import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiHeadersProvider } from '../../src/services/ApiHeadersProvider';
import {
  BackendContractViolationError,
} from '../../src/services/upload-lifecycle/errors';
import { AcceptedUploadTracker } from '../../src/services/upload-lifecycle/AcceptedUploadTracker';

describe('AcceptedUploadTracker', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('treats not_found from the accepted-upload stream as a terminal anomaly', async () => {
    const encoder = new TextEncoder();
    global.fetch = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `event: upload_status\ndata: ${JSON.stringify({
                type: 'upload_status',
                occurredAt: '2026-04-10T00:00:00.000Z',
                success: true,
                jobId: 'accepted-job-1',
                analysisStatus: 'not_found',
                analysisId: null,
                uuid: null,
                hasData: false,
                errorCode: 'JOB_NOT_FOUND',
                isPermanent: true,
                timestamp: '2026-04-10T00:00:00.000Z',
              })}\n\n`
            )
          );
          controller.close();
        },
      });

      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof fetch;

    const tracker = new AcceptedUploadTracker(
      'http://localhost:3000',
      new ApiHeadersProvider(),
      { getStatus: vi.fn() } as any
    );

    const failurePromise = new Promise<any>(resolve => {
      tracker.once('analysisFailed', resolve);
    });

    tracker.trackAcceptedUpload(
      {
        acceptedJobId: 'accepted-job-1',
        statusPath: '/api/upload/job-status/accepted-job-1',
        realtimePath: '/api/realtime/uploads/accepted-job-1',
      },
      'match-hash-1'
    );

    await expect(failurePromise).resolves.toMatchObject({
      jobId: 'accepted-job-1',
      matchHash: 'match-hash-1',
      errorCode: 'JOB_NOT_FOUND',
      isPermanent: true,
      isNotFound: true,
      error: 'Accepted upload record is missing on the server after acceptance',
    });
    expect(tracker.getTrackedCount()).toBe(0);
  });

  it('recovers after a transient fallback-status failure instead of abandoning the session', async () => {
    vi.useFakeTimers();
    const fetchCalls: number[] = [];
    global.fetch = vi.fn(async () => {
      fetchCalls.push(fetchCalls.length + 1);
      throw new Error('stream disconnected');
    }) as typeof fetch;

    const getStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary 503'))
      .mockResolvedValueOnce({
        success: true,
        jobId: 'accepted-job-2',
        analysisStatus: 'completed',
        analysisId: 42,
        uuid: 'uuid-42',
        hasData: true,
        analysisData: [],
        entitlementMode: 'none',
        freeQuotaLimit: null,
        freeQuotaUsed: null,
        freeQuotaRemaining: null,
        freeQuotaExhausted: false,
        timestamp: '2026-04-10T00:00:01.000Z',
      });

    const tracker = new AcceptedUploadTracker(
      'http://localhost:3000',
      new ApiHeadersProvider(),
      { getStatus } as any
    );

    const completedPromise = new Promise<any>(resolve => {
      tracker.once('analysisCompleted', resolve);
    });

    tracker.trackAcceptedUpload(
      {
        acceptedJobId: 'accepted-job-2',
        statusPath: '/api/upload/job-status/accepted-job-2',
        realtimePath: '/api/realtime/uploads/accepted-job-2',
      },
      'match-hash-2'
    );

    await vi.runOnlyPendingTimersAsync();
    await vi.runOnlyPendingTimersAsync();

    await expect(completedPromise).resolves.toMatchObject({
      jobId: 'accepted-job-2',
      matchHash: 'match-hash-2',
      analysisId: 42,
    });
    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(fetchCalls.length).toBeGreaterThanOrEqual(2);
    expect(tracker.getTrackedCount()).toBe(0);
  });

  it('emits authRequired instead of transportError when realtime bootstrap returns 401', async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn(async () => new Response(null, { status: 401 })) as typeof fetch;

    const tracker = new AcceptedUploadTracker(
      'http://localhost:3000',
      new ApiHeadersProvider('expired-token'),
      { getStatus: vi.fn() } as any
    );
    const authRequired = vi.fn();
    const transportError = vi.fn();
    tracker.on('authRequired', authRequired);
    tracker.on('transportError', transportError);

    tracker.trackAcceptedUpload(
      {
        acceptedJobId: 'accepted-job-auth',
        statusPath: '/api/upload/job-status/accepted-job-auth',
        realtimePath: '/api/realtime/uploads/accepted-job-auth',
      },
      'match-hash-auth'
    );

    await vi.advanceTimersByTimeAsync(0);

    expect(authRequired).toHaveBeenCalledWith({
      jobId: 'accepted-job-auth',
      matchHash: 'match-hash-auth',
      error: 'Upload realtime stream returned unauthorized (401)',
    });
    expect(transportError).not.toHaveBeenCalled();
  });

  it('increases reconnect delay when realtime keeps failing but canonical recovery succeeds', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    global.fetch = vi.fn(async () => {
      throw new Error('stream disconnected');
    }) as typeof fetch;

    const getStatus = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        jobId: 'accepted-job-backoff',
        analysisStatus: 'processing',
        analysisId: null,
        uuid: null,
        hasData: false,
        entitlementMode: 'none',
        freeQuotaLimit: null,
        freeQuotaUsed: null,
        freeQuotaRemaining: null,
        freeQuotaExhausted: false,
        timestamp: '2026-04-10T00:00:01.000Z',
      })
      .mockResolvedValueOnce({
        success: true,
        jobId: 'accepted-job-backoff',
        analysisStatus: 'processing',
        analysisId: null,
        uuid: null,
        hasData: false,
        entitlementMode: 'none',
        freeQuotaLimit: null,
        freeQuotaUsed: null,
        freeQuotaRemaining: null,
        freeQuotaExhausted: false,
        timestamp: '2026-04-10T00:00:02.000Z',
      })
      .mockResolvedValueOnce({
        success: true,
        jobId: 'accepted-job-backoff',
        analysisStatus: 'completed',
        analysisId: 99,
        uuid: 'uuid-99',
        hasData: true,
        analysisData: [],
        entitlementMode: 'none',
        freeQuotaLimit: null,
        freeQuotaUsed: null,
        freeQuotaRemaining: null,
        freeQuotaExhausted: false,
        timestamp: '2026-04-10T00:00:03.000Z',
      });

    const tracker = new AcceptedUploadTracker(
      'http://localhost:3000',
      new ApiHeadersProvider(),
      { getStatus } as any
    );

    const completedPromise = new Promise<any>(resolve => {
      tracker.once('analysisCompleted', resolve);
    });

    tracker.trackAcceptedUpload(
      {
        acceptedJobId: 'accepted-job-backoff',
        statusPath: '/api/upload/job-status/accepted-job-backoff',
        realtimePath: '/api/realtime/uploads/accepted-job-backoff',
      },
      'match-hash-backoff'
    );

    await vi.runOnlyPendingTimersAsync();
    await vi.runOnlyPendingTimersAsync();

    await expect(completedPromise).resolves.toMatchObject({
      jobId: 'accepted-job-backoff',
      matchHash: 'match-hash-backoff',
      analysisId: 99,
    });

    const reconnectDelays = setTimeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((delay): delay is number => typeof delay === 'number' && delay > 0);

    expect(reconnectDelays).toEqual(expect.arrayContaining([1000, 2000]));
    expect(getStatus).toHaveBeenCalledTimes(3);
  });

  it('falls back to canonical status when realtime returns an unknown lifecycle state', async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    global.fetch = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `event: upload_status\ndata: ${JSON.stringify({
                type: 'upload_status',
                occurredAt: '2026-04-10T00:00:00.000Z',
                success: true,
                jobId: 'accepted-job-3',
                analysisStatus: 'mystery_state',
                analysisId: null,
                uuid: null,
                hasData: false,
                timestamp: '2026-04-10T00:00:00.000Z',
              })}\n\n`
            )
          );
          controller.close();
        },
      });

      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof fetch;

    const tracker = new AcceptedUploadTracker(
      'http://localhost:3000',
      new ApiHeadersProvider(),
      {
        getStatus: vi.fn().mockResolvedValueOnce({
          success: true,
          jobId: 'accepted-job-3',
          analysisStatus: 'completed',
          analysisId: 43,
          uuid: 'uuid-43',
          hasData: true,
          analysisData: [],
          entitlementMode: 'none',
          freeQuotaLimit: null,
          freeQuotaUsed: null,
          freeQuotaRemaining: null,
          freeQuotaExhausted: false,
          timestamp: '2026-04-10T00:00:01.000Z',
        }),
      } as any
    );

    const completedPromise = new Promise<any>(resolve => {
      tracker.once('analysisCompleted', resolve);
    });
    const transportError = vi.fn();
    tracker.on('transportError', transportError);

    tracker.trackAcceptedUpload(
      {
        acceptedJobId: 'accepted-job-3',
        statusPath: '/api/upload/job-status/accepted-job-3',
        realtimePath: '/api/realtime/uploads/accepted-job-3',
      },
      'match-hash-3'
    );

    await vi.runOnlyPendingTimersAsync();

    await expect(completedPromise).resolves.toMatchObject({
      jobId: 'accepted-job-3',
      matchHash: 'match-hash-3',
      analysisId: 43,
    });
    expect(transportError).not.toHaveBeenCalled();
    expect(tracker.getTrackedCount()).toBe(0);
  });

  it('falls back to canonical status when realtime payload jobId does not match the tracked accepted upload', async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    global.fetch = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `event: upload_status\ndata: ${JSON.stringify({
                type: 'upload_status',
                occurredAt: '2026-04-10T00:00:00.000Z',
                success: true,
                jobId: 'foreign-job-id',
                analysisStatus: 'processing',
                analysisId: null,
                uuid: null,
                hasData: false,
                timestamp: '2026-04-10T00:00:00.000Z',
              })}\n\n`
            )
          );
          controller.close();
        },
      });

      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof fetch;

    const tracker = new AcceptedUploadTracker(
      'http://localhost:3000',
      new ApiHeadersProvider(),
      {
        getStatus: vi.fn().mockResolvedValueOnce({
          success: true,
          jobId: 'accepted-job-4',
          analysisStatus: 'completed',
          analysisId: 44,
          uuid: 'uuid-44',
          hasData: true,
          analysisData: [],
          entitlementMode: 'none',
          freeQuotaLimit: null,
          freeQuotaUsed: null,
          freeQuotaRemaining: null,
          freeQuotaExhausted: false,
          timestamp: '2026-04-10T00:00:01.000Z',
        }),
      } as any
    );

    const completedPromise = new Promise<any>(resolve => {
      tracker.once('analysisCompleted', resolve);
    });
    const transportError = vi.fn();
    tracker.on('transportError', transportError);

    tracker.trackAcceptedUpload(
      {
        acceptedJobId: 'accepted-job-4',
        statusPath: '/api/upload/job-status/accepted-job-4',
        realtimePath: '/api/realtime/uploads/accepted-job-4',
      },
      'match-hash-4'
    );

    await vi.runOnlyPendingTimersAsync();

    await expect(completedPromise).resolves.toMatchObject({
      jobId: 'accepted-job-4',
      matchHash: 'match-hash-4',
      analysisId: 44,
    });
    expect(transportError).not.toHaveBeenCalled();
    expect(tracker.getTrackedCount()).toBe(0);
  });

  it('falls back to canonical status when realtime payload JSON is malformed', async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    global.fetch = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('event: upload_status\ndata: {"broken"\n\n'));
          controller.close();
        },
      });

      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof fetch;

    const tracker = new AcceptedUploadTracker(
      'http://localhost:3000',
      new ApiHeadersProvider(),
      {
        getStatus: vi.fn().mockResolvedValueOnce({
          success: true,
          jobId: 'accepted-job-5',
          analysisStatus: 'completed',
          analysisId: 45,
          uuid: 'uuid-45',
          hasData: true,
          analysisData: [],
          entitlementMode: 'none',
          freeQuotaLimit: null,
          freeQuotaUsed: null,
          freeQuotaRemaining: null,
          freeQuotaExhausted: false,
          timestamp: '2026-04-10T00:00:01.000Z',
        }),
      } as any
    );

    const completedPromise = new Promise<any>(resolve => {
      tracker.once('analysisCompleted', resolve);
    });
    const transportError = vi.fn();
    tracker.on('transportError', transportError);

    tracker.trackAcceptedUpload(
      {
        acceptedJobId: 'accepted-job-5',
        statusPath: '/api/upload/job-status/accepted-job-5',
        realtimePath: '/api/realtime/uploads/accepted-job-5',
      },
      'match-hash-5'
    );

    await vi.runOnlyPendingTimersAsync();

    await expect(completedPromise).resolves.toMatchObject({
      jobId: 'accepted-job-5',
      matchHash: 'match-hash-5',
      analysisId: 45,
    });
    expect(transportError).not.toHaveBeenCalled();
    expect(tracker.getTrackedCount()).toBe(0);
  });

  it('fails explicitly when recovery returns a contract violation instead of retrying forever', async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn(async () => {
      throw new Error('stream disconnected');
    }) as typeof fetch;

    const getStatus = vi
      .fn()
      .mockRejectedValueOnce(
        new BackendContractViolationError(
          'Backend contract violation: upload status returned unknown lifecycle state "mystery_state"'
        )
      );

    const tracker = new AcceptedUploadTracker(
      'http://localhost:3000',
      new ApiHeadersProvider(),
      { getStatus } as any
    );

    const failurePromise = new Promise<any>(resolve => {
      tracker.once('analysisFailed', resolve);
    });

    tracker.trackAcceptedUpload(
      {
        acceptedJobId: 'accepted-job-6',
        statusPath: '/api/upload/job-status/accepted-job-6',
        realtimePath: '/api/realtime/uploads/accepted-job-6',
      },
      'match-hash-6'
    );

    await vi.runOnlyPendingTimersAsync();

    await expect(failurePromise).resolves.toMatchObject({
      jobId: 'accepted-job-6',
      matchHash: 'match-hash-6',
      errorCode: 'BACKEND_CONTRACT_VIOLATION',
      isPermanent: true,
    });
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(tracker.getTrackedCount()).toBe(0);
  });

  it('fails explicitly when completed payload is missing a UUID', async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn(async () => {
      throw new Error('stream disconnected');
    }) as typeof fetch;

    const getStatus = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        jobId: 'accepted-job-7',
        analysisStatus: 'completed',
        analysisId: 77,
        uuid: null,
        hasData: true,
        analysisData: [],
        entitlementMode: 'none',
        freeQuotaLimit: null,
        freeQuotaUsed: null,
        freeQuotaRemaining: null,
        freeQuotaExhausted: false,
        timestamp: '2026-04-10T00:00:01.000Z',
      });

    const tracker = new AcceptedUploadTracker(
      'http://localhost:3000',
      new ApiHeadersProvider(),
      { getStatus } as any
    );

    const failurePromise = new Promise<any>(resolve => {
      tracker.once('analysisFailed', resolve);
    });

    tracker.trackAcceptedUpload(
      {
        acceptedJobId: 'accepted-job-7',
        statusPath: '/api/upload/job-status/accepted-job-7',
        realtimePath: '/api/realtime/uploads/accepted-job-7',
      },
      'match-hash-7'
    );

    await expect(failurePromise).resolves.toMatchObject({
      jobId: 'accepted-job-7',
      matchHash: 'match-hash-7',
      errorCode: 'BACKEND_CONTRACT_VIOLATION',
      isPermanent: true,
    });
    expect(tracker.getTrackedCount()).toBe(0);
  });

  it('parses SSE frames correctly when CRLF delimiters are split across stream chunks', async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    global.fetch = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `event: upload_status\r\ndata: ${JSON.stringify({
                type: 'upload_status',
                occurredAt: '2026-04-10T00:00:00.000Z',
                success: true,
                jobId: 'accepted-job-8',
                analysisStatus: 'processing',
                analysisId: null,
                uuid: null,
                hasData: false,
                timestamp: '2026-04-10T00:00:00.000Z',
              })}\r`
            )
          );
          controller.enqueue(
            encoder.encode(
              `\n\r\nevent: upload_status\r\ndata: ${JSON.stringify({
                type: 'upload_status',
                occurredAt: '2026-04-10T00:00:01.000Z',
                success: true,
                jobId: 'accepted-job-8',
                analysisStatus: 'completed',
                analysisId: 48,
                uuid: 'uuid-48',
                hasData: true,
                analysisData: [],
                entitlementMode: 'none',
                freeQuotaLimit: null,
                freeQuotaUsed: null,
                freeQuotaRemaining: null,
                freeQuotaExhausted: false,
                timestamp: '2026-04-10T00:00:01.000Z',
              })}\r\n\r\n`
            )
          );
          controller.close();
        },
      });

      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof fetch;

    const tracker = new AcceptedUploadTracker(
      'http://localhost:3000',
      new ApiHeadersProvider(),
      { getStatus: vi.fn() } as any
    );

    const progressPromise = new Promise<any>(resolve => {
      tracker.once('analysisProgress', resolve);
    });
    const completedPromise = new Promise<any>(resolve => {
      tracker.once('analysisCompleted', resolve);
    });

    tracker.trackAcceptedUpload(
      {
        acceptedJobId: 'accepted-job-8',
        statusPath: '/api/upload/job-status/accepted-job-8',
        realtimePath: '/api/realtime/uploads/accepted-job-8',
      },
      'match-hash-8'
    );

    await expect(progressPromise).resolves.toMatchObject({
      jobId: 'accepted-job-8',
      matchHash: 'match-hash-8',
      status: 'processing',
    });
    await expect(completedPromise).resolves.toMatchObject({
      jobId: 'accepted-job-8',
      matchHash: 'match-hash-8',
      analysisId: 48,
    });
    expect(tracker.getTrackedCount()).toBe(0);
  });

  it('fails explicitly when duplicate accepted upload registration conflicts with existing identity', async () => {
    global.fetch = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start() {
          // Keep stream open; this test exercises registration invariants only.
        },
      });

      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof fetch;

    const tracker = new AcceptedUploadTracker(
      'http://localhost:3000',
      new ApiHeadersProvider(),
      { getStatus: vi.fn() } as any
    );

    const failurePromise = new Promise<any>(resolve => {
      tracker.once('analysisFailed', resolve);
    });

    tracker.trackAcceptedUpload(
      {
        acceptedJobId: 'accepted-job-9',
        statusPath: '/api/upload/job-status/accepted-job-9',
        realtimePath: '/api/realtime/uploads/accepted-job-9',
      },
      'match-hash-9'
    );

    tracker.trackAcceptedUpload(
      {
        acceptedJobId: 'accepted-job-9',
        statusPath: '/api/upload/job-status/accepted-job-9-conflict',
        realtimePath: '/api/realtime/uploads/accepted-job-9-conflict',
      },
      'match-hash-9-conflict'
    );

    await expect(failurePromise).resolves.toMatchObject({
      jobId: 'accepted-job-9',
      matchHash: 'match-hash-9',
      errorCode: 'BACKEND_CONTRACT_VIOLATION',
      isPermanent: true,
    });
    expect(tracker.getTrackedCount()).toBe(0);
  });
});
