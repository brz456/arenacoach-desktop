/**
 * RecordingService - Integrates OBS recording with match detection events
 * Handles automatic recording start/stop based on arena match lifecycle
 */

import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';
import { app, BrowserWindow } from 'electron';
import { OBSRecorder, RecordingStatus, ObsFatalIpcError, RecordingErrorEvent } from './OBSRecorder';
import { RecordingSettings } from './RecordingTypes';
import type { OBSRecorderConfig } from './obs/OBSSettingsManager';
import type { PreviewBounds } from './obs/OBSPreviewManager';
import { MetadataService } from './MetadataService';
import { MatchStartedEvent } from '../match-detection/types/MatchEvent';
import { SettingsService } from './SettingsService';
import { Resolution, RECORDING_EXTENSION, THUMBNAIL_EXTENSION } from './RecordingTypes';
import type {
  VideoMetadataUpdate,
  RecordingStatusType,
} from '../match-detection/types/StoredMatchTypes';
import { spawn } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';

/**
 * Recording service configuration
 */
export interface RecordingServiceConfig extends OBSRecorderConfig {
  autoStart?: boolean;
  autoStop?: boolean;
  keepTemporaryFiles?: boolean;
  metadataIntegration?: boolean;
}

/**
 * Recording session information (V3: lifecycle-driven, bufferId-first)
 */
export interface RecordingSession {
  bufferId: string;
  tempDir: string;
  finalPath: string | null;
  startTime: Date;
  endTime: Date | null;
  duration: number;
  status: 'recording' | 'stopping' | 'completed' | 'failed';
}

/**
 * Service status with recording-specific information
 */
export interface RecordingServiceStatus extends RecordingStatus {
  isEnabled: boolean;
  currentSession: RecordingSession | null;
  currentMatchKey: string | null; // BufferId of current match
}

/**
 * Manages automatic recording of arena matches using OBS
 */
export class RecordingService extends EventEmitter {
  // Constants for timing values
  private static readonly TEMP_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
  private static readonly RENAME_RETRY_DELAY_MS = 1000; // 1 second

  private obsRecorder: OBSRecorder;
  private metadataService: MetadataService;
  private settingsService: SettingsService;
  private config: RecordingServiceConfig;
  private isEnabled = false;
  private currentSession: RecordingSession | null = null;
  private currentStopPromise: Promise<{ finalPath: string | null; deleted: boolean }> | null = null;
  private recordingsDir: string;
  private thumbnailsDir: string;

  constructor(
    config: RecordingServiceConfig = {},
    metadataService: MetadataService,
    settingsService?: SettingsService
  ) {
    super();

    this.config = {
      autoStart: config.autoStart ?? true,
      autoStop: config.autoStop ?? true,
      keepTemporaryFiles: config.keepTemporaryFiles ?? false,
      metadataIntegration: config.metadataIntegration ?? true,
      ...config,
    };

    // Store required metadata service (no fallback)
    this.metadataService = metadataService;

    // Store settings service with proper initialization
    this.settingsService = settingsService || new SettingsService();

    // Set up recordings directory - check settings first
    this.recordingsDir = this.getRecordingsDirectory();
    // Set up thumbnails directory as a subdirectory of recordings
    this.thumbnailsDir = path.join(this.recordingsDir, 'Thumbnails');

    // Initialize OBS recorder (self-contained capture)
    this.obsRecorder = new OBSRecorder({
      ...config,
      outputDir: this.recordingsDir,
    });

    this.setupEventHandlers();

    console.log('[RecordingService] Created with config:', this.config);
  }

  /**
   * Initialize the recording service
   */
  public async initialize(): Promise<void> {
    console.log('[RecordingService] Initializing...');

    try {
      // Ensure recordings directory exists
      await fs.promises.mkdir(this.recordingsDir, { recursive: true });
      // Ensure thumbnails directory exists
      await fs.promises.mkdir(this.thumbnailsDir, { recursive: true });

      // Initialize OBS recorder (includes capture management)
      await this.obsRecorder.initialize();

      this.isEnabled = true;
      console.log('[RecordingService] Initialization complete');
      this.emit('initialized');
    } catch (error) {
      console.error('[RecordingService] Initialization failed:', error);

      // Mark service as unavailable but don't crash the application
      this.isEnabled = false;

      console.warn(
        '[RecordingService] Recording functionality disabled due to OBS initialization failure'
      );
      this.emit('error', error);

      // Don't throw - allow application to continue without recording
      return;
    }
  }

  /**
   * Enable automatic recording and initialize OBS if needed
   */
  public async enable(): Promise<void> {
    try {
      // Re-initialize OBS if it was shut down
      if (this.obsRecorder && !(await this.obsRecorder.getStatus()).isInitialized) {
        console.log('[RecordingService] Re-initializing OBS...');
        await this.obsRecorder.initialize();
      }

      this.isEnabled = true;
      console.log('[RecordingService] Automatic recording enabled');
      this.emit('enabled');
    } catch (error) {
      console.error('[RecordingService] Failed to enable recording:', error);
      this.isEnabled = false;
      this.emit('error', error);
    }
  }

  /**
   * Disable automatic recording and shutdown OBS for lightweight operation
   */
  public async disable(): Promise<void> {
    this.isEnabled = false;

    try {
      // Stop any active recording first using unified helper
      if (this.currentSession && this.currentSession.status === 'recording') {
        await this.stopRecordingForMatch({
          bufferId: this.currentSession.bufferId,
          outcome: 'incomplete',
          reason: 'recording disabled',
        });
      }

      // Shutdown OBS to free resources when disabled
      if (this.obsRecorder) {
        await this.obsRecorder.shutdown();
        console.log('[RecordingService] OBS shut down for lightweight operation');
      }

      console.log('[RecordingService] Recording disabled and OBS shut down');
      this.emit('disabled');
    } catch (error) {
      console.error('[RecordingService] Error disabling recording:', error);
      this.emit('error', error);
    }
  }

  /**
   * Handle match started event - begin recording
   */
  public async handleMatchStarted(event: MatchStartedEvent): Promise<void> {
    if (!this.isEnabled || !this.config.autoStart) {
      console.log('[RecordingService] Skipping auto-start (disabled or OBS unavailable)');
      return;
    }

    if (!this.obsRecorder) {
      console.log('[RecordingService] OBS recorder not available, skipping recording');
      return;
    }

    // Check if already recording for this buffer (idempotency)
    if (this.currentSession && this.currentSession.bufferId === event.bufferId) {
      console.warn('[RecordingService] Already recording for this buffer:', event.bufferId);
      return;
    }

    // Stop stale session if recording for a different buffer
    if (this.currentSession && this.currentSession.bufferId !== event.bufferId) {
      console.warn('[RecordingService] Stopping stale session before new match:', {
        staleBuffer: this.currentSession.bufferId,
        newBuffer: event.bufferId,
      });
      await this.stopRecordingForMatch({
        bufferId: this.currentSession.bufferId,
        outcome: 'incomplete',
        reason: 'new match started',
      });
    }

    try {
      console.log(
        '[RecordingService] Match started, beginning recording for buffer:',
        event.bufferId
      );

      // Generate temp directory for match recording
      const tempDir = path.join(this.recordingsDir, 'temp');

      // Ensure temp directory exists
      await fs.promises.mkdir(tempDir, { recursive: true });

      // Start recording (pass directory, let OBS generate filename)
      const recordingPath = await this.obsRecorder.startRecording(tempDir);

      // Create session
      this.currentSession = {
        bufferId: event.bufferId,
        tempDir: recordingPath,
        finalPath: null,
        startTime: new Date(),
        endTime: null,
        duration: 0,
        status: 'recording',
      };

      // Mark recording as in_progress in metadata (clears any stale error fields)
      if (this.config.metadataIntegration) {
        await this.metadataService.updateVideoMetadataByBufferId(event.bufferId, {
          recordingStatus: 'in_progress' as RecordingStatusType,
          recordingErrorCode: undefined,
          recordingErrorMessage: undefined,
        });
      }

      console.log('[RecordingService] Recording started:', recordingPath);
      this.emit('recordingStarted', {
        bufferId: event.bufferId,
        path: recordingPath,
      });
    } catch (error) {
      console.error('[RecordingService] Failed to start recording:', error);
      this.emit('error', error);
    }
  }

  /**
   * Handle match ended event - stop recording for complete match
   */
  public async handleMatchEnded(bufferId: string): Promise<void> {
    if (!this.isEnabled || !this.config.autoStop) {
      console.log('[RecordingService] Skipping auto-stop (disabled)');
      return;
    }

    await this.stopRecordingForMatch({
      bufferId,
      outcome: 'complete',
    });
  }

  /**
   * Handle early end - stop recording for incomplete match
   */
  public async handleEarlyEnd(
    bufferId: string,
    reason: string
  ): Promise<{ finalPath: string | null; deleted: boolean }> {
    return this.stopRecordingForMatch({
      bufferId,
      outcome: 'incomplete',
      reason,
    });
  }

  /**
   * Unified stop helper - handles both complete and incomplete outcomes
   */
  private async stopRecordingForMatch(options: {
    bufferId: string;
    outcome: 'complete' | 'incomplete';
    reason?: string;
  }): Promise<{ finalPath: string | null; deleted: boolean }> {
    const { bufferId, outcome, reason } = options;

    // Guard: no current session
    if (!this.currentSession) {
      console.warn('[RecordingService] stopRecordingForMatch: no active session for', bufferId);
      return { finalPath: null, deleted: false };
    }

    // Guard: bufferId mismatch
    if (this.currentSession.bufferId !== bufferId) {
      console.warn('[RecordingService] stopRecordingForMatch: bufferId mismatch:', {
        session: this.currentSession.bufferId,
        requested: bufferId,
      });
      return { finalPath: null, deleted: false };
    }

    // Idempotency: if already stopping, return existing promise
    if (this.currentStopPromise && this.currentSession.status === 'stopping') {
      console.log(
        '[RecordingService] stopRecordingForMatch: already stopping, awaiting:',
        bufferId
      );
      return this.currentStopPromise;
    }

    // Guard: session not in recording state
    if (this.currentSession.status !== 'recording') {
      console.log('[RecordingService] stopRecordingForMatch: session not recording:', {
        bufferId,
        status: this.currentSession.status,
      });
      return { finalPath: this.currentSession.finalPath, deleted: false };
    }

    // Transition to stopping
    this.currentSession.status = 'stopping';

    // Create promise and cache it for idempotency
    this.currentStopPromise = (async (): Promise<{
      finalPath: string | null;
      deleted: boolean;
    }> => {
      try {
        // Call OBS stop
        const recordedFile = await this.obsRecorder.stopRecording();

        // If no file returned, mark as failed_io (Case 1: OBS write failure)
        if (!recordedFile) {
          console.warn('[RecordingService] OBS stop returned no file for:', bufferId);

          // Persist recording failure status in metadata
          if (this.config.metadataIntegration) {
            await this.metadataService.updateVideoMetadataByBufferId(bufferId, {
              recordingStatus: 'failed_io' as RecordingStatusType,
              recordingErrorCode: 'OBS_WRITE_ERROR',
              recordingErrorMessage:
                'OBS could not write to the recording directory. Check folder permissions or Windows Controlled Folder Access.',
            });
          }

          this.currentSession!.status = 'failed';
          this.currentSession = null;
          return { finalPath: null, deleted: false };
        }

        // Compute session end time and duration
        const endTime = new Date();
        const durationSeconds =
          (endTime.getTime() - this.currentSession!.startTime.getTime()) / 1000;

        // Determine target filename based on outcome
        let finalFilename: string;
        if (outcome === 'complete') {
          finalFilename = this.sanitizeFilename(`${bufferId}${RECORDING_EXTENSION}`);
        } else {
          const timestamp = this.currentSession!.startTime.toISOString().replace(/[:.]/g, '-');
          finalFilename = this.sanitizeFilename(
            `Incomplete_${bufferId}_${timestamp}${RECORDING_EXTENSION}`
          );
        }

        const targetPath = path.join(this.recordingsDir, finalFilename);

        // Attempt rename with fallback to temp path on failure (Case 2: rename EPERM)
        let actualFinalPath: string;
        let recordingStatus: RecordingStatusType = 'completed';
        let recordingErrorCode: string | undefined;
        let recordingErrorMessage: string | undefined;

        try {
          await this.renameWithRetry(recordedFile, targetPath);
          actualFinalPath = targetPath;
        } catch (renameError) {
          // Rename failed - fall back to temp file path
          console.warn('[RecordingService] Rename failed, using temp path as final:', {
            recordedFile,
            targetPath,
            error: (renameError as Error).message,
          });

          actualFinalPath = recordedFile;
          recordingStatus = 'completed_with_warning';
          recordingErrorCode = 'RENAME_FAILED';
          recordingErrorMessage =
            'Recording saved but could not be moved to the ArenaCoach recordings folder. Check permissions or antivirus settings.';
        }

        // Generate thumbnail (best-effort; failure should not change recording status)
        let thumbnailPath: string | null = null;
        try {
          thumbnailPath = await this.generateThumbnail(actualFinalPath, durationSeconds);
        } catch (thumbError) {
          console.warn(
            '[RecordingService] Thumbnail generation failed (non-critical):',
            thumbError
          );
        }

        // Update video metadata via MetadataService
        if (this.config.metadataIntegration) {
          const settings = this.getRecordingSettings();
          const videoMetadata: VideoMetadataUpdate = {
            videoPath: actualFinalPath,
            videoSize: (await fs.promises.stat(actualFinalPath)).size,
            videoDuration: durationSeconds,
            videoRecordedAt: new Date().toISOString(),
            videoResolution: this.getResolutionString(settings.resolution),
            videoFps: settings.fps,
            videoCodec: 'h264',
            recordingStatus,
          };

          // Only add error fields when defined (exactOptionalPropertyTypes compliance)
          if (recordingErrorCode !== undefined) {
            videoMetadata.recordingErrorCode = recordingErrorCode;
          }
          if (recordingErrorMessage !== undefined) {
            videoMetadata.recordingErrorMessage = recordingErrorMessage;
          }
          if (thumbnailPath) {
            videoMetadata.videoThumbnail = thumbnailPath;
          }

          await this.metadataService.updateVideoMetadataByBufferId(bufferId, videoMetadata);

          console.log('[RecordingService] Updated video metadata for bufferId:', bufferId);
        }

        // Emit appropriate event based on outcome (use actualFinalPath so UI can open it)
        if (outcome === 'complete') {
          // Load metadata to get matchHash
          const storedMetadata = await this.metadataService.loadMatchByBufferId(bufferId);
          const matchHash = storedMetadata?.matchHash;

          if (matchHash) {
            this.emit('recordingCompleted', {
              matchHash,
              bufferId,
              path: actualFinalPath,
              duration: durationSeconds,
            });
          } else {
            console.warn('[RecordingService] Complete match missing matchHash:', bufferId);
          }
        } else {
          this.emit('recordingInterrupted', {
            bufferId,
            path: actualFinalPath,
            duration: durationSeconds,
            reason: reason || 'incomplete',
          });
        }

        // Enforce disk quota if configured
        const settings = this.settingsService.getSettings();
        if (settings.maxDiskStorage && settings.maxDiskStorage > 0) {
          await this.obsRecorder.enforceStorageQuota(settings.maxDiskStorage);
        }

        // Update session status and clear
        this.currentSession!.finalPath = actualFinalPath;
        this.currentSession!.endTime = endTime;
        this.currentSession!.duration = durationSeconds;
        this.currentSession!.status = 'completed'; // A usable recording exists
        this.currentSession = null;

        // Clean up temp files if configured
        if (!this.config.keepTemporaryFiles) {
          await this.cleanupTempFiles();
        }

        return { finalPath: actualFinalPath, deleted: false };
      } catch (error) {
        console.error('[RecordingService] stopRecordingForMatch failed:', error);

        // Classify errors: OS I/O errors should not propagate up
        const errnoCode = (error as NodeJS.ErrnoException).code;
        const isOsIoError = ['EPERM', 'EBUSY', 'ENOENT', 'EACCES'].includes(errnoCode || '');

        // Persist failure status for all errors
        if (this.config.metadataIntegration) {
          try {
            await this.metadataService.updateVideoMetadataByBufferId(bufferId, {
              recordingStatus: 'failed_unknown' as RecordingStatusType,
              recordingErrorCode: 'RECORDING_STOP_ERROR',
              recordingErrorMessage: `Recording failed: ${(error as Error).message}`,
            });
          } catch (metaError) {
            console.warn('[RecordingService] Failed to persist failure status:', metaError);
          }
        }

        if (this.currentSession) {
          this.currentSession.status = 'failed';
          this.currentSession = null;
        }

        // Only rethrow non-OS I/O errors (programming/invariant violations)
        if (!isOsIoError) {
          throw error;
        }

        // OS I/O errors: log and return gracefully (no unhandled rejection)
        return { finalPath: null, deleted: false };
      } finally {
        this.currentStopPromise = null;
      }
    })();

    return this.currentStopPromise;
  }

  /**
   * Get current recording settings from config
   */
  private getRecordingSettings(): { resolution: Resolution; fps: number } {
    return {
      resolution: this.config.resolution || '1920x1080',
      fps: this.config.fps || 60,
    };
  }

  /**
   * Convert resolution setting to metadata string format
   */
  private getResolutionString(resolution: Resolution): string {
    // Resolution is already in the correct format (e.g., '1920x1080')
    return resolution;
  }

  /**
   * Get service status
   */
  public async getStatus(): Promise<RecordingServiceStatus> {
    const obsStatus = this.obsRecorder
      ? await this.obsRecorder.getStatus()
      : {
          isInitialized: false,
          isRecording: false,
          currentFile: null,
          duration: 0,
          frameCount: 0,
          droppedFrames: 0,
          cpuUsage: 0,
          diskUsedGB: 0,
        };

    return {
      ...obsStatus,
      isEnabled: this.isEnabled,
      currentSession: this.currentSession,
      currentMatchKey: this.currentSession?.bufferId || null,
    };
  }

  /**
   * Clean up orphaned temporary files (from failed recordings only)
   * Preserves temp files that are referenced by match metadata (rename fallback case)
   */
  private async cleanupTempFiles(): Promise<void> {
    const tempDir = path.join(this.recordingsDir, 'temp');

    try {
      // Check if directory exists
      await fs.promises.access(tempDir);

      // Get set of temp paths that are referenced by match metadata
      // These should NOT be deleted even if they're old
      // Pass tempDir for prefix-based filtering with normalized paths
      const referencedTempPaths = await this.metadataService.getReferencedTempPaths(tempDir);

      const files = await fs.promises.readdir(tempDir);
      const now = Date.now();
      const isWindows = process.platform === 'win32';

      for (const file of files) {
        // Normalize filePath for consistent comparison with referenced paths
        const filePath = path.resolve(path.join(tempDir, file));

        // Skip files that are referenced by match metadata (rename fallback recordings)
        // Case-insensitive comparison on Windows
        const filePathForLookup = isWindows ? filePath.toLowerCase() : filePath;
        const isReferenced = isWindows
          ? Array.from(referencedTempPaths).some(p => p.toLowerCase() === filePathForLookup)
          : referencedTempPaths.has(filePath);

        if (isReferenced) {
          console.log('[RecordingService] Skipping referenced temp file (rename fallback):', file);
          continue;
        }

        try {
          const stats = await fs.promises.stat(filePath);
          const age = now - stats.mtimeMs;

          // Only delete orphaned temp files from failed recordings (age-based)
          if (age > RecordingService.TEMP_FILE_MAX_AGE_MS && stats.isFile()) {
            await fs.promises.unlink(filePath);
            console.log('[RecordingService] Cleaned up orphaned temp file:', file);
          }
        } catch {
          console.warn('[RecordingService] Could not stat temp file:', file);
        }
      }
    } catch (error: unknown) {
      if (error instanceof Error && (error as any).code === 'ENOENT') {
        // Directory doesn't exist, nothing to clean
        return;
      }
      console.error('[RecordingService] Error cleaning temp files:', error);
    }
  }

  /**
   * Setup event handlers for OBS recorder
   */
  private setupEventHandlers(): void {
    this.obsRecorder.on('initialized', () => {
      console.log('[RecordingService] OBS recorder initialized');
      this.emit('obsInitialized');
    });

    this.obsRecorder.on('recordingStarted', (path: string) => {
      console.log('[RecordingService] OBS recording started:', path);
    });

    this.obsRecorder.on('recordingStopped', (path: string, duration: number) => {
      console.log('[RecordingService] OBS recording stopped:', {
        path,
        duration: `${duration.toFixed(1)}s`,
      });
    });

    this.obsRecorder.on('error', (error: Error) => {
      console.error('[RecordingService] OBS error:', error);
      // Recognize fatal IPC errors and disable recording service
      if (error instanceof ObsFatalIpcError || (error as any)?.code === 'OBS_IPC_FATAL') {
        console.warn('[RecordingService] Fatal OBS IPC error detected, disabling recording');
        this.isEnabled = false;
      }
      this.emit('obsError', error);
    });

    // Handle user-facing recording errors (folder/permission issues)
    // This handles Case 1: OBS emits stop with error code before stopRecording is called
    this.obsRecorder.on('recordingError', async (event: RecordingErrorEvent) => {
      console.warn('[RecordingService] OBS recording error:', {
        sessionId: event.sessionId,
        code: event.code,
        error: event.error,
      });

      // Persist failure to metadata BEFORE clearing session (Case 1 requirement)
      if (this.config.metadataIntegration && this.currentSession?.bufferId) {
        try {
          await this.metadataService.updateVideoMetadataByBufferId(this.currentSession.bufferId, {
            recordingStatus: 'failed_io' as RecordingStatusType,
            recordingErrorCode: 'OBS_WRITE_ERROR',
            recordingErrorMessage:
              'OBS could not write to the recording directory. Check folder permissions or Windows Controlled Folder Access.',
          });
          console.log(
            '[RecordingService] Persisted recording failure for bufferId:',
            this.currentSession.bufferId
          );
        } catch (metaError) {
          console.warn('[RecordingService] Failed to persist recording failure:', metaError);
        }

        // Clear local session so stopRecordingForMatch returns early cleanly
        this.currentSession.status = 'failed';
        this.currentSession = null;
      }

      // Build user-friendly message
      const userMessage =
        'Recording failed due to a folder/permission issue. Check your recording location and antivirus settings.';

      // Emit typed event for renderer notification
      this.emit('recordingError', userMessage);
    });
  }

  /**
   * Rename file with retry logic to handle timing issues
   */
  private async renameWithRetry(source: string, dest: string, retries = 3): Promise<void> {
    for (let i = 0; i < retries; i++) {
      try {
        // Attempt rename directly - fs.promises.rename will throw if source doesn't exist
        await fs.promises.rename(source, dest);
        console.log('[RecordingService] File renamed successfully:', dest);
        return;
      } catch (error: unknown) {
        if (i === retries - 1) {
          console.error('[RecordingService] Failed to rename after retries:', error);
          throw error;
        }
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.warn(`[RecordingService] Rename failed, retry ${i + 1}/${retries}:`, errorMessage);
        await new Promise(resolve => setTimeout(resolve, RecordingService.RENAME_RETRY_DELAY_MS));
      }
    }
  }

  /**
   * Generate thumbnail for video file
   * @param videoPath - Path to the video file
   * @param duration - Video duration in seconds
   * @returns Path to generated thumbnail or null if failed
   */
  private async generateThumbnail(videoPath: string, duration: number): Promise<string | null> {
    try {
      // Calculate thumbnail time: halfway through the recording
      const thumbnailTime = duration / 2;

      // Generate thumbnail path in Thumbnails folder (same name + THUMBNAIL_EXTENSION)
      const parsedPath = path.parse(videoPath);
      const thumbnailPath = path.join(
        this.thumbnailsDir,
        `${parsedPath.name}${THUMBNAIL_EXTENSION}`
      );

      // Resolve the ffmpeg binary path (fix asar path)
      const ffmpegPathRaw = ffmpegStatic as unknown as string;
      const ffmpegPath = ffmpegPathRaw?.includes('app.asar')
        ? ffmpegPathRaw.replace('app.asar', 'app.asar.unpacked')
        : ffmpegPathRaw;

      // Guard against unresolved binary path for determinism
      if (!ffmpegPath) {
        throw new Error('FFmpeg binary path could not be resolved');
      }

      // Build ffmpeg arguments
      const args = [
        '-y', // Overwrite existing thumbnail for idempotency
        '-ss',
        String(thumbnailTime),
        '-i',
        videoPath,
        '-frames:v',
        '1',
        '-update',
        '1', // Required for single image output (not sequence)
        '-q:v',
        '2', // JPEG quality (2 = high quality, 1 = highest, 31 = lowest)
        '-vf',
        'scale=640:-1',
        thumbnailPath,
      ];

      // Generate thumbnail using spawn
      await new Promise<void>((resolve, reject) => {
        const ffmpegProcess = spawn(ffmpegPath, args);

        let stderr = '';

        ffmpegProcess.stderr.on('data', data => {
          stderr += data.toString();
        });

        ffmpegProcess.on('exit', code => {
          if (code === 0) {
            console.log('[RecordingService] Thumbnail generated:', thumbnailPath);
            resolve();
          } else {
            console.error('[RecordingService] Thumbnail generation failed with code:', code);
            console.error('[RecordingService] FFmpeg stderr:', stderr);
            reject(new Error(`FFmpeg exited with code ${code}`));
          }
        });

        ffmpegProcess.on('error', err => {
          console.error('[RecordingService] Failed to spawn ffmpeg:', err);
          reject(err);
        });
      });

      return thumbnailPath;
    } catch (error) {
      console.error('[RecordingService] Failed to generate thumbnail:', error);
      return null; // Non-critical failure
    }
  }

  /**
   * Update the recording directory at runtime
   * This updates both the recordings directory and thumbnails subdirectory
   */
  public async updateRecordingDirectory(newDirectory: string): Promise<void> {
    try {
      // Validate the new directory
      if (!newDirectory || typeof newDirectory !== 'string') {
        throw new Error('Invalid recording directory');
      }

      // Normalize and validate path - don't use root directories
      const normalizedPath = path.normalize(newDirectory);
      const isRootDir = normalizedPath === path.parse(normalizedPath).root;

      let finalPath = normalizedPath;
      if (isRootDir) {
        // If it's a root directory, create a subdirectory for recordings
        finalPath = path.join(normalizedPath, 'ArenaCoach', 'Recordings');
        console.warn(
          `[RecordingService] Root directory "${normalizedPath}" not allowed, using "${finalPath}" instead`
        );

        // Update the settings with the sanitized path so UI shows the correct location
        try {
          this.settingsService.updateSettings({ recordingLocation: finalPath });
          console.log('[RecordingService] Updated settings with sanitized path:', finalPath);
        } catch (updateError) {
          console.warn(
            '[RecordingService] Failed to update settings with sanitized path:',
            updateError
          );
          // Continue with the safe path even if settings update fails
        }
      }

      // Update the directories
      this.recordingsDir = finalPath;
      this.thumbnailsDir = path.join(finalPath, 'Thumbnails');

      // Ensure the recordings directory exists; thumbnails dir will be lazily ensured at thumbnail time
      await fs.promises.mkdir(this.recordingsDir, { recursive: true });

      // Update the OBS recorder output directory
      if (this.obsRecorder) {
        this.obsRecorder.updateOutputDirectory(this.recordingsDir);
      }

      console.log('[RecordingService] Recording directory updated:', {
        recordingsDir: this.recordingsDir,
        thumbnailsDir: this.thumbnailsDir,
      });
    } catch (error) {
      console.error('[RecordingService] Failed to update recording directory:', error);
      throw error;
    }
  }

  /**
   * Get recordings directory from settings or use default
   */
  private getRecordingsDirectory(): string {
    try {
      if (this.settingsService) {
        const settings = this.settingsService.getSettings();
        if (settings.recordingLocation) {
          // Validate the path - don't use root directories
          const normalizedPath = path.normalize(settings.recordingLocation);

          // Check if it's a root directory (e.g., "E:\", "C:\", "/")
          const isRootDir = normalizedPath === path.parse(normalizedPath).root;

          if (isRootDir) {
            // If it's a root directory, create a subdirectory for recordings
            const safePath = path.join(normalizedPath, 'ArenaCoach', 'Recordings');
            console.warn(
              `[RecordingService] Root directory "${normalizedPath}" not allowed, using "${safePath}" instead`
            );

            // Update the settings with the sanitized path so UI shows the correct location
            try {
              this.settingsService.updateSettings({ recordingLocation: safePath });
              console.log('[RecordingService] Updated settings with sanitized path:', safePath);
            } catch (updateError) {
              console.warn(
                '[RecordingService] Failed to update settings with sanitized path:',
                updateError
              );
              // Continue with the safe path even if settings update fails
            }

            return safePath;
          }

          // Valid non-root directory
          return normalizedPath;
        }
      }
    } catch (error) {
      console.warn('[RecordingService] Failed to get recording location from settings:', error);
    }

    // Fall back to default
    return this.config.outputDir || path.join(app.getPath('videos'), 'ArenaCoach', 'Recordings');
  }

  /**
   * Sanitize filename to remove invalid characters
   */
  private sanitizeFilename(filename: string): string {
    // Replace invalid Windows filename characters
    return filename.replace(/[<>:"|?*]/g, '_');
  }

  /**
   * Set WoW process active state (pass-through to OBS recorder)
   */
  public setWoWActive(active: boolean): void {
    this.obsRecorder.setWoWActive(active);
  }

  /**
   * Enable or disable game capture mode (pass-through to OBS recorder)
   */
  public setGameCaptureEnabled(enabled: boolean): void {
    this.obsRecorder.setGameCaptureEnabled(enabled);
  }

  /**
   * Set main window for preview display (pass-through to OBS recorder)
   */
  public setMainWindow(window: BrowserWindow): void {
    this.obsRecorder.setMainWindow(window);
  }

  /**
   * Show preview at specified bounds (pass-through to OBS recorder)
   */
  public async showPreview(bounds: PreviewBounds): Promise<void> {
    if (!this.isEnabled) {
      // Preview is not available when recording is disabled - no-op
      return;
    }
    return this.obsRecorder.showPreview(bounds);
  }

  /**
   * Update preview bounds (pass-through to OBS recorder)
   */
  public async updatePreviewBounds(bounds: PreviewBounds): Promise<void> {
    if (!this.isEnabled) {
      // Preview is not available when recording is disabled - no-op
      return;
    }
    return this.obsRecorder.updatePreviewBounds(bounds);
  }

  /**
   * Hide preview (pass-through to OBS recorder)
   */
  public hidePreview(): void {
    if (!this.isEnabled) {
      // Preview is not available when recording is disabled - no-op
      return;
    }
    this.obsRecorder.hidePreview();
  }

  /**
   * Check if OBS is initialized (pass-through to OBS recorder)
   */
  public isOBSInitialized(): boolean {
    return this.obsRecorder.getIsInitialized();
  }

  /**
   * Check if recording is active (pass-through to OBS recorder)
   */
  public isRecordingActive(): boolean {
    return this.obsRecorder.getIsRecording();
  }

  /**
   * Apply recording settings to OBS (pass-through to OBS recorder)
   * @returns true if all settings applied successfully, false if any failed
   */
  public async applyRecordingSettings(settings: Partial<RecordingSettings>): Promise<boolean> {
    // Guard: reject settings updates when recording is disabled (e.g., after fatal IPC error)
    if (!this.isEnabled) {
      console.warn('[RecordingService] Recording disabled; ignoring settings update');
      return false;
    }

    // First apply all settings including capture mode
    const result = await this.obsRecorder.applyRecordingSettings(settings);

    // Apply encoder after base settings if provided
    if (settings.encoder !== undefined) {
      try {
        this.obsRecorder.setEncoder(settings.encoder);
      } catch (e) {
        console.warn('[RecordingService] Failed to set encoder:', settings.encoder, e);
        // Non-fatal; return overall result regardless
      }
    }

    // Then apply monitor selection AFTER mode switch if needed
    if (settings.monitorId !== undefined) {
      // Get current capture mode - either from settings being applied or from saved settings
      const currentMode =
        settings.captureMode || this.settingsService.getSettings().recording.captureMode;

      if (currentMode === 'monitor_capture') {
        await this.obsRecorder.setMonitorById(settings.monitorId);
      }
    }

    return result;
  }

  /**
   * Get available audio devices (pass-through to OBS recorder)
   */
  public async getAudioDevices(): Promise<{
    input: Array<{ id: string; name: string }>;
    output: Array<{ id: string; name: string }>;
  }> {
    return this.obsRecorder.getAudioDevices();
  }

  /**
   * Get available monitors (pass-through to OBS recorder)
   */
  public async getMonitors(): Promise<Array<{ id: string; name: string }>> {
    return this.obsRecorder.getMonitors();
  }

  /**
   * Shutdown the service and cleanup resources
   */
  public async shutdown(): Promise<void> {
    console.log('[RecordingService] Shutting down...');

    try {
      // Stop any active recording using unified helper
      if (this.currentSession && this.currentSession.status === 'recording') {
        await this.stopRecordingForMatch({
          bufferId: this.currentSession.bufferId,
          outcome: 'incomplete',
          reason: 'shutdown',
        });
      }

      // Shutdown OBS recorder
      await this.obsRecorder.shutdown();

      this.isEnabled = false;
      console.log('[RecordingService] Shutdown complete');
      this.emit('shutdown');
    } catch (error) {
      console.error('[RecordingService] Error during shutdown:', error);
      this.emit('error', error);
    }
  }
}
