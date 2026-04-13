# Desktop Services Layer

**Business logic services for the ArenaCoach Desktop application.**

---

## Overview

The services layer provides specialized business logic components organized into
four functional areas:

1. **Upload Lifecycle Pipeline** - Job tracking, backend communication, and
   analysis enrichment
2. **Match Detection & Metadata** - Match lifecycle management and persistence
3. **Infrastructure** - Cross-cutting concerns (settings, health, headers,
   cleanup)
4. **Recording System** - OBS integration (see [`obs/README.md`](obs/README.md))

All services follow dependency injection patterns with clear separation of
concerns.

---

## Table of Contents

1. [Upload Lifecycle Pipeline](#upload-lifecycle-pipeline)
2. [Match Detection & Metadata](#match-detection--metadata)
3. [Infrastructure Services](#infrastructure-services)
4. [Cross-Service Data Flow](#cross-service-data-flow)
5. [Error Handling Patterns](#error-handling-patterns)
6. [State Persistence](#state-persistence)

---

## Upload Lifecycle Pipeline

### Overview

The upload lifecycle uploads match chunks to the backend, persists pre- and
post-acceptance state for restart safety, tracks accepted uploads over SSE, and
falls back to the status endpoint when realtime transport is interrupted.

**Key Architecture:**

- **Acceptance boundary is explicit:** uploads are local-only until `/api/upload`
  returns an accepted tracking contract
- **Accepted tracking is server-authoritative:** desktop only tracks accepted
  uploads via the backend contract (`acceptedJobId`, `statusPath`,
  `realtimePath`)
- **No client-side entitlement classification:** analysis payload presence is
  determined entirely by the backend
- **Status endpoint is recovery, not hot path:** SSE is primary; status is used
  on reconnect/restart and for diagnostics

**Services:**

1. **UploadLifecycleService** - Owns upload retries, acceptance transitions,
   persistence, and terminal cleanup
2. **UploadLifecycleStore** - Persists local-pending and accepted uploads across
   restarts
3. **UploadService** - Uploads chunks to backend API and returns the accepted
   tracking contract
4. **AcceptedUploadTracker** - Tracks accepted uploads over SSE with status-call
   fallback
5. **AnalysisEnrichmentService** - Enriches metadata with analysis results
6. **ApiHeadersProvider** - Centralizes authentication header management

---

### UploadLifecycleService

**File:** `upload-lifecycle/UploadLifecycleService.ts`

**Responsibility:** Primary upload-lifecycle coordinator. Owns the
pre-acceptance retry loop, acceptance-state persistence, restart recovery
branching, accepted-upload tracker wiring, and terminal cleanup for both
local-pending and accepted uploads.

**Constructor dependencies:**

- `uploadService: UploadService`
- `acceptedUploadTracker: AcceptedUploadTracker`
- `lifecycleStore: UploadLifecycleStore`
- `headersProvider: ApiHeadersProvider`
- `uploadRecoveryService: UploadRecoveryService`

**Key APIs:**

```typescript
initialize(): Promise<void>
resumePendingUploads(): Promise<void>
submitMatchChunk(
  chunkFilePath: string,
  matchMetadata: MatchEndedEvent,
  matchHash: string
): Promise<string>
getStatus(): UploadLifecycleSnapshot
cleanup(): Promise<void>
updateAuthToken(token?: string): void
```

**State model:**

- `local_pending` - desktop has a chunk and metadata, but `/api/upload` has not
  yet returned accepted tracking
- `accepted` - backend accepted the upload and returned
  `{ acceptedJobId, statusPath, realtimePath }`; the desktop now tracks only the
  accepted server-known upload

**Restart behavior:**

- `initialize()` loads persisted lifecycle state from `UploadLifecycleStore`
- `resumePendingUploads()` branches deterministically:
  - `accepted` records resume via `AcceptedUploadTracker`
  - `local_pending` records resume via `UploadRecoveryService` and re-enter the
    pre-acceptance upload loop

**Acceptance and terminal behavior:**

- `/api/upload` success is not considered complete until accepted state is
  durably persisted
- accepted-upload terminal events are not forwarded until accepted-record cleanup
  is durably persisted
- pre-acceptance uploads stop retrying once they cross the existing
  `ExpirationConfig` combat-log expiration boundary

**Events:**

- `analysisJobCreated: { jobId, matchHash, status }`
- `analysisProgress: { jobId, status, message, matchHash }`
- `analysisCompleted: { jobId, matchHash, analysisId?, analysisPayload? }`
- `analysisFailed: { jobId, matchHash, error, errorCode?, isPermanent?, isNotFound? }`
- `uploadRetrying: { matchHash, attempt, nextAttempt, delayMs, ...error }`
- `transportError: { jobId, matchHash, error }`
- `authRequired: { jobId, matchHash, error }`
- `serviceStatusChanged: { activeUploadsCount, localPendingUploadsCount, acceptedUploadsCount, activeUploadAttempts, lastStatusObservedAt }`

**Key patterns:**

- Explicit acceptance boundary
- Durable persistence before lifecycle transitions proceed
- Local-pending vs accepted restart split
- Shutdown-aware cancellation for local upload attempts
- Accepted-upload auth failures surface through `authRequired`, not transport retry noise

---

### UploadLifecycleStore

**File:** `upload-lifecycle/UploadLifecycleStore.ts`

**Responsibility:** Persists local-pending and accepted uploads to disk for
restart-safe recovery.

**Key APIs:**

```typescript
savePendingUploads(uploads: Map<string, UploadLifecycleRecord>): Promise<void>
loadPendingUploads(): Promise<Map<string, UploadLifecycleRecord>>
```

**Dependencies:** None

**State:**

- **Location:** `{userDataPath}/pending-uploads.json`
- **Format:** JSON object mapping local upload IDs to `UploadLifecycleRecord`
- **Migration behavior:** legacy pending records without acceptance are migrated
  into `local_pending` state and retried instead of being tracked as accepted

**Key Patterns:**

- **Atomic writes** - Temp file + rename for crash safety
- **Directory auto-creation** - Creates parent directories if missing
- **Conservative recovery** - Restores accepted tracking only when the accepted
  server contract is present

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
): Promise<UploadAcceptedResponse>

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

- Called by `UploadLifecycleService.submitMatchChunk()`
- Reports success/failure to `ServiceHealthCheck`
- Uses `ApiHeadersProvider` for optional authentication

**Error Handling:**

- Validates file exists before upload
- Distinguishes network/5xx (service down) vs 4xx (client error)
- Idempotent responses treated as success
- No retries (delegated to `UploadLifecycleService`)

**Key Patterns:**

- Atomic file validation
- Health integration
- Accepted-upload contract normalization

---

### AcceptedUploadTracker

**File:** `upload-lifecycle/AcceptedUploadTracker.ts`

**Responsibility:** Tracks accepted uploads over SSE and falls back to the
status endpoint when the realtime transport drops.

**Key APIs:**

```typescript
trackAcceptedUpload(tracking: UploadTrackingContract, matchHash: string): void
stopTracking(jobId: string): void
stopAll(): void
getTrackedCount(): number
```

**Dependencies:**

- `apiBaseUrl: string`
- `headersProvider: ApiHeadersProvider`
- `statusClient: UploadStatusClient`
- `healthCheck?: ServiceHealthCheck`

**External:**

- `fetch` - SSE transport
- `EventEmitter` - Event notifications
- `ServiceHealthCheck` - Health integration

**State:**

- **In-memory only:** accepted-upload session map keyed by accepted job ID
- **Per-session state:** tracking contract, match hash, last status,
  reconnect attempts, abort controller

**Events:**

- `analysisProgress: { jobId, status, message, matchHash }`
- `analysisCompleted: { jobId, matchHash, analysisId?, analysisPayload? }`
- `analysisFailed: { jobId, matchHash, error, errorCode?, isNotFound? }`
- `transportError: { jobId, matchHash, error }`
- `authRequired: { jobId, matchHash, error }`
- `serviceStatusChanged: { trackingActive, acceptedUploadsCount, lastStatusObservedAt }`

**Behavior:**

```typescript
1. Open SSE stream to tracking.realtimePath
2. Apply canonical status events to the local session
3. If the stream drops, call tracking.statusPath for recovery
4. Reconnect with bounded backoff unless a terminal state is reached
```

**Key Patterns:**

- **SSE-first accepted tracking** - polling is no longer the primary transport
- **Canonical recovery path** - status endpoint is used after transport errors
- **Contract violation guard** - completed responses with malformed payloads
  fail explicitly
- **Idempotent registration** - duplicate `trackAcceptedUpload()` calls are
  ignored

---

### AnalysisEnrichmentService

**File:** `AnalysisEnrichmentService.ts`

**Responsibility:** Enriches stored match metadata with server-provided analysis
data via single atomic write.

**Key APIs:**

```typescript
finalizeCompletion(
  jobId: string,
  analysisId: number | undefined,
  analysisPayload: AnalysisPayload | undefined,
  freemiumFields: FreemiumQuotaFields
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
setUploadLifecycleService(orchestrator: UploadLifecycleService): void
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
- `UploadLifecycleService` - Upload pipeline
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
- **Active-flavor filter** - Rejects installations that do not match `activeFlavor.dirName`
- **Lazy orchestrator setup** - Can set `UploadLifecycleService` before/after init
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
updateMatchStatus(matchHash: string, status: UploadStatus, additionalData?: {}): Promise<UploadStatus | null>
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

### Upload → Track → Enrich Flow

```
1. Match Detected (Complete)
   ├─ MatchLifecycleService validates and finalizes
   └─ MetadataService.finalizeCompleteMatch() creates metadata with hash

2. Upload Lifecycle Coordination
   ├─ UploadLifecycleService.submitMatchChunk()
   ├─ Generates local upload ID (UUID)
   ├─ Persists local-pending state via UploadLifecycleStore
   └─ Treats the upload as local-only until backend acceptance is confirmed

3. Upload
   ├─ UploadService.uploadChunk()
   ├─ Multipart POST to /api/upload with optional auth header
   ├─ Returns accepted tracking contract
   └─ Reports health to ServiceHealthCheck

4. Accepted Upload Tracking
   ├─ AcceptedUploadTracker.trackAcceptedUpload(tracking, matchHash)
   ├─ Opens SSE stream to tracking.realtimePath
   ├─ Falls back to tracking.statusPath after reconnect/restart or transport failure
   ├─ Backend recomputes canonical status and entitlement-gated payload
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

- Delegated to `UploadLifecycleService`
- Exponential backoff: 1s → 5m max
- Permanent vs transient error classification

**Accepted-upload transport recovery:**

- SSE is the primary accepted-upload transport
- Status endpoint is the canonical recovery path after disconnects/restarts
- Reconnect backoff: 1s → 30s max

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

- `trackAcceptedUpload()` ignores if job already tracked

**Duplicate metadata writes:**

- No-op if status unchanged and no additional data

---

## State Persistence

### Disk-Persisted State

| Service                | Location                          | Format         | Purpose                              |
| ---------------------- | --------------------------------- | -------------- | ------------------------------------ |
| UploadLifecycleStore          | `{userData}/pending-uploads.json` | JSON           | Job correlation for restart recovery |
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
  ├─ UploadLifecycleStore.loadPendingUploads()
  ├─ For each accepted upload:
  │   └─ AcceptedUploadTracker.trackAcceptedUpload(tracking, matchHash)
  ├─ For each local-pending upload:
  │   └─ UploadRecoveryService rehydrates chunk + metadata and retries upload
  └─ Non-accepted uploads are never resumed via server status
```

---

## Service Dependencies Graph

```
┌─────────────────────────────────────────────────────────────┐
│                    MatchDetectionService                     │
│  (Orchestrator wrapper, event forwarding)                   │
└─────────────────────────────────────────────────────────────┘
         │
         ├──▶ UploadLifecycleService (injected via setter)
         │      │
         │      ├──▶ UploadService
         │      │      ├──▶ ApiHeadersProvider
         │      │      └──▶ ServiceHealthCheck
         │      │
         │      ├──▶ AcceptedUploadTracker
         │      │      └──▶ ServiceHealthCheck
         │      │
         │      ├──▶ UploadLifecycleStore
         │      └──▶ ApiHeadersProvider

┌─────────────────────────────────────────────────────────────┐
│                      MatchLifecycleService                   │
│  (Session SSoT, metadata + recording coordination)          │
└─────────────────────────────────────────────────────────────┘
         │
         ├──▶ MetadataService
         │      └──▶ MetadataStorageService
         └──▶ RecordingService
                ├──▶ MetadataService
                └──▶ SettingsService

┌─────────────────────────────────────────────────────────────┐
│                  AnalysisEnrichmentService                   │
│  (Accepted-upload completion enrichment)                    │
└─────────────────────────────────────────────────────────────┘
         │
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
         ├──▶ MetadataService
         └──▶ SettingsService
```

---

## Performance Characteristics

### Memory Usage

| Service                  | Baseline | Per-Job/Match                 |
| ------------------------ | -------- | ----------------------------- |
| AcceptedUploadTracker | ~1 MB    | ~500 bytes per tracked job    |
| MetadataStorageService   | ~2 MB    | ~10 KB per match file         |
| UploadLifecycleStore            | ~100 KB  | ~200 bytes per pending upload |
| RecordingService         | ~5 MB    | 0 (files on disk)             |
| OBSRecorder              | ~50 MB   | 0 (OBS overhead)              |

### Concurrency Limits

- **Accepted uploads:** One SSE stream per accepted upload
- **Local upload attempts:** Determined by active local uploads; tracked explicitly by `UploadLifecycleService`
- **Metadata writes:** Per-key mutex (unlimited concurrent for different keys)
- **Chunk cleanup:** Parallel deletion (Promise.all, no limit)

### Timing Characteristics

- **Upload retry backoff:** 1 second → 5 minutes max
- **SSE reconnect backoff:** 1 second → 30 seconds max
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
2. **Upload Lifecycle Metrics** - Export accepted/local upload counts for diagnostics
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
