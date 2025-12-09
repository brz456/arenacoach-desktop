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

    async initializeWoWPath() {
        try {
            const installations = await window.arenaCoach.wow.detectInstallations();
            this.updateWoWPath(installations);
        } catch (error) {
            console.error('Failed to detect WoW installations:', error);
            this.wowPath.textContent = 'Detection Failed';
        }
    }

    updateWoWPath(installations) {
        if (installations && installations.length > 0) {
            const primaryInstall = installations[0];
            this.wowPath.textContent = primaryInstall.path;
        } else {
            this.wowPath.textContent = 'No WoW Installation Found';
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