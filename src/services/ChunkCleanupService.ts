import { EventEmitter } from 'events';
import { app } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { isNodeError } from '../utils/errors';

/**
 * Extract error details for diagnostics (message + code if available)
 */
function getErrorDetails(error: unknown): { message: string; code: string | undefined } {
  const message = error instanceof Error ? error.message : String(error);
  const code = isNodeError(error) ? error.code : undefined;
  return { message, code };
}

/**
 * Configuration for the Chunk Cleanup Service
 */
export interface ChunkCleanupServiceConfig {
  /** Directory where chunks are stored */
  chunksDir?: string;
}

/**
 * Result of scanning for aged chunk files
 */
export type FindAgedChunksResult = {
  agedChunkPaths: string[];
  scanErrors: Array<{ file: string; error: string }>;
};

/**
 * Result of scanning for orphaned chunk files
 */
export type FindOrphanedChunksResult = {
  orphanedChunkPaths: string[];
  scanErrors: Array<{ file: string; error: string }>;
};

/**
 * Result of cleaning up chunks for an instance
 */
export type CleanupChunksForInstanceResult = {
  success: boolean;
  errors: string[];
  failedFiles: Array<{ file: string; error: string }>;
};

/**
 * Result of cleaning up files by path
 */
export type CleanupFilesResult = {
  deletedCount: number;
  missingCount: number;
  failureCount: number;
  deletedFilePaths: string[];
  missingFilePaths: string[];
  failedFiles: Array<{ filePath: string; error: string }>;
};

/**
 * Service for managing chunk file lifecycle via periodic maintenance.
 * Chunks are retained for a configurable window (see ChunkRetentionConfig) and
 * deleted via aged retention cleanup during periodic maintenance passes.
 */
export class ChunkCleanupService extends EventEmitter {
  private readonly chunksDir: string;
  private isInitialized = false;

  constructor(config: ChunkCleanupServiceConfig = {}) {
    super();

    // Set up chunks directory with normalized folder structure (absolute path enforced)
    // Pattern matches MetadataStorageService/MatchDetectionService for test compatibility
    const userDataPath = app ? app.getPath('userData') : path.join(process.cwd(), 'data');
    const rawChunksDir = config.chunksDir || path.join(userDataPath, 'logs', 'chunks');
    this.chunksDir = path.resolve(rawChunksDir);

    console.info('[ChunkCleanupService] Initialized with chunks directory:', this.chunksDir);
  }

  /**
   * Initialize the service and ensure chunks directory exists
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      console.warn('[ChunkCleanupService] Already initialized');
      return;
    }

    try {
      await this.ensureChunksDirectory();
      this.isInitialized = true;
      console.info('[ChunkCleanupService] Successfully initialized');
    } catch (error) {
      console.error('[ChunkCleanupService] Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Clean up chunk files for a specific bufferId.
   * Returns explicit result (no silent swallowing of failures).
   * @param bufferId The bufferId to clean up chunks for
   * @param jobId Optional job ID for logging correlation
   * @returns CleanupChunksForInstanceResult with success status and errors
   */
  public async cleanupChunksForInstance(
    bufferId: string,
    jobId?: string
  ): Promise<CleanupChunksForInstanceResult> {
    if (!this.isInitialized) {
      return {
        success: false,
        errors: ['ChunkCleanupService not initialized'],
        failedFiles: [],
      };
    }

    const errors: string[] = [];

    try {
      console.info('[ChunkCleanupService] Starting cleanup for instance:', { bufferId, jobId });

      // Find all chunk files matching this bufferId
      const chunkFiles = await this.findChunkFilesForInstance(bufferId);

      if (chunkFiles.length === 0) {
        console.debug('[ChunkCleanupService] No chunk files found for instance:', bufferId);
        return { success: true, errors: [], failedFiles: [] };
      }

      console.info('[ChunkCleanupService] Found chunk files to clean up:', {
        bufferId,
        chunkCount: chunkFiles.length,
        files: chunkFiles.map(f => path.basename(f)),
      });

      // Use consolidated cleanup method
      const { deletedCount, missingCount, failureCount, deletedFilePaths, failedFiles } =
        await this.cleanupFiles(chunkFiles);

      console.info('[ChunkCleanupService] Cleanup completed for instance:', {
        bufferId,
        jobId,
        totalFiles: chunkFiles.length,
        deletedCount,
        missingCount,
        failureCount,
      });

      // Emit cleanup completed event
      this.emit('cleanupCompleted', {
        bufferId,
        jobId,
        totalFiles: chunkFiles.length,
        deletedCount,
        missingCount,
        failureCount,
        deletedFiles: deletedFilePaths.map(f => path.basename(f)),
      });

      // Map failedFiles to result format (file basename + error)
      const failedFilesResult = failedFiles.map(f => ({
        file: path.basename(f.filePath),
        error: f.error,
      }));

      // Collect summary error if there were failures
      if (failureCount > 0) {
        errors.push(`Failed to delete ${failureCount} file(s)`);
        this.emit('cleanupErrors', {
          bufferId,
          jobId,
          failureCount,
          failedFiles: failedFilesResult,
        });
      }

      return { success: failureCount === 0, errors, failedFiles: failedFilesResult };
    } catch (error) {
      const { message, code } = getErrorDetails(error);
      const errorMsg = code ? `${message} (${code})` : message;
      console.error('[ChunkCleanupService] Failed to cleanup chunks for instance:', {
        bufferId,
        jobId,
        error: message,
        code,
      });

      // Rely on returned result for error handling (don't emit 'error' which throws without listener)
      return { success: false, errors: [errorMsg], failedFiles: [] };
    }
  }

  /**
   * Find all chunk files that belong to a specific bufferId.
   * Uses stateless filename-based correlation with predictable chunk naming.
   * Throws on directory read failure or invalid bufferId (no silent fallback).
   */
  private async findChunkFilesForInstance(bufferId: string): Promise<string[]> {
    // Sanitize bufferId to prevent path injection
    const sanitizedBufferId = this.sanitizeBufferId(bufferId);

    // Invariant: sanitizedBufferId must be non-empty
    if (sanitizedBufferId.length === 0) {
      throw new Error(`Invalid bufferId: sanitization yielded empty string for "${bufferId}"`);
    }

    console.debug('[ChunkCleanupService] Scanning directory for bufferId:', sanitizedBufferId);

    // Catastrophic failure: throw (no silent fallback)
    const files = await fs.readdir(this.chunksDir);

    // Sort for deterministic processing order
    const txtFiles = files.filter(f => f.endsWith('.txt')).sort();
    const matchingFiles: string[] = [];

    for (const file of txtFiles) {
      // MatchChunker writes chunk files with bufferId format: <bufferId>.txt
      if (file === `${sanitizedBufferId}.txt`) {
        const fullPath = path.join(this.chunksDir, file);
        matchingFiles.push(fullPath);
      }
    }

    if (matchingFiles.length > 0) {
      console.debug('[ChunkCleanupService] Found chunk files via directory scan:', {
        bufferId: sanitizedBufferId,
        files: matchingFiles.map(f => path.basename(f)),
      });
    }

    return matchingFiles;
  }

  /**
   * Sanitize bufferId to prevent path injection attacks
   */
  private sanitizeBufferId(bufferId: string): string {
    // Remove any potentially dangerous characters
    return bufferId.replace(/[^a-zA-Z0-9_-]/g, '');
  }

  /**
   * Find chunk files that have no corresponding metadata files (orphaned chunks).
   * This identifies chunks left behind by system failures or incomplete processing.
   * Throws on catastrophic directory read failure (no silent fallback to empty array).
   * @param validBufferIds Set of bufferIds that have valid metadata files
   * @returns FindOrphanedChunksResult with orphaned paths and per-file scan errors
   */
  public async findOrphanedChunks(validBufferIds: Set<string>): Promise<FindOrphanedChunksResult> {
    if (!this.isInitialized) {
      throw new Error('ChunkCleanupService not initialized');
    }

    console.debug('[ChunkCleanupService] Scanning for orphaned chunk files');

    // Catastrophic failure: throw (no silent fallback)
    const files = await fs.readdir(this.chunksDir);

    // Sort for deterministic processing order
    const txtFiles = files.filter(f => f.endsWith('.txt')).sort();

    const orphanedChunkPaths: string[] = [];
    const scanErrors: Array<{ file: string; error: string }> = [];

    for (const file of txtFiles) {
      const filePath = path.join(this.chunksDir, file);

      // Use lstat to validate it's a regular file (don't follow symlinks)
      try {
        const stat = await fs.lstat(filePath);
        if (!stat.isFile()) {
          continue; // Skip non-regular files
        }
      } catch (error) {
        const { message, code } = getErrorDetails(error);
        scanErrors.push({ file, error: code ? `${message} (${code})` : message });
        continue;
      }

      // Extract bufferId from simple filename format: <bufferId>.txt
      const bufferId = path.basename(file, '.txt');

      // Check if this bufferId has corresponding metadata
      if (!validBufferIds.has(bufferId)) {
        orphanedChunkPaths.push(filePath);
        console.debug(
          `[ChunkCleanupService] Found orphaned chunk: ${file} (no metadata for ${bufferId})`
        );
      }
    }

    if (orphanedChunkPaths.length > 0) {
      console.info(`[ChunkCleanupService] Found ${orphanedChunkPaths.length} orphaned chunk files`);
    } else {
      console.debug('[ChunkCleanupService] No orphaned chunk files found');
    }

    return { orphanedChunkPaths, scanErrors };
  }

  /**
   * Find chunk files older than the specified age.
   * Throws on catastrophic directory read failure (no silent fallback).
   * @param maxAgeMs Maximum age in milliseconds; chunks older than this are returned
   * @param currentTimeMs Current timestamp for deterministic age calculation
   * @returns FindAgedChunksResult with aged chunk paths and per-file scan errors
   */
  public async findAgedChunks(
    maxAgeMs: number,
    currentTimeMs: number
  ): Promise<FindAgedChunksResult> {
    if (!this.isInitialized) {
      throw new Error('ChunkCleanupService not initialized');
    }

    console.debug('[ChunkCleanupService] Scanning for aged chunk files', { maxAgeMs });

    // Catastrophic failure: throw (no silent fallback)
    const files = await fs.readdir(this.chunksDir);

    // Sort for deterministic processing order
    const txtFiles = files.filter(f => f.endsWith('.txt')).sort();

    const agedChunkPaths: string[] = [];
    const scanErrors: Array<{ file: string; error: string }> = [];

    for (const file of txtFiles) {
      const filePath = path.join(this.chunksDir, file);

      // Use lstat to get mtime (don't follow symlinks)
      try {
        const stat = await fs.lstat(filePath);
        if (!stat.isFile()) {
          continue; // Skip non-regular files
        }

        // Check if file is older than maxAgeMs
        const fileAgeMs = currentTimeMs - stat.mtimeMs;
        if (fileAgeMs > maxAgeMs) {
          agedChunkPaths.push(filePath);
        }
      } catch (error) {
        const { message, code } = getErrorDetails(error);
        scanErrors.push({ file, error: code ? `${message} (${code})` : message });
        continue;
      }
    }

    if (agedChunkPaths.length > 0) {
      console.info(`[ChunkCleanupService] Found ${agedChunkPaths.length} aged chunk files`);
    } else {
      console.debug('[ChunkCleanupService] No aged chunk files found');
    }

    return { agedChunkPaths, scanErrors };
  }

  /**
   * Delete a single chunk file by bufferId. Returns explicit result (no silent fallbacks).
   * ENOENT (file doesn't exist) is treated as success (desired state already achieved).
   * @param bufferId The bufferId whose chunk file should be deleted
   * @returns Object with chunkDeleted status and any errors
   */
  public async deleteChunkForBufferId(
    bufferId: string
  ): Promise<{ chunkDeleted: boolean; errors: string[] }> {
    if (!this.isInitialized) {
      return { chunkDeleted: false, errors: ['ChunkCleanupService not initialized'] };
    }

    const sanitizedBufferId = this.sanitizeBufferId(bufferId);

    // Invariant: sanitizedBufferId must be non-empty
    if (sanitizedBufferId.length === 0) {
      return {
        chunkDeleted: false,
        errors: [`Invalid bufferId: sanitization yielded empty string for "${bufferId}"`],
      };
    }

    const chunkFilePath = path.join(this.chunksDir, `${sanitizedBufferId}.txt`);

    try {
      await fs.unlink(chunkFilePath);
      console.debug('[ChunkCleanupService] Deleted chunk file for bufferId:', sanitizedBufferId);
      return { chunkDeleted: true, errors: [] };
    } catch (error) {
      // ENOENT (file doesn't exist) means desired state is already achieved
      if (isNodeError(error) && error.code === 'ENOENT') {
        return { chunkDeleted: true, errors: [] };
      }
      const { message, code } = getErrorDetails(error);
      const errorMessage = code
        ? `Failed to delete chunk for ${sanitizedBufferId}: ${message} (${code})`
        : `Failed to delete chunk for ${sanitizedBufferId}: ${message}`;
      console.warn('[ChunkCleanupService]', errorMessage);
      return { chunkDeleted: false, errors: [errorMessage] };
    }
  }

  /**
   * Clean up specific chunk files by their absolute paths.
   * Validates each path is within chunksDir before deletion (security invariant).
   * ENOENT is treated as success (idempotent deletion - desired state already achieved).
   * @param filePaths Array of absolute paths to chunk files to delete
   * @returns CleanupFilesResult with success/failure counts and structured error details
   */
  public async cleanupFiles(filePaths: string[]): Promise<CleanupFilesResult> {
    if (!this.isInitialized) {
      throw new Error('ChunkCleanupService not initialized');
    }

    if (filePaths.length === 0) {
      return {
        deletedCount: 0,
        missingCount: 0,
        failureCount: 0,
        deletedFilePaths: [],
        missingFilePaths: [],
        failedFiles: [],
      };
    }

    console.info(`[ChunkCleanupService] Starting cleanup of ${filePaths.length} files`);

    type DeleteResult =
      | { status: 'deleted'; filePath: string }
      | { status: 'missing'; filePath: string }
      | { status: 'failed'; filePath: string; error: string };

    const deletePromises = filePaths.map(async (filePath): Promise<DeleteResult> => {
      // Security invariant: path must resolve within chunksDir (cross-platform safe)
      const resolvedPath = path.resolve(filePath);
      const rel = path.relative(this.chunksDir, resolvedPath);

      // Reject if: empty (is chunksDir itself), parent traversal, or absolute (Windows drive)
      // Standard traversal check: rel === '..' or rel starts with '../' (or '..\' on Windows)
      const isTraversal = rel === '' || rel === '..' || rel.startsWith('..' + path.sep);
      if (isTraversal || path.isAbsolute(rel)) {
        const errorMsg = `Path escapes chunksDir: ${resolvedPath}`;
        console.error('[ChunkCleanupService] Security violation:', errorMsg);
        return { status: 'failed', filePath: resolvedPath, error: errorMsg };
      }

      try {
        await fs.unlink(resolvedPath);
        console.debug('[ChunkCleanupService] Deleted file:', path.basename(resolvedPath));
        return { status: 'deleted', filePath: resolvedPath };
      } catch (error) {
        // ENOENT (file doesn't exist) means desired state is already achieved (idempotent)
        if (isNodeError(error) && error.code === 'ENOENT') {
          console.debug('[ChunkCleanupService] File already missing:', path.basename(resolvedPath));
          return { status: 'missing', filePath: resolvedPath };
        }
        const { message, code } = getErrorDetails(error);
        const errorMsg = code ? `${message} (${code})` : message;
        console.error('[ChunkCleanupService] Failed to delete file:', {
          filePath: path.basename(resolvedPath),
          error: message,
          code,
        });
        return { status: 'failed', filePath: resolvedPath, error: errorMsg };
      }
    });

    const results = await Promise.all(deletePromises);
    const deletedFilePaths = results.filter(r => r.status === 'deleted').map(r => r.filePath);
    const missingFilePaths = results.filter(r => r.status === 'missing').map(r => r.filePath);
    const failedFiles = results
      .filter((r): r is Extract<DeleteResult, { status: 'failed' }> => r.status === 'failed')
      .map(r => ({ filePath: r.filePath, error: r.error }));

    console.info('[ChunkCleanupService] File cleanup completed:', {
      totalFiles: filePaths.length,
      deletedCount: deletedFilePaths.length,
      missingCount: missingFilePaths.length,
      failureCount: failedFiles.length,
    });

    return {
      deletedCount: deletedFilePaths.length,
      missingCount: missingFilePaths.length,
      failureCount: failedFiles.length,
      deletedFilePaths,
      missingFilePaths,
      failedFiles,
    };
  }

  /**
   * Get statistics about the chunks directory
   */
  public async getChunkStats(): Promise<{
    totalChunkFiles: number;
    totalSizeBytes: number;
    oldestFileAge: number;
    newestFileAge: number;
  }> {
    if (!this.isInitialized) {
      throw new Error('ChunkCleanupService not initialized');
    }

    // Capture timestamp once for consistent calculations
    const currentTimeMs = Date.now();

    try {
      const files = await fs.readdir(this.chunksDir);
      const chunkFiles = files.filter(f => f.endsWith('.txt'));

      if (chunkFiles.length === 0) {
        return {
          totalChunkFiles: 0,
          totalSizeBytes: 0,
          oldestFileAge: 0,
          newestFileAge: 0,
        };
      }

      let totalSize = 0;
      let oldestTime = currentTimeMs;
      let newestTime = 0;
      let regularFileCount = 0;

      for (const file of chunkFiles) {
        const filePath = path.join(this.chunksDir, file);
        const stat = await fs.lstat(filePath);

        // Skip non-regular files (consistent with findAgedChunks/findOrphanedChunks)
        if (!stat.isFile()) {
          continue;
        }

        regularFileCount++;
        totalSize += stat.size;
        oldestTime = Math.min(oldestTime, stat.mtime.getTime());
        newestTime = Math.max(newestTime, stat.mtime.getTime());
      }

      // Adjust count to only include regular files
      if (regularFileCount === 0) {
        return {
          totalChunkFiles: 0,
          totalSizeBytes: 0,
          oldestFileAge: 0,
          newestFileAge: 0,
        };
      }

      return {
        totalChunkFiles: regularFileCount,
        totalSizeBytes: totalSize,
        oldestFileAge: Math.floor((currentTimeMs - oldestTime) / (24 * 60 * 60 * 1000)),
        newestFileAge: Math.floor((currentTimeMs - newestTime) / (24 * 60 * 60 * 1000)),
      };
    } catch (error) {
      console.error('[ChunkCleanupService] Failed to get chunk stats:', error);
      throw error;
    }
  }

  /**
   * Ensure chunks directory exists
   */
  private async ensureChunksDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.chunksDir, { recursive: true });
      console.info('[ChunkCleanupService] Ensured chunks directory exists:', this.chunksDir);
    } catch (error) {
      console.error('[ChunkCleanupService] Failed to create chunks directory:', error);
      throw error;
    }
  }

  /**
   * Clean up all resources
   */
  public cleanup(): void {
    console.info('[ChunkCleanupService] Cleaning up resources...');
    this.removeAllListeners();
    console.info('[ChunkCleanupService] Cleanup complete');
  }
}
