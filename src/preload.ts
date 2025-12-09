import { contextBridge, ipcRenderer } from 'electron';
import { StoredMatchMetadata, RecordingStatusType } from './match-detection/types/StoredMatchTypes';
import { MatchMetadata } from './match-detection/types/MatchMetadata';
import type { WindowBounds } from './services/SettingsService';
import type { RecordingSettings } from './services/RecordingTypes';
import type { FreemiumQuotaFields } from './Freemium';

// Types for the API
export interface WoWInstallation {
  path: string;
  version: 'retail' | 'classic' | 'classic_era';
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
  analysisId?: string;
  status?: string;
  matchHash: string;
  ssePayload?: SsePayload;
  isSkillCappedViewer?: boolean;
}

export interface AnalysisFailedEvent {
  jobId: string;
  error: string;
  matchHash: string;
  errorCode?: string;
  isPermanent?: boolean;
}

// Settings types - Single Source of Truth aligned with SettingsService
export interface AppSettings {
  maxMatchFiles: number;
  recordingLocation?: string;
  maxDiskStorage?: number; // GB limit for recordings
  recordingEnabled?: boolean;
  matchDetectionEnabled?: boolean;
  windowBounds?: WindowBounds;
  recording: RecordingSettings; // Nested recording settings (SSoT)
  runOnStartup?: boolean;
  wowInstallationPath?: string; // User-validated WoW installation root
}

// Define the API that will be exposed to the renderer process
export interface ArenaCoachAPI {
  // App information
  getVersion(): Promise<string>;
  getEnvironment(): Promise<{ isDevelopment: boolean }>;

  // Window controls
  window: {
    minimize(): Promise<void>;
    maximize(): Promise<void>;
    close(): Promise<void>;
    isMaximized(): Promise<boolean>;
    openExternal(url: string): Promise<{ success: boolean; error?: string }>;
  };

  // Authentication
  auth: {
    isAuthenticated(): Promise<boolean>;
    getCurrentUser(): Promise<UserInfo | null>;
    loginWithBattleNet(): Promise<LoginResult>;
    logout(): Promise<void>;
    verifySkillCapped(code: string): Promise<{ success: boolean; user?: UserInfo; error?: string }>;
    getSkillCappedStatus(): Promise<{ success: boolean; verified: boolean; error?: string }>;

    // Event listeners
    onAuthSuccess(callback: (data: { token: AuthToken; user: UserInfo }) => void): () => void;
    onAuthError(callback: (error: string) => void): () => void;
    onLogout(callback: () => void): () => void;
    onTokenRefreshed(callback: (token: AuthToken) => void): () => void;
  };

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
    getDetectionStatus(): Promise<{
      running: boolean;
      initialized: boolean;
      wowProcessStatus: { isRunning: boolean; isMonitoring: boolean; firstPollCompleted: boolean };
    }>;
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
    onAnalysisJobCreated(callback: (event: AnalysisJobEvent) => void): () => void;
    onAnalysisProgress(callback: (event: AnalysisProgressEvent) => void): () => void;
    onAnalysisCompleted(callback: (event: AnalysisCompletedEvent) => void): () => void;
    onAnalysisFailed(callback: (event: AnalysisFailedEvent) => void): () => void;
    onJobRetry(
      callback: (event: {
        matchHash: string;
        attempt: number;
        delayMs: number;
        errorType: string;
      }) => void
    ): () => void;
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
  };

  // Settings management
  settings: {
    get(): Promise<AppSettings>;
    update(settings: Partial<AppSettings>): Promise<AppSettings>;
    reset(): Promise<AppSettings>;
  };

  // Service status for header indicator
  service: {
    getStatus(): Promise<{ connected: boolean; trackedJobsCount: number; hasAuth: boolean }>;
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
      callback: (status: { connected: boolean; trackedJobsCount: number; hasAuth: boolean }) => void
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
    updateSettings(settings: Partial<RecordingSettings>): Promise<RecordingSettings>;
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
    checkFileExists(path: string): Promise<boolean>;
    getEffectiveDirectory(): Promise<string>;
    getRecordingInfo(bufferId: string): Promise<{
      videoPath: string | null;
      videoDuration: number | null;
      recordingStatus: RecordingStatusType;
      recordingErrorCode: string | null;
      recordingErrorMessage: string | null;
    }>;

    // Event listeners
    onRecordingStarted(callback: (data: { bufferId: string; path: string }) => void): () => void;
    onRecordingCompleted(
      callback: (data: { matchHash: string; path: string; duration: number }) => void
    ): () => void;
    onRecordingError(callback: (error: string) => void): () => void;
    onRecordingUserError(callback: (message: string) => void): () => void;
  };

  // Tray navigation
  onTrayNavigation(callback: (view: string) => void): () => void;
}

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
const api: ArenaCoachAPI = {
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  getEnvironment: () => ipcRenderer.invoke('app:getEnvironment'),

  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    openExternal: (url: string) => ipcRenderer.invoke('window:openExternal', url),
  },

  auth: {
    isAuthenticated: () => ipcRenderer.invoke('auth:isAuthenticated'),
    getCurrentUser: () => ipcRenderer.invoke('auth:getCurrentUser'),
    loginWithBattleNet: () => ipcRenderer.invoke('auth:loginWithBattleNet'),
    logout: () => ipcRenderer.invoke('auth:logout'),
    verifySkillCapped: (code: string) => ipcRenderer.invoke('auth:verifySkillCapped', code),
    getSkillCappedStatus: () => ipcRenderer.invoke('auth:getSkillCappedStatus'),

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
    onJobRetry: (
      callback: (event: {
        matchHash: string;
        attempt: number;
        delayMs: number;
        errorType: string;
      }) => void
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        event: { matchHash: string; attempt: number; delayMs: number; errorType: string }
      ) => callback(event);
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
      callback: (status: { connected: boolean; trackedJobsCount: number; hasAuth: boolean }) => void
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        status: { connected: boolean; trackedJobsCount: number; hasAuth: boolean }
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
    checkFileExists: (path: string) => ipcRenderer.invoke('recording:checkFileExists', path),
    getEffectiveDirectory: () => ipcRenderer.invoke('recording:getEffectiveDirectory'),
    getRecordingInfo: (bufferId: string) =>
      ipcRenderer.invoke('recording:getRecordingInfoForMatch', bufferId),

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
