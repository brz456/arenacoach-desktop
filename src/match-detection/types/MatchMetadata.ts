/**
 * Individual round summary for Solo Shuffle
 */
export interface ShuffleRoundSummary {
  roundNumber: number;
  winningTeamId: number | undefined; // May be undefined for incomplete/early-end rounds
  killedPlayerId: string | undefined; // May be undefined for incomplete/early-end rounds
  duration: number | undefined; // seconds - May be undefined for incomplete rounds
  startTimestamp: number; // ms relative to shuffle start - for video seeking
  endTimestamp: number | undefined; // ms relative to shuffle start - May be undefined for incomplete rounds
  team0Players: string[] | undefined; // Player GUIDs on team 0 for this round
  team1Players: string[] | undefined; // Player GUIDs on team 1 for this round
}

/**
 * Known event categories - extensible with string type union
 */
export type EventCategoryType = 'deaths' | string;

/**
 * Event item structure for match events timeline
 */
export interface MatchEventItem {
  timestamp: number; // ms relative to match start
  description?: string; // Optional human-readable description (e.g., "Player X died")
  data?: unknown; // Optional payload for event-specific data (e.g., { playerId, killerId } for deaths, or APM value for apm events)
  severity?: number; // Optional severity 1..10 from server-side mistake analysis
}

/**
 * Event category structure for grouping related events
 */
export interface MatchEventCategory {
  category: EventCategoryType; // Event category (e.g., 'deaths')
  items: MatchEventItem[]; // Events in this category
}

/**
 * Match metadata extracted from combat log parsing.
 * Supports progressive enrichment with partial data
 */
export interface MatchMetadata {
  // Available immediately from match start (Phase 1)
  timestamp: Date;
  mapId: number;
  bracket: string;
  season: number;
  isRanked: boolean;
  players: PlayerMetadata[];
  playerId?: string; // GUID of the recording player - may be determined later

  // Available only after match finalization (Phase 2) - optional
  winningTeamId?: number;
  matchDuration?: number;
  team0MMR?: number;
  team1MMR?: number;

  // Parser-level kill count for non-shuffle matches (2v2/3v3)
  // undefined or 0 = no real player deaths observed
  playerDeathCount?: number;

  // Solo Shuffle specific data
  shuffleRounds?: ShuffleRoundSummary[]; // All rounds data - OPTIONAL

  // Events timeline for video player interface (deaths, cooldowns, apm, etc.)
  events?: MatchEventCategory[]; // Event categories with timestamped items
}

// CRITICAL: Ensure exact bracket strings for consistency
export const BRACKET_STRINGS = {
  TWO_V_TWO: '2v2',
  THREE_V_THREE: '3v3',
  SOLO_SHUFFLE: 'Solo Shuffle',
} as const;

/**
 * Individual player metadata extracted from COMBATANT_INFO events.
 */
export interface PlayerMetadata {
  id: string; // Player GUID
  personalRating: number;
  classId: number;
  specId: number;
  teamId: number;
  highestPvpTier?: number;
  name?: string; // May be extracted from combat events if available
  realm?: string; // Realm name extracted from combat events
  region?: string; // Region extracted from combat events (US, EU, etc.)

  // Solo Shuffle specific - per-player wins/losses (v2+)
  wins?: number; // Total wins for this player in the shuffle match
  losses?: number; // Total losses for this player in the shuffle match
}
