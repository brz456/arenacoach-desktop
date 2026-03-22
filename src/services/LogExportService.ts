import { app } from 'electron';
import * as fs from 'fs/promises';
import * as fsCb from 'fs';
import * as path from 'path';
import archiver from 'archiver';
import { isNodeError } from '../utils/errors';
import { isValidBufferId } from '../utils/bufferId';

export interface LogExportOptions {
  /** If provided, exports data for this specific match */
  bufferId?: string;
}

/** Discriminated union - prevents impossible states like { success: true, error: '...' } */
export type LogExportResult =
  | { success: true; zipPath: string }
  | { success: false; error: string };

interface ManifestFile {
  path: string;
  found: boolean;
}

interface ManifestDirectory {
  path: string;
  exists: boolean;
}

interface ExportManifest {
  exportedAt: string;
  appVersion: string;
  bufferId?: string;
  directories: ManifestDirectory[];
  files: ManifestFile[];
}

// Maximum number of recent match files to include in general export.
// Balances usefulness (enough context for debugging) vs zip size.
const MAX_RECENT_MATCHES = 50;

// Log file extension pattern for enumeration
const LOG_FILE_PATTERN = /\.log$/;

/**
 * Service for exporting application logs and match data for debugging
 */
export class LogExportService {
  private readonly userDataPath: string;
  private readonly logsDir: string;
  private readonly matchesDir: string;
  private readonly chunksDir: string;
  private readonly osnLogsDir: string;

  constructor() {
    this.userDataPath = app.getPath('userData');
    this.logsDir = path.join(this.userDataPath, 'logs');
    this.matchesDir = path.join(this.logsDir, 'matches');
    this.chunksDir = path.join(this.logsDir, 'chunks');
    this.osnLogsDir = path.join(this.userDataPath, 'osn-data', 'node-obs', 'logs');
  }

  /**
   * Export logs and optionally match-specific data to a zip file in Downloads.
   * Returns zipPath on success; caller may choose to reveal it in the OS file manager.
   */
  async exportLogs(options: LogExportOptions = {}): Promise<LogExportResult> {
    const { bufferId } = options;
    const hasBufferId = bufferId !== undefined;

    // Validate bufferId to prevent path traversal
    if (hasBufferId && !isValidBufferId(bufferId)) {
      return { success: false, error: 'Invalid bufferId format' };
    }

    try {
      // Single timestamp for consistency between filename and manifest
      const now = new Date();
      const timestamp = now.toISOString().replace(/[:.]/g, '-');
      const filename = hasBufferId
        ? `ArenaCoach-Logs-${timestamp}-${bufferId}.zip`
        : `ArenaCoach-Logs-${timestamp}.zip`;

      const downloadsPath = app.getPath('downloads');
      const zipPath = path.join(downloadsPath, filename);

      const manifest: ExportManifest = {
        exportedAt: now.toISOString(),
        appVersion: app.getVersion(),
        ...(hasBufferId && { bufferId }),
        directories: [],
        files: [],
      };

      await this.createZipArchive(zipPath, manifest, bufferId);

      return { success: true, zipPath };
    } catch (error) {
      // Preserve actionable error info; log full error for debugging
      const message = error instanceof Error ? error.message : String(error);
      console.error('[LogExportService] Export failed:', error);
      return { success: false, error: message };
    }
  }

  private async createZipArchive(
    zipPath: string,
    manifest: ExportManifest,
    bufferId?: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const output = fsCb.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 6 } });

      const cleanup = () => {
        archive.destroy();
        output.destroy();
      };

      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          fn();
        }
      };

      const rejectWithCleanup = (err: Error) => {
        cleanup();
        // Best-effort delete partial zip
        fs.unlink(zipPath).catch(unlinkErr => {
          console.warn('[LogExportService] Failed to cleanup partial zip:', unlinkErr);
        });
        reject(err);
      };

      output.on('close', () => {
        settle(() => {
          console.info(`[LogExportService] Archive created: ${archive.pointer()} bytes`);
          resolve();
        });
      });

      output.on('error', err => {
        settle(() => rejectWithCleanup(err));
      });

      archive.on('error', err => {
        settle(() => rejectWithCleanup(err));
      });

      archive.on('warning', err => {
        // All warnings are fatal
        settle(() => rejectWithCleanup(err));
      });

      archive.pipe(output);

      // Queue files for archiving; manifest written after enumeration
      this.addFilesToArchive(archive, manifest, bufferId)
        .then(() => {
          // Add manifest last - all files processed, manifest.files is final
          const manifestJson = JSON.stringify(manifest, null, 2);
          archive.append(manifestJson, { name: 'manifest.json' });
          archive.finalize().catch(err => settle(() => rejectWithCleanup(err)));
        })
        .catch(err => settle(() => rejectWithCleanup(err)));
    });
  }

  private async addFilesToArchive(
    archive: archiver.Archiver,
    manifest: ExportManifest,
    bufferId: string | undefined
  ): Promise<void> {
    const hasBufferId = bufferId !== undefined;

    // Always include log files
    await this.addLogFiles(archive, manifest);

    // Always include OBS/osn-data logs (critical for crash diagnosis)
    await this.addOsnLogs(archive, manifest);

    if (hasBufferId) {
      // Include specific match data
      await this.addMatchFile(archive, manifest, bufferId);
      await this.addChunkFile(archive, manifest, bufferId);
    } else {
      // Include recent matches (metadata only, not chunks)
      await this.addRecentMatchFiles(archive, manifest);
    }
  }

  private async addLogFiles(archive: archiver.Archiver, manifest: ExportManifest): Promise<void> {
    // Enumerate logs directory for .log files (SSoT: actual files present)
    let logFiles: string[];
    try {
      const files = await fs.readdir(this.logsDir);
      logFiles = files.filter(f => LOG_FILE_PATTERN.test(f)).sort();
      manifest.directories.push({ path: 'logs/', exists: true });
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        // Record that logs directory doesn't exist
        manifest.directories.push({ path: 'logs/', exists: false });
        return;
      }
      throw err;
    }

    for (const logFile of logFiles) {
      const logPath = path.join(this.logsDir, logFile);
      const archiveName = `logs/${logFile}`;
      await this.appendFileEntry(archive, manifest, logPath, archiveName);
    }
  }

  /**
   * Add OBS/osn-data logs for crash diagnosis.
   * These logs contain x264 encoder crashes, GPU errors, and other OBS subprocess issues.
   * Each file is one OBS session; we include the most recent ones.
   */
  private async addOsnLogs(archive: archiver.Archiver, manifest: ExportManifest): Promise<void> {
    const MAX_OSN_LOGS = 10;
    let files: string[];
    try {
      files = await fs.readdir(this.osnLogsDir);
      manifest.directories.push({ path: 'osn-logs/', exists: true });
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        // OBS logs directory doesn't exist (OBS never initialized)
        manifest.directories.push({ path: 'osn-logs/', exists: false });
        return;
      }
      throw err;
    }

    const txtFiles = files.filter(f => f.endsWith('.txt'));

    // Get file stats and sort by modification time (newest first)
    const filesWithStats = await Promise.all(
      txtFiles.map(async file => {
        const filePath = path.join(this.osnLogsDir, file);
        try {
          const stat = await fs.stat(filePath);
          return { file, filePath, mtime: stat.mtimeMs };
        } catch (err) {
          if (isNodeError(err) && err.code === 'ENOENT') {
            return null;
          }
          throw err;
        }
      })
    );

    const validFiles = filesWithStats
      .filter((f): f is { file: string; filePath: string; mtime: number } => f !== null)
      .sort((a, b) => b.mtime - a.mtime || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
      .slice(0, MAX_OSN_LOGS);

    for (const { file, filePath } of validFiles) {
      const archiveName = `osn-logs/${file}`;
      await this.appendFileEntry(archive, manifest, filePath, archiveName);
    }
  }

  private async addMatchFile(
    archive: archiver.Archiver,
    manifest: ExportManifest,
    bufferId: string
  ): Promise<void> {
    // Check directory existence for manifest consistency
    const dirExists = await this.checkDirectoryExists(this.matchesDir);
    manifest.directories.push({ path: 'matches/', exists: dirExists });

    const archiveName = `matches/${bufferId}.json`;
    if (!dirExists) {
      manifest.files.push({ path: archiveName, found: false });
      return;
    }

    const matchPath = path.join(this.matchesDir, `${bufferId}.json`);
    await this.appendFileEntry(archive, manifest, matchPath, archiveName);
  }

  private async addChunkFile(
    archive: archiver.Archiver,
    manifest: ExportManifest,
    bufferId: string
  ): Promise<void> {
    // Check directory existence for manifest consistency
    const dirExists = await this.checkDirectoryExists(this.chunksDir);
    manifest.directories.push({ path: 'chunks/', exists: dirExists });

    const archiveName = `chunks/${bufferId}.txt`;
    if (!dirExists) {
      manifest.files.push({ path: archiveName, found: false });
      return;
    }

    const chunkPath = path.join(this.chunksDir, `${bufferId}.txt`);
    await this.appendFileEntry(archive, manifest, chunkPath, archiveName);
  }

  private async addRecentMatchFiles(
    archive: archiver.Archiver,
    manifest: ExportManifest
  ): Promise<void> {
    let files: string[];
    try {
      files = await fs.readdir(this.matchesDir);
      manifest.directories.push({ path: 'matches/', exists: true });
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        // Record that matches directory doesn't exist
        manifest.directories.push({ path: 'matches/', exists: false });
        return;
      }
      throw err;
    }

    const jsonFiles = files.filter(f => f.endsWith('.json'));

    // Get file stats and sort by modification time (newest first)
    const filesWithStats = await Promise.all(
      jsonFiles.map(async file => {
        const filePath = path.join(this.matchesDir, file);
        try {
          const stat = await fs.stat(filePath);
          return { file, filePath, mtime: stat.mtimeMs };
        } catch (err) {
          // Only ignore ENOENT (file deleted between readdir and stat - race condition)
          if (isNodeError(err) && err.code === 'ENOENT') {
            return null;
          }
          throw err;
        }
      })
    );

    const validFiles = filesWithStats
      .filter((f): f is { file: string; filePath: string; mtime: number } => f !== null)
      .sort((a, b) => b.mtime - a.mtime || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
      .slice(0, MAX_RECENT_MATCHES);

    for (const { file, filePath } of validFiles) {
      const archiveName = `matches/${file}`;
      await this.appendFileEntry(archive, manifest, filePath, archiveName);
    }
  }

  /**
   * Check if file exists and add to archive if so.
   * Uses fs.stat() pre-check for existence, then archive.file() which manages stream lifecycle.
   * Records found:false in manifest if file doesn't exist (ENOENT).
   */
  private async appendFileEntry(
    archive: archiver.Archiver,
    manifest: ExportManifest,
    filePath: string,
    archiveName: string
  ): Promise<void> {
    try {
      await fs.stat(filePath);
      // File exists - add to archive (archiver manages stream lifecycle)
      archive.file(filePath, { name: archiveName });
      manifest.files.push({ path: archiveName, found: true });
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        // File doesn't exist - record in manifest, don't add to archive
        manifest.files.push({ path: archiveName, found: false });
        return;
      }
      throw err;
    }
  }

  /**
   * Check if directory exists. Only returns false for ENOENT.
   * Throws if path exists but is not a directory (invalid state).
   */
  private async checkDirectoryExists(dirPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(dirPath);
      if (!stat.isDirectory()) {
        throw new Error(`Expected directory but found file: ${dirPath}`);
      }
      return true;
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return false;
      }
      throw err;
    }
  }
}
