import { MatchEndedEvent } from '../types/MatchEvent';
import { MatchBuffer } from '../types/MatchTypes';

/**
 * Result of match resolution attempt
 */
export interface MatchResolutionResult {
  bufferId: string;
  matchBuffer: MatchBuffer;
  success: true;
}

export interface MatchResolutionFailure {
  success: false;
  reason: string;
}

export type MatchResolution = MatchResolutionResult | MatchResolutionFailure;

/**
 * Simple match resolver that uses bufferId lookup for all match types.
 * Each round (including Solo Shuffle rounds) is chunked independently.
 * Shuffle information is preserved in metadata for upload/UI purposes.
 */
export class MatchResolver {
  private activeMatches: Map<string, MatchBuffer>;

  constructor(activeMatches: Map<string, MatchBuffer>) {
    this.activeMatches = activeMatches;
  }

  /**
   * Resolve match using bufferId lookup - works for all match types
   */
  resolveMatch(matchEvent: MatchEndedEvent): MatchResolution {
    const bufferId = matchEvent.bufferId;
    const matchBuffer = this.activeMatches.get(bufferId);

    if (matchBuffer) {
      return {
        bufferId,
        matchBuffer,
        success: true
      };
    }

    return {
      success: false,
      reason: `No active match found for bufferId: ${bufferId}`
    };
  }
}