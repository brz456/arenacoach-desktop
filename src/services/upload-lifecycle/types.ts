import type { AnalysisPayload } from '../AnalysisEnrichmentService';
import type { FreemiumQuotaFields } from '../../Freemium';

export const UPLOAD_ACCEPTANCE_STATES = ['local_pending', 'accepted'] as const;
export type UploadAcceptanceState = (typeof UPLOAD_ACCEPTANCE_STATES)[number];
export const UPLOAD_ANALYSIS_STATUSES = [
  'queued',
  'processing',
  'completed',
  'failed',
  'not_found',
] as const;
export type UploadAnalysisStatus = (typeof UPLOAD_ANALYSIS_STATUSES)[number];
export const UPLOAD_PROGRESS_STATUSES = ['queued', 'processing'] as const;
export type UploadProgressStatus = (typeof UPLOAD_PROGRESS_STATUSES)[number];
export type UploadTrackingPath = `/api/${string}`;

export interface UploadTrackingContract {
  acceptedJobId: string;
  statusPath: UploadTrackingPath;
  realtimePath: UploadTrackingPath;
}

interface UploadLifecycleRecordBase<TAcceptanceState extends UploadAcceptanceState> {
  acceptanceState: TAcceptanceState;
  matchHash: string;
  createdAt: number;
}

export interface LocalPendingUploadRecord extends UploadLifecycleRecordBase<'local_pending'> {
  bufferId: string;
}

export interface AcceptedUploadRecord extends UploadLifecycleRecordBase<'accepted'> {
  tracking: UploadTrackingContract;
  acceptedAt: number;
}

export type UploadLifecycleRecord = LocalPendingUploadRecord | AcceptedUploadRecord;

export interface UploadAcceptedResponse {
  tracking: UploadTrackingContract;
}

export interface UploadStatusResponse extends FreemiumQuotaFields {
  success: boolean;
  jobId: string;
  analysisStatus: UploadAnalysisStatus;
  analysisId: number | null;
  uuid: string | null;
  hasData: boolean;
  timestamp: string;
  analysisData?: unknown;
  jobDetails?: {
    createdAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
    retryCount: number;
    output: string | null;
  };
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  errorCode?: string;
  isPermanent?: boolean;
  isPremiumViewer?: boolean;
  premiumSources?: Array<'skillcapped' | 'stripe'>;
  entitlementSource?: string;
}

export interface UploadRealtimeStatusEvent extends UploadStatusResponse {
  type: 'upload_status';
  occurredAt: string;
}

export interface AnalysisCompletedData extends FreemiumQuotaFields {
  jobId: string;
  matchHash: string;
  analysisId?: number;
  analysisPayload?: AnalysisPayload;
  isPremiumViewer?: boolean;
  premiumSources?: Array<'skillcapped' | 'stripe'>;
}

export interface AnalysisFailedData {
  jobId: string;
  matchHash: string;
  error?: string;
  errorCode?: string;
  isPermanent?: boolean;
  isNotFound?: boolean;
}

export interface AnalysisProgressData {
  jobId: string;
  status: UploadProgressStatus;
  matchHash: string;
  message?: string;
  queuePosition?: number | null;
  totalInQueue?: number | null;
}

export interface UploadTransportErrorData {
  jobId: string;
  matchHash: string;
  error: string;
}

export interface UploadAuthRequiredData {
  jobId: string;
  matchHash: string;
  error: string;
}

export interface AcceptedUploadTrackerStatus {
  trackingActive: boolean;
  acceptedUploadsCount: number;
  lastStatusObservedAt: number;
}

export interface UploadLifecycleStatus {
  activeUploadsCount: number;
  localPendingUploadsCount: number;
  acceptedUploadsCount: number;
  activeUploadAttempts: number;
  lastStatusObservedAt: number;
}

export interface UploadLifecycleSnapshot {
  initialized: boolean;
  activeUploads: number;
  localPendingUploads: number;
  acceptedUploads: number;
  activeUploadAttempts: number;
  hasAuth: boolean;
}

export interface UploadRetryingData {
  matchHash: string;
  attempt: number;
  nextAttempt: number;
  delayMs: number;
  name?: string;
  message: string;
  code?: string;
  status?: number;
  method?: string;
  url?: string;
  timeoutMs?: number;
  responseData?: { error?: string; success?: boolean; isIdempotent?: boolean } | string;
  isAxiosError: boolean;
}

export function isUploadAnalysisStatus(value: unknown): value is UploadAnalysisStatus {
  return typeof value === 'string' && (UPLOAD_ANALYSIS_STATUSES as readonly string[]).includes(value);
}

export function isUploadProgressStatus(value: unknown): value is UploadProgressStatus {
  return typeof value === 'string' && (UPLOAD_PROGRESS_STATUSES as readonly string[]).includes(value);
}

export function isUploadTrackingPath(value: unknown): value is UploadTrackingPath {
  return typeof value === 'string' && /^\/api\/[A-Za-z0-9/_-]+$/.test(value);
}

export function parseUploadTrackingContract(value: unknown): UploadTrackingContract | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const tracking = value as Partial<UploadTrackingContract>;
  if (
    typeof tracking.acceptedJobId !== 'string' ||
    tracking.acceptedJobId.trim().length === 0 ||
    !isUploadTrackingPath(tracking.statusPath) ||
    !isUploadTrackingPath(tracking.realtimePath)
  ) {
    return null;
  }

  return {
    acceptedJobId: tracking.acceptedJobId,
    statusPath: tracking.statusPath,
    realtimePath: tracking.realtimePath,
  };
}
