import { EventEmitter } from 'events';
import {
  MatchStartedEvent,
  MatchEndedEvent,
  MatchEndedIncompleteEvent,
} from '../match-detection/types/MatchEvent';
import { EarlyEndTrigger } from '../match-detection/types/EarlyEndTriggers';
import { MetadataService } from './MetadataService';
import { RecordingService } from './RecordingService';
import { MatchMetadata, BRACKET_STRINGS } from '../match-detection/types/MatchMetadata';

export type MatchLifecycleState = 'active' | 'complete' | 'incomplete';

export interface MatchSessionState {
  bufferId: string;
  state: MatchLifecycleState;
  completionReason?: string;
  duplicateStartDetected?: boolean;
}

/**
 * Single source of truth for match session lifecycle.
 * Owns session state transitions and coordinates metadata + recording services.
 *
 * Enforces invariants:
 * - 1 bufferId → 1 session → exactly 1 recording stop
 * - Session state is monotonic: active → complete/incomplete
 * - Recording strictly follows metadata lifecycle
 * - All structural validation lives here (not in MetadataService)
 */
export class MatchLifecycleService extends EventEmitter {
  private readonly sessions = new Map<string, MatchSessionState>();

  constructor(
    private readonly metadataService: MetadataService,
    private readonly recordingService: RecordingService | null
  ) {
    super();
  }

  /**
   * Handle match started event - create session and start metadata + recording
   */
  public async handleMatchStarted(event: MatchStartedEvent): Promise<void> {
    const { bufferId } = event;

    // Check for existing session
    const existingSession = this.sessions.get(bufferId);
    if (existingSession && existingSession.state === 'active') {
      // Duplicate start for already-active session (e.g., /reload in 2v2/3v3)
      existingSession.duplicateStartDetected = true;
      console.warn('[MatchLifecycle] Ignoring duplicate MATCH_STARTED for active session', {
        bufferId,
        bracket: event.bracket,
      });
      return;
    }

    if (
      existingSession &&
      (existingSession.state === 'complete' || existingSession.state === 'incomplete')
    ) {
      // Extremely rare: new match with same bufferId after terminal state
      console.warn(
        '[MatchLifecycle] New match starting for bufferId in terminal state - re-initializing',
        { bufferId, previousState: existingSession.state }
      );
    }

    // Create new session
    this.sessions.set(bufferId, {
      bufferId,
      state: 'active',
    });

    // Create initial metadata
    await this.metadataService.createInitialMetadata(event);

    // Start recording if enabled (best-effort; recording failures do not abort match)
    if (this.recordingService) {
      try {
        await this.recordingService.handleMatchStarted(event);
      } catch (recordingError) {
        console.error('[MatchLifecycle] Recording start failed (non-fatal):', recordingError);
        // Match continues without recording
      }
    }

    this.emit('matchLifecycle:started', { bufferId });
    console.info('[MatchLifecycle] Match session started:', { bufferId, bracket: event.bracket });
  }

  /**
   * Handle match ended event - validate completeness and finalize or mark invalid
   */
  public async handleMatchEnded(event: MatchEndedEvent): Promise<void> {
    const { bufferId } = event;

    const session = this.sessions.get(bufferId);
    if (!session || session.state !== 'active') {
      console.warn('[MatchLifecycle] Match ended event for non-active session - ignoring', {
        bufferId,
        sessionState: session?.state || 'not-found',
      });
      return;
    }

    // Verify stored metadata exists (guard)
    const stored = await this.metadataService.loadMatchByBufferId(bufferId);
    if (!stored) {
      console.error('[MatchLifecycle] Stored metadata missing for bufferId:', bufferId);
      await this.handleMatchValidationFailed({
        bufferId,
        trigger: 'METADATA_MISSING',
        reason: 'Initial metadata file not found',
      });
      return;
    }

    // Validate match completeness using enriched metadata from parser
    const validation = this.validateMatchCompleteness(bufferId, event.metadata);
    if (!validation.isValid) {
      const reason = validation.errors.join('; ');
      console.warn('[MatchLifecycle] Match validation failed:', {
        bufferId,
        errors: validation.errors,
      });

      if (
        validation.hardInvalidationTrigger === EarlyEndTrigger.INSUFFICIENT_COMBATANTS ||
        validation.hardInvalidationTrigger === EarlyEndTrigger.NO_PLAYER_DEATH
      ) {
        // Route through early-end path for hard deletion
        const incompleteEvent: MatchEndedIncompleteEvent = {
          bufferId,
          trigger: validation.hardInvalidationTrigger,
          lines: 0,
          buffer: {
            startTime: event.metadata.timestamp.getTime(),
            rawLines: [],
            inactivityTimer: null,
            metadata: event.metadata,
          },
        };
        await this.handleMatchEndedIncomplete(incompleteEvent);
      } else {
        await this.handleMatchValidationFailed({
          bufferId,
          trigger: 'VALIDATION_FAILED',
          reason,
          metadata: event.metadata, // Pass enriched metadata for persistence
        });
      }
      return;
    }

    // Validation passed - finalize as complete
    try {
      const matchHash = await this.metadataService.finalizeCompleteMatch(event);

      // Stop recording for complete match (best-effort; recording failures do not invalidate match)
      if (this.recordingService) {
        try {
          await this.recordingService.handleMatchEnded(bufferId);
        } catch (recordingError) {
          console.error('[MatchLifecycle] Recording stop failed (non-fatal):', recordingError);
          // Match finalization continues
        }
      }

      // Mark session complete
      session.state = 'complete';
      session.completionReason = 'Match completed successfully';

      this.emit('matchLifecycle:completed', { bufferId, matchHash });
      console.info('[MatchLifecycle] Match session completed:', { bufferId, matchHash });
    } catch (error) {
      console.error('[MatchLifecycle] Error finalizing complete match:', error);

      // Mark session incomplete due to finalization error
      session.state = 'incomplete';
      session.completionReason = `Metadata finalization error: ${(error as Error).message}`;

      // Stop recording early (best-effort)
      if (this.recordingService) {
        try {
          await this.recordingService.handleEarlyEnd(bufferId, session.completionReason);
        } catch (recordingError) {
          console.error('[MatchLifecycle] Recording early end failed (non-fatal):', recordingError);
        }
      }

      this.emit('matchLifecycle:incomplete', { bufferId, reason: session.completionReason });
      throw error;
    }
  }

  /**
   * Handle match ended incomplete event - mark session incomplete
   * Kill-aware: 2v2/3v3 early ends with no kills are classified as NO_PLAYER_DEATH
   */
  public async handleMatchEndedIncomplete(event: MatchEndedIncompleteEvent): Promise<void> {
    const { bufferId, trigger, buffer } = event;

    // Extract metadata from buffer if available for enrichment
    const bufferMetadata = buffer.metadata;

    // Compute effective trigger based on metadata availability and kill count
    // Note: NEW_MATCH_START never has metadata (match was overwritten before any end event)
    let effectiveTrigger = trigger;
    if (bufferMetadata) {
      const { bracket, playerDeathCount } = bufferMetadata;
      const is2v2 = bracket === BRACKET_STRINGS.TWO_V_TWO;
      const is3v3 = bracket === BRACKET_STRINGS.THREE_V_THREE;
      const deathCount = typeof playerDeathCount === 'number' ? playerDeathCount : 0;

      if ((is2v2 || is3v3) && deathCount <= 0) {
        effectiveTrigger = EarlyEndTrigger.NO_PLAYER_DEATH;
      }
    }

    const session = this.sessions.get(bufferId);
    if (!session) {
      console.warn(
        '[MatchLifecycle] Incomplete event for unknown session - creating terminal session',
        {
          bufferId,
          trigger: effectiveTrigger,
        }
      );
      this.sessions.set(bufferId, {
        bufferId,
        state: 'incomplete',
        completionReason: `Early end: ${effectiveTrigger}`,
      });
    } else {
      session.state = 'incomplete';
      session.completionReason = `Early end: ${effectiveTrigger}`;
    }

    // Mark metadata as incomplete, enriching with whatever parser data is available
    await this.metadataService.markMatchIncomplete(bufferId, effectiveTrigger, bufferMetadata);

    // Stop recording early (best-effort; recording failures do not affect match state)
    const reason = `Early end: ${effectiveTrigger}`;
    if (this.recordingService) {
      try {
        await this.recordingService.handleEarlyEnd(bufferId, reason);
      } catch (recordingError) {
        console.error('[MatchLifecycle] Recording early end failed (non-fatal):', recordingError);
      }
    }

    // Hard-delete structurally invalid matches (not real matches, no value to keep):
    // - CANCEL_INSTANT_MATCH: Too short to be a real match
    // - INSUFFICIENT_COMBATANTS: Wrong player count for bracket
    // - NO_PLAYER_DEATH: 2v2/3v3 with no kills (timeout/abandon)
    // - NEW_MATCH_START: Overwritten by new match before any end event (no metadata available)
    if (
      effectiveTrigger === EarlyEndTrigger.CANCEL_INSTANT_MATCH ||
      effectiveTrigger === EarlyEndTrigger.INSUFFICIENT_COMBATANTS ||
      effectiveTrigger === EarlyEndTrigger.NO_PLAYER_DEATH ||
      effectiveTrigger === EarlyEndTrigger.NEW_MATCH_START
    ) {
      const deleted = await this.metadataService.deleteMatchByBufferId(bufferId);
      if (!deleted) {
        console.warn(
          '[MatchLifecycle] Cancellation cleanup did not delete match (metadata or video missing / deletion failed):',
          { bufferId, trigger: effectiveTrigger }
        );
      } else {
        console.info(
          '[MatchLifecycle] Cancellation cleanup removed metadata and video for bufferId:',
          bufferId
        );
      }
    }

    this.emit('matchLifecycle:incomplete', { bufferId, trigger: effectiveTrigger, reason });
    console.info('[MatchLifecycle] Match session ended incomplete:', {
      bufferId,
      trigger: effectiveTrigger,
    });
  }

  /**
   * Handle match validation failed - mark session incomplete with validation error
   */
  public async handleMatchValidationFailed(event: {
    bufferId: string;
    trigger: string;
    reason: string;
    metadata?: MatchMetadata;
  }): Promise<void> {
    const { bufferId, trigger, reason, metadata } = event;

    const session = this.sessions.get(bufferId);
    if (session) {
      session.state = 'incomplete';
      session.completionReason = `Validation failed: ${reason}`;
    } else {
      this.sessions.set(bufferId, {
        bufferId,
        state: 'incomplete',
        completionReason: `Validation failed: ${reason}`,
      });
    }

    // Mark metadata as validation failed, preserving enriched metadata for inspection
    await this.metadataService.markMatchValidationFailed(bufferId, trigger, reason, metadata);

    // Stop recording early (best-effort; recording failures do not affect match state)
    if (this.recordingService) {
      try {
        await this.recordingService.handleEarlyEnd(bufferId, reason);
      } catch (recordingError) {
        console.error('[MatchLifecycle] Recording early end failed (non-fatal):', recordingError);
      }
    }

    this.emit('matchLifecycle:incomplete', { bufferId, trigger, reason });
    console.info('[MatchLifecycle] Match validation failed:', { bufferId, reason });
  }

  /**
   * Get session state for a given bufferId
   */
  public getSession(bufferId: string): MatchSessionState | undefined {
    return this.sessions.get(bufferId);
  }

  /**
   * Validate match completeness - SSoT for structural acceptance rules.
   * Parser provides data, lifecycle decides validity.
   * Validates against enriched metadata from parser (contains shuffleRounds, W-L, etc.).
   */
  private validateMatchCompleteness(
    bufferId: string,
    incoming: MatchMetadata
  ): {
    isValid: boolean;
    errors: string[];
    hardInvalidationTrigger?: EarlyEndTrigger;
  } {
    const errors: string[] = [];
    let hardInvalidationTrigger: EarlyEndTrigger | undefined;
    const { bracket, shuffleRounds, players, playerId } = incoming;

    const isSoloShuffle = bracket === 'Solo Shuffle' || bracket === 'Rated Solo Shuffle';

    if (isSoloShuffle) {
      if (!Array.isArray(shuffleRounds) || shuffleRounds.length === 0) {
        errors.push('Solo Shuffle requires shuffleRounds data');
      } else if (shuffleRounds.length !== 6) {
        errors.push(`Solo Shuffle requires exactly 6 rounds (got ${shuffleRounds.length})`);
      }

      if (playerId && Array.isArray(players) && Array.isArray(shuffleRounds)) {
        const recordingPlayer = players.find(p => p.id === playerId);
        if (recordingPlayer) {
          const wins = recordingPlayer.wins ?? 0;
          const losses = recordingPlayer.losses ?? 0;
          if (wins + losses !== shuffleRounds.length) {
            errors.push(
              `W-L record (${wins}-${losses}) must equal round count (${shuffleRounds.length})`
            );
          }
        }
      }
    } else {
      // Reject non-shuffle matches with duplicate starts
      const session = this.sessions.get(bufferId);
      if (session?.duplicateStartDetected) {
        errors.push(
          'Multiple ARENA_MATCH_START events detected for non-shuffle session (duplicate start / reload anomaly)'
        );
      }

      // Enforce exact player counts for 2v2/3v3
      const playerCount = Array.isArray(players) ? players.length : 0;
      const is2v2 = bracket === BRACKET_STRINGS.TWO_V_TWO;
      const is3v3 = bracket === BRACKET_STRINGS.THREE_V_THREE;

      if (is2v2 && playerCount !== 4) {
        errors.push(`2v2 requires exactly 4 combatants (got ${playerCount})`);
        hardInvalidationTrigger = EarlyEndTrigger.INSUFFICIENT_COMBATANTS;
      } else if (is3v3 && playerCount !== 6) {
        errors.push(`3v3 requires exactly 6 combatants (got ${playerCount})`);
        hardInvalidationTrigger = EarlyEndTrigger.INSUFFICIENT_COMBATANTS;
      }

      // Enforce at least one kill for 2v2/3v3 (only if combatant count is valid)
      if ((is2v2 || is3v3) && hardInvalidationTrigger === undefined) {
        const expectedCount = is2v2 ? 4 : 6;
        if (playerCount === expectedCount) {
          const deathCount =
            typeof incoming.playerDeathCount === 'number' ? incoming.playerDeathCount : 0;

          if (deathCount <= 0) {
            errors.push('2v2/3v3 matches require at least one player death (no kills detected)');
            hardInvalidationTrigger = EarlyEndTrigger.NO_PLAYER_DEATH;
          }
        }
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      ...(hardInvalidationTrigger !== undefined && { hardInvalidationTrigger }),
    };
  }
}
