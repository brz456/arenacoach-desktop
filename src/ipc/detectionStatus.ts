import type { MatchDetectionStatus } from '../services/MatchDetectionService';
import type {
  DetectionInactiveReason,
  DetectionStatusSnapshot,
  WoWProcessStatusSnapshot,
} from './ipcTypes';

export const DEFAULT_WOW_PROCESS_STATUS: Readonly<WoWProcessStatusSnapshot> = Object.freeze({
  isRunning: false,
  isMonitoring: false,
  firstPollCompleted: false,
});

type NonRunningUninitializedDetectionStatus = MatchDetectionStatus & {
  running: false;
  initialized: false;
};

type ServiceOwnedDetectionStatus = MatchDetectionStatus & ({
  running: true;
} | {
  initialized: true;
});

type BuildDetectionStatusSnapshotParams =
  | {
      status: ServiceOwnedDetectionStatus;
      matchDetectionEnabled: boolean | undefined;
      resolvedInstallationCount?: never;
    }
  | {
      status: NonRunningUninitializedDetectionStatus;
      matchDetectionEnabled: boolean | undefined;
      resolvedInstallationCount: number;
    };

export function isNonRunningUninitializedDetectionStatus(
  status: MatchDetectionStatus
): status is NonRunningUninitializedDetectionStatus {
  return !status.running && !status.initialized;
}

export function isServiceOwnedDetectionStatus(
  status: MatchDetectionStatus
): status is ServiceOwnedDetectionStatus {
  return status.running || status.initialized;
}

export function buildDetectionStatusSnapshot(
  params: BuildDetectionStatusSnapshotParams
): DetectionStatusSnapshot {
  const { status, matchDetectionEnabled } = params;
  const running = status.running;
  const initialized = status.initialized;
  if (
    isNonRunningUninitializedDetectionStatus(status) &&
    params.resolvedInstallationCount === undefined
  ) {
    throw new Error(
      '[buildDetectionStatusSnapshot] resolvedInstallationCount is required when detection is neither running nor initialized'
    );
  }

  let installationCount: number;
  if (isNonRunningUninitializedDetectionStatus(status)) {
    installationCount = params.resolvedInstallationCount!;
  } else {
    if (status.installations === null) {
      throw new Error(
        '[buildDetectionStatusSnapshot] service-owned detection status must include installations'
      );
    }
    if (running && status.installations.count <= 0) {
      throw new Error(
        '[buildDetectionStatusSnapshot] running detection status must report at least one installation'
      );
    }
    installationCount = status.installations.count;
  }

  let inactiveReason: DetectionInactiveReason | null = null;
  if (!running) {
    if (matchDetectionEnabled === false) {
      inactiveReason = 'USER_DISABLED';
    } else if (!initialized && installationCount === 0) {
      inactiveReason = 'NO_INSTALLATION';
    }
  }

  return {
    running,
    initialized,
    installationCount,
    inactiveReason,
    wowProcessStatus: status.wowProcessStatus ?? DEFAULT_WOW_PROCESS_STATUS,
  };
}
