import { parseCombatLogArenaTypeToBracketLabel } from '@wow/game-data';
import { ArenaBracket, ARENA_BRACKET_LABELS } from '../types/MatchEvent';

/**
 * Centralized bracket conversion utilities to eliminate redundant mapping logic.
 * Sources data from @wow/game-data (SSoT).
 */

/**
 * Parse arena type string from combat log to ArenaBracket and formatted string
 */
const ARENA_BRACKET_VALUES: ReadonlySet<string> = new Set(Object.values(ARENA_BRACKET_LABELS));

function isArenaBracketLabel(value: string): value is ArenaBracket {
  return ARENA_BRACKET_VALUES.has(value);
}

export function parseBracketFromArenaType(
  arenaType: string
): { bracket: ArenaBracket; bracketString: string } | null {
  const bracketLabel = parseCombatLogArenaTypeToBracketLabel(arenaType);
  if (bracketLabel === null || !isArenaBracketLabel(bracketLabel)) {
    return null;
  }
  return { bracket: bracketLabel, bracketString: bracketLabel };
}

/**
 * Format ArenaBracket to display string
 */
export function formatBracket(bracket: ArenaBracket): string {
  // ArenaBracket values are already the display strings
  return bracket;
}

/**
 * Check if bracket is Solo Shuffle
 */
export function isSoloShuffleBracket(bracket: ArenaBracket): boolean {
  return bracket === ARENA_BRACKET_LABELS.SoloShuffle;
}

/**
 * Check if bracket is Skirmish
 */
export function isSkirmishBracket(bracket: ArenaBracket): boolean {
  return bracket === ARENA_BRACKET_LABELS.Skirmish;
}
