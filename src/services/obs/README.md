# OBS Recording Subsystem

**OBS Studio Node integration for automated arena match recording.**

---

## Overview

The OBS subsystem provides video recording capabilities for arena matches
through OBS Studio Node. It manages capture sources (game/window/monitor),
video/audio settings, live preview, and storage quota enforcement.

**Architecture:**

- **OBSRecorder** - Core OBS lifecycle management with per-session state machine
- **OBSCaptureManager** - Source management and WoW window detection
- **OBSSettingsManager** - Video/audio configuration
- **OBSPreviewManager** - Live preview display overlay
- **RecordingStorageManager** - Disk usage tracking and quota enforcement

---

## Table of Contents

1. [Component Overview](#component-overview)
2. [OBSRecorder](#obsrecorder)
3. [OBSCaptureManager](#obscapturemanager)
4. [OBSSettingsManager](#obssettingsmanager)
5. [OBSPreviewManager](#obspreviewmanager)
6. [RecordingStorageManager](#recordingstoragemanager)
7. [Type Definitions](#type-definitions)
8. [Recording Flow](#recording-flow)
9. [Error Handling](#error-handling)
10. [Performance](#performance)
11. [Configuration Reference](#configuration-reference)
12. [Troubleshooting](#troubleshooting)
13. [Known Limitations](#known-limitations)
14. [Related Documentation](#related-documentation)

---

## Component Overview

```
┌────────────────────────────────────────────────────────────┐
│                      OBSRecorder                            │
│  • OBS lifecycle (init/start/stop/shutdown)               │
│  • Settings coordination                                   │
│  • Signal handling (recording events)                     │
│  • Main window reference                                  │
└────────────────────────────────────────────────────────────┘
         │
         ├──▶ OBSCaptureManager
         │      • Scene and source management
         │      • Game/window/monitor capture modes
         │      • WoW window detection with backoff
         │      • Audio source management
         │
         ├──▶ OBSSettingsManager
         │      • Video settings (resolution, FPS, quality)
         │      • Audio settings (devices, channels)
         │      • Encoder configuration
         │      • OBS settings API wrapper
         │
         ├──▶ OBSPreviewManager
         │      • Live preview display
         │      • Bounds management
         │      • Offscreen positioning for hide
         │
         └──▶ RecordingStorageManager
                • Disk usage calculation
                • Storage quota enforcement
                • Oldest-first file deletion
```

---

## OBSRecorder

**File:** `../OBSRecorder.ts`

**Responsibility:** Low-level OBS Studio Node management with initialization,
recording lifecycle, and graceful shutdown.

### Key APIs

```typescript
// Initialization
initialize(): Promise<void>

// Recording lifecycle
startRecording(outputPath?: string): Promise<string>
stopRecording(): Promise<StopRecordingResult>
// StopRecordingResult = { ok: true, filePath, durationSeconds } | { ok: false, reason, error?, durationSeconds }

// Settings
updateOutputDirectory(newDirectory: string): void
applyRecordingSettings(settings: Partial<RecordingSettings>): Promise<boolean>
setEncoder(encoder: EncoderType): void

// Status
getStatus(): Promise<RecordingStatus>
getIsInitialized(): boolean
getIsRecording(): boolean

// Preview
setMainWindow(window: BrowserWindow): void
showPreview(bounds: PreviewBounds): Promise<void>
updatePreviewBounds(bounds: PreviewBounds): Promise<void>
hidePreview(): void

// WoW integration
setWoWActive(active: boolean): void
setGameCaptureEnabled(enabled: boolean): void

// Audio/Monitor
getAudioDevices(): { input: AudioDevice[], output: AudioDevice[] }
getMonitors(): { id: string, name: string }[]
setMonitorById(monitorId: string): boolean

// Storage
enforceStorageQuota(maxStorageGB: number, protectedVideoPaths?: Set<string>): Promise<StorageQuotaEnforcementResult>

// Cleanup
shutdown(): Promise<void>
```

### Constructor

```typescript
constructor(config: OBSRecorderConfig)

interface OBSRecorderConfig {
  outputDir?: string;      // Default: {videos}/ArenaCoach/Recordings/
  resolution?: Resolution;
  fps?: 30 | 60;
  bitrate?: number;
  encoder?: EncoderType;
  audioDevice?: string;
}
```

### State Management (V3: Per-Session Architecture)

**Initialization:**

- `isInitialized` flag
- Video context (destroyed on shutdown)
- OBS working directory: resolved via `getOBSWorkingDirectory()` (packaging-safe)
- OBS data directory: `{userData}/osn-data/`

**Recording (Per-Session State Machine):**

- `currentSession: RecordingSessionState | null`:
  - `id: string` - Unique session UUID (cryptographically random)
  - `status: 'idle' | 'starting' | 'recording' | 'stopping'`
  - `outputDir: string` - Recording directory for this session
  - `filePath: string | null` - Final file path from OBS
  - `startTime: Date`, `stopTime: Date`
- Stop coordination: Promise + resolver (signal-driven, per-session)
- Derives `isRecording` from
  `currentSession.status === 'recording' || currentSession.status === 'stopping'`

**Settings:**

- `currentSettings` - For diff-based optimization

**Invariants:**

- At most one recording session at any time
- Session IDs prevent cross-session contamination
- Stop timeout (120s hard) returns `StopRecordingResult` with `reason: 'stop_timeout'` (never stale paths from previous sessions)

### Events

```typescript
emit('initialized')
emit('recordingStarted', directory: string)
emit('recordingStopped', filePath: string | null, duration: number)
emit('error', error: Error)
emit('shutdown')
```

### Configuration

```typescript
DEFAULT_OUTPUT_DIR = '{videos}/ArenaCoach/Recordings/';
OBS_WORKING_DIR = getOBSWorkingDirectory(); // packaging-safe resolution
OBS_DATA_DIR = '{userData}/osn-data/';
WARN_TIMEOUT_MS = 30000; // 30-second warning (logs only)
HARD_TIMEOUT_MS = 120000; // 120-second hard timeout (resolves stop_timeout)
```

### Initialization Sequence

1. **ASAR Path Fixing** - Handles `.asar.unpacked` for packaged apps
2. **IPC Connection** - Named pipe: `arena-coach-obs`
3. **OBS Startup** - `osn.NodeObs.OBS_API_initAPI(locale, dataDir, version, '')`
4. **Video Context** - Creates global video context with resolution/FPS
5. **Settings Manager** - Configures output and encoder
6. **Capture Manager** - Initializes scene and sources
7. **Signal Handler** - Monitors output signals for recording events

### Recording Lifecycle (V3: Per-Session)

**Start:**

```typescript
startRecording(outputPath?)
  ├─ Precondition: currentSession is null or status === 'idle'
  ├─ Generate unique session ID (randomUUID)
  ├─ Create currentSession { id, status: 'starting', outputDir, ... }
  ├─ Set recording directory
  ├─ Call osn.NodeObs.OBS_service_startRecording()
  ├─ Wait for 'start' signal → transition to 'recording'
  └─ Return directory path
```

**Stop (Signal-Driven, Per-Session, Two-Phase Timeout):**

```typescript
stopRecording() → StopRecordingResult
  ├─ Precondition: currentSession exists and status !== 'idle'
  │   └─ If no session: return { ok: false, reason: 'no_active_session', durationSeconds: 0 }
  ├─ Idempotency: return existing stopPromise if already stopping
  ├─ Capture sessionId and startTime (for duration after cleanup)
  ├─ Transition currentSession.status = 'stopping'
  ├─ Create Promise + resolver (stored per-session)
  ├─ Set up two-phase timeout:
  │   ├─ Warn timer (30s): logs warning, does NOT resolve or clear session
  │   └─ Hard timer (120s): resolve({ ok: false, reason: 'stop_timeout', durationSeconds }), clear session
  ├─ Call osn.NodeObs.OBS_service_stopRecording()
  ├─ Wait for 'stop' signal from OBS (temporal correlation)
  │   ├─ Guard: ignore stale signals (check session status)
  │   ├─ Call getLastRecording() once per session
  │   ├─ If filePath: resolve({ ok: true, filePath, durationSeconds })
  │   ├─ If no filePath: resolve({ ok: false, reason: 'stop_error', error: '...no recording path', durationSeconds })
  │   ├─ Clear timeouts, resolve promise
  │   └─ Set currentSession = null
  ├─ On error signal (code !== 0 or writing_error):
  │   └─ resolve({ ok: false, reason: 'write_error' | 'stop_error', durationSeconds })
  └─ Return StopRecordingResult
```

**Error Recovery:** (via shared `handleRecordingError` helper)

- Exception in stop: clears timeouts and session, emits `error`, returns `{ ok: false, reason: 'stop_error', error: 'Stop failed: ...', durationSeconds }` (no throw)
- Stop signal with non-zero code: emits `recordingError` event, resolves with `StopRecordingResult` (`reason: 'stop_error'`)
- `writing_error` signal: emits `recordingError` event, resolves with `StopRecordingResult` (`reason: 'write_error'`)

### Shutdown Sequence

1. Destroy preview (`previewManager.destroyPreview()`)
2. Release all sources (`captureManager.releaseAll()`)
3. Destroy video context
4. Run shutdown sequence (`InitShutdownSequence()` →
   `OBS_service_removeCallback()` → `IPC.disconnect()`)

### Key Patterns

- **Promise-based stop coordination** - Stop is signal-driven, not immediate
- **Diff-based settings application** - Only applies changed settings
- **Video context updates** - FPS/resolution changes update context.video and trigger capture rescaling (with rollback on failure)
- **ASAR path fixing** - Handles Electron packaging
- **Graceful shutdown** - Cleanup in reverse initialization order

---

## OBSCaptureManager

**File:** `OBSCaptureManager.ts`

**Responsibility:** Manages OBS capture sources and audio inputs, handles WoW
window attachment with exponential backoff.

### Key APIs

```typescript
import * as osn from 'obs-studio-node';

// Type alias for video context
type VideoContext = ReturnType<typeof osn.VideoFactory.create>;

// Initialization
initialize(context: VideoContext): Promise<void>

// WoW detection
tryAttachToWoWWindow(): void
stopWoWDetection(): void
setWoWActive(active: boolean): void

// Capture modes
setGameCaptureEnabled(enabled: boolean): void
applyCaptureMode(mode: CaptureMode): boolean  // Returns false on failure; callers must not update settings when false
setCaptureCursor(enabled: boolean): boolean

// Audio
setDesktopAudioEnabled(enabled: boolean): void
setDesktopAudioDevice(deviceId: string): void
setMicrophoneAudioEnabled(enabled: boolean): void
setMicrophoneDevice(deviceId: string): void
setMicrophoneSuppression(enabled: boolean): void
setMicrophoneForceMono(enabled: boolean): void

// Monitors
listMonitors(): { id: string, name: string }[]
setMonitorById(monitorId: string): boolean

// Utilities
rescaleToNewDimensions(context: VideoContext): void
releaseAll(): boolean  // Returns true if all resources released successfully
getScene(): IScene | null
```

### Constructor

```typescript
constructor(options?: { hookCheckDelayMs?: number; supervisor?: ObsIpcSupervisor })

// Default hookCheckDelayMs: 500ms
// supervisor: Optional callback for fatal IPC error escalation
```

### Source Architecture

**Scene:** Single scene containing all sources (only one capture enabled at a
time)

**Sources:**

1. **Game Capture** - `game_capture` input (WoW DirectX hook)
2. **Window Capture** - `window_capture` input (alternative capture mode; selected via settings)
3. **Monitor Capture** - `monitor_capture` input (full screen capture)
4. **Desktop Audio** - `wasapi_output_capture` (system audio)
5. **Microphone** - `wasapi_input_capture` (microphone input)
6. **Dummy Window Input** - Hidden helper `window_capture` used for WoW window
   enumeration; created once via `ensureDummyWindowCapture()`, reused across
   polls, released in `releaseAll()`

**Capture Modes:** (enum from `RecordingTypes.ts`)

```typescript
enum CaptureMode {
  GAME = 'game_capture',
  WINDOW = 'window_capture',
  MONITOR = 'monitor_capture'
}
```

### WoW Window Detection

**Game Capture Mode - Exponential Backoff Strategy:**

```
Initial: 500ms
  ↓
Check if hooked → NO
  ↓
Wait 500ms, try again
  ↓
Check if hooked → NO
  ↓
Wait 1s (doubled), try again
  ↓
Check if hooked → NO
  ↓
Wait 2s (doubled), try again
  ↓
... (continues doubling)
  ↓
Max: 30 seconds between attempts
No max attempts (continues while enabled)
```

**Hook Detection:**

- After attaching to window, waits `hookCheckDelayMs` (500ms)
- Checks for non-zero width/height on game capture source
- If dimensions available: scales source and starts dimension monitoring
- If dimensions stay 0 while attached and attempts exceed `LOST_SOURCE_ATTEMPTS`: disables source and schedules reattach with backoff (lost source detection)
- Scaling checks stop after `MAX_SCALE_ATTEMPTS` (no-op terminal branch)
- Continues polling with backoff while game capture enabled

**Window Capture Mode - Continuous Polling:**

- Uses persistent dummy window capture to refresh window list
- 5-second interval between polls
- Dummy created once, reused across polls, released only in `releaseAll()`
- Pattern: `[Wow.exe]: World of Warcraft`
- **Continues polling even after WoW found** to detect window resizes and rescale
- Rescales automatically when source dimensions change
- Stops only when: mode switches away from WINDOW, shutdown, or fatal IPC error

### Capture Modes

**Game Capture:**

- **Target:** `wow.exe` process
- **Method:** DirectX hook injection
- **Best for:** Performance (lowest overhead)
- **Limitation:** Requires WoW hook success

**Window Capture:**

- **Target:** Specific window title
- **Method:** Window composition capture
- **Best for:** Windowed/borderless scenarios or when game capture can't hook; selected via settings/UI (no automatic fallback)
- **Limitation:** Higher overhead than game capture

**Monitor Capture:**

- **Target:** Entire monitor
- **Method:** Screen duplication API
- **Best for:** Multi-window setups, overlays
- **Limitation:** Highest overhead, captures everything

### Audio Management

**Desktop Audio:**

- Source: `wasapi_output_capture`
- Default device: Uses OBS default
- Configurable device selection
- Enable/disable toggle

**Microphone:**

- Source: `wasapi_input_capture`
- Default device: Uses OBS default
- Configurable device selection
- Enable/disable toggle
- Noise suppression support
- Force mono option

### Monitor Capture

**Enumeration:**

```typescript
listMonitors() → [
  { id: '0', name: 'Display 1: 1920x1080 @ 0,0' },
  { id: '1', name: 'Display 2: 2560x1440 @ 1920,0' }
]
```

**Selection:**

- `setMonitorById(id)` updates monitor capture source
- Returns `true` if source updated successfully

### Rescaling

When video context resolution changes:

```typescript
rescaleToNewDimensions(newContext)
  ├─ Store new video context reference
  ├─ Based on currentCaptureMode:
  │   ├─ GAME → trigger checkAndScaleSource() for game capture
  │   ├─ WINDOW → trigger checkAndScaleWindowSource() for window capture
  │   └─ MONITOR → trigger checkAndScaleMonitorSource() for monitor capture
  └─ Scale logic: fit source to output while maintaining aspect ratio
      ├─ scaleX = outputWidth / sourceWidth
      ├─ scaleY = outputHeight / sourceHeight
      ├─ scale = min(scaleX, scaleY)
      └─ Center scaled source in output canvas
```

### Key Patterns

- **Multi-source scene** - All captures in one scene, one enabled at a time
- **WoW detection with exponential backoff** - Graceful degradation
- **Dummy input polling** - Refreshes window list without affecting active
  capture
- **Audio on separate channels** - Desktop + microphone independent
- **Monitor enumeration** - Lists available displays
- **Scale adjustment** - Handles resolution changes
- **Cursor capture SSOT** - Only this service manages cursor setting

---

## OBSSettingsManager

**File:** `OBSSettingsManager.ts`

**Responsibility:** Manages OBS configuration settings through the OBS settings
API.

### Key APIs

```typescript
getVideoSettings(): IVideoInfo
configureOutput(config?: OBSRecorderConfig): void
applySetting(category: string, parameter: string, value: string | number): boolean
updateConfig(config: Partial<OBSRecorderConfig>): void
setResolution(resolution: Resolution): void
setFPS(fps: 30 | 60): void
setQuality(quality: RecordingQuality): void
getInputAudioDevices(): AudioDevice[]
getOutputAudioDevices(): AudioDevice[]
```

### Constructor

```typescript
constructor(
  config: OBSRecorderConfig,
  options?: { defaultQuality?: number }
)

// defaultQuality: CRF value for x264 (default: 23)
```

### Quality Presets

**Bitrate (from QUALITY_BITRATE_KBPS_MAP in RecordingTypes.ts):**

```typescript
LOW:    3000 kbps  (3 Mbps)
MEDIUM: 4500 kbps  (4.5 Mbps)
HIGH:   6500 kbps  (6.5 Mbps)
ULTRA:  9000 kbps  (9 Mbps)
```

**CRF (for x264 encoder):**

- Default: 23 (good quality)
- Lower = better quality, larger files
- Higher = worse quality, smaller files

### Resolution Presets

```typescript
'1280x720'; // 720p
'1920x1080'; // 1080p
'1920x1200'; // 16:10
'2560x1080'; // 21:9
'2560x1440'; // 1440p
'2560x1600'; // 16:10
'3440x1200'; // 21:9
'3440x1440'; // Ultrawide 1440p
'3840x1080'; // 32:9
'3840x1600'; // 21:9
'3840x2160'; // 4K
```

### Encoder Support

```typescript
type EncoderType = 'x264' | 'nvenc' | 'amd';

// Encoder mapping:
x264  → obs_x264           (Software)
nvenc → jim_nvenc          (NVIDIA GPU)
amd   → h264_texture_amf   (AMD GPU)
```

### Output Configuration

**File Format:** MP4 container (`.mp4` extension) **Video Codec:** H.264
(encoder-dependent implementation) **Keyframe Interval:** 1 second **Recording
Format:** Standard (not streaming optimized)

### Key Patterns

- **OBS settings API wrapper** - Abstracts complex settings structures
- **Encoder-specific quality** - `configureEncoderQuality()` sets CRF for x264, CQP for NVENC/AMD; `setQuality()` writes `Output.Recbitrate` using `QUALITY_BITRATE_KBPS_MAP`
- **Subcategory iteration** - OBS settings organized hierarchically
- **Audio device handling** - Returns default device entry on empty/error (errors logged); device IDs may be 'default' when OSN omits ID

---

## OBSPreviewManager

**File:** `OBSPreviewManager.ts`

**Responsibility:** Manages the OBS preview display overlay for the Scene tab.

### Key APIs

```typescript
setMainWindow(window: BrowserWindow): void
setScene(scene: IScene): void
showPreview(bounds: PreviewBounds): Promise<void>
updatePreviewBounds(bounds: PreviewBounds): Promise<void>
hidePreview(): void
destroyPreview(): void
```

### PreviewBounds

```typescript
interface PreviewBounds {
  x: number; // X position in main window
  y: number; // Y position in main window
  width: number; // Preview width
  height: number; // Preview height
}
```

### State Management

- **Main window reference** - For native handle access
- **Scene reference** - Scene to display
- **Preview state:** Created, visible flags

### Lifecycle

**Creation (lazy):**

- Created on first `showPreview()` call
- Requires main window and scene to be set

**Show:**

- Positions preview at specified bounds
- Updates visibility

**Hide:**

- Moves preview to offscreen coordinates (50000, 50000)
- Does not destroy preview (efficiency)

**Destroy:**

- Called on shutdown only
- Releases preview display resources

### Key Patterns

- **Lazy creation** - Preview created on first use
- **Offscreen positioning** - Hidden by moving far offscreen (not destroyed)
- **Bounds coordination** - Synchronizes with renderer calculations
- **No mid-lifecycle destruction** - Only destroyed on shutdown

---

## RecordingStorageManager

**File:** `RecordingStorageManager.ts`

**Responsibility:** Tracks recording disk usage and enforces storage quota.

### Key APIs

```typescript
getRecordingsUsedSpace(): Promise<number>  // Returns GB
enforceStorageQuota(maxStorageGB: number, protectedVideoPaths?: Set<string>): Promise<StorageQuotaEnforcementResult>
updateOutputDirectory(newDirectory: string): void
```

### Constructor

```typescript
constructor(defaultOutputDir: string)
```

### Storage Tracking

**Calculation:**

- Scans output directory for `.mp4` files
- Sums file sizes
- Converts to GB
- Excludes thumbnails and temp directory

**Quota Enforcement:**

```typescript
enforceStorageQuota(maxStorageGB: number, protectedVideoPaths?: Set<string>) → StorageQuotaEnforcementResult
  ├─ Get current usage
  ├─ If over quota:
  │   ├─ List all .mp4 files
  │   ├─ Sort by mtime (oldest first)
  │   ├─ Skip files in protectedVideoPaths (favourited recordings)
  │   ├─ Delete unprotected files until under quota
  │   ├─ Delete associated thumbnails
  │   ├─ Log deletions (warn if protected paths prevented reaching quota)
  │   └─ Return { exceeded: true, deleted: [...], ... }
  └─ Skip if under quota or quota = 0 (unlimited)
  └─ Return { exceeded: false, deleted: [], ... }
```

**Note:** RecordingService updates metadata for deleted recordings to
`recordingStatus: 'deleted_quota'` using the returned deletion details.

### Key Patterns

- **Size calculation** - Only counts `.mp4` files
- **Efficient quota check** - Only enforces when needed
- **Oldest-first deletion** - Based on mtime
- **Thumbnail cleanup** - Removes associated thumbnails
- **Non-critical thumbnail errors** - Doesn't fail if thumbnail delete fails
- **Zero = unlimited** - No quota enforcement when maxStorageGB = 0

---

## Type Definitions

### RecordingTypes.ts

**File:** `../RecordingTypes.ts`

**Core Types:**

```typescript
// Capture modes
enum CaptureMode {
  GAME = 'game_capture',
  WINDOW = 'window_capture',
  MONITOR = 'monitor_capture',
}

// Resolutions
type Resolution = keyof typeof RESOLUTION_DIMENSIONS;

// Quality presets
enum RecordingQuality {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  ULTRA = 'ultra',
}

// Encoder types
type EncoderType = 'nvenc' | 'amd' | 'x264';

// Recording settings (complete definition from RecordingTypes.ts)
interface RecordingSettings {
  captureMode: CaptureMode;
  resolution: Resolution;
  fps: 30 | 60;
  quality: RecordingQuality;
  encoder?: EncoderType; // Optional; defaults to x264
  desktopAudioEnabled: boolean;
  desktopAudioDevice: string; // Device ID or 'default' (required)
  microphoneAudioEnabled: boolean;
  microphoneDevice: string; // Device ID or 'default' (required)
  captureCursor: boolean;
  monitorId?: string; // Monitor ID for monitor capture
  audioSuppressionEnabled: boolean;
  forceMonoInput: boolean;
}

// Audio device
interface AudioDevice {
  id: string;
  name: string;
}

// Preview bounds
interface PreviewBounds {
  x: number; // X position in main window
  y: number; // Y position in main window
  width: number; // Preview width
  height: number; // Preview height
}

// Recording status (from OBSRecorder.ts)
interface RecordingStatus {
  isInitialized: boolean;
  isRecording: boolean;
  currentFile: string | null;
  duration: number;
  frameCount: number;
  droppedFrames: number;
  cpuUsage: number;
  diskUsedGB: number;
}
```

### obsEnums.ts

**File:** `../obsEnums.ts`

OBS Studio Node type definitions and enums (imported from native bindings).

---

## Recording Flow

V3 architecture: BufferId-first, lifecycle-driven.

### Architecture Overview

**V3 Match Lifecycle:**

- `MatchLifecycleService` - SSoT for session state (active/complete/incomplete)
- `MetadataService` - BufferId-first metadata operations
- `RecordingService` - Follower of lifecycle decisions
- `OBSRecorder` - Per-session recording state machine

**Identity:**

- `bufferId` - Runtime session identity (e.g., `1741178654000_1505`)
- `matchHash` - Only for complete, uploadable matches (analysis identity)

### Complete Match Flow

```
Match Started Event (from MatchDetectionOrchestrator)
  ↓
MatchLifecycleService.handleMatchStarted(event)
  ├─ Create session state (bufferId → 'active')
  ├─ MetadataService.createInitialMetadata(event)
  └─ RecordingService.handleMatchStarted(event)
      ├─ Stop stale session if different bufferId
      ├─ Create RecordingSession { bufferId, status: 'recording', ... }
      └─ OBSRecorder.startRecording(tempDir)
          ├─ Generate session UUID
          ├─ Create currentSession { id, status: 'starting', outputDir, ... }
          ├─ OBS API: startRecording()
          ├─ Wait for 'start' signal → status = 'recording'
          └─ Return directory path

[Recording Active - Video/Audio Captured]

Match Ended Event (with full metadata from parser)
  ↓
MatchLifecycleService.handleMatchEnded(event)
  ├─ Validate: Solo Shuffle requires 6 rounds, W-L consistent
  ├─ If valid:
  │   ├─ MetadataService.finalizeCompleteMatch(event)
  │   │   └─ Generate matchHash, mark complete, save
  │   └─ RecordingService.handleMatchEnded(bufferId)
  │       └─ stopRecordingForMatch({ bufferId, outcome: 'complete' })
  │           ├─ OBSRecorder.stopRecording()
  │           │   ├─ Transition session 'stopping'
  │           │   ├─ Wait for 'stop' signal (30s warn, 120s hard timeout)
  │           │   ├─ Get StopRecordingResult from OBS
  │           │   ├─ Clear session
  │           │   └─ Return StopRecordingResult
  │           ├─ Rename: {bufferId}.mp4
  │           ├─ Generate thumbnail: Thumbnails/{bufferId}.jpg
  │           ├─ MetadataService.updateVideoMetadataByBufferId(bufferId, videoData)
  │           ├─ Enforce disk quota (maxDiskStorage setting)
  │           ├─ Load matchHash from metadata
  │           └─ Emit recordingCompleted({ matchHash, bufferId, path, duration })
  │
  └─ If invalid (validation failed):
      └─ MatchLifecycleService.handleMatchValidationFailed(...)
          ├─ MetadataService.markMatchValidationFailed(bufferId, reason, metadata)
          └─ RecordingService.handleEarlyEnd(bufferId, reason)
              └─ stopRecordingForMatch({ bufferId, outcome: 'incomplete', reason })
                  ├─ OBSRecorder.stopRecording() (same as above)
                  ├─ Rename: Incomplete_{bufferId}_{timestamp}.mp4
                  ├─ Generate thumbnail
                  ├─ Update metadata by bufferId
                  ├─ Enforce disk quota
                  └─ Emit recordingInterrupted({ bufferId, path, duration, reason })
```

### Incomplete Match Flow (Early-End)

```
Match Ended Incomplete Event (LOG_FILE_CHANGE, timeout, zone change)
  ↓
MatchLifecycleService.handleMatchEndedIncomplete(event)
  ├─ MetadataService.markMatchIncomplete(bufferId, trigger, metadataSnapshot)
  └─ RecordingService.handleEarlyEnd(bufferId, reason)
      └─ stopRecordingForMatch({ bufferId, outcome: 'incomplete', reason })
          ├─ OBSRecorder.stopRecording()
          ├─ Rename: Incomplete_{bufferId}_{timestamp}.mp4
          ├─ Generate thumbnail
          ├─ Update metadata by bufferId (no matchHash)
          ├─ Enforce disk quota
          └─ Emit recordingInterrupted({ bufferId, path, duration, reason })
```

### Key V3 Patterns

- **BufferId is SSoT** for local session identity (files, metadata, recordings)
- **MatchHash only for complete matches** (upload/analysis identity)
- **Lifecycle owns decisions** (complete vs incomplete, when to stop)
- **Recording follows lifecycle** (no structural validation in recorder)
- **Per-session OBS state** (UUID-tracked, no cross-session contamination)
- **Unified stop helper** (outcome-based: 'complete' | 'incomplete')
- **Disk quota enforced** after every recording (complete and incomplete)

### Settings Application Flow

```
User changes settings via UI
  ↓
IPC: scene.updateSettings(updates)
  ↓
RecordingService.applyRecordingSettings(settings)
  ├─ Guard: !this.isEnabled → return false
  ├─ Delegate to OBSRecorder.applyRecordingSettings(settings)
  │   ├─ Validate: Not recording/stopping OR setting is "safe" (blocks UNSAFE during recording)
  │   ├─ Diff against current settings
  │   ├─ Apply only changed settings (transactional with rollback on failure):
  │   │   ├─ Resolution/FPS → Reinitialize video context (rollback settingsManager on failure)
  │   │   ├─ Quality → OBSSettingsManager.setQuality()
  │   │   ├─ Encoder → OBSRecorder.setEncoder()
  │   │   ├─ Capture mode → OBSCaptureManager.applyCaptureMode() (boolean; only commit on true)
  │   │   ├─ Audio → OBSCaptureManager.setDesktopAudio/Microphone()
  │   │   └─ Cursor → OBSCaptureManager.setCaptureCursor() (boolean; only commit on true)
  │   └─ Update currentSettings cache only for successfully applied changes
  └─ Persist to SettingsService
```

### Safe vs Unsafe Settings

**All recording settings are currently UNSAFE during active recording:**

```typescript
// From RecordingTypes.ts - UNSAFE_RECORDING_SETTINGS
[
  'captureMode', // Cannot switch capture source
  'resolution', // Cannot change video dimensions
  'fps', // Cannot change framerate
  'quality', // Cannot change bitrate
  'encoder', // Cannot change encoder
  'desktopAudioEnabled', // Cannot toggle audio tracks
  'microphoneAudioEnabled', // Cannot toggle audio tracks
  'captureCursor', // Cannot toggle cursor overlay
  'desktopAudioDevice', // Cannot switch audio devices
  'microphoneDevice', // Cannot switch audio devices
  'monitorId', // Cannot switch monitors
  'audioSuppressionEnabled', // Cannot change suppression
  'forceMonoInput', // Cannot change mono state
];
```

**Rationale:**

- Video settings require context/source reinitialization
- Audio toggles affect OBS track configuration
- Prevents OBS crashes and corrupted recordings

**Enforcement:**

- `OBSRecorder.applyRecordingSettings()` rejects all changes while recording
- Returns error:
  `{ code: 'RECORDING_ACTIVE', message: 'Cannot change settings during recording' }`
- UI disables all setting controls when recording active

**Note:** `SAFE_RECORDING_SETTINGS` array is intentionally empty (future
expansion point)

---

## Error Handling

### OBS Initialization Errors

**Common:**

- OBS binary not found
- Working directory permissions
- Data directory write failures

**Handling:**

- Thrown during `initialize()`
- Propagated to RecordingService
- Service remains in uninitialized state
- Retry requires full re-initialization

### Recording Errors

**Start failures:**

- Output directory doesn't exist
- Insufficient disk space
- OBS not initialized

**Stop failures:**

- Signal timeout (30s warn logs only, 120s hard timeout resolves `stop_timeout`)
- File write errors (`write_error`, `stop_error`)
- OBS crash during recording

**Handling:**

- Start failures: thrown from `startRecording()`
- Stop failures: returned as `StopRecordingResult` `{ ok: false, reason, error?, durationSeconds }` (not thrown)
- Errors emitted via `recordingError` / `error` events
- Session state cleaned up in all cases

### File Operation Errors

**Rename failures (Windows file locking):**

- Retry up to 3 times
- 1-second delays between attempts
- Common cause: Antivirus scanning

**Thumbnail generation failures:**

- Non-critical
- Logged but doesn't fail recording
- Metadata updated without thumbnail path

**Quota enforcement failures:**

- Logged but doesn't block new recordings
- Partial cleanup acceptable

### WoW Detection Errors

**Window not found:**

- Game capture: Continues with unbounded exponential backoff (500ms → 30s max)
  while enabled
- Window capture: Continuous polling (5-second interval) while window mode active;
  continues after WoW found to detect resizes; stops only on mode switch/shutdown/fatal IPC

**Hook failures:**

- Detected after `hookCheckDelayMs` (500ms)
- Continues attempting with unbounded exponential backoff
- Backoff range: 500ms → 30s max
- No attempt limit (continues while game capture enabled)

---

## Performance

### Memory Usage

| Component               | Baseline | Recording          |
| ----------------------- | -------- | ------------------ |
| OBSRecorder             | ~50 MB   | ~50 MB (no change) |
| OBSCaptureManager       | ~10 MB   | ~10 MB             |
| OBSSettingsManager      | ~1 MB    | ~1 MB              |
| OBSPreviewManager       | ~5 MB    | ~5 MB              |
| RecordingStorageManager | ~100 KB  | ~100 KB            |

**Total OBS overhead:** ~65 MB baseline

### Video File Sizes

**2v2/3v3 Match (5-15 minutes):**

- LOW: 150-450 MB
- MEDIUM: 225-675 MB
- HIGH: 300-900 MB
- ULTRA: 450-1350 MB

**Solo Shuffle Match (20-40 minutes):**

- LOW: 600-1200 MB
- MEDIUM: 900-1800 MB
- HIGH: 1200-2400 MB
- ULTRA: 1800-3600 MB

**Thumbnail:** ~50-200 KB per match (JPEG)

### CPU Usage

- **x264 (Software):** 10-30% (one core, depends on preset/quality)
- **NVENC (NVIDIA):** 1-5% (GPU-accelerated)
- **AMD (Hardware):** 1-5% (GPU-accelerated)

### Polling Overhead

- **WoW detection:** Negligible CPU usage when active
- **Window enumeration:** Uses persistent dummy input; per-poll tick refreshes settings/properties (no per-tick source creation)

---

## Configuration Reference

### Default Settings

```typescript
// Video (from SettingsService defaults)
DEFAULT_RESOLUTION = '1920x1080';
DEFAULT_FPS = 30;
DEFAULT_QUALITY = 'medium';
DEFAULT_ENCODER = 'x264';

// Audio (from SettingsService defaults)
DEFAULT_DESKTOP_AUDIO_ENABLED = false;
DEFAULT_DESKTOP_AUDIO_DEVICE = 'default';
DEFAULT_MICROPHONE_ENABLED = false;
DEFAULT_MICROPHONE_DEVICE = 'default';
DEFAULT_AUDIO_SUPPRESSION_ENABLED = true;
DEFAULT_FORCE_MONO_INPUT = true;

// Capture (from SettingsService defaults)
DEFAULT_CAPTURE_MODE = 'window_capture'; // CaptureMode.WINDOW
DEFAULT_CAPTURE_CURSOR = true;

// Storage
DEFAULT_OUTPUT_DIR = '{videos}/ArenaCoach/Recordings/';
DEFAULT_MAX_STORAGE_GB = 50;

// WoW Detection (OBSCaptureManager)
WOW_HOOK_CHECK_DELAY_MS = 500;
WOW_MIN_BACKOFF_MS = 500;
WOW_MAX_BACKOFF_MS = 30000;
WINDOW_POLL_INTERVAL_MS = 5000;

// Timeouts
RECORDING_STOP_WARN_TIMEOUT_MS = 30000; // logs warning only
RECORDING_STOP_HARD_TIMEOUT_MS = 120000; // resolves stop_timeout
VIDEO_RENAME_RETRY_DELAY_MS = 1000;
VIDEO_RENAME_MAX_RETRIES = 3;
```

### Environment Variables

None - All configuration via constructor or SettingsService.

---

## Troubleshooting

### Common Issues

**Issue:** "OBS failed to initialize" **Causes:**

- OBS binaries missing/corrupted
- Working directory permissions
- Data directory write failures **Solution:** Reinstall desktop app, check
  directory permissions

**Issue:** "Game capture shows black screen" **Causes:**

- WoW not running
- DirectX hook failed
- Admin rights mismatch **Solution:** Switch to window capture mode

**Issue:** "Recording stops immediately" **Causes:**

- Disk full
- Output directory permissions
- OBS crash **Solution:** Check disk space, verify directory writable

**Issue:** "No audio in recordings" **Causes:**

- Audio devices not selected
- Audio sources disabled
- Device disconnected during recording **Solution:** Verify audio settings,
  check device connections

**Issue:** "Preview not visible" **Causes:**

- Main window not set
- Scene not set
- Bounds off-screen **Solution:** Verify `setMainWindow()` and `setScene()`
  called

### Debug Logging

All components log extensively:

- `[OBSRecorder]` - Main lifecycle events
- `[OBSCaptureManager]` - Source and WoW detection
- `[OBSSettingsManager]` - Settings changes
- `[OBSPreviewManager]` - Preview operations
- `[RecordingStorageManager]` - Quota enforcement

Enable verbose logging for detailed diagnostics.

---

## Known Limitations

### Platform Support

**Windows-only** - OBS Studio Node requires Windows native bindings.

**Cross-platform alternatives:**

- macOS: AVFoundation
- Linux: FFmpeg direct integration

### OBS Version Compatibility

**Bundled:** obs-studio-node `osn-0.25.34-release-win64` (pinned in package.json)

**Incompatibilities:** Major OBS versions may change API

### Hardware Acceleration

**NVIDIA NVENC:**

- Requires NVIDIA GPU with NVENC support
- GTX 600 series or newer

**AMD Hardware Encoder:**

- Requires AMD GPU with VCE/VCN
- RX 400 series or newer

**Default Encoder:**

- Default preference is `x264` (from settings defaults) in `auto` mode
- Runtime does encoder probe + selection via `resolveEncoderSelection(...)`
- In `auto` mode it picks the best available supported H.264 encoder
- If probe data is unavailable, it falls back to `obs_x264`

### Concurrent Recording Limitation

**Single recording at a time** - Cannot record multiple matches simultaneously.

**Reason:** OBS Studio Node limitation (single global context).

---

## Related Documentation

- **Parent Services:** See [`../README.md`](../README.md) for complete services
  layer documentation
- **RecordingService:** See `../RecordingService.ts` for high-level
  orchestration
- **Main README:** See [`../../../README.md`](../../../README.md) for overall
  desktop documentation

---
