import { describe, expect, it } from 'vitest';
import type { MatchDetectionStatus } from '../../src/services/MatchDetectionService';
import { buildDetectionStatusSnapshot } from '../../src/ipc/detectionStatus';

type NonRunningUninitializedStatus = MatchDetectionStatus & {
  initialized: false;
  running: false;
  installations: null;
};

type RunningStatus = MatchDetectionStatus & {
  initialized: true;
  running: true;
  installations: {
    count: number;
    paths: string[];
  };
};

type InitializedStoppedStatus = MatchDetectionStatus & {
  initialized: true;
  running: false;
  installations: {
    count: number;
    paths: string[];
  } | null;
};

function createNonRunningUninitializedStatus(
  overrides: Partial<NonRunningUninitializedStatus> = {}
): NonRunningUninitializedStatus {
  return {
    initialized: false,
    running: false,
    metrics: null,
    currentMatch: null,
    installations: null,
    ...overrides,
  };
}

function createRunningStatus(overrides: Partial<RunningStatus> = {}): RunningStatus {
  return {
    initialized: true,
    running: true,
    metrics: null,
    currentMatch: null,
    installations: { count: 1, paths: ['service-path'] },
    ...overrides,
  };
}

function createInitializedStoppedStatus(
  overrides: Partial<InitializedStoppedStatus> = {}
): InitializedStoppedStatus {
  return {
    initialized: true,
    running: false,
    metrics: null,
    currentMatch: null,
    installations: { count: 1, paths: ['service-path'] },
    ...overrides,
  };
}

describe('buildDetectionStatusSnapshot', () => {
  it('prioritizes USER_DISABLED over NO_INSTALLATION', () => {
    const snapshot = buildDetectionStatusSnapshot({
      status: createNonRunningUninitializedStatus(),
      matchDetectionEnabled: false,
      resolvedInstallationCount: 0,
    });

    expect(snapshot.inactiveReason).toBe('USER_DISABLED');
    expect(snapshot.installationCount).toBe(0);
  });

  it('reports NO_INSTALLATION only for non-running non-initialized availability checks', () => {
    const snapshot = buildDetectionStatusSnapshot({
      status: createNonRunningUninitializedStatus(),
      matchDetectionEnabled: true,
      resolvedInstallationCount: 0,
    });

    expect(snapshot.inactiveReason).toBe('NO_INSTALLATION');
    expect(snapshot.installationCount).toBe(0);
  });

  it('does not treat undefined matchDetectionEnabled as disabled', () => {
    const snapshot = buildDetectionStatusSnapshot({
      status: createNonRunningUninitializedStatus(),
      matchDetectionEnabled: undefined,
      resolvedInstallationCount: 0,
    });

    expect(snapshot.inactiveReason).toBe('NO_INSTALLATION');
  });

  it('forces null inactiveReason while running and preserves service installation count', () => {
    const snapshot = buildDetectionStatusSnapshot({
      status: createRunningStatus({
        installations: { count: 2, paths: ['a', 'b'] },
      }),
      matchDetectionEnabled: false,
    });

    expect(snapshot.inactiveReason).toBeNull();
    expect(snapshot.installationCount).toBe(2);
  });

  it('uses service-owned installation count when initialized but not running', () => {
    const snapshot = buildDetectionStatusSnapshot({
      status: createInitializedStoppedStatus({
        installations: { count: 1, paths: ['service-path'] },
      }),
      matchDetectionEnabled: true,
    });

    expect(snapshot.inactiveReason).toBeNull();
    expect(snapshot.installationCount).toBe(1);
  });

  it('keeps USER_DISABLED when initialized but not running', () => {
    const snapshot = buildDetectionStatusSnapshot({
      status: createInitializedStoppedStatus({
        installations: { count: 1, paths: ['service-path'] },
      }),
      matchDetectionEnabled: false,
    });

    expect(snapshot.inactiveReason).toBe('USER_DISABLED');
    expect(snapshot.installationCount).toBe(1);
  });

  it('preserves explicit wowProcessStatus from the service snapshot', () => {
    const snapshot = buildDetectionStatusSnapshot({
      status: createRunningStatus({
        wowProcessStatus: {
          isRunning: true,
          isMonitoring: true,
          firstPollCompleted: true,
        },
      }),
      matchDetectionEnabled: true,
    });

    expect(snapshot.wowProcessStatus).toEqual({
      isRunning: true,
      isMonitoring: true,
      firstPollCompleted: true,
    });
  });

  it('provides a deterministic default wowProcessStatus when service state is absent', () => {
    const snapshot = buildDetectionStatusSnapshot({
      status: createNonRunningUninitializedStatus(),
      matchDetectionEnabled: true,
      resolvedInstallationCount: 1,
    });

    expect(snapshot.wowProcessStatus).toEqual({
      isRunning: false,
      isMonitoring: false,
      firstPollCompleted: false,
    });
  });

  it('uses resolved availability data for non-running non-initialized snapshots', () => {
    const snapshot = buildDetectionStatusSnapshot({
      status: createNonRunningUninitializedStatus(),
      matchDetectionEnabled: true,
      resolvedInstallationCount: 3,
    });

    expect(snapshot.installationCount).toBe(3);
    expect(snapshot.inactiveReason).toBeNull();
  });

  it('throws when a service-owned snapshot is missing installations', () => {
    expect(() =>
      buildDetectionStatusSnapshot({
        status: createInitializedStoppedStatus({
          installations: null,
        }),
        matchDetectionEnabled: true,
      })
    ).toThrow('must include installations');
  });

  it('throws when a non-running non-initialized snapshot omits resolvedInstallationCount', () => {
    const invalidParams = {
      status: createNonRunningUninitializedStatus(),
      matchDetectionEnabled: true,
    } as unknown as Parameters<typeof buildDetectionStatusSnapshot>[0];

    expect(() =>
      buildDetectionStatusSnapshot(invalidParams)
    ).toThrow('resolvedInstallationCount is required');
  });

  it('throws when a running snapshot reports zero installations', () => {
    expect(() =>
      buildDetectionStatusSnapshot({
        status: createRunningStatus({
          installations: { count: 0, paths: [] },
        }),
        matchDetectionEnabled: true,
      })
    ).toThrow('must report at least one installation');
  });
});
