# Desktop Services Layer

**Business logic services for the ArenaCoach Desktop application.**

---

## Overview

The services layer provides specialized business logic components organized into
four functional areas:

1. **Upload & Polling Pipeline** - Job tracking, backend communication, and
   analysis enrichment
2. **Match Detection & Metadata** - Match lifecycle management and persistence
3. **Infrastructure** - Cross-cutting concerns (settings, health, headers,
   cleanup)
4. **Recording System** - OBS integration (see [`obs/README.md`](obs/README.md))

All services follow dependency injection patterns with clear separation of
concerns.

---

## Table of Contents

1. [Upload & Polling Pipeline](#upload--polling-pipeline)
2. [Match Detection & Metadata](#match-detection--metadata)
3. [Infrastructure Services](#infrastructure-services)
4. [Cross-Service Data Flow](#cross-service-data-flow)
5. [Error Handling Patterns](#error-handling-patterns)
6. [State Persistence](#state-persistence)

---

## Upload & Polling Pipeline

### Overview

The upload pipeline uploads match chunks to the backend and polls for analysis
completion. It consists of five services working together to upload match
chunks, poll for completion, and enrich local metadata with analysis results.

**Key Architecture:**

- **Backend determines analysis response:** Desktop trusts server response
- **No client-side classification:** Analysis data presence determined by backend
- **Contract violation guard:** Prevents infinite loops via 3-strike malformed
  payload detection

**Services:**

1. **JobStateStore** - Persists job correlation across restarts
2. **UploadService** - Uploads chunks to backend API
3. **CompletionPollingService** - Polls for job completion
4. **AnalysisEnrichmentService** - Enriches metadata with analysis results
5. **ApiHeadersProvider** - Centralizes authentication header management

---

### JobStateStore

**File:** `JobStateStore.ts`

**Responsibility:** Persists pending upload state to disk for recovery across
application restarts.

**Key APIs:**

```typescript
savePendingUploads(uploads: Map<string, CorrelationData>): Promise<void>
loadPendingUploads(): Promise<Map<string, CorrelationData>>
clearPendingUploads(): Promise<void>
getStats(): Promise<StorageStats>
```

**Dependencies:** None

**State:**

- **Location:** `{userDataPath}/pending-uploads.json`
- **Format:** JSON object mapping `jobId → CorrelationData`

**CorrelationData Structure:**

```typescript
{
  matchHash: string;
  timestamp: number;
  // Simple retry tracking
  errorType?: 'rate_limit' | 'auth' | 'server' | 'network' | 'permanent_server';
  retryCount?: number;
  nextRetryAt?: number;
}
```

**Key Patterns:**

- **Atomic writes** - Temp file + rename for crash safety
- **Directory auto-creation** - Creates parent directories if missing
- **Silent failures on load** - Returns empty Map if file doesn't exist

---

### UploadService

**File:** `UploadService.ts`

**Responsibility:** Uploads match chunk files to backend API using multipart
form data.

**Key APIs:**

```typescript
uploadChunk(
  chunkFilePath: string,
  matchMetadata: MatchEndedEvent,
  matchHash: string,
  jobId: string
): Promise<void>

getConfig(): { apiBaseUrl, uploadEndpoint, hasAuth }
```

**Dependencies:**

- `apiBaseUrl: string`
- `uploadEndpoint: string`
- `headersProvider: ApiHeadersProvider`
- `healthCheck?: ServiceHealthCheck`

**External:**

- `axios` - HTTP client
- `FormData` - Multipart assembly
- `fs/promises` - File validation

**State:** Stateless

**Integration:**

- Called by `JobQueueOrchestrator.submitMatchChunk()`
- Reports success/failure to `ServiceHealthCheck`
- Uses `ApiHeadersProvider` for optional authentication

**Error Handling:**

- Validates file exists before upload
- Distinguishes network/5xx (service down) vs 4xx (client error)
- Idempotent responses treated as success
- No retries (delegated to orchestrator)

**Key Patterns:**

- Atomic file validation
- Health integration
- Idempotency awareness

---

### CompletionPollingService

**File:** `CompletionPollingService.ts`

**Responsibility:** Polls backend for job completion status with exponential
backoff.

**Key APIs:**

```typescript
trackJob(jobId: string, matchHash: string): void
stopTrackingJob(jobId: string): void
getTrackedJobIds(): string[]
stopAll(): void
pausePolling(): void
resumePolling(): void
updateAuthToken(newToken?: string): void
handleServiceHealth(isHealthy: boolean): void
getPollingStats(): PollingStats
```

**Dependencies:**

- `config: CompletionPollingConfig` (apiBaseUrl, authToken, intervals, limits)

**External:**

- `axios` - HTTP polling
- `EventEmitter` - Event notifications
- `ServiceHealthCheck` - Health integration

**State:**

- **In-memory only:** `trackedJobs` Map with per-job state
- **Per-job state:** `jobId`, `matchHash`, `currentDelayMs`, `lastStatus`,
  `lastPolled`, `startTime`, `timer`, `isPaused`, `isPolling`,
  `contractViolationCount`

**Events:**

- `trackingStarted: { jobId, matchHash }`
- `trackingStopped: { jobId }`
- `analysisProgress: { jobId, status, message, matchHash }`
- `analysisCompleted: { jobId, matchHash, analysisId?, analysisPayload? }`
- `analysisFailed: { jobId, matchHash, error }`
- `pollError: { jobId, matchHash, error }`
- `authRequired: { jobId, matchHash, reason }`
- `serviceStatusChanged: { pollingActive, trackedJobsCount, lastPollOkAt }`

**Configuration:**

```typescript
DEFAULT_BASE_INTERVAL_MS = 5000; // 5 seconds
DEFAULT_MAX_BACKOFF_MS = 60000; // 60 seconds
DEFAULT_MAX_CONCURRENT_POLLS = 6; // Concurrent job limit
DEFAULT_WARMUP_NOTFOUND_MS = 120000; // 2-minute warm-up for 404s
HTTP_TIMEOUT_MS = 10000; // 10-second request timeout
JITTER_PERCENT = 0.1; // ±10% jitter
MAX_CONTRACT_VIOLATIONS_BEFORE_FAILURE = 3;
```

**Backend-Driven Completion:**

The desktop trusts the backend `JobStatusResponse`:

```typescript
interface JobStatusResponse {
  success: boolean;
  jobId: string;
  analysisStatus: string;
  analysisId: string | null;
  uuid: string | null;
  hasData: boolean;
  analysisData?: unknown;
  // Standardized error shape (WI-02)
  error?: { code: string; message: string; details?: unknown };
  errorCode?: string;
  isPermanent?: boolean;
}
```

**Completion behavior:**

- When `analysisStatus === 'completed'`:
  - If `analysisId` non-null and `analysisData` is array: Emit
    `analysisCompleted` with payload
  - If `analysisId` null: Emit `analysisCompleted` without payload
  - Both cases stop tracking the job (no infinite polling)

**Contract Violation Guard:**

- Detects malformed responses: `analysisId` non-null but `analysisData` not an
  array
- Tracks violations per job (max 3)
- After threshold: Emits `analysisFailed`
- Prevents infinite loops even if backend regresses

**Key Patterns:**

- **Exponential backoff with jitter** - Prevents thundering herd
- **Warm-up window for 404s** - Jobs need time to appear in backend
- **Pause/resume support** - Handles auth failures gracefully
- **Concurrent poll limiting** - Max 6 polls at once
- **Idempotent tracking** - Duplicate `trackJob()` calls ignored

---

### AnalysisEnrichmentService

**File:** `AnalysisEnrichmentService.ts`

**Responsibility:** Enriches stored match metadata with server-provided analysis
data via single atomic write.

**Key APIs:**

```typescript
finalizeCompletion(
  jobId: string,
  analysisId: string | undefined,
  analysisPayload: AnalysisPayload | undefined
): Promise<void>
```

**Dependencies:**

- `metadataStorageService: MetadataStorageService`

**State:** Stateless (delegates to MetadataStorageService)

**Data Flow:**

**Without analysis data** (`!analysisId || !analysisPayload`):

1. Find metadata by jobId
2. If already `COMPLETED`, return (idempotency)
3. Single write: mark as `COMPLETED`

**With analysis data:**

1. Find metadata by jobId
2. Validate payload structure (uuid, analysisId, events array)
3. Normalize nested events: `MatchEventCategory[][]` → `MatchEventCategory[]`
4. Single atomic write with all enrichment data:
   - `analysisId`, `uuid`, `events`
   - `upload_timestamp`, `user_id` (optional)
   - `hasEventEnrichment: true`
   - `uploadStatus: COMPLETED`

**Key Patterns:**

- **Atomic enrichment write** - All data in single operation
- **Deterministic event normalization:**
  - Flattens per-round structure to flat timeline
  - Sorts categories alphabetically
  - Sorts items by timestamp within categories
- **Idempotency safeguards** - Skips if already enriched with same data
- **Type validation:**
  - `isMatchEventItem()` - Validates event structure
  - `isMatchEventCategory()` - Validates category structure
  - `isNestedEvents()` - Validates nested array structure
- **Date rehydration** - Converts JSON string timestamps to Date objects

**Analysis Payload:**

```typescript
interface AnalysisPayload {
  uuid: string;
  user_id?: number | string;
  upload_timestamp?: string;
  metadata?: {
    match?: {
      analyzedPlayerOverallScore?: number;
    };
  };
  events?: MatchEventCategory[][];
}
```

---

### ApiHeadersProvider

**File:** `ApiHeadersProvider.ts`

**Responsibility:** Centralized HTTP header management with optional
authentication.

**Key APIs:**

```typescript
updateToken(token?: string): void
getHeaders(additionalHeaders?: Record<string, string>): Record<string, string>
hasAuth(): boolean
getTokenStatus(): string  // Masked token for logging
```

**Dependencies:** None

**State:**

- **In-memory:** `authToken` (optional)
- **No persistence**

**Key Patterns:**

- Single source of truth for API headers
- Optional authentication support
- Token masking for security (logs first 8 chars + "...")
- Bearer token format: `Authorization: Bearer {token}`
- Standard user agent: `User-Agent: ArenaCoach-Desktop`

---

## Match Detection & Metadata

### MatchDetectionService

**File:** `MatchDetectionService.ts`

**Responsibility:** Service layer wrapper for `MatchDetectionOrchestrator`,
managing initialization with WoW installations and providing status information.

**Key APIs:**

```typescript
initialize(installations: WoWInstallation[]): Promise<void>
start(): Promise<void>
stop(): Promise<void>
updateAuthToken(token: string): void
setJobQueueOrchestrator(orchestrator: JobQueueOrchestrator): void
getStatusWithProcessCheck(): Promise<MatchDetectionStatus>
getStatus(): MatchDetectionStatus
getCurrentMatch(): { bracket: string; timestamp: Date } | null
submitMatchChunk(chunkFilePath, matchMetadata, matchHash): Promise<string>
cleanup(): Promise<void>
```

**Dependencies:**

- `config: MatchDetectionServiceConfig` (apiBaseUrl, enableWoWProcessMonitoring)

**External:**

- `MatchDetectionOrchestrator` - Core detection pipeline
- `JobQueueOrchestrator` - Upload pipeline
- `WoWProcessMonitor` - Process monitoring

**State:**

- **In-memory:** Orchestrator instance, installation list, initialization flag
- **No disk persistence**

**Events:**

- `initialized`, `started`, `stopped`
- `matchStarted`, `matchProcessed`, `matchEnded`, `matchEndedIncomplete`
- `analysisJobCreated`, `analysisProgress`, `analysisCompleted`,
  `analysisFailed`
- `watcherError`, `chunkerError`, `pipelineError`, `watcherWarning`
- `wowProcessStart`, `wowProcessStop`, `processMonitorError`
- `serviceStatusChanged`

**Key Patterns:**

- **Adapter pattern** - Wraps orchestrator, forwards events
- **Initialization guard** - Prevents duplicate initialization
- **Retail-only filter** - Filters installations to `_retail_` paths only
- **Lazy orchestrator setup** - Can set `JobQueueOrchestrator` before/after init
- **Optional process check** - One-time WoW process status for UI

---

### MatchLifecycleService

**File:** `MatchLifecycleService.ts`

**Responsibility:** Single source of truth for match session lifecycle. Owns session state transitions and coordinates metadata + recording services. All structural validation lives here.

**Key APIs:**

```typescript
handleMatchStarted(event: MatchStartedEvent): Promise<void>
handleMatchEnded(event: MatchEndedEvent): Promise<void>
handleMatchEndedIncomplete(event: MatchEndedIncompleteEvent): Promise<void>
handleMatchValidationFailed(event: { bufferId, trigger, reason, metadata? }): Promise<void>
getSession(bufferId: string): MatchSessionState | undefined
```

**Dependencies:**

- `metadataService: MetadataService` (required)
- `recordingService: RecordingService | null` (optional, null if recording disabled)

**Session State:**

```typescript
type MatchLifecycleState = 'active' | 'complete' | 'incomplete';

interface MatchSessionState {
  bufferId: string;
  state: MatchLifecycleState;
  completionReason?: string;
}
```

**Behavior:**

**handleMatchStarted(event):**
- Deduplicates: ignores duplicate starts for already-active sessions (e.g., `/reload`)
- Creates session with `state: 'active'`
- Calls `metadataService.createInitialMetadata(event)`
- Calls `recordingService.handleMatchStarted(event)` if present

**handleMatchEnded(event):**
- Validates session is active
- Loads stored metadata by bufferId
- Applies structural validation:
  - Solo Shuffle: exactly 6 rounds, W-L consistent with round count
  - 2v2/3v3: no duplicate starts, exact combatant count (4/6), at least one kill
- If valid:
  - Calls `metadataService.finalizeCompleteMatch(event)` → matchHash
  - Calls `recordingService.handleMatchEnded(bufferId)`
  - Marks session `complete`
- If invalid:
  - Hard invalidation (INSUFFICIENT_COMBATANTS, NO_PLAYER_DEATH): routes to `handleMatchEndedIncomplete`
  - Soft invalidation (other failures): routes to `handleMatchValidationFailed`

**handleMatchEndedIncomplete(event):**
- Marks session `incomplete`
- Calls `metadataService.markMatchIncomplete(bufferId, trigger, buffer.metadata)`
- Calls `recordingService.handleEarlyEnd(bufferId, reason)`
- Hard-deletes metadata and video for triggers: `CANCEL_INSTANT_MATCH`, `INSUFFICIENT_COMBATANTS`, `NO_PLAYER_DEATH`, `NEW_MATCH_START`

**handleMatchValidationFailed(event):**
- Marks session `incomplete`
- Calls `metadataService.markMatchValidationFailed(bufferId, trigger, reason, metadata?)` (metadata optional)
- Calls `recordingService.handleEarlyEnd(bufferId, reason)`

**Validation Rules (SSoT):**

```typescript
validateMatchCompleteness(incoming: MatchMetadata):
  - Solo Shuffle:
    • Must have shuffleRounds array
    • Exactly 6 rounds required
    • Recording player W-L must equal round count
  - 2v2/3v3:
    • Reject duplicate ARENA_MATCH_START events (reload anomaly)
    • Exact combatant count: 4 for 2v2, 6 for 3v3 → INSUFFICIENT_COMBATANTS
    • At least one player death required → NO_PLAYER_DEATH
```

**Invariants:**

- Session state is monotonic: `active → complete | incomplete`
- Recording stopped exactly once per session (via handleMatchEnded OR handleEarlyEnd, never both)
- Only this service decides complete vs incomplete
- Validation logic lives here, not in MetadataService or RecordingService

---

### MetadataService

**File:** `MetadataService.ts`

**Responsibility:** Pure match metadata data operations with no structural
validation (validation moved to MatchLifecycleService).

**Key APIs:**

```typescript
// Phase 1: Create initial metadata on match start
createInitialMetadata(event: MatchStartedEvent): Promise<void>

// Phase 2: Mark incomplete matches (early-end or validation failed)
markMatchIncomplete(
  bufferId: string,
  trigger: EarlyEndTrigger,
  metadata?: Partial<MatchMetadata>
): Promise<void>

markMatchValidationFailed(
  bufferId: string,
  trigger: string,
  reason: string,
  metadata?: MatchMetadata
): Promise<boolean>  // true if persisted, false if not found; throws on catastrophic/save failures

// Phase 3: Finalize complete matches with hash generation
finalizeCompleteMatch(event: MatchEndedEvent): Promise<string>

// Utilities
loadMatchByBufferId(bufferId: string): Promise<StoredMatchMetadata | null>
deleteMatchByBufferId(bufferId: string): Promise<boolean>
ensureMatchHashForBufferId(bufferId: string): Promise<string>
updateVideoMetadataByBufferId(bufferId: string, videoData: VideoMetadataUpdate): Promise<void>
```

**Dependencies:**

- `metadataStorageService: MetadataStorageService` (required, no fallback)

**External:**

- `generateMatchHash()` utility
- `getTriggerMessage()` utility

**State:** Stateless (pure data operations, delegates to storage)

**Three-Phase Lifecycle:**

**Phase 1: createInitialMetadata(event)**

- Triggered by `MatchLifecycleService.handleMatchStarted`
- Creates `{bufferId}.json` with:
  - `matchCompletionStatus = 'in_progress'`
  - `enrichmentPhase = 'initial' | 'combatants_added'`
  - Basic match data (timestamp, bracket, season, players)
  - `uploadStatus = PENDING`
- No matchHash yet (generated in Phase 3)

**Phase 2A: markMatchIncomplete(bufferId, trigger, metadata?)**

- Called by `MatchLifecycleService.handleMatchEndedIncomplete`
- For early-end scenarios (LOG_FILE_CHANGE, timeout, zone change)
- Enriches with partial metadata snapshot if available (players, shuffleRounds)
- Updates:
  - `matchCompletionStatus = 'incomplete'`
  - `enrichmentPhase = 'finalized'`
  - `errorMessage = getTriggerMessage(trigger)` (e.g., "combat log file
    changed")

**Phase 2B: markMatchValidationFailed(bufferId, trigger, reason, metadata?)**

- Called by `MatchLifecycleService.handleMatchValidationFailed`
- For structural validation failures (e.g., Solo Shuffle < 6 rounds)
- If metadata provided, enriches with full parsed metadata (preserves data for inspection)
- Updates:
  - `matchCompletionStatus = 'incomplete'`
  - `enrichmentPhase = 'finalized'`
  - `errorMessage = reason` (human-readable validation error)

**Phase 3: finalizeCompleteMatch(event) → matchHash**

- Called by `MatchLifecycleService.handleMatchEnded` after validation passes
- Assumes structural validation already passed (no checks here)
- Enriches metadata with event.metadata
- Generates matchHash (timestamp + players, deterministic)
- Updates:
  - `matchHash` (64-char hex)
  - `matchCompletionStatus = 'complete'`
  - `enrichmentPhase = 'finalized'`
  - Clears error fields
- Returns matchHash for upload coordination

**Key Patterns:**

- **No validation logic** - All structural rules live in MatchLifecycleService
- **BufferId-first** - All operations keyed by bufferId, not matchHash
- **Single enrichment helper** - Internal `enrichMetadata` for all paths
- **Pure data operations** - No lifecycle decisions
- **Deterministic hash** - Service authoritative, generated once

---

### MetadataStorageService

**File:** `MetadataStorageService.ts`

**Responsibility:** File-based persistent storage for match metadata with atomic
writes, concurrent access control, and validation.

**Key APIs:**

```typescript
initialize(): Promise<void>
saveMatch(metadata: StoredMatchMetadata): Promise<void>
loadMatchByBufferId(bufferId: string): Promise<StoredMatchMetadata | null>
loadMatch(matchHash: string): Promise<StoredMatchMetadata | null>
findMatchByJobId(jobId: string): Promise<StoredMatchMetadata | null>
updateMatchStatus(matchHash: string, status: UploadStatus, additionalData?: {}): Promise<void>
updateVideoMetadataByBufferId(bufferId: string, videoData: VideoMetadataUpdate): Promise<void>
updateFavouriteByBufferId(bufferId: string, isFavourite: boolean): Promise<void>
listFavouriteVideoPathsWithDiagnostics(): Promise<{ paths: Set<string>; scanErrors: Array<{ file: string; error: string }> }>
deleteMatch(bufferId: string): Promise<boolean>
listMatches(limit?: number, offset?: number): Promise<StoredMatchMetadata[]>
getMatchesCount(): Promise<number>
cleanupOldMatches(): Promise<number>
```

**Dependencies:**

- `config: MetadataStorageServiceConfig` (maxFiles)

**External:**

- `fs/promises` - File operations
- `async-mutex` - Per-key locking
- `EventEmitter` - Event notifications

**State:**

- **Location:** `{userDataPath}/logs/matches/`
- **Filename:** `{sanitizedBufferId}.json`
- **In-memory:** Per-key mutex map (prevents concurrent writes)

**Events:**

- `initialized`
- `matchSaved: { matchHash, bufferId, filepath }`
- `matchUpdated` (variants):
  - `{ matchHash, bufferId, status, additionalData }` - status updates
  - `{ bufferId, videoData }` - video metadata updates
  - `{ bufferId, isFavourite }` - favourite toggle
- `matchDeleted: { bufferId, hadVideo }`
- `cleanupCompleted: { deletedCount }`
- `error: { context, error }`

**Configuration:**

- Default max files: 1000 (oldest deleted when exceeded)

**Key Patterns:**

- **Async-mutex serialization** - Per-key mutex prevents race conditions
- **Atomic write guarantee** - Temp file + rename with retry:
  1. Write to `{filepath}.tmp`
  2. Atomic rename to `{filepath}`
  3. On failure: retry with 25-50ms backoff (up to 3 attempts)
  4. Cleanup temp file on failure
- **Content-based lookup** - Searches all files for jobId/hash (no filename
  assumptions)
- **Transient error handling** - Windows-specific classification:
  - `EBUSY`, `EPERM`, `ENOENT` → Transient (retry)
  - Others → Permanent (logged differently)
- **Validation on save:**
  - Required fields check
  - Enum value validation
  - Solo Shuffle structure validation
  - matchHash required for completed matches only
- **Date rehydration** - Auto-converts JSON timestamps to Date objects
- **Video cleanup** - Atomic deletion with path validation (must be absolute)
- **No-op guard** - Skips writes if no changes

---

## Recording System

### RecordingService

**File:** `RecordingService.ts`

**Responsibility:** Match-driven recording orchestrator. Follows MatchLifecycleService decisions and coordinates OBS recording with metadata updates. BufferId-first, no validation logic.

**Key APIs:**

```typescript
// Lifecycle
initialize(): Promise<void>
enable(): Promise<void>
disable(): Promise<void>
shutdown(): Promise<void>

// Match-driven recording (called by MatchLifecycleService)
handleMatchStarted(event: MatchStartedEvent): Promise<void>
handleMatchEnded(bufferId: string): Promise<void>
handleEarlyEnd(bufferId: string, reason: string): Promise<{ finalPath: string | null; deleted: boolean }>

// Status
getStatus(): Promise<RecordingServiceStatus>
isOBSInitialized(): boolean
isRecordingActive(): boolean

// Settings (pass-through to OBSRecorder)
applyRecordingSettings(settings: Partial<RecordingSettings>): Promise<boolean>
updateRecordingDirectory(newDirectory: string): Promise<void>
getAudioDevices(): Promise<{ input: AudioDevice[]; output: AudioDevice[] }>
getMonitors(): Promise<Array<{ id: string; name: string }>>

// Preview (pass-through)
setMainWindow(window: BrowserWindow): void
showPreview(bounds: PreviewBounds): Promise<void>
updatePreviewBounds(bounds: PreviewBounds): Promise<void>
hidePreview(): void

// WoW integration (pass-through)
setWoWActive(active: boolean): void
setGameCaptureEnabled(enabled: boolean): void
```

**Constructor:**

```typescript
constructor(
  config: RecordingServiceConfig,
  metadataService: MetadataService,  // Required (V3: no fallback)
  settingsService?: SettingsService
)

interface RecordingServiceConfig extends OBSRecorderConfig {
  autoStart?: boolean;
  autoStop?: boolean;
  keepTemporaryFiles?: boolean;
  metadataIntegration?: boolean;
}
```

**Dependencies:**

- `metadataService: MetadataService` (required, V3: no fallback)
- `settingsService: SettingsService` (for directory/quota settings)
- `obsRecorder: OBSRecorder` (internal, created in constructor)

**Session State:**

```typescript
interface RecordingSession {
  bufferId: string;
  tempDir: string;
  finalPath: string | null;
  startTime: Date;
  endTime: Date | null;
  duration: number;
  status: 'recording' | 'stopping' | 'completed' | 'failed';
}
```

**Behavior (V3):**

**handleMatchStarted(event):**
- Guards: service enabled, autoStart true
- Idempotency: returns if already recording this bufferId
- Stale session handling: stops previous bufferId before starting new
- Calls `obsRecorder.startRecording(tempDir)`
- Creates `currentSession` with `status: 'recording'`

**handleMatchEnded(bufferId):**
- Delegates to `stopRecordingForMatch({ bufferId, outcome: 'complete' })`

**handleEarlyEnd(bufferId, reason):**
- Delegates to `stopRecordingForMatch({ bufferId, outcome: 'incomplete', reason })`

**stopRecordingForMatch(options) - Unified Stop Helper:**
- Validates session exists and bufferId matches
- Idempotency: returns same promise if already stopping
- Calls `obsRecorder.stopRecording()` → `StopRecordingResult`
  - `{ ok: true, filePath, durationSeconds }` on success
  - `{ ok: false, reason, durationSeconds }` on failure (`no_active_session`, `write_error`, `stop_error`, `stop_timeout`)
- If `ok: true`:
  - Renames to `{bufferId}.mp4` (complete) or `Incomplete_{bufferId}_{timestamp}.mp4` (incomplete)
  - Generates thumbnail via FFmpeg
  - Updates metadata: `metadataService.updateVideoMetadataByBufferId(bufferId, videoData)`
  - Enforces disk quota: `obsRecorder.enforceStorageQuota(maxDiskStorage, protectedVideoPaths?)`
    - Scans favourite matches via `listFavouriteVideoPathsWithDiagnostics()` to build protected paths set
    - Skips deletion of favourited recordings (may leave storage over quota if only favourites remain)
    - Updates deleted recordings to `recordingStatus: 'deleted_quota'` via `markRecordingDeletedByQuotaByVideoPath`
    - Emits `recordingRetentionCleanup({ deletedCount, freedGB, maxGB })` if recordings were deleted
  - Emits events:
    - Complete: `recordingCompleted({ matchHash, bufferId, path, duration })`
    - Incomplete: `recordingInterrupted({ bufferId, path, duration, reason })`
- If `ok: false`: marks session failed with appropriate `recordingStatus` (`failed_io`, `failed_timeout`, etc.), no rename

**Events:**

```typescript
emit('initialized')
emit('enabled')
emit('disabled')
emit('recordingStarted', { bufferId, path })
emit('recordingCompleted', { matchHash, bufferId, path, duration })
emit('recordingInterrupted', { bufferId, path, duration, reason })
emit('recordingRetentionCleanup', { deletedCount, freedGB, maxGB })
emit('error', error)
emit('shutdown')
```

**Invariants:**

- At most one recording session at any time
- Recording follows lifecycle (no structural decisions)
- BufferId is correlation key (not matchHash)
- One stop per bufferId (idempotent via currentStopPromise)
- Disk quota enforced after every recording

**Key V3 Patterns:**

- **Lifecycle follower** - No validation, reacts to lifecycle calls
- **BufferId-driven** - All operations keyed by bufferId
- **Unified stop** - Single helper for complete/incomplete outcomes
- **Metadata via MetadataService** - Not MetadataStorageService directly
- **Quota enforcement** - Respects user's maxDiskStorage setting

**See also:** `obs/README.md` for OBS-layer details

---

## Infrastructure Services

### ApiHeadersProvider

**File:** `ApiHeadersProvider.ts`

**Responsibility:** Centralized HTTP header management with optional
authentication.

**Key APIs:**

```typescript
updateToken(token?: string): void
getHeaders(additionalHeaders?: Record<string, string>): Record<string, string>
hasAuth(): boolean
getTokenStatus(): string
```

**Dependencies:** None

**State:**

- In-memory `authToken` (optional)
- No persistence

**Key Patterns:**

- Single source of truth for API headers
- Token masking for security
- Bearer token format
- User agent: `ArenaCoach-Desktop`

---

### ServiceHealthCheck

**File:** `ServiceHealthCheck.ts`

**Responsibility:** Tracks backend service availability based on actual API call
results (event-driven, not periodic).

**Key APIs:**

```typescript
reportSuccess(): void
reportFailure(isNetworkOrServerError: boolean): void
isServiceAvailable(): boolean
getLastCheckTime(): number
getTimeSinceLastSuccess(): number | null
checkOnce(): Promise<boolean>
getStatus(): { isAvailable, lastCheckTime, hasAuth }
```

**Dependencies:**

- `apiBaseUrl: string`
- `headersProvider: ApiHeadersProvider`
- `healthCheckEndpoint?: string` (defaults to `/health`)

**External:**

- `axios` - HTTP client for checks
- `EventEmitter` - Status notifications

**State:**

- Last check result (boolean)
- Last check time (timestamp)

**Events:**

- `statusChanged: boolean` (only on transitions)

**Configuration:**

- Health check timeout: 5 seconds
- Check endpoint: `/health`
- 2xx is acceptable (means service is up)

**Key Patterns:**

- **Event-driven health** - No background polling
- **Real API 4xx tolerance** - Normal client errors don't mark service down, but `/health` expects 2xx
- **5xx + network failures** - Mark service unavailable
- **Idle health checks** - Optional one-time check when no active jobs
- **Status transition only** - Only emits on changes

---

### SettingsService

**File:** `SettingsService.ts`

**Responsibility:** Application-wide settings persistence with schema
validation.

**Key APIs:**

```typescript
getSettings(): AppSettings
updateSettings(newSettings: Partial<AppSettings>): AppSettings
saveWindowBounds(bounds: WindowBounds): void
getWindowBounds(): WindowBounds
resetToDefaults(): AppSettings
```

**Dependencies:** None (uses electron-store internally)

**External:**

- `electron-store` - Persistent settings storage

**State:**

- Disk-persistent via electron-store
- Automatic JSON serialization

**Settings Structure:**

```typescript
{
  maxMatchFiles: number;           // Default: 1000
  recordingLocation?: string;
  maxDiskStorage?: number;         // GB, default: 50
  recordingEnabled?: boolean;      // Default: true
  matchDetectionEnabled?: boolean; // Default: true
  windowBounds?: WindowBounds;
  recording: RecordingSettings;    // Nested config
  runOnStartup?: boolean;          // Default: true
}
```

**Key Patterns:**

- electron-store integration
- Nested object merging (recording settings)
- Schema validation (window bounds, storage ranges)
- Undefined filtering (prevents accidental deletions)

---

### ChunkCleanupService

**File:** `ChunkCleanupService.ts`

**Responsibility:** Manages chunk file lifecycle via periodic maintenance.
Chunks are retained for a code-defined window (SSoT: ChunkRetentionConfig, 7 days) and
deleted via aged retention cleanup during periodic maintenance passes.

**Key APIs:**

```typescript
initialize(): Promise<void>
cleanupChunksForInstance(bufferId: string, jobId?: string): Promise<CleanupChunksForInstanceResult>
findAgedChunks(maxAgeMs: number, currentTimeMs: number): Promise<FindAgedChunksResult>
findOrphanedChunks(validBufferIds: Set<string>): Promise<FindOrphanedChunksResult>
deleteChunkForBufferId(bufferId: string): Promise<{ chunkDeleted: boolean; errors: string[] }>
cleanupFiles(filePaths: string[]): Promise<CleanupFilesResult>  // throws if not initialized; validates paths
getChunkStats(): Promise<{
  totalChunkFiles: number;
  totalSizeBytes: number;
  oldestFileAge: number;
  newestFileAge: number;
}>
cleanup(): void
```

**Dependencies:**

- `config: ChunkCleanupServiceConfig` (chunksDir)

**External:**

- `fs/promises` - File operations
- `EventEmitter` - Cleanup events

**State:**

- Chunks directory path (absolute, normalized)
- Initialization flag

**Events:**

- `cleanupCompleted: { bufferId, jobId?, totalFiles, deletedCount, missingCount, failureCount, deletedFiles }`
- `cleanupErrors: { bufferId, jobId?, failureCount, failedFiles: Array<{ file, error }> }`

**Configuration:**

- Chunks directory: `{userDataPath}/logs/chunks/` (or `{cwd}/data/logs/chunks/` in non-Electron)
- Chunk file naming: `{bufferId}.txt`

**Key Patterns:**

- BufferId-based correlation
- Parallel deletion (Promise.all)
- Orphaned chunk detection
- Path sanitization (alphanumeric + hyphen/underscore)
- Granular error tracking

---

## Cross-Service Data Flow

### Upload → Poll → Enrich Flow

```
1. Match Detected (Complete)
   ├─ MatchLifecycleService validates and finalizes
   └─ MetadataService.finalizeCompleteMatch() creates metadata with hash

2. Job Queue Orchestration
   ├─ JobQueueOrchestrator.submitMatchChunk()
   ├─ Generates jobId (UUID)
   ├─ Persists CorrelationData via JobStateStore (entitlement-agnostic)
   └─ Logs hasAuth for diagnostics only (no entitlement classification)

3. Upload
   ├─ UploadService.uploadChunk()
   ├─ Multipart POST to /api/upload with optional auth header
   ├─ Returns jobId
   └─ Reports health to ServiceHealthCheck

4. Polling
   ├─ CompletionPollingService.trackJob(jobId, matchHash)
   ├─ Polls /api/upload/job-status/:jobId with backoff
   ├─ Backend queries DB for entitlements, returns isPremiumViewer + conditional payload
   ├─ Desktop trusts backend response (no local entitlement inference)
   └─ Emits analysisCompleted (with/without payload) or analysisFailed

5. Enrichment
   ├─ AnalysisEnrichmentService.finalizeCompletion(jobId, analysisId?, payload?)
   ├─ Non-auth path: Mark COMPLETED
   ├─ Auth path: Enrich with events + Mark COMPLETED
   └─ MetadataStorageService.updateMatchStatus()

6. Retention
   └─ Chunks retained for 7 days (ChunkRetentionConfig); deleted by periodic maintenance
```

### Recording Flow (Lifecycle-Driven, BufferId-First)

```
1. Match Started
   ├─ MatchDetectionOrchestrator emits matchStarted
   ├─ MatchLifecycleService.handleMatchStarted(event)
   │   ├─ MetadataService.createInitialMetadata(event) → {bufferId}.json
   │   └─ RecordingService.handleMatchStarted(event)
   │       └─ OBSRecorder.startRecording(tempDir)
   │           └─ Creates session with UUID, status: 'starting' → 'recording'

2. Match Ended (Complete)
   ├─ MatchLifecycleService.handleMatchEnded(event)
   │   ├─ Validates: Solo Shuffle 6 rounds, W-L consistent
   │   ├─ MetadataService.finalizeCompleteMatch(event) → generates matchHash
   │   └─ RecordingService.handleMatchEnded(bufferId)
   │       └─ stopRecordingForMatch({ bufferId, outcome: 'complete' })
   │           ├─ OBSRecorder.stopRecording() → StopRecordingResult
   │           ├─ Rename: {bufferId}.mp4
   │           ├─ Thumbnail: Thumbnails/{bufferId}.jpg
   │           ├─ MetadataService.updateVideoMetadataByBufferId(bufferId, videoData)
   │           ├─ Enforce quota: OBSRecorder.enforceStorageQuota(maxDiskStorage, protectedVideoPaths?)
   │           └─ Emit: recordingCompleted({ matchHash, bufferId, path, duration })

3. Match Ended (Incomplete/Validation Failed)
   ├─ MatchLifecycleService.handleMatchEndedIncomplete(event) OR
   ├─ MatchLifecycleService.handleMatchValidationFailed(...)
   │   ├─ MetadataService.markMatchIncomplete/markMatchValidationFailed
   │   └─ RecordingService.handleEarlyEnd(bufferId, reason)
   │       └─ stopRecordingForMatch({ bufferId, outcome: 'incomplete', reason })
   │           ├─ OBSRecorder.stopRecording() → StopRecordingResult
   │           ├─ Rename: Incomplete_{bufferId}_{timestamp}.mp4
   │           ├─ Thumbnail: Thumbnails/Incomplete_{bufferId}_{timestamp}.jpg
   │           ├─ MetadataService.updateVideoMetadataByBufferId(bufferId, videoData)
   │           ├─ Enforce quota
   │           └─ Emit: recordingInterrupted({ bufferId, path, duration, reason })
```

**Key Principles:**

- BufferId is SSoT for local identity (metadata files, recording files, UI keys)
- MatchHash only for complete matches (upload/analysis)
- MatchLifecycleService owns all completion decisions
- RecordingService follows lifecycle (no validation logic)
- OBSRecorder uses per-session UUID state (no stale paths)

---

## Error Handling Patterns

### Retry Strategies

**Upload retries:**

- Delegated to `JobQueueOrchestrator`
- Exponential backoff: 1s → 5m max
- Permanent vs transient error classification

**Polling retries:**

- Exponential backoff: 5s → 60s (with jitter)
- Automatic on poll failure
- No attempt-based cap for required jobs

**File operation retries:**

- Metadata atomic rename: Single retry with 25-50ms backoff on
  `EPERM`/`EEXIST`/`EBUSY` (Windows file locking)
- Video file rename: 3 attempts with 1s delays (RecordingService)
- Per-key mutex prevents concurrent metadata writes

**WoW window detection retries (OBSCaptureManager):**

- Game capture mode: Exponential backoff 500ms → 30s max, continues indefinitely
  while enabled (no attempt cap)
- Window capture mode: Continuous polling (5-second interval, no attempt limit),
  stops when window found or mode changed

**WoW process monitoring (WoWProcessMonitor):**

- Fixed 2-second polling interval
- One-time 750ms delayed re-check on first poll
- No exponential backoff

### Error Classification

**Transient (will retry):**

- Windows file locking: `EBUSY`, `EPERM`, `ENOENT`
- Network errors: No response, timeout
- Server errors: 5xx responses
- Rate limits: 429 responses

**Permanent (won't retry):**

- Client errors: 4xx responses (except 429)
- Validation failures: Schema violations
- Missing dependencies: WoW not installed

### Idempotency Safeguards

**Duplicate uploads:**

- Accepts idempotent backend responses as success

**Duplicate enrichment:**

- Skips if already completed with same analysisId

**Duplicate tracking:**

- `trackJob()` ignores if job already tracked

**Duplicate metadata writes:**

- No-op if status unchanged and no additional data

---

## State Persistence

### Disk-Persisted State

| Service                | Location                          | Format         | Purpose                              |
| ---------------------- | --------------------------------- | -------------- | ------------------------------------ |
| JobStateStore          | `{userData}/pending-uploads.json` | JSON           | Job correlation for restart recovery |
| MetadataStorageService | `{userData}/logs/matches/`        | JSON per match | Match metadata                       |
| SettingsService        | `{userData}/config.json`          | JSON           | App settings                         |
| RecordingService       | `{recordingLocation}/`            | MP4 videos     | Match recordings                     |
| OBSRecorder            | `{userData}/osn-data/`            | OBS cache      | OBS configuration                    |
| ChunkCleanupService    | `{userData}/logs/chunks/`         | TXT chunks     | Retained 7 days for export/diagnostics |

### Atomic Write Patterns

All services use **temp file + rename** for crash safety:

```typescript
1. Write to {filepath}.tmp
2. Atomic rename to {filepath}
3. On error: cleanup temp file
4. On Windows locking: retry with backoff
```

### State Recovery on Restart

```
App Start
  ├─ JobStateStore.loadPendingUploads()
  ├─ For each pending job:
  │   └─ CompletionPollingService.trackJob(jobId, matchHash, { expectedEvents })
  └─ Polling resumes exactly where it left off
```

---

## Service Dependencies Graph

```
┌─────────────────────────────────────────────────────────────┐
│                    MatchDetectionService                     │
│  (Orchestrator wrapper, event forwarding)                   │
└─────────────────────────────────────────────────────────────┘
         │
         ├──▶ JobQueueOrchestrator (injected via setter)
         │      │
         │      ├──▶ UploadService
         │      │      ├──▶ ApiHeadersProvider
         │      │      └──▶ ServiceHealthCheck
         │      │
         │      ├──▶ CompletionPollingService
         │      │      └──▶ ServiceHealthCheck
         │      │
         │      ├──▶ JobStateStore
         │      └──▶ ApiHeadersProvider
         │
         └──▶ MetadataService
                ├──▶ MetadataStorageService
                └──▶ AnalysisEnrichmentService
                       └──▶ MetadataStorageService

┌─────────────────────────────────────────────────────────────┐
│                      RecordingService                        │
│  (OBS orchestration, auto-recording)                        │
└─────────────────────────────────────────────────────────────┘
         │
         ├──▶ OBSRecorder
         │      ├──▶ OBSCaptureManager
         │      ├──▶ OBSSettingsManager
         │      ├──▶ OBSPreviewManager
         │      └──▶ RecordingStorageManager
         │
         ├──▶ MetadataStorageService
         └──▶ SettingsService
```

---

## Performance Characteristics

### Memory Usage

| Service                  | Baseline | Per-Job/Match                 |
| ------------------------ | -------- | ----------------------------- |
| CompletionPollingService | ~1 MB    | ~500 bytes per tracked job    |
| MetadataStorageService   | ~2 MB    | ~10 KB per match file         |
| JobStateStore            | ~100 KB  | ~200 bytes per pending upload |
| RecordingService         | ~5 MB    | 0 (files on disk)             |
| OBSRecorder              | ~50 MB   | 0 (OBS overhead)              |

### Concurrency Limits

- **Polling:** Max 6 concurrent job status requests
- **Metadata writes:** Per-key mutex (unlimited concurrent for different keys)
- **Chunk cleanup:** Parallel deletion (Promise.all, no limit)

### Timing Characteristics

- **Polling base interval:** 5 seconds
- **Polling max backoff:** 60 seconds
- **File rename retry:** 1 second between attempts
- **WoW detection backoff:** 500ms → 30s max
- **Health check timeout:** 5 seconds
- **OBS stop warn timeout:** 30 seconds (logs warning, does not resolve)
- **OBS stop hard timeout:** 120 seconds (resolves `stop_timeout`, clears session)

---

## Common Patterns

### Dependency Injection

All services use constructor injection:

```typescript
constructor(
  private dependency: DependencyService,
  private config: ServiceConfig
) { }
```

### Event-Driven Communication

Services emit events, consumers subscribe:

```typescript
service.on('eventName', data => {
  // Handle event
});
```

### Atomic Operations

All file writes use temp file + rename:

```typescript
await fs.writeFile(tmpPath, data);
await fs.rename(tmpPath, finalPath); // Atomic on POSIX/Windows
```

### Validation at Boundaries

All public APIs validate inputs:

```typescript
if (!matchHash) {
  throw new Error('matchHash required');
}
```

### Graceful Degradation

Services handle missing optional dependencies:

```typescript
this.healthCheck?.reportSuccess(); // Only if provided
```

---

## Future Enhancement Areas

1. **Cross-Platform Support** - Abstract Windows-specific patterns
2. **WebSocket Polling** - Replace HTTP polling for lower latency
3. **Distributed Tracing** - Correlation IDs across all services
4. **Metrics Collection** - Prometheus-style metrics export
5. **Configuration Hot-Reload** - Update settings without restart
6. **Batch Operations** - Bulk metadata updates for performance

---

## Related Documentation

- **OBS Services:** See [`obs/README.md`](obs/README.md) for detailed OBS
  integration documentation
- **Main README:** See [`../../README.md`](../../README.md) for overall desktop
  app documentation

---

**Last Updated:** November 2025
