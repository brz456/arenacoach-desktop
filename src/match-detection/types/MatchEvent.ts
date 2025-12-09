import { MatchMetadata, PlayerMetadata } from './MatchMetadata';
import { MatchBuffer } from './MatchTypes';
import { EarlyEndTrigger } from './EarlyEndTriggers';

/**
 * Arena match event types for real-time detection
 */
export enum MatchEventType {
  MATCH_STARTED = 'MATCH_STARTED',
  MATCH_ENDED = 'MATCH_ENDED',
  ZONE_CHANGE = 'ZONE_CHANGE',
}

/**
 * Arena bracket types based on combat log parsing
 */
export enum ArenaBracket {
  TwoVTwo = '2v2',
  ThreeVThree = '3v3',
  SoloShuffle = 'Solo Shuffle',
}

/**
 * Match start event data - minimal orchestration fields plus optional combatant data
 * Combatant data is included when available (COMBATANT_INFO processed with match start)
 */
export interface MatchStartedEvent {
  type: MatchEventType.MATCH_STARTED;
  timestamp: Date;
  zoneId: number;
  /**
   * Temporary buffer ID for correlating start/end events within the detection pipeline.
   * Used only for buffering and event correlation until final metadata is available.
   */
  bufferId: string;
  /**
   * Additional match context for immediate metadata creation
   */
  bracket?: string;
  season?: number;
  isRanked?: boolean;
  /**
   * Player metadata if available from COMBATANT_INFO processing
   * This allows immediate metadata creation with complete player data
   */
  players?: PlayerMetadata[];
}

/**
 * Match end event data - minimal orchestration fields plus complete metadata
 * All match information is in metadata - event fields are only for orchestration
 */
export interface MatchEndedEvent {
  type: MatchEventType.MATCH_ENDED;
  timestamp: Date;
  /**
   * Temporary buffer ID for event correlation - matches the start event bufferId.
   */
  bufferId: string;
  // Complete match data extracted from combat log parsing
  metadata: MatchMetadata;
}

/**
 * Zone change event data - for detecting players leaving arenas
 */
export interface ZoneChangeEvent {
  type: MatchEventType.ZONE_CHANGE;
  timestamp: Date;
  zoneId: number;
  zoneName: string;
  sourceGUID?: string; // Player who changed zones (optional for now)
  metadataSnapshot?: MatchMetadata | null; // Optional parser snapshot at time of zone change
}

/**
 * Match ended incomplete event - emitted when a match ends early
 * (timeout, log file change, or other early-end triggers).
 * Not part of the MatchEvent union as it lacks a MatchEventType discriminant.
 */
export interface MatchEndedIncompleteEvent {
  bufferId: string;
  trigger: EarlyEndTrigger;
  lines: number;
  buffer: MatchBuffer;
}

/**
 * Union type for core parser match events (start/end/zone-change).
 * Early/incomplete events use MatchEndedIncompleteEvent separately.
 */
export type MatchEvent = MatchStartedEvent | MatchEndedEvent | ZoneChangeEvent;
