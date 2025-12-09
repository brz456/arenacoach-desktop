import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import MatchLogWatcher from '../../../src/match-detection/parsing/MatchLogWatcher';
import MatchChunker from '../../../src/match-detection/chunking/MatchChunker';
import {
  MatchEventType,
  MatchStartedEvent,
  ZoneChangeEvent,
} from '../../../src/match-detection/types/MatchEvent';
import { createTempTestDir, cleanupTempDir } from '../../helpers/matchDetectionTestUtils';

/**
 * Stale Zone Change Ordering Regression Tests
 *
 * Reproduces the bug from 18:28 Nokhudon match where a stale ZONE_CHANGE
 * from the previous arena (Dornogal @ 18:27:01) was emitted AFTER the new
 * ARENA_MATCH_START (18:28:53) due to type-based bucketing in MatchLogWatcher.
 *
 * With the old code:
 *   - processChunkSynchronously emitted events in type-bucket order:
 *     1. All MATCH_STARTED
 *     2. logChunk
 *     3. All ZONE_CHANGE
 *     4. All MATCH_ENDED
 *   - This caused MatchChunker.onZoneChange to see an active match and kill it.
 *
 * With the fix:
 *   - Events are emitted in log-line order (as they appear in the file).
 *   - Stale ZONE_CHANGE arrives when activeMatches.size === 0, so it's ignored.
 *   - Match proceeds normally.
 */

// Minimal combat log lines that reproduce the bug
const STALE_ZONE_CHANGE_CHUNK = [
  // Line 26: Stale zone change from leaving previous arena (Dornogal)
  '12/6/2025 18:27:01.0231  ZONE_CHANGE,2552,"Dornogal",0',
  // Line 317: Entering new arena zone
  '12/6/2025 18:27:55.2801  ZONE_CHANGE,2563,"Nokhudon Proving Grounds",0',
  // Line 318: Duplicate zone change (common in WoW logs)
  '12/6/2025 18:27:55.2841  ZONE_CHANGE,2563,"Nokhudon Proving Grounds",0',
  // Line 377: Match starts in Nokhudon
  '12/6/2025 18:28:53.5541  ARENA_MATCH_START,2563,40,2v2,1',
];

describe('Stale Zone Change Ordering (Regression)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempTestDir('stale-zone-change-');
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe('MatchLogWatcher event ordering', () => {
    it('emits events in log-line order, not type-bucket order', () => {
      const watcher = new MatchLogWatcher(tempDir, 10);
      const emittedEvents: Array<{ type: string; timestamp?: Date; zoneId?: number }> = [];

      watcher.on('zoneChange', (event: ZoneChangeEvent) => {
        emittedEvents.push({
          type: 'zoneChange',
          timestamp: event.timestamp,
          zoneId: event.zoneId,
        });
      });
      watcher.on('matchStarted', (event: MatchStartedEvent) => {
        emittedEvents.push({
          type: 'matchStarted',
          timestamp: event.timestamp,
          zoneId: event.zoneId,
        });
      });
      watcher.on('logChunk', () => {
        emittedEvents.push({ type: 'logChunk' });
      });

      // Process ALL lines as a SINGLE chunk (how production works)
      const watcherAny = watcher as any;
      watcherAny.processChunkSynchronously(STALE_ZONE_CHANGE_CHUNK);

      // Find event indices
      const zoneChangeIndices = emittedEvents
        .map((e, i) => (e.type === 'zoneChange' ? i : -1))
        .filter(i => i >= 0);
      const matchStartedIndices = emittedEvents
        .map((e, i) => (e.type === 'matchStarted' ? i : -1))
        .filter(i => i >= 0);
      const logChunkIndices = emittedEvents
        .map((e, i) => (e.type === 'logChunk' ? i : -1))
        .filter(i => i >= 0);

      // Verify both event types were emitted
      expect(zoneChangeIndices.length).toBeGreaterThan(0);
      expect(matchStartedIndices.length).toBe(1);

      // First ZONE_CHANGE must come before MATCH_STARTED (log-line order)
      expect(zoneChangeIndices[0]).toBeLessThan(matchStartedIndices[0]);

      // All 3 zone changes should come before match start
      for (const idx of zoneChangeIndices) {
        expect(idx).toBeLessThan(matchStartedIndices[0]);
      }

      // Only one logChunk event (single chunk processing)
      expect(logChunkIndices).toHaveLength(1);

      watcher.cleanup();
    });
  });

  describe('stale zone change handling', () => {
    it('does not kill match when stale zone change precedes match start', async () => {
      const chunker = new MatchChunker({
        outputDir: tempDir,
        minMatchLines: 1,
        allowedOutputRoots: [tempDir],
      });
      await chunker.init();

      let incompleteEventFired = false;

      chunker.on('matchEndedIncomplete', () => {
        incompleteEventFired = true;
      });

      const watcher = new MatchLogWatcher(tempDir, 10);

      watcher.on('matchStarted', event => {
        chunker.onMatchStarted(event);
      });
      watcher.on('zoneChange', event => {
        chunker.onZoneChange(event);
      });
      watcher.on('logChunk', lines => {
        chunker.addLogChunk(lines);
      });

      // Process chunk with stale zone change before match start
      const watcherAny = watcher as any;
      watcherAny.processChunkSynchronously(STALE_ZONE_CHANGE_CHUNK);

      // Match should still be active (zone changes processed when no match active)
      expect(chunker.getActiveMatchCount()).toBe(1);

      // No incomplete event should have fired
      expect(incompleteEventFired).toBe(false);

      chunker.cleanup();
      watcher.cleanup();
    });
  });

  describe('bug documentation', () => {
    it('demonstrates old behavior: match killed when zone change arrives after start', async () => {
      const chunker = new MatchChunker({
        outputDir: tempDir,
        minMatchLines: 1,
        allowedOutputRoots: [tempDir],
      });
      await chunker.init();

      let incompleteEventFired = false;

      chunker.on('matchEndedIncomplete', () => {
        incompleteEventFired = true;
      });

      // Simulate OLD behavior: manually send events in wrong order (type-bucketed)
      // 1. MATCH_STARTED first (as old code would emit)
      const matchStartEvent: MatchStartedEvent = {
        type: MatchEventType.MATCH_STARTED,
        timestamp: new Date('2025-12-06T18:28:53.554'),
        zoneId: 2563, // Nokhudon Proving Grounds
        bufferId: 'test-old-behavior-match',
        bracket: '2v2',
        season: 40,
        isRanked: true,
      };
      chunker.onMatchStarted(matchStartEvent);
      expect(chunker.getActiveMatchCount()).toBe(1);

      // 2. Then ZONE_CHANGE (as old code would emit AFTER match start)
      const staleZoneChange: ZoneChangeEvent = {
        type: MatchEventType.ZONE_CHANGE,
        timestamp: new Date('2025-12-06T18:27:01.023'), // Earlier timestamp, but arrives later
        zoneId: 2552, // Dornogal (different from arena)
        zoneName: 'Dornogal',
      };
      chunker.onZoneChange(staleZoneChange);

      // This simulates the bug: match is killed because zone changed while active
      expect(chunker.getActiveMatchCount()).toBe(0);
      expect(incompleteEventFired).toBe(true);

      chunker.cleanup();
    });
  });
});
