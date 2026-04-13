import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import { isAxiosError } from 'axios';
import type { MatchEndedEvent } from '../../match-detection/types/MatchEvent';
import { ExpirationConfig } from '../../config/ExpirationConfig';
import {
  CombatLogExpiredError,
  PipelineErrorCode,
  isCombatLogExpiredError,
} from '../../match-detection/types/PipelineErrors';
import { toSafeAxiosErrorLog } from '../../utils/errorRedaction';
import { UploadService } from '../UploadService';
import { ApiHeadersProvider } from '../ApiHeadersProvider';
import { AcceptedUploadTracker } from './AcceptedUploadTracker';
import { UploadLifecycleStore } from './UploadLifecycleStore';
import { UploadRecoveryService } from './UploadRecoveryService';
import {
  AcceptedUploadRecord,
  UploadAuthRequiredData,
  AnalysisCompletedData,
  AnalysisFailedData,
  LocalPendingUploadRecord,
  UploadLifecycleSnapshot,
  UploadLifecycleStatus,
  UploadLifecycleRecord,
  UploadRetryingData,
} from './types';
import { isUnauthorizedAuthError } from './errors';

class UploadLifecycleShutdownError extends Error {
  constructor() {
    super('UploadLifecycleService is shutting down');
    this.name = 'UploadLifecycleShutdownError';
  }
}

interface LocalUploadSession {
  localUploadId: string;
  closed: boolean;
  abortController?: AbortController;
  retryDelayTimer?: ReturnType<typeof setTimeout>;
  retryDelayResolve?: () => void;
}

export class UploadLifecycleService extends EventEmitter {
  private static readonly INITIAL_PERSIST_RETRY_DELAY_MS = 1000;
  private static readonly MAX_PERSIST_RETRY_DELAY_MS = 30000;
  private pendingUploads = new Map<string, UploadLifecycleRecord>();
  private initialized = false;
  private shuttingDown = false;
  private activeUploadAttempts = 0;
  private localUploadSessions = new Map<string, LocalUploadSession>();
  private backgroundTasks = new Set<Promise<void>>();
  private persistenceRetryWaiters = new Set<{
    timer: ReturnType<typeof setTimeout>;
    reject: (error: Error) => void;
  }>();
  private readonly INITIAL_RETRY_DELAY_MS = 1000;
  private readonly MAX_RETRY_DELAY_MS = 300000;

  constructor(
    private uploadService: UploadService,
    private acceptedUploadTracker: AcceptedUploadTracker,
    private lifecycleStore: UploadLifecycleStore,
    private headersProvider: ApiHeadersProvider,
    private uploadRecoveryService: UploadRecoveryService
  ) {
    super();
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.shuttingDown = false;
    this.setupAcceptedUploadEventForwarding();
    this.pendingUploads = await this.lifecycleStore.loadPendingUploads();
    this.initialized = true;
    this.emitLifecycleStatusChanged();
  }

  async resumePendingUploads(): Promise<void> {
    this.assertInitialized();

    for (const [localUploadId, record] of this.pendingUploads) {
      if (record.acceptanceState === 'accepted') {
        this.acceptedUploadTracker.trackAcceptedUpload(record.tracking, record.matchHash);
        continue;
      }

      this.trackBackgroundTask(
        this.resumeLocalPendingUpload(localUploadId, record),
        localUploadId,
        record.matchHash
      );
    }
  }

  async submitMatchChunk(
    chunkFilePath: string,
    matchMetadata: MatchEndedEvent,
    matchHash: string
  ): Promise<string> {
    this.assertInitialized();
    this.assertNotExpired(matchMetadata);

    if (!matchMetadata.bufferId) {
      throw new Error('Cannot submit upload without bufferId');
    }

    const localUploadId = crypto.randomUUID();
    const record: LocalPendingUploadRecord = {
      matchHash,
      bufferId: matchMetadata.bufferId,
      createdAt: Date.now(),
      acceptanceState: 'local_pending',
    };
    this.pendingUploads.set(localUploadId, record);
    await this.persistPendingUploads();

    return this.uploadUntilAccepted(chunkFilePath, matchMetadata, matchHash, localUploadId);
  }

  updateAuthToken(token?: string): void {
    this.emitLifecycleStatusChanged();

    if (this.shuttingDown || !this.initialized) {
      return;
    }

    if (token && token.trim().length > 0) {
      return;
    }

    this.resumeIdleLocalPendingUploads();
  }

  getStatus(): UploadLifecycleSnapshot {
    const localPendingUploads = this.countLocalPendingUploads();
    const acceptedUploads = this.countAcceptedUploads();

    return {
      initialized: this.initialized,
      activeUploads: this.pendingUploads.size,
      localPendingUploads,
      acceptedUploads,
      activeUploadAttempts: this.activeUploadAttempts,
      hasAuth: this.headersProvider.hasAuth(),
    };
  }

  async cleanup(): Promise<void> {
    this.shuttingDown = true;
    this.initialized = false;
    this.cancelLocalUploadSessions();
    this.cancelPersistenceRetryWaiters();
    this.acceptedUploadTracker.stopAll();
    await Promise.allSettled(Array.from(this.backgroundTasks));
    await this.lifecycleStore.savePendingUploads(this.pendingUploads);
    this.removeAllListeners();
    this.acceptedUploadTracker.removeAllListeners();
  }

  private setupAcceptedUploadEventForwarding(): void {
    this.acceptedUploadTracker.on('analysisProgress', data => {
      this.emit('analysisProgress', data);
    });
    this.acceptedUploadTracker.on('analysisCompleted', data => {
      if (this.shuttingDown) {
        return;
      }
      void this.handleLifecycleTerminalEvent('analysisCompleted', data, () =>
        this.handleAnalysisCompleted(data)
      );
    });
    this.acceptedUploadTracker.on('analysisFailed', data => {
      if (this.shuttingDown) {
        return;
      }
      void this.handleLifecycleTerminalEvent('analysisFailed', data, () =>
        this.handleAnalysisFailed(data)
      );
    });
    this.acceptedUploadTracker.on('serviceStatusChanged', () => {
      this.emitLifecycleStatusChanged();
    });
    this.acceptedUploadTracker.on('transportError', data => {
      this.emit('transportError', data);
    });
    this.acceptedUploadTracker.on('authRequired', data => {
      this.emit('authRequired', data);
    });
  }

  private async resumeLocalPendingUpload(
    localUploadId: string,
    record: LocalPendingUploadRecord
  ): Promise<void> {
    this.assertRunning();
    const recovered = await this.uploadRecoveryService.recoverPendingUpload(record);
    this.assertRunning();
    if (!recovered) {
      this.pendingUploads.delete(localUploadId);
      await this.persistPendingUploadsDurably(
        'Removing unrecoverable local-pending upload state',
        {
          localUploadId,
          matchHash: record.matchHash,
          failureType: 'missing_local_recovery_data',
        }
      );
      this.emit('analysisFailed', {
        jobId: localUploadId,
        matchHash: record.matchHash,
        error: 'Upload retry could not be resumed because local match data or chunk file is missing',
        errorCode: 'UPLOAD_RECOVERY_FAILED',
        isPermanent: true,
      } satisfies AnalysisFailedData);
      return;
    }

    try {
      await this.uploadUntilAccepted(
        recovered.chunkFilePath,
        recovered.matchEvent,
        recovered.matchHash,
        localUploadId
      );
    } catch (error) {
      if (this.isShutdownError(error)) {
        return;
      }
      if (isUnauthorizedAuthError(error)) {
        return;
      }
      if (isCombatLogExpiredError(error)) {
        this.emit('analysisFailed', {
          jobId: localUploadId,
          matchHash: record.matchHash,
          error: error.message,
          errorCode: PipelineErrorCode.COMBAT_LOG_EXPIRED,
          isPermanent: true,
        } satisfies AnalysisFailedData);
        return;
      }
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      this.emit('analysisFailed', {
        jobId: localUploadId,
        matchHash: record.matchHash,
        error: normalizedError.message || 'Upload rejected before server acceptance',
        errorCode: 'UPLOAD_REJECTED',
        isPermanent: true,
      } satisfies AnalysisFailedData);
    }
  }

  private async uploadUntilAccepted(
    chunkFilePath: string,
    matchMetadata: MatchEndedEvent,
    matchHash: string,
    localUploadId: string
  ): Promise<string> {
    let attempt = 0;
    const session = this.getOrCreateLocalUploadSession(localUploadId);

    while (true) {
      this.assertRunning();
      attempt += 1;
      let retryDelayMs: number | null = null;

      try {
        this.assertNotExpired(matchMetadata);
        this.activeUploadAttempts += 1;
        this.emitLifecycleStatusChanged();
        session.abortController = new AbortController();
        const accepted = await this.uploadService.uploadChunk(
          chunkFilePath,
          matchMetadata,
          matchHash,
          localUploadId,
          session.abortController.signal
        );
        delete session.abortController;
        this.assertRunning();

        const acceptedRecord: AcceptedUploadRecord = {
          matchHash,
          createdAt: this.pendingUploads.get(localUploadId)?.createdAt ?? Date.now(),
          acceptanceState: 'accepted',
          tracking: accepted.tracking,
          acceptedAt: Date.now(),
        };
        this.pendingUploads.set(localUploadId, acceptedRecord);
        await this.persistPendingUploadsDurably(
          'Persisting accepted upload state after server acceptance',
          {
            jobId: accepted.tracking.acceptedJobId,
            matchHash,
            localUploadId,
          }
        );
        this.assertRunning();

        this.emit('analysisJobCreated', {
          matchHash,
          jobId: accepted.tracking.acceptedJobId,
          status: 'queued',
        });
        this.acceptedUploadTracker.trackAcceptedUpload(accepted.tracking, matchHash);

        this.closeLocalUploadSession(localUploadId);
        return accepted.tracking.acceptedJobId;
      } catch (error) {
        delete session.abortController;
        if (this.isShutdownError(error)) {
          this.closeLocalUploadSession(localUploadId);
          throw error;
        }
        if (isUnauthorizedAuthError(error)) {
          this.emitAuthRequired(localUploadId, matchHash, error);
          this.closeLocalUploadSession(localUploadId);
          throw error;
        }
        const normalizedError = error instanceof Error ? error : new Error(String(error));

        if (!this.isRetryableError(normalizedError)) {
          await this.handleTerminalLocalPendingFailure(
            localUploadId,
            matchHash,
            'UPLOAD_REJECTED',
            normalizedError.message || 'Upload rejected before server acceptance'
          );
          throw normalizedError;
        }

        const delayMs = Math.min(
          this.INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1),
          this.MAX_RETRY_DELAY_MS
        );
        retryDelayMs = delayMs;

        this.emit('uploadRetrying', {
          matchHash,
          attempt,
          nextAttempt: attempt + 1,
          delayMs,
          ...toSafeAxiosErrorLog(normalizedError),
        } satisfies UploadRetryingData);
      } finally {
        this.activeUploadAttempts = Math.max(0, this.activeUploadAttempts - 1);
        this.emitLifecycleStatusChanged();
      }

      if (retryDelayMs !== null) {
        await this.waitForRetryDelay(session, retryDelayMs);
      }
    }
  }

  private async handleAnalysisCompleted(data: AnalysisCompletedData): Promise<void> {
    await this.tryClearAcceptedRecordDurably(data.jobId, data.matchHash, 'analysisCompleted');
    this.emit('analysisCompleted', data);
  }

  private async handleAnalysisFailed(data: AnalysisFailedData): Promise<void> {
    await this.tryClearAcceptedRecordDurably(data.jobId, data.matchHash, 'analysisFailed');
    this.emit('analysisFailed', data);
  }

  private findRecordKeyByAcceptedJobId(jobId: string): string | undefined {
    for (const [localUploadId, record] of this.pendingUploads.entries()) {
      if (record.acceptanceState === 'accepted' && record.tracking.acceptedJobId === jobId) {
        return localUploadId;
      }
    }
    return undefined;
  }

  private isRetryableError(error: Error): boolean {
    const message = error.message.toLowerCase();

    if (isAxiosError(error) && error.code === 'ECONNABORTED') {
      return true;
    }

    if (
      message.includes('econnrefused') ||
      message.includes('enotfound') ||
      message.includes('etimedout') ||
      message.includes('econnreset') ||
      message.includes('network') ||
      message.includes('timeout of') ||
      message.includes('timed out') ||
      message.includes('socket hang up')
    ) {
      return true;
    }

    if ('response' in error && typeof (error as { response?: { status?: number } }).response === 'object') {
      const status = (error as { response?: { status?: number } }).response?.status;
      if (status && (status >= 500 || status === 429)) {
        return true;
      }
    }

    if ('code' in error) {
      const code = (error as { code?: string }).code;
      if (
        code &&
        ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ECONNABORTED'].includes(code)
      ) {
        return true;
      }
    }

    return false;
  }

  private async persistPendingUploads(): Promise<void> {
    await this.lifecycleStore.savePendingUploads(this.pendingUploads);
    this.emitLifecycleStatusChanged();
  }

  private async persistPendingUploadsDurably(
    action: string,
    context: Record<string, unknown>
  ): Promise<void> {
    let attempt = 0;

    while (true) {
      this.assertRunning();
      try {
        await this.persistPendingUploads();
        return;
      } catch (error) {
        attempt += 1;
        this.logPersistenceAnomaly(action, { ...context, attempt }, error);
        const delayMs = Math.min(
          UploadLifecycleService.INITIAL_PERSIST_RETRY_DELAY_MS * 2 ** (attempt - 1),
          UploadLifecycleService.MAX_PERSIST_RETRY_DELAY_MS
        );
        await this.waitForPersistenceRetry(delayMs);
      }
    }
  }

  private trackBackgroundTask(
    task: Promise<void>,
    localUploadId: string,
    matchHash: string
  ): void {
    const trackedTask = task.catch(error => {
      if (this.isShutdownError(error)) {
        return;
      }

      const normalizedError = error instanceof Error ? error : new Error(String(error));
      return this.handleUnexpectedResumeFailure(localUploadId, matchHash, normalizedError);
    }).finally(() => {
      this.backgroundTasks.delete(trackedTask);
    });

    this.backgroundTasks.add(trackedTask);
  }

  private async handleLifecycleTerminalEvent(
    eventName: 'analysisCompleted' | 'analysisFailed',
    eventData: AnalysisCompletedData | AnalysisFailedData,
    handler: () => Promise<void>
  ): Promise<void> {
    try {
      await handler();
    } catch (error) {
      console.error(`[UploadLifecycleService] Failed to handle ${eventName} event:`, {
        jobId: eventData.jobId,
        matchHash: eventData.matchHash,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleUnexpectedResumeFailure(
    localUploadId: string,
    matchHash: string,
    error: Error
  ): Promise<void> {
    console.error('[UploadLifecycleService] Local upload resume failed:', {
      localUploadId,
      matchHash,
      error: error.message,
    });
    this.emit('transportError', {
      jobId: localUploadId,
      matchHash,
      error: error.message || 'Upload retry could not be resumed',
    });
  }

  private resumeIdleLocalPendingUploads(): void {
    for (const [localUploadId, record] of this.pendingUploads) {
      if (record.acceptanceState !== 'local_pending') {
        continue;
      }

      if (this.localUploadSessions.has(localUploadId)) {
        continue;
      }

      this.trackBackgroundTask(
        this.resumeLocalPendingUpload(localUploadId, record),
        localUploadId,
        record.matchHash
      );
    }
  }

  private async handleTerminalLocalPendingFailure(
    localUploadId: string,
    matchHash: string,
    failureCode: string,
    _failureMessage: string
  ): Promise<void> {
    this.assertRunning();
    this.pendingUploads.delete(localUploadId);
    await this.persistPendingUploadsDurably(
      'Removing terminal local-pending upload state',
      {
        localUploadId,
        matchHash,
        failureType: failureCode,
      }
    );
    this.closeLocalUploadSession(localUploadId);
  }

  private async tryClearAcceptedRecordDurably(
    jobId: string,
    matchHash: string,
    terminalEvent: 'analysisCompleted' | 'analysisFailed'
  ): Promise<void> {
    const recordKey = this.findRecordKeyByAcceptedJobId(jobId);
    if (!recordKey) {
      return;
    }

    const existingRecord = this.pendingUploads.get(recordKey);
    this.pendingUploads.delete(recordKey);

    try {
      await this.persistPendingUploadsDurably(
        'Removing accepted upload record after terminal status',
        {
          jobId,
          matchHash,
          localUploadId: recordKey,
          terminalEvent,
        }
      );
    } catch (error) {
      if (existingRecord) {
        this.pendingUploads.set(recordKey, existingRecord);
      }
      this.logPersistenceAnomaly(
        'Accepted upload record cleanup could not be durably persisted after terminal status',
        {
          jobId,
          matchHash,
          localUploadId: recordKey,
          terminalEvent,
        },
        error
      );
      throw error;
    }
  }

  private getOrCreateLocalUploadSession(localUploadId: string): LocalUploadSession {
    const existing = this.localUploadSessions.get(localUploadId);
    if (existing) {
      return existing;
    }

    const session: LocalUploadSession = {
      localUploadId,
      closed: false,
    };
    this.localUploadSessions.set(localUploadId, session);
    return session;
  }

  private closeLocalUploadSession(localUploadId: string): void {
    const session = this.localUploadSessions.get(localUploadId);
    if (!session) {
      return;
    }

    session.closed = true;
    session.abortController?.abort();
    if (session.retryDelayTimer) {
      clearTimeout(session.retryDelayTimer);
      delete session.retryDelayTimer;
    }
    if (session.retryDelayResolve) {
      const resolve = session.retryDelayResolve;
      delete session.retryDelayResolve;
      resolve();
    }
    this.localUploadSessions.delete(localUploadId);
  }

  private cancelLocalUploadSessions(): void {
    for (const localUploadId of Array.from(this.localUploadSessions.keys())) {
      this.closeLocalUploadSession(localUploadId);
    }
  }

  private cancelPersistenceRetryWaiters(): void {
    for (const waiter of Array.from(this.persistenceRetryWaiters)) {
      waiter.reject(new UploadLifecycleShutdownError());
    }
    this.persistenceRetryWaiters.clear();
  }

  private async waitForRetryDelay(
    session: LocalUploadSession,
    delayMs: number
  ): Promise<void> {
    this.assertRunning();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        delete session.retryDelayTimer;
        delete session.retryDelayResolve;
        resolve();
      };
      const abort = () => {
        if (settled) {
          return;
        }
        settled = true;
        delete session.retryDelayTimer;
        delete session.retryDelayResolve;
        reject(new UploadLifecycleShutdownError());
      };

      if (session.closed || this.shuttingDown) {
        abort();
        return;
      }

      session.retryDelayResolve = finish;
      session.retryDelayTimer = setTimeout(finish, delayMs);
    });
    this.assertRunning();
  }

  private async waitForPersistenceRetry(delayMs: number): Promise<void> {
    this.assertRunning();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.persistenceRetryWaiters.delete(waiter);
        resolve();
      }, delayMs);
      const waiter = {
        timer,
        reject: (error: Error) => {
          clearTimeout(timer);
          this.persistenceRetryWaiters.delete(waiter);
          reject(error);
        },
      };
      this.persistenceRetryWaiters.add(waiter);
    });
    this.assertRunning();
  }

  private emitLifecycleStatusChanged(): void {
    if (this.shuttingDown) {
      return;
    }
    const activeUploadsCount = this.pendingUploads.size;
    this.emit('serviceStatusChanged', {
      activeUploadsCount,
      localPendingUploadsCount: this.countLocalPendingUploads(),
      acceptedUploadsCount: this.acceptedUploadTracker.getTrackedCount(),
      activeUploadAttempts: this.activeUploadAttempts,
      lastStatusObservedAt: Date.now(),
    } satisfies UploadLifecycleStatus);
  }

  private countAcceptedUploads(): number {
    let count = 0;
    for (const record of this.pendingUploads.values()) {
      if (record.acceptanceState === 'accepted') {
        count += 1;
      }
    }
    return count;
  }

  private countLocalPendingUploads(): number {
    let count = 0;
    for (const record of this.pendingUploads.values()) {
      if (record.acceptanceState === 'local_pending') {
        count += 1;
      }
    }
    return count;
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error('UploadLifecycleService not initialized');
    }
  }

  private assertRunning(): void {
    if (this.shuttingDown) {
      throw new UploadLifecycleShutdownError();
    }
    this.assertInitialized();
  }

  private isShutdownError(error: unknown): error is UploadLifecycleShutdownError {
    return (
      error instanceof UploadLifecycleShutdownError ||
      (error instanceof Error && error.name === 'CanceledError' && this.shuttingDown)
    );
  }

  private logPersistenceAnomaly(
    message: string,
    context: Record<string, unknown>,
    error: unknown
  ): void {
    console.error(`[UploadLifecycleService] ${message}`, {
      ...context,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private emitAuthRequired(jobId: string, matchHash: string, error: Error): void {
    this.emit('authRequired', {
      jobId,
      matchHash,
      error: error.message,
    } satisfies UploadAuthRequiredData);
  }

  private assertNotExpired(matchMetadata: MatchEndedEvent): void {
    const matchTimestamp = matchMetadata.metadata.timestamp.getTime();
    if (!ExpirationConfig.isExpired(matchTimestamp)) {
      return;
    }

    const ageInHours = ExpirationConfig.getAgeInHours(matchTimestamp);
    throw new CombatLogExpiredError(
      `Combat log expired (${ageInHours.toFixed(1)} hours old)`,
      ageInHours
    );
  }
}
