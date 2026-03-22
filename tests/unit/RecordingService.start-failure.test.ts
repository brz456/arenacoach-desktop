import type { PathLike } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

var recorderStartRecording: ReturnType<typeof vi.fn>;
var recorderStopRecording: ReturnType<typeof vi.fn>;
var recorderUpdateOutputDirectory: ReturnType<typeof vi.fn>;
const fsExistsSync = vi.hoisted(
  () => vi.fn<(path: PathLike) => boolean>(() => true)
);
const fsPromisesMkdir = vi.hoisted(() => vi.fn(async () => undefined));
const childProcessSpawn = vi.hoisted(() => vi.fn());

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: fsExistsSync,
    promises: {
      ...actual.promises,
      mkdir: fsPromisesMkdir,
    },
  };
});

vi.mock('child_process', () => ({
  spawn: childProcessSpawn,
}));

vi.mock('ffmpeg-static', () => ({
  default: '/usr/bin/ffmpeg',
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/desktop-vitest-user-data'),
  },
  BrowserWindow: class BrowserWindow {},
}));

vi.mock('../../src/services/OBSRecorder', () => {
  recorderStartRecording = vi.fn();
  recorderStopRecording = vi.fn();
  recorderUpdateOutputDirectory = vi.fn();
  const { EventEmitter } = require('events');

  class MockOBSRecorder extends EventEmitter {
    public startRecording = recorderStartRecording;
    public stopRecording = recorderStopRecording;
    public updateOutputDirectory = recorderUpdateOutputDirectory;
  }

  class MockObsRecorderAvailabilityError extends Error {
    constructor(
      public readonly code: string,
      message: string
    ) {
      super(message);
      this.name = 'ObsRecorderAvailabilityError';
    }
  }

  return {
    OBSRecorder: MockOBSRecorder,
    ObsFatalIpcError: class ObsFatalIpcError extends Error {},
    ObsRecorderAvailabilityError: MockObsRecorderAvailabilityError,
    OBS_RECORDING_DIRECTORY_UNAVAILABLE: 'OBS_RECORDING_DIRECTORY_UNAVAILABLE',
    OBS_RECORDER_RECOVERING: 'OBS_RECORDER_RECOVERING',
    OBS_RECORDER_UNAVAILABLE: 'OBS_RECORDER_UNAVAILABLE',
  };
});

import {
  OBS_RECORDING_DIRECTORY_UNAVAILABLE,
  OBS_RECORDER_RECOVERING,
  OBS_RECORDER_UNAVAILABLE,
  ObsRecorderAvailabilityError,
} from '../../src/services/OBSRecorder';
import { RecordingService } from '../../src/services/RecordingService';

describe('RecordingService start failures from recorder availability', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    recorderStartRecording.mockReset();
    recorderStopRecording.mockReset();
    recorderUpdateOutputDirectory.mockReset();
    fsExistsSync.mockReset();
    fsPromisesMkdir.mockReset();
    childProcessSpawn.mockReset();
    fsExistsSync.mockReturnValue(true);
    fsPromisesMkdir.mockResolvedValue(undefined);
  });

  it.each([
    {
      code: OBS_RECORDER_RECOVERING,
      expectedMessage:
        'Recording did not start because OBS is recovering from a previous recording failure.',
      expectedMetadataMessage:
        'Recording did not start because the OBS recorder is recovering from a previous output failure.',
    },
    {
      code: OBS_RECORDER_UNAVAILABLE,
      expectedMessage:
        'Recording did not start because OBS is unavailable after a previous recording failure.',
      expectedMetadataMessage:
        'Recording did not start because the OBS recorder is unavailable after a failed recovery.',
    },
    {
      code: OBS_RECORDING_DIRECTORY_UNAVAILABLE,
      expectedMessage:
        'Recording did not start because the recording folder is unavailable. Reconnect the drive or choose a different recording folder.',
      expectedMetadataMessage:
        'Recording did not start because the preferred recording directory is unavailable.',
    },
  ])('persists deterministic metadata for $code start failures', async ({
    code,
    expectedMessage,
    expectedMetadataMessage,
  }) => {
    const metadataService = {
      updateVideoMetadataByBufferId: vi.fn(async () => undefined),
    };
    const settingsService = {
      getSettings: vi.fn(() => ({
        recordingLocation: undefined,
        recording: { captureMode: 'game_capture' },
      })),
      updateSettings: vi.fn(),
    };

    const service = new RecordingService(
      { outputDir: 'G:\\recordings' },
      metadataService as any,
      settingsService as any
    );
    (service as any).isEnabled = true;
    recorderStartRecording.mockRejectedValueOnce(
      new ObsRecorderAvailabilityError(code, 'recorder unavailable')
    );

    const recordingErrors: string[] = [];
    service.on('recordingError', (message: string) => {
      recordingErrors.push(message);
    });

    await service.handleMatchStarted({ bufferId: 'buffer-1' } as any);

    expect(metadataService.updateVideoMetadataByBufferId).toHaveBeenCalledWith('buffer-1', {
      recordingStatus: 'failed_unknown',
      recordingErrorCode: code,
      recordingErrorMessage: expectedMetadataMessage,
    });
    expect(recordingErrors).toEqual([expectedMessage]);
  });

  it('falls back to the stop-result writer when the event-path metadata write fails', async () => {
    const metadataService = {
      updateVideoMetadataByBufferId: vi
        .fn()
        .mockRejectedValueOnce(new Error('event writer failed'))
        .mockResolvedValueOnce(undefined),
    };
    const settingsService = {
      getSettings: vi.fn(() => ({
        recordingLocation: undefined,
        recording: { captureMode: 'game_capture' },
      })),
      updateSettings: vi.fn(),
    };

    const service = new RecordingService(
      { outputDir: 'G:\\recordings' },
      metadataService as any,
      settingsService as any
    );
    (service as any).isEnabled = true;
    (service as any).currentSession = {
      bufferId: 'buffer-2',
      tempDir: '/tmp',
      finalPath: null,
      startTime: new Date('2026-03-22T09:00:00.000Z'),
      endTime: null,
      duration: 0,
      status: 'recording',
    };

    const mockRecorder = (service as any).obsRecorder;
    recorderStopRecording.mockImplementationOnce(async () => {
      mockRecorder.emit('recordingError', {
        sessionId: 'obs-session-1',
        code: -1,
        error: 'disk full',
      });

      return {
        ok: false,
        reason: 'write_error',
        error: 'disk full',
        durationSeconds: 12,
      };
    });

    await service.handleMatchEnded('buffer-2');

    expect(metadataService.updateVideoMetadataByBufferId).toHaveBeenCalledTimes(2);
    expect(metadataService.updateVideoMetadataByBufferId).toHaveBeenNthCalledWith(1, 'buffer-2', {
      recordingStatus: 'failed_io',
      recordingErrorCode: 'OBS_WRITE_ERROR',
      recordingErrorMessage:
        'OBS could not write to the recording directory. Check folder permissions or Windows Controlled Folder Access.',
    });
    expect(metadataService.updateVideoMetadataByBufferId).toHaveBeenNthCalledWith(2, 'buffer-2', {
      recordingStatus: 'failed_io',
      recordingErrorCode: 'OBS_WRITE_ERROR',
      recordingErrorMessage:
        'OBS could not write to the recording directory. Check folder permissions or Windows Controlled Folder Access.',
    });
  });

  it('does not persist failed-recovery metadata for ordinary non-availability start errors', async () => {
    const metadataService = {
      updateVideoMetadataByBufferId: vi.fn(async () => undefined),
    };
    const settingsService = {
      getSettings: vi.fn(() => ({
        recordingLocation: undefined,
        recording: { captureMode: 'game_capture' },
      })),
      updateSettings: vi.fn(),
    };

    const service = new RecordingService(
      {},
      metadataService as any,
      settingsService as any
    );
    const serviceErrors: unknown[] = [];
    (service as any).isEnabled = true;
    recorderStartRecording.mockRejectedValueOnce(
      Object.assign(new Error('OBS not initialized'), { code: 'OBS_NOT_INITIALIZED' })
    );
    service.on('error', error => {
      serviceErrors.push(error);
    });

    await service.handleMatchStarted({ bufferId: 'buffer-3' } as any);

    expect(metadataService.updateVideoMetadataByBufferId).not.toHaveBeenCalled();
    expect(serviceErrors).toHaveLength(1);
    expect(serviceErrors[0]).toMatchObject({ message: 'OBS not initialized', code: 'OBS_NOT_INITIALIZED' });
  });

  it('falls back to the default recording path when the saved drive root is unavailable at startup', () => {
    fsExistsSync.mockImplementation(path => path !== 'G:\\');

    const metadataService = {
      updateVideoMetadataByBufferId: vi.fn(async () => undefined),
    };
    const settingsService = {
      getSettings: vi.fn(() => ({
        recordingLocation: 'G:\\recordings',
        recording: { captureMode: 'game_capture' },
      })),
      updateSettings: vi.fn(),
    };

    const service = new RecordingService(
      {},
      metadataService as any,
      settingsService as any
    );

    expect((service as any).recordingsDir).toBe('/tmp/desktop-vitest-user-data/ArenaCoach/Recordings');
    expect(settingsService.updateSettings).not.toHaveBeenCalled();
  });

  it('fails deterministically at match start when the current recording root disappears mid-session', async () => {
    fsExistsSync.mockImplementation(path => path !== 'H:\\');

    const metadataService = {
      updateVideoMetadataByBufferId: vi.fn(async () => undefined),
    };
    const settingsService = {
      getSettings: vi.fn(() => ({
        recordingLocation: 'H:\\ArenaCoach\\Recordings',
        recording: { captureMode: 'game_capture' },
      })),
      updateSettings: vi.fn(),
    };

    const service = new RecordingService(
      {},
      metadataService as any,
      settingsService as any
    );
    (service as any).isEnabled = true;
    (service as any).recordingsDir = 'H:\\ArenaCoach\\Recordings';
    (service as any).thumbnailsDir = 'H:\\ArenaCoach\\Recordings\\Thumbnails';

    const recordingErrors: string[] = [];
    service.on('recordingError', (message: string) => {
      recordingErrors.push(message);
    });

    await service.handleMatchStarted({ bufferId: 'buffer-4' } as any);

    expect(recorderUpdateOutputDirectory).not.toHaveBeenCalled();
    expect(recorderStartRecording).not.toHaveBeenCalled();
    expect(settingsService.updateSettings).not.toHaveBeenCalled();
    expect(metadataService.updateVideoMetadataByBufferId).toHaveBeenCalledWith('buffer-4', {
      recordingStatus: 'failed_unknown',
      recordingErrorCode: OBS_RECORDING_DIRECTORY_UNAVAILABLE,
      recordingErrorMessage:
        'Recording did not start because the preferred recording directory is unavailable.',
    });
    expect(recordingErrors).toEqual([
      'Recording did not start because the recording folder is unavailable. Reconnect the drive or choose a different recording folder.',
    ]);
  });

  it('converts raw filesystem ENOENT start failures into deterministic recording metadata', async () => {
    const metadataService = {
      updateVideoMetadataByBufferId: vi.fn(async () => undefined),
    };
    const settingsService = {
      getSettings: vi.fn(() => ({
        recordingLocation: undefined,
        recording: { captureMode: 'game_capture' },
      })),
      updateSettings: vi.fn(),
    };

    const service = new RecordingService(
      {},
      metadataService as any,
      settingsService as any
    );
    (service as any).isEnabled = true;
    recorderStartRecording.mockRejectedValueOnce(
      Object.assign(new Error("ENOENT: no such file or directory, mkdir '\\\\?'"), {
        code: 'ENOENT',
        errno: -2,
        syscall: 'mkdir',
      })
    );

    const recordingErrors: string[] = [];
    service.on('recordingError', (message: string) => {
      recordingErrors.push(message);
    });

    await service.handleMatchStarted({ bufferId: 'buffer-5' } as any);

    expect(metadataService.updateVideoMetadataByBufferId).toHaveBeenCalledWith('buffer-5', {
      recordingStatus: 'failed_unknown',
      recordingErrorCode: OBS_RECORDING_DIRECTORY_UNAVAILABLE,
      recordingErrorMessage:
        'Recording did not start because the preferred recording directory is unavailable.',
    });
    expect(recordingErrors).toEqual([
      'Recording did not start because the recording folder is unavailable. Reconnect the drive or choose a different recording folder.',
    ]);
  });

  it('recreates the thumbnails directory before spawning ffmpeg for thumbnail generation', async () => {
    const { EventEmitter } = require('events');

    const metadataService = {
      updateVideoMetadataByBufferId: vi.fn(async () => undefined),
    };
    const settingsService = {
      getSettings: vi.fn(() => ({
        recordingLocation: 'H:\\ArenaCoach\\Recordings',
        recording: { captureMode: 'game_capture' },
      })),
      updateSettings: vi.fn(),
    };

    const service = new RecordingService(
      {},
      metadataService as any,
      settingsService as any
    );
    (service as any).thumbnailsDir = 'H:\\ArenaCoach\\Recordings\\Thumbnails';

    childProcessSpawn.mockImplementation(() => {
      const process = new EventEmitter() as any;
      process.stderr = new EventEmitter();
      queueMicrotask(() => {
        process.emit('exit', 0);
      });
      return process;
    });

    await (service as any).generateThumbnail(
      'H:\\ArenaCoach\\Recordings\\1773826997000_1134.mp4',
      32.6
    );

    expect(fsPromisesMkdir).toHaveBeenCalledWith('H:\\ArenaCoach\\Recordings\\Thumbnails', {
      recursive: true,
    });
    expect(childProcessSpawn).toHaveBeenCalledTimes(1);
  });
});
