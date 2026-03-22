/**
 * RecordingService - Integrates OBS recording with match detection events
 * Handles automatic recording start/stop based on arena match lifecycle
 */

import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';
import { app, BrowserWindow } from 'electron';
import {
  OBSRecorder,
  RecordingStatus,
  ObsFatalIpcError,
  RecordingErrorEvent,
  StopRecordingResult,
  ObsRecorderAvailabilityError,
  OBS_RECORDING_DIRECTORY_UNAVAILABLE,
  OBS_RECORDER_RECOVERING,
  OBS_RECORDER_UNAVAILABLE,
} from './OBSRecorder';
import { RecordingSettings } from './RecordingTypes';
import type { OBSRecorderConfig } from './obs/OBSSettingsManager';
import type { PreviewBounds } from './obs/OBSPreviewManager';
import { MetadataService } from './MetadataService';
import { MatchStartedEvent } from '../match-detection/types/MatchEvent';
import { SettingsService } from './SettingsService';
import { Resolution, RECORDING_EXTENSION, THUMBNAIL_EXTENSION } from './RecordingTypes';
import {
  DEFAULT_RECORDING_SUBDIR,
  getEffectiveRecordingDirectory,
} from '../utils/recordingPathUtils';
import { isNodeError } from '../utils/errors';
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
  private recorderFailureMetadataWrites = new Map<string, Promise<boolean>>();
  private recordingsDir: string;
  private thumbnailsDir: string;

  constructor(
    config: RecordingServiceConfig = {},
    metadataService: MetadataService,
    settingsService: SettingsService
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

    // Store required settings service (no fallback)
    this.settingsService = settingsService;

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
        this.refreshEncoderIntentFromSettings();
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

  private refreshEncoderIntentFromSettings(): void {
    const recordingSettings = this.settingsService.getSettings().recording;
    const encoderMode = recordingSettings.encoderMode || 'auto';
    const encoder = recordingSettings.encoder || 'x264';

    this.config.encoderMode = encoderMode;
    this.config.encoder = encoder;
    this.obsRecorder.updateEncoderIntent(encoderMode, encoder);
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

      await this.ensureRecordingDirectoryReadyForStart();

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
      if (error instanceof ObsRecorderAvailabilityError) {
        const availabilityCode =
          error.code === OBS_RECORDER_RECOVERING
            ? OBS_RECORDER_RECOVERING
            : error.code === OBS_RECORDER_UNAVAILABLE
              ? OBS_RECORDER_UNAVAILABLE
              : OBS_RECORDING_DIRECTORY_UNAVAILABLE;
        await this.handleRecorderUnavailableStartFailure(event.bufferId, availabilityCode);
        return;
      }

      if (this.isRecordingPathUnavailableStartError(error)) {
        await this.handleRecorderUnavailableStartFailure(
          event.bufferId,
          OBS_RECORDING_DIRECTORY_UNAVAILABLE
        );
        return;
      }

      console.error('[RecordingService] Failed to start recording:', error);
      this.emit('error', error);
    }
  }

  private async handleRecorderUnavailableStartFailure(
    bufferId: string,
    code:
      | typeof OBS_RECORDER_RECOVERING
      | typeof OBS_RECORDER_UNAVAILABLE
      | typeof OBS_RECORDING_DIRECTORY_UNAVAILABLE
  ): Promise<void> {
    const failureDetails =
      code === OBS_RECORDER_RECOVERING
        ? {
            recordingErrorCode: OBS_RECORDER_RECOVERING,
            recordingErrorMessage:
              'Recording did not start because the OBS recorder is recovering from a previous output failure.',
            userMessage:
              'Recording did not start because OBS is recovering from a previous recording failure.',
          }
        : code === OBS_RECORDER_UNAVAILABLE
          ? {
              recordingErrorCode: OBS_RECORDER_UNAVAILABLE,
              recordingErrorMessage:
                'Recording did not start because the OBS recorder is unavailable after a failed recovery.',
              userMessage:
                'Recording did not start because OBS is unavailable after a previous recording failure.',
            }
          : {
              recordingErrorCode: OBS_RECORDING_DIRECTORY_UNAVAILABLE,
              recordingErrorMessage:
                'Recording did not start because the preferred recording directory is unavailable.',
              userMessage:
                'Recording did not start because the recording folder is unavailable. Reconnect the drive or choose a different recording folder.',
            };

    if (this.config.metadataIntegration) {
      try {
        await this.metadataService.updateVideoMetadataByBufferId(bufferId, {
          recordingStatus: 'failed_unknown' as RecordingStatusType,
          recordingErrorCode: failureDetails.recordingErrorCode,
          recordingErrorMessage: failureDetails.recordingErrorMessage,
        });
      } catch (metadataError) {
        console.warn(
          '[RecordingService] Failed to persist recorder-unavailable start failure:',
          metadataError
        );
      }
    }

    this.emit('recordingError', failureDetails.userMessage);
  }

  private persistRecorderFailureMetadata(
    bufferId: string,
    update: {
      recordingStatus: RecordingStatusType;
      recordingErrorCode: string;
      recordingErrorMessage: string;
    }
  ): Promise<boolean> {
    if (!this.config.metadataIntegration) {
      return Promise.resolve(true);
    }

    return this.metadataService
      .updateVideoMetadataByBufferId(bufferId, update)
      .then(() => true)
      .catch(metaError => {
        console.warn('[RecordingService] Failed to persist recording failure:', metaError);
        return false;
      });
  }

  private async consumeRecorderFailureMetadataWrite(bufferId: string): Promise<boolean> {
    const writePromise = this.recorderFailureMetadataWrites.get(bufferId);

    if (!writePromise) {
      return false;
    }

    try {
      return await writePromise;
    } finally {
      this.recorderFailureMetadataWrites.delete(bufferId);
    }
  }

  private async ensureRecordingDirectoryReadyForStart(): Promise<void> {
    const unavailableRoot = this.getUnavailableRecordingRoot(this.recordingsDir);

    if (!unavailableRoot) {
      return;
    }

    console.warn(
      `[RecordingService] Recording root unavailable during start: "${this.recordingsDir}" (missing root: "${unavailableRoot}")`
    );

    throw new ObsRecorderAvailabilityError(
      OBS_RECORDING_DIRECTORY_UNAVAILABLE,
      'Recording directory root is unavailable.'
    );
  }

  private isRecordingPathUnavailableStartError(error: unknown): boolean {
    if (!isNodeError(error)) {
      return false;
    }

    return ['ENOENT', 'ENODEV', 'EIO'].includes(error.code);
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
    if (!this.isEnabled || !this.config.autoStop) {
      console.log('[RecordingService] Skipping early end stop (disabled)');
      return { finalPath: null, deleted: false };
    }

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

    // Capture session data BEFORE any async operation (race-condition fix)
    const sessionRef = this.currentSession;
    const sessionStartTime = this.currentSession.startTime;
    const sessionBufferId = this.currentSession.bufferId;

    // Create promise and cache it for idempotency
    this.currentStopPromise = (async (): Promise<{
      finalPath: string | null;
      deleted: boolean;
    }> => {
      try {
        // Call OBS stop - returns typed result
        const stopResult: StopRecordingResult = await this.obsRecorder.stopRecording();

        // Handle failure cases based on reason
        if (!stopResult.ok) {
          const { reason, error: errorMsg, durationSeconds } = stopResult;
          const eventMetadataWriteSucceeded =
            reason === 'write_error' || reason === 'stop_error'
              ? await this.consumeRecorderFailureMetadataWrite(sessionBufferId)
              : false;

          // Map reason to recordingStatus and error code
          let recordingStatus: RecordingStatusType;
          let recordingErrorCode: string;
          let recordingErrorMessage: string;

          // Handle no_active_session: best-effort metadata update + clear session
          if (reason === 'no_active_session') {
            console.warn('[RecordingService] OBS reported no active session for:', sessionBufferId);

            // Best-effort metadata update: only if still in_progress (avoid clobbering better status)
            if (this.config.metadataIntegration) {
              try {
                const currentMeta = await this.metadataService.loadMatchByBufferId(sessionBufferId);
                if (
                  !currentMeta?.recordingStatus ||
                  currentMeta.recordingStatus === 'in_progress'
                ) {
                  await this.metadataService.updateVideoMetadataByBufferId(sessionBufferId, {
                    recordingStatus: 'failed_unknown' as RecordingStatusType,
                    recordingErrorCode: 'OBS_NO_ACTIVE_SESSION',
                    recordingErrorMessage:
                      'No active OBS recording session was found when stopping.',
                  });
                }
              } catch (metaError) {
                console.warn(
                  '[RecordingService] Failed to update metadata for no_active_session:',
                  metaError
                );
              }
            }

            // Clear session only if still the same session (race-safety)
            if (this.currentSession === sessionRef) {
              this.currentSession.status = 'failed';
              this.currentSession = null;
            }
            return { finalPath: null, deleted: false };
          }

          // Determine failure status for other reasons - split deterministically
          if (reason === 'stop_timeout') {
            recordingStatus = 'failed_timeout';
            recordingErrorCode = 'OBS_STOP_TIMEOUT';
            recordingErrorMessage = 'Recording stop timed out; OBS may be unresponsive.';
          } else if (reason === 'write_error') {
            // write_error: OBS explicitly reported a write failure
            recordingStatus = 'failed_io';
            recordingErrorCode = 'OBS_WRITE_ERROR';
            recordingErrorMessage =
              'OBS could not write to the recording directory. Check folder permissions or Windows Controlled Folder Access.';
          } else {
            // stop_error: stop failed for unknown reason → failed_unknown (not failed_io)
            recordingStatus = 'failed_unknown';
            recordingErrorCode = 'OBS_STOP_ERROR';
            recordingErrorMessage = 'Recording failed while stopping in OBS.';
          }

          // Log technical details separately (not persisted to user-facing metadata)
          console.warn('[RecordingService] OBS stop failed:', {
            bufferId: sessionBufferId,
            reason,
            technicalError: errorMsg,
            duration: durationSeconds,
            metadataOwner: eventMetadataWriteSucceeded ? 'recordingError_event' : 'stop_result',
          });

          // Signal-originated recorder failures only suppress fallback persistence after a
          // confirmed successful event-path write.
          if (this.config.metadataIntegration && !eventMetadataWriteSucceeded) {
            await this.metadataService.updateVideoMetadataByBufferId(sessionBufferId, {
              recordingStatus,
              recordingErrorCode,
              recordingErrorMessage,
            });
          }

          // Clear session only if still the same session (race-safety)
          if (this.currentSession === sessionRef) {
            this.currentSession.status = 'failed';
            this.currentSession = null;
          }
          return { finalPath: null, deleted: false };
        }

        // Success case - extract file path and duration from result
        const { filePath: recordedFile, durationSeconds } = stopResult;

        // Compute session end time
        const endTime = new Date();

        // Determine target filename based on outcome
        let finalFilename: string;
        if (outcome === 'complete') {
          finalFilename = this.sanitizeFilename(`${sessionBufferId}${RECORDING_EXTENSION}`);
        } else {
          const timestamp = sessionStartTime.toISOString().replace(/[:.]/g, '-');
          finalFilename = this.sanitizeFilename(
            `Incomplete_${sessionBufferId}_${timestamp}${RECORDING_EXTENSION}`
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

          await this.metadataService.updateVideoMetadataByBufferId(sessionBufferId, videoMetadata);

          console.log('[RecordingService] Updated video metadata for bufferId:', sessionBufferId);
        }

        // Emit appropriate event based on outcome (use actualFinalPath so UI can open it)
        if (outcome === 'complete') {
          // Load metadata to get matchHash
          const storedMetadata = await this.metadataService.loadMatchByBufferId(sessionBufferId);
          const matchHash = storedMetadata?.matchHash;

          if (matchHash) {
            this.emit('recordingCompleted', {
              matchHash,
              bufferId: sessionBufferId,
              path: actualFinalPath,
              duration: durationSeconds,
            });
          } else {
            console.warn('[RecordingService] Complete match missing matchHash:', sessionBufferId);
          }
        } else {
          this.emit('recordingInterrupted', {
            bufferId: sessionBufferId,
            path: actualFinalPath,
            duration: durationSeconds,
            reason: reason || 'incomplete',
          });
        }

        // Enforce disk quota if configured
        // Wrapped in separate try/catch: quota failures should not mark the current recording as failed
        const settings = this.settingsService.getSettings();
        if (settings.maxDiskStorage && settings.maxDiskStorage > 0) {
          // Resolve protected paths for favourite recordings (metadata integration)
          let protectedVideoPaths: Set<string> | undefined;
          let shouldEnforceQuota = true;

          if (this.config.metadataIntegration) {
            try {
              const { paths, scanErrors } =
                await this.metadataService.listFavouriteVideoPathsWithDiagnostics();

              if (scanErrors.length > 0) {
                console.error(
                  '[RecordingService] Metadata scan incomplete, skipping quota enforcement:',
                  scanErrors
                );
                shouldEnforceQuota = false;
              } else {
                protectedVideoPaths = paths;
              }
            } catch (metadataError) {
              console.error(
                '[RecordingService] Failed to list favourite video paths (non-critical):',
                metadataError
              );
              // Skip quota enforcement when protected path list is incomplete
              shouldEnforceQuota = false;
            }
          }

          if (shouldEnforceQuota) {
            try {
              const quotaResult = await this.obsRecorder.enforceStorageQuota(
                settings.maxDiskStorage,
                protectedVideoPaths
              );

              // Update metadata for each deleted recording (gated by metadataIntegration)
              if (this.config.metadataIntegration) {
                for (const deleted of quotaResult.deleted) {
                  try {
                    // Match by exact videoPath to update metadata
                    await this.metadataService.markRecordingDeletedByQuotaByVideoPath(
                      deleted.filePath
                    );
                  } catch (metaError) {
                    console.warn(
                      '[RecordingService] Failed to update metadata for quota-deleted recording:',
                      { filePath: deleted.filePath, error: metaError }
                    );
                  }
                }
              }

              // Emit retention cleanup event for renderer notification (unconditional)
              if (quotaResult.deleted.length > 0) {
                const deletedCount = quotaResult.deleted.length;
                const freedGB = Number(
                  quotaResult.deleted.reduce((sum, d) => sum + d.sizeGB, 0).toFixed(1)
                );
                this.emit('recordingRetentionCleanup', {
                  deletedCount,
                  freedGB,
                  maxGB: settings.maxDiskStorage,
                });
              }
            } catch (quotaError) {
              // Quota enforcement failed - log but don't fail the current recording
              console.warn('[RecordingService] Quota enforcement failed (non-critical):', quotaError);
            }
          }
        }

        // Update session status and clear only if still the same session (race-safety)
        if (this.currentSession === sessionRef) {
          this.currentSession.finalPath = actualFinalPath;
          this.currentSession.endTime = endTime;
          this.currentSession.duration = durationSeconds;
          this.currentSession.status = 'completed'; // A usable recording exists
          this.currentSession = null;
        }

        this.recorderFailureMetadataWrites.delete(sessionBufferId);

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
            await this.metadataService.updateVideoMetadataByBufferId(sessionBufferId, {
              recordingStatus: 'failed_unknown' as RecordingStatusType,
              recordingErrorCode: 'RECORDING_STOP_ERROR',
              recordingErrorMessage: `Recording failed: ${(error as Error).message}`,
            });
          } catch (metaError) {
            console.warn('[RecordingService] Failed to persist failure status:', metaError);
          }
        }

        // Clear session only if still the same session (race-safety)
        if (this.currentSession === sessionRef) {
          this.currentSession.status = 'failed';
          this.currentSession = null;
        }

        this.recorderFailureMetadataWrites.delete(sessionBufferId);

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

  public getCurrentEncoderId(): string | null {
    if (!this.obsRecorder || !this.obsRecorder.getIsInitialized()) {
      return null;
    }

    return this.obsRecorder.getCurrentEncoderId();
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
      if (isNodeError(error) && error.code === 'ENOENT') {
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

    this.obsRecorder.on('recordingStopped', (path: string | null, duration: number) => {
      console.log('[RecordingService] OBS recording stopped:', {
        path,
        duration: `${duration.toFixed(1)}s`,
      });
    });

    this.obsRecorder.on('error', (error: Error) => {
      console.error('[RecordingService] OBS error:', error);
      // Recognize fatal IPC errors and disable recording service
      if (error instanceof ObsFatalIpcError) {
        console.warn('[RecordingService] Fatal OBS IPC error detected, disabling recording');
        this.isEnabled = false;
      }
      this.emit('obsError', error);
    });

    // Handle user-facing recording errors
    // Race-condition fix: capture session data before await, re-check after
    this.obsRecorder.on('recordingError', async (event: RecordingErrorEvent) => {
      console.warn('[RecordingService] OBS recording error:', {
        sessionId: event.sessionId,
        code: event.code,
        error: event.error,
        stopInProgress: !!this.currentStopPromise,
      });

      // Determine error classification based on event.code (deterministic)
      // -1 = write_error (OBS write failure), -2 = stop_error (stop failed)
      const isWriteError = event.code === -1;
      const recordingErrorCode = isWriteError ? 'OBS_WRITE_ERROR' : 'OBS_STOP_ERROR';
      // Deterministic status mapping: write_error → failed_io, stop_error → failed_unknown
      const recordingStatus: RecordingStatusType = isWriteError ? 'failed_io' : 'failed_unknown';
      const recordingErrorMessage = isWriteError
        ? 'OBS could not write to the recording directory. Check folder permissions or Windows Controlled Folder Access.'
        : 'Recording failed while stopping in OBS.';
      // User message: don't assert specific cause for write errors
      const userMessage = isWriteError
        ? 'OBS could not write the recording. Check free disk space, folder permissions, and Windows Controlled Folder Access/antivirus.'
        : 'Recording failed while stopping. Check OBS logs for details.';

      // Capture session data BEFORE any await (race-condition fix)
      const sessionRef = this.currentSession;
      const capturedBufferId = sessionRef?.bufferId;

      // If no active session or no bufferId: emit and return (don't mutate)
      if (!capturedBufferId) {
        this.emit('recordingError', userMessage);
        return;
      }

      const metadataWritePromise = this.persistRecorderFailureMetadata(capturedBufferId, {
        recordingStatus,
        recordingErrorCode,
        recordingErrorMessage,
      });
      this.recorderFailureMetadataWrites.set(capturedBufferId, metadataWritePromise);

      const metadataWriteSucceeded = await metadataWritePromise;
      if (metadataWriteSucceeded) {
        console.log('[RecordingService] Persisted recording failure for bufferId:', capturedBufferId);
      }

      // B-guard: Only mutate session if stop is NOT in progress AND session unchanged
      // If stop IS in progress or session changed, the stop flow will handle cleanup
      if (!this.currentStopPromise && this.currentSession === sessionRef) {
        this.currentSession.status = 'failed';
        this.currentSession = null;
        this.recorderFailureMetadataWrites.delete(capturedBufferId);
      }

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

      // The recording root may have been removed/recreated since initialization.
      // Re-ensure the thumbnails directory before spawning ffmpeg.
      await fs.promises.mkdir(this.thumbnailsDir, { recursive: true });

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

      // Use SSoT for path resolution (handles root directory sanitization)
      const normalizedPath = path.normalize(newDirectory);
      const finalPath = getEffectiveRecordingDirectory(normalizedPath, app.getPath('videos'));

      // If path was sanitized (e.g., root dir), update settings so UI shows correct location
      if (finalPath !== normalizedPath) {
        console.warn(
          `[RecordingService] Root directory "${normalizedPath}" not allowed, using "${finalPath}" instead`
        );
        try {
          this.settingsService.updateSettings({ recordingLocation: finalPath });
          console.log('[RecordingService] Updated settings with sanitized path:', finalPath);
        } catch (updateError) {
          console.warn(
            '[RecordingService] Failed to update settings with sanitized path:',
            updateError
          );
        }
      }

      await this.applyActiveRecordingDirectory(finalPath);
    } catch (error) {
      console.error('[RecordingService] Failed to update recording directory:', error);
      throw error;
    }
  }

  /**
   * Get recordings directory from settings or use default.
   * Uses SSoT from recordingPathUtils for path resolution.
   */
  private getRecordingsDirectory(): string {
    const safeDefaultDir = this.getSafeDefaultRecordingDirectory();
    const defaultDir = this.config.outputDir || safeDefaultDir;

    const settings = this.settingsService.getSettings();

    // If no recording location in settings, use defaultDir (respects config.outputDir)
    if (!settings.recordingLocation) {
      return defaultDir;
    }

    const effectiveDir = getEffectiveRecordingDirectory(
      settings.recordingLocation,
      app.getPath('videos')
    );

    // If directory was sanitized (any transformation), update settings so UI shows correct location
    const normalizedInput = path.normalize(settings.recordingLocation);
    const unavailableRoot = this.getUnavailableRecordingRoot(effectiveDir);

    if (unavailableRoot) {
      console.warn(
        `[RecordingService] Recording directory root unavailable, temporarily using default: "${effectiveDir}" (missing root: "${unavailableRoot}")`
      );
      return safeDefaultDir;
    }

    if (normalizedInput !== effectiveDir) {
      console.warn(
        `[RecordingService] Sanitized recording directory: "${normalizedInput}" -> "${effectiveDir}"`
      );
      try {
        this.settingsService.updateSettings({ recordingLocation: effectiveDir });
        console.log('[RecordingService] Updated settings with sanitized path:', effectiveDir);
      } catch (updateError) {
        console.warn(
          '[RecordingService] Failed to update settings with sanitized path:',
          updateError
        );
      }
    }

    return effectiveDir;
  }

  private getSafeDefaultRecordingDirectory(): string {
    return path.join(app.getPath('videos'), DEFAULT_RECORDING_SUBDIR);
  }

  private getUnavailableRecordingRoot(recordingDir: string): string | null {
    const windowsRootMatch = recordingDir.match(/^[A-Za-z]:[\\/]/);
    const root = windowsRootMatch?.[0] ?? path.parse(recordingDir).root;

    if (!root) {
      return null;
    }

    return fs.existsSync(root) ? null : root;
  }

  private async applyActiveRecordingDirectory(newDirectory: string): Promise<void> {
    this.recordingsDir = newDirectory;
    this.thumbnailsDir = path.join(newDirectory, 'Thumbnails');

    await fs.promises.mkdir(this.recordingsDir, { recursive: true });
    await fs.promises.mkdir(this.thumbnailsDir, { recursive: true });

    if (this.obsRecorder) {
      this.obsRecorder.updateOutputDirectory(this.recordingsDir);
    }

    console.log('[RecordingService] Recording directory updated:', {
      recordingsDir: this.recordingsDir,
      thumbnailsDir: this.thumbnailsDir,
    });
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
