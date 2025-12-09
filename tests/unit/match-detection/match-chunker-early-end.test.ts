import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import MatchChunker from '../../../src/match-detection/chunking/MatchChunker';
import {
  MatchEventType,
  MatchStartedEvent,
  ZoneChangeEvent,
} from '../../../src/match-detection/types/MatchEvent';
import { EarlyEndTrigger } from '../../../src/match-detection/types/EarlyEndTriggers';
import { createTempTestDir, cleanupTempDir } from '../../helpers/matchDetectionTestUtils';

describe('MatchChunker - early end triggers', () => {
  let chunker: MatchChunker;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempTestDir('chunker-early-end-');
    chunker = new MatchChunker({
      outputDir: tempDir,
      minMatchLines: 1,
      allowedOutputRoots: [tempDir],
    });
    await chunker.init();
  });

  afterEach(async () => {
    chunker.cleanup();
    await cleanupTempDir(tempDir);
  });

  function createMatchStartEvent(bufferId: string, zoneId: number): MatchStartedEvent {
    return {
      type: MatchEventType.MATCH_STARTED,
      timestamp: new Date(),
      zoneId,
      bufferId,
    };
  }

  function createZoneChangeEvent(zoneId: number, zoneName: string): ZoneChangeEvent {
    return {
      type: MatchEventType.ZONE_CHANGE,
      timestamp: new Date(),
      zoneId,
      zoneName,
    };
  }

  it('does not end match on same arena zone change', async () => {
    let incompleteEventFired = false;
    chunker.on('matchEndedIncomplete', () => {
      incompleteEventFired = true;
    });

    // Start match in Blade's Edge Arena (1672)
    chunker.onMatchStarted(createMatchStartEvent('test-same-arena', 1672));
    expect(chunker.getActiveMatchCount()).toBe(1);

    // Zone change to same arena
    chunker.onZoneChange(createZoneChangeEvent(1672, "Blade's Edge Arena"));

    expect(incompleteEventFired).toBe(false);
    expect(chunker.getActiveMatchCount()).toBe(1);
  });

  it('ends match on arena->different arena zone change with ZONE_CHANGE trigger', async () => {
    let incompleteEvent: { bufferId: string; trigger: EarlyEndTrigger } | null = null;
    chunker.on('matchEndedIncomplete', data => {
      incompleteEvent = data;
    });

    // Start match in Blade's Edge Arena (1672)
    chunker.onMatchStarted(createMatchStartEvent('test-diff-arena', 1672));
    expect(chunker.getActiveMatchCount()).toBe(1);

    // Zone change to different arena (Dalaran Sewers - 617)
    chunker.onZoneChange(createZoneChangeEvent(617, 'Dalaran Sewers'));

    expect(incompleteEvent).not.toBeNull();
    expect(incompleteEvent!.trigger).toBe(EarlyEndTrigger.ZONE_CHANGE);
    expect(chunker.getActiveMatchCount()).toBe(0);
  });

  it('ends match on arena->non-arena zone change with ZONE_CHANGE trigger', async () => {
    let incompleteEvent: { bufferId: string; trigger: EarlyEndTrigger } | null = null;
    chunker.on('matchEndedIncomplete', data => {
      incompleteEvent = data;
    });

    // Start match in Nagrand Arena (1505)
    chunker.onMatchStarted(createMatchStartEvent('test-non-arena', 1505));
    expect(chunker.getActiveMatchCount()).toBe(1);

    // Zone change to non-arena (Revendreth - 2222)
    chunker.onZoneChange(createZoneChangeEvent(2222, 'Revendreth'));

    expect(incompleteEvent).not.toBeNull();
    expect(incompleteEvent!.trigger).toBe(EarlyEndTrigger.ZONE_CHANGE);
    expect(chunker.getActiveMatchCount()).toBe(0);
  });

  it('emits exactly one early end event for multiple zone changes', async () => {
    let incompleteEventCount = 0;
    chunker.on('matchEndedIncomplete', () => {
      incompleteEventCount++;
    });

    // Start match in Hook Point (1825)
    chunker.onMatchStarted(createMatchStartEvent('test-duplicate', 1825));
    expect(chunker.getActiveMatchCount()).toBe(1);

    // First zone change ends the match
    chunker.onZoneChange(createZoneChangeEvent(2222, 'Revendreth'));

    // Second zone change should be ignored (match already ended)
    chunker.onZoneChange(createZoneChangeEvent(1672, "Blade's Edge Arena"));

    // Third zone change should also be ignored
    chunker.onZoneChange(createZoneChangeEvent(617, 'Dalaran Sewers'));

    expect(incompleteEventCount).toBe(1);
    expect(chunker.getActiveMatchCount()).toBe(0);
  });

  it('ignores duplicate MATCH_STARTED for the same bufferId (per current implementation)', async () => {
    const bufferId = 'test-duplicate-start';

    // First start - should create match
    chunker.onMatchStarted(createMatchStartEvent(bufferId, 1672));
    expect(chunker.getActiveMatchCount()).toBe(1);

    // Duplicate start with same bufferId - should be ignored
    chunker.onMatchStarted(createMatchStartEvent(bufferId, 1672));
    expect(chunker.getActiveMatchCount()).toBe(1);

    // Another duplicate - still ignored
    chunker.onMatchStarted(createMatchStartEvent(bufferId, 617));
    expect(chunker.getActiveMatchCount()).toBe(1);
  });

  it('ends previous match when new match with different bufferId starts, then zone change ends new match', async () => {
    const incompleteEvents: Array<{ bufferId: string; trigger: string }> = [];
    chunker.on('matchEndedIncomplete', data => {
      incompleteEvents.push({ bufferId: data.bufferId, trigger: data.trigger });
    });

    // Start first match
    chunker.onMatchStarted(createMatchStartEvent('match-1', 1672));
    expect(chunker.getActiveMatchCount()).toBe(1);

    // Start second match - this ends match-1 with NEW_MATCH_START
    chunker.onMatchStarted(createMatchStartEvent('match-2', 617));
    expect(chunker.getActiveMatchCount()).toBe(1);
    expect(incompleteEvents).toHaveLength(1);
    expect(incompleteEvents[0].bufferId).toBe('match-1');
    expect(incompleteEvents[0].trigger).toBe('NEW_MATCH_START');

    // Zone change should end match-2
    chunker.onZoneChange(createZoneChangeEvent(2222, 'Revendreth'));

    expect(incompleteEvents).toHaveLength(2);
    expect(incompleteEvents[1].bufferId).toBe('match-2');
    expect(incompleteEvents[1].trigger).toBe('ZONE_CHANGE');
    expect(chunker.getActiveMatchCount()).toBe(0);
  });

  it('ignores zone changes when no active matches exist', async () => {
    let incompleteEventFired = false;
    chunker.on('matchEndedIncomplete', () => {
      incompleteEventFired = true;
    });

    // No matches started, zone change should be ignored
    chunker.onZoneChange(createZoneChangeEvent(2222, 'Revendreth'));

    expect(incompleteEventFired).toBe(false);
    expect(chunker.getActiveMatchCount()).toBe(0);
  });
});
