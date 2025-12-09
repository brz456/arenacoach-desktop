import axios from 'axios';
import { ApiHeadersProvider } from './ApiHeadersProvider';
import { EventEmitter } from 'events';

/**
 * ServiceHealthCheck - Event-driven health tracking for backend availability
 * 
 * This service tracks backend availability based on actual API call results.
 * No periodic polling - health status is determined by real API interactions.
 * Supports optional idle checks when no jobs are being tracked.
 */
export class ServiceHealthCheck extends EventEmitter {
  // Configuration constants
  private static readonly HEALTH_CHECK_TIMEOUT_MS = 5000;
  private static readonly HEALTH_CHECK_ID_PREFIX = 'health-check-';

  private lastCheckResult: boolean = false;
  private lastCheckTime: number = 0;

  constructor(
    private apiBaseUrl: string,
    private headersProvider: ApiHeadersProvider,
    private jobStatusEndpoint: string = '/api/upload/job-status'
  ) {
    super();
    console.info('[ServiceHealthCheck] Initialized with event-driven health tracking');
  }

  /**
   * Report successful API call - service is available
   */
  reportSuccess(): void {
    const wasDown = !this.lastCheckResult;
    this.lastCheckResult = true;
    this.lastCheckTime = Date.now();
    
    if (wasDown) {
      console.info('[ServiceHealthCheck] Service is now available');
      this.emit('statusChanged', true);
    }
  }

  /**
   * Report failed API call - service may be unavailable
   * Only report down for network errors or 5xx responses
   */
  reportFailure(isNetworkOrServerError: boolean = true): void {
    if (!isNetworkOrServerError) {
      // 4xx errors don't mean service is down
      return;
    }
    
    const wasUp = this.lastCheckResult;
    this.lastCheckResult = false;
    this.lastCheckTime = Date.now();
    
    if (wasUp) {
      console.warn('[ServiceHealthCheck] Service is now unavailable');
      this.emit('statusChanged', false);
    }
  }

  /**
   * Get current service availability status
   */
  isServiceAvailable(): boolean {
    return this.lastCheckResult;
  }

  /**
   * Get last check time
   */
  getLastCheckTime(): number {
    return this.lastCheckTime;
  }

  /**
   * Get time since last successful check in milliseconds
   */
  getTimeSinceLastSuccess(): number | null {
    if (!this.lastCheckResult || this.lastCheckTime === 0) {
      return null;
    }
    return Date.now() - this.lastCheckTime;
  }

  /**
   * Perform a single health check (for idle checks)
   * Returns true if service is available, false otherwise
   */
  async checkOnce(): Promise<boolean> {
    try {
      // Generate a unique health check job ID
      const healthCheckJobId = `${ServiceHealthCheck.HEALTH_CHECK_ID_PREFIX}${Date.now()}`;
      
      const headers = this.headersProvider.getHeaders();
      await axios.get(
        `${this.apiBaseUrl}${this.jobStatusEndpoint}/${healthCheckJobId}`,
        {
          headers,
          timeout: ServiceHealthCheck.HEALTH_CHECK_TIMEOUT_MS
        }
      );
      
      // Even 404 means service is responding
      this.reportSuccess();
      return true;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response) {
          // 4xx responses mean service is available
          if (error.response.status >= 400 && error.response.status < 500) {
            this.reportSuccess();
            return true;
          }
          // 5xx responses mean service error
          this.reportFailure(true);
          return false;
        }
        // Network error
        this.reportFailure(true);
        return false;
      }
      // Unknown error
      this.reportFailure(true);
      return false;
    }
  }

  /**
   * Get current status for debugging
   */
  getStatus(): {
    isAvailable: boolean;
    lastCheckTime: number;
    hasAuth: boolean;
  } {
    return {
      isAvailable: this.lastCheckResult,
      lastCheckTime: this.lastCheckTime,
      hasAuth: this.headersProvider.hasAuth()
    };
  }
}