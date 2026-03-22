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
import {
  RecordingStorageManager,
  StorageQuotaEnforcementResult,
} from './obs/RecordingStorageManager';
import { OBSPreviewManager, PreviewBounds } from './obs/OBSPreviewManager';
import { ObsRecordingSignal } from './obsEnums';
import { BrowserWindow } from 'electron';
import {
  RecordingSettings,
  AudioDevice,
  EncoderType,
  EncoderMode,
  CaptureMode,
  Resolution,
  RESOLUTION_DIMENSIONS,
  UNSAFE_RECORDING_SETTINGS,
} from './RecordingTypes';
import { resolveEncoderSelection } from './obs/encoderResolver';
import { AppError, isNodeError } from '../utils/errors';

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
type ObsEngineState = 'idle' | 'initializing' | 'ready' | 'recovering' | 'shuttingDown' | 'failed';

export const OBS_RECORDER_RECOVERING = 'OBS_RECORDER_RECOVERING' as const;
export const OBS_RECORDER_UNAVAILABLE = 'OBS_RECORDER_UNAVAILABLE' as const;
export const OBS_RECORDING_DIRECTORY_UNAVAILABLE = 'OBS_RECORDING_DIRECTORY_UNAVAILABLE' as const;

export type ObsRecorderAvailabilityCode =
  | typeof OBS_RECORDER_RECOVERING
  | typeof OBS_RECORDER_UNAVAILABLE
  | typeof OBS_RECORDING_DIRECTORY_UNAVAILABLE;

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

export class ObsRecorderAvailabilityError extends AppError {
  constructor(code: ObsRecorderAvailabilityCode, message: string) {
    super(message, code);
    this.name = 'ObsRecorderAvailabilityError';
  }
}

class ObsRecorderShutdownAbortError extends Error {
  constructor(message = 'OBS recorder operation aborted because shutdown is in progress') {
    super(message);
    this.name = 'ObsRecorderShutdownAbortError';
  }
}

class ObsRecorderFatalAbortError extends Error {
  constructor(message = 'OBS recorder operation aborted because the recorder entered a failed state') {
    super(message);
    this.name = 'ObsRecorderFatalAbortError';
  }
}

/**
 * Reason for stop recording failure
 */
export type StopRecordingFailureReason =
  | 'no_active_session'
  | 'write_error'
  | 'stop_error'
  | 'stop_timeout';

/**
 * Typed result from stopRecording()
 */
export type StopRecordingResult =
  | { ok: true; filePath: string; durationSeconds: number }
  | { ok: false; reason: StopRecordingFailureReason; error?: string; durationSeconds: number };

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
  // Two-phase stop timeout: warn logs only, hard resolves failure
  private static readonly WARN_TIMEOUT_MS = 30000; // 30s: logs warning, does NOT resolve
  private static readonly HARD_TIMEOUT_MS = 120000; // 120s: resolves stop_timeout, clears session

  private isInitialized = false;
  private engineState: ObsEngineState = 'idle';
  private context: ReturnType<typeof osn.VideoFactory.create> | null = null; // KEEP NAME for compatibility
  private config: OBSRecorderConfig;
  private defaultOutputDir: string;
  private uuid = 'arena-coach-obs'; // Unique identifier for IPC

  // Per-session state machine
  private currentSession: RecordingSessionState | null = null;
  private stopPromise: Promise<StopRecordingResult> | null = null;
  private stopResolve: ((result: StopRecordingResult) => void) | null = null;
  private warnTimeoutHandle: NodeJS.Timeout | null = null;
  private hardTimeoutHandle: NodeJS.Timeout | null = null;
  private initializationPromise: Promise<void> | null = null;
  private recoveryPromise: Promise<void> | null = null;
  private recoveryToken = 0;
  private deferredRecoveryPending = false;
  private lifecycleToken = 0;
  private engineGeneration = 0;
  private nativeEngineStarted = false;

  // Managers
  private captureManager: OBSCaptureManager;
  private settingsManager: OBSSettingsManager;
  private storageManager: RecordingStorageManager;
  private previewManager: OBSPreviewManager;
  private previewState: { isVisible: boolean; bounds: PreviewBounds | null } = {
    isVisible: false,
    bounds: null,
  };

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
      encoderMode: config.encoderMode || 'auto',
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
    const joinedRecovery = !!this.recoveryPromise;
    if (this.recoveryPromise) {
      await this.recoveryPromise;
    }

    if (joinedRecovery && !this.deferredRecoveryPending) {
      this.assertRecorderAvailableAfterLifecycleJoin();
      return;
    }

    if (this.getIsInitialized()) {
      console.warn('[OBSRecorder] Already initialized');
      return;
    }

    if (this.initializationPromise) {
      await this.initializationPromise;
      return;
    }

    if (this.isShutdownInProgress()) {
      throw new ObsRecorderShutdownAbortError();
    }

    if (this.deferredRecoveryPending) {
      await this.completeDeferredRecoveryInitialization('initialize');
      this.assertRecorderAvailableAfterLifecycleJoin();
      return;
    }

    const lifecycleToken = this.lifecycleToken;
    this.initializationPromise = this.runInitialize(lifecycleToken).finally(() => {
      this.initializationPromise = null;
    });
    await this.initializationPromise;
  }

  /**
   * Start recording a match (per-session state)
   */
  public async startRecording(outputPath?: string): Promise<string> {
    if (this.recoveryPromise) {
      this.assertRecorderAvailableForStart();
    }

    if (this.deferredRecoveryPending) {
      await this.completeDeferredRecoveryInitialization('start');
    }

    this.assertRecorderAvailableForStart();

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
      if (this.isRecordingDirectoryUnavailableStartError(error)) {
        const availabilityError = new ObsRecorderAvailabilityError(
          OBS_RECORDING_DIRECTORY_UNAVAILABLE,
          'Recording output directory is unavailable.'
        );
        console.error('[OBSRecorder] Failed to start recording:', availabilityError);
        this.currentSession = null;
        this.emit('error', availabilityError);
        throw availabilityError;
      }

      console.error('[OBSRecorder] Failed to start recording:', error);
      this.currentSession = null;
      this.emit('error', error);
      throw error;
    }
  }

  private isRecordingDirectoryUnavailableStartError(error: unknown): boolean {
    if (!isNodeError(error)) {
      return false;
    }

    return ['ENOENT', 'ENODEV', 'EIO'].includes(error.code);
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

  private getCaptureRecoverySettingsSnapshot(): Partial<RecordingSettings> {
    return { ...this.currentSettings };
  }

  private restoreCaptureStateAfterInitialization(
    settingsSnapshot: Partial<RecordingSettings>
  ): void {
    const captureMode = settingsSnapshot.captureMode;

    if (captureMode !== undefined && !this.captureManager.applyCaptureMode(captureMode)) {
      throw new Error(`Failed to restore capture mode after OBS initialization: ${captureMode}`);
    }

    if (
      captureMode === CaptureMode.MONITOR &&
      settingsSnapshot.monitorId !== undefined &&
      !this.captureManager.setMonitorById(settingsSnapshot.monitorId)
    ) {
      throw new Error(
        `Failed to restore monitor selection after OBS initialization: ${settingsSnapshot.monitorId}`
      );
    }

    if (
      settingsSnapshot.captureCursor !== undefined &&
      !this.captureManager.setCaptureCursor(settingsSnapshot.captureCursor)
    ) {
      throw new Error('Failed to restore capture cursor setting after OBS initialization');
    }

    if (settingsSnapshot.desktopAudioEnabled !== undefined) {
      this.captureManager.setDesktopAudioEnabled(settingsSnapshot.desktopAudioEnabled);
    }

    if (settingsSnapshot.desktopAudioDevice !== undefined) {
      this.captureManager.setDesktopAudioDevice(settingsSnapshot.desktopAudioDevice);
    }

    if (settingsSnapshot.microphoneAudioEnabled !== undefined) {
      this.captureManager.setMicrophoneAudioEnabled(settingsSnapshot.microphoneAudioEnabled);
    }

    if (settingsSnapshot.microphoneDevice !== undefined) {
      this.captureManager.setMicrophoneDevice(settingsSnapshot.microphoneDevice);
    }

    if (settingsSnapshot.audioSuppressionEnabled !== undefined) {
      this.captureManager.setMicrophoneSuppression(settingsSnapshot.audioSuppressionEnabled);
    }

    if (settingsSnapshot.forceMonoInput !== undefined) {
      this.captureManager.setMicrophoneForceMono(settingsSnapshot.forceMonoInput);
    }
  }

  /**
   * Update encoder at runtime (when not recording/stopping)
   */
  public setEncoder(encoder: EncoderType): void {
    try {
      if (this.getIsRecording()) {
        console.warn('[OBSRecorder] Ignoring encoder change while recording/stopping');
        return;
      }

      this.config.encoder = encoder;
      this.config.encoderMode = 'manual';
      this.settingsManager.updateConfig({ encoder, encoderMode: 'manual' });

      const availableEncoderIds = this.enumerateVideoEncoderIds();
      const decision = resolveEncoderSelection({
        availableEncoderIds,
        mode: 'manual',
        preferredEncoder: encoder,
      });

      if (decision.kind === 'resolved') {
        if (decision.reason === 'manual_requested_unavailable_fallback') {
          console.warn('[OBSRecorder] Requested manual encoder unavailable; using fallback', {
            requestedEncoder: decision.requestedEncoder,
            fallbackEncoderId: decision.encoderId,
            availableEncoderIds: availableEncoderIds ?? null,
          });
        }
        const applied = this.settingsManager.applyEncoderById(decision.encoderId);
        if (!applied) {
          console.warn('[OBSRecorder] Failed to apply resolved encoder id:', decision.encoderId);
        }
        return;
      }

      if (decision.reason === 'no_supported_h264') {
        console.warn('[OBSRecorder] No supported H.264 encoders available; keeping current encoder', {
          requestedEncoder: encoder,
          availableEncoderIds: availableEncoderIds ?? null,
        });
        return;
      }

      const appliedFallback = this.settingsManager.applyEncoderById('obs_x264');
      console.warn('[OBSRecorder] Encoder probe unavailable; forced x264 fallback', {
        requestedEncoder: encoder,
        appliedFallbackEncoderId: appliedFallback ? 'obs_x264' : null,
        reason: decision.reason,
      });
    } catch (error) {
      console.error('[OBSRecorder] Failed to set encoder:', error);
    }
  }

  public updateEncoderIntent(mode: EncoderMode, encoder?: EncoderType): void {
    this.config.encoderMode = mode;
    this.settingsManager.updateConfig({ encoderMode: mode });

    if (encoder !== undefined) {
      this.config.encoder = encoder;
      this.settingsManager.updateConfig({ encoder });
    }
  }

  /**
   * Stop current recording (per-session state, no stale paths)
   * Returns typed result with explicit failure reasons
   */
  public async stopRecording(): Promise<StopRecordingResult> {
    // Precondition: no active session or already idle
    if (!this.currentSession || this.currentSession.status === 'idle') {
      console.warn('[OBSRecorder] No active recording to stop');
      return { ok: false, reason: 'no_active_session', durationSeconds: 0 };
    }

    // Idempotency: if already stopping, return existing promise
    if (this.stopPromise && this.currentSession.status === 'stopping') {
      console.log(
        '[OBSRecorder] Already stopping session, waiting for completion:',
        this.currentSession.id
      );
      return this.stopPromise;
    }

    // Guard: engine is in failed state, do not attempt IPC stop
    if (this.engineState === 'failed') {
      const durationSeconds = this.currentSession.startTime
        ? (Date.now() - this.currentSession.startTime.getTime()) / 1000
        : 0;

      console.warn('[OBSRecorder] Skipping stop - engine in failed state:', {
        sessionId: this.currentSession.id,
      });

      // Clear session state deterministically (recording is lost; IPC is dead)
      this.handleRecordingError('stop_error', 'OBS engine failed');

      return { ok: false, reason: 'stop_error', error: 'OBS engine failed', durationSeconds };
    }

    // Capture session data before any async operations
    const sessionId = this.currentSession.id;
    const startTime = this.currentSession.startTime;

    try {
      console.log('[OBSRecorder] Stopping recording session:', sessionId);

      // Transition to stopping
      this.currentSession.status = 'stopping';

      // Create promise that will resolve when Stop signal is received
      // Capture locally at creation time (race-safe: signal handler may clear this.stopPromise)
      const stopPromiseLocal = new Promise<StopRecordingResult>(resolve => {
        this.stopResolve = resolve;

        // Warn timer: logs warning but does NOT resolve or clear session
        this.warnTimeoutHandle = setTimeout(() => {
          console.warn(
            '[OBSRecorder] Stop signal not received after 30s (session still active):',
            sessionId
          );
        }, OBSRecorder.WARN_TIMEOUT_MS);

        // Hard timer: resolves with stop_timeout after 120s
        this.hardTimeoutHandle = setTimeout(() => {
          if (this.stopResolve) {
            const durationSeconds = startTime ? (Date.now() - startTime.getTime()) / 1000 : 0;

            console.error(
              '[OBSRecorder] Hard timeout reached - stop considered failed:',
              sessionId
            );

            // Clear warn timer if still pending
            if (this.warnTimeoutHandle) {
              clearTimeout(this.warnTimeoutHandle);
              this.warnTimeoutHandle = null;
            }

            // Do NOT call getLastRecording on timeout (no stale paths)
            // Clear state before resolving so late signals are treated as stale
            this.currentSession = null;
            const resolveRef = this.stopResolve;
            this.stopResolve = null;
            this.stopPromise = null;
            this.hardTimeoutHandle = null;

            resolveRef({ ok: false, reason: 'stop_timeout', durationSeconds });
          }
        }, OBSRecorder.HARD_TIMEOUT_MS);
      });
      this.stopPromise = stopPromiseLocal;

      // Request stop (signal handler may run synchronously on some platforms)
      osn.NodeObs.OBS_service_stopRecording();

      // Wait for stop signal or timeout (using local ref, immune to this.stopPromise being cleared)
      const result = await stopPromiseLocal;

      console.log('[OBSRecorder] Recording stopped for session:', {
        sessionId,
        ok: result.ok,
        filePath: result.ok ? result.filePath : undefined,
        reason: result.ok ? undefined : result.reason,
        duration: `${result.durationSeconds.toFixed(1)}s`,
      });

      // Emit event with file path and duration (for backward compatibility)
      const filePath = result.ok ? result.filePath : null;
      this.emit('recordingStopped', filePath, result.durationSeconds);

      return result;
    } catch (error) {
      console.error('[OBSRecorder] Failed to stop recording:', error);

      // Compute duration from captured startTime
      const durationSeconds = startTime ? (Date.now() - startTime.getTime()) / 1000 : 0;

      // Clear timeouts to prevent stale callbacks
      if (this.warnTimeoutHandle) {
        clearTimeout(this.warnTimeoutHandle);
        this.warnTimeoutHandle = null;
      }
      if (this.hardTimeoutHandle) {
        clearTimeout(this.hardTimeoutHandle);
        this.hardTimeoutHandle = null;
      }

      // Build failure result
      const errorMessage = error instanceof Error ? error.message : String(error);
      const failureResult: StopRecordingResult = {
        ok: false,
        reason: 'stop_error',
        error: `Stop failed: ${errorMessage}`,
        durationSeconds,
      };

      // Clear state before resolving (prevents late signals from interfering)
      // Pattern: capture + clear + resolve (same as hard-timeout)
      const resolveRef = this.stopResolve;
      this.currentSession = null;
      this.stopResolve = null;
      this.stopPromise = null;

      // Resolve for any concurrent callers waiting on idempotency promise
      resolveRef?.(failureResult);

      // Emit error for monitoring but return typed result (no throw)
      this.emit('error', error);

      return failureResult;
    }
  }

  /**
   * Get current recording status (derived from currentSession)
   */
  public async getStatus(): Promise<RecordingStatus> {
    // When engine is failed or shutting down, report as not initialized/recording
    const engineHealthy =
      this.engineState !== 'failed' &&
      this.engineState !== 'shuttingDown' &&
      this.engineState !== 'recovering';

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
    if (!this.getIsInitialized()) {
      const error = new Error('OBS not initialized');
      (error as any).code = 'OBS_NOT_INITIALIZED';
      throw error;
    }
    this.previewState = { isVisible: true, bounds };
    return this.previewManager.showPreview(bounds);
  }

  /**
   * Update preview bounds
   */
  public async updatePreviewBounds(bounds: PreviewBounds): Promise<void> {
    if (!this.getIsInitialized()) {
      const error = new Error('OBS not initialized');
      (error as any).code = 'OBS_NOT_INITIALIZED';
      throw error;
    }
    this.previewState.bounds = bounds;
    return this.previewManager.updatePreviewBounds(bounds);
  }

  /**
   * Hide preview
   */
  public hidePreview(): void {
    this.previewState.isVisible = false;
    this.previewManager.hidePreview();
  }

  /**
   * Check if OBS is initialized
   */
  public getIsInitialized(): boolean {
    return this.isInitialized && this.engineState === 'ready';
  }

  /**
   * Check if currently recording (derived from currentSession)
   */
  public getIsRecording(): boolean {
    return (
      this.currentSession?.status === 'recording' || this.currentSession?.status === 'stopping'
    );
  }

  public getCurrentEncoderId(): string | null {
    if (!this.getIsInitialized()) {
      return null;
    }

    try {
      return this.settingsManager.getRecordingEncoderId();
    } catch (error) {
      console.warn('[OBSRecorder] Failed to read current RecEncoder setting:', error);
      return null;
    }
  }

  /**
   * Shutdown OBS and cleanup resources
   */
  public async shutdown(): Promise<void> {
    console.log('[OBSRecorder] Shutting down...');
    this.lifecycleToken += 1;
    this.deferredRecoveryPending = false;

    // Transition to shuttingDown (unless already failed)
    if (this.engineState !== 'failed') {
      this.engineState = 'shuttingDown';
    }

    try {
      if (this.recoveryPromise) {
        await this.recoveryPromise.catch(() => undefined);
      }

      if (this.initializationPromise) {
        await this.initializationPromise.catch(() => undefined);
      }

      await this.teardownEngine({ stopActiveRecording: true, strict: false });

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
    this.recoveryToken += 1;
    this.lifecycleToken += 1;
    this.deferredRecoveryPending = false;

    // If a recording session exists, it is irrecoverably lost. Resolve any pending stop promise
    // and clear session/timeouts to prevent subsequent calls from attempting IPC.
    if (this.currentSession && this.currentSession.status !== 'idle') {
      this.handleRecordingError('stop_error', 'OBS IPC failed during recording');
    } else {
      // No active session, but ensure any pending stop state is cleared
      if (this.warnTimeoutHandle) {
        clearTimeout(this.warnTimeoutHandle);
        this.warnTimeoutHandle = null;
      }
      if (this.hardTimeoutHandle) {
        clearTimeout(this.hardTimeoutHandle);
        this.hardTimeoutHandle = null;
      }
      if (this.stopResolve) {
        this.stopResolve({
          ok: false,
          reason: 'stop_error',
          error: 'OBS IPC failed',
          durationSeconds: 0,
        });
        this.stopResolve = null;
      }
      this.stopPromise = null;
      this.currentSession = null;
    }

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

    const hasNativeEngineResources = this.isInitialized || this.nativeEngineStarted || !!this.context;

    if (hasNativeEngineResources) {
      try {
        osn.NodeObs.InitShutdownSequence();
      } catch (e) {
        console.warn('[OBSRecorder] InitShutdownSequence failed during fatal error handling:', e);
      }

      try {
        osn.NodeObs.OBS_service_removeCallback();
      } catch (e) {
        console.warn('[OBSRecorder] OBS_service_removeCallback failed during fatal error handling:', e);
      }

      try {
        osn.NodeObs.IPC.disconnect();
      } catch (e) {
        console.warn('[OBSRecorder] IPC.disconnect failed during fatal error handling:', e);
      }
    }

    this.isInitialized = false;
    this.nativeEngineStarted = false;

    // Emit typed error for upstream services
    const fatalError = new ObsFatalIpcError('Fatal OBS IPC failure', error);
    this.emit('error', fatalError);
  }

  /**
   * Get the OBS working directory (where binaries are located)
   */
  private getOBSWorkingDirectory(): string {
    // obs-studio-node may be hoisted to the workspace root node_modules, so resolve via Node.
    // OBS Studio Node expects its working directory to be the module root (where its binaries live).
    const moduleRoot = path.dirname(require.resolve('obs-studio-node/package.json'));
    return fixPathWhenPackaged(moduleRoot);
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

  private enumerateVideoEncoderIds(): string[] | undefined {
    try {
      return osn.VideoEncoderFactory.types();
    } catch (error) {
      console.warn('[OBSRecorder] Failed to enumerate OSN video encoders:', error);
      return undefined;
    }
  }

  private isWriteFailureStopError(error: string | undefined): boolean {
    if (!error) {
      return false;
    }

    const normalizedError = error.toLowerCase();
    return (
      normalizedError.includes('error writing to') ||
      normalizedError.includes('no space left on device') ||
      normalizedError.includes('av_interleaved_write_frame failed') ||
      normalizedError.includes('operation not permitted') ||
      normalizedError.includes('permission denied') ||
      normalizedError.includes('access is denied') ||
      normalizedError.includes('access denied')
    );
  }

  /**
   * Handle OBS output signals (recording events) with temporal correlation
   */
  private handleOutputSignal(obsSignal: OBSOutputSignal, signalGeneration: number): void {
    console.log('[OBSRecorder] Output signal:', obsSignal);

    // Check if this is a recording signal
    if (obsSignal.type !== 'recording') {
      return;
    }

    if (signalGeneration !== this.engineGeneration) {
      console.warn('[OBSRecorder] Ignoring stale output signal from prior engine generation:', {
        signal: obsSignal.signal,
        signalGeneration,
        currentGeneration: this.engineGeneration,
      });
      return;
    }

    if (this.engineState === 'recovering') {
      console.warn('[OBSRecorder] Ignoring output signal while recorder recovery is in progress:', {
        signal: obsSignal.signal,
        engineGeneration: signalGeneration,
      });
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
        console.log('[OBSRecorder] Recording stopped signal received');

        // Check for error condition FIRST - handles "early stop with error" (Case 1)
        // where OBS stops itself due to write error before stopRecording() is called
        const hasError = obsSignal.code !== undefined && obsSignal.code !== 0;
        const hasErrorString = !!obsSignal.error;

        if (hasError || hasErrorString) {
          // Error path: allow if session is active (starting/recording/stopping)
          // even if stopResolve is null (early stop with error before stopRecording called)
          if (this.currentSession && this.currentSession.status !== 'idle') {
            const errorReason = this.isWriteFailureStopError(obsSignal.error)
              ? 'write_error'
              : 'stop_error';
            console.warn('[OBSRecorder] Stop signal with error condition:', {
              code: obsSignal.code,
              error: obsSignal.error,
              classifiedReason: errorReason,
              sessionId: this.currentSession.id,
              status: this.currentSession.status,
            });

            this.handleRecordingError(errorReason, obsSignal.error);
            return; // handleRecordingError clears session and resolves if stopResolve exists
          }
          // No active session - ignore stale error signal
          console.warn('[OBSRecorder] Stale stop error signal ignored (no active session)');
          return;
        }

        // Success path: strict correlation guard - only process when stop is in progress
        // This prevents late/stale success signals from tearing down a new session
        if (
          !this.currentSession ||
          this.currentSession.status !== 'stopping' ||
          !this.stopResolve
        ) {
          console.warn('[OBSRecorder] Stale stop signal ignored (no active stop in progress)', {
            hasSession: !!this.currentSession,
            status: this.currentSession?.status,
            hasResolver: !!this.stopResolve,
          });
          return;
        }

        // Compute duration from session start time
        const durationSeconds = this.currentSession.startTime
          ? (Date.now() - this.currentSession.startTime.getTime()) / 1000
          : 0;

        // Get the recorded file path
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

        // Clear timeouts
        if (this.warnTimeoutHandle) {
          clearTimeout(this.warnTimeoutHandle);
          this.warnTimeoutHandle = null;
        }
        if (this.hardTimeoutHandle) {
          clearTimeout(this.hardTimeoutHandle);
          this.hardTimeoutHandle = null;
        }

        // Resolve promise with typed result
        const resolve = this.stopResolve;
        this.stopResolve = null;
        this.stopPromise = null;

        if (filePath) {
          resolve({ ok: true, filePath, durationSeconds });
        } else {
          // Stop signal received but OBS returned no file path.
          // Classified as stop_error (not write_error) because OBS did not explicitly
          // report a write failure - we only know the stop completed without a path.
          // This is intentionally mapped to failed_io upstream for user-facing status.
          resolve({
            ok: false,
            reason: 'stop_error',
            error: 'Stop signal received but OBS returned no recording path',
            durationSeconds,
          });
        }

        // Clear session only after successful resolution
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
        this.handleRecordingError('write_error', obsSignal.error || 'OBS writing_error');
        break;
      }
    }
  }

  /**
   * Handle recording error cleanup - shared logic for stop-with-error and writing_error signals
   */
  private handleRecordingError(
    reason: 'write_error' | 'stop_error',
    error: string | undefined
  ): void {
    // Compute duration from session start time
    const durationSeconds = this.currentSession?.startTime
      ? (Date.now() - this.currentSession.startTime.getTime()) / 1000
      : 0;

    // Emit recordingError event (backward compatibility)
    const errorEvent: RecordingErrorEvent = {
      sessionId: this.currentSession?.id || 'unknown',
      code: reason === 'write_error' ? -1 : -2,
      error,
    };
    this.emit('recordingError', errorEvent);

    // Clear timeouts
    if (this.warnTimeoutHandle) {
      clearTimeout(this.warnTimeoutHandle);
      this.warnTimeoutHandle = null;
    }
    if (this.hardTimeoutHandle) {
      clearTimeout(this.hardTimeoutHandle);
      this.hardTimeoutHandle = null;
    }

    // Resolve stopPromise with typed failure result
    if (this.stopResolve) {
      const result: StopRecordingResult = error
        ? { ok: false, reason, error, durationSeconds }
        : { ok: false, reason, durationSeconds };
      this.stopResolve(result);
      this.stopResolve = null;
      this.stopPromise = null;
    }

    // Reset session to idle to allow future recordings
    if (this.currentSession) {
      this.currentSession.status = 'idle';
      this.currentSession = null;
    }

    this.scheduleRecovery(reason, error);
  }

  private assertRecorderAvailableForStart(): void {
    const availabilityError = this.getStartAvailabilityError();
    if (availabilityError) {
      throw availabilityError;
    }
  }

  private scheduleRecovery(reason: 'write_error' | 'stop_error', error: string | undefined): void {
    if (this.engineState === 'failed' || this.engineState === 'shuttingDown') {
      return;
    }

    if (this.recoveryPromise) {
      console.warn('[OBSRecorder] Recovery already in progress; collapsing duplicate request:', {
        reason,
        error,
      });
      return;
    }

    console.warn('[OBSRecorder] Scheduling recorder recovery after recording failure:', {
      reason,
      error,
      engineGeneration: this.engineGeneration,
    });

    this.invalidateEngineGeneration();
    this.engineState = 'recovering';
    const recoveryToken = ++this.recoveryToken;
    if (reason === 'write_error') {
      this.deferredRecoveryPending = true;
    }
    this.recoveryPromise = Promise.resolve()
      .then(() => this.performRecoveryCycle(reason, error, recoveryToken))
      .catch(recoveryError => {
        console.warn('[OBSRecorder] Recovery promise settled with failure:', recoveryError);
      })
      .finally(() => {
        this.recoveryPromise = null;
      });
  }

  private async performRecoveryCycle(
    reason: 'write_error' | 'stop_error',
    error: string | undefined,
    recoveryToken: number
  ): Promise<void> {
    try {
      if (this.shouldAbortRecovery(recoveryToken)) {
        console.info('[OBSRecorder] Recorder recovery aborted before recycle:', {
          reason,
          error,
          engineState: this.engineState,
          recoveryToken,
          currentRecoveryToken: this.recoveryToken,
        });
        return;
      }

      await this.teardownEngine({ stopActiveRecording: false, strict: true });

      if (this.shouldAbortRecovery(recoveryToken)) {
        console.info('[OBSRecorder] Recorder recovery aborted after teardown:', {
          reason,
          error,
          engineState: this.engineState,
          recoveryToken,
          currentRecoveryToken: this.recoveryToken,
        });
        return;
      }

      if (reason === 'write_error') {
        this.isInitialized = false;
        console.info('[OBSRecorder] Recorder recovery deferred until next start/initialize:', {
          reason,
          error,
          recoveryToken,
          engineGeneration: this.engineGeneration,
        });
        return;
      }

      await this.initializeForRecovery(recoveryToken);

      if (this.shouldAbortRecovery(recoveryToken)) {
        console.info('[OBSRecorder] Recorder recovery aborted after initialization:', {
          reason,
          error,
          engineState: this.engineState,
          recoveryToken,
          currentRecoveryToken: this.recoveryToken,
        });
        return;
      }

      if (!this.isInitialized || this.engineState !== 'ready') {
        throw new Error('Recorder recovery completed without reaching ready state');
      }

      console.info('[OBSRecorder] Recorder recovery completed successfully:', {
        reason,
        error,
        engineGeneration: this.engineGeneration,
      });
    } catch (recoveryError) {
      if (
        recoveryError instanceof ObsRecorderShutdownAbortError ||
        recoveryError instanceof ObsRecorderFatalAbortError ||
        this.shouldAbortRecovery(recoveryToken)
      ) {
        console.info('[OBSRecorder] Recorder recovery aborted before completion:', {
          reason,
          error,
          engineState: this.engineState,
          recoveryToken,
          currentRecoveryToken: this.recoveryToken,
        });
        return;
      }

      this.isInitialized = false;
      this.currentSession = null;
      this.stopResolve = null;
      this.stopPromise = null;
      this.deferredRecoveryPending = false;
      this.engineState = 'failed';

      console.error('[OBSRecorder] Recorder recovery failed; recorder unavailable:', recoveryError);

      this.emit(
        'error',
        new ObsRecorderAvailabilityError(
          OBS_RECORDER_UNAVAILABLE,
          'OBS recorder recovery failed; recorder is unavailable.'
        )
      );

      throw recoveryError;
    }
  }

  private shouldAbortRecovery(recoveryToken: number): boolean {
    return (
      recoveryToken !== this.recoveryToken ||
      this.engineState === 'failed' ||
      this.isShutdownInProgress()
    );
  }

  private hasFailedState(): boolean {
    return this.engineState === 'failed';
  }

  private invalidateEngineGeneration(): void {
    this.engineGeneration += 1;
  }

  /**
   * Maps recorder lifecycle state to the public start-time contract:
   * recovering => typed recovering error
   * failed => typed unavailable error
   * everything else that is not ready => legacy not-initialized error
   */
  private getStartAvailabilityError(): Error | null {
    if (this.engineState === 'failed') {
      return new ObsRecorderAvailabilityError(
        OBS_RECORDER_UNAVAILABLE,
        'OBS recorder is unavailable.'
      );
    }

    if (this.recoveryPromise || this.engineState === 'recovering') {
      return new ObsRecorderAvailabilityError(
        OBS_RECORDER_RECOVERING,
        'OBS recorder is recovering from a previous output failure.'
      );
    }

    if (!this.isInitialized || this.engineState !== 'ready') {
      const error = new Error('OBS not initialized');
      (error as any).code = 'OBS_NOT_INITIALIZED';
      return error;
    }

    return null;
  }

  private assertRecorderAvailableAfterLifecycleJoin(): void {
    if (this.getIsInitialized()) {
      return;
    }

    if (this.isShutdownInProgress()) {
      throw new ObsRecorderShutdownAbortError();
    }

    throw new ObsRecorderAvailabilityError(
      OBS_RECORDER_UNAVAILABLE,
      'OBS recorder is unavailable.'
    );
  }

  private assertLifecycleReadyToPublish(lifecycleToken: number): void {
    if (this.hasFailedState()) {
      throw new ObsRecorderFatalAbortError();
    }

    if (lifecycleToken !== this.lifecycleToken || this.isShutdownInProgress()) {
      throw new ObsRecorderShutdownAbortError();
    }
  }

  private async completeDeferredRecoveryInitialization(
    trigger: 'initialize' | 'start'
  ): Promise<void> {
    if (!this.deferredRecoveryPending) {
      return;
    }

    const recoveryToken = this.recoveryToken;
    console.info('[OBSRecorder] Completing deferred recorder recovery before lifecycle action:', {
      trigger,
      recoveryToken,
      engineGeneration: this.engineGeneration,
    });

    try {
      await this.initializeForRecovery(recoveryToken);

      if (this.shouldAbortRecovery(recoveryToken)) {
        throw new Error('Deferred recorder recovery aborted before completion');
      }

      if (!this.isInitialized || this.engineState !== 'ready') {
        throw new Error('Deferred recorder recovery completed without reaching ready state');
      }

      this.deferredRecoveryPending = false;
      console.info('[OBSRecorder] Deferred recorder recovery completed successfully:', {
        trigger,
        recoveryToken,
        engineGeneration: this.engineGeneration,
      });
    } catch (error) {
      if (this.hasFailedState() || this.isShutdownInProgress()) {
        this.deferredRecoveryPending = false;
      }

      if (this.hasFailedState()) {
        throw new ObsRecorderAvailabilityError(
          OBS_RECORDER_UNAVAILABLE,
          'OBS recorder recovery failed; recorder is unavailable.'
        );
      }

      throw error;
    }
  }

  private async runInitialize(lifecycleToken: number): Promise<void> {
    this.engineState = 'initializing';

    try {
      const captureRecoverySettings = this.getCaptureRecoverySettingsSnapshot();
      console.log('[OBSRecorder] Initializing OBS Studio Node...');

      // Initialize IPC connection
      osn.NodeObs.IPC.host(this.uuid);
      this.nativeEngineStarted = true;

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

      const availableEncoderIds = this.enumerateVideoEncoderIds();
      const encoderDecision = resolveEncoderSelection({
        availableEncoderIds,
        mode: this.config.encoderMode || 'auto',
        preferredEncoder: this.config.encoder || 'x264',
      });

      console.info('[OBSRecorder] Encoder probe result:', {
        mode: this.config.encoderMode || 'auto',
        preferredEncoder: this.config.encoder || 'x264',
        availableEncoderIds: availableEncoderIds ?? null,
        decision: encoderDecision,
      });

      // Create and configure video context
      this.context = osn.VideoFactory.create();
      this.context.video = this.settingsManager.getVideoSettings();

      // Configure output settings
      if (encoderDecision.kind === 'resolved') {
        if (encoderDecision.reason === 'manual_requested_unavailable_fallback') {
          console.warn('[OBSRecorder] Manual encoder unavailable; applying fallback encoder', {
            requestedEncoder: encoderDecision.requestedEncoder,
            fallbackEncoderId: encoderDecision.encoderId,
            availableEncoderIds: availableEncoderIds ?? null,
          });
        }
        this.settingsManager.configureOutput({ encoderId: encoderDecision.encoderId });
      } else if (encoderDecision.reason === 'no_supported_h264') {
        console.warn(
          '[OBSRecorder] No supported H.264 encoder found in probe list; preserving OBS RecEncoder'
        );
        this.settingsManager.configureOutput({ preserveCurrentEncoder: true });
      } else {
        console.warn('[OBSRecorder] Encoder probe unavailable; forcing x264 fallback', {
          reason: encoderDecision.reason,
        });
        this.settingsManager.configureOutput({ encoderId: 'obs_x264' });
      }

      // Initialize capture manager (creates scene and game capture)
      await this.captureManager.initialize(this.context);
      this.restoreCaptureStateAfterInitialization(captureRecoverySettings);

      this.assertLifecycleReadyToPublish(lifecycleToken);

      // Set scene on preview manager if available
      const scene = this.captureManager.getScene();
      if (scene) {
        this.previewManager.setScene(scene);
      }
      await this.restorePreviewStateAfterInitialization();

      const nextEngineGeneration = this.engineGeneration + 1;
      this.engineGeneration = nextEngineGeneration;

      // Connect output signal handlers for recording events
      osn.NodeObs.OBS_service_connectOutputSignals((signal: OBSOutputSignal) => {
        this.handleOutputSignal(signal, nextEngineGeneration);
      });

      // Sync current settings from config to avoid unnecessary first updates
      this.syncCurrentSettingsFromOBS(captureRecoverySettings);
      this.assertLifecycleReadyToPublish(lifecycleToken);

      this.isInitialized = true;
      this.engineState = 'ready';
      console.log('[OBSRecorder] Initialization complete');
      this.emit('initialized');
    } catch (error) {
      if (
        error instanceof ObsRecorderShutdownAbortError ||
        error instanceof ObsRecorderFatalAbortError
      ) {
        this.isInitialized = false;
        console.info('[OBSRecorder] Initialization aborted:', error.message);
        throw error;
      }

      console.error('[OBSRecorder] Initialization failed:', error);
      this.engineState = 'failed';
      this.emit('error', error);
      throw error;
    }
  }

  private async initializeForRecovery(recoveryToken: number): Promise<void> {
    if (this.getIsInitialized()) {
      return;
    }

    if (this.initializationPromise) {
      await this.initializationPromise;
      return;
    }

    if (this.shouldAbortRecovery(recoveryToken)) {
      if (this.isShutdownInProgress()) {
        throw new ObsRecorderShutdownAbortError();
      }

      throw new ObsRecorderFatalAbortError();
    }

    const lifecycleToken = this.lifecycleToken;
    this.initializationPromise = this.runInitialize(lifecycleToken).finally(() => {
      this.initializationPromise = null;
    });
    await this.initializationPromise;
  }

  private async teardownEngine(options: {
    stopActiveRecording: boolean;
    strict: boolean;
  }): Promise<void> {
    const teardownErrors: string[] = [];

    const recordTeardownError = (step: string, teardownError: unknown): void => {
      const message =
        teardownError instanceof Error ? teardownError.message : String(teardownError);
      teardownErrors.push(`${step}: ${message}`);
      console.error(`[OBSRecorder] ${step} failed during teardown:`, teardownError);
    };

    if (options.stopActiveRecording && this.currentSession && this.currentSession.status !== 'idle') {
      try {
        await this.stopRecording();
      } catch (stopError) {
        recordTeardownError('stopRecording', stopError);
      }
    }

    try {
      this.captureManager.stopWoWDetection();
    } catch (stopDetectionError) {
      recordTeardownError('captureManager.stopWoWDetection', stopDetectionError);
    }

    const hasNativeEngineResources = this.isInitialized || this.nativeEngineStarted || !!this.context;

    if (hasNativeEngineResources) {
      console.log('[OBSRecorder] Tearing down OBS engine...');

      try {
        this.previewManager.destroyPreview();
      } catch (previewError) {
        recordTeardownError('previewManager.destroyPreview', previewError);
      }

      try {
        this.captureManager.releaseAll();
      } catch (releaseError) {
        recordTeardownError('captureManager.releaseAll', releaseError);
      }

      try {
        if (this.context) {
          this.context.destroy();
        }
      } catch (contextError) {
        recordTeardownError('context.destroy', contextError);
      } finally {
        this.context = null;
      }

      try {
        osn.NodeObs.InitShutdownSequence();
      } catch (initShutdownError) {
        recordTeardownError('NodeObs.InitShutdownSequence', initShutdownError);
      }

      try {
        osn.NodeObs.OBS_service_removeCallback();
      } catch (removeCallbackError) {
        recordTeardownError('NodeObs.OBS_service_removeCallback', removeCallbackError);
      }

      try {
        osn.NodeObs.IPC.disconnect();
      } catch (disconnectError) {
        recordTeardownError('NodeObs.IPC.disconnect', disconnectError);
      }
    }

    this.isInitialized = false;
    this.nativeEngineStarted = false;

    if (options.strict && teardownErrors.length > 0) {
      throw new Error(`OBS teardown failed during recovery: ${teardownErrors.join('; ')}`);
    }
  }

  private isShutdownInProgress(): boolean {
    return this.engineState === 'shuttingDown';
  }

  /**
   * Enforce user storage quota by deleting oldest recordings
   * PUBLIC API - delegate to manager
   */
  public async enforceStorageQuota(
    maxStorageGB: number,
    protectedVideoPaths?: Set<string>
  ): Promise<StorageQuotaEnforcementResult> {
    return this.storageManager.enforceStorageQuota(maxStorageGB, protectedVideoPaths);
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

    // Enforce UNSAFE settings lock while recording/stopping (defense-in-depth; UI already disables)
    if (this.getIsRecording()) {
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
        // Invariant: currentSettings must have fps/resolution defined for rollback
        // (set during initialize() or previous successful applyRecordingSettings)
        if (
          this.currentSettings.fps === undefined ||
          this.currentSettings.resolution === undefined
        ) {
          throw new Error(
            'Cannot apply video settings: currentSettings.fps or resolution undefined (initialization incomplete)'
          );
        }

        // Capture verified previous values for rollback on failure
        const previousFps = this.currentSettings.fps;
        const previousResolution = this.currentSettings.resolution;

        // Store requested values (don't commit to currentSettings until reinit succeeds)
        const requestedFps = changes.fps;
        const requestedResolution = changes.resolution;

        // Transactional: rollback settingsManager on any failure (throw or reinit failure)
        let videoSettingsApplied = false;
        try {
          // Update settingsManager (needed for reinit to pick up new values)
          if (requestedFps !== undefined) {
            this.settingsManager.setFPS(requestedFps);
          }
          if (requestedResolution !== undefined) {
            this.settingsManager.setResolution(requestedResolution);
          }

          // Reinitialize video context to apply FPS/resolution changes
          if (await this.reinitializeVideoContext()) {
            // Commit to currentSettings only on success (SSoT: diff-based retry remains valid on failure)
            if (requestedFps !== undefined) {
              this.currentSettings.fps = requestedFps;
            }
            if (requestedResolution !== undefined) {
              this.currentSettings.resolution = requestedResolution;
            }
            videoSettingsApplied = true;
          }
        } finally {
          // Rollback settingsManager if not successfully applied (SSoT: keep in sync with actual context)
          if (!videoSettingsApplied) {
            try {
              this.settingsManager.setFPS(previousFps);
            } catch (rollbackFpsErr) {
              console.error('[OBSRecorder] Failed to rollback FPS setting:', rollbackFpsErr);
            }
            try {
              this.settingsManager.setResolution(previousResolution);
            } catch (rollbackResErr) {
              console.error('[OBSRecorder] Failed to rollback resolution setting:', rollbackResErr);
            }
            allSuccessful = false;
          }
        }
      }

      // Apply quality setting (doesn't require context reinit)
      if (changes.quality !== undefined) {
        this.settingsManager.setQuality(changes.quality);
        this.currentSettings.quality = changes.quality;
      }

      // Capture settings
      if (changes.captureMode !== undefined) {
        if (this.captureManager.applyCaptureMode(changes.captureMode)) {
          this.currentSettings.captureMode = changes.captureMode;
        } else {
          allSuccessful = false;
        }
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
  private syncCurrentSettingsFromOBS(preservedSettings: Partial<RecordingSettings> = {}): void {
    // Preserve non-video settings so recovery can restore capture state after engine recycle.
    this.currentSettings = { ...preservedSettings };

    const currentVideoSettings = this.settingsManager.getVideoSettings();
    const resolvedFps = this.getRecordingFPSFromVideoSettings(currentVideoSettings);
    const resolvedResolution = this.getRecordingResolutionFromVideoSettings(currentVideoSettings);

    if (resolvedFps !== undefined) {
      this.currentSettings.fps = resolvedFps;
    } else if (preservedSettings.fps !== undefined) {
      this.currentSettings.fps = preservedSettings.fps;
    } else if (this.config.fps !== undefined) {
      this.currentSettings.fps = this.config.fps;
    }

    if (resolvedResolution !== undefined) {
      this.currentSettings.resolution = resolvedResolution;
    } else if (preservedSettings.resolution !== undefined) {
      this.currentSettings.resolution = preservedSettings.resolution;
    } else if (this.config.resolution !== undefined) {
      this.currentSettings.resolution = this.config.resolution;
    }

    // Seed quality from bitrate config to avoid no-op on first update
    // Note: We don't have a direct quality mapping from bitrate, so we leave it undefined
    // This ensures the first quality setting will be applied when requested
  }

  private getRecordingFPSFromVideoSettings(videoSettings: {
    fpsNum?: number;
  }): RecordingSettings['fps'] | undefined {
    if (videoSettings.fpsNum === 30 || videoSettings.fpsNum === 60) {
      return videoSettings.fpsNum;
    }

    return undefined;
  }

  private getRecordingResolutionFromVideoSettings(videoSettings: {
    baseWidth?: number;
    baseHeight?: number;
  }): Resolution | undefined {
    for (const [resolution, dimensions] of Object.entries(RESOLUTION_DIMENSIONS)) {
      if (
        dimensions.width === videoSettings.baseWidth &&
        dimensions.height === videoSettings.baseHeight
      ) {
        return resolution as Resolution;
      }
    }

    return undefined;
  }

  private async restorePreviewStateAfterInitialization(): Promise<void> {
    if (!this.previewState.isVisible || !this.previewState.bounds) {
      return;
    }

    try {
      await this.previewManager.showPreview(this.previewState.bounds);
    } catch (error) {
      console.warn('[OBSRecorder] Failed to restore preview after OBS initialization:', error);
    }
  }

  /**
   * Reinitialize video context for live FPS/resolution changes
   * Only allowed when not recording/stopping
   * @returns true if successful, false otherwise (never throws)
   */
  private async reinitializeVideoContext(): Promise<boolean> {
    // Guard: cannot reinit during recording/stopping or if no context
    if (this.getIsRecording() || !this.context) {
      return false;
    }

    try {
      // Get new video settings with updated resolution/FPS
      const newVideoSettings = this.settingsManager.getVideoSettings();

      // Check if video context actually needs updating
      const current = this.context.video;
      const needsUpdate =
        newVideoSettings.fpsNum !== current.fpsNum ||
        newVideoSettings.baseWidth !== current.baseWidth ||
        newVideoSettings.baseHeight !== current.baseHeight ||
        newVideoSettings.outputWidth !== current.outputWidth ||
        newVideoSettings.outputHeight !== current.outputHeight;

      if (!needsUpdate) {
        return true; // No change needed
      }

      // Transactional: capture previous state for rollback on failure
      const previousVideo = this.context.video;

      try {
        // Apply new video settings directly to existing context
        this.context.video = newVideoSettings;

        // Trigger re-scaling of active capture sources to new dimensions
        this.captureManager.rescaleToNewDimensions(this.context);

        return true;
      } catch (rescaleError) {
        // Rollback context.video to maintain SSoT consistency
        this.context.video = previousVideo;
        console.error('[OBSRecorder] Video context reinit failed, rolled back:', rescaleError);
        return false;
      }
    } catch (error) {
      console.error('[OBSRecorder] Video context reinit failed:', error);
      return false;
    }
  }

  /**
   * Get available audio devices
   */
  public getAudioDevices(): { input: AudioDevice[]; output: AudioDevice[] } {
    if (!this.getIsInitialized()) {
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
    if (!this.getIsInitialized() || !this.captureManager) {
      return [];
    }

    return this.captureManager.listMonitors();
  }

  /**
   * Set monitor by ID
   */
  public setMonitorById(monitorId: string): boolean {
    if (!this.getIsInitialized() || !this.captureManager) {
      return false;
    }

    const applied = this.captureManager.setMonitorById(monitorId);
    if (applied) {
      this.currentSettings.monitorId = monitorId;
    }
    return applied;
  }
}
