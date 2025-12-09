# ArenaCoach Desktop Application

**Windows desktop application for automated World of Warcraft arena match
detection, analysis, and video recording.**

[![Platform](https://img.shields.io/badge/Platform-Windows-blue)](#platform-requirements)
[![Electron](https://img.shields.io/badge/Electron-32.x-47848F?logo=electron)](https://www.electronjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![OBS](https://img.shields.io/badge/OBS-Integration-302E31?logo=obsstudio)](https://obsproject.com/)

---

## Overview

ArenaCoach Desktop is an Electron-based companion application that runs
alongside World of Warcraft, automatically detecting arena matches, uploading
combat logs for analysis, and optionally recording gameplay. It operates as a
zero-configuration system with resilient backend communication and comprehensive
error handling.

**Core Capabilities:**

- **Automated Match Detection**: Real-time parsing of WoW combat logs
- **Job Tracking**: Resilient polling with exponential backoff and intelligent
  retry
- **Video Recording**: OBS integration with game/window/monitor capture
- **Match Analysis**: Backend enrichment with detailed event data
- **State Persistence**: Survives application restarts without losing tracking
  state

---

## Table of Contents

1. [Architecture](#architecture)
2. [Directory Structure](#directory-structure)
3. [Core Components](#core-components)
4. [Development](#development)
5. [Build & Distribution](#build--distribution)
6. [Security](#security)
7. [Configuration](#configuration)
8. [Type System](#type-system)
9. [Performance](#performance)
10. [Known Limitations](#known-limitations)

---

## Architecture

### High-Level System Flow

```
┌──────────────────────────────────────────────────────────────┐
│                    WoW Process Monitoring                    │
│  • Windows tasklist polling (2-second intervals)             │
│  • Emits wowProcessStart/wowProcessStop events               │
│  • Typed error handling with factory pattern                 │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│              Match Detection Pipeline                        │
│  • Combat log file watching (fs.watch optimized)             │
│  • Real-time match parsing (CombatLogParser)                 │
│  • Per-match chunking (MatchChunker)                         │
│  • Events: MATCH_STARTED → MATCH_ENDED → chunk created       │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│               Job Queue Pipeline                             │
│  • Chunk upload to backend API                               │
│  • Job ID generation and correlation                         │
│  • State persistence (JobStateStore)                         │
│  • Polling initiation (CompletionPollingService)             │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│          Completion Polling & Enrichment                      │
│  • Resilient job status polling (5s base, 60s cap)          │
│  • Smart correlation with O(1) job lookup                    │
│  • Jitter to prevent thundering herd                         │
│  • Analysis enrichment with event data                       │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                  User Interface (Renderer)                    │
│  • Real-time match status updates                            │
│  • Recording controls and video player                       │
│  • Settings management                                       │
│  • Secure IPC communication (context isolation)              │
└──────────────────────────────────────────────────────────────┘
```

### Event-Driven Architecture

The application uses **EventEmitter** throughout for loose coupling:

- **WoWProcessMonitor** → `wowProcessStart/Stop` →
  **MatchDetectionOrchestrator**
- **CombatLogParser** → `MATCH_STARTED/ENDED` → **MatchChunker**
- **MatchChunker** → `matchProcessed` → **JobQueueOrchestrator**
- **CompletionPollingService** → `analysisCompleted/Failed` → **Main Process**
- **Main Process** → IPC → **Renderer Process** (UI updates)

---

## Directory Structure

```
desktop/
├── src/                                 # TypeScript source code
│   ├── main.ts                         # Electron main process entry
│   ├── preload.ts                      # Secure IPC bridge
│   ├── authManager.ts                  # Battle.net OAuth
│   ├── wowInstallation.ts              # WoW detection & addon mgmt
│   │
│   ├── match-detection/                # Match detection pipeline
│   │   ├── MatchDetectionOrchestrator.ts
│   │   ├── parsing/                    # Combat log parsing
│   │   │   ├── MatchLogWatcher.ts
│   │   │   ├── CombatLogParser.ts
│   │   │   ├── CombatLogLine.ts
│   │   │   └── ShuffleRoundTracker.ts
│   │   ├── chunking/                   # Match segmentation
│   │   │   ├── MatchChunker.ts
│   │   │   └── MatchResolver.ts
│   │   ├── pipeline/
│   │   │   └── JobQueueOrchestrator.ts
│   │   ├── constants/                  # Arena zones, class/spec maps
│   │   ├── types/                      # Type definitions
│   │   └── utils/                      # Hashing, bracket utils
│   │
│   ├── process-monitoring/             # WoW process detection
│   │   ├── WoWProcessMonitor.ts
│   │   └── WoWProcessMonitorErrors.ts
│   │
│   ├── services/                       # Business logic services
│   │   ├── MatchDetectionService.ts
│   │   ├── MatchLifecycleService.ts    # Session lifecycle coordinator
│   │   ├── MetadataService.ts          # Match metadata operations
│   │   ├── MetadataStorageService.ts
│   │   ├── CompletionPollingService.ts
│   │   ├── JobStateStore.ts
│   │   ├── UploadService.ts
│   │   ├── AnalysisEnrichmentService.ts
│   │   ├── RecordingService.ts         # Match-driven recording orchestrator
│   │   ├── SettingsService.ts
│   │   ├── ApiHeadersProvider.ts
│   │   ├── ServiceHealthCheck.ts
│   │   ├── OBSRecorder.ts              # Per-session OBS state machine
│   │   ├── RecordingTypes.ts
│   │   └── obs/                        # OBS sub-services
│   │       ├── OBSCaptureManager.ts
│   │       ├── OBSSettingsManager.ts
│   │       ├── OBSPreviewManager.ts
│   │       └── RecordingStorageManager.ts
│   │
│   └── config/
│       └── ExpirationConfig.ts
│
├── assets/                              # Frontend UI
│   ├── index.html
│   ├── renderer.js
│   ├── styles.css
│   ├── MatchDataService.js
│   └── VideoPlayer.js
│
├── addon/                              # WoW addon files
├── dist/                               # Compiled JS (generated)
├── release/                            # Built installers (generated)
│
├── package.json
├── tsconfig.json
├── electron-builder.yml
└── README.md
```

---

## Core Components

### 1. Process Monitoring

**File**: `src/process-monitoring/WoWProcessMonitor.ts`

Monitors Windows processes for `wow.exe` using `tasklist` command.

**Key Features:**

- 2-second polling intervals
- EventEmitter-based (`wowProcessStart`, `wowProcessStop`)
- First-poll guarantee with 750ms delayed re-check
- Platform detection (Windows-only with graceful errors)
- Typed error hierarchy via `WoWProcessMonitorErrorFactory`

**Integration:**

- Feeds lifecycle events to `MatchDetectionOrchestrator`
- Controls when combat log watching starts/stops

---

### 2. Match Detection Pipeline

#### MatchDetectionOrchestrator

**File**: `src/match-detection/MatchDetectionOrchestrator.ts`

Main coordinator for the automated pipeline.

**Responsibilities:**

- Integrates WoW process monitoring
- Manages log watcher, parser, and chunker lifecycle
- Emits `matchProcessed` events for upload orchestration

#### Combat Log Watcher

**File**: `src/match-detection/parsing/MatchLogWatcher.ts`

Monitors WoW combat log directory for file changes using `fs.watch()`.

**Key Features:**

- Byte position tracking per file (`filePositions: Map<string, number>`)
- Partial line buffering for chunk boundaries
- Do-while loop ensures no bytes lost during processing
- 10-minute inactivity timeout
- System metrics (linesProcessed, errorsHandled)

#### Combat Log Parser

**File**: `src/match-detection/parsing/CombatLogParser.ts`

Parses individual combat log lines to extract match events.

**Match Detection Logic:**

- Triggers on `ARENA_MATCH_START` event
- Ends on `ARENA_MATCH_END` or zone change
- Requires minimum 20 lines (configurable)
- Safety limit: 200,000 lines per match
- Progressive player data enrichment from `COMBATANT_INFO`

**Supported Brackets:**

- 2v2, 3v3, Solo Shuffle (with `ShuffleRoundTracker`)

#### Match Chunker

**File**: `src/match-detection/chunking/MatchChunker.ts`

Extracts individual matches from continuous combat logs.

**Security Features:**

- Path traversal protection (absolute path resolution)
- Null byte and dangerous pattern detection
- Per-match file generation with unique identifiers

**Output:**

- Creates `.txt` chunk files named with bufferId
- Embeds full combat log header for backend analysis

---

### 3. Job Queue Pipeline

**File**: `src/match-detection/pipeline/JobQueueOrchestrator.ts`

Thin orchestration layer coordinating uploads and tracking.

**Workflow:**

1. Receives `MatchProcessedPayload` from orchestrator
2. Generates unique `jobId` (UUID)
3. Uploads chunk via `UploadService` (with auth header if authenticated)
4. Initiates polling via `CompletionPollingService`
5. Persists correlation state via `JobStateStore` (entitlement-agnostic)

**Backend-Driven Analysis:**

- Backend determines what analysis data to return on each request
- Desktop trusts server response (no local classification)
- Changes take effect on next poll (no token refresh needed)

**State Management:**

- `pendingUploads` Map tracks in-flight jobs
- Persisted to `{userData}/pending-uploads.json`
- Survives application restarts
- Resumes polling on app launch

**Retry Strategy:**

- Exponential backoff: 1s → 5m max
- Permanent vs. transient error classification
- Server-side expiration provides natural termination

---

### 4. Completion Polling Service

**File**: `src/services/CompletionPollingService.ts`

Polls backend for job status updates with intelligent backoff.

**Polling Strategy:**

- **Base interval**: 5 seconds
- **Max backoff**: 60 seconds
- **Jitter**: ±10% randomization
- **Concurrent limit**: 6 jobs
- **HTTP timeout**: 10 seconds per request

**Backend-Driven Completion:**

Desktop trusts the backend `JobStatusResponse` completely:

- When `analysisStatus === 'completed'`:
  - If `analysisId` non-null + `analysisData` is array: Emit `analysisCompleted`
    **with** payload
  - If `analysisId` null: Emit `analysisCompleted` **without** payload
  - Both cases stop tracking (no infinite polling)

**Contract Violation Guard (Defensive):**

- Detects malformed responses: `analysisId` non-null but `analysisData` not
  array
- Tracks violations per job (max 3)
- After threshold: Emits `analysisFailed` and stops tracking
- Prevents infinite loops even if backend regresses

**Job Status Response:**

```typescript
interface JobStatusResponse {
  success: boolean;
  jobId: string;
  analysisStatus: string; // 'queued' | 'processing' | 'completed'
  analysisId: string | null;
  uuid: string | null;
  hasData: boolean;
  analysisData?: unknown;
  jobDetails?: { ... };
}
```

---

### 5. Analysis Enrichment

**File**: `src/services/AnalysisEnrichmentService.ts`

Handles completion events and enriches match metadata with analysis data.

**Enrichment Process:**

- Flattens nested per-round event structure
- Updates `matchData.events` with normalized categories
- Sets `hasEventEnrichment: true`
- Single atomic metadata write

---

### 6. Recording System

#### OBSRecorder

**File**: `src/services/OBSRecorder.ts`

Manages OBS Studio Node integration for video capture.

**Features:**

- ASAR path fixing for packaged apps
- UUID-based IPC identification
- Recording lifecycle management (start/stop)
- Output signal handling for status monitoring

#### RecordingService

**File**: `src/services/RecordingService.ts`

Orchestrates OBS recording as a follower of MatchLifecycleService decisions.

**Match-Driven Recording:**

- Follows MatchLifecycleService calls (handleMatchStarted, handleMatchEnded,
  handleEarlyEnd)
- BufferId-driven (not hash-based)
- Unified stop helper for complete and incomplete matches
- Files named by bufferId: `{bufferId}.mp4` or
  `Incomplete_{bufferId}_{timestamp}.mp4`
- Updates metadata via MetadataService.updateVideoMetadataByBufferId

#### OBS Sub-Services

**OBSCaptureManager**: Game/window/monitor capture modes **OBSSettingsManager**:
Video (resolution, FPS, quality) and audio settings **OBSPreviewManager**: Live
preview overlay for monitor preview **RecordingStorageManager**: File path and
storage location management

**Recording Settings:**

```typescript
// Complete definition from RecordingTypes.ts
interface RecordingSettings {
  captureMode: CaptureMode; // 'game_capture' | 'window_capture' | 'monitor_capture'
  resolution: Resolution; // '1280x720' | '1920x1080' | '2560x1440' | '3440x1440'
  fps: 30 | 60;
  quality: RecordingQuality; // 'low' | 'medium' | 'high' | 'ultra'
  encoder?: EncoderType; // 'x264' | 'nvenc' | 'amd' (optional; defaults to x264)
  desktopAudioEnabled: boolean;
  desktopAudioDevice: string; // Device ID or 'default' (required)
  microphoneAudioEnabled: boolean;
  microphoneDevice: string; // Device ID or 'default' (required)
  captureCursor: boolean;
  monitorId?: string; // Monitor ID for monitor capture
  audioSuppressionEnabled: boolean;
  forceMonoInput: boolean;
}
```

**Safety System:**

- Settings validated at runtime
- **All recording settings blocked during active recording** (see
  `UNSAFE_RECORDING_SETTINGS` in `RecordingTypes.ts`)
- No safe live settings currently available (`SAFE_RECORDING_SETTINGS` is empty)
- Blocked settings include: `captureMode`, `resolution`, `fps`, `quality`,
  `desktopAudioEnabled`, `microphoneAudioEnabled`, `captureCursor`, audio
  devices, monitor selection, and audio processing options

---

### 7. Authentication

**File**: `src/authManager.ts`

Handles Battle.net OAuth authentication flow.

**OAuth Flow (RFC 8252 Compliant):**

1. Initiates session via `POST /api/auth/desktop/oauth/initiate`
2. Launches system browser to Battle.net OAuth URL
3. Starts local loopback callback server (dynamic port)
4. Waits for authorization callback (60-second timeout)
5. Exchanges code for JWT via `POST /api/auth/desktop/oauth/exchange`
6. Stores token with `electron-safe-storage` encryption

**Token Management:**

- Automatic refresh before expiration
- Secure storage (OS-level encryption)
- Injected into all API requests via `ApiHeadersProvider`

---

### 8. Data Persistence

#### Job State Store

**File**: `src/services/JobStateStore.ts`

**Responsibilities:**

- Persists pending upload tracking to disk
- Atomic write operations (temp file + rename)
- Survives application crashes

**Storage:**

- Location: `{userData}/pending-uploads.json`
- Format: `Map<jobId, CorrelationData>`

**CorrelationData:**

```typescript
interface CorrelationData {
  matchHash: string;
  timestamp: number;
  errorType?: 'rate_limit' | 'auth' | 'server' | 'network' | 'permanent_server';
  retryCount?: number;
  nextRetryAt?: number;
}
```

#### Metadata Storage Service

**File**: `src/services/MetadataStorageService.ts`

**Responsibilities:**

- Stores match metadata to disk
- Supports incremental updates
- Handles analysis enrichment

**Storage:**

- Location: `{userData}/logs/`
- Per-match metadata files
- Files named by `bufferId` (e.g., `1741178654000_1505.json`)
- Indexed by bufferId for primary lookup, matchHash for complete matches

#### Settings Service

**File**: `src/services/SettingsService.ts`

**Responsibilities:**

- Persists application settings
- Uses `electron-store` for atomic writes
- Schema validation

**Settings Stored:**

- Window bounds and layout
- Recording settings
- Match detection configuration
- Disk storage limits

---

## Development

### Platform Requirements

- **OS**: Windows 10+ (x64)
- **Node.js**: 20.x or later
- **npm**: 8.0.0 or later

**Why Windows-only?**

- OBS Studio Node native bindings
- Windows-specific process monitoring (`tasklist`)
- Cross-platform support would require abstraction layer

### Setup

```bash
cd desktop
npm install
```

### Development Commands

```bash
# Development with hot reload
npm run dev:desktop

# TypeScript compilation
npm run build

# Run built application
npm run start

# Sync changes to running app
npm run dev:sync

# Code quality
npm run lint
npm run type-check

# Package for distribution
npm run dist
```

### TypeScript Configuration

**File**: `tsconfig.json`

- **Target**: ES2022
- **Module**: CommonJS
- **Strict mode**: Enabled
- **Source maps**: Enabled for debugging
- **Output**: `dist/` directory

### Environment Variables

**File**: `.env`

```bash
API_BASE_URL=https://api.arenacoach.gg
BATTLE_NET_CLIENT_ID=your_client_id
BATTLE_NET_CLIENT_SECRET=your_client_secret
```

---

## Build & Distribution

### Build Configuration

**File**: `electron-builder.yml`

```yaml
appId: gg.arenacoach.desktop
productName: ArenaCoach
directories:
  output: release
win:
  target: [nsis]
  arch: [x64]
  artifactName: ArenaCoach-Setup-${version}.exe
publish:
  provider: generic
  url: https://arenacoach.gg/desktop/releases/
```

### Build Process

```bash
npm run dist
```

**Output:**

- `release/ArenaCoach-Setup-{version}.exe` - NSIS installer
- `release/latest.yml` - Auto-updater manifest

### Auto-Updater

**Provider**: Generic (Cloudflare R2) **Update URL**:
`https://arenacoach.gg/desktop/releases/` **Check interval**: On app startup +
manual check

---

## Security

### Process Security

**Context Isolation:**

- `contextIsolation: true` - Renderer cannot access Node.js
- `nodeIntegration: false` - No direct fs/require in renderer
- Preload script provides controlled API surface

### Network Security

**HTTPS:**

- Automatic HTTPS/HTTP detection
- Proper certificate validation
- Content-Security-Policy with restrictive defaults

**Authentication:**

- Bearer token with JWT format (30-day expiration)
- Secure storage via `electron-safe-storage`
- Long-lived tokens without automatic refresh (desktop Battle.net OAuth flow)
- Token refresh infrastructure available for tokens with refresh metadata (not
  currently used)

### File System Security

**Path Validation:**

- Absolute path normalization
- Traversal pattern detection (`../`, null bytes)
- Safe directory resolution

### Input Validation

**IPC Boundaries:**

- Type-safe message validation
- Structured error codes (no information leakage)
- No eval() or dynamic code execution

---

## Configuration

### Application Settings

**Storage**: `{userData}/config.json`

**Configurable Options:**

- WoW installation path
- Combat log directory override
- Recording output directory
- Auto-recording toggle
- Capture settings (mode, resolution, FPS, quality)
- Audio device selection
- Disk usage limits

### Combat Log Expiration

**File**: `src/config/ExpirationConfig.ts`

```typescript
COMBAT_LOG_EXPIRATION_HOURS = 48; // Reject logs older than 48 hours
```

### Polling Configuration

**File**: `src/services/CompletionPollingService.ts`

```typescript
DEFAULT_BASE_INTERVAL_MS = 5000; // 5 seconds
DEFAULT_MAX_BACKOFF_MS = 60000; // 60 seconds
DEFAULT_MAX_CONCURRENT_POLLS = 6; // Concurrent job limit
DEFAULT_WARMUP_NOTFOUND_MS = 120000; // 2-minute warm-up for 404s
HTTP_TIMEOUT_MS = 10000; // 10-second request timeout
JITTER_PERCENT = 0.1; // ±10% jitter
MAX_CONTRACT_VIOLATIONS_BEFORE_FAILURE = 3;
```

---

## Type System

### Core Type Hierarchies

#### Match Events

```typescript
enum MatchEventType {
  MATCH_STARTED = 'MATCH_STARTED',
  MATCH_ENDED = 'MATCH_ENDED',
  ZONE_CHANGE = 'ZONE_CHANGE',
}

interface MatchStartedEvent {
  type: MatchEventType.MATCH_STARTED;
  timestamp: Date;
  zoneId: number;
  bufferId: string;
  bracket?: string;
  season?: number;
  players?: PlayerMetadata[];
}

interface MatchEndedEvent {
  type: MatchEventType.MATCH_ENDED;
  timestamp: Date;
  bufferId: string;
  metadata: MatchMetadata;
}
```

#### Match Metadata

```typescript
interface MatchMetadata {
  timestamp: Date;
  mapId: number;
  bracket: string; // '2v2' | '3v3' | 'Solo Shuffle'
  season: number;
  isRanked: boolean;
  players: PlayerMetadata[];
  playerId?: string; // Recording player GUID
  winningTeamId?: number;
  matchDuration?: number;
  shuffleRounds?: ShuffleRoundSummary[];
  events?: MatchEventCategory[];
}

interface PlayerMetadata {
  id: string; // Player GUID
  personalRating: number;
  classId: number;
  specId: number;
  teamId: number;
  name?: string;
}
```

#### Upload Status

```typescript
enum UploadStatus {
  PENDING = 'pending',
  UPLOADING = 'uploading',
  QUEUED = 'queued',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  INCOMPLETE = 'incomplete',
  EXPIRED = 'expired',
  NOT_FOUND = 'not_found',
}

type MatchCompletionStatus = 'in_progress' | 'complete' | 'incomplete';
type EnrichmentPhase = 'initial' | 'combatants_added' | 'finalized';

interface StoredMatchMetadata {
  // Core match data and identifiers
  matchData: MatchMetadata;
  matchHash?: string;
  bufferId?: string;

  // Progressive metadata system (required)
  matchCompletionStatus: MatchCompletionStatus;
  enrichmentPhase: EnrichmentPhase;
  createdAt: Date;
  lastUpdatedAt: Date;

  // Upload tracking
  jobId?: string;
  analysisId?: string;
  uploadStatus: UploadStatus;
  progressMessage?: string;
  queuePosition?: number | null;
  totalInQueue?: number | null;

  // Server analysis results
  analyzed_player_overall_score?: number;
  user_id?: number;
  upload_timestamp?: string;
  uuid?: string;

  // Video recording metadata (optional)
  videoPath?: string;
  videoSize?: number;
  videoDuration?: number;
  videoRecordedAt?: string;
  videoResolution?: string;
  videoFps?: number;
  videoCodec?: string;
  videoThumbnail?: string;

  // Event enrichment
  hasEventEnrichment?: boolean;

  // Error tracking
  errorMessage?: string;
  errorCode?: string; // e.g., 'QUOTA_EXHAUSTED'
  failedAt?: string;

  // Storage metadata
  storedAt?: number;
}
```

---

## Performance

### Match Detection

- **Log watcher**: Event-driven (`fs.watch`) with 10-minute inactivity timeout
- **Parser**: Streaming (not fully buffered)
- **Chunker**: 5-minute inactivity timeout
- **Memory**: Bounded by active match count (~10MB per match buffer)
- **WoW Process Monitor**: 2-second polling (Windows `tasklist`)

### Job Polling

- **Base interval**: 5 seconds
- **Max backoff**: 60 seconds
- **Concurrent limit**: 6 jobs
- **Timeout**: 10 seconds per request
- **Algorithm**: O(1) job correlation via Map lookup

### Recording

- **OBS pipeline**: x264 (software) and NVENC/AMD (hardware-accelerated)
- **File format**: MP4 container (H.264 via x264/NVENC/AMD encoders)
- **Chunk files**: Typically 5-20MB per arena match

### Metrics

- **Lines per match**: 500-10,000 (typical 2v2/3v3), 10,000-50,000 (Solo
  Shuffle)
- **Processing speed**: ~50,000 lines/second
- **Memory footprint**: 150-250MB baseline, +10MB per active match

---

## Known Limitations

### Platform Support

**Windows-only**: OBS Studio Node and native process monitoring require Windows.

**Mitigation**: Cross-platform support would require:

- Abstraction layer for process monitoring (macOS: `ps`, Linux: `/proc`)
- OBS alternatives or conditional compilation

### Combat Log Parsing

**Retail-only**: Covers `_retail_` WoW version only.

**Reason**: Combat log format changes across WoW versions (Classic, TBC, Wrath,
etc.)

**Line limits**: 20-200,000 lines per match (safety bounds to prevent runaway
parsing)

### Job Polling Architecture

**Polling vs. WebSocket**: Current implementation uses HTTP polling for
simplicity.

**Trade-offs:**

- ✅ Simpler deployment (no WebSocket infrastructure)
- ✅ Better handling of network interruptions
- ✅ Idempotent status checks
- ❌ Slightly higher latency (~5s vs instant)
- ❌ More HTTP requests (mitigated by exponential backoff)

### Recording Integration

**Optional**: Can run without recording enabled.

**Settings during recording**: All recording settings are currently blocked
during active recording to prevent OBS crashes and corrupted recordings
(`SAFE_RECORDING_SETTINGS` is empty; see `RecordingTypes.ts` for the complete
`UNSAFE_RECORDING_SETTINGS` list).

---

## Contributing

### Code Standards

- **TypeScript**: Strict mode enabled
- **Linting**: ESLint with recommended rules
- **Formatting**: Consistent spacing and style
- **Error Handling**: Explicit, boundary-focused try-catch (no blanket catches);
  clear logging and error propagation
- **Type Safety**: No `any` types without justification

### Commit Guidelines

Follow conventional commits format:

```
feat: add Solo Shuffle support
fix: resolve race condition in job polling
refactor: extract match chunking logic
docs: update API documentation
```

### Testing

Run type checking before commits:

```bash
npm run type-check
npm run lint
```

---

## Troubleshooting

### Common Issues

**Issue**: "WoW process not detected" **Solution**: Ensure WoW is running and
visible in Task Manager as `wow.exe`

**Issue**: "Combat logs not being processed" **Solution**: Verify `/Logs`
directory exists in WoW installation and logging is enabled

**Issue**: "Jobs stuck in 'processing'" **Solution**: Check network connectivity
to `API_BASE_URL` and authentication status

**Issue**: "Recording fails to start" **Solution**: Verify OBS Studio Node is
installed and capture settings are valid

### Logs

**Main process logs**: `{userData}/logs/main.log` **Renderer logs**: DevTools
console (F12) **Combat log watcher**: `{userData}/logs/match-detection.log`

---

## License

This project is licensed under the **GNU General Public License v2.0 or later**
(GPL-2.0-or-later).

See [LICENSE](LICENSE) for the full license text.

See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for licenses of included
third-party software.

---

## Support

For issues and feature requests, please contact support through the ArenaCoach
platform.

**Version**: 0.1.3 **Last Updated**: December 2025 **License**: GPL-2.0-or-later
