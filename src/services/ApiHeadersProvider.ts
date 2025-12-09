/**
 * ApiHeadersProvider - Centralized management of optional auth headers
 * 
 * This service manages HTTP headers for API requests, including optional
 * authentication tokens. When no token is present, requests proceed
 * anonymously. When a token is set, it's included in the Authorization header.
 */
export class ApiHeadersProvider {
  private static readonly TOKEN_MASK_PREFIX_LENGTH = 8;
  private authToken: string | undefined;

  constructor(initialToken?: string) {
    this.authToken = initialToken;
  }

  /**
   * Update the authentication token
   * @param token - The auth token to use, or undefined to clear auth
   */
  updateToken(token?: string): void {
    this.authToken = token;
    console.info('[ApiHeadersProvider] Auth token updated:', token ? 'Token set' : 'Token cleared');
  }

  /**
   * Get headers for API requests with optional auth
   * @param additionalHeaders - Any additional headers to include
   * @returns Combined headers object
   */
  getHeaders(additionalHeaders?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': 'ArenaCoach-Desktop',
      ...additionalHeaders
    };

    // Only add Authorization header if we have a valid token
    if (this.authToken && this.authToken.trim() !== '') {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    return headers;
  }

  /**
   * Check if authentication is currently set
   * @returns true if an auth token is present
   */
  hasAuth(): boolean {
    return !!(this.authToken && this.authToken.trim() !== '');
  }

  /**
   * Get current auth token (for debugging/logging only)
   * @returns Masked token string or 'none'
   */
  getTokenStatus(): string {
    if (!this.authToken || this.authToken.trim() === '') {
      return 'none';
    }
    // Mask token for security in logs
    return `${this.authToken.substring(0, ApiHeadersProvider.TOKEN_MASK_PREFIX_LENGTH)}...`;
  }
}