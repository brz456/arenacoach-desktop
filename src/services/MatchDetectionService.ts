import { EventEmitter } from 'events';
import { app } from 'electron';
import path from 'path';
import MatchDetectionOrchestrator, {
  OrchestratorConfig,
  MatchProcessedPayload,
} from '../match-detection/MatchDetectionOrchestrator';
import { JobQueueOrchestrator } from '../match-detection/pipeline/JobQueueOrchestrator';
import { WoWInstallation } from '../wowInstallation';
import {
  WoWProcessMonitorError,
  getErrorDetails,
} from '../process-monitoring/WoWProcessMonitorErrors';
import { WoWProcessMonitor } from '../process-monitoring/WoWProcessMonitor';
import { MatchEndedEvent } from '../match-detection/types/MatchEvent';
import { activeFlavor } from '../config/wowFlavor';

/**
 * Configuration for the Match Detection Service
 */
export interface MatchDetectionServiceConfig {
  apiBaseUrl: string;
  enableWoWProcessMonitoring?: boolean;
  isSkirmishTrackingEnabled?: () => boolean;
}

/**
 * Status information returned by the Match Detection Service
 */
export interface MatchDetectionStatus {
  initialized: boolean;
  running: boolean;
  metrics: {
    linesProcessed: number;
    errorsHandled: number;
    lastProcessingTime: number;
    memoryUsage?: {
      heapUsed: number;
      rss: number;
    };
    activeMatches: number;
  } | null;
  currentMatch: {
    bracket: string;
    timestamp: Date;
  } | null;
  installations: {
    count: number;
    paths: string[];
  } | null;
  wowProcessStatus?: {
    isRunning: boolean;
    isMonitoring: boolean;
    firstPollCompleted: boolean;
  };
}

/**
 * Service that manages automated match detection and analysis
 * Replaces both CombatLogWatcher and manual upload systems
 */
export class MatchDetectionService extends EventEmitter {
  private orchestrator?: MatchDetectionOrchestrator | undefined;
  private jobQueueOrchestrator?: JobQueueOrchestrator;
  private config: MatchDetectionServiceConfig;
  private installations: WoWInstallation[] = [];
  private outputDirectory: string;
  private isInitialized = false;
  private didOneTimeProcessCheck = false;

  constructor(config: MatchDetectionServiceConfig) {
    super();
    this.config = config;

    // Set up output directory for match chunks with normalized folder structure
    const userDataPath = app.getPath('userData');
    this.outputDirectory = path.join(userDataPath, 'logs', 'chunks');
  }

  /**
   * Initialize the service with WoW installations for the active flavor
   */
  public async initialize(installations: WoWInstallation[]): Promise<void> {
    if (this.isInitialized) {
      console.warn('[MatchDetectionService] Already initialized');
      return;
    }

    // Reset one-time process check flag for new orchestrator lifecycle
    this.didOneTimeProcessCheck = false;

    if (installations.length === 0) {
      throw new Error(
        `No ${activeFlavor.id} WoW installations found. Only the active WoW flavor is supported: ${activeFlavor.id} (${activeFlavor.dirName}).`
      );
    }

    // Invariant: all installations must be for the active flavor
    const invalidInstallation = installations.find(
      i => !i.combatLogPath.includes(activeFlavor.dirName)
    );
    if (invalidInstallation) {
      throw new Error(
        `[MatchDetectionService] Installation path does not match active flavor (${activeFlavor.id} / ${activeFlavor.dirName})`
      );
    }

    this.installations = installations;

    // Use the first installation's combat log directory
    const primaryLogDirectory = installations[0]!.combatLogPath;

    console.info(`[MatchDetectionService] Initializing with ${activeFlavor.id} installations:`, {
      installationCount: installations.length,
      primaryLogDirectory,
      outputDirectory: this.outputDirectory,
    });

    // Create orchestrator configuration
    const orchestratorConfig: OrchestratorConfig = {
      logDirectory: primaryLogDirectory,
      outputDirectory: this.outputDirectory,
      watcherTimeoutMinutes: 10,
      enableWoWProcessMonitoring: this.config.enableWoWProcessMonitoring ?? true,
      ...(this.config.isSkirmishTrackingEnabled && {
        isSkirmishTrackingEnabled: this.config.isSkirmishTrackingEnabled,
      }),
      chunkerOptions: {
        minMatchLines: 20,
        maxMatchLines: 200000,
        allowedOutputRoots: [this.outputDirectory],
      },
    };

    // Create orchestrator
    this.orchestrator = new MatchDetectionOrchestrator(orchestratorConfig);

    // Pass JobQueueOrchestrator to the MatchDetectionOrchestrator if already set
    if (this.jobQueueOrchestrator) {
      this.orchestrator.setJobQueueOrchestrator(this.jobQueueOrchestrator);
    }

    this.setupEventHandlers();

    this.isInitialized = true;
    this.emit('initialized');
  }

  /**
   * Start automated match detection
   */
  public async start(): Promise<void> {
    if (!this.orchestrator) {
      throw new Error('Service not initialized. Call initialize() first.');
    }

    try {
      console.info('[MatchDetectionService] Starting automated match detection...');
      await this.orchestrator.start();
      this.emit('started');
    } catch (error) {
      console.error('[MatchDetectionService] Failed to start:', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Stop automated match detection
   */
  public async stop(): Promise<void> {
    if (!this.orchestrator) {
      return;
    }

    try {
      console.info('[MatchDetectionService] Stopping automated match detection...');
      await this.orchestrator.stop();
      this.orchestrator = undefined; // Clear orchestrator reference for fresh restart
      this.isInitialized = false; // Reset initialization flag to allow restart
      this.didOneTimeProcessCheck = false; // Reset for next lifecycle
      this.emit('stopped');
    } catch (error) {
      console.error('[MatchDetectionService] Error stopping:', error);
      this.emit('error', error);
    }
  }

  /**
   * Update authentication token
   */
  public updateAuthToken(token: string): void {
    console.info('[MatchDetectionService] Updating authentication token');

    if (this.orchestrator) {
      this.orchestrator.updateAuthToken(token);
    }
  }

  /**
   * Set the JobQueueOrchestrator to use for uploads
   * This allows using the new decomposed services for upload processing
   */
  public setJobQueueOrchestrator(orchestrator: JobQueueOrchestrator): void {
    console.info('[MatchDetectionService] Setting JobQueueOrchestrator');
    this.jobQueueOrchestrator = orchestrator;

    // Pass to MatchDetectionOrchestrator if already initialized
    if (this.orchestrator) {
      this.orchestrator.setJobQueueOrchestrator(orchestrator);
    }
  }

  /**
   * Get service status and metrics with one-time WoW process check if needed
   * Used for initial state queries when process monitor hasn't polled yet
   */
  public async getStatusWithProcessCheck(): Promise<MatchDetectionStatus> {
    const status = this.getStatus();

    // One-time check: if orchestrator hasn't polled yet and we haven't done our fallback check
    const needsOneTimeCheck =
      !this.didOneTimeProcessCheck &&
      (!status.wowProcessStatus || !status.wowProcessStatus.firstPollCompleted);

    if (needsOneTimeCheck) {
      try {
        const processCheck = await WoWProcessMonitor.checkNow();
        this.didOneTimeProcessCheck = true;
        status.wowProcessStatus = {
          isRunning: processCheck.isRunning,
          isMonitoring: status.wowProcessStatus?.isMonitoring ?? false,
          firstPollCompleted: true,
        };
      } catch (error) {
        // Log error but don't fail the status query - return status without process check
        console.error('[MatchDetectionService] WoW process check failed:', error);
        // Mark as attempted to avoid repeated failures
        this.didOneTimeProcessCheck = true;
      }
    }

    return status;
  }

  /**
   * Get service status and metrics
   */
  public getStatus(): MatchDetectionStatus {
    if (!this.orchestrator) {
      return {
        initialized: false,
        running: false,
        metrics: null,
        currentMatch: null,
        installations: null,
      };
    }

    const metrics = this.orchestrator.getSystemMetrics();
    const currentMatch = this.getCurrentMatch();

    return {
      initialized: this.isInitialized,
      running: metrics.isRunning,
      metrics: {
        linesProcessed: metrics.linesProcessed,
        errorsHandled: metrics.errorsHandled,
        lastProcessingTime: metrics.lastProcessingTime,
        ...(metrics.memoryUsage !== undefined && { memoryUsage: metrics.memoryUsage }),
        activeMatches: metrics.activeMatches,
      },
      currentMatch,
      installations: {
        count: this.installations.length,
        paths: this.installations.map(i => i.combatLogPath),
      },
      ...(metrics.wowProcessStatus && { wowProcessStatus: metrics.wowProcessStatus }),
    };
  }

  /**
   * Get current match state
   */
  public getCurrentMatch(): { bracket: string; timestamp: Date } | null {
    return this.orchestrator?.getCurrentMatch() || null;
  }

  /**
   * Submit a match chunk directly for upload
   */
  public async submitMatchChunk(
    chunkFilePath: string,
    matchMetadata: MatchEndedEvent,
    matchHash: string
  ): Promise<string> {
    if (!this.orchestrator) {
      throw new Error('MatchDetectionService not initialized');
    }

    return this.orchestrator.submitMatchChunk(chunkFilePath, matchMetadata, matchHash);
  }

  /**
   * Setup event handlers for orchestrator events
   */
  private setupEventHandlers(): void {
    if (!this.orchestrator) return;

    // Forward match processing events with sequential architecture
    this.orchestrator.on('matchStarted', event => {
      console.info('[MatchDetectionService] Match started:', event.bufferId);
      this.emit('matchStarted', event);
    });

    this.orchestrator.on('matchProcessed', (payload: MatchProcessedPayload) => {
      console.info('[MatchDetectionService] Match processed:', {
        bufferId: payload.matchEvent.bufferId,
        chunkFilePath: payload.chunkFilePath,
      });
      this.emit('matchProcessed', payload);
    });

    this.orchestrator.on('matchEnded', event => {
      console.info('[MatchDetectionService] Match ended:', event.bufferId);
      this.emit('matchEnded', event);
    });

    // Forward incomplete match events
    this.orchestrator.on('matchEndedIncomplete', event => {
      console.info('[MatchDetectionService] Match ended incomplete:', {
        bufferId: event.bufferId,
        trigger: event.trigger,
        lines: event.lines,
      });
      this.emit('matchEndedIncomplete', event);
    });

    this.orchestrator.on('analysisJobCreated', event => {
      console.info('[MatchDetectionService] Analysis job created:', event.jobId);
      this.emit('analysisJobCreated', event);
    });

    this.orchestrator.on('analysisProgress', event => {
      this.emit('analysisProgress', event);
    });

    this.orchestrator.on('analysisCompleted', event => {
      console.info('[MatchDetectionService] Analysis completed:', event.jobId);
      this.emit('analysisCompleted', event);
    });

    this.orchestrator.on('analysisFailed', event => {
      console.info('[MatchDetectionService] Analysis failed:', event.jobId);
      this.emit('analysisFailed', event);
    });

    // Handle errors
    this.orchestrator.on('watcherError', error => {
      console.error('[MatchDetectionService] Combat log watcher error:', error);
      this.emit('watcherError', error);
    });

    this.orchestrator.on('chunkerError', error => {
      console.error('[MatchDetectionService] Match chunker error:', error);
      this.emit('chunkerError', error);
    });

    this.orchestrator.on('pipelineError', error => {
      console.error('[MatchDetectionService] Pipeline integration error:', error);
      this.emit('pipelineError', error);
    });

    // Handle warnings
    this.orchestrator.on('watcherWarning', warning => {
      console.warn('[MatchDetectionService] Combat log watcher warning:', warning);
      this.emit('watcherWarning', warning);
    });

    // Handle WoW process events
    this.orchestrator.on('wowProcessStart', () => {
      console.info('[MatchDetectionService] WoW process started - match detection active');
      this.emit('wowProcessStart');
    });

    this.orchestrator.on('wowProcessStop', () => {
      console.info('[MatchDetectionService] WoW process stopped - match detection paused');
      this.emit('wowProcessStop');
    });

    this.orchestrator.on('processMonitorError', (error: WoWProcessMonitorError) => {
      const errorDetails = getErrorDetails(error);
      console.error('[MatchDetectionService] WoW process monitor error:', errorDetails);
      this.emit('processMonitorError', error);
    });

    // Forward service status changes for real-time UI updates
    this.orchestrator.on('serviceStatusChanged', status => {
      this.emit('serviceStatusChanged', status);
    });

    // Forward job retry events
    this.orchestrator.on('jobRetry', event => {
      this.emit('jobRetry', event);
    });
  }

  /**
   * Clean up resources
   */
  public async cleanup(): Promise<void> {
    console.info('[MatchDetectionService] Cleaning up resources...');

    try {
      if (this.orchestrator) {
        await this.orchestrator.stop();
      }
    } catch (error) {
      console.error('[MatchDetectionService] Error during cleanup:', error);
    }

    this.removeAllListeners();
    this.isInitialized = false;
    this.didOneTimeProcessCheck = false;
  }
}
