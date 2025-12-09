/**
 * OBSRecorder - Core OBS Studio Node management for arena match recording
 * Handles initialization, configuration, and recording lifecycle
 */

import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

// OBS Studio Node types
import * as osn from 'obs-studio-node';

// Manager imports
import { OBSCaptureManager, ObsIpcSupervisor } from './obs/OBSCaptureManager';
import { OBSSettingsManager, OBSRecorderConfig } from './obs/OBSSettingsManager';
import { RecordingStorageManager } from './obs/RecordingStorageManager';
import { OBSPreviewManager, PreviewBounds } from './obs/OBSPreviewManager';
import { ObsRecordingSignal } from './obsEnums';
import { BrowserWindow } from 'electron';
import {
  RecordingSettings,
  AudioDevice,
  EncoderType,
  UNSAFE_RECORDING_SETTINGS,
} from './RecordingTypes';

/**
 * Fix path for packaged Electron apps (ASAR handling)
 * Ensures native modules work correctly in packaged applications
 */
function fixPathWhenPackaged(pathToFix: string): string {
  if (pathToFix.includes('app.asar')) {
    return pathToFix.replace('app.asar', 'app.asar.unpacked');
  }
  return pathToFix;
}

/**
 * OBS output signal interface
 */
export interface OBSOutputSignal {
  type: 'recording' | 'stream' | string;
  signal: ObsRecordingSignal | string;
  /** Numeric result code from OBS (0 = success, non-zero = error) */
  code?: number;
  error?: string;
}

/**
 * Recording error event payload
 */
export interface RecordingErrorEvent {
  sessionId: string;
  code: number | undefined;
  error: string | undefined;
}

/**
 * Recording status information
 */
export interface RecordingStatus {
  isInitialized: boolean;
  isRecording: boolean;
  currentFile: string | null;
  duration: number;
  frameCount: number;
  droppedFrames: number;
  cpuUsage: number;
  diskUsedGB: number;
}

/**
 * OBS engine lifecycle state
 */
type ObsEngineState = 'idle' | 'initializing' | 'ready' | 'shuttingDown' | 'failed';

/**
 * Typed error for fatal OBS IPC failures.
 * Emitted when the OBS engine becomes unrecoverably unhealthy.
 */
export class ObsFatalIpcError extends Error {
  public readonly code = 'OBS_IPC_FATAL' as const;

  constructor(
    message = 'Fatal OBS IPC failure',
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'ObsFatalIpcError';
  }
}

/**
 * Per-session recording state
 */
type RecordingSessionStatus = 'idle' | 'starting' | 'recording' | 'stopping';

interface RecordingSessionState {
  id: string;
  status: RecordingSessionStatus;
  outputDir: string;
  filePath: string | null;
  startTime?: Date;
  stopTime?: Date;
}

/**
 * Manages OBS Studio Node for recording WoW arena matches
 */
export class OBSRecorder extends EventEmitter implements ObsIpcSupervisor {
  // Configurable timing constants
  // 30s timeout: large recordings (500MB+) may take time to finalize MP4 container
  private static readonly STOP_TIMEOUT_MS = 30000;

  private isInitialized = false;
  private engineState: ObsEngineState = 'idle';
  private context: ReturnType<typeof osn.VideoFactory.create> | null = null; // KEEP NAME for compatibility
  private config: OBSRecorderConfig;
  private defaultOutputDir: string;
  private uuid = 'arena-coach-obs'; // Unique identifier for IPC

  // Per-session state machine
  private currentSession: RecordingSessionState | null = null;
  private stopPromise: Promise<string | null> | null = null;
  private stopResolve: ((filePath: string | null) => void) | null = null;
  private stopTimeoutHandle: NodeJS.Timeout | null = null;

  // Managers
  private captureManager: OBSCaptureManager;
  private settingsManager: OBSSettingsManager;
  private storageManager: RecordingStorageManager;
  private previewManager: OBSPreviewManager;

  // Track current settings for diff-based updates
  private currentSettings: Partial<RecordingSettings> = {};

  constructor(config: OBSRecorderConfig = {}) {
    super();
    // Set up default output directory
    this.defaultOutputDir =
      config.outputDir || path.join(app.getPath('videos'), 'ArenaCoach', 'Recordings');

    // Ensure output directory exists
    if (!fs.existsSync(this.defaultOutputDir)) {
      fs.mkdirSync(this.defaultOutputDir, { recursive: true });
    }

    this.config = {
      resolution: config.resolution || '1920x1080',
      fps: config.fps || 60,
      bitrate: config.bitrate || 8000,
      encoder: config.encoder || 'x264',
      audioDevice: config.audioDevice || 'default',
      outputDir: this.defaultOutputDir,
    };

    // Initialize managers
    this.captureManager = new OBSCaptureManager({ supervisor: this });
    this.settingsManager = new OBSSettingsManager(this.config);
    this.storageManager = new RecordingStorageManager(this.defaultOutputDir);
    this.previewManager = new OBSPreviewManager();

    console.log('[OBSRecorder] Created with config:', this.config);
  }

  /**
   * Initialize OBS Studio Node
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      console.warn('[OBSRecorder] Already initialized');
      return;
    }

    this.engineState = 'initializing';

    try {
      console.log('[OBSRecorder] Initializing OBS Studio Node...');

      // Initialize IPC connection
      osn.NodeObs.IPC.host(this.uuid);

      // Set working directory to OBS module location
      const workingDir = this.getOBSWorkingDirectory();
      osn.NodeObs.SetWorkingDirectory(workingDir);
      console.log('[OBSRecorder] Working directory:', workingDir);

      // Get data directory for OBS settings/cache
      const dataDir = this.getOBSDataDirectory();
      console.log('[OBSRecorder] Data directory:', dataDir);

      // Initialize OBS API
      const initResult = osn.NodeObs.OBS_API_initAPI('en-US', dataDir, '1.0.0', '');
      if (initResult !== 0) {
        throw new Error(`Failed to initialize OBS API: ${initResult}`);
      }

      // Create and configure video context
      this.context = osn.VideoFactory.create();
      this.context.video = this.settingsManager.getVideoSettings();

      // Configure output settings
      this.settingsManager.configureOutput(this.config);

      // Initialize capture manager (creates scene and game capture)
      await this.captureManager.initialize(this.context);

      // Set scene on preview manager if available
      const scene = this.captureManager.getScene();
      if (scene) {
        this.previewManager.setScene(scene);
      }

      // Connect output signal handlers for recording events
      osn.NodeObs.OBS_service_connectOutputSignals((signal: OBSOutputSignal) => {
        this.handleOutputSignal(signal);
      });

      // Sync current settings from config to avoid unnecessary first updates
      this.syncCurrentSettingsFromOBS();

      this.isInitialized = true;
      this.engineState = 'ready';
      console.log('[OBSRecorder] Initialization complete');
      this.emit('initialized');
    } catch (error) {
      console.error('[OBSRecorder] Initialization failed:', error);
      this.engineState = 'failed';
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Start recording a match (per-session state)
   */
  public async startRecording(outputPath?: string): Promise<string> {
    if (!this.isInitialized) {
      throw new Error('OBSRecorder not initialized. Call initialize() first.');
    }

    // Precondition: cannot start if session is active/stopping
    if (this.currentSession && this.currentSession.status !== 'idle') {
      throw new Error(
        `Cannot start recording: session already ${this.currentSession.status} (id: ${this.currentSession.id})`
      );
    }

    try {
      // Set recording directory, let OBS generate filename
      const recordingDir = outputPath || path.join(this.defaultOutputDir, 'temp');

      // Ensure directory exists
      if (!fs.existsSync(recordingDir)) {
        fs.mkdirSync(recordingDir, { recursive: true });
      }

      // Generate session ID
      const sessionId = randomUUID();

      console.log('[OBSRecorder] Starting recording session:', {
        sessionId,
        outputDir: recordingDir,
      });

      // Create new session
      this.currentSession = {
        id: sessionId,
        status: 'starting',
        outputDir: recordingDir,
        filePath: null,
        startTime: new Date(),
      };

      // Set only the directory path, let OBS generate filename
      this.settingsManager.applySetting('Output', 'RecFilePath', recordingDir);

      // Start recording using OBS service
      osn.NodeObs.OBS_service_startRecording();

      console.log('[OBSRecorder] Recording command sent for session:', sessionId);
      this.emit('recordingStarted', recordingDir);

      return recordingDir; // Return directory, not specific file
    } catch (error) {
      console.error('[OBSRecorder] Failed to start recording:', error);
      this.currentSession = null;
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Update the output directory for recordings
   * This updates both the OBS settings and the storage manager
   */
  public updateOutputDirectory(newDirectory: string): void {
    try {
      // Update the default output directory
      this.defaultOutputDir = newDirectory;

      // Update the settings manager with new path
      if (this.settingsManager) {
        this.settingsManager.applySetting('Output', 'RecFilePath', newDirectory);
      }

      // Update the storage manager
      if (this.storageManager) {
        this.storageManager.updateOutputDirectory(newDirectory);
      }

      console.log('[OBSRecorder] Output directory updated:', newDirectory);
    } catch (error) {
      console.error('[OBSRecorder] Failed to update output directory:', error);
      throw error;
    }
  }

  /**
   * Update encoder at runtime (when not recording ideally)
   */
  public setEncoder(encoder: EncoderType): void {
    try {
      if (this.currentSession && this.currentSession.status === 'recording') {
        console.warn('[OBSRecorder] Ignoring encoder change while recording');
        return;
      }
      this.settingsManager.updateConfig({ encoder });
    } catch (error) {
      console.error('[OBSRecorder] Failed to set encoder:', error);
    }
  }

  /**
   * Stop current recording (per-session state, no stale paths)
   */
  public async stopRecording(): Promise<string | null> {
    // Precondition: no active session or already idle
    if (!this.currentSession || this.currentSession.status === 'idle') {
      console.warn('[OBSRecorder] No active recording to stop');
      return null;
    }

    // Idempotency: if already stopping, return existing promise
    if (this.stopPromise && this.currentSession.status === 'stopping') {
      console.log(
        '[OBSRecorder] Already stopping session, waiting for completion:',
        this.currentSession.id
      );
      return this.stopPromise;
    }

    try {
      const sessionId = this.currentSession.id;
      const startTime = this.currentSession.startTime; // Capture before cleanup
      console.log('[OBSRecorder] Stopping recording session:', sessionId);

      // Transition to stopping
      this.currentSession.status = 'stopping';

      // Create promise that will resolve when Stop signal is received
      this.stopPromise = new Promise<string | null>(resolve => {
        this.stopResolve = resolve;

        // Set a timeout in case signal never arrives
        this.stopTimeoutHandle = setTimeout(() => {
          if (this.stopResolve) {
            console.warn('[OBSRecorder] Stop signal timeout - no file path returned:', sessionId);

            // Do NOT call getLastRecording on timeout (no stale paths)
            this.currentSession = null;
            this.stopResolve = null;
            this.stopPromise = null;
            this.stopTimeoutHandle = null;

            resolve(null);
          }
        }, OBSRecorder.STOP_TIMEOUT_MS);
      });

      // Request stop
      osn.NodeObs.OBS_service_stopRecording();

      // Wait for stop signal or timeout
      const recordedFile = await this.stopPromise;

      // Compute duration from captured startTime
      const duration = startTime ? (Date.now() - startTime.getTime()) / 1000 : 0;

      console.log('[OBSRecorder] Recording stopped for session:', {
        sessionId,
        file: recordedFile,
        duration: `${duration.toFixed(1)}s`,
      });

      this.emit('recordingStopped', recordedFile, duration);

      return recordedFile;
    } catch (error) {
      console.error('[OBSRecorder] Failed to stop recording:', error);

      // Clear timeout to prevent stale callback interfering with future stops
      if (this.stopTimeoutHandle) {
        clearTimeout(this.stopTimeoutHandle);
        this.stopTimeoutHandle = null;
      }

      this.currentSession = null;
      this.stopPromise = null;
      this.stopResolve = null;
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Get current recording status (derived from currentSession)
   */
  public async getStatus(): Promise<RecordingStatus> {
    // When engine is failed or shutting down, report as not initialized/recording
    const engineHealthy = this.engineState !== 'failed' && this.engineState !== 'shuttingDown';

    const isRecording =
      engineHealthy &&
      (this.currentSession?.status === 'recording' || this.currentSession?.status === 'stopping');

    const duration =
      isRecording && this.currentSession?.startTime
        ? (Date.now() - this.currentSession.startTime.getTime()) / 1000
        : 0;

    const recordingsUsedGB = await this.storageManager.getRecordingsUsedSpace();

    return {
      isInitialized: engineHealthy && this.isInitialized,
      isRecording,
      currentFile: this.currentSession?.filePath || null,
      duration,
      frameCount: 0,
      droppedFrames: 0,
      cpuUsage: 0,
      diskUsedGB: recordingsUsedGB,
    };
  }

  /**
   * Set main window for preview display
   */
  public setMainWindow(window: BrowserWindow): void {
    this.previewManager.setMainWindow(window);
  }

  /**
   * Show preview at specified bounds
   */
  public async showPreview(bounds: PreviewBounds): Promise<void> {
    if (!this.isInitialized) {
      const error = new Error('OBS not initialized');
      (error as any).code = 'OBS_NOT_INITIALIZED';
      throw error;
    }
    return this.previewManager.showPreview(bounds);
  }

  /**
   * Update preview bounds
   */
  public async updatePreviewBounds(bounds: PreviewBounds): Promise<void> {
    if (!this.isInitialized) {
      const error = new Error('OBS not initialized');
      (error as any).code = 'OBS_NOT_INITIALIZED';
      throw error;
    }
    return this.previewManager.updatePreviewBounds(bounds);
  }

  /**
   * Hide preview
   */
  public hidePreview(): void {
    this.previewManager.hidePreview();
  }

  /**
   * Check if OBS is initialized
   */
  public getIsInitialized(): boolean {
    return this.isInitialized;
  }

  /**
   * Check if currently recording (derived from currentSession)
   */
  public getIsRecording(): boolean {
    return (
      this.currentSession?.status === 'recording' || this.currentSession?.status === 'stopping'
    );
  }

  /**
   * Shutdown OBS and cleanup resources
   */
  public async shutdown(): Promise<void> {
    console.log('[OBSRecorder] Shutting down...');

    // Transition to shuttingDown (unless already failed)
    if (this.engineState !== 'failed') {
      this.engineState = 'shuttingDown';
    }

    try {
      // Stop recording if active
      if (this.currentSession && this.currentSession.status !== 'idle') {
        await this.stopRecording();
      }

      // Stop WoW detection in capture manager
      this.captureManager.stopWoWDetection();

      // Shutdown OBS
      if (this.isInitialized) {
        try {
          console.log('[OBSRecorder] Shutting down OBS...');

          // CRITICAL ORDER:
          // 1. Destroy preview display FIRST
          this.previewManager.destroyPreview();

          // 2. Release all sources
          this.captureManager.releaseAll();

          // 3. Destroy video context
          if (this.context) {
            this.context.destroy();
            this.context = null;
          }

          // Shutdown sequence (only remove callbacks we registered)
          osn.NodeObs.InitShutdownSequence();
          osn.NodeObs.OBS_service_removeCallback(); // We registered connectOutputSignals
          osn.NodeObs.IPC.disconnect();

          console.log('[OBSRecorder] OBS shutdown sequence completed');
        } catch (shutdownError) {
          console.error('[OBSRecorder] Error during OBS shutdown:', shutdownError);
        }

        this.isInitialized = false;
      }

      this.engineState = 'idle';
      console.log('[OBSRecorder] Shutdown complete');
      this.emit('shutdown');
    } catch (error) {
      console.error('[OBSRecorder] Error during shutdown:', error);
      this.emit('error', error);
    }
  }

  /**
   * Handle fatal OBS IPC error from capture manager (ObsIpcSupervisor implementation).
   * Transitions engine to failed state, performs best-effort teardown, and emits typed error.
   */
  public onObsFatalIpcError(error: Error): void {
    // Idempotent: ignore if already failed or shutting down
    if (this.engineState === 'failed' || this.engineState === 'shuttingDown') {
      console.debug('[OBSRecorder] Ignoring fatal IPC error in state:', this.engineState);
      return;
    }

    console.error('[OBSRecorder] Fatal OBS IPC error detected, disabling recording engine');

    // Transition to failed state
    this.engineState = 'failed';

    // Best-effort teardown (each step individually wrapped to avoid secondary crashes)
    try {
      this.captureManager.releaseAll();
    } catch (e) {
      console.warn('[OBSRecorder] releaseAll failed during fatal error handling:', e);
    }

    try {
      if (this.context) {
        this.context.destroy();
        this.context = null;
      }
    } catch (e) {
      console.warn('[OBSRecorder] context destroy failed during fatal error handling:', e);
    }

    // Only attempt OBS shutdown sequence if we were initialized
    if (this.isInitialized) {
      try {
        osn.NodeObs.InitShutdownSequence();
      } catch (e) {
        console.warn('[OBSRecorder] InitShutdownSequence failed during fatal error handling:', e);
      }

      try {
        osn.NodeObs.IPC.disconnect();
      } catch (e) {
        console.warn('[OBSRecorder] IPC.disconnect failed during fatal error handling:', e);
      }
    }

    this.isInitialized = false;

    // Emit typed error for upstream services
    const fatalError = new ObsFatalIpcError('Fatal OBS IPC failure', error);
    this.emit('error', fatalError);
  }

  /**
   * Get the OBS working directory (where binaries are located)
   */
  private getOBSWorkingDirectory(): string {
    return fixPathWhenPackaged(path.join(__dirname, '../../', 'node_modules', 'obs-studio-node'));
  }

  /**
   * Get the OBS data directory for settings and cache
   */
  private getOBSDataDirectory(): string {
    // Create a dedicated directory for OBS data
    const dataPath = path.join(app.getPath('userData'), 'osn-data');

    // Ensure directory exists
    if (!fs.existsSync(dataPath)) {
      fs.mkdirSync(dataPath, { recursive: true });
    }

    return dataPath;
  }

  /**
   * Handle OBS output signals (recording events) with temporal correlation
   */
  private handleOutputSignal(obsSignal: OBSOutputSignal): void {
    console.log('[OBSRecorder] Output signal:', obsSignal);

    // Check if this is a recording signal
    if (obsSignal.type !== 'recording') {
      return;
    }

    switch (obsSignal.signal) {
      case 'start':
        console.log('[OBSRecorder] Recording started signal');
        // Update session status if we're in starting state
        if (this.currentSession && this.currentSession.status === 'starting') {
          this.currentSession.status = 'recording';
          console.log('[OBSRecorder] Session transitioned to recording:', this.currentSession.id);
        }
        break;

      case 'stop': {
        console.log('[OBSRecorder] Recording stopped signal - getting actual file path');

        // Check for error condition BEFORE stale signal guard (Case 1: early stop with error)
        const hasError = obsSignal.code !== undefined && obsSignal.code !== 0;
        const hasErrorString = !!obsSignal.error;

        if (hasError || hasErrorString) {
          console.warn('[OBSRecorder] Stop signal with error condition:', {
            code: obsSignal.code,
            error: obsSignal.error,
            sessionId: this.currentSession?.id || 'unknown',
          });

          this.handleRecordingError(obsSignal.code, obsSignal.error);
          return; // Do NOT call getLastRecording for error cases
        }

        // Temporal correlation: only process if session is active
        if (
          !this.currentSession ||
          (this.currentSession.status !== 'stopping' && this.currentSession.status !== 'recording')
        ) {
          console.warn('[OBSRecorder] Stale stop signal ignored');
          return;
        }

        let filePath: string | null = null;
        try {
          const lastFile = osn.NodeObs.OBS_service_getLastRecording();
          filePath = lastFile ? path.normalize(lastFile) : null;
          this.currentSession.filePath = filePath;
          this.currentSession.stopTime = new Date();
          console.log('[OBSRecorder] OBS created file for session:', {
            sessionId: this.currentSession.id,
            filePath,
          });
        } catch (error) {
          console.error('[OBSRecorder] Failed to get last recording:', error);
          filePath = null;
        }

        // Clear timeout
        if (this.stopTimeoutHandle) {
          clearTimeout(this.stopTimeoutHandle);
          this.stopTimeoutHandle = null;
        }

        // Resolve promise and clear session
        const resolve = this.stopResolve;
        this.stopResolve = null;
        this.stopPromise = null;

        if (resolve) {
          resolve(filePath);
        }

        this.currentSession.status = 'idle';
        this.currentSession = null;
        break;
      }

      case 'starting':
        console.log('[OBSRecorder] Recording starting signal');
        break;

      case 'stopping':
        console.log('[OBSRecorder] Recording stopping signal');
        break;

      case 'wrote':
        // File chunk written - no action needed
        break;

      case 'writing_error': {
        console.error('[OBSRecorder] Write error signal:', obsSignal.error);
        this.handleRecordingError(-1, obsSignal.error || 'OBS writing_error');
        break;
      }
    }
  }

  /**
   * Handle recording error cleanup - shared logic for stop-with-error and writing_error signals
   */
  private handleRecordingError(code: number | undefined, error: string | undefined): void {
    // Emit recordingError event
    const errorEvent: RecordingErrorEvent = {
      sessionId: this.currentSession?.id || 'unknown',
      code,
      error,
    };
    this.emit('recordingError', errorEvent);

    // Clear timeout if set
    if (this.stopTimeoutHandle) {
      clearTimeout(this.stopTimeoutHandle);
      this.stopTimeoutHandle = null;
    }

    // Resolve stopPromise with null (no valid file)
    if (this.stopResolve) {
      this.stopResolve(null);
      this.stopResolve = null;
      this.stopPromise = null;
    }

    // Reset session to idle to allow future recordings
    if (this.currentSession) {
      this.currentSession.status = 'idle';
      this.currentSession = null;
    }
  }

  /**
   * Enforce user storage quota by deleting oldest recordings
   * PUBLIC API - delegate to manager
   */
  public async enforceStorageQuota(maxStorageGB: number): Promise<void> {
    return this.storageManager.enforceStorageQuota(maxStorageGB);
  }

  /**
   * Set WoW process active state (pass-through to capture manager)
   */
  public setWoWActive(active: boolean): void {
    this.captureManager.setWoWActive(active);
  }

  /**
   * Enable or disable game capture mode (pass-through to capture manager)
   */
  public setGameCaptureEnabled(enabled: boolean): void {
    this.captureManager.setGameCaptureEnabled(enabled);
  }

  /**
   * Apply recording settings to OBS with diff-based optimization
   * Only applies changes that differ from current settings
   * @returns true if all settings applied successfully, false if any failed
   */
  public async applyRecordingSettings(settings: Partial<RecordingSettings>): Promise<boolean> {
    // Guard: reject settings updates when engine is not ready
    if (this.engineState !== 'ready') {
      console.warn(
        `[OBSRecorder] Rejecting settings update while OBS engine is not ready (state: ${this.engineState})`
      );
      return false;
    }

    if (!this.isInitialized) {
      const error = new Error('OBS not initialized');
      (error as any).code = 'OBS_NOT_INITIALIZED';
      throw error;
    }

    // Enforce UNSAFE settings lock while recording (defense-in-depth; UI already disables)
    const isRecording = this.currentSession && this.currentSession.status === 'recording';
    if (isRecording) {
      const incomingKeys = Object.keys(settings) as (keyof RecordingSettings)[];
      const blocked = incomingKeys.filter(k =>
        (UNSAFE_RECORDING_SETTINGS as readonly string[]).includes(k as string)
      );
      if (blocked.length > 0) {
        const error = new Error('Cannot change settings while recording');
        (error as any).code = 'RECORDING_ACTIVE';
        (error as any).details = { blockedKeys: blocked };
        throw error;
      }
    }

    // Compute diff to avoid unnecessary OBS API calls (DRY principle)
    const changes: Partial<RecordingSettings> = {};
    const keys = Object.keys(settings) as (keyof RecordingSettings)[];
    for (const key of keys) {
      if (settings[key] !== undefined && settings[key] !== this.currentSettings[key]) {
        (changes as any)[key] = settings[key];
      }
    }

    // Early return if no changes
    if (Object.keys(changes).length === 0) {
      return true;
    }

    let allSuccessful = true;
    const needsVideoContextReinit = changes.fps !== undefined || changes.resolution !== undefined;

    try {
      // Apply video settings that require context reinit (only when not recording)
      if (needsVideoContextReinit) {
        // Update settings that will be used for reinit
        if (changes.fps !== undefined) {
          this.settingsManager.setFPS(changes.fps);
          this.currentSettings.fps = changes.fps;
        }

        if (changes.resolution !== undefined) {
          this.settingsManager.setResolution(changes.resolution);
          this.currentSettings.resolution = changes.resolution;
        }

        // Reinitialize video context to apply FPS/resolution changes
        if (!(await this.reinitializeVideoContext())) {
          allSuccessful = false;
        }
      }

      // Apply quality setting (doesn't require context reinit)
      if (changes.quality !== undefined) {
        this.settingsManager.setQuality(changes.quality);
        this.currentSettings.quality = changes.quality;
      }

      // Capture settings
      if (changes.captureMode !== undefined) {
        this.captureManager.applyCaptureMode(changes.captureMode);
        this.currentSettings.captureMode = changes.captureMode;
      }

      if (changes.captureCursor !== undefined) {
        // Cursor is a per-source setting managed by captureManager only (SSOT)
        if (!this.captureManager.setCaptureCursor(changes.captureCursor)) {
          allSuccessful = false;
        } else {
          this.currentSettings.captureCursor = changes.captureCursor;
        }
      }

      // Audio settings (these return void, so we can't check success)
      if (changes.desktopAudioEnabled !== undefined) {
        this.captureManager.setDesktopAudioEnabled(changes.desktopAudioEnabled);
        this.currentSettings.desktopAudioEnabled = changes.desktopAudioEnabled;
      }

      if (changes.desktopAudioDevice !== undefined) {
        this.captureManager.setDesktopAudioDevice(changes.desktopAudioDevice);
        this.currentSettings.desktopAudioDevice = changes.desktopAudioDevice;
      }

      if (changes.microphoneAudioEnabled !== undefined) {
        this.captureManager.setMicrophoneAudioEnabled(changes.microphoneAudioEnabled);
        this.currentSettings.microphoneAudioEnabled = changes.microphoneAudioEnabled;
      }

      if (changes.microphoneDevice !== undefined) {
        this.captureManager.setMicrophoneDevice(changes.microphoneDevice);
        this.currentSettings.microphoneDevice = changes.microphoneDevice;
      }

      // Mic processing features
      if (changes.audioSuppressionEnabled !== undefined) {
        this.captureManager.setMicrophoneSuppression(!!changes.audioSuppressionEnabled);
        this.currentSettings.audioSuppressionEnabled = !!changes.audioSuppressionEnabled;
      }

      if (changes.forceMonoInput !== undefined) {
        this.captureManager.setMicrophoneForceMono(!!changes.forceMonoInput);
        this.currentSettings.forceMonoInput = !!changes.forceMonoInput;
      }
    } catch (error) {
      console.error('[OBSRecorder] Settings update failed:', error);
      return false;
    }

    return allSuccessful;
  }

  /**
   * Sync currentSettings from config values
   * Called after initialization to prevent unnecessary API calls on first update
   */
  private syncCurrentSettingsFromOBS(): void {
    // Initialize with config values as baseline since we can't easily read all settings back from OBS
    this.currentSettings = {};

    // Only set values that are defined
    if (this.config.fps !== undefined) {
      this.currentSettings.fps = this.config.fps;
    }
    if (this.config.resolution !== undefined) {
      this.currentSettings.resolution = this.config.resolution;
    }

    // Seed quality from bitrate config to avoid no-op on first update
    // Note: We don't have a direct quality mapping from bitrate, so we leave it undefined
    // This ensures the first quality setting will be applied when requested

    // Set defaults for other settings
    this.currentSettings.captureCursor = false; // Default cursor setting
  }

  /**
   * Reinitialize video context for live FPS/resolution changes
   * Only allowed when not recording
   * @returns true if successful, false otherwise
   */
  private async reinitializeVideoContext(): Promise<boolean> {
    if ((this.currentSession && this.currentSession.status === 'recording') || !this.context) {
      return false; // Cannot reinit during recording or if no context
    }

    try {
      // Get new video settings with updated resolution/FPS
      const newVideoSettings = this.settingsManager.getVideoSettings();

      // Check if video context actually needs updating
      const current = this.context.video;
      if (
        newVideoSettings.fpsNum !== current.fpsNum ||
        newVideoSettings.baseWidth !== current.baseWidth ||
        newVideoSettings.baseHeight !== current.baseHeight ||
        newVideoSettings.outputWidth !== current.outputWidth ||
        newVideoSettings.outputHeight !== current.outputHeight
      ) {
        // Apply new video settings directly to existing context
        this.context.video = newVideoSettings;

        // Trigger re-scaling of active capture sources to new dimensions
        if (this.context) {
          this.captureManager.rescaleToNewDimensions(this.context);
        }
      }

      return true;
    } catch (error) {
      console.error('[OBSRecorder] Operation failed:', error);
      return false;
    }
  }

  /**
   * Get available audio devices
   */
  public getAudioDevices(): { input: AudioDevice[]; output: AudioDevice[] } {
    if (!this.isInitialized) {
      return { input: [], output: [] };
    }

    return {
      input: this.settingsManager.getInputAudioDevices(),
      output: this.settingsManager.getOutputAudioDevices(),
    };
  }

  /**
   * Get available monitors
   */
  public getMonitors(): Array<{ id: string; name: string }> {
    if (!this.isInitialized || !this.captureManager) {
      return [];
    }

    return this.captureManager.listMonitors();
  }

  /**
   * Set monitor by ID
   */
  public setMonitorById(monitorId: string): boolean {
    if (!this.isInitialized || !this.captureManager) {
      return false;
    }

    return this.captureManager.setMonitorById(monitorId);
  }
}
