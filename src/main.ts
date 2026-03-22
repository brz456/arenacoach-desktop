import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Menu,
  shell,
  Tray,
  powerMonitor,
  screen,
} from 'electron';
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
import { activeFlavor } from './config/wowFlavor';
import { AuthManager, AuthConfig } from './authManager';
import type { AuthToken, UserInfo } from './authTypes';
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
import { LogExportService, LogExportResult } from './services/LogExportService';
import {
  SettingsService,
  AppSettings,
  WindowBounds,
  MIN_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
} from './services/SettingsService';
import { getEffectiveRecordingDirectory } from './utils/recordingPathUtils';
import { AppError, isAppError, isNodeError } from './utils/errors';
import { isValidBufferId } from './utils/bufferId';
import { toSafeAxiosErrorLog } from './utils/errorRedaction';
import type { RevealResult, RecordingInfoResult } from './ipc/ipcTypes';
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
import { UploadStatus, StoredMatchMetadata } from './match-detection/types/StoredMatchTypes';
import {
  MatchStartedEvent,
  MatchEndedEvent,
  MatchEventType,
} from './match-detection/types/MatchEvent';
import type { MatchEndedIncompleteEvent } from './match-detection/types/MatchEvent';
import { EarlyEndTrigger, getTriggerMessage } from './match-detection/types/EarlyEndTriggers';
import { isCombatLogExpiredError } from './match-detection/types/PipelineErrors';
import type { JobRetryPayload } from './match-detection/types/JobRetryPayload';
import { MatchProcessedPayload } from './match-detection/MatchDetectionOrchestrator';
import {
  WoWProcessMonitorError,
  getErrorDetails,
} from './process-monitoring/WoWProcessMonitorErrors';
import { ExpirationConfig } from './config/ExpirationConfig';
import { ChunkRetentionConfig } from './config/ChunkRetentionConfig';
import { FreemiumQuotaFields } from './Freemium';
import { inferEncoderTypeFromId } from './services/obs/encoderResolver';

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
  isPremiumViewer?: boolean;
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

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

// Set the app name for userData directory (changes %APPDATA%/Electron to %APPDATA%/arenacoach-desktop)
app.setName('arenacoach-desktop');

/**
 * Validates and normalizes a file path from IPC boundary.
 * Checks: type, length, null bytes, absolute path.
 * NOTE: Does NOT enforce containment - caller must verify path is within allowed directories.
 */
function validateFilePath(filePath: unknown): string {
  if (typeof filePath !== 'string') {
    throw new Error('Invalid input: file path must be a string');
  }

  if (filePath.length === 0 || filePath.length > 1000) {
    throw new Error('Invalid input: file path must be 1-1000 characters');
  }

  // Reject null bytes (path injection)
  if (filePath.includes('\x00')) {
    throw new Error('Invalid input: path contains null bytes');
  }

  const normalizedPath = path.normalize(filePath);

  // Ensure path is absolute (required for containment checks)
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
  private static readonly IDLE_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes for idle health checks
  private static readonly RECORDING_RECOVERY_DELAY_MS = 2000;
  private static readonly RECORDING_RECOVERY_MAX_ATTEMPTS = 3;

  // Non-terminal upload statuses: matches in these states should not be deleted and may be expired
  private static readonly NON_TERMINAL_UPLOAD_STATUSES = new Set([
    UploadStatus.PENDING,
    UploadStatus.UPLOADING,
    UploadStatus.QUEUED,
    UploadStatus.PROCESSING,
  ]);

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
  private logExportService: LogExportService;

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
  private recordingRecoveryAttemptsThisSession: number = 0;
  private recordingRecoveryDisabledForSession: boolean = false;
  private pendingRecordingRecovery: { requestedAt: number; attempts: number } | null = null;
  private recordingRecoveryTimeoutId: NodeJS.Timeout | null = null;

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
    };
    this.authManager = new AuthManager(authConfig);

    // Initialize settings service FIRST (needed for matchDetectionConfig)
    this.settingsService = new SettingsService();

    // Initialize match detection service (replaces old CombatLogWatcher)
    const matchDetectionConfig: MatchDetectionServiceConfig = {
      apiBaseUrl: this.apiBaseUrl,
      enableWoWProcessMonitoring: !this.isUIDevMode,
      isSkirmishTrackingEnabled: () =>
        this.settingsService.getSettings().enabledBrackets.skirmish !== false,
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

    // Initialize log export service for debug data export
    this.logExportService = new LogExportService();

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
    if (this.settingsService.getSettings().recordingEnabled === false) return;
    if (reason === 'error') {
      if (this.matchDetectionService.getCurrentMatch()) return;
      if (this.ongoingFinalizations.size > 0) return;
    }
    // Debounce to once per 60s
    const now = Date.now();
    if (reason === 'resume' && now - this.lastRecordingRecoveryAt < 60000) return;

    this.isRecoveringRecording = true;
    this.lastRecordingRecoveryAt = now;
    console.info(`[Main] Recovering recording service due to ${reason}...`);

    try {
      const status = await this.recordingService.getStatus();
      // If actively recording, perform only a soft refresh to avoid disruption
      if (status.isRecording) {
        const applyResult = await this.applyPersistedRecordingSettings();
        if (applyResult.success) {
          console.info('[Main] Soft-refreshed recording settings during active recording');
        } else {
          console.warn('[Main] Soft-refresh settings failed during recording:', applyResult.error);
        }
      } else if (!status.isInitialized) {
        await this.recordingService.initialize();
        if (this.mainWindow) {
          this.recordingService.setMainWindow(this.mainWindow);
        }
        const applyResult = await this.applyPersistedRecordingSettings();
        if (applyResult.success) {
          console.info('[Main] Recording service reinitialized');
        } else {
          console.warn(
            '[Main] Recording reinitialized but settings apply failed:',
            applyResult.error
          );
        }
      } else {
        // Soft-refresh settings to ensure sources are valid after resume
        const applyResult = await this.applyPersistedRecordingSettings();
        if (!applyResult.success) {
          console.warn('[Main] Soft-refresh settings failed:', applyResult.error);
        }
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
          const applyResult = await this.applyPersistedRecordingSettings();
          if (applyResult.success) {
            console.info('[Main] Recording service fully restarted');
          } else {
            console.warn(
              '[Main] Recording restarted but settings apply failed:',
              applyResult.error
            );
          }
        } else {
          console.info('[Main] Skipping restart while recording; will rely on soft refresh');
        }
      } catch (e2) {
        console.error('[Main] Full recording service restart failed:', e2);
      }
    } finally {
      this.isRecoveringRecording = false;
      if (reason === 'resume') {
        this.flushPendingRecordingRecovery('retry');
      }
    }
  }

  private clearRecordingRecoveryState(): void {
    if (this.recordingRecoveryTimeoutId) {
      clearTimeout(this.recordingRecoveryTimeoutId);
      this.recordingRecoveryTimeoutId = null;
    }
    this.pendingRecordingRecovery = null;
  }

  private requestRecordingRecoveryDueToFatalObsIpc(error: Error): void {
    if (!this.recordingService) return;
    if (this.settingsService.getSettings().recordingEnabled === false) return;
    if (this.recordingRecoveryDisabledForSession) return;
    if (
      this.recordingRecoveryAttemptsThisSession >=
      ArenaCoachDesktop.RECORDING_RECOVERY_MAX_ATTEMPTS
    ) {
      this.recordingRecoveryDisabledForSession = true;
      this.clearRecordingRecoveryState();
      return;
    }

    if (!this.pendingRecordingRecovery) {
      this.pendingRecordingRecovery = { requestedAt: Date.now(), attempts: 0 };
      console.warn('[Main] Fatal OBS IPC error detected; recording recovery requested', error);
    }

    this.flushPendingRecordingRecovery('obsError');
  }

  private flushPendingRecordingRecovery(
    context: 'obsError' | 'matchEnded' | 'matchEndedIncomplete' | 'retry'
  ): void {
    if (!this.pendingRecordingRecovery) return;
    if (!this.recordingService) {
      this.clearRecordingRecoveryState();
      return;
    }
    if (this.isQuitting) return;
    if (this.settingsService.getSettings().recordingEnabled === false) {
      this.clearRecordingRecoveryState();
      return;
    }
    if (this.recordingRecoveryDisabledForSession) {
      this.clearRecordingRecoveryState();
      return;
    }
    if (this.matchDetectionService.getCurrentMatch()) return;
    if (this.ongoingFinalizations.size > 0) return;
    if (this.recordingRecoveryTimeoutId) {
      if (context === 'matchEnded' || context === 'matchEndedIncomplete') {
        clearTimeout(this.recordingRecoveryTimeoutId);
        this.recordingRecoveryTimeoutId = null;
      } else {
        return;
      }
    }

    if (
      this.recordingRecoveryAttemptsThisSession >=
      ArenaCoachDesktop.RECORDING_RECOVERY_MAX_ATTEMPTS
    ) {
      const pendingAgeMs = Date.now() - this.pendingRecordingRecovery.requestedAt;
      console.warn('[Main] Recording recovery max attempts reached; leaving recording disabled', {
        attempts: this.recordingRecoveryAttemptsThisSession,
        pendingAttempts: this.pendingRecordingRecovery.attempts,
        pendingAgeMs,
      });
      this.pendingRecordingRecovery = null;
      this.recordingRecoveryDisabledForSession = true;
      return;
    }

    const delayMs =
      context === 'matchEnded' || context === 'matchEndedIncomplete'
        ? 0
        : ArenaCoachDesktop.RECORDING_RECOVERY_DELAY_MS;

    this.recordingRecoveryTimeoutId = setTimeout(() => {
      void (async () => {
        this.recordingRecoveryTimeoutId = null;

        if (!this.pendingRecordingRecovery) return;
        if (!this.recordingService) {
          this.pendingRecordingRecovery = null;
          return;
        }
        if (this.isQuitting) return;
        if (this.settingsService.getSettings().recordingEnabled === false) {
          this.pendingRecordingRecovery = null;
          return;
        }
        if (this.recordingRecoveryDisabledForSession) {
          this.pendingRecordingRecovery = null;
          return;
        }
        if (this.matchDetectionService.getCurrentMatch()) return;
        if (this.ongoingFinalizations.size > 0) return;
        if (this.isRecoveringRecording) return;

        this.pendingRecordingRecovery.attempts += 1;
        this.recordingRecoveryAttemptsThisSession += 1;
        try {
          await this.recoverRecordingService('error');
        } catch (recoveryError) {
          console.error('[Main] Recording recovery attempt failed:', recoveryError);
        }

        if (!this.recordingService) return;

        try {
          const status = await this.recordingService.getStatus();
          if (status.isInitialized && status.isEnabled) {
            this.pendingRecordingRecovery = null;
            return;
          }
        } catch (statusError) {
          console.warn('[Main] Recording recovery status check failed:', statusError);
        }

        this.flushPendingRecordingRecovery('retry');
      })().catch(unexpectedError => {
        console.error('[Main] Unexpected error in recording recovery scheduler:', unexpectedError);
      });
    }, delayMs);
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
          this.checkUpdateState().catch(error => {
            // Log only - autoUpdater.on('error') is the canonical emission path
            console.error('Update check failed:', error);
          });
        });
      });

      // Check for updates every 4 hours
      this.updateIntervalId = setInterval(
        () => {
          // Use checkUpdateState for consistent error handling
          // Errors are emitted via autoUpdater.on('error') - just prevent unhandled rejection here
          this.checkUpdateState().catch(error => {
            console.error('Periodic update check failed:', error);
          });
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
    // Check if update is already downloaded and ready
    // If so, show banner immediately; otherwise check for new updates
    const result = await autoUpdater.checkForUpdatesAndNotify();

    // Note: autoUpdater.checkForUpdatesAndNotify() will trigger the appropriate events:
    // - If update already downloaded: 'update-downloaded' event fires
    // - If new update available: 'update-available' -> download -> 'update-downloaded'
    // - If no updates: 'update-not-available' event fires
    // - On error: 'error' event fires (already wired to emit 'updater:error' to renderer)

    console.info('Update check completed:', result);
  }

  private createMainWindow(): void {
    // Get saved window bounds (defaults to optimal first-run size from DEFAULT_SETTINGS)
    const savedBounds = this.settingsService.getWindowBounds();

    // Normalize bounds to fit within OS work area
    const safeBounds = this.getSafeWindowBounds(savedBounds);

    // Create the browser window (Windows frameless)
    this.mainWindow = new BrowserWindow({
      ...safeBounds, // Use normalized position and size
      // Never set a minimum larger than the current safe window size (small displays)
      minWidth: Math.min(MIN_WINDOW_WIDTH, safeBounds.width),
      minHeight: Math.min(MIN_WINDOW_HEIGHT, safeBounds.height),
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

    // Handle window close - minimize to tray or quit based on setting
    this.mainWindow.on('close', event => {
      if (!this.isQuitting) {
        const settings = this.settingsService.getSettings();
        if (settings.minimizeToTray) {
          event.preventDefault();
          this.mainWindow?.hide();
        } else {
          // Hide window immediately then quit (same behavior as tray Exit)
          this.mainWindow?.hide();
          app.quit();
        }
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

  /**
   * Normalize window bounds to fit within the OS work area.
   * Prevents windows from landing behind taskbar or off-screen.
   */
  private getSafeWindowBounds(rawBounds: WindowBounds): Electron.Rectangle {
    const minWidth = MIN_WINDOW_WIDTH;
    const minHeight = MIN_WINDOW_HEIGHT;

    // Determine target display using rawBounds position, fallback to primary
    let display: Electron.Display;
    if (rawBounds.x !== undefined && rawBounds.y !== undefined) {
      display = screen.getDisplayMatching({
        x: rawBounds.x,
        y: rawBounds.y,
        width: rawBounds.width,
        height: rawBounds.height,
      });
    } else {
      display = screen.getPrimaryDisplay();
    }

    const workArea = display.workArea;

    // Clamp dimensions (never exceed work area; degrade gracefully on small displays)
    const width = Math.min(workArea.width, Math.max(minWidth, rawBounds.width));
    const height = Math.min(workArea.height, Math.max(minHeight, rawBounds.height));

    // Clamp position if provided, otherwise center in work area
    let x: number;
    let y: number;
    if (rawBounds.x !== undefined && rawBounds.y !== undefined) {
      x = Math.max(workArea.x, Math.min(rawBounds.x, workArea.x + workArea.width - width));
      y = Math.max(workArea.y, Math.min(rawBounds.y, workArea.y + workArea.height - height));
    } else {
      x = workArea.x + Math.floor((workArea.width - width) / 2);
      y = workArea.y + Math.floor((workArea.height - height) / 2);
    }

    return { x, y, width, height };
  }

  private saveWindowBounds(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    // Use getNormalBounds() when maximized/fullscreen to avoid persisting maximized geometry
    let bounds: Electron.Rectangle;
    if (this.mainWindow.isMaximized() || this.mainWindow.isFullScreen()) {
      bounds = this.mainWindow.getNormalBounds();
    } else {
      bounds = this.mainWindow.getBounds();
    }

    // Clamp to minimums to prevent schema validation errors
    const clampedBounds = {
      x: bounds.x,
      y: bounds.y,
      width: Math.max(MIN_WINDOW_WIDTH, bounds.width),
      height: Math.max(MIN_WINDOW_HEIGHT, bounds.height),
    };
    this.settingsService.saveWindowBounds(clampedBounds);
  }

  /**
   * Get the effective recording directory based on settings.
   * Delegates to SSoT function from utils/recordingPathUtils.
   */
  private getRecordingDirectoryFromSettings(): string {
    const settings = this.settingsService.getSettings();
    return getEffectiveRecordingDirectory(settings.recordingLocation, app.getPath('videos'));
  }

  /**
   * Reveal a file in the OS file manager (Explorer/Finder) with security validation.
   * Only allows paths under userData/logs or downloads.
   * Uses realpath to prevent symlink escape attacks.
   * Accepts unknown for safe IPC boundary handling.
   *
   * NOTE: Recordings must use ID-based IPC handlers (recording:revealVideoInFolder,
   * recording:revealThumbnailInFolder) which resolve paths from metadata in main process.
   *
   * Throws errors with structured codes:
   * - INVALID_PATH: Input validation failed (type, length, null bytes, not absolute)
   * - NOT_FOUND: File doesn't exist or is inaccessible
   * - NOT_ALLOWED: Path is outside allowed directories
   * - OPEN_FAILED: shell.showItemInFolder threw (rare)
   *
   * Note: Electron's shell.showItemInFolder returns void, so "success" means no exception
   * was thrown, not a guarantee the file manager opened. This is an Electron API limitation.
   */
  private async revealFileInFolder(filePath: unknown): Promise<void> {
    // Use shared validator for type, length, null bytes, and absolute path checks
    let validatedPath: string;
    try {
      validatedPath = validateFilePath(filePath);
    } catch (error) {
      throw new AppError(error instanceof Error ? error.message : 'Invalid path', 'INVALID_PATH');
    }

    // Resolve symlinks to get canonical path (also verifies file exists)
    let realPath: string;
    try {
      realPath = await fs.realpath(validatedPath);
    } catch {
      throw new AppError('File not found or inaccessible', 'NOT_FOUND');
    }

    // Build allowlist: userData/logs, downloads only
    // Recordings use ID-based reveal handlers (recording:revealVideoInFolder, recording:revealThumbnailInFolder)
    const userDataLogsPath = path.join(app.getPath('userData'), 'logs');
    const downloadsPath = app.getPath('downloads');

    const rootCandidates = [userDataLogsPath, downloadsPath];

    // Safe "is under directory" check using path.relative
    // On Windows, normalize case for comparison (paths are case-insensitive)
    const isWindows = process.platform === 'win32';
    const normCase = (p: string) => (isWindows ? p.toLowerCase() : p);

    const isUnderRoot = (target: string, root: string): boolean => {
      const relative = path.relative(normCase(root), normCase(target));
      return !relative.startsWith('..') && !path.isAbsolute(relative);
    };

    // Resolve roots to canonical paths as well
    // Only fall back to path.resolve for ENOENT (directory doesn't exist yet);
    // fail closed on permission errors or other unexpected failures
    const resolveRoot = async (p: string): Promise<string> => {
      try {
        return await fs.realpath(p);
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          // Root may not exist yet (e.g., logs dir not created) - use resolved path
          return path.resolve(p);
        }
        // Permission denied, invalid path, or other errors - fail closed
        throw new AppError(`Cannot resolve allowed root: ${p}`, 'NOT_ALLOWED');
      }
    };

    const allowedRoots = await Promise.all(rootCandidates.map(resolveRoot));
    const isAllowed = allowedRoots.some(root => isUnderRoot(realPath, root));

    if (!isAllowed) {
      throw new AppError('Path not in allowed directory', 'NOT_ALLOWED');
    }

    // shell.showItemInFolder is sync and returns void; wrap for any unexpected throws
    try {
      shell.showItemInFolder(realPath);
    } catch {
      throw new AppError('Failed to open file explorer', 'OPEN_FAILED');
    }
  }

  /**
   * Apply persisted recording settings to the recording service
   * Centralizes the logic for applying saved settings, avoiding code duplication
   * @returns Explicit result so callers can handle failures deterministically
   */
  private async applyPersistedRecordingSettings(): Promise<{ success: boolean; error?: string }> {
    if (!this.recordingService) {
      const error = 'RecordingService not initialized';
      console.warn('[ArenaCoachDesktop] Cannot apply recording settings:', error);
      return { success: false, error };
    }

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

    try {
      const success = await this.recordingService.applyRecordingSettings(settings);
      if (success) {
        console.info('[ArenaCoachDesktop] Applied persisted recording settings');
        return { success: true };
      } else {
        const error = 'Recording service rejected settings (disabled or fatal error)';
        console.warn('[ArenaCoachDesktop] Failed to apply persisted recording settings:', error);
        return { success: false, error };
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown error applying settings';
      console.error('[ArenaCoachDesktop] Failed to apply persisted recording settings:', err);
      return { success: false, error };
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

  private toRendererRecordingSettings(recording: AppSettings['recording']): RecordingSettings {
    const rendererRecording = { ...recording } as AppSettings['recording'] & {
      encoderMode?: 'auto' | 'manual';
    };
    delete rendererRecording.encoderMode;
    return rendererRecording as RecordingSettings;
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

    // Show file in folder (explorer/finder)
    ipcMain.handle(
      'shell:showItemInFolder',
      async (
        _event,
        filePath: unknown
      ): Promise<
        | { success: true }
        | {
            success: false;
            error: string;
            code: 'INVALID_PATH' | 'NOT_FOUND' | 'NOT_ALLOWED' | 'OPEN_FAILED' | 'UNKNOWN';
          }
      > => {
        try {
          await this.revealFileInFolder(filePath);
          return { success: true };
        } catch (error) {
          console.error('Failed to show item in folder:', error);
          const message = error instanceof Error ? error.message : 'Unknown error';
          // Use type guard to safely extract error code
          type RevealErrorCode =
            | 'INVALID_PATH'
            | 'NOT_FOUND'
            | 'NOT_ALLOWED'
            | 'OPEN_FAILED'
            | 'UNKNOWN';
          const validCodes: readonly RevealErrorCode[] = [
            'INVALID_PATH',
            'NOT_FOUND',
            'NOT_ALLOWED',
            'OPEN_FAILED',
          ];
          let code: RevealErrorCode = 'UNKNOWN';
          if (isAppError(error) && validCodes.includes(error.code as RevealErrorCode)) {
            code = error.code as RevealErrorCode;
          }
          return { success: false, error: message, code };
        }
      }
    );

    // App information handlers
    ipcMain.handle('app:getVersion', () => {
      return app.getVersion();
    });

    ipcMain.handle('app:getEnvironment', () => {
      return {
        isDevelopment: this.isDevelopment,
      };
    });

    ipcMain.handle('billing:getEnabled', async () => {
      try {
        const response = await fetch(`${this.apiBaseUrl}/api/billing/enabled`, {
          method: 'GET',
        });
        let data: unknown = null;
        try {
          data = await response.json();
        } catch (parseError) {
          console.warn('[Main] Failed to parse billing enabled response:', parseError);
        }

        if (!response.ok) {
          let errorMessage = `Billing enabled request failed (${response.status})`;
          if (data && typeof data === 'object' && 'error' in data) {
            const errorPayload = (data as { error?: { message?: string } }).error;
            if (errorPayload && typeof errorPayload.message === 'string') {
              errorMessage = errorPayload.message;
            }
          }
          return { success: false, error: errorMessage };
        }

        if (
          !data ||
          typeof data !== 'object' ||
          !('success' in data) ||
          (data as { success?: boolean }).success !== true ||
          !('data' in data) ||
          typeof (data as { data?: { billingEnabled?: boolean } }).data?.billingEnabled !== 'boolean'
        ) {
          return { success: false, error: 'Invalid billing enabled response.' };
        }

        return {
          success: true,
          billingEnabled: (data as { data: { billingEnabled: boolean } }).data.billingEnabled,
        };
      } catch (error) {
        console.warn('[Main] Failed to fetch billing enabled flag:', error);
        return { success: false, error: 'Failed to fetch billing enabled flag.' };
      }
    });

    // Log export handler - returns zipPath; renderer calls shell:showItemInFolder to reveal
    ipcMain.handle('logs:export', async (_event, bufferId?: unknown): Promise<LogExportResult> => {
      // Runtime validation of untrusted IPC input
      if (bufferId !== undefined) {
        if (typeof bufferId !== 'string') {
          return {
            success: false,
            error: 'Invalid bufferId: must be a string or undefined',
          };
        }
        const trimmedId = bufferId.trim();
        if (trimmedId.length === 0) {
          return {
            success: false,
            error: 'Invalid bufferId: must be a non-empty string or undefined',
          };
        }
        return this.logExportService.exportLogs({ bufferId: trimmedId });
      }
      return this.logExportService.exportLogs({});
    });

    // WoW installation handlers
    // Note: Errors propagate to renderer (no silent fallback). Renderer must handle rejected promise.
    ipcMain.handle('wow:detectInstallations', async (): Promise<WoWInstallation[]> => {
      // Return mock data in UI dev mode
      if (this.isUIDevMode) {
        const mockData = [
          {
            path: '/mock/world-of-warcraft',
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
    });

    ipcMain.handle(
      'wow:validateInstallation',
      async (_event, installPath: unknown): Promise<WoWInstallation | null> => {
        // Return mock data in UI dev mode (don't persist mock paths)
        if (this.isUIDevMode) {
          return {
            path: '/mock/world-of-warcraft',
            combatLogPath: '/mock/world-of-warcraft/Logs',
            addonsPath: '/mock/world-of-warcraft/Interface/AddOns',
            addonInstalled: true,
            arenaCoachAddonPath: '/mock/world-of-warcraft/Interface/AddOns/ArenaCoach',
          };
        }

        let validPath: string;
        try {
          validPath = validateFilePath(installPath);
        } catch (error) {
          console.error('Error validating WoW installation:', error);
          return null;
        }

        const installation = await WoWInstallationDetector.validateInstallation(validPath);
        if (installation === null) return null;

        // Post-success side effects are best-effort; do not clobber a successful validation result.
        try {
          this.settingsService.setWoWInstallationPath(installation.path);
          console.info(`[ArenaCoachDesktop] Persisted validated WoW path: ${installation.path}`);

          // Re-resolve installations and notify renderer to keep UI in sync
          const updated = await this.resolveWoWInstallations();
          this.notifyAddonStatusToRenderer(updated);
        } catch (error) {
          console.error('[ArenaCoachDesktop] Failed to refresh installations after validation:', error);
        }

        return installation;
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
          message: `Select the main World of Warcraft installation directory (contains ${activeFlavor.windowsExecutable})`,
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

        // 401: Token rejected - logout immediately (truthfulness)
        if (response.status === 401) {
          console.warn('[Main] Skill Capped verify returned 401, logging out');
          await this.authManager.logout();
          return { success: false, error: 'Session expired. Please log in again.' };
        }

        const data = (await response.json()) as {
          success: boolean;
          user?: UserInfo;
          error?: { code: string; message: string; details?: unknown };
        };

        if (!response.ok) {
          console.error('Error during Skill Capped verification:', data);
          return {
            success: false,
            error: data.error?.message || 'Verification failed',
            details: data.error?.details,
          };
        }

        if (data.success) {
          if (!data.user) {
            // Backend contract violation: success=true but no user data
            console.error('Skill Capped verification: backend returned success without user data');
            return { success: false, error: 'Verification failed: invalid server response' };
          }
          const updatedUser = data.user;

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
          return {
            success: false,
            error: data.error?.message || 'Verification failed',
            details: data.error?.details,
          };
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Error during Skill Capped verification:', message);
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

        // 401: Token rejected - logout immediately (truthfulness)
        if (response.status === 401) {
          console.warn('[Main] Skill Capped status check returned 401, logging out');
          await this.authManager.logout();
          return {
            success: false,
            verified: false,
            error: 'Session expired. Please log in again.',
          };
        }

        const data = (await response.json()) as {
          success: boolean;
          is_verified: boolean;
        };

        if (!response.ok) {
          console.error('Error checking Skill Capped status:', data);
          return { success: false, verified: false, error: 'Failed to check status' };
        }

        // Always update user based on backend response (supports revocation true→false)
        const currentUser = this.authManager.getCurrentUser();
        if (currentUser && currentUser.is_skill_capped_verified !== data.is_verified) {
          const updatedUser = { ...currentUser, is_skill_capped_verified: data.is_verified };
          this.authManager.updateCurrentUser(updatedUser);

          // Emit auth:success to update UI on status change
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('auth:success', {
              token: this.authManager.getAuthToken(),
              user: updatedUser,
              source: 'skillcapped-status',
            });
          }
        }

        return { success: true, verified: data.is_verified };
      } catch (error: unknown) {
        console.error('Error checking Skill Capped status:', error);
        return { success: false, verified: false, error: 'Failed to check status' };
      }
    });

    ipcMain.handle('auth:getWebLoginUrl', async () => {
      try {
        if (!this.authManager.isAuthenticated()) {
          return { success: false, error: 'Not authenticated' };
        }

        if (!this.apiHeadersProvider.hasAuth()) {
          return { success: false, error: 'No auth token available' };
        }

        const headers = this.apiHeadersProvider.getHeaders({
          'Content-Type': 'application/json',
        });

        const response = await fetch(`${this.apiBaseUrl}/api/auth/web-login-code`, {
          method: 'POST',
          headers,
        });

        if (response.status === 401) {
          console.warn('[Main] Web login code returned 401, logging out');
          await this.authManager.logout();
          return { success: false, error: 'Session expired. Please log in again.' };
        }

        const data = (await response.json()) as
          | { success: true; code: string }
          | { success: false; error: { message?: string } };

        if (!response.ok || !('code' in data)) {
          const errorMessage =
            'error' in data && data.error?.message ? data.error.message : 'Failed to create login code';
          return { success: false, error: errorMessage };
        }

        const returnTo = '/account';
        const loginUrl = `${this.apiBaseUrl}/api/auth/code-login?code=${encodeURIComponent(
          data.code
        )}&returnTo=${encodeURIComponent(returnTo)}`;

        return { success: true, url: loginUrl };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Error creating web login URL:', message);
        return { success: false, error: 'Failed to open premium signup.' };
      }
    });

    ipcMain.handle('auth:refreshBillingStatus', async () => {
      return await this.checkBillingStatus();
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
        throw new Error('Recording service not available');
      }

      try {
        // Re-enable OBS and re-apply saved settings so capture sources are correctly configured
        await this.recordingService.enable();
        if (this.mainWindow) {
          this.recordingService.setMainWindow(this.mainWindow);
        }
        const applyResult = await this.applyPersistedRecordingSettings();
        if (!applyResult.success) {
          throw new Error(applyResult.error ?? 'Failed to apply recording settings');
        }
        // Persist user preference
        this.settingsService.updateSettings({ recordingEnabled: true });
      } catch (error) {
        console.error('[recording:enable] Failed to enable recording:', error);
        throw error;
      }
    });

    ipcMain.handle('recording:disable', async (): Promise<void> => {
      if (!this.recordingService) {
        throw new Error('Recording service not available');
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

    // Recording metadata handlers moved to setupStorageIPC() - require initialized metadataStorageService

    // Scene handlers for recording settings
    ipcMain.handle('scene:getSettings', () => {
      try {
        const settings = this.settingsService.getSettings();
        return this.toRendererRecordingSettings(settings.recording);
      } catch (error) {
        console.error('[scene:getSettings] Failed to get settings:', error);
        throw new Error('Failed to retrieve scene settings');
      }
    });

    ipcMain.handle('scene:getRuntimeEncoder', () => {
      const settings = this.settingsService.getSettings();
      const mode = settings.recording.encoderMode || 'auto';
      const preferredEncoder = settings.recording.encoder || 'x264';

      const encoderId =
        this.recordingService && this.recordingService.isOBSInitialized()
          ? this.recordingService.getCurrentEncoderId()
          : null;

      return {
        mode,
        preferredEncoder,
        encoder: inferEncoderTypeFromId(encoderId),
      };
    });

    ipcMain.handle(
      'scene:updateSettings',
      async (
        _event,
        updates: Partial<RecordingSettings>
      ): Promise<{ settings: RecordingSettings; obsApplyError?: string }> => {
        // Check if recording is active and trying to change unsafe settings
        if (this.recordingService) {
          const status = await this.recordingService.getStatus();
          if (status.isRecording) {
            const hasUnsafeUpdate = UNSAFE_RECORDING_SETTINGS.some(key => key in updates);
            if (hasUnsafeUpdate) {
              throw new AppError(
                'Cannot change video settings while recording is active',
                'RECORDING_ACTIVE'
              );
            }
          }
        }

        // Validate the incoming settings
        const validated = this.validateRecordingSettings(updates);

        // Early return if no valid updates to avoid unnecessary write
        if (Object.keys(validated).length === 0) {
          const current = this.settingsService.getSettings();
          return { settings: this.toRendererRecordingSettings(current.recording) };
        }

        const current = this.settingsService.getSettings();
        const encoderTouched =
          (updates as { _encoderTouched?: unknown })._encoderTouched === true;
        const didEncoderChange =
          validated.encoder !== undefined &&
          validated.encoder !== (current.recording.encoder || 'x264');
        const shouldApplyEncoderManually =
          validated.encoder !== undefined && (didEncoderChange || encoderTouched);
        const nextEncoderMode = shouldApplyEncoderManually
          ? 'manual'
          : current.recording.encoderMode || 'auto';

        const updatedRecording = {
          ...current.recording,
          ...validated,
          encoderMode: nextEncoderMode,
        };

        const persisted = this.settingsService.updateSettings({
          recording: updatedRecording,
        });

        const obsApplySettings: Partial<RecordingSettings> = { ...validated };
        if (!shouldApplyEncoderManually && obsApplySettings.encoder !== undefined) {
          delete obsApplySettings.encoder;
        }

        // Apply settings to OBS if initialized
        let obsApplyError: string | undefined;
        if (
          this.recordingService &&
          this.recordingService.isOBSInitialized() &&
          Object.keys(obsApplySettings).length > 0
        ) {
          try {
            const success = await this.recordingService.applyRecordingSettings(obsApplySettings);
            if (!success) {
              // Service returned false (e.g., recording disabled after fatal error)
              obsApplyError = 'Recording service rejected settings update';
            }
          } catch (applyError) {
            // Settings are persisted, OBS apply can be retried on next recording start
            console.error('[scene:updateSettings] Failed to apply settings to OBS:', applyError);
            obsApplyError =
              applyError instanceof Error ? applyError.message : 'Failed to apply OBS settings';
          }
        }

        return obsApplyError
          ? { settings: this.toRendererRecordingSettings(persisted.recording), obsApplyError }
          : { settings: this.toRendererRecordingSettings(persisted.recording) };
      }
    );

    // Recording directory helper for Scene UI - returns the actual sanitized path being used
    ipcMain.handle('recording:getEffectiveDirectory', () => {
      return this.getRecordingDirectoryFromSettings();
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
        this.recordingService.hidePreview();
      }
    });

    // Audio device enumeration for Scene UI
    ipcMain.handle('obs:audio:getDevices', async () => {
      if (!this.recordingService || !this.recordingService.isOBSInitialized()) {
        throw new Error('OBS not initialized');
      }
      return this.recordingService.getAudioDevices();
    });

    // Monitor enumeration for Scene UI
    ipcMain.handle('obs:display:getMonitors', async () => {
      if (!this.recordingService || !this.recordingService.isOBSInitialized()) {
        throw new Error('OBS not initialized');
      }
      return this.recordingService.getMonitors();
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

    ipcMain.handle(
      'settings:update',
      async (
        _event,
        newSettings: Partial<AppSettings>
      ): Promise<{
        settings: AppSettings;
        recordingDirUpdateError?: string;
        recordingEnableError?: string;
        recordingDisableError?: string;
      }> => {
        // Check if recording enabled setting is changing
        const currentSettings = this.settingsService.getSettings();
        const wasRecordingEnabled = currentSettings.recordingEnabled !== false;
        const previousRunOnStartup = currentSettings.runOnStartup;

        // Update settings first (persisted)
        const updatedSettings = this.settingsService.updateSettings(newSettings);
        const willBeRecordingEnabled = updatedSettings.recordingEnabled !== false;

        // Track partial failures
        let recordingDirUpdateError: string | undefined;
        let recordingEnableError: string | undefined;
        let recordingDisableError: string | undefined;

        // Handle recording directory change if recording service is active
        // Require string type (including '') to handle clearing to default; undefined is ignored
        if (
          this.recordingService &&
          typeof newSettings.recordingLocation === 'string' &&
          newSettings.recordingLocation !== currentSettings.recordingLocation
        ) {
          try {
            // Pass raw input to updateRecordingDirectory so it can do its own sanitization
            // and update settings if needed. Exception: '' means clear to default, but
            // updateRecordingDirectory rejects empty string, so compute effective dir for that case.
            const dirToUpdate =
              newSettings.recordingLocation === ''
                ? getEffectiveRecordingDirectory('', app.getPath('videos'))
                : newSettings.recordingLocation;
            console.info('[ArenaCoachDesktop] Updating recording directory to:', dirToUpdate);
            await this.recordingService.updateRecordingDirectory(dirToUpdate);
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
            // Settings are persisted, but live service update failed - record as partial failure
            recordingDirUpdateError =
              error instanceof Error ? error.message : 'Failed to update recording directory';
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
              recordingEnableError = 'Recording service not ready - please try again';
            } else {
              // Enable recording - initialize service
              try {
                console.info(
                  '[ArenaCoachDesktop] Enabling recording service due to settings change'
                );
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
                const applyResult = await this.applyPersistedRecordingSettings();
                if (!applyResult.success) {
                  // Service initialized but settings failed to apply - report as partial failure
                  recordingEnableError = applyResult.error ?? 'Failed to apply recording settings';
                } else {
                  console.info('[ArenaCoachDesktop] Recording service enabled via settings');
                }
              } catch (error) {
                console.error('[ArenaCoachDesktop] Failed to enable recording service:', error);
                this.recordingService = null;
                this.clearRecordingRecoveryState();
                recordingEnableError =
                  error instanceof Error ? error.message : 'Failed to enable recording';
              }
            }
          } else if (!willBeRecordingEnabled && this.recordingService) {
            // Disable recording - shutdown service
            try {
              console.info(
                '[ArenaCoachDesktop] Disabling recording service due to settings change'
              );
              await this.recordingService.shutdown();
              this.recordingService = null;
              this.clearRecordingRecoveryState();
              console.info('[ArenaCoachDesktop] Recording service disabled via settings');
            } catch (error) {
              console.error('[ArenaCoachDesktop] Error disabling recording service:', error);
              recordingDisableError =
                error instanceof Error ? error.message : 'Failed to disable recording';
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

        const result: {
          settings: AppSettings;
          recordingDirUpdateError?: string;
          recordingEnableError?: string;
          recordingDisableError?: string;
        } = { settings: updatedSettings };
        if (recordingDirUpdateError) {
          result.recordingDirUpdateError = recordingDirUpdateError;
        }
        if (recordingEnableError) {
          result.recordingEnableError = recordingEnableError;
        }
        if (recordingDisableError) {
          result.recordingDisableError = recordingDisableError;
        }
        return result;
      }
    );

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

    ipcMain.handle('matches:delete', async (_event, bufferId: unknown) => {
      try {
        if (!isValidBufferId(bufferId)) {
          throw new Error('Invalid bufferId: must match expected format');
        }

        // Single-scan delete with pre-delete validation
        const { deleted, scanErrors } =
          await this.metadataStorageService.deleteMatchByBufferIdWithDiagnostics(
            bufferId,
            match => {
              // Validator throws if match should not be deleted
              if (match.matchCompletionStatus === 'in_progress') {
                throw new Error('Cannot delete match while it is in progress');
              }
              if (ArenaCoachDesktop.NON_TERMINAL_UPLOAD_STATUSES.has(match.uploadStatus)) {
                throw new Error(
                  `Cannot delete match in non-terminal status: ${match.uploadStatus}`
                );
              }
            }
          );

        // Log scan errors as warning but don't block idempotent deletes
        // (scan errors are per-file and may be unrelated to the requested bufferId)
        if (scanErrors.length > 0) {
          const sampleErrors = scanErrors.slice(0, 3).map(e => `${e.file}: ${e.error}`);
          console.warn(
            `[matches:delete] ${scanErrors.length} file(s) could not be read during scan. ` +
              `Sample errors: ${sampleErrors.join('; ')}`
          );
        }

        return deleted;
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

    ipcMain.handle('matches:setFavourite', async (_event, bufferId: unknown, isFavourite: unknown): Promise<boolean> => {
      try {
        // Validate bufferId at IPC boundary
        if (!isValidBufferId(bufferId)) {
          throw new Error('Invalid bufferId: must match expected format');
        }

        // Validate isFavourite as boolean
        if (typeof isFavourite !== 'boolean') {
          throw new Error('Invalid isFavourite: must be a boolean');
        }

        await this.metadataStorageService.updateFavouriteByBufferId(bufferId, isFavourite);
        return true;
      } catch (error) {
        console.error('Error setting favourite status:', error);
        throw error;
      }
    });

    // Recording info handlers - depend on metadataStorageService
    ipcMain.handle(
      'recording:getRecordingInfoForMatch',
      async (_event, bufferId: unknown): Promise<RecordingInfoResult> => {
        // Validate bufferId at IPC boundary
        if (!isValidBufferId(bufferId)) {
          return {
            success: false,
            error: 'Invalid bufferId format',
            code: 'INVALID_BUFFER_ID',
          };
        }

        // Load metadata with diagnostics for precise error handling
        let result: Awaited<
          ReturnType<typeof this.metadataStorageService.loadMatchByBufferIdWithDiagnostics>
        >;
        try {
          result = await this.metadataStorageService.loadMatchByBufferIdWithDiagnostics(bufferId);
        } catch (error) {
          // Only handle expected storage errors; rethrow unexpected exceptions
          if (!isNodeError(error) && !(error instanceof Error && isNodeError(error.cause))) {
            throw error;
          }
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('[ArenaCoachDesktop] Catastrophic metadata load failure:', error);
          return {
            success: false,
            error: `Failed to load metadata: ${message}`,
            code: 'METADATA_LOAD_FAILED',
          };
        }

        const { match, scanErrors } = result;

        // Distinguish "not found" from "load failed with errors"
        if (match === null) {
          if (scanErrors.length > 0) {
            const firstErrorMsg = scanErrors[0]?.error ?? 'Unknown error';
            return {
              success: false,
              error: `Failed to load metadata (${scanErrors.length} file error(s)): ${firstErrorMsg}`,
              code: 'METADATA_LOAD_FAILED',
            };
          }
          return {
            success: false,
            error: 'Match metadata not found',
            code: 'METADATA_NOT_FOUND',
          };
        }

        // Compute videoExists in main process (no renderer-supplied paths)
        let videoExists = false;
        const videoPath = match.videoPath ?? null;
        if (videoPath !== null) {
          try {
            const validatedPath = validateFilePath(videoPath);
            await fs.access(validatedPath);
            videoExists = true;
          } catch {
            // Invalid path or file doesn't exist
            videoExists = false;
          }
        }

        return {
          success: true,
          videoPath,
          videoExists,
          videoDuration: match.videoDuration ?? null,
          recordingStatus: match.recordingStatus ?? 'not_applicable',
          recordingErrorCode: match.recordingErrorCode ?? null,
          recordingErrorMessage: match.recordingErrorMessage ?? null,
        };
      }
    );

    ipcMain.handle(
      'recording:getThumbnailForMatch',
      async (_event, bufferId: unknown): Promise<string | null> => {
        // Validate bufferId at IPC boundary; return null for invalid input
        if (!isValidBufferId(bufferId)) {
          return null;
        }

        // Load metadata with diagnostics
        let result: Awaited<
          ReturnType<typeof this.metadataStorageService.loadMatchByBufferIdWithDiagnostics>
        >;
        try {
          result = await this.metadataStorageService.loadMatchByBufferIdWithDiagnostics(bufferId);
        } catch (error) {
          console.error('[ArenaCoachDesktop] Failed to get thumbnail for match:', error);
          return null;
        }

        const { match, scanErrors } = result;

        // Log scan errors if any occurred
        if (match === null && scanErrors.length > 0) {
          console.error(
            '[ArenaCoachDesktop] Metadata load errors while getting thumbnail:',
            scanErrors
          );
          return null;
        }

        if (!match) {
          return null;
        }

        const thumbnail = match.videoThumbnail;
        if (!thumbnail) {
          return null;
        }

        // Validate thumbnail path before returning
        try {
          const validatedThumb = validateFilePath(thumbnail);
          await fs.access(validatedThumb);
          return validatedThumb;
        } catch {
          // Invalid path or thumbnail doesn't exist
          return null;
        }
      }
    );

    // ID-based reveal handlers for recordings - uses bufferId, not renderer-supplied paths
    ipcMain.handle(
      'recording:revealVideoInFolder',
      async (_event, bufferId: unknown): Promise<RevealResult> => {
        // Validate bufferId at IPC boundary
        if (!isValidBufferId(bufferId)) {
          return {
            success: false,
            error: 'Invalid bufferId format',
            code: 'INVALID_BUFFER_ID',
          };
        }

        // Load metadata
        let result: Awaited<
          ReturnType<typeof this.metadataStorageService.loadMatchByBufferIdWithDiagnostics>
        >;
        try {
          result = await this.metadataStorageService.loadMatchByBufferIdWithDiagnostics(bufferId);
        } catch (error) {
          // Only handle expected storage errors; rethrow unexpected exceptions
          if (!isNodeError(error) && !(error instanceof Error && isNodeError(error.cause))) {
            throw error;
          }
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('[ArenaCoachDesktop] Failed to load metadata for video reveal:', error);
          return {
            success: false,
            error: `Failed to load metadata: ${message}`,
            code: 'NOT_FOUND',
          };
        }

        const { match, scanErrors } = result;

        // Distinguish metadata load failures from missing media
        if (match === null) {
          if (scanErrors.length > 0) {
            const firstErrorMsg = scanErrors[0]?.error ?? 'Unknown error';
            return {
              success: false,
              error: `Failed to load metadata (${scanErrors.length} file error(s)): ${firstErrorMsg}`,
              code: 'NOT_FOUND',
            };
          }
          // No match found and no errors = match doesn't exist
          return {
            success: false,
            error: 'No video recording for this match',
            code: 'NO_MEDIA',
          };
        }

        if (!match.videoPath) {
          return {
            success: false,
            error: 'No video recording for this match',
            code: 'NO_MEDIA',
          };
        }

        // Validate stored video path
        let validatedPath: string;
        try {
          validatedPath = validateFilePath(match.videoPath);
        } catch {
          return {
            success: false,
            error: 'Invalid stored video path',
            code: 'NOT_FOUND',
          };
        }

        // Resolve to real path (also verifies existence)
        let realPath: string;
        try {
          realPath = await fs.realpath(validatedPath);
        } catch (error) {
          // Only handle expected filesystem errors; rethrow unexpected exceptions
          if (!isNodeError(error)) {
            throw error;
          }
          return {
            success: false,
            error: 'Video file not found',
            code: 'NOT_FOUND',
          };
        }

        // Reveal in folder - shell.showItemInFolder is sync/void, wrap for any throws
        try {
          shell.showItemInFolder(realPath);
          return { success: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return {
            success: false,
            error: `Failed to open file manager: ${message}`,
            code: 'OPEN_FAILED',
          };
        }
      }
    );

    ipcMain.handle(
      'recording:revealThumbnailInFolder',
      async (_event, bufferId: unknown): Promise<RevealResult> => {
        // Validate bufferId at IPC boundary
        if (!isValidBufferId(bufferId)) {
          return {
            success: false,
            error: 'Invalid bufferId format',
            code: 'INVALID_BUFFER_ID',
          };
        }

        // Load metadata
        let result: Awaited<
          ReturnType<typeof this.metadataStorageService.loadMatchByBufferIdWithDiagnostics>
        >;
        try {
          result = await this.metadataStorageService.loadMatchByBufferIdWithDiagnostics(bufferId);
        } catch (error) {
          // Only handle expected storage errors; rethrow unexpected exceptions
          if (!isNodeError(error) && !(error instanceof Error && isNodeError(error.cause))) {
            throw error;
          }
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('[ArenaCoachDesktop] Failed to load metadata for thumbnail reveal:', error);
          return {
            success: false,
            error: `Failed to load metadata: ${message}`,
            code: 'NOT_FOUND',
          };
        }

        const { match, scanErrors } = result;

        // Distinguish metadata load failures from missing media
        if (match === null) {
          if (scanErrors.length > 0) {
            const firstErrorMsg = scanErrors[0]?.error ?? 'Unknown error';
            return {
              success: false,
              error: `Failed to load metadata (${scanErrors.length} file error(s)): ${firstErrorMsg}`,
              code: 'NOT_FOUND',
            };
          }
          // No match found and no errors = match doesn't exist
          return {
            success: false,
            error: 'No thumbnail for this match',
            code: 'NO_MEDIA',
          };
        }

        if (!match.videoThumbnail) {
          return {
            success: false,
            error: 'No thumbnail for this match',
            code: 'NO_MEDIA',
          };
        }

        // Validate stored thumbnail path
        let validatedPath: string;
        try {
          validatedPath = validateFilePath(match.videoThumbnail);
        } catch {
          return {
            success: false,
            error: 'Invalid stored thumbnail path',
            code: 'NOT_FOUND',
          };
        }

        // Resolve to real path (also verifies existence)
        let realPath: string;
        try {
          realPath = await fs.realpath(validatedPath);
        } catch (error) {
          // Only handle expected filesystem errors; rethrow unexpected exceptions
          if (!isNodeError(error)) {
            throw error;
          }
          return {
            success: false,
            error: 'Thumbnail file not found',
            code: 'NOT_FOUND',
          };
        }

        // Reveal in folder - shell.showItemInFolder is sync/void, wrap for any throws
        try {
          shell.showItemInFolder(realPath);
          return { success: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return {
            success: false,
            error: `Failed to open file manager: ${message}`,
            code: 'OPEN_FAILED',
          };
        }
      }
    );

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

    // Quota status handler - fetches weekly enrichment quota from backend
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

    // Fatal OBS IPC recovery: request safe-point recovery for next match
    this.recordingService.on('obsError', (error: Error) => {
      const errorCode = (error as { code?: string }).code;
      if (errorCode !== 'OBS_IPC_FATAL') {
        return;
      }
      this.requestRecordingRecoveryDueToFatalObsIpc(error);
    });

    // Forward user-facing recording error event (folder/permission issues)
    this.recordingService.on('recordingError', (userMessage: string) => {
      console.warn('[ArenaCoachDesktop] Recording user-facing error:', userMessage);
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('recording:userError', userMessage);
      }
    });

    // Forward retention cleanup event (quota-triggered deletions)
    this.recordingService.on(
      'recordingRetentionCleanup',
      (data: { deletedCount: number; freedGB: number; maxGB: number }) => {
        console.info('[ArenaCoachDesktop] Recording retention cleanup:', data);
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('recording:retentionCleanup', data);
        }
      }
    );

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

    if (this.recordingRecoveryTimeoutId) {
      clearTimeout(this.recordingRecoveryTimeoutId);
      this.recordingRecoveryTimeoutId = null;
    }

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

    const key = event.bufferId;
    const finalizationPromise = this.matchLifecycleService
      ? this.matchLifecycleService.handleMatchEnded(event)
      : Promise.resolve();
    if (this.matchLifecycleService) {
      this.ongoingFinalizations.set(key, finalizationPromise);
    }
    try {
      await finalizationPromise;
    } finally {
      if (this.matchLifecycleService) {
        this.ongoingFinalizations.delete(key);
      }

      // Always notify renderer so UI exits "in match" state
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('match:ended', event);
      }
      this.flushPendingRecordingRecovery('matchEnded');
    }
  }

  /**
   * Internal handler for match ended incomplete events.
   * Assumes it is called within a serialized queue context for the bufferId.
   */
  private async handleMatchEndedIncompleteInternal(
    event: MatchEndedIncompleteEvent
  ): Promise<void> {
    try {
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
    } finally {
      this.flushPendingRecordingRecovery('matchEndedIncomplete');
    }
  }

  /**
   * Internal handler for match processed events.
   * Assumes it is called within a serialized queue context for the bufferId,
   * guaranteeing that matchStarted and matchEnded have already completed.
   */
  private async handleMatchProcessedInternal(payload: MatchProcessedPayload): Promise<void> {
    const { matchEvent, chunkFilePath } = payload;

    // Load authoritative metadata state from disk with diagnostics
    // to distinguish "not found" from "load failed"
    let loadResult: Awaited<
      ReturnType<typeof this.metadataStorageService.loadMatchByBufferIdWithDiagnostics>
    >;

    try {
      loadResult = await this.metadataStorageService.loadMatchByBufferIdWithDiagnostics(
        matchEvent.bufferId
      );
    } catch (loadError) {
      // Catastrophic failure (cannot read directory) - skip without deleting chunk
      // (transient; aged retention cleanup will handle once storage is healthy)
      console.error(
        `[ArenaCoachDesktop] Catastrophic metadata load failure in matchProcessed; preserving chunk:`,
        { bufferId: matchEvent.bufferId, chunkFilePath },
        loadError
      );
      return;
    }

    const { match: storedMetadata, scanErrors } = loadResult;

    console.info('[ArenaCoachDesktop] Match processed:', {
      bufferId: matchEvent.bufferId,
      matchHash: storedMetadata?.matchHash,
      chunkFilePath: chunkFilePath,
      scanErrors: scanErrors.length > 0 ? scanErrors.length : undefined,
    });

    if (!storedMetadata) {
      // Scan incomplete - can't prove "not found"; target file may be in scanErrors
      if (scanErrors.length > 0) {
        console.warn(
          `[ArenaCoachDesktop] Metadata scan incomplete; preserving chunk for later cleanup:`,
          { bufferId: matchEvent.bufferId, scanErrorCount: scanErrors.length, scanErrors }
        );
        return;
      }

      // Scan complete, truly not found - chunk preserved for log export/retention cleanup
      console.warn(
        `[ArenaCoachDesktop] No metadata found for bufferId; skipping matchProcessed (chunk preserved for retention cleanup): ${matchEvent.bufferId}`
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
        console.error(
          `[ArenaCoachDesktop] Upload failed for match ${matchHash}:`,
          toSafeAxiosErrorLog(uploadError)
        );

        // Map upload errors to appropriate metadata updates
        if (isCombatLogExpiredError(uploadError)) {
          console.info('[ArenaCoachDesktop] Processing expired combat log for match:', matchHash);

          // Update metadata and delete chunk for expired match
          if (!storedMetadata.bufferId) {
            console.warn(
              `[ArenaCoachDesktop] Cannot process expired match - no bufferId for ${matchHash}`
            );
          } else {
            const currentTimeMs = Date.now();
            // Explicit construction with validated fields (no as cast)
            const narrowedMatch = {
              ...storedMetadata,
              matchHash,
              bufferId: storedMetadata.bufferId,
            };
            const result = await this.updateMatchMetadataToExpired(narrowedMatch, currentTimeMs);
            if (result.errors.length > 0) {
              console.warn(
                `[ArenaCoachDesktop] Errors during expiration processing for ${matchHash}:`,
                result.errors
              );
            }
          }
        } else {
          // Handle all other errors by marking as FAILED
          console.error(
            `[ArenaCoachDesktop] Upload error for match ${matchHash}:`,
            toSafeAxiosErrorLog(uploadError)
          );

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

        // Keep auth state in sync with backend-authoritative job-status entitlement.
        // This updates UI immediately when premium is gained/lost while app is running.
        const authToken = this.authManager.getAuthToken();
        const currentUser = this.authManager.getCurrentUser();
        if (authToken && currentUser && typeof event.isPremiumViewer === 'boolean') {
          const premiumChanged = currentUser.is_premium !== event.isPremiumViewer;

          if (premiumChanged) {
            const updatedUser: UserInfo = {
              ...currentUser,
              is_premium: event.isPremiumViewer,
            };
            this.authManager.updateCurrentUser(updatedUser);
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
              this.mainWindow.webContents.send('auth:success', {
                token: authToken,
                user: updatedUser,
                source: 'billing-status',
              });
            }
          }
        }

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
        console.error('[ArenaCoachDesktop] Match detection service error:', errorMessage);
      } catch (handlingError) {
        console.error('[ArenaCoachDesktop] Error handling service error event:', handlingError);
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
        if (this.recordingRecoveryTimeoutId) {
          clearTimeout(this.recordingRecoveryTimeoutId);
          this.recordingRecoveryTimeoutId = null;
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
    _data: { token: AuthToken; user: UserInfo },
    sourceFlag?: string
  ): Promise<void> {
    try {
      if (!this.authManager.isAuthenticated() || !this.apiHeadersProvider.hasAuth()) {
        return;
      }
      const headers = this.apiHeadersProvider.getHeaders();
      const response = await fetch(`${this.apiBaseUrl}/api/skillcapped/status`, {
        method: 'GET',
        headers,
      });

      // 401: Token rejected - logout immediately (truthfulness)
      if (response.status === 401) {
        console.warn('[Main] Skill Capped status check returned 401, logging out');
        await this.authManager.logout();
        return;
      }

      if (response.ok) {
        const statusData = (await response.json()) as {
          success: boolean;
          is_verified: boolean;
        };

        // Check if still authenticated (logout/rotation could have occurred during fetch)
        const currentToken = this.authManager.getAuthToken();
        const currentUser = this.authManager.getCurrentUser();
        if (!currentToken || !currentUser) {
          // Auth changed mid-flight, don't emit stale state
          return;
        }

        // Update user object based on server status (supports revocation)
        const updatedUser = { ...currentUser, is_skill_capped_verified: statusData.is_verified };

        // Log status changes for debugging
        if (currentUser.is_skill_capped_verified !== statusData.is_verified) {
          console.info(
            `[Main] Skill Capped status changed for ${currentUser.battletag || 'Unknown'} (ID: ${currentUser.id || 'N/A'}): ${currentUser.is_skill_capped_verified} → ${statusData.is_verified}`
          );
        }

        this.authManager.updateCurrentUser(updatedUser);

        // Emit auth:success with current SSoT token and confirmed status
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('auth:success', {
            token: currentToken,
            user: updatedUser,
            source: sourceFlag,
          });
        }
        return;
      }
    } catch (error) {
      console.warn('[Main] Failed to check Skill Capped status:', error);
    }
  }

  /**
   * Check billing status and update user object.
   * Used by login, restore, and explicit refresh calls.
   */
  private async checkBillingStatus(): Promise<{ success: true } | { success: false; error: string }> {
    try {
      if (!this.authManager.isAuthenticated() || !this.apiHeadersProvider.hasAuth()) {
        return { success: false, error: 'Not authenticated' };
      }
      const headers = this.apiHeadersProvider.getHeaders();
      const response = await fetch(`${this.apiBaseUrl}/api/billing/status`, {
        method: 'GET',
        headers,
      });

      if (response.status === 401) {
        console.warn('[Main] Billing status check returned 401, logging out');
        await this.authManager.logout();
        return { success: false, error: 'Unauthorized' };
      }

      let statusData: unknown = null;
      try {
        statusData = await response.json();
      } catch (parseError) {
        console.warn('[Main] Failed to parse billing status response:', parseError);
      }

      if (!response.ok) {
        let errorMessage = `Billing status request failed (${response.status})`;
        if (statusData && typeof statusData === 'object' && 'error' in statusData) {
          const errorPayload = (statusData as { error?: { message?: string } }).error;
          if (errorPayload && typeof errorPayload.message === 'string') {
            errorMessage = errorPayload.message;
          }
        }
        return { success: false, error: errorMessage };
      }

      if (
        !statusData ||
        typeof statusData !== 'object' ||
        (statusData as { success?: boolean }).success !== true
      ) {
        return { success: false, error: 'Invalid billing status response.' };
      }

      const data = (statusData as {
        data?: { billingEnabled?: boolean; isPremium?: boolean; premiumSources?: Array<'skillcapped' | 'stripe'> };
      }).data;

      if (
        !data ||
        typeof data.billingEnabled !== 'boolean' ||
        typeof data.isPremium !== 'boolean' ||
        !Array.isArray(data.premiumSources)
      ) {
        return { success: false, error: 'Invalid billing status response.' };
      }

      const currentToken = this.authManager.getAuthToken();
      const currentUser = this.authManager.getCurrentUser();
      if (!currentToken || !currentUser) {
        return { success: false, error: 'Missing auth context.' };
      }

      const updatedUser: UserInfo = {
        ...currentUser,
        is_premium: data.isPremium,
        premium_sources: data.premiumSources,
      };

      this.authManager.updateCurrentUser(updatedUser);

      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('auth:success', {
          token: currentToken,
          user: updatedUser,
          source: 'billing-status',
        });
      }
      return { success: true };
    } catch (error) {
      console.warn('[Main] Failed to check billing status:', error);
    }
    return { success: false, error: 'Failed to fetch billing status.' };
  }

  private setupAuthentication(): void {
    // Handle authentication events
    this.authManager.on('auth-success', async (data: { token: AuthToken; user: UserInfo }) => {
      console.info(`User authenticated: ${data.user.battletag}`);

      // Update all services with auth token
      this.updateAllServicesAuthToken(data.token.accessToken);

      // Emit baseline auth success immediately (do not depend on status endpoints)
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('auth:success', {
          token: data.token,
          user: data.user,
        });
      }

      // Check Skill Capped status and emit result
      await this.checkSkillCappedStatus(data, 'login-with-status');
      await this.checkBillingStatus();
    });

    this.authManager.on('auth-restored', async (data: { token: AuthToken; user: UserInfo }) => {
      console.info(`Authentication restored from saved credentials: ${data.user.battletag}`);

      // Update all services with restored auth token
      this.updateAllServicesAuthToken(data.token.accessToken);

      // Emit baseline auth success immediately (do not depend on status endpoints)
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('auth:success', {
          token: data.token,
          user: data.user,
          source: 'restore-with-status',
        });
      }

      // Check Skill Capped status and emit auth:success
      await this.checkSkillCappedStatus(data, 'restore-with-status');
      await this.checkBillingStatus();
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
      console.error('Authentication error:', toSafeAxiosErrorLog(error));

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
      encoderMode: settings.recording.encoderMode || 'auto',
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
          const applyResult = await this.applyPersistedRecordingSettings();
          if (applyResult.success) {
            console.info('[ArenaCoachDesktop] Recording service initialized');
          } else {
            console.warn(
              '[ArenaCoachDesktop] Recording service initialized but settings apply failed:',
              applyResult.error
            );
          }
        } catch (error) {
          console.error('[ArenaCoachDesktop] Failed to initialize recording service:', error);
          // Non-critical - continue without recording
          this.recordingService = null;
          this.clearRecordingRecoveryState();
        }
      } else {
        console.info(
          '[ArenaCoachDesktop] Recording disabled in settings or not supported on this platform'
        );
        this.recordingService = null;
        this.clearRecordingRecoveryState();
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
        this.apiHeadersProvider
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

      // Handle auth failures from polling service (401 responses)
      this.completionPollingService.on(
        'authRequired',
        async (event: { jobId: string; matchHash: string; reason: string }) => {
          console.warn('[Main] CompletionPollingService reported auth failure:', event.reason);
          await this.authManager.logout();
        }
      );

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
   * Update match metadata to expired status when combat log is too old.
   * Returns explicit result (no silent swallowing of failures).
   * @param match The match metadata with required matchHash and bufferId
   * @param currentTimeMs Timestamp for deterministic failedAt/lastUpdatedAt
   * @returns Object with metadataUpdated, chunkDeleted, and errors
   */
  private async updateMatchMetadataToExpired(
    match: StoredMatchMetadata & { matchHash: string; bufferId: string },
    currentTimeMs: number
  ): Promise<{ metadataUpdated: boolean; chunkDeleted: boolean; errors: string[] }> {
    const errors: string[] = [];

    // Build updated metadata with explicit field updates
    const updatedMatch: StoredMatchMetadata = {
      ...match,
      uploadStatus: UploadStatus.EXPIRED,
      errorMessage: `Combat log expired (older than ${ExpirationConfig.COMBAT_LOG_EXPIRATION_HOURS} hours)`,
      failedAt: new Date(currentTimeMs).toISOString(),
      lastUpdatedAt: new Date(currentTimeMs),
      // Ensure storedAt is set (avoid Date.now() in storage layer)
      storedAt: match.storedAt ?? currentTimeMs,
    };

    // Persist metadata update
    let metadataUpdated = false;
    try {
      await this.metadataStorageService.saveMatch(updatedMatch);
      metadataUpdated = true;
      console.info('[ArenaCoachDesktop] Updated match metadata to expired:', match.matchHash);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorMessage = `Failed to save expired metadata for ${match.matchHash}: ${message}`;
      errors.push(errorMessage);
      console.error('[ArenaCoachDesktop]', errorMessage);
      // Return early - don't attempt chunk deletion if metadata update failed
      return { metadataUpdated: false, chunkDeleted: false, errors };
    }

    // Attempt chunk deletion via explicit-result API
    const deleteResult = await this.chunkCleanupService.deleteChunkForBufferId(match.bufferId);
    if (deleteResult.errors.length > 0) {
      errors.push(...deleteResult.errors);
    }
    if (deleteResult.chunkDeleted) {
      console.info(
        '[ArenaCoachDesktop] Deleted chunk file for expired match (by bufferId):',
        match.bufferId
      );
    }

    // Notify renderer process (guarded to maintain explicit-result contract)
    try {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('match:statusUpdated', {
          matchHash: match.matchHash,
          status: UploadStatus.EXPIRED,
        });
      }
    } catch (notifyError) {
      const message = notifyError instanceof Error ? notifyError.message : String(notifyError);
      errors.push(`Failed to notify renderer: ${message}`);
    }

    return { metadataUpdated, chunkDeleted: deleteResult.chunkDeleted, errors };
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
    // Type check - narrow to Record<string, unknown> for safe property access
    if (!bounds || typeof bounds !== 'object') {
      throw new AppError('Invalid preview bounds: must be an object', 'INVALID_PREVIEW_BOUNDS');
    }

    const b = bounds as Record<string, unknown>;

    // Check required properties exist
    if (!('width' in b) || !('height' in b) || !('x' in b) || !('y' in b)) {
      throw new AppError(
        'Invalid preview bounds: missing required properties (width, height, x, y)',
        'INVALID_PREVIEW_BOUNDS'
      );
    }

    // Extract and validate each property is a number
    const { width, height, x, y } = b;
    if (
      typeof width !== 'number' ||
      typeof height !== 'number' ||
      typeof x !== 'number' ||
      typeof y !== 'number'
    ) {
      throw new AppError(
        'Invalid preview bounds: all properties must be numbers',
        'INVALID_PREVIEW_BOUNDS'
      );
    }

    // Check all are finite
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      throw new AppError(
        'Invalid preview bounds: all properties must be finite numbers',
        'INVALID_PREVIEW_BOUNDS'
      );
    }

    // Check non-negative coordinates
    if (x < 0 || y < 0) {
      throw new AppError(
        'Invalid preview bounds: x and y must be non-negative',
        'INVALID_PREVIEW_BOUNDS'
      );
    }

    // Check positive dimensions
    if (width <= 0 || height <= 0) {
      throw new AppError(
        'Invalid preview bounds: width and height must be positive',
        'INVALID_PREVIEW_BOUNDS'
      );
    }

    // Sanity check for reasonable bounds (prevent memory issues)
    const MAX_DIMENSION = 10000;
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      throw new AppError(
        `Invalid preview bounds: dimensions exceed maximum (${MAX_DIMENSION}px)`,
        'INVALID_PREVIEW_BOUNDS'
      );
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
   * Clean up chunk files for terminal NOT_FOUND failures (non-retryable).
   * Expired matches are handled by updateMatchMetadataToExpired / periodic maintenance.
   * Preserves chunks for retryable failures to enable re-uploads.
   */
  private async cleanupChunksForTerminalFailure(
    jobId: string,
    matchHash: string,
    isNotFound?: boolean
  ): Promise<void> {
    // Only cleanup chunks for NOT_FOUND (job doesn't exist on server, non-retryable)
    if (isNotFound !== true) {
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

    console.info('[ArenaCoachDesktop] Initiating chunk cleanup for terminal failure:', {
      matchHash,
      jobId,
      failureType: 'NOT_FOUND',
    });

    try {
      const existingMatch = await this.metadataStorageService.findMatchByJobId(jobId);
      if (existingMatch?.bufferId) {
        const result = await this.chunkCleanupService.cleanupChunksForInstance(
          existingMatch.bufferId,
          jobId
        );
        if (result.success) {
          console.info(
            '[ArenaCoachDesktop] Chunk cleanup completed for terminal failure:',
            matchHash
          );
        } else {
          console.warn('[ArenaCoachDesktop] Chunk cleanup had errors for terminal failure:', {
            matchHash,
            errors: result.errors,
          });
        }
      } else {
        console.warn(
          '[ArenaCoachDesktop] Cannot cleanup chunks: No bufferId found for jobId:',
          jobId
        );
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[ArenaCoachDesktop] Failed to cleanup chunks for terminal failure:', {
        jobId,
        matchHash,
        isNotFound,
        error: errorMessage,
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
   * Perform periodic maintenance pass with staged cleanup:
   * 1. Aged chunk cleanup (delete chunks older than retention window)
   * 2. Expiration maintenance (mark stale uploads as EXPIRED and delete their chunks)
   * 3. Orphan detection (log orphaned chunks for diagnostics; no deletion here)
   */
  private async performPeriodicExpirationCheck(): Promise<void> {
    console.info('[ArenaCoachDesktop] Starting periodic maintenance pass');
    const currentTimeMs = Date.now();

    // Stage 1: Aged chunk cleanup (always runs first)
    try {
      console.info('[ArenaCoachDesktop] Stage 1: Aged chunk cleanup');
      const { agedChunkPaths, scanErrors: agedScanErrors } =
        await this.chunkCleanupService.findAgedChunks(
          ChunkRetentionConfig.RETENTION_MS,
          currentTimeMs
        );

      if (agedScanErrors.length > 0) {
        console.warn('[ArenaCoachDesktop] Aged chunk scan errors:', agedScanErrors);
      }

      if (agedChunkPaths.length > 0) {
        const cleanupResult = await this.chunkCleanupService.cleanupFiles(agedChunkPaths);
        console.info('[ArenaCoachDesktop] Aged chunk cleanup completed:', {
          totalAgedChunks: agedChunkPaths.length,
          deletedCount: cleanupResult.deletedCount,
          missingCount: cleanupResult.missingCount,
          failureCount: cleanupResult.failureCount,
        });
      } else {
        console.debug('[ArenaCoachDesktop] No aged chunks found');
      }
    } catch (error) {
      console.error('[ArenaCoachDesktop] Stage 1 failed (aged chunk cleanup):', error);
      // Continue to next stage
    }

    // Stage 2: Expiration maintenance (packaged app only via ExpirationConfig.isExpired)
    try {
      console.info('[ArenaCoachDesktop] Stage 2: Expiration maintenance');
      const { matches, scanErrors: metadataScanErrors } =
        await this.metadataStorageService.listAllMatchesWithDiagnostics();

      if (metadataScanErrors.length > 0) {
        console.warn('[ArenaCoachDesktop] Metadata scan errors:', metadataScanErrors);
      }

      // Filter for expirable matches (non-terminal upload status, expired by ExpirationConfig, has required fields)
      const expirableMatches: Array<StoredMatchMetadata & { matchHash: string; bufferId: string }> =
        [];
      for (const match of matches) {
        // Skip if already in terminal status or missing required fields
        if (!ArenaCoachDesktop.NON_TERMINAL_UPLOAD_STATUSES.has(match.uploadStatus)) continue;
        if (!match.matchHash || !match.bufferId) continue;
        if (!match.matchData?.timestamp) continue;

        // Check if expired via SSoT config (guard against invalid timestamps)
        const timestampMs = match.matchData.timestamp.getTime();
        if (!Number.isFinite(timestampMs)) {
          console.warn(
            `[ArenaCoachDesktop] Invalid timestamp for match ${match.matchHash}, skipping expiration check`
          );
          continue;
        }

        if (ExpirationConfig.isExpired(timestampMs, currentTimeMs)) {
          // Explicit construction with validated fields (no as cast)
          expirableMatches.push({
            ...match,
            matchHash: match.matchHash,
            bufferId: match.bufferId,
          });
        }
      }

      if (expirableMatches.length > 0) {
        console.info(`[ArenaCoachDesktop] Found ${expirableMatches.length} matches to expire`);

        let metadataUpdatedCount = 0;
        let chunkDeletedCount = 0;
        let failureCount = 0;

        for (const match of expirableMatches) {
          const result = await this.updateMatchMetadataToExpired(match, currentTimeMs);
          if (result.metadataUpdated) {
            metadataUpdatedCount++;
          } else {
            failureCount++;
          }
          if (result.chunkDeleted) {
            chunkDeletedCount++;
          }
          if (result.errors.length > 0) {
            console.warn(
              `[ArenaCoachDesktop] Expiration errors for ${match.matchHash}:`,
              result.errors
            );
          }
        }

        console.info('[ArenaCoachDesktop] Expiration maintenance completed:', {
          totalCandidates: expirableMatches.length,
          metadataUpdatedCount,
          chunkDeletedCount,
          failureCount,
        });
      } else {
        console.debug('[ArenaCoachDesktop] No expired matches found');
      }
    } catch (error) {
      console.error('[ArenaCoachDesktop] Stage 2 failed (expiration maintenance):', error);
      // Continue to next stage
    }

    // Stage 3: Orphan detection (diagnostics only; deletion handled by aged retention)
    try {
      console.info('[ArenaCoachDesktop] Stage 3: Orphan detection');
      const validBufferIds = await this.metadataStorageService.listBufferIdsStrict();

      console.debug(`[ArenaCoachDesktop] Found ${validBufferIds.size} valid bufferIds in metadata`);

      const { orphanedChunkPaths, scanErrors: orphanScanErrors } =
        await this.chunkCleanupService.findOrphanedChunks(validBufferIds);

      if (orphanScanErrors.length > 0) {
        console.warn('[ArenaCoachDesktop] Orphan scan errors:', orphanScanErrors);
      }

      if (orphanedChunkPaths.length > 0) {
        // Log sample basenames for diagnostics (no deletion - handled by aged retention)
        const sampleBasenames = orphanedChunkPaths.slice(0, 5).map(p => path.basename(p));
        console.info(
          '[ArenaCoachDesktop] Orphaned chunks detected (will be cleaned by retention):',
          {
            count: orphanedChunkPaths.length,
            sampleBasenames,
          }
        );
      } else {
        console.debug('[ArenaCoachDesktop] No orphaned chunk files found');
      }
    } catch (error) {
      console.error('[ArenaCoachDesktop] Stage 3 failed (orphan detection):', error);
      // Don't throw - maintenance should continue
    }

    console.info('[ArenaCoachDesktop] Periodic maintenance pass completed');
  }

  /**
   * Handle orphaned matches from previous application sessions.
   * Any 'in_progress' match at startup is orphaned by definition — no match from a
   * previous process can recover to 'complete'. Transition all unconditionally.
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

      const allMatches = await this.metadataStorageService.listAllMatches();

      let processedCount = 0;
      let transitionedCount = 0;

      for (const match of allMatches) {
        if (match.matchCompletionStatus === 'in_progress') {
          const idForLog = match.matchHash || match.bufferId || 'unknown';
          try {
            const updatedMetadata = { ...match };
            updatedMetadata.matchCompletionStatus = 'incomplete';
            updatedMetadata.uploadStatus = UploadStatus.INCOMPLETE;
            updatedMetadata.enrichmentPhase = 'finalized';
            updatedMetadata.errorMessage =
              'Recovered after crash: match incomplete after app restart';
            updatedMetadata.lastUpdatedAt = new Date();

            await this.metadataStorageService.saveMatch(updatedMetadata);

            console.info(
              `[ArenaCoachDesktop] Transitioned orphaned match to incomplete: ${idForLog}`
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
