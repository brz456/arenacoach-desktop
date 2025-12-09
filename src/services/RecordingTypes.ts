// Recording quality levels
export enum RecordingQuality {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  ULTRA = 'ultra'
}

// Bitrate mapping in kbps (industry standard)
export const QUALITY_BITRATE_KBPS_MAP = {
  [RecordingQuality.LOW]: 4000,    // 4 Mbps (4000 kbps)
  [RecordingQuality.MEDIUM]: 6000, // 6 Mbps (6000 kbps)
  [RecordingQuality.HIGH]: 8000,   // 8 Mbps (8000 kbps)
  [RecordingQuality.ULTRA]: 12000  // 12 Mbps (12000 kbps)
} as const;

// Resolution options
export type Resolution = '1280x720' | '1920x1080' | '2560x1440' | '3440x1440';

// Resolution to pixels mapping
export const RESOLUTION_DIMENSIONS = {
  '1280x720': { width: 1280, height: 720 },
  '1920x1080': { width: 1920, height: 1080 },
  '2560x1440': { width: 2560, height: 1440 },
  '3440x1440': { width: 3440, height: 1440 }
} as const;

// Recording format constants (SSoT)
export const RECORDING_FORMAT = 'mp4';
export const RECORDING_EXTENSION = '.mp4';
export const THUMBNAIL_EXTENSION = '.jpg';

// Encoder options
export type EncoderType = 'nvenc' | 'amd' | 'x264';

// Capture modes
export enum CaptureMode {
  GAME = 'game_capture',
  WINDOW = 'window_capture', 
  MONITOR = 'monitor_capture'
}

// Audio device interface matching OBS
export interface AudioDevice {
  id: string;
  name: string;
}

// Complete recording settings
export interface RecordingSettings {
  captureMode: CaptureMode;
  resolution: Resolution;
  fps: 30 | 60;
  quality: RecordingQuality;
  encoder?: EncoderType; // Optional; defaults to x264 where available
  desktopAudioEnabled: boolean;
  desktopAudioDevice: string; // Device ID or 'default'
  microphoneAudioEnabled: boolean;
  microphoneDevice: string; // Device ID or 'default'
  captureCursor: boolean;
  monitorId?: string; // Monitor ID for monitor capture mode
  audioSuppressionEnabled: boolean;
  forceMonoInput: boolean;
}

// DETERMINISTIC SAFETY RULES
// Settings that can change during recording (live-applied)
export const SAFE_RECORDING_SETTINGS = [
  // Intentionally empty for now; all scene settings are unsafe during recording
] as const;

// Settings that MUST be blocked during recording
// UI: disabled with tooltip "Stop recording to change"
// IPC: rejected with error code RECORDING_ACTIVE
export const UNSAFE_RECORDING_SETTINGS = [
  'captureMode',      // Cannot switch capture source mid-recording
  'resolution',       // Cannot change video dimensions mid-recording
  'fps',             // Cannot change framerate mid-recording
  'quality',         // Cannot change bitrate mid-recording
  'encoder',         // Cannot change encoder mid-recording
  'desktopAudioEnabled',    // Cannot toggle audio tracks mid-recording
  'microphoneAudioEnabled', // Cannot toggle audio tracks mid-recording
  'captureCursor',          // Cannot toggle cursor overlay mid-recording
  'desktopAudioDevice',    // Cannot switch audio devices mid-recording
  'microphoneDevice',      // Cannot switch audio devices mid-recording
  'monitorId',             // Cannot switch monitors mid-recording
  'audioSuppressionEnabled', // Cannot change suppression mid-recording
  'forceMonoInput'          // Cannot change mono state mid-recording
] as const;

// Type guards
export type SafeRecordingSetting = typeof SAFE_RECORDING_SETTINGS[number];
export type UnsafeRecordingSetting = typeof UNSAFE_RECORDING_SETTINGS[number];

// IPC Error types
export type IpcErrorCode = 
  | 'RECORDING_ACTIVE' 
  | 'OBS_NOT_INITIALIZED' 
  | 'INVALID_SETTING' 
  | 'PREVIEW_UNAVAILABLE' 
  | 'BAD_BOUNDS';

export interface IpcError {
  code: IpcErrorCode;
  message: string;
  details?: unknown;
}