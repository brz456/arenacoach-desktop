/**
 * Arena zone IDs and detection utilities
 */

/**
 * Complete set of arena zone IDs from retail WoW
 */
export const ARENA_ZONE_IDS = new Set([
  1672, // Blade's Edge Arena
  617,  // Dalaran Sewers  
  1505, // Nagrand Arena
  572,  // Ruins of Lordaeron
  2167, // Robodrome
  1134, // Tiger's Peak
  980,  // Tol'viron Arena
  1504, // Black Rook Hold Arena
  2373, // Empyrean Domain
  1552, // Ashamane's Fall
  1911, // Mugambala
  1825, // Hook Point
  2509, // Maldraxxus Coliseum
  2547, // Enigma Crucible
  2563, // Nokhudon Proving Grounds
  2759  // Cage of Carnage
]);

/**
 * Arena zone names mapping for debugging and logging
 */
export const ARENA_ZONE_NAMES: { [key: number]: string } = {
  1672: "Blade's Edge Arena",
  617: 'Dalaran Sewers',
  1505: 'Nagrand Arena', 
  572: 'Ruins of Lordaeron',
  2167: 'Robodrome',
  1134: "Tiger's Peak",
  980: "Tol'viron Arena",
  1504: 'Black Rook Hold Arena',
  2373: 'Empyrean Domain',
  1552: "Ashamane's Fall",
  1911: 'Mugambala',
  1825: 'Hook Point',
  2509: 'Maldraxxus Coliseum',
  2547: 'Enigma Crucible', 
  2563: 'Nokhudon Proving Grounds',
  2759: 'Cage of Carnage'
};

/**
 * Check if a zone ID represents an arena
 * Used for zone change early ending detection
 */
export function isArenaZone(zoneId: number): boolean {
  return ARENA_ZONE_IDS.has(zoneId);
}

/**
 * Get arena name from zone ID for logging purposes
 * Returns 'Unknown Arena' if zone ID is not found
 */
export function getArenaName(zoneId: number): string {
  return ARENA_ZONE_NAMES[zoneId] || `Unknown Arena (${zoneId})`;
}