import * as fs from 'fs';
import * as path from 'path';

/**
 * Correlation data for tracking job-to-match relationships.
 *
 * ENTITLEMENT INVARIANT:
 * This persisted state must remain free of entitlement fields.
 * Entitlements are derived at request time from the backend (DB-backed),
 * not persisted in desktop state.
 */
export interface CorrelationData {
  matchHash: string;
  timestamp: number;
  // Simple retry tracking
  errorType?: 'rate_limit' | 'auth' | 'server' | 'network' | 'permanent_server';
  retryCount?: number;
  nextRetryAt?: number | undefined;
}

/**
 * Storage statistics interface
 */
export interface StorageStats {
  pendingUploadsExists: boolean;
  pendingUploadsSize?: number;
}

/**
 * JobStateStore - Manages persistent state for job tracking
 *
 * This service handles all persistence of job tracking state for
 * pending uploads. It ensures state survives application restarts
 * and provides atomic write operations.
 */
export class JobStateStore {
  // File name constants
  private static readonly PENDING_UPLOADS_FILENAME = 'pending-uploads.json';

  private pendingUploadsPath: string;

  constructor(private userDataPath: string) {
    // Set up file paths
    this.pendingUploadsPath = path.join(userDataPath, JobStateStore.PENDING_UPLOADS_FILENAME);

    console.info('[JobStateStore] Initialized with path:', {
      pendingUploads: this.pendingUploadsPath,
    });
  }

  /**
   * Atomically write data to a file
   * Uses temp file + rename for atomic operation
   */
  private async atomicWrite(filePath: string, data: string): Promise<void> {
    const tmpPath = `${filePath}.tmp`;
    try {
      // Ensure directory exists
      const dir = path.dirname(filePath);
      await fs.promises.mkdir(dir, { recursive: true });

      await fs.promises.writeFile(tmpPath, data, 'utf-8');
      await fs.promises.rename(tmpPath, filePath);
    } catch (error) {
      // Clean up temp file if rename failed
      try {
        await fs.promises.unlink(tmpPath);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  /**
   * Save pending uploads to disk
   */
  async savePendingUploads(uploads: Map<string, CorrelationData>): Promise<void> {
    try {
      const data = Object.fromEntries(uploads);
      await this.atomicWrite(this.pendingUploadsPath, JSON.stringify(data, null, 2));
      console.debug('[JobStateStore] Saved pending uploads:', uploads.size);
    } catch (error) {
      console.error('[JobStateStore] Failed to save pending uploads:', error);
      throw error;
    }
  }

  /**
   * Load pending uploads from disk
   */
  async loadPendingUploads(): Promise<Map<string, CorrelationData>> {
    try {
      await fs.promises.access(this.pendingUploadsPath);
      const data = await fs.promises.readFile(this.pendingUploadsPath, 'utf-8');
      const parsed = JSON.parse(data);
      const map = new Map(Object.entries(parsed) as [string, CorrelationData][]);
      console.info('[JobStateStore] Loaded pending uploads:', map.size);
      return map;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[JobStateStore] Failed to load pending uploads:', error);
      }
      // Return empty map on error or if file doesn't exist
      return new Map();
    }
  }

  /**
   * Clear all pending uploads
   */
  async clearPendingUploads(): Promise<void> {
    try {
      await fs.promises.access(this.pendingUploadsPath);
      await fs.promises.unlink(this.pendingUploadsPath);
      console.info('[JobStateStore] Cleared pending uploads');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[JobStateStore] Failed to clear pending uploads:', error);
      }
    }
  }

  /**
   * Get storage stats for debugging
   */
  async getStats(): Promise<StorageStats> {
    const stats: StorageStats = {
      pendingUploadsExists: false,
    };

    // Check pending uploads file
    try {
      await fs.promises.access(this.pendingUploadsPath);
      stats.pendingUploadsExists = true;
      const fileStats = await fs.promises.stat(this.pendingUploadsPath);
      stats.pendingUploadsSize = fileStats.size;
    } catch {
      // File doesn't exist or can't be accessed
    }

    return stats;
  }
}
