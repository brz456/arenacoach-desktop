export class BackendContractViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackendContractViolationError';
  }
}

export class RealtimeStreamContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RealtimeStreamContractError';
  }
}

export class UnauthorizedAuthError extends Error {
  readonly status = 401;

  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedAuthError';
  }
}

export function isBackendContractViolationError(
  error: unknown
): error is BackendContractViolationError {
  return error instanceof BackendContractViolationError;
}

export function isUnauthorizedAuthError(error: unknown): error is UnauthorizedAuthError {
  return error instanceof UnauthorizedAuthError;
}
