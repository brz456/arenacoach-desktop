import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => {
  const setVideoResolution = (resolution: string) => {
    const [width, height] = resolution.split('x').map(Number);
    state.videoSettings = {
      ...state.videoSettings,
      baseWidth: width,
      baseHeight: height,
      outputWidth: width,
      outputHeight: height,
    };
  };

  const state = {
    signalHandlers: [] as Array<(signal: any) => void>,
    lastRecording: null as string | null,
    recoveryInitGate: null as Promise<void> | null,
    initializeCount: 0,
    videoSettings: {
      fpsNum: 60,
      baseWidth: 1920,
      baseHeight: 1080,
      outputWidth: 1920,
      outputHeight: 1080,
    },
    context: {
      video: {
        fpsNum: 60,
        baseWidth: 1920,
        baseHeight: 1080,
        outputWidth: 1920,
        outputHeight: 1080,
      },
      destroy: vi.fn(),
    },
    captureInitialize: vi.fn(async () => {
      state.initializeCount += 1;
      if (state.initializeCount === 2 && state.recoveryInitGate) {
        await state.recoveryInitGate;
      }
    }),
    captureApplyCaptureMode: vi.fn(() => true),
    captureSetCaptureCursor: vi.fn(() => true),
    captureSetDesktopAudioEnabled: vi.fn(),
    captureSetDesktopAudioDevice: vi.fn(),
    captureSetMicrophoneAudioEnabled: vi.fn(),
    captureSetMicrophoneDevice: vi.fn(),
    captureSetMicrophoneSuppression: vi.fn(),
    captureSetMicrophoneForceMono: vi.fn(),
    captureGetScene: vi.fn<() => { name: string } | null>(() => null),
    captureStopWoWDetection: vi.fn(),
    captureReleaseAll: vi.fn(),
    captureRescale: vi.fn(),
    captureListMonitors: vi.fn(() => []),
    captureSetMonitorById: vi.fn(() => true),
    settingsGetVideoSettings: vi.fn(() => ({ ...state.videoSettings })),
    settingsConfigureOutput: vi.fn(),
    settingsApplySetting: vi.fn(),
    settingsUpdateConfig: vi.fn(),
    settingsApplyEncoderById: vi.fn(() => true),
    settingsGetRecordingEncoderId: vi.fn(() => 'obs_x264'),
    settingsSetFPS: vi.fn((fps: number) => {
      state.videoSettings = { ...state.videoSettings, fpsNum: fps };
    }),
    settingsSetResolution: vi.fn((resolution: string) => {
      setVideoResolution(resolution);
    }),
    settingsSetQuality: vi.fn(),
    settingsGetInputAudioDevices: vi.fn(() => []),
    settingsGetOutputAudioDevices: vi.fn(() => []),
    storageGetRecordingsUsedSpace: vi.fn(async () => 0),
    storageEnforceStorageQuota: vi.fn(async () => ({ deleted: [] })),
    storageUpdateOutputDirectory: vi.fn(),
    previewSetScene: vi.fn(),
    previewDestroyPreview: vi.fn(),
    previewSetMainWindow: vi.fn(),
    previewShowPreview: vi.fn(async () => undefined),
    previewUpdatePreviewBounds: vi.fn(async () => undefined),
    previewHidePreview: vi.fn(),
    obsApiInit: vi.fn(() => 0),
    ipcHost: vi.fn(),
    ipcDisconnect: vi.fn(),
    setWorkingDirectory: vi.fn(),
    connectOutputSignals: vi.fn((handler: (signal: any) => void) => {
      state.signalHandlers.push(handler);
    }),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    getLastRecording: vi.fn(() => state.lastRecording),
    initShutdownSequence: vi.fn(),
    removeCallback: vi.fn(),
    encoderTypes: vi.fn(() => ['obs_x264']),
  };

  return state;
});

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/desktop-vitest-user-data'),
  },
  BrowserWindow: class BrowserWindow {},
}));

vi.mock('obs-studio-node', () => ({
  NodeObs: {
    IPC: {
      host: mockState.ipcHost,
      disconnect: mockState.ipcDisconnect,
    },
    SetWorkingDirectory: mockState.setWorkingDirectory,
    OBS_API_initAPI: mockState.obsApiInit,
    OBS_service_connectOutputSignals: mockState.connectOutputSignals,
    OBS_service_startRecording: mockState.startRecording,
    OBS_service_stopRecording: mockState.stopRecording,
    OBS_service_getLastRecording: mockState.getLastRecording,
    InitShutdownSequence: mockState.initShutdownSequence,
    OBS_service_removeCallback: mockState.removeCallback,
  },
  VideoFactory: {
    create: vi.fn(() => mockState.context),
  },
  VideoEncoderFactory: {
    types: mockState.encoderTypes,
  },
}));

vi.mock('../../../src/services/obs/OBSCaptureManager', () => ({
  OBSCaptureManager: class OBSCaptureManager {
    public initialize = mockState.captureInitialize;
    public applyCaptureMode = mockState.captureApplyCaptureMode;
    public setCaptureCursor = mockState.captureSetCaptureCursor;
    public setDesktopAudioEnabled = mockState.captureSetDesktopAudioEnabled;
    public setDesktopAudioDevice = mockState.captureSetDesktopAudioDevice;
    public setMicrophoneAudioEnabled = mockState.captureSetMicrophoneAudioEnabled;
    public setMicrophoneDevice = mockState.captureSetMicrophoneDevice;
    public setMicrophoneSuppression = mockState.captureSetMicrophoneSuppression;
    public setMicrophoneForceMono = mockState.captureSetMicrophoneForceMono;
    public getScene = mockState.captureGetScene;
    public stopWoWDetection = mockState.captureStopWoWDetection;
    public releaseAll = mockState.captureReleaseAll;
    public rescaleToNewDimensions = mockState.captureRescale;
    public listMonitors = mockState.captureListMonitors;
    public setMonitorById = mockState.captureSetMonitorById;
  },
}));

vi.mock('../../../src/services/obs/OBSSettingsManager', () => ({
  OBSSettingsManager: class OBSSettingsManager {
    public getVideoSettings = mockState.settingsGetVideoSettings;
    public configureOutput = mockState.settingsConfigureOutput;
    public applySetting = mockState.settingsApplySetting;
    public updateConfig = mockState.settingsUpdateConfig;
    public applyEncoderById = mockState.settingsApplyEncoderById;
    public getRecordingEncoderId = mockState.settingsGetRecordingEncoderId;
    public setFPS = mockState.settingsSetFPS;
    public setResolution = mockState.settingsSetResolution;
    public setQuality = mockState.settingsSetQuality;
    public getInputAudioDevices = mockState.settingsGetInputAudioDevices;
    public getOutputAudioDevices = mockState.settingsGetOutputAudioDevices;
  },
}));

vi.mock('../../../src/services/obs/RecordingStorageManager', () => ({
  RecordingStorageManager: class RecordingStorageManager {
    public getRecordingsUsedSpace = mockState.storageGetRecordingsUsedSpace;
    public enforceStorageQuota = mockState.storageEnforceStorageQuota;
    public updateOutputDirectory = mockState.storageUpdateOutputDirectory;
  },
}));

vi.mock('../../../src/services/obs/OBSPreviewManager', () => ({
  OBSPreviewManager: class OBSPreviewManager {
    public setScene = mockState.previewSetScene;
    public destroyPreview = mockState.previewDestroyPreview;
    public setMainWindow = mockState.previewSetMainWindow;
    public showPreview = mockState.previewShowPreview;
    public updatePreviewBounds = mockState.previewUpdatePreviewBounds;
    public hidePreview = mockState.previewHidePreview;
  },
}));

vi.mock('../../../src/services/obs/encoderResolver', () => ({
  resolveEncoderSelection: vi.fn(() => ({
    kind: 'resolved',
    encoderId: 'obs_x264',
    mode: 'auto',
    reason: 'auto_best_available',
    requestedEncoder: 'x264',
  })),
}));

import {
  OBSRecorder,
  OBS_RECORDER_RECOVERING,
  OBS_RECORDER_UNAVAILABLE,
  ObsRecorderAvailabilityError,
} from '../../../src/services/OBSRecorder';
import { CaptureMode } from '../../../src/services/RecordingTypes';

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('OBSRecorder recovery', () => {
  beforeEach(() => {
    mockState.signalHandlers.length = 0;
    mockState.lastRecording = null;
    mockState.recoveryInitGate = null;
    mockState.initializeCount = 0;
    mockState.context.video = {
      fpsNum: 60,
      baseWidth: 1920,
      baseHeight: 1080,
      outputWidth: 1920,
      outputHeight: 1080,
    };
    mockState.videoSettings = {
      fpsNum: 60,
      baseWidth: 1920,
      baseHeight: 1080,
      outputWidth: 1920,
      outputHeight: 1080,
    };

    for (const fn of [
      mockState.captureInitialize,
      mockState.captureApplyCaptureMode,
      mockState.captureSetCaptureCursor,
      mockState.captureSetDesktopAudioEnabled,
      mockState.captureSetDesktopAudioDevice,
      mockState.captureSetMicrophoneAudioEnabled,
      mockState.captureSetMicrophoneDevice,
      mockState.captureSetMicrophoneSuppression,
      mockState.captureSetMicrophoneForceMono,
      mockState.captureGetScene,
      mockState.captureStopWoWDetection,
      mockState.captureReleaseAll,
      mockState.captureRescale,
      mockState.captureListMonitors,
      mockState.captureSetMonitorById,
      mockState.settingsGetVideoSettings,
      mockState.settingsConfigureOutput,
      mockState.settingsApplySetting,
      mockState.settingsUpdateConfig,
      mockState.settingsApplyEncoderById,
      mockState.settingsGetRecordingEncoderId,
      mockState.settingsSetFPS,
      mockState.settingsSetResolution,
      mockState.settingsSetQuality,
      mockState.settingsGetInputAudioDevices,
      mockState.settingsGetOutputAudioDevices,
      mockState.storageGetRecordingsUsedSpace,
      mockState.storageEnforceStorageQuota,
      mockState.storageUpdateOutputDirectory,
      mockState.previewSetScene,
      mockState.previewDestroyPreview,
      mockState.previewSetMainWindow,
      mockState.previewShowPreview,
      mockState.previewUpdatePreviewBounds,
      mockState.previewHidePreview,
      mockState.obsApiInit,
      mockState.ipcHost,
      mockState.ipcDisconnect,
      mockState.setWorkingDirectory,
      mockState.connectOutputSignals,
      mockState.startRecording,
      mockState.stopRecording,
      mockState.getLastRecording,
      mockState.initShutdownSequence,
      mockState.removeCallback,
      mockState.encoderTypes,
      mockState.context.destroy,
    ]) {
      fn.mockClear();
    }
  });

  it('defers write-failure reinitialization until the next recording start', async () => {
    const recorder = new OBSRecorder();
    await recorder.initialize();
    await recorder.startRecording('/tmp/session-a');

    const firstGenerationHandler = mockState.signalHandlers[0];
    firstGenerationHandler({ type: 'recording', signal: 'start' });
    firstGenerationHandler({
      type: 'recording',
      signal: 'writing_error',
      error: 'disk full',
    });

    await vi.waitFor(() => {
      expect(mockState.initShutdownSequence).toHaveBeenCalledTimes(1);
    });

    expect(mockState.captureInitialize).toHaveBeenCalledTimes(1);
    await expect(recorder.startRecording('/tmp/session-b')).resolves.toBe('/tmp/session-b');

    expect(mockState.captureInitialize).toHaveBeenCalledTimes(2);
    expect(mockState.signalHandlers).toHaveLength(2);
  });

  it('ignores stale signals from the pre-recovery engine generation', async () => {
    const recorder = new OBSRecorder();
    await recorder.initialize();
    await recorder.startRecording('/tmp/session-a');

    const firstGenerationHandler = mockState.signalHandlers[0];
    firstGenerationHandler({ type: 'recording', signal: 'start' });
    firstGenerationHandler({
      type: 'recording',
      signal: 'writing_error',
      error: 'access denied',
    });

    await vi.waitFor(() => {
      expect(mockState.initShutdownSequence).toHaveBeenCalledTimes(1);
    });

    await recorder.startRecording('/tmp/session-b');
    const secondGenerationHandler = mockState.signalHandlers[1];
    secondGenerationHandler({ type: 'recording', signal: 'start' });

    const recordingErrors: Array<{ code: number | undefined; error: string | undefined }> = [];
    recorder.on('recordingError', event => {
      recordingErrors.push({ code: event.code, error: event.error });
    });

    firstGenerationHandler({
      type: 'recording',
      signal: 'writing_error',
      error: 'stale signal should be ignored',
    });

    expect(recordingErrors).toEqual([]);
    expect(recorder.getIsRecording()).toBe(true);
    expect(mockState.captureInitialize).toHaveBeenCalledTimes(2);
    expect(mockState.signalHandlers).toHaveLength(2);
  });

  it('collapses duplicate recorder recovery requests into a single recycle', async () => {
    const recorder = new OBSRecorder();
    await recorder.initialize();
    await recorder.startRecording('/tmp/session-a');

    const firstGenerationHandler = mockState.signalHandlers[0];
    firstGenerationHandler({ type: 'recording', signal: 'start' });
    firstGenerationHandler({
      type: 'recording',
      signal: 'writing_error',
      error: 'first failure',
    });
    firstGenerationHandler({
      type: 'recording',
      signal: 'stop',
      error: 'duplicate stop error while recovering',
    });

    await vi.waitFor(() => {
      expect(mockState.initShutdownSequence).toHaveBeenCalledTimes(1);
    });

    expect(mockState.captureInitialize).toHaveBeenCalledTimes(1);
    await recorder.initialize();
    expect(mockState.captureInitialize).toHaveBeenCalledTimes(2);
    expect(mockState.signalHandlers).toHaveLength(2);
  });

  it('joins deferred write-failure recovery instead of starting a parallel external initialize', async () => {
    const recorder = new OBSRecorder();
    await recorder.initialize();
    await recorder.startRecording('/tmp/session-a');

    const firstGenerationHandler = mockState.signalHandlers[0];
    firstGenerationHandler({ type: 'recording', signal: 'start' });
    firstGenerationHandler({
      type: 'recording',
      signal: 'writing_error',
      error: 'disk full',
    });

    await vi.waitFor(() => {
      expect(mockState.initShutdownSequence).toHaveBeenCalledTimes(1);
    });

    const externalInitializePromise = recorder.initialize();
    await flushMicrotasks();
    await externalInitializePromise;

    expect(mockState.captureInitialize).toHaveBeenCalledTimes(2);
    expect(mockState.signalHandlers).toHaveLength(2);
    await vi.waitFor(() => {
      expect(recorder.getIsInitialized()).toBe(true);
    });
    await recorder.initialize();
    await expect(recorder.startRecording('/tmp/session-b')).resolves.toBe('/tmp/session-b');
  });

  it('fails startRecording immediately with recovering while recycle is in flight, then completes deferred recovery on the next start', async () => {
    const recorder = new OBSRecorder();
    await recorder.initialize();
    await recorder.startRecording('/tmp/session-a');

    const firstGenerationHandler = mockState.signalHandlers[0];
    firstGenerationHandler({ type: 'recording', signal: 'start' });
    firstGenerationHandler({
      type: 'recording',
      signal: 'writing_error',
      error: 'disk full',
    });

    await expect(recorder.startRecording('/tmp/session-b')).rejects.toMatchObject({
      code: OBS_RECORDER_RECOVERING,
    } satisfies Partial<ObsRecorderAvailabilityError>);

    await vi.waitFor(() => {
      expect(mockState.initShutdownSequence).toHaveBeenCalledTimes(1);
    });

    await vi.waitFor(() => {
      expect((recorder as any).recoveryPromise).toBeNull();
      expect((recorder as any).deferredRecoveryPending).toBe(true);
    });

    await expect(recorder.startRecording('/tmp/session-c')).resolves.toBe('/tmp/session-c');
  });

  it('classifies write-like stop signals as write_error during recovery', async () => {
    const recordingErrors: Array<{ code: number | undefined; error: string | undefined }> = [];
    const recorder = new OBSRecorder();
    recorder.on('recordingError', event => {
      recordingErrors.push({ code: event.code, error: event.error });
    });

    await recorder.initialize();
    await recorder.startRecording('/tmp/session-a');

    const firstGenerationHandler = mockState.signalHandlers[0];
    firstGenerationHandler({ type: 'recording', signal: 'start' });
    firstGenerationHandler({
      type: 'recording',
      signal: 'stop',
      code: -8,
      error:
        "Error writing to 'H:\\\\ArenaCoach\\\\Recordings\\\\temp/2026-03-22 12-26-12.mp4', No space left on device\r\n" +
        'av_interleaved_write_frame failed: -1: Operation not permitted\r\n',
    });

    await vi.waitFor(() => {
      expect(recordingErrors).toHaveLength(1);
      expect(recordingErrors[0]).toMatchObject({ code: -1 });
      expect(mockState.initShutdownSequence).toHaveBeenCalledTimes(1);
    });
  });

  it('re-seeds currentSettings video values from recovered OBS settings after deferred recovery', async () => {
    const recorder = new OBSRecorder();
    await recorder.initialize();

    await expect(
      recorder.applyRecordingSettings({
        fps: 30,
        resolution: '1280x720',
      })
    ).resolves.toBe(true);

    await recorder.startRecording('/tmp/session-a');
    const firstGenerationHandler = mockState.signalHandlers[0];
    firstGenerationHandler({ type: 'recording', signal: 'start' });
    firstGenerationHandler({
      type: 'recording',
      signal: 'writing_error',
      error: 'disk full',
    });

    await vi.waitFor(() => {
      expect(mockState.initShutdownSequence).toHaveBeenCalledTimes(1);
    });

    await recorder.initialize();
    expect(mockState.captureInitialize).toHaveBeenCalledTimes(2);

    await expect(
      recorder.applyRecordingSettings({
        fps: 60,
        resolution: '1920x1080',
      })
    ).resolves.toBe(true);

    expect(mockState.settingsSetFPS).toHaveBeenLastCalledWith(60);
    expect(mockState.settingsSetResolution).toHaveBeenLastCalledWith('1920x1080');
    expect((recorder as any).currentSettings.fps).toBe(60);
    expect((recorder as any).currentSettings.resolution).toBe('1920x1080');
  });

  it('re-shows an already visible preview after deferred recovery tears the engine down', async () => {
    mockState.captureGetScene.mockReturnValue({ name: 'ArenaCoach Scene' });

    const recorder = new OBSRecorder();
    await recorder.initialize();
    await recorder.showPreview({ width: 800, height: 450, x: 12, y: 34 });
    await recorder.startRecording('/tmp/session-a');

    const firstGenerationHandler = mockState.signalHandlers[0];
    firstGenerationHandler({ type: 'recording', signal: 'start' });
    firstGenerationHandler({
      type: 'recording',
      signal: 'writing_error',
      error: 'disk full',
    });

    await vi.waitFor(() => {
      expect(mockState.initShutdownSequence).toHaveBeenCalledTimes(1);
    });

    await recorder.initialize();

    expect(mockState.previewDestroyPreview).toHaveBeenCalledTimes(1);
    expect(mockState.previewShowPreview).toHaveBeenCalledTimes(2);
    expect(mockState.previewShowPreview).toHaveBeenLastCalledWith({
      width: 800,
      height: 450,
      x: 12,
      y: 34,
    });
  });

  it('tears down partially initialized native resources when shutdown aborts stop-error recovery', async () => {
    const recoveryGate = createDeferred();
    mockState.recoveryInitGate = recoveryGate.promise;

    const recorder = new OBSRecorder();
    await recorder.initialize();
    await recorder.startRecording('/tmp/session-a');

    const firstGenerationHandler = mockState.signalHandlers[0];
    firstGenerationHandler({ type: 'recording', signal: 'start' });
    firstGenerationHandler({
      type: 'recording',
      signal: 'stop',
      code: -2,
      error: 'generic stop failure',
    });

    await vi.waitFor(() => {
      expect(mockState.captureInitialize).toHaveBeenCalledTimes(2);
    });

    const shutdownPromise = recorder.shutdown();
    recoveryGate.resolve();
    await shutdownPromise;

    expect(mockState.initShutdownSequence).toHaveBeenCalledTimes(2);
    expect(mockState.removeCallback).toHaveBeenCalledTimes(2);
    expect(mockState.ipcDisconnect).toHaveBeenCalledTimes(2);
    expect(mockState.captureReleaseAll).toHaveBeenCalledTimes(2);
    expect(mockState.context.destroy).toHaveBeenCalledTimes(2);
    expect(mockState.signalHandlers).toHaveLength(1);
    expect(recorder.getIsInitialized()).toBe(false);
  });

  it('tears down native resources on fatal IPC even before initialization reaches ready', () => {
    const recorder = new OBSRecorder();
    const fatalErrors: Error[] = [];

    (recorder as any).nativeEngineStarted = true;
    recorder.on('error', error => {
      fatalErrors.push(error);
    });

    recorder.onObsFatalIpcError(new Error('fatal ipc during initialize'));

    expect(mockState.initShutdownSequence).toHaveBeenCalledTimes(1);
    expect(mockState.removeCallback).toHaveBeenCalledTimes(1);
    expect(mockState.ipcDisconnect).toHaveBeenCalledTimes(1);
    expect(mockState.captureReleaseAll).toHaveBeenCalledTimes(1);
    expect(fatalErrors).toHaveLength(1);
    expect(recorder.getIsInitialized()).toBe(false);
  });

  it('does not let deferred write-failure recovery revive the recorder after fatal IPC', async () => {
    const fatalErrors: Error[] = [];
    const recordingErrors: Array<{ code: number | undefined; error: string | undefined }> = [];

    const recorder = new OBSRecorder();
    recorder.on('error', error => {
      fatalErrors.push(error);
    });
    recorder.on('recordingError', event => {
      recordingErrors.push({ code: event.code, error: event.error });
    });

    await recorder.initialize();
    await recorder.startRecording('/tmp/session-a');

    const firstGenerationHandler = mockState.signalHandlers[0];
    firstGenerationHandler({ type: 'recording', signal: 'start' });
    firstGenerationHandler({
      type: 'recording',
      signal: 'writing_error',
      error: 'disk full',
    });

    await vi.waitFor(() => {
      expect(mockState.initShutdownSequence).toHaveBeenCalledTimes(1);
    });

    recorder.onObsFatalIpcError(new Error('fatal ipc during recovery'));
    await flushMicrotasks();
    const recordingErrorCountBeforeLateSignal = recordingErrors.length;

    firstGenerationHandler({
      type: 'recording',
      signal: 'writing_error',
      error: 'late poisoned-engine signal',
    });

    await vi.waitFor(async () => {
      await expect(recorder.startRecording('/tmp/session-b')).rejects.toMatchObject({
        code: OBS_RECORDER_UNAVAILABLE,
      } satisfies Partial<ObsRecorderAvailabilityError>);
    });

    expect(recordingErrors).toHaveLength(recordingErrorCountBeforeLateSignal);
    expect(mockState.signalHandlers).toHaveLength(1);
    expect(mockState.initShutdownSequence).toHaveBeenCalledTimes(1);
    expect(fatalErrors).toHaveLength(1);
    expect(recorder.getIsInitialized()).toBe(false);
  });

  it('prefers unavailable over recovering immediately after fatal IPC flips the engine to failed', async () => {
    const fatalErrors: Error[] = [];
    const recorder = new OBSRecorder();
    recorder.on('error', error => {
      fatalErrors.push(error);
    });

    await recorder.initialize();
    await recorder.startRecording('/tmp/session-a');

    const firstGenerationHandler = mockState.signalHandlers[0];
    firstGenerationHandler({ type: 'recording', signal: 'start' });
    firstGenerationHandler({
      type: 'recording',
      signal: 'writing_error',
      error: 'disk full',
    });

    await vi.waitFor(() => {
      expect(mockState.initShutdownSequence).toHaveBeenCalledTimes(1);
    });

    recorder.onObsFatalIpcError(new Error('fatal ipc during recovery'));

    await expect(recorder.startRecording('/tmp/session-b')).rejects.toMatchObject({
      code: OBS_RECORDER_UNAVAILABLE,
    } satisfies Partial<ObsRecorderAvailabilityError>);
    expect(fatalErrors).toHaveLength(1);
  });

  it('does not publish ready if shutdown starts at the tail of initialization', async () => {
    const recorder = new OBSRecorder();
    const initialized = vi.fn();
    const originalSyncCurrentSettings = (recorder as any).syncCurrentSettingsFromOBS.bind(recorder);
    let shutdownPromise: Promise<void> | null = null;

    recorder.on('initialized', initialized);
    (recorder as any).syncCurrentSettingsFromOBS = vi.fn(() => {
      shutdownPromise = recorder.shutdown();
      originalSyncCurrentSettings();
    });

    await expect(recorder.initialize()).rejects.toMatchObject({
      name: 'ObsRecorderShutdownAbortError',
    });
    await shutdownPromise;

    expect(initialized).not.toHaveBeenCalled();
    expect(recorder.getIsInitialized()).toBe(false);
    expect(mockState.initShutdownSequence).toHaveBeenCalledTimes(1);
    expect(mockState.ipcDisconnect).toHaveBeenCalledTimes(1);
  });

  it('restores capture mode state when deferred write-failure recovery completes on next start', async () => {
    const recorder = new OBSRecorder();

    await recorder.initialize();
    const initialApplyCalls = mockState.captureApplyCaptureMode.mock.calls.length;

    const settingsApplied = await recorder.applyRecordingSettings({
      captureMode: CaptureMode.WINDOW,
      captureCursor: false,
    });
    expect(settingsApplied).toBe(true);
    expect(mockState.captureApplyCaptureMode).toHaveBeenCalledWith(CaptureMode.WINDOW);
    expect(mockState.captureSetCaptureCursor).toHaveBeenCalledWith(false);

    await recorder.startRecording('/tmp/session-a');
    const firstGenerationHandler = mockState.signalHandlers[0];
    firstGenerationHandler({ type: 'recording', signal: 'start' });
    firstGenerationHandler({
      type: 'recording',
      signal: 'writing_error',
      error: 'disk full',
    });

    await vi.waitFor(() => {
      expect(mockState.initShutdownSequence).toHaveBeenCalledTimes(1);
    });

    await expect(recorder.startRecording('/tmp/session-b')).resolves.toBe('/tmp/session-b');

    expect(mockState.captureApplyCaptureMode.mock.calls.length).toBe(initialApplyCalls + 2);
    expect(mockState.captureSetCaptureCursor).toHaveBeenCalledTimes(2);
    expect(mockState.captureApplyCaptureMode.mock.calls.at(-1)).toEqual([CaptureMode.WINDOW]);
    expect(mockState.captureSetCaptureCursor.mock.calls.at(-1)).toEqual([false]);
    expect(recorder.getIsInitialized()).toBe(true);
  });

  it('fails deferred recovery closed when capture mode restore fails on the next start', async () => {
    const recorder = new OBSRecorder();

    await recorder.initialize();
    await recorder.applyRecordingSettings({ captureMode: CaptureMode.WINDOW });

    mockState.captureApplyCaptureMode.mockReturnValueOnce(false);

    await recorder.startRecording('/tmp/session-a');
    const firstGenerationHandler = mockState.signalHandlers[0];
    firstGenerationHandler({ type: 'recording', signal: 'start' });
    firstGenerationHandler({
      type: 'recording',
      signal: 'writing_error',
      error: 'disk full',
    });

    await vi.waitFor(() => {
      expect(mockState.initShutdownSequence).toHaveBeenCalledTimes(1);
    });

    await expect(recorder.startRecording('/tmp/session-b')).rejects.toMatchObject({
      code: OBS_RECORDER_UNAVAILABLE,
    } satisfies Partial<ObsRecorderAvailabilityError>);

    expect(recorder.getIsInitialized()).toBe(false);
  });

  it('waits for a non-recovery initialize to abort before teardown on shutdown', async () => {
    const initGate = createDeferred();
    const recorder = new OBSRecorder();

    mockState.captureInitialize.mockImplementationOnce(async () => {
      mockState.initializeCount += 1;
      await initGate.promise;
    });

    const initializePromise = recorder.initialize();
    await vi.waitFor(() => {
      expect(mockState.captureInitialize).toHaveBeenCalledTimes(1);
    });

    const shutdownPromise = recorder.shutdown();
    expect(mockState.initShutdownSequence).not.toHaveBeenCalled();

    initGate.resolve();
    await expect(initializePromise).rejects.toMatchObject({
      name: 'ObsRecorderShutdownAbortError',
    });
    await shutdownPromise;

    expect(mockState.initShutdownSequence).toHaveBeenCalledTimes(1);
    expect(mockState.ipcDisconnect).toHaveBeenCalledTimes(1);
    expect(recorder.getIsInitialized()).toBe(false);
  });
});
