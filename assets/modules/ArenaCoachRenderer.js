class ArenaCoachRenderer {
    constructor() {
        this.initialize();
    }

    async initialize() {
        try {
            // Get app information
            const version = await window.arenaCoach.getVersion();

            // Store environment status globally for easy access
            window.app.env = await window.arenaCoach.getEnvironment();

            // App information elements may not exist in modernized UI
            const appVersionElement = document.getElementById('app-version');
            const platformInfoElement = document.getElementById('platform-info');
            if (appVersionElement) appVersionElement.textContent = `v${version}`;
            if (platformInfoElement) platformInfoElement.textContent = 'Windows';

            // Initialize modular UI components
            this.headerStatusUI = new HeaderStatusUI(); // Initialize header status first
            this.windowControls = new WindowControls(); // Initialize window controls
            this.updateNotificationManager = new UpdateNotificationManager(); // Initialize update manager
            this.authUI = new AuthUI();
            this.skillCappedVerifyUI = new SkillCappedVerifyUI(); // Initialize Skill Capped verification
            this.wowPathUI = new WoWPathUI();
            this.addonManagerUI = new AddonManagerUI();
            this.settingsUI = new SettingsUI();
            this.sceneUI = new SceneUI();
            this.matchUI = new MatchUI();

            // Initialize NavigationManager after all components are created
            this.navigationManager = new NavigationManager(this.matchUI, this.settingsUI, this.sceneUI);

            // Give MatchUI a reference to NavigationManager for video player navigation tracking
            this.matchUI.setNavigationManager(this.navigationManager);

            // Setup export logs button
            this.setupExportLogsButton();

            // Listen for navigation messages from system tray
            this.setupTrayNavigation();

            // Listen for recording retention cleanup events
            this.setupRecordingRetentionListener();

        } catch (error) {
            console.error('Failed to initialize app:', error);
            NotificationManager.show('Failed to initialize application', 'error');
        }
    }

    /**
     * Setup export logs button click handler
     */
    setupExportLogsButton() {
        const exportLogsBtn = document.getElementById('export-logs-btn');
        if (!exportLogsBtn) {
            console.error('[ArenaCoachRenderer] export-logs-btn element not found');
            return;
        }
        if (!(exportLogsBtn instanceof HTMLButtonElement)) {
            console.error('[ArenaCoachRenderer] export-logs-btn must be a button element');
            return;
        }

        const labelEl = exportLogsBtn.querySelector('.filter-label');
        const originalLabel = labelEl?.textContent ?? 'Export Logs';

        exportLogsBtn.addEventListener('click', async () => {
            try {
                exportLogsBtn.disabled = true;
                if (labelEl) labelEl.textContent = 'Exporting...';

                const result = await window.arenaCoach.logs.export();

                if (result.success) {
                    // zipPath guaranteed by discriminated union
                    const revealResult = await window.arenaCoach.shell.showItemInFolder(result.zipPath);
                    if (revealResult.success) {
                        NotificationManager.show('Logs exported and opened in file explorer', 'success');
                    } else {
                        NotificationManager.show('Logs exported to Downloads folder', 'success');
                        console.warn('[ArenaCoachRenderer] Could not reveal file:', revealResult.error, revealResult.code);
                    }
                } else {
                    // error guaranteed by discriminated union
                    NotificationManager.show(`Export failed: ${result.error}`, 'error');
                }
            } catch (error) {
                console.error('Failed to export logs:', error);
                NotificationManager.show('Failed to export logs', 'error');
            } finally {
                exportLogsBtn.disabled = false;
                if (labelEl) labelEl.textContent = originalLabel;
            }
        });
    }

    /**
     * Setup navigation from system tray context menu
     */
    setupTrayNavigation() {
        // Listen for navigation messages from the main process (tray clicks)
        window.arenaCoach.onTrayNavigation((view) => {
            if (this.navigationManager) {
                this.navigationManager.navigateToView(view);
            }
        });
    }

    /**
     * Setup listener for recording retention cleanup notifications
     */
    setupRecordingRetentionListener() {
        window.arenaCoach.recording.onRecordingRetentionCleanup((data) => {
            const { deletedCount, freedGB, maxGB } = data;
            const message = `${deletedCount} old recording(s) removed (${freedGB}GB freed) to stay under ${maxGB}GB limit`;
            NotificationManager.show(message, 'info', 6000);
        });
    }

}

window.ArenaCoachRenderer = ArenaCoachRenderer;
