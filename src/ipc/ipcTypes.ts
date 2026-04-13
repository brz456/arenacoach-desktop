import type { RecordingStatusType } from '../match-detection/types/StoredMatchTypes';

export type DetectionInactiveReason = 'NO_INSTALLATION' | 'USER_DISABLED';

export interface WoWProcessStatusSnapshot {
  isRunning: boolean;
  isMonitoring: boolean;
  firstPollCompleted: boolean;
}

export interface DetectionStatusSnapshot {
  running: boolean;
  initialized: boolean;
  installationCount: number;
  inactiveReason: DetectionInactiveReason | null;
  wowProcessStatus: WoWProcessStatusSnapshot;
}

export type RevealResult =
  | { success: true }
  | {
      success: false;
      error: string;
      code: 'INVALID_BUFFER_ID' | 'NO_MEDIA' | 'NOT_FOUND' | 'OPEN_FAILED';
    };

export type RecordingInfoResult =
  | {
      success: true;
      videoPath: string | null;
      videoExists: boolean;
      videoDuration: number | null;
      recordingStatus: RecordingStatusType;
      recordingErrorCode: string | null;
      recordingErrorMessage: string | null;
    }
  | {
      success: false;
      error: string;
      code: 'INVALID_BUFFER_ID' | 'METADATA_NOT_FOUND' | 'METADATA_LOAD_FAILED';
    };
