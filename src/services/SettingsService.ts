import Store from 'electron-store';
import {
  RecordingSettings,
  RecordingQuality,
  CaptureMode,
  RESOLUTION_DIMENSIONS,
} from './RecordingTypes';

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export interface AppSettings {
  maxMatchFiles: number;
  recordingLocation?: string;
  maxDiskStorage?: number; // GB limit for recordings
  recordingEnabled?: boolean;
  matchDetectionEnabled?: boolean;
  windowBounds?: WindowBounds;
  recording: RecordingSettings; // Nested recording settings
  runOnStartup?: boolean;
  wowInstallationPath?: string; // User-validated WoW installation root
}

const DEFAULT_SETTINGS: AppSettings = {
  maxMatchFiles: 1000,
  maxDiskStorage: 50, // 50 GB default
  recordingEnabled: true,
  matchDetectionEnabled: true,
  windowBounds: {
    width: 1400,
    height: 1000,
  },
  recording: {
    captureMode: CaptureMode.WINDOW,
    resolution: '1920x1080',
    fps: 60,
    quality: RecordingQuality.MEDIUM,
    encoder: 'x264',
    desktopAudioEnabled: false,
    desktopAudioDevice: 'default',
    microphoneAudioEnabled: false,
    microphoneDevice: 'default',
    captureCursor: true,
    audioSuppressionEnabled: true,
    forceMonoInput: true,
  },
  runOnStartup: true,
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
        wowInstallationPath: {
          type: 'string',
          maxLength: 1024,
        },
        windowBounds: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number', minimum: 1400 },
            height: { type: 'number', minimum: 900 },
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
    const { recording, ...otherSettings } = newSettings;

    // Filter out undefined values to avoid unintended deletes
    const entries = Object.entries(otherSettings).filter(([, v]) => v !== undefined);
    if (entries.length > 0) {
      this.store.set(Object.fromEntries(entries) as Partial<AppSettings>);
    }

    // Handle nested recording object with proper merge
    if (recording !== undefined) {
      const currentRecording = this.store.get('recording', DEFAULT_SETTINGS.recording);
      const mergedRecording = { ...currentRecording, ...recording };
      this.store.set('recording', mergedRecording);
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
