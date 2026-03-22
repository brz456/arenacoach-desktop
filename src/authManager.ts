import { EventEmitter } from 'events';
import axios, { AxiosResponse } from 'axios';
import { safeStorage, app, shell } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import http from 'http';
import { URL } from 'url';

import type { AuthToken, UserInfo, LoginResult } from './authTypes';

// Module-level constants for token rotation and expiry handling
const ROTATE_EARLY_MS = 24 * 60 * 60 * 1000; // 24 hours before expiry
const EXPIRY_LEEWAY_MS = 5 * 60 * 1000; // 5 minutes (clock skew tolerance)
const ROTATE_RETRY_DELAYS_MS = [5 * 60 * 1000, 30 * 60 * 1000, 2 * 60 * 60 * 1000] as const;
const SLOW_ROTATE_RETRY_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_TIMEOUT_MS = 2_147_483_647; // Node/Electron setTimeout clamp (~24.8 days)

export interface AuthConfig {
  apiBaseUrl: string;
  tokenRotateEndpoint?: string; // default: '/api/auth/desktop/token/rotate'
}

// Stored auth shapes for deterministic Date serialization
type StoredAuthToken = Omit<AuthToken, 'expiresAt'> & { expiresAtMs: number };
type StoredAuthData = { token: StoredAuthToken; user: UserInfo; savedAt: number };

/**
 * Decode JWT payload and extract exp claim as milliseconds.
 * Returns null if token is malformed or exp is missing/invalid.
 * Does NOT verify signature (desktop cannot; secret not available).
 */
function decodeJwtExpMs(accessToken: string): number | null {
  try {
    const parts = accessToken.split('.');
    if (parts.length !== 3 || !parts[1]) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number') return null;
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

/**
 * Schedule a callback at a target timestamp, handling setTimeout's ~24.8 day clamp.
 * Re-schedules in chunks until target is reached.
 */
function scheduleUntil(
  targetMs: number,
  callback: () => void,
  setHandle: (handle: NodeJS.Timeout) => void
): void {
  const step = () => {
    const now = Date.now();
    const remainingMs = targetMs - now;
    if (remainingMs <= 0) {
      const handle = setTimeout(callback, 0);
      setHandle(handle);
      return;
    }
    const delayMs = Math.min(remainingMs, MAX_TIMEOUT_MS);
    const handle = setTimeout(step, delayMs);
    setHandle(handle);
  };
  step();
}

/**
 * Convert unknown error to Error instance for consistent auth-error emission.
 */
function toError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) return error;
  if (typeof error === 'string') return new Error(error);
  if (error && typeof error === 'object' && 'message' in error) {
    return new Error(String((error as { message: unknown }).message));
  }
  return new Error(fallbackMessage);
}

/**
 * Parse Retry-After header value (integer seconds OR HTTP-date).
 * Returns milliseconds until retry, or undefined if unparseable/missing.
 */
function parseRetryAfterMs(header: string | undefined): number | undefined {
  if (!header) return undefined;
  const parsed = parseInt(header, 10);
  if (!isNaN(parsed)) {
    return parsed * 1000;
  }
  const dateMs = Date.parse(header);
  if (!isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

/**
 * Escape HTML special characters to prevent XSS.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export class AuthManager extends EventEmitter {
  private config: AuthConfig;
  private currentToken: AuthToken | null = null;
  private currentUser: UserInfo | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private expiryTimer: NodeJS.Timeout | null = null;
  private rotationRetryCount = 0;
  private logoutPromise: Promise<void> | null = null;
  private authInProgress = false;

  constructor(config: AuthConfig) {
    super();
    this.config = {
      apiBaseUrl: config.apiBaseUrl,
      tokenRotateEndpoint: config.tokenRotateEndpoint ?? '/api/auth/desktop/token/rotate',
    };
  }

  /**
   * Initialize the AuthManager - must be called after construction
   */
  public async initialize(): Promise<void> {
    await this.loadSavedAuth();
  }

  /**
   * Battle.net OAuth authentication with system browser + loopback
   * Implements RFC 8252-compliant OAuth flow for native applications
   */
  public async loginWithBattleNet(): Promise<LoginResult> {
    // Guard: prevent concurrent OAuth flows
    if (this.authInProgress) {
      return { success: false, error: 'Authentication already in progress' };
    }

    this.authInProgress = true;
    let callbackServer: http.Server | null = null;

    try {
      // Start local callback server
      const callbackPort = await this.startCallbackServer(server => {
        callbackServer = server;
      });

      // Initialize desktop OAuth session
      const initResponse = await axios.post(
        `${this.config.apiBaseUrl}/api/auth/desktop/oauth/initiate`,
        { callback_port: callbackPort },
        { timeout: 30000, validateStatus: () => true }
      );

      // Validate initiate response shape
      const initData = initResponse.data;
      if (typeof initData !== 'object' || initData === null) {
        return {
          success: false,
          error: 'OAuth initiate: invalid response format',
          errorCode: 'CONTRACT_VIOLATION',
        };
      }
      if (!initResponse.status.toString().startsWith('2') || !initData.success) {
        const message =
          typeof initData.error?.message === 'string' ? initData.error.message : undefined;
        return {
          success: false,
          error: message ?? 'Failed to initialize OAuth session',
        };
      }
      if (
        typeof initData.desktop_session_id !== 'string' ||
        typeof initData.auth_url !== 'string'
      ) {
        return {
          success: false,
          error: 'OAuth initiate: missing desktop_session_id or auth_url',
          errorCode: 'CONTRACT_VIOLATION',
        };
      }

      const { desktop_session_id, auth_url } = initData;

      // Open system browser to Battle.net OAuth URL
      await shell.openExternal(auth_url);

      // Wait for callback with timeout
      if (!callbackServer) {
        throw new Error('Callback server not initialized');
      }
      const loginCode = await this.waitForCallback(callbackServer, 600000); // 10min timeout for real-world auth scenarios (2FA, user delays)

      // Exchange login code for JWT token
      const exchangeResponse = await axios.post(
        `${this.config.apiBaseUrl}/api/auth/desktop/oauth/exchange`,
        {
          desktop_session_id,
          login_code: loginCode,
        },
        { timeout: 30000, validateStatus: () => true }
      );

      // Validate exchange response shape
      const exchangeData = exchangeResponse.data;
      if (typeof exchangeData !== 'object' || exchangeData === null) {
        return {
          success: false,
          error: 'OAuth exchange: invalid response format',
          errorCode: 'CONTRACT_VIOLATION',
        };
      }
      if (!exchangeResponse.status.toString().startsWith('2') || !exchangeData.success) {
        const message =
          typeof exchangeData.error?.message === 'string' ? exchangeData.error.message : undefined;
        return {
          success: false,
          error: message ?? 'Token exchange failed',
        };
      }
      if (typeof exchangeData.token !== 'string') {
        return {
          success: false,
          error: 'OAuth exchange: missing or invalid token',
          errorCode: 'CONTRACT_VIOLATION',
        };
      }
      const user = exchangeData.user;
      if (
        typeof user !== 'object' ||
        user === null ||
        typeof user.id !== 'string' ||
        typeof user.bnet_id !== 'string' ||
        typeof user.battletag !== 'string'
      ) {
        return {
          success: false,
          error: 'OAuth exchange: missing or invalid user data',
          errorCode: 'CONTRACT_VIOLATION',
        };
      }

      const token = exchangeData.token;

      // Derive expiresAt from token exp claim (required for desktop tokens)
      const expiresAtMs = decodeJwtExpMs(token);
      if (!expiresAtMs) {
        // Backend contract violation: desktop tokens MUST contain exp
        return {
          success: false,
          error: 'Authentication token missing expiry',
          errorCode: 'CONTRACT_VIOLATION' as const,
        };
      }

      const authToken: AuthToken = {
        accessToken: token,
        tokenType: 'Bearer',
        expiresAt: new Date(expiresAtMs),
      };

      // Reset rotation retry count on fresh login
      this.rotationRetryCount = 0;

      const result = this.setAuthToken(authToken, user);
      await this.saveAuthData();

      return result;
    } catch (error: unknown) {
      this.emit('auth-error', toError(error, 'Battle.net authentication failed'));
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Battle.net authentication failed',
      };
    } finally {
      this.authInProgress = false;
      this.stopCallbackServer(callbackServer);
    }
  }

  /**
   * Start local HTTP server for OAuth callback
   */
  private async startCallbackServer(setServerRef: (server: http.Server) => void): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer();
      setServerRef(server);

      // Try preferred port 12345, then fallback to OS-assigned ephemeral port
      const tryListen = (port: number, fallbackToEphemeral: boolean): void => {
        const onError = (err: NodeJS.ErrnoException): void => {
          if (err.code === 'EADDRINUSE' && fallbackToEphemeral) {
            // Preferred port in use - let OS assign an available ephemeral port
            server.off('error', onError);
            tryListen(0, false);
          } else {
            reject(new Error(`Failed to start callback server: ${err.message}`));
          }
        };

        // Attach error handler BEFORE listen to catch early bind errors
        server.once('error', onError);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', onError);
          const addr = server.address();
          const assignedPort = typeof addr === 'object' && addr ? addr.port : port;
          resolve(assignedPort);
        });
      };

      tryListen(12345, true);
    });
  }

  /**
   * Wait for OAuth callback with login code
   */
  private async waitForCallback(server: http.Server, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('OAuth callback timeout - user may have canceled authentication'));
      }, timeoutMs);

      server.on('request', (req, res) => {
        // Validate request has required fields (loopback-only, but be defensive)
        if (!req.url) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Bad Request: missing URL');
          return;
        }

        let url: URL;
        try {
          // Use localhost as base since headers.host may be missing
          url = new URL(req.url, 'http://127.0.0.1');
        } catch {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Bad Request: invalid URL');
          return;
        }

        if (url.pathname === '/callback') {
          const loginCode = url.searchParams.get('login_code');
          const error = url.searchParams.get('error');

          if (error) {
            // Send error response to browser (escape error to prevent XSS)
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(
              `
              <html>
                <head><title>Authentication Error</title></head>
                <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
                  <h2>Authentication Failed</h2>
                  <p>Error: ${escapeHtml(error)}</p>
                  <p>You can close this window and try again.</p>
                </body>
              </html>
            `,
              () => {
                clearTimeout(timeout);
                reject(new Error(`OAuth authentication failed: ${error}`));
              }
            );
            return;
          }

          if (loginCode) {
            // Send success response to browser
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(
              `
              <html>
                <head><title>Authentication Successful</title></head>
                <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
                  <h2>Authentication Successful!</h2>
                  <p>You can close this window and return to the app.</p>
                  <script>setTimeout(() => window.close(), 2000);</script>
                </body>
              </html>
            `,
              () => {
                // Only resolve after response is fully sent
                clearTimeout(timeout);
                resolve(loginCode);
              }
            );
          } else {
            // Send error response for missing login code
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(
              `
              <html>
                <head><title>Authentication Error</title></head>
                <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
                  <h2>Authentication Error</h2>
                  <p>Missing login code. Please try again.</p>
                </body>
              </html>
            `,
              () => {
                clearTimeout(timeout);
                reject(new Error('Missing login code in callback'));
              }
            );
          }
        } else {
          res.writeHead(404);
          res.end('Not Found');
        }
      });
    });
  }

  /**
   * Stop the callback server
   */
  private stopCallbackServer(server: http.Server | null): void {
    if (server && server.listening) {
      server.close();
    }
  }

  /**
   * Set authentication token and user.
   * Requires token.expiresAt or derivable from JWT exp claim (truthfulness invariant).
   * Rejects already-expired tokens (truthfulness: never emit auth-success for expired token).
   * User is required (no fallback fetch - caller must provide).
   */
  public setAuthToken(token: AuthToken, user: UserInfo): LoginResult {
    // Ensure deterministic expiry (truthfulness: never emit auth-success without known expiry)
    let tokenWithExpiry: AuthToken;
    if (token.expiresAt) {
      tokenWithExpiry = token;
    } else {
      const expMs = decodeJwtExpMs(token.accessToken);
      if (!expMs) {
        return {
          success: false,
          error: 'Token missing expiry: no expiresAt and cannot derive from JWT exp',
          errorCode: 'CONTRACT_VIOLATION',
        };
      }
      tokenWithExpiry = { ...token, expiresAt: new Date(expMs) };
    }

    // Truthfulness: reject tokens already expired or within leeway
    const expiresAtMs = tokenWithExpiry.expiresAt!.getTime();
    if (expiresAtMs - EXPIRY_LEEWAY_MS <= Date.now()) {
      return {
        success: false,
        error: 'Token already expired or within expiry leeway',
        errorCode: 'UNAUTHORIZED',
      };
    }

    this.currentToken = tokenWithExpiry;
    this.currentUser = user;

    // Setup token refresh (expiry guaranteed)
    this.setupTokenRefresh();

    console.debug('[AuthManager] Emitting auth-success event with user:', user.battletag);
    this.emit('auth-success', { token: tokenWithExpiry, user });

    return {
      success: true,
      token: tokenWithExpiry,
      user,
    };
  }

  /**
   * Get current authentication token
   */
  public getAuthToken(): AuthToken | null {
    return this.currentToken;
  }

  /**
   * Get current user info
   */
  public getCurrentUser(): UserInfo | null {
    return this.currentUser;
  }

  /**
   * Update current user info (e.g., after Skill Capped verification)
   */
  public updateCurrentUser(user: UserInfo): void {
    this.currentUser = user;
  }

  /**
   * Check if user is authenticated
   */
  public isAuthenticated(): boolean {
    return this.currentToken !== null && this.currentUser !== null && !this.isTokenExpired();
  }

  /**
   * Check if token is expired or about to expire.
   * Returns true if expiresAt is missing (truthfulness: cannot claim valid without deterministic expiry).
   */
  public isTokenExpired(): boolean {
    if (!this.currentToken?.expiresAt) {
      return true; // No expiration info - treat as expired for truthfulness
    }

    // Consider token expired if it expires within EXPIRY_LEEWAY_MS
    const leewayFromNow = new Date(Date.now() + EXPIRY_LEEWAY_MS);
    return this.currentToken.expiresAt <= leewayFromNow;
  }

  /**
   * Rotate desktop JWT token (extend validity while authenticated).
   * Single-shot call; retry logic is owned by setupTokenRefresh scheduler.
   */
  public async rotateToken(): Promise<LoginResult> {
    // Snapshot token at entry for concurrency safety (logout can null this.currentToken mid-request)
    const tokenSnapshot = this.currentToken;
    if (!tokenSnapshot?.accessToken) {
      return { success: false, error: 'No authentication token available', errorCode: 'NO_TOKEN' };
    }

    let response: AxiosResponse;
    try {
      response = await axios.post(
        `${this.config.apiBaseUrl}${this.config.tokenRotateEndpoint}`,
        {},
        {
          headers: {
            Authorization: `Bearer ${tokenSnapshot.accessToken}`,
          },
          validateStatus: () => true, // Handle all status codes manually
          timeout: 10000, // 10s bounded timeout (TRANSIENT on timeout)
        }
      );
    } catch (error: unknown) {
      // Distinguish network errors (TRANSIENT) from response errors (status-based classification)
      if (axios.isAxiosError(error) && error.response) {
        // Response received but axios threw (e.g., transform error) - classify by status
        const status = error.response.status;

        // 401: Must logout even if axios threw during response processing
        if (status === 401) {
          this.emit('token-refresh-failed', new Error('Token expired or invalid'));
          await this.logout();
          return { success: false, error: 'Token expired or invalid', errorCode: 'UNAUTHORIZED' };
        }

        // 429: Rate limited
        if (status === 429) {
          const retryAfterMs = parseRetryAfterMs(error.response.headers?.['retry-after']);
          this.emit('token-refresh-failed', new Error('Rate limited'));
          const result: LoginResult = {
            success: false,
            error: 'Rate limited',
            errorCode: 'RATE_LIMITED',
          };
          if (retryAfterMs !== undefined) result.retryAfterMs = retryAfterMs;
          return result;
        }

        // 5xx or 404: Transient
        if (status >= 500 || status === 404) {
          this.emit('token-refresh-failed', toError(error, `Server error: ${status}`));
          return { success: false, error: `Server error: ${status}`, errorCode: 'TRANSIENT' };
        }

        // Other statuses with parse/transform error: Contract violation
        this.emit('token-refresh-failed', toError(error, 'Token rotation response error'));
        return {
          success: false,
          error: error.message || 'Token rotation contract violation: response error',
          errorCode: 'CONTRACT_VIOLATION',
        };
      }
      // Network errors, timeouts, DNS, TLS failures (no response) → TRANSIENT
      this.emit('token-refresh-failed', toError(error, 'Token rotation network error'));
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Token rotation network error',
        errorCode: 'TRANSIENT',
      };
    }

    const status = response.status;

    // 401: Unauthorized - token rejected, logout immediately
    if (status === 401) {
      this.emit('token-refresh-failed', new Error('Token expired or invalid'));
      await this.logout();
      return { success: false, error: 'Token expired or invalid', errorCode: 'UNAUTHORIZED' };
    }

    // 429: Rate limited - retryable with Retry-After
    if (status === 429) {
      const retryAfterMs = parseRetryAfterMs(response.headers['retry-after']);
      this.emit('token-refresh-failed', new Error('Rate limited'));
      const result: LoginResult = {
        success: false,
        error: 'Rate limited',
        errorCode: 'RATE_LIMITED',
      };
      if (retryAfterMs !== undefined) result.retryAfterMs = retryAfterMs;
      return result;
    }

    // 5xx: Server error - transient
    if (status >= 500 && status < 600) {
      this.emit('token-refresh-failed', new Error(`Server error: ${status}`));
      return { success: false, error: `Server error: ${status}`, errorCode: 'TRANSIENT' };
    }

    // 404: Endpoint missing (deploy sequencing) - transient
    if (status === 404) {
      this.emit('token-refresh-failed', new Error('Rotate endpoint not found'));
      return { success: false, error: 'Rotate endpoint not found', errorCode: 'TRANSIENT' };
    }

    // Other 4xx (400, 403, 405, 415, etc): Contract violation - non-retryable
    if (status >= 400 && status < 500) {
      this.emit('token-refresh-failed', new Error(`Client error: ${status}`));
      return {
        success: false,
        error: `Token rotation client error: ${status}`,
        errorCode: 'CONTRACT_VIOLATION',
      };
    }

    // 2xx: Success - validate and parse response
    if (status >= 200 && status < 300) {
      // Validate response.data is a non-null object (axios auto-parses JSON)
      const rawData = response.data;
      if (typeof rawData !== 'object' || rawData === null) {
        this.emit('token-refresh-failed', new Error('Invalid response format'));
        return {
          success: false,
          error: 'Token rotation contract violation: response not an object',
          errorCode: 'CONTRACT_VIOLATION',
        };
      }
      const data = rawData as { success?: boolean; token?: string; expires_at?: string };

      // Require success === true (reject missing/false/non-boolean)
      if (data.success !== true) {
        this.emit('token-refresh-failed', new Error('Response success flag not true'));
        return {
          success: false,
          error: 'Token rotation contract violation: success !== true',
          errorCode: 'CONTRACT_VIOLATION',
        };
      }

      if (!data.token || typeof data.token !== 'string') {
        // Missing token - contract violation but existing token still usable
        this.emit('token-refresh-failed', new Error('Missing token in response'));
        return {
          success: false,
          error: 'Token rotation contract violation: missing token',
          errorCode: 'CONTRACT_VIOLATION',
        };
      }

      // Derive expiry from token exp claim (SSoT)
      const expMs = decodeJwtExpMs(data.token);
      if (!expMs) {
        // Cannot derive expiry from NEW token - must logout (truthfulness: can't maintain expiry state)
        this.emit('token-refresh-failed', new Error('Token missing exp claim'));
        await this.logout();
        return {
          success: false,
          error: 'Token rotation contract violation: missing exp',
          errorCode: 'CONTRACT_VIOLATION',
        };
      }

      // Check expires_at consistency hint if present (optional, SSoT is JWT exp)
      if (data.expires_at) {
        const hintMs = Date.parse(data.expires_at);
        if (isNaN(hintMs)) {
          // expires_at present but unparseable - warn but continue (JWT exp is SSoT)
          console.warn('[AuthManager] Token rotation: expires_at hint unparseable, using JWT exp', {
            expires_at: data.expires_at,
            expMs,
          });
        } else if (Math.abs(hintMs - expMs) > EXPIRY_LEEWAY_MS) {
          console.warn(
            '[AuthManager] Token rotation: expires_at hint differs from token exp beyond leeway',
            { expMs, hintMs, leewayMs: EXPIRY_LEEWAY_MS }
          );
        }
      }

      // Check if still logged in with same token (logout+relogin could have occurred during HTTP call)
      if (!this.currentToken || this.currentToken.accessToken !== tokenSnapshot.accessToken) {
        return { success: false, error: 'Token changed during rotation', errorCode: 'NO_TOKEN' };
      }

      // Update token (use snapshot for base, not this.currentToken which could race)
      const newToken: AuthToken = {
        accessToken: data.token,
        expiresAt: new Date(expMs),
      };
      if (tokenSnapshot.tokenType) newToken.tokenType = tokenSnapshot.tokenType;
      if (tokenSnapshot.refreshToken) newToken.refreshToken = tokenSnapshot.refreshToken;
      this.currentToken = newToken;

      // Immediately reschedule timers for new token (prevents stale expiry timer race)
      this.setupTokenRefresh();

      // Save and emit success
      await this.saveAuthData();
      this.emit('token-refreshed', newToken);

      const result: LoginResult = {
        success: true,
        token: newToken,
      };
      if (this.currentUser) result.user = this.currentUser;
      return result;
    }

    // 3xx: Redirect - misconfiguration, non-retryable
    if (status >= 300 && status < 400) {
      this.emit('token-refresh-failed', new Error(`Unexpected redirect: ${status}`));
      return {
        success: false,
        error: `Token rotation contract violation: unexpected redirect ${status}`,
        errorCode: 'CONTRACT_VIOLATION',
      };
    }

    // 1xx: Informational - shouldn't happen with axios, non-retryable
    if (status < 200) {
      this.emit('token-refresh-failed', new Error(`Unexpected informational status: ${status}`));
      return {
        success: false,
        error: `Token rotation contract violation: unexpected status ${status}`,
        errorCode: 'CONTRACT_VIOLATION',
      };
    }

    // Defensive fallback (should be unreachable with exhaustive classification above)
    this.emit('token-refresh-failed', new Error(`Unhandled status: ${status}`));
    return {
      success: false,
      error: `Token rotation contract violation: unhandled status ${status}`,
      errorCode: 'CONTRACT_VIOLATION',
    };
  }

  /**
   * Logout and clear authentication.
   * Idempotent: concurrent calls deduplicate; emits 'logout' at most once per transition.
   */
  public async logout(): Promise<void> {
    // Deduplicate concurrent calls
    if (this.logoutPromise) {
      return this.logoutPromise;
    }

    // Already logged out - no-op
    if (!this.currentToken && !this.currentUser) {
      return;
    }

    this.logoutPromise = (async () => {
      try {
        // Clear all timers first (deterministic, non-blocking)
        if (this.refreshTimer) {
          clearTimeout(this.refreshTimer);
          this.refreshTimer = null;
        }
        if (this.expiryTimer) {
          clearTimeout(this.expiryTimer);
          this.expiryTimer = null;
        }

        // Reset rotation retry count
        this.rotationRetryCount = 0;

        // Capture token for server notify before clearing
        const tokenForNotify = this.currentToken?.accessToken;

        // Clear local state immediately (truthfulness: UI shows logged out)
        this.currentToken = null;
        this.currentUser = null;

        // Clear saved authentication
        await this.clearSavedAuth();

        // Emit logout event (UI can update)
        this.emit('logout');

        // Fire-and-forget server notify with bounded timeout (best-effort, non-blocking)
        if (tokenForNotify) {
          axios
            .post(
              `${this.config.apiBaseUrl}/api/auth/logout-desktop`,
              {},
              {
                headers: { Authorization: `Bearer ${tokenForNotify}` },
                timeout: 5000, // 5s bounded timeout
              }
            )
            .catch(error => {
              console.warn('[AuthManager] Failed to notify server of logout (best-effort)', {
                error: error instanceof Error ? error.message : error,
              });
            });
        }
      } finally {
        this.logoutPromise = null;
      }
    })();

    return this.logoutPromise;
  }

  /**
   * Setup automatic token rotation and hard expiry logout.
   * Uses desktop token rotation (not refresh tokens).
   */
  private setupTokenRefresh(): void {
    // Clear any existing timers
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }

    if (!this.currentToken?.expiresAt) {
      return; // No expiration info
    }

    const expiresAtMs = this.currentToken.expiresAt.getTime();
    const hardLogoutAtMs = expiresAtMs - EXPIRY_LEEWAY_MS;

    // Schedule hard expiry logout (truthfulness: never show logged-in after expiry)
    const msUntilHardLogout = hardLogoutAtMs - Date.now();
    const logoutWithErrorHandling = (): void => {
      this.logout().catch(err => this.emit('auth-error', toError(err, 'Expiry logout failed')));
    };
    if (msUntilHardLogout <= 0) {
      // Already expired - logout immediately
      setTimeout(logoutWithErrorHandling, 0);
      return;
    }
    scheduleUntil(hardLogoutAtMs, logoutWithErrorHandling, handle => {
      this.expiryTimer = handle;
    });

    // Schedule rotation 24 hours before expiry
    const rotateAtMs = expiresAtMs - ROTATE_EARLY_MS;
    const msUntilRotate = rotateAtMs - Date.now();

    // Define rotation attempt with retry logic
    const rotateAttempt = async (): Promise<void> => {
      const result = await this.rotateToken();

      if (result.success) {
        // Reset retry count (rescheduling already done in rotateToken success path)
        this.rotationRetryCount = 0;
        return;
      }

      // Handle by error code
      switch (result.errorCode) {
        case 'UNAUTHORIZED':
          // Logout already occurred in rotateToken; stop
          return;

        case 'NO_TOKEN':
          // No token (logged out before timer fired); stop
          return;

        case 'CONTRACT_VIOLATION':
          // Non-retryable; emit auth-error and stop
          this.emit('auth-error', new Error(result.error ?? 'Token rotation failed'));
          return;

        case 'TRANSIENT':
        case 'RATE_LIMITED': {
          // Retryable - check if we have quick retries left
          const nextRetryDelayMs = ROTATE_RETRY_DELAYS_MS[this.rotationRetryCount];
          if (nextRetryDelayMs !== undefined) {
            const retryAfter = result.retryAfterMs;
            const actualDelay =
              result.errorCode === 'RATE_LIMITED' && retryAfter !== undefined
                ? Math.max(retryAfter, nextRetryDelayMs)
                : nextRetryDelayMs;
            this.rotationRetryCount += 1;
            // Use scheduleUntil to handle potential setTimeout overflow from large Retry-After
            scheduleUntil(Date.now() + actualDelay, rotateWithErrorHandling, h => {
              this.refreshTimer = h;
            });
            return;
          }

          // Quick retries exhausted - enter slow retry phase (bounded by expiry)
          const currentHardLogoutAtMs =
            (this.currentToken?.expiresAt?.getTime() ?? Date.now()) - EXPIRY_LEEWAY_MS;
          const msUntilHardLogoutNow = currentHardLogoutAtMs - Date.now();
          const slowRetryDelayMs = Math.min(
            SLOW_ROTATE_RETRY_MS,
            Math.max(0, msUntilHardLogoutNow)
          );

          if (slowRetryDelayMs <= 0) {
            // Expiry imminent - rely on hard logout timer
            return;
          }

          // Use scheduleUntil to handle potential setTimeout overflow
          scheduleUntil(Date.now() + slowRetryDelayMs, rotateWithErrorHandling, h => {
            this.refreshTimer = h;
          });
          return;
        }

        default:
          // Unknown error code - stop retrying
          this.emit('auth-error', new Error(result.error ?? 'Token rotation failed'));
          return;
      }
    };

    // Wrapper to catch and surface async errors from timer callbacks
    const rotateWithErrorHandling = (): void => {
      rotateAttempt().catch(err => this.emit('auth-error', toError(err, 'Token rotation failed')));
    };

    // Schedule initial rotation
    if (msUntilRotate <= 0) {
      // Already within early window - rotate immediately
      this.refreshTimer = setTimeout(rotateWithErrorHandling, 0);
    } else {
      scheduleUntil(rotateAtMs, rotateWithErrorHandling, handle => {
        this.refreshTimer = handle;
      });
    }
  }

  /**
   * Get auth header for API requests
   */
  public getAuthHeader(): string | null {
    if (!this.currentToken) {
      return null;
    }

    return `${this.currentToken.tokenType || 'Bearer'} ${this.currentToken.accessToken}`;
  }

  /**
   * Save authentication data securely using Windows Credential Manager (via Electron safeStorage).
   * Uses StoredAuthData format with expiresAtMs (not Date) for deterministic serialization.
   */
  private async saveAuthData(): Promise<void> {
    if (!this.currentToken || !this.currentUser) {
      return;
    }

    // Require expiresAt for desktop tokens (truthfulness invariant)
    if (!this.currentToken.expiresAt) {
      console.error('[AuthManager] Cannot save auth: token missing expiresAt');
      await this.clearSavedAuth();
      return;
    }

    try {
      const storedToken: StoredAuthToken = {
        accessToken: this.currentToken.accessToken,
        expiresAtMs: this.currentToken.expiresAt.getTime(),
      };
      if (this.currentToken.tokenType) storedToken.tokenType = this.currentToken.tokenType;
      if (this.currentToken.refreshToken) storedToken.refreshToken = this.currentToken.refreshToken;

      const authData: StoredAuthData = {
        token: storedToken,
        user: this.currentUser,
        savedAt: Date.now(),
      };

      const dataString = JSON.stringify(authData);

      // Use Windows Credential Manager encryption via Electron safeStorage
      if (safeStorage.isEncryptionAvailable()) {
        const encryptedData = safeStorage.encryptString(dataString);
        const authFilePath = path.join(app.getPath('userData'), 'auth-data.enc');
        await fs.writeFile(authFilePath, encryptedData);
      } else {
        console.warn(
          '[AuthManager] Windows Credential Manager encryption not available - authentication will not persist'
        );
        // Clear any existing stale auth file to prevent restoring outdated state
        await this.clearSavedAuth();
      }
    } catch (error) {
      console.error('[AuthManager] Failed to save auth data:', error);
    }
  }

  /**
   * Load saved authentication data from Windows Credential Manager.
   * Validates StoredAuthData format, JWT exp, and expiry before restoring.
   */
  private async loadSavedAuth(): Promise<void> {
    const authFilePath = path.join(app.getPath('userData'), 'auth-data.enc');

    let encryptedData: Buffer;
    try {
      encryptedData = await fs.readFile(authFilePath);
    } catch (error: unknown) {
      const err = error as { code?: string };
      if (err.code !== 'ENOENT') {
        console.error('[AuthManager] Failed to read saved auth file:', error);
      }
      return;
    }

    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('[AuthManager] Encryption not available, clearing unusable persisted state');
      await this.clearSavedAuth();
      return;
    }

    let decryptedString: string;
    try {
      decryptedString = safeStorage.decryptString(encryptedData);
    } catch {
      console.warn('[AuthManager] Failed to decrypt saved auth, clearing');
      await this.clearSavedAuth();
      return;
    }

    let authData: unknown;
    try {
      authData = JSON.parse(decryptedString);
    } catch {
      console.warn('[AuthManager] Corrupted saved auth data, clearing');
      await this.clearSavedAuth();
      return;
    }

    // Strictly validate StoredAuthData shape (no legacy compatibility)
    if (
      !authData ||
      typeof authData !== 'object' ||
      !('token' in authData) ||
      !('user' in authData) ||
      !('savedAt' in authData) ||
      typeof (authData as { savedAt: unknown }).savedAt !== 'number'
    ) {
      console.warn('[AuthManager] Invalid saved auth format, clearing');
      await this.clearSavedAuth();
      return;
    }

    const data = authData as { token: unknown; user: unknown; savedAt: number };

    // Validate token shape
    if (
      !data.token ||
      typeof data.token !== 'object' ||
      !('accessToken' in data.token) ||
      typeof (data.token as { accessToken: unknown }).accessToken !== 'string' ||
      !('expiresAtMs' in data.token) ||
      typeof (data.token as { expiresAtMs: unknown }).expiresAtMs !== 'number'
    ) {
      console.warn(
        '[AuthManager] Invalid saved token format (missing accessToken or expiresAtMs), clearing'
      );
      await this.clearSavedAuth();
      return;
    }

    const storedToken = data.token as StoredAuthToken;

    // Validate user shape (required fields for auth state)
    if (
      !data.user ||
      typeof data.user !== 'object' ||
      typeof (data.user as { id: unknown }).id !== 'string' ||
      typeof (data.user as { bnet_id: unknown }).bnet_id !== 'string' ||
      typeof (data.user as { battletag: unknown }).battletag !== 'string'
    ) {
      console.warn('[AuthManager] Invalid saved user format, clearing');
      await this.clearSavedAuth();
      return;
    }
    const user = data.user as UserInfo;

    // Decode exp from token (SSoT for expiry)
    const expMs = decodeJwtExpMs(storedToken.accessToken);
    if (!expMs) {
      console.warn('[AuthManager] Cannot decode exp from saved token, clearing');
      await this.clearSavedAuth();
      return;
    }

    // Validate expiresAtMs matches decoded exp (within leeway)
    if (Math.abs(storedToken.expiresAtMs - expMs) > EXPIRY_LEEWAY_MS) {
      console.warn('[AuthManager] Saved expiresAtMs does not match token exp, clearing');
      await this.clearSavedAuth();
      return;
    }

    // Check if token is expired (with leeway)
    const now = Date.now();
    if (expMs - EXPIRY_LEEWAY_MS <= now) {
      console.info('[AuthManager] Saved token expired, clearing');
      await this.clearSavedAuth();
      return;
    }

    // Restore authentication state
    this.currentToken = {
      accessToken: storedToken.accessToken,
      expiresAt: new Date(expMs),
    };
    if (storedToken.tokenType) this.currentToken.tokenType = storedToken.tokenType;
    if (storedToken.refreshToken) this.currentToken.refreshToken = storedToken.refreshToken;
    this.currentUser = user;

    // Reset rotation retry count for fresh session
    this.rotationRetryCount = 0;

    // Set up token rotation and expiry timer
    this.setupTokenRefresh();

    console.info('[AuthManager] Restored authentication from Windows Credential Manager');
    this.emit('auth-restored', { token: this.currentToken, user: this.currentUser });
  }

  /**
   * Clear saved authentication data
   */
  private async clearSavedAuth(): Promise<void> {
    try {
      const authFilePath = path.join(app.getPath('userData'), 'auth-data.enc');
      await fs.unlink(authFilePath);
    } catch (error: unknown) {
      const err = error as { code?: string };
      if (err.code !== 'ENOENT') {
        console.error('[AuthManager] Failed to clear saved auth:', error);
      }
    }
  }
}
