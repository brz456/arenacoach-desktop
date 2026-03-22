import Store from 'electron-store';
import {
  RecordingSettings,
  RecordingQuality,
  CaptureMode,
  RESOLUTION_DIMENSIONS,
  EncoderMode,
} from './RecordingTypes';

// Canonical minimum window dimensions - used in BrowserWindow config and window bounds clamping
export const MIN_WINDOW_WIDTH = 1000;
export const MIN_WINDOW_HEIGHT = 750;

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export type MistakeViewMode = 'all' | 'mine';

export interface EnabledBracketsSettings {
  skirmish: boolean;
}

export interface AppSettings {
  maxMatchFiles: number;
  recordingLocation?: string;
  maxDiskStorage?: number; // GB limit for recordings
  recordingEnabled?: boolean;
  matchDetectionEnabled?: boolean;
  windowBounds?: WindowBounds;
  recording: StoredRecordingSettings; // Nested recording settings
  runOnStartup?: boolean;
  minimizeToTray: boolean; // Close button minimizes to tray instead of quitting
  showMmrBadge: boolean; // Show MMR badge on match cards
  defaultMistakeView: MistakeViewMode; // Default event-filter player scope
  enabledBrackets: EnabledBracketsSettings; // Which detected brackets are allowed into processing
  wowInstallationPath?: string; // User-validated WoW installation root
}

export type StoredRecordingSettings = RecordingSettings & {
  encoderMode?: EncoderMode;
};

const DEFAULT_SETTINGS: AppSettings = {
  maxMatchFiles: 1000,
  maxDiskStorage: 100, // 100 GB default
  recordingEnabled: true,
  matchDetectionEnabled: true,
  windowBounds: {
    width: 1650, // Optimal 4-column layout
    height: 1000,
  },
  recording: {
    captureMode: CaptureMode.WINDOW,
    resolution: '1920x1080',
    fps: 30,
    quality: RecordingQuality.MEDIUM,
    encoder: 'x264',
    encoderMode: 'auto',
    desktopAudioEnabled: false,
    desktopAudioDevice: 'default',
    microphoneAudioEnabled: false,
    microphoneDevice: 'default',
    captureCursor: true,
    audioSuppressionEnabled: true,
    forceMonoInput: true,
  },
  runOnStartup: true,
  minimizeToTray: true, // Default: close button minimizes to tray
  showMmrBadge: true, // Default: show MMR badge on match cards
  defaultMistakeView: 'all',
  enabledBrackets: {
    skirmish: true,
  },
};

/**
 * Simple settings service using electron-store
 * Handles atomic writes automatically and provides simple get/set interface
 */
export class SettingsService {
  private store: Store<AppSettings>;

  constructor() {
    this.store = new Store<AppSettings>({
      name: 'settings',
      defaults: DEFAULT_SETTINGS,
      schema: {
        maxMatchFiles: {
          type: 'number',
          minimum: 0,
          maximum: 100000,
        },
        recordingLocation: {
          type: 'string',
        },
        maxDiskStorage: {
          type: 'number',
          minimum: 0,
          maximum: 1000,
        },
        recordingEnabled: {
          type: 'boolean',
        },
        matchDetectionEnabled: {
          type: 'boolean',
        },
        runOnStartup: {
          type: 'boolean',
        },
        minimizeToTray: {
          type: 'boolean',
        },
        showMmrBadge: {
          type: 'boolean',
        },
        defaultMistakeView: {
          type: 'string',
          enum: ['all', 'mine'],
        },
        enabledBrackets: {
          type: 'object',
          properties: {
            skirmish: { type: 'boolean' },
          },
          required: ['skirmish'],
        },
        wowInstallationPath: {
          type: 'string',
          maxLength: 1024,
        },
        windowBounds: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
          required: ['width', 'height'],
        },
        recording: {
          type: 'object',
          properties: {
            captureMode: {
              type: 'string',
              enum: ['game_capture', 'window_capture', 'monitor_capture'],
            },
            resolution: {
              type: 'string',
              enum: Object.keys(RESOLUTION_DIMENSIONS),
            },
            fps: {
              type: 'number',
              enum: [30, 60],
            },
            quality: {
              type: 'string',
              enum: ['low', 'medium', 'high', 'ultra'],
            },
            encoder: {
              type: 'string',
              enum: ['nvenc', 'amd', 'x264'],
            },
            encoderMode: {
              type: 'string',
              enum: ['auto', 'manual'],
            },
            desktopAudioEnabled: { type: 'boolean' },
            desktopAudioDevice: { type: 'string' },
            microphoneAudioEnabled: { type: 'boolean' },
            microphoneDevice: { type: 'string' },
            captureCursor: { type: 'boolean' },
            monitorId: { type: 'string' },
            audioSuppressionEnabled: { type: 'boolean' },
            forceMonoInput: { type: 'boolean' },
          },
          required: ['captureMode', 'resolution', 'fps', 'quality'],
        },
      },
    });
  }

  getSettings(): AppSettings {
    return this.store.store;
  }

  updateSettings(newSettings: Partial<AppSettings>): AppSettings {
    // Let electron-store schema handle all validation
    const { recording, enabledBrackets, ...otherSettings } = newSettings;

    // Filter out undefined values to avoid unintended deletes
    const entries = Object.entries(otherSettings).filter(([, v]) => v !== undefined);
    if (entries.length > 0) {
      this.store.set(Object.fromEntries(entries) as Partial<AppSettings>);
    }

    // Handle nested recording object with proper merge
    if (recording !== undefined) {
      const currentRecording = {
        ...DEFAULT_SETTINGS.recording,
        ...this.store.get('recording', DEFAULT_SETTINGS.recording),
      };
      const mergedRecording = { ...currentRecording, ...recording };
      this.store.set('recording', mergedRecording);
    }

    if (enabledBrackets !== undefined) {
      const currentEnabledBrackets = {
        ...DEFAULT_SETTINGS.enabledBrackets,
        ...this.store.get('enabledBrackets', DEFAULT_SETTINGS.enabledBrackets),
      };
      const mergedEnabledBrackets = {
        ...currentEnabledBrackets,
        ...Object.fromEntries(Object.entries(enabledBrackets).filter(([, v]) => v !== undefined)),
      };
      this.store.set('enabledBrackets', mergedEnabledBrackets);
    }

    return this.getSettings();
  }

  /**
   * Save window position and size
   */
  saveWindowBounds(bounds: WindowBounds): void {
    this.updateSettings({ windowBounds: bounds });
  }

  /**
   * Get saved window bounds
   */
  getWindowBounds(): WindowBounds {
    return this.store.get('windowBounds', DEFAULT_SETTINGS.windowBounds!);
  }

  resetToDefaults(): AppSettings {
    this.store.clear();
    return this.getSettings();
  }

  /**
   * Get the persisted WoW installation path
   */
  getWoWInstallationPath(): string | undefined {
    return this.store.get('wowInstallationPath');
  }

  /**
   * Set the WoW installation path
   * Empty string is treated as undefined (clears the setting)
   */
  setWoWInstallationPath(path: string | undefined): void {
    if (path === undefined || path === '') {
      this.store.delete('wowInstallationPath');
    } else {
      this.store.set('wowInstallationPath', path);
    }
  }
}
