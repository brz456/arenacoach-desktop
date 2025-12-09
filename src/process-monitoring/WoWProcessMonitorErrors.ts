/**
 * Error types and codes for WoW Process Monitor
 * 
 * Provides specific, typed error classes for better debugging and user support.
 * Replaces generic Error instances with meaningful, categorized errors.
 */

/**
 * Error codes for programmatic error handling
 */
export enum WoWProcessMonitorErrorCode {
  PROCESS_DETECTION_FAILED = 'PROCESS_DETECTION_FAILED',
  COMMAND_TIMEOUT = 'COMMAND_TIMEOUT',
  COMMAND_EXECUTION_FAILED = 'COMMAND_EXECUTION_FAILED',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR'
}

/**
 * Base error class for all WoW Process Monitor errors
 */
export abstract class WoWProcessMonitorError extends Error {
  public readonly code: WoWProcessMonitorErrorCode;
  public readonly timestamp: Date;

  constructor(message: string, code: WoWProcessMonitorErrorCode) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.timestamp = new Date();
    
    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Returns a formatted error message with code and timestamp
   */
  public getFormattedMessage(): string {
    return `[${this.code}] ${this.message} (${this.timestamp.toISOString()})`;
  }
}

/**
 * Error thrown when WoW process detection fails
 */
export class WoWProcessDetectionError extends WoWProcessMonitorError {
  constructor(message: string) {
    super(message, WoWProcessMonitorErrorCode.PROCESS_DETECTION_FAILED);
  }
}

/**
 * Error thrown when the tasklist command times out
 */
export class WoWProcessTimeoutError extends WoWProcessMonitorError {
  public readonly timeoutMs: number;

  constructor(timeoutMs: number, message?: string) {
    const defaultMessage = `Process detection command timed out after ${timeoutMs}ms`;
    super(message || defaultMessage, WoWProcessMonitorErrorCode.COMMAND_TIMEOUT);
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Error thrown when the tasklist command execution fails
 */
export class WoWProcessCommandError extends WoWProcessMonitorError {
  public readonly originalError: Error | undefined;
  public readonly exitCode: number | undefined;

  constructor(message: string, originalError?: Error, exitCode?: number) {
    super(message, WoWProcessMonitorErrorCode.COMMAND_EXECUTION_FAILED);
    this.originalError = originalError;
    this.exitCode = exitCode;
  }
}

/**
 * Error factory functions for consistent error creation
 */
export class WoWProcessMonitorErrorFactory {
  /**
   * Create a process detection error
   */
  static createDetectionError(message: string): WoWProcessDetectionError {
    return new WoWProcessDetectionError(message);
  }

  /**
   * Create a timeout error
   */
  static createTimeoutError(timeoutMs: number, customMessage?: string): WoWProcessTimeoutError {
    return new WoWProcessTimeoutError(timeoutMs, customMessage);
  }

  /**
   * Create a command execution error
   */
  static createCommandError(message: string, originalError?: Error, exitCode?: number): WoWProcessCommandError {
    return new WoWProcessCommandError(message, originalError, exitCode);
  }

  /**
   * Create an error from an unknown error type
   */
  static fromUnknownError(error: unknown): WoWProcessMonitorError {
    if (error instanceof WoWProcessMonitorError) {
      return error;
    }
    
    if (error instanceof Error) {
      return new WoWProcessCommandError(
        `Unknown error occurred: ${error.message}`,
        error
      );
    }
    
    return new WoWProcessDetectionError(
      `Unknown error occurred: ${String(error)}`
    );
  }
}

/**
 * Type guard to check if an error is a WoW Process Monitor error
 */
export function isWoWProcessMonitorError(error: unknown): error is WoWProcessMonitorError {
  return error instanceof WoWProcessMonitorError;
}

/**
 * Utility function to get error details for logging
 */
export function getErrorDetails(error: WoWProcessMonitorError): {
  code: string;
  message: string;
  timestamp: string;
  name: string;
  additionalInfo?: Record<string, unknown>;
} {
  const details = {
    code: error.code,
    message: error.message,
    timestamp: error.timestamp.toISOString(),
    name: error.name
  };

  // Add specific error type information
  if (error instanceof WoWProcessTimeoutError) {
    return {
      ...details,
      additionalInfo: { timeoutMs: error.timeoutMs }
    };
  }

  if (error instanceof WoWProcessCommandError) {
    return {
      ...details,
      additionalInfo: {
        exitCode: error.exitCode,
        originalError: error.originalError?.message
      }
    };
  }

  return details;
}