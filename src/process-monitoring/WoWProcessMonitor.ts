import { EventEmitter } from 'events';
import { exec } from 'child_process';
import { promisify } from 'util';
import { 
  WoWProcessMonitorError, 
  WoWProcessMonitorErrorFactory 
} from './WoWProcessMonitorErrors';

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
 * Enhanced with first-poll guarantee and delayed re-check for 100% reliable detection.
 */
export class WoWProcessMonitor extends EventEmitter {
  private isWowRunning = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private readonly POLL_INTERVAL_MS = 2000; // 2 seconds - improved responsiveness while maintaining reliability
  private readonly WOW_PROCESS_REGEX = /wow\.exe/i; // Retail WoW only
  private isMonitoring = false;
  private isShuttingDown = false;
  private hasLoggedPlatformWarning = false;
  private firstPollCompleted = false;

  declare on: <K extends keyof WoWProcessEvents>(event: K, listener: WoWProcessEvents[K]) => this;
  declare emit: <K extends keyof WoWProcessEvents>(event: K, ...args: Parameters<WoWProcessEvents[K]>) => boolean;

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

    try {
      // Perform initial check immediately and await completion (first-poll guarantee)
      await this.poll();
      this.firstPollCompleted = true;
      console.info('[WoWProcessMonitor] First poll completed, WoW status:', this.isWowRunning);

      // Schedule short delayed re-check to catch immediate startup edge case
      setTimeout(() => {
        if (!this.isShuttingDown) {
          this.poll().catch(error => {
            const typedError = WoWProcessMonitorErrorFactory.fromUnknownError(error);
            console.error('[WoWProcessMonitor] Delayed re-check failed:', typedError.getFormattedMessage());
            this.emit('error', typedError);
          });
        }
      }, 750); // 750ms delayed re-check

      // Start regular polling
      this.pollInterval = setInterval(() => {
        if (!this.isShuttingDown) {
          this.poll().catch(error => {
            const typedError = WoWProcessMonitorErrorFactory.fromUnknownError(error);
            console.error('[WoWProcessMonitor] Poll failed:', typedError.getFormattedMessage());
            this.emit('error', typedError);
          });
        }
      }, this.POLL_INTERVAL_MS);

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

    // Clear the polling interval
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    // Reset state
    this.isMonitoring = false;
    this.isWowRunning = false;
    this.firstPollCompleted = false;
    this.isShuttingDown = false; // Reset shutdown flag to allow restart

    console.info('[WoWProcessMonitor] Process monitoring stopped');
  }

  /**
   * Get current WoW running status
   */
  public getWoWStatus(): { isRunning: boolean; isMonitoring: boolean; firstPollCompleted: boolean } {
    return {
      isRunning: this.isWowRunning,
      isMonitoring: this.isMonitoring,
      firstPollCompleted: this.firstPollCompleted
    };
  }

  /**
   * Perform one-time WoW process check without starting monitoring
   * Used for initial state queries when monitoring hasn't started yet
   */
  public static async checkNow(): Promise<{ isRunning: boolean }> {
    try {
      // Use Windows tasklist command
      const { stdout } = await execAsync('tasklist', { 
        timeout: 10000, // 10 second timeout
        encoding: 'utf8'
      });

      // Search for WoW process names in the output
      const isWowRunning = /wow\.exe/i.test(stdout);
      
      return { isRunning: isWowRunning };
    } catch (error) {
      // If tasklist fails, don't crash - same error handling as instance method
      if ((error as any).code === 'ENOENT') {
        // tasklist command not found (non-Windows or missing)
        return { isRunning: false };
      }
      
      // Handle timeout or other errors
      return { isRunning: false };
    }
  }

  /**
   * Poll for WoW processes using Windows tasklist command
   */
  private async poll(): Promise<void> {
    try {
      const isCurrentlyRunning = await this.checkWowProcess();
      
      // Only emit events on state change to prevent spam
      if (isCurrentlyRunning !== this.isWowRunning) {
        this.isWowRunning = isCurrentlyRunning;
        
        if (!this.isShuttingDown) {
          if (isCurrentlyRunning) {
            console.info('[WoWProcessMonitor] WoW process detected - starting match detection');
            this.emit('wowProcessStart');
          } else {
            console.info('[WoWProcessMonitor] WoW process stopped - stopping match detection');
            this.emit('wowProcessStop');
          }
        }
      }
    } catch (error) {
      // Don't emit errors during shutdown to avoid noise
      if (!this.isShuttingDown) {
        const typedError = WoWProcessMonitorErrorFactory.fromUnknownError(error);
        console.error('[WoWProcessMonitor] Error checking WoW process:', typedError.getFormattedMessage());
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
        console.warn('[WoWProcessMonitor] Windows tasklist command not found - WoW process monitoring unavailable');
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