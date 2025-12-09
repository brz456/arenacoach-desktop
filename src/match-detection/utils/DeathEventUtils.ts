import CombatLogLine from '../parsing/CombatLogLine';
import { isPlayerGuid } from './PlayerUtils';

/**
 * Death event data extracted from UNIT_DIED combat log events
 */
export interface DeathEventData {
  killedPlayerId: string;
  killedPlayerName?: string;
  timestamp: Date;
  relativeTimestamp?: number; // ms relative to match/round start
}

/**
 * Extract death event data from a UNIT_DIED log line
 *
 * UNIT_DIED events have the following structure:
 * - destGUID at field 5 contains the GUID of the player who died
 * - destName at field 6 contains the name of the player who died
 *
 * @param logLine The UNIT_DIED log line to parse
 * @returns DeathEventData if a valid player death was found, null otherwise
 */
export function extractDeathEvent(logLine: CombatLogLine): DeathEventData | null {
  // Use destGUID at index 5, not srcGUID
  const killedGUID = logLine.getField(5);

  // Validate it's a player GUID
  if (!killedGUID || !isPlayerGuid(killedGUID)) {
    return null;
  }

  // Ignore Hunter Feign Death
  // Many logs include a feign-death indicator at field 9 for UNIT_DIED
  // Treat it as boolean: 1 => feign death, 0/undefined => real death
  const feignFlag = parseInt(logLine.getField(9), 10);
  if (Number.isFinite(feignFlag) && feignFlag === 1) {
    return null;
  }

  // Extract player name if available
  const killedPlayerName = logLine.getField(6);

  return {
    killedPlayerId: killedGUID,
    killedPlayerName: killedPlayerName,
    timestamp: logLine.getTimestamp(),
  };
}

/**
 * Calculate relative timestamp for a death event
 *
 * @param deathTime The absolute time of death
 * @param startTime The start time to calculate relative to
 * @returns Milliseconds since start time
 */
export function calculateRelativeTimestamp(deathTime: Date, startTime: Date): number {
  return deathTime.getTime() - startTime.getTime();
}
