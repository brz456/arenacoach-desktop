import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UploadLifecycleService } from '../../src/services/upload-lifecycle/UploadLifecycleService';
import type { UploadLifecycleRecord } from '../../src/services/upload-lifecycle/types';
import { MatchEventType } from '../../src/match-detection/types/MatchEvent';
import { UnauthorizedAuthError } from '../../src/services/upload-lifecycle/errors';
import { ExpirationConfig } from '../../src/config/ExpirationConfig';
import { PipelineErrorCode } from '../../src/match-detection/types/PipelineErrors';

class AcceptedUploadTrackerStub extends EventEmitter {
  trackAcceptedUpload = vi.fn();
  stopAll = vi.fn();
  getTrackedCount = vi.fn(() => 0);
}

describe('UploadLifecycleService recovery', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports explicit lifecycle counts instead of generic job state', async () => {
    const tracker = new AcceptedUploadTrackerStub();
    tracker.getTrackedCount.mockReturnValue(1);

    const lifecycleStore = {
      loadPendingUploads: vi.fn(async () => {
        const uploads = new Map<string, UploadLifecycleRecord>();
        uploads.set('local-accepted', {
          matchHash: 'accepted-match',
          createdAt: 1,
          acceptanceState: 'accepted',
          acceptedAt: 10,
          tracking: {
            acceptedJobId: 'accepted-job-id',
            statusPath: '/api/upload/job-status/accepted-job-id',
            realtimePath: '/api/realtime/uploads/accepted-job-id',
          },
        });
        uploads.set('local-pending', {
          matchHash: 'pending-match',
          bufferId: 'buffer-1',
          createdAt: 2,
          acceptanceState: 'local_pending',
        });
        return uploads;
      }),
      savePendingUploads: vi.fn(async () => undefined),
    };

    const service = new UploadLifecycleService(
      { uploadChunk: vi.fn() } as any,
      tracker as any,
      lifecycleStore as any,
      { hasAuth: () => true } as any,
      { recoverPendingUpload: vi.fn() } as any
    );

    await service.initialize();

    expect(service.getStatus()).toEqual({
      initialized: true,
      activeUploads: 2,
      localPendingUploads: 1,
      acceptedUploads: 1,
      activeUploadAttempts: 0,
      hasAuth: true,
    });
  });

  it('resumes accepted uploads via tracker and local-pending uploads via upload retry', async () => {
    const tracker = new AcceptedUploadTrackerStub();
    const lifecycleStore = {
      loadPendingUploads: vi.fn(async () => {
        const uploads = new Map<string, UploadLifecycleRecord>();
        uploads.set('local-accepted', {
          matchHash: 'accepted-match',
          createdAt: 1,
          acceptanceState: 'accepted',
          acceptedAt: 10,
          tracking: {
            acceptedJobId: 'accepted-job-id',
            statusPath: '/api/upload/job-status/accepted-job-id',
            realtimePath: '/api/realtime/uploads/accepted-job-id',
          },
        });
        uploads.set('local-pending', {
          matchHash: 'pending-match',
          bufferId: 'buffer-1',
          createdAt: 2,
          acceptanceState: 'local_pending',
        });
        return uploads;
      }),
      savePendingUploads: vi.fn(async () => undefined),
    };
    const uploadChunk = vi.fn(async () => ({
      tracking: {
        acceptedJobId: 'local-pending',
        statusPath: '/api/upload/job-status/local-pending',
        realtimePath: '/api/realtime/uploads/local-pending',
      },
    }));
    const recoverPendingUpload = vi.fn(async () => ({
      chunkFilePath: '/tmp/buffer-1.txt',
      matchHash: 'pending-match',
      matchEvent: {
        type: MatchEventType.MATCH_ENDED,
        timestamp: new Date('2026-04-10T00:00:00.000Z'),
        bufferId: 'buffer-1',
        metadata: {
          timestamp: new Date('2026-04-10T00:00:00.000Z'),
          mapId: 1,
          bracket: 'Solo Shuffle',
          season: 1,
          isRanked: true,
          players: [],
        },
      },
    }));

    const service = new UploadLifecycleService(
      { uploadChunk } as any,
      tracker as any,
      lifecycleStore as any,
      { hasAuth: () => true } as any,
      { recoverPendingUpload } as any
    );

    await service.initialize();
    await service.resumePendingUploads();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(tracker.trackAcceptedUpload).toHaveBeenCalledWith(
      {
        acceptedJobId: 'accepted-job-id',
        statusPath: '/api/upload/job-status/accepted-job-id',
        realtimePath: '/api/realtime/uploads/accepted-job-id',
      },
      'accepted-match'
    );
    expect(uploadChunk).toHaveBeenCalledWith(
      '/tmp/buffer-1.txt',
      expect.objectContaining({
        bufferId: 'buffer-1',
      }),
      'pending-match',
      'local-pending',
      expect.any(AbortSignal)
    );
    expect(tracker.trackAcceptedUpload).toHaveBeenCalledWith(
      {
        acceptedJobId: 'local-pending',
        statusPath: '/api/upload/job-status/local-pending',
        realtimePath: '/api/realtime/uploads/local-pending',
      },
      'pending-match'
    );
  });

  it('surfaces non-retryable resumed upload failures as upload rejected', async () => {
    const tracker = new AcceptedUploadTrackerStub();
    const lifecycleStore = {
      loadPendingUploads: vi.fn(async () => {
        const uploads = new Map<string, UploadLifecycleRecord>();
        uploads.set('local-pending', {
          matchHash: 'pending-match',
          bufferId: 'buffer-1',
          createdAt: 2,
          acceptanceState: 'local_pending',
        });
        return uploads;
      }),
      savePendingUploads: vi.fn(async () => undefined),
    };
    const uploadChunk = vi.fn(async () => {
      throw new Error('Upload rejected by server');
    });
    const recoverPendingUpload = vi.fn(async () => ({
      chunkFilePath: '/tmp/buffer-1.txt',
      matchHash: 'pending-match',
      matchEvent: {
        type: MatchEventType.MATCH_ENDED,
        timestamp: new Date('2026-04-10T00:00:00.000Z'),
        bufferId: 'buffer-1',
        metadata: {
          timestamp: new Date('2026-04-10T00:00:00.000Z'),
          mapId: 1,
          bracket: 'Solo Shuffle',
          season: 1,
          isRanked: true,
          players: [],
        },
      },
    }));

    const service = new UploadLifecycleService(
      { uploadChunk } as any,
      tracker as any,
      lifecycleStore as any,
      { hasAuth: () => true } as any,
      { recoverPendingUpload } as any
    );
    const analysisFailed = vi.fn();
    service.on('analysisFailed', analysisFailed);

    await service.initialize();
    await service.resumePendingUploads();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(analysisFailed).toHaveBeenCalledWith({
      jobId: 'local-pending',
      matchHash: 'pending-match',
      error: 'Upload rejected by server',
      errorCode: 'UPLOAD_REJECTED',
      isPermanent: true,
    });
  });

  it('marks resumed local-pending uploads as expired once they cross the expiration boundary', async () => {
    const tracker = new AcceptedUploadTrackerStub();
    const lifecycleStore = {
      loadPendingUploads: vi.fn(async () => {
        const uploads = new Map<string, UploadLifecycleRecord>();
        uploads.set('local-pending', {
          matchHash: 'pending-match',
          bufferId: 'buffer-1',
          createdAt: 2,
          acceptanceState: 'local_pending',
        });
        return uploads;
      }),
      savePendingUploads: vi.fn(async () => undefined),
    };
    const uploadChunk = vi.fn(async () => {
      throw new Error('temporary network error');
    });
    const recoverPendingUpload = vi.fn(async () => ({
      chunkFilePath: '/tmp/buffer-1.txt',
      matchHash: 'pending-match',
      matchEvent: {
        type: MatchEventType.MATCH_ENDED,
        timestamp: new Date('2026-04-10T00:00:00.000Z'),
        bufferId: 'buffer-1',
        metadata: {
          timestamp: new Date('2026-04-10T00:00:00.000Z'),
          mapId: 1,
          bracket: 'Solo Shuffle',
          season: 1,
          isRanked: true,
          players: [],
        },
      },
    }));

    const isExpiredSpy = vi
      .spyOn(ExpirationConfig, 'isExpired')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const getAgeInHoursSpy = vi
      .spyOn(ExpirationConfig, 'getAgeInHours')
      .mockReturnValue(1.1);

    const service = new UploadLifecycleService(
      { uploadChunk } as any,
      tracker as any,
      lifecycleStore as any,
      { hasAuth: () => true } as any,
      { recoverPendingUpload } as any
    );
    const analysisFailed = vi.fn();
    service.on('analysisFailed', analysisFailed);

    await service.initialize();
    await service.resumePendingUploads();
    await new Promise(resolve => setTimeout(resolve, 1100));

    expect(isExpiredSpy).toHaveBeenCalled();
    expect(analysisFailed).toHaveBeenCalledWith({
      jobId: 'local-pending',
      matchHash: 'pending-match',
      error: 'Combat log expired (1.1 hours old)',
      errorCode: PipelineErrorCode.COMBAT_LOG_EXPIRED,
      isPermanent: true,
    });
    expect(getAgeInHoursSpy).toHaveBeenCalled();
    expect(service.getStatus()).toMatchObject({
      activeUploads: 0,
      localPendingUploads: 0,
      acceptedUploads: 0,
    });
  });

  it('emits authRequired instead of terminal failure when resumed local upload gets 401', async () => {
    const tracker = new AcceptedUploadTrackerStub();
    const lifecycleStore = {
      loadPendingUploads: vi.fn(async () => {
        const uploads = new Map<string, UploadLifecycleRecord>();
        uploads.set('local-pending', {
          matchHash: 'pending-match',
          bufferId: 'buffer-1',
          createdAt: 2,
          acceptanceState: 'local_pending',
        });
        return uploads;
      }),
      savePendingUploads: vi.fn(async () => undefined),
    };
    const uploadChunk = vi.fn(async () => {
      throw new UnauthorizedAuthError('Upload request returned unauthorized (401)');
    });
    const recoverPendingUpload = vi.fn(async () => ({
      chunkFilePath: '/tmp/buffer-1.txt',
      matchHash: 'pending-match',
      matchEvent: {
        type: MatchEventType.MATCH_ENDED,
        timestamp: new Date('2026-04-10T00:00:00.000Z'),
        bufferId: 'buffer-1',
        metadata: {
          timestamp: new Date('2026-04-10T00:00:00.000Z'),
          mapId: 1,
          bracket: 'Solo Shuffle',
          season: 1,
          isRanked: true,
          players: [],
        },
      },
    }));

    const service = new UploadLifecycleService(
      { uploadChunk } as any,
      tracker as any,
      lifecycleStore as any,
      { hasAuth: () => true } as any,
      { recoverPendingUpload } as any
    );
    const authRequired = vi.fn();
    const analysisFailed = vi.fn();
    service.on('authRequired', authRequired);
    service.on('analysisFailed', analysisFailed);

    await service.initialize();
    await service.resumePendingUploads();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(authRequired).toHaveBeenCalledWith({
      jobId: 'local-pending',
      matchHash: 'pending-match',
      error: 'Upload request returned unauthorized (401)',
    });
    expect(authRequired).toHaveBeenCalledTimes(1);
    expect(analysisFailed).not.toHaveBeenCalled();
    expect(service.getStatus()).toMatchObject({
      localPendingUploads: 1,
      acceptedUploads: 0,
    });
  });

  it('does not create accepted state after cleanup begins during an in-flight upload', async () => {
    const tracker = new AcceptedUploadTrackerStub();
    const lifecycleStore = {
      loadPendingUploads: vi.fn(async () => new Map<string, UploadLifecycleRecord>()),
      savePendingUploads: vi.fn(async () => undefined),
    };

    let resolveUpload:
      | ((value: {
          tracking: {
            acceptedJobId: string;
            statusPath: string;
            realtimePath: string;
          };
        }) => void)
      | undefined;
    const uploadChunk = vi.fn(
      () =>
        new Promise<{
          tracking: {
            acceptedJobId: string;
            statusPath: string;
            realtimePath: string;
          };
        }>(resolve => {
          resolveUpload = resolve;
        })
    );

    const service = new UploadLifecycleService(
      { uploadChunk } as any,
      tracker as any,
      lifecycleStore as any,
      { hasAuth: () => true } as any,
      { recoverPendingUpload: vi.fn() } as any
    );
    const analysisJobCreated = vi.fn();
    service.on('analysisJobCreated', analysisJobCreated);

    await service.initialize();
    const submitPromise = service.submitMatchChunk(
      '/tmp/chunk.txt',
      {
        type: MatchEventType.MATCH_ENDED,
        timestamp: new Date('2026-04-10T00:00:00.000Z'),
        bufferId: 'buffer-1',
        metadata: {
          timestamp: new Date('2026-04-10T00:00:00.000Z'),
          mapId: 1,
          bracket: 'Solo Shuffle',
          season: 1,
          isRanked: true,
          players: [],
        },
      },
      'match-hash-cleanup'
    );

    await Promise.resolve();
    const cleanupPromise = service.cleanup();
    resolveUpload?.({
      tracking: {
        acceptedJobId: 'accepted-after-cleanup',
        statusPath: '/api/upload/job-status/accepted-after-cleanup',
        realtimePath: '/api/realtime/uploads/accepted-after-cleanup',
      },
    });

    await cleanupPromise;
    await expect(submitPromise).rejects.toThrow('UploadLifecycleService is shutting down');
    expect(tracker.trackAcceptedUpload).not.toHaveBeenCalled();
    expect(analysisJobCreated).not.toHaveBeenCalled();
  });

  it('surfaces unexpected background resume failures without deleting pending retry state', async () => {
    const tracker = new AcceptedUploadTrackerStub();
    const lifecycleStore = {
      loadPendingUploads: vi.fn(async () => {
        const uploads = new Map<string, UploadLifecycleRecord>();
        uploads.set('local-pending', {
          matchHash: 'pending-match',
          bufferId: 'buffer-1',
          createdAt: 2,
          acceptanceState: 'local_pending',
        });
        return uploads;
      }),
      savePendingUploads: vi.fn(async () => undefined),
    };
    const service = new UploadLifecycleService(
      { uploadChunk: vi.fn() } as any,
      tracker as any,
      lifecycleStore as any,
      { hasAuth: () => true } as any,
      {
        recoverPendingUpload: vi.fn(async () => {
          throw new Error('Recovery storage failed');
        }),
      } as any
    );
    const transportError = vi.fn();
    service.on('transportError', transportError);

    await service.initialize();
    await service.resumePendingUploads();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(transportError).toHaveBeenCalledWith({
      jobId: 'local-pending',
      matchHash: 'pending-match',
      error: 'Recovery storage failed',
    });
    expect(service.getStatus()).toMatchObject({
      activeUploads: 1,
      localPendingUploads: 1,
      acceptedUploads: 0,
    });
  });

  it('waits for accepted-state persistence before starting accepted tracking', async () => {
    vi.useFakeTimers();
    const tracker = new AcceptedUploadTrackerStub();
    const lifecycleStore = {
      loadPendingUploads: vi.fn(async () => new Map<string, UploadLifecycleRecord>()),
      savePendingUploads: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Disk full after acceptance'))
        .mockResolvedValueOnce(undefined),
    };
    const uploadChunk = vi.fn(async () => ({
      tracking: {
        acceptedJobId: 'accepted-job-persist-failure',
        statusPath: '/api/upload/job-status/accepted-job-persist-failure',
        realtimePath: '/api/realtime/uploads/accepted-job-persist-failure',
      },
    }));

    const service = new UploadLifecycleService(
      { uploadChunk } as any,
      tracker as any,
      lifecycleStore as any,
      { hasAuth: () => true } as any,
      { recoverPendingUpload: vi.fn() } as any
    );
    const analysisJobCreated = vi.fn();
    service.on('analysisJobCreated', analysisJobCreated);

    await service.initialize();
    const submitPromise = service.submitMatchChunk(
      '/tmp/chunk.txt',
      {
        type: MatchEventType.MATCH_ENDED,
        timestamp: new Date('2026-04-10T00:00:00.000Z'),
        bufferId: 'buffer-persist-failure',
        metadata: {
          timestamp: new Date('2026-04-10T00:00:00.000Z'),
          mapId: 1,
          bracket: 'Solo Shuffle',
          season: 1,
          isRanked: true,
          players: [],
        },
      },
      'match-hash-persist-failure'
    );

    await Promise.resolve();
    expect(tracker.trackAcceptedUpload).not.toHaveBeenCalled();
    expect(analysisJobCreated).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    const acceptedJobId = await submitPromise;

    expect(acceptedJobId).toBe('accepted-job-persist-failure');
    expect(tracker.trackAcceptedUpload).toHaveBeenCalledWith(
      {
        acceptedJobId: 'accepted-job-persist-failure',
        statusPath: '/api/upload/job-status/accepted-job-persist-failure',
        realtimePath: '/api/realtime/uploads/accepted-job-persist-failure',
      },
      'match-hash-persist-failure'
    );
    expect(analysisJobCreated).toHaveBeenCalledWith({
      matchHash: 'match-hash-persist-failure',
      jobId: 'accepted-job-persist-failure',
      status: 'queued',
    });
    expect(service.getStatus()).toMatchObject({
      activeUploads: 1,
      acceptedUploads: 1,
      localPendingUploads: 0,
    });
  });

  it('waits for accepted-record cleanup persistence before emitting terminal completion', async () => {
    vi.useFakeTimers();
    const tracker = new AcceptedUploadTrackerStub();
    const lifecycleStore = {
      loadPendingUploads: vi.fn(async () => {
        const uploads = new Map<string, UploadLifecycleRecord>();
        uploads.set('local-accepted', {
          matchHash: 'accepted-match',
          createdAt: 1,
          acceptanceState: 'accepted',
          acceptedAt: 10,
          tracking: {
            acceptedJobId: 'accepted-job-id',
            statusPath: '/api/upload/job-status/accepted-job-id',
            realtimePath: '/api/realtime/uploads/accepted-job-id',
          },
        });
        return uploads;
      }),
      savePendingUploads: vi
        .fn()
        .mockRejectedValueOnce(new Error('Failed to persist accepted cleanup'))
        .mockResolvedValueOnce(undefined),
    };

    const service = new UploadLifecycleService(
      { uploadChunk: vi.fn() } as any,
      tracker as any,
      lifecycleStore as any,
      { hasAuth: () => true } as any,
      { recoverPendingUpload: vi.fn() } as any
    );
    const analysisCompleted = vi.fn();
    service.on('analysisCompleted', analysisCompleted);

    await service.initialize();
    tracker.emit('analysisCompleted', {
      jobId: 'accepted-job-id',
      matchHash: 'accepted-match',
      analysisId: 42,
    });
    await Promise.resolve();

    expect(analysisCompleted).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();

    expect(analysisCompleted).toHaveBeenCalledWith({
      jobId: 'accepted-job-id',
      matchHash: 'accepted-match',
      analysisId: 42,
    });
    expect(service.getStatus()).toMatchObject({
      activeUploads: 0,
      acceptedUploads: 0,
    });
  });
});
