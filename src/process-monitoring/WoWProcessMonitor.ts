import { EventEmitter } from 'events';
import { exec } from 'child_process';
import { promisify } from 'util';
import { WoWProcessMonitorError, WoWProcessMonitorErrorFactory } from './WoWProcessMonitorErrors';
import { activeFlavor } from '../config/wowFlavor';

const execAsync = promisify(exec);

/**
 * Events emitted by WoWProcessMonitor
 */
export interface WoWProcessEvents {
  wowProcessStart: () => void;
  wowProcessStop: () => void;
  error: (error: WoWProcessMonitorError) => void;
}

/**
 * WoW process monitoring system that detects when World of Warcraft is running
 *
 * Uses Windows tasklist command to monitor for WoW processes with 2-second polling.
 * Emits events when WoW starts or stops to control the match detection lifecycle.
 *
 * Reliability features:
 * - First poll is awaited before start() resolves (guarantees initial state)
 * - Early re-check at 750ms catches processes starting immediately after init
 * - Stop detection requires consecutive not-running polls (hysteresis)
 */
export class WoWProcessMonitor extends EventEmitter {
  private isWowRunning = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private monitorGeneration = 0;
  private readonly POLL_INTERVAL_MS = 2000; // 2 seconds - improved responsiveness while maintaining reliability
  private static get WOW_PROCESS_REGEX(): RegExp {
    return activeFlavor.processNameRegex;
  }
  private isMonitoring = false;
  private isShuttingDown = false;
  private hasLoggedPlatformWarning = false;
  private firstPollCompleted = false;
  private consecutiveNotRunningCount = 0;
  private readonly STOP_DETECTION_THRESHOLD = 3; // Require 3 consecutive not-running polls before emitting stop

  declare on: <K extends keyof WoWProcessEvents>(event: K, listener: WoWProcessEvents[K]) => this;
  declare emit: <K extends keyof WoWProcessEvents>(
    event: K,
    ...args: Parameters<WoWProcessEvents[K]>
  ) => boolean;

  /**
   * Start monitoring for WoW processes with first-poll guarantee
   */
  public async start(): Promise<void> {
    if (this.isMonitoring) {
      console.warn('[WoWProcessMonitor] Already monitoring processes');
      return;
    }

    if (this.isShuttingDown) {
      console.warn('[WoWProcessMonitor] Cannot start during shutdown');
      return;
    }

    console.info('[WoWProcessMonitor] Starting WoW process monitoring...');
    this.isMonitoring = true;
    this.isShuttingDown = false;
    this.monitorGeneration += 1;
    const generation = this.monitorGeneration;

    try {
      // Perform initial check immediately and await completion (first-poll guarantee)
      await this.poll(generation);

      // Guard: if stop() was called during poll, don't proceed with timer setup
      if (!this.isMonitoring || this.isShuttingDown || this.monitorGeneration !== generation) {
        return;
      }

      this.firstPollCompleted = true;
      console.info('[WoWProcessMonitor] First poll completed, WoW status:', this.isWowRunning);

      // Start polling loop with short initial delay for re-check, then standard interval
      // All polling goes through one sequential scheduler to prevent overlapping polls
      this.scheduleNextPoll(generation, 750);

      console.info('[WoWProcessMonitor] Process monitoring started');
    } catch (error) {
      const typedError = WoWProcessMonitorErrorFactory.fromUnknownError(error);
      console.error('[WoWProcessMonitor] Initial poll failed:', typedError.getFormattedMessage());
      this.emit('error', typedError);
      throw error; // Re-throw to indicate startup failure
    }
  }

  /**
   * Stop monitoring with proper cleanup
   */
  public stop(): void {
    if (!this.isMonitoring) {
      return;
    }

    console.info('[WoWProcessMonitor] Stopping WoW process monitoring...');
    this.isShuttingDown = true;
    this.monitorGeneration += 1;

    // Clear the polling timeout
    if (this.pollInterval) {
      clearTimeout(this.pollInterval);
      this.pollInterval = null;
    }

    // Reset state
    this.isMonitoring = false;
    this.isWowRunning = false;
    this.consecutiveNotRunningCount = 0;
    this.firstPollCompleted = false;
    this.isShuttingDown = false; // Safe due to monitorGeneration invalidating in-flight polls

    console.info('[WoWProcessMonitor] Process monitoring stopped');
  }

  /**
   * Get current WoW running status
   */
  public getWoWStatus(): {
    isRunning: boolean;
    isMonitoring: boolean;
    firstPollCompleted: boolean;
  } {
    return {
      isRunning: this.isWowRunning,
      isMonitoring: this.isMonitoring,
      firstPollCompleted: this.firstPollCompleted,
    };
  }

  /**
   * Perform one-time WoW process check without starting monitoring
   * Used for initial state queries when monitoring hasn't started yet
   * Throws on command failure - callers must handle errors explicitly
   */
  public static async checkNow(): Promise<{ isRunning: boolean }> {
    // Use filtered tasklist for active flavor's executable (case-insensitive on Windows)
    const processName = activeFlavor.windowsExecutable;
    const { stdout } = await execAsync(`tasklist /FI "IMAGENAME eq ${processName}"`, {
      timeout: 10000,
      encoding: 'utf8',
    });

    // Regex match is locale-agnostic: if process exists, its name appears in output
    const isWowRunning = WoWProcessMonitor.WOW_PROCESS_REGEX.test(stdout);
    return { isRunning: isWowRunning };
  }

  /**
   * Schedule the next poll after a delay, ensuring sequential execution
   * Uses setTimeout for self-scheduling to prevent overlapping polls
   * @param generation - Monitor generation to validate against
   * @param delayMs - Delay before poll (defaults to POLL_INTERVAL_MS, use shorter for initial re-check)
   */
  private scheduleNextPoll(generation: number, delayMs: number = this.POLL_INTERVAL_MS): void {
    if (!this.isMonitoring || this.isShuttingDown || this.monitorGeneration !== generation) {
      return;
    }

    this.pollInterval = setTimeout(async () => {
      if (!this.isMonitoring || this.isShuttingDown || this.monitorGeneration !== generation) {
        return;
      }

      // poll() handles its own errors internally and does not rethrow
      await this.poll(generation);

      // Schedule next poll after this one completes (always use standard interval)
      this.scheduleNextPoll(generation);
    }, delayMs);
  }

  /**
   * Poll for WoW processes using Windows tasklist command
   */
  private async poll(generation: number): Promise<void> {
    if (!this.isMonitoring || this.isShuttingDown || this.monitorGeneration !== generation) {
      return;
    }
    try {
      const isCurrentlyRunning = await this.checkWowProcess();
      if (!this.isMonitoring || this.isShuttingDown || this.monitorGeneration !== generation) {
        return;
      }

      // Handle state transitions with hysteresis for stop detection
      if (isCurrentlyRunning) {
        // WoW detected - reset counter, handle start immediately
        this.consecutiveNotRunningCount = 0;

        if (!this.isWowRunning) {
          this.isWowRunning = true;
          console.info('[WoWProcessMonitor] WoW process detected - starting match detection');
          this.emit('wowProcessStart');
        }
      } else {
        // WoW not detected - apply hysteresis for stop detection
        if (this.isWowRunning) {
          this.consecutiveNotRunningCount++;
          console.debug(
            `[WoWProcessMonitor] WoW not detected (${this.consecutiveNotRunningCount}/${this.STOP_DETECTION_THRESHOLD})`
          );

          if (this.consecutiveNotRunningCount >= this.STOP_DETECTION_THRESHOLD) {
            this.isWowRunning = false;
            this.consecutiveNotRunningCount = 0;
            console.info('[WoWProcessMonitor] WoW process stopped - stopping match detection');
            this.emit('wowProcessStop');
          }
        }
      }
    } catch (error) {
      // Reset hysteresis counter on error to enforce "consecutive" semantics
      // A sequence like false → false → error → false should not trigger stop
      if (this.isWowRunning) {
        this.consecutiveNotRunningCount = 0;
      }

      // Don't emit errors during shutdown to avoid noise
      if (!this.isShuttingDown && this.isMonitoring && this.monitorGeneration === generation) {
        const typedError = WoWProcessMonitorErrorFactory.fromUnknownError(error);
        console.error(
          '[WoWProcessMonitor] Error checking WoW process:',
          typedError.getFormattedMessage()
        );
        this.emit('error', typedError);
      }
    }
  }

  /**
   * Check if any WoW process is currently running
   */
  private async checkWowProcess(): Promise<boolean> {
    try {
      const result = await WoWProcessMonitor.checkNow();
      return result.isRunning;
    } catch (error) {
      // Only log this warning once to avoid spam for monitoring context
      if (!this.hasLoggedPlatformWarning && (error as any).code === 'ENOENT') {
        console.warn(
          '[WoWProcessMonitor] Windows tasklist command not found - WoW process monitoring unavailable'
        );
        this.hasLoggedPlatformWarning = true;
      }

      // Handle timeout errors specifically
      if ((error as any).killed && (error as any).signal === 'SIGTERM') {
        throw WoWProcessMonitorErrorFactory.createTimeoutError(
          10000,
          'Process detection command was terminated due to timeout'
        );
      }

      // Handle command execution errors - convert to monitoring-specific error
      const originalError = error as Error;
      throw WoWProcessMonitorErrorFactory.createCommandError(
        `Failed to execute process detection command: ${originalError.message}`,
        originalError,
        (error as any).code
      );
    }
  }
}

export default WoWProcessMonitor;
