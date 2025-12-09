/**
 * Upload status types for match metadata storage
 */
export enum UploadStatus {
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

import { MatchMetadata } from './MatchMetadata';

/**
 * Match completion status for progressive metadata system
 */
export type MatchCompletionStatus = 'in_progress' | 'complete' | 'incomplete';

/**
 * Recording status for match metadata
 * - 'not_applicable': Recording was never attempted for this match
 * - 'in_progress': Recording is currently active
 * - 'completed': Recording finished successfully with canonical filename
 * - 'completed_with_warning': Recording exists but rename failed; temp path used
 * - 'failed_io': OBS failed to write file or FS operation failed
 * - 'failed_unknown': Unexpected error during recording
 */
export type RecordingStatusType =
  | 'not_applicable'
  | 'in_progress'
  | 'completed'
  | 'completed_with_warning'
  | 'failed_io'
  | 'failed_unknown';

/**
 * Metadata enrichment phase tracking
 */
export type EnrichmentPhase = 'initial' | 'combatants_added' | 'finalized';

/**
 * Complete match record structure for local file storage
 * BREAKING CHANGE: New progressive metadata system with required lifecycle fields
 */
export interface StoredMatchMetadata {
  // Core match data from combat log parsing (SSoT)
  matchData: MatchMetadata;

  // Additional identifiers for correlation
  /** Universal match hash for correlation across all players in the same match - set at match completion */
  matchHash?: string;
  /** Buffer ID for event correlation during match lifecycle */
  bufferId?: string;

  // BREAKING CHANGE: Required progressive metadata fields
  /** Current completion status of the match */
  matchCompletionStatus: MatchCompletionStatus;
  /** Current enrichment phase */
  enrichmentPhase: EnrichmentPhase;
  /** When this metadata file was first created */
  createdAt: Date;
  /** When this metadata file was last updated */
  lastUpdatedAt: Date;

  // Upload tracking (preserved)
  /** pg-boss job ID when upload starts */
  jobId?: string;
  /** Backend analysis ID when complete */
  analysisId?: string;
  /** Current upload/processing status */
  uploadStatus: UploadStatus;
  /** Live progress message during processing */
  progressMessage?: string;
  /** Position in the job queue (1-based index, null if position unavailable or job not waiting) */
  queuePosition?: number | null;
  /** Total number of jobs in queue (waiting + active, null if not applicable for current job state) */
  totalInQueue?: number | null;

  // Essential server analysis results (preserved)
  /** Analyzed player's overall score */
  analyzed_player_overall_score?: number;
  /** User ID from backend */
  user_id?: number;
  /** Upload timestamp from backend */
  upload_timestamp?: string;
  /** Unique UUID for the analysis */
  uuid?: string;

  // Video recording metadata (optional - only present if recording enabled)
  /** Path to recorded video file */
  videoPath?: string;
  /** Video file size in bytes */
  videoSize?: number;
  /** Video duration in seconds */
  videoDuration?: number;
  /** Timestamp when video was recorded */
  videoRecordedAt?: string;
  /** Video resolution (e.g., "1920x1080") */
  videoResolution?: string;
  /** Video frame rate */
  videoFps?: number;
  /** Video codec used */
  videoCodec?: string;
  /** Path to video thumbnail image */
  videoThumbnail?: string;

  // Recording outcome tracking
  /** Current recording status for this match */
  recordingStatus?: RecordingStatusType;
  /** Canonical error code if recording failed (e.g., 'OBS_WRITE_ERROR', 'RENAME_FAILED') */
  recordingErrorCode?: string | undefined;
  /** User-friendly error message if recording failed */
  recordingErrorMessage?: string | undefined;

  // Event enrichment tracking (skill-capped only)
  /** Whether this match has received event enrichment from server */
  hasEventEnrichment?: boolean;

  // Error tracking for failed uploads
  /** Error message if upload/analysis failed */
  errorMessage?: string;
  /** Canonical backend error code (e.g., 'INVALID_LOG_FORMAT', 'QUOTA_EXHAUSTED') */
  errorCode?: string;
  /** Whether the failure is permanent (non-retryable) */
  isPermanent?: boolean;
  /** ISO timestamp when upload/analysis failed */
  failedAt?: string;

  // Freemium quota state (persisted for video view status bar)
  /** Entitlement mode at completion: 'skillcapped' | 'freemium' | 'none' */
  entitlementMode?: 'skillcapped' | 'freemium' | 'none';
  /** Whether free quota was exhausted when this match completed */
  freeQuotaExhausted?: boolean;

  // Storage metadata (preserved)
  /** Timestamp when this file was created/stored (added by storage layer) */
  storedAt?: number;
}

/**
 * Video metadata update structure for RecordingService
 * Used by updateVideoMetadata to safely update video fields without touching upload status
 */
export interface VideoMetadataUpdate {
  /** Path to recorded video file */
  videoPath?: string;
  /** Video file size in bytes */
  videoSize?: number;
  /** Video duration in seconds */
  videoDuration?: number;
  /** Timestamp when video was recorded */
  videoRecordedAt?: string;
  /** Video resolution (e.g., "1920x1080") */
  videoResolution?: string;
  /** Video frame rate */
  videoFps?: number;
  /** Video codec used */
  videoCodec?: string;
  /** Path to video thumbnail image */
  videoThumbnail?: string;

  // Recording outcome tracking (mirrors StoredMatchMetadata fields)
  /** Current recording status for this match */
  recordingStatus?: RecordingStatusType;
  /** Canonical error code if recording failed (undefined clears previous value) */
  recordingErrorCode?: string | undefined;
  /** User-friendly error message if recording failed (undefined clears previous value) */
  recordingErrorMessage?: string | undefined;
}

/**
 * Validation result for stored match metadata
 */
export interface ValidationResult {
  /** Whether the metadata is valid */
  isValid: boolean;
  /** Error messages if validation fails */
  errors: string[];
}
