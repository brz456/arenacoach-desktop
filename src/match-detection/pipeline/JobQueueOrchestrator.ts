import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import { ApiHeadersProvider } from '../../services/ApiHeadersProvider';
import { UploadService } from '../../services/UploadService';
import { CompletionPollingService } from '../../services/CompletionPollingService';
import { JobStateStore, CorrelationData } from '../../services/JobStateStore';
import { MatchEndedEvent } from '../types/MatchEvent';
import { ExpirationConfig } from '../../config/ExpirationConfig';
import { CombatLogExpiredError } from '../types/PipelineErrors';
import { AnalysisPayload } from '../../services/AnalysisEnrichmentService';
import { FreemiumQuotaFields } from '../../Freemium';

/**
 * Analysis completion event payload
 */
interface AnalysisCompletedData extends FreemiumQuotaFields {
  jobId: string;
  matchHash: string;
  analysisId?: string; // Normalized to string at emission boundary
  analysisPayload?: AnalysisPayload;
  isSkillCappedViewer?: boolean;
}

/**
 * Analysis failure event payload
 */
interface AnalysisFailedData {
  jobId: string;
  matchHash: string;
  error?: string;
  errorCode?: string;
  isPermanent?: boolean;
}

/**
 * JobQueueOrchestrator - Thin orchestration layer for job management
 *
 * This class coordinates between the decomposed services to provide
 * a unified interface for match chunk upload and tracking. It maintains
 * minimal state and delegates all heavy lifting to specialized services.
 *
 */
export class JobQueueOrchestrator extends EventEmitter {
  private pendingUploads = new Map<string, CorrelationData>();
  private isInitialized = false;
  private uploadInProgress = false;

  // Retry configuration for transient upload failures
  // Indefinite retries - server-side expiration provides natural termination
  private readonly INITIAL_RETRY_DELAY_MS = 1000; // 1 second
  private readonly MAX_RETRY_DELAY_MS = 300000; // 5 minutes max backoff

  constructor(
    private uploadService: UploadService,
    private pollingService: CompletionPollingService,
    private stateStore: JobStateStore,
    private headersProvider: ApiHeadersProvider
  ) {
    super();
    console.info('[JobQueueOrchestrator] Created - awaiting initialization');
  }

  /**
   * Initialize the orchestrator and restore state
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      console.warn('[JobQueueOrchestrator] Already initialized');
      return;
    }

    console.info('[JobQueueOrchestrator] Initializing...');

    try {
      // Load persisted state
      this.pendingUploads = await this.stateStore.loadPendingUploads();

      console.info('[JobQueueOrchestrator] Restored state:', {
        pendingUploads: this.pendingUploads.size,
      });

      // Resume polling for any pending uploads
      for (const [jobId, data] of this.pendingUploads) {
        console.info('[JobQueueOrchestrator] Resuming tracking for job:', {
          jobId,
          matchHash: data.matchHash,
        });
        this.pollingService.trackJob(jobId, data.matchHash);
      }

      // Set up event forwarding from polling service
      this.setupEventForwarding();

      this.isInitialized = true;
      console.info('[JobQueueOrchestrator] Initialization complete');
    } catch (error) {
      console.error('[JobQueueOrchestrator] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Set up event forwarding from polling service
   */
  private setupEventForwarding(): void {
    // Forward completion events
    this.pollingService.on('analysisCompleted', async data => {
      await this.handleAnalysisCompleted(data);
    });

    // Forward failure events
    this.pollingService.on('analysisFailed', async data => {
      await this.handleAnalysisFailed(data);
    });

    // Forward progress events
    this.pollingService.on('analysisProgress', data => {
      this.emit('analysisProgress', data);
    });

    // Forward service status events
    this.pollingService.on('serviceStatusChanged', status => {
      this.emit('serviceStatusChanged', status);
    });

    // Forward poll errors
    this.pollingService.on('pollError', data => {
      this.emit('pollError', data);
    });

    // Forward poll timeouts
    this.pollingService.on('pollTimeout', data => {
      this.emit('pollTimeout', data);
    });
  }

  /**
   * Submit a match chunk for upload and analysis.
   *
   * ENTITLEMENT INVARIANT:
   * JobQueueOrchestrator is intentionally entitlement-agnostic.
   * It does not attempt to classify jobs as entitled vs non-entitled.
   * Entitlement decisions are the responsibility of the backend (via DB checks)
   * and CompletionPollingService (which reacts to backend responses).
   */
  async submitMatchChunk(
    chunkFilePath: string,
    matchMetadata: MatchEndedEvent,
    matchHash: string
  ): Promise<string> {
    if (!this.isInitialized) {
      throw new Error('JobQueueOrchestrator not initialized');
    }

    // Check expiration
    const matchTimestamp = matchMetadata.metadata.timestamp.getTime();
    if (ExpirationConfig.isExpired(matchTimestamp)) {
      const ageInHours = ExpirationConfig.getAgeInHours(matchTimestamp);
      console.warn('[JobQueueOrchestrator] Rejecting expired combat log:', {
        matchHash,
        ageInHours,
        maxHours: ExpirationConfig.COMBAT_LOG_EXPIRATION_HOURS,
      });
      throw new CombatLogExpiredError(
        `Combat log expired (${ageInHours.toFixed(1)} hours old)`,
        ageInHours
      );
    }

    // Generate job ID
    const jobId = crypto.randomUUID();

    console.info('[JobQueueOrchestrator] Submitting match chunk:', {
      jobId,
      matchHash,
      hasAuth: this.headersProvider.hasAuth(),
    });

    // Store correlation data
    const correlationData: CorrelationData = {
      matchHash,
      timestamp: Date.now(),
    };
    this.pendingUploads.set(jobId, correlationData);
    await this.stateStore.savePendingUploads(this.pendingUploads);

    // Emit upload started event
    this.emit('uploadStarted', {
      matchHash,
      status: 'uploading',
    });

    // Try upload with exponential backoff retry indefinitely
    // Server-side expiration provides natural termination
    let lastError: Error | undefined;
    let attempt = 0;

    while (true) {
      // Check if orchestrator is shutting down
      if (!this.isInitialized) {
        console.info('[JobQueueOrchestrator] Stopping retry loop - orchestrator shutting down');
        throw new Error('Upload cancelled: orchestrator shutting down');
      }

      attempt++;
      try {
        // Upload the chunk
        this.uploadInProgress = true;
        await this.uploadService.uploadChunk(chunkFilePath, matchMetadata, matchHash, jobId);
        this.uploadInProgress = false;

        // Start polling for completion
        this.pollingService.trackJob(jobId, matchHash);

        // Emit job created event
        this.emit('analysisJobCreated', {
          matchHash,
          jobId,
          status: 'queued',
        });

        console.info('[JobQueueOrchestrator] Upload successful, polling started:', {
          jobId,
          matchHash,
          attempt,
        });

        return jobId;
      } catch (error) {
        this.uploadInProgress = false;
        lastError = error instanceof Error ? error : new Error('Unknown error');

        // Check if error is retryable (5xx or network error)
        const isRetryable = this.isRetryableError(lastError);

        if (!isRetryable) {
          // Non-retryable error (client error, expired, etc.)
          console.error('[JobQueueOrchestrator] Upload failed (non-retryable):', {
            jobId,
            matchHash,
            attempt,
            isRetryable,
            error: lastError.message,
          });

          // Remove from pending uploads on permanent failure
          this.pendingUploads.delete(jobId);
          await this.stateStore.savePendingUploads(this.pendingUploads);

          // Emit upload failed event
          this.emit('uploadFailed', {
            matchHash,
            error: lastError.message,
          });

          throw lastError;
        }

        // Calculate exponential backoff delay
        const baseDelay = this.INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        const jitter = Math.random() * 0.2 * baseDelay; // Add 20% jitter
        const delay = Math.min(baseDelay + jitter, this.MAX_RETRY_DELAY_MS);

        console.warn('[JobQueueOrchestrator] Upload failed (retryable), will retry indefinitely:', {
          jobId,
          matchHash,
          attempt,
          nextAttempt: attempt + 1,
          delayMs: Math.round(delay),
          error: lastError.message,
          note: 'Retrying indefinitely - server expiration provides natural termination',
        });

        // Emit retry event
        this.emit('uploadRetrying', {
          matchHash,
          attempt,
          nextAttempt: attempt + 1,
          delayMs: Math.round(delay),
          error: lastError.message,
        });

        // Check again before sleeping in case shutdown happened during error handling
        if (!this.isInitialized) {
          console.info(
            '[JobQueueOrchestrator] Stopping retry loop before sleep - orchestrator shutting down'
          );
          throw new Error('Upload cancelled: orchestrator shutting down');
        }

        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    // This should never be reached (infinite loop), but TypeScript needs it
    // The loop only exits via throw for non-retryable errors or successful upload
  }

  /**
   * Handle analysis completion
   */
  private async handleAnalysisCompleted(data: AnalysisCompletedData): Promise<void> {
    const { jobId, matchHash } = data;

    console.info('[JobQueueOrchestrator] Analysis completed:', {
      jobId,
      matchHash,
    });

    // Remove from pending uploads
    this.pendingUploads.delete(jobId);
    await this.stateStore.savePendingUploads(this.pendingUploads);

    // Forward the completion event
    this.emit('analysisCompleted', data);
  }

  /**
   * Handle analysis failure
   */
  private async handleAnalysisFailed(data: AnalysisFailedData): Promise<void> {
    const { jobId, matchHash, error, errorCode, isPermanent } = data;

    console.warn('[JobQueueOrchestrator] Analysis failed:', {
      jobId,
      matchHash,
      error,
      errorCode,
      isPermanent,
    });

    // Remove from pending uploads
    this.pendingUploads.delete(jobId);
    await this.stateStore.savePendingUploads(this.pendingUploads);

    // Forward the failure event
    this.emit('analysisFailed', data);
  }

  /**
   * Determine if an error is retryable (5xx or network error)
   */
  private isRetryableError(error: Error): boolean {
    const message = error.message.toLowerCase();

    // Network errors
    if (
      message.includes('econnrefused') ||
      message.includes('enotfound') ||
      message.includes('etimedout') ||
      message.includes('econnreset') ||
      message.includes('network') ||
      message.includes('socket hang up')
    ) {
      return true;
    }

    // Check for axios errors with response status
    if ('response' in error && typeof (error as any).response === 'object') {
      const status = (error as any).response?.status;
      // Retry on 5xx server errors or 429 (rate limit)
      if (status >= 500 || status === 429) {
        return true;
      }
    }

    // Check for fetch errors
    if ('code' in error) {
      const code = (error as any).code;
      // Common network error codes
      if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE'].includes(code)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Update authentication token across all services
   */
  updateAuthToken(token?: string): void {
    console.info(
      '[JobQueueOrchestrator] Updating auth token:',
      token ? 'Token set' : 'Token cleared'
    );

    this.headersProvider.updateToken(token);
    this.pollingService.updateAuthToken(token);
  }

  /**
   * Get current status
   */
  getStatus(): {
    initialized: boolean;
    pendingUploads: number;
    uploadInProgress: boolean;
    hasAuth: boolean;
  } {
    return {
      initialized: this.isInitialized,
      pendingUploads: this.pendingUploads.size,
      uploadInProgress: this.uploadInProgress,
      hasAuth: this.headersProvider.hasAuth(),
    };
  }

  /**
   * Clean up and stop all operations
   */
  async cleanup(): Promise<void> {
    console.info('[JobQueueOrchestrator] Cleaning up...');

    // Stop polling
    this.pollingService.stopAll();

    // Save final state
    await this.stateStore.savePendingUploads(this.pendingUploads);

    // Remove all listeners
    this.removeAllListeners();
    this.pollingService.removeAllListeners();

    this.isInitialized = false;
    console.info('[JobQueueOrchestrator] Cleanup complete');
  }
}
