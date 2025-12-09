import { EventEmitter } from 'events';
import { app } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Mutex } from 'async-mutex';
import {
  StoredMatchMetadata,
  UploadStatus,
  ValidationResult,
  VideoMetadataUpdate,
} from '../match-detection/types/StoredMatchTypes';
import { BRACKET_STRINGS } from '../match-detection/types/MatchMetadata';

/**
 * Configuration for the Metadata Storage Service
 */
export interface MetadataStorageServiceConfig {
  /** Maximum number of files to keep (0 = unlimited) */
  maxFiles?: number;
  /** Optional override for the root storage directory (used by tests) */
  storageDir?: string;
}

/**
 * Service for managing local match metadata storage
 * Provides persistent file-based storage for match data and analysis results
 */
export class MetadataStorageService extends EventEmitter {
  private readonly storageDir: string;
  private readonly config: MetadataStorageServiceConfig;
  private isInitialized = false;
  private mutexes = new Map<string, Mutex>();

  constructor(config: MetadataStorageServiceConfig = {}) {
    super();
    this.config = {
      maxFiles: 1000, // Default limit
      ...config,
    };

    // Set up storage directory: use explicit storageDir if provided, otherwise default path
    if (config.storageDir) {
      this.storageDir = config.storageDir;
    } else {
      const userDataPath = app ? app.getPath('userData') : path.join(process.cwd(), 'data');
      this.storageDir = path.join(userDataPath, 'logs', 'matches');
    }

    // Prevent unhandled error crashes with Windows-specific error classification
    this.on('error', errorData => {
      const error = errorData.error;

      // Classify Windows-specific transient vs permanent errors
      const isTransient =
        error?.code === 'EBUSY' || // Antivirus scanning
        error?.code === 'EPERM' || // Temporary permissions
        error?.code === 'ENOENT'; // Race condition

      if (isTransient) {
        console.warn(
          '[MetadataStorageService] Transient storage issue (will retry):',
          error?.message || 'Unknown error'
        );
      } else {
        console.error('[MetadataStorageService] Permanent storage issue:', errorData);
        // Could emit to UI for user notification
      }
    });
  }

  /**
   * Initialize the service and ensure storage directory exists
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      console.warn('[MetadataStorageService] Already initialized');
      return;
    }

    try {
      await this.ensureStorageDirectory();
      console.info('[MetadataStorageService] Initialized with storage directory:', this.storageDir);
      this.isInitialized = true;
      this.emit('initialized');
    } catch (error) {
      console.error('[MetadataStorageService] Failed to initialize:', error);
      this.emit('error', { context: 'initialization', error });
      throw error;
    }
  }

  /**
   * Get or create a mutex for the given matchHash
   * @private
   */
  private getMutex(matchHash: string): Mutex {
    if (!this.mutexes.has(matchHash)) {
      this.mutexes.set(matchHash, new Mutex());
    }
    return this.mutexes.get(matchHash)!;
  }

  /**
   * Save match metadata to local storage
   */
  public async saveMatch(metadata: StoredMatchMetadata): Promise<void> {
    return this.safeFileOperation(async () => {
      // Serialize saves per instance using hash if available, else bufferId
      const mutexKey = metadata.matchHash || metadata.bufferId!;
      const mutex = this.getMutex(mutexKey);

      return await mutex.runExclusive(async () => {
        return await this._saveMatchInternal(metadata);
      });
    }, 'saving match metadata');
  }

  /**
   * Internal save method without mutex (for use when already inside mutex context)
   * @private
   */
  private async _saveMatchInternal(metadata: StoredMatchMetadata): Promise<void> {
    // Validate metadata before saving
    const validation = this.validateMetadata(metadata);
    if (!validation.isValid) {
      throw new Error(`Invalid metadata: ${validation.errors.join(', ')}`);
    }

    await this.ensureStorageDirectory();

    //  Use bufferId for filename consistency throughout lifecycle
    const filename = this.generateFileName(metadata.bufferId!);
    const filepath = path.join(this.storageDir, filename);

    // Add storage metadata directly to the object (preserve creation time)
    if (!metadata.storedAt) {
      metadata.storedAt = Date.now();
    }

    // Atomic write using temporary file to prevent race conditions
    const tempFilepath = `${filepath}.tmp`;
    await fs.writeFile(tempFilepath, JSON.stringify(metadata, null, 2), 'utf-8');

    try {
      await fs.rename(tempFilepath, filepath);
    } catch (renameError: any) {
      // Handle case where target file exists or is locked (e.g., from previous incomplete match or antivirus)
      if (
        renameError.code === 'EPERM' ||
        renameError.code === 'EEXIST' ||
        renameError.code === 'EBUSY'
      ) {
        console.warn(
          '[MetadataStorageService] Target file exists or is locked, removing and retrying:',
          filepath
        );
        try {
          // Best-effort delete: ignore ENOENT (file already gone), log others
          try {
            await fs.unlink(filepath);
          } catch (unlinkError: any) {
            if (unlinkError.code === 'ENOENT') {
              // File already gone - this is fine, continue with retry
            } else {
              console.warn(
                '[MetadataStorageService] Failed to remove existing file:',
                unlinkError.message
              );
              throw unlinkError; // Re-throw non-ENOENT errors
            }
          }

          // Minimal backoff for transient locks (antivirus, etc.)
          await new Promise(resolve => setTimeout(resolve, Math.random() * 25 + 25)); // 25-50ms

          await fs.rename(tempFilepath, filepath); // Retry atomic rename
        } catch (retryError) {
          // Cleanup temp file and re-throw
          await fs.unlink(tempFilepath).catch(() => {}); // Best effort cleanup
          throw retryError;
        }
      } else {
        // Cleanup temp file and re-throw for other errors
        await fs.unlink(tempFilepath).catch(() => {}); // Best effort cleanup
        throw renameError;
      }
    }

    console.debug('[MetadataStorageService] Saved match metadata:', {
      matchHash: metadata.matchHash,
      bufferId: metadata.bufferId,
      uploadStatus: metadata.uploadStatus, // Renamed for clarity - this is upload status, not match completion status
    });

    this.emit('matchSaved', {
      matchHash: metadata.matchHash,
      bufferId: metadata.bufferId,
      filepath,
    });
  }

  /**
   * Load match metadata by bufferId - PRIMARY lookup method
   * BREAKING CHANGE: Uses content-based bufferId matching for architectural decoupling
   */
  public async loadMatchByBufferId(bufferId: string): Promise<StoredMatchMetadata | null> {
    return this.safeFileOperation(
      async () => {
        const files = await this.getMatchFiles();

        // Search through all files for matching bufferId in content
        for (const file of files) {
          try {
            const filepath = path.join(this.storageDir, file);
            const content = await fs.readFile(filepath, 'utf-8');
            const metadata = JSON.parse(content) as StoredMatchMetadata;

            if (metadata.bufferId === bufferId) {
              // Normalize all Date objects after JSON read
              if (metadata.matchData?.timestamp) {
                metadata.matchData.timestamp = new Date(metadata.matchData.timestamp as any);
              }
              if (metadata.createdAt) {
                metadata.createdAt = new Date(metadata.createdAt as any);
              }
              if (metadata.lastUpdatedAt) {
                metadata.lastUpdatedAt = new Date(metadata.lastUpdatedAt as any);
              }

              return metadata;
            }
          } catch (error) {
            console.warn(
              '[MetadataStorageService] Failed to load file during bufferId search:',
              file,
              error
            );
            // Continue with other files
          }
        }

        return null; // No matching bufferId found
      },
      'loading match metadata by bufferId',
      null
    );
  }

  /**
   * Load match metadata by match hash - SECONDARY lookup method
   * BREAKING CHANGE: Uses content-based hash matching, not filename patterns
   */
  public async loadMatch(matchHash: string): Promise<StoredMatchMetadata | null> {
    return this.safeFileOperation(
      async () => {
        const files = await this.getMatchFiles();

        // Search through all files for matching matchHash in content
        for (const file of files) {
          try {
            const filepath = path.join(this.storageDir, file);
            const content = await fs.readFile(filepath, 'utf-8');
            const metadata = JSON.parse(content) as StoredMatchMetadata;

            if (metadata.matchHash === matchHash) {
              // Normalize all Date objects after JSON read
              if (metadata.matchData?.timestamp) {
                metadata.matchData.timestamp = new Date(metadata.matchData.timestamp as any);
              }
              if (metadata.createdAt) {
                metadata.createdAt = new Date(metadata.createdAt as any);
              }
              if (metadata.lastUpdatedAt) {
                metadata.lastUpdatedAt = new Date(metadata.lastUpdatedAt as any);
              }

              return metadata;
            }
          } catch (error) {
            console.warn(
              '[MetadataStorageService] Failed to load file during hash search:',
              file,
              error
            );
            // Continue with other files
          }
        }

        return null; // No matching hash found
      },
      'loading match metadata by hash',
      null
    );
  }

  /**
   * Find match metadata by jobId (for SSE correlation)
   */
  public async findMatchByJobId(jobId: string): Promise<StoredMatchMetadata | null> {
    return this.safeFileOperation(
      async () => {
        const files = await this.getMatchFiles();

        // Search through all files for matching jobId
        for (const file of files) {
          try {
            const filepath = path.join(this.storageDir, file);
            const content = await fs.readFile(filepath, 'utf-8');
            const metadata = JSON.parse(content) as StoredMatchMetadata;

            if (metadata.jobId === jobId) {
              return metadata;
            }
          } catch (error) {
            console.warn(
              '[MetadataStorageService] Failed to load file during jobId search:',
              file,
              error
            );
            // Continue with other files
          }
        }

        return null;
      },
      'finding match by jobId',
      null
    );
  }

  /**
   * Load all match files with their metadata for batch operations
   * @private
   */
  private async loadAllMatchesWithFiles(): Promise<
    { file: string; metadata: StoredMatchMetadata }[]
  > {
    const files = await this.getMatchFiles();

    const matchPromises = files.map(async file => {
      try {
        const filepath = path.join(this.storageDir, file);
        const content = await fs.readFile(filepath, 'utf-8');
        const metadata = JSON.parse(content) as StoredMatchMetadata;

        // Normalize all Date objects after JSON read (JSON.parse returns strings)
        if (metadata.matchData?.timestamp) {
          metadata.matchData.timestamp = new Date(metadata.matchData.timestamp as any);
        }
        if (metadata.createdAt) {
          metadata.createdAt = new Date(metadata.createdAt as any);
        }
        if (metadata.lastUpdatedAt) {
          metadata.lastUpdatedAt = new Date(metadata.lastUpdatedAt as any);
        }

        return { file, metadata };
      } catch (error) {
        console.warn(
          '[MetadataStorageService] Failed to load file during batch operation:',
          file,
          error
        );
        return null;
      }
    });

    const results = await Promise.all(matchPromises);
    return results.filter((m): m is { file: string; metadata: StoredMatchMetadata } => m !== null);
  }

  /**
   * List matches with pagination support
   * Sorts by timestamp from file content (newest first) - optimized for memory usage
   */
  public async listMatches(limit = 50, offset = 0): Promise<StoredMatchMetadata[]> {
    return this.safeFileOperation(
      async () => {
        const files = await this.getMatchFiles();

        // Sort files by timestamp prefix in filename (newest first) - avoids loading all files
        const sortedFiles = files.sort((a, b) => {
          const timestampA = parseInt(a.split('_')[0] || '0', 10);
          const timestampB = parseInt(b.split('_')[0] || '0', 10);
          return timestampB - timestampA; // Newest first
        });

        // Apply pagination at file level to minimize memory usage
        const paginatedFiles = sortedFiles.slice(offset, offset + limit);

        // Load only the files we need for this page
        const matchPromises = paginatedFiles.map(async file => {
          try {
            const filepath = path.join(this.storageDir, file);
            const content = await fs.readFile(filepath, 'utf-8');
            const metadata = JSON.parse(content) as StoredMatchMetadata;

            // Normalize all Date objects after JSON read
            if (metadata.matchData?.timestamp) {
              metadata.matchData.timestamp = new Date(metadata.matchData.timestamp as any);
            }
            if (metadata.createdAt) {
              metadata.createdAt = new Date(metadata.createdAt as any);
            }
            if (metadata.lastUpdatedAt) {
              metadata.lastUpdatedAt = new Date(metadata.lastUpdatedAt as any);
            }

            return metadata;
          } catch (error) {
            console.warn(
              '[MetadataStorageService] Failed to load file during pagination:',
              file,
              error
            );
            return null;
          }
        });

        const results = await Promise.all(matchPromises);
        return results.filter((m): m is StoredMatchMetadata => m !== null);
      },
      'listing matches',
      []
    );
  }

  /**
   * List all matches without pagination
   * Used internally for cross-cutting concerns (e.g., temp file protection)
   */
  public async listAllMatches(): Promise<StoredMatchMetadata[]> {
    return this.safeFileOperation(
      async () => {
        const allMatches = await this.loadAllMatchesWithFiles();
        return allMatches.map(entry => entry.metadata);
      },
      'listing all matches',
      []
    );
  }

  /**
   * Update match upload status and additional metadata
   * Uses async-mutex to prevent race conditions in concurrent writes
   */
  public async updateMatchStatus(
    matchHash: string,
    status: UploadStatus,
    additionalData: Partial<StoredMatchMetadata> = {}
  ): Promise<void> {
    return this.safeFileOperation(async () => {
      // Serialize writes per matchHash using async-mutex
      const mutex = this.getMutex(matchHash);

      return await mutex.runExclusive(async () => {
        const existingMatch = await this.loadMatch(matchHash);
        if (!existingMatch) {
          console.debug(
            `[MetadataStorageService] Skipping status update - no metadata file for: ${matchHash}`
          );
          return; // Gracefully skip updates for non-existent files
        }

        // No-op guard: Skip write if status unchanged and no additional fields
        if (existingMatch.uploadStatus === status && Object.keys(additionalData).length === 0) {
          return; // Skip redundant write
        }

        // Normal status update logic
        const updatedMatch: StoredMatchMetadata = {
          ...existingMatch,
          ...additionalData,
          uploadStatus: status,
          lastUpdatedAt: new Date(),
          // IMPORTANT: Do NOT update storedAt - preserve original bufferId-based filename
        };

        // Clear progress message for final states to prevent stale data
        if (
          status === UploadStatus.COMPLETED ||
          status === UploadStatus.FAILED ||
          status === UploadStatus.NOT_FOUND
        ) {
          delete updatedMatch.progressMessage;
        }

        await this._saveMatchInternal(updatedMatch);

        // Log status changes or enrichment updates
        if (existingMatch.uploadStatus !== status) {
          console.debug('[MetadataStorageService] Updated match status:', {
            matchHash,
            oldUploadStatus: existingMatch.uploadStatus,
            newUploadStatus: status,
          });
        } else if (Object.keys(additionalData).length > 0) {
          // Log enrichment updates for diagnostics
          console.debug('[MetadataStorageService] Enriching match with additional data:', {
            matchHash,
            status,
            fieldsAdded: Object.keys(additionalData),
          });
        }

        this.emit('matchUpdated', { matchHash, status, additionalData });
      });
    }, 'updating match status');
  }

  /**
   * Update only video metadata fields by bufferId (works for complete and incomplete matches)
   * Preserves existing upload status and completion status
   */
  public async updateVideoMetadataByBufferId(
    bufferId: string,
    videoData: VideoMetadataUpdate
  ): Promise<void> {
    return this.safeFileOperation(async () => {
      const mutex = this.getMutex(bufferId);

      return await mutex.runExclusive(async () => {
        const existingMatch = await this.loadMatchByBufferId(bufferId);
        if (!existingMatch) {
          console.debug(
            `[MetadataStorageService] Skipping video update - no metadata file for bufferId: ${bufferId}`
          );
          return;
        }

        // Update ONLY video fields, preserve all other fields including uploadStatus
        const updatedMatch: StoredMatchMetadata = {
          ...existingMatch,
          ...videoData,
          lastUpdatedAt: new Date(),
        };

        await this._saveMatchInternal(updatedMatch);

        console.debug('[MetadataStorageService] Updated video metadata:', {
          bufferId,
          matchHash: existingMatch.matchHash || 'incomplete',
          preservedStatus: existingMatch.uploadStatus,
        });

        this.emit('matchUpdated', { bufferId, videoData });
      });
    }, 'updating video metadata');
  }

  /**
   * Delete match metadata by bufferId (works for complete and incomplete matches)
   */
  public async deleteMatch(bufferId: string): Promise<boolean> {
    return this.safeFileOperation(
      async () => {
        const files = await this.getMatchFiles();
        for (const file of files) {
          try {
            const filepath = path.join(this.storageDir, file);
            const content = await fs.readFile(filepath, 'utf-8');
            const metadata = JSON.parse(content) as StoredMatchMetadata;
            if (metadata.bufferId === bufferId) {
              // Atomic video deletion with minimal guard
              if (metadata.videoPath) {
                if (!path.isAbsolute(metadata.videoPath)) {
                  console.error(
                    '[MetadataStorageService] Refusing to delete non-absolute video path:',
                    {
                      bufferId,
                      videoPath: metadata.videoPath,
                    }
                  );
                  return false;
                }

                try {
                  await fs.unlink(metadata.videoPath);
                  console.debug('[MetadataStorageService] Deleted associated video file:', {
                    bufferId,
                    videoPath: metadata.videoPath,
                  });
                } catch (videoError: any) {
                  if (videoError.code !== 'ENOENT') {
                    console.error(
                      '[MetadataStorageService] Video deletion failed - keeping metadata:',
                      {
                        bufferId,
                        videoPath: metadata.videoPath,
                        error: videoError?.message,
                      }
                    );
                    return false; // keep metadata if deletion actually failed
                  }
                  // ENOENT → already gone, proceed to delete metadata
                }
              }

              // Delete thumbnail if it exists
              if (metadata.videoThumbnail) {
                if (!path.isAbsolute(metadata.videoThumbnail)) {
                  console.error(
                    '[MetadataStorageService] Refusing to delete non-absolute thumbnail path:',
                    {
                      bufferId,
                      videoThumbnail: metadata.videoThumbnail,
                    }
                  );
                } else {
                  try {
                    await fs.unlink(metadata.videoThumbnail);
                    console.debug('[MetadataStorageService] Deleted associated thumbnail file:', {
                      bufferId,
                      videoThumbnail: metadata.videoThumbnail,
                    });
                  } catch (thumbnailError) {
                    // Thumbnail deletion is non-critical, just log
                    if ((thumbnailError as NodeJS.ErrnoException).code !== 'ENOENT') {
                      console.warn(
                        '[MetadataStorageService] Thumbnail deletion failed (non-critical):',
                        {
                          bufferId,
                          videoThumbnail: metadata.videoThumbnail,
                          error: (thumbnailError as Error)?.message,
                        }
                      );
                    }
                  }
                }
              }

              // Delete metadata file (only reached if video deletion succeeded or not needed)
              await fs.unlink(filepath);
              console.debug('[MetadataStorageService] Deleted match metadata:', {
                bufferId,
                filename: file,
              });
              this.emit('matchDeleted', { bufferId, hadVideo: !!metadata.videoPath });
              return true;
            }
          } catch (error) {
            console.warn('[MetadataStorageService] Failed during delete scan:', file, error);
          }
        }
        return false;
      },
      'deleting match metadata',
      false
    );
  }

  /**
   * Get total number of stored matches
   */
  public async getMatchesCount(): Promise<number> {
    return this.safeFileOperation(
      async () => {
        const files = await this.getMatchFiles();
        return files.length;
      },
      'counting matches',
      0
    );
  }

  /**
   * Clean up excess matches based on file count limit
   * Uses content-based sorting to keep the most recent matches
   */
  public async cleanupOldMatches(): Promise<number> {
    return this.safeFileOperation(
      async () => {
        let deletedCount = 0;

        // Load all matches using the shared helper method
        const allMatches = await this.loadAllMatchesWithFiles();

        const validMatches = allMatches.filter(
          (m): m is { file: string; metadata: StoredMatchMetadata } =>
            m.metadata.matchData.timestamp !== null
        );

        // Clean up by file count if configured
        if (
          this.config.maxFiles &&
          this.config.maxFiles > 0 &&
          validMatches.length > this.config.maxFiles
        ) {
          // Sort by timestamp (oldest first) for proper cleanup
          const sortedMatches = validMatches.sort(
            (a, b) =>
              a.metadata.matchData.timestamp.getTime() - b.metadata.matchData.timestamp.getTime()
          );

          const excessCount = sortedMatches.length - this.config.maxFiles;
          const excessMatches = sortedMatches.slice(0, excessCount);

          for (const { file } of excessMatches) {
            try {
              await fs.unlink(path.join(this.storageDir, file));
              deletedCount++;
            } catch (error) {
              console.warn('[MetadataStorageService] Failed to delete excess file:', file, error);
            }
          }
        }

        if (deletedCount > 0) {
          console.info('[MetadataStorageService] Cleaned up old matches:', { deletedCount });
          this.emit('cleanupCompleted', { deletedCount });
        }

        return deletedCount;
      },
      'cleaning up old matches',
      0
    );
  }

  /**
   * Ensure storage directory exists
   */
  private async ensureStorageDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.storageDir, { recursive: true });
    } catch (error) {
      throw new Error(
        `Failed to create storage directory: 
    ${this.storageDir}`,
        { cause: error }
      );
    }
  }

  /**
   * Sanitize bufferId to be safe for use in filenames
   * Removes directory traversal characters and other non-alphanumeric chars except hyphens and underscores
   */
  private sanitizeBufferId(bufferId: string): string {
    // Allow alphanumeric characters, hyphens, and underscores only
    return bufferId.replace(/[^a-zA-Z0-9-_]/g, '');
  }

  /**
   * Generate filename for match metadata
   * Format: {sanitizedBufferId}.json
   * Uses bufferId for stable filenames throughout lifecycle
   */
  private generateFileName(bufferId: string): string {
    const sanitizedBufferId = this.sanitizeBufferId(bufferId);
    return `${sanitizedBufferId}.json`;
  }

  /**
   * Get all match files from storage directory
   */
  private async getMatchFiles(): Promise<string[]> {
    try {
      await this.ensureStorageDirectory();
      const files = await fs.readdir(this.storageDir);
      // Match files are named {sanitizedBufferId}.json where bufferId contains timestamp
      return files.filter(file => file.endsWith('.json'));
    } catch (error) {
      console.warn('[MetadataStorageService] Failed to read storage directory:', error);
      return [];
    }
  }

  /**
   * Validate match metadata
   */
  private validateMetadata(metadata: StoredMatchMetadata): ValidationResult {
    const errors: string[] = [];

    // Validate core match data structure
    if (!metadata.matchData || typeof metadata.matchData !== 'object') {
      errors.push('matchData is required and must be an object');
      return { isValid: false, errors }; // Early return if matchData is missing
    }

    // BREAKING CHANGE: Validate new required progressive metadata fields
    if (
      !(['in_progress', 'complete', 'incomplete'] as const).includes(metadata.matchCompletionStatus)
    ) {
      errors.push(
        'matchCompletionStatus is required and must be "in_progress", "complete", or "incomplete"'
      );
    }

    if (
      !(['initial', 'combatants_added', 'finalized'] as const).includes(metadata.enrichmentPhase)
    ) {
      errors.push(
        'enrichmentPhase is required and must be "initial", "combatants_added", or "finalized"'
      );
    }

    if (!metadata.createdAt || !(metadata.createdAt instanceof Date)) {
      errors.push('createdAt is required and must be a Date object');
    }

    if (!metadata.lastUpdatedAt || !(metadata.lastUpdatedAt instanceof Date)) {
      errors.push('lastUpdatedAt is required and must be a Date object');
    }

    // Validate service-generated IDs for complete matches only (both generated at finalize)
    if (metadata.matchCompletionStatus === 'complete') {
      if (!metadata.matchHash || typeof metadata.matchHash !== 'string') {
        errors.push('matchHash is required for complete matches and must be a string');
      } else if (!/^[a-f0-9]{64}$/.test(metadata.matchHash)) {
        errors.push('matchHash must be 64 hex characters');
      }

      if (!metadata.matchData.playerId || typeof metadata.matchData.playerId !== 'string') {
        errors.push('playerId is required for complete matches and must be a string');
      }
    }

    // Always require bufferId (used for filenames and correlation)
    if (!metadata.bufferId || typeof metadata.bufferId !== 'string') {
      errors.push('bufferId is required and must be a string');
    }

    if (!metadata.matchData.timestamp || !(metadata.matchData.timestamp instanceof Date)) {
      errors.push('matchData.timestamp is required and must be a Date object');
    }

    if (!Object.values(UploadStatus).includes(metadata.uploadStatus)) {
      errors.push('uploadStatus must be a valid UploadStatus value');
    }

    // Validate always available fields from match start
    if (!metadata.matchData.bracket || typeof metadata.matchData.bracket !== 'string') {
      errors.push('matchData.bracket is required and must be a string');
    }

    if (typeof metadata.matchData.season !== 'number') {
      errors.push('matchData.season is required and must be a number');
    }

    if (typeof metadata.matchData.mapId !== 'number') {
      errors.push('matchData.mapId is required and must be a number');
    }

    if (typeof metadata.matchData.isRanked !== 'boolean') {
      errors.push('matchData.isRanked is required and must be a boolean');
    }

    if (!Array.isArray(metadata.matchData.players)) {
      errors.push('matchData.players is required and must be an array');
    }

    // BREAKING CHANGE: Optional fields that are only available after completion
    // These are now optional and only validated for complete matches
    if (metadata.matchCompletionStatus === 'complete') {
      if (typeof metadata.matchData.matchDuration !== 'number') {
        errors.push(
          'matchData.matchDuration is required for complete matches and must be a number'
        );
      }

      // winningTeamId is optional for Solo Shuffle (uses per-player wins/losses instead)
      const isSoloShuffle = metadata.matchData.bracket === BRACKET_STRINGS.SOLO_SHUFFLE;
      if (!isSoloShuffle && typeof metadata.matchData.winningTeamId !== 'number') {
        errors.push(
          'matchData.winningTeamId is required for complete matches and must be a number'
        );
      }

      // Solo Shuffle specific validation
      if (isSoloShuffle) {
        // Require shuffle rounds data
        if (
          !Array.isArray(metadata.matchData.shuffleRounds) ||
          metadata.matchData.shuffleRounds.length < 1
        ) {
          errors.push(
            'matchData.shuffleRounds is required for complete Solo Shuffle matches and must be an array with at least 1 round'
          );
        }

        // Require per-player W-L record for recording player
        if (metadata.matchData.playerId && metadata.matchData.players) {
          const recordingPlayer = metadata.matchData.players.find(
            p => p.id === metadata.matchData.playerId
          );
          if (recordingPlayer) {
            if (typeof recordingPlayer.wins !== 'number') {
              errors.push(
                'Recording player wins is required for complete Solo Shuffle matches and must be a number'
              );
            }
            if (typeof recordingPlayer.losses !== 'number') {
              errors.push(
                'Recording player losses is required for complete Solo Shuffle matches and must be a number'
              );
            }

            // Validate W-L record matches round count
            if (
              metadata.matchData.shuffleRounds &&
              recordingPlayer.wins !== undefined &&
              recordingPlayer.losses !== undefined
            ) {
              const totalRounds = recordingPlayer.wins + recordingPlayer.losses;
              if (totalRounds !== metadata.matchData.shuffleRounds.length) {
                errors.push(
                  `Recording player W-L record (${recordingPlayer.wins}-${recordingPlayer.losses}) must equal shuffleRounds count (${metadata.matchData.shuffleRounds.length})`
                );
              }
            }
          } else {
            errors.push('Recording player not found in players array for Solo Shuffle validation');
          }
        } else {
          errors.push('playerId and players array required for Solo Shuffle validation');
        }

        // Validate each round structure
        if (metadata.matchData.shuffleRounds) {
          metadata.matchData.shuffleRounds.forEach((round, index) => {
            if (typeof round.roundNumber !== 'number') {
              errors.push(`shuffleRounds[${index}].roundNumber must be a number`);
            }
            if (typeof round.duration !== 'number') {
              errors.push(`shuffleRounds[${index}].duration must be a number`);
            }
            if (typeof round.startTimestamp !== 'number') {
              errors.push(`shuffleRounds[${index}].startTimestamp must be a number`);
            }
            if (typeof round.endTimestamp !== 'number') {
              errors.push(`shuffleRounds[${index}].endTimestamp must be a number`);
            }
            if (round.winningTeamId !== undefined && ![0, 1].includes(round.winningTeamId)) {
              errors.push(`shuffleRounds[${index}].winningTeamId must be 0 or 1`);
            }
            if (!Array.isArray(round.team0Players)) {
              errors.push(`shuffleRounds[${index}].team0Players must be an array`);
            }
            if (!Array.isArray(round.team1Players)) {
              errors.push(`shuffleRounds[${index}].team1Players must be an array`);
            }
          });
        }

        // Warn if winningTeamId exists for shuffle (prefer undefined)
        if (metadata.matchData.winningTeamId !== undefined) {
          console.warn(
            '[MetadataStorageService] Solo Shuffle has winningTeamId - should be undefined to avoid ambiguity'
          );
        }
      }

      if (typeof metadata.matchData.team0MMR !== 'number') {
        errors.push('matchData.team0MMR is required for complete matches and must be a number');
      }

      if (typeof metadata.matchData.team1MMR !== 'number') {
        errors.push('matchData.team1MMR is required for complete matches and must be a number');
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Safe wrapper for file operations with error handling
   */
  private async safeFileOperation<T>(
    operation: () => Promise<T>,
    errorContext: string,
    fallback?: T
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      console.error(`[MetadataStorageService] ${errorContext}:`, error);
      this.emit('error', { context: errorContext, error });

      if (fallback !== undefined) {
        return fallback;
      }

      throw error;
    }
  }
}
