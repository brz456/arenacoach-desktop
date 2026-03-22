// Simplified WoW Path Display
class WoWPathUI {
    constructor() {
        this.setupElements();
        this.initializeWoWPath();
    }

    setupElements() {
        this.wowPath = document.getElementById('wow-path');
        this.browseWowBtn = document.getElementById('browse-wow');

        // Setup button events
        this.browseWowBtn?.addEventListener('click', () => this.handleBrowseWoW());
    }

    setWoWPathText(text) {
        if (!this.wowPath) {
            console.error('[WoWPathUI] #wow-path element not found');
            return;
        }
        this.wowPath.textContent = text;
    }

    async initializeWoWPath() {
        try {
            const installations = await window.arenaCoach.wow.detectInstallations();
            this.updateWoWPath(installations);
        } catch (error) {
            console.error('Failed to detect WoW installations:', error);
            this.setWoWPathText('Detection Failed');
        }
    }

    updateWoWPath(installations) {
        if (installations && installations.length > 0) {
            const { combatLogPath } = installations[0];
            const logsSuffix = /[\\/]Logs[\\/]?$/;
            if (logsSuffix.test(combatLogPath)) {
                // Show flavor path (e.g., ...\World of Warcraft\_retail_)
                this.setWoWPathText(combatLogPath.replace(logsSuffix, ''));
            } else {
                console.warn('[WoWPathUI] combatLogPath does not match expected pattern:', combatLogPath);
                this.setWoWPathText(combatLogPath);
            }
        } else {
            this.setWoWPathText('No WoW Installation Found');
        }
    }

    async handleBrowseWoW() {
        try {
            const selectedPath = await window.arenaCoach.wow.browseInstallation();
            if (selectedPath) {
                const installation = await window.arenaCoach.wow.validateInstallation(selectedPath);
                if (installation) {
                    this.updateWoWPath([installation]);
                    NotificationManager.show('WoW installation found and validated!', 'success');
                } else {
                    NotificationManager.show('Invalid WoW installation selected', 'error');
                }
            }
        } catch (error) {
            console.error('Error browsing WoW installation:', error);
            NotificationManager.show('Error selecting WoW installation', 'error');
        }
    }
}