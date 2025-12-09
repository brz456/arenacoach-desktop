import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import MatchLogWatcher from '../../../src/match-detection/parsing/MatchLogWatcher';
import MatchChunker from '../../../src/match-detection/chunking/MatchChunker';
import { MetadataService } from '../../../src/services/MetadataService';
import { MetadataStorageService } from '../../../src/services/MetadataStorageService';
import { MatchStartedEvent, MatchEndedEvent } from '../../../src/match-detection/types/MatchEvent';
import {
  createTempTestDir,
  cleanupTempDir,
  loadFixtureLog,
} from '../../helpers/matchDetectionTestUtils';

/**
 * Solo Shuffle Pipeline Integration Test
 *
 * Tests the complete Solo Shuffle pipeline including:
 * - Event suppression (1 matchStarted for 6 rounds)
 * - MetadataService integration (create/finalize)
 * - W-L record calculation
 * - Round timeline with timestamps
 * - Metadata file persistence
 *
 * This mirrors shuffle-integration-test.ts behavior in Vitest format.
 */
describe('Solo Shuffle Pipeline', () => {
  let watcher: MatchLogWatcher;
  let chunker: MatchChunker;
  let metadataService: MetadataService;
  let metadataStorageService: MetadataStorageService;
  let tempLogDir: string;
  let tempOutputDir: string;
  let tempMetadataDir: string;

  beforeEach(async () => {
    tempLogDir = await createTempTestDir('shuffle-pipeline-logs-');
    tempOutputDir = await createTempTestDir('shuffle-pipeline-output-');
    tempMetadataDir = await createTempTestDir('shuffle-pipeline-metadata-');

    // Setup watcher
    watcher = new MatchLogWatcher(tempLogDir, 10);

    // Setup chunker
    chunker = new MatchChunker({
      outputDir: tempOutputDir,
      minMatchLines: 10,
      maxMatchLines: 200000,
      allowedOutputRoots: [tempOutputDir],
    });
    await chunker.init();

    // Setup metadata services
    metadataStorageService = new MetadataStorageService({
      maxFiles: 1000,
      storageDir: tempMetadataDir,
    });
    await metadataStorageService.initialize();
    metadataService = new MetadataService(metadataStorageService);

    // Wire pipeline (like MatchDetectionOrchestrator does)
    // Use a queue to ensure metadata operations complete in order
    const metadataQueue = new Map<string, Promise<void>>();

    watcher.on('matchStarted', (event: MatchStartedEvent) => {
      chunker.onMatchStarted(event);
      // Queue metadata creation
      const createPromise = metadataService.createInitialMetadata(event);
      metadataQueue.set(event.bufferId, createPromise);
    });

    watcher.on('matchEnded', async (event: MatchEndedEvent) => {
      chunker.onMatchEnded(event);
      // Wait for metadata creation to complete before finalizing
      const createPromise = metadataQueue.get(event.bufferId);
      if (createPromise) {
        await createPromise;
      }
      await metadataService.finalizeCompleteMatch(event);
    });

    watcher.on('zoneChange', event => chunker.onZoneChange(event));
    watcher.on('logChunk', lines => chunker.addLogChunk(lines));
  });

  afterEach(async () => {
    watcher.cleanup();
    chunker.cleanup();
    await cleanupTempDir(tempLogDir);
    await cleanupTempDir(tempOutputDir);
    await cleanupTempDir(tempMetadataDir);
  });

  describe('event suppression', () => {
    it('emits only 1 matchStarted event for 6-round shuffle', async () => {
      const lines = await loadFixtureLog('shuffle-single-match.txt');

      const startEvents: MatchStartedEvent[] = [];
      watcher.on('matchStarted', (e: MatchStartedEvent) => startEvents.push(e));

      const watcherAny = watcher as any;
      watcherAny.processChunkSynchronously(lines);

      await new Promise(resolve => setTimeout(resolve, 200));

      // EVENT SUPPRESSION: Only 1 start event
      expect(startEvents).toHaveLength(1);
      expect(startEvents[0].bracket).toBe('Solo Shuffle');
    });
  });

  describe('round tracking', () => {
    it('tracks all 6 rounds with metadata', async () => {
      const lines = await loadFixtureLog('shuffle-single-match.txt');

      let endEvent: MatchEndedEvent | null = null;
      watcher.on('matchEnded', (e: MatchEndedEvent) => {
        endEvent = e;
      });

      const watcherAny = watcher as any;
      watcherAny.processChunkSynchronously(lines);

      await new Promise(resolve => setTimeout(resolve, 200));

      expect(endEvent).not.toBeNull();
      expect(endEvent!.metadata.shuffleRounds).toBeDefined();
      expect(endEvent!.metadata.shuffleRounds).toHaveLength(6);

      // Verify each round has required data
      for (let i = 0; i < 6; i++) {
        const round = endEvent!.metadata.shuffleRounds![i];
        expect(round.roundNumber).toBe(i + 1);
        expect(typeof round.duration).toBe('number');
        expect(round.duration).toBeGreaterThan(0);
      }
    });

    it('tracks round timestamps for video seeking', async () => {
      const lines = await loadFixtureLog('shuffle-single-match.txt');

      let endEvent: MatchEndedEvent | null = null;
      watcher.on('matchEnded', (e: MatchEndedEvent) => {
        endEvent = e;
      });

      const watcherAny = watcher as any;
      watcherAny.processChunkSynchronously(lines);

      await new Promise(resolve => setTimeout(resolve, 200));

      expect(endEvent).not.toBeNull();
      const rounds = endEvent!.metadata.shuffleRounds!;

      // All rounds should have timestamps
      for (const round of rounds) {
        expect(typeof round.startTimestamp).toBe('number');
        expect(typeof round.endTimestamp).toBe('number');
        expect(round.endTimestamp).toBeGreaterThanOrEqual(round.startTimestamp!);
      }
    });
  });

  describe('W-L record calculation', () => {
    it('calculates wins/losses for recording player', async () => {
      const lines = await loadFixtureLog('shuffle-single-match.txt');

      let endEvent: MatchEndedEvent | null = null;
      watcher.on('matchEnded', (e: MatchEndedEvent) => {
        endEvent = e;
      });

      const watcherAny = watcher as any;
      watcherAny.processChunkSynchronously(lines);

      await new Promise(resolve => setTimeout(resolve, 200));

      expect(endEvent).not.toBeNull();
      expect(endEvent!.metadata.playerId).toBeDefined();
      expect(endEvent!.metadata.players).toBeDefined();

      // Find recording player
      const recordingPlayer = endEvent!.metadata.players!.find(
        p => p.id === endEvent!.metadata.playerId
      );

      expect(recordingPlayer).toBeDefined();
      expect(typeof recordingPlayer!.wins).toBe('number');
      expect(typeof recordingPlayer!.losses).toBe('number');

      // Wins + losses should equal 6 rounds
      expect(recordingPlayer!.wins! + recordingPlayer!.losses!).toBe(6);
    });

    it('calculates wins/losses for all players', async () => {
      const lines = await loadFixtureLog('shuffle-single-match.txt');

      let endEvent: MatchEndedEvent | null = null;
      watcher.on('matchEnded', (e: MatchEndedEvent) => {
        endEvent = e;
      });

      const watcherAny = watcher as any;
      watcherAny.processChunkSynchronously(lines);

      await new Promise(resolve => setTimeout(resolve, 200));

      expect(endEvent).not.toBeNull();
      const players = endEvent!.metadata.players!;

      // Should have 6 players in solo shuffle
      expect(players.length).toBe(6);

      // All players should have wins/losses
      for (const player of players) {
        expect(typeof player.wins).toBe('number');
        expect(typeof player.losses).toBe('number');
        // Each player's W-L should sum to 6
        expect(player.wins! + player.losses!).toBe(6);
      }
    });
  });

  describe('MetadataService integration', () => {
    it('creates metadata file on match start', async () => {
      const lines = await loadFixtureLog('shuffle-single-match.txt');

      let bufferId: string | null = null;
      watcher.on('matchStarted', (e: MatchStartedEvent) => {
        bufferId = e.bufferId;
      });

      const watcherAny = watcher as any;
      watcherAny.processChunkSynchronously(lines);

      await new Promise(resolve => setTimeout(resolve, 200));

      expect(bufferId).not.toBeNull();

      // Verify metadata file was created
      const metadataFiles = fs.readdirSync(tempMetadataDir).filter(f => f.endsWith('.json'));
      expect(metadataFiles.length).toBeGreaterThanOrEqual(1);

      // Find the file for this bufferId
      const matchFile = metadataFiles.find(f => f.includes(bufferId!));
      expect(matchFile).toBeDefined();
    });

    it('finalizes metadata with complete shuffle data', async () => {
      const lines = await loadFixtureLog('shuffle-single-match.txt');

      let bufferId: string | null = null;
      watcher.on('matchStarted', (e: MatchStartedEvent) => {
        bufferId = e.bufferId;
      });

      const watcherAny = watcher as any;
      watcherAny.processChunkSynchronously(lines);

      await new Promise(resolve => setTimeout(resolve, 300));

      expect(bufferId).not.toBeNull();

      // Load and verify stored metadata
      const storedMetadata = await metadataStorageService.loadMatchByBufferId(bufferId!);
      expect(storedMetadata).not.toBeNull();

      // Verify completion status
      expect(storedMetadata!.matchCompletionStatus).toBe('complete');

      // Verify shuffle data persisted
      expect(storedMetadata!.matchData.shuffleRounds).toBeDefined();
      expect(storedMetadata!.matchData.shuffleRounds!.length).toBe(6);

      // Verify bracket
      expect(storedMetadata!.matchData.bracket).toBe('Solo Shuffle');
    });
  });

  describe('chunk file creation', () => {
    it('creates single chunk file for entire shuffle session', async () => {
      const lines = await loadFixtureLog('shuffle-single-match.txt');

      const extractedFiles: string[] = [];
      chunker.on('matchExtracted', data => extractedFiles.push(data.filePath));

      const watcherAny = watcher as any;
      watcherAny.processChunkSynchronously(lines);

      await new Promise(resolve => setTimeout(resolve, 200));

      // Should create exactly 1 chunk file
      expect(extractedFiles).toHaveLength(1);
      expect(fs.existsSync(extractedFiles[0])).toBe(true);
    });
  });
});
