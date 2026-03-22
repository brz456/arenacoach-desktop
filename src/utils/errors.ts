/**
 * Application-level error with typed code property.
 * Follows Node.js convention of errors having a .code property.
 */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * Type guard for AppError instances.
 */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Type guard for Node.js system errors (e.g., ENOENT, EACCES).
 * Requires errno or syscall to distinguish from application errors with .code.
 */
export function isNodeError(error: unknown): error is NodeJS.ErrnoException & { code: string } {
  if (!(error instanceof Error) || !('code' in error)) return false;
  const e = error as Record<string, unknown>;
  return (
    typeof e.code === 'string' && (typeof e.errno === 'number' || typeof e.syscall === 'string')
  );
}
