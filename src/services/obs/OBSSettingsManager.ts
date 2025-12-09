/**
 * OBSSettingsManager - Manages OBS configuration and settings
 * Handles video settings, encoder configuration, and output settings
 */

import * as path from 'path';
import * as osn from 'obs-studio-node';
import { IVideoInfo } from 'obs-studio-node';
import { app } from 'electron';
import {
  ObsVideoFormat,
  ObsColorSpace,
  ObsScaleType,
  ObsFpsType,
  ObsColorRange,
} from '../obsEnums';
import {
  Resolution,
  RESOLUTION_DIMENSIONS,
  RECORDING_FORMAT,
  RecordingQuality,
  QUALITY_BITRATE_KBPS_MAP,
  AudioDevice,
} from '../RecordingTypes';

/**
 * OBS settings subcategory structure
 */
export interface OBSSettingsSubcategory {
  parameters: Array<{
    name: string;
    currentValue: string | number;
    type?: string;
  }>;
}

/**
 * OBS settings category structure
 */
export interface OBSSettingsCategory {
  data: OBSSettingsSubcategory[];
}

/**
 * Configuration for OBS recording
 */
export interface OBSRecorderConfig {
  outputDir?: string;
  resolution?: Resolution;
  fps?: 30 | 60;
  bitrate?: number;
  encoder?: 'nvenc' | 'amd' | 'x264';
  audioDevice?: string;
}

/**
 * Encoder constants for type safety
 */
const Encoder = {
  NVIDIA: 'jim_nvenc',
  AMD: 'h264_texture_amf',
  X264: 'obs_x264',
} as const;

/**
 * Manages OBS settings and configuration
 */
export class OBSSettingsManager {
  private config: OBSRecorderConfig;
  private defaultOutputDir: string;
  private readonly defaultQuality: number;

  // Default audio device fallbacks
  private static readonly DEFAULT_INPUT_DEVICE: AudioDevice = {
    id: 'default',
    name: 'Default Microphone',
  };
  private static readonly DEFAULT_OUTPUT_DEVICE: AudioDevice = {
    id: 'default',
    name: 'Default Desktop Audio',
  };

  constructor(config: OBSRecorderConfig, options: { defaultQuality?: number } = {}) {
    this.config = config;
    this.defaultQuality = options.defaultQuality ?? 23; // Lower = better quality

    // Set up default output directory
    this.defaultOutputDir =
      config.outputDir || path.join(app.getPath('videos'), 'ArenaCoach', 'Recordings');

    // Initialized with config
  }

  /**
   * Get video settings for OBS video context
   */
  public getVideoSettings(): IVideoInfo {
    const resolution = this.getResolutionSettings();
    const fps = this.config.fps ?? 30; // Safe default to 30 FPS if not configured

    return {
      ...resolution,
      fpsNum: fps,
      fpsDen: 1,

      // Required video format properties
      // Using type assertions to handle OBS Studio Node's type issues
      // See https://github.com/stream-labs/obs-studio-node/issues/1260
      outputFormat: ObsVideoFormat.NV12 as unknown as osn.EVideoFormat,
      colorspace: ObsColorSpace.CS709 as unknown as osn.EColorSpace,
      range: ObsColorRange.Default as unknown as osn.ERangeType,
      scaleType: ObsScaleType.Bicubic as unknown as osn.EScaleType,
      fpsType: ObsFpsType.Fractional as unknown as osn.EFPSType,
    };
  }

  /**
   * Get resolution settings based on configuration
   */
  private getResolutionSettings(): {
    baseWidth: number;
    baseHeight: number;
    outputWidth: number;
    outputHeight: number;
  } {
    const resolutionKey = this.config.resolution || '1920x1080';
    const dimensions = RESOLUTION_DIMENSIONS[resolutionKey] || RESOLUTION_DIMENSIONS['1920x1080'];

    return {
      baseWidth: dimensions.width,
      baseHeight: dimensions.height,
      outputWidth: dimensions.width,
      outputHeight: dimensions.height,
    };
  }

  /**
   * Configure OBS output settings
   */
  public configureOutput(config?: OBSRecorderConfig): void {
    const finalConfig = config || this.config;

    // Configuring output settings

    // Set output mode to Advanced for more control
    this.applySetting('Output', 'Mode', 'Advanced');

    // Set recording path
    this.applySetting('Output', 'RecFilePath', this.defaultOutputDir);

    // Configure encoder
    const encoder = this.resolveEncoderId(finalConfig);
    this.applySetting('Output', 'RecEncoder', encoder);

    // Set recording format
    this.applySetting('Output', 'RecFormat', RECORDING_FORMAT);

    // Set keyframe interval to 1 second for better seeking
    this.applySetting('Output', 'Reckeyint_sec', 1);

    // Configure quality based on encoder
    this.configureEncoderQuality(encoder);

    // Output configured with encoder
  }

  /**
   * Apply a setting to OBS using the proper API
   * @param category - OBS settings category (e.g., 'Video', 'Output')
   * @param parameter - Parameter name within the category
   * @param value - Value to set
   * @returns true if parameter was found and updated, false otherwise
   *
   * Common OBS parameters (obs-studio-node v0.23.x):
   * - Video.Base: Base resolution (e.g., '1920x1080')
   * - Video.Output: Output resolution (e.g., '1920x1080')
   * - Video.FPSNum: FPS numerator (e.g., 30 or 60)
   * - Video.FPSDen: FPS denominator (typically 1)
   * - Output.Mode: Output mode ('Simple' or 'Advanced')
   * - Output.RecFilePath: Recording output directory
   * - Output.RecFormat: Recording format (e.g., 'mkv')
   * - Output.Recbitrate: Recording bitrate in kbps
   * - Output.RecEncoder: Encoder selection
   */
  public applySetting(category: string, parameter: string, value: string | number): boolean {
    const settingsResponse = osn.NodeObs.OBS_settings_getSettings(category) as OBSSettingsCategory;
    let parameterFound = false;

    settingsResponse.data.forEach((subcategory: OBSSettingsSubcategory) => {
      subcategory.parameters.forEach(param => {
        if (param.name === parameter) {
          param.currentValue = value;
          parameterFound = true;
        }
      });
    });

    if (parameterFound) {
      osn.NodeObs.OBS_settings_saveSettings(category, settingsResponse.data);
    }

    return parameterFound;
  }

  /**
   * Configure encoder-specific quality settings
   */
  private configureEncoderQuality(encoder: string): void {
    if (encoder === 'obs_x264') {
      // x264 uses CRF
      this.applySetting('Output', 'Recrate_control', 'CRF');
      this.applySetting('Output', 'Reccrf', this.defaultQuality);
    } else if (encoder.includes('nvenc') || encoder.includes('amf')) {
      // Hardware encoders use CQP
      this.applySetting('Output', 'Recrate_control', 'CQP');
      this.applySetting('Output', 'Reccqp', this.defaultQuality);
    }
  }

  /**
   * Select the best available encoder
   */
  private resolveEncoderId(config?: OBSRecorderConfig): string {
    const finalConfig = config || this.config;

    // Check requested encoder type
    if (finalConfig.encoder === 'nvenc') {
      return Encoder.NVIDIA;
    }

    if (finalConfig.encoder === 'amd') {
      return Encoder.AMD;
    }

    // Fallback to x264 software encoder
    return Encoder.X264;
  }

  /**
   * Update the output directory
   */
  public updateOutputDirectory(dir: string): void {
    this.defaultOutputDir = dir;
    this.applySetting('Output', 'RecFilePath', dir);
  }

  /**
   * Get the current output directory
   */
  public getOutputDirectory(): string {
    return this.defaultOutputDir;
  }

  /**
   * Update configuration
   */
  public updateConfig(config: Partial<OBSRecorderConfig>): void {
    this.config = { ...this.config, ...config };
    if (config.outputDir) {
      this.defaultOutputDir = config.outputDir;
    }
    if (config.encoder) {
      // Re-apply encoder immediately to keep OBS in sync
      const encoder = this.resolveEncoderId(this.config);
      // Avoid redundant writes: only configure if applySetting returns true
      const updated = this.applySetting('Output', 'RecEncoder', encoder);
      if (updated) {
        this.configureEncoderQuality(encoder);
      }
    }
  }

  /**
   * Set FPS for video context
   * Note: This updates the video context settings, requires OBS restart to take effect
   */
  public setFPS(fps: 30 | 60): void {
    this.config.fps = fps;

    // Update video settings
    this.applySetting('Video', 'FPSNum', fps);
    this.applySetting('Video', 'FPSDen', 1);
    this.applySetting('Video', 'FPSType', 'Fractional');
  }

  /**
   * Set resolution for video context
   * Updates both base and output resolution
   */
  public setResolution(resolution: Resolution): void {
    this.config.resolution = resolution;
    const dimensions = RESOLUTION_DIMENSIONS[resolution];

    if (!dimensions) {
      throw new Error(`Invalid resolution: ${resolution}`);
    }

    // Update video settings for both base and output resolution
    this.applySetting('Video', 'Base', `${dimensions.width}x${dimensions.height}`);
    this.applySetting('Video', 'Output', `${dimensions.width}x${dimensions.height}`);
  }

  /**
   * Set recording quality (bitrate)
   * Updates encoder bitrate based on quality preset
   */
  public setQuality(quality: RecordingQuality): void {
    const bitrate = QUALITY_BITRATE_KBPS_MAP[quality];

    if (!bitrate) {
      throw new Error(`Invalid quality: ${quality}`);
    }

    this.config.bitrate = bitrate;

    // Apply bitrate to encoder settings (all encoders use same setting)
    this.applySetting('Output', 'Recbitrate', bitrate);
  }

  /**
   * Set capture cursor option
   * Note: This is a placeholder - actual cursor capture is managed by OBSCaptureManager
   * per capture source (game/window/monitor) not globally
   */
  public setCaptureCursor(enabled: boolean): void {
    // Cursor capture is handled per-source in OBSCaptureManager
    // This method exists for API completeness but has no effect
    // The actual setting is applied via captureManager.setCaptureCursor()
  }

  /**
   * Get available input audio devices (microphones)
   */
  public getInputAudioDevices(): AudioDevice[] {
    try {
      // Use the OBS settings API to get input devices
      const inputDevices = osn.NodeObs.OBS_settings_getInputAudioDevices() as any[];

      if (inputDevices && inputDevices.length > 0) {
        return inputDevices.map((device: any) => ({
          id: device.id || 'default',
          // OSN returns { id, description } for devices. Fallback to name if present.
          name: device.name || device.description || device.id || 'Unknown Device',
        }));
      }

      return [OBSSettingsManager.DEFAULT_INPUT_DEVICE];
    } catch (error) {
      console.error('[OBSSettingsManager] Error getting input audio devices:', error);
      return [OBSSettingsManager.DEFAULT_INPUT_DEVICE];
    }
  }

  /**
   * Get available output audio devices (desktop audio)
   */
  public getOutputAudioDevices(): AudioDevice[] {
    try {
      // Use the OBS settings API to get output devices
      const outputDevices = osn.NodeObs.OBS_settings_getOutputAudioDevices() as any[];

      if (outputDevices && outputDevices.length > 0) {
        return outputDevices.map((device: any) => ({
          id: device.id || 'default',
          // OSN returns { id, description } for devices Fallback to name if present.
          name: device.name || device.description || device.id || 'Unknown Device',
        }));
      }

      return [OBSSettingsManager.DEFAULT_OUTPUT_DEVICE];
    } catch (error) {
      console.error('[OBSSettingsManager] Error getting output audio devices:', error);
      return [OBSSettingsManager.DEFAULT_OUTPUT_DEVICE];
    }
  }
}
