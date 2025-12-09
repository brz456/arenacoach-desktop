/**
 * Utility functions for player GUID validation and processing
 */

/**
 * Check if a GUID string represents a player
 * @param guid The GUID string to validate
 * @returns true if the GUID is a valid player GUID format
 */
export function isPlayerGuid(guid: string | undefined | null): guid is string {
  return Boolean(guid && typeof guid === 'string' && guid.startsWith('Player-'));
}