import type { RecordingStatusType } from '../match-detection/types/StoredMatchTypes';

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
