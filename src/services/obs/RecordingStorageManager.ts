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
    try {
      // Calculate total size of actual recording files
      const recordingFiles = await this.getRecordingFiles();
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
      console.error('[RecordingStorageManager] Failed to calculate recordings used space:', error);
      return 0;
    }
  }
  
  /**
   * Enforce user storage quota by deleting oldest recordings
   */
  public async enforceStorageQuota(maxStorageGB: number): Promise<void> {
    if (maxStorageGB <= 0) return; // 0 = unlimited
    
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
            mtime: stats.mtime
          });
        } catch (statError) {
          console.warn('[RecordingStorageManager] Could not stat recording file:', file);
        }
      }
      
      // If under limit, no cleanup needed
      if (totalSizeGB <= maxStorageGB) {
        return;
      }
      
      // Sort by modification time (oldest first)
      fileInfos.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());
      
      // Delete oldest files until under quota
      console.log(`[RecordingStorageManager] Storage quota exceeded (${totalSizeGB.toFixed(1)}GB / ${maxStorageGB}GB), cleaning up old recordings`);
      
      for (const fileInfo of fileInfos) {
        if (totalSizeGB <= maxStorageGB) break;
        
        try {
          await fs.unlink(fileInfo.path);
          totalSizeGB -= fileInfo.sizeGB;
          console.log(`[RecordingStorageManager] Deleted old recording: ${path.basename(fileInfo.path)} (${fileInfo.sizeGB.toFixed(1)}GB)`);
          
          // Also try to delete thumbnail if it exists (in Thumbnails subfolder)
          const parsedPath = path.parse(fileInfo.path);
          const thumbnailsDir = path.join(parsedPath.dir, 'Thumbnails');
          const thumbnailPath = path.join(thumbnailsDir, `${parsedPath.name}${THUMBNAIL_EXTENSION}`);
          try {
            await fs.unlink(thumbnailPath);
            console.log(`[RecordingStorageManager] Deleted associated thumbnail: ${path.basename(thumbnailPath)}`);
          } catch (thumbnailError) {
            // Thumbnail might not exist, which is fine
            if ((thumbnailError as NodeJS.ErrnoException).code !== 'ENOENT') {
              console.warn('[RecordingStorageManager] Could not delete thumbnail (non-critical):', thumbnailPath);
            }
          }
        } catch (deleteError) {
          console.error('[RecordingStorageManager] Failed to delete recording:', fileInfo.path, deleteError);
        }
      }
      
      console.log(`[RecordingStorageManager] Storage cleanup complete: ${totalSizeGB.toFixed(1)}GB / ${maxStorageGB}GB`);
      
    } catch (error) {
      console.error('[RecordingStorageManager] Error during storage quota enforcement:', error);
    }
  }
  
  /**
   * Get all recording files (excluding temp directory)
   */
  private async getRecordingFiles(): Promise<string[]> {
    const files: string[] = [];
    
    try {
      const items = await fs.readdir(this.defaultOutputDir);
      
      for (const item of items) {
        const itemPath = path.join(this.defaultOutputDir, item);
        const stats = await fs.stat(itemPath);
        
        // Only include recording files, skip temp directory and other files
        if (stats.isFile() && item.endsWith(RECORDING_EXTENSION)) {
          files.push(itemPath);
        }
      }
    } catch (error) {
      console.error('[RecordingStorageManager] Error reading recordings directory:', error);
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