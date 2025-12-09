import { EventEmitter } from 'events';
import { app } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Configuration for the Chunk Cleanup Service
 */
export interface ChunkCleanupServiceConfig {
  /** Directory where chunks are stored */
  chunksDir?: string;
  /** Whether to enable automatic cleanup on successful uploads */
  autoCleanupEnabled?: boolean;
}

/**
 * Service for cleaning up chunk files after successful uploads
 * Prevents the chunks directory from growing endlessly
 */
export class ChunkCleanupService extends EventEmitter {
  private readonly chunksDir: string;
  private readonly config: ChunkCleanupServiceConfig;
  private isInitialized = false;

  constructor(config: ChunkCleanupServiceConfig = {}) {
    super();
    
    // Set up chunks directory with normalized folder structure
    const userDataPath = app ? app.getPath('userData') : path.join(process.cwd(), 'data');
    this.chunksDir = config.chunksDir || path.join(userDataPath, 'logs', 'chunks');
    
    this.config = {
      autoCleanupEnabled: true,
      ...config,
      chunksDir: this.chunksDir // Ensure chunksDir is always set
    };

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
   * Clean up chunk files for a specific bufferId after successful upload
   * @param bufferId The bufferId to clean up chunks for
   * @param jobId Optional job ID for logging correlation
   */
  public async cleanupChunksForInstance(bufferId: string, jobId?: string): Promise<void> {
    if (!this.isInitialized) {
      console.warn('[ChunkCleanupService] Service not initialized, skipping cleanup');
      return;
    }

    if (!this.config.autoCleanupEnabled) {
      console.debug('[ChunkCleanupService] Auto cleanup disabled, skipping cleanup for instance:', bufferId);
      return;
    }

    try {
      console.info('[ChunkCleanupService] Starting cleanup for instance:', { bufferId, jobId });
      
      // Find all chunk files matching this bufferId
      const chunkFiles = await this.findChunkFilesForInstance(bufferId);
      
      if (chunkFiles.length === 0) {
        console.debug('[ChunkCleanupService] No chunk files found for instance:', bufferId);
        return;
      }

      console.info('[ChunkCleanupService] Found chunk files to clean up:', {
        bufferId,
        chunkCount: chunkFiles.length,
        files: chunkFiles.map(f => path.basename(f))
      });

      // Use consolidated cleanup method
      const { successCount, failureCount, deletedFilePaths, failedFilePaths } = await this.cleanupFiles(chunkFiles);

      console.info('[ChunkCleanupService] Cleanup completed for instance:', {
        bufferId,
        jobId,
        totalFiles: chunkFiles.length,
        successCount,
        failureCount
      });

      // Emit cleanup completed event
      this.emit('cleanupCompleted', {
        bufferId,
        jobId,
        totalFiles: chunkFiles.length,
        successCount,
        failureCount,
        deletedFiles: deletedFilePaths.map(f => path.basename(f)) // Actual successfully deleted files
      });

      // If there were failures, emit an error event
      if (failureCount > 0) {
        this.emit('cleanupErrors', {
          bufferId,
          jobId,
          failureCount,
          failedFiles: failedFilePaths.map(f => path.basename(f)) // Failed file basenames for diagnostics
        });
      }

    } catch (error) {
      console.error('[ChunkCleanupService] Failed to cleanup chunks for instance:', {
        bufferId,
        jobId,
        error: (error as Error).message
      });
      
      this.emit('error', {
        message: 'Failed to cleanup chunks for instance',
        bufferId,
        jobId,
        error: (error as Error).message
      });
    }
  }

  /**
   * Find all chunk files that belong to a specific bufferId
   * Uses stateless filename-based correlation with predictable chunk naming
   */
  private async findChunkFilesForInstance(bufferId: string): Promise<string[]> {
    try {
      // Sanitize bufferId to prevent path injection
      const sanitizedBufferId = this.sanitizeBufferId(bufferId);
      
      console.debug('[ChunkCleanupService] Scanning directory for bufferId:', sanitizedBufferId);
      
      const files = await fs.readdir(this.chunksDir);
      const matchingFiles: string[] = [];
      
      for (const file of files) {
        // Skip non-text files
        if (!file.endsWith('.txt')) {
          continue;
        }
        
        // MatchChunker writes chunk files with bufferId format: <bufferId>.txt
        if (file === `${sanitizedBufferId}.txt`) {
          const fullPath = path.join(this.chunksDir, file);
          matchingFiles.push(fullPath);
        }
      }
      
      if (matchingFiles.length > 0) {
        console.debug('[ChunkCleanupService] Found chunk files via directory scan:', {
          bufferId: sanitizedBufferId,
          files: matchingFiles.map(f => path.basename(f))
        });
      }
      
      return matchingFiles;
    } catch (error) {
      console.error('[ChunkCleanupService] Failed to find chunk files for instance:', {
        bufferId,
        error: (error as Error).message
      });
      return [];
    }
  }

  /**
   * Find chunk files for a specific bufferId (public method for retry functionality)
   * @param bufferId The bufferId to find chunks for
   * @returns Array of chunk file paths
   */
  public async findChunkFiles(bufferId: string): Promise<string[]> {
    if (!this.isInitialized) {
      console.warn('[ChunkCleanupService] Service not initialized, cannot find chunk files');
      return [];
    }
    
    return await this.findChunkFilesForInstance(bufferId);
  }

  /**
   * Sanitize bufferId to prevent path injection attacks
   */
  private sanitizeBufferId(bufferId: string): string {
    // Remove any potentially dangerous characters
    return bufferId.replace(/[^a-zA-Z0-9_-]/g, '');
  }

  /**
   * Find chunk files that have no corresponding metadata files (orphaned chunks)
   * This identifies chunks left behind by system failures or incomplete processing
   * @param validBufferIds Set of bufferIds that have valid metadata files
   * @returns Array of absolute paths to orphaned chunk files
   */
  public async findOrphanedChunks(validBufferIds: Set<string>): Promise<string[]> {
    if (!this.isInitialized) {
      console.warn('[ChunkCleanupService] Service not initialized, cannot find orphaned chunks');
      return [];
    }

    try {
      console.debug('[ChunkCleanupService] Scanning for orphaned chunk files');
      
      const files = await fs.readdir(this.chunksDir);
      const orphanedChunks: string[] = [];
      
      for (const file of files) {
        // Skip non-text files
        if (!file.endsWith('.txt')) {
          continue;
        }
        
        // Extract bufferId from simple filename format: <bufferId>.txt
        const bufferId = path.basename(file, '.txt');
        
        // Check if this bufferId has corresponding metadata
        if (!validBufferIds.has(bufferId)) {
          const filePath = path.join(this.chunksDir, file);
          orphanedChunks.push(filePath);
          console.debug(`[ChunkCleanupService] Found orphaned chunk: ${file} (no metadata for ${bufferId})`);
        }
      }
      
      if (orphanedChunks.length > 0) {
        console.info(`[ChunkCleanupService] Found ${orphanedChunks.length} orphaned chunk files`);
      } else {
        console.debug('[ChunkCleanupService] No orphaned chunk files found');
      }
      
      return orphanedChunks;
      
    } catch (error) {
      console.error('[ChunkCleanupService] Failed to find orphaned chunks:', {
        error: (error as Error).message
      });
      return [];
    }
  }

  /**
   * Clean up specific chunk files by their absolute paths
   * @param filePaths Array of absolute paths to chunk files to delete
   * @returns Object with success/failure counts and lists of deleted/failed files
   */
  public async cleanupFiles(filePaths: string[]): Promise<{ successCount: number; failureCount: number; deletedFilePaths: string[]; failedFilePaths: string[] }> {
    if (!this.isInitialized) {
      console.warn('[ChunkCleanupService] Service not initialized, skipping file cleanup');
      return { successCount: 0, failureCount: 0, deletedFilePaths: [], failedFilePaths: [] };
    }

    if (filePaths.length === 0) {
      return { successCount: 0, failureCount: 0, deletedFilePaths: [], failedFilePaths: [] };
    }

    console.info(`[ChunkCleanupService] Starting cleanup of ${filePaths.length} files`);

    const deletePromises = filePaths.map(async (filePath) => {
      try {
        await fs.unlink(filePath);
        console.debug('[ChunkCleanupService] Deleted file:', path.basename(filePath));
        return { success: true, filePath };
      } catch (error) {
        console.error('[ChunkCleanupService] Failed to delete file:', {
          filePath: path.basename(filePath),
          error: (error as Error).message
        });
        return { success: false, filePath, error: (error as Error).message };
      }
    });

    const results = await Promise.all(deletePromises);
    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => !r.success).length;
    const deletedFilePaths = results.filter(r => r.success).map(r => r.filePath);
    const failedFilePaths = results.filter(r => !r.success).map(r => r.filePath);

    console.info('[ChunkCleanupService] File cleanup completed:', {
      totalFiles: filePaths.length,
      successCount,
      failureCount
    });

    return { successCount, failureCount, deletedFilePaths, failedFilePaths };
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
      throw new Error('Service not initialized');
    }

    try {
      const files = await fs.readdir(this.chunksDir);
      const chunkFiles = files.filter(f => f.endsWith('.txt'));
      
      if (chunkFiles.length === 0) {
        return {
          totalChunkFiles: 0,
          totalSizeBytes: 0,
          oldestFileAge: 0,
          newestFileAge: 0
        };
      }
      
      let totalSize = 0;
      let oldestTime = Date.now();
      let newestTime = 0;
      
      for (const file of chunkFiles) {
        const filePath = path.join(this.chunksDir, file);
        const stat = await fs.stat(filePath);
        
        totalSize += stat.size;
        oldestTime = Math.min(oldestTime, stat.mtime.getTime());
        newestTime = Math.max(newestTime, stat.mtime.getTime());
      }
      
      return {
        totalChunkFiles: chunkFiles.length,
        totalSizeBytes: totalSize,
        oldestFileAge: Math.floor((Date.now() - oldestTime) / (24 * 60 * 60 * 1000)),
        newestFileAge: Math.floor((Date.now() - newestTime) / (24 * 60 * 60 * 1000))
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