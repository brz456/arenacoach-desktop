/**
 * Error types and codes for match processing pipeline
 * 
 * Provides specific, typed error classes for better error handling and debugging.
 * Replaces fragile string-based error detection with type-safe instanceof checks.
 */

/**
 * Error codes for programmatic error handling
 */
export enum PipelineErrorCode {
  COMBAT_LOG_EXPIRED = 'COMBAT_LOG_EXPIRED',
  UPLOAD_FAILED = 'UPLOAD_FAILED',
  AUTHENTICATION_FAILED = 'AUTHENTICATION_FAILED',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR'
}

/**
 * Base error class for all pipeline errors
 */
export abstract class PipelineError extends Error {
  public readonly code: PipelineErrorCode;
  public readonly timestamp: Date;

  constructor(message: string, code: PipelineErrorCode) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.timestamp = new Date();
    
    // Ensure proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Error thrown when a combat log is too old to process (older than 6 hours)
 */
export class CombatLogExpiredError extends PipelineError {
  public readonly ageInHours: number;

  constructor(message: string, ageInHours: number) {
    super(message, PipelineErrorCode.COMBAT_LOG_EXPIRED);
    this.ageInHours = ageInHours;
  }
}

/**
 * Error thrown when upload operations fail
 */
export class UploadFailedError extends PipelineError {
  constructor(message: string) {
    super(message, PipelineErrorCode.UPLOAD_FAILED);
  }
}

/**
 * Error thrown when authentication fails
 */
export class AuthenticationFailedError extends PipelineError {
  constructor(message: string) {
    super(message, PipelineErrorCode.AUTHENTICATION_FAILED);
  }
}

/**
 * Type guard to check if an error is a CombatLogExpiredError
 */
export function isCombatLogExpiredError(error: unknown): error is CombatLogExpiredError {
  return error instanceof CombatLogExpiredError;
}

/**
 * Type guard to check if an error is any PipelineError
 */
export function isPipelineError(error: unknown): error is PipelineError {
  return error instanceof PipelineError;
}