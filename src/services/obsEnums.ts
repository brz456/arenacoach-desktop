/**
 * OBS Studio Type Definitions
 *
 * These enums mirror the native OBS Studio C API constants required for
 * obs-studio-node integration. All values are derived directly from the
 * OBS Studio source code.
 *
 * Verified Sources (2024-12-09):
 * - obs_scale_type enum: https://github.com/obsproject/obs-studio/blob/master/libobs/obs.h
 * - video_format, video_colorspace, video_range_type: https://github.com/obsproject/obs-studio/blob/master/libobs/media-io/video-io.h
 * - output_signals array: https://github.com/obsproject/obs-studio/blob/master/libobs/obs-output.c
 *
 * License: OBS Studio is licensed under GPL v2. These enum definitions are
 * factual representations of the OBS API.
 */

// =============================================================================
// OUTPUT SIGNAL TYPES
// =============================================================================

/**
 * Recording output signal names emitted by OBS during recording lifecycle.
 *
 * Verified from libobs/obs-output.c output_signals array:
 *   "void start(ptr output)"
 *   "void stop(ptr output, int code)"
 *   "void starting(ptr output)"
 *   "void stopping(ptr output)"
 *   "void activate(ptr output)"
 *   "void deactivate(ptr output)"
 *   "void reconnect(ptr output)"
 *   "void reconnect_success(ptr output)"
 *
 * Reference: https://github.com/obsproject/obs-studio/blob/master/libobs/obs-output.c
 */
export const enum ObsRecordingSignal {
  // --- Core libobs signals (verified in obs-output.c) ---
  /** Output is initializing, about to begin */
  Starting = 'starting',
  /** Output has successfully started */
  Start = 'start',
  /** Output source has become active */
  Activate = 'activate',
  /** Output is in the process of stopping */
  Stopping = 'stopping',
  /** Output has fully stopped */
  Stop = 'stop',
  /** Output source has been deactivated */
  Deactivate = 'deactivate',
  /** Attempting to reconnect (streaming) */
  Reconnect = 'reconnect',
  /** Reconnection successful (streaming) */
  ReconnectSuccess = 'reconnect_success',

  // --- File output signals (obs-studio-node specific) ---
  /** File chunk was successfully written */
  Wrote = 'wrote',
  /** File write error (disk full, permission denied, etc.) */
  WritingError = 'writing_error',
}

// =============================================================================
// VIDEO CONFIGURATION TYPES
// =============================================================================

/**
 * Video pixel formats supported by OBS.
 * Maps to enum video_format in libobs/media-io/video-io.h
 *
 * Reference: https://github.com/obsproject/obs-studio/blob/master/libobs/media-io/video-io.h#L31
 */
export const enum ObsVideoFormat {
  None = 0,
  I420 = 1, // Planar 4:2:0
  NV12 = 2, // Semi-planar 4:2:0 (most common for hardware encoding)
  YVYU = 3, // Packed 4:2:2
  YUY2 = 4, // Packed 4:2:2
  UYVY = 5, // Packed 4:2:2
  RGBA = 6, // 32-bit RGBA
  BGRA = 7, // 32-bit BGRA
  BGRX = 8, // 32-bit BGRx (no alpha)
  Y800 = 9, // Grayscale
  I444 = 10, // Planar 4:4:4
  BGR3 = 11, // 24-bit BGR
  I422 = 12, // Planar 4:2:2
  I40A = 13, // I420 with alpha
  I42A = 14, // I422 with alpha
  YUVA = 15, // Packed 4:4:4 with alpha
  AYUV = 16, // Packed 4:4:4 with alpha (different order)
}

/**
 * Color space definitions for video output.
 * Maps to enum video_colorspace in libobs/media-io/video-io.h
 *
 * Reference: https://github.com/obsproject/obs-studio/blob/master/libobs/media-io/video-io.h#L55
 */
export const enum ObsColorSpace {
  Default = 0, // Auto-detect
  CS601 = 1, // ITU-R BT.601 (SD)
  CS709 = 2, // ITU-R BT.709 (HD) - recommended for most use cases
  SRGB = 3, // sRGB
  CS2100PQ = 4, // ITU-R BT.2100 PQ (HDR)
  CS2100HLG = 5, // ITU-R BT.2100 HLG (HDR)
}

/**
 * Color range for video output (full vs limited).
 * Maps to enum video_range_type in libobs/media-io/video-io.h
 *
 * Reference: https://github.com/obsproject/obs-studio/blob/master/libobs/media-io/video-io.h#L65
 */
export const enum ObsColorRange {
  Default = 0, // Auto-detect
  Partial = 1, // Limited range (16-235) - standard for broadcast
  Full = 2, // Full range (0-255) - common for PC displays
}

/**
 * Video scaling algorithms.
 * Maps to enum obs_scale_type in libobs/obs.h
 *
 * Reference: https://github.com/obsproject/obs-studio/blob/master/libobs/obs.h
 */
export const enum ObsScaleType {
  Disable = 0, // No scaling
  Point = 1, // Nearest neighbor (fastest, pixelated)
  Bicubic = 2, // Bicubic interpolation (balanced)
  Bilinear = 3, // Bilinear interpolation (fast, smooth)
  Lanczos = 4, // Lanczos (highest quality, slowest)
  Area = 5, // Area averaging (good for downscaling)
}

/**
 * FPS specification type.
 * Maps to enum obs_fps_type used in video settings.
 *
 * Reference: obs-studio-node video configuration
 */
export const enum ObsFpsType {
  Common = 0, // Use common FPS presets (30, 60)
  Integer = 1, // Specify as integer value
  Fractional = 2, // Specify as numerator/denominator fraction
}
