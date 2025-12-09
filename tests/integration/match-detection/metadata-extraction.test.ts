import { describe, it, expect, beforeEach } from 'vitest';
import { CombatLogParser } from '../../../src/match-detection/parsing/CombatLogParser';
import {
  MatchEventType,
  MatchStartedEvent,
  MatchEndedEvent,
} from '../../../src/match-detection/types/MatchEvent';
import { loadFixtureLog } from '../../helpers/matchDetectionTestUtils';

/**
 * Metadata Extraction Tests
 * Tests that CombatLogParser correctly extracts player metadata from COMBATANT_INFO
 * events and correlates them with match start/end events.
 */
describe('Metadata Extraction', () => {
  let parser: CombatLogParser;

  beforeEach(() => {
    parser = new CombatLogParser();
  });

  describe('COMBATANT_INFO parsing', () => {
    it('extracts player data from real 3v3 match', async () => {
      const lines = await loadFixtureLog('3v3-single-match.txt');

      let startEvent: MatchStartedEvent | null = null;
      let endEvent: MatchEndedEvent | null = null;

      for (const line of lines) {
        const event = parser.parseLogLine(line);
        if (event?.type === MatchEventType.MATCH_STARTED) {
          startEvent = event as MatchStartedEvent;
        } else if (event?.type === MatchEventType.MATCH_ENDED) {
          endEvent = event as MatchEndedEvent;
        }
      }

      // Match should be detected
      expect(startEvent).not.toBeNull();
      expect(endEvent).not.toBeNull();

      // Verify match metadata
      expect(startEvent!.bracket).toBe('3v3');
      expect(startEvent!.zoneId).toBe(1505); // Nagrand Arena
      expect(startEvent!.isRanked).toBe(true);

      // Verify end metadata
      expect(endEvent!.metadata).toBeDefined();
      expect(endEvent!.metadata.matchDuration).toBe(90);
      expect(endEvent!.metadata.bracket).toBe('3v3');
      expect(endEvent!.metadata.season).toBe(39);

      // Verify MMR extraction
      expect(endEvent!.metadata.team0MMR).toBe(2064);
      expect(endEvent!.metadata.team1MMR).toBe(1864);
    });

    it('extracts player metadata with spec and class IDs', async () => {
      const lines = await loadFixtureLog('3v3-single-match.txt');

      let endEvent: MatchEndedEvent | null = null;

      for (const line of lines) {
        const event = parser.parseLogLine(line);
        if (event?.type === MatchEventType.MATCH_ENDED) {
          endEvent = event as MatchEndedEvent;
        }
      }

      expect(endEvent).not.toBeNull();
      const players = endEvent!.metadata.players;

      // Should have 6 players in a 3v3
      expect(players.length).toBe(6);

      // Each player should have required fields from COMBATANT_INFO
      for (const player of players) {
        expect(player.id).toMatch(/^Player-\d+-[A-F0-9]+$/);
        expect([0, 1]).toContain(player.teamId);
        expect(player.specId).toBeGreaterThan(0);
        expect(typeof player.personalRating).toBe('number');
      }

      // Verify team distribution (3 per team)
      const team0Count = players.filter(p => p.teamId === 0).length;
      const team1Count = players.filter(p => p.teamId === 1).length;
      expect(team0Count).toBe(3);
      expect(team1Count).toBe(3);
    });

    it('extracts player names from SPELL events', async () => {
      const lines = await loadFixtureLog('3v3-single-match.txt');

      let endEvent: MatchEndedEvent | null = null;

      for (const line of lines) {
        const event = parser.parseLogLine(line);
        if (event?.type === MatchEventType.MATCH_ENDED) {
          endEvent = event as MatchEndedEvent;
        }
      }

      expect(endEvent).not.toBeNull();
      const players = endEvent!.metadata.players;

      // At least some players should have names extracted from SPELL_ events
      const playersWithNames = players.filter(p => p.name && p.name !== 'Unknown');

      // Real match should have most player names extracted
      expect(playersWithNames.length).toBeGreaterThanOrEqual(4);

      // Verify name format (Name-Realm-Region)
      for (const player of playersWithNames) {
        // Names should be extracted, might have realm info
        expect(player.name!.length).toBeGreaterThan(0);
        expect(player.name).not.toBe('0'); // Not corrupted by team ID
        expect(player.name).not.toBe('1');
      }
    });
  });

  describe('winning team detection', () => {
    it('correctly identifies winning team from ARENA_MATCH_END', async () => {
      const lines = await loadFixtureLog('3v3-single-match.txt');

      let endEvent: MatchEndedEvent | null = null;

      for (const line of lines) {
        const event = parser.parseLogLine(line);
        if (event?.type === MatchEventType.MATCH_ENDED) {
          endEvent = event as MatchEndedEvent;
        }
      }

      expect(endEvent).not.toBeNull();
      // ARENA_MATCH_END,0,90,2064,1864 - first arg after event is winningTeamId
      expect(endEvent!.metadata.winningTeamId).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('handles match end without prior start (returns null)', () => {
      const endLine = '3/5/2025 12:45:44.8521  ARENA_MATCH_END,0,90,2064,1864';
      const event = parser.parseLogLine(endLine);

      // No match started, so end is ignored
      expect(event).toBeNull();
    });

    it('handles skirmish matches (filtered out)', () => {
      const skirmishLine = '8/3/2025 22:12:04.889  ARENA_MATCH_START,2547,33,Skirmish,0';
      const event = parser.parseLogLine(skirmishLine);

      // Skirmish is unranked (last arg is 0), should be filtered
      expect(event).toBeNull();
    });
  });
});
