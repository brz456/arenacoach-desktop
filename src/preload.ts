import { contextBridge, ipcRenderer } from 'electron';
import { StoredMatchMetadata } from './match-detection/types/StoredMatchTypes';
import { MatchMetadata } from './match-detection/types/MatchMetadata';
import type { AppSettings } from './services/SettingsService';
import type { RecordingSettings } from './services/RecordingTypes';
import type { FreemiumQuotaFields } from './Freemium';
import type {
  DetectionStatusSnapshot,
  RevealResult,
  RecordingInfoResult,
} from './ipc/ipcTypes';
import type { AuthToken, UserInfo, LoginResult } from './authTypes';
import type { JobRetryPayload } from './match-detection/types/JobRetryPayload';
import {
  BRACKET_BY_SLUG,
  BRACKET_LABEL_SKIRMISH,
  ARENA_MAP_IMAGE_KEYS,
  SPEC_BY_ID,
  SPEC_ICON_KEYS,
  CLASS_NAME_TO_ICON_SLUG,
  getRatingIconSlug,
} from '@wow/game-data';

// Types for the API
export interface WoWInstallation {
  path: string;
  combatLogPath: string;
  addonsPath: string;
  addonInstalled: boolean;
  arenaCoachAddonPath: string;
}

export interface AddonInstallationResult {
  success: boolean;
  message: string;
  installedFiles?: string[];
  error?: string;
}

export interface CombatLogSession {
  sessionId: string;
  startTime: Date;
  endTime?: Date;
  installation: WoWInstallation;
  logFilePath: string;
  startPosition: number;
  endPosition?: number;
  rawData: string[];
  isActive: boolean;
  matchType?: string;
  matchBracket?: number;
}

// Match detection types
export enum MatchEventType {
  MATCH_STARTED = 'MATCH_STARTED',
  MATCH_ENDED = 'MATCH_ENDED',
}

export interface MatchStartedEvent {
  type: MatchEventType.MATCH_STARTED;
  timestamp: Date;
  zoneId: number;
  bufferId: string;
}

export interface MatchEndedEvent {
  type: MatchEventType.MATCH_ENDED;
  timestamp: Date;
  bufferId: string;
  metadata: MatchMetadata;
}

export type MatchEvent = MatchStartedEvent | MatchEndedEvent;

// Analysis event types
export interface AnalysisJobEvent {
  jobId: string;
  matchHash: string;
}

export interface AnalysisProgressEvent {
  jobId: string;
  matchHash: string;
  status: 'completed' | 'failed' | 'uploading' | 'pending' | 'queued' | 'processing';
  message?: string;
  originalName?: string;
  queuePosition?: number | null;
  totalInQueue?: number | null;
}

// SSE Payload interface for type safety across IPC boundaries
export interface SsePayload extends Partial<StoredMatchMetadata> {
  id?: string;
  source?: string;
  [key: string]: unknown;
}

export interface AnalysisCompletedEvent extends FreemiumQuotaFields {
  jobId: string;
  analysisId?: number;
  status?: string;
  matchHash: string;
  ssePayload?: SsePayload;
  isPremiumViewer?: boolean;
  premiumSources?: Array<'skillcapped' | 'stripe'>;
}

export interface AnalysisFailedEvent {
  jobId: string;
  error: string;
  matchHash: string;
  isNotFound?: boolean;
  errorCode?: string;
  isPermanent?: boolean;
}

// Game data constants exposed to renderer (SSoT from @wow/game-data)
export interface GameDataAPI {
  /** Bracket labels for comparisons (e.g., BRACKET_LABELS.SoloShuffle === 'Solo Shuffle') */
  BRACKET_LABELS: {
    TwoVTwo: string;
    ThreeVThree: string;
    SoloShuffle: string;
    Skirmish: string;
  };
  /** Bracket display names for UI (e.g., BRACKET_DISPLAY_NAMES.TwoVTwo === '2v2 Arena') */
  BRACKET_DISPLAY_NAMES: {
    TwoVTwo: string;
    ThreeVThree: string;
    SoloShuffle: string;
    Skirmish: string;
  };
  /** Map ID to image filename stem (e.g., 1505 → 'nagrand'), null if unknown */
  getMapImageFilename(mapId: number): string | null;
  /** Spec ID to icon key (e.g., 250 → 'deathknight_blood'), null if unknown */
  getSpecIconFilename(specId: number): string | null;
  /** Lowercase class name to icon slug (e.g., 'deathknight' → 'dk') */
  CLASS_ICON_SLUGS: Record<string, string>;
  /** Spec ID to class ID (e.g., 250 → 6 for Blood DK) */
  getClassIdFromSpec(specId: number): number;
  /** Rating to icon slug (e.g., 2400 → 'elite', 1300 → null) */
  getRatingIconSlug(rating: number): string | null;
}

// Define the API that will be exposed to the renderer process
export interface ArenaCoachAPI {
  // Game data constants (SSoT from @wow/game-data)
  gameData: GameDataAPI;

  // App information
  getVersion(): Promise<string>;
  getEnvironment(): Promise<{ isDevelopment: boolean }>;
  getBillingEnabled(): Promise<
    | { success: true; billingEnabled: boolean }
    | { success: false; error: string }
  >;

  // Window controls
  window: {
    minimize(): Promise<void>;
    maximize(): Promise<void>;
    close(): Promise<void>;
    isMaximized(): Promise<boolean>;
    openExternal(url: string): Promise<{ success: boolean; error?: string }>;
  };

  // Shell operations
  shell: {
    showItemInFolder(filePath: string): Promise<
      | { success: true }
      | {
          success: false;
          error: string;
          code: 'INVALID_PATH' | 'NOT_FOUND' | 'NOT_ALLOWED' | 'OPEN_FAILED' | 'UNKNOWN';
        }
    >;
  };

  // Authentication
  auth: {
    isAuthenticated(): Promise<boolean>;
    getCurrentUser(): Promise<UserInfo | null>;
    loginWithBattleNet(): Promise<LoginResult>;
    logout(): Promise<void>;
    verifySkillCapped(code: string): Promise<{ success: boolean; user?: UserInfo; error?: string }>;
    getSkillCappedStatus(): Promise<{ success: boolean; verified: boolean; error?: string }>;
    getWebLoginUrl(): Promise<{ success: boolean; url?: string; error?: string }>;

    // Event listeners
    onAuthSuccess(callback: (data: { token: AuthToken; user: UserInfo }) => void): () => void;
    onAuthError(callback: (error: string) => void): () => void;
    onLogout(callback: () => void): () => void;
    onTokenRefreshed(callback: (token: AuthToken) => void): () => void;
  };

  refreshBillingStatus(): Promise<
    | { success: true }
    | { success: false; error: string }
  >;

  // WoW installation detection and process monitoring
  wow: {
    detectInstallations(): Promise<WoWInstallation[]>;
    validateInstallation(installPath: string): Promise<WoWInstallation | null>;
    browseInstallation(): Promise<string | null>;

    // Process monitoring event listeners
    onProcessStart(callback: () => void): () => void;
    onProcessStop(callback: () => void): () => void;
    onProcessMonitorError(callback: (error: { message: string }) => void): () => void;
  };

  // Addon management
  addon: {
    checkInstallation(installation: WoWInstallation): Promise<boolean>;
    install(installation: WoWInstallation): Promise<AddonInstallationResult>;
    validateFiles(installation: WoWInstallation): Promise<boolean>;
    onStatusUpdated(callback: (installations: WoWInstallation[]) => void): () => void;
  };

  // Match detection
  match: {
    startDetection(): Promise<void>;
    stopDetection(): Promise<void>;
    getStatus(): Promise<boolean>;
    getDetectionStatus(): Promise<DetectionStatusSnapshot>;
    getCurrentMatch(): Promise<{ bracket: string; timestamp: Date } | null>;
    getTriggerMessage(trigger: string): Promise<string>;

    // Live status updates for Single Source of Truth pattern
    updateLiveStatus(
      matchHash: string,
      status: string,
      progressMessage?: string,
      queuePosition?: number | null,
      totalInQueue?: number | null
    ): Promise<void>;

    // Event listeners
    onMatchStarted(callback: (event: MatchEvent) => void): () => void;
    onMatchListNeedsRefresh(callback: (event: MatchEvent) => void): () => void;
    onMatchEnded(callback: (event: MatchEvent) => void): () => void;
    onMatchEndedIncomplete(
      callback: (event: {
        bufferId: string;
        trigger: string;
        lines: number;
        timestamp: string;
      }) => void
    ): () => void;
    onTimeout(callback: (data: { timeoutMs: number }) => void): () => void;
    onDetectionStarted(callback: () => void): () => void;
    onDetectionStopped(callback: () => void): () => void;
    onDetectionStatusChanged(callback: (status: DetectionStatusSnapshot) => void): () => void;
    onAnalysisJobCreated(callback: (event: AnalysisJobEvent) => void): () => void;
    onAnalysisProgress(callback: (event: AnalysisProgressEvent) => void): () => void;
    onAnalysisCompleted(callback: (event: AnalysisCompletedEvent) => void): () => void;
    onAnalysisFailed(callback: (event: AnalysisFailedEvent) => void): () => void;
    onJobRetry(callback: (event: JobRetryPayload) => void): () => void;
    onStatusUpdated(
      callback: (event: {
        matchHash: string;
        status: string;
        progressMessage?: string;
        queuePosition?: number | null;
        totalInQueue?: number | null;
      }) => void
    ): () => void;
    onMetadataUpdated(callback: (event: { matchHash: string }) => void): () => void;
  };

  // Match metadata storage
  matches: {
    list(limit?: number, offset?: number): Promise<StoredMatchMetadata[]>;
    count(): Promise<number>;
    load(matchHash: string): Promise<StoredMatchMetadata | null>;
    delete(bufferId: string): Promise<boolean>;
    cleanup(): Promise<number>;
    setFavourite(bufferId: string, isFavourite: boolean): Promise<boolean>;
  };

  // Log export for debugging
  logs: {
    export(
      bufferId?: string
    ): Promise<{ success: true; zipPath: string } | { success: false; error: string }>;
  };

  // Settings management
  settings: {
    get(): Promise<AppSettings>;
    update(settings: Partial<AppSettings>): Promise<{
      settings: AppSettings;
      recordingDirUpdateError?: string;
      recordingEnableError?: string;
      recordingDisableError?: string;
    }>;
    reset(): Promise<AppSettings>;
  };

  // Service status for header indicator
  service: {
    getStatus(): Promise<{ connected: boolean; activeUploadsCount: number; hasAuth: boolean }>;
    getQuotaStatus(): Promise<{
      success: boolean;
      data?: {
        quotaDate: string;
        limit: number;
        used: number;
        remaining: number;
        exhausted: boolean;
        resetsAt: string;
      };
      error?: string;
    }>;
    onStatusChanged(
      callback: (status: { connected: boolean; activeUploadsCount: number; hasAuth: boolean }) => void
    ): () => void;
  };

  // Auto-updater functionality
  updater: {
    quitAndInstall(): Promise<void>;

    // Event listeners
    onUpdateAvailable(callback: (version: string) => void): () => void;
    onUpdateDownloaded(callback: () => void): () => void;
    onError(callback: (message: string) => void): () => void;
  };

  // Dialog functionality
  dialogs: {
    showOpenDialog(options: {
      title?: string;
      defaultPath?: string;
      properties: Array<'openFile' | 'openDirectory' | 'multiSelections' | 'createDirectory'>;
      filters?: Array<{ name: string; extensions: string[] }>;
    }): Promise<{ canceled: boolean; filePaths: string[] }>;
  };

  // Scene settings for recording configuration
  scene: {
    getSettings(): Promise<RecordingSettings>;
    getRuntimeEncoder(): Promise<{
      mode: 'auto' | 'manual';
      preferredEncoder: 'nvenc' | 'amd' | 'x264';
      encoder: 'nvenc' | 'amd' | 'x264' | null;
    }>;
    updateSettings(
      settings: Partial<RecordingSettings>
    ): Promise<{ settings: RecordingSettings; obsApplyError?: string }>;
    setActive(active: boolean): Promise<void>;
  };

  // OBS functionality
  obs: {
    isInitialized(): Promise<boolean>;
    preview: {
      show(bounds: { width: number; height: number; x: number; y: number }): Promise<void>;
      updateBounds(bounds: { width: number; height: number; x: number; y: number }): Promise<void>;
      hide(): Promise<void>;
    };
    audio: {
      getDevices(): Promise<{
        input: Array<{ id: string; name: string }>;
        output: Array<{ id: string; name: string }>;
      }>;
    };
    display: {
      getMonitors(): Promise<Array<{ id: string; name: string }>>;
    };
  };

  // Recording functionality
  recording: {
    isInitialized(): Promise<boolean>;
    isEnabled(): Promise<boolean>;
    isRecording(): Promise<boolean>;
    initialize(): Promise<void>;
    enable(): Promise<void>;
    disable(): Promise<void>;
    getStatus(): Promise<{
      isInitialized: boolean;
      isEnabled: boolean;
      isRecording: boolean;
      currentFile: string | null;
      currentMatchHash: string | null;
      diskUsedGB: number;
      cpuUsage: number;
      droppedFrames: number;
    }>;
    getThumbnailPath(bufferId: string): Promise<string | null>;
    getEffectiveDirectory(): Promise<string>;
    getRecordingInfo(bufferId: string): Promise<RecordingInfoResult>;
    revealVideoInFolder(bufferId: string): Promise<RevealResult>;
    revealThumbnailInFolder(bufferId: string): Promise<RevealResult>;

    // Event listeners
    onRecordingStarted(callback: (data: { bufferId: string; path: string }) => void): () => void;
    onRecordingCompleted(
      callback: (data: { matchHash: string; path: string; duration: number }) => void
    ): () => void;
    onRecordingError(callback: (error: string) => void): () => void;
    onRecordingUserError(callback: (message: string) => void): () => void;
    onRecordingRetentionCleanup(
      callback: (data: { deletedCount: number; freedGB: number; maxGB: number }) => void
    ): () => void;
  };

  // Tray navigation
  onTrayNavigation(callback: (view: string) => void): () => void;
}

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
const api: ArenaCoachAPI = {
  // Game data constants (SSoT from @wow/game-data)
  gameData: {
    BRACKET_LABELS: {
      TwoVTwo: BRACKET_BY_SLUG['2v2'].label,
      ThreeVThree: BRACKET_BY_SLUG['3v3'].label,
      SoloShuffle: BRACKET_BY_SLUG['shuffle'].label,
      Skirmish: BRACKET_LABEL_SKIRMISH,
    },
    BRACKET_DISPLAY_NAMES: {
      TwoVTwo: BRACKET_BY_SLUG['2v2'].displayName,
      ThreeVThree: BRACKET_BY_SLUG['3v3'].displayName,
      SoloShuffle: BRACKET_BY_SLUG['shuffle'].displayName,
      Skirmish: BRACKET_LABEL_SKIRMISH,
    },
    getMapImageFilename: (mapId: number): string | null => ARENA_MAP_IMAGE_KEYS[mapId] ?? null,
    getSpecIconFilename: (specId: number): string | null => SPEC_ICON_KEYS[specId] ?? null,
    CLASS_ICON_SLUGS: { ...CLASS_NAME_TO_ICON_SLUG },
    getClassIdFromSpec: (specId: number): number => SPEC_BY_ID[specId]?.classId ?? 0,
    getRatingIconSlug: (rating: number): string | null => getRatingIconSlug(rating),
  },

  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  getEnvironment: () => ipcRenderer.invoke('app:getEnvironment'),
  getBillingEnabled: () => ipcRenderer.invoke('billing:getEnabled'),
  refreshBillingStatus: () => ipcRenderer.invoke('auth:refreshBillingStatus'),

  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    openExternal: (url: string) => ipcRenderer.invoke('window:openExternal', url),
  },

  shell: {
    showItemInFolder: (filePath: string) => ipcRenderer.invoke('shell:showItemInFolder', filePath),
  },

  auth: {
    isAuthenticated: () => ipcRenderer.invoke('auth:isAuthenticated'),
    getCurrentUser: () => ipcRenderer.invoke('auth:getCurrentUser'),
    loginWithBattleNet: () => ipcRenderer.invoke('auth:loginWithBattleNet'),
    logout: () => ipcRenderer.invoke('auth:logout'),
    verifySkillCapped: (code: string) => ipcRenderer.invoke('auth:verifySkillCapped', code),
    getSkillCappedStatus: () => ipcRenderer.invoke('auth:getSkillCappedStatus'),
    getWebLoginUrl: () => ipcRenderer.invoke('auth:getWebLoginUrl'),

    onAuthSuccess: (
      callback: (data: { token: AuthToken; user: UserInfo }) => void
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: { token: AuthToken; user: UserInfo }
      ) => callback(data);
      ipcRenderer.on('auth:success', handler);
      return () => {
        ipcRenderer.removeListener('auth:success', handler);
      };
    },
    onAuthError: (callback: (error: string) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, error: string) => callback(error);
      ipcRenderer.on('auth:error', handler);
      return () => {
        ipcRenderer.removeListener('auth:error', handler);
      };
    },
    onLogout: (callback: () => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent) => callback();
      ipcRenderer.on('auth:logout', handler);
      return () => {
        ipcRenderer.removeListener('auth:logout', handler);
      };
    },
    onTokenRefreshed: (callback: (token: AuthToken) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, token: AuthToken) => callback(token);
      ipcRenderer.on('auth:token-refreshed', handler);
      return () => {
        ipcRenderer.removeListener('auth:token-refreshed', handler);
      };
    },
  },

  wow: {
    detectInstallations: () => ipcRenderer.invoke('wow:detectInstallations'),
    validateInstallation: (installPath: string) =>
      ipcRenderer.invoke('wow:validateInstallation', installPath),
    browseInstallation: () => ipcRenderer.invoke('wow:browseInstallation'),

    onProcessStart: (callback: () => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent) => callback();
      ipcRenderer.on('wow:processStart', handler);
      return () => {
        ipcRenderer.removeListener('wow:processStart', handler);
      };
    },
    onProcessStop: (callback: () => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent) => callback();
      ipcRenderer.on('wow:processStop', handler);
      return () => {
        ipcRenderer.removeListener('wow:processStop', handler);
      };
    },
    onProcessMonitorError: (
      callback: (error: { message: string; code?: string; timestamp?: string }) => void
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        error: { message: string; code?: string; timestamp?: string }
      ) => callback(error);
      ipcRenderer.on('wow:processMonitorError', handler);
      return () => {
        ipcRenderer.removeListener('wow:processMonitorError', handler);
      };
    },
  },

  addon: {
    checkInstallation: (installation: WoWInstallation) =>
      ipcRenderer.invoke('addon:checkInstallation', installation),
    install: (installation: WoWInstallation) => ipcRenderer.invoke('addon:install', installation),
    validateFiles: (installation: WoWInstallation) =>
      ipcRenderer.invoke('addon:validateFiles', installation),
    onStatusUpdated: (callback: (installations: WoWInstallation[]) => void) => {
      const handler = (_event: unknown, installations: WoWInstallation[]) =>
        callback(installations);
      ipcRenderer.on('addon:statusUpdated', handler);
      return () => {
        ipcRenderer.removeListener('addon:statusUpdated', handler);
      };
    },
  },

  match: {
    startDetection: () => ipcRenderer.invoke('match:startDetection'),
    stopDetection: () => ipcRenderer.invoke('match:stopDetection'),
    getStatus: () => ipcRenderer.invoke('match:getStatus'),
    getDetectionStatus: () => ipcRenderer.invoke('match:getDetectionStatus'),
    getCurrentMatch: () => ipcRenderer.invoke('match:getCurrentMatch'),
    getTriggerMessage: (trigger: string): Promise<string> =>
      ipcRenderer.invoke('match:getTriggerMessage', trigger),

    // Live status updates for Single Source of Truth pattern
    updateLiveStatus: (
      matchHash: string,
      status: string,
      progressMessage?: string,
      queuePosition?: number | null,
      totalInQueue?: number | null
    ) =>
      ipcRenderer.invoke(
        'match:updateLiveStatus',
        matchHash,
        status,
        progressMessage,
        queuePosition,
        totalInQueue
      ),

    onMatchStarted: (callback: (event: MatchEvent) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, event: MatchEvent) => callback(event);
      ipcRenderer.on('match:started', handler);
      return () => {
        ipcRenderer.removeListener('match:started', handler);
      };
    },
    onMatchListNeedsRefresh: (callback: (event: MatchEvent) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, event: MatchEvent) => callback(event);
      ipcRenderer.on('match:listNeedsRefresh', handler);
      return () => {
        ipcRenderer.removeListener('match:listNeedsRefresh', handler);
      };
    },
    onMatchEnded: (callback: (event: MatchEvent) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, event: MatchEvent) => callback(event);
      ipcRenderer.on('match:ended', handler);
      return () => {
        ipcRenderer.removeListener('match:ended', handler);
      };
    },
    onMatchEndedIncomplete: (
      callback: (event: {
        bufferId: string;
        trigger: string;
        lines: number;
        timestamp: string;
      }) => void
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        event: { bufferId: string; trigger: string; lines: number; timestamp: string }
      ) => callback(event);
      ipcRenderer.on('match:endedIncomplete', handler);
      return () => {
        ipcRenderer.removeListener('match:endedIncomplete', handler);
      };
    },
    onTimeout: (callback: (data: { timeoutMs: number }) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { timeoutMs: number }) =>
        callback(data);
      ipcRenderer.on('match:timeout', handler);
      return () => {
        ipcRenderer.removeListener('match:timeout', handler);
      };
    },
    onDetectionStarted: (callback: () => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent) => callback();
      ipcRenderer.on('match:detectionStarted', handler);
      return () => {
        ipcRenderer.removeListener('match:detectionStarted', handler);
      };
    },
    onDetectionStopped: (callback: () => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent) => callback();
      ipcRenderer.on('match:detectionStopped', handler);
      return () => {
        ipcRenderer.removeListener('match:detectionStopped', handler);
      };
    },
    onDetectionStatusChanged: (
      callback: (status: DetectionStatusSnapshot) => void
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        status: DetectionStatusSnapshot
      ) => callback(status);
      ipcRenderer.on('match:detectionStatusChanged', handler);
      return () => {
        ipcRenderer.removeListener('match:detectionStatusChanged', handler);
      };
    },
    onAnalysisJobCreated: (callback: (event: AnalysisJobEvent) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, event: AnalysisJobEvent) =>
        callback(event);
      ipcRenderer.on('analysis:jobCreated', handler);
      return () => {
        ipcRenderer.removeListener('analysis:jobCreated', handler);
      };
    },
    onAnalysisProgress: (callback: (event: AnalysisProgressEvent) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, event: AnalysisProgressEvent) =>
        callback(event);
      ipcRenderer.on('analysis:progress', handler);
      return () => {
        ipcRenderer.removeListener('analysis:progress', handler);
      };
    },
    onAnalysisCompleted: (callback: (event: AnalysisCompletedEvent) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, event: AnalysisCompletedEvent) =>
        callback(event);
      ipcRenderer.on('analysis:completed', handler);
      return () => {
        ipcRenderer.removeListener('analysis:completed', handler);
      };
    },
    onAnalysisFailed: (callback: (event: AnalysisFailedEvent) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, event: AnalysisFailedEvent) =>
        callback(event);
      ipcRenderer.on('analysis:failed', handler);
      return () => {
        ipcRenderer.removeListener('analysis:failed', handler);
      };
    },
    onJobRetry: (callback: (event: JobRetryPayload) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, event: JobRetryPayload) =>
        callback(event);
      ipcRenderer.on('match:jobRetry', handler);
      return () => {
        ipcRenderer.removeListener('match:jobRetry', handler);
      };
    },
    onStatusUpdated: (
      callback: (event: {
        matchHash: string;
        status: string;
        progressMessage?: string;
        queuePosition?: number | null;
        totalInQueue?: number | null;
      }) => void
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        event: {
          matchHash: string;
          status: string;
          progressMessage?: string;
          queuePosition?: number | null;
          totalInQueue?: number | null;
        }
      ) => callback(event);
      ipcRenderer.on('match:statusUpdated', handler);
      return () => {
        ipcRenderer.removeListener('match:statusUpdated', handler);
      };
    },
    onMetadataUpdated: (callback: (event: { matchHash: string }) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, event: { matchHash: string }) =>
        callback(event);
      ipcRenderer.on('match:metadataUpdated', handler);
      return () => {
        ipcRenderer.removeListener('match:metadataUpdated', handler);
      };
    },
  },

  matches: {
    list: (limit?: number, offset?: number) => ipcRenderer.invoke('matches:list', limit, offset),
    count: () => ipcRenderer.invoke('matches:count'),
    load: (matchHash: string) => ipcRenderer.invoke('matches:load', matchHash),
    delete: (bufferId: string) => ipcRenderer.invoke('matches:delete', bufferId),
    cleanup: () => ipcRenderer.invoke('matches:cleanup'),
    setFavourite: (bufferId: string, isFavourite: boolean) =>
      ipcRenderer.invoke('matches:setFavourite', bufferId, isFavourite),
  },

  logs: {
    export: (bufferId?: string) => ipcRenderer.invoke('logs:export', bufferId),
  },

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (settings: Partial<AppSettings>) => ipcRenderer.invoke('settings:update', settings),
    reset: () => ipcRenderer.invoke('settings:reset'),
  },

  service: {
    getStatus: () => ipcRenderer.invoke('service:getStatus'),
    getQuotaStatus: () => ipcRenderer.invoke('quota:getStatus'),
    onStatusChanged: (
      callback: (status: { connected: boolean; activeUploadsCount: number; hasAuth: boolean }) => void
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        status: { connected: boolean; activeUploadsCount: number; hasAuth: boolean }
      ) => callback(status);
      ipcRenderer.on('service:statusChanged', handler);
      return () => {
        ipcRenderer.removeListener('service:statusChanged', handler);
      };
    },
  },

  updater: {
    quitAndInstall: () => ipcRenderer.invoke('updater:quitAndInstall'),

    onUpdateAvailable: (callback: (version: string) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, version: string) => callback(version);
      ipcRenderer.on('updater:updateAvailable', handler);
      return () => {
        ipcRenderer.removeListener('updater:updateAvailable', handler);
      };
    },
    onUpdateDownloaded: (callback: () => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent) => callback();
      ipcRenderer.on('updater:updateDownloaded', handler);
      return () => {
        ipcRenderer.removeListener('updater:updateDownloaded', handler);
      };
    },
    onError: (callback: (message: string) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, message: string) => callback(message);
      ipcRenderer.on('updater:error', handler);
      return () => {
        ipcRenderer.removeListener('updater:error', handler);
      };
    },
  },

  dialogs: {
    showOpenDialog: (options: {
      title?: string;
      defaultPath?: string;
      properties: Array<'openFile' | 'openDirectory' | 'multiSelections' | 'createDirectory'>;
      filters?: Array<{ name: string; extensions: string[] }>;
    }) => ipcRenderer.invoke('dialog:showOpenDialog', options),
  },

  scene: {
    getSettings: () => ipcRenderer.invoke('scene:getSettings'),
    getRuntimeEncoder: () => ipcRenderer.invoke('scene:getRuntimeEncoder'),
    updateSettings: (settings: Partial<RecordingSettings>) =>
      ipcRenderer.invoke('scene:updateSettings', settings),
    setActive: (active: boolean) => ipcRenderer.invoke('scene:setActive', active),
  },

  obs: {
    isInitialized: () => ipcRenderer.invoke('obs:isInitialized'),
    preview: {
      show: (bounds: { width: number; height: number; x: number; y: number }) =>
        ipcRenderer.invoke('obs:preview:show', bounds),
      updateBounds: (bounds: { width: number; height: number; x: number; y: number }) =>
        ipcRenderer.invoke('obs:preview:updateBounds', bounds),
      hide: () => ipcRenderer.invoke('obs:preview:hide'),
    },
    audio: {
      getDevices: () => ipcRenderer.invoke('obs:audio:getDevices'),
    },
    display: {
      getMonitors: () => ipcRenderer.invoke('obs:display:getMonitors'),
    },
  },

  recording: {
    isInitialized: () => ipcRenderer.invoke('recording:isInitialized'),
    isEnabled: () => ipcRenderer.invoke('recording:isEnabled'),
    isRecording: () => ipcRenderer.invoke('recording:isRecording'),
    initialize: () => ipcRenderer.invoke('recording:initialize'),
    enable: () => ipcRenderer.invoke('recording:enable'),
    disable: () => ipcRenderer.invoke('recording:disable'),
    getStatus: () => ipcRenderer.invoke('recording:getStatus'),
    getThumbnailPath: (bufferId: string) =>
      ipcRenderer.invoke('recording:getThumbnailForMatch', bufferId),
    getEffectiveDirectory: () => ipcRenderer.invoke('recording:getEffectiveDirectory'),
    getRecordingInfo: (bufferId: string) =>
      ipcRenderer.invoke('recording:getRecordingInfoForMatch', bufferId),
    revealVideoInFolder: (bufferId: string) =>
      ipcRenderer.invoke('recording:revealVideoInFolder', bufferId),
    revealThumbnailInFolder: (bufferId: string) =>
      ipcRenderer.invoke('recording:revealThumbnailInFolder', bufferId),

    onRecordingStarted: (
      callback: (data: { bufferId: string; path: string }) => void
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: { bufferId: string; path: string }
      ) => callback(data);
      ipcRenderer.on('recording:started', handler);
      return () => {
        ipcRenderer.removeListener('recording:started', handler);
      };
    },
    onRecordingCompleted: (
      callback: (data: { matchHash: string; path: string; duration: number }) => void
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: { matchHash: string; path: string; duration: number }
      ) => callback(data);
      ipcRenderer.on('recording:completed', handler);
      return () => {
        ipcRenderer.removeListener('recording:completed', handler);
      };
    },
    onRecordingError: (callback: (error: string) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, error: string) => callback(error);
      ipcRenderer.on('recording:error', handler);
      return () => {
        ipcRenderer.removeListener('recording:error', handler);
      };
    },
    onRecordingUserError: (callback: (message: string) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, message: string) => callback(message);
      ipcRenderer.on('recording:userError', handler);
      return () => {
        ipcRenderer.removeListener('recording:userError', handler);
      };
    },
    onRecordingRetentionCleanup: (
      callback: (data: { deletedCount: number; freedGB: number; maxGB: number }) => void
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: { deletedCount: number; freedGB: number; maxGB: number }
      ) => callback(data);
      ipcRenderer.on('recording:retentionCleanup', handler);
      return () => {
        ipcRenderer.removeListener('recording:retentionCleanup', handler);
      };
    },
  },

  // Tray navigation
  onTrayNavigation: (callback: (view: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, view: string) => callback(view);
    ipcRenderer.on('navigate-to-view', handler);
    return () => {
      ipcRenderer.removeListener('navigate-to-view', handler);
    };
  },
};

// Expose the API to the renderer process
contextBridge.exposeInMainWorld('arenaCoach', api);

// Type declaration for the renderer process
declare global {
  interface Window {
    arenaCoach: ArenaCoachAPI;
  }
}
