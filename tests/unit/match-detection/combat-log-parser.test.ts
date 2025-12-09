import { describe, it, expect, beforeEach } from 'vitest';
import { CombatLogParser } from '../../../src/match-detection/parsing/CombatLogParser';
import {
  MatchEventType,
  MatchStartedEvent,
  MatchEndedEvent,
  ZoneChangeEvent,
} from '../../../src/match-detection/types/MatchEvent';

describe('CombatLogParser - arena match metadata', () => {
  let parser: CombatLogParser;

  beforeEach(() => {
    parser = new CombatLogParser();
  });

  describe('parseLogLine - ARENA_MATCH_START', () => {
    it('parses 2v2 arena start event', () => {
      const line = '8/3/2025 22:12:04.889  ARENA_MATCH_START,2547,33,2v2,1';
      const event = parser.parseLogLine(line);

      expect(event).not.toBeNull();
      expect(event!.type).toBe(MatchEventType.MATCH_STARTED);

      const startEvent = event as MatchStartedEvent;
      expect(startEvent.zoneId).toBe(2547);
      expect(startEvent.bracket).toBe('2v2');
      expect(startEvent.isRanked).toBe(true);
    });

    it('parses 3v3 arena start event', () => {
      const line = '7/15/2025 19:30:12.456  ARENA_MATCH_START,617,45,3v3,1';
      const event = parser.parseLogLine(line);

      expect(event).not.toBeNull();
      expect(event!.type).toBe(MatchEventType.MATCH_STARTED);

      const startEvent = event as MatchStartedEvent;
      expect(startEvent.zoneId).toBe(617);
      expect(startEvent.bracket).toBe('3v3');
      expect(startEvent.isRanked).toBe(true);
    });

    it('parses Solo Shuffle start event and normalizes category', () => {
      const line = '9/1/2025 20:15:30.100  ARENA_MATCH_START,2547,33,Rated Solo Shuffle,3';
      const event = parser.parseLogLine(line);

      expect(event).not.toBeNull();
      expect(event!.type).toBe(MatchEventType.MATCH_STARTED);

      const startEvent = event as MatchStartedEvent;
      expect(startEvent.zoneId).toBe(2547);
      expect(startEvent.bracket).toBe('Solo Shuffle');
      expect(startEvent.isRanked).toBe(true);
    });

    it('parses TWW format arena start with year in timestamp', () => {
      const line = '7/27/2024 21:39:13.095  ARENA_MATCH_START,2547,33,2v2,1';
      const event = parser.parseLogLine(line);

      expect(event).not.toBeNull();
      expect(event!.type).toBe(MatchEventType.MATCH_STARTED);

      const startEvent = event as MatchStartedEvent;
      expect(startEvent.zoneId).toBe(2547);
      expect(startEvent.bracket).toBe('2v2');
    });

    it('filters skirmish (unranked) matches', () => {
      const line = '6/22/2025 14:05:33.222  ARENA_MATCH_START,1552,21,Skirmish,0';
      const event = parser.parseLogLine(line);

      // Skirmish returns null because isRanked=false
      expect(event).toBeNull();
    });

    it('returns null for unknown arena type', () => {
      const line = '8/3/2025 22:12:04.889  ARENA_MATCH_START,2547,33,UnknownType,1';
      const event = parser.parseLogLine(line);

      expect(event).toBeNull();
    });
  });

  describe('parseLogLine - ARENA_MATCH_END', () => {
    it('parses arena end event and extracts duration', () => {
      // First start a match
      parser.parseLogLine('8/3/2025 22:12:04.889  ARENA_MATCH_START,2547,33,2v2,1');

      // Then end it
      const line = '8/3/2025 22:12:14.889  ARENA_MATCH_END,0,8,1673,1668';
      const event = parser.parseLogLine(line);

      expect(event).not.toBeNull();
      expect(event!.type).toBe(MatchEventType.MATCH_ENDED);

      const endEvent = event as MatchEndedEvent;
      expect(endEvent.metadata.matchDuration).toBe(8);
      expect(endEvent.metadata.winningTeamId).toBe(0);
    });

    it('extracts winning team ID from end event', () => {
      parser.parseLogLine('7/15/2025 19:30:12.456  ARENA_MATCH_START,617,45,3v3,1');

      const line = '7/15/2025 19:35:45.123  ARENA_MATCH_END,1,12,2834,2801';
      const event = parser.parseLogLine(line);

      expect(event).not.toBeNull();
      const endEvent = event as MatchEndedEvent;
      expect(endEvent.metadata.winningTeamId).toBe(1);
      expect(endEvent.metadata.matchDuration).toBe(12);
    });

    it('returns null for end event without prior start', () => {
      const line = '8/3/2025 22:12:14.889  ARENA_MATCH_END,0,8,1673,1668';
      const event = parser.parseLogLine(line);

      // No match started, so end event is ignored
      expect(event).toBeNull();
    });
  });

  describe('parseLogLine - ZONE_CHANGE', () => {
    it('parses zone change events', () => {
      const line = '1/23/2025 19:52:00.696  ZONE_CHANGE,1672,"Blade\'s Edge Arena",0';
      const event = parser.parseLogLine(line);

      expect(event).not.toBeNull();
      expect(event!.type).toBe(MatchEventType.ZONE_CHANGE);

      const zoneEvent = event as ZoneChangeEvent;
      expect(zoneEvent.zoneId).toBe(1672);
      expect(zoneEvent.zoneName).toBe("Blade's Edge Arena");
    });

    it('parses zone change to non-arena zone', () => {
      const line = '1/23/2025 19:54:57.015  ZONE_CHANGE,2222,"Revendreth",0';
      const event = parser.parseLogLine(line);

      expect(event).not.toBeNull();
      const zoneEvent = event as ZoneChangeEvent;
      expect(zoneEvent.zoneId).toBe(2222);
      expect(zoneEvent.zoneName).toBe('Revendreth');
    });
  });

  describe('parseLogLine - non-match events', () => {
    it('returns null for spell cast events', () => {
      const line =
        '8/3/2025 22:12:04.889  SPELL_CAST_SUCCESS,Player-123,PlayerName,0x511,0x0,Target-456,TargetName,0x10a48,0x0,12345,"Spell Name",0x1';
      const event = parser.parseLogLine(line);

      expect(event).toBeNull();
    });

    it('returns null for damage events', () => {
      const line =
        '8/3/2025 22:12:05.100  SPELL_DAMAGE,Player-123,"PlayerName",0x511,0x0,Target-456,"TargetName",0x10a48,0x0,12345,"Spell Name",0x1,Target-456,0,100,0,0,0,nil,nil,nil,nil,nil';
      const event = parser.parseLogLine(line);

      expect(event).toBeNull();
    });
  });
});

describe('CombatLogParser - state management', () => {
  let parser: CombatLogParser;

  beforeEach(() => {
    parser = new CombatLogParser();
  });

  it('getCurrentMatch returns null when no match active', () => {
    expect(parser.getCurrentMatch()).toBeNull();
  });

  it('getCurrentMatch returns match info after start', () => {
    parser.parseLogLine('8/3/2025 22:12:04.889  ARENA_MATCH_START,2547,33,2v2,1');

    const current = parser.getCurrentMatch();
    expect(current).not.toBeNull();
    expect(current!.bracket).toBe('2v2');
  });

  it('getCurrentMatch returns null after match end', () => {
    parser.parseLogLine('8/3/2025 22:12:04.889  ARENA_MATCH_START,2547,33,2v2,1');
    parser.parseLogLine('8/3/2025 22:12:14.889  ARENA_MATCH_END,0,8,1673,1668');

    expect(parser.getCurrentMatch()).toBeNull();
  });

  it('reset() clears all state', () => {
    parser.parseLogLine('8/3/2025 22:12:04.889  ARENA_MATCH_START,2547,33,2v2,1');
    expect(parser.getCurrentMatch()).not.toBeNull();

    parser.reset();

    expect(parser.getCurrentMatch()).toBeNull();
  });
});
