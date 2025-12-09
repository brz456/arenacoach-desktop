import { app, BrowserWindow, ipcMain, dialog, Menu, shell, Tray, powerMonitor } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

// Route all main-process console output through electron-log for persistent logging
const consoleLevels: Array<'log' | 'info' | 'warn' | 'error' | 'debug'> = [
  'log',
  'info',
  'warn',
  'error',
  'debug',
];

for (const level of consoleLevels) {
  const logLevel = level === 'log' ? 'info' : level;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (console as any)[level] = (...args: any[]) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (log as any)[logLevel](...args);
  };
}

log.info('[ArenaCoachDesktop] Main process starting', {
  version: app.getVersion(),
  nodeEnv: process.env.NODE_ENV,
});
import {
  WoWInstallationDetector,
  WoWInstallation,
  AddonManager,
  AddonInstallationResult,
} from './wowInstallation';
import { AuthManager, AuthConfig, AuthToken, UserInfo } from './authManager';
import {
  MatchDetectionService,
  MatchDetectionServiceConfig,
} from './services/MatchDetectionService';
import {
  MetadataStorageService,
  MetadataStorageServiceConfig,
} from './services/MetadataStorageService';
import { MetadataService } from './services/MetadataService';
import { MatchLifecycleService } from './services/MatchLifecycleService';
import { RecordingService, RecordingServiceConfig } from './services/RecordingService';
import { AnalysisEnrichmentService, AnalysisPayload } from './services/AnalysisEnrichmentService';
import { SettingsService, AppSettings } from './services/SettingsService';
import {
  Resolution,
  RESOLUTION_DIMENSIONS,
  QUALITY_BITRATE_KBPS_MAP,
  RecordingSettings,
  UNSAFE_RECORDING_SETTINGS,
  RecordingQuality,
  CaptureMode,
  EncoderType,
} from './services/RecordingTypes';
import { ChunkCleanupService } from './services/ChunkCleanupService';
import { ApiHeadersProvider } from './services/ApiHeadersProvider';
import { UploadService } from './services/UploadService';
import { JobStateStore } from './services/JobStateStore';
import { ServiceHealthCheck } from './services/ServiceHealthCheck';
import { JobQueueOrchestrator } from './match-detection/pipeline/JobQueueOrchestrator';
import {
  CompletionPollingService,
  CompletionPollingConfig,
} from './services/CompletionPollingService';
import { UploadStatus, RecordingStatusType } from './match-detection/types/StoredMatchTypes';
import {
  MatchStartedEvent,
  MatchEndedEvent,
  MatchEventType,
} from './match-detection/types/MatchEvent';
import type { MatchEndedIncompleteEvent } from './match-detection/types/MatchEvent';
import { EarlyEndTrigger, getTriggerMessage } from './match-detection/types/EarlyEndTriggers';
import { isCombatLogExpiredError } from './match-detection/types/PipelineErrors';
import { MatchProcessedPayload } from './match-detection/MatchDetectionOrchestrator';
import {
  WoWProcessMonitorError,
  getErrorDetails,
} from './process-monitoring/WoWProcessMonitorErrors';
import { ExpirationConfig } from './config/ExpirationConfig';
import { FreemiumQuotaFields } from './Freemium';

// Event payload interfaces for improved type safety
interface AnalysisJobCreatedPayload {
  jobId: string;
  matchHash: string;
  status: string;
}

interface AnalysisProgressPayload {
  jobId: string;
  status: string;
  matchHash: string;
  message?: string;
  queuePosition?: number | null;
  totalInQueue?: number | null;
}

interface AnalysisCompletedPayload extends FreemiumQuotaFields {
  jobId: string;
  analysisId?: string; // Optional string - normalized at boundary, undefined for non-auth users
  matchHash: string;
  analysisPayload?: AnalysisPayload; // Optional - only present for entitled users (premium or freemium)
  isSkillCappedViewer?: boolean;
}

interface AnalysisFailedPayload {
  jobId: string;
  matchHash: string;
  error?: string;
  isNotFound?: boolean;
  originalName?: string;
  errorCode?: string;
  isPermanent?: boolean;
}

interface AnalysisTimeoutPayload {
  jobId: string;
  matchHash: string;
  attempts?: number;
}

interface JobRetryPayload {
  matchHash: string;
  attempt: number;
  delayMs: number;
  errorType: string;
}

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

// Set the app name for userData directory (changes %APPDATA%/Electron to %APPDATA%/arenacoach-desktop)
app.setName('arenacoach-desktop');

function validateFilePath(filePath: unknown): string {
  if (typeof filePath !== 'string') {
    throw new Error('Invalid input: file path must be a string');
  }

  if (filePath.length === 0 || filePath.length > 1000) {
    throw new Error('Invalid input: file path must be 1-1000 characters');
  }

  // Prevent path traversal attacks
  const normalizedPath = path.normalize(filePath);
  if (normalizedPath.includes('..') || normalizedPath.includes('\x00')) {
    throw new Error('Invalid input: path traversal attempts detected');
  }

  // Ensure path is absolute (safer for file operations)
  if (!path.isAbsolute(normalizedPath)) {
    throw new Error('Invalid input: path must be absolute');
  }

  return normalizedPath;
}

class ArenaCoachDesktop {
  // Configuration constants
  private static readonly EXPIRATION_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
  private static readonly WINDOW_READY_TIMEOUT_MS = 30000; // 30 second timeout
  private static readonly WINDOW_READY_POLL_INTERVAL_MS = 100; // 100ms polling interval
  private static readonly POLLING_INTERVAL_MS = 5000; // 5 seconds for job polling
  private static readonly SERVICE_STATUS_INTERVAL_MS = 5000; // 5 seconds for service status updates
  private static readonly UPLOAD_ENDPOINT = '/api/upload';
  private static readonly JOB_STATUS_ENDPOINT = '/api/upload/job-status';
  private static readonly IDLE_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes for idle health checks

  // Recording constants - matches OBS recorder default
  private static readonly DEFAULT_RECORDING_SUBDIR = 'ArenaCoach/Recordings';

  private mainWindow: BrowserWindow | null = null;
  private tray: Tray | null = null;
  private isQuitting = false; // Flag to control window close behavior
  private isDevelopment = !app.isPackaged;
  private isUIDevMode = process.env.UI_DEV_MODE === 'true';
  private authManager: AuthManager;
  private matchDetectionService: MatchDetectionService;
  private recordingService: RecordingService | null = null;
  private metadataStorageService!: MetadataStorageService;
  private metadataService!: MetadataService;
  private matchLifecycleService?: MatchLifecycleService;
  private analysisEnrichmentService!: AnalysisEnrichmentService;
  private settingsService: SettingsService;
  private chunkCleanupService: ChunkCleanupService;

  // New decomposed services
  private apiHeadersProvider!: ApiHeadersProvider;
  private uploadService!: UploadService;
  private jobStateStore!: JobStateStore;
  private completionPollingService!: CompletionPollingService;
  private jobQueueOrchestrator!: JobQueueOrchestrator;
  private serviceHealthCheck!: ServiceHealthCheck;
  private apiBaseUrl: string;
  private idleCheckTimer: NodeJS.Timeout | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;

  // Track ongoing metadata finalizations to prevent race conditions
  private ongoingFinalizations = new Map<string, Promise<void>>();

  // Per-buffer lifecycle serialization: ensures match lifecycle operations
  // (start, end, endIncomplete) run sequentially per bufferId
  private bufferQueues = new Map<string, Promise<void>>();
  private updateIntervalId: NodeJS.Timeout | null = null;
  private expirationTimerId: NodeJS.Timeout | null = null;
  private serviceStatusTimerId: NodeJS.Timeout | null = null;
  private isCheckingExpiration = false;
  private windowBoundsDebounceTimer: NodeJS.Timeout | null = null;
  // Recording recovery state
  private isRecoveringRecording: boolean = false;
  private lastRecordingRecoveryAt: number = 0;

  // WoW installation status tracking for addon sync
  private latestWoWInstallations: WoWInstallation[] = [];

  /**
   * Apply auto-launch setting for Windows startup
   */
  private applyAutoLaunchSetting(enable: boolean): void {
    // Platform guard - only apply on Windows
    if (process.platform !== 'win32') {
      console.debug('[ArenaCoachDesktop] Auto-launch setting skipped - not Windows platform');
      return;
    }

    try {
      app.setLoginItemSettings({ openAtLogin: enable });
      console.info(`[ArenaCoachDesktop] Auto-launch setting applied: ${enable}`);

      // Optional diagnostic - log actual state after applying
      const loginSettings = app.getLoginItemSettings();
      console.debug(
        '[ArenaCoachDesktop] Login item settings after apply:',
        loginSettings.openAtLogin
      );
    } catch (error) {
      console.error('[ArenaCoachDesktop] Failed to apply auto-launch setting:', error);
    }
  }

  /**
   * Notify renderer of current addon installation status
   * @param installations - Optional fresh snapshot; if omitted, uses cached latestWoWInstallations
   */
  private notifyAddonStatusToRenderer(installations?: WoWInstallation[]): void {
    try {
      if (installations) {
        this.latestWoWInstallations = installations;
      }

      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('addon:statusUpdated', this.latestWoWInstallations);
      }
    } catch (error) {
      console.error('[ArenaCoachDesktop] Failed to notify addon status to renderer:', error);
    }
  }

  /**
   * Resolve WoW installations using persisted user path combined with default paths
   * SSoT resolver: all WoW-dependent flows must use this method
   * Updates latestWoWInstallations cache before returning
   */
  private async resolveWoWInstallations(): Promise<WoWInstallation[]> {
    const userPath = this.settingsService.getWoWInstallationPath();
    const userPaths = userPath ? [userPath] : [];

    const installations = await WoWInstallationDetector.detectInstallationsWithOverrides(userPaths);

    console.info('[ArenaCoachDesktop] resolveWoWInstallations:', {
      totalInstallations: installations.length,
      userPathUsed: !!userPath,
      userPath: userPath ?? '(none)',
    });

    this.latestWoWInstallations = installations;
    return installations;
  }

  constructor() {
    // Store API base URL for reuse
    this.apiBaseUrl =
      process.env.API_BASE_URL ||
      (this.isDevelopment ? 'http://127.0.0.1:3001' : 'https://arenacoach.gg');

    // Log UI dev mode status
    if (this.isUIDevMode) {
      console.info('🚀 ArenaCoach Desktop - UI Development Mode');
      console.info('   - WoW Process Monitoring: DISABLED');
      console.info('   - Auto-updater: DISABLED');
      console.info('   - Match Detection: DISABLED');
      console.info('   - Fast UI iteration mode: ENABLED');
    }

    // Initialize auth manager
    const authConfig: AuthConfig = {
      apiBaseUrl: this.apiBaseUrl,
      clientId: 'arenacoach-desktop-app',
    };
    this.authManager = new AuthManager(authConfig);

    // Initialize settings service FIRST (needed for matchDetectionConfig)
    this.settingsService = new SettingsService();

    // Initialize match detection service (replaces old CombatLogWatcher)
    const matchDetectionConfig: MatchDetectionServiceConfig = {
      apiBaseUrl: this.apiBaseUrl,
      enableWoWProcessMonitoring: !this.isUIDevMode,
    };
    this.matchDetectionService = new MatchDetectionService(matchDetectionConfig);

    // Recording service will be initialized later after metadata service is ready
    // Only enable on Windows and when not in UI dev mode
    if (!this.isUIDevMode && process.platform === 'win32') {
      // Just mark that we should initialize recording service later
      this.recordingService = null; // Will be created in initializeMatchMetadataServices (called from initializeAsyncServices)
    }

    // Initialize chunk cleanup service for managing chunk files
    this.chunkCleanupService = new ChunkCleanupService();

    // Setup non-async services immediately
    this.setupApp();
    this.setupAutoUpdater();
    this.setupCoreIPC(); // Only register IPC handlers that don't depend on async services
    this.setupAuthentication();
    this.registerPowerMonitorHooks();
  }

  private registerPowerMonitorHooks(): void {
    try {
      powerMonitor.on('suspend', () => {
        console.info('[Main] System suspend detected');
        try {
          // Hide preview to avoid stale native window during sleep
          if (this.recordingService) {
            this.recordingService.hidePreview();
          }
        } catch (e) {
          console.warn('[Main] Failed to hide preview on suspend:', e);
        }
      });

      powerMonitor.on('resume', async () => {
        console.info('[Main] System resume detected');
        // Attempt a light-weight recovery of OBS if needed
        try {
          await this.recoverRecordingService('resume');
        } catch (e) {
          console.error('[Main] Recovery after resume failed:', e);
        }
      });
    } catch (e) {
      console.warn('[Main] Power monitor hooks not available:', e);
    }
  }

  private async recoverRecordingService(reason: 'resume' | 'error'): Promise<void> {
    if (!this.recordingService) return;
    if (this.isRecoveringRecording) return;
    if (this.isQuitting) return; // do nothing while quitting
    // Debounce to once per 60s
    const now = Date.now();
    if (now - this.lastRecordingRecoveryAt < 60000) return;

    this.isRecoveringRecording = true;
    this.lastRecordingRecoveryAt = now;
    console.info(`[Main] Recovering recording service due to ${reason}...`);

    try {
      const status = await this.recordingService.getStatus();
      // If actively recording, perform only a soft refresh to avoid disruption
      if (status.isRecording) {
        await this.applyPersistedRecordingSettings();
        console.info('[Main] Soft-refreshed recording settings during active recording');
      } else if (!status.isInitialized) {
        await this.recordingService.initialize();
        if (this.mainWindow) {
          this.recordingService.setMainWindow(this.mainWindow);
        }
        await this.applyPersistedRecordingSettings();
        console.info('[Main] Recording service reinitialized');
      } else {
        // Soft-refresh settings to ensure sources are valid after resume
        await this.applyPersistedRecordingSettings();
      }
    } catch (e) {
      console.warn('[Main] Soft recovery failed, considering full restart...', e);
      try {
        // Only attempt full restart if not recording to avoid disruption
        const status = await this.recordingService.getStatus();
        if (!status.isRecording) {
          await this.recordingService.shutdown();
          await this.recordingService.initialize();
          if (this.mainWindow) {
            this.recordingService.setMainWindow(this.mainWindow);
          }
          await this.applyPersistedRecordingSettings();
          console.info('[Main] Recording service fully restarted');
        } else {
          console.info('[Main] Skipping restart while recording; will rely on soft refresh');
        }
      } catch (e2) {
        console.error('[Main] Full recording service restart failed:', e2);
      }
    } finally {
      this.isRecoveringRecording = false;
    }
  }

  private setupApp(): void {
    // This method will be called when Electron has finished initialization
    app.whenReady().then(async () => {
      // STEP 0: Initialize auth-dependent headers provider BEFORE auth events can fire
      // This ensures early consumers (e.g., Skill Capped status check) have a headers provider
      const existingToken = this.authManager.getAuthToken();
      this.apiHeadersProvider = new ApiHeadersProvider(existingToken?.accessToken);

      // Initialize auth manager after app is ready (may emit auth-restored)
      await this.authManager.initialize();

      // Remove native menu bar (File, Edit, View, Window, Help)
      Menu.setApplicationMenu(null);

      // Apply startup setting from stored settings
      const settings = this.settingsService.getSettings();
      if (settings.runOnStartup !== undefined) {
        this.applyAutoLaunchSetting(settings.runOnStartup === true);
      }

      this.createMainWindow();

      // Initialize all async services BEFORE loading the renderer to avoid IPC races
      // (matches:list, quota:getStatus handlers must exist before renderer calls them)
      await this.initializeAsyncServices();

      // NOW load the renderer HTML - IPC handlers are guaranteed to be registered
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        const htmlPath = path.join(__dirname, '../assets/index.html');
        this.mainWindow.loadFile(htmlPath).catch(error => {
          console.error('Failed to load application:', error);
        });
      }

      // Ensure renderer is fully loaded, then push an accurate initial service status
      await this.waitForMainWindowReady();
      this.notifyAddonStatusToRenderer();
      this.sendServiceStatus();

      // Now it is safe to show the main window (preview services ready, UI state accurate)
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.show();
        if (this.isDevelopment) {
          this.mainWindow.webContents.openDevTools();
        }
        console.info('[Main] Window shown after services initialized');
      }
    });

    // Quit when all windows are closed (except on macOS where apps typically stay running)
    app.on('window-all-closed', () => {
      // On Windows/Linux, keep running in system tray instead of quitting
      if (process.platform === 'darwin') {
        app.quit();
      }
      // On other platforms, the app continues running in the system tray
    });

    // Security: Prevent navigation to external URLs
    app.on('web-contents-created', (_event, contents) => {
      contents.on('will-navigate', (navigationEvent, navigationUrl) => {
        const parsedUrl = new URL(navigationUrl);

        const allowedOrigins = ['https://arenacoach.gg'];
        if (this.isDevelopment) {
          allowedOrigins.push('http://127.0.0.1:3001');
        }

        if (!allowedOrigins.includes(parsedUrl.origin)) {
          navigationEvent.preventDefault();
        }
      });
    });
  }

  private setupAutoUpdater(): void {
    // Skip auto-updater in UI dev mode
    if (this.isUIDevMode) {
      console.info('⚡ Auto-updater disabled in UI dev mode');
      return;
    }

    // Configure auto-updater
    autoUpdater.logger = log;

    // Check for updates after app is ready (production only)
    if (!this.isDevelopment) {
      app.whenReady().then(() => {
        // Check for updates after main window is ready and services initialized
        this.waitForMainWindowReady().then(() => {
          // Check immediately for downloaded updates, then check for new ones
          this.checkUpdateState();
        });
      });

      // Check for updates every 4 hours
      this.updateIntervalId = setInterval(
        () => {
          autoUpdater.checkForUpdatesAndNotify();
        },
        4 * 60 * 60 * 1000
      );
    }

    // Auto-updater event handlers
    autoUpdater.on('checking-for-update', () => {
      console.info('Checking for update...');
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('updater:checking-for-update');
      }
    });

    autoUpdater.on('update-available', info => {
      console.info('Update available:', info);
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('updater:updateAvailable', info.version);
      }
    });

    autoUpdater.on('update-not-available', info => {
      console.info('Update not available:', info);
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('updater:update-not-available', info);
      }
    });

    autoUpdater.on('error', err => {
      console.error('Auto-updater error:', err);
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('updater:error', err.message);
      }
    });

    autoUpdater.on('download-progress', progressObj => {
      let logMessage = `Download speed: ${progressObj.bytesPerSecond}`;
      logMessage += ` - Downloaded ${progressObj.percent}%`;
      logMessage += ` (${progressObj.transferred}/${progressObj.total})`;
      console.info(logMessage);

      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('updater:download-progress', progressObj);
      }
    });

    autoUpdater.on('update-downloaded', info => {
      console.info('Update downloaded:', info);
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('updater:updateDownloaded');
      }

      // Notify user that update is ready, let them choose when to restart
      console.info('Update downloaded - user can restart when ready');
    });
  }

  private async checkUpdateState(): Promise<void> {
    try {
      // Check if update is already downloaded and ready
      // If so, show banner immediately; otherwise check for new updates
      const result = await autoUpdater.checkForUpdatesAndNotify();

      // Note: autoUpdater.checkForUpdatesAndNotify() will trigger the appropriate events:
      // - If update already downloaded: 'update-downloaded' event fires
      // - If new update available: 'update-available' -> download -> 'update-downloaded'
      // - If no updates: 'update-not-available' event fires

      console.info('Update check completed:', result);
    } catch (error) {
      console.error('Update check failed:', error);
      // Silent failure - don't interrupt user experience
    }
  }

  private createMainWindow(): void {
    // Get saved window bounds
    const savedBounds = this.settingsService.getWindowBounds();

    // Create the browser window (Windows frameless)
    this.mainWindow = new BrowserWindow({
      ...savedBounds, // Use saved position and size
      minWidth: 1400,
      minHeight: 900, // Minimum height requirement
      width: 1650, // Default width for 4-column layout
      height: 1000, // Default height for optimal 4-row card layout
      frame: false, // Remove native Windows frame and title bar
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
      },
      icon: path.join(__dirname, '../assets/favicon.ico'),
      title: 'ArenaCoach Desktop App',
      show: false, // Don't show until ready
    });

    // NOTE: loadFile() is NOT called here. Page loading is deferred until after
    // initializeAsyncServices() completes in setupApp(), ensuring all IPC handlers
    // (matches:list, quota:getStatus, etc.) are registered before the renderer runs.

    // Save window bounds when moved or resized (debounced)
    this.mainWindow.on('moved', () => {
      this.debouncedSaveWindowBounds();
    });

    this.mainWindow.on('resized', () => {
      this.debouncedSaveWindowBounds();
    });

    // Handle window close - minimize to tray instead of quit
    this.mainWindow.on('close', event => {
      if (!this.isQuitting) {
        event.preventDefault();
        this.mainWindow?.hide();
      }
    });

    // Handle window closed (when actually destroyed)
    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
      // Stop idle checks
      if (this.idleCheckTimer) {
        clearInterval(this.idleCheckTimer);
        this.idleCheckTimer = null;
      }
    });

    // Create system tray
    this.createSystemTray();
  }

  /**
   * Create system tray with context menu
   */
  private createSystemTray(): void {
    try {
      // Use favicon.ico for the tray icon
      const trayIconPath = path.join(__dirname, '../assets/favicon.ico');
      this.tray = new Tray(trayIconPath);

      // Set tooltip
      this.tray.setToolTip('ArenaCoach Desktop App');

      // Create context menu
      const contextMenu = Menu.buildFromTemplate([
        {
          label: 'Open ArenaCoach',
          click: () => {
            this.showWindow();
          },
        },
        {
          type: 'separator',
        },
        {
          label: 'Settings',
          click: () => {
            this.showWindow();
            // Send message to renderer to switch to settings view
            this.mainWindow?.webContents.send('navigate-to-view', 'settings');
          },
        },
        {
          label: 'Scene',
          click: () => {
            this.showWindow();
            // Send message to renderer to switch to scene view
            this.mainWindow?.webContents.send('navigate-to-view', 'scene');
          },
        },
        {
          type: 'separator',
        },
        {
          label: 'Exit',
          click: () => {
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
              this.mainWindow.hide();
            }
            app.quit();
          },
        },
      ]);

      this.tray.setContextMenu(contextMenu);

      // Single-click to show window
      this.tray.on('click', () => {
        this.showWindow();
      });
    } catch (error) {
      console.error('Failed to create system tray:', error);
    }
  }

  /**
   * Show and focus the main window
   */
  private showWindow(): void {
    if (this.mainWindow) {
      if (this.mainWindow.isMinimized()) {
        this.mainWindow.restore();
      }
      this.mainWindow.show();
      this.mainWindow.focus();
    }
  }

  /**
   * Handle a second-instance launch attempt.
   * Called from the module-level 'second-instance' event handler.
   * Restores and focuses the existing window if present; no-op otherwise.
   */
  public handleSecondInstance(_commandLine: string[], _workingDirectory: string): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.showWindow();
    } else {
      log.info('[ArenaCoachDesktop] Second instance event received before main window ready');
    }
  }

  /**
   * Save current window bounds to settings (debounced to prevent excessive disk writes)
   */
  private debouncedSaveWindowBounds(): void {
    // Clear existing timer
    if (this.windowBoundsDebounceTimer) {
      clearTimeout(this.windowBoundsDebounceTimer);
    }

    // Set new timer for 300ms debounce
    this.windowBoundsDebounceTimer = setTimeout(() => {
      this.saveWindowBounds();
      this.windowBoundsDebounceTimer = null;
    }, 300);
  }

  private async waitForMainWindowReady(): Promise<void> {
    return new Promise(resolve => {
      const startTime = Date.now();
      const timeoutMs = ArenaCoachDesktop.WINDOW_READY_TIMEOUT_MS;

      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        // Wait for window to be fully shown and services initialized
        const checkReady = () => {
          if (Date.now() - startTime > timeoutMs) {
            console.warn('[ArenaCoachDesktop] waitForMainWindowReady timed out after 30s');
            return resolve();
          }
          if (this.mainWindow && this.mainWindow.webContents.isLoading()) {
            setTimeout(checkReady, ArenaCoachDesktop.WINDOW_READY_POLL_INTERVAL_MS);
          } else {
            resolve();
          }
        };
        checkReady();
      } else {
        // Fallback: wait for window to be created
        const checkWindow = () => {
          if (Date.now() - startTime > timeoutMs) {
            console.warn(
              '[ArenaCoachDesktop] waitForMainWindowReady window creation timed out after 30s'
            );
            return resolve();
          }
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            setTimeout(() => resolve(), 1000);
          } else {
            setTimeout(checkWindow, ArenaCoachDesktop.WINDOW_READY_POLL_INTERVAL_MS);
          }
        };
        checkWindow();
      }
    });
  }

  private saveWindowBounds(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    const bounds = this.mainWindow.getBounds();
    this.settingsService.saveWindowBounds(bounds);
  }

  /**
   * Apply persisted recording settings to the recording service
   * Centralizes the logic for applying saved settings, avoiding code duplication
   */
  private async applyPersistedRecordingSettings(): Promise<void> {
    if (!this.recordingService) {
      console.warn(
        '[ArenaCoachDesktop] Cannot apply recording settings: RecordingService not initialized'
      );
      return;
    }

    try {
      const saved = this.settingsService.getSettings().recording;
      const settings: Partial<RecordingSettings> = {
        captureMode: saved.captureMode,
        captureCursor: saved.captureCursor,
        desktopAudioEnabled: saved.desktopAudioEnabled,
        desktopAudioDevice: saved.desktopAudioDevice,
        microphoneAudioEnabled: saved.microphoneAudioEnabled,
        microphoneDevice: saved.microphoneDevice,
        audioSuppressionEnabled: saved.audioSuppressionEnabled,
        forceMonoInput: saved.forceMonoInput,
      };

      // Only include monitorId if it's defined
      if (saved.monitorId !== undefined) {
        settings.monitorId = saved.monitorId;
      }

      await this.recordingService.applyRecordingSettings(settings);
      console.info('[ArenaCoachDesktop] Applied persisted recording settings');
    } catch (error) {
      console.error('[ArenaCoachDesktop] Failed to apply persisted recording settings:', error);
    }
  }

  /**
   * Validate and sanitize recording settings from untrusted input
   */
  private validateRecordingSettings(updates: any): Partial<RecordingSettings> {
    const validated: Partial<RecordingSettings> = {};

    // Validate capture mode
    if (updates.captureMode !== undefined) {
      if (Object.values(CaptureMode).includes(updates.captureMode)) {
        validated.captureMode = updates.captureMode;
      }
    }

    // Validate resolution
    if (updates.resolution !== undefined) {
      const validResolutions = Object.keys(RESOLUTION_DIMENSIONS) as Resolution[];
      if (validResolutions.includes(updates.resolution)) {
        validated.resolution = updates.resolution;
      }
    }

    // Validate FPS
    if (updates.fps !== undefined) {
      const fps = Number(updates.fps);
      if (fps === 30 || fps === 60) {
        validated.fps = fps as 30 | 60;
      }
    }

    // Validate quality
    if (updates.quality !== undefined) {
      if (Object.values(RecordingQuality).includes(updates.quality)) {
        validated.quality = updates.quality;
      }
    }

    // Validate encoder
    if (updates.encoder !== undefined) {
      const isValidEncoder = (value: unknown): value is EncoderType => {
        return (
          typeof value === 'string' && (value === 'nvenc' || value === 'amd' || value === 'x264')
        );
      };
      if (isValidEncoder(updates.encoder)) {
        validated.encoder = updates.encoder;
      }
    }

    // Validate boolean settings
    if (typeof updates.desktopAudioEnabled === 'boolean') {
      validated.desktopAudioEnabled = updates.desktopAudioEnabled;
    }

    if (typeof updates.microphoneAudioEnabled === 'boolean') {
      validated.microphoneAudioEnabled = updates.microphoneAudioEnabled;
    }

    if (typeof updates.captureCursor === 'boolean') {
      validated.captureCursor = updates.captureCursor;
    }

    if (typeof updates.audioSuppressionEnabled === 'boolean') {
      validated.audioSuppressionEnabled = updates.audioSuppressionEnabled;
    }

    if (typeof updates.forceMonoInput === 'boolean') {
      validated.forceMonoInput = updates.forceMonoInput;
    }

    // Validate device strings (basic validation - ensure they're strings)
    if (typeof updates.desktopAudioDevice === 'string' && updates.desktopAudioDevice.length > 0) {
      validated.desktopAudioDevice = updates.desktopAudioDevice;
    }

    if (typeof updates.microphoneDevice === 'string' && updates.microphoneDevice.length > 0) {
      validated.microphoneDevice = updates.microphoneDevice;
    }

    // Validate monitor ID (non-empty string only)
    if (updates.monitorId !== undefined) {
      if (typeof updates.monitorId === 'string' && updates.monitorId.trim().length > 0) {
        validated.monitorId = updates.monitorId.trim();
      }
      // Empty string or whitespace is ignored - keeps previous selection
    }

    return validated;
  }

  /**
   * Setup IPC handlers that don't depend on async services
   * These can be registered immediately in the constructor
   */
  private setupCoreIPC(): void {
    // Window control handlers for frameless window
    ipcMain.handle('window:minimize', () => {
      if (!this.mainWindow || this.mainWindow.isDestroyed()) {
        throw new Error('Main window not available');
      }
      this.mainWindow.minimize();
    });

    ipcMain.handle('window:maximize', () => {
      if (!this.mainWindow || this.mainWindow.isDestroyed()) {
        throw new Error('Main window not available');
      }
      if (this.mainWindow.isMaximized()) {
        this.mainWindow.unmaximize();
      } else {
        this.mainWindow.maximize();
      }
    });

    ipcMain.handle('window:close', () => {
      if (!this.mainWindow || this.mainWindow.isDestroyed()) {
        throw new Error('Main window not available');
      }
      this.mainWindow.close();
    });

    ipcMain.handle('window:isMaximized', () => {
      if (!this.mainWindow || this.mainWindow.isDestroyed()) {
        return false;
      }
      return this.mainWindow.isMaximized();
    });

    ipcMain.handle('window:openExternal', async (_event, url: string) => {
      try {
        // Validate URL format
        const parsedUrl = new URL(url);

        // Only allow HTTP and HTTPS protocols for security
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
          throw new Error(`Unsafe protocol: ${parsedUrl.protocol}`);
        }

        await shell.openExternal(url);
        return { success: true };
      } catch (error) {
        console.error('Failed to open external URL:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    });

    // App information handlers
    ipcMain.handle('app:getVersion', () => {
      return app.getVersion();
    });

    ipcMain.handle('app:getEnvironment', () => {
      return {
        isDevelopment: this.isDevelopment,
      };
    });

    // WoW installation handlers
    ipcMain.handle('wow:detectInstallations', async (): Promise<WoWInstallation[]> => {
      try {
        // Return mock data in UI dev mode
        if (this.isUIDevMode) {
          const mockData = [
            {
              path: '/mock/world-of-warcraft',
              version: 'retail' as const,
              combatLogPath: '/mock/world-of-warcraft/Logs',
              addonsPath: '/mock/world-of-warcraft/Interface/AddOns',
              addonInstalled: true,
              arenaCoachAddonPath: '/mock/world-of-warcraft/Interface/AddOns/ArenaCoach',
            },
          ];
          this.latestWoWInstallations = mockData;
          return mockData;
        }
        return await this.resolveWoWInstallations();
      } catch (error) {
        console.error('Error detecting WoW installations:', error);
        return [];
      }
    });

    ipcMain.handle(
      'wow:validateInstallation',
      async (_event, installPath: unknown): Promise<WoWInstallation | null> => {
        try {
          // Return mock data in UI dev mode (don't persist mock paths)
          if (this.isUIDevMode) {
            return {
              path: '/mock/world-of-warcraft',
              version: 'retail' as const,
              combatLogPath: '/mock/world-of-warcraft/Logs',
              addonsPath: '/mock/world-of-warcraft/Interface/AddOns',
              addonInstalled: true,
              arenaCoachAddonPath: '/mock/world-of-warcraft/Interface/AddOns/ArenaCoach',
            };
          }
          const validPath = validateFilePath(installPath);
          const installation = await WoWInstallationDetector.validateInstallation(validPath);

          // Persist validated path to settings and refresh installation list
          if (installation !== null) {
            this.settingsService.setWoWInstallationPath(installation.path);
            console.info(`[ArenaCoachDesktop] Persisted validated WoW path: ${installation.path}`);

            // Re-resolve installations and notify renderer to keep UI in sync
            const updated = await this.resolveWoWInstallations();
            this.notifyAddonStatusToRenderer(updated);
          }

          return installation;
        } catch (error) {
          console.error('Error validating WoW installation:', error);
          return null;
        }
      }
    );

    ipcMain.handle('wow:browseInstallation', async (): Promise<string | null> => {
      try {
        if (!this.mainWindow) {
          throw new Error('Main window not available');
        }

        const result = await dialog.showOpenDialog(this.mainWindow, {
          title: 'Select World of Warcraft Installation Folder',
          properties: ['openDirectory'],
          message: 'Select the main World of Warcraft installation directory (contains Wow.exe)',
        });

        if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
          return null;
        }

        return result.filePaths[0] || null;
      } catch (error) {
        console.error('Error opening WoW installation browser:', error);
        return null;
      }
    });

    // Addon management handlers
    ipcMain.handle(
      'addon:checkInstallation',
      async (_event, installationData: unknown): Promise<boolean> => {
        try {
          // Return mock data in UI dev mode
          if (this.isUIDevMode) {
            return true;
          }

          // Validate installation data
          if (!installationData || typeof installationData !== 'object') {
            throw new Error('Invalid installation data provided');
          }

          const installation = installationData as WoWInstallation;
          return await AddonManager.checkAddonInstallation(installation);
        } catch (error) {
          console.error('Error checking addon installation:', error);
          return false;
        }
      }
    );

    ipcMain.handle(
      'addon:install',
      async (_event, installationData: unknown): Promise<AddonInstallationResult> => {
        try {
          // Return mock success in UI dev mode
          if (this.isUIDevMode) {
            return {
              success: true,
              message: 'Mock addon installation successful',
              installedFiles: ['ArenaCoach.lua', 'ArenaCoach.toc', 'icon64.tga'],
            };
          }

          // Validate installation data
          if (!installationData || typeof installationData !== 'object') {
            return {
              success: false,
              message: 'Invalid installation data provided',
              error: 'Installation data is required',
            };
          }

          const installation = installationData as WoWInstallation;
          const result = await AddonManager.installAddon(installation);

          // Re-resolve installations and notify renderer on success
          if (result.success) {
            try {
              const updatedInstallations = await this.resolveWoWInstallations();
              this.notifyAddonStatusToRenderer(updatedInstallations);
            } catch (error) {
              console.error(
                '[ArenaCoachDesktop] Failed to re-resolve installations after manual addon install:',
                error
              );
            }
          }

          return result;
        } catch (error) {
          console.error('Error installing addon:', error);
          return {
            success: false,
            message: 'Addon installation failed',
            error: error instanceof Error ? error.message : 'Unknown error occurred',
          };
        }
      }
    );

    ipcMain.handle(
      'addon:validateFiles',
      async (_event, installationData: unknown): Promise<boolean> => {
        try {
          // Return mock data in UI dev mode
          if (this.isUIDevMode) {
            return true;
          }

          // Validate installation data
          if (!installationData || typeof installationData !== 'object') {
            throw new Error('Invalid installation data provided');
          }

          const installation = installationData as WoWInstallation;
          return await AddonManager.validateAddonFiles(installation);
        } catch (error) {
          console.error('Error validating addon files:', error);
          return false;
        }
      }
    );

    // Match detection handlers (consolidated API)
    ipcMain.handle('match:startDetection', async (): Promise<void> => {
      try {
        const installations = await this.resolveWoWInstallations();
        await this.matchDetectionService.initialize(installations);
        await this.matchDetectionService.start();

        // Persist user preference only after successful start
        this.settingsService.updateSettings({ matchDetectionEnabled: true });

        // Emit event for renderer state management
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('match:detectionStarted');
        }
      } catch (error) {
        console.error('Error starting match detection:', error);
        throw error;
      }
    });

    ipcMain.handle('match:stopDetection', async (): Promise<void> => {
      try {
        await this.matchDetectionService.stop();

        // Persist user preference only after successful stop
        this.settingsService.updateSettings({ matchDetectionEnabled: false });

        // Emit event for renderer state management
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('match:detectionStopped');
        }
      } catch (error) {
        console.error('Error stopping match detection:', error);
        throw error;
      }
    });

    ipcMain.handle('match:getStatus', () => {
      return this.matchDetectionService.getStatus().running;
    });

    // Authentication handlers
    ipcMain.handle('auth:isAuthenticated', (): boolean => {
      return this.authManager.isAuthenticated();
    });

    ipcMain.handle('auth:getCurrentUser', (): UserInfo | null => {
      return this.authManager.getCurrentUser();
    });

    ipcMain.handle('auth:loginWithBattleNet', async _event => {
      try {
        console.debug('[Main] IPC auth:loginWithBattleNet called, starting Battle.net OAuth flow');
        const result = await this.authManager.loginWithBattleNet();
        console.debug('[Main] Battle.net OAuth flow completed, result:', result.success);
        return result;
      } catch (error) {
        console.error('Error during Battle.net login:', error);
        throw error;
      }
    });

    ipcMain.handle('auth:logout', async (): Promise<void> => {
      try {
        await this.authManager.logout();
      } catch (error) {
        console.error('Error during logout:', error);
        throw error;
      }
    });

    /**
     * IPC Handler: Verify Skill-Capped subscription code.
     *
     * ENTITLEMENT INVARIANT:
     * This handler updates currentUser and emits auth:success purely for UI/UX purposes.
     * Entitlements for event delivery are enforced server-side via DB checks
     * in /api/upload/job-status, not via these flags.
     */
    ipcMain.handle('auth:verifySkillCapped', async (_event, code: unknown) => {
      // Input validation
      if (typeof code !== 'string' || code.trim().length === 0) {
        return { success: false, error: 'Verification code is required' };
      }

      try {
        if (!this.authManager.isAuthenticated()) {
          return { success: false, error: 'Not authenticated' };
        }

        // Use existing ApiHeadersProvider pattern
        if (!this.apiHeadersProvider.hasAuth()) {
          return { success: false, error: 'No auth token available' };
        }

        const headers = this.apiHeadersProvider.getHeaders({
          'Content-Type': 'application/json',
        });

        // Call backend API to verify Skill Capped code
        const response = await fetch(`${this.apiBaseUrl}/api/skillcapped/verify`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ userProvidedCode: code.trim() }), // Match website pattern
        });

        const data = (await response.json()) as {
          success: boolean;
          user?: UserInfo;
          error?: string;
          message?: string;
        };

        if (!response.ok) {
          console.error('Error during Skill Capped verification:', data);
          return { success: false, error: data.error || 'Verification failed' };
        }

        if (data.success) {
          const updatedUser = data.user!;

          // Update user info (no token changes)
          this.authManager.updateCurrentUser(updatedUser);

          // Notify renderer of auth state change
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('auth:success', {
              token: this.authManager.getAuthToken(),
              user: updatedUser,
              source: 'skillcapped-verification', // Flag to identify source
            });
          }

          return { success: true, user: updatedUser };
        } else {
          return { success: false, error: data.error || 'Verification failed' };
        }
      } catch (error: any) {
        console.error('Error during Skill Capped verification:', error);
        return { success: false, error: 'Verification failed. Please try again.' };
      }
    });

    /**
     * IPC Handler: Check if user is already Skill-Capped verified.
     *
     * ENTITLEMENT INVARIANT:
     * This handler retrieves and displays current verification status for UI only.
     * Entitlements for event delivery are enforced server-side via DB checks
     * in /api/upload/job-status, not via these flags.
     */
    ipcMain.handle('auth:getSkillCappedStatus', async () => {
      try {
        if (!this.authManager.isAuthenticated()) {
          return { success: false, verified: false, error: 'Not authenticated' };
        }

        if (!this.apiHeadersProvider.hasAuth()) {
          return { success: false, verified: false, error: 'No auth token available' };
        }

        const headers = this.apiHeadersProvider.getHeaders();

        // Call backend API to check Skill Capped status
        const response = await fetch(`${this.apiBaseUrl}/api/skillcapped/status`, {
          method: 'GET',
          headers,
        });

        const data = (await response.json()) as {
          success: boolean;
          is_verified: boolean;
        };

        if (!response.ok) {
          console.error('Error checking Skill Capped status:', data);
          return { success: false, verified: false, error: 'Failed to check status' };
        }

        // If verified, update only user object (no token changes)
        if (data.is_verified) {
          const currentUser = this.authManager.getCurrentUser();
          if (currentUser && !currentUser.is_skill_capped_verified) {
            const updatedUser = { ...currentUser, is_skill_capped_verified: true };
            this.authManager.updateCurrentUser(updatedUser);

            // Emit auth:success to update UI
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
              this.mainWindow.webContents.send('auth:success', {
                token: this.authManager.getAuthToken(),
                user: updatedUser,
                source: 'skillcapped-status', // Flag to identify source
              });
            }
          }
        }

        return { success: true, verified: data.is_verified };
      } catch (error: unknown) {
        console.error('Error checking Skill Capped status:', error);
        return { success: false, verified: false, error: 'Failed to check status' };
      }
    });

    // Extended match detection handlers
    ipcMain.handle('match:getCurrentMatch', () => {
      return this.matchDetectionService.getCurrentMatch();
    });

    ipcMain.handle('match:getDetectionStatus', async () => {
      const fullStatus = await this.matchDetectionService.getStatusWithProcessCheck();
      return {
        running: fullStatus.running,
        initialized: fullStatus.initialized,
        wowProcessStatus: fullStatus.wowProcessStatus,
      };
    });

    ipcMain.handle('match:getSystemMetrics', () => {
      return this.matchDetectionService.getStatus().metrics;
    });

    ipcMain.handle('match:getTriggerMessage', (_event, trigger: string): string => {
      // Boundary: convert external string to EarlyEndTrigger or fail explicitly
      if (!(trigger in EarlyEndTrigger)) {
        throw new Error(`Unknown early-end trigger: ${trigger}`);
      }
      return getTriggerMessage(trigger as EarlyEndTrigger);
    });

    // Service status handlers moved to setupStorageIPC() - require initialized match detection service

    // Auto-updater handlers
    ipcMain.handle('updater:quitAndInstall', (): void => {
      if (!this.isDevelopment) {
        autoUpdater.quitAndInstall();
      }
    });

    // Storage-dependent handlers moved to setupStorageIPC() method

    // Dialog handlers
    ipcMain.handle('dialog:showOpenDialog', async (_event, options) => {
      return await dialog.showOpenDialog(options);
    });

    // Recording handlers
    ipcMain.handle('recording:isInitialized', async (): Promise<boolean> => {
      return this.recordingService
        ? (await this.recordingService.getStatus()).isInitialized
        : false;
    });

    ipcMain.handle('recording:isEnabled', async (): Promise<boolean> => {
      return this.recordingService ? (await this.recordingService.getStatus()).isEnabled : false;
    });

    ipcMain.handle('recording:isRecording', async (): Promise<boolean> => {
      return this.recordingService ? (await this.recordingService.getStatus()).isRecording : false;
    });

    ipcMain.handle('recording:initialize', async (): Promise<void> => {
      if (this.recordingService && !(await this.recordingService.getStatus()).isInitialized) {
        await this.recordingService.initialize();
      }
    });

    ipcMain.handle('recording:enable', async (): Promise<void> => {
      if (!this.recordingService) {
        return;
      }

      try {
        // Re-enable OBS and re-apply saved settings so capture sources are correctly configured
        await this.recordingService.enable();
        if (this.mainWindow) {
          this.recordingService.setMainWindow(this.mainWindow);
        }
        await this.applyPersistedRecordingSettings();
        // Persist user preference
        this.settingsService.updateSettings({ recordingEnabled: true });
      } catch (error) {
        console.error('[recording:enable] Failed to enable recording:', error);
        throw error; // Re-throw to let renderer handle it
      }
    });

    ipcMain.handle('recording:disable', async (): Promise<void> => {
      if (!this.recordingService) {
        return;
      }
      await this.recordingService.disable();
      // Persist user preference
      this.settingsService.updateSettings({ recordingEnabled: false });
    });

    ipcMain.handle('recording:getStatus', async () => {
      if (!this.recordingService) {
        return {
          isInitialized: false,
          isEnabled: false,
          isRecording: false,
          currentFile: null,
          currentMatchHash: null,
          diskUsedGB: 0,
          cpuUsage: 0,
          droppedFrames: 0,
        };
      }

      const status = await this.recordingService.getStatus();
      return {
        isInitialized: status.isInitialized,
        isEnabled: status.isEnabled,
        isRecording: status.isRecording,
        currentFile: status.currentFile, // Proper file/directory path from OBS
        currentMatchHash: status.currentMatchKey, // Match identification for UI
        diskUsedGB: status.diskUsedGB,
        cpuUsage: status.cpuUsage,
        droppedFrames: status.droppedFrames,
      };
    });

    ipcMain.handle(
      'recording:getRecordingInfoForMatch',
      async (
        _event,
        bufferId: string
      ): Promise<{
        videoPath: string | null;
        videoDuration: number | null;
        recordingStatus: RecordingStatusType;
        recordingErrorCode: string | null;
        recordingErrorMessage: string | null;
      }> => {
        try {
          const metadata = await this.metadataStorageService.loadMatchByBufferId(bufferId);
          return {
            videoPath: metadata?.videoPath ?? null,
            videoDuration: metadata?.videoDuration ?? null,
            recordingStatus: metadata?.recordingStatus ?? 'not_applicable',
            recordingErrorCode: metadata?.recordingErrorCode ?? null,
            recordingErrorMessage: metadata?.recordingErrorMessage ?? null,
          };
        } catch (error) {
          console.error('[ArenaCoachDesktop] Failed to get recording info for match:', error);
          return {
            videoPath: null,
            videoDuration: null,
            recordingStatus: 'failed_unknown',
            recordingErrorCode: 'METADATA_LOAD_FAILED',
            recordingErrorMessage: 'Recording info is unavailable due to a local storage error.',
          };
        }
      }
    );

    ipcMain.handle(
      'recording:getThumbnailForMatch',
      async (_event, bufferId: string): Promise<string | null> => {
        try {
          const metadata = await this.metadataStorageService.loadMatchByBufferId(bufferId);
          return metadata?.videoThumbnail || null;
        } catch (error) {
          console.error('[ArenaCoachDesktop] Failed to get thumbnail for match:', error);
          return null;
        }
      }
    );

    ipcMain.handle(
      'recording:checkFileExists',
      async (_event, filePath: string): Promise<boolean> => {
        try {
          if (typeof filePath !== 'string' || !filePath) {
            return false;
          }

          // Get the allowed recording directory from settings
          const settings = this.settingsService.getSettings();
          const defaultDir = path.join(
            app.getPath('videos'),
            ArenaCoachDesktop.DEFAULT_RECORDING_SUBDIR
          );

          let recordingDir: string;
          if (!settings.recordingLocation) {
            recordingDir = defaultDir;
          } else {
            // Apply same validation as RecordingService to get actual directory
            const normalizedPath = path.normalize(settings.recordingLocation);
            const isRootDir = normalizedPath === path.parse(normalizedPath).root;

            if (isRootDir) {
              recordingDir = path.join(normalizedPath, 'ArenaCoach', 'Recordings');
            } else {
              recordingDir = normalizedPath;
            }
          }

          // Normalize and resolve absolute paths
          const baseDir = path.resolve(recordingDir);
          const targetPath = path.resolve(filePath);
          const rel = path.relative(baseDir, targetPath);

          // Security: must be inside baseDir (no parent escapes or absolute rel)
          if (rel.startsWith('..') || path.isAbsolute(rel)) {
            console.warn(
              `[Security] Attempted to check file outside recording directory: ${filePath}`
            );
            return false;
          }

          // Use fs imported at module level
          await fs.access(targetPath);
          return true;
        } catch {
          return false;
        }
      }
    );

    // Scene handlers for recording settings
    ipcMain.handle('scene:getSettings', () => {
      try {
        const settings = this.settingsService.getSettings();
        return settings.recording;
      } catch (error) {
        console.error('[scene:getSettings] Failed to get settings:', error);
        throw new Error('Failed to retrieve scene settings');
      }
    });

    ipcMain.handle('scene:updateSettings', async (_event, updates: Partial<RecordingSettings>) => {
      try {
        // Check if recording is active and trying to change unsafe settings
        if (this.recordingService) {
          const status = await this.recordingService.getStatus();
          if (status.isRecording) {
            const hasUnsafeUpdate = UNSAFE_RECORDING_SETTINGS.some(key => key in updates);
            if (hasUnsafeUpdate) {
              // Throw structured error with code for better error handling
              const error = new Error('Cannot change video settings while recording is active');
              (error as any).code = 'RECORDING_ACTIVE';
              throw error;
            }
          }
        }

        // Validate the incoming settings
        const validated = this.validateRecordingSettings(updates);

        // Early return if no valid updates to avoid unnecessary write
        if (Object.keys(validated).length === 0) {
          const current = this.settingsService.getSettings();
          return current.recording;
        }

        const current = this.settingsService.getSettings();
        const updated = {
          ...current,
          recording: {
            ...current.recording,
            ...validated,
          },
        };

        this.settingsService.updateSettings(updated);

        // Apply settings to OBS if initialized
        if (this.recordingService && this.recordingService.isOBSInitialized()) {
          try {
            await this.recordingService.applyRecordingSettings(validated);
          } catch (applyError) {
            // Log but don't fail the entire update
            // Settings are persisted, OBS apply can be retried
          }
        }

        return updated.recording;
      } catch (error) {
        throw error;
      }
    });

    // Recording directory helper for Scene UI - returns the actual sanitized path being used
    ipcMain.handle('recording:getEffectiveDirectory', () => {
      try {
        const settings = this.settingsService.getSettings();
        const defaultDir = path.join(
          app.getPath('videos'),
          ArenaCoachDesktop.DEFAULT_RECORDING_SUBDIR
        );

        if (!settings.recordingLocation) {
          return defaultDir;
        }

        // Apply same validation as RecordingService to show what's actually being used
        const normalizedPath = path.normalize(settings.recordingLocation);
        const isRootDir = normalizedPath === path.parse(normalizedPath).root;

        if (isRootDir) {
          // Return the sanitized path that RecordingService actually uses
          return path.join(normalizedPath, 'ArenaCoach', 'Recordings');
        }

        return normalizedPath;
      } catch (error) {
        console.error('[recording:getEffectiveDirectory] Failed to get directory:', error);
        throw new Error('Failed to determine recording directory');
      }
    });

    // OBS Preview handlers
    ipcMain.handle('obs:isInitialized', async (): Promise<boolean> => {
      return this.recordingService ? this.recordingService.isOBSInitialized() : false;
    });

    ipcMain.handle('obs:preview:show', async (_event, bounds: unknown): Promise<void> => {
      if (!this.recordingService) {
        // Recording service not available - no-op
        return;
      }

      // Validate untrusted input from renderer
      const validatedBounds = this.validatePreviewBounds(bounds);

      try {
        await this.recordingService.showPreview(validatedBounds);
      } catch (error) {
        console.error('[obs:preview:show] Failed to show preview:', error);
        throw error;
      }
    });

    ipcMain.handle('obs:preview:updateBounds', async (_event, bounds: unknown): Promise<void> => {
      if (!this.recordingService) {
        // Recording service not available - no-op
        return;
      }

      // Validate untrusted input from renderer
      const validatedBounds = this.validatePreviewBounds(bounds);

      try {
        await this.recordingService.updatePreviewBounds(validatedBounds);
      } catch (error) {
        console.error('[obs:preview:updateBounds] Failed to update bounds:', error);
        throw error;
      }
    });

    ipcMain.handle('obs:preview:hide', async (): Promise<void> => {
      if (!this.recordingService) {
        // Recording service not available - no-op
        return;
      }

      try {
        this.recordingService.hidePreview(); // No await - this is a synchronous method
      } catch (error) {
        console.error('[obs:preview:hide] Failed to hide preview:', error);
        throw error;
      }
    });

    // Scene tab active state tracking
    ipcMain.handle('scene:setActive', (_event, active: boolean): void => {
      // Hide preview when Scene tab becomes inactive
      if (!active && this.recordingService) {
        try {
          this.recordingService.hidePreview();
        } catch (error) {
          // Silent fail - preview hiding is non-critical
        }
      }
    });

    // Audio device enumeration for Scene UI
    ipcMain.handle('obs:audio:getDevices', async () => {
      try {
        if (!this.recordingService || !this.recordingService.isOBSInitialized()) {
          return { input: [], output: [] };
        }

        return this.recordingService.getAudioDevices();
      } catch (error) {
        // Silent fail with empty device lists
        return { input: [], output: [] };
      }
    });

    // Monitor enumeration for Scene UI
    ipcMain.handle('obs:display:getMonitors', async () => {
      try {
        if (!this.recordingService || !this.recordingService.isOBSInitialized()) {
          return [];
        }

        return this.recordingService.getMonitors();
      } catch (error) {
        console.error('[obs:display:getMonitors] Failed to get monitors:', error);
        // Return primary monitor as fallback
        return [{ id: '0', name: 'Primary Monitor' }];
      }
    });

    // Settings handlers
    ipcMain.handle('settings:get', () => {
      try {
        return this.settingsService.getSettings();
      } catch (error) {
        console.error('Error getting settings:', error);
        throw error;
      }
    });

    ipcMain.handle('settings:update', async (_event, newSettings: Partial<AppSettings>) => {
      try {
        // Check if recording enabled setting is changing
        const currentSettings = this.settingsService.getSettings();
        const wasRecordingEnabled = currentSettings.recordingEnabled !== false;
        const previousRunOnStartup = currentSettings.runOnStartup;

        // Update settings first
        const updatedSettings = this.settingsService.updateSettings(newSettings);
        const willBeRecordingEnabled = updatedSettings.recordingEnabled !== false;

        // Handle recording directory change if recording service is active
        if (
          this.recordingService &&
          newSettings.recordingLocation &&
          newSettings.recordingLocation !== currentSettings.recordingLocation
        ) {
          try {
            console.info(
              '[ArenaCoachDesktop] Updating recording directory to:',
              newSettings.recordingLocation
            );
            await this.recordingService.updateRecordingDirectory(newSettings.recordingLocation);
            console.info('[ArenaCoachDesktop] Recording directory updated successfully');
            // Re-read settings in case RecordingService sanitized the path
            const refreshedSettings = this.settingsService.getSettings();
            if (
              refreshedSettings.recordingLocation &&
              refreshedSettings.recordingLocation !== updatedSettings.recordingLocation
            ) {
              console.info(
                '[ArenaCoachDesktop] Recording location was sanitized from',
                updatedSettings.recordingLocation,
                'to',
                refreshedSettings.recordingLocation
              );
              // Update our return value to reflect the sanitized path
              updatedSettings.recordingLocation = refreshedSettings.recordingLocation;
            }
          } catch (error) {
            console.error('[ArenaCoachDesktop] Failed to update recording directory:', error);
            // Don't throw - setting is saved, just couldn't update live service
          }
        }

        // Handle recording service initialization/shutdown based on recordingEnabled changes
        if (
          !this.isUIDevMode &&
          process.platform === 'win32' &&
          wasRecordingEnabled !== willBeRecordingEnabled
        ) {
          if (willBeRecordingEnabled && !this.recordingService) {
            // Guard: Ensure metadata service is initialized before creating recording service
            if (!this.metadataStorageService) {
              console.warn(
                '[ArenaCoachDesktop] Cannot enable recording - metadata service not yet initialized'
              );
              return updatedSettings;
            }

            // Enable recording - initialize service
            try {
              console.info('[ArenaCoachDesktop] Enabling recording service due to settings change');
              const recordingConfig = this.createRecordingServiceConfig(updatedSettings);
              this.recordingService = new RecordingService(
                recordingConfig,
                this.metadataService,
                this.settingsService
              );
              await this.recordingService.initialize();
              this.setupRecordingEvents(); // Wire up event handlers

              // Pass main window for preview
              if (this.mainWindow) {
                this.recordingService.setMainWindow(this.mainWindow);
              }

              // Apply saved recording settings using helper method
              await this.applyPersistedRecordingSettings();

              console.info('[ArenaCoachDesktop] Recording service enabled via settings');
            } catch (error) {
              console.error('[ArenaCoachDesktop] Failed to enable recording service:', error);
              this.recordingService = null;
            }
          } else if (!willBeRecordingEnabled && this.recordingService) {
            // Disable recording - shutdown service
            try {
              console.info(
                '[ArenaCoachDesktop] Disabling recording service due to settings change'
              );
              await this.recordingService.shutdown();
              this.recordingService = null;
              console.info('[ArenaCoachDesktop] Recording service disabled via settings');
            } catch (error) {
              console.error('[ArenaCoachDesktop] Error disabling recording service:', error);
            }
          }
        }

        // Handle runOnStartup change
        if (
          newSettings.runOnStartup !== undefined &&
          newSettings.runOnStartup !== previousRunOnStartup
        ) {
          this.applyAutoLaunchSetting(updatedSettings.runOnStartup === true);
        }

        return updatedSettings;
      } catch (error) {
        console.error('Error updating settings:', error);
        throw error;
      }
    });

    ipcMain.handle('settings:reset', () => {
      try {
        const settings = this.settingsService.resetToDefaults();

        // Apply auto-launch setting after reset to keep OS in sync
        if (settings.runOnStartup !== undefined) {
          this.applyAutoLaunchSetting(settings.runOnStartup === true);
        }

        return settings;
      } catch (error) {
        console.error('Error resetting settings:', error);
        throw error;
      }
    });
  }

  /**
   * Setup IPC handlers that depend on MetadataStorageService
   * These must be registered AFTER metadata services are initialized
   */
  private setupStorageIPC(): void {
    // Match metadata handlers
    ipcMain.handle('matches:list', async (_event, limit?: number, offset?: number) => {
      try {
        return await this.metadataStorageService.listMatches(limit, offset);
      } catch (error) {
        console.error('Error listing matches:', error);
        throw error;
      }
    });

    ipcMain.handle('matches:count', async () => {
      try {
        return await this.metadataStorageService.getMatchesCount();
      } catch (error) {
        console.error('Error counting matches:', error);
        throw error;
      }
    });

    ipcMain.handle('matches:load', async (_event, matchHash: string) => {
      try {
        if (typeof matchHash !== 'string' || matchHash.length === 0) {
          throw new Error('Invalid matchHash: must be a non-empty string');
        }
        return await this.metadataStorageService.loadMatch(matchHash);
      } catch (error) {
        console.error('Error loading match:', error);
        throw error;
      }
    });

    ipcMain.handle('matches:delete', async (_event, bufferId: string) => {
      try {
        if (typeof bufferId !== 'string' || bufferId.length === 0) {
          throw new Error('Invalid bufferId: must be a non-empty string');
        }
        return await this.metadataStorageService.deleteMatch(bufferId);
      } catch (error) {
        console.error('Error deleting match:', error);
        throw error;
      }
    });

    ipcMain.handle('matches:cleanup', async () => {
      try {
        return await this.metadataStorageService.cleanupOldMatches();
      } catch (error) {
        console.error('Error cleaning up matches:', error);
        throw error;
      }
    });

    // Live status update handler for Single Source of Truth pattern
    ipcMain.handle(
      'match:updateLiveStatus',
      async (
        _event,
        matchHash: string,
        status: string,
        progressMessage?: string,
        queuePosition?: number | null,
        totalInQueue?: number | null
      ) => {
        try {
          if (typeof matchHash !== 'string' || matchHash.length === 0) {
            throw new Error('Invalid matchHash: must be a non-empty string');
          }
          if (typeof status !== 'string' || status.length === 0) {
            throw new Error('Invalid status: must be a non-empty string');
          }

          const validStatuses = Object.values(UploadStatus);
          if (!validStatuses.includes(status as UploadStatus)) {
            throw new Error(`Invalid status: must be one of ${validStatuses.join(', ')}`);
          }

          if (
            queuePosition !== undefined &&
            queuePosition !== null &&
            typeof queuePosition !== 'number'
          ) {
            throw new Error('Invalid queuePosition: must be a number or null');
          }
          if (
            totalInQueue !== undefined &&
            totalInQueue !== null &&
            typeof totalInQueue !== 'number'
          ) {
            throw new Error('Invalid totalInQueue: must be a number or null');
          }
          if (
            queuePosition !== undefined &&
            queuePosition !== null &&
            (!Number.isInteger(queuePosition) || queuePosition < 1)
          ) {
            throw new Error('Invalid queuePosition: must be a positive integer or null');
          }
          if (
            totalInQueue !== undefined &&
            totalInQueue !== null &&
            (!Number.isInteger(totalInQueue) || totalInQueue < 0)
          ) {
            throw new Error('Invalid totalInQueue: must be a non-negative integer or null');
          }

          const updateData: Partial<any> = {};
          if (progressMessage) updateData.progressMessage = progressMessage;
          if (queuePosition !== undefined && queuePosition !== null)
            updateData.queuePosition = queuePosition;
          if (totalInQueue !== undefined && totalInQueue !== null)
            updateData.totalInQueue = totalInQueue;

          await this.metadataStorageService.updateMatchStatus(
            matchHash,
            status as UploadStatus,
            updateData
          );

          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('match:statusUpdated', {
              matchHash,
              status,
              progressMessage,
              queuePosition,
              totalInQueue,
            });
          }
        } catch (error) {
          console.error('Error updating live status:', error);
          throw error;
        }
      }
    );

    // Service status handler - returns current connection status
    ipcMain.handle('service:getStatus', async () => {
      // Read directly from services for current status
      const pollingStats = this.completionPollingService?.getPollingStats();
      const isConnected = this.serviceHealthCheck?.isServiceAvailable() ?? false;
      const hasAuth = this.apiHeadersProvider?.hasAuth() ?? false;

      return {
        connected: isConnected,
        trackedJobsCount: pollingStats?.trackedJobsCount ?? 0,
        hasAuth,
      };
    });

    // Quota status handler - fetches daily enrichment quota from backend
    ipcMain.handle('quota:getStatus', async () => {
      try {
        const headers = this.apiHeadersProvider.getHeaders();
        const response = await fetch(`${this.apiBaseUrl}/api/upload/enrichment-quota`, {
          method: 'GET',
          headers,
        });

        if (!response.ok) {
          throw new Error(`Quota status HTTP ${response.status}`);
        }

        const data = await response.json();
        return { success: true, data };
      } catch (error) {
        console.error('[Main] Failed to fetch enrichment quota status:', error);
        return { success: false, error: 'Failed to fetch quota status' };
      }
    });

    console.info('[ArenaCoachDesktop] Storage-dependent IPC handlers registered successfully');
  }

  private setupRecordingEvents(): void {
    if (!this.recordingService) return;

    // Forward recording started event
    this.recordingService.on('recordingStarted', (data: { bufferId: string; path: string }) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('recording:started', data);
      }
    });

    // Forward recording completed event
    this.recordingService.on(
      'recordingCompleted',
      (data: { matchHash: string; path: string; duration: number }) => {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('recording:completed', data);
        }
      }
    );

    // Forward recording error event (internal errors)
    this.recordingService.on('error', (error: Error) => {
      console.error('[ArenaCoachDesktop] Recording error:', error);
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('recording:error', error.message);
      }
    });

    // Forward user-facing recording error event (folder/permission issues)
    this.recordingService.on('recordingError', (userMessage: string) => {
      console.warn('[ArenaCoachDesktop] Recording user-facing error:', userMessage);
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('recording:userError', userMessage);
      }
    });

    console.info('[ArenaCoachDesktop] Recording event handlers registered');
  }

  /**
   * Enqueues a lifecycle operation for a specific bufferId, ensuring sequential execution.
   * Operations for the same bufferId run one after another in the order they are enqueued.
   * Operations for different bufferIds remain independent and may run in parallel.
   */
  private enqueueLifecycleOp(bufferId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.bufferQueues.get(bufferId) ?? Promise.resolve();

    // Chain the new operation after the previous one, regardless of previous success/failure
    const current = previous.then(operation, operation);

    // Store a tail that never rejects, so the chain always stays usable for subsequent operations
    this.bufferQueues.set(
      bufferId,
      current.catch(() => {})
    );

    return current;
  }

  /**
   * Internal handler for match started events.
   * Assumes it is called within a serialized queue context for the bufferId.
   */
  private async handleMatchStartedInternal(event: MatchStartedEvent): Promise<void> {
    console.info('[ArenaCoachDesktop] Match started:', event);

    await this.matchLifecycleService?.handleMatchStarted(event);

    // Notify renderer process when match starts
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('match:started', event);
    }
  }

  /**
   * Internal handler for match ended events.
   * Assumes it is called within a serialized queue context for the bufferId.
   */
  private async handleMatchEndedInternal(event: MatchEndedEvent): Promise<void> {
    console.info('[ArenaCoachDesktop] Match ended:', event);

    if (!this.matchLifecycleService) return;

    const key = event.bufferId;
    const finalizationPromise = this.matchLifecycleService.handleMatchEnded(event);
    this.ongoingFinalizations.set(
      key,
      finalizationPromise.finally(() => this.ongoingFinalizations.delete(key))
    );
    await finalizationPromise;

    // Notify renderer process
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('match:ended', event);
    }
  }

  /**
   * Internal handler for match ended incomplete events.
   * Assumes it is called within a serialized queue context for the bufferId.
   */
  private async handleMatchEndedIncompleteInternal(
    event: MatchEndedIncompleteEvent
  ): Promise<void> {
    const { bufferId, trigger, lines } = event;
    console.warn(`[ArenaCoachDesktop] Match ended incomplete:`, {
      bufferId,
      trigger,
      lines,
    });

    await this.matchLifecycleService?.handleMatchEndedIncomplete(event);

    // Notify UI for match list refresh
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('match:listNeedsRefresh', event);
    }

    // Notify renderer process of incomplete match
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('match:endedIncomplete', {
        bufferId,
        trigger,
        lines,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Internal handler for match processed events.
   * Assumes it is called within a serialized queue context for the bufferId,
   * guaranteeing that matchStarted and matchEnded have already completed.
   */
  private async handleMatchProcessedInternal(payload: MatchProcessedPayload): Promise<void> {
    const { matchEvent, chunkFilePath } = payload;

    // Load authoritative metadata state from disk (single source of truth)
    const storedMetadata = await this.metadataStorageService.loadMatchByBufferId(
      matchEvent.bufferId
    );

    console.info('[ArenaCoachDesktop] Match processed:', {
      bufferId: matchEvent.bufferId,
      matchHash: storedMetadata?.matchHash,
      chunkFilePath: chunkFilePath,
    });
    if (!storedMetadata) {
      console.error(
        `[ArenaCoachDesktop] No metadata found for match ${matchEvent.bufferId} - this should never happen in progressive system`
      );
      return;
    }

    // Build finalized event from stored metadata for upload
    const finalizedEvent: MatchEndedEvent = {
      type: MatchEventType.MATCH_ENDED,
      timestamp: storedMetadata.matchData.timestamp,
      bufferId: matchEvent.bufferId,
      metadata: storedMetadata.matchData,
    };

    // Gate upload based on completion status from stored metadata
    if (storedMetadata.matchCompletionStatus === 'complete') {
      // Complete matches should always have matchHash
      if (!storedMetadata.matchHash) {
        console.error('[ArenaCoachDesktop] Complete match missing matchHash - skipping upload');
        return;
      }

      const matchHash = storedMetadata.matchHash; // Store for TypeScript

      // Proceed with existing upload pipeline for complete matches
      try {
        await this.matchDetectionService.submitMatchChunk(chunkFilePath, finalizedEvent, matchHash);
        console.info(
          `[ArenaCoachDesktop] Successfully submitted chunk for complete match: ${matchHash}`
        );
      } catch (uploadError) {
        console.error(`[ArenaCoachDesktop] Upload failed for match ${matchHash}:`, uploadError);

        // Map upload errors to appropriate metadata updates
        if (isCombatLogExpiredError(uploadError)) {
          console.info('[ArenaCoachDesktop] Processing expired combat log for match:', matchHash);

          // Update metadata and clean up chunks for expired match
          if (storedMetadata.bufferId) {
            await this.updateMatchMetadataToExpired(matchHash, storedMetadata.bufferId);
          } else {
            console.warn(
              `[ArenaCoachDesktop] Cannot process expired match - no bufferId for ${matchHash}`
            );
          }
        } else {
          // Handle all other errors by marking as FAILED
          console.error(`[ArenaCoachDesktop] Upload error for match ${matchHash}:`, uploadError);

          const errorMessage =
            uploadError instanceof Error ? uploadError.message : String(uploadError);
          await this.updateMatchMetadataForFailure(matchHash, `Upload failed: ${errorMessage}`);
        }
      }
    } else {
      // Process incomplete matches - mark upload status as incomplete (terminal state)
      const matchHashDisplay = storedMetadata.matchHash || 'no-hash';
      console.info(
        `[ArenaCoachDesktop] Processing incomplete match: ${matchHashDisplay} (status: ${storedMetadata.matchCompletionStatus})`
      );

      // Only attempt metadata update if we have a matchHash
      if (storedMetadata.matchHash) {
        await this.updateMatchMetadataToIncomplete(storedMetadata.matchHash);
      }

      // Preserve data for OBS integration (Task 2 & 3 foundation)
      console.info(
        `[ArenaCoachDesktop] Incomplete match preserved for local use: ${matchHashDisplay}`
      );
    }

    // Always notify UI for match list refresh
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('match:listNeedsRefresh', matchEvent);
    }
  }

  private setupMatchDetection(): void {
    // Delegate to MatchLifecycleService (SSoT for session state)
    // Per-buffer queue ensures sequential execution for each bufferId
    this.matchDetectionService.on('matchStarted', async (event: MatchStartedEvent) => {
      try {
        await this.enqueueLifecycleOp(event.bufferId, () => this.handleMatchStartedInternal(event));
      } catch (error) {
        console.error('Error handling matchStarted event:', error);
      }
    });

    // Delegate to MatchLifecycleService
    this.matchDetectionService.on('matchEnded', async (event: MatchEndedEvent) => {
      try {
        await this.enqueueLifecycleOp(event.bufferId, () => this.handleMatchEndedInternal(event));
      } catch (error) {
        console.error('Error handling matchEnded event:', error);
      }
    });

    // Delegate to MatchLifecycleService
    this.matchDetectionService.on(
      'matchEndedIncomplete',
      async (event: MatchEndedIncompleteEvent) => {
        try {
          await this.enqueueLifecycleOp(event.bufferId, () =>
            this.handleMatchEndedIncompleteInternal(event)
          );
        } catch (error) {
          console.error('Error handling matchEndedIncomplete event:', error);
        }
      }
    );

    // matchProcessed is enqueued in the same per-buffer queue to ensure it runs
    // after matchStarted and matchEnded have completed for this bufferId
    this.matchDetectionService.on('matchProcessed', async (payload: MatchProcessedPayload) => {
      try {
        await this.enqueueLifecycleOp(payload.matchEvent.bufferId, () =>
          this.handleMatchProcessedInternal(payload)
        );
      } catch (error) {
        console.error('Error handling matchProcessed event:', error);
      }
    });

    // Analysis pipeline events - using any type following proven combat log patterns
    //
    // ARCHITECTURAL JUSTIFICATION for `any` typing in event handlers:
    // the use of `any` for dynamic event payloads is a proven and necessary pattern for
    // combat log and match detection systems. This follows established patterns because:
    //
    // 1. DYNAMIC EVENT STRUCTURES: Match detection events have variable payload structures
    //    similar to WoW combat log events (60+ different event types with varying parameters)
    //
    // 2. PERFORMANCE OPTIMIZATION: Just-in-time payload processing avoids overhead of
    //    parsing unused data, critical for real-time match detection processing
    //
    // 3. VERSION RESILIENCE: `any` typing allows graceful handling of analysis pipeline
    //    evolution without breaking existing event handlers
    //
    // 4. SAFE BOUNDARY PATTERN: `any` is confined to the event boundary and immediately
    //    converted to typed structures within handlers (see immediate destructuring below)
    //
    // This is "strategic flexibility" not "weak typing" - a deliberate architectural
    // choice for dynamic event systems processing thousands of events per second.
    this.matchDetectionService.on('analysisJobCreated', (event: AnalysisJobCreatedPayload) => {
      try {
        const { jobId, matchHash } = event;
        console.info('Analysis job created:', jobId);

        // Update match metadata with jobId and uploading status
        this.updateMatchMetadataForUpload(matchHash, jobId);

        // Notify renderer process
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('analysis:jobCreated', event);
        }
      } catch (error) {
        console.error('Error handling analysisJobCreated event:', error);
      }
    });

    this.matchDetectionService.on('analysisProgress', (event: AnalysisProgressPayload) => {
      try {
        const { jobId, status } = event;
        if (this.isDevelopment) {
          console.info('Analysis progress:', { jobId, status });
        }

        // Notify renderer process
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('analysis:progress', event);
        }
      } catch (error) {
        console.error('Error handling analysisProgress event:', error);
      }
    });

    this.matchDetectionService.on('jobRetry', (event: JobRetryPayload) => {
      try {
        if (this.isDevelopment) {
          console.info('Job retry:', event);
        }

        // Notify renderer process
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('match:jobRetry', event);
        }
      } catch (error) {
        console.error('Error handling jobRetry event:', error);
      }
    });

    this.matchDetectionService.on('analysisCompleted', async (event: AnalysisCompletedPayload) => {
      try {
        const { jobId, analysisId, analysisPayload, matchHash } = event;

        console.info('Analysis completed:', {
          jobId,
          analysisId,
          matchHash,
          entitlementMode: event.entitlementMode,
        });

        // Single atomic completion finalizer handles both entitled and non-entitled paths
        // - Non-entitled: marks as COMPLETED with freemium state
        // - Entitled (skill-capped or freemium): marks as COMPLETED + enriches with analysis data
        await this.analysisEnrichmentService.finalizeCompletion(
          jobId,
          analysisId, // Already normalized to string at emission boundary
          analysisPayload,
          {
            entitlementMode: event.entitlementMode,
            freeQuotaLimit: event.freeQuotaLimit,
            freeQuotaUsed: event.freeQuotaUsed,
            freeQuotaRemaining: event.freeQuotaRemaining,
            freeQuotaExhausted: event.freeQuotaExhausted,
          }
        );

        // Always clean up chunk files after successful analysis (both auth and non-auth)
        await this.cleanupChunksAfterAnalysis(jobId);

        // Notify renderer process (existing behavior preserved)
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('analysis:completed', event);
        }
      } catch (error) {
        console.error('Error handling analysisCompleted event:', error);
      }
    });

    // Handle new fallback polling events for enhanced reliability
    this.matchDetectionService.on('analysisFailed', (event: AnalysisFailedPayload) => {
      try {
        console.debug('[ArenaCoachDesktop] Received analysisFailed event:', event);

        const { jobId, matchHash, error, isNotFound, errorCode, isPermanent } = event;

        console.error('Analysis failed:', {
          jobId,
          matchHash,
          error,
          isNotFound,
          errorCode,
          isPermanent,
        });

        // Update local metadata to reflect failure with structured error data
        this.updateMatchMetadataForFailure(
          matchHash,
          error || 'Unknown error',
          isNotFound,
          errorCode,
          isPermanent
        );

        // Clean up chunk files selectively based on failure type
        this.cleanupChunksForTerminalFailure(jobId, matchHash, isNotFound).catch(cleanupError => {
          console.error(
            `[ArenaCoachDesktop] Failed to cleanup chunks for terminal failure ${jobId}:`,
            cleanupError
          );
        });

        // Notify renderer process
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('analysis:failed', event);
        }
      } catch (handlingError) {
        console.error('Error handling analysisFailed event:', handlingError);
      }
    });

    this.matchDetectionService.on('analysisTimeout', (event: AnalysisTimeoutPayload) => {
      try {
        const { jobId, matchHash, attempts } = event;

        console.warn('Analysis timeout:', { jobId, matchHash, totalAttempts: attempts });

        // Update local metadata to reflect timeout with synthetic error code
        this.updateMatchMetadataForFailure(
          matchHash,
          'Analysis timed out after maximum polling attempts',
          /* isNotFound */ false,
          'ANALYSIS_TIMEOUT',
          false
        );

        // Notify renderer process
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('analysis:timeout', event);
        }
      } catch (handlingError) {
        console.error('Error handling analysisTimeout event:', handlingError);
      }
    });

    // Handle service lifecycle events
    this.matchDetectionService.on('started', () => {
      try {
        console.info('Match detection service started');

        // Service started - no need to send match:started event
        // Only send match:started when actual matches are detected
      } catch (error) {
        console.error('Error handling started event:', error);
      }
    });

    this.matchDetectionService.on('stopped', () => {
      try {
        console.info('Match detection service stopped');
      } catch (error) {
        console.error('Error handling stopped event:', error);
      }
    });

    // Handle WoW process monitoring events
    this.matchDetectionService.on('wowProcessStart', () => {
      try {
        console.info('[MAIN] WoW process started - match detection now active');

        // Notify recording service for game capture
        if (this.recordingService) {
          this.recordingService.setWoWActive(true);
        }

        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('wow:processStart');
        }
      } catch (error) {
        console.error('[MAIN] Error handling wowProcessStart event:', error);
      }
    });

    this.matchDetectionService.on('wowProcessStop', () => {
      try {
        console.info('[MAIN] WoW process stopped - match detection paused');

        // Notify recording service for game capture
        if (this.recordingService) {
          this.recordingService.setWoWActive(false);
        }

        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('wow:processStop');
        }
      } catch (error) {
        console.error('[MAIN] Error handling wowProcessStop event:', error);
      }
    });

    this.matchDetectionService.on('processMonitorError', (error: WoWProcessMonitorError) => {
      try {
        const errorDetails = getErrorDetails(error);
        console.error('WoW process monitor error:', errorDetails);

        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('wow:processMonitorError', {
            message: error.message,
            code: error.code,
            timestamp: error.timestamp.toISOString(),
          });
        }
      } catch (handlingError) {
        console.error('Error handling processMonitorError event:', handlingError);
      }
    });

    // Error events - using any type following established patterns
    // NOTE: Error payloads from services are inherently dynamic and may contain
    // varying properties (message, stack, code, etc.) depending on error source.
    // This mirrors combat log error handling patterns in reference architectures.
    this.matchDetectionService.on('error', (error: any) => {
      try {
        // SAFE BOUNDARY PATTERN: Immediately extract known properties
        const errorMessage = error?.message || error?.toString() || 'Unknown error';
        console.error('Match detection service error:', error);
      } catch (handlingError) {
        console.error('Error handling service error event:', handlingError);
      }
    });

    // Consolidated cleanup when app is quitting
    app.on('before-quit', async event => {
      // If already in cleanup process, allow quit to proceed
      if (this.isQuitting) {
        return;
      }

      // Prevent immediate quit to allow async cleanup
      event.preventDefault();
      this.isQuitting = true;

      try {
        console.info('Performing pre-quit cleanup...');

        // Destroy system tray
        if (this.tray) {
          this.tray.destroy();
          this.tray = null;
        }

        // Stop auto-updater interval
        if (this.updateIntervalId) {
          clearInterval(this.updateIntervalId);
          this.updateIntervalId = null;
        }

        // Stop service status timer
        if (this.serviceStatusTimerId) {
          clearInterval(this.serviceStatusTimerId);
          this.serviceStatusTimerId = null;
        }

        // Stop expiration timer
        if (this.expirationTimerId) {
          clearInterval(this.expirationTimerId);
          this.expirationTimerId = null;
        }

        // Clear window bounds debounce timer
        if (this.windowBoundsDebounceTimer) {
          clearTimeout(this.windowBoundsDebounceTimer);
          this.windowBoundsDebounceTimer = null;
        }

        // Clear recovery timer
        if (this.recoveryTimer) {
          clearInterval(this.recoveryTimer);
          this.recoveryTimer = null;
        }

        // Shutdown recording service FIRST (critical for OBS cleanup)
        if (this.recordingService) {
          try {
            console.info('Shutting down recording service...');
            await this.recordingService.shutdown();
            console.info('Recording service shutdown complete');
          } catch (error) {
            console.error('Error shutting down recording service:', error);
            // Continue with other cleanup even if recording shutdown fails
          }
        }

        // Clean up new services
        if (this.completionPollingService) {
          console.info('Stopping completion polling service...');
          this.completionPollingService.stopAll();
        }

        // The JobQueueOrchestrator handles job state persistence internally

        // Clean up match detection service
        await this.matchDetectionService.cleanup();

        // Clean up chunk cleanup service
        this.chunkCleanupService.cleanup();

        // No explicit cleanup needed for match metadata service (file-based storage)

        console.info('Pre-quit cleanup completed successfully');
      } catch (error) {
        console.error('Error during pre-quit cleanup:', error);
      } finally {
        // Now exit the app
        app.quit();
      }
    });
  }

  /**
   * Check Skill Capped status and update user object.
   * Used by both auth-success (login) and auth-restored (app start).
   *
   * ENTITLEMENT INVARIANT:
   * This function is a UI/state synchronization mechanism only.
   * It does NOT influence entitlements for job-status/event delivery.
   * Entitlements are enforced server-side via DB checks in /api/upload/job-status.
   */
  private async checkSkillCappedStatus(
    data: { token: AuthToken; user: UserInfo },
    sourceFlag?: string
  ): Promise<{ token: AuthToken; user: UserInfo }> {
    try {
      const headers = this.apiHeadersProvider.getHeaders();
      const response = await fetch(`${this.apiBaseUrl}/api/skillcapped/status`, {
        method: 'GET',
        headers,
      });

      if (response.ok) {
        const statusData = (await response.json()) as {
          success: boolean;
          is_verified: boolean;
        };

        // Update user object based on server status (supports revocation)
        const updatedUser = { ...data.user, is_skill_capped_verified: statusData.is_verified };

        // Log status changes for debugging
        if (data.user.is_skill_capped_verified !== statusData.is_verified) {
          console.info(
            `[Main] Skill Capped status changed for ${data.user?.battletag || 'Unknown'} (ID: ${data.user?.id || 'N/A'}): ${data.user.is_skill_capped_verified} → ${statusData.is_verified}`
          );
        }

        this.authManager.updateCurrentUser(updatedUser);

        // Always emit auth:success (renderer only listens for this)
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('auth:success', {
            token: data.token,
            user: updatedUser,
            source: statusData.is_verified && sourceFlag ? sourceFlag : undefined,
          });
        }

        return { token: data.token, user: updatedUser };
      }
    } catch (error) {
      console.warn('[Main] Failed to check Skill Capped status:', error);
    }

    // Fallback: emit auth:success with original data if status check failed
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('auth:success', data);
    }
    return data;
  }

  private setupAuthentication(): void {
    // Handle authentication events
    this.authManager.on('auth-success', async (data: { token: AuthToken; user: UserInfo }) => {
      console.info(`User authenticated: ${data.user.battletag}`);

      // Update all services with auth token
      this.updateAllServicesAuthToken(data.token.accessToken);

      // Check Skill Capped status and emit result
      await this.checkSkillCappedStatus(data, 'login-with-status');
    });

    this.authManager.on('auth-restored', async (data: { token: AuthToken; user: UserInfo }) => {
      console.info(`Authentication restored from saved credentials: ${data.user.battletag}`);

      // Update all services with restored auth token
      this.updateAllServicesAuthToken(data.token.accessToken);

      // Check Skill Capped status and emit auth:success
      await this.checkSkillCappedStatus(data, 'restore-with-status');
    });

    this.authManager.on('token-refreshed', (token: AuthToken) => {
      console.info('Authentication token refreshed');

      // Update all services with refreshed token
      this.updateAllServicesAuthToken(token.accessToken);

      // Notify renderer process
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('auth:token-refreshed', token);
      }
    });

    this.authManager.on('logout', async () => {
      console.info('User logged out');

      // Clear auth token from all services
      this.updateAllServicesAuthToken(undefined);

      // Perform immediate health check after logout
      if (this.serviceHealthCheck) {
        await this.serviceHealthCheck.checkOnce();
        this.sendServiceStatus();
      }

      // Notify renderer process
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('auth:logout');
      }
    });

    this.authManager.on('auth-error', (error: Error) => {
      console.error('Authentication error:', error);

      // Notify renderer process
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('auth:error', error.message);
      }
    });

    this.authManager.on('device-flow-initiated', data => {
      console.info('Device flow initiated:', data.userCode);

      // Notify renderer process
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('auth:device-flow-initiated', data);
      }
    });

    this.authManager.on('device-flow-pending', data => {
      // Notify renderer process of polling progress
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('auth:device-flow-pending', data);
      }
    });
  }

  /**
   * Initialize match detection service with WoW installations
   */
  private async initializeMatchDetection(): Promise<void> {
    try {
      console.info('[ArenaCoachDesktop] Initializing match detection service...');

      const installations = await this.resolveWoWInstallations();
      await this.matchDetectionService.initialize(installations);

      const settings = this.settingsService.getSettings();
      if (settings.matchDetectionEnabled !== false && !this.isUIDevMode) {
        console.info('[ArenaCoachDesktop] Auto-starting match detection based on settings...');
        try {
          await this.matchDetectionService.start();

          // Only emit if start succeeds
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('match:detectionStarted');
          }
        } catch (startError) {
          console.error('[ArenaCoachDesktop] Failed to auto-start match detection:', startError);
          // Continue - service is initialized but not running
        }
      } else {
        console.info(
          '[ArenaCoachDesktop] Match detection auto-start skipped (UI dev mode or disabled in settings)'
        );
      }

      console.info('[ArenaCoachDesktop] Match detection service initialized successfully');
    } catch (error) {
      console.error('[ArenaCoachDesktop] Failed to initialize match detection service:', error);
      // Don't throw - allow app to continue without match detection
    }
  }

  /**
   * Check and install ArenaCoach addon for all detected WoW installations
   */
  private async checkAndInstallAddons(): Promise<void> {
    try {
      console.info('[ArenaCoachDesktop] Checking ArenaCoach addon installations...');

      const installations = await this.resolveWoWInstallations();

      if (installations.length === 0) {
        console.info('[ArenaCoachDesktop] No WoW installations found, skipping addon check');
        return;
      }

      const installationsNeedingAddon: WoWInstallation[] = [];
      const installationsWithAddon: WoWInstallation[] = [];

      // Check addon status for all installations
      for (const installation of installations) {
        if (installation.addonInstalled) {
          // Double-check that files are valid
          const filesValid = await AddonManager.validateAddonFiles(installation);
          if (filesValid) {
            installationsWithAddon.push(installation);
          } else {
            console.info(
              `[ArenaCoachDesktop] Addon files invalid for ${installation.path}, needs reinstall`
            );
            installationsNeedingAddon.push(installation);
          }
        } else {
          installationsNeedingAddon.push(installation);
        }
      }

      console.info(
        `[ArenaCoachDesktop] Found ${installationsWithAddon.length} installations with addon, ${installationsNeedingAddon.length} needing addon`
      );

      // Install addon to installations that need it
      for (const installation of installationsNeedingAddon) {
        try {
          console.info(`[ArenaCoachDesktop] Installing ArenaCoach addon to: ${installation.path}`);
          const result = await AddonManager.installAddon(installation);

          if (result.success) {
            console.info(
              `[ArenaCoachDesktop] Successfully installed addon to: ${installation.path}`
            );
          } else {
            console.warn(
              `[ArenaCoachDesktop] Failed to install addon to ${installation.path}: ${result.message}`
            );
            if (result.error) {
              console.warn(`[ArenaCoachDesktop] Error details: ${result.error}`);
            }
          }
        } catch (error) {
          console.error(
            `[ArenaCoachDesktop] Unexpected error installing addon to ${installation.path}:`,
            error
          );
        }
      }

      // Re-resolve installations to reflect addon changes and notify renderer
      try {
        const updatedInstallations = await this.resolveWoWInstallations();
        this.notifyAddonStatusToRenderer(updatedInstallations);
      } catch (error) {
        console.error(
          '[ArenaCoachDesktop] Failed to re-resolve installations after addon install:',
          error
        );
      }

      console.info('[ArenaCoachDesktop] Addon installation check completed');
    } catch (error) {
      console.error('[ArenaCoachDesktop] Failed to check and install addons:', error);
      // Don't throw - allow app to continue even if addon installation fails
    }
  }
  /**
   * Initialize all async services with proper sequencing to prevent race conditions
   * Ensures metadata services exist before event handlers can access them
   */
  private async initializeAsyncServices(): Promise<void> {
    if (this.isQuitting) return; // Prevent re-init during shutdown

    try {
      console.info('[ArenaCoachDesktop] Starting async service initialization...');

      // Step 1: Initialize metadata services FIRST (required by IPC and event handlers)
      await this.initializeMatchMetadataServices();

      // Step 2: Register IPC handlers that depend on metadata storage
      this.setupStorageIPC();

      // Step 3: Initialize other async services
      await this.initializeChunkCleanup();
      this.initializeExpirationTimer();

      // Step 3.5: Handle orphaned matches from previous sessions (Task 2)
      await this.handleOrphanedMatches();

      // Step 4: Initialize match detection (if not in UI dev mode)
      if (!this.isUIDevMode) {
        await this.initializeMatchDetection();
        await this.checkAndInstallAddons();
      }

      // Step 5: ONLY NOW register match detection event handlers
      this.setupMatchDetection();

      // Setup recording service event handlers if available
      if (this.recordingService) {
        this.setupRecordingEvents();
      }

      console.info('[ArenaCoachDesktop] All async services initialized successfully');
    } catch (error) {
      console.error('[ArenaCoachDesktop] Failed to initialize async services:', error);
      // Don't throw - allow app to continue with limited functionality
    }
  }

  /**
   * Create recording service configuration from settings
   * Centralizes config creation to avoid duplication and prepare for future user-configurable settings
   */
  private createRecordingServiceConfig(settings: AppSettings): RecordingServiceConfig {
    return {
      autoStart: true,
      autoStop: true,
      metadataIntegration: true,
      resolution: settings.recording.resolution, // Direct use of Resolution format
      fps: settings.recording.fps,
      bitrate: QUALITY_BITRATE_KBPS_MAP[settings.recording.quality],
      encoder: settings.recording.encoder || 'x264',
      ...(settings.recordingLocation && { outputDir: settings.recordingLocation }),
    };
  }

  /**
   * Initialize all metadata services with proper dependency injection
   * Creates single MetadataStorageService instance and injects it into dependent services
   */
  private async initializeMatchMetadataServices(): Promise<void> {
    try {
      console.info('[ArenaCoachDesktop] Initializing match metadata services...');

      // Get current settings for metadata storage configuration
      const settings = this.settingsService.getSettings();
      const metadataConfig: MetadataStorageServiceConfig = {
        maxFiles: settings.maxMatchFiles,
      };

      // Create single configured MetadataStorageService instance
      this.metadataStorageService = new MetadataStorageService(metadataConfig);
      await this.metadataStorageService.initialize();

      // 1. Storage layer (no dependencies) - already initialized above
      // 2. Settings (already created earlier in setupApp)
      // 3. Metadata layer (depends on storage)
      this.metadataService = new MetadataService(this.metadataStorageService);
      this.analysisEnrichmentService = new AnalysisEnrichmentService(this.metadataStorageService);

      // 4. Recording layer (depends on metadata + settings)
      if (
        !this.isUIDevMode &&
        process.platform === 'win32' &&
        settings.recordingEnabled !== false
      ) {
        try {
          const recordingConfig = this.createRecordingServiceConfig(settings);
          this.recordingService = new RecordingService(
            recordingConfig,
            this.metadataService,
            this.settingsService
          );
          await this.recordingService.initialize();

          // Pass main window for preview
          if (this.mainWindow) {
            this.recordingService.setMainWindow(this.mainWindow);
          }

          // Apply saved recording settings using helper method
          await this.applyPersistedRecordingSettings();

          console.info('[ArenaCoachDesktop] Recording service initialized');
        } catch (error) {
          console.error('[ArenaCoachDesktop] Failed to initialize recording service:', error);
          // Non-critical - continue without recording
          this.recordingService = null;
        }
      } else {
        console.info(
          '[ArenaCoachDesktop] Recording disabled in settings or not supported on this platform'
        );
        this.recordingService = null;
      }

      // 5. Lifecycle orchestrator (depends on metadata + recording)
      this.matchLifecycleService = new MatchLifecycleService(
        this.metadataService,
        this.recordingService ?? null
      );

      // Initialize new decomposed services
      const authToken = this.authManager.getAuthToken();
      const authTokenString = authToken?.accessToken;
      // ApiHeadersProvider is created earlier in setupApp(); ensure it has the latest token
      this.apiHeadersProvider.updateToken(authTokenString);

      // Initialize health check service
      this.serviceHealthCheck = new ServiceHealthCheck(
        this.apiBaseUrl,
        this.apiHeadersProvider,
        ArenaCoachDesktop.JOB_STATUS_ENDPOINT
      );
      this.uploadService = new UploadService(
        this.apiBaseUrl,
        ArenaCoachDesktop.UPLOAD_ENDPOINT,
        this.apiHeadersProvider,
        this.serviceHealthCheck
      );
      this.jobStateStore = new JobStateStore(app.getPath('userData'));

      // Initialize completion polling service
      const pollingConfig: CompletionPollingConfig = {
        apiBaseUrl: this.apiBaseUrl,
        baseIntervalMs: ArenaCoachDesktop.POLLING_INTERVAL_MS,
        ...(authTokenString && { authToken: authTokenString }),
        healthCheck: this.serviceHealthCheck,
      };
      this.completionPollingService = new CompletionPollingService(pollingConfig);

      // Set up event handlers for job queue orchestrator
      // Events flow: JobQueueOrchestrator -> main.ts handlers -> UI/storage updates

      // Initialize job queue orchestrator
      this.jobQueueOrchestrator = new JobQueueOrchestrator(
        this.uploadService,
        this.completionPollingService,
        this.jobStateStore,
        this.apiHeadersProvider
      );

      // Initialize the orchestrator to restore state and set up event forwarding
      await this.jobQueueOrchestrator.initialize();

      // Perform an initial health check to warm internal status (UI update occurs after renderer is ready)
      if (this.serviceHealthCheck) {
        try {
          await this.serviceHealthCheck.checkOnce();
        } catch {
          // Non-fatal – status will reflect current connectivity
        }
      }

      // Start periodic service status updates
      this.startServiceStatusUpdates();

      // Start idle health checks
      this.startIdleHealthChecks();

      // Listen for job tracking changes to manage idle checks
      this.completionPollingService.on('serviceStatusChanged', (status: any) => {
        const hasJobs = status.trackedJobsCount > 0;
        if (hasJobs && this.idleCheckTimer) {
          // Stop idle checks when jobs are being tracked
          this.stopIdleHealthChecks();
        } else if (!hasJobs && !this.idleCheckTimer) {
          // Start idle checks when no jobs are being tracked
          this.startIdleHealthChecks();
        }
      });

      // Pass the JobQueueOrchestrator to the MatchDetectionService
      // This allows it to use our new decomposed services for uploads
      this.matchDetectionService.setJobQueueOrchestrator(this.jobQueueOrchestrator);

      console.info('[ArenaCoachDesktop] Match metadata services initialized successfully');
    } catch (error) {
      console.error('[ArenaCoachDesktop] Failed to initialize match metadata services:', error);
      // Don't throw - allow app to continue without match metadata storage
    }
  }

  /**
   * Initialize chunk cleanup service for managing chunk files
   */
  private async initializeChunkCleanup(): Promise<void> {
    try {
      console.info('[ArenaCoachDesktop] Initializing chunk cleanup service...');

      await this.chunkCleanupService.initialize();

      console.info('[ArenaCoachDesktop] Chunk cleanup service initialized successfully');
    } catch (error) {
      console.error('[ArenaCoachDesktop] Failed to initialize chunk cleanup service:', error);
      // Don't throw - allow app to continue without chunk cleanup
    }
  }

  /**
   * Update match metadata when upload job is created
   */
  private async updateMatchMetadataForUpload(matchHash: string, jobId: string): Promise<void> {
    try {
      await this.metadataStorageService.updateMatchStatus(matchHash, UploadStatus.UPLOADING, {
        jobId,
      });

      console.info('[ArenaCoachDesktop] Updated match metadata for upload:', { matchHash, jobId });

      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('match:statusUpdated', {
          matchHash,
          status: UploadStatus.UPLOADING,
        });
      }
    } catch (error) {
      console.error('[ArenaCoachDesktop] Failed to update match metadata for upload:', error);
    }
  }

  /**
   * Update match metadata to expired status when combat log is too old
   */
  private async updateMatchMetadataToExpired(matchHash: string, bufferId: string): Promise<void> {
    try {
      await this.metadataStorageService.updateMatchStatus(matchHash, UploadStatus.EXPIRED, {
        errorMessage: `Combat log expired (older than ${ExpirationConfig.COMBAT_LOG_EXPIRATION_HOURS} hours)`,
        failedAt: new Date().toISOString(),
      });

      console.info('[ArenaCoachDesktop] Updated match metadata to expired:', matchHash);

      try {
        await this.chunkCleanupService.cleanupChunksForInstance(bufferId);
        console.info(
          '[ArenaCoachDesktop] Cleaned up chunk files for expired match (by bufferId):',
          bufferId
        );
      } catch (cleanupError) {
        console.error(
          `[ArenaCoachDesktop] Failed to cleanup chunks for expired match ${matchHash}:`,
          cleanupError
        );
      }

      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('match:statusUpdated', {
          matchHash,
          status: UploadStatus.EXPIRED,
        });
      }
    } catch (error) {
      console.error('[ArenaCoachDesktop] Failed to update match metadata to expired:', error);
    }
  }

  /**
   * Update authentication token across all services
   */
  private updateAllServicesAuthToken(token?: string): void {
    // Update match detection service
    const tokenString = token ?? '';
    this.matchDetectionService.updateAuthToken(tokenString);

    // Update decomposed services
    if (this.apiHeadersProvider) {
      this.apiHeadersProvider.updateToken(token);
    }
    if (this.completionPollingService) {
      this.completionPollingService.updateAuthToken(token);
    }
  }

  /**
   * Update match metadata to INCOMPLETE status for incomplete matches
   */
  private async updateMatchMetadataToIncomplete(matchHash: string): Promise<void> {
    try {
      await this.metadataStorageService.updateMatchStatus(matchHash, UploadStatus.INCOMPLETE, {
        progressMessage: 'Match incomplete - local only',
        errorMessage: 'Match ended incomplete - preserved for local analysis',
      });

      console.info('[ArenaCoachDesktop] Updated match metadata to incomplete:', matchHash);
      // Notify renderer process that status was updated
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('match:statusUpdated', {
          matchHash,
          status: UploadStatus.INCOMPLETE,
          progressMessage: 'Local only',
        });
      }
    } catch (error) {
      console.error('[ArenaCoachDesktop] Failed to update match metadata to incomplete:', error);
      // Don't throw - this shouldn't break the processing
    }
  }

  /**
   * Validate preview bounds from untrusted renderer process
   * Ensures bounds contain valid, non-negative, finite numbers
   */
  private validatePreviewBounds(bounds: unknown): {
    width: number;
    height: number;
    x: number;
    y: number;
  } {
    // Type check
    if (!bounds || typeof bounds !== 'object') {
      const error = new Error('Invalid preview bounds: must be an object');
      (error as any).code = 'INVALID_PREVIEW_BOUNDS';
      throw error;
    }

    const b = bounds as any;

    // Check required properties exist
    if (!('width' in b) || !('height' in b) || !('x' in b) || !('y' in b)) {
      const error = new Error(
        'Invalid preview bounds: missing required properties (width, height, x, y)'
      );
      (error as any).code = 'INVALID_PREVIEW_BOUNDS';
      throw error;
    }

    // Validate each property
    const { width, height, x, y } = b;

    // Check all are numbers
    if (
      typeof width !== 'number' ||
      typeof height !== 'number' ||
      typeof x !== 'number' ||
      typeof y !== 'number'
    ) {
      const error = new Error('Invalid preview bounds: all properties must be numbers');
      (error as any).code = 'INVALID_PREVIEW_BOUNDS';
      throw error;
    }

    // Check all are finite
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      const error = new Error('Invalid preview bounds: all properties must be finite numbers');
      (error as any).code = 'INVALID_PREVIEW_BOUNDS';
      throw error;
    }

    // Check non-negative
    if (x < 0 || y < 0) {
      const error = new Error('Invalid preview bounds: x and y must be non-negative');
      (error as any).code = 'INVALID_PREVIEW_BOUNDS';
      throw error;
    }

    // Check positive dimensions
    if (width <= 0 || height <= 0) {
      const error = new Error('Invalid preview bounds: width and height must be positive');
      (error as any).code = 'INVALID_PREVIEW_BOUNDS';
      throw error;
    }

    // Sanity check for reasonable bounds (prevent memory issues)
    const MAX_DIMENSION = 10000;
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      const error = new Error(
        `Invalid preview bounds: dimensions exceed maximum (${MAX_DIMENSION}px)`
      );
      (error as any).code = 'INVALID_PREVIEW_BOUNDS';
      throw error;
    }

    return { width, height, x, y };
  }

  /**
   * Start periodic service status updates to frontend
   */
  private startServiceStatusUpdates(): void {
    // Clear any existing interval for idempotency
    if (this.serviceStatusTimerId) {
      clearInterval(this.serviceStatusTimerId);
      this.serviceStatusTimerId = null;
    }

    // Send initial status
    this.sendServiceStatus();

    // Send updates periodically
    this.serviceStatusTimerId = setInterval(() => {
      this.sendServiceStatus();
    }, ArenaCoachDesktop.SERVICE_STATUS_INTERVAL_MS);
  }

  /**
   * Send current service status to frontend
   */
  private sendServiceStatus(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    try {
      const isAvailable = this.serviceHealthCheck?.isServiceAvailable() ?? false;
      const pollingStats = this.completionPollingService?.getPollingStats();
      const hasAuth = this.apiHeadersProvider?.hasAuth() ?? false;

      this.mainWindow.webContents.send('service:statusChanged', {
        connected: isAvailable,
        trackedJobsCount: pollingStats?.trackedJobsCount ?? 0,
        hasAuth,
      });
    } catch (error) {
      console.error('[ArenaCoachDesktop] Failed to send service status:', error);
    }
  }

  /**
   * Update match metadata when analysis fails or times out
   */
  private async updateMatchMetadataForFailure(
    matchHash: string,
    errorMessage: string,
    isNotFound?: boolean,
    errorCode?: string,
    isPermanent?: boolean
  ): Promise<void> {
    try {
      const status = isNotFound ? UploadStatus.NOT_FOUND : UploadStatus.FAILED;

      console.info('[ArenaCoachDesktop] Updating match metadata for failure:', {
        matchHash,
        errorMessage,
        isNotFound,
        errorCode,
        isPermanent,
        status,
      });

      await this.metadataStorageService.updateMatchStatus(matchHash, status, {
        errorMessage,
        ...(errorCode !== undefined && { errorCode }),
        ...(isPermanent !== undefined && { isPermanent }),
        failedAt: new Date().toISOString(),
      });

      console.info('[ArenaCoachDesktop] Successfully updated match metadata for failure:', {
        matchHash,
        errorMessage,
        errorCode,
        status,
      });

      // Signal renderer to refresh UI after metadata is persisted
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('match:metadataUpdated', { matchHash });
      }
    } catch (error) {
      console.error('[ArenaCoachDesktop] Failed to update match metadata for failure:', error);
    }
  }

  /**
   * Clean up chunk files after successful analysis completion
   */
  private async cleanupChunksAfterAnalysis(jobId: string): Promise<void> {
    try {
      // Find the match metadata to get the bufferId
      const existingMatch = await this.metadataStorageService.findMatchByJobId(jobId);

      if (existingMatch && existingMatch.bufferId) {
        const bufferId = existingMatch.bufferId;

        console.info('[ArenaCoachDesktop] Initiating chunk cleanup for successful analysis:', {
          bufferId,
          jobId,
        });

        // Clean up chunk files for this instance
        await this.chunkCleanupService.cleanupChunksForInstance(bufferId, jobId);

        console.info('[ArenaCoachDesktop] Chunk cleanup completed for instance:', bufferId);
      } else {
        console.warn(
          '[ArenaCoachDesktop] Cannot cleanup chunks: No bufferId found for jobId:',
          jobId
        );
      }
    } catch (error) {
      console.error('[ArenaCoachDesktop] Failed to cleanup chunks after analysis:', {
        jobId,
        error: (error as Error).message,
      });
      // Don't throw - chunk cleanup failure shouldn't break the analysis pipeline
    }
  }

  /**
   * Clean up chunk files for terminal failures (expired, not found)
   * Preserves chunks for retryable failures to enable re-uploads
   */
  private async cleanupChunksForTerminalFailure(
    jobId: string,
    matchHash: string,
    isNotFound?: boolean
  ): Promise<void> {
    // Only cleanup chunks for terminal failure types that shouldn't be retried
    const shouldCleanup = isNotFound === true; // NOT_FOUND status (job doesn't exist on server)

    if (!shouldCleanup) {
      console.debug(
        '[ArenaCoachDesktop] Preserving chunk files for potentially retryable failure:',
        {
          matchHash,
          jobId,
          isNotFound,
          reason: 'failure may be retryable',
        }
      );
      return;
    }

    try {
      console.info('[ArenaCoachDesktop] Initiating chunk cleanup for terminal failure:', {
        matchHash,
        jobId,
        failureType: isNotFound ? 'NOT_FOUND' : 'OTHER',
      });

      const existingMatch = await this.metadataStorageService.findMatchByJobId(jobId);
      if (existingMatch?.bufferId) {
        await this.chunkCleanupService.cleanupChunksForInstance(existingMatch.bufferId, jobId);
      } else {
        console.warn(
          '[ArenaCoachDesktop] Cannot cleanup chunks: No bufferId found for jobId:',
          jobId
        );
      }

      console.info('[ArenaCoachDesktop] Chunk cleanup completed for terminal failure:', matchHash);
    } catch (error) {
      console.error('[ArenaCoachDesktop] Failed to cleanup chunks for terminal failure:', {
        jobId,
        matchHash,
        isNotFound,
        error: (error as Error).message,
      });
      // Don't throw - chunk cleanup failure shouldn't break the analysis pipeline
    }
  }

  /**
   * Initialize periodic expiration timer for automatic cleanup
   */
  private initializeExpirationTimer(): void {
    try {
      console.info('[ArenaCoachDesktop] Initializing periodic expiration timer');

      this.expirationTimerId = setInterval(async () => {
        // Prevent overlapping executions
        if (this.isCheckingExpiration) {
          console.info(
            '[ArenaCoachDesktop] Expiration check is already running. Skipping this interval.'
          );
          return;
        }

        this.isCheckingExpiration = true;
        try {
          await this.performPeriodicExpirationCheck();
        } catch (error) {
          // Error is already logged inside performPeriodicExpirationCheck
        } finally {
          this.isCheckingExpiration = false;
        }
      }, ArenaCoachDesktop.EXPIRATION_CHECK_INTERVAL_MS);

      console.info(
        `[ArenaCoachDesktop] Expiration timer started (runs every ${ArenaCoachDesktop.EXPIRATION_CHECK_INTERVAL_MS / 60000} minutes)`
      );
    } catch (error) {
      console.error('[ArenaCoachDesktop] Failed to initialize expiration timer:', error);
      // Don't throw - app should continue without the timer
    }
  }

  /**
   * Perform periodic check for expired metadata files and mark them as expired
   * This handles cases where users don't log in to trigger expiration checks
   */
  private async performPeriodicExpirationCheck(): Promise<void> {
    try {
      console.info('[ArenaCoachDesktop] Starting periodic expiration check');

      // Find all expired matches by scanning metadata files
      const expiredMatchHashes = await this.findExpiredMatches();

      if (expiredMatchHashes.length === 0) {
        console.info('[ArenaCoachDesktop] No expired matches found during periodic check');
        return;
      }

      console.info(
        `[ArenaCoachDesktop] Found ${expiredMatchHashes.length} expired matches during periodic check`
      );

      // Process each expired match using matchHash directly
      const processPromises = expiredMatchHashes.map(async matchHash => {
        try {
          await this.metadataStorageService.updateMatchStatus(matchHash, UploadStatus.EXPIRED);
          return { matchHash, success: true };
        } catch (error) {
          console.error(
            `[ArenaCoachDesktop] Failed to expire match during periodic check: ${matchHash}`,
            error
          );
          return { matchHash, success: false, error: (error as Error).message };
        }
      });

      // Use Promise.allSettled to handle failures gracefully
      const results = await Promise.allSettled(processPromises);
      const successCount = results.filter(r => r.status === 'fulfilled').length;
      const failureCount = results.filter(r => r.status === 'rejected').length;

      console.info('[ArenaCoachDesktop] Periodic expiration check completed:', {
        totalMatches: expiredMatchHashes.length,
        successCount,
        failureCount,
      });

      // NEW: Check for orphaned chunk files (chunks without corresponding metadata)
      try {
        console.info('[ArenaCoachDesktop] Starting orphaned chunk detection');

        // Get all valid bufferIds from metadata service
        const allMatches = await this.metadataStorageService.listMatches(10000, 0); // Get large batch to cover all matches
        const validBufferIds = new Set(allMatches.map(match => match.bufferId!).filter(Boolean));

        console.debug(
          `[ArenaCoachDesktop] Found ${validBufferIds.size} valid bufferIds in metadata`
        );

        // Find orphaned chunks
        const orphanedChunks = await this.chunkCleanupService.findOrphanedChunks(validBufferIds);

        if (orphanedChunks.length > 0) {
          console.warn(
            `[ArenaCoachDesktop] Found ${orphanedChunks.length} orphaned chunk files. Cleaning up.`
          );

          // Clean up orphaned chunks
          const cleanupResult = await this.chunkCleanupService.cleanupFiles(orphanedChunks);

          console.info('[ArenaCoachDesktop] Orphaned chunk cleanup completed:', {
            totalOrphanedChunks: orphanedChunks.length,
            successCount: cleanupResult.successCount,
            failureCount: cleanupResult.failureCount,
          });
        } else {
          console.debug('[ArenaCoachDesktop] No orphaned chunk files found');
        }
      } catch (orphanError) {
        console.error('[ArenaCoachDesktop] Failed during orphaned chunk cleanup:', orphanError);
        // Don't throw - this is a bonus cleanup, shouldn't break the main expiration logic
      }
    } catch (error) {
      console.error('[ArenaCoachDesktop] Failed during periodic expiration check:', error);
      // Don't throw - timer should continue running
    }
  }

  /**
   * Handle orphaned matches from previous application sessions (Task 2)
   * Transitions stale 'in_progress' matches to 'incomplete' status after app crashes
   */
  private async handleOrphanedMatches(): Promise<void> {
    try {
      console.info('[ArenaCoachDesktop] Starting orphaned match detection and cleanup...');

      if (!this.metadataStorageService) {
        console.warn(
          '[ArenaCoachDesktop] Metadata storage service not available - skipping orphaned match handling'
        );
        return;
      }

      // Get all matches to identify stale in_progress states
      const allMatches = await this.metadataStorageService.listMatches(1000, 0);
      const currentTime = Date.now();
      const ORPHAN_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes since last update

      let processedCount = 0;
      let transitionedCount = 0;

      for (const match of allMatches) {
        // Use hash or bufferId for logging
        const idForLog = match.matchHash || match.bufferId || 'unknown';

        const lastUpdateTime = match.lastUpdatedAt?.getTime() || match.createdAt?.getTime() || 0;
        const timeSinceUpdate = currentTime - lastUpdateTime;

        // Only handle stale 'in_progress' matches - app crashed during active match detection
        if (
          match.matchCompletionStatus === 'in_progress' &&
          timeSinceUpdate > ORPHAN_THRESHOLD_MS
        ) {
          try {
            // Transition to incomplete - match was interrupted by crash
            const updatedMetadata = { ...match };
            updatedMetadata.matchCompletionStatus = 'incomplete';
            updatedMetadata.uploadStatus = UploadStatus.INCOMPLETE;
            updatedMetadata.enrichmentPhase = 'finalized';
            updatedMetadata.errorMessage =
              'Recovered after crash: match incomplete after app restart';
            updatedMetadata.lastUpdatedAt = new Date();

            await this.metadataStorageService.saveMatch(updatedMetadata);

            console.info(
              `[ArenaCoachDesktop] Transitioned stale match to incomplete: ${idForLog} (stale for ${Math.round(timeSinceUpdate / 60000)} minutes)`
            );
            transitionedCount++;
          } catch (error) {
            console.error(
              `[ArenaCoachDesktop] Failed to transition orphaned match ${idForLog}:`,
              error
            );
          }
        }

        processedCount++;
      }

      if (transitionedCount === 0) {
        console.info(
          `[ArenaCoachDesktop] No orphaned matches found (scanned ${processedCount} matches)`
        );
      } else {
        console.info(
          `[ArenaCoachDesktop] Orphaned match cleanup completed: ${transitionedCount}/${processedCount} matches transitioned to incomplete`
        );
      }
    } catch (error) {
      console.error('[ArenaCoachDesktop] Error during orphaned match handling:', error);
      // Don't throw - allow app startup to continue
    }
  }

  /**
   * Find expired matches by scanning metadata files
   * Returns array of matchHashes that need to be marked as expired
   */
  private async findExpiredMatches(): Promise<string[]> {
    try {
      // Get paginated matches to avoid loading everything into memory
      const batchSize = 100;
      let offset = 0;
      const expiredMatchHashes: string[] = [];
      const currentTime = Date.now();

      while (true) {
        const matches = await this.metadataStorageService.listMatches(batchSize, offset);

        if (matches.length === 0) {
          break; // No more matches
        }

        // Check each match for expiration
        for (const match of matches) {
          // Skip if already expired or has no timestamp
          if (match.uploadStatus === UploadStatus.EXPIRED || !match.matchData.timestamp) {
            continue;
          }

          // Check if match is expired using centralized config
          const timestampMs = match.matchData.timestamp.getTime();
          if (ExpirationConfig.isExpired(timestampMs, currentTime) && match.matchHash) {
            expiredMatchHashes.push(match.matchHash); // Return matchHash for consistent downstream usage
          }
        }

        // Move to next batch
        offset += batchSize;

        // If we got fewer matches than batch size, we've reached the end
        if (matches.length < batchSize) {
          break;
        }
      }

      return expiredMatchHashes;
    } catch (error) {
      console.error('[ArenaCoachDesktop] Failed to find expired matches:', error);
      return []; // Return empty array on error
    }
  }

  /**
   * Start idle health checks when no jobs are being tracked
   */
  private startIdleHealthChecks(): void {
    // Only start if not already running
    if (this.idleCheckTimer) {
      return;
    }

    console.info('[ArenaCoachDesktop] Starting idle health checks:', {
      interval: ArenaCoachDesktop.IDLE_CHECK_INTERVAL_MS / 1000,
    });

    // Perform immediate check
    this.performIdleHealthCheck();

    // Schedule periodic checks
    this.idleCheckTimer = setInterval(() => {
      this.performIdleHealthCheck();
    }, ArenaCoachDesktop.IDLE_CHECK_INTERVAL_MS);
  }

  /**
   * Stop idle health checks
   */
  private stopIdleHealthChecks(): void {
    if (this.idleCheckTimer) {
      console.info('[ArenaCoachDesktop] Stopping idle health checks');
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }
    // Also stop recovery timer if running
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  /**
   * Perform a single idle health check
   */
  private async performIdleHealthCheck(): Promise<void> {
    // Only check if no jobs are being tracked
    const trackedJobs = this.completionPollingService?.getPollingStats().trackedJobsCount || 0;
    if (trackedJobs > 0) {
      console.debug(
        '[ArenaCoachDesktop] Skipping idle check - jobs are being tracked:',
        trackedJobs
      );
      return;
    }

    try {
      console.debug('[ArenaCoachDesktop] Performing idle health check');
      const isAvailable = await this.serviceHealthCheck.checkOnce();
      console.debug('[ArenaCoachDesktop] Idle health check result:', isAvailable);

      // Push status immediately so UI updates
      this.sendServiceStatus();

      // If disconnected, start fast recovery loop (5s intervals)
      if (!isAvailable && !this.recoveryTimer) {
        console.info('[ArenaCoachDesktop] Service disconnected - starting recovery loop');
        this.recoveryTimer = setInterval(async () => {
          await this.serviceHealthCheck.checkOnce();
          this.sendServiceStatus();

          if (this.serviceHealthCheck.isServiceAvailable()) {
            console.info('[ArenaCoachDesktop] Service recovered');
            clearInterval(this.recoveryTimer!);
            this.recoveryTimer = null;
          }
        }, 5000);
      } else if (isAvailable && this.recoveryTimer) {
        // Clean up recovery timer if service is back
        clearInterval(this.recoveryTimer);
        this.recoveryTimer = null;
      }
    } catch (error) {
      console.warn('[ArenaCoachDesktop] Idle health check failed:', error);
    }
  }
}

// Single-instance enforcement: only one ArenaCoachDesktop process per user
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  log.info('[ArenaCoachDesktop] Another instance is already running - exiting');
  app.quit();
} else {
  const desktopApp = new ArenaCoachDesktop();

  app.on('second-instance', (_event, commandLine, workingDirectory) => {
    desktopApp.handleSecondInstance(commandLine, workingDirectory);
  });
}
