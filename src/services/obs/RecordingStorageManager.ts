/**
 * RecordingStorageManager - Manages recording storage and quota enforcement
 * Handles disk space calculations and cleanup of old recordings
 */

import * as path from 'path';
import { promises as fs } from 'fs';
import { RECORDING_EXTENSION, THUMBNAIL_EXTENSION } from '../RecordingTypes';

/**
 * File information for storage management
 */
interface FileInfo {
  path: string;
  sizeGB: number;
  mtime: Date;
}

/**
 * Details of a single recording deletion during quota enforcement
 * Path-only approach: metadata lookup uses filePath match, not filename parsing
 */
export interface StorageQuotaDeletion {
  filePath: string;
  fileName: string;
  sizeGB: number;
  thumbnailPath: string;
  thumbnailDeleted: boolean;
}

/**
 * Result of quota enforcement operation
 */
export interface StorageQuotaEnforcementResult {
  exceeded: boolean;
  maxGB: number;
  beforeGB: number;
  afterGB: number;
  deleted: StorageQuotaDeletion[];
  errors: Array<{ filePath: string; error: string }>;
}

/**
 * Manages recording storage and quota enforcement
 */
export class RecordingStorageManager {
  private defaultOutputDir: string;

  constructor(defaultOutputDir: string) {
    this.defaultOutputDir = defaultOutputDir;
    console.log('[RecordingStorageManager] Initialized with output dir:', defaultOutputDir);
  }

  /**
   * Get used space by recordings in GB (efficient calculation)
   */
  public async getRecordingsUsedSpace(): Promise<number> {
    return RecordingStorageManager.getRecordingsUsedSpaceForDirectory(this.defaultOutputDir);
  }

  public static async getRecordingsUsedSpaceForDirectory(
    outputDir: string,
    options: { quietMissingDir?: boolean } = {}
  ): Promise<number> {
    try {
      // Calculate total size of actual recording files
      const recordingFiles = await RecordingStorageManager.getRecordingFilesForDirectory(outputDir);
      let totalSize = 0;

      for (const file of recordingFiles) {
        try {
          const stats = await fs.stat(file);
          totalSize += stats.size;
        } catch (statError) {
          console.warn(`[RecordingStorageManager] Could not stat file, skipping: ${file}`);
        }
      }

      return totalSize / (1024 * 1024 * 1024); // Convert to GB
    } catch (error) {
      if (
        options.quietMissingDir &&
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return 0;
      }
      console.error('[RecordingStorageManager] Failed to calculate recordings used space:', error);
      return 0;
    }
  }

  /**
   * Normalize path for comparison (case-insensitive on Windows).
   * Matches MetadataStorageService.normalizePathForComparison behavior.
   */
  private normalizePathForComparison(filePath: string): string {
    const normalized = path.resolve(filePath);
    // Windows paths are case-insensitive
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  }

  /**
   * Enforce user storage quota by deleting oldest recordings.
   * Returns detailed result including which files were deleted (path-only, no filename parsing).
   */
  public async enforceStorageQuota(
    maxStorageGB: number,
    protectedVideoPaths?: Set<string>
  ): Promise<StorageQuotaEnforcementResult> {
    const result: StorageQuotaEnforcementResult = {
      exceeded: false,
      maxGB: maxStorageGB,
      beforeGB: 0,
      afterGB: 0,
      deleted: [],
      errors: [],
    };

    if (maxStorageGB <= 0) {
      // 0 = unlimited
      return result;
    }

    try {
      // Get all recording files (not temp files)
      const recordingFiles = await this.getRecordingFiles();

      // Calculate total size
      let totalSizeGB = 0;
      const fileInfos: FileInfo[] = [];

      for (const file of recordingFiles) {
        try {
          const stats = await fs.stat(file);
          const sizeGB = stats.size / (1024 * 1024 * 1024);
          totalSizeGB += sizeGB;
          fileInfos.push({
            path: file,
            sizeGB: sizeGB,
            mtime: stats.mtime,
          });
        } catch (statError) {
          // Record per-file stat failure so callers can distinguish "no recordings" vs "couldn't scan"
          const errorMsg = statError instanceof Error ? statError.message : String(statError);
          console.warn('[RecordingStorageManager] Could not stat recording file:', file);
          result.errors.push({ filePath: file, error: errorMsg });
        }
      }

      result.beforeGB = totalSizeGB;

      // If under limit, no cleanup needed
      if (totalSizeGB <= maxStorageGB) {
        result.afterGB = totalSizeGB;
        return result;
      }

      result.exceeded = true;

      // Pre-normalize protected paths into a set for efficient lookup
      const normalizedProtectedPaths = new Set<string>();
      if (protectedVideoPaths) {
        for (const protectedPath of protectedVideoPaths) {
          normalizedProtectedPaths.add(this.normalizePathForComparison(protectedPath));
        }
      }

      // Sort by modification time (oldest first)
      fileInfos.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());

      // Delete oldest files until under quota
      console.log(
        `[RecordingStorageManager] Storage quota exceeded (${totalSizeGB.toFixed(1)}GB / ${maxStorageGB}GB), cleaning up old recordings`
      );

      for (const fileInfo of fileInfos) {
        if (totalSizeGB <= maxStorageGB) break;

        // Skip deletion for protected favourite recordings
        const normalizedFilePath = this.normalizePathForComparison(fileInfo.path);
        if (normalizedProtectedPaths.has(normalizedFilePath)) {
          console.log(
            `[RecordingStorageManager] Skipping favourite recording: ${path.basename(fileInfo.path)}`
          );
          continue;
        }

        const fileName = path.basename(fileInfo.path);
        const parsedPath = path.parse(fileInfo.path);
        const thumbnailsDir = path.join(parsedPath.dir, 'Thumbnails');
        const thumbnailPath = path.join(thumbnailsDir, `${parsedPath.name}${THUMBNAIL_EXTENSION}`);

        try {
          await fs.unlink(fileInfo.path);
          totalSizeGB -= fileInfo.sizeGB;
          console.log(
            `[RecordingStorageManager] Deleted old recording: ${fileName} (${fileInfo.sizeGB.toFixed(1)}GB)`
          );

          // Try to delete thumbnail
          let thumbnailDeleted = false;
          try {
            await fs.unlink(thumbnailPath);
            thumbnailDeleted = true;
            console.log(
              `[RecordingStorageManager] Deleted associated thumbnail: ${path.basename(thumbnailPath)}`
            );
          } catch (thumbnailError) {
            // Thumbnail might not exist, which is fine
            if ((thumbnailError as NodeJS.ErrnoException).code !== 'ENOENT') {
              console.warn(
                '[RecordingStorageManager] Could not delete thumbnail (non-critical):',
                thumbnailPath
              );
            }
          }

          // Record deletion details (path-only: metadata lookup by filePath)
          result.deleted.push({
            filePath: fileInfo.path,
            fileName,
            sizeGB: fileInfo.sizeGB,
            thumbnailPath,
            thumbnailDeleted,
          });
        } catch (deleteError) {
          const errorMsg = deleteError instanceof Error ? deleteError.message : String(deleteError);
          console.error(
            '[RecordingStorageManager] Failed to delete recording:',
            fileInfo.path,
            deleteError
          );
          result.errors.push({ filePath: fileInfo.path, error: errorMsg });
        }
      }

      result.afterGB = totalSizeGB;

      // Log warning if favourites prevented full cleanup
      if (totalSizeGB > maxStorageGB) {
        console.warn(
          `[RecordingStorageManager] Protected favourite recordings prevented reaching quota: ${totalSizeGB.toFixed(1)}GB / ${maxStorageGB}GB`
        );
      }

      console.log(
        `[RecordingStorageManager] Storage cleanup complete: ${totalSizeGB.toFixed(1)}GB / ${maxStorageGB}GB`
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error('[RecordingStorageManager] Error during storage quota enforcement:', error);

      // Record the error so callers don't interpret this as "clean run with no deletions"
      result.errors.push({ filePath: this.defaultOutputDir, error: errorMsg });
      // Compute afterGB from deletions that actually occurred (may be partial)
      const deletedSizeGB = result.deleted.reduce((sum, d) => sum + d.sizeGB, 0);
      result.afterGB = Math.max(0, result.beforeGB - deletedSizeGB);
    }

    return result;
  }

  /**
   * Get all recording files (excluding temp directory)
   * Throws on directory read failure so caller can capture into errors.
   * Uses withFileTypes to avoid redundant stat calls - caller stats for size/mtime.
   */
  private async getRecordingFiles(): Promise<string[]> {
    return RecordingStorageManager.getRecordingFilesForDirectory(this.defaultOutputDir);
  }

  private static async getRecordingFilesForDirectory(outputDir: string): Promise<string[]> {
    // Let readdir throw on failure so enforceStorageQuota can capture it
    const items = await fs.readdir(outputDir, { withFileTypes: true });

    const files: string[] = [];
    for (const dirent of items) {
      // Only include recording files, skip directories and non-recording files
      if (dirent.isFile() && dirent.name.endsWith(RECORDING_EXTENSION)) {
        files.push(path.join(outputDir, dirent.name));
      }
    }

    return files;
  }

  /**
   * Update the output directory
   */
  public updateOutputDirectory(dir: string): void {
    this.defaultOutputDir = dir;
    console.log('[RecordingStorageManager] Output directory updated:', dir);
  }

  /**
   * Get the current output directory
   */
  public getOutputDirectory(): string {
    return this.defaultOutputDir;
  }
}
