import axios from 'axios';

const MAX_STRING_CHARS = 500;

/**
 * Redact Authorization header values
 * If value starts with "Bearer " (case-insensitive), return "Bearer [REDACTED]"
 * Otherwise return "[REDACTED]"
 */
export function redactAuthorization(value: string): string {
  if (value.toLowerCase().startsWith('bearer ')) {
    return 'Bearer [REDACTED]';
  }
  return '[REDACTED]';
}

/**
 * Redact bearer tokens from any string content
 * Replaces all "Bearer <token>" patterns with "Bearer [REDACTED]"
 */
function redactBearerTokens(value: string): string {
  return value.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
}

/**
 * Convert any error to a safe log object without exposing secrets
 * Extracts minimal diagnostic info from Axios errors while redacting headers/tokens
 */
export function toSafeAxiosErrorLog(error: unknown): {
  name?: string;
  message: string;
  code?: string;
  status?: number;
  method?: string;
  url?: string;
  timeoutMs?: number;
  responseData?: { error?: string; success?: boolean; isIdempotent?: boolean } | string;
  isAxiosError: boolean;
} {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const axiosError = axios.isAxiosError(error) ? error : null;
  const result: ReturnType<typeof toSafeAxiosErrorLog> = {
    message: redactBearerTokens(rawMessage),
    isAxiosError: axiosError !== null,
  };

  // Add error name if available
  if (error instanceof Error && error.name) {
    result.name = error.name;
  }

  // Extract Axios-specific fields (early return if not an Axios error)
  if (!axiosError) {
    return result;
  }

  // Extract error code
  if (typeof axiosError.code === 'string') {
    result.code = axiosError.code;
  }

  // Extract HTTP status
  if (axiosError.response?.status !== undefined) {
    result.status = axiosError.response.status;
  }

  // Extract method (uppercased)
  if (typeof axiosError.config?.method === 'string') {
    result.method = axiosError.config.method.toUpperCase();
  }

  // Extract timeout (only if finite number)
  if (axiosError.config?.timeout !== undefined && Number.isFinite(axiosError.config.timeout)) {
    result.timeoutMs = axiosError.config.timeout;
  }

  // Extract URL (with baseURL resolution)
  const rawUrl = typeof axiosError.config?.url === 'string' ? axiosError.config.url : undefined;
  const baseURL =
    typeof axiosError.config?.baseURL === 'string' ? axiosError.config.baseURL : undefined;

  if (rawUrl) {
    if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
      result.url = rawUrl;
    } else if (baseURL) {
      result.url = `${baseURL.replace(/\/+$/, '')}/${rawUrl.replace(/^\/+/, '')}`;
    } else {
      result.url = rawUrl;
    }
  }

  // Extract response data (allowlisted fields only)
  if (axiosError.response?.data !== undefined) {
    const data = axiosError.response.data;

    if (typeof data === 'object' && data !== null) {
      // Extract allowlisted fields only
      const safeData: { error?: string; success?: boolean; isIdempotent?: boolean } = {};

      if (data.error !== undefined && data.error !== null) {
        // WI-02 standard error shape: { error: { code, message, details? } }
        const rawError = (data as { error?: unknown }).error;
        const errorValue =
          typeof rawError === 'object' &&
          rawError !== null &&
          'message' in rawError &&
          typeof (rawError as { message?: unknown }).message === 'string'
            ? (rawError as { message: string }).message
            : String(rawError);
        const redacted = redactBearerTokens(errorValue);
        safeData.error =
          redacted.length > MAX_STRING_CHARS
            ? redacted.slice(0, MAX_STRING_CHARS) + '…(truncated)'
            : redacted;
      }

      if (data.success !== undefined && data.success !== null) {
        safeData.success = Boolean(data.success);
      }

      if (data.isIdempotent !== undefined && data.isIdempotent !== null) {
        safeData.isIdempotent = Boolean(data.isIdempotent);
      }

      // Only include responseData if at least one field was extracted
      if (
        safeData.error !== undefined ||
        safeData.success !== undefined ||
        safeData.isIdempotent !== undefined
      ) {
        result.responseData = safeData;
      }
    } else if (typeof data === 'string') {
      // Truncate and redact string response data
      const redacted = redactBearerTokens(data);
      result.responseData =
        redacted.length > MAX_STRING_CHARS
          ? redacted.slice(0, MAX_STRING_CHARS) + '…(truncated)'
          : redacted;
    }
    // Omit responseData for other types (don't stringify arbitrary structures)
  }

  return result;
}
