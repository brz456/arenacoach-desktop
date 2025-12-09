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
import {
  createTempTestDir,
  cleanupTempDir,
  loadFixtureLog,
  createLifecycleOpQueue,
} from '../../helpers/matchDetectionTestUtils';

/**
 * Shuffle Early End (2 Rounds) Integration Tests
 *
 * Tests the production pipeline behavior when a Solo Shuffle ends early
 * (e.g., player leaves after 2 rounds instead of completing all 6).
 *
 * Production flow:
 * 1. MatchLogWatcher emits matchStarted for each round (same bufferId)
 * 2. MatchChunker tracks rounds via ARENA_MATCH_START events
 * 3. On matchEnded, validation checks shuffleRounds.length === 6
 * 4. Validation fails: "Solo Shuffle requires exactly 6 rounds (got 2)"
 * 5. Match marked as validation_failed/incomplete
 * 6. Metadata PRESERVED (not deleted - unlike instant-cancel)
 * 7. Recording PRESERVED (for local viewing)
 * 8. No upload attempted
 *
 * Key difference from instant-cancel:
 * - Metadata and recording are kept for incomplete shuffles
 * - Only CANCEL_INSTANT_MATCH trigger deletes everything
 */
describe('Shuffle Early End - 2 Rounds', () => {
  let watcher: MatchLogWatcher;
  let chunker: MatchChunker;
  let metadataService: MetadataService;
  let metadataStorageService: MetadataStorageService;
  let lifecycleService: MatchLifecycleService;

  let tempLogDir: string;
  let tempOutputDir: string;
  let tempMetadataDir: string;

  beforeEach(async () => {
    tempLogDir = await createTempTestDir('shuffle-early-logs-');
    tempOutputDir = await createTempTestDir('shuffle-early-output-');
    tempMetadataDir = await createTempTestDir('shuffle-early-metadata-');

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

  it('marks shuffle with 2 rounds as validation_failed and preserves metadata', async () => {
    const lines = await loadFixtureLog('shuffle-early-leaver.txt');

    // Fixture has 2 ARENA_MATCH_START events (rounds) and 1 ARENA_MATCH_END
    expect(lines.length).toBeGreaterThan(20);

    // Track events
    const startEvents: MatchStartedEvent[] = [];
    const endEvents: MatchEndedEvent[] = [];
    const incompleteEvents: MatchEndedIncompleteEvent[] = [];
    const lifecycleStarted: string[] = [];
    const lifecycleCompleted: string[] = [];
    const lifecycleIncomplete: Array<{ bufferId: string; reason?: string }> = [];

    const { enqueueOp, waitForAll, getErrors } = createLifecycleOpQueue();

    // Wire event tracking
    watcher.on('matchStarted', (event: MatchStartedEvent) => {
      startEvents.push(event);
    });
    watcher.on('matchEnded', (event: MatchEndedEvent) => {
      endEvents.push(event);
    });
    chunker.on('matchEndedIncomplete', (event: MatchEndedIncompleteEvent) => {
      incompleteEvents.push(event);
    });

    // Wire lifecycle service events
    lifecycleService.on('matchLifecycle:started', data => {
      lifecycleStarted.push(data.bufferId);
    });
    lifecycleService.on('matchLifecycle:completed', data => {
      lifecycleCompleted.push(data.bufferId);
    });
    lifecycleService.on('matchLifecycle:incomplete', data => {
      lifecycleIncomplete.push({ bufferId: data.bufferId, reason: data.reason });
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

    // === VERIFY SHUFFLE ROUND DETECTION ===

    // For Solo Shuffle, parser emits matchStarted ONLY for first round
    // (subsequent ARENA_MATCH_START events are suppressed, tracked by shuffleTracker)
    expect(startEvents.length).toBe(1);

    const bufferId = startEvents[0].bufferId;

    // Bracket is Solo Shuffle
    expect(startEvents[0].bracket).toContain('Shuffle');

    // === VERIFY SINGLE SESSION ===

    // Only ONE session created (first round creates, subsequent ignored)
    expect(lifecycleStarted).toHaveLength(1);

    // === VERIFY matchEnded ===

    expect(endEvents).toHaveLength(1);
    expect(endEvents[0].bufferId).toBe(bufferId);

    // Parser should have detected 2 rounds
    expect(endEvents[0].metadata.shuffleRounds).toBeDefined();
    expect(endEvents[0].metadata.shuffleRounds!.length).toBe(2);

    // === VERIFY VALIDATION FAILURE (6 rounds required) ===

    // Match should NOT complete successfully
    expect(lifecycleCompleted).toHaveLength(0);

    // Match should be marked incomplete due to validation failure
    // (may have multiple incomplete events if zone change also triggers one)
    expect(lifecycleIncomplete.length).toBeGreaterThanOrEqual(1);

    // Verify validation failure reason was captured in one of the incomplete events
    const validationFailureEvent = lifecycleIncomplete.find(
      e => e.reason && e.reason.includes('6 rounds')
    );
    expect(validationFailureEvent).toBeDefined();

    // Session ends in 'incomplete' state
    const session = lifecycleService.getSession(bufferId);
    expect(session).toBeDefined();
    expect(session!.state).toBe('incomplete');
    // Note: session.completionReason may be overwritten by subsequent events (e.g., ZONE_CHANGE)
    // The validation error is preserved in metadata.errorMessage

    // === VERIFY METADATA PRESERVED (not deleted) ===

    const storedMetadata = await metadataStorageService.loadMatchByBufferId(bufferId);
    expect(storedMetadata).not.toBeNull();
    expect(storedMetadata!.matchCompletionStatus).toBe('incomplete');
    expect(storedMetadata!.uploadStatus).toBe('incomplete');
    expect(storedMetadata!.matchHash).toBeUndefined();

    // Note: In this fixture, a ZONE_CHANGE event follows ARENA_MATCH_END,
    // which triggers a second incomplete handler that overwrites errorMessage.
    // The validation failure did occur (as shown in lifecycleIncomplete events),
    // but the stored errorMessage reflects the last event processed.
    expect(storedMetadata!.errorMessage).toBeDefined();

    // Metadata contains the shuffle round data for local viewing
    expect(storedMetadata!.matchData.shuffleRounds).toBeDefined();
    expect(storedMetadata!.matchData.shuffleRounds!.length).toBe(2);

    // === VERIFY NO UNEXPECTED ERRORS ===

    const errors = getErrors();
    // Filter out expected errors (validation-related)
    const unexpectedErrors = errors.filter(
      e => !e.message.includes('playerId') && !e.message.includes('6 rounds')
    );
    expect(unexpectedErrors).toHaveLength(0);
  });

  it('detects correct round count via parser shuffleTracker', async () => {
    const lines = await loadFixtureLog('shuffle-early-leaver.txt');

    const startEvents: MatchStartedEvent[] = [];
    const endEvents: MatchEndedEvent[] = [];
    const { enqueueOp, waitForAll, getErrors } = createLifecycleOpQueue();

    watcher.on('matchStarted', (event: MatchStartedEvent) => {
      startEvents.push(event);
    });
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

    // Only 1 matchStarted emitted (first round only - subsequent rounds suppressed)
    expect(startEvents.length).toBe(1);

    // Parser extracts shuffleRounds from combat log via internal shuffleTracker
    // 2 ARENA_MATCH_START events in fixture = 2 rounds tracked
    expect(endEvents).toHaveLength(1);
    expect(endEvents[0].metadata.shuffleRounds).toHaveLength(2);

    // No unexpected lifecycle errors
    expect(getErrors()).toHaveLength(0);
  });

  it('preserves metadata for incomplete shuffle (unlike instant-cancel which deletes)', async () => {
    const lines = await loadFixtureLog('shuffle-early-leaver.txt');

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

    const bufferId = startEvents[0].bufferId;

    // Key difference from instant-cancel: metadata is PRESERVED
    const storedMetadata = await metadataStorageService.loadMatchByBufferId(bufferId);
    expect(storedMetadata).not.toBeNull();

    // Metadata has enriched data for local viewing
    expect(storedMetadata!.matchData.bracket).toContain('Shuffle');
    expect(storedMetadata!.matchData.players).toBeDefined();
    expect(storedMetadata!.matchData.players!.length).toBeGreaterThan(0);

    // No unexpected lifecycle errors
    expect(getErrors()).toHaveLength(0);
  });
});
