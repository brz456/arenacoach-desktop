import { EventEmitter } from 'events';
import MatchLogWatcher from './parsing/MatchLogWatcher';
import MatchChunker, { MatchChunkerOptions } from './chunking/MatchChunker';
import { JobQueueOrchestrator } from './pipeline/JobQueueOrchestrator';
import {
  MatchStartedEvent,
  MatchEndedEvent,
  MatchEventType,
  ZoneChangeEvent,
} from './types/MatchEvent';
import { MatchBuffer } from './types/MatchTypes';
import { SystemMetrics } from './types/SystemMonitoringTypes';
import { WoWProcessMonitor } from '../process-monitoring/WoWProcessMonitor';
import {
  WoWProcessMonitorError,
  getErrorDetails,
} from '../process-monitoring/WoWProcessMonitorErrors';
import { EarlyEndTrigger } from './types/EarlyEndTriggers';
import type { JobRetryPayload } from './types/JobRetryPayload';

/**
 * Payload for the matchProcessed event containing match data and chunk file path
 */
export interface MatchProcessedPayload {
  matchEvent: MatchEndedEvent;
  chunkFilePath: string;
}

/**
 * Configuration for the match detection orchestrator
 */
export interface OrchestratorConfig {
  logDirectory: string;
  outputDirectory: string;
  watcherTimeoutMinutes?: number;
  chunkerOptions?: Partial<MatchChunkerOptions>;
  enableWoWProcessMonitoring?: boolean;
  isSkirmishTrackingEnabled?: () => boolean;
}

/**
 * Orchestrates the complete automated pipeline:
 * WoW Process Monitoring → Combat Log Watching → Match Detection → Chunking → Job Queue Processing → Polling-based Tracking
 *
 * Replaces both manual upload and old file watching systems
 */
export default class MatchDetectionOrchestrator extends EventEmitter {
  private watcher: MatchLogWatcher;
  private chunker: MatchChunker;
  private jobQueueOrchestrator?: JobQueueOrchestrator;
  private jobQueueHandlers: {
    analysisJobCreated?: (data: any) => void;
    analysisProgress?: (data: any) => void;
    analysisCompleted?: (data: any) => void;
    analysisFailed?: (data: any) => void;
    serviceStatusChanged?: (status: any) => void;
    pollError?: (data: any) => void;
    pollTimeout?: (data: any) => void;
    uploadRetrying?: (data: any) => void;
  } = {};
  private processMonitor: WoWProcessMonitor | null = null;
  private isRunning = false;
  private isShuttingDown = false;
  private enableProcessMonitoring: boolean;
  private isWatchingActive = false; // Prevents redundant startMonitoring calls
  private isStarting = false; // Prevents concurrent startMonitoring attempts

  constructor(config: OrchestratorConfig) {
    super();

    this.enableProcessMonitoring = config.enableWoWProcessMonitoring ?? true;

    // Initialize components
    this.watcher = new MatchLogWatcher(
      config.logDirectory,
      config.watcherTimeoutMinutes || 10,
      config.isSkirmishTrackingEnabled
    );

    const chunkerOptions: MatchChunkerOptions = {
      outputDir: config.outputDirectory,
      minMatchLines: 20,
      maxMatchLines: 200000, // 200k safety limit
      allowedOutputRoots: [config.outputDirectory],
      ...config.chunkerOptions,
    };
    this.chunker = new MatchChunker(chunkerOptions);

    // Initialize WoW process monitor if enabled
    if (this.enableProcessMonitoring) {
      this.processMonitor = new WoWProcessMonitor();
    }

    this.setupEventHandlers();
  }

  /**
   * Start the complete automation pipeline
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      console.warn('[MatchOrchestrator] Already running');
      return;
    }

    try {
      console.info('[MatchOrchestrator] Starting automated match detection pipeline...');

      // Initialize chunker first (ensures output directory exists)
      await this.chunker.init();

      // Service is now active - set state before any UI can read it
      this.isRunning = true;

      // Start WoW process monitoring if enabled
      if (this.processMonitor) {
        console.info('[MatchOrchestrator] Starting WoW process monitoring...');

        // Await first poll completion (first-poll guarantee)
        await this.processMonitor.start();

        // Re-check WoW status after first poll completion and start watching if needed
        const { isRunning: wowIsRunning } = this.processMonitor.getWoWStatus();
        if (wowIsRunning) {
          console.info(
            '[MatchOrchestrator] WoW detected after first poll - starting combat log watching immediately'
          );
          await this.startMonitoring();
        } else {
          console.info(
            '[MatchOrchestrator] WoW not detected after first poll - waiting for WoW to start'
          );
        }
      } else {
        // Process monitoring disabled - start immediately (legacy behavior)
        console.info(
          '[MatchOrchestrator] Process monitoring disabled - starting combat log watching immediately'
        );
        await this.startMonitoring();
      }

      console.info('[MatchOrchestrator] Pipeline started successfully');
      this.emit('started');
    } catch (error) {
      console.error('[MatchOrchestrator] Failed to start pipeline:', error);
      this.isRunning = false; // Reset state on failure
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Start combat log monitoring (internal method)
   */
  private async startMonitoring(): Promise<void> {
    if (this.isWatchingActive || this.isStarting) {
      return; // Skip redundant calls silently
    }

    this.isStarting = true;
    try {
      console.info('[MatchOrchestrator] Starting combat log watching...');
      await this.watcher.watch();
      this.isWatchingActive = true;
    } catch (error) {
      console.error(
        '[MatchOrchestrator] Failed to start combat log watching:',
        (error as Error).message
      );
      throw error;
    } finally {
      this.isStarting = false;
    }
  }

  /**
   * Stop combat log monitoring (internal method)
   */
  private async stopMonitoring(): Promise<void> {
    if (!this.isWatchingActive) {
      return; // Skip if not currently watching
    }

    try {
      console.info('[MatchOrchestrator] Stopping combat log watching...');
      await this.watcher.unwatch();
    } catch (error) {
      console.error(
        '[MatchOrchestrator] Error stopping combat log watching:',
        (error as Error).message
      );
    } finally {
      this.isWatchingActive = false; // Always reset flag to prevent stuck state
    }
  }

  /**
   * Stop the automation pipeline with proper synchronization
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    // Prevent concurrent shutdowns and new operations
    if (this.isShuttingDown) {
      console.warn('[MatchOrchestrator] Shutdown already in progress, waiting...');
      // Wait for current shutdown to complete by checking flag periodically
      while (this.isShuttingDown) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return;
    }

    this.isShuttingDown = true;

    try {
      console.info('[MatchOrchestrator] Stopping automation pipeline...');

      // Phase 0: Stop WoW process monitoring first
      if (this.processMonitor) {
        console.info('[MatchOrchestrator] Phase 0: Stopping WoW process monitoring...');
        this.processMonitor.stop();
      }

      // Phase 1: Stop input sources first to prevent new data
      console.info('[MatchOrchestrator] Phase 1: Stopping input sources...');
      await this.stopMonitoring();

      // Phase 2: Input sources stopped, proceed to finalization

      // Phase 3: Force end any active matches (may trigger submissions)
      console.info('[MatchOrchestrator] Phase 3: Finalizing active matches...');
      await this.chunker.forceEndAllMatches();

      // Phase 4: Active matches finalized, proceed to cleanup

      // Phase 5: Final cleanup - remove all listeners and clear state
      console.info('[MatchOrchestrator] Phase 5: Final resource cleanup...');
      this.watcher.cleanup();
      this.chunker.cleanup();
      this.cleanupJobQueueHandlers();

      this.isRunning = false;
      this.isWatchingActive = false; // Reset watching state
      this.isStarting = false; // Reset starting state

      console.info('[MatchOrchestrator] Pipeline stopped successfully');
      this.emit('stopped');
    } catch (error) {
      console.error('[MatchOrchestrator] Error stopping pipeline:', error);
      this.emit('error', error);
    } finally {
      this.isShuttingDown = false;
    }
  }

  /**
   * Setup event handlers to connect all components
   */
  private setupEventHandlers(): void {
    // Setup WoW process monitoring events
    if (this.processMonitor) {
      this.processMonitor.on('wowProcessStart', async () => {
        if (!this.isShuttingDown) {
          console.info('[MatchOrchestrator] WoW process started - beginning match detection');
          try {
            await this.startMonitoring();
            this.emit('wowProcessStart');
          } catch (error) {
            console.error(
              '[MatchOrchestrator] Failed to start monitoring after WoW process start:',
              error
            );
            this.emit('error', error);
          }
        }
      });

      this.processMonitor.on('wowProcessStop', async () => {
        if (!this.isShuttingDown) {
          console.info(
            '[MatchOrchestrator] WoW process stopped - triggering early ending for active matches'
          );
          try {
            // Trigger early ending for all active matches first
            this.chunker.triggerEarlyEnding(EarlyEndTrigger.PROCESS_STOP);

            // Then stop monitoring
            await this.stopMonitoring();
            this.emit('wowProcessStop');
          } catch (error) {
            console.error(
              '[MatchOrchestrator] Failed to stop monitoring after WoW process stop:',
              error
            );
            this.emit('error', error);
          }
        }
      });

      this.processMonitor.on('error', (error: WoWProcessMonitorError) => {
        const errorDetails = getErrorDetails(error);
        console.error('[MatchOrchestrator] WoW process monitor error:', errorDetails);
        this.emit('processMonitorError', error);
      });
    }

    // Connect MatchLogWatcher → MatchChunker
    this.watcher.on('matchStarted', (event: MatchStartedEvent) => {
      // Note: non-skirmish unranked matches are filtered at parsing level
      console.info('[MatchOrchestrator] Match detected:', {
        bufferId: event.bufferId,
        zoneId: event.zoneId,
      });

      this.chunker.onMatchStarted(event);
      this.emit('matchStarted', event);
    });

    this.watcher.on('matchEnded', (event: MatchEndedEvent) => {
      // Note: non-skirmish unranked matches are filtered at parsing level
      console.info('[MatchOrchestrator] Match ended:', {
        bufferId: event.bufferId,
        bracket: event.metadata.bracket,
        duration: event.metadata.matchDuration,
      });

      this.chunker.onMatchEnded(event);
      this.emit('matchEnded', event);
    });

    // Zone change event handling - route to chunker for match cleanup
    this.watcher.on('zoneChange', (event: ZoneChangeEvent) => {
      this.chunker.onZoneChange(event);

      // Note: Shuffle tracker reset handled by parser during parseZoneChange()
      console.info('[MatchOrchestrator] Zone change - may reset shuffle tracking');

      // Also emit for other components that might need zone change notifications
      this.emit('zoneChange', event);
    });

    // Handle raw log chunks for atomic processing
    this.watcher.on('logChunk', (lines: Array<{ line: string; timestamp: Date }>) => {
      this.chunker.addLogChunk(lines);
    });

    // Handle combat log file changes - trigger early ending for active matches
    this.watcher.on('logFileChanged', event => {
      console.warn(
        '[MatchOrchestrator] Combat log file changed - ending all active matches',
        event
      );
      this.chunker.triggerEarlyEnding(EarlyEndTrigger.LOG_FILE_CHANGE, event.metadataSnapshot);
      this.emit('logFileChanged', event); // optional telemetry/UI
    });

    // Connect MatchChunker → emit matchProcessed for main.ts to handle
    this.chunker.on('matchExtracted', data => {
      // Single guard clause for shutdown - prevents all processing if shutting down
      if (this.isShuttingDown) {
        console.info('[MatchOrchestrator] Skipping chunk processing during shutdown');
        return;
      }

      const { filePath, matchInfo, buffer } = data;
      const matchEndedEvent = this.createMatchEndedEvent(buffer, matchInfo.bufferId);

      console.info('[MatchOrchestrator] Processing match chunk:', {
        filename: matchInfo.filename,
        lines: matchInfo.lines,
        size: matchInfo.size,
      });

      // Emit matchProcessed event with chunkFilePath for main.ts to handle upload
      const payload: MatchProcessedPayload = {
        matchEvent: matchEndedEvent,
        chunkFilePath: filePath,
      };

      this.emit('matchProcessed', payload);
    });

    // Handle errors from components
    this.watcher.on('error', error => {
      console.error('[MatchOrchestrator] Watcher error:', error);
      this.emit('watcherError', error);
    });

    this.watcher.on('warning', warning => {
      console.warn('[MatchOrchestrator] Watcher warning:', warning);
      this.emit('watcherWarning', warning);
    });

    // Forward incomplete match events from chunker
    this.chunker.on('matchEndedIncomplete', event => {
      console.warn('[MatchOrchestrator] Match ended incomplete:', {
        bufferId: event.bufferId,
        trigger: event.trigger,
        lines: event.lines,
      });

      // Clear parser's current match state since no ARENA_MATCH_END will be received
      // This prevents stale "in match" state from persisting across renderer reloads
      // EXCEPTION: Don't clear for NEW_MATCH_START - parser already has the new match context
      if (event.trigger !== EarlyEndTrigger.NEW_MATCH_START) {
        this.watcher.clearCurrentMatch();
      }

      this.emit('matchEndedIncomplete', event);
    });

    this.chunker.on('error', error => {
      console.error('[MatchOrchestrator] Chunker error:', error);
      this.emit('chunkerError', error);
    });
  }

  /**
   * Create MatchEndedEvent from match buffer for pipeline submission
   * Enforces SSoT: no fallbacks, fails fast if required data missing
   */
  private createMatchEndedEvent(buffer: MatchBuffer, bufferId: string): MatchEndedEvent {
    // Require metadata - it should always be present
    if (!buffer.metadata) {
      throw new Error('Buffer metadata missing - cannot create event without match data');
    }

    // Require endTime - no fallbacks (SSoT principle)
    if (!buffer.endTime) {
      throw new Error(
        'Buffer missing required endTime - cannot create event without SSoT timestamp'
      );
    }

    const event: MatchEndedEvent = {
      type: MatchEventType.MATCH_ENDED,
      timestamp: new Date(buffer.endTime),
      bufferId,
      metadata: buffer.metadata,
    };
    return event;
  }

  /**
   * Update authentication token for pipeline
   */
  public updateAuthToken(token: string): void {
    console.info('[MatchOrchestrator] Updating authentication token');
    if (this.jobQueueOrchestrator) {
      this.jobQueueOrchestrator.updateAuthToken(token);
    }
  }


  /**
   * Clean up JobQueueOrchestrator event handlers to prevent listener leaks
   */
  private cleanupJobQueueHandlers(): void {
    if (!this.jobQueueOrchestrator) {
      return;
    }

    // Remove all stored handler references
    if (this.jobQueueHandlers.analysisJobCreated) {
      this.jobQueueOrchestrator.off('analysisJobCreated', this.jobQueueHandlers.analysisJobCreated);
    }
    if (this.jobQueueHandlers.analysisProgress) {
      this.jobQueueOrchestrator.off('analysisProgress', this.jobQueueHandlers.analysisProgress);
    }
    if (this.jobQueueHandlers.analysisCompleted) {
      this.jobQueueOrchestrator.off('analysisCompleted', this.jobQueueHandlers.analysisCompleted);
    }
    if (this.jobQueueHandlers.analysisFailed) {
      this.jobQueueOrchestrator.off('analysisFailed', this.jobQueueHandlers.analysisFailed);
    }
    if (this.jobQueueHandlers.serviceStatusChanged) {
      this.jobQueueOrchestrator.off('serviceStatusChanged', this.jobQueueHandlers.serviceStatusChanged);
    }
    if (this.jobQueueHandlers.pollError) {
      this.jobQueueOrchestrator.off('pollError', this.jobQueueHandlers.pollError);
    }
    if (this.jobQueueHandlers.pollTimeout) {
      this.jobQueueOrchestrator.off('pollTimeout', this.jobQueueHandlers.pollTimeout);
    }
    if (this.jobQueueHandlers.uploadRetrying) {
      this.jobQueueOrchestrator.off('uploadRetrying', this.jobQueueHandlers.uploadRetrying);
    }

    // Clear handler storage
    this.jobQueueHandlers = {};
  }

  /**
   * Set the JobQueueOrchestrator to use
   * This allows using the new decomposed services for uploads
   */
  public setJobQueueOrchestrator(orchestrator: JobQueueOrchestrator): void {
    console.info('[MatchOrchestrator] Setting JobQueueOrchestrator');
    
    // Remove old listeners before attaching new ones
    this.cleanupJobQueueHandlers();
    
    this.jobQueueOrchestrator = orchestrator;

    // Wire up event forwarding from JobQueueOrchestrator and store handler references
    this.jobQueueHandlers.analysisJobCreated = data => {
      this.emit('analysisJobCreated', data);
    };
    orchestrator.on('analysisJobCreated', this.jobQueueHandlers.analysisJobCreated);

    this.jobQueueHandlers.analysisProgress = data => {
      this.emit('analysisProgress', data);
    };
    orchestrator.on('analysisProgress', this.jobQueueHandlers.analysisProgress);

    this.jobQueueHandlers.analysisCompleted = data => {
      this.emit('analysisCompleted', data);
    };
    orchestrator.on('analysisCompleted', this.jobQueueHandlers.analysisCompleted);

    this.jobQueueHandlers.analysisFailed = data => {
      this.emit('analysisFailed', data);
    };
    orchestrator.on('analysisFailed', this.jobQueueHandlers.analysisFailed);

    this.jobQueueHandlers.serviceStatusChanged = status => {
      this.emit('serviceStatusChanged', status);
    };
    orchestrator.on('serviceStatusChanged', this.jobQueueHandlers.serviceStatusChanged);

    this.jobQueueHandlers.pollError = data => {
      this.emit('pipelineError', data);
    };
    orchestrator.on('pollError', this.jobQueueHandlers.pollError);

    this.jobQueueHandlers.pollTimeout = data => {
      this.emit('analysisTimeout', {
        jobId: data.jobId,
        matchHash: data.matchHash,
        attempts: data.attempts,
      });
    };
    orchestrator.on('pollTimeout', this.jobQueueHandlers.pollTimeout);

    this.jobQueueHandlers.uploadRetrying = data => {
      // Map error information to JobRetryPayload with deterministic errorType
      const errorType = data.code === 'ECONNABORTED' ? 'timeout' : 'network';
      
      const retryPayload: JobRetryPayload = {
        matchHash: data.matchHash,
        attempt: data.attempt,
        delayMs: data.delayMs,
        errorType,
      };
      
      this.emit('jobRetry', retryPayload);
    };
    orchestrator.on('uploadRetrying', this.jobQueueHandlers.uploadRetrying);
  }


  /**
   * Submit a match chunk directly for upload
   */
  public async submitMatchChunk(
    chunkFilePath: string,
    matchMetadata: MatchEndedEvent,
    matchHash: string
  ): Promise<string> {
    if (!this.jobQueueOrchestrator) {
      throw new Error('JobQueueOrchestrator not initialized');
    }
    return this.jobQueueOrchestrator.submitMatchChunk(chunkFilePath, matchMetadata, matchHash);
  }

  /**
   * Get current match state
   */
  public getCurrentMatch(): { bracket: string; timestamp: Date } | null {
    return this.watcher.getCurrentMatch();
  }

  /**
   * Get system metrics for monitoring
   */
  public getSystemMetrics(): SystemMetrics & {
    activeMatches: number;
    isRunning: boolean;
    wowProcessStatus?: { isRunning: boolean; isMonitoring: boolean; firstPollCompleted: boolean };
  } {
    const watcherMetrics = this.watcher.getSystemMetrics();

    return {
      ...watcherMetrics,
      activeMatches: this.chunker.getActiveMatchCount(),
      isRunning: this.isRunning,
      ...(this.processMonitor && { wowProcessStatus: this.processMonitor.getWoWStatus() }),
    };
  }
}
