import { EventEmitter } from 'events';
import { ApiHeadersProvider } from '../ApiHeadersProvider';
import { ServiceHealthCheck } from '../ServiceHealthCheck';
import type { AnalysisPayload } from '../AnalysisEnrichmentService';
import {
  AcceptedUploadTrackerStatus,
  UploadAnalysisStatus,
  AnalysisCompletedData,
  AnalysisFailedData,
  AnalysisProgressData,
  UploadTransportErrorData,
  UploadAuthRequiredData,
  UploadRealtimeStatusEvent,
  UploadStatusResponse,
  UploadTrackingContract,
  isUploadAnalysisStatus,
} from './types';
import {
  isBackendContractViolationError,
  RealtimeStreamContractError,
  isUnauthorizedAuthError,
  UnauthorizedAuthError,
} from './errors';
import { UploadStatusClient } from './UploadStatusClient';

interface AcceptedUploadSession {
  tracking: UploadTrackingContract;
  matchHash: string;
  lastStatus?: UploadAnalysisStatus;
  closed: boolean;
  reconnectAttempts: number;
  authRequiredEmitted?: boolean;
  abortController?: AbortController;
  retryDelayTimer?: ReturnType<typeof setTimeout>;
  retryDelayResolve?: () => void;
}

interface SseFrame {
  event: string;
  data: string;
}

export class AcceptedUploadTracker extends EventEmitter {
  private static readonly BASE_RECONNECT_DELAY_MS = 1000;
  private static readonly MAX_RECONNECT_DELAY_MS = 30000;
  private sessions = new Map<string, AcceptedUploadSession>();
  private lastStatusObservedAt = 0;

  constructor(
    private apiBaseUrl: string,
    private headersProvider: ApiHeadersProvider,
    private statusClient: UploadStatusClient,
    private healthCheck?: ServiceHealthCheck
  ) {
    super();
  }

  trackAcceptedUpload(tracking: UploadTrackingContract, matchHash: string): void {
    const existingSession = this.sessions.get(tracking.acceptedJobId);
    if (existingSession) {
      if (
        existingSession.matchHash !== matchHash ||
        existingSession.tracking.statusPath !== tracking.statusPath ||
        existingSession.tracking.realtimePath !== tracking.realtimePath
      ) {
        console.error(
          '[AcceptedUploadTracker] Duplicate accepted upload registration conflicted with existing tracked session identity',
          {
            acceptedJobId: tracking.acceptedJobId,
            existingMatchHash: existingSession.matchHash,
            nextMatchHash: matchHash,
            existingStatusPath: existingSession.tracking.statusPath,
            nextStatusPath: tracking.statusPath,
            existingRealtimePath: existingSession.tracking.realtimePath,
            nextRealtimePath: tracking.realtimePath,
          }
        );
        this.emitFailure({
          jobId: tracking.acceptedJobId,
          matchHash: existingSession.matchHash,
          error:
            'Backend contract violation: duplicate accepted upload registration conflicted with the existing tracked session identity',
          errorCode: 'BACKEND_CONTRACT_VIOLATION',
          isPermanent: true,
        });
      }
      return;
    }

    const session: AcceptedUploadSession = {
      tracking,
      matchHash,
      closed: false,
      reconnectAttempts: 0,
    };
    this.sessions.set(tracking.acceptedJobId, session);
    this.emitServiceStatusChanged();
    void this.runSession(session);
  }

  stopTracking(jobId: string): void {
    const session = this.sessions.get(jobId);
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
    this.sessions.delete(jobId);
    this.emitServiceStatusChanged();
  }

  stopAll(): void {
    for (const jobId of Array.from(this.sessions.keys())) {
      this.stopTracking(jobId);
    }
  }

  getTrackedCount(): number {
    return this.sessions.size;
  }

  private async runSession(session: AcceptedUploadSession): Promise<void> {
    while (!session.closed) {
      try {
        await this.consumeRealtimeStream(session);
      } catch (error) {
        if (this.handleAuthRequired(session, error)) {
          session.reconnectAttempts += 1;
          const delayMs = this.getReconnectDelayMs(session.reconnectAttempts);
          await this.waitForReconnectDelay(session, delayMs);
          continue;
        }
        if (this.handleContractViolation(session, error)) {
          return;
        }
        if (!this.handleRealtimeStreamContractFailure(session, error)) {
          this.handleTransportFailure(session, error);
        }
      }

      if (session.closed) {
        return;
      }

      try {
        const terminal = await this.recoverCanonicalStatus(session);
        if (terminal || session.closed) {
          return;
        }
      } catch (error) {
        if (this.handleAuthRequired(session, error)) {
          session.reconnectAttempts += 1;
          const delayMs = this.getReconnectDelayMs(session.reconnectAttempts);
          await this.waitForReconnectDelay(session, delayMs);
          continue;
        }
        if (this.handleContractViolation(session, error)) {
          return;
        }
        this.handleTransportFailure(session, error);
        if (session.closed) {
          return;
        }
      }

      session.reconnectAttempts += 1;
      const delayMs = this.getReconnectDelayMs(session.reconnectAttempts);
      await this.waitForReconnectDelay(session, delayMs);
    }
  }

  private async consumeRealtimeStream(session: AcceptedUploadSession): Promise<void> {
    session.abortController = new AbortController();
    const response = await fetch(`${this.apiBaseUrl}${session.tracking.realtimePath}`, {
      method: 'GET',
      headers: this.headersProvider.getHeaders({ Accept: 'text/event-stream' }),
      signal: session.abortController.signal,
    });

    if (response.status === 401) {
      throw new UnauthorizedAuthError('Upload realtime stream returned unauthorized (401)');
    }

    if (!response.ok) {
      throw new Error(`Upload realtime stream failed: HTTP ${response.status}`);
    }

    if (!response.body) {
      throw new Error('Upload realtime stream returned no response body');
    }

    this.healthCheck?.reportSuccess();
    this.emitServiceStatusChanged();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (!session.closed) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let separatorIndex = buffer.indexOf('\n\n');
      while (separatorIndex >= 0 && !session.closed) {
        const frame = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        this.handleSseFrame(session, this.parseSseFrame(frame));
        separatorIndex = buffer.indexOf('\n\n');
      }
    }
  }

  private parseSseFrame(frame: string): SseFrame | null {
    if (!frame.trim()) {
      return null;
    }

    let event = 'message';
    const dataLines: string[] = [];

    for (const line of frame.split('\n')) {
      if (!line || line.startsWith(':')) {
        continue;
      }
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
        continue;
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart());
      }
    }

    if (dataLines.length === 0) {
      return null;
    }

    return { event, data: dataLines.join('\n') };
  }

  private handleSseFrame(session: AcceptedUploadSession, frame: SseFrame | null): void {
    if (!frame || frame.event === 'connected') {
      return;
    }
    if (frame.event !== 'upload_status') {
      return;
    }

    let payload: UploadRealtimeStatusEvent;
    try {
      payload = JSON.parse(frame.data) as UploadRealtimeStatusEvent;
    } catch {
      throw new RealtimeStreamContractError(
        'Backend contract violation: realtime upload status payload is not valid JSON'
      );
    }

    if (!isUploadAnalysisStatus(payload.analysisStatus)) {
      throw new RealtimeStreamContractError(
        `Backend contract violation: realtime upload status returned unknown lifecycle state "${String(payload.analysisStatus)}"`
      );
    }

    if (payload.jobId !== session.tracking.acceptedJobId) {
      throw new RealtimeStreamContractError(
        `Backend contract violation: realtime upload status jobId "${payload.jobId}" does not match tracked accepted upload "${session.tracking.acceptedJobId}"`
      );
    }

    this.handleCanonicalStatus(session, payload, 'realtime');
  }

  private async recoverCanonicalStatus(session: AcceptedUploadSession): Promise<boolean> {
    const status = await this.statusClient.getStatus(session.tracking);
    return this.handleCanonicalStatus(session, status, 'canonical');
  }

  private handleCanonicalStatus(
    session: AcceptedUploadSession,
    status: UploadStatusResponse,
    source: 'realtime' | 'canonical'
  ): boolean {
    if (status.jobId !== session.tracking.acceptedJobId) {
      const message = `Backend contract violation: upload status jobId "${status.jobId}" does not match tracked accepted upload "${session.tracking.acceptedJobId}"`;
      if (source === 'realtime') {
        throw new RealtimeStreamContractError(message);
      }
      this.emitFailure({
        jobId: session.tracking.acceptedJobId,
        matchHash: session.matchHash,
        error: message,
        errorCode: 'BACKEND_CONTRACT_VIOLATION',
        isPermanent: true,
      });
      return true;
    }

    if (source === 'realtime') {
      session.reconnectAttempts = 0;
    }

    switch (status.analysisStatus) {
      case 'completed': {
        if (
          status.analysisId !== null &&
          (!Array.isArray(status.analysisData) ||
            typeof status.uuid !== 'string' ||
            status.uuid.trim().length === 0)
        ) {
          const message =
            'Backend contract violation: completed upload returned malformed analysis identity or data';
          if (source === 'realtime') {
            throw new RealtimeStreamContractError(message);
          }
          this.emitFailure({
            jobId: session.tracking.acceptedJobId,
            matchHash: session.matchHash,
            error: message,
            errorCode: 'BACKEND_CONTRACT_VIOLATION',
            isPermanent: true,
          });
          return true;
        }

        const normalizedEvents = Array.isArray(status.analysisData)
          ? (status.analysisData as AnalysisPayload['events'])
          : undefined;

        const completedPayload: AnalysisCompletedData = {
          jobId: session.tracking.acceptedJobId,
          matchHash: session.matchHash,
          ...(status.analysisId != null && { analysisId: status.analysisId }),
          ...(status.analysisId != null && {
            analysisPayload: {
              uuid: status.uuid as string,
              ...(normalizedEvents && { events: normalizedEvents }),
            },
          }),
          entitlementMode: status.entitlementMode,
          freeQuotaLimit: status.freeQuotaLimit,
          freeQuotaUsed: status.freeQuotaUsed,
          freeQuotaRemaining: status.freeQuotaRemaining,
          freeQuotaExhausted: status.freeQuotaExhausted,
          ...(typeof status.isPremiumViewer === 'boolean' && {
            isPremiumViewer: status.isPremiumViewer,
          }),
          ...(status.premiumSources && { premiumSources: status.premiumSources }),
        };

        session.authRequiredEmitted = false;
        this.lastStatusObservedAt = Date.now();
        this.healthCheck?.reportSuccess();
        this.emitServiceStatusChanged();
        this.emit('analysisCompleted', completedPayload);
        this.stopTracking(session.tracking.acceptedJobId);
        return true;
      }
      case 'failed': {
        const failurePayload: AnalysisFailedData = {
          jobId: session.tracking.acceptedJobId,
          matchHash: session.matchHash,
          error:
            status.jobDetails?.output ||
            status.error?.message ||
            'Accepted upload failed during processing',
          isPermanent: status.isPermanent === true,
          ...(status.errorCode && { errorCode: status.errorCode }),
        };
        session.authRequiredEmitted = false;
        this.lastStatusObservedAt = Date.now();
        this.healthCheck?.reportSuccess();
        this.emitServiceStatusChanged();
        this.emitFailure(failurePayload);
        return true;
      }
      case 'not_found':
        session.authRequiredEmitted = false;
        this.lastStatusObservedAt = Date.now();
        this.healthCheck?.reportSuccess();
        this.emitServiceStatusChanged();
        this.emitFailure({
          jobId: session.tracking.acceptedJobId,
          matchHash: session.matchHash,
          error: 'Accepted upload record is missing on the server after acceptance',
          errorCode: 'JOB_NOT_FOUND',
          isPermanent: true,
          isNotFound: true,
        });
        return true;
      case 'queued':
      case 'processing':
        session.authRequiredEmitted = false;
        if (status.analysisStatus !== session.lastStatus) {
          session.lastStatus = status.analysisStatus;
          const progressPayload: AnalysisProgressData = {
            jobId: session.tracking.acceptedJobId,
            matchHash: session.matchHash,
            status: status.analysisStatus,
            message: this.getStatusMessage(status.analysisStatus),
          };
          this.emit('analysisProgress', progressPayload);
        }
        this.lastStatusObservedAt = Date.now();
        this.healthCheck?.reportSuccess();
        this.emitServiceStatusChanged();
        return false;
    }
  }

  private emitFailure(payload: AnalysisFailedData): void {
    this.emit('analysisFailed', payload);
    this.stopTracking(payload.jobId);
  }

  private handleTransportFailure(session: AcceptedUploadSession, error: unknown): void {
    if (session.closed) {
      return;
    }

    this.healthCheck?.reportFailure(true);
    const payload: UploadTransportErrorData = {
      jobId: session.tracking.acceptedJobId,
      matchHash: session.matchHash,
      error: error instanceof Error ? error.message : String(error),
    };
    this.emit('transportError', payload);
  }

  private handleAuthRequired(session: AcceptedUploadSession, error: unknown): boolean {
    if (!isUnauthorizedAuthError(error)) {
      return false;
    }

    if (!session.authRequiredEmitted) {
      const payload: UploadAuthRequiredData = {
        jobId: session.tracking.acceptedJobId,
        matchHash: session.matchHash,
        error: error.message,
      };
      this.emit('authRequired', payload);
      session.authRequiredEmitted = true;
    }

    return true;
  }

  private handleRealtimeStreamContractFailure(
    session: AcceptedUploadSession,
    error: unknown
  ): boolean {
    if (!(error instanceof RealtimeStreamContractError)) {
      return false;
    }

    console.warn('[AcceptedUploadTracker] Realtime contract anomaly; falling back to canonical status recovery', {
      jobId: session.tracking.acceptedJobId,
      matchHash: session.matchHash,
      error: error.message,
    });
    return true;
  }

  private handleContractViolation(session: AcceptedUploadSession, error: unknown): boolean {
    if (!isBackendContractViolationError(error)) {
      return false;
    }

    this.emitFailure({
      jobId: session.tracking.acceptedJobId,
      matchHash: session.matchHash,
      error: error.message,
      errorCode: 'BACKEND_CONTRACT_VIOLATION',
      isPermanent: true,
    });
    return true;
  }

  private getStatusMessage(status: UploadAnalysisStatus): string {
    switch (status) {
      case 'queued':
        return 'Queued for processing...';
      case 'processing':
        return 'Analyzing match data and generating insights...';
      case 'completed':
      case 'failed':
      case 'not_found':
        return `Status: ${status}`;
    }
  }

  private getReconnectDelayMs(reconnectAttempts: number): number {
    return Math.min(
      AcceptedUploadTracker.BASE_RECONNECT_DELAY_MS * 2 ** (reconnectAttempts - 1),
      AcceptedUploadTracker.MAX_RECONNECT_DELAY_MS
    );
  }

  private emitServiceStatusChanged(): void {
    this.emit('serviceStatusChanged', {
      trackingActive: this.sessions.size > 0,
      acceptedUploadsCount: this.sessions.size,
      lastStatusObservedAt: this.lastStatusObservedAt,
    } satisfies AcceptedUploadTrackerStatus);
  }

  private async waitForReconnectDelay(
    session: AcceptedUploadSession,
    delayMs: number
  ): Promise<void> {
    await new Promise<void>(resolve => {
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

      session.retryDelayResolve = finish;
      session.retryDelayTimer = setTimeout(finish, delayMs);
    });
  }
}
