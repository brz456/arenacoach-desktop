import { EventEmitter } from 'events';
import axios, { AxiosResponse } from 'axios';
import { safeStorage, app, shell } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import http from 'http';
import { URL } from 'url';

export interface AuthConfig {
  apiBaseUrl: string;
  clientId: string;
  tokenRefreshEndpoint?: string;
  userInfoEndpoint?: string;
}

export interface AuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  tokenType?: string;
}

export interface UserInfo {
  id: string;
  bnet_id: string;
  battletag: string;
  is_admin?: boolean;
  is_skill_capped_verified?: boolean;
  created_at?: string;
}

export interface LoginResult {
  success: boolean;
  token?: AuthToken;
  user?: UserInfo;
  error?: string;
}

export class AuthManager extends EventEmitter {
  private config: AuthConfig;
  private currentToken: AuthToken | null = null;
  private currentUser: UserInfo | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private authInProgress = false;

  constructor(config: AuthConfig) {
    super();
    this.config = {
      tokenRefreshEndpoint: '/api/auth/refresh',
      userInfoEndpoint: '/api/auth/me',
      ...config,
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
        { callback_port: callbackPort }
      );

      if (!initResponse.data.success) {
        throw new Error(initResponse.data.message || 'Failed to initialize OAuth session');
      }

      const { desktop_session_id, auth_url } = initResponse.data;

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
        }
      );

      if (!exchangeResponse.data.success) {
        throw new Error(exchangeResponse.data.message || 'Token exchange failed');
      }

      const { token, user } = exchangeResponse.data;

      const authToken: AuthToken = {
        accessToken: token,
        tokenType: 'Bearer',
      };

      const result = await this.setAuthToken(authToken, user);
      await this.saveAuthData();

      return result;
    } catch (error: any) {
      this.emit('auth-error', error);
      return {
        success: false,
        error: error.message || 'Battle.net authentication failed',
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

      // Try ports starting from 12345, with fallback to system-assigned
      let port = 12345;
      const maxAttempts = 100;
      let attempts = 0;

      const tryListen = () => {
        server.listen(port, '127.0.0.1', () => {
          resolve(port);
        });

        server.on('error', (err: any) => {
          if (err.code === 'EADDRINUSE' && attempts < maxAttempts) {
            attempts++;
            port = Math.floor(Math.random() * (65535 - 1024) + 1024); // Random port in safe range
            server.removeAllListeners('error');
            tryListen();
          } else {
            reject(new Error(`Failed to start callback server: ${err.message}`));
          }
        });
      };

      tryListen();
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
        const url = new URL(req.url!, `http://${req.headers.host}`);

        if (url.pathname === '/callback') {
          const loginCode = url.searchParams.get('login_code');
          const error = url.searchParams.get('error');

          if (error) {
            // Send error response to browser
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(
              `
              <html>
                <head><title>Authentication Error</title></head>
                <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
                  <h2>Authentication Failed</h2>
                  <p>Error: ${error}</p>
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
   * Set authentication token and fetch user info
   */
  public async setAuthToken(token: AuthToken, user?: UserInfo): Promise<LoginResult> {
    this.currentToken = token;

    try {
      // Fetch user info if not provided
      if (!user) {
        user = await this.fetchUserInfo();
      }

      this.currentUser = user;

      // Setup token refresh if we have an expiration
      this.setupTokenRefresh();

      console.debug('[AuthManager] Emitting auth-success event with user:', user.battletag);
      this.emit('auth-success', { token, user });

      return {
        success: true,
        token,
        user,
      };
    } catch (error: any) {
      this.currentToken = null;
      this.currentUser = null;

      return {
        success: false,
        error: error.message || 'Failed to authenticate',
      };
    }
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
    return this.currentToken !== null && this.currentUser !== null;
  }

  /**
   * Check if token is expired or about to expire
   */
  public isTokenExpired(): boolean {
    if (!this.currentToken?.expiresAt) {
      return false; // No expiration info
    }

    // Consider token expired if it expires within 5 minutes
    const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);
    return this.currentToken.expiresAt <= fiveMinutesFromNow;
  }

  /**
   * Refresh authentication token
   */
  public async refreshToken(): Promise<LoginResult> {
    if (!this.currentToken?.refreshToken) {
      return {
        success: false,
        error: 'No refresh token available',
      };
    }

    try {
      const response: AxiosResponse = await axios.post(
        `${this.config.apiBaseUrl}${this.config.tokenRefreshEndpoint}`,
        {
          refresh_token: this.currentToken.refreshToken,
          client_id: this.config.clientId,
        }
      );

      if (response.status === 200) {
        const { access_token, refresh_token, expires_in } = response.data;

        const newToken: AuthToken = {
          accessToken: access_token,
          refreshToken: refresh_token || this.currentToken?.refreshToken,
          ...(expires_in ? { expiresAt: new Date(Date.now() + expires_in * 1000) } : {}),
          tokenType: 'Bearer',
        };

        this.currentToken = newToken;
        this.setupTokenRefresh();

        // Save updated token securely
        await this.saveAuthData();

        this.emit('token-refreshed', newToken);

        return {
          success: true,
          token: newToken,
          ...(this.currentUser ? { user: this.currentUser } : {}),
        };
      }

      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    } catch (error: any) {
      this.emit('token-refresh-failed', error);

      if (axios.isAxiosError(error)) {
        return {
          success: false,
          error: error.response?.data?.message || error.message,
        };
      }

      return {
        success: false,
        error: error.message || 'Token refresh failed',
      };
    }
  }

  /**
   * Logout and clear authentication
   */
  public async logout(): Promise<void> {
    // Clear refresh timer
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    // Optionally notify server of logout
    if (this.currentToken) {
      try {
        await axios.post(
          `${this.config.apiBaseUrl}/api/auth/logout-desktop`,
          {},
          {
            headers: {
              Authorization: `Bearer ${this.currentToken.accessToken}`,
            },
          }
        );
      } catch (error) {
        console.warn(
          '[AuthManager] Failed to notify server of logout. Client-side logout will proceed.',
          { error }
        );
      }
    }

    this.currentToken = null;
    this.currentUser = null;

    // Clear saved authentication
    await this.clearSavedAuth();

    this.emit('logout');
  }

  /**
   * Fetch user information
   */
  private async fetchUserInfo(): Promise<UserInfo> {
    if (!this.currentToken) {
      throw new Error('No authentication token available');
    }

    const response: AxiosResponse = await axios.get(
      `${this.config.apiBaseUrl}${this.config.userInfoEndpoint}`,
      {
        headers: {
          Authorization: `Bearer ${this.currentToken.accessToken}`,
        },
      }
    );

    if (response.status === 200) {
      return response.data;
    }

    throw new Error(`Failed to fetch user info: HTTP ${response.status}`);
  }

  /**
   * Setup automatic token refresh
   */
  private setupTokenRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    if (!this.currentToken?.expiresAt) {
      return; // No expiration info
    }

    // Refresh token 5 minutes before expiration
    const refreshTime = this.currentToken.expiresAt.getTime() - Date.now() - 5 * 60 * 1000;

    if (refreshTime > 0) {
      this.refreshTimer = setTimeout(async () => {
        try {
          await this.refreshToken();
        } catch (error) {
          console.error('Automatic token refresh failed:', error);
          this.emit('auth-error', error);
        }
      }, refreshTime);
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
   * Save authentication data securely using Windows Credential Manager (via Electron safeStorage)
   */
  private async saveAuthData(): Promise<void> {
    if (!this.currentToken || !this.currentUser) {
      return;
    }

    try {
      const authData = {
        token: this.currentToken,
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
      }
    } catch (error) {
      console.error('[AuthManager] Failed to save auth data:', error);
    }
  }

  /**
   * Load saved authentication data from Windows Credential Manager
   */
  private async loadSavedAuth(): Promise<void> {
    try {
      const authFilePath = path.join(app.getPath('userData'), 'auth-data.enc');

      try {
        const encryptedData = await fs.readFile(authFilePath);

        if (safeStorage.isEncryptionAvailable()) {
          const decryptedString = safeStorage.decryptString(encryptedData);
          let authData;

          try {
            authData = JSON.parse(decryptedString);
          } catch (parseError) {
            console.warn(
              '[AuthManager] Corrupted saved auth data detected, clearing and requiring fresh login'
            );
            await this.clearSavedAuth();
            return;
          }

          // Validate saved data (security check)
          if (!authData.token || !authData.user || !authData.savedAt) {
            console.warn('[AuthManager] Invalid saved auth data format');
            return;
          }

          // Check if data is too old (1 year - Windows gaming app standard)
          const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
          if (authData.savedAt < oneYearAgo) {
            console.info(
              '[AuthManager] Saved auth data expired after 1 year, requiring fresh login'
            );
            await this.clearSavedAuth();
            return;
          }

          // Restore authentication state
          this.currentToken = authData.token;
          this.currentUser = authData.user;

          // Set up token refresh
          this.setupTokenRefresh();

          console.info('[AuthManager] Restored authentication from Windows Credential Manager');
          this.emit('auth-restored', { token: this.currentToken, user: this.currentUser });
        }
      } catch (error: any) {
        if (error.code !== 'ENOENT') {
          console.error('[AuthManager] Failed to load saved auth:', error);
        }
      }
    } catch (error) {
      console.error('[AuthManager] Error during auth restoration:', error);
    }
  }

  /**
   * Clear saved authentication data
   */
  private async clearSavedAuth(): Promise<void> {
    try {
      const authFilePath = path.join(app.getPath('userData'), 'auth-data.enc');
      await fs.unlink(authFilePath);
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        console.error('[AuthManager] Failed to clear saved auth:', error);
      }
    }
  }
}
