/**
 * Early match ending trigger types and user-facing messages
 * Centralizes trigger-to-text mapping to avoid drift across UI components
 */

export enum EarlyEndTrigger {
  SAFETY_TIMEOUT = 'SAFETY_TIMEOUT',
  PROCESS_STOP = 'PROCESS_STOP',
  DATA_TIMEOUT = 'DATA_TIMEOUT',
  NEW_MATCH_START = 'NEW_MATCH_START',
  FORCE_END = 'FORCE_END',
  ZONE_CHANGE = 'ZONE_CHANGE',
  LOG_FILE_CHANGE = 'LOG_FILE_CHANGE',
  CANCEL_INSTANT_MATCH = 'CANCEL_INSTANT_MATCH',
  INSUFFICIENT_COMBATANTS = 'INSUFFICIENT_COMBATANTS',
  NO_PLAYER_DEATH = 'NO_PLAYER_DEATH',
}

/**
 * User-facing messages for early ending triggers
 * Single source of truth for consistent UI text across all components
 */
const TRIGGER_MESSAGES: Record<EarlyEndTrigger, string> = {
  [EarlyEndTrigger.SAFETY_TIMEOUT]: 'safety timeout',
  [EarlyEndTrigger.PROCESS_STOP]: 'WoW process stopped',
  [EarlyEndTrigger.DATA_TIMEOUT]: 'data timeout',
  [EarlyEndTrigger.NEW_MATCH_START]: 'double start',
  [EarlyEndTrigger.FORCE_END]: 'force shutdown',
  [EarlyEndTrigger.ZONE_CHANGE]: 'zone change away from arena',
  [EarlyEndTrigger.LOG_FILE_CHANGE]: 'combat log file changed',
  [EarlyEndTrigger.CANCEL_INSTANT_MATCH]: 'instant match cancellation',
  [EarlyEndTrigger.INSUFFICIENT_COMBATANTS]: 'insufficient arena combatants',
  [EarlyEndTrigger.NO_PLAYER_DEATH]: 'no player deaths detected',
} as const;

/**
 * Get user-friendly text for an early ending trigger.
 * Strictly typed - callers must supply a valid EarlyEndTrigger value.
 */
export function getTriggerMessage(trigger: EarlyEndTrigger): string {
  return TRIGGER_MESSAGES[trigger];
}
