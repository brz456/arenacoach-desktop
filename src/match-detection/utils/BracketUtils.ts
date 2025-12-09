import { ArenaBracket } from '../types/MatchEvent';

/**
 * Centralized bracket conversion utilities to eliminate redundant mapping logic.
 * Single source of truth for bracket string formatting.
 */

/**
 * Parse arena type string from combat log to ArenaBracket enum and formatted string
 */
export function parseBracketFromArenaType(arenaType: string): { bracket: ArenaBracket; bracketString: string } | null {
  switch (arenaType) {
    case '2v2':
      return { bracket: ArenaBracket.TwoVTwo, bracketString: '2v2' };
    case '3v3':
      return { bracket: ArenaBracket.ThreeVThree, bracketString: '3v3' };
    case 'Rated Solo Shuffle':
      return { bracket: ArenaBracket.SoloShuffle, bracketString: 'Solo Shuffle' };
    default:
      return null;
  }
}

/**
 * Format ArenaBracket enum to display string
 */
export function formatBracket(bracket: ArenaBracket): string {
  switch (bracket) {
    case ArenaBracket.TwoVTwo:
      return '2v2';
    case ArenaBracket.ThreeVThree:
      return '3v3';
    case ArenaBracket.SoloShuffle:
      return 'Solo Shuffle';
    default:
      return 'Unknown';
  }
}

/**
 * Check if bracket is Solo Shuffle
 */
export function isSoloShuffleBracket(bracket: ArenaBracket): boolean {
  return bracket === ArenaBracket.SoloShuffle;
}