// Settings UI Module
class SettingsUI {
    constructor() {
        this.currentSettings = null;
        this.isUpdateReady = false; // Track update state
        this.currentTab = 'storage'; // Track current settings tab
        this.isRecording = false; // Track recording state for UI disabling
        this.isInMatch = false; // Track match state for UI disabling
        this._isToggling = false; // Re-entry guard for recording toggle
        this.setupElements();
        this.setupEvents();
        this.loadSettings();
        this.startRecordingStateMonitoring(); // Start event-driven recording state monitoring
        this.startMatchActiveMonitoring(); // Start event-driven match state monitoring
    }

    setupElements() {
        this.maxMatchFilesInput = document.getElementById('max-match-files');
        this.resetMaxFilesBtn = document.getElementById('reset-max-files-btn');
        this.recordingLocationDisplay = document.getElementById('recording-location');
        this.browseRecordingLocationBtn = document.getElementById('browse-recording-location-btn');
        this.maxDiskStorageInput = document.getElementById('max-disk-storage');
        this.resetDiskStorageBtn = document.getElementById('reset-disk-storage-btn');
        this.diskUsageFill = document.getElementById('disk-usage-fill');
        this.diskUsageText = document.getElementById('disk-usage-text');
        this.recordingToggleBtn = document.getElementById('toggle-recording');
        this.recordingStatus = document.getElementById('recording-status');
        this.recordingIndicator = document.getElementById('recording-indicator');
        this.wowPath = document.getElementById('wow-path');
        this.browseWowBtn = document.getElementById('browse-wow');
        this.autoStartupToggle = document.getElementById('auto-startup');
        this.minimizeToTrayToggle = document.getElementById('minimize-to-tray');
        this.showMmrBadgeToggle = document.getElementById('show-mmr-badge');
        this.defaultMistakeViewToggle = document.getElementById('default-mistake-view');
        this.enableSkirmishTrackingToggle = document.getElementById('enable-skirmish-tracking');

        // Store last valid value for restoration
        this.lastValidMaxFiles = null;
        
        // Debounced auto-save function (300ms industry standard)
        this.debouncedAutoSave = this.debounce(() => this.handleAutoSave(), 300);
    }

    // Utility: Debounce function for industry-standard input handling
    debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func.apply(this, args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    setupEvents() {
        // Tab switching for Settings
        document.querySelectorAll('.settings-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                this.switchSettingsTab(e.currentTarget.dataset.tab);
            });
        });
        
        // Auto-save on input change with validation
        this.maxMatchFilesInput?.addEventListener('input', () => this.handleMaxMatchFilesInput());
        
        // Handle blur to finalize empty fields
        this.maxMatchFilesInput?.addEventListener('blur', () => this.handleMaxMatchFilesBlur());
        
        // Select all on click for easy overwriting (simpler than focus)
        this.maxMatchFilesInput?.addEventListener('click', () => this.handleMaxMatchFilesClick());
        
        this.resetMaxFilesBtn?.addEventListener('click', () => this.handleResetMaxFiles());
        this.browseRecordingLocationBtn?.addEventListener('click', () => this.handleBrowseRecordingLocation());
        this.maxDiskStorageInput?.addEventListener('input', () => this.handleMaxDiskStorageInput());
        this.resetDiskStorageBtn?.addEventListener('click', () => this.handleResetDiskStorage());
        this.recordingToggleBtn?.addEventListener('click', () => this.handleRecordingToggle());
        this.autoStartupToggle?.addEventListener('change', () => this.handleAutoStartupChange());
        this.minimizeToTrayToggle?.addEventListener('change', () => this.handleMinimizeToTrayChange());
        this.showMmrBadgeToggle?.addEventListener('change', () => this.handleShowMmrBadgeChange());
        this.defaultMistakeViewToggle?.addEventListener('change', () => this.handleDefaultMistakeViewChange());
        this.enableSkirmishTrackingToggle?.addEventListener('change', () => this.handleSkirmishTrackingChange());
    }

    async loadSettings() {
        try {
            this.currentSettings = await window.arenaCoach.settings.get();
            await this.updateForm();
        } catch (error) {
            console.error('Failed to load settings:', error);
            NotificationManager.show('Failed to load settings', 'error');
        }
    }

    async updateForm() {
        if (!this.currentSettings) return;

        this.maxMatchFilesInput.value = this.currentSettings.maxMatchFiles;
        // Store as last valid value
        this.lastValidMaxFiles = this.currentSettings.maxMatchFiles;
        
        // Update recording location display
        if (this.recordingLocationDisplay) {
            const location = this.currentSettings.recordingLocation;
            if (location && location.length > 0) {
                this.recordingLocationDisplay.textContent = location;
            } else {
                try {
                    // Ask main for the effective directory (user selection or default Videos/ArenaCoach/Recordings)
                    const effectiveDir = await window.arenaCoach.recording.getEffectiveDirectory();
                    this.recordingLocationDisplay.textContent = effectiveDir || '';
                } catch (e) {
                    console.warn('[SettingsUI] Failed to get effective recording directory:', e);
                    this.recordingLocationDisplay.textContent = '';
                }
            }
        }
        
        // Update max disk storage input
        if (this.maxDiskStorageInput) {
            this.maxDiskStorageInput.value = this.currentSettings.maxDiskStorage ?? 50;
        }
        
        // Update recording status and disk usage
        this.updateRecordingStatus();
        this.updateDiskUsage();

        // Update auto-startup toggle
        if (this.autoStartupToggle) {
            this.autoStartupToggle.checked = !!this.currentSettings.runOnStartup;
        }

        // Update minimize to tray toggle
        if (this.minimizeToTrayToggle) {
            this.minimizeToTrayToggle.checked = this.currentSettings.minimizeToTray;
        }

        // Update show MMR badge toggle
        if (this.showMmrBadgeToggle) {
            this.showMmrBadgeToggle.checked = this.currentSettings.showMmrBadge;
        }

        if (this.defaultMistakeViewToggle) {
            this.defaultMistakeViewToggle.checked = this.currentSettings.defaultMistakeView === 'mine';
        }

        if (this.enableSkirmishTrackingToggle) {
            this.enableSkirmishTrackingToggle.checked = this.currentSettings.enabledBrackets?.skirmish !== false;
        }
    }


    switchSettingsTab(tabName) {
        // Update tab buttons
        document.querySelectorAll('.settings-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === tabName);
        });
        
        // Update panels
        document.querySelectorAll('.settings-panel').forEach(panel => {
            panel.classList.toggle('active', panel.dataset.panel === tabName);
        });
        
        this.currentTab = tabName;
    }

    handleMaxMatchFilesInput() {
        const inputElement = this.maxMatchFilesInput;
        let value = inputElement.value;
        
        // Skip saving for empty values (user is typing)
        if (value === '') {
            return;
        }
        
        // Handle multiple leading zeros (UI improvement)
        if (value.length > 1 && value.startsWith('0') && !isNaN(parseInt(value, 10))) {
            const cleanValue = parseInt(value, 10).toString();
            inputElement.value = cleanValue;
            value = cleanValue;
        }
        
        // Parse and clamp the value
        const numValue = parseInt(value, 10);

        // Invalid input: restore last valid value, don't save
        if (isNaN(numValue)) {
            if (this.lastValidMaxFiles !== null) {
                inputElement.value = this.lastValidMaxFiles.toString();
            }
            return;
        }

        // Clamp to valid range
        let clampedValue = numValue;
        if (numValue < 0) {
            inputElement.value = '0';
            clampedValue = 0;
        } else if (numValue > 100000) {
            inputElement.value = '100000';
            clampedValue = 100000;
        }

        // Store the valid value and trigger debounced save
        this.lastValidMaxFiles = clampedValue;
        this.debouncedAutoSave();
    }

    handleMaxMatchFilesBlur() {
        const inputElement = this.maxMatchFilesInput;
        let value = inputElement.value;
        
        // If field is empty on blur, restore last valid value or default
        if (value === '') {
            const restoreValue = this.lastValidMaxFiles !== null ? this.lastValidMaxFiles : 1000;
            inputElement.value = restoreValue;
            this.handleAutoSave();
        }
    }

    handleMaxMatchFilesClick() {
        // Select all text when user clicks the field for easy overwriting
        this.maxMatchFilesInput.select();
    }

    async handleAutoSave() {
        const parsed = parseInt(this.maxMatchFilesInput.value, 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
            console.error('[SettingsUI] Invalid maxMatchFiles value:', this.maxMatchFilesInput.value);
            return;
        }
        const newSettings = { maxMatchFiles: parsed };

        try {
            const updateResult = await window.arenaCoach.settings.update(newSettings);
            this.currentSettings = updateResult.settings;
            // Auto-save doesn't show success notification to avoid spam
        } catch (error) {
            console.error('Failed to save settings:', error);
            const message = error instanceof Error ? error.message : String(error);
            NotificationManager.show(`Failed to save settings: ${message}`, 'error');
        }
    }

    async handleResetMaxFiles() {
        // Remove confirm dialog entirely to avoid focus issues
        this.maxMatchFilesInput.value = '1000';
        this.lastValidMaxFiles = 1000; // Update stored value
        
        await this.handleAutoSave();
    }

    async handleBrowseRecordingLocation() {
        // Prevent double-clicks during async operation
        const browseButton = this.browseRecordingLocationBtn;
        if (browseButton) {
            browseButton.disabled = true;
        }

        try {
            // Get current location from settings for default path
            const currentLocation = this.currentSettings?.recordingLocation;

            const dialogResult = await window.arenaCoach.dialogs.showOpenDialog({
                title: 'Select Recording Location',
                defaultPath: currentLocation || '',
                properties: ['openDirectory', 'createDirectory']
            });

            if (dialogResult && !dialogResult.canceled && dialogResult.filePaths.length > 0) {
                const selectedPath = dialogResult.filePaths[0];

                // Update display temporarily with selected path
                this.recordingLocationDisplay.textContent = selectedPath;

                // Save the setting
                const newSettings = {
                    recordingLocation: selectedPath
                };

                const updateResult = await window.arenaCoach.settings.update(newSettings);
                this.currentSettings = updateResult.settings;

                // Warn if live recording service update failed
                if (updateResult.recordingDirUpdateError) {
                    NotificationManager.show('Recording location saved but live update failed. Restart to apply.', 'warning');
                }

                // Update display with the actual saved path (may be sanitized if root directory)
                if (this.currentSettings.recordingLocation) {
                    this.recordingLocationDisplay.textContent = this.currentSettings.recordingLocation;

                    // If the path was sanitized, show a more specific notification
                    if (this.currentSettings.recordingLocation !== selectedPath) {
                        NotificationManager.show(`Recording location set to: ${this.currentSettings.recordingLocation}`, 'info');
                    } else if (!updateResult.recordingDirUpdateError) {
                        NotificationManager.show('Recording location updated', 'success');
                    }
                } else if (!updateResult.recordingDirUpdateError) {
                    NotificationManager.show('Recording location updated', 'success');
                }
            }
        } catch (error) {
            console.error('Failed to browse recording location:', error);
            NotificationManager.show('Failed to select recording location', 'error');
        } finally {
            // Re-enable button after operation completes
            if (browseButton) {
                browseButton.disabled = false;
            }
        }
    }


    async handleMaxDiskStorageInput() {
        if (!this.maxDiskStorageInput) return;
        
        const value = parseInt(this.maxDiskStorageInput.value, 10);
        if (isNaN(value) || value < 0) return;
        
        try {
            const updateResult = await window.arenaCoach.settings.update({
                maxDiskStorage: value
            });
            this.currentSettings = updateResult.settings;
            this.updateDiskUsage();
        } catch (error) {
            console.error('Failed to update max disk storage:', error);
        }
    }

    async handleResetDiskStorage() {
        if (this.maxDiskStorageInput) {
            this.maxDiskStorageInput.value = '50';
            await this.handleMaxDiskStorageInput();
            // handleMaxDiskStorageInput will call updateDiskUsage()
        }
    }

    async handleRecordingToggle() {
        // Prevent rapid double-clicks
        if (this._isToggling) return;
        this._isToggling = true;
        
        try {
            // Block entire UI during OBS operations
            document.body.style.pointerEvents = 'none';
            document.body.style.cursor = 'wait';
            document.getElementById('app')?.setAttribute('inert', '');
            
            // Force a repaint so cursor/text updates show before OBS work starts
            await new Promise(requestAnimationFrame);
            
            // Disable button and show loading state
            if (this.recordingToggleBtn) {
                this.recordingToggleBtn.disabled = true;
            }
            
            const isEnabled = await window.arenaCoach.recording.isEnabled();
            
            // Update button text to show operation in progress
            if (this.recordingToggleBtn) {
                this.recordingToggleBtn.textContent = isEnabled ? 'Disabling...' : 'Enabling...';
            }
            
            if (isEnabled) {
                await window.arenaCoach.recording.disable();
                await this.updateRecordingStatus();
                // Update Scene placeholder if Scene tab exists
                if (window.app?.renderer?.sceneUI) {
                    await window.app.renderer.sceneUI.updatePlaceholderVisibility();
                }
            } else {
                await window.arenaCoach.recording.enable();
                await this.updateRecordingStatus();
                // Update Scene placeholder if Scene tab exists
                if (window.app?.renderer?.sceneUI) {
                    await window.app.renderer.sceneUI.updatePlaceholderVisibility();
                }
            }
        } catch (error) {
            console.error('Failed to toggle recording:', error);
            // Restore button state on error
            await this.updateRecordingStatus();
        } finally {
            // Restore UI interaction
            document.body.style.pointerEvents = '';
            document.body.style.cursor = '';
            document.getElementById('app')?.removeAttribute('inert');
            
            // Re-enable button
            if (this.recordingToggleBtn) {
                this.recordingToggleBtn.disabled = false;
            }
            
            // Clear re-entry guard
            this._isToggling = false;
        }
    }

    async updateRecordingStatus() {
        try {
            const status = await window.arenaCoach.recording.getStatus();
            
            if (this.recordingStatus && this.recordingToggleBtn && this.recordingIndicator) {
                if (status.isEnabled) {
                    this.recordingStatus.textContent = 'Recording enabled';
                    this.recordingToggleBtn.textContent = 'Disable Recording';
                    this.recordingIndicator.className = 'status-indicator connected';
                } else {
                    this.recordingStatus.textContent = 'Recording disabled';
                    this.recordingToggleBtn.textContent = 'Enable Recording';
                    this.recordingIndicator.className = 'status-indicator disconnected';
                }
            }
        } catch (error) {
            console.error('Failed to update recording status:', error);
        }
    }

    async updateDiskUsage() {
        try {
            const status = await window.arenaCoach.recording.getStatus();
            const maxStorage = this.currentSettings?.maxDiskStorage ?? 50;

            if (this.diskUsageFill && this.diskUsageText) {
                // Validate diskUsedGB before rendering
                if (typeof status.diskUsedGB !== 'number' || !Number.isFinite(status.diskUsedGB)) {
                    this.diskUsageFill.style.width = '0%';
                    this.diskUsageFill.className = 'disk-usage-fill';
                    this.diskUsageText.textContent = 'Disk usage unavailable';
                    return;
                }
                const usedGB = status.diskUsedGB;

                if (maxStorage === 0) {
                    // No limit mode: hide progress bar, show usage only
                    this.diskUsageFill.style.width = '0%';
                    this.diskUsageFill.className = 'disk-usage-fill';
                    this.diskUsageText.textContent = `Used: ${usedGB.toFixed(1)} GB (no limit)`;
                } else {
                    const percentage = Math.max(0, Math.min((usedGB / maxStorage) * 100, 100));

                    // Update progress bar (represents used space)
                    this.diskUsageFill.style.width = `${percentage}%`;

                    // Update color based on used space
                    this.diskUsageFill.className = 'disk-usage-fill';
                    if (percentage >= 95) {
                        this.diskUsageFill.classList.add('danger'); // High usage = danger
                    } else if (percentage >= 80) {
                        this.diskUsageFill.classList.add('warning'); // High usage = warning
                    }

                    // Update text to show used space vs user limit
                    this.diskUsageText.textContent = `Used: ${usedGB.toFixed(1)} GB / ${maxStorage} GB`;
                }
            }
        } catch (error) {
            console.error('Failed to update disk usage:', error);
        }
    }

    handleBrowseWow() {
        // Trigger WoW path selection via IPC
        if (window.arenaCoach && window.arenaCoach.wow && window.arenaCoach.wow.browseInstallation) {
            window.arenaCoach.wow.browseInstallation();
        }
    }

    // Start event-driven monitoring of recording state
    startRecordingStateMonitoring() {
        // Unsubscribe first if already set
        this.stopRecordingStateMonitoring();

        // Setup event listeners for recording state changes
        this._onRecStart = window.arenaCoach.recording.onRecordingStarted(() => {
            this.isRecording = true;
            this.updateRecordingDisabledState();
        });
        
        this._onRecComplete = window.arenaCoach.recording.onRecordingCompleted(() => {
            this.isRecording = false;
            this.updateRecordingDisabledState();
        });

        // Initialize current state from backend
        this.checkInitialRecordingState();
    }

    // Stop monitoring recording state
    stopRecordingStateMonitoring() {
        if (this._onRecStart) {
            this._onRecStart();
            this._onRecStart = null;
        }
        if (this._onRecComplete) {
            this._onRecComplete();
            this._onRecComplete = null;
        }
    }

    // Check initial recording state
    async checkInitialRecordingState() {
        try {
            const status = await window.arenaCoach.recording.getStatus();
            this.isRecording = status.isRecording;
            this.updateRecordingDisabledState();
        } catch (error) {
            // Keep last-known value on IPC error (no inference)
            console.warn('[SettingsUI] Failed to get recording status, keeping last-known value:', error);
            this.updateRecordingDisabledState();
        }
    }

    // Update UI elements based on recording state
    updateRecordingDisabledState() {
        const isDisabled = this.isRecording;
        const tooltip = isDisabled ? 'Stop recording to change this setting' : '';

        const controls = [
            this.browseRecordingLocationBtn,  // id: browse-recording-location-btn
            this.maxDiskStorageInput,         // id: max-disk-storage
            this.resetDiskStorageBtn,         // id: reset-disk-storage-btn
            this.recordingToggleBtn           // id: toggle-recording (Detection/Recording setting)
        ];

        controls.forEach(el => {
            if (!el) return;
            el.disabled = isDisabled;
            el.title = tooltip;
            el.classList.toggle('disabled-while-recording', isDisabled);
        });
    }

    // Start event-driven monitoring of match state
    startMatchActiveMonitoring() {
        // Unsubscribe first if already set
        this.stopMatchActiveMonitoring();

        // Setup event listeners for match state changes
        this._onMatchStart = window.arenaCoach.match.onMatchStarted(() => {
            this.isInMatch = true;
            this.updateMatchDisabledState();
        });

        this._onMatchEnd = window.arenaCoach.match.onMatchEnded(() => {
            this.isInMatch = false;
            this.updateMatchDisabledState();
        });

        // Initialize current state from backend
        this.checkInitialMatchState();
    }

    // Stop monitoring match state
    stopMatchActiveMonitoring() {
        if (this._onMatchStart) {
            this._onMatchStart();
            this._onMatchStart = null;
        }
        if (this._onMatchEnd) {
            this._onMatchEnd();
            this._onMatchEnd = null;
        }
    }

    // Check initial match state
    async checkInitialMatchState() {
        try {
            const match = await window.arenaCoach.match.getCurrentMatch();
            this.isInMatch = !!match;
            this.updateMatchDisabledState();
        } catch (error) {
            // Keep last-known value on IPC error (no inference)
            console.warn('[SettingsUI] Failed to get current match, keeping last-known value:', error);
            this.updateMatchDisabledState();
        }
    }

    // Update UI elements based on match state
    updateMatchDisabledState() {
        const isDisabled = this.isInMatch;
        const tooltip = isDisabled ? 'Match in progress - wait for match to end' : '';

        const controls = [
            this.maxMatchFilesInput,     // id: max-match-files
            this.resetMaxFilesBtn,       // id: reset-max-files-btn
            this.browseWowBtn            // id: browse-wow
        ];

        controls.forEach(el => {
            if (!el) return;
            el.disabled = isDisabled;
            el.title = tooltip;
            el.classList.toggle('disabled-while-recording', isDisabled);
        });
    }

    async handleAutoStartupChange() {
        // Early return if no change (avoid no-op IPC call)
        const enabled = !!this.autoStartupToggle?.checked;
        if (this.currentSettings && enabled === !!this.currentSettings.runOnStartup) {
            return;
        }

        // Disable toggle during async operation to prevent race conditions
        if (this.autoStartupToggle) {
            this.autoStartupToggle.disabled = true;
        }

        try {
            const result = await window.arenaCoach.settings.update({ runOnStartup: enabled });

            if (!result?.settings) {
                throw new Error('Unexpected response: settings missing');
            }

            this.currentSettings = result.settings;
            console.log(`Auto-startup setting updated: ${enabled}`);
        } catch (error) {
            console.error('Failed to update auto-startup setting:', error);
            // Revert checkbox state on error
            if (this.autoStartupToggle && this.currentSettings) {
                this.autoStartupToggle.checked = !!this.currentSettings.runOnStartup;
            }
            NotificationManager.show('Failed to update startup setting', 'error');
        } finally {
            // Re-enable toggle after operation completes
            if (this.autoStartupToggle) {
                this.autoStartupToggle.disabled = false;
            }
        }
    }

    async handleMinimizeToTrayChange() {
        if (!this.minimizeToTrayToggle) {
            console.error('[SettingsUI] minimizeToTrayToggle element not found');
            return;
        }

        const enabled = this.minimizeToTrayToggle.checked;
        if (this.currentSettings && enabled === this.currentSettings.minimizeToTray) {
            return;
        }

        this.minimizeToTrayToggle.disabled = true;

        try {
            const result = await window.arenaCoach.settings.update({ minimizeToTray: enabled });

            if (!result?.settings) {
                throw new Error('Unexpected response: settings missing');
            }

            this.currentSettings = result.settings;
            console.log(`Minimize to tray setting updated: ${enabled}`);
        } catch (error) {
            console.error('Failed to update minimize to tray setting:', error);
            // Revert checkbox to prior state (opposite of attempted change)
            this.minimizeToTrayToggle.checked = !enabled;
            NotificationManager.show('Failed to update close behavior setting', 'error');
        } finally {
            this.minimizeToTrayToggle.disabled = false;
        }
    }

    async handleShowMmrBadgeChange() {
        if (!this.showMmrBadgeToggle) {
            console.error('[SettingsUI] showMmrBadgeToggle element not found');
            return;
        }

        const enabled = this.showMmrBadgeToggle.checked;
        if (this.currentSettings && enabled === this.currentSettings.showMmrBadge) {
            return;
        }

        this.showMmrBadgeToggle.disabled = true;

        try {
            const result = await window.arenaCoach.settings.update({ showMmrBadge: enabled });

            if (!result?.settings) {
                throw new Error('Unexpected response: settings missing');
            }

            this.currentSettings = result.settings;
            console.log(`Show MMR badge setting updated: ${enabled}`);

            this.dispatchSettingsUpdated('showMmrBadge', enabled);
        } catch (error) {
            console.error('Failed to update show MMR badge setting:', error);
            // Revert checkbox to prior state (opposite of attempted change)
            this.showMmrBadgeToggle.checked = !enabled;
            NotificationManager.show('Failed to update MMR badge setting', 'error');
        } finally {
            this.showMmrBadgeToggle.disabled = false;
        }
    }

    dispatchSettingsUpdated(key, value) {
        window.dispatchEvent(new CustomEvent('settings:updated', {
            detail: { key, value }
        }));
    }

    async handleDefaultMistakeViewChange() {
        if (!this.defaultMistakeViewToggle) {
            console.error('[SettingsUI] defaultMistakeViewToggle element not found');
            return;
        }

        const value = this.defaultMistakeViewToggle.checked ? 'mine' : 'all';

        if (this.currentSettings && value === this.currentSettings.defaultMistakeView) {
            return;
        }

        this.defaultMistakeViewToggle.disabled = true;

        try {
            const result = await window.arenaCoach.settings.update({ defaultMistakeView: value });

            if (!result?.settings) {
                throw new Error('Unexpected response: settings missing');
            }

            this.currentSettings = result.settings;
            this.dispatchSettingsUpdated('defaultMistakeView', value);
        } catch (error) {
            console.error('Failed to update default mistake view setting:', error);
            const revertValue = this.currentSettings?.defaultMistakeView || 'all';
            this.defaultMistakeViewToggle.checked = revertValue === 'mine';
            NotificationManager.show('Failed to update events default setting', 'error');
        } finally {
            this.defaultMistakeViewToggle.disabled = false;
        }
    }

    async handleSkirmishTrackingChange() {
        if (!this.enableSkirmishTrackingToggle) {
            console.error('[SettingsUI] enableSkirmishTrackingToggle element not found');
            return;
        }

        const enabled = this.enableSkirmishTrackingToggle.checked;
        const currentValue = this.currentSettings?.enabledBrackets?.skirmish;
        if (this.currentSettings && enabled === currentValue) {
            return;
        }

        this.enableSkirmishTrackingToggle.disabled = true;

        try {
            const result = await window.arenaCoach.settings.update({
                enabledBrackets: { skirmish: enabled }
            });

            if (!result?.settings) {
                throw new Error('Unexpected response: settings missing');
            }

            this.currentSettings = result.settings;
        } catch (error) {
            console.error('Failed to update skirmish tracking setting:', error);
            this.enableSkirmishTrackingToggle.checked = !enabled;
            NotificationManager.show('Failed to update skirmish setting', 'error');
        } finally {
            this.enableSkirmishTrackingToggle.disabled = false;
        }
    }

}

window.SettingsUI = SettingsUI;
