// Addon Management UI
class AddonManagerUI {
    constructor() {
        this.currentInstallations = [];
        this.addonStatusListenerCleanup = null;
        this.setupElements();
        this.setupStatusListener();
        this.initializeAddonStatus();
    }

    setupElements() {
        this.addonStatus = document.getElementById('addon-status');
        this.addonInstallBtn = document.getElementById('addon-install');

        // Setup button events
        this.addonInstallBtn?.addEventListener('click', () => this.handleAddonInstall());
    }

    /**
     * Setup IPC listener for addon status updates from main process
     * @private
     */
    setupStatusListener() {
        this.addonStatusListenerCleanup = window.arenaCoach.addon.onStatusUpdated((installations) => {
            this.handleAddonStatusUpdated(installations);
        });
    }

    /**
     * Handle addon status updates from main process
     * @private
     * @param {WoWInstallation[]} installations - Current WoW installations with addon status
     */
    handleAddonStatusUpdated(installations) {
        this.currentInstallations = installations;
        this.checkAddonStatus();
    }

    /**
     * Cleanup resources when destroying this UI component
     * @private
     */
    destroy() {
        if (this.addonStatusListenerCleanup) {
            this.addonStatusListenerCleanup();
            this.addonStatusListenerCleanup = null;
        }
    }

    async initializeAddonStatus() {
        try {
            // First get WoW installations
            const installations = await window.arenaCoach.wow.detectInstallations();
            this.currentInstallations = installations;

            if (installations.length === 0) {
                this.updateAddonStatus('No WoW Installation Found', false);
                return;
            }

            // Check addon status for all installations
            await this.checkAddonStatus();
        } catch (error) {
            console.error('Failed to initialize addon status:', error);
            this.updateAddonStatus('Status Check Failed', false);
        }
    }

    async checkAddonStatus() {
        try {
            if (this.currentInstallations.length === 0) {
                this.updateAddonStatus('No WoW Installation Found', false);
                return;
            }

            let installedCount = 0;

            // Check each installation
            for (const installation of this.currentInstallations) {
                if (installation.addonInstalled) {
                    // Double-check with validation
                    const isValid = await window.arenaCoach.addon.validateFiles(installation);
                    if (isValid) {
                        installedCount++;
                    }
                }
            }

            // Update UI based on status
            if (installedCount === this.currentInstallations.length) {
                this.updateAddonStatus('ArenaCoach Addon Installed', true);
            } else if (installedCount > 0) {
                this.updateAddonStatus(`Addon Installed (${installedCount}/${this.currentInstallations.length})`, false);
            } else {
                this.updateAddonStatus('Addon Not Installed', false);
            }
        } catch (error) {
            console.error('Error checking addon status:', error);
            this.updateAddonStatus('Status Check Failed', false);
        }
    }

    updateAddonStatus(text, isInstalled) {
        if (this.addonStatus) {
            this.addonStatus.textContent = text;
        }

        if (this.addonInstallBtn) {
            if (isInstalled) {
                this.addonInstallBtn.textContent = 'Reinstall Addon';
                this.addonInstallBtn.className = 'btn secondary small';
            } else {
                this.addonInstallBtn.textContent = 'Install Addon';
                this.addonInstallBtn.className = 'btn primary small';
            }
            // Always re-enable the button when updating status
            this.addonInstallBtn.disabled = false;
        }
    }

    async handleAddonInstall() {
        // Prevent multiple concurrent installations and provide immediate feedback
        if (this.addonInstallBtn.disabled) {
            return;
        }

        // Set in-progress state - disable interaction and show current action state
        this.addonInstallBtn.disabled = true;
        const isCurrentlyInstalled = this.addonInstallBtn.textContent === 'Reinstall Addon';
        this.addonInstallBtn.textContent = isCurrentlyInstalled ? 'Reinstalling...' : 'Installing...';

        try {
            if (this.currentInstallations.length === 0) {
                NotificationManager.show('No WoW installation found. Please browse and select your World of Warcraft installation folder in the settings above.', 'error');
                return;
            }

            let successCount = 0;
            const errors = [];

            // Install to all installations
            for (const installation of this.currentInstallations) {
                try {
                    const result = await window.arenaCoach.addon.install(installation);
                    if (result.success) {
                        successCount++;
                        console.debug(`Addon installed successfully to: ${installation.path}`);
                    } else {
                        const contextualError = this.getContextualErrorMessage(result.message, result.error);
                        errors.push(`${installation.path}: ${contextualError}`);
                        console.error(`Addon installation failed for ${installation.path}:`, result.error);
                    }
                } catch (error) {
                    errors.push(`${installation.path}: ${error.message}`);
                    console.error(`Unexpected error installing addon to ${installation.path}:`, error);
                }
            }

            // Show results notification (no manual state updates - let finally block handle UI state)
            if (successCount === this.currentInstallations.length) {
                NotificationManager.show('ArenaCoach addon installed successfully!', 'success');
            } else if (successCount > 0) {
                NotificationManager.show(`Addon installed to ${successCount}/${this.currentInstallations.length} installations. Some failed.`, 'warning');
            } else {
                // Show first error in notification, log all errors to console
                const firstError = errors.length > 0 ? errors[0] : 'Unknown error occurred';
                NotificationManager.show(`Addon installation failed: ${firstError}`, 'error');
                // Log detailed errors
                console.error('Addon installation errors:', errors);
            }

        } catch (error) {
            console.error('Error during addon installation:', error);
            NotificationManager.show('Unexpected error during addon installation. Please try again or restart the application.', 'error');
        } finally {
            // Immediately refresh the final state - no hardcoded delays, let the system determine actual state
            try {
                this.currentInstallations = await window.arenaCoach.wow.detectInstallations();
                await this.checkAddonStatus(); // Centralized state management determines final UI state
            } catch (refreshError) {
                console.error('Error refreshing addon status:', refreshError);
                // Fallback: re-enable button manually if refresh fails
                this.addonInstallBtn.disabled = false;
            }
        }
    }

    /**
     * Provide contextual error messages with actionable guidance
     */
    getContextualErrorMessage(message, error) {
        const lowerMessage = (message || '').toLowerCase();
        const lowerError = (error || '').toLowerCase();

        // Source file issues
        if (lowerMessage.includes('source addon files not found') || lowerError.includes('source addon directory not found')) {
            return 'Addon source files missing. Please reinstall the ArenaCoach application.';
        }

        if (lowerMessage.includes('source addon file not found')) {
            return 'Addon files are incomplete. Please reinstall the ArenaCoach application.';
        }

        if (lowerError.includes('corrupted files') || lowerError.includes('checksum mismatch')) {
            return 'Addon files are corrupted. Please reinstall the ArenaCoach application.';
        }

        // Permission issues
        if (lowerError.includes('permission denied') || lowerError.includes('eacces')) {
            return 'Permission denied. Try running ArenaCoach as administrator or check that World of Warcraft is not running.';
        }

        // Directory creation issues
        if (lowerMessage.includes('failed to create addon directory')) {
            return 'Cannot create addon folder. Check that World of Warcraft is not running and you have write permissions.';
        }

        // File copy issues
        if (lowerMessage.includes('failed to copy addon file')) {
            return 'Cannot copy addon files. Ensure World of Warcraft is closed and try again.';
        }

        // Path issues
        if (lowerError.includes('no such file or directory') || lowerError.includes('enoent')) {
            return 'World of Warcraft installation path is invalid. Please reselect your WoW installation folder.';
        }

        // Generic file system errors
        if (lowerError.includes('enospc')) {
            return 'Not enough disk space. Please free up space and try again.';
        }

        if (lowerError.includes('ebusy') || lowerError.includes('locked')) {
            return 'Files are in use. Please close World of Warcraft and try again.';
        }

        // Default fallback with original message
        return `${message}. ${error ? 'Please try again or contact support.' : ''}`.trim();
    }
}
