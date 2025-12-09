import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import MatchLogWatcher from '../../../src/match-detection/parsing/MatchLogWatcher';
import MatchChunker from '../../../src/match-detection/chunking/MatchChunker';
import { MatchStartedEvent, MatchEndedEvent } from '../../../src/match-detection/types/MatchEvent';
import {
  createTempTestDir,
  cleanupTempDir,
  loadFixtureLog,
  FIXTURES_LOGS_DIR,
} from '../../helpers/matchDetectionTestUtils';

/**
 * Streaming Pipeline Integration Tests
 * Tests the complete flow: MatchLogWatcher -> events -> MatchChunker -> file output
 */
describe('Streaming Pipeline', () => {
  let watcher: MatchLogWatcher;
  let chunker: MatchChunker;
  let tempDir: string;
  let outputDir: string;

  beforeEach(async () => {
    tempDir = await createTempTestDir('streaming-pipeline-');
    outputDir = path.join(tempDir, 'chunks');
    await fs.mkdir(outputDir, { recursive: true });

    watcher = new MatchLogWatcher(tempDir, 10);
    chunker = new MatchChunker({
      outputDir,
      minMatchLines: 20,
      allowedOutputRoots: [outputDir],
    });
    await chunker.init();

    // Wire up the pipeline: watcher events -> chunker
    watcher.on('matchStarted', (event: MatchStartedEvent) => {
      chunker.onMatchStarted(event);
    });
    watcher.on('matchEnded', (event: MatchEndedEvent) => {
      chunker.onMatchEnded(event);
    });
    watcher.on('logChunk', (lines: Array<{ line: string; timestamp: Date }>) => {
      chunker.addLogChunk(lines);
    });
    watcher.on('zoneChange', event => {
      chunker.onZoneChange(event);
    });
  });

  afterEach(async () => {
    chunker.cleanup();
    watcher.cleanup();
    await cleanupTempDir(tempDir);
  });

  describe('match extraction', () => {
    it('extracts match files when processing complete match', async () => {
      const extractedFiles: string[] = [];
      chunker.on('matchExtracted', ({ filePath }) => {
        extractedFiles.push(filePath);
      });

      // Simulate a complete 2v2 match with enough lines
      watcher.handleLogLine('8/3/2025 22:12:04.889  ARENA_MATCH_START,2547,33,2v2,1');

      // Add combat lines to meet minMatchLines threshold
      for (let i = 0; i < 25; i++) {
        watcher.handleLogLine(
          `8/3/2025 22:12:0${5 + i}.000  SPELL_CAST_SUCCESS,Player-123,"TestPlayer",0x511,0x0,Target-456,"TestTarget",0x10a48,0x0,12345,"Test Spell",0x1`
        );
      }

      watcher.handleLogLine('8/3/2025 22:12:30.889  ARENA_MATCH_END,0,26,1673,1668');

      // Wait for async file write
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(extractedFiles).toHaveLength(1);

      // Verify file exists and has content
      const fileContent = await fs.readFile(extractedFiles[0], 'utf-8');
      expect(fileContent.length).toBeGreaterThan(0);
      expect(fileContent).toContain('SPELL_CAST_SUCCESS');
    });

    it('skips match extraction when below minMatchLines threshold', async () => {
      const extractedFiles: string[] = [];
      const incompleteEvents: any[] = [];

      chunker.on('matchExtracted', ({ filePath }) => {
        extractedFiles.push(filePath);
      });
      chunker.on('matchEndedIncomplete', event => {
        incompleteEvents.push(event);
      });

      // Match with only a few lines (instant cancel)
      watcher.handleLogLine('8/3/2025 22:12:04.889  ARENA_MATCH_START,2547,33,2v2,1');
      watcher.handleLogLine(
        '8/3/2025 22:12:05.000  SPELL_CAST_SUCCESS,Player-123,"TestPlayer",0x511,0x0,Target-456,"TestTarget",0x10a48,0x0,12345,"Test Spell",0x1'
      );
      watcher.handleLogLine('8/3/2025 22:12:06.889  ARENA_MATCH_END,0,2,1673,1668');

      await new Promise(resolve => setTimeout(resolve, 100));

      // Should be treated as instant cancellation - no file extracted
      expect(extractedFiles).toHaveLength(0);
      expect(incompleteEvents).toHaveLength(1);
    });
  });

  describe('chunked processing', () => {
    it('handles lines arriving in multiple chunks', async () => {
      const startEvents: MatchStartedEvent[] = [];
      const endEvents: MatchEndedEvent[] = [];

      watcher.on('matchStarted', (e: MatchStartedEvent) => startEvents.push(e));
      watcher.on('matchEnded', (e: MatchEndedEvent) => endEvents.push(e));

      // First chunk: match start
      watcher.handleLogLine('8/3/2025 22:12:04.889  ARENA_MATCH_START,2547,33,2v2,1');
      expect(startEvents).toHaveLength(1);

      // Second chunk: combat lines
      for (let i = 0; i < 10; i++) {
        watcher.handleLogLine(
          `8/3/2025 22:12:${10 + i}.000  SPELL_DAMAGE,Player-123,"TestPlayer",0x511,0x0,Target-456,"TestTarget",0x10a48,0x0,12345,"Test Spell",0x1,Target-456,0,100,0,0,0,nil,nil,nil,nil,nil`
        );
      }

      // Third chunk: more combat + end
      for (let i = 0; i < 10; i++) {
        watcher.handleLogLine(
          `8/3/2025 22:12:${20 + i}.000  SPELL_HEAL,Player-123,"TestPlayer",0x511,0x0,Target-456,"TestTarget",0x10a48,0x0,12345,"Test Heal",0x1,Target-456,0,100,0,0,0,nil,nil,nil,nil,nil`
        );
      }
      watcher.handleLogLine('8/3/2025 22:12:35.889  ARENA_MATCH_END,0,31,1673,1668');

      // Wait for async finalization
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(endEvents).toHaveLength(1);
      expect(chunker.getActiveMatchCount()).toBe(0);
    });
  });

  describe('zone change handling', () => {
    it('ends active match on zone change', async () => {
      const incompleteEvents: any[] = [];
      chunker.on('matchEndedIncomplete', event => {
        incompleteEvents.push(event);
      });

      // Start match
      watcher.handleLogLine('8/3/2025 22:12:04.889  ARENA_MATCH_START,2547,33,2v2,1');
      expect(chunker.getActiveMatchCount()).toBe(1);

      // Zone change to non-arena
      watcher.handleLogLine('8/3/2025 22:12:10.000  ZONE_CHANGE,2222,"Revendreth",0');

      expect(incompleteEvents).toHaveLength(1);
      expect(chunker.getActiveMatchCount()).toBe(0);
    });
  });

  describe('fixture-based processing', { timeout: 30000 }, () => {
    it('processes split shuffle session files correctly', async () => {
      // Check if fixtures exist
      const part1Path = path.join(FIXTURES_LOGS_DIR, 'shuffle-session-part1.txt');
      const part2Path = path.join(FIXTURES_LOGS_DIR, 'shuffle-session-part2.txt');

      let part1Exists = false;
      let part2Exists = false;

      try {
        await fs.access(part1Path);
        part1Exists = true;
        await fs.access(part2Path);
        part2Exists = true;
      } catch {
        // Fixtures don't exist, skip test
      }

      if (!part1Exists || !part2Exists) {
        console.log('Skipping fixture-based test: fixtures not available');
        return;
      }

      const startEvents: MatchStartedEvent[] = [];
      const endEvents: MatchEndedEvent[] = [];
      const extractedFiles: string[] = [];

      watcher.on('matchStarted', (e: MatchStartedEvent) => startEvents.push(e));
      watcher.on('matchEnded', (e: MatchEndedEvent) => endEvents.push(e));
      chunker.on('matchExtracted', ({ filePath }) => {
        extractedFiles.push(filePath);
      });

      // Process part 1 (simulates first half of streaming)
      const part1Lines = await loadFixtureLog('shuffle-session-part1.txt');
      for (const line of part1Lines) {
        watcher.handleLogLine(line);
      }

      // Process part 2 (simulates second half of streaming)
      const part2Lines = await loadFixtureLog('shuffle-session-part2.txt');
      for (const line of part2Lines) {
        watcher.handleLogLine(line);
      }

      // Wait for async file writes
      await new Promise(resolve => setTimeout(resolve, 200));

      // Solo Shuffle should have multiple rounds detected
      console.log(
        `Processed ${part1Lines.length + part2Lines.length} lines, detected ${startEvents.length} starts, ${endEvents.length} ends, extracted ${extractedFiles.length} files`
      );

      // Basic sanity: we should see at least one match start and end
      expect(startEvents.length).toBeGreaterThanOrEqual(1);
    });
  });
});
