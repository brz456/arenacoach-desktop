import { createHash } from 'crypto';
import { PlayerMetadata } from '../types/MatchMetadata';

/**
 * Utility for generating match identifiers that are consistent
 * across all players in the same match, while also supporting player-specific
 * database constraints.
 */

/**
 * Generate a match hash that's identical for all players in the same match
 * @param timestamp Match start timestamp as Date object
 * @param players Array of all players in the match
 * @returns Match hash (full SHA256 - 64 characters)
 */
export function generateMatchHash(
  timestamp: Date,
  players: PlayerMetadata[]
): string {
  const sortedPlayerIds = players.map(p => p.id).sort();
  
  // Use structured input to prevent concatenation ambiguity
  const hashInput = JSON.stringify({
    timestamp: timestamp.getTime(),
    players: sortedPlayerIds
  });
  
  // Return FULL SHA-256 hash - industry standard for collision resistance
  return createHash('sha256')
    .update(hashInput)
    .digest('hex');
}

