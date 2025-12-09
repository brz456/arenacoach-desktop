import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import MatchLogWatcher from '../../../src/match-detection/parsing/MatchLogWatcher';
import CombatLogSimulator from '../../helpers/CombatLogSimulator';
import {
  MatchStartedEvent,
  MatchEndedEvent,
  ZoneChangeEvent,
} from '../../../src/match-detection/types/MatchEvent';
import {
  createTempTestDir,
  cleanupTempDir,
  FIXTURES_LOGS_DIR,
} from '../../helpers/matchDetectionTestUtils';

/**
 * Active Write Behavior Integration Tests
 *
 * Tests that MatchLogWatcher ONLY processes actively-written combat logs
 * and ignores static (pre-existing, complete) log files.
 *
 * This is a critical security/performance requirement to ensure the app
 * doesn't process old static combat log files in the logs directory.
 *
 * Key invariants tested:
 * 1. Static file → 0 events (IGNORED)
 * 2. Active file → >0 events (PROCESSED)
 * 3. Mixed scenario → only active file processed
 */
describe('Active vs Static Combat Log Processing', () => {
  let tempDir: string;
  let watcher: MatchLogWatcher;
  let simulator: CombatLogSimulator | null = null;

  // Source fixture log for all tests
  const sourceLogPath = path.join(FIXTURES_LOGS_DIR, '3v3-single-match.txt');

  // Test timing constants (shorter than legacy harness but sufficient for detection)
  const STATIC_TEST_DURATION_MS = 2000;
  const ACTIVE_TEST_DURATION_MS = 4000;

  beforeEach(async () => {
    tempDir = await createTempTestDir('active-write-');
  });

  afterEach(async () => {
    // Stop simulator if running
    if (simulator) {
      simulator.stopSimulation();
      simulator = null;
    }

    // Stop and cleanup watcher
    if (watcher) {
      await watcher.unwatch();
      watcher.cleanup();
    }

    await cleanupTempDir(tempDir);
  });

  it('ignores static log files (pre-existing complete files generate zero events)', async () => {
    // Track events
    const events: Array<{ type: string; timestamp: Date }> = [];

    const staticFilePath = path.join(tempDir, `WoWCombatLog-static-${Date.now()}.txt`);

    // Phase 1: Create complete static log file BEFORE watcher starts
    await CombatLogSimulator.createStaticLogFile(sourceLogPath, staticFilePath);

    // Phase 2: Create watcher and setup event handlers
    watcher = new MatchLogWatcher(tempDir, 1);

    watcher.on('matchStarted', (event: MatchStartedEvent) => {
      events.push({ type: 'matchStarted', timestamp: event.timestamp });
    });
    watcher.on('matchEnded', (event: MatchEndedEvent) => {
      events.push({ type: 'matchEnded', timestamp: event.timestamp });
    });
    watcher.on('zoneChange', (event: ZoneChangeEvent) => {
      events.push({ type: 'zoneChange', timestamp: event.timestamp });
    });
    watcher.on('logChunk', (lines: Array<{ line: string; timestamp: Date }>) => {
      if (lines.length > 0) {
        events.push({ type: 'logChunk', timestamp: lines[0].timestamp });
      }
    });

    // Phase 3: Start watching and wait
    await watcher.watch();

    // Wait to observe - static file should generate NO events
    await new Promise(resolve => setTimeout(resolve, STATIC_TEST_DURATION_MS));

    // Assert: static file must be ignored
    expect(events).toHaveLength(0);
  });

  it('processes actively written log files (incremental writes generate events)', async () => {
    // Track events
    const events: Array<{ type: string; timestamp: Date }> = [];

    const activeFilePath = path.join(tempDir, `WoWCombatLog-active-${Date.now()}.txt`);

    // Phase 1: Create watcher FIRST
    watcher = new MatchLogWatcher(tempDir, 1);

    watcher.on('matchStarted', (event: MatchStartedEvent) => {
      events.push({ type: 'matchStarted', timestamp: event.timestamp });
    });
    watcher.on('matchEnded', (event: MatchEndedEvent) => {
      events.push({ type: 'matchEnded', timestamp: event.timestamp });
    });
    watcher.on('zoneChange', (event: ZoneChangeEvent) => {
      events.push({ type: 'zoneChange', timestamp: event.timestamp });
    });
    watcher.on('logChunk', (lines: Array<{ line: string; timestamp: Date }>) => {
      if (lines.length > 0) {
        events.push({ type: 'logChunk', timestamp: lines[0].timestamp });
      }
    });

    // Phase 2: Start watching
    await watcher.watch();

    // Phase 3: Create and start simulator for active writing
    simulator = CombatLogSimulator.createTestSimulator(sourceLogPath, activeFilePath);
    await simulator.loadSourceLog();

    simulator.startSimulation({
      linesPerBatch: 5,
      batchIntervalMs: 100,
      enableBurstMode: false,
      useAdvancedTiming: false,
    });

    // Wait for active writing to complete
    await new Promise(resolve => setTimeout(resolve, ACTIVE_TEST_DURATION_MS));

    // Assert: active file must generate events
    expect(events.length).toBeGreaterThan(0);

    // Should have at least one match-related event (matchStarted or logChunk)
    const hasMatchEvents = events.some(
      e => e.type === 'matchStarted' || e.type === 'matchEnded' || e.type === 'logChunk'
    );
    expect(hasMatchEvents).toBe(true);
  });

  it('processes only the active file when both static and active exist (mixed scenario)', async () => {
    // Track events with timestamps to determine when they occurred
    const eventsBeforeSimulation: Array<{ type: string; timestamp: Date }> = [];
    const eventsAfterSimulation: Array<{ type: string; timestamp: Date }> = [];
    let simulationStarted = false;

    const staticFilePath = path.join(tempDir, `WoWCombatLog-static-${Date.now()}.txt`);
    const activeFilePath = path.join(tempDir, `WoWCombatLog-active-${Date.now() + 1}.txt`);

    // Phase 1: Create complete static log file BEFORE watcher starts
    await CombatLogSimulator.createStaticLogFile(sourceLogPath, staticFilePath);

    // Phase 2: Create watcher
    watcher = new MatchLogWatcher(tempDir, 1);

    const trackEvent = (type: string, timestamp: Date) => {
      if (simulationStarted) {
        eventsAfterSimulation.push({ type, timestamp });
      } else {
        eventsBeforeSimulation.push({ type, timestamp });
      }
    };

    watcher.on('matchStarted', (event: MatchStartedEvent) => {
      trackEvent('matchStarted', event.timestamp);
    });
    watcher.on('matchEnded', (event: MatchEndedEvent) => {
      trackEvent('matchEnded', event.timestamp);
    });
    watcher.on('zoneChange', (event: ZoneChangeEvent) => {
      trackEvent('zoneChange', event.timestamp);
    });
    watcher.on('logChunk', (lines: Array<{ line: string; timestamp: Date }>) => {
      if (lines.length > 0) {
        trackEvent('logChunk', lines[0].timestamp);
      }
    });

    // Phase 3: Start watching (static file already exists)
    await watcher.watch();

    // Wait to ensure static file is observed and ignored
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Phase 4: Now start active file simulation
    simulationStarted = true;
    simulator = CombatLogSimulator.createTestSimulator(sourceLogPath, activeFilePath);
    await simulator.loadSourceLog();

    simulator.startSimulation({
      linesPerBatch: 5,
      batchIntervalMs: 100,
      enableBurstMode: false,
      useAdvancedTiming: false,
    });

    // Wait for active writing
    await new Promise(resolve => setTimeout(resolve, ACTIVE_TEST_DURATION_MS));

    // Assert: No events from static file (before simulation started)
    expect(eventsBeforeSimulation).toHaveLength(0);

    // Assert: Events only from active file (after simulation started)
    expect(eventsAfterSimulation.length).toBeGreaterThan(0);
  });
});
