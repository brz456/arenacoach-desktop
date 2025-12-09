import { MatchMetadata } from './MatchMetadata';
import { EarlyEndTrigger } from './EarlyEndTriggers';

/**
 * Essential match buffer interface for chunking operations.
 * Simplified to single inactivity timer following reference implementation patterns.
 */
export interface MatchBuffer {
  startTime: number;
  endTime?: number;
  rawLines: string[];
  inactivityTimer: NodeJS.Timeout | null; // Single 30-minute combat inactivity timer

  // Early ending tracking
  timedOut?: boolean;
  earlyEndingTrigger?: EarlyEndTrigger; // Track what triggered early ending

  // Source of truth for all match data
  metadata?: MatchMetadata;
}
