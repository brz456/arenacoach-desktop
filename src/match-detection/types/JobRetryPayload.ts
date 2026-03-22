/**
 * Retry error type classification (exact values emitted by orchestrator)
 * - 'timeout': Axios timeout (ECONNABORTED)
 * - 'network': Other network/connection errors
 */
export type JobRetryErrorType = 'timeout' | 'network';

/**
 * Job retry event payload - Single Source of Truth
 * Emitted when upload retry is scheduled for a match
 */
export interface JobRetryPayload {
  matchHash: string;
  attempt: number;
  delayMs: number;
  errorType: JobRetryErrorType;
}
