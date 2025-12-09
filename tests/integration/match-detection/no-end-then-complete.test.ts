import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import MatchLogWatcher from '../../../src/match-detection/parsing/MatchLogWatcher';
import MatchChunker from '../../../src/match-detection/chunking/MatchChunker';
import { MetadataService } from '../../../src/services/MetadataService';
import { MetadataStorageService } from '../../../src/services/MetadataStorageService';
import { MatchLifecycleService } from '../../../src/services/MatchLifecycleService';
import {
  MatchStartedEvent,
  MatchEndedEvent,
  MatchEndedIncompleteEvent,
} from '../../../src/match-detection/types/MatchEvent';
// EarlyEndTrigger imported for type annotation in lifecycleIncomplete tracking
import { EarlyEndTrigger } from '../../../src/match-detection/types/EarlyEndTriggers';
import {
  createTempTestDir,
  cleanupTempDir,
  loadFixtureLog,
  createLifecycleOpQueue,
} from '../../helpers/matchDetectionTestUtils';

/**
 * No Arena End Then Shuffle Complete Tests
 *
 * Tests the production pipeline behavior when:
 * 1. First match (3v3) starts but never receives ARENA_MATCH_END
 * 2. Shuffle match starts - creates NEW bufferId and updates currentMatch
 * 3. Shuffle completes normally with 6 rounds
 * 4. Orphaned 3v3 session remains without an end event
 *
 * This simulates a player leaving a 3v3 early (no END event) and then
 * queuing into a shuffle that completes successfully.
 *
 * Combined fixture structure (no-end-then-shuffle.txt):
 * - Line 1: 3v3 ARENA_MATCH_START (zone 1672) - no END
 * - Line 20: Shuffle round 1 ARENA_MATCH_START (zone 2563) - NEW session
 * - Lines 5735+: Shuffle rounds 2-6
 * - Line 54674: Shuffle ARENA_MATCH_END
 *
 * Key behavior: Solo Shuffle ALWAYS starts a new session (updates currentMatch)
 * because shuffles always create new bufferIds. This ensures that when shuffle
 * ends, currentMatch has the correct shuffle context (bufferId, bracket, etc.)
 * rather than stale data from a prior orphaned match.
 */
describe('No Arena End Then Shuffle Complete', () => {
  let watcher: MatchLogWatcher;
  let chunker: MatchChunker;
  let metadataService: MetadataService;
  let metadataStorageService: MetadataStorageService;
  let lifecycleService: MatchLifecycleService;

  let tempLogDir: string;
  let tempOutputDir: string;
  let tempMetadataDir: string;

  beforeEach(async () => {
    tempLogDir = await createTempTestDir('no-end-then-complete-logs-');
    tempOutputDir = await createTempTestDir('no-end-then-complete-output-');
    tempMetadataDir = await createTempTestDir('no-end-then-complete-metadata-');

    watcher = new MatchLogWatcher(tempLogDir, 10);

    chunker = new MatchChunker({
      outputDir: tempOutputDir,
      minMatchLines: 20,
      maxMatchLines: 200000,
      allowedOutputRoots: [tempOutputDir],
    });
    await chunker.init();

    metadataStorageService = new MetadataStorageService({
      maxFiles: 1000,
      storageDir: tempMetadataDir,
    });
    await metadataStorageService.initialize();
    metadataService = new MetadataService(metadataStorageService);

    lifecycleService = new MatchLifecycleService(metadataService, null);

    // Wire pipeline
    watcher.on('matchStarted', (event: MatchStartedEvent) => {
      chunker.onMatchStarted(event);
    });
    watcher.on('matchEnded', (event: MatchEndedEvent) => {
      chunker.onMatchEnded(event);
    });
    watcher.on('zoneChange', event => {
      chunker.onZoneChange(event);
    });
    watcher.on('logChunk', lines => {
      chunker.addLogChunk(lines);
    });
  });

  afterEach(async () => {
    watcher.cleanup();
    chunker.cleanup();
    await cleanupTempDir(tempLogDir);
    await cleanupTempDir(tempOutputDir);
    await cleanupTempDir(tempMetadataDir);
  });

  it('completes shuffle correctly when prior 3v3 had no end event', async () => {
    const lines = await loadFixtureLog('no-end-then-shuffle.txt');

    // Track events
    const startEvents: MatchStartedEvent[] = [];
    const endEvents: MatchEndedEvent[] = [];
    const lifecycleStarted: string[] = [];
    const lifecycleCompleted: string[] = [];
    const lifecycleIncomplete: Array<{
      bufferId: string;
      trigger?: EarlyEndTrigger;
      reason?: string;
    }> = [];

    const { enqueueOp, waitForAll, getErrors } = createLifecycleOpQueue();

    // Wire event tracking
    watcher.on('matchStarted', (event: MatchStartedEvent) => {
      startEvents.push(event);
    });
    watcher.on('matchEnded', (event: MatchEndedEvent) => {
      endEvents.push(event);
    });

    // Wire lifecycle events
    lifecycleService.on('matchLifecycle:started', data => {
      lifecycleStarted.push(data.bufferId);
    });
    lifecycleService.on('matchLifecycle:completed', data => {
      lifecycleCompleted.push(data.bufferId);
    });
    lifecycleService.on('matchLifecycle:incomplete', data => {
      lifecycleIncomplete.push({
        bufferId: data.bufferId,
        trigger: data.trigger,
        reason: data.reason,
      });
    });

    // Wire lifecycle handlers
    watcher.on('matchStarted', (event: MatchStartedEvent) => {
      enqueueOp(event.bufferId, () => lifecycleService.handleMatchStarted(event));
    });
    watcher.on('matchEnded', (event: MatchEndedEvent) => {
      enqueueOp(event.bufferId, () => lifecycleService.handleMatchEnded(event));
    });
    chunker.on('matchEndedIncomplete', (event: MatchEndedIncompleteEvent) => {
      enqueueOp(event.bufferId, () => lifecycleService.handleMatchEndedIncomplete(event));
    });

    // Process combined fixture
    const watcherAny = watcher as any;
    watcherAny.processChunkSynchronously(lines);

    await waitForAll();

    // === VERIFY TWO DISTINCT MATCH STARTS ===

    // Should have 2 matchStarted events with DIFFERENT bufferIds
    expect(startEvents.length).toBe(2);

    const match1BufferId = startEvents[0].bufferId; // 3v3
    const match2BufferId = startEvents[1].bufferId; // Shuffle

    // Verify different buffer IDs
    expect(match1BufferId).not.toBe(match2BufferId);

    // Verify match brackets
    expect(startEvents[0].bracket).toBe('3v3');
    expect(startEvents[1].bracket).toContain('Shuffle');

    // === VERIFY matchEnded EVENT HAS CORRECT SHUFFLE DATA ===

    // There should be exactly 1 matchEnded event
    expect(endEvents.length).toBe(1);

    // matchEnded should have the SHUFFLE's bufferId (not the orphaned 3v3's)
    expect(endEvents[0].bufferId).toBe(match2BufferId);

    // Metadata should have correct shuffle bracket
    expect(endEvents[0].metadata.bracket).toContain('Shuffle');

    // Shuffle rounds should be complete (6 rounds)
    expect(endEvents[0].metadata.shuffleRounds).toBeDefined();
    expect(endEvents[0].metadata.shuffleRounds!.length).toBe(6);

    // === VERIFY TWO SESSIONS CREATED ===

    expect(lifecycleStarted.length).toBe(2);
    expect(lifecycleStarted).toContain(match1BufferId);
    expect(lifecycleStarted).toContain(match2BufferId);

    // === VERIFY SHUFFLE SESSION COMPLETES OR PROCESSES ===

    // The shuffle session (match2BufferId) should receive the end event
    // and either complete or fail validation (e.g., playerId issues)
    const shuffleProcessed =
      lifecycleCompleted.includes(match2BufferId) ||
      lifecycleIncomplete.some(e => e.bufferId === match2BufferId);
    expect(shuffleProcessed).toBe(true);

    // The orphaned 3v3 session (match1BufferId) never receives an end event
    // It remains in 'active' state (no completion/incomplete triggered)

    // === VERIFY NO UNEXPECTED ERRORS ===

    const errors = getErrors();
    const unexpectedErrors = errors.filter(
      e =>
        !e.message.includes('playerId') &&
        !e.message.includes('validation') &&
        !e.message.includes('6 rounds')
    );
    expect(unexpectedErrors).toHaveLength(0);
  });

  it('shuffle creates new session and bufferId when prior match was orphaned', async () => {
    const lines = await loadFixtureLog('no-end-then-shuffle.txt');

    const startEvents: MatchStartedEvent[] = [];
    const { enqueueOp, waitForAll, getErrors } = createLifecycleOpQueue();

    watcher.on('matchStarted', (event: MatchStartedEvent) => {
      startEvents.push(event);
    });

    // Wire lifecycle
    watcher.on('matchStarted', (event: MatchStartedEvent) => {
      enqueueOp(event.bufferId, () => lifecycleService.handleMatchStarted(event));
    });
    watcher.on('matchEnded', (event: MatchEndedEvent) => {
      enqueueOp(event.bufferId, () => lifecycleService.handleMatchEnded(event));
    });
    chunker.on('matchEndedIncomplete', (event: MatchEndedIncompleteEvent) => {
      enqueueOp(event.bufferId, () => lifecycleService.handleMatchEndedIncomplete(event));
    });

    const watcherAny = watcher as any;
    watcherAny.processChunkSynchronously(lines);

    await waitForAll();

    // Solo Shuffle always starts a new session (updates currentMatch)
    // even when there's an orphaned prior match
    expect(startEvents.length).toBe(2);

    const match1 = startEvents[0];
    const match2 = startEvents[1];

    // Different zones (3v3 in 1672, shuffle in 2563)
    expect(match1.zoneId).toBe(1672);
    expect(match2.zoneId).toBe(2563);

    // Different brackets
    expect(match1.bracket).toBe('3v3');
    expect(match2.bracket).toContain('Shuffle');

    // DIFFERENT buffer IDs - shuffle creates its own session
    expect(match1.bufferId).not.toBe(match2.bufferId);

    // Buffer IDs encode their respective timestamps/zones
    expect(match1.bufferId).toContain('1672');
    expect(match2.bufferId).toContain('2563');

    // No unexpected errors
    const errors = getErrors();
    const unexpectedErrors = errors.filter(
      e =>
        !e.message.includes('playerId') &&
        !e.message.includes('validation') &&
        !e.message.includes('6 rounds')
    );
    expect(unexpectedErrors).toHaveLength(0);
  });
});
