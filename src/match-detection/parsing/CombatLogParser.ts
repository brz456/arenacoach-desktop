import CombatLogLine from './CombatLogLine';
import {
  MatchEvent,
  MatchEventType,
  ArenaBracket,
  MatchStartedEvent,
  ZoneChangeEvent,
} from '../types/MatchEvent';
import { MatchMetadata, PlayerMetadata, ShuffleRoundSummary } from '../types/MatchMetadata';
import { getClassIdFromSpec } from '../constants/specToClass';
import {
  parseBracketFromArenaType,
  formatBracket,
  isSoloShuffleBracket,
} from '../utils/BracketUtils';
import { ShuffleRoundTracker } from './ShuffleRoundTracker';
import { extractDeathEvent } from '../utils/DeathEventUtils';

/**
 * Current match context needed for parsing match end events
 */
export interface MatchContext {
  startTime?: Date;
  bracket?: ArenaBracket;
  zoneId?: number;
  bufferId?: string;
  seasonId?: number;
  isRanked?: boolean;
}

/**
 * Combat log parser responsible for extracting match events from WoW combat log lines.
 * Handles arena match detection, Solo Shuffle tracking, and match event creation.
 * Separated from file watching logic for clean separation of concerns.
 */
export class CombatLogParser {
  // Current match tracking for match end correlation
  private currentMatch: MatchContext | null = null;

  // Solo Shuffle round tracking (enhanced)
  private shuffleTracker = new ShuffleRoundTracker();

  // Match metadata extraction
  private readonly MAX_BUFFERED_LINES = 20000; // Large buffer for edge cases
  private combatants: Map<string, PlayerMetadata> = new Map();
  private matchLines: string[] = []; // Buffer for player identification
  private playerId: string | null = null;
  private warnedBufferLimit = false;
  private loggedPlayerFound = false;
  private team0MMR: number = 0;
  private team1MMR: number = 0;

  // Kill tracking for non-shuffle matches (2v2/3v3)
  private playerDeathCount: number = 0;

  /**
   * Parse a combat log line and extract match events if present.
   * Returns null if the line doesn't contain a match event.
   */
  public parseLogLine(line: string): MatchEvent | null {
    try {
      const logLine = new CombatLogLine(line);
      const eventType = logLine.getEventType();

      // Buffer lines during active match for player identification
      if (this.currentMatch) {
        // Check if we already have all required data
        let isComplete = this.hasAllRequiredData();

        if (!isComplete) {
          // Continue scanning until we have player ID + enough names
          if (!this.playerId) {
            this.playerId = this.tryIdentifyPlayerFromLine(line);
          } else {
            // Player found - only enrich names from ongoing events (no buffering)
            this.enrichCombatantsFromLogLine(logLine);
          }

          // Re-check completion after processing this line
          isComplete = this.hasAllRequiredData();
          if (isComplete && !this.loggedPlayerFound) {
            const playersWithNames = this.getPlayersWithNames();
            const totalPlayers = this.combatants.size;
            console.debug(
              `[CombatLogParser] Scanning complete: Player found + ALL names extracted (${playersWithNames}/${totalPlayers}) at ${this.matchLines.length} lines`
            );
            this.loggedPlayerFound = true;
          }

          // Only buffer if we still need more data
          if (!isComplete) {
            if (this.matchLines.length < this.MAX_BUFFERED_LINES) {
              this.matchLines.push(line);
            } else if (!this.warnedBufferLimit) {
              console.warn(
                '[CombatLogParser] Match line buffer limit reached. Player identification may fail.'
              );
              this.warnedBufferLimit = true;
            }
          }
        }
      }

      if (eventType === 'ARENA_MATCH_START') {
        const arenaType = logLine.getField(3);

        // Parse bracket once using centralized utility
        const bracketInfo = parseBracketFromArenaType(arenaType);
        if (!bracketInfo) {
          console.warn('[CombatLogParser] Unknown arena type:', arenaType);
          return null;
        }
        const { bracket } = bracketInfo;

        // Create match event with pre-parsed bracket info
        const matchEvent = this.createMatchStartEvent(logLine, bracketInfo);
        if (matchEvent) {
          // Update current match context only if this is a new session:
          // - Solo Shuffle ALWAYS starts a new session (creates new bufferId via shuffleTracker)
          // - Non-shuffle starts new session only if no currentMatch exists
          // This ensures currentMatch stays in sync with shuffleTracker for shuffle matches,
          // even when a prior non-shuffle match was orphaned (no ARENA_MATCH_END received).
          const isNewSession =
            isSoloShuffleBracket(bracket) || !this.currentMatch || !this.currentMatch.bufferId;
          if (isNewSession) {
            this.updateCurrentMatch(
              matchEvent as MatchStartedEvent,
              parseInt(logLine.getField(2), 10),
              (matchEvent as MatchStartedEvent).isRanked || false,
              bracket
            );
            // Clear previous match data
            this.combatants.clear();
            this.matchLines = [line]; // Start buffering with the start event
            this.playerId = null;
            this.warnedBufferLimit = false;
            this.loggedPlayerFound = false;
            this.team0MMR = 0;
            this.team1MMR = 0;
            this.playerDeathCount = 0;
          }
        }
        return matchEvent;
      } else if (eventType === 'ARENA_MATCH_END') {
        const matchEvent = this.createMatchEndEvent(logLine);

        // Always clear state after match end, regardless of whether we emit an event
        // This ensures future matches can be detected properly
        this.currentMatch = null;
        this.matchLines = [];
        this.combatants.clear();
        this.playerId = null;
        this.warnedBufferLimit = false;
        this.loggedPlayerFound = false;
        this.team0MMR = 0;
        this.team1MMR = 0;
        this.playerDeathCount = 0;

        return matchEvent;
      } else if (eventType === 'COMBATANT_INFO') {
        // Parse combatant information for metadata
        this.parseCombatantInfo(logLine);
      } else if (eventType === 'UNIT_DIED') {
        const isShuffleActive = this.shuffleTracker.isShuffleActive();

        if (isShuffleActive) {
          // Shuffle-specific round ending
          const roundEnded = this.shuffleTracker.handleDeath(logLine);
          if (roundEnded) {
            console.info('[CombatLogParser] Shuffle round ended via player death');
          }
        } else {
          // Non-shuffle: track real player deaths for 2v2/3v3 no-kill invalidation
          const deathEvent = extractDeathEvent(logLine);
          if (deathEvent) {
            this.playerDeathCount++;
          }
        }
      } else if (eventType === 'ZONE_CHANGE') {
        // Parse zone change events for early ending detection
        return this.parseZoneChange(logLine);
      }

      return null;
    } catch {
      // Invalid log line - ignore and let caller continue
      return null;
    }
  }

  /**
   * Get current match context for external monitoring
   */
  public getCurrentMatch(): { bracket: string; timestamp: Date } | null {
    if (!this.currentMatch?.startTime || !this.currentMatch?.bracket) {
      return null;
    }

    return {
      bracket: this.currentMatch.bracket,
      timestamp: this.currentMatch.startTime,
    };
  }

  /**
   * Clear current match context without full reset.
   * Used when a match ends via early-end triggers (zone change, process stop, etc.)
   * where ARENA_MATCH_END log line is never received.
   */
  public clearCurrentMatch(): void {
    this.currentMatch = null;
  }

  /**
   * Reset parser state (useful for testing or cleanup)
   */
  public reset(): void {
    this.currentMatch = null;
    this.combatants.clear();
    this.matchLines = [];
    this.playerId = null;
    this.warnedBufferLimit = false;
    this.loggedPlayerFound = false;
    this.team0MMR = 0;
    this.team1MMR = 0;
    this.playerDeathCount = 0;

    // CRITICAL: Reset shuffle tracker
    this.shuffleTracker.reset();
  }

  /**
   * Create match start event from log line with enhanced data for immediate metadata creation.
   */
  private createMatchStartEvent(
    line: CombatLogLine,
    bracketInfo: { bracket: ArenaBracket; bracketString: string }
  ): MatchEvent | null {
    const startTime = line.getTimestamp();
    const zoneId = parseInt(line.getField(1), 10);
    const seasonId = parseInt(line.getField(2), 10);
    const rankedFlag = parseInt(line.getField(4), 10) === 1;

    // Validate parsed numbers
    if (!Number.isFinite(zoneId) || !Number.isFinite(seasonId)) {
      console.warn('[CombatLogParser] Invalid numeric values in ARENA_MATCH_START:', {
        zoneId,
        seasonId,
      });
      return null;
    }

    const { bracket, bracketString } = bracketInfo;

    // Determine if match is ranked
    let isRanked: boolean;
    if (isSoloShuffleBracket(bracket)) {
      // Solo Shuffle is always ranked (we only parse "Rated Solo Shuffle")
      isRanked = true;
    } else {
      // Regular 2v2/3v3 - check ranked flag
      isRanked = rankedFlag;
      if (!isRanked) {
        console.info('[CombatLogParser] Skipping unranked arena match:', bracketString);
        return null;
      }
    }

    // CRITICAL: Handle Solo Shuffle multi-round logic
    if (isSoloShuffleBracket(bracket)) {
      if (!this.shuffleTracker.isShuffleActive()) {
        // FIRST ROUND - Start new shuffle
        const bufferId = `${startTime.getTime()}_${zoneId}`;
        this.shuffleTracker.startShuffle(bufferId, startTime);

        // Emit matchStarted ONLY for first round
        return {
          type: MatchEventType.MATCH_STARTED,
          timestamp: startTime,
          zoneId,
          bufferId,
          bracket: bracketString,
          season: seasonId,
          isRanked,
          players: Array.from(this.combatants.values()),
        };
      } else {
        // SUBSEQUENT ROUNDS - Don't emit matchStarted
        this.shuffleTracker.startNewRound(startTime);

        // CRITICAL FIX: Clear combatants to avoid stale teamId/name bleeding
        this.combatants.clear();

        console.info(
          '[CombatLogParser] Solo Shuffle round',
          this.shuffleTracker.getCurrentRoundNumber(),
          'started'
        );
        return null; // SUPPRESS event for rounds 2-6
      }
    }

    // Regular arena match logic (2v2/3v3)
    // For non-shuffle brackets: always emit MATCH_STARTED, but reuse bufferId
    // for multiple starts of the same physical match.
    let bufferId: string;
    if (this.currentMatch && this.currentMatch.bufferId) {
      // Duplicate start while a non-shuffle match is active (e.g. /reload).
      // Emit an event for observability, but reuse the existing bufferId so
      // downstream layers can correlate it with the same session.
      bufferId = this.currentMatch.bufferId;
    } else {
      bufferId = `${startTime.getTime()}_${zoneId}`;
    }

    return {
      type: MatchEventType.MATCH_STARTED,
      timestamp: startTime,
      zoneId,
      bufferId,
      bracket: bracketString,
      season: seasonId,
      isRanked,
      players: Array.from(this.combatants.values()),
    };
  }

  /**
   * Create match end event from log line.
   */
  private createMatchEndEvent(line: CombatLogLine): MatchEvent | null {
    if (!this.currentMatch || !this.currentMatch.startTime) {
      console.warn('[CombatLogParser] Arena end without active match');
      return null;
    }

    const endTime = line.getTimestamp();
    const winningTeamId = parseInt(line.getField(1), 10);
    const duration = parseInt(line.getField(2), 10); // Use combat log duration (server-authoritative)

    // Validate parsed numbers
    if (!Number.isFinite(winningTeamId) || !Number.isFinite(duration)) {
      console.warn('[CombatLogParser] Invalid numeric values in ARENA_MATCH_END:', {
        winningTeamId,
        duration,
      });
      return null;
    }

    console.debug('[CombatLogParser] Using combat log duration:', {
      serverDuration: duration,
      winningTeam: winningTeamId,
    });

    // Extract MMRs from ARENA_MATCH_END
    this.extractMMRFromMatchEnd(line);

    // Identify the recording player from buffered combat events (now also extracts names)
    if (!this.playerId) {
      this.playerId = this.identifyPlayerFromCombatEvents();
    }

    // Ensure we have a valid bufferId - this should never be undefined if currentMatch exists
    if (!this.currentMatch.bufferId) {
      console.error('[CombatLogParser] Critical: currentMatch exists but bufferId is undefined', {
        bracket: this.currentMatch.bracket,
        zoneId: this.currentMatch.zoneId,
        startTime: this.currentMatch.startTime,
      });
      return null;
    }

    // Track whether this is a shuffle BEFORE finalizing (finalize sets isActive = false)
    const isShuffle = this.shuffleTracker.isShuffleActive();

    // For shuffle: finalize tracker state BEFORE building metadata
    if (isShuffle) {
      if (this.playerId) {
        this.shuffleTracker.setRecordingPlayer(this.playerId);
      }
      this.shuffleTracker.finalizeShuffle(endTime);
    }

    // Build metadata once (includes finalized shuffle rounds via getCurrentRounds())
    const metadata = this.buildMatchMetadata();
    if (!metadata) {
      console.warn(`[CombatLogParser] Cannot emit MATCH_ENDED: insufficient data`);
      if (isShuffle) {
        this.shuffleTracker.reset();
      }
      return null;
    }

    // Add ARENA_MATCH_END-specific fields
    metadata.matchDuration = duration;
    if (!isShuffle) {
      // Only set winningTeamId for non-shuffle (shuffle uses per-round winners)
      metadata.winningTeamId = winningTeamId;
    }

    // Reset shuffle tracker after successful metadata build
    if (isShuffle) {
      this.shuffleTracker.reset();
    }

    return {
      type: MatchEventType.MATCH_ENDED,
      timestamp: endTime,
      bufferId: this.currentMatch.bufferId,
      metadata,
    };
  }

  /**
   * Parse zone change event from combat log line
   * Format: ZONE_CHANGE,{zoneId},"{zoneName}",{difficultyId}
   */
  private parseZoneChange(line: CombatLogLine): ZoneChangeEvent | null {
    try {
      const zoneId = parseInt(line.getField(1), 10);
      const zoneName = line.getField(2);

      // Validate zone ID is numeric
      if (!Number.isFinite(zoneId)) {
        console.warn('[CombatLogParser] Invalid zone ID in ZONE_CHANGE:', line.getField(1));
        return null;
      }

      // CRITICAL: Only reset shuffle tracker on zone change AWAY FROM arena
      // Same-arena zone changes (map transitions, etc.) should not end the shuffle
      if (this.shuffleTracker.isShuffleActive() && this.currentMatch?.zoneId !== zoneId) {
        console.info(
          '[CombatLogParser] Zone change away from arena during shuffle - resetting tracker'
        );
        this.shuffleTracker.reset();
      }

      const zoneChangeEvent: ZoneChangeEvent = {
        type: MatchEventType.ZONE_CHANGE,
        timestamp: line.getTimestamp(),
        zoneId,
        zoneName: zoneName || `Zone ${zoneId}`,
        sourceGUID: line.getField(0) || undefined, // Player GUID if available
      };

      console.debug('[CombatLogParser] Parsed zone change:', {
        zoneId: zoneChangeEvent.zoneId,
        zoneName: zoneChangeEvent.zoneName,
        timestamp: zoneChangeEvent.timestamp,
      });

      return zoneChangeEvent;
    } catch (error) {
      console.warn('[CombatLogParser] Failed to parse ZONE_CHANGE event:', error);
      return null;
    }
  }

  /**
   * Update current match state from match start event.
   * Category is determined from parsing context, not from event (which no longer contains it)
   */
  private updateCurrentMatch(
    matchEvent: MatchStartedEvent,
    seasonId: number,
    isRanked: boolean,
    bracket: ArenaBracket
  ): void {
    this.currentMatch = {
      startTime: matchEvent.timestamp,
      bracket: bracket,
      zoneId: matchEvent.zoneId,
      bufferId: matchEvent.bufferId,
      seasonId: seasonId,
      isRanked: isRanked,
    };
  }

  /**
   * Parse COMBATANT_INFO event to extract player metadata.
   */
  private parseCombatantInfo(line: CombatLogLine): void {
    try {
      const playerGuid = line.getField(1);
      const teamId = parseInt(line.getField(2), 10);
      const specId = parseInt(line.getField(24), 10);
      const personalRating = parseInt(line.getField(31), 10);
      const highestPvpTier = parseInt(line.getField(32), 10);

      // Validate critical numeric values
      if (!Number.isFinite(teamId) || !Number.isFinite(specId)) {
        console.warn('[CombatLogParser] Invalid critical values in COMBATANT_INFO:', {
          teamId,
          specId,
        });
        return;
      }

      // Derive class ID from spec ID
      const classId = getClassIdFromSpec(specId);

      const playerMetadata: PlayerMetadata = {
        id: playerGuid,
        teamId,
        specId,
        classId,
        personalRating: Number.isFinite(personalRating) ? personalRating : 0,
        highestPvpTier: Number.isFinite(highestPvpTier) ? highestPvpTier : 0,
      };

      this.combatants.set(playerGuid, playerMetadata);

      // NEW: Track for shuffle rounds
      if (this.shuffleTracker.isShuffleActive()) {
        this.shuffleTracker.addCombatant(playerGuid, teamId, playerMetadata.name);
      }

      console.debug('[CombatLogParser] Parsed combatant:', {
        guid: playerGuid,
        teamId,
        specId,
        classId,
        personalRating,
      });
    } catch (error) {
      console.warn('[CombatLogParser] Failed to parse COMBATANT_INFO:', error);
    }
  }

  /**
   * Extract MMR values from ARENA_MATCH_END event.
   */
  private extractMMRFromMatchEnd(line: CombatLogLine): void {
    try {
      // ARENA_MATCH_END format: ARENA_MATCH_END,{winningTeamId},{matchDurationInSeconds},{team0MMR},{team1MMR}
      const team0MMR = parseInt(line.getField(3), 10);
      const team1MMR = parseInt(line.getField(4), 10);

      // Use valid MMR values or default to 0
      this.team0MMR = Number.isFinite(team0MMR) ? team0MMR : 0;
      this.team1MMR = Number.isFinite(team1MMR) ? team1MMR : 0;

      console.debug('[CombatLogParser] Extracted MMRs:', {
        team0MMR: this.team0MMR,
        team1MMR: this.team1MMR,
      });
    } catch (error) {
      console.warn('[CombatLogParser] Failed to extract MMRs:', error);
      this.team0MMR = 0;
      this.team1MMR = 0;
    }
  }

  /**
   * Identify the recording player by scanning buffered combat events for self flags.
   * Only enriches names for combatants that don't already have them (avoids redundant work).
   */
  private identifyPlayerFromCombatEvents(): string | null {
    for (const rawLine of this.matchLines) {
      try {
        const logLine = new CombatLogLine(rawLine);
        const eventType = logLine.getEventType();

        // Always attempt to extract names (method handles its own filtering)
        this.enrichCombatantsFromLogLine(logLine);

        // Look for events that have source flags for player identification
        if (this.isCombatEventWithNames(eventType)) {
          const srcGUID = logLine.getField(1);
          const srcFlags = parseInt(logLine.getField(3), 16);

          if (this.isUnitSelf(srcFlags)) {
            console.debug('[CombatLogParser] Identified player:', srcGUID);
            return srcGUID;
          }
        }
      } catch {
        // Skip invalid lines
        continue;
      }
    }

    console.warn('[CombatLogParser] Could not identify recording player from combat events');
    return null;
  }

  /**
   * Extract unit type from combat log flags.
   * Uses WoW combat log flag structure: bits 0x0000fc00 determine unit type.
   */
  private getUnitType(flags: number): 'player' | 'pet' | 'guardian' | 'npc' | 'object' | 'none' {
    const TYPE_MASK = 0x0000fc00;
    const masked = flags & TYPE_MASK;

    switch (masked) {
      case 0x00000400:
        return 'player';
      case 0x00000800:
        return 'npc';
      case 0x00001000:
        return 'pet';
      case 0x00002000:
        return 'guardian';
      case 0x00004000:
        return 'object';
      default:
        return 'none';
    }
  }

  /**
   * Check if unit flags indicate this is the recording player.
   * CRITICAL: Must filter by unit type to exclude pets/guardians owned by the player.
   */
  private isUnitSelf(flags: number): boolean {
    const REACTION_FRIENDLY = 0x00000010;
    const AFFILIATION_MINE = 0x00000001;

    // Check affiliation and reaction
    const isFriendlyMine = (flags & REACTION_FRIENDLY) !== 0 && (flags & AFFILIATION_MINE) !== 0;

    // CRITICAL: Also check unit type is 'player' to exclude pets/guardians
    const isPlayer = this.getUnitType(flags) === 'player';

    return isFriendlyMine && isPlayer;
  }

  /**
   * Attempt to identify player from a single line (early detection).
   * Also extracts names for combatants that need them.
   */
  private tryIdentifyPlayerFromLine(line: string): string | null {
    try {
      const logLine = new CombatLogLine(line);
      const eventType = logLine.getEventType();

      // Always attempt to extract names (method handles its own filtering)
      this.enrichCombatantsFromLogLine(logLine);

      // Look for events that have source flags for player identification
      if (this.isCombatEventWithNames(eventType)) {
        const srcGUID = logLine.getField(1);
        const srcFlags = parseInt(logLine.getField(3), 16);

        if (this.isUnitSelf(srcFlags)) {
          console.debug('[CombatLogParser] Early player identification:', srcGUID);
          return srcGUID;
        }
      }
    } catch {
      // Skip invalid lines silently
    }

    return null;
  }

  /**
   * Extract player name, realm, and region from combat event name field.
   * Format: "Bluedàn-Tichondrius-US" or "Name-Realm" or "Name"
   */
  private extractPlayerDetails(nameField: string): {
    name: string;
    realm: string;
    region: string;
  } | null {
    try {
      if (!nameField || nameField === 'Unknown') {
        return null;
      }

      const parts = nameField.split('-');
      if (parts.length >= 3) {
        // Format: "Name-Realm-Region" (e.g., "Bluedàn-Tichondrius-US")
        const region = parts[parts.length - 1] || 'Unknown'; // Last part is region
        const realm = parts[parts.length - 2] || 'Unknown'; // Second-to-last is realm
        const name = parts.slice(0, -2).join('-'); // Everything else is name
        return { name, realm, region };
      } else if (parts.length === 2) {
        // Format: "Name-Realm" (no region)
        const name = parts[0] || '';
        const realm = parts[1] || 'Unknown';
        return { name, realm, region: 'Unknown' };
      } else {
        // Single name, no realm or region
        return { name: nameField, realm: 'Unknown', region: 'Unknown' };
      }
    } catch (error) {
      console.warn('[CombatLogParser] Failed to extract player details:', error);
      return null;
    }
  }

  /**
   * Check if a combat event type contains player name information.
   * Based on WoW combat log format: events with source/destination unit names.
   */
  private isCombatEventWithNames(eventType: string): boolean {
    // Most combat events with player names are SPELL_ events
    return eventType.startsWith('SPELL_');
  }

  /**
   * Enrich combatant metadata with name/realm/region from a single combat event.
   * Only processes events that actually contain player names to prevent corruption.
   */
  private enrichCombatantsFromLogLine(logLine: CombatLogLine): void {
    const eventType = logLine.getEventType();

    // Guard: Only act on name-bearing events to prevent name corruption
    if (!this.isCombatEventWithNames(eventType)) {
      return;
    }

    // Guard: Only enrich if some players still need names (avoid redundant work)
    const playersWithNames = this.getPlayersWithNames();
    const totalPlayers = this.combatants.size;
    if (playersWithNames >= totalPlayers) {
      return;
    }

    // Extract source player details
    const srcGUID = logLine.getField(1);
    const srcName = logLine.getField(2);
    if (
      srcGUID &&
      srcName &&
      typeof srcName === 'string' &&
      /-/.test(srcName) &&
      this.combatants.has(srcGUID)
    ) {
      const details = this.extractPlayerDetails(srcName);
      if (details) {
        const player = this.combatants.get(srcGUID)!;
        if (!player.name) player.name = details.name;
        if (!player.realm) player.realm = details.realm;
        if (!player.region) player.region = details.region;
      }
    }

    // Extract destination player details (if different from source)
    const destGUID = logLine.getField(5);
    const destName = logLine.getField(6);
    if (
      destGUID &&
      destName &&
      typeof destName === 'string' &&
      /-/.test(destName) &&
      destGUID !== srcGUID &&
      this.combatants.has(destGUID)
    ) {
      const details = this.extractPlayerDetails(destName);
      if (details) {
        const player = this.combatants.get(destGUID)!;
        if (!player.name) player.name = details.name;
        if (!player.realm) player.realm = details.realm;
        if (!player.region) player.region = details.region;
      }
    }
  }

  /**
   * Create match metadata snapshot from current parser state.
   * Used for both normal match end and early-end scenarios.
   * SSoT: Single method to build metadata regardless of how match ends.
   */
  public buildMatchMetadata(): MatchMetadata | null {
    if (
      !this.currentMatch?.startTime ||
      !this.currentMatch?.zoneId ||
      !this.currentMatch?.bracket
    ) {
      console.warn('[CombatLogParser] Insufficient match context for metadata');
      return null;
    }

    // Get bracket string using centralized formatter
    const bracket = formatBracket(this.currentMatch.bracket);

    // Service will generate matchHash at finalization - parser only provides raw data
    const players = Array.from(this.combatants.values());
    const recordingPlayerId = this.playerId || '';

    const metadata: MatchMetadata = {
      // winningTeamId and matchDuration will be set by ARENA_MATCH_END line if available
      team0MMR: this.team0MMR,
      team1MMR: this.team1MMR,
      timestamp: this.currentMatch.startTime,
      mapId: this.currentMatch.zoneId,
      bracket,
      season: this.currentMatch.seasonId || 0,
      isRanked: this.currentMatch.isRanked || false,
      players,
      playerId: recordingPlayerId,
      playerDeathCount: this.playerDeathCount,
    };

    // SSoT: Include shuffle rounds if tracker has any rounds (active or finalized)
    const currentRounds = this.shuffleTracker.getCurrentRounds();
    if (currentRounds.length > 0) {
      // Convert RoundData to ShuffleRoundSummary format
      metadata.shuffleRounds = currentRounds
        .filter(round => {
          // Include all rounds with minimum data (roundNumber + startTime)
          // Early-end rounds may not have endTime/winningTeamId yet
          return round.roundNumber !== undefined && round.startTime !== undefined;
        })
        .map(round => {
          const teamComps = this.shuffleTracker.getTeamCompositions(round);
          const summary: ShuffleRoundSummary = {
            roundNumber: round.roundNumber,
            winningTeamId: round.winningTeamId ?? undefined,
            killedPlayerId: round.killedPlayerId ?? undefined,
            startTimestamp: round.startTimestamp,
            endTimestamp: round.endTimestamp ?? undefined,
            duration: round.duration ?? undefined,
            team0Players: teamComps.team0Players.length > 0 ? teamComps.team0Players : undefined,
            team1Players: teamComps.team1Players.length > 0 ? teamComps.team1Players : undefined,
          };
          return summary;
        });

      // Calculate per-player W-L records if we have complete rounds
      const playerWinsLosses = new Map<string, { wins: number; losses: number }>();
      players.forEach(player => playerWinsLosses.set(player.id, { wins: 0, losses: 0 }));

      metadata.shuffleRounds?.forEach(round => {
        if (round.winningTeamId !== undefined) {
          round.team0Players?.forEach(playerId => {
            const stats = playerWinsLosses.get(playerId);
            if (stats) {
              if (round.winningTeamId === 0) stats.wins++;
              else stats.losses++;
            }
          });
          round.team1Players?.forEach(playerId => {
            const stats = playerWinsLosses.get(playerId);
            if (stats) {
              if (round.winningTeamId === 1) stats.wins++;
              else stats.losses++;
            }
          });
        }
      });

      // Apply W-L to players
      players.forEach(player => {
        const stats = playerWinsLosses.get(player.id);
        if (stats) {
          player.wins = stats.wins;
          player.losses = stats.losses;
        }
      });
    }

    console.debug('[CombatLogParser] Created match metadata:', {
      playerCount: metadata.players.length,
      playerId: metadata.playerId,
      bracket: metadata.bracket,
      season: metadata.season,
      mmrs: { team0: metadata.team0MMR, team1: metadata.team1MMR },
      shuffleRoundCount: metadata.shuffleRounds?.length || 0,
      playerDeathCount: metadata.playerDeathCount,
    });

    return metadata;
  }

  /**
   * Check how many players we have names for
   */
  private getPlayersWithNames(): number {
    return Array.from(this.combatants.values()).filter(p => p.name && p.name !== 'Unknown').length;
  }

  /**
   * Check if we have all the data we need and can stop scanning
   */
  private hasAllRequiredData(): boolean {
    const hasPlayerId = !!this.playerId;
    const playersWithNames = this.getPlayersWithNames();
    const totalPlayers = this.combatants.size;

    // We can stop when we have:
    // 1. Player ID identified AND
    // 2. ALL players have names (don't stop until we get them all)
    const hasAllNames = totalPlayers > 0 && playersWithNames === totalPlayers;

    return hasPlayerId && hasAllNames;
  }
}
