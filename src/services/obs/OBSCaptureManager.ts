/**
 * OBSCaptureManager - Manages OBS capture sources (game, monitor, audio)
 * Handles scene creation, source management, and WoW window attachment
 */

import * as osn from 'obs-studio-node';
import { IScene, IInput, ISceneItem } from 'obs-studio-node';
import { CaptureMode } from '../RecordingTypes';

/**
 * Supervisor interface for fatal OBS IPC errors.
 * Implemented by OBSRecorder to receive notifications when the OBS engine becomes unhealthy.
 */
export interface ObsIpcSupervisor {
  onObsFatalIpcError(error: Error): void;
}

/**
 * OBS window list item
 */
export interface OBSWindowItem {
  name: string;
  value: string | number;
}

/**
 * Manages OBS capture sources and scene configuration
 */
export class OBSCaptureManager {
  // Configurable timing constants
  private static readonly SCALE_CHECK_DELAY_MS = 1000;
  private static readonly MAX_SCALE_ATTEMPTS = 20;
  private static readonly LOST_SOURCE_ATTEMPTS = 5;

  // OBS property type constant (obs-studio-node v0.23.x)
  // Note: No enum exported by library, using numeric constant from API
  private static readonly OBS_PROPERTY_LIST = 6; // List property type
  // Microphone flags
  private static readonly FORCE_MONO_FLAG = 1 << 1;

  // Exponential backoff constants
  private static readonly MIN_BACKOFF_MS = 500;
  private static readonly MAX_BACKOFF_MS = 30000;

  private scene: IScene | null = null;
  private gameCapture: IInput | null = null;
  private windowCapture: IInput | null = null;
  private monitorCapture: IInput | null = null;
  private audioCapture: IInput | null = null;
  private microphoneCapture: IInput | null = null;
  private microphoneSuppressionFilter: osn.IFilter | null = null;

  // Track current capture mode
  private currentCaptureMode: CaptureMode = CaptureMode.WINDOW;

  // Track attachment attempts for logging
  private wowDetectionAttempts = 0;
  private readonly wowHookCheckDelay: number;

  // Video context reference for scaling calculations
  private context: ReturnType<typeof osn.VideoFactory.create> | null = null;

  // WoW detection state management
  private detectionTimeoutId: NodeJS.Timeout | null = null;
  private backoffMs = OBSCaptureManager.MIN_BACKOFF_MS;
  private isWoWAttached = false;
  private isGameCaptureEnabled = false;

  // Track cursor capture preference
  private captureCursorEnabled = true;

  // Lifecycle state
  private isShuttingDown = false;

  // Window capture polling
  private dummyWindowCapture: IInput | null = null;
  private windowPollIntervalId: NodeJS.Timeout | null = null;
  private static readonly WINDOW_POLL_INTERVAL_MS = 5000;

  // Supervisor for fatal IPC error escalation
  private readonly supervisor: ObsIpcSupervisor | undefined;

  constructor(options: { hookCheckDelayMs?: number; supervisor?: ObsIpcSupervisor } = {}) {
    this.wowHookCheckDelay = options.hookCheckDelayMs ?? 500;
    this.supervisor = options.supervisor;
  }

  /**
   * Initialize scene and capture sources
   * Creates game, window, and monitor capture sources (only one active at a time)
   */
  public async initialize(context: ReturnType<typeof osn.VideoFactory.create>): Promise<void> {
    this.isShuttingDown = false;
    this.context = context;

    // Create scene
    this.scene = osn.SceneFactory.create('ArenaCoach Scene');

    // Set scene as output source for video channel
    osn.Global.setOutputSource(0, this.scene);

    // Create all capture sources (only one will be enabled at a time)

    // 1. Game capture for WoW
    this.gameCapture = osn.InputFactory.create('game_capture', 'WoW Game Capture');
    this.gameCapture.enabled = false; // Initially disabled until WoW detected

    // Add game capture to scene
    const gameCaptureItem = this.scene.add(this.gameCapture);
    gameCaptureItem.position = { x: 0, y: 0 };
    gameCaptureItem.scale = { x: 1.0, y: 1.0 };

    // 2. Window capture (for non-fullscreen windows)
    this.windowCapture = osn.InputFactory.create('window_capture', 'Window Capture');
    this.windowCapture.enabled = false; // Disabled by default

    // Add window capture to scene
    const windowCaptureItem = this.scene.add(this.windowCapture);
    windowCaptureItem.position = { x: 0, y: 0 };
    windowCaptureItem.scale = { x: 1.0, y: 1.0 };

    // Ensure dummy window capture is ready for polling
    if (!this.ensureDummyWindowCapture()) {
      console.warn(
        '[OBSCaptureManager] Failed to create dummy window capture during initialization; polling will retry on demand'
      );
    }

    // 3. Monitor capture (for entire screen)
    this.monitorCapture = osn.InputFactory.create('monitor_capture', 'Monitor Capture');
    this.monitorCapture.enabled = false; // Disabled by default

    // Add monitor capture to scene
    const monitorCaptureItem = this.scene.add(this.monitorCapture);
    monitorCaptureItem.position = { x: 0, y: 0 };
    monitorCaptureItem.scale = { x: 1.0, y: 1.0 };

    // Create desktop audio capture
    this.audioCapture = osn.InputFactory.create('wasapi_output_capture', 'Desktop Audio');

    // Create microphone capture
    this.microphoneCapture = osn.InputFactory.create('wasapi_input_capture', 'Microphone');

    // Set audio sources for channels
    osn.Global.setOutputSource(1, this.audioCapture); // Desktop audio on channel 1
    osn.Global.setOutputSource(2, this.microphoneCapture); // Microphone on channel 2

    // Game capture, desktop audio, and microphone initialized

    // WoW detection will start only when game capture mode is selected
  }

  /**
   * Try to attach game capture to WoW window
   */
  public tryAttachToWoWWindow(): void {
    // Only attempt if game capture enabled
    if (!this.gameCapture || !this.isGameCaptureEnabled) return;

    this.wowDetectionAttempts++;

    // Create dummy game_capture to refresh properties
    const dummyInput = osn.InputFactory.create('game_capture', 'temp_dummy');

    try {
      // Force refresh to get current window list
      const dummySettings = dummyInput.settings;
      dummySettings.refresh = `${Math.random().toString(36).substr(2, 9)}-${Date.now()}`;
      dummyInput.update(dummySettings);

      // Find window property
      let prop = dummyInput.properties.first();
      while (prop && prop.name !== 'window') {
        prop = prop.next();
      }

      if (prop && prop.name === 'window' && this.isObsListProperty(prop)) {
        const windowList = prop.details.items;

        // Debug: Log available windows on early attempts
        if (this.wowDetectionAttempts <= 2) {
          // Available windows found
        }

        // Find WoW window with robust, case-insensitive matching
        const wowWindow = windowList.find((item: OBSWindowItem) =>
          OBSCaptureManager.isWoWWindowName(item.name || '')
        );

        if (wowWindow) {
          // Found WoW window

          // Configure game capture (cursor setting managed by setCaptureCursor)
          const settings = this.gameCapture.settings;
          settings.capture_mode = 'window';
          settings.priority = 1;
          settings.allow_transparency = false;
          // Note: capture_cursor is managed by setCaptureCursor/OBSSettingsManager
          settings.window = String(wowWindow.value); // Use the OSN token, not name

          this.gameCapture.update(settings);
          this.gameCapture.save();
          this.gameCapture.enabled = true;

          // Game capture attached to WoW

          // Reset attempts and mark as attached
          this.wowDetectionAttempts = 0;
          this.isWoWAttached = true;

          // Stop detection - we found WoW
          this.clearDetectionTimer();
          this.resetBackoff();

          // Wait for hook and then scale
          setTimeout(() => {
            this.checkAndScaleSource();
          }, this.wowHookCheckDelay);
        } else {
          // WoW window not found yet
          // Schedule next attempt with backoff if still enabled and not attached
          if (this.isGameCaptureEnabled && !this.isWoWAttached) {
            this.scheduleNextAttempt();
          }
        }
      }
    } catch (error) {
      // Error during WoW attach
    } finally {
      // Always cleanup dummy input
      dummyInput.release();
    }
  }

  /**
   * Schedule next detection attempt with exponential backoff
   */
  private scheduleNextAttempt(): void {
    this.clearDetectionTimer();

    // Scheduling next detection attempt

    this.detectionTimeoutId = setTimeout(() => {
      this.tryAttachToWoWWindow();
    }, this.backoffMs);

    // Exponential backoff: double the delay, cap at MAX_BACKOFF_MS
    this.backoffMs = Math.min(this.backoffMs * 2, OBSCaptureManager.MAX_BACKOFF_MS);
  }

  /**
   * Clear any pending detection timer
   */
  private clearDetectionTimer(): void {
    if (this.detectionTimeoutId) {
      clearTimeout(this.detectionTimeoutId);
      this.detectionTimeoutId = null;
    }
  }

  /**
   * Reset backoff to minimum
   */
  private resetBackoff(): void {
    this.backoffMs = OBSCaptureManager.MIN_BACKOFF_MS;
  }

  /**
   * Reset detection attempts counter
   */
  public resetDetectionAttempts(): void {
    this.wowDetectionAttempts = 0;
    this.isWoWAttached = false;

    // Clear any pending detection
    this.clearDetectionTimer();
    this.resetBackoff();

    // Disable game capture
    if (this.gameCapture) {
      this.gameCapture.enabled = false;
      // Detection reset, game capture disabled
    }
  }

  /**
   * Type guard for OBS list property with robust validation
   * Validates both type constant and structure for maximum safety
   */
  private isObsListProperty(property: osn.IProperty): property is osn.IListProperty {
    // Check numeric type (no enum available in obs-studio-node)
    return (
      property.type === OBSCaptureManager.OBS_PROPERTY_LIST &&
      // Structural validation for safety
      'details' in property &&
      typeof (property as any).details === 'object' &&
      (property as any).details !== null &&
      'items' in (property as any).details &&
      Array.isArray((property as any).details.items)
    );
  }

  /** Determine if an OBS window list item name is a WoW window */
  private static isWoWWindowName(name: string): boolean {
    const lower = name.toLowerCase();
    return lower.includes('wow.exe');
  }

  /**
   * Check if source is hooked and scale if ready
   */
  private checkAndScaleSource(attempts = 0): void {
    if (!this.gameCapture) return;

    if (this.gameCapture.width > 0 && this.gameCapture.height > 0) {
      // Source hooked successfully
      this.scaleGameCaptureSource();
    } else if (attempts < OBSCaptureManager.MAX_SCALE_ATTEMPTS) {
      // Check if we lost the source (WoW closed while attached)
      if (this.isWoWAttached && attempts > OBSCaptureManager.LOST_SOURCE_ATTEMPTS) {
        // Lost source dimensions - WoW may have closed
        this.isWoWAttached = false;
        this.gameCapture.enabled = false;
        // Schedule reattachment attempt
        if (this.isGameCaptureEnabled) {
          this.scheduleNextAttempt();
        }
        return;
      }
      // Retry scaling check with attempt limit
      setTimeout(
        () => this.checkAndScaleSource(attempts + 1),
        OBSCaptureManager.SCALE_CHECK_DELAY_MS
      );
    } else {
      // Failed to get source dimensions - scaling aborted
    }
  }

  /**
   * Scale game capture source to fit output resolution
   * @returns true if scaling succeeded, false otherwise
   */
  private scaleGameCaptureSource(): boolean {
    if (!this.scene || !this.gameCapture || !this.context) return false;

    try {
      // Only scale when source has valid dimensions
      if (this.gameCapture.width <= 0 || this.gameCapture.height <= 0) {
        // Source dimensions not ready, skipping scale
        return false;
      }

      // Get scene item for the game capture
      const sceneItems = this.scene.getItems();
      const gameCaptureItem = sceneItems.find(
        (item: ISceneItem) => item.source.name === this.gameCapture!.name
      );

      if (gameCaptureItem) {
        const outputWidth = this.context.video.outputWidth;
        const outputHeight = this.context.video.outputHeight;
        const sourceWidth = this.gameCapture.width;
        const sourceHeight = this.gameCapture.height;

        // Calculate scale to fit (maintain aspect ratio)
        const scaleX = outputWidth / sourceWidth;
        const scaleY = outputHeight / sourceHeight;
        const scale = Math.min(scaleX, scaleY);

        // Apply scaling
        gameCaptureItem.scale = { x: scale, y: scale };

        // Center the scaled source in the scene canvas
        const scaledWidth = sourceWidth * scale;
        const scaledHeight = sourceHeight * scale;

        gameCaptureItem.position = {
          x: (outputWidth - scaledWidth) / 2,
          y: (outputHeight - scaledHeight) / 2,
        };

        // Game capture centered in scene
      }
    } catch (error) {
      // Failed to scale game capture
      return false;
    }
    return true;
  }

  /**
   * Check if window capture source is ready and scale if needed
   */
  private checkAndScaleWindowSource(attempts = 0): void {
    if (!this.windowCapture) return;

    if (this.windowCapture.width > 0 && this.windowCapture.height > 0) {
      // Source hooked successfully
      this.scaleWindowCaptureSource();
    } else if (attempts < OBSCaptureManager.MAX_SCALE_ATTEMPTS) {
      // Retry scaling check with attempt limit
      setTimeout(
        () => this.checkAndScaleWindowSource(attempts + 1),
        OBSCaptureManager.SCALE_CHECK_DELAY_MS
      );
    } else {
      // Failed to get source dimensions - scaling aborted
    }
  }

  /**
   * Scale window capture source to fit output resolution
   * @returns true if scaling succeeded, false otherwise
   */
  private scaleWindowCaptureSource(): boolean {
    if (!this.scene || !this.windowCapture || !this.context) return false;

    try {
      // Only scale when source has valid dimensions
      if (this.windowCapture.width <= 0 || this.windowCapture.height <= 0) {
        // Source dimensions not ready, skipping scale
        return false;
      }

      // Get scene item for the window capture
      const sceneItems = this.scene.getItems();
      const windowCaptureItem = sceneItems.find(
        (item: ISceneItem) => item.source.name === this.windowCapture!.name
      );

      if (windowCaptureItem) {
        const outputWidth = this.context.video.outputWidth;
        const outputHeight = this.context.video.outputHeight;
        const sourceWidth = this.windowCapture.width;
        const sourceHeight = this.windowCapture.height;

        // Calculate scale to fit (maintain aspect ratio)
        const scaleX = outputWidth / sourceWidth;
        const scaleY = outputHeight / sourceHeight;
        const scale = Math.min(scaleX, scaleY);

        // Apply scaling
        windowCaptureItem.scale = { x: scale, y: scale };

        // Center the scaled source in the scene canvas
        const scaledWidth = sourceWidth * scale;
        const scaledHeight = sourceHeight * scale;

        windowCaptureItem.position = {
          x: (outputWidth - scaledWidth) / 2,
          y: (outputHeight - scaledHeight) / 2,
        };

        // Window capture centered in scene
      }
    } catch (error) {
      // Failed to scale window capture
      return false;
    }
    return true;
  }

  /**
   * Release all capture sources and scene
   * CRITICAL for proper shutdown sequence
   * @returns true if all resources released successfully
   */
  public releaseAll(): boolean {
    this.isShuttingDown = true;
    // Stop polling and release persistent dummy
    this.clearWindowCapturePolling();
    if (this.dummyWindowCapture) {
      try {
        this.dummyWindowCapture.release();
      } catch (_) {}
      this.dummyWindowCapture = null;
    }

    try {
      // Clear output sources first
      // Note: Casting to 'any' required as OBS types don't properly support null for detachment
      osn.Global.setOutputSource(0, null as any);
      osn.Global.setOutputSource(1, null as any);
      osn.Global.setOutputSource(2, null as any);

      // Release individual sources
      if (this.gameCapture) {
        this.gameCapture.release();
        this.gameCapture = null;
      }

      if (this.windowCapture) {
        this.windowCapture.release();
        this.windowCapture = null;
      }

      if (this.monitorCapture) {
        this.monitorCapture.release();
        this.monitorCapture = null;
      }

      if (this.audioCapture) {
        this.audioCapture.release();
        this.audioCapture = null;
      }

      if (this.microphoneCapture) {
        this.microphoneCapture.release();
        this.microphoneCapture = null;
      }

      // Release scene last
      if (this.scene) {
        this.scene.release();
        this.scene = null;
      }

      // All sources released
    } catch (error) {
      // Error during release - non-critical during shutdown
      return false;
    }
    return true;
  }

  /**
   * Get the current scene
   */
  public getScene(): IScene | null {
    return this.scene;
  }

  /**
   * Check if game capture is currently active
   */
  public isGameCaptureActive(): boolean {
    return this.gameCapture?.enabled ?? false;
  }

  /**
   * Enable or disable game capture mode
   */
  public setGameCaptureEnabled(enabled: boolean): void {
    this.isGameCaptureEnabled = enabled;

    if (enabled) {
      // Reset backoff and immediately try to attach
      this.resetBackoff();
      this.tryAttachToWoWWindow();
      // If not attached, scheduleNextAttempt() will be called from tryAttachToWoWWindow()
    } else {
      // Stop detection and disable game capture
      this.clearDetectionTimer();
      if (this.gameCapture) {
        this.gameCapture.enabled = false;
        this.isWoWAttached = false;
        // Game capture disabled
      }
    }
  }

  /**
   * Set WoW process active state (optional hint for immediate recheck)
   */
  public setWoWActive(active: boolean): void {
    // This is now just an optional hint to speed up detection
    if (active && this.isGameCaptureEnabled && !this.isWoWAttached) {
      // Clear current timer and try immediately
      this.clearDetectionTimer();
      this.resetBackoff();
      this.tryAttachToWoWWindow();
    }
    // We don't disable on inactive - let the self-contained detection handle it
  }

  /**
   * Set microphone device
   */
  public setMicrophoneDevice(deviceId: string): void {
    if (this.microphoneCapture) {
      const settings = this.microphoneCapture.settings;
      settings.device_id = deviceId;
      this.microphoneCapture.update(settings);
      this.microphoneCapture.save(); // Persist settings across sessions
      // Microphone device updated
    }
  }

  /**
   * Enable or disable RNNoise suppression on microphone
   */
  public setMicrophoneSuppression(enabled: boolean): void {
    if (!this.microphoneCapture) return;

    try {
      if (enabled) {
        if (!this.microphoneSuppressionFilter) {
          const filter = osn.FilterFactory.create(
            'noise_suppress_filter_v2',
            'MicNoiseSuppression',
            { method: 'rnnoise', suppress_level: -30, intensity: 1 }
          );
          try {
            this.microphoneCapture.addFilter(filter);
            this.microphoneSuppressionFilter = filter;
          } catch (e) {
            console.warn('[OBSCaptureManager] Failed to add mic suppression filter', e);
            try {
              filter.release?.();
            } catch (_) {}
          }
        }
      } else {
        if (this.microphoneSuppressionFilter) {
          try {
            this.microphoneCapture.removeFilter(this.microphoneSuppressionFilter);
          } catch (e) {
            console.warn('[OBSCaptureManager] Failed to remove mic suppression filter', e);
          }
          this.microphoneSuppressionFilter = null;
        }
      }
    } catch (e) {
      console.warn('[OBSCaptureManager] Mic suppression update failed', e);
    }
  }

  /**
   * Force mono on microphone input (avoids channel imbalance)
   */
  public setMicrophoneForceMono(enabled: boolean): void {
    if (!this.microphoneCapture) return;
    try {
      this.microphoneCapture.flags = enabled
        ? this.microphoneCapture.flags | OBSCaptureManager.FORCE_MONO_FLAG
        : this.microphoneCapture.flags & ~OBSCaptureManager.FORCE_MONO_FLAG;
    } catch (e) {
      console.warn('[OBSCaptureManager] Failed to toggle mic force-mono', e);
    }
  }

  /**
   * Set desktop audio device
   */
  public setDesktopAudioDevice(deviceId: string): void {
    if (this.audioCapture) {
      const settings = this.audioCapture.settings;
      settings.device_id = deviceId;
      this.audioCapture.update(settings);
      this.audioCapture.save(); // Persist settings across sessions
      // Desktop audio device updated
    }
  }

  /**
   * Stop WoW detection (public method for shutdown)
   */
  public stopWoWDetection(): void {
    this.clearDetectionTimer();
    // WoW detection stopped
  }

  /**
   * Apply capture mode - enables selected source, disables others
   */
  public applyCaptureMode(mode: CaptureMode): void {
    this.currentCaptureMode = mode;

    // Disable all capture sources first
    if (this.gameCapture) this.gameCapture.enabled = false;
    if (this.windowCapture) this.windowCapture.enabled = false;
    if (this.monitorCapture) this.monitorCapture.enabled = false;

    // Stop WoW detection if switching away from game capture
    if (mode !== CaptureMode.GAME) {
      this.stopWoWDetection();
      this.isGameCaptureEnabled = false;
    }
    // Stop window polling if switching away from window mode
    if (mode !== CaptureMode.WINDOW) {
      this.clearWindowCapturePolling();
    }

    // Enable the selected capture mode
    switch (mode) {
      case CaptureMode.GAME:
        if (this.gameCapture) {
          this.isGameCaptureEnabled = true;
          // Apply cursor preference to game capture
          const gameSettings = this.gameCapture.settings;
          gameSettings.capture_cursor = this.captureCursorEnabled;
          this.gameCapture.update(gameSettings);
          // Game capture will be enabled when WoW is detected
          this.tryAttachToWoWWindow();
        }
        break;

      case CaptureMode.WINDOW:
        if (this.windowCapture) {
          // Begin polling to attach to WoW (handles minimized/restored and OSN cache refresh)
          this.startWindowCapturePolling();
        }
        break;

      case CaptureMode.MONITOR:
        if (this.monitorCapture) {
          // Apply cursor preference to monitor capture
          const monitorSettings = this.monitorCapture.settings;
          monitorSettings.capture_cursor = this.captureCursorEnabled;
          this.monitorCapture.update(monitorSettings);
          this.monitorCapture.enabled = true;
        }
        break;
    }
  }

  /**
   * Select a default window for window capture
   * Selects only WoW window
   * @returns true if window selected, false otherwise
   */
  private selectDefaultWindow(): boolean {
    if (!this.windowCapture) return false;

    try {
      // Get window capture properties to find available windows
      const props = this.windowCapture.properties;
      const windowProp = props?.get('window');

      if (windowProp && this.isObsListProperty(windowProp)) {
        const windows = windowProp.details.items || [];

        // Only select WoW window
        const selectedWindow = windows.find((w: any) =>
          OBSCaptureManager.isWoWWindowName(w.name || '')
        );

        if (selectedWindow) {
          const settings = this.windowCapture.settings;
          settings.window = selectedWindow.value;
          settings.method = 2; // Windows Graphics Capture - fixes black screen
          settings.cursor = this.captureCursorEnabled; // Apply cursor preference
          this.windowCapture.update(settings);
          this.windowCapture.save();

          // Wait briefly then check and scale the window capture
          setTimeout(() => {
            this.checkAndScaleWindowSource();
          }, this.wowHookCheckDelay);

          return true;
        }
      }
    } catch (error) {
      // Window selection failed - will show desktop
      return false;
    }
    return false;
  }

  /**
   * Ensure persistent dummy window capture exists
   * @returns true if exists/created, false on failure
   */
  private ensureDummyWindowCapture(): boolean {
    if (this.isShuttingDown) return false;
    if (this.dummyWindowCapture) return true;
    try {
      this.dummyWindowCapture = osn.InputFactory.create('window_capture', 'temp_window_dummy');
      return true;
    } catch (e) {
      console.warn('[OBSCaptureManager] Failed to create dummy window capture', e);
      return false;
    }
  }

  /** Start polling using a dummy window_capture source to find WoW window */
  private startWindowCapturePolling(): void {
    this.clearWindowCapturePolling();
    if (this.isShuttingDown || !this.windowCapture) return;

    // Ensure we start from a clean state (avoid stale hook)
    try {
      this.windowCapture.enabled = false;
    } catch (_) {}

    // Use persistent dummy
    if (!this.ensureDummyWindowCapture()) {
      // Failed to create dummy, fallback to single-shot selection
      this.selectDefaultWindow();
      return;
    }

    // Immediate attempt, then interval
    this.windowPollTick();

    // If a fatal error triggered shutdown or windowCapture was released, do not start a new timer
    if (this.isShuttingDown || !this.windowCapture) {
      return;
    }

    this.windowPollIntervalId = setInterval(() => {
      this.windowPollTick();
    }, OBSCaptureManager.WINDOW_POLL_INTERVAL_MS);
  }

  /** Stop polling (does NOT release dummy source) */
  private clearWindowCapturePolling(): void {
    if (this.windowPollIntervalId) {
      clearInterval(this.windowPollIntervalId);
      this.windowPollIntervalId = null;
    }
  }

  /**
   * Classify whether an error is a fatal OBS IPC error.
   * Returns true for errors indicating the OBS IPC channel is broken.
   */
  private isObsIpcError(error: unknown): error is Error {
    if (!(error instanceof Error)) return false;
    // Match explicit OBS IPC failure signature from obs-studio-node
    return error.message.includes('Failed to make IPC call');
  }

  /**
   * Report a fatal OBS IPC error to the supervisor.
   * If no supervisor is configured, logs a warning.
   */
  private reportFatalObsError(error: Error): void {
    if (this.supervisor) {
      this.supervisor.onObsFatalIpcError(error);
    } else {
      console.error('[OBSCaptureManager] Fatal OBS IPC error (no supervisor):', error.message);
    }
  }

  /** Force-refresh dummy properties and find WoW window token */
  private findWoWWindowViaDummy(): string | undefined {
    if (this.isShuttingDown || !this.dummyWindowCapture) return undefined;
    try {
      const s = this.dummyWindowCapture.settings;
      (s as any).refresh = `${Math.random().toString(36).slice(2)}-${Date.now()}`;
      this.dummyWindowCapture.update(s);

      let prop = this.dummyWindowCapture.properties.first();
      while (prop && prop.name !== 'window') {
        prop = prop.next();
      }
      if (!prop || prop.name !== 'window' || !this.isObsListProperty(prop)) {
        return undefined;
      }
      const items = prop.details.items || [];
      const match = items.find((it: any) => OBSCaptureManager.isWoWWindowName(it.name || ''));
      return match ? String(match.value) : undefined;
    } catch (_) {
      return undefined;
    }
  }

  /** Poll tick: re-find WoW token, apply to real source, stop when dimensions are non-zero */
  private windowPollTick(): void {
    try {
      if (
        this.isShuttingDown ||
        this.currentCaptureMode !== CaptureMode.WINDOW ||
        !this.windowCapture
      ) {
        this.clearWindowCapturePolling();
        return;
      }

      // If already hooked (dimensions ready), stop polling
      if (
        this.windowCapture.enabled &&
        this.windowCapture.width > 0 &&
        this.windowCapture.height > 0
      ) {
        // Scale and stop
        try {
          this.scaleWindowCaptureSource();
        } catch (_) {}
        this.clearWindowCapturePolling();
        return;
      }

      const token = this.findWoWWindowViaDummy();
      if (!token) {
        return; // try again on next interval
      }

      // Apply settings and force re-hook by toggling
      const settings = this.windowCapture.settings;
      settings.method = 2; // Windows Graphics Capture
      settings.cursor = this.captureCursorEnabled;
      settings.window = token;
      this.windowCapture.enabled = false;
      this.windowCapture.update(settings);
      this.windowCapture.save();
      this.windowCapture.enabled = true;
      // After a brief delay, trigger scaling check
      setTimeout(() => this.checkAndScaleWindowSource(), this.wowHookCheckDelay);
    } catch (error) {
      // Classify and handle the error
      if (this.isObsIpcError(error)) {
        // Fatal IPC error: stop polling deterministically
        this.clearWindowCapturePolling();
        // Best-effort disable (may fail if IPC is broken)
        try {
          if (this.windowCapture) this.windowCapture.enabled = false;
        } catch (_) {}
        // Escalate to supervisor
        this.reportFatalObsError(error);
      } else {
        // Non-IPC error: log warning, continue polling on next interval
        console.warn(
          '[OBSCaptureManager] windowPollTick unexpected error, continuing polling:',
          error
        );
      }
    }
  }

  /**
   * List available monitors
   * @returns Array of monitor objects with id and name
   */
  public listMonitors(): { id: string; name: string }[] {
    const monitors: { id: string; name: string }[] = [];

    try {
      // Create or use existing monitor capture to get properties
      const source =
        this.monitorCapture || osn.InputFactory.create('monitor_capture', 'temp_monitor');

      try {
        // Find monitor property - could be 'monitor_id' or 'monitor'
        let prop = source.properties.first();
        let monitorProp: osn.IProperty | null = null;

        while (prop) {
          if (prop.name === 'monitor_id' || prop.name === 'monitor') {
            monitorProp = prop;
            break;
          }
          prop = prop.next();
        }

        if (monitorProp && this.isObsListProperty(monitorProp)) {
          const monitorList = monitorProp.details.items || [];

          monitorList.forEach((item: any, index: number) => {
            // Skip "auto" option if present
            if (
              String(item.value).toLowerCase() === 'auto' ||
              String(item.name).toLowerCase() === 'auto'
            ) {
              return;
            }

            monitors.push({
              id: String(item.value),
              name: item.name || `Monitor ${index + 1}`,
            });
          });
        }

        // If no monitors found, add at least the primary
        if (monitors.length === 0) {
          monitors.push({
            id: '0',
            name: 'Primary Monitor',
          });
        }
      } finally {
        // Clean up temp source if we created one
        if (!this.monitorCapture) {
          source.release();
        }
      }
    } catch (error) {
      console.error('[OBSCaptureManager] Error listing monitors:', error);
      // Return primary monitor as fallback
      monitors.push({
        id: '0',
        name: 'Primary Monitor',
      });
    }

    return monitors;
  }

  /**
   * Set monitor by ID
   * @param monitorId The monitor ID to select
   * @returns true if monitor was set, false on failure
   */
  public setMonitorById(monitorId: string): boolean {
    if (!this.monitorCapture) {
      return false;
    }

    try {
      const settings = this.monitorCapture.settings;

      // Detect which property name OBS uses for monitor selection
      let prop = this.monitorCapture.properties.first();
      let monitorPropName: string | null = null;
      let monitorProp: osn.IProperty | null = null;

      while (prop) {
        if (prop.name === 'monitor_id' || prop.name === 'monitor') {
          monitorPropName = prop.name;
          monitorProp = prop;
          break;
        }
        prop = prop.next();
      }

      if (!monitorPropName || !monitorProp) {
        return false;
      }

      // Check if monitor exists in available list
      const monitors = this.listMonitors();
      const monitorIndex = monitors.findIndex(m => m.id === monitorId);
      const monitorExists = monitorIndex !== -1;

      if (!monitorExists) {
        // Fall back to primary monitor
        if (monitorPropName === 'monitor_id') {
          settings.monitor_id = monitors[0]?.id || '0';
        } else {
          settings.monitor = 0;
        }
      } else {
        // Set based on the property type
        if (monitorPropName === 'monitor_id') {
          // Use the ID string directly for monitor_id property
          settings.monitor_id = monitorId;
        } else {
          // Use numeric index for monitor property
          // Get the actual list from the property to find the correct index
          if (this.isObsListProperty(monitorProp)) {
            const monitorList = monitorProp.details.items || [];
            const listIndex = monitorList.findIndex(
              (item: any) => String(item.value) === monitorId
            );
            if (listIndex !== -1) {
              settings.monitor = listIndex;
            } else {
              settings.monitor = 0;
            }
          } else {
            settings.monitor = monitorIndex;
          }
        }
      }

      this.monitorCapture.update(settings);
      this.monitorCapture.save();

      // Re-enable to apply the change if monitor capture is active
      if (this.currentCaptureMode === CaptureMode.MONITOR && this.monitorCapture.enabled) {
        this.monitorCapture.enabled = false;
        this.monitorCapture.enabled = true;
      }

      return monitorExists;
    } catch (error) {
      console.error('[OBSCaptureManager] Error setting monitor:', error);
      return false;
    }
  }

  /**
   * Set capture cursor option for the current capture mode
   * @returns true if setting was applied, false otherwise
   */
  public setCaptureCursor(enabled: boolean): boolean {
    // Update our preference
    this.captureCursorEnabled = enabled;

    // Apply to the currently active capture source
    let activeCapture: IInput | null = null;

    switch (this.currentCaptureMode) {
      case CaptureMode.GAME:
        activeCapture = this.gameCapture;
        break;
      case CaptureMode.WINDOW:
        activeCapture = this.windowCapture;
        break;
      case CaptureMode.MONITOR:
        activeCapture = this.monitorCapture;
        break;
    }

    if (activeCapture) {
      try {
        const settings = activeCapture.settings;

        // Window capture uses 'cursor' property, others use 'capture_cursor'
        if (this.currentCaptureMode === CaptureMode.WINDOW) {
          settings.cursor = enabled;
        } else {
          settings.capture_cursor = enabled;
        }

        activeCapture.update(settings);
        activeCapture.save();
      } catch (error) {
        // Cursor setting failed - non-critical
        return false;
      }
      return true;
    }
    return false;
  }

  /**
   * Enable or disable desktop audio capture
   */
  public setDesktopAudioEnabled(enabled: boolean): void {
    if (this.audioCapture) {
      this.audioCapture.enabled = enabled;
    }
  }

  /**
   * Enable or disable microphone audio capture
   */
  public setMicrophoneAudioEnabled(enabled: boolean): void {
    if (this.microphoneCapture) {
      this.microphoneCapture.enabled = enabled;
    }
  }

  /**
   * Re-scale capture sources to new video context dimensions
   * Called after video context resolution/FPS changes
   */
  public rescaleToNewDimensions(context: ReturnType<typeof osn.VideoFactory.create>): void {
    this.context = context;

    // Re-scale the currently active capture source
    switch (this.currentCaptureMode) {
      case CaptureMode.GAME:
        if (this.gameCapture?.enabled) {
          // Directly trigger re-scaling for game capture
          this.checkAndScaleSource();
        }
        break;

      case CaptureMode.WINDOW:
        if (this.windowCapture?.enabled) {
          // Directly trigger re-scaling for window capture
          this.checkAndScaleWindowSource();
        }
        break;

      case CaptureMode.MONITOR:
        // Monitor capture doesn't need scaling typically
        break;
    }
  }
}
