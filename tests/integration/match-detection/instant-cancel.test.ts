import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
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
import { EarlyEndTrigger } from '../../../src/match-detection/types/EarlyEndTriggers';
import {
  createTempTestDir,
  cleanupTempDir,
  loadFixtureLog,
  createLifecycleOpQueue,
} from '../../helpers/matchDetectionTestUtils';

/**
 * Instant Match Cancellation Integration Tests
 *
 * Tests the complete production pipeline for matches that are cancelled due to
 * insufficient combat log lines (< MIN_MATCH_LINES, default 20).
 *
 * Production flow:
 * 1. MatchLogWatcher parses log → emits matchStarted, matchEnded, logChunk
 * 2. MatchChunker receives events → detects rawLines < MIN_MATCH_LINES
 * 3. MatchChunker emits matchEndedIncomplete with CANCEL_INSTANT_MATCH
 * 4. MatchLifecycleService receives → may upgrade to NO_PLAYER_DEATH for no-kill 3v3
 * 5. MatchLifecycleService deletes metadata (purge) for hard-deletion triggers
 *
 * Key invariants:
 * - matchStarted IS emitted (watcher always emits on ARENA_MATCH_START)
 * - matchEnded IS emitted (watcher always emits on ARENA_MATCH_END)
 * - matchEndedIncomplete IS emitted (CANCEL_INSTANT_MATCH or upgraded to NO_PLAYER_DEATH)
 * - matchExtracted is NOT emitted (no chunk file created)
 * - Metadata is created on matchStarted, then DELETED on cancellation
 *
 * Note: 3v3 instant matches with no kills will have trigger upgraded to NO_PLAYER_DEATH
 * because no-kill detection takes precedence (more specific classification).
 */
describe('Instant Match Cancellation (3v3-instant-end)', () => {
  let watcher: MatchLogWatcher;
  let chunker: MatchChunker;
  let metadataService: MetadataService;
  let metadataStorageService: MetadataStorageService;
  let lifecycleService: MatchLifecycleService;

  let tempLogDir: string;
  let tempOutputDir: string;
  let tempMetadataDir: string;

  beforeEach(async () => {
    tempLogDir = await createTempTestDir('instant-cancel-logs-');
    tempOutputDir = await createTempTestDir('instant-cancel-output-');
    tempMetadataDir = await createTempTestDir('instant-cancel-metadata-');

    // Setup watcher
    watcher = new MatchLogWatcher(tempLogDir, 10);

    // Setup chunker with MIN_MATCH_LINES = 20 (production default)
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

    // Setup lifecycle service (no recording service - null is valid)
    lifecycleService = new MatchLifecycleService(metadataService, null);

    // Wire pipeline exactly as production (MatchDetectionOrchestrator pattern)
    // Watcher → Chunker
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

  it('cancels instant match and purges metadata (13 lines < 20 MIN_MATCH_LINES)', async () => {
    const lines = await loadFixtureLog('3v3-instant-end.txt');

    // Verify fixture has < 20 lines (instant cancellation condition)
    expect(lines.length).toBeLessThan(20);

    // Track all events
    const startEvents: MatchStartedEvent[] = [];
    const endEvents: MatchEndedEvent[] = [];
    const incompleteEvents: MatchEndedIncompleteEvent[] = [];
    const extractedFiles: string[] = [];
    const lifecycleStarted: string[] = [];
    const lifecycleIncomplete: Array<{ bufferId: string; trigger: EarlyEndTrigger }> = [];

    // Per-bufferId operation queue (simulates main.ts enqueueLifecycleOp)
    const { enqueueOp, waitForAll, getErrors } = createLifecycleOpQueue();

    // Wire event tracking (orchestrator emits these)
    watcher.on('matchStarted', (event: MatchStartedEvent) => {
      startEvents.push(event);
    });
    watcher.on('matchEnded', (event: MatchEndedEvent) => {
      endEvents.push(event);
    });
    chunker.on('matchEndedIncomplete', (event: MatchEndedIncompleteEvent) => {
      incompleteEvents.push(event);
    });
    chunker.on('matchExtracted', data => {
      extractedFiles.push(data.filePath);
    });

    // Wire lifecycle service events
    lifecycleService.on('matchLifecycle:started', data => {
      lifecycleStarted.push(data.bufferId);
    });
    lifecycleService.on('matchLifecycle:incomplete', data => {
      lifecycleIncomplete.push({ bufferId: data.bufferId, trigger: data.trigger });
    });

    // Wire lifecycle handlers with per-bufferId queue (as main.ts does)
    watcher.on('matchStarted', (event: MatchStartedEvent) => {
      enqueueOp(event.bufferId, () => lifecycleService.handleMatchStarted(event));
    });
    watcher.on('matchEnded', (event: MatchEndedEvent) => {
      enqueueOp(event.bufferId, () => lifecycleService.handleMatchEnded(event));
    });
    chunker.on('matchEndedIncomplete', (event: MatchEndedIncompleteEvent) => {
      enqueueOp(event.bufferId, () => lifecycleService.handleMatchEndedIncomplete(event));
    });

    // Process fixture through pipeline (synchronous chunk processing)
    const watcherAny = watcher as any;
    watcherAny.processChunkSynchronously(lines);

    // Wait for all queued operations to complete
    await waitForAll();

    // === VERIFY EVENT EMISSION ===

    // matchStarted IS emitted (watcher always emits on ARENA_MATCH_START)
    expect(startEvents).toHaveLength(1);
    expect(startEvents[0].bracket).toBe('3v3');
    expect(startEvents[0].zoneId).toBe(1505); // Nagrand Arena

    // matchEnded IS emitted (watcher always emits on ARENA_MATCH_END)
    expect(endEvents).toHaveLength(1);
    expect(endEvents[0].metadata.bracket).toBe('3v3');
    expect(endEvents[0].metadata.matchDuration).toBe(90);

    // matchEndedIncomplete with CANCEL_INSTANT_MATCH IS emitted from chunker
    // (lifecycle may upgrade to NO_PLAYER_DEATH for no-kill 3v3)
    expect(incompleteEvents).toHaveLength(1);
    expect(incompleteEvents[0].trigger).toBe(EarlyEndTrigger.CANCEL_INSTANT_MATCH);
    expect(incompleteEvents[0].lines).toBeLessThan(20);

    // matchExtracted is NOT emitted (no chunk file created)
    expect(extractedFiles).toHaveLength(0);

    // === VERIFY LIFECYCLE SERVICE ===

    // Lifecycle service received matchStarted
    expect(lifecycleStarted).toHaveLength(1);

    // Lifecycle service received matchEndedIncomplete events:
    // 1. From handleMatchEnded validation (NO_PLAYER_DEATH - no kills in metadata)
    // 2. From chunker's CANCEL_INSTANT_MATCH (upgraded to NO_PLAYER_DEATH by lifecycle)
    // Both result in hard-deletion, so metadata is purged.
    // The important thing is that at least one NO_PLAYER_DEATH trigger was received.
    const noPlayerDeathTriggers = lifecycleIncomplete.filter(
      e => e.trigger === EarlyEndTrigger.NO_PLAYER_DEATH
    );
    expect(noPlayerDeathTriggers.length).toBeGreaterThanOrEqual(1);

    // === VERIFY METADATA PURGE ===

    // Metadata file should be DELETED (purged) after hard-deletion trigger
    const metadataFiles = fs.readdirSync(tempMetadataDir).filter(f => f.endsWith('.json'));
    expect(metadataFiles).toHaveLength(0);

    // Attempting to load by bufferId should return null
    const bufferId = startEvents[0].bufferId;
    const storedMetadata = await metadataStorageService.loadMatchByBufferId(bufferId);
    expect(storedMetadata).toBeNull();

    // === VERIFY NO CHUNK FILE ===

    // Output directory should have no chunk files
    const chunkFiles = fs.readdirSync(tempOutputDir).filter(f => f.endsWith('.txt'));
    expect(chunkFiles).toHaveLength(0);

    // === VERIFY NO UNEXPECTED ERRORS ===
    const errors = getErrors();
    // playerId errors may or may not occur depending on fixture - not a hard requirement
    // Just verify no unexpected errors that would indicate bugs
    const criticalErrors = errors.filter(
      e => !e.message.includes('playerId is required') && !e.message.includes('No metadata found') // Expected when match is deleted before other handlers run
    );
    expect(criticalErrors).toHaveLength(0);
  });

  it('verifies bufferId correlation across all events', async () => {
    const lines = await loadFixtureLog('3v3-instant-end.txt');

    let startBufferId: string | null = null;
    let endBufferId: string | null = null;
    let incompleteBufferId: string | null = null;

    const { enqueueOp, waitForAll, getErrors } = createLifecycleOpQueue();

    watcher.on('matchStarted', (event: MatchStartedEvent) => {
      startBufferId = event.bufferId;
    });
    watcher.on('matchEnded', (event: MatchEndedEvent) => {
      endBufferId = event.bufferId;
    });
    chunker.on('matchEndedIncomplete', (event: MatchEndedIncompleteEvent) => {
      incompleteBufferId = event.bufferId;
    });

    // Wire lifecycle with queue (required for full pipeline)
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

    // All events should have same bufferId
    expect(startBufferId).not.toBeNull();
    expect(endBufferId).toBe(startBufferId);
    expect(incompleteBufferId).toBe(startBufferId);

    // No unexpected lifecycle errors (playerId error is expected for this fixture)
    const errors = getErrors();
    const unexpectedErrors = errors.filter(e => !e.message.includes('playerId is required'));
    expect(unexpectedErrors).toHaveLength(0);
  });

  it('lifecycle session state transitions correctly: active → incomplete', async () => {
    const lines = await loadFixtureLog('3v3-instant-end.txt');

    let bufferId: string | null = null;

    const { enqueueOp, waitForAll, getErrors } = createLifecycleOpQueue();

    watcher.on('matchStarted', (event: MatchStartedEvent) => {
      bufferId = event.bufferId;
    });

    // Wire lifecycle with queue
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

    expect(bufferId).not.toBeNull();

    // Session should be in 'incomplete' state after cancellation
    const session = lifecycleService.getSession(bufferId!);
    expect(session).toBeDefined();
    expect(session!.state).toBe('incomplete');
    // For no-kill 3v3, trigger is upgraded to NO_PLAYER_DEATH
    expect(session!.completionReason).toContain('NO_PLAYER_DEATH');

    // No unexpected lifecycle errors (playerId error is expected for this fixture)
    const errors = getErrors();
    const unexpectedErrors = errors.filter(e => !e.message.includes('playerId is required'));
    expect(unexpectedErrors).toHaveLength(0);
  });
});
