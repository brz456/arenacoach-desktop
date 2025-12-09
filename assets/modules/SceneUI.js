// Scene UI Manager
class SceneUI {
    // Constants for default values
    static DEFAULT_CAPTURE_MODE = 'game_capture';
    static DEFAULT_FPS = '60';
    static DEFAULT_RESOLUTION = '1920x1080';
    static DEFAULT_QUALITY = 'medium';
    static DEFAULT_DESKTOP_AUDIO_ENABLED = false;
    static DEFAULT_MICROPHONE_AUDIO_ENABLED = false;
    static DEFAULT_CAPTURE_CURSOR = true;
    static DEFAULT_AUDIO_DEVICE = 'default';
    static DEFAULT_AUDIO_SUPPRESSION = true;
    static DEFAULT_FORCE_MONO = true;
    
    // Preview retry constants
    static PREVIEW_RETRY_BASE_MS = 2000;
    static PREVIEW_MAX_RETRIES = 3;
    
    // Recording state monitoring
    // Event-driven approach - no longer using polling interval
    
    // Debug logging utility (only logs in development)
    static debugLog(context, message, error) {
        if (window.app && window.app.env && window.app.env.isDevelopment) {
            if (error) {
                console.warn(`[${context}] ${message}:`, error);
            } else {
                console.log(`[${context}] ${message}`);
            }
        }
    }
    
    constructor() {
        this.isVisible = false;
        this.currentTab = 'source';
        
        // Store current values - initialize with safe defaults, will be overridden by loadSettings()
        this.captureMode = SceneUI.DEFAULT_CAPTURE_MODE;  // Safe default, will be updated by loadSettings()
        this.fps = SceneUI.DEFAULT_FPS;  // Safe default, will be updated by loadSettings()
        
        // Initialize preview retry state
        this.previewRetryAttempts = 0;
        this.previewRetryTimeoutId = null;
        
        // Recording state for UI disabling
        this.isRecording = false;
        this.recordingCheckInterval = null;
        this._bannerReflowRAF = null;
        
        this.setupElements();
        this.setupEvents();
        // Load settings from IPC on initialization
        this.loadSettings();
    }
    
    setupElements() {
        this.desktopAudioToggle = document.getElementById('desktop-audio');
        this.microphoneToggle = document.getElementById('microphone');
        this.desktopDeviceSelect = document.getElementById('desktop-audio-device');
        this.micDeviceSelect = document.getElementById('microphone-device');
        this.monitorDeviceSelect = document.getElementById('monitor-device');
        this.previewBox = document.getElementById('scene-preview-box');
        this.previewPlaceholder = this.previewBox?.querySelector('.preview-placeholder');
        this.previewInitialized = false;
        this.resizeObserver = null;
    }
    
    setupEvents() {
        // Tab switching
        document.querySelectorAll('.scene-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                this.switchTab(e.target.dataset.tab);
            });
        });
        
        // Button group handling for capture mode
        document.querySelectorAll('#capture-mode-group .button-option').forEach(btn => {
            btn.addEventListener('click', (_e) => {
                document.querySelectorAll('#capture-mode-group .button-option').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.captureMode = btn.dataset.value;
                
                // Show/hide monitor dropdown based on capture mode
                const monitorGroup = document.getElementById('monitor-selection-group');
                if (monitorGroup) {
                    if (btn.dataset.value === 'monitor_capture') {
                        monitorGroup.classList.remove('hidden');
                    } else {
                        monitorGroup.classList.add('hidden');
                    }
                }
                
                this.trackSettings();
            });
        });
        
        // Button group handling for FPS
        document.querySelectorAll('#fps-group .button-option').forEach(btn => {
            btn.addEventListener('click', (_e) => {
                document.querySelectorAll('#fps-group .button-option').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.fps = btn.dataset.value;
                this.trackSettings();
            });
        });
        
        // Audio toggle handlers
        this.desktopAudioToggle?.addEventListener('change', () => {
            this.updateAudioDeviceVisibility();
            this.trackSettings();
        });
        
        this.microphoneToggle?.addEventListener('change', () => {
            this.updateAudioDeviceVisibility();
            this.trackSettings();
        });
        
        // Hot-plug audio device refresh on dropdown interaction
        this.desktopDeviceSelect?.addEventListener('focus', () => this.refreshAudioDevicesDebounced());
        this.desktopDeviceSelect?.addEventListener('mousedown', () => this.refreshAudioDevicesDebounced());
        this.micDeviceSelect?.addEventListener('focus', () => this.refreshAudioDevicesDebounced());
        this.micDeviceSelect?.addEventListener('mousedown', () => this.refreshAudioDevicesDebounced());
        
        // Monitor device dropdown
        this.monitorDeviceSelect?.addEventListener('change', () => this.trackSettings());
        this.monitorDeviceSelect?.addEventListener('focus', () => this.refreshMonitorsDebounced());
        this.monitorDeviceSelect?.addEventListener('mousedown', () => this.refreshMonitorsDebounced());
        
        // Track other settings changes
        document.querySelectorAll('.scene-setting').forEach(element => {
            if (!element.classList.contains('button-option')) {
                element.addEventListener('change', () => this.trackSettings());
            }
        });

        // Smoothly track update banner transitions for the native OBS preview
        document.addEventListener('updateStateChange', () => {
            this._smoothPreviewReflow(600); // track for ~600ms to cover CSS transition
        });
    }
    
    switchTab(tabName) {
        // Update tab buttons
        document.querySelectorAll('.scene-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === tabName);
        });
        
        // Update panels
        document.querySelectorAll('.scene-panel').forEach(panel => {
            panel.classList.toggle('active', panel.dataset.panel === tabName);
        });
        
        this.currentTab = tabName;
    }
    
    async show() {
        this.isVisible = true;
        // Notify main process that Scene tab is active
        window.arenaCoach.scene.setActive(true);
        
        // Fetch and populate audio devices and monitors FIRST, then load settings
        // This ensures dropdown options exist before we try to select saved values
        await Promise.all([
            this.fetchAudioDevices(),
            this.fetchMonitors()
        ]);
        
        // Load settings from IPC after devices are populated
        // Await to ensure settings are applied before updating UI visibility
        await this.loadSettings();
        this.updateAudioDeviceVisibility();

        // Update placeholder visibility based on recording enabled state
        await this.updatePlaceholderVisibility();

        // Check recording status and update UI state
        await this.updateRecordingState();
        // Start periodic recording state checks
        this.startRecordingStateMonitoring();
        
        // Handle preview: re-show if already initialized, otherwise initialize
        if (this.previewInitialized) {
            try {
                const bounds = this.getPreviewBounds();
                await window.arenaCoach.obs.preview.show(bounds);
                this.setupResizeObserver();
            } catch (error) {
                SceneUI.debugLog('SceneUI', 'Failed to re-show preview', error);
            }
        } else {
            this.initializePreview();
        }
    }
    
    hide() {
        this.isVisible = false;
        // Notify main process that Scene tab is inactive
        window.arenaCoach.scene.setActive(false);
        
        // Stop recording state monitoring
        this.stopRecordingStateMonitoring();
        
        // Cancel any pending retry attempts
        if (this.previewRetryTimeoutId) {
            clearTimeout(this.previewRetryTimeoutId);
            this.previewRetryTimeoutId = null;
        }
        
        // Hide preview
        this.hidePreview();
    }
    
    async initializePreview() {
        if (!this.previewBox || this.previewInitialized) return;
        
        try {
            // Check if OBS is initialized
            const isInitialized = await window.arenaCoach.obs.isInitialized();
            if (!isInitialized) {
                // Schedule retry with exponential backoff
                this.schedulePreviewRetry();
                return;
            }
            
            // Get preview bounds and show preview
            const bounds = this.getPreviewBounds();
            await window.arenaCoach.obs.preview.show(bounds);
            this.previewInitialized = true;
            
            // Success - reset retry attempts
            this.previewRetryAttempts = 0;
            this.previewRetryTimeoutId = null;
            
            // Setup resize observer
            this.setupResizeObserver();
        } catch (error) {
            SceneUI.debugLog('SceneUI', 'Failed to initialize preview - scheduling retry', error);
            // Schedule retry with exponential backoff
            this.schedulePreviewRetry();
        }
    }
    
    schedulePreviewRetry() {
        // Check if we've exceeded max retries
        if (this.previewRetryAttempts >= SceneUI.PREVIEW_MAX_RETRIES) {
            // Preview initialization failed after maximum retries
            // Silently stop retrying - recording is likely disabled
            return;
        }
        
        // Calculate exponential backoff delay
        const backoffDelay = SceneUI.PREVIEW_RETRY_BASE_MS * Math.pow(2, this.previewRetryAttempts);
        this.previewRetryAttempts++;
        
        // Cancel any existing timeout
        if (this.previewRetryTimeoutId) {
            clearTimeout(this.previewRetryTimeoutId);
        }
        
        // Schedule retry
        this.previewRetryTimeoutId = setTimeout(() => {
            this.previewRetryTimeoutId = null;
            this.initializePreview();
        }, backoffDelay);
    }
    
    getPreviewBounds() {
        const rect = this.previewBox.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        return {
            width: Math.floor(rect.width * dpr),
            height: Math.floor(rect.height * dpr),
            x: Math.floor(rect.x * dpr),
            y: Math.floor(rect.y * dpr)
        };
    }

    // Smoothly reflow native preview while the banner animates
    _smoothPreviewReflow(durationMs = 600) {
        if (!this.isVisible || !this.previewInitialized) return;
        const start = performance.now();
        if (this._bannerReflowRAF) cancelAnimationFrame(this._bannerReflowRAF);

        const tick = (now) => {
            if (!this.isVisible || !this.previewInitialized) return;
            try {
                const bounds = this.getPreviewBounds();
                window.arenaCoach.obs.preview.updateBounds(bounds).catch(() => {});
            } catch (e) {
                SceneUI.debugLog('SceneUI', 'Preview bounds update during banner animation failed', e);
            }
            if (now - start < durationMs) {
                this._bannerReflowRAF = requestAnimationFrame(tick);
            } else {
                this._bannerReflowRAF = null;
            }
        };
        this._bannerReflowRAF = requestAnimationFrame(tick);
    }
    
    setupResizeObserver() {
        if (!this.previewBox || this.resizeObserver) return;
        
        this.resizeObserver = new ResizeObserver(() => {
            if (!this.isVisible || !this.previewInitialized) return;
            
            const bounds = this.getPreviewBounds();
            window.arenaCoach.obs.preview.updateBounds(bounds).catch(error => {
                SceneUI.debugLog('SceneUI', 'Failed to update preview bounds', error);
            });
        });
        
        this.resizeObserver.observe(this.previewBox);
    }
    
    async hidePreview() {
        if (!this.previewInitialized) return;
        
        try {
            await window.arenaCoach.obs.preview.hide();
        } catch (error) {
            SceneUI.debugLog('SceneUI', 'Failed to hide preview', error);
        }
        
        // Cleanup resize observer
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
    }
    
    updateAudioDeviceVisibility() {
        // Enable/disable device dropdowns based on audio toggles
        if (this.desktopDeviceSelect) {
            this.desktopDeviceSelect.disabled = !this.desktopAudioToggle?.checked;
        }
        
        if (this.micDeviceSelect) {
            this.micDeviceSelect.disabled = !this.microphoneToggle?.checked;
        }
    }
    
    // Refresh audio devices with debouncing (for hot-plug support)
    refreshAudioDevicesDebounced() {
        const now = Date.now();
        // Throttle to avoid spamming - 1 second minimum between refreshes
        if (this._lastDevicesRefreshAt && (now - this._lastDevicesRefreshAt) < 1000) {
            return;
        }
        this._lastDevicesRefreshAt = now;
        
        // Fire-and-forget; fetchAudioDevices handles selection restoration
        this.fetchAudioDevices();
    }
    
    // Refresh monitors with debouncing (for hot-plug support)
    refreshMonitorsDebounced() {
        const now = Date.now();
        // Throttle to avoid spamming - 1 second minimum between refreshes
        if (this._lastMonitorsRefreshAt && (now - this._lastMonitorsRefreshAt) < 1000) {
            return;
        }
        this._lastMonitorsRefreshAt = now;
        
        // Fire-and-forget; fetchMonitors handles selection restoration
        this.fetchMonitors();
    }
    
    // Fetch and populate audio devices from OBS
    async fetchAudioDevices() {
        try {
            // Only fetch if OBS is initialized
            const isInitialized = await window.arenaCoach.obs.isInitialized();
            if (!isInitialized) {
                return;
            }
            
            // Get available audio devices
            const devices = await window.arenaCoach.obs.audio.getDevices();
            
            // Store current selections
            const currentDesktopDevice = this.desktopDeviceSelect?.value || 'default';
            const currentMicDevice = this.micDeviceSelect?.value || 'default';
            
            // Populate desktop audio devices
            if (this.desktopDeviceSelect && devices.output) {
                this.desktopDeviceSelect.innerHTML = '';
                devices.output.forEach(device => {
                    const option = document.createElement('option');
                    option.value = device.id;
                    option.textContent = device.name;
                    this.desktopDeviceSelect.appendChild(option);
                });
                
                // Restore previous selection if it exists
                if (devices.output.some(d => d.id === currentDesktopDevice)) {
                    this.desktopDeviceSelect.value = currentDesktopDevice;
                }
            }
            
            // Populate microphone devices
            if (this.micDeviceSelect && devices.input) {
                this.micDeviceSelect.innerHTML = '';
                devices.input.forEach(device => {
                    const option = document.createElement('option');
                    option.value = device.id;
                    option.textContent = device.name;
                    this.micDeviceSelect.appendChild(option);
                });
                
                // Restore previous selection if it exists
                if (devices.input.some(d => d.id === currentMicDevice)) {
                    this.micDeviceSelect.value = currentMicDevice;
                }
            }
        } catch (error) {
            SceneUI.debugLog('SceneUI', 'Failed to fetch audio devices - using defaults', error);
        }
    }
    
    // Fetch and populate monitors from OBS
    async fetchMonitors() {
        try {
            // Only fetch if OBS is initialized
            const isInitialized = await window.arenaCoach.obs.isInitialized();
            if (!isInitialized) {
                return;
            }
            
            // Get available monitors
            const monitors = await window.arenaCoach.obs.display.getMonitors();
            
            // Store current selection
            const currentMonitor = this.monitorDeviceSelect?.value || '0';
            
            // Populate monitor devices
            if (this.monitorDeviceSelect && monitors) {
                this.monitorDeviceSelect.innerHTML = '';
                
                // Add monitors to dropdown
                if (monitors.length > 0) {
                    monitors.forEach(monitor => {
                        const option = document.createElement('option');
                        option.value = monitor.id;
                        option.textContent = monitor.name;
                        this.monitorDeviceSelect.appendChild(option);
                    });
                } else {
                    // Fallback if no monitors returned
                    const option = document.createElement('option');
                    option.value = '0';
                    option.textContent = 'Primary Monitor';
                    this.monitorDeviceSelect.appendChild(option);
                }
                
                // Restore previous selection if it exists
                if (monitors.some(m => m.id === currentMonitor)) {
                    this.monitorDeviceSelect.value = currentMonitor;
                }
            }
        } catch (error) {
            SceneUI.debugLog('SceneUI', 'Failed to fetch monitors - using defaults', error);
            // Add default option on error
            if (this.monitorDeviceSelect) {
                this.monitorDeviceSelect.innerHTML = '';
                const option = document.createElement('option');
                option.value = '0';
                option.textContent = 'Primary Monitor';
                this.monitorDeviceSelect.appendChild(option);
            }
        }
    }
    
    // Check recording status and update UI state
    async updateRecordingState() {
        try {
            const status = await window.arenaCoach.recording.getStatus();
            const wasRecording = this.isRecording;
            this.isRecording = status.isRecording;
            
            // Only update UI if state changed
            if (wasRecording !== this.isRecording) {
                this.updateUIDisabledState();
            }
        } catch (error) {
            SceneUI.debugLog('SceneUI', 'Failed to update recording state - assuming not recording', error);
            this.isRecording = false;
        }
    }
    
    // Start event-driven monitoring of recording state
    startRecordingStateMonitoring() {
        // Clear any existing listeners
        this.stopRecordingStateMonitoring();
        
        // Setup event listeners for recording state changes
        this.recordingStartedUnsubscribe = window.arenaCoach.recording.onRecordingStarted(() => {
            this.isRecording = true;
            this.updateUIDisabledState();
        });
        
        this.recordingCompletedUnsubscribe = window.arenaCoach.recording.onRecordingCompleted(() => {
            this.isRecording = false;
            this.updateUIDisabledState();
        });
        
        // Also check current state on initial setup
        this.updateRecordingState();
    }
    
    // Stop monitoring recording state
    stopRecordingStateMonitoring() {
        if (this.recordingStartedUnsubscribe) {
            this.recordingStartedUnsubscribe();
            this.recordingStartedUnsubscribe = null;
        }
        if (this.recordingCompletedUnsubscribe) {
            this.recordingCompletedUnsubscribe();
            this.recordingCompletedUnsubscribe = null;
        }
    }
    
    // Update placeholder visibility based on recording enabled state
    async updatePlaceholderVisibility() {
        if (!this.previewPlaceholder) return;

        try {
            const settings = await window.arenaCoach.settings.get();
            const recordingEnabled = settings.recordingEnabled !== false;

            if (recordingEnabled) {
                this.previewPlaceholder.classList.add('hidden');
            } else {
                this.previewPlaceholder.classList.remove('hidden');
            }
        } catch (error) {
            console.error('[SceneUI] Failed to update placeholder visibility:', error);
        }
    }

    // Update UI elements based on recording state
    updateUIDisabledState() {
        const isDisabled = this.isRecording;
        const tooltip = isDisabled ? 'Stop recording to change this setting' : '';
        
        // Unsafe settings that cannot be changed during recording
        const unsafeControls = [
            // Capture mode buttons
            ...document.querySelectorAll('#capture-mode-group .button-option'),
            // FPS buttons
            ...document.querySelectorAll('#fps-group .button-option'),
            // Resolution dropdown
            document.getElementById('resolution'),
            // Quality dropdown
            document.getElementById('quality'),
            // Encoder dropdown
            document.getElementById('encoder'),
            // Capture cursor toggle
            document.getElementById('capture-cursor'),
            // Audio enable/disable toggles
            document.getElementById('desktop-audio'),
            document.getElementById('microphone'),
            // Audio device dropdowns
            document.getElementById('desktop-audio-device'),
            document.getElementById('microphone-device'),
            // Monitor dropdown
            document.getElementById('monitor-device'),
            // New mic processing toggles
            document.getElementById('microphone-suppression'),
            document.getElementById('microphone-force-mono')
        ];
        
        unsafeControls.forEach(control => {
            if (!control) return;
            
            if (isDisabled) {
                control.disabled = true;
                control.classList.add('disabled-while-recording');
                control.title = tooltip;
                
                // For button groups, add disabled class
                if (control.classList.contains('button-option')) {
                    control.classList.add('button-option-disabled');
                }
            } else {
                control.disabled = false;
                control.classList.remove('disabled-while-recording');
                control.title = '';
                
                // Re-enable button groups
                if (control.classList.contains('button-option')) {
                    control.classList.remove('button-option-disabled');
                }
            }
        });
        
        // Toggle recording notice visibility
        this.toggleRecordingNotice(isDisabled);
    }
    
    // Toggle recording notice in the source tab
    toggleRecordingNotice(show) {
        const sourceTabContent = document.querySelector('.scene-tab-content[data-tab="source"]');
        if (!sourceTabContent) return;
        
        const noticeId = 'scene-recording-notice';
        let notice = document.getElementById(noticeId);
        
        if (show && !notice) {
            // Create notice element from template
            notice = document.createElement('div');
            notice.id = noticeId;
            notice.className = 'recording-notice';
            notice.textContent = '⚠️ Recording in progress - Some settings are locked';
            sourceTabContent.insertBefore(notice, sourceTabContent.firstChild);
        } else if (!show && notice) {
            // Remove notice element
            notice.remove();
        }
    }
    
    // Save settings via IPC
    async trackSettings() {
        const settings = this.getSettingsFromUI();
        try {
            await window.arenaCoach.scene.updateSettings(settings);
        } catch (error) {
            // Handle structured errors with specific messages
            const message = error?.code === 'RECORDING_ACTIVE' 
                ? 'Cannot change settings while recording'
                : 'Failed to save settings';
            NotificationManager.show(message, 'error');
        }
    }
    
    // Load settings from IPC
    async loadSettings() {
        try {
            const settings = await window.arenaCoach.scene.getSettings();
            this.applySettingsToUI(settings);
        } catch (error) {
            // Silent fail - fall back to hardcoded defaults if IPC fails
            this.loadDefaults();
        }
    }
    
    // Apply settings to UI elements
    applySettingsToUI(settings) {
        // Update button groups
        if (settings.captureMode) {
            this.captureMode = settings.captureMode;
            document.querySelectorAll('#capture-mode-group .button-option').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.value === settings.captureMode);
            });
            
            // Show/hide monitor dropdown based on capture mode
            const monitorGroup = document.getElementById('monitor-selection-group');
            if (monitorGroup) {
                if (settings.captureMode === 'monitor_capture') {
                    monitorGroup.classList.remove('hidden');
                } else {
                    monitorGroup.classList.add('hidden');
                }
            }
        }
        
        if (settings.fps !== undefined) {
            this.fps = String(settings.fps);
            document.querySelectorAll('#fps-group .button-option').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.value === String(settings.fps));
            });
        }
        
        // Update dropdowns and checkboxes
        const resolution = document.getElementById('resolution');
        const quality = document.getElementById('quality');
        const encoder = document.getElementById('encoder');
        const desktopAudio = document.getElementById('desktop-audio');
        const microphone = document.getElementById('microphone');
        const captureCursor = document.getElementById('capture-cursor');
        const desktopDevice = document.getElementById('desktop-audio-device');
        const micDevice = document.getElementById('microphone-device');
        const monitorDevice = document.getElementById('monitor-device');
        const micSuppression = document.getElementById('microphone-suppression');
        const micForceMono = document.getElementById('microphone-force-mono');
        
        if (resolution && settings.resolution) {
            if (Array.from(resolution.options).some(opt => opt.value === settings.resolution)) {
                resolution.value = settings.resolution;
            }
        }
        if (quality && settings.quality) {
            if (Array.from(quality.options).some(opt => opt.value === settings.quality)) {
                quality.value = settings.quality;
            }
        }
        if (encoder && settings.encoder) {
            if (Array.from(encoder.options).some(opt => opt.value === settings.encoder)) {
                encoder.value = settings.encoder;
            }
        }
        if (desktopAudio && settings.desktopAudioEnabled !== undefined) desktopAudio.checked = settings.desktopAudioEnabled;
        if (microphone && settings.microphoneAudioEnabled !== undefined) microphone.checked = settings.microphoneAudioEnabled;
        if (captureCursor && settings.captureCursor !== undefined) captureCursor.checked = settings.captureCursor;
        // Set audio devices only if the option exists, otherwise leave at first option (default)
        if (desktopDevice && settings.desktopAudioDevice) {
            if (Array.from(desktopDevice.options).some(opt => opt.value === settings.desktopAudioDevice)) {
                desktopDevice.value = settings.desktopAudioDevice;
            }
        }
        if (micDevice && settings.microphoneDevice) {
            if (Array.from(micDevice.options).some(opt => opt.value === settings.microphoneDevice)) {
                micDevice.value = settings.microphoneDevice;
            }
        }
        // Set monitor only if the option exists
        if (monitorDevice && settings.monitorId) {
            if (Array.from(monitorDevice.options).some(opt => opt.value === settings.monitorId)) {
                monitorDevice.value = settings.monitorId;
            }
        }
        
        if (micSuppression && settings.audioSuppressionEnabled !== undefined) {
            micSuppression.checked = !!settings.audioSuppressionEnabled;
        }
        if (micForceMono && settings.forceMonoInput !== undefined) {
            micForceMono.checked = !!settings.forceMonoInput;
        }
        this.updateAudioDeviceVisibility();
    }
    
    // Get current settings from UI with proper null checks and defaults
    getSettingsFromUI() {
        const resolutionEl = document.getElementById('resolution');
        const qualityEl = document.getElementById('quality');
        const encoderEl = document.getElementById('encoder');
        const desktopAudioEl = document.getElementById('desktop-audio');
        const desktopDeviceEl = document.getElementById('desktop-audio-device');
        const microphoneEl = document.getElementById('microphone');
        const micDeviceEl = document.getElementById('microphone-device');
        const captureCursorEl = document.getElementById('capture-cursor');
        const monitorDeviceEl = document.getElementById('monitor-device');
        const micSuppressionEl = document.getElementById('microphone-suppression');
        const micForceMonoEl = document.getElementById('microphone-force-mono');
        
        return {
            captureMode: this.captureMode || SceneUI.DEFAULT_CAPTURE_MODE,
            resolution: resolutionEl ? resolutionEl.value : SceneUI.DEFAULT_RESOLUTION,
            fps: parseInt(this.fps, 10) || parseInt(SceneUI.DEFAULT_FPS, 10),
            quality: qualityEl ? qualityEl.value : SceneUI.DEFAULT_QUALITY,
            encoder: encoderEl ? encoderEl.value : 'x264',
            desktopAudioEnabled: desktopAudioEl ? desktopAudioEl.checked : SceneUI.DEFAULT_DESKTOP_AUDIO_ENABLED,
            desktopAudioDevice: desktopDeviceEl ? desktopDeviceEl.value : SceneUI.DEFAULT_AUDIO_DEVICE,
            microphoneAudioEnabled: microphoneEl ? microphoneEl.checked : SceneUI.DEFAULT_MICROPHONE_AUDIO_ENABLED,
            microphoneDevice: micDeviceEl ? micDeviceEl.value : SceneUI.DEFAULT_AUDIO_DEVICE,
            captureCursor: captureCursorEl ? captureCursorEl.checked : SceneUI.DEFAULT_CAPTURE_CURSOR,
            monitorId: monitorDeviceEl ? monitorDeviceEl.value : '0',
            audioSuppressionEnabled: micSuppressionEl ? micSuppressionEl.checked : SceneUI.DEFAULT_AUDIO_SUPPRESSION,
            forceMonoInput: micForceMonoEl ? micForceMonoEl.checked : SceneUI.DEFAULT_FORCE_MONO
        };
    }
    
    // Fallback to hardcoded defaults
    loadDefaults() {
        // Set button group defaults
        document.querySelector(`#capture-mode-group .button-option[data-value="${SceneUI.DEFAULT_CAPTURE_MODE}"]`)?.classList.add('active');
        document.querySelector(`#fps-group .button-option[data-value="${SceneUI.DEFAULT_FPS}"]`)?.classList.add('active');
        
        // Set other defaults
        const resolution = document.getElementById('resolution');
        const quality = document.getElementById('quality');
        const desktopAudio = document.getElementById('desktop-audio');
        const microphone = document.getElementById('microphone');
        const captureCursor = document.getElementById('capture-cursor');
        
        if (resolution) resolution.value = SceneUI.DEFAULT_RESOLUTION;
        if (quality) quality.value = SceneUI.DEFAULT_QUALITY;
        if (desktopAudio) desktopAudio.checked = SceneUI.DEFAULT_DESKTOP_AUDIO_ENABLED;
        if (microphone) microphone.checked = SceneUI.DEFAULT_MICROPHONE_AUDIO_ENABLED;
        if (captureCursor) captureCursor.checked = SceneUI.DEFAULT_CAPTURE_CURSOR;
        
        this.updateAudioDeviceVisibility();
    }
    
    /**
     * Cleanup method to prevent memory leaks
     * Follows the pattern established by other UI classes
     */
    destroy() {
        // Hide handles stopping monitoring, clearing timers, and hiding preview
        this.hide();
        
        // Reset internal flags not handled by hide()
        this.previewInitialized = false;
        this.previewRetryAttempts = 0;
    }
}

window.SceneUI = SceneUI;
