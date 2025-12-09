import { describe, it, expect, beforeEach } from 'vitest';
import { ShuffleRoundTracker } from '../../../src/match-detection/parsing/ShuffleRoundTracker';
import CombatLogLine from '../../../src/match-detection/parsing/CombatLogLine';

describe('ShuffleRoundTracker', () => {
  let tracker: ShuffleRoundTracker;

  beforeEach(() => {
    tracker = new ShuffleRoundTracker();
  });

  describe('shuffle session lifecycle', () => {
    it('initializes with inactive state', () => {
      expect(tracker.isShuffleActive()).toBe(false);
      expect(tracker.getCurrentRounds()).toHaveLength(0);
    });

    it('activates on startShuffle', () => {
      const startTime = new Date('2024-08-03T22:12:04.889Z');
      tracker.startShuffle('shuffle-test-123', startTime);

      expect(tracker.isShuffleActive()).toBe(true);
      expect(tracker.getBufferId()).toBe('shuffle-test-123');
      expect(tracker.getCurrentRoundNumber()).toBe(1);
      expect(tracker.getCurrentRounds()).toHaveLength(1);
    });

    it('finalizes rounds and returns summary on finalizeShuffle', () => {
      const startTime = new Date('2024-08-03T22:12:04.889Z');
      tracker.startShuffle('shuffle-test-123', startTime);

      // Add some combatants
      tracker.addCombatant('Player-1234-AAAA', 0, 'TestPlayer1');
      tracker.addCombatant('Player-1234-BBBB', 1, 'TestPlayer2');

      // Finalize the shuffle
      const endTime = new Date('2024-08-03T22:15:04.889Z');
      const summary = tracker.finalizeShuffle(endTime);

      expect(summary).not.toBeNull();
      expect(summary!.rounds).toHaveLength(1);
      expect(tracker.isShuffleActive()).toBe(false);
    });
  });

  describe('round tracking', () => {
    beforeEach(() => {
      tracker.startShuffle('shuffle-test', new Date('2024-08-03T22:00:00.000Z'));
    });

    it('tracks multiple rounds', () => {
      // Round 1 already started via startShuffle
      expect(tracker.getCurrentRoundNumber()).toBe(1);

      // Start round 2
      tracker.startNewRound(new Date('2024-08-03T22:02:00.000Z'));
      expect(tracker.getCurrentRoundNumber()).toBe(2);

      // Start round 3
      tracker.startNewRound(new Date('2024-08-03T22:04:00.000Z'));
      expect(tracker.getCurrentRoundNumber()).toBe(3);

      // Finalize shuffle
      const summary = tracker.finalizeShuffle(new Date('2024-08-03T22:06:00.000Z'));

      // Should have 3 rounds
      expect(summary!.rounds).toHaveLength(3);
      expect(summary!.rounds[0].roundNumber).toBe(1);
      expect(summary!.rounds[1].roundNumber).toBe(2);
      expect(summary!.rounds[2].roundNumber).toBe(3);
    });

    it('tracks round durations correctly', () => {
      // Round 1: 2 minutes
      tracker.startNewRound(new Date('2024-08-03T22:02:00.000Z'));

      // Round 2: 3 minutes
      tracker.startNewRound(new Date('2024-08-03T22:05:00.000Z'));

      // Finalize after 1 more minute
      const summary = tracker.finalizeShuffle(new Date('2024-08-03T22:06:00.000Z'));

      // Round 1: 120 seconds
      expect(summary!.rounds[0].duration).toBe(120);
      // Round 2: 180 seconds
      expect(summary!.rounds[1].duration).toBe(180);
      // Round 3: 60 seconds
      expect(summary!.rounds[2].duration).toBe(60);
    });
  });

  describe('combatant tracking', () => {
    beforeEach(() => {
      tracker.startShuffle('shuffle-test', new Date('2024-08-03T22:00:00.000Z'));
    });

    it('tracks combatants per round', () => {
      // Add combatants to round 1
      tracker.addCombatant('Player-1234-AAAA', 0, 'Player1');
      tracker.addCombatant('Player-1234-BBBB', 0, 'Player2');
      tracker.addCombatant('Player-1234-CCCC', 1, 'Player3');
      tracker.addCombatant('Player-1234-DDDD', 1, 'Player4');

      const rounds = tracker.getCurrentRounds();
      expect(rounds[0].players.size).toBe(4);
    });

    it('resets combatants on new round', () => {
      // Add combatants to round 1
      tracker.addCombatant('Player-1234-AAAA', 0, 'Player1');
      tracker.addCombatant('Player-1234-BBBB', 1, 'Player2');

      // Start round 2
      tracker.startNewRound(new Date('2024-08-03T22:02:00.000Z'));

      // Round 2 (current) should have empty players
      const rounds = tracker.getCurrentRounds();
      const currentRound = rounds[rounds.length - 1];
      expect(currentRound.players.size).toBe(0);
    });
  });

  describe('death handling', () => {
    beforeEach(() => {
      tracker.startShuffle('shuffle-test', new Date('2024-08-03T22:00:00.000Z'));
      tracker.addCombatant('Player-1234-AAAA', 0, 'Player1');
      tracker.addCombatant('Player-1234-BBBB', 1, 'Player2');
    });

    it('determines winner from death event', () => {
      // Simulate UNIT_DIED event - Player2 (team 1) dies, Team 0 wins
      const deathLine = new CombatLogLine(
        '8/3/2025 22:01:30.000  UNIT_DIED,0000000000000000,nil,0x80000000,0x80000000,Player-1234-BBBB,"Player2",0x511,0x0'
      );

      const result = tracker.handleDeath(deathLine);

      expect(result).toBe(true);
      const rounds = tracker.getCurrentRounds();
      expect(rounds[0].winningTeamId).toBe(0);
      expect(rounds[0].killedPlayerId).toBe('Player-1234-BBBB');
    });

    it('prevents winner overwrites (first death wins)', () => {
      // First death
      const death1 = new CombatLogLine(
        '8/3/2025 22:01:30.000  UNIT_DIED,0000000000000000,nil,0x80000000,0x80000000,Player-1234-BBBB,"Player2",0x511,0x0'
      );
      tracker.handleDeath(death1);

      // Second death (should be ignored)
      const death2 = new CombatLogLine(
        '8/3/2025 22:01:31.000  UNIT_DIED,0000000000000000,nil,0x80000000,0x80000000,Player-1234-AAAA,"Player1",0x511,0x0'
      );
      const result = tracker.handleDeath(death2);

      expect(result).toBe(false);
      const rounds = tracker.getCurrentRounds();
      expect(rounds[0].winningTeamId).toBe(0); // Still team 0
    });
  });

  describe('team compositions', () => {
    beforeEach(() => {
      tracker.startShuffle('shuffle-test', new Date('2024-08-03T22:00:00.000Z'));
    });

    it('returns team compositions correctly', () => {
      tracker.addCombatant('Player-1234-AAAA', 0, 'Player1');
      tracker.addCombatant('Player-1234-BBBB', 0, 'Player2');
      tracker.addCombatant('Player-1234-CCCC', 1, 'Player3');
      tracker.addCombatant('Player-1234-DDDD', 1, 'Player4');

      const rounds = tracker.getCurrentRounds();
      const compositions = tracker.getTeamCompositions(rounds[0]);

      expect(compositions.team0Players).toHaveLength(2);
      expect(compositions.team1Players).toHaveLength(2);
      expect(compositions.team0Players).toContain('Player-1234-AAAA');
      expect(compositions.team1Players).toContain('Player-1234-CCCC');
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      tracker.startShuffle('shuffle-test', new Date());
      tracker.addCombatant('Player-1234-AAAA', 0);

      tracker.reset();

      expect(tracker.isShuffleActive()).toBe(false);
      expect(tracker.getCurrentRounds()).toHaveLength(0);
      expect(tracker.getBufferId()).toBeUndefined();
    });
  });

  describe('finalizeShuffle edge cases', () => {
    it('returns null when no shuffle active', () => {
      const summary = tracker.finalizeShuffle(new Date());
      expect(summary).toBeNull();
    });

    it('returns null after already finalized', () => {
      tracker.startShuffle('shuffle-test', new Date('2024-08-03T22:00:00.000Z'));
      tracker.finalizeShuffle(new Date('2024-08-03T22:06:00.000Z'));

      const secondSummary = tracker.finalizeShuffle(new Date());
      expect(secondSummary).toBeNull();
    });
  });
});
