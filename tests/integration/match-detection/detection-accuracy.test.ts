import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import MatchLogWatcher from '../../../src/match-detection/parsing/MatchLogWatcher';
import MatchChunker from '../../../src/match-detection/chunking/MatchChunker';
import { MatchStartedEvent, MatchEndedEvent } from '../../../src/match-detection/types/MatchEvent';
import {
  createTempTestDir,
  cleanupTempDir,
  loadFixtureLog,
} from '../../helpers/matchDetectionTestUtils';

/**
 * Detection Accuracy Test Suite
 *
 * Tests the desktop app's match detection pipeline using real combat log fixtures
 * and synthetic edge cases. Exercises MatchLogWatcher -> MatchChunker flow.
 *
 * If MatchLogWatcher or MatchChunker behavior changes, these tests MUST break.
 */

/** Accuracy target for aggregate detection tests */
const MATCH_DETECTION_ACCURACY_TARGET = 0.95;

describe('Match Detection Accuracy', () => {
  let watcher: MatchLogWatcher;
  let chunker: MatchChunker;
  let tempLogDir: string;
  let tempOutputDir: string;

  beforeEach(async () => {
    tempLogDir = await createTempTestDir('detection-logs-');
    tempOutputDir = await createTempTestDir('detection-output-');

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
  });

  afterEach(async () => {
    watcher.cleanup();
    chunker.cleanup();
    await cleanupTempDir(tempLogDir);
    await cleanupTempDir(tempOutputDir);
  });

  /**
   * Helper to process lines through the watcher using public API
   */
  function processLines(lines: string[]): void {
    for (const line of lines) {
      watcher.handleLogLine(line);
    }
  }

  describe('fixture-based detection (real combat logs)', () => {
    it('detects 2v2 match with correct metadata from fixture', async () => {
      const lines = await loadFixtureLog('2v2-single-match.txt');

      const startEvents: MatchStartedEvent[] = [];
      const endEvents: MatchEndedEvent[] = [];
      const extractedFiles: string[] = [];

      watcher.on('matchStarted', (e: MatchStartedEvent) => startEvents.push(e));
      watcher.on('matchEnded', (e: MatchEndedEvent) => endEvents.push(e));
      chunker.on('matchExtracted', data => extractedFiles.push(data.filePath));

      processLines(lines);

      // Wait for async file operations
      await new Promise(resolve => setTimeout(resolve, 200));

      // Should emit exactly 1 start and 1 end event
      expect(startEvents).toHaveLength(1);
      expect(endEvents).toHaveLength(1);

      // Verify start metadata
      expect(startEvents[0].bracket).toBe('2v2');
      expect(startEvents[0].zoneId).toBe(1505); // Nagrand Arena
      expect(startEvents[0].isRanked).toBe(true);
      expect(startEvents[0].season).toBe(40);

      // Verify end metadata
      expect(endEvents[0].metadata.matchDuration).toBe(282);
      expect(endEvents[0].metadata.team0MMR).toBe(1899);
      expect(endEvents[0].metadata.team1MMR).toBe(1915);
      expect(endEvents[0].metadata.bracket).toBe('2v2');

      // Verify players extracted (4 for 2v2)
      expect(endEvents[0].metadata.players).toHaveLength(4);

      // Should create chunk file
      expect(extractedFiles.length).toBeGreaterThanOrEqual(1);
    });

    it('detects 3v3 match with correct metadata from fixture', async () => {
      const lines = await loadFixtureLog('3v3-single-match.txt');

      const startEvents: MatchStartedEvent[] = [];
      const endEvents: MatchEndedEvent[] = [];

      watcher.on('matchStarted', (e: MatchStartedEvent) => startEvents.push(e));
      watcher.on('matchEnded', (e: MatchEndedEvent) => endEvents.push(e));

      processLines(lines);

      await new Promise(resolve => setTimeout(resolve, 200));

      // Should emit exactly 1 start and 1 end event
      expect(startEvents).toHaveLength(1);
      expect(endEvents).toHaveLength(1);

      // Verify start metadata
      expect(startEvents[0].bracket).toBe('3v3');
      expect(startEvents[0].zoneId).toBe(1505); // Nagrand Arena
      expect(startEvents[0].isRanked).toBe(true);
      expect(startEvents[0].season).toBe(39);

      // Verify end metadata
      expect(endEvents[0].metadata.matchDuration).toBe(90);
      expect(endEvents[0].metadata.team0MMR).toBe(2064);
      expect(endEvents[0].metadata.team1MMR).toBe(1864);

      // Verify players extracted (6 for 3v3)
      expect(endEvents[0].metadata.players).toHaveLength(6);
    });

    it('detects Solo Shuffle with event suppression from fixture', async () => {
      const lines = await loadFixtureLog('shuffle-single-match.txt');

      const startEvents: MatchStartedEvent[] = [];
      const endEvents: MatchEndedEvent[] = [];

      watcher.on('matchStarted', (e: MatchStartedEvent) => startEvents.push(e));
      watcher.on('matchEnded', (e: MatchEndedEvent) => endEvents.push(e));

      processLines(lines);

      await new Promise(resolve => setTimeout(resolve, 200));

      // EVENT SUPPRESSION: Only 1 start event even though log has 6 ARENA_MATCH_START
      expect(startEvents).toHaveLength(1);
      expect(startEvents[0].bracket).toBe('Solo Shuffle');

      // Should have 1 end event
      expect(endEvents).toHaveLength(1);

      // Should have shuffle round data
      expect(endEvents[0].metadata.shuffleRounds).toBeDefined();
      expect(endEvents[0].metadata.shuffleRounds).toHaveLength(6);
    });
  });

  describe('synthetic scenario detection', () => {
    /**
     * Test scenarios covering different arena types and formats.
     * These ensure specific parsing behaviors are tested.
     */
    const testScenarios = [
      {
        name: '2v2 Arena Match',
        startLine: '8/3/2025 22:12:04.889  ARENA_MATCH_START,2547,33,2v2,1',
        endLine: '8/3/2025 22:12:14.889  ARENA_MATCH_END,0,8,1673,1668',
        expectedCategory: '2v2',
        expectedZoneId: 2547,
        expectedDuration: 8,
        shouldBeSkipped: false,
      },
      {
        name: '3v3 Arena Match',
        startLine: '7/15/2025 19:30:12.456  ARENA_MATCH_START,617,45,3v3,1',
        endLine: '7/15/2025 19:35:45.123  ARENA_MATCH_END,1,12,2834,2801',
        expectedCategory: '3v3',
        expectedZoneId: 617,
        expectedDuration: 12,
        shouldBeSkipped: false,
      },
      {
        name: 'Skirmish Match (should be filtered)',
        startLine: '6/22/2025 14:05:33.222  ARENA_MATCH_START,1552,21,Skirmish,0',
        endLine: '6/22/2025 14:08:15.777  ARENA_MATCH_END,0,5,1829,1824',
        expectedCategory: 'Skirmish',
        expectedZoneId: 1552,
        expectedDuration: 5,
        shouldBeSkipped: true, // Parser filters unranked matches
      },
      {
        name: 'Solo Shuffle Match',
        startLine: '9/1/2025 20:15:30.100  ARENA_MATCH_START,2547,33,Rated Solo Shuffle,3',
        endLine: '9/1/2025 20:18:45.950  ARENA_MATCH_END,1,15,2156,2143',
        expectedCategory: 'Solo Shuffle', // Parser normalizes "Rated Solo Shuffle"
        expectedZoneId: 2547,
        expectedDuration: 15,
        shouldBeSkipped: false,
      },
      {
        name: 'TWW Format Arena (with year in timestamp)',
        startLine: '7/27/2024 21:39:13.095  ARENA_MATCH_START,2547,33,2v2,1',
        endLine: '7/27/2024 21:42:08.456  ARENA_MATCH_END,0,8,1764,1759',
        expectedCategory: '2v2',
        expectedZoneId: 2547,
        expectedDuration: 8,
        shouldBeSkipped: false,
      },
    ];

    it.each(testScenarios.filter(s => !s.shouldBeSkipped))(
      'detects $name correctly',
      async scenario => {
        let startEvent: MatchStartedEvent | null = null;
        let endEvent: MatchEndedEvent | null = null;

        watcher.on('matchStarted', (e: MatchStartedEvent) => {
          startEvent = e;
        });
        watcher.on('matchEnded', (e: MatchEndedEvent) => {
          endEvent = e;
        });

        watcher.handleLogLine(scenario.startLine);
        watcher.handleLogLine(scenario.endLine);

        expect(startEvent).not.toBeNull();
        expect(endEvent).not.toBeNull();

        expect(startEvent!.zoneId).toBe(scenario.expectedZoneId);
        expect(endEvent!.metadata.bracket).toBe(scenario.expectedCategory);
        expect(endEvent!.metadata.matchDuration).toBeDefined();

        // Duration tolerance of ±1 second
        expect(
          Math.abs(endEvent!.metadata.matchDuration! - scenario.expectedDuration)
        ).toBeLessThanOrEqual(1);
      }
    );

    it('filters Skirmish matches (unranked)', () => {
      const skirmishScenario = testScenarios.find(s => s.shouldBeSkipped);
      const startEvents: MatchStartedEvent[] = [];

      watcher.on('matchStarted', (e: MatchStartedEvent) => startEvents.push(e));

      watcher.handleLogLine(skirmishScenario!.startLine);

      // Skirmish (isRanked=0) should be filtered out
      expect(startEvents).toHaveLength(0);
    });

    it('meets accuracy target across all valid scenarios', () => {
      const validScenarios = testScenarios.filter(s => !s.shouldBeSkipped);
      let passed = 0;

      for (const scenario of validScenarios) {
        const startEvents: MatchStartedEvent[] = [];
        const endEvents: MatchEndedEvent[] = [];

        // Fresh listeners for each scenario
        const startHandler = (e: MatchStartedEvent) => startEvents.push(e);
        const endHandler = (e: MatchEndedEvent) => endEvents.push(e);

        watcher.on('matchStarted', startHandler);
        watcher.on('matchEnded', endHandler);

        watcher.handleLogLine(scenario.startLine);
        watcher.handleLogLine(scenario.endLine);

        const startEvent = startEvents[0];
        const endEvent = endEvents[0];
        const detected =
          startEvents.length === 1 &&
          endEvents.length === 1 &&
          startEvent !== undefined &&
          endEvent !== undefined &&
          startEvent.zoneId === scenario.expectedZoneId &&
          endEvent.metadata.bracket === scenario.expectedCategory;

        if (detected) passed++;

        watcher.removeListener('matchStarted', startHandler);
        watcher.removeListener('matchEnded', endHandler);
      }

      const accuracy = passed / validScenarios.length;
      expect(accuracy).toBeGreaterThanOrEqual(MATCH_DETECTION_ACCURACY_TARGET);
    });
  });

  describe('error handling', () => {
    it('handles invalid arena type without crashing', () => {
      const startEvents: MatchStartedEvent[] = [];
      watcher.on('matchStarted', (e: MatchStartedEvent) => startEvents.push(e));

      // Should not throw, may or may not emit event depending on implementation
      expect(() => {
        watcher.handleLogLine('8/3/2025 22:12:04.889  ARENA_MATCH_START,2547,33,UnknownType,1');
      }).not.toThrow();
    });

    it('handles malformed start event without crashing', () => {
      const startEvents: MatchStartedEvent[] = [];
      watcher.on('matchStarted', (e: MatchStartedEvent) => startEvents.push(e));

      expect(() => {
        watcher.handleLogLine('8/3/2025 22:12:04.889  ARENA_MATCH_START,invalid,data');
      }).not.toThrow();

      // Malformed events should not produce match events
      expect(startEvents).toHaveLength(0);
    });

    it('ignores non-arena events', () => {
      const startEvents: MatchStartedEvent[] = [];
      const endEvents: MatchEndedEvent[] = [];

      watcher.on('matchStarted', (e: MatchStartedEvent) => startEvents.push(e));
      watcher.on('matchEnded', (e: MatchEndedEvent) => endEvents.push(e));

      watcher.handleLogLine(
        '8/3/2025 22:12:04.889  SPELL_CAST_SUCCESS,Player-123,PlayerName,0x511,0x0,Target-456,TargetName,0x10a48,0x0,12345,"Spell Name",0x1'
      );

      expect(startEvents).toHaveLength(0);
      expect(endEvents).toHaveLength(0);
    });

    it('ignores end events without corresponding start', () => {
      const endEvents: MatchEndedEvent[] = [];
      watcher.on('matchEnded', (e: MatchEndedEvent) => endEvents.push(e));

      watcher.handleLogLine('12/6/2025 18:42:21.3501  ARENA_MATCH_END,0,282,1899,1915');

      expect(endEvents).toHaveLength(0);
    });
  });

  describe('bufferId correlation', () => {
    it('correlates start and end events via bufferId', async () => {
      const lines = await loadFixtureLog('2v2-single-match.txt');

      let startEvent: MatchStartedEvent | null = null;
      let endEvent: MatchEndedEvent | null = null;

      watcher.on('matchStarted', (e: MatchStartedEvent) => {
        startEvent = e;
      });
      watcher.on('matchEnded', (e: MatchEndedEvent) => {
        endEvent = e;
      });

      processLines(lines);

      await new Promise(resolve => setTimeout(resolve, 200));

      expect(startEvent).not.toBeNull();
      expect(endEvent).not.toBeNull();
      expect(startEvent!.bufferId).toBeDefined();
      expect(endEvent!.bufferId).toBe(startEvent!.bufferId);
    });
  });

  describe('chunk file creation', () => {
    it('creates chunk file for complete match', async () => {
      const lines = await loadFixtureLog('2v2-single-match.txt');

      const extractedFiles: string[] = [];
      chunker.on('matchExtracted', data => extractedFiles.push(data.filePath));

      processLines(lines);

      await new Promise(resolve => setTimeout(resolve, 200));

      expect(extractedFiles).toHaveLength(1);
    });

    it('creates single chunk file for entire shuffle session (not 6)', async () => {
      const lines = await loadFixtureLog('shuffle-single-match.txt');

      const extractedFiles: string[] = [];
      chunker.on('matchExtracted', data => extractedFiles.push(data.filePath));

      processLines(lines);

      await new Promise(resolve => setTimeout(resolve, 200));

      // Should create exactly 1 chunk file (not 6)
      expect(extractedFiles).toHaveLength(1);
    });
  });
});
