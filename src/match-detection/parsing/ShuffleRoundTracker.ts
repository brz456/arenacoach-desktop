import CombatLogLine from './CombatLogLine';
import { extractDeathEvent, calculateRelativeTimestamp } from '../utils/DeathEventUtils';

export interface RoundData {
  roundNumber: number;
  startTime: Date;
  endTime?: Date;
  startTimestamp: number; // ms relative to shuffle start
  endTimestamp?: number; // ms relative to shuffle start
  players: Map<string, { teamId: number; name?: string }>;
  winningTeamId?: number;
  killedPlayerId?: string;
  duration?: number; // seconds
}

export interface ShuffleState {
  isActive: boolean;
  firstStartTime?: Date;
  bufferId?: string;
  rounds: RoundData[];
  currentRound?: RoundData | undefined;
  recordingPlayerId?: string;
}

export class ShuffleRoundTracker {
  private state: ShuffleState = {
    isActive: false,
    rounds: [],
  };

  /**
   * Calculate duration in seconds from timestamps in milliseconds
   */
  private calculateDuration(startTimestamp: number, endTimestamp: number): number {
    return Math.round((endTimestamp - startTimestamp) / 1000);
  }

  public startShuffle(bufferId: string, startTime: Date): void {
    this.state = {
      isActive: true,
      firstStartTime: startTime,
      bufferId: bufferId,
      rounds: [],
      currentRound: {
        roundNumber: 1,
        startTime: startTime,
        startTimestamp: 0, // First round starts at 0ms
        players: new Map(),
      },
    };
  }

  public startNewRound(startTime: Date): void {
    if (!this.state.isActive || !this.state.firstStartTime) return;

    // Finalize previous round if exists
    if (this.state.currentRound) {
      // CRITICAL FIX: Only set end timestamps if not already set by handleDeath()
      if (!this.state.currentRound.endTime) {
        const endTimestamp = startTime.getTime() - this.state.firstStartTime.getTime();
        this.state.currentRound.endTime = startTime;
        this.state.currentRound.endTimestamp = endTimestamp;
      }
      if (!this.state.currentRound.duration && this.state.currentRound.endTimestamp !== undefined) {
        this.state.currentRound.duration = this.calculateDuration(
          this.state.currentRound.startTimestamp,
          this.state.currentRound.endTimestamp
        );
      }
      this.state.rounds.push(this.state.currentRound);
    }

    // Start new round
    const startTimestamp = startTime.getTime() - this.state.firstStartTime.getTime();
    this.state.currentRound = {
      roundNumber: this.state.rounds.length + 1,
      startTime: startTime,
      startTimestamp: startTimestamp,
      players: new Map(),
    };
  }

  public addCombatant(guid: string, teamId: number, name?: string): void {
    if (!this.state.currentRound) return;
    const playerData = { teamId, ...(name !== undefined && { name }) };
    this.state.currentRound.players.set(guid, playerData);
  }

  public setRecordingPlayer(playerId: string): void {
    this.state.recordingPlayerId = playerId;
  }

  /**
   * Use destGUID at field 5 for UNIT_DIED events
   */
  public handleDeath(logLine: CombatLogLine): boolean {
    if (!this.state.isActive || !this.state.currentRound) return false;

    // Guard against winner overwrites
    if (this.state.currentRound.winningTeamId !== undefined) return false;

    // Use shared utility to extract death event
    const deathEvent = extractDeathEvent(logLine);
    if (!deathEvent) return false;

    const player = this.state.currentRound.players.get(deathEvent.killedPlayerId);
    if (!player) return false;

    // First player death ends round - determine winner as the other team
    this.state.currentRound.killedPlayerId = deathEvent.killedPlayerId;

    // Get all teams present in this round
    const teamsPresent = new Set<number>();
    this.state.currentRound.players.forEach(p => teamsPresent.add(p.teamId));

    // Winner is the team that didn't lose a player
    const winningTeamId = Array.from(teamsPresent).find(teamId => teamId !== player.teamId);
    if (winningTeamId !== undefined) {
      this.state.currentRound.winningTeamId = winningTeamId;
    }
    this.state.currentRound.endTime = deathEvent.timestamp;

    // Calculate relative timestamp
    if (this.state.firstStartTime) {
      this.state.currentRound.endTimestamp = calculateRelativeTimestamp(
        deathEvent.timestamp,
        this.state.firstStartTime
      );
      this.state.currentRound.duration = this.calculateDuration(
        this.state.currentRound.startTimestamp,
        this.state.currentRound.endTimestamp
      );
    }

    return true; // Round ended
  }

  /**
   * Get current rounds without finalizing.
   * Returns completed rounds + current round in progress (if active).
   * Also returns finalized rounds after finalizeShuffle() sets isActive = false.
   */
  public getCurrentRounds(): RoundData[] {
    const allRounds = [...this.state.rounds];
    if (this.state.currentRound) {
      allRounds.push(this.state.currentRound);
    }
    return allRounds;
  }

  public finalizeShuffle(endTime: Date): ShuffleState | null {
    if (!this.state.isActive || !this.state.firstStartTime) return null;

    // Finalize last round
    if (this.state.currentRound) {
      if (!this.state.currentRound.endTime) {
        this.state.currentRound.endTime = endTime;
        this.state.currentRound.endTimestamp =
          endTime.getTime() - this.state.firstStartTime.getTime();
      }
      if (!this.state.currentRound.duration && this.state.currentRound.endTimestamp !== undefined) {
        this.state.currentRound.duration = this.calculateDuration(
          this.state.currentRound.startTimestamp,
          this.state.currentRound.endTimestamp
        );
      }
      this.state.rounds.push(this.state.currentRound);
      this.state.currentRound = undefined; // Prevent double-counting in getCurrentRounds()
    }

    // Mark inactive to prevent further round additions
    this.state.isActive = false;

    return { ...this.state };
  }

  public isShuffleActive(): boolean {
    return this.state.isActive;
  }

  public getBufferId(): string | undefined {
    return this.state.bufferId;
  }

  public getCurrentRoundNumber(): number {
    return this.state.rounds.length + 1;
  }

  /**
   * CRITICAL: Reset on zone changes or early endings
   */
  public reset(): void {
    this.state = {
      isActive: false,
      rounds: [],
    };
  }

  /**
   * Get team compositions for a round
   */
  public getTeamCompositions(round: RoundData): { team0Players: string[]; team1Players: string[] } {
    const team0Players: string[] = [];
    const team1Players: string[] = [];

    round.players.forEach((playerData, guid) => {
      if (playerData.teamId === 0) {
        team0Players.push(guid);
      } else if (playerData.teamId === 1) {
        team1Players.push(guid);
      }
    });

    return { team0Players, team1Players };
  }
}
