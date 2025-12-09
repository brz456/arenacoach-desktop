import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import path from 'path';
import { MatchStartedEvent, MatchEndedEvent, ZoneChangeEvent } from '../types/MatchEvent';
import { MatchBuffer } from '../types/MatchTypes';
import { MatchMetadata } from '../types/MatchMetadata';
import { MatchResolver } from './MatchResolver';
import { EarlyEndTrigger } from '../types/EarlyEndTriggers';

/**
 * Configuration options for MatchChunker
 */
export interface MatchChunkerOptions {
  outputDir: string;
  minMatchLines?: number;
  maxMatchLines?: number;
  allowedOutputRoots?: string[];
}

/**
 * Streaming combat log chunker that extracts individual matches from continuous logs.
 */
export default class MatchChunker extends EventEmitter {
  private activeMatches = new Map<string, MatchBuffer>();
  private pendingEndEvents = new Map<string, MatchEndedEvent>();
  private currentArenaZoneId: number | null = null; // Track current arena zone for zone change logic
  private outputDir: string;
  private readonly COMBAT_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes - long timeout to avoid false DATA_TIMEOUT on slow fs.flush
  private readonly MIN_MATCH_LINES: number;
  private readonly MAX_MATCH_LINES: number;
  private matchResolver: MatchResolver;

  // Combat log header extraction (SSoT from source files)
  private combatLogHeader: string | null = null;

  constructor(options: MatchChunkerOptions) {
    super();

    /**
     * Combat Inactivity Timeout
     *
     * - Single 30-minute timeout resets on any combat log activity
     * - Only ends matches that have been truly idle (no combat activity)
     * - Never kills legitimate in-progress match detection
     * - Graceful finalization with chunk extraction for completed matches
     */
    this.MIN_MATCH_LINES = options.minMatchLines ?? 20;
    this.MAX_MATCH_LINES = options.maxMatchLines ?? 200000; // 200k line safety limit

    // Validate and sanitize output directory
    this.outputDir = this.validateOutputDirectory(options.outputDir, options.allowedOutputRoots);

    // Initialize match resolver
    this.matchResolver = new MatchResolver(this.activeMatches);

    // Note: Directory creation now handled in async init() method
  }

  /**
   * Initialize the MatchChunker by ensuring the output directory exists.
   * Must be called before processing any log lines.
   */
  public async init(): Promise<void> {
    await this.ensureOutputDirectory();
  }

  /**
   * Validate and sanitize output directory to prevent path injection attacks
   */
  private validateOutputDirectory(outputDir: string, allowedRoots?: string[]): string {
    // Convert to absolute path to prevent relative path attacks
    const absoluteOutputDir = path.resolve(outputDir);

    // Basic security validation
    if (outputDir.includes('\x00')) {
      throw new Error(`Security violation: Directory path contains null bytes: ${outputDir}`);
    }
    if (outputDir.includes('..') || outputDir.includes('~')) {
      throw new Error(
        `Security violation: Directory path contains dangerous patterns: ${outputDir}`
      );
    }

    // Optional: Validate against allowed root directories
    if (allowedRoots && allowedRoots.length > 0) {
      const isAllowed = allowedRoots.some(root => {
        const absoluteRoot = path.resolve(root);
        return absoluteOutputDir.startsWith(absoluteRoot);
      });

      if (!isAllowed) {
        throw new Error(
          `Security violation: Output directory '${absoluteOutputDir}' is outside allowed roots`
        );
      }
    }

    console.info('[MatchChunker] Validated output directory:', absoluteOutputDir);
    return absoluteOutputDir;
  }

  /**
   * Handle match started event from MatchLogWatcher
   */
  public onMatchStarted(matchEvent: MatchStartedEvent): void {
    const bufferId = matchEvent.bufferId;

    // Validate bufferId before processing
    if (!bufferId || typeof bufferId !== 'string' || bufferId.trim().length === 0) {
      console.error('[MatchChunker] Invalid bufferId in match started event:', {
        bufferId,
        matchEvent,
      });
      return;
    }

    // Check for duplicate bufferId (e.g., /reload in 2v2/3v3)
    if (this.activeMatches.has(bufferId)) {
      console.warn(
        `[MatchChunker] Duplicate onMatchStarted for bufferId ${bufferId} - ignoring (lifecycle will handle)`
      );
      return;
    }

    // End any OTHER active matches before starting a new one
    // This handles cases like: 3v3 starts → Solo Shuffle starts (3v3 never got ARENA_MATCH_END)
    if (this.activeMatches.size > 0) {
      const staleBufferIds = Array.from(this.activeMatches.keys()).filter(id => id !== bufferId);
      if (staleBufferIds.length > 0) {
        console.warn(
          '[MatchChunker] New match starting while other matches active - ending stale matches:',
          {
            newBufferId: bufferId,
            staleBufferIds,
          }
        );
        for (const staleId of staleBufferIds) {
          this.handleGracefulEndingByBufferId(staleId, EarlyEndTrigger.NEW_MATCH_START);
        }
      }
    }

    // Buffer is now active (tracked in activeMatches map)

    // Track current arena zone ID for zone change logic
    this.currentArenaZoneId = matchEvent.zoneId;

    // Create new match buffer with single inactivity timer
    const matchBuffer: MatchBuffer = {
      startTime: matchEvent.timestamp.getTime(),
      rawLines: [],
      inactivityTimer: null,
    };

    // Set single inactivity timer (resets on any combat activity)
    this.setInactivityTimer(bufferId, matchBuffer);

    this.activeMatches.set(bufferId, matchBuffer);

    console.info('[MatchChunker] Started buffering match with inactivity timeout:', {
      bufferId,
      zoneId: matchEvent.zoneId,
      timestamp: matchEvent.timestamp,
      bracket: matchEvent.bracket,
      inactivityTimeoutMs: this.COMBAT_INACTIVITY_TIMEOUT_MS,
    });
  }

  /**
   * Set or reset inactivity timer for a specific buffer
   * Timer fires only when no combat activity for the configured inactivity timeout
   */
  private setInactivityTimer(bufferId: string, matchBuffer: MatchBuffer): void {
    // Clear existing timer
    if (matchBuffer.inactivityTimer) {
      clearTimeout(matchBuffer.inactivityTimer);
    }

    // Set new timer
    matchBuffer.inactivityTimer = setTimeout(() => {
      this.handleCombatInactivity(bufferId);
    }, this.COMBAT_INACTIVITY_TIMEOUT_MS);
  }

  /**
   * Handle combat inactivity timeout (reference implementation pattern)
   * Gracefully ends matches that have been idle, never kills in-progress detection
   */
  private handleCombatInactivity(bufferId: string): void {
    const matchBuffer = this.activeMatches.get(bufferId);
    if (!matchBuffer) return;

    console.info(
      `[MatchChunker] Combat inactivity detected for ${bufferId} (inactivity timeout reached)`
    );

    // Unconditionally route through handleGracefulEnding so incomplete is always emitted
    this.handleGracefulEnding(bufferId, matchBuffer, EarlyEndTrigger.DATA_TIMEOUT);
  }

  /**
   * Gracefully clean up buffer without chunk creation
   */
  private gracefullyCleanupBuffer(bufferId: string, matchBuffer: MatchBuffer): void {
    // Clear timer
    if (matchBuffer.inactivityTimer) {
      clearTimeout(matchBuffer.inactivityTimer);
    }

    // Clear any pending end event for this buffer to prevent leaks
    this.pendingEndEvents.delete(bufferId);

    // Remove buffer
    this.activeMatches.delete(bufferId);

    console.info(`[MatchChunker] Gracefully cleaned up buffer: ${bufferId}`);
  }

  /**
   * Handle match ended event from MatchLogWatcher
   * Records pending end-event for finalization after next addLogChunk
   */
  public onMatchEnded(matchEvent: MatchEndedEvent): void {
    // Validate bufferId before processing
    if (
      !matchEvent.bufferId ||
      typeof matchEvent.bufferId !== 'string' ||
      matchEvent.bufferId.trim().length === 0
    ) {
      console.error('[MatchChunker] Invalid bufferId in match ended event:', {
        bufferId: matchEvent.bufferId,
        matchEvent,
      });
      return;
    }

    // Resolve match using bufferId lookup
    const resolution = this.matchResolver.resolveMatch(matchEvent);

    if (!resolution.success) {
      console.warn(`[MatchChunker] ${resolution.reason}`);
      return;
    }

    const { bufferId, matchBuffer } = resolution;

    // Check if match buffer exists
    if (!this.activeMatches.has(bufferId)) {
      console.warn(`[MatchChunker] No active buffer found for ${bufferId}`);
      return;
    }

    // Clear inactivity timer
    if (matchBuffer.inactivityTimer) {
      clearTimeout(matchBuffer.inactivityTimer);
    }

    // Record pending end-event for finalization after chunk processing
    this.pendingEndEvents.set(bufferId, matchEvent);

    console.info('[MatchChunker] Recorded pending match end event for buffer:', {
      bufferId,
      lines: matchBuffer.rawLines.length,
    });
  }

  /**
   * Add a chunk of raw combat log lines to active match buffers atomically.
   * This ensures all lines from a file chunk are processed together.
   * CRITICAL: Only adds lines that occurred at or after the match start time.
   */
  public addLogChunk(lines: Array<{ line: string; timestamp: Date }>): void {
    // Extract combat log header from source files (SSoT approach)
    this.extractCombatLogHeader(lines);

    // Process chunk atomically - all lines added together
    // Create snapshot to avoid concurrent modification during iteration
    const activeMatchesSnapshot = new Map(this.activeMatches);
    activeMatchesSnapshot.forEach((buffer, bufferId) => {
      // Filter lines to only include those at or after match start time
      const relevantLines = lines.filter(
        lineData => lineData.timestamp.getTime() >= buffer.startTime
      );

      if (relevantLines.length === 0) {
        return; // No relevant lines for this match
      }

      // Check if adding this chunk would exceed maximum size
      const totalLines = buffer.rawLines.length + relevantLines.length;
      if (totalLines >= this.MAX_MATCH_LINES) {
        console.warn(
          `[MatchChunker] Match buffer for ${bufferId} would exceed ${this.MAX_MATCH_LINES} lines after chunk. Force finalizing.`
        );

        // Clear pending end event to prevent orphaned entries
        this.pendingEndEvents.delete(bufferId);

        // Clear inactivity timer to prevent memory exhaustion
        if (buffer.inactivityTimer) {
          clearTimeout(buffer.inactivityTimer);
        }

        buffer.endTime = Date.now();
        buffer.timedOut = true;

        // Branch based on metadata presence to maintain SSoT correctness
        if (buffer.metadata) {
          // Match has metadata - proceed with normal finalization
          this.finalizeMatch(bufferId, buffer).catch(error => {
            console.error(
              `[MatchChunker] Error force-finalizing oversized match ${bufferId}:`,
              error
            );
            this.emit('error', {
              message: 'Failed to finalize oversized match',
              bufferId: bufferId,
              error: (error as Error).message,
            });
          });
        } else {
          // No metadata yet - treat as early end to ensure proper terminal state
          console.warn(
            `[MatchChunker] Oversized match ${bufferId} has no metadata - handling as early end`
          );
          this.handleGracefulEndingByBufferId(bufferId, EarlyEndTrigger.FORCE_END);
        }
        return; // Skip adding this chunk to the oversized buffer
      }

      // Add only relevant lines (at or after match start) from chunk atomically
      relevantLines.forEach(lineData => {
        buffer.rawLines.push(lineData.line);
      });

      // CRITICAL: Reset timeout on combat activity
      if (relevantLines.length > 0) {
        this.resetTimeoutOnActivity(bufferId, buffer);
      }

      // Check for pending end event and finalize after chunk lines are attached
      const pendingEnd = this.pendingEndEvents.get(bufferId);
      if (pendingEnd) {
        this.pendingEndEvents.delete(bufferId);
        this.finalizeBufferFromMatchEnd(bufferId, buffer, pendingEnd);
      }
    });
  }

  /**
   * Add a single raw combat log line (legacy method for backward compatibility).
   * New code should use addLogChunk for better performance and synchronization.
   */
  public addLogLine(line: string, timestamp: Date): void {
    // Convert single line to chunk format for consistency
    this.addLogChunk([{ line, timestamp }]);
  }

  /**
   * Reset inactivity timer when combat activity occurs (reference implementation pattern)
   */
  private resetTimeoutOnActivity(bufferId: string, buffer: MatchBuffer): void {
    // Reset inactivity timer for this specific buffer
    this.setInactivityTimer(bufferId, buffer);
  }

  /**
   * Determine if a match should be treated as an instant cancellation candidate.
   * Policy: any match with fewer than MIN_MATCH_LINES is cancelled.
   * Rationale: real arena matches produce substantial combat log output;
   * matches below this threshold are synthetic test artifacts or corrupted logs.
   */
  private isInstantCancellationCandidate(buffer: MatchBuffer): boolean {
    // If we have enough lines, not a cancellation candidate
    return buffer.rawLines.length < this.MIN_MATCH_LINES;
  }

  /**
   * Finalize a match buffer after chunk lines have been attached.
   * Called from addLogChunk when a pending end event exists.
   * Handles instant cancellation or normal finalization.
   */
  private finalizeBufferFromMatchEnd(
    bufferId: string,
    matchBuffer: MatchBuffer,
    matchEvent: MatchEndedEvent
  ): void {
    // Set end time and metadata from the end event
    matchBuffer.endTime = matchEvent.timestamp.getTime();
    matchBuffer.metadata = matchEvent.metadata;

    // Deterministic instant match cancellation based on buffer content
    if (this.isInstantCancellationCandidate(matchBuffer)) {
      console.info('[MatchChunker] Instant cancellation candidate detected:', {
        bufferId,
        lines: matchBuffer.rawLines.length,
        bracket: matchEvent.metadata.bracket,
        hasPlayerId: !!matchEvent.metadata.playerId,
      });
      this.handleGracefulEnding(bufferId, matchBuffer, EarlyEndTrigger.CANCEL_INSTANT_MATCH);
      return;
    }

    // Normal finalization path for complete matches
    this.finalizeMatch(bufferId, matchBuffer);
  }

  /**
   * Decide whether to extract chunk based on ending trigger and buffer state
   * Policy-driven decisions for clean future extensibility
   */
  private shouldExtractChunk(trigger: EarlyEndTrigger, buffer: MatchBuffer): boolean {
    // Simple policy: never extract on early ends (cleanup only)
    return false;

    // Future policy for when we want to save meaningful timeouts/force-ends:
    // if (trigger === EarlyEndTrigger.DATA_TIMEOUT || trigger === EarlyEndTrigger.FORCE_END) {
    //   return buffer.rawLines.length >= this.MIN_MATCH_LINES;
    // }
    // return false;
  }

  /**
   * Handle graceful ending for all early ending scenarios
   * Always emit matchEndedIncomplete regardless of metadata state
   * Uses trigger-based policy for chunk extraction decisions
   */
  private handleGracefulEnding(
    bufferId: string,
    matchBuffer: MatchBuffer,
    trigger: EarlyEndTrigger
  ): void {
    console.info(`[MatchChunker] Graceful ending for ${bufferId} (trigger: ${trigger})`);

    // Clear inactivity timer
    if (matchBuffer.inactivityTimer) {
      clearTimeout(matchBuffer.inactivityTimer);
    }

    // Mark as ended
    matchBuffer.endTime = Date.now();
    matchBuffer.timedOut = true;
    matchBuffer.earlyEndingTrigger = trigger;

    // Always emit matchEndedIncomplete for early endings (architectural requirement)
    this.emit('matchEndedIncomplete', {
      bufferId,
      trigger,
      lines: matchBuffer.rawLines.length,
      buffer: matchBuffer,
    });

    // Use trigger-based policy for chunk extraction decisions
    if (this.shouldExtractChunk(trigger, matchBuffer)) {
      console.info(
        `[MatchChunker] Extracting chunk for early end: ${bufferId} (trigger: ${trigger})`
      );
      this.finalizeMatch(bufferId, matchBuffer);
    } else {
      console.info(`[MatchChunker] Clean up without chunk: ${bufferId} (trigger: ${trigger})`);
      this.gracefullyCleanupBuffer(bufferId, matchBuffer);
    }
  }

  /**
   * Handle graceful ending by bufferId (wrapper for external calls)
   */
  private handleGracefulEndingByBufferId(bufferId: string, trigger: EarlyEndTrigger): void {
    const matchBuffer = this.activeMatches.get(bufferId);
    if (!matchBuffer) return;

    this.handleGracefulEnding(bufferId, matchBuffer, trigger);
  }

  /**
   * Finalize match and create output file
   */
  private async finalizeMatch(bufferId: string, matchBuffer: MatchBuffer): Promise<void> {
    try {
      const filename = this.generateMatchFilename(bufferId);
      const filePath = path.join(this.outputDir, filename);

      // Create combat log header (extracted from source files)
      const header = this.createCombatLogHeader(matchBuffer);
      const content = header
        ? [header, ...matchBuffer.rawLines].join('\n')
        : matchBuffer.rawLines.join('\n');

      // Write match file (async for non-blocking I/O)
      await fs.writeFile(filePath, content, 'utf-8');

      const matchInfo = {
        bufferId,
        filename,
        lines: matchBuffer.rawLines.length,
        size: content.length,
        timedOut: matchBuffer.timedOut,
      };

      console.info('[MatchChunker] Match file created:', matchInfo);

      // Emit match extracted event
      this.emit('matchExtracted', {
        filePath,
        matchInfo,
        buffer: matchBuffer,
      });
    } catch (error) {
      // Error logging moved to emit event only for consistency
      this.emit('error', {
        message: 'Failed to finalize match',
        bufferId,
        error: (error as Error).message,
      });
    } finally {
      // Always clean up the match from active maps, regardless of success/failure
      this.activeMatches.delete(bufferId);
      this.pendingEndEvents.delete(bufferId);

      // Reset current arena zone if no active matches remain
      if (this.activeMatches.size === 0) {
        this.currentArenaZoneId = null;
      }
    }
  }

  /**
   * Generate match filename using bufferId for stable correlation throughout lifecycle
   * Uses bufferId for consistent naming throughout lifecycle
   * Format: <bufferId>.txt (bufferId provides stable identifier from match start to end)
   */
  private generateMatchFilename(bufferId: string): string {
    return `${bufferId}.txt`;
  }

  /**
   * Extract combat log header from incoming lines (SSoT from source files)
   * Header format: timestamp  COMBAT_LOG_VERSION,X,ADVANCED_LOG_ENABLED,1,BUILD_VERSION,X.X.X,PROJECT_ID,1
   */
  private extractCombatLogHeader(lines: Array<{ line: string; timestamp: Date }>): void {
    for (const lineData of lines) {
      const line = lineData.line.trim();

      // Detect combat log header pattern
      if (
        line.includes('COMBAT_LOG_VERSION') &&
        line.includes('BUILD_VERSION') &&
        line.includes('PROJECT_ID')
      ) {
        this.combatLogHeader = line;
        console.debug('[MatchChunker] Extracted combat log header from source:', line);
        break; // Use first header found
      }
    }
  }

  /**
   * Create combat log header using extracted header from source files
   * No fallback - if no header extracted, returns empty string
   */
  private createCombatLogHeader(_matchBuffer: MatchBuffer): string {
    // Use extracted header from source files (SSoT approach)
    if (this.combatLogHeader) {
      return this.combatLogHeader;
    }

    // No fallback - if we don't have a header from source, don't generate one
    console.warn(
      '[MatchChunker] No header extracted from source files - chunked file will have no header'
    );
    return '';
  }

  /**
   * Ensure output directory exists (async)
   */
  private async ensureOutputDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.outputDir, { recursive: true });
      console.info('[MatchChunker] Created output directory:', this.outputDir);
    } catch (error: any) {
      // mkdir throws an error if the directory exists but is not a directory
      // We can ignore 'EEXIST' which is common and expected
      if (error.code === 'EEXIST') {
        // If the path already exists, verify it's a directory
        try {
          const stats = await fs.stat(this.outputDir);
          if (!stats.isDirectory()) {
            throw new Error(`Output path '${this.outputDir}' exists but is not a directory.`);
          }
          // Path exists and is a directory - this is fine
        } catch (statError) {
          this.emit('error', {
            message: 'Failed to verify output directory',
            error: (statError as Error).message,
          });
          throw statError;
        }
      } else if (error.code === 'EACCES') {
        throw new Error(
          `Permission denied: Cannot create output directory '${this.outputDir}'. Check file permissions.`
        );
      } else if (error.code === 'ENOTDIR') {
        throw new Error(`Invalid path: Part of the path '${this.outputDir}' is not a directory.`);
      } else {
        this.emit('error', {
          message: 'Failed to create output directory',
          error: (error as Error).message,
        });
        throw error;
      }
    }
  }

  /**
   * Get active match count for monitoring
   */
  public getActiveMatchCount(): number {
    return this.activeMatches.size;
  }

  /**
   * Force end all active matches (for cleanup) - now async
   */
  public async forceEndAllMatches(): Promise<void> {
    console.info('[MatchChunker] Force ending all active matches');

    const finalizationPromises: Promise<void>[] = [];

    // Create snapshot to avoid concurrent modification during iteration
    const activeMatchesSnapshot = new Map(this.activeMatches);
    activeMatchesSnapshot.forEach((buffer, bufferId) => {
      // Clear inactivity timer
      if (buffer.inactivityTimer) {
        clearTimeout(buffer.inactivityTimer);
      }

      if (buffer.rawLines.length >= this.MIN_MATCH_LINES) {
        buffer.endTime = Date.now();
        buffer.timedOut = true;
        buffer.earlyEndingTrigger = EarlyEndTrigger.FORCE_END;

        // Defensive programming: Only finalize if metadata is present
        if (buffer.metadata) {
          finalizationPromises.push(this.finalizeMatch(bufferId, buffer));
        } else {
          // Use consistent early ending pattern for proper event emission and metadata handling
          this.handleGracefulEndingByBufferId(bufferId, EarlyEndTrigger.FORCE_END);
        }
      }
    });

    // Wait for all matches to be finalized
    await Promise.all(finalizationPromises);
    this.activeMatches.clear();
    this.currentArenaZoneId = null; // Reset zone tracking

    console.info('[MatchChunker] Force ended all active matches');
  }

  /**
   * Clean up all resources and listeners
   */
  public cleanup(): void {
    console.info('[MatchChunker] Cleaning up resources...');

    // Clear all inactivity timers first
    this.activeMatches.forEach(buffer => {
      if (buffer.inactivityTimer) {
        clearTimeout(buffer.inactivityTimer);
      }
    });

    // Clear active matches maps and pending end events
    this.activeMatches.clear();
    this.pendingEndEvents.clear();
    this.currentArenaZoneId = null; // Reset zone tracking

    // Reset header extraction state
    this.combatLogHeader = null;

    // Remove all event listeners
    this.removeAllListeners();

    console.info('[MatchChunker] Cleanup complete');
  }

  /**
   * Handle zone change events for early ending detection
   * Centralized zone change logic - single source of truth for ending decisions
   * Only ignore same arena transitions, end everything else
   */
  public onZoneChange(event: ZoneChangeEvent): void {
    console.debug('[MatchChunker] Processing zone change:', {
      zoneId: event.zoneId,
      zoneName: event.zoneName,
      currentArenaZoneId: this.currentArenaZoneId,
      timestamp: event.timestamp,
    });

    // Only process if we have active matches
    if (this.activeMatches.size === 0) {
      console.debug('[MatchChunker] Zone change ignored - no active matches');
      return;
    }

    // Implement zone change logic:
    // - Same arena zone (zoneId === currentArenaZoneId) → no action
    // - Any other zone change → end match
    if (event.zoneId === this.currentArenaZoneId) {
      console.debug('[MatchChunker] Zone change within same arena - no action taken:', {
        arenaZoneId: event.zoneId,
        arenaZoneName: event.zoneName,
      });
    } else {
      console.info('[MatchChunker] Zone change detected - ending match:', {
        fromZoneId: this.currentArenaZoneId,
        toZoneId: event.zoneId,
        toZoneName: event.zoneName,
        activeMatches: this.activeMatches.size,
      });

      // Trigger early ending for all active matches with metadata snapshot for kill-aware handling
      this.triggerEarlyEnding(EarlyEndTrigger.ZONE_CHANGE, event.metadataSnapshot);
    }
  }

  /**
   * Public method for MatchDetectionOrchestrator to trigger early ending.
   * Accepts optional metadata snapshot from parser for enrichment.
   */
  public triggerEarlyEnding(
    trigger: EarlyEndTrigger,
    metadataSnapshot?: MatchMetadata | null
  ): void {
    console.info(
      `[MatchChunker] Triggering early ending for all active matches (trigger: ${trigger}, hasMetadata: ${!!metadataSnapshot})`
    );

    // Create snapshot to avoid concurrent modification
    const activeBufferIds = Array.from(this.activeMatches.keys());

    activeBufferIds.forEach(bufferId => {
      const buffer = this.activeMatches.get(bufferId);
      if (buffer && metadataSnapshot) {
        // Attach metadata snapshot to buffer for lifecycle enrichment
        buffer.metadata = metadataSnapshot;
      }
      this.handleGracefulEndingByBufferId(bufferId, trigger);
    });
  }
}
