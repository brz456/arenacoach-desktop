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
            // Pass settingsUI dependency to MatchUI for proper decoupling
            this.matchUI = new MatchUI(this.settingsUI);

            // Initialize NavigationManager after all components are created
            this.navigationManager = new NavigationManager(this.matchUI, this.settingsUI, this.sceneUI);

            // Give MatchUI a reference to NavigationManager for video player navigation tracking
            this.matchUI.setNavigationManager(this.navigationManager);

            // Listen for navigation messages from system tray
            this.setupTrayNavigation();

        } catch (error) {
            console.error('Failed to initialize app:', error);
            NotificationManager.show('Failed to initialize application', 'error');
        }
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

}

window.ArenaCoachRenderer = ArenaCoachRenderer;
