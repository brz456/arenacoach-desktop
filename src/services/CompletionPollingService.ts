import { EventEmitter } from 'events';
import axios, { AxiosInstance, isAxiosError } from 'axios';
import { ServiceHealthCheck } from './ServiceHealthCheck';
import { FreemiumQuotaFields } from '../Freemium';

/**
 * Configuration for completion polling service
 */
export interface CompletionPollingConfig {
  apiBaseUrl: string;
  authToken?: string; // Made optional for anonymous polling
  jobStatusEndpoint?: string;
  baseIntervalMs?: number;
  maxBackoffMs?: number;
  maxConcurrentPolls?: number;
  warmUpNotFoundMs?: number;
  healthCheck?: ServiceHealthCheck; // Optional health check reporter
}

/**
 * Job status response from the backend (pg-boss format)
 */
export interface JobStatusResponse extends FreemiumQuotaFields {
  success: boolean;
  jobId: string;
  analysisStatus: string;
  analysisId: string | null;
  uuid: string | null;
  hasData: boolean;
  timestamp: string;
  analysisData?: unknown; // Full rich metadata when analysis is completed
  jobDetails?: {
    createdAt: string | null;
    startedAt: string | null; // Changed from processedAt to startedAt
    completedAt: string | null; // Changed from finishedAt to completedAt
    retryCount: number; // Changed from attemptsMade to retryCount
    output: string | null; // Changed from failedReason to output
  };
  error?: string;
  errorCode?: string;
  isPermanent?: boolean;
  // Entitlement fields (DB-backed, added for transparency)
  isSkillCappedViewer?: boolean;
  entitlementSource?: string; // e.g., 'db'
}

/**
 * Tracked job information
 */
interface TrackedJob {
  jobId: string;
  matchHash: string;
  currentDelayMs: number;
  lastStatus: string;
  lastPolled: number;
  startTime: number;
  timer?: NodeJS.Timeout | undefined;
  isPaused: boolean;
  isPolling: boolean;
  contractViolationCount?: number; // Track backend contract violations for fail-safe
}

/**
 * Completion polling service for tracking job completion
 * Provides robust correlation tracking through direct API polling
 * Works with or without authentication
 */
export class CompletionPollingService extends EventEmitter {
  // Configuration constants
  private static readonly DEFAULT_BASE_INTERVAL_MS = 5000; // 5 seconds
  private static readonly DEFAULT_MAX_BACKOFF_MS = 60000; // 60 seconds
  private static readonly DEFAULT_MAX_CONCURRENT_POLLS = 6; // Reasonable concurrency
  private static readonly DEFAULT_WARMUP_NOTFOUND_MS = 120000; // 2 minutes
  private static readonly DEFAULT_JOB_STATUS_ENDPOINT = '/api/upload/job-status';
  private static readonly HTTP_TIMEOUT_MS = 10000; // 10 seconds
  private static readonly JITTER_PERCENT = 0.1; // ±10% jitter
  private static readonly MAX_CONTRACT_VIOLATIONS_BEFORE_FAILURE = 3; // Backend malformed payload guard

  private config: CompletionPollingConfig;
  private httpClient: AxiosInstance;
  private trackedJobs = new Map<string, TrackedJob>();
  private activePollCount = 0;
  private isServicePaused = false;

  constructor(config: CompletionPollingConfig) {
    super();
    this.config = {
      jobStatusEndpoint: CompletionPollingService.DEFAULT_JOB_STATUS_ENDPOINT,
      baseIntervalMs: CompletionPollingService.DEFAULT_BASE_INTERVAL_MS,
      maxBackoffMs: CompletionPollingService.DEFAULT_MAX_BACKOFF_MS,
      maxConcurrentPolls: CompletionPollingService.DEFAULT_MAX_CONCURRENT_POLLS,
      warmUpNotFoundMs: CompletionPollingService.DEFAULT_WARMUP_NOTFOUND_MS,
      ...config,
    };

    // Create HTTP client with optional authentication
    const headers: Record<string, string> = {
      'User-Agent': 'ArenaCoach-Desktop-Polling',
    };

    // Only add Authorization header if token is provided
    if (this.config.authToken && this.config.authToken.trim() !== '') {
      headers['Authorization'] = `Bearer ${this.config.authToken}`;
    }

    this.httpClient = axios.create({
      baseURL: this.config.apiBaseUrl,
      headers,
      timeout: CompletionPollingService.HTTP_TIMEOUT_MS,
    });

    console.info('[CompletionPollingService] Initialized with config:', {
      apiBaseUrl: this.config.apiBaseUrl,
      baseIntervalMs: this.config.baseIntervalMs,
      maxBackoffMs: this.config.maxBackoffMs,
      maxConcurrentPolls: this.config.maxConcurrentPolls,
    });
  }

  /**
   * Start tracking a job for completion via polling
   */
  public trackJob(jobId: string, matchHash: string): void {
    if (!matchHash) {
      console.warn('[CompletionPollingService] Refusing to track job without matchHash:', {
        jobId,
      });
      return;
    }

    console.info('[CompletionPollingService] Starting to track job:', {
      jobId,
      matchHash,
    });

    // Prevent duplicate tracking (idempotent registration)
    if (this.trackedJobs.has(jobId)) {
      console.debug('[CompletionPollingService] Job already tracked:', jobId);
      return;
    }

    const trackedJob: TrackedJob = {
      jobId,
      matchHash,
      currentDelayMs: this.config.baseIntervalMs!,
      lastStatus: 'unknown',
      lastPolled: 0,
      startTime: Date.now(),
      isPaused: this.isServicePaused,
      isPolling: false,
    };

    this.trackedJobs.set(jobId, trackedJob);

    // Start polling this job if service isn't paused
    if (!this.isServicePaused) {
      this.scheduleJobPoll(trackedJob);
    }

    this.emit('trackingStarted', { jobId, matchHash });
  }

  /**
   * Stop tracking a specific job
   */
  public stopTrackingJob(jobId: string): void {
    const trackedJob = this.trackedJobs.get(jobId);
    if (trackedJob) {
      // Clear timer if exists
      if (trackedJob.timer) {
        clearTimeout(trackedJob.timer);
        trackedJob.timer = undefined;
      }

      // Decrement active poll count if job was polling
      if (trackedJob.isPolling) {
        this.activePollCount = Math.max(0, this.activePollCount - 1);
      }

      this.trackedJobs.delete(jobId);
      console.info('[CompletionPollingService] Stopped tracking job:', jobId);
      this.emit('trackingStopped', { jobId });
    }
  }

  /**
   * Get list of currently tracked job IDs
   */
  public getTrackedJobIds(): string[] {
    return Array.from(this.trackedJobs.keys());
  }

  /**
   * Stop tracking all jobs and cease polling
   */
  public stopAll(): void {
    console.info('[CompletionPollingService] Stopping all tracking and polling');

    // Clear all timers and jobs
    for (const [jobId] of this.trackedJobs) {
      this.stopTrackingJob(jobId);
    }

    this.activePollCount = 0;
    this.isServicePaused = false;
  }

  /**
   * Pause all job polling (e.g., on auth failure or service disconnection)
   */
  public pausePolling(): void {
    console.info('[CompletionPollingService] Pausing all job polling');
    this.isServicePaused = true;

    // Clear all timers but keep jobs tracked
    for (const trackedJob of this.trackedJobs.values()) {
      trackedJob.isPaused = true;
      if (trackedJob.timer) {
        clearTimeout(trackedJob.timer);
        trackedJob.timer = undefined;
      }
      if (trackedJob.isPolling) {
        trackedJob.isPolling = false;
        this.activePollCount = Math.max(0, this.activePollCount - 1);
      }
    }
  }

  /**
   * Resume job polling (e.g., after auth restoration or service recovery)
   */
  public resumePolling(): void {
    if (!this.isServicePaused) return;

    console.info('[CompletionPollingService] Resuming job polling');
    this.isServicePaused = false;

    // Resume all jobs with base delay
    for (const trackedJob of this.trackedJobs.values()) {
      trackedJob.isPaused = false;
      trackedJob.currentDelayMs = this.config.baseIntervalMs!; // Reset backoff
      this.scheduleJobPoll(trackedJob);
    }
  }

  /**
   * Schedule a poll for a specific job with backoff and jitter
   */
  private scheduleJobPoll(trackedJob: TrackedJob): void {
    if (trackedJob.isPaused || this.isServicePaused || trackedJob.timer) {
      return;
    }

    // Apply jitter (±10%)
    const jitter = (Math.random() - 0.5) * 2 * CompletionPollingService.JITTER_PERCENT;
    const delayWithJitter = Math.round(trackedJob.currentDelayMs * (1 + jitter));

    console.debug('[CompletionPollingService] Scheduling job poll:', {
      jobId: trackedJob.jobId,
      delayMs: delayWithJitter,
      baseDelayMs: trackedJob.currentDelayMs,
    });

    trackedJob.timer = setTimeout(
      () => {
        trackedJob.timer = undefined;
        this.executeJobPoll(trackedJob);
      },
      Math.max(1000, delayWithJitter)
    ); // Minimum 1s delay
  }

  /**
   * Execute polling for a specific job with concurrency control
   */
  private async executeJobPoll(trackedJob: TrackedJob): Promise<void> {
    if (trackedJob.isPaused || this.isServicePaused) {
      return;
    }

    // Respect concurrency limits
    if (this.activePollCount >= this.config.maxConcurrentPolls!) {
      console.debug(
        '[CompletionPollingService] Concurrency limit reached, rescheduling job:',
        trackedJob.jobId
      );
      // Add small delay to avoid tight re-queue loops under sustained load
      setTimeout(() => this.scheduleJobPoll(trackedJob), 250);
      return;
    }

    // Mark as actively polling
    trackedJob.isPolling = true;
    this.activePollCount++;

    try {
      await this.pollJob(trackedJob);
    } finally {
      // Always decrement counter and mark not polling
      trackedJob.isPolling = false;
      this.activePollCount = Math.max(0, this.activePollCount - 1);
    }
  }

  /**
   * Get authorization headers if token is available
   */
  private getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.config.authToken && this.config.authToken.trim() !== '') {
      headers['Authorization'] = `Bearer ${this.config.authToken}`;
    }
    return headers;
  }

  /**
   * Poll a specific job for status updates with robust error handling.
   *
   * ENTITLEMENT INVARIANT:
   * Completion events and payload presence are dictated entirely by server response.
   * The client does not attempt to infer entitlements from local state.
   * Backend enforces DB-backed entitlements; desktop reacts to JobStatusResponse only.
   */
  private async pollJob(trackedJob: TrackedJob): Promise<void> {
    const { jobId, matchHash } = trackedJob;

    try {
      trackedJob.lastPolled = Date.now();

      console.debug('[CompletionPollingService] Polling job status:', {
        jobId,
        delayMs: trackedJob.currentDelayMs,
        hasAuth: !!(this.config.authToken && this.config.authToken.trim() !== ''),
      });

      // Make API request with optional auth headers
      const response = await this.httpClient.get<JobStatusResponse>(
        `${this.config.jobStatusEndpoint}/${jobId}`,
        { headers: this.getAuthHeaders() }
      );

      if (!response.data.success) {
        throw new Error(response.data.error || 'API request failed');
      }

      const statusData = response.data;

      // Report successful API call to health check
      this.config.healthCheck?.reportSuccess();

      // Check for progress - reset backoff on status change
      if (statusData.analysisStatus !== trackedJob.lastStatus) {
        trackedJob.currentDelayMs = this.config.baseIntervalMs!; // Reset to base
        trackedJob.lastStatus = statusData.analysisStatus;
      } else {
        // No progress - increase backoff with cap
        trackedJob.currentDelayMs = Math.min(
          trackedJob.currentDelayMs * 2,
          this.config.maxBackoffMs!
        );
      }

      // Emit successful poll status
      this.emit('serviceStatusChanged', {
        pollingActive: this.trackedJobs.size > 0,
        trackedJobsCount: this.trackedJobs.size,
        lastPollOkAt: Date.now(),
      });

      // Emit progress update
      this.emit('analysisProgress', {
        jobId,
        status: statusData.analysisStatus,
        message: this.getStatusMessage(statusData),
        matchHash,
      });

      // Check for completion
      if (this.isJobCompleted(statusData)) {
        console.info('[CompletionPollingService] Job completed via polling:', {
          jobId,
          analysisId: statusData.analysisId,
          analysisStatus: statusData.analysisStatus,
        });

        // Contract violation guard: detect backend bugs (completed + analysisId + malformed data)
        if (statusData.analysisId !== null && !Array.isArray(statusData.analysisData)) {
          const violationCount = (trackedJob.contractViolationCount || 0) + 1;
          trackedJob.contractViolationCount = violationCount;

          console.error('[CompletionPollingService] Backend contract violation:', {
            jobId,
            analysisId: statusData.analysisId,
            violationCount,
            threshold: CompletionPollingService.MAX_CONTRACT_VIOLATIONS_BEFORE_FAILURE,
          });

          if (violationCount >= CompletionPollingService.MAX_CONTRACT_VIOLATIONS_BEFORE_FAILURE) {
            this.emit('analysisFailed', {
              jobId,
              matchHash,
              error: 'Backend contract violation: completed with malformed analysisData payload',
              errorCode: 'BACKEND_CONTRACT_VIOLATION',
              isPermanent: true,
            });
            this.stopTrackingJob(jobId);
            return;
          }

          // Below threshold: reschedule with backoff
          this.increaseBackoff(trackedJob);
          this.scheduleJobPoll(trackedJob);
          return;
        }

        const normalizedAnalysisId =
          statusData.analysisId != null ? String(statusData.analysisId) : undefined;

        this.emit('analysisCompleted', {
          jobId,
          matchHash,
          analysisId: normalizedAnalysisId,
          analysisPayload: normalizedAnalysisId
            ? {
                uuid: statusData.uuid as string,
                events: Array.isArray(statusData.analysisData)
                  ? (statusData.analysisData as any)
                  : [],
              }
            : undefined,
          // Freemium metadata (entitlement-agnostic, for UI display)
          entitlementMode: statusData.entitlementMode,
          isSkillCappedViewer: statusData.isSkillCappedViewer,
          freeQuotaLimit: statusData.freeQuotaLimit,
          freeQuotaUsed: statusData.freeQuotaUsed,
          freeQuotaRemaining: statusData.freeQuotaRemaining,
          freeQuotaExhausted: statusData.freeQuotaExhausted,
        });

        this.stopTrackingJob(jobId);
        return;
      }

      // Check for failure
      if (this.isJobFailed(statusData)) {
        console.warn('[CompletionPollingService] Job failed:', {
          jobId,
          analysisStatus: statusData.analysisStatus,
          output: statusData.jobDetails?.output,
        });

        const message = statusData.jobDetails?.output || statusData.error || 'Job failed';

        this.emit('analysisFailed', {
          jobId,
          matchHash,
          error: message,
          errorCode: statusData.errorCode,
          isPermanent: statusData.isPermanent === true,
        });

        this.stopTrackingJob(jobId);
        return;
      }

      // Schedule next poll (monotonic scheduling)
      this.scheduleJobPoll(trackedJob);
    } catch (error) {
      await this.handlePollError(error, trackedJob);
    }
  }

  /**
   * Handle polling errors with appropriate backoff and recovery
   */
  private async handlePollError(error: unknown, trackedJob: TrackedJob): Promise<void> {
    const { jobId, matchHash } = trackedJob;

    if (isAxiosError(error)) {
      const status = error.response?.status;

      // 404 - Handle with warm-up window
      if (status === 404) {
        const ageMs = Date.now() - trackedJob.startTime;
        if (ageMs < this.config.warmUpNotFoundMs!) {
          // Still in warm-up period - continue polling
          console.debug('[CompletionPollingService] Job not found but still in warm-up period:', {
            jobId,
            ageMs,
            warmUpMs: this.config.warmUpNotFoundMs,
          });
          this.increaseBackoff(trackedJob);
          this.scheduleJobPoll(trackedJob);
        } else {
          // Past warm-up - job doesn't exist
          console.warn('[CompletionPollingService] Job not found after warm-up period:', jobId);
          this.emit('analysisFailed', {
            jobId,
            matchHash,
            error: 'Job not found - may have been cleaned up',
            errorCode: 'JOB_NOT_FOUND',
            isPermanent: true,
          });
          this.stopTrackingJob(jobId);
        }
        return;
      }

      // 401 - Auth failure, pause this job
      if (status === 401) {
        console.warn('[CompletionPollingService] Auth failure for job, pausing:', jobId);
        trackedJob.isPaused = true;
        this.emit('authRequired', {
          jobId,
          matchHash,
          reason: 'Unauthorized - token expired or invalid',
        });
        return;
      }

      // 5xx or network errors - continue with backoff
      if (!status || status >= 500) {
        this.config.healthCheck?.reportFailure(true);
      }
    } else {
      // Unknown error - assume network/server issue
      this.config.healthCheck?.reportFailure(true);
    }

    // Generic error handling - increase backoff and continue
    console.warn(
      '[CompletionPollingService] Poll error for job:',
      jobId,
      error instanceof Error ? error.message : error
    );

    this.emit('pollError', {
      jobId,
      matchHash,
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    this.increaseBackoff(trackedJob);
    this.scheduleJobPoll(trackedJob);
  }

  /**
   * Increase backoff delay for a job
   */
  private increaseBackoff(trackedJob: TrackedJob): void {
    trackedJob.currentDelayMs = Math.min(trackedJob.currentDelayMs * 2, this.config.maxBackoffMs!);
  }

  /**
   * Check if job is completed based on status response
   */
  private isJobCompleted(statusData: JobStatusResponse): boolean {
    // Now that backend only queries analyses table, analysisStatus is the single source of truth
    return statusData.analysisStatus === 'completed';
  }

  /**
   * Check if job has failed based on status response
   */
  private isJobFailed(statusData: JobStatusResponse): boolean {
    // Now that backend only queries analyses table, analysisStatus is the single source of truth
    return statusData.analysisStatus === 'failed';
  }

  /**
   * Generate user-friendly status message
   */
  private getStatusMessage(statusData: JobStatusResponse): string {
    // Now using only analysisStatus since backend simplified
    switch (statusData.analysisStatus) {
      case 'processing':
        return 'Analyzing match data and generating insights...';
      case 'queued':
        return 'Queued for processing...';
      case 'pending':
        return 'Analysis pending...';
      case 'completed':
        return 'Analysis complete';
      case 'failed':
        return 'Analysis failed';
      default:
        return `Status: ${statusData.analysisStatus}`;
    }
  }

  /**
   * Update authentication token and resume paused jobs
   */
  public updateAuthToken(newToken?: string): void {
    if (newToken && newToken.trim() !== '') {
      this.config.authToken = newToken;
      this.httpClient.defaults.headers['Authorization'] = `Bearer ${newToken}`;
      console.info('[CompletionPollingService] Updated authentication token');

      // Resume any jobs that were paused due to auth failure
      this.resumeAuthPausedJobs();
    } else {
      // Important: Delete the property and header entirely when no token
      delete this.config.authToken;
      delete this.httpClient.defaults.headers['Authorization'];
      console.info(
        '[CompletionPollingService] Cleared authentication token - using anonymous mode'
      );
    }
  }

  /**
   * Resume jobs that were paused due to auth failures
   */
  private resumeAuthPausedJobs(): void {
    const resumedJobs: string[] = [];

    for (const trackedJob of this.trackedJobs.values()) {
      if (trackedJob.isPaused) {
        trackedJob.isPaused = false;
        trackedJob.currentDelayMs = this.config.baseIntervalMs!; // Reset backoff
        this.scheduleJobPoll(trackedJob);
        resumedJobs.push(trackedJob.jobId);
      }
    }

    if (resumedJobs.length > 0) {
      const displayJobs = resumedJobs.length > 20 ? resumedJobs.slice(0, 20) : resumedJobs;
      console.info(
        `[CompletionPollingService] Resumed ${resumedJobs.length} auth-paused jobs:`,
        resumedJobs.length > 20
          ? [...displayJobs, `...and ${resumedJobs.length - 20} more`]
          : displayJobs
      );
    }
  }

  /**
   * Handle service health changes
   */
  public handleServiceHealth(isHealthy: boolean): void {
    if (isHealthy && this.isServicePaused) {
      this.resumePolling();
    } else if (!isHealthy && !this.isServicePaused) {
      this.pausePolling();
    }
  }

  /**
   * Get current polling statistics
   */
  public getPollingStats(): {
    trackedJobsCount: number;
    activePollCount: number;
    isServicePaused: boolean;
    trackedJobs: Array<{
      jobId: string;
      matchHash: string;
      currentDelayMs: number;
      isPaused: boolean;
      elapsedMs: number;
    }>;
  } {
    const now = Date.now();
    return {
      trackedJobsCount: this.trackedJobs.size,
      activePollCount: this.activePollCount,
      isServicePaused: this.isServicePaused,
      trackedJobs: Array.from(this.trackedJobs.values()).map(job => ({
        jobId: job.jobId,
        matchHash: job.matchHash,
        currentDelayMs: job.currentDelayMs,
        isPaused: job.isPaused,
        elapsedMs: now - job.startTime,
      })),
    };
  }
}
