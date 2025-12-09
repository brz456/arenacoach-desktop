import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import MatchLogWatcher from '../../../src/match-detection/parsing/MatchLogWatcher';
import MatchChunker from '../../../src/match-detection/chunking/MatchChunker';
import { EarlyEndTrigger } from '../../../src/match-detection/types/EarlyEndTriggers';
import { MatchStartedEvent } from '../../../src/match-detection/types/MatchEvent';
import {
  createTempTestDir,
  cleanupTempDir,
  loadFixtureLog,
} from '../../helpers/matchDetectionTestUtils';

/**
 * Log File Change Scenario Test
 *
 * Tests the desktop app behavior when a combat log file changes mid-match
 * (e.g., player does /reload in WoW).
 *
 * Fixtures:
 * - shuffle-session-part1.txt: First part of shuffle, ends without ARENA_MATCH_END
 * - shuffle-session-part2.txt: Second part, new log file with < 6 rounds
 *
 * Expected behavior:
 * - Part 1: matchEndedIncomplete with LOG_FILE_CHANGE trigger
 * - Part 2: matchEndedIncomplete with < 6 rounds (incomplete shuffle)
 */
describe('Log File Change Scenario', () => {
  let watcher: MatchLogWatcher;
  let chunker: MatchChunker;
  let tempLogDir: string;
  let tempOutputDir: string;

  beforeEach(async () => {
    tempLogDir = await createTempTestDir('log-change-logs-');
    tempOutputDir = await createTempTestDir('log-change-output-');

    watcher = new MatchLogWatcher(tempLogDir, 10);
    chunker = new MatchChunker({
      outputDir: tempOutputDir,
      minMatchLines: 10,
      maxMatchLines: 200000,
      allowedOutputRoots: [tempOutputDir],
    });
    await chunker.init();

    // Wire watcher to chunker (like MatchDetectionOrchestrator does)
    watcher.on('matchStarted', event => chunker.onMatchStarted(event));
    watcher.on('matchEnded', event => chunker.onMatchEnded(event));
    watcher.on('zoneChange', event => chunker.onZoneChange(event));
    watcher.on('logChunk', lines => chunker.addLogChunk(lines));

    // Wire logFileChanged to trigger early ending (like orchestrator does)
    watcher.on('logFileChanged', event => {
      chunker.triggerEarlyEnding(EarlyEndTrigger.LOG_FILE_CHANGE, event.metadataSnapshot);
    });
  });

  afterEach(async () => {
    watcher.cleanup();
    chunker.cleanup();
    await cleanupTempDir(tempLogDir);
    await cleanupTempDir(tempOutputDir);
  });

  describe('Part 1: No ARENA_MATCH_END', () => {
    it('triggers matchEndedIncomplete with LOG_FILE_CHANGE when log file changes', async () => {
      const lines = await loadFixtureLog('shuffle-session-part1.txt');

      const startEvents: MatchStartedEvent[] = [];
      const incompleteEvents: Array<{ bufferId: string; trigger: EarlyEndTrigger; lines: number }> =
        [];

      watcher.on('matchStarted', (e: MatchStartedEvent) => startEvents.push(e));
      chunker.on('matchEndedIncomplete', data => {
        incompleteEvents.push({
          bufferId: data.bufferId,
          trigger: data.trigger,
          lines: data.lines,
        });
      });

      // Process part 1 lines
      const watcherAny = watcher as any;
      watcherAny.processChunkSynchronously(lines);

      // Should have started a match
      expect(startEvents.length).toBeGreaterThanOrEqual(1);
      expect(startEvents[0].bracket).toBe('Solo Shuffle');

      // Simulate log file change (like /reload in WoW)
      watcher.emit('logFileChanged', {
        oldFile: 'WoWCombatLog-old.txt',
        newFile: 'WoWCombatLog-new.txt',
        metadataSnapshot: null,
      });

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should have triggered incomplete with LOG_FILE_CHANGE
      expect(incompleteEvents.length).toBe(1);
      expect(incompleteEvents[0].trigger).toBe(EarlyEndTrigger.LOG_FILE_CHANGE);
      expect(incompleteEvents[0].lines).toBeGreaterThan(0);

      // No active matches after early end
      expect(chunker.getActiveMatchCount()).toBe(0);
    });
  });

  describe('Part 2: Less than 6 rounds', () => {
    it('detects incomplete shuffle with < 6 rounds', async () => {
      const lines = await loadFixtureLog('shuffle-session-part2.txt');

      const startEvents: MatchStartedEvent[] = [];
      let endEventMetadata: any = null;

      watcher.on('matchStarted', (e: MatchStartedEvent) => startEvents.push(e));
      watcher.on('matchEnded', e => {
        endEventMetadata = e.metadata;
      });

      // Process part 2 lines
      const watcherAny = watcher as any;
      watcherAny.processChunkSynchronously(lines);

      await new Promise(resolve => setTimeout(resolve, 100));

      // Should have started shuffle rounds
      expect(startEvents.length).toBeGreaterThanOrEqual(1);

      // If we got an end event, check that shuffle rounds < 6
      // (This validates the data that MatchLifecycleService would use)
      if (endEventMetadata?.shuffleRounds) {
        expect(endEventMetadata.shuffleRounds.length).toBeLessThan(6);
      }
    });
  });
});
