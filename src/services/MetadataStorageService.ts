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
          '[MetadataStorageService] Transient storage issue:',
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
      // Validate bufferId before acquiring mutex (required for SSoT consistency)
      if (!metadata.bufferId) {
        throw new Error('Cannot save match: bufferId is required');
      }
      const mutexKey = metadata.bufferId;
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

          // Fixed backoff for transient locks (antivirus, etc.)
          const RENAME_RETRY_DELAY_MS = 50;
          await new Promise(resolve => setTimeout(resolve, RENAME_RETRY_DELAY_MS));

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
    try {
      const result = await this.loadMatchByBufferIdWithDiagnostics(bufferId);
      return result.match;
    } catch (error) {
      // Catastrophic failure (cannot read directory, etc.) - log and return null
      // to preserve existing "null fallback" semantics for current callers
      console.error(
        '[MetadataStorageService] Catastrophic failure loading match by bufferId:',
        error
      );
      this.emit('error', { context: 'loading match metadata by bufferId', error });
      return null;
    }
  }

  /**
   * Load match metadata by bufferId with detailed diagnostics.
   * Unlike loadMatchByBufferId, this method:
   * - Throws on catastrophic failures (cannot read directory)
   * - Returns per-file scan errors separately from the result
   * - Enables callers to distinguish "not found" from "load failed"
   */
  public async loadMatchByBufferIdWithDiagnostics(bufferId: string): Promise<{
    match: StoredMatchMetadata | null;
    scanErrors: Array<{ file: string; error: string }>;
  }> {
    const scanErrors: Array<{ file: string; error: string }> = [];

    // This will throw if the directory cannot be read (catastrophic failure)
    // Uses SSoT helper for deterministic, sorted iteration
    const jsonFiles = await this.getMatchFilesStrict();

    // Search through all files for matching bufferId in content
    for (const file of jsonFiles) {
      try {
        const filepath = path.join(this.storageDir, file);
        const content = await fs.readFile(filepath, 'utf-8');
        const metadata = JSON.parse(content) as StoredMatchMetadata;

        if (metadata.bufferId === bufferId) {
          this.normalizeMetadataDates(metadata);
          return { match: metadata, scanErrors };
        }
      } catch (error) {
        // Per-file failure: record error and continue scanning other files
        const errorMessage = error instanceof Error ? error.message : String(error);
        scanErrors.push({ file, error: errorMessage });
        console.warn(
          '[MetadataStorageService] Failed to load file during bufferId search:',
          file,
          error
        );
      }
    }

    return { match: null, scanErrors };
  }

  /**
   * Delete match by bufferId with pre-delete validation and diagnostics.
   * Single-scan operation: finds match, validates via callback, then deletes.
   *
   * @param bufferId - The bufferId to search for
   * @param validateMatch - Callback that throws if match should not be deleted; receives normalized metadata
   * @returns { deleted: boolean, scanErrors: [...] } - deleted is true if match was found, validated, and deleted
   * @throws On catastrophic failures (unreadable directory) or if validateMatch throws
   */
  public async deleteMatchByBufferIdWithDiagnostics(
    bufferId: string,
    validateMatch: (match: StoredMatchMetadata) => void
  ): Promise<{
    deleted: boolean;
    scanErrors: Array<{ file: string; error: string }>;
  }> {
    const scanErrors: Array<{ file: string; error: string }> = [];

    // This will throw if the directory cannot be read (catastrophic failure)
    const jsonFiles = await this.getMatchFilesStrict();

    for (const file of jsonFiles) {
      let metadata: StoredMatchMetadata;
      let filepath: string;

      try {
        filepath = path.join(this.storageDir, file);
        const content = await fs.readFile(filepath, 'utf-8');
        metadata = JSON.parse(content) as StoredMatchMetadata;
      } catch (error) {
        // Per-file failure: record error and continue scanning
        const errorMessage = error instanceof Error ? error.message : String(error);
        scanErrors.push({ file, error: errorMessage });
        console.warn(
          '[MetadataStorageService] Failed to load file during delete scan:',
          file,
          error
        );
        continue;
      }

      if (metadata.bufferId !== bufferId) {
        continue;
      }

      // Normalize dates before validation (consistent with loadMatchByBufferIdWithDiagnostics)
      this.normalizeMetadataDates(metadata);

      // Match found - validate before deleting (throws if invalid)
      validateMatch(metadata);

      // Validation passed - use shared deletion helper
      const deleted = await this.deleteMatchAssetsAndMetadata({
        bufferId,
        filepath,
        filename: file,
        metadata,
      });

      return { deleted, scanErrors };
    }

    // Match not found
    return { deleted: false, scanErrors };
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
              this.normalizeMetadataDates(metadata);
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

        this.normalizeMetadataDates(metadata);

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

            this.normalizeMetadataDates(metadata);

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
   * Get all known bufferIds from metadata files (strict version - throws on directory read failure).
   * SSoT for orphan detection: a chunk is orphan if its bufferId is not in this set.
   * @returns Set of bufferIds derived from metadata filenames
   */
  public async listBufferIdsStrict(): Promise<Set<string>> {
    const jsonFiles = await this.getMatchFilesStrict();
    const bufferIds = new Set<string>();
    for (const file of jsonFiles) {
      const bufferId = path.basename(file, '.json');
      bufferIds.add(bufferId);
    }
    return bufferIds;
  }

  /**
   * List all matches with explicit error reporting (no silent fallbacks).
   * Throws on catastrophic directory read failure.
   * Per-file read/parse errors are collected in scanErrors.
   * @returns Object with matches array and scanErrors array
   */
  public async listAllMatchesWithDiagnostics(): Promise<{
    matches: StoredMatchMetadata[];
    scanErrors: Array<{ file: string; error: string }>;
  }> {
    // Catastrophic failure: throw (no silent fallback)
    const jsonFiles = await this.getMatchFilesStrict();

    const matches: StoredMatchMetadata[] = [];
    const scanErrors: Array<{ file: string; error: string }> = [];

    for (const file of jsonFiles) {
      try {
        const filepath = path.join(this.storageDir, file);
        const content = await fs.readFile(filepath, 'utf-8');
        const metadata = JSON.parse(content) as StoredMatchMetadata;

        // Require matchData.timestamp (expiration/maintenance depends on it)
        if (!metadata.matchData?.timestamp) {
          scanErrors.push({ file, error: 'Missing matchData.timestamp' });
          continue;
        }

        // Normalize and validate date fields (no silent Invalid Date propagation)
        const parsedTimestamp = new Date(metadata.matchData.timestamp as any);
        if (Number.isNaN(parsedTimestamp.getTime())) {
          scanErrors.push({ file, error: 'Invalid matchData.timestamp' });
          continue;
        }
        metadata.matchData.timestamp = parsedTimestamp;

        if (metadata.createdAt) {
          const parsed = new Date(metadata.createdAt as any);
          if (Number.isNaN(parsed.getTime())) {
            scanErrors.push({ file, error: 'Invalid createdAt' });
            continue;
          }
          metadata.createdAt = parsed;
        }
        if (metadata.lastUpdatedAt) {
          const parsed = new Date(metadata.lastUpdatedAt as any);
          if (Number.isNaN(parsed.getTime())) {
            scanErrors.push({ file, error: 'Invalid lastUpdatedAt' });
            continue;
          }
          metadata.lastUpdatedAt = parsed;
        }

        matches.push(metadata);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        scanErrors.push({ file, error: errorMessage });
      }
    }

    return { matches, scanErrors };
  }

  /**
   * Update match upload status and additional metadata
   * Uses async-mutex to prevent race conditions in concurrent writes
   * BREAKING CHANGE: Now locks on bufferId for consistency with other write paths
   */
  public async updateMatchStatus(
    matchHash: string,
    status: UploadStatus,
    additionalData: Partial<StoredMatchMetadata> = {}
  ): Promise<void> {
    return this.safeFileOperation(async () => {
      // First load to get bufferId (outside mutex)
      const existingMatch = await this.loadMatch(matchHash);
      if (!existingMatch) {
        console.debug(
          `[MetadataStorageService] Skipping status update - no metadata file for: ${matchHash}`
        );
        return; // Gracefully skip updates for non-existent files
      }

      const bufferId = existingMatch.bufferId;
      if (!bufferId) {
        console.error(
          `[MetadataStorageService] Cannot update status - no bufferId for: ${matchHash}`
        );
        return;
      }

      // BREAKING CHANGE: Lock on bufferId (not matchHash) for consistency
      const mutex = this.getMutex(bufferId);

      return await mutex.runExclusive(async () => {
        // Reload inside mutex to get fresh state (prevent lost updates)
        const freshMatch = await this.loadMatchByBufferId(bufferId);
        if (!freshMatch) {
          console.debug(
            `[MetadataStorageService] Match disappeared during status update: ${bufferId}`
          );
          return;
        }

        // No-op guard: Skip write if status unchanged and no additional fields
        if (freshMatch.uploadStatus === status && Object.keys(additionalData).length === 0) {
          return; // Skip redundant write
        }

        // Guard: Forbid identity field mutation via additionalData (SSoT invariant)
        const forbiddenFields = ['bufferId', 'matchHash', 'storedAt'] as const;
        for (const field of forbiddenFields) {
          if (field in additionalData) {
            throw new Error(
              `Cannot mutate identity field '${field}' via additionalData in updateMatchStatus`
            );
          }
        }

        // Normal status update logic
        const updatedMatch: StoredMatchMetadata = {
          ...freshMatch,
          ...additionalData,
          uploadStatus: status,
          lastUpdatedAt: new Date(),
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
        if (freshMatch.uploadStatus !== status) {
          console.debug('[MetadataStorageService] Updated match status:', {
            matchHash,
            bufferId,
            oldUploadStatus: freshMatch.uploadStatus,
            newUploadStatus: status,
          });
        } else if (Object.keys(additionalData).length > 0) {
          // Log enrichment updates for diagnostics
          console.debug('[MetadataStorageService] Enriching match with additional data:', {
            matchHash,
            bufferId,
            status,
            fieldsAdded: Object.keys(additionalData),
          });
        }

        this.emit('matchUpdated', { matchHash, bufferId, status, additionalData });
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
   * Update favourite status by bufferId (works for complete and incomplete matches)
   * Uses mutex to prevent race conditions with other bufferId-keyed operations
   */
  public async updateFavouriteByBufferId(
    bufferId: string,
    isFavourite: boolean
  ): Promise<void> {
    return this.safeFileOperation(async () => {
      const mutex = this.getMutex(bufferId);

      return await mutex.runExclusive(async () => {
        const existingMatch = await this.loadMatchByBufferId(bufferId);
        if (!existingMatch) {
          console.debug(
            `[MetadataStorageService] Skipping favourite update - no metadata file for bufferId: ${bufferId}`
          );
          return;
        }

        // No-op guard: Skip write if favourite status unchanged
        if (existingMatch.isFavourite === isFavourite) {
          return;
        }

        // Update ONLY favourite field, preserve all other fields
        const updatedMatch: StoredMatchMetadata = {
          ...existingMatch,
          isFavourite,
          lastUpdatedAt: new Date(),
        };

        await this._saveMatchInternal(updatedMatch);

        console.debug('[MetadataStorageService] Updated favourite status:', {
          bufferId,
          isFavourite,
        });

        this.emit('matchUpdated', { bufferId, isFavourite });
      });
    }, 'updating favourite status');
  }

  /**
   * List all favourite video paths with explicit error reporting.
   * Returns normalized paths for protected set construction.
   * Throws on catastrophic directory read failure.
   * Per-file read/parse errors are collected in scanErrors.
   */
  public async listFavouriteVideoPathsWithDiagnostics(): Promise<{
    paths: Set<string>;
    scanErrors: Array<{ file: string; error: string }>;
  }> {
    const { matches, scanErrors } = await this.listAllMatchesWithDiagnostics();

    const paths = new Set<string>();

    for (const match of matches) {
      if (match.isFavourite === true && match.videoPath) {
        // Require absolute path (safety check)
        if (!path.isAbsolute(match.videoPath)) {
          // Use actual filename (derived from bufferId) for consistent diagnostics
          const filename = match.bufferId ? this.generateFileName(match.bufferId) : 'unknown';
          scanErrors.push({
            file: filename,
            error: `Non-absolute videoPath: ${match.videoPath}`,
          });
          continue;
        }

        const normalizedPath = this.normalizePathForComparison(match.videoPath);
        paths.add(normalizedPath);
      }
    }

    return { paths, scanErrors };
  }

  /**
   * Mark recording as deleted by quota enforcement using video file path.
   * Scans all matches for videoPath match (normalized for Windows case-insensitivity).
   * @returns Number of matches updated
   */
  public async markRecordingDeletedByQuotaByVideoPath(videoFilePath: string): Promise<number> {
    return this.safeFileOperation(
      async () => {
        const files = await this.getMatchFiles();
        let updatedCount = 0;

        // Normalize search path for comparison (case-insensitive on Windows)
        const normalizedSearchPath = this.normalizePathForComparison(videoFilePath);

        for (const file of files) {
          try {
            const filepath = path.join(this.storageDir, file);
            const content = await fs.readFile(filepath, 'utf-8');
            const metadata = JSON.parse(content) as StoredMatchMetadata;

            // Normalize stored path for comparison
            const normalizedStoredPath = metadata.videoPath
              ? this.normalizePathForComparison(metadata.videoPath)
              : null;

            if (normalizedStoredPath === normalizedSearchPath) {
              // Get bufferId for mutex and logging
              const bufferId = metadata.bufferId;
              if (!bufferId) {
                console.warn(
                  '[MetadataStorageService] Skipping quota update - no bufferId in metadata:',
                  file
                );
                continue;
              }

              // Use mutex to prevent lost updates
              const mutex = this.getMutex(bufferId);
              await mutex.runExclusive(async () => {
                // Re-load to get properly normalized metadata (dates as Date objects)
                const existingMatch = await this.loadMatchByBufferId(bufferId);
                if (!existingMatch) {
                  console.debug(
                    '[MetadataStorageService] Match disappeared during quota update:',
                    bufferId
                  );
                  return;
                }

                // Re-check videoPath still matches (atomicity guard)
                const reloadedNormalizedPath = existingMatch.videoPath
                  ? this.normalizePathForComparison(existingMatch.videoPath)
                  : null;
                if (reloadedNormalizedPath !== normalizedSearchPath) {
                  console.debug(
                    '[MetadataStorageService] videoPath changed between scan and update, skipping:',
                    { bufferId, expected: normalizedSearchPath, actual: reloadedNormalizedPath }
                  );
                  return;
                }

                // Clear video fields (use delete to satisfy exactOptionalPropertyTypes)
                delete existingMatch.videoPath;
                delete existingMatch.videoThumbnail;
                delete existingMatch.videoSize;
                delete existingMatch.videoDuration;
                delete existingMatch.videoRecordedAt;
                delete existingMatch.videoResolution;
                delete existingMatch.videoFps;
                delete existingMatch.videoCodec;

                // Set quota deletion status
                existingMatch.recordingStatus = 'deleted_quota';
                existingMatch.recordingErrorCode = 'DELETED_QUOTA';
                existingMatch.recordingErrorMessage = 'Recording deleted due to storage limit.';
                existingMatch.lastUpdatedAt = new Date();

                await this._saveMatchInternal(existingMatch);
                updatedCount++;

                console.debug(
                  '[MetadataStorageService] Marked recording deleted by quota (videoPath match):',
                  { bufferId, videoFilePath }
                );

                this.emit('matchUpdated', {
                  bufferId,
                  videoData: {
                    recordingStatus: 'deleted_quota',
                    recordingErrorCode: 'DELETED_QUOTA',
                    recordingErrorMessage: 'Recording deleted due to storage limit.',
                  },
                });
              });
            }
          } catch (error) {
            console.warn(
              '[MetadataStorageService] Failed to check/update file during videoPath search:',
              file,
              error
            );
          }
        }

        return updatedCount;
      },
      'marking recording deleted by quota via videoPath',
      0
    );
  }

  /**
   * Normalize path for comparison (case-insensitive on Windows).
   */
  private normalizePathForComparison(filePath: string): string {
    const normalized = path.resolve(filePath);
    // Windows paths are case-insensitive
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  }

  /**
   * Normalize Date fields in metadata after JSON.parse (JSON serializes dates as strings).
   * Mutates the metadata object in place. Safe if called on already-normalized metadata.
   */
  private normalizeMetadataDates(metadata: StoredMatchMetadata): void {
    if (metadata.matchData?.timestamp) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      metadata.matchData.timestamp = new Date(metadata.matchData.timestamp as any);
    }
    if (metadata.createdAt) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      metadata.createdAt = new Date(metadata.createdAt as any);
    }
    if (metadata.lastUpdatedAt) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      metadata.lastUpdatedAt = new Date(metadata.lastUpdatedAt as any);
    }
  }

  /**
   * Delete video, thumbnail, and metadata file for a match.
   * SSoT for deletion logic - used by both deleteMatch and deleteMatchByBufferIdWithDiagnostics.
   *
   * @returns true if deletion succeeded, false if video deletion failed (metadata preserved)
   */
  private async deleteMatchAssetsAndMetadata(params: {
    bufferId: string;
    filepath: string;
    filename: string;
    metadata: StoredMatchMetadata;
  }): Promise<boolean> {
    const { bufferId, filepath, filename, metadata } = params;

    // Delete video if present
    if (metadata.videoPath) {
      if (!path.isAbsolute(metadata.videoPath)) {
        console.error('[MetadataStorageService] Refusing to delete non-absolute video path:', {
          bufferId,
          videoPath: metadata.videoPath,
        });
        return false;
      }

      try {
        await fs.unlink(metadata.videoPath);
        console.debug('[MetadataStorageService] Deleted associated video file:', {
          bufferId,
          videoPath: metadata.videoPath,
        });
      } catch (videoError: unknown) {
        const nodeError = videoError as NodeJS.ErrnoException;
        if (nodeError.code !== 'ENOENT') {
          console.error('[MetadataStorageService] Video deletion failed - keeping metadata:', {
            bufferId,
            videoPath: metadata.videoPath,
            error: nodeError.message,
          });
          return false;
        }
        // ENOENT → already gone, proceed
      }
    }

    // Delete thumbnail if present (non-critical)
    if (metadata.videoThumbnail) {
      if (path.isAbsolute(metadata.videoThumbnail)) {
        try {
          await fs.unlink(metadata.videoThumbnail);
          console.debug('[MetadataStorageService] Deleted associated thumbnail file:', {
            bufferId,
            videoThumbnail: metadata.videoThumbnail,
          });
        } catch (thumbnailError: unknown) {
          const nodeError = thumbnailError as NodeJS.ErrnoException;
          if (nodeError.code !== 'ENOENT') {
            console.warn('[MetadataStorageService] Thumbnail deletion failed (non-critical):', {
              bufferId,
              videoThumbnail: metadata.videoThumbnail,
              error: nodeError.message,
            });
          }
        }
      } else {
        console.error('[MetadataStorageService] Refusing to delete non-absolute thumbnail path:', {
          bufferId,
          videoThumbnail: metadata.videoThumbnail,
        });
      }
    }

    // Delete metadata file
    await fs.unlink(filepath);
    console.debug('[MetadataStorageService] Deleted match metadata:', {
      bufferId,
      filename,
    });
    this.emit('matchDeleted', { bufferId, hadVideo: !!metadata.videoPath });

    return true;
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
              return await this.deleteMatchAssetsAndMetadata({
                bufferId,
                filepath,
                filename: file,
                metadata,
              });
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
   * NEVER deletes favourited matches
   */
  public async cleanupOldMatches(): Promise<number> {
    return this.safeFileOperation(
      async () => {
        let deletedCount = 0;

        // Load all matches using the shared helper method
        const allMatches = await this.loadAllMatchesWithFiles();

        // Helper to get valid timestamp in ms (returns null for invalid/NaN/missing)
        const getValidTimeMs = (date: Date | null | undefined): number | null => {
          if (!date || !(date instanceof Date)) return null;
          const time = date.getTime();
          return Number.isNaN(time) ? null : time;
        };

        // Clean up by file count if configured (use allMatches - fallback sorting handles missing timestamps)
        if (
          this.config.maxFiles &&
          this.config.maxFiles > 0 &&
          allMatches.length > this.config.maxFiles
        ) {
          // CRITICAL: Exclude favourites from deletion candidates
          const deletableMatches = allMatches.filter(
            m => m.metadata.isFavourite !== true
          );
          const favouriteCount = allMatches.length - deletableMatches.length;

          // Sort deletable matches by effective date with deterministic tie-breaker (oldest first)
          const sortedMatches = deletableMatches.sort((a, b) => {
            // Compute effective time per match (timestamp ?? lastUpdatedAt ?? createdAt)
            // Uses optional chaining to guard against missing matchData
            const aTimeMs =
              getValidTimeMs(a.metadata.matchData?.timestamp) ??
              getValidTimeMs(a.metadata.lastUpdatedAt) ??
              getValidTimeMs(a.metadata.createdAt);
            const bTimeMs =
              getValidTimeMs(b.metadata.matchData?.timestamp) ??
              getValidTimeMs(b.metadata.lastUpdatedAt) ??
              getValidTimeMs(b.metadata.createdAt);

            // Both have valid times - compare them
            if (aTimeMs !== null && bTimeMs !== null) {
              const timeDiff = aTimeMs - bTimeMs;
              if (timeDiff !== 0) return timeDiff;

              // Deterministic tie-breaker using bufferId (lexicographic)
              const aBufferId = a.metadata.bufferId || '';
              const bBufferId = b.metadata.bufferId || '';
              return aBufferId.localeCompare(bBufferId);
            }

            // If one side missing effective time, put it at the end (prefer deleting matches with dates)
            if (aTimeMs === null && bTimeMs !== null) return 1;
            if (aTimeMs !== null && bTimeMs === null) return -1;

            // Both missing - tie-break by bufferId for determinism
            const aBufferId = a.metadata.bufferId || '';
            const bBufferId = b.metadata.bufferId || '';
            return aBufferId.localeCompare(bBufferId);
          });

          const excessCount = allMatches.length - this.config.maxFiles;
          const canDelete = Math.min(excessCount, sortedMatches.length);
          const excessMatches = sortedMatches.slice(0, canDelete);

          for (const { file, metadata } of excessMatches) {
            const bufferId = metadata.bufferId;
            if (!bufferId) {
              console.warn('[MetadataStorageService] Skipping cleanup - no bufferId:', file);
              continue;
            }

            const filepath = path.join(this.storageDir, file);
            try {
              const deleted = await this.deleteMatchAssetsAndMetadata({
                bufferId,
                filepath,
                filename: file,
                metadata,
              });
              if (deleted) {
                deletedCount++;
              }
              // If deletion failed (e.g., unsafe paths), leave over-limit (same policy as favourites)
            } catch (error) {
              console.warn('[MetadataStorageService] Failed to delete excess match:', file, error);
            }
          }

          // Log if favourites prevented reaching quota
          if (favouriteCount > 0 && deletedCount < excessCount) {
            console.warn(
              '[MetadataStorageService] Cannot reach maxFiles quota due to favourites:',
              {
                maxFiles: this.config.maxFiles,
                totalMatches: allMatches.length,
                favouriteCount,
                deletedCount,
                remainingOverLimit: allMatches.length - deletedCount - this.config.maxFiles,
              }
            );
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
   * Get all match files from storage directory (strict version - throws on failure).
   * SSoT for: ensureStorageDirectory + readdir + filter + deterministic sort.
   * Used by methods that need to propagate catastrophic failures.
   */
  private async getMatchFilesStrict(): Promise<string[]> {
    await this.ensureStorageDirectory();
    const files = await fs.readdir(this.storageDir);
    // Match files are named {sanitizedBufferId}.json where bufferId contains timestamp
    // Sort for deterministic iteration order (readdir order is not guaranteed)
    return files.filter(file => file.endsWith('.json')).sort();
  }

  /**
   * Get all match files from storage directory (fallback version - returns [] on failure).
   * Wraps getMatchFilesStrict with try/catch for callers that need graceful degradation.
   */
  private async getMatchFiles(): Promise<string[]> {
    try {
      return await this.getMatchFilesStrict();
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
    } else if (Number.isNaN(metadata.createdAt.getTime())) {
      errors.push('createdAt has invalid Date value');
    }

    if (!metadata.lastUpdatedAt || !(metadata.lastUpdatedAt instanceof Date)) {
      errors.push('lastUpdatedAt is required and must be a Date object');
    } else if (Number.isNaN(metadata.lastUpdatedAt.getTime())) {
      errors.push('lastUpdatedAt has invalid Date value');
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
    } else if (Number.isNaN(metadata.matchData.timestamp.getTime())) {
      errors.push('matchData.timestamp has invalid Date value');
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

    // Validate optional favourite field if present
    if (metadata.isFavourite !== undefined && typeof metadata.isFavourite !== 'boolean') {
      errors.push('isFavourite must be a boolean when provided');
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
