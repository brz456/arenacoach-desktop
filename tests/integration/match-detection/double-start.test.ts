import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import MatchChunker from '../../../src/match-detection/chunking/MatchChunker';
import { MatchEventType, MatchStartedEvent } from '../../../src/match-detection/types/MatchEvent';
import { EarlyEndTrigger } from '../../../src/match-detection/types/EarlyEndTriggers';
import { createTempTestDir, cleanupTempDir } from '../../helpers/matchDetectionTestUtils';

/**
 * Double ARENA_MATCH_START Tests
 * Tests that MatchChunker correctly handles scenarios where multiple match start
 * events occur, including duplicate starts for the same match and concurrent matches.
 */
describe('Double ARENA_MATCH_START Handling', () => {
  let chunker: MatchChunker;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempTestDir('double-start-');
    chunker = new MatchChunker({
      outputDir: tempDir,
      minMatchLines: 10,
      maxMatchLines: 200000,
      allowedOutputRoots: [tempDir],
    });
    await chunker.init();
  });

  afterEach(async () => {
    chunker.cleanup();
    await cleanupTempDir(tempDir);
  });

  function createMatchStartEvent(bufferId: string, zoneId: number): MatchStartedEvent {
    return {
      type: MatchEventType.MATCH_STARTED,
      timestamp: new Date(),
      bufferId,
      zoneId,
      bracket: '2v2',
      season: 30,
      isRanked: true,
    };
  }

  describe('same bufferId (duplicate ignored)', () => {
    it('ignores duplicate match start and keeps original match active', async () => {
      const events: Array<{ type: string; bufferId: string; trigger?: EarlyEndTrigger }> = [];

      chunker.on('matchEndedIncomplete', event => {
        events.push({
          type: 'matchEndedIncomplete',
          bufferId: event.bufferId,
          trigger: event.trigger,
        });
      });

      const bufferId = 'test-buffer-123';

      // First match starts
      chunker.onMatchStarted(createMatchStartEvent(bufferId, 1552));
      expect(chunker.getActiveMatchCount()).toBe(1);

      // Add some combat activity
      chunker.addLogChunk([
        { line: 'SPELL_DAMAGE,Player-1,Target-1', timestamp: new Date() },
        { line: 'SPELL_DAMAGE,Player-2,Target-2', timestamp: new Date() },
      ]);

      // Second match starts with SAME bufferId - should be IGNORED
      chunker.onMatchStarted(createMatchStartEvent(bufferId, 1552));

      // No cleanup events should fire - duplicate is ignored
      expect(events).toHaveLength(0);

      // Still one active match (the original)
      expect(chunker.getActiveMatchCount()).toBe(1);
    });

    it('continues accumulating lines after duplicate start is ignored', async () => {
      const bufferId = 'test-buffer-lines';

      // First match starts
      chunker.onMatchStarted(createMatchStartEvent(bufferId, 1552));

      // Add 5 lines
      chunker.addLogChunk([
        { line: 'Line 1', timestamp: new Date() },
        { line: 'Line 2', timestamp: new Date() },
        { line: 'Line 3', timestamp: new Date() },
        { line: 'Line 4', timestamp: new Date() },
        { line: 'Line 5', timestamp: new Date() },
      ]);

      // Duplicate start is ignored
      chunker.onMatchStarted(createMatchStartEvent(bufferId, 1552));

      // Add more lines - should continue accumulating on original match
      chunker.addLogChunk([
        { line: 'Line 6', timestamp: new Date() },
        { line: 'Line 7', timestamp: new Date() },
      ]);

      // Original match still active with accumulated lines
      expect(chunker.getActiveMatchCount()).toBe(1);
    });
  });

  describe('different bufferIds (new match replaces old)', () => {
    it('ends previous match when new match starts with different bufferId', () => {
      const events: any[] = [];

      chunker.on('matchEndedIncomplete', event => {
        events.push(event);
      });

      // First match starts
      chunker.onMatchStarted(createMatchStartEvent('buffer-A', 1552));
      expect(chunker.getActiveMatchCount()).toBe(1);

      // Add activity to first match
      chunker.addLogChunk([{ line: 'SPELL_DAMAGE,PlayerA,TargetA', timestamp: new Date() }]);

      // Second match starts with DIFFERENT bufferId (e.g., 3v3 → Shuffle transition)
      // This should END the first match with NEW_MATCH_START trigger
      chunker.onMatchStarted(createMatchStartEvent('buffer-B', 1553));

      // Only the new match should be active
      expect(chunker.getActiveMatchCount()).toBe(1);

      // First match should have been ended with NEW_MATCH_START
      expect(events).toHaveLength(1);
      expect(events[0].bufferId).toBe('buffer-A');
      expect(events[0].trigger).toBe(EarlyEndTrigger.NEW_MATCH_START);
    });

    it('handles duplicate start on new match after previous was ended', async () => {
      const incompleteEvents: Array<{ bufferId: string; trigger: EarlyEndTrigger }> = [];

      chunker.on('matchEndedIncomplete', event => {
        incompleteEvents.push({ bufferId: event.bufferId, trigger: event.trigger });
      });

      // Start first match
      chunker.onMatchStarted(createMatchStartEvent('buffer-A', 1552));
      expect(chunker.getActiveMatchCount()).toBe(1);

      // Start second match (ends first with NEW_MATCH_START)
      chunker.onMatchStarted(createMatchStartEvent('buffer-B', 1553));
      expect(chunker.getActiveMatchCount()).toBe(1);
      expect(incompleteEvents).toHaveLength(1);
      expect(incompleteEvents[0].bufferId).toBe('buffer-A');
      expect(incompleteEvents[0].trigger).toBe(EarlyEndTrigger.NEW_MATCH_START);

      // Duplicate start on buffer-B - should be ignored
      chunker.onMatchStarted(createMatchStartEvent('buffer-B', 1553));

      // No additional incomplete events - duplicate is ignored
      expect(incompleteEvents).toHaveLength(1);

      // Still have 1 active match (buffer-B)
      expect(chunker.getActiveMatchCount()).toBe(1);
    });
  });

  describe('duplicate start prevention', () => {
    it('ignores duplicate onMatchStarted for same bufferId within short time', () => {
      const bufferId = 'test-duplicate';

      // First start
      chunker.onMatchStarted(createMatchStartEvent(bufferId, 1552));
      expect(chunker.getActiveMatchCount()).toBe(1);

      // Duplicate start (same bufferId, immediate)
      // MatchChunker should log and ignore
      chunker.onMatchStarted(createMatchStartEvent(bufferId, 1552));
      expect(chunker.getActiveMatchCount()).toBe(1);
    });
  });

  describe('bufferId lifecycle', () => {
    it('allows reuse of bufferId after match properly ends', async () => {
      const events: any[] = [];

      chunker.on('matchEndedIncomplete', event => {
        events.push({ type: 'incomplete', bufferId: event.bufferId });
      });
      chunker.on('matchExtracted', event => {
        events.push({ type: 'extracted', bufferId: event.matchInfo.bufferId });
      });

      const bufferId = 'reusable-buffer';

      // First match lifecycle
      chunker.onMatchStarted(createMatchStartEvent(bufferId, 1552));

      // Add enough lines to meet minMatchLines (10)
      for (let i = 0; i < 15; i++) {
        chunker.addLogChunk([{ line: `Combat line ${i}`, timestamp: new Date() }]);
      }

      // End first match properly
      chunker.onMatchEnded({
        type: MatchEventType.MATCH_ENDED,
        timestamp: new Date(),
        bufferId,
        metadata: {
          winningTeamId: 0,
          matchDuration: 60,
          team0MMR: 1500,
          team1MMR: 1400,
          timestamp: new Date(),
          mapId: 1552,
          bracket: '2v2',
          season: 30,
          isRanked: true,
          players: [],
          playerId: '',
        },
      });

      // Wait for async file write
      await new Promise(resolve => setTimeout(resolve, 100));

      // Now start a new match with same bufferId - should work cleanly
      chunker.onMatchStarted(createMatchStartEvent(bufferId, 1552));
      expect(chunker.getActiveMatchCount()).toBe(1);
    });
  });
});
