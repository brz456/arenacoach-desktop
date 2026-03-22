export const VALID_BUFFER_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function isValidBufferId(value: unknown): value is string {
  return typeof value === 'string' && VALID_BUFFER_ID_PATTERN.test(value);
}
