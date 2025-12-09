import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import CombatLogLine from './CombatLogLine';
import { CombatLogParser } from './CombatLogParser';
import {
  MatchEventType,
  MatchStartedEvent,
  MatchEndedEvent,
  ZoneChangeEvent,
} from '../types/MatchEvent';
import { SystemMetrics } from '../types/SystemMonitoringTypes';

/**
 * Combat log watcher using fs.watch for file change detection.
 * Watches for WoW combat log files and emits match detection events.
 *
 * Key invariants:
 * - Every byte appended to the log file is processed exactly once
 * - Partial lines split across chunks are buffered and reassembled
 * - No bytes are lost even if the file grows during processing (do-while loop)
 */
export default class MatchLogWatcher extends EventEmitter {
  private readonly logDirectory: string;
  private readonly timeoutDuration: number;
  private watcher: fs.FSWatcher | null = null;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  /** Maps file path -> last processed byte position */
  private filePositions: Map<string, number> = new Map();

  /** Maps file path -> incomplete line fragment from previous chunk */
  private partialLineBuffer: Map<string, string> = new Map();

  private currentLogFile: string = '';
  private parser: CombatLogParser;

  /**
   * Per-file processing lock to prevent concurrent processing of the same file.
   * When processing completes, we re-check if the file grew and process again.
   */
  private processingFile: Map<string, boolean> = new Map();

  /** Runtime metrics for monitoring and diagnostics. */
  private metrics: SystemMetrics = {
    linesProcessed: 0,
    errorsHandled: 0,
    lastProcessingTime: 0,
  };

  constructor(logDir: string, timeoutMinutes: number = 10) {
    super();
    this.timeoutDuration = timeoutMinutes * 60 * 1000;
    this.logDirectory = this.resolveLogDirectory(logDir);
    this.parser = new CombatLogParser();
  }

  private resolveLogDirectory(logDir: string): string {
    if (!logDir) {
      const userProfile = process.env.USERPROFILE;
      if (!userProfile) {
        throw new Error('USERPROFILE environment variable not set');
      }
      return path.join(userProfile, 'Documents', 'World of Warcraft', '_retail_', 'Logs');
    }
    return path.resolve(logDir);
  }

  /**
   * Start watching for combat log changes.
   */
  public async watch(): Promise<void> {
    if (!fs.existsSync(this.logDirectory)) {
      throw new Error(`Log directory does not exist: ${this.logDirectory}`);
    }

    // Initialize positions for existing log files (baseline = current size, read nothing)
    this.initializeFilePositions();

    // Use native fs.watch for reliable event detection
    this.watcher = fs.watch(this.logDirectory, { persistent: true });

    this.watcher.on('change', (eventType, filename) => {
      if (typeof filename !== 'string') return;
      if (!filename.startsWith('WoWCombatLog')) return;

      const fullPath = path.join(this.logDirectory, filename);

      if (eventType === 'rename') {
        this.handleRenameEvent(fullPath, filename);
        return;
      }

      // Track active log file changes
      if (filename !== this.currentLogFile) {
        this.handleLogFileRotation(fullPath, filename);
      }

      // Trigger processing (will loop until caught up)
      this.triggerProcessing(fullPath);
    });

    this.watcher.on('error', (error: Error) => this.emit('error', error));

    console.info('[MatchLogWatcher] Watching directory:', this.logDirectory);
  }

  /**
   * Handle rename events (file created or deleted).
   */
  private handleRenameEvent(fullPath: string, filename: string): void {
    if (fs.existsSync(fullPath)) {
      // File created - set baseline to current size
      try {
        const stats = fs.statSync(fullPath);
        this.filePositions.set(fullPath, stats.size);
        console.info(`[MatchLogWatcher] New file baseline: ${filename} (${stats.size} bytes)`);
      } catch (error) {
        console.warn(`[MatchLogWatcher] Failed to set baseline for ${filename}:`, error);
        this.filePositions.set(fullPath, 0);
      }
    } else {
      // File deleted - clean up state
      this.filePositions.delete(fullPath);
      this.partialLineBuffer.delete(fullPath);
      this.processingFile.delete(fullPath);
      console.info(`[MatchLogWatcher] File removed: ${filename}`);
    }
  }

  /**
   * Trigger processing for a file. If already processing, the do-while loop
   * in processFileLoop will catch any new bytes.
   */
  private triggerProcessing(filePath: string): void {
    // If already processing, the loop will catch up - no action needed
    if (this.processingFile.get(filePath)) {
      return;
    }

    this.processingFile.set(filePath, true);
    this.processFileLoop(filePath);
  }

  /**
   * Process file in a loop until we've caught up to all bytes.
   * This ensures no bytes are lost even if the file grows during processing.
   */
  private async processFileLoop(filePath: string): Promise<void> {
    try {
      let processedAny: boolean;
      do {
        processedAny = await this.processNewBytes(filePath);
      } while (processedAny);
    } catch (error) {
      console.error('[MatchLogWatcher] Error processing file:', error);
      this.metrics.errorsHandled++;
      this.emit('error', error);
    } finally {
      this.processingFile.set(filePath, false);

      // Re-check after releasing lock to catch events that arrived during processing
      setImmediate(() => {
        if (!this.processingFile.get(filePath)) {
          try {
            const size = fs.statSync(filePath).size;
            const pos = this.filePositions.get(filePath) ?? 0;
            if (size > pos) {
              this.triggerProcessing(filePath);
            }
          } catch (error: unknown) {
            const err = error as NodeJS.ErrnoException;
            // ENOENT is expected when file is deleted/rotated - clean up state
            if (err && err.code === 'ENOENT') {
              this.filePositions.delete(filePath);
              this.partialLineBuffer.delete(filePath);
              this.processingFile.delete(filePath);
              return;
            }
            // Unexpected IO error - log, track, and emit
            console.error('[MatchLogWatcher] Post-processing recheck failed:', filePath, error);
            this.metrics.errorsHandled++;
            this.emit('error', error);
          }
        }
      });
    }
  }

  /**
   * Process any new bytes in the file. Returns true if bytes were processed.
   * Uses fs.promises API for async file operations.
   */
  private async processNewBytes(filePath: string): Promise<boolean> {
    const startTime = Date.now();

    // Get current file size
    let currentSize: number;
    try {
      const stats = await fs.promises.stat(filePath);
      currentSize = stats.size;
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      // ENOENT is expected when file is deleted/rotated - clean up and return
      if (err && err.code === 'ENOENT') {
        this.filePositions.delete(filePath);
        this.partialLineBuffer.delete(filePath);
        return false;
      }
      // Unexpected IO error - log, track, and emit
      console.error('[MatchLogWatcher] Failed to stat file:', filePath, error);
      this.metrics.errorsHandled++;
      this.emit('error', error);
      return false;
    }

    const lastPosition = this.filePositions.get(filePath) ?? 0;
    const bytesToRead = currentSize - lastPosition;

    if (bytesToRead <= 0) return false;

    // Memory safety check
    if (bytesToRead > 100 * 1024 * 1024) {
      throw new Error(`Chunk too large: ${bytesToRead} bytes`);
    }

    // Read the bytes using fs.promises FileHandle API
    let fileHandle: fs.promises.FileHandle | null = null;
    try {
      fileHandle = await fs.promises.open(filePath, 'r');
      const buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, lastPosition);

      // Convert to string and prepend any partial line from previous chunk
      let content = buffer.subarray(0, bytesRead).toString('utf-8');
      const partial = this.partialLineBuffer.get(filePath);
      if (partial) {
        content = partial + content;
        this.partialLineBuffer.delete(filePath);
      }

      // Split into lines - last element may be incomplete
      const lines = content.split('\n');
      const lastLine = lines.pop();

      // Store incomplete line for next chunk
      if (lastLine && lastLine.length > 0) {
        this.partialLineBuffer.set(filePath, lastLine);
      }

      // Process complete lines
      const completeLines = lines.map(line => line.trim()).filter(line => line.length > 0);

      if (completeLines.length > 0) {
        this.processLines(completeLines);
        this.resetInactivityTimeout();
      }

      // Update position
      this.filePositions.set(filePath, lastPosition + bytesRead);
      this.metrics.lastProcessingTime = Date.now() - startTime;

      return bytesRead > 0;
    } finally {
      if (fileHandle) {
        await fileHandle.close();
      }
    }
  }

  /**
   * Handle log file rotation (WoW creates new log file).
   */
  private handleLogFileRotation(newFilePath: string, newFilename: string): void {
    const previousFile = this.currentLogFile;
    console.info('[MatchLogWatcher] Log file rotation:', previousFile, '->', newFilename);

    const metadataSnapshot = this.parser.buildMatchMetadata();
    this.parser.reset();
    this.currentLogFile = newFilename;

    if (previousFile) {
      this.emit('logFileChanged', {
        previousFilePath: path.join(this.logDirectory, previousFile),
        currentFilePath: newFilePath,
        timestamp: new Date(),
        metadataSnapshot,
      });
    }
  }

  /**
   * Initialize file positions to current sizes (don't read historical data).
   * Also sets currentLogFile to the most recently modified log.
   */
  private initializeFilePositions(): void {
    try {
      const files = fs.readdirSync(this.logDirectory);
      let newestFile: { name: string; mtime: number } | null = null;

      for (const file of files) {
        if (file.startsWith('WoWCombatLog') && file.endsWith('.txt')) {
          const fullPath = path.join(this.logDirectory, file);
          const stats = fs.statSync(fullPath);
          this.filePositions.set(fullPath, stats.size);

          // Track newest file by mtime
          if (!newestFile || stats.mtimeMs > newestFile.mtime) {
            newestFile = { name: file, mtime: stats.mtimeMs };
          }
        }
      }

      // Set current log file to newest on startup
      if (newestFile) {
        this.currentLogFile = newestFile.name;
      }
    } catch (error) {
      console.warn('[MatchLogWatcher] Failed to initialize file positions:', error);
    }
  }

  public async unwatch(): Promise<void> {
    this.clearInactivityTimeout();
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    console.info('[MatchLogWatcher] Stopped watching');
  }

  public cleanup(): void {
    console.info('[MatchLogWatcher] Cleaning up...');
    this.unwatch();
    this.filePositions.clear();
    this.partialLineBuffer.clear();
    this.processingFile.clear();
    this.currentLogFile = '';
    this.parser.reset();
    this.metrics = { linesProcessed: 0, errorsHandled: 0, lastProcessingTime: 0 };
    this.removeAllListeners();
    console.info('[MatchLogWatcher] Cleanup complete');
  }

  /**
   * Process parsed lines, emit events, and batch for logChunk.
   */
  private processLines(lines: string[]): void {
    const chunkLines: Array<{ line: string; timestamp: Date }> = [];

    for (const line of lines) {
      let timestamp: Date;

      try {
        const logLine = new CombatLogLine(line);
        timestamp = logLine.getTimestamp();

        const matchEvent = this.parser.parseLogLine(line);
        if (matchEvent) {
          this.emitMatchEvent(matchEvent);
        }

        this.metrics.linesProcessed++;
      } catch (error) {
        this.handleParseError(line, error);
        timestamp = new Date();
      }

      chunkLines.push({ line, timestamp });
    }

    if (chunkLines.length > 0) {
      this.emit('logChunk', chunkLines);
    }
  }

  private emitMatchEvent(event: MatchStartedEvent | MatchEndedEvent | ZoneChangeEvent): void {
    switch (event.type) {
      case MatchEventType.MATCH_STARTED:
        console.info('[MatchLogWatcher] Match started:', {
          zoneId: (event as MatchStartedEvent).zoneId,
          bufferId: (event as MatchStartedEvent).bufferId,
        });
        this.emit('matchStarted', event);
        break;

      case MatchEventType.ZONE_CHANGE: {
        // Attach metadata snapshot for kill-aware early-end handling
        const snapshot = this.parser.buildMatchMetadata();
        if (snapshot) {
          (event as ZoneChangeEvent).metadataSnapshot = snapshot;
        }
        console.info('[MatchLogWatcher] Zone change:', {
          zoneId: (event as ZoneChangeEvent).zoneId,
          zoneName: (event as ZoneChangeEvent).zoneName,
        });
        this.emit('zoneChange', event);
        break;
      }

      case MatchEventType.MATCH_ENDED:
        console.info('[MatchLogWatcher] Match ended:', {
          bufferId: (event as MatchEndedEvent).bufferId,
        });
        this.emit('matchEnded', event);
        break;
    }
  }

  private handleParseError(line: string, error: unknown): void {
    this.metrics.errorsHandled++;
    console.warn('[MatchLogWatcher] Parse error:', line.substring(0, 50), error);

    if (this.metrics.errorsHandled % 50 === 0) {
      this.emit('warning', {
        message: 'Multiple parse errors',
        count: this.metrics.errorsHandled,
      });
    }
  }

  private resetInactivityTimeout(): void {
    this.clearInactivityTimeout();
    this.timeoutHandle = setTimeout(() => {
      this.emit('timeout', this.timeoutDuration);
    }, this.timeoutDuration);
  }

  private clearInactivityTimeout(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }

  public handleLogLine(line: string): void {
    this.processLines([line]);
  }

  public processChunkSynchronously(lines: string[]): void {
    this.processLines(lines);
  }

  public getCurrentMatch(): { bracket: string; timestamp: Date } | null {
    return this.parser.getCurrentMatch();
  }

  /**
   * Clear parser's current match context without full reset.
   * Called when a match ends via early-end triggers where no ARENA_MATCH_END is received.
   */
  public clearCurrentMatch(): void {
    this.parser.clearCurrentMatch();
  }

  public getSystemMetrics(): SystemMetrics {
    const mem = process.memoryUsage();
    return {
      ...this.metrics,
      memoryUsage: {
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        rss: Math.round(mem.rss / 1024 / 1024),
      },
    };
  }
}
