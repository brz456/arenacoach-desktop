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
 * Shuffle Reloads (Missing Round Win) Integration Tests
 *
 * Tests the production pipeline behavior when a Solo Shuffle has structural issues:
 * - 6 ARENA_MATCH_START events (one per round)
 * - 1 ARENA_MATCH_END event
 * - Only 5 kills detected (one round missing a kill)
 *
 * The fixture (shuffle-reloads.txt) represents a shuffle where one round's
 * kill was not captured in the combat log. This results in:
 * - 6 rounds tracked (all ARENA_MATCH_START events)
 * - Only 5 rounds have winningTeamId (from UNIT_DIED events)
 * - W-L record (e.g., 4-1) doesn't equal round count (6)
 *
 * Expected behavior:
 * 1. MatchLogWatcher emits matchStarted for first round only
 * 2. ShuffleRoundTracker tracks all 6 rounds via ARENA_MATCH_START events
 * 3. Only 5 rounds get winners determined by UNIT_DIED events
 * 4. Validation fails: "W-L record (X-Y) must equal round count (6)"
 * 5. Match marked as VALIDATION_FAILED/incomplete
 * 6. Metadata is PRESERVED (for debugging/local viewing)
 * 7. No upload attempted
 *
 * Key invariants:
 * - Only ONE matchStarted event (first round)
 * - shuffleRounds array contains 6 entries
 * - At least one round missing winningTeamId
 * - Match fails validation due to W-L mismatch
 * - Metadata preserved with incomplete status
 */
describe('Shuffle Reloads - Missing Round Wins', () => {
  let watcher: MatchLogWatcher;
  let chunker: MatchChunker;
  let metadataService: MetadataService;
  let metadataStorageService: MetadataStorageService;
  let lifecycleService: MatchLifecycleService;

  let tempLogDir: string;
  let tempOutputDir: string;
  let tempMetadataDir: string;

  beforeEach(async () => {
    tempLogDir = await createTempTestDir('shuffle-reloads-logs-');
    tempOutputDir = await createTempTestDir('shuffle-reloads-output-');
    tempMetadataDir = await createTempTestDir('shuffle-reloads-metadata-');

    // Setup watcher
    watcher = new MatchLogWatcher(tempLogDir, 10);

    // Setup chunker with production defaults
    chunker = new MatchChunker({
      outputDir: tempOutputDir,
      minMatchLines: 20,
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

    // Setup lifecycle service (no recording service)
    lifecycleService = new MatchLifecycleService(metadataService, null);

    // Wire pipeline exactly as production
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

  it('invalidates shuffle with 5 kills for 6 rounds (W-L mismatch)', async () => {
    const lines = await loadFixtureLog('shuffle-reloads.txt');

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

    // Wire lifecycle handlers with queue
    watcher.on('matchStarted', (event: MatchStartedEvent) => {
      enqueueOp(event.bufferId, () => lifecycleService.handleMatchStarted(event));
    });
    watcher.on('matchEnded', (event: MatchEndedEvent) => {
      enqueueOp(event.bufferId, () => lifecycleService.handleMatchEnded(event));
    });
    chunker.on('matchEndedIncomplete', (event: MatchEndedIncompleteEvent) => {
      enqueueOp(event.bufferId, () => lifecycleService.handleMatchEndedIncomplete(event));
    });

    // Process fixture
    const watcherAny = watcher as any;
    watcherAny.processChunkSynchronously(lines);

    await waitForAll();

    // === VERIFY SINGLE SESSION ===

    expect(startEvents.length).toBe(1);
    const bufferId = startEvents[0].bufferId;
    expect(startEvents[0].bracket).toContain('Shuffle');
    expect(lifecycleStarted).toHaveLength(1);

    // === VERIFY 6 ROUNDS TRACKED ===

    expect(endEvents).toHaveLength(1);
    expect(endEvents[0].metadata.shuffleRounds).toBeDefined();
    expect(endEvents[0].metadata.shuffleRounds!.length).toBe(6);

    // === VERIFY MISSING ROUND WINNER (core invariant) ===

    // This fixture MUST have at least one round missing a winner (only 5 kills)
    const roundsMissingWinner = endEvents[0].metadata.shuffleRounds!.filter(
      r => r.winningTeamId === undefined
    );
    expect(roundsMissingWinner.length).toBeGreaterThan(0); // Core scenario invariant

    // Equivalently: fewer than 6 rounds have winners
    const roundsWithWinners = endEvents[0].metadata.shuffleRounds!.filter(
      r => r.winningTeamId !== undefined
    );
    expect(roundsWithWinners.length).toBeLessThan(6);

    // === VERIFY VALIDATION FAILURE ===

    // Match should NOT complete (validation fails)
    expect(lifecycleCompleted).toHaveLength(0);

    // Match should be marked incomplete with VALIDATION_FAILED trigger
    expect(lifecycleIncomplete.length).toBeGreaterThanOrEqual(1);
    const validationFailure = lifecycleIncomplete.find(
      e => e.reason && e.reason.includes('must equal round count')
    );
    expect(validationFailure).toBeDefined();
    expect(validationFailure!.reason).toMatch(
      /W-L record \(\d+-\d+\) must equal round count \(6\)/
    );

    // Session should be in incomplete state
    const session = lifecycleService.getSession(bufferId);
    expect(session).toBeDefined();
    expect(session!.state).toBe('incomplete');

    // === VERIFY METADATA PRESERVED WITH CORRECT STATE ===

    const storedMetadata = await metadataStorageService.loadMatchByBufferId(bufferId);
    expect(storedMetadata).not.toBeNull();
    expect(storedMetadata!.matchCompletionStatus).toBe('incomplete');
    expect(storedMetadata!.uploadStatus).toBe('incomplete');
    expect(storedMetadata!.matchHash).toBeUndefined(); // No hash for invalid matches
    expect(storedMetadata!.matchData.bracket).toContain('Shuffle');
    expect(storedMetadata!.errorMessage).toBeDefined();
    expect(storedMetadata!.errorMessage).toMatch(/W-L record.*must equal round count/);

    // === VERIFY NO UNEXPECTED ERRORS ===

    const errors = getErrors();
    const unexpectedErrors = errors.filter(
      e =>
        !e.message.includes('playerId') &&
        !e.message.includes('validation') &&
        !e.message.includes('round count') &&
        !e.message.includes('winningTeamId')
    );
    expect(unexpectedErrors).toHaveLength(0);
  });

  it('emits only one matchStarted for 6 ARENA_MATCH_START events', async () => {
    const lines = await loadFixtureLog('shuffle-reloads.txt');

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

    // Key behavior: Only 1 matchStarted despite 6 ARENA_MATCH_START in log
    // Fixture has 6 ARENA_MATCH_START events (verified via grep)
    expect(startEvents.length).toBe(1);

    // Bracket should be Solo Shuffle
    expect(startEvents[0].bracket).toContain('Shuffle');

    // No unexpected lifecycle errors
    const errors = getErrors();
    const unexpectedErrors = errors.filter(
      e =>
        !e.message.includes('playerId') &&
        !e.message.includes('validation') &&
        !e.message.includes('winningTeamId')
    );
    expect(unexpectedErrors).toHaveLength(0);
  });

  it('tracks all 6 rounds in shuffleRounds metadata', async () => {
    const lines = await loadFixtureLog('shuffle-reloads.txt');

    const endEvents: MatchEndedEvent[] = [];
    const { enqueueOp, waitForAll, getErrors } = createLifecycleOpQueue();

    watcher.on('matchEnded', (event: MatchEndedEvent) => {
      endEvents.push(event);
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

    // Should have exactly 1 matchEnded event
    expect(endEvents).toHaveLength(1);

    // Should have exactly 6 rounds tracked
    expect(endEvents[0].metadata.shuffleRounds).toBeDefined();
    expect(endEvents[0].metadata.shuffleRounds!.length).toBe(6);

    // Each round should have a roundNumber
    endEvents[0].metadata.shuffleRounds!.forEach((round, index) => {
      expect(round.roundNumber).toBe(index + 1);
    });

    // No unexpected lifecycle errors
    const errors = getErrors();
    const unexpectedErrors = errors.filter(
      e =>
        !e.message.includes('playerId') &&
        !e.message.includes('validation') &&
        !e.message.includes('winningTeamId')
    );
    expect(unexpectedErrors).toHaveLength(0);
  });
});
