import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import MatchLogWatcher from '../../../src/match-detection/parsing/MatchLogWatcher';
import { MatchStartedEvent, MatchEndedEvent } from '../../../src/match-detection/types/MatchEvent';
import { createTempTestDir, cleanupTempDir } from '../../helpers/matchDetectionTestUtils';

describe('MatchLogWatcher - event emission', () => {
  let watcher: MatchLogWatcher;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempTestDir('watcher-events-');
    watcher = new MatchLogWatcher(tempDir, 10);
  });

  afterEach(async () => {
    watcher.cleanup();
    await cleanupTempDir(tempDir);
  });

  it('emits matchStarted for valid arena start line', () => {
    const events: MatchStartedEvent[] = [];
    watcher.on('matchStarted', (event: MatchStartedEvent) => {
      events.push(event);
    });

    watcher.handleLogLine('8/3/2025 22:12:04.889  ARENA_MATCH_START,2547,33,2v2,1');

    expect(events).toHaveLength(1);
    expect(events[0].zoneId).toBe(2547);
    expect(events[0].bracket).toBe('2v2');
    expect(events[0].isRanked).toBe(true);
  });

  it('emits matchEnded for valid arena end line after start', () => {
    const startEvents: MatchStartedEvent[] = [];
    const endEvents: MatchEndedEvent[] = [];

    watcher.on('matchStarted', (event: MatchStartedEvent) => {
      startEvents.push(event);
    });
    watcher.on('matchEnded', (event: MatchEndedEvent) => {
      endEvents.push(event);
    });

    watcher.handleLogLine('8/3/2025 22:12:04.889  ARENA_MATCH_START,2547,33,2v2,1');
    watcher.handleLogLine('8/3/2025 22:12:14.889  ARENA_MATCH_END,0,8,1673,1668');

    expect(startEvents).toHaveLength(1);
    expect(endEvents).toHaveLength(1);
    expect(endEvents[0].metadata.matchDuration).toBe(8);
  });

  it('does not emit events for non-arena lines', () => {
    const events: any[] = [];
    watcher.on('matchStarted', event => events.push(event));
    watcher.on('matchEnded', event => events.push(event));

    // Spell cast event
    watcher.handleLogLine(
      '8/3/2025 22:12:04.889  SPELL_CAST_SUCCESS,Player-123,PlayerName,0x511,0x0,Target-456,TargetName,0x10a48,0x0,12345,"Spell Name",0x1'
    );

    expect(events).toHaveLength(0);
  });

  it('does not emit events for skirmish (unranked) matches', () => {
    const events: any[] = [];
    watcher.on('matchStarted', event => events.push(event));

    watcher.handleLogLine('6/22/2025 14:05:33.222  ARENA_MATCH_START,1552,21,Skirmish,0');

    expect(events).toHaveLength(0);
  });

  it('emits zoneChange events', () => {
    const events: any[] = [];
    watcher.on('zoneChange', event => events.push(event));

    watcher.handleLogLine('1/23/2025 19:52:00.696  ZONE_CHANGE,1672,"Blade\'s Edge Arena",0');

    expect(events).toHaveLength(1);
    expect(events[0].zoneId).toBe(1672);
    expect(events[0].zoneName).toBe("Blade's Edge Arena");
  });

  it('emits logChunk with all lines processed', () => {
    const chunks: any[] = [];
    watcher.on('logChunk', chunk => chunks.push(chunk));

    watcher.handleLogLine('8/3/2025 22:12:04.889  ARENA_MATCH_START,2547,33,2v2,1');

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(1);
    expect(chunks[0][0].line).toContain('ARENA_MATCH_START');
  });

  it('handles multiple match start/end cycles', () => {
    const startEvents: MatchStartedEvent[] = [];
    const endEvents: MatchEndedEvent[] = [];

    watcher.on('matchStarted', (event: MatchStartedEvent) => startEvents.push(event));
    watcher.on('matchEnded', (event: MatchEndedEvent) => endEvents.push(event));

    // First match
    watcher.handleLogLine('8/3/2025 22:12:04.889  ARENA_MATCH_START,2547,33,2v2,1');
    watcher.handleLogLine('8/3/2025 22:12:14.889  ARENA_MATCH_END,0,8,1673,1668');

    // Second match
    watcher.handleLogLine('8/3/2025 22:15:04.889  ARENA_MATCH_START,617,45,3v3,1');
    watcher.handleLogLine('8/3/2025 22:20:14.889  ARENA_MATCH_END,1,12,2000,1995');

    expect(startEvents).toHaveLength(2);
    expect(endEvents).toHaveLength(2);

    expect(startEvents[0].bracket).toBe('2v2');
    expect(startEvents[1].bracket).toBe('3v3');
  });
});

describe('MatchLogWatcher - state', () => {
  let watcher: MatchLogWatcher;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempTestDir('watcher-state-');
    watcher = new MatchLogWatcher(tempDir, 10);
  });

  afterEach(async () => {
    watcher.cleanup();
    await cleanupTempDir(tempDir);
  });

  it('getCurrentMatch returns null when no match active', () => {
    expect(watcher.getCurrentMatch()).toBeNull();
  });

  it('getCurrentMatch returns match info during active match', () => {
    watcher.handleLogLine('8/3/2025 22:12:04.889  ARENA_MATCH_START,2547,33,2v2,1');

    const current = watcher.getCurrentMatch();
    expect(current).not.toBeNull();
    expect(current!.bracket).toBe('2v2');
  });

  it('getSystemMetrics returns metrics object', () => {
    const metrics = watcher.getSystemMetrics();

    expect(metrics).toBeDefined();
    expect(typeof metrics.linesProcessed).toBe('number');
    expect(typeof metrics.errorsHandled).toBe('number');
  });
});
