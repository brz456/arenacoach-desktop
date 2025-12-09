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
  ZoneChangeEvent,
} from '../../../src/match-detection/types/MatchEvent';
import { EarlyEndTrigger } from '../../../src/match-detection/types/EarlyEndTriggers';
import {
  createTempTestDir,
  cleanupTempDir,
  loadFixtureLog,
  createLifecycleOpQueue,
} from '../../helpers/matchDetectionTestUtils';

/**
 * No-Kill Invalidation Integration Tests
 *
 * Tests the kill-aware validation and early-ending feature for 2v2/3v3 matches.
 *
 * Scenarios tested:
 * 1. Normal ARENA_MATCH_END with no kills → NO_PLAYER_DEATH → hard-delete
 * 2. Zone change with no kills → ZONE_CHANGE upgraded to NO_PLAYER_DEATH → hard-delete
 * 3. Zone change with kills → ZONE_CHANGE → preserved (incomplete, not uploaded)
 *
 * Key invariants:
 * - Solo Shuffle is unaffected (uses round-level kill tracking)
 * - playerDeathCount is tracked from UNIT_DIED events for Player-* GUIDs
 * - 2v2/3v3 with kills + ARENA_MATCH_END = valid and uploadable
 * - 2v2/3v3 with kills + no ARENA_MATCH_END = kept as incomplete (not uploaded)
 * - 2v2/3v3 without kills = hard-deleted (no value, regardless of end type)
 */
describe('No-Kill Invalidation (2v2/3v3)', () => {
  let watcher: MatchLogWatcher;
  let chunker: MatchChunker;
  let metadataService: MetadataService;
  let metadataStorageService: MetadataStorageService;
  let lifecycleService: MatchLifecycleService;

  let tempLogDir: string;
  let tempOutputDir: string;
  let tempMetadataDir: string;

  beforeEach(async () => {
    tempLogDir = await createTempTestDir('no-kill-logs-');
    tempOutputDir = await createTempTestDir('no-kill-output-');
    tempMetadataDir = await createTempTestDir('no-kill-metadata-');

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
    watcher.on('zoneChange', (event: ZoneChangeEvent) => {
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

  describe('Normal match end path', () => {
    it('invalidates 3v3 match with ARENA_MATCH_END but no kills (NO_PLAYER_DEATH)', async () => {
      const lines = await loadFixtureLog('3v3-no-kill-match-end.txt');

      // Track events
      const startEvents: MatchStartedEvent[] = [];
      const endEvents: MatchEndedEvent[] = [];
      const lifecycleIncomplete: Array<{ bufferId: string; trigger: EarlyEndTrigger }> = [];
      const lifecycleCompleted: string[] = [];

      const { enqueueOp, waitForAll } = createLifecycleOpQueue();

      watcher.on('matchStarted', (event: MatchStartedEvent) => {
        startEvents.push(event);
      });
      watcher.on('matchEnded', (event: MatchEndedEvent) => {
        endEvents.push(event);
      });

      lifecycleService.on('matchLifecycle:incomplete', data => {
        lifecycleIncomplete.push({ bufferId: data.bufferId, trigger: data.trigger });
      });
      lifecycleService.on('matchLifecycle:completed', data => {
        lifecycleCompleted.push(data.bufferId);
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

      const watcherAny = watcher as any;
      watcherAny.processChunkSynchronously(lines);

      await waitForAll();

      // === VERIFY MATCH EVENTS ===
      expect(startEvents).toHaveLength(1);
      expect(startEvents[0].bracket).toBe('3v3');

      expect(endEvents).toHaveLength(1);
      expect(endEvents[0].metadata.bracket).toBe('3v3');
      // Verify parser tracked zero deaths
      expect(endEvents[0].metadata.playerDeathCount).toBe(0);

      // === VERIFY LIFECYCLE ROUTING ===
      // Match should be routed to incomplete with NO_PLAYER_DEATH trigger
      expect(lifecycleCompleted).toHaveLength(0);
      expect(lifecycleIncomplete).toHaveLength(1);
      expect(lifecycleIncomplete[0].trigger).toBe(EarlyEndTrigger.NO_PLAYER_DEATH);

      // === VERIFY HARD DELETION ===
      const metadataFiles = fs.readdirSync(tempMetadataDir).filter(f => f.endsWith('.json'));
      expect(metadataFiles).toHaveLength(0);

      const bufferId = startEvents[0].bufferId;
      const storedMetadata = await metadataStorageService.loadMatchByBufferId(bufferId);
      expect(storedMetadata).toBeNull();
    });
  });

  describe('Zone change path (no ARENA_MATCH_END)', () => {
    it('hard-deletes 2v2 zone-change match with NO kills (NO_PLAYER_DEATH)', async () => {
      const lines = await loadFixtureLog('2v2-zone-change-no-kill.txt');

      const startEvents: MatchStartedEvent[] = [];
      const incompleteEvents: MatchEndedIncompleteEvent[] = [];
      const lifecycleIncomplete: Array<{ bufferId: string; trigger: EarlyEndTrigger }> = [];

      const { enqueueOp, waitForAll } = createLifecycleOpQueue();

      watcher.on('matchStarted', (event: MatchStartedEvent) => {
        startEvents.push(event);
      });
      chunker.on('matchEndedIncomplete', (event: MatchEndedIncompleteEvent) => {
        incompleteEvents.push(event);
      });

      lifecycleService.on('matchLifecycle:incomplete', data => {
        lifecycleIncomplete.push({ bufferId: data.bufferId, trigger: data.trigger });
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

      const watcherAny = watcher as any;
      watcherAny.processChunkSynchronously(lines);

      await waitForAll();

      // === VERIFY MATCH START ===
      expect(startEvents).toHaveLength(1);
      expect(startEvents[0].bracket).toBe('2v2');

      // === VERIFY ZONE CHANGE TRIGGERED EARLY END ===
      expect(incompleteEvents).toHaveLength(1);
      expect(incompleteEvents[0].trigger).toBe(EarlyEndTrigger.ZONE_CHANGE);

      // Metadata snapshot should have recorded zero deaths
      const metadataSnapshot = incompleteEvents[0].buffer.metadata;
      expect(metadataSnapshot).toBeDefined();
      expect(metadataSnapshot?.playerDeathCount).toBe(0);

      // === VERIFY LIFECYCLE UPGRADED TO NO_PLAYER_DEATH ===
      expect(lifecycleIncomplete).toHaveLength(1);
      expect(lifecycleIncomplete[0].trigger).toBe(EarlyEndTrigger.NO_PLAYER_DEATH);

      // === VERIFY HARD DELETION ===
      const metadataFiles = fs.readdirSync(tempMetadataDir).filter(f => f.endsWith('.json'));
      expect(metadataFiles).toHaveLength(0);

      const bufferId = startEvents[0].bufferId;
      const storedMetadata = await metadataStorageService.loadMatchByBufferId(bufferId);
      expect(storedMetadata).toBeNull();
    });

    it('preserves 3v3 zone-change match WITH kills as incomplete (not deleted, not uploaded)', async () => {
      const lines = await loadFixtureLog('3v3-zone-change-with-kill.txt');

      const startEvents: MatchStartedEvent[] = [];
      const incompleteEvents: MatchEndedIncompleteEvent[] = [];
      const lifecycleIncomplete: Array<{ bufferId: string; trigger: EarlyEndTrigger }> = [];
      const lifecycleCompleted: string[] = [];

      const { enqueueOp, waitForAll } = createLifecycleOpQueue();

      watcher.on('matchStarted', (event: MatchStartedEvent) => {
        startEvents.push(event);
      });
      chunker.on('matchEndedIncomplete', (event: MatchEndedIncompleteEvent) => {
        incompleteEvents.push(event);
      });

      lifecycleService.on('matchLifecycle:incomplete', data => {
        lifecycleIncomplete.push({ bufferId: data.bufferId, trigger: data.trigger });
      });
      lifecycleService.on('matchLifecycle:completed', data => {
        lifecycleCompleted.push(data.bufferId);
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

      const watcherAny = watcher as any;
      watcherAny.processChunkSynchronously(lines);

      await waitForAll();

      // === VERIFY MATCH START ===
      expect(startEvents).toHaveLength(1);
      expect(startEvents[0].bracket).toBe('3v3');

      // === VERIFY ZONE CHANGE TRIGGERED EARLY END ===
      expect(incompleteEvents).toHaveLength(1);
      expect(incompleteEvents[0].trigger).toBe(EarlyEndTrigger.ZONE_CHANGE);

      // Metadata snapshot should have recorded the kill
      const metadataSnapshot = incompleteEvents[0].buffer.metadata;
      expect(metadataSnapshot).toBeDefined();
      expect(metadataSnapshot?.playerDeathCount).toBeGreaterThan(0);

      // === VERIFY LIFECYCLE KEPT ZONE_CHANGE (not upgraded to NO_PLAYER_DEATH) ===
      // Match with kills is preserved as incomplete, NOT hard-deleted
      expect(lifecycleCompleted).toHaveLength(0); // Not completed (no ARENA_MATCH_END)
      expect(lifecycleIncomplete).toHaveLength(1);
      expect(lifecycleIncomplete[0].trigger).toBe(EarlyEndTrigger.ZONE_CHANGE);

      // === VERIFY METADATA PRESERVED (NOT DELETED) ===
      const metadataFiles = fs.readdirSync(tempMetadataDir).filter(f => f.endsWith('.json'));
      expect(metadataFiles).toHaveLength(1);

      const bufferId = startEvents[0].bufferId;
      const storedMetadata = await metadataStorageService.loadMatchByBufferId(bufferId);
      expect(storedMetadata).not.toBeNull();
      expect(storedMetadata?.matchCompletionStatus).toBe('incomplete');
      // Match is incomplete - never uploadable (no matchHash)
    });
  });
});
