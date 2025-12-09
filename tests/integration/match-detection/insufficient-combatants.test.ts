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
 * Insufficient Combatants Integration Tests (2v2 case)
 *
 * Tests the production pipeline for 2v2 matches with wrong player counts.
 * Per the design, these matches should be treated as hard invalidations and
 * fully purged (metadata deleted). The same validation logic applies to 3v3
 * (requires exactly 6 combatants) via the same code path in validateMatchCompleteness.
 *
 * Production flow for insufficient combatants:
 * 1. MatchLogWatcher parses log → emits matchStarted, matchEnded
 * 2. MatchChunker receives events → creates chunk (>= MIN_MATCH_LINES)
 * 3. MatchLifecycleService.handleMatchEnded → validateMatchCompleteness
 * 4. Validation fails with hardInvalidationTrigger = INSUFFICIENT_COMBATANTS
 * 5. Routes through handleMatchEndedIncomplete (not handleMatchValidationFailed)
 * 6. Metadata is deleted (hard purge)
 *
 * Key invariants tested:
 * - matchStarted IS emitted (watcher emits on ARENA_MATCH_START)
 * - matchEnded IS emitted (watcher emits on ARENA_MATCH_END)
 * - lifecycleService emits matchLifecycle:started for the bufferId
 * - lifecycleService emits matchLifecycle:incomplete with INSUFFICIENT_COMBATANTS
 * - Metadata is created on matchStarted, then DELETED due to insufficient combatants
 * - Match never reaches 'complete' state
 */
describe('Insufficient Combatants Hard Purge (2v2 with 3 players)', () => {
  let watcher: MatchLogWatcher;
  let chunker: MatchChunker;
  let metadataService: MetadataService;
  let metadataStorageService: MetadataStorageService;
  let lifecycleService: MatchLifecycleService;

  let tempLogDir: string;
  let tempOutputDir: string;
  let tempMetadataDir: string;

  beforeEach(async () => {
    tempLogDir = await createTempTestDir('insufficient-combatants-logs-');
    tempOutputDir = await createTempTestDir('insufficient-combatants-output-');
    tempMetadataDir = await createTempTestDir('insufficient-combatants-metadata-');

    // Setup watcher
    watcher = new MatchLogWatcher(tempLogDir, 10);

    // Setup chunker - use minMatchLines low enough that the fixture passes chunking
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

  it('purges 2v2 match with only 3 combatants (insufficient players)', async () => {
    const lines = await loadFixtureLog('2v2-insufficient-combatants.txt');

    // Verify fixture has enough lines to pass chunker minMatchLines
    expect(lines.length).toBeGreaterThan(20);

    // Track all events
    const startEvents: MatchStartedEvent[] = [];
    const endEvents: MatchEndedEvent[] = [];
    const incompleteEvents: MatchEndedIncompleteEvent[] = [];
    const lifecycleStarted: string[] = [];
    const lifecycleIncomplete: Array<{ bufferId: string; trigger: EarlyEndTrigger }> = [];
    const lifecycleCompleted: string[] = [];

    // Per-bufferId operation queue (simulates main.ts enqueueLifecycleOp)
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
    lifecycleService.on('matchLifecycle:incomplete', data => {
      lifecycleIncomplete.push({ bufferId: data.bufferId, trigger: data.trigger });
    });
    lifecycleService.on('matchLifecycle:completed', data => {
      lifecycleCompleted.push(data.bufferId);
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

    // matchStarted IS emitted
    expect(startEvents).toHaveLength(1);
    expect(startEvents[0].bracket).toBe('2v2');
    const bufferId = startEvents[0].bufferId;

    // matchEnded IS emitted
    expect(endEvents).toHaveLength(1);
    expect(endEvents[0].metadata.bracket).toBe('2v2');
    // Verify the fixture has 3 players (insufficient for 2v2)
    expect(endEvents[0].metadata.players).toHaveLength(3);

    // Chunker does NOT emit matchEndedIncomplete for this flow
    // (INSUFFICIENT_COMBATANTS is synthesized internally by MatchLifecycleService)
    expect(incompleteEvents).toHaveLength(0);

    // === VERIFY LIFECYCLE SERVICE ===

    // Lifecycle started event was emitted with correct bufferId
    expect(lifecycleStarted).toHaveLength(1);
    expect(lifecycleStarted[0]).toBe(bufferId);

    // Match should NOT be completed (insufficient combatants)
    expect(lifecycleCompleted).toHaveLength(0);

    // Lifecycle service should receive incomplete with INSUFFICIENT_COMBATANTS trigger
    const insufficientTriggerEvents = lifecycleIncomplete.filter(
      e => e.trigger === EarlyEndTrigger.INSUFFICIENT_COMBATANTS
    );
    expect(insufficientTriggerEvents).toHaveLength(1);
    expect(insufficientTriggerEvents[0].bufferId).toBe(bufferId);

    // === VERIFY METADATA PURGE ===

    // Metadata file should be DELETED (purged) after INSUFFICIENT_COMBATANTS
    const metadataFiles = fs.readdirSync(tempMetadataDir).filter(f => f.endsWith('.json'));
    expect(metadataFiles).toHaveLength(0);

    // Attempting to load by bufferId should return null
    const storedMetadata = await metadataStorageService.loadMatchByBufferId(bufferId);
    expect(storedMetadata).toBeNull();

    // === VERIFY SESSION STATE ===

    // Session should be in 'incomplete' state after hard purge
    const session = lifecycleService.getSession(bufferId);
    expect(session).toBeDefined();
    expect(session!.state).toBe('incomplete');
    expect(session!.completionReason).toContain('INSUFFICIENT_COMBATANTS');

    // === VERIFY NO UNEXPECTED ERRORS ===
    const errors = getErrors();
    expect(errors).toHaveLength(0);
  });

  it('validates error message contains correct combatant count information', async () => {
    const lines = await loadFixtureLog('2v2-insufficient-combatants.txt');

    const validationErrors: string[] = [];
    const { enqueueOp, waitForAll, getErrors } = createLifecycleOpQueue();

    // Capture console.warn to extract validation errors
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      const msg = args.map(a => JSON.stringify(a)).join(' ');
      if (msg.includes('Match validation failed')) {
        const errorsArg = args.find(a => typeof a === 'object' && a !== null && 'errors' in a) as
          | { errors?: string[] }
          | undefined;
        if (errorsArg?.errors) {
          validationErrors.push(...errorsArg.errors);
        }
      }
      originalWarn.apply(console, args);
    };

    try {
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

      const watcherAny = watcher as any;
      watcherAny.processChunkSynchronously(lines);

      await waitForAll();

      // Verify error message mentions 2v2 requires 4 combatants and got 3
      expect(validationErrors).toHaveLength(1);
      expect(validationErrors[0]).toContain('2v2 requires exactly 4 combatants');
      expect(validationErrors[0]).toContain('got 3');

      // Verify no unexpected lifecycle errors
      const errors = getErrors();
      expect(errors).toHaveLength(0);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('verifies bufferId correlation across start, end, and incomplete events', async () => {
    const lines = await loadFixtureLog('2v2-insufficient-combatants.txt');

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

    lifecycleService.on('matchLifecycle:incomplete', data => {
      if (data.trigger === EarlyEndTrigger.INSUFFICIENT_COMBATANTS) {
        incompleteBufferId = data.bufferId;
      }
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

    // All events should have same bufferId
    expect(startBufferId).not.toBeNull();
    expect(endBufferId).toBe(startBufferId);
    expect(incompleteBufferId).toBe(startBufferId);

    // Verify no unexpected lifecycle errors
    const errors = getErrors();
    expect(errors).toHaveLength(0);
  });
});
