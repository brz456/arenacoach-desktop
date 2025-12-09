// Update Notification Manager - Handles auto-updater notifications
class UpdateNotificationManager {
    static DEV_BANNER_DELAY_MS = 1000;
    static BANNER_REMOVAL_DELAY_MS = 400; // Match CSS transition duration

    constructor() {
        this.currentBanner = null;
        this.setupEventListeners();
        this.showDevBannerIfNeeded();
    }

    setupEventListeners() {
        // Listen for update events from main process
        window.arenaCoach.updater.onUpdateAvailable((version) => {
            this.showUpdateAvailable(version);
        });

        window.arenaCoach.updater.onUpdateDownloaded(() => {
            this.showUpdateReady();
        });

        window.arenaCoach.updater.onError((message) => {
            this.showUpdateError(message);
        });
    }


    showDevBannerIfNeeded() {
        // Show permanent development banner in dev:ui mode
        if (window.app && window.app.env && window.app.env.isDevelopment) {
            setTimeout(() => {
                this.showDevBanner();
            }, UpdateNotificationManager.DEV_BANNER_DELAY_MS);
        }
    }

    showDevBanner() {
        this.removeBanner();
        
        const banner = document.createElement('div');
        banner.className = 'update-notification';
        banner.setAttribute('role', 'status');
        banner.setAttribute('aria-live', 'assertive');
        
        const content = document.createElement('div');
        content.className = 'update-content';
        
        const text = document.createElement('span');
        text.className = 'update-text';
        text.textContent = 'Restart to update [DEV MODE]';
        
        const restartBtn = document.createElement('button');
        restartBtn.className = 'update-restart-btn';
        restartBtn.textContent = 'Restart';
        
        content.append(text, restartBtn);
        banner.appendChild(content);
        document.body.appendChild(banner);
        this.currentBanner = banner;

        // Defer class application to next frame so layout settles before banner enters
        requestAnimationFrame(() => {
            const appMain = document.querySelector('.app-main');
            if (appMain) {
                appMain.classList.add('update-banner-shown');
            }
            document.body.classList.add('update-banner-shown');
        });

        // Emit event that update is ready (for dev mode)
        document.dispatchEvent(new CustomEvent('updateStateChange', { 
            detail: { isUpdateReady: true } 
        }));

        // Event handler - just show notification in dev mode
        restartBtn.addEventListener('click', () => {
            NotificationManager.show('Dev Mode: Install Update clicked', 'success', 3000);
        });

        // Animate in after layout classes are applied
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                banner.classList.add('update-notification-show');
            });
        });
    }

    showUpdateAvailable(version) {
        // Silent download - don't show banner during download phase
        // Banner will only appear when download is complete via showUpdateReady()
        console.log(`Update ${version} downloading silently...`);
    }

    showUpdateReady() {
        this.removeBanner();
        
        const banner = document.createElement('div');
        banner.className = 'update-notification';
        banner.setAttribute('role', 'status');
        banner.setAttribute('aria-live', 'assertive');
        
        const content = document.createElement('div');
        content.className = 'update-content';
        
        const text = document.createElement('span');
        text.className = 'update-text';
        text.textContent = 'New ArenaCoach version ready to install. Restart to apply changes.';
        
        const restartBtn = document.createElement('button');
        restartBtn.className = 'update-restart-btn';
        restartBtn.textContent = 'Restart';
        
        content.append(text, restartBtn);
        banner.appendChild(content);
        document.body.appendChild(banner);
        this.currentBanner = banner;

        // Defer class application to next frame so layout settles before banner enters
        requestAnimationFrame(() => {
            const appMain = document.querySelector('.app-main');
            if (appMain) {
                appMain.classList.add('update-banner-shown');
            }
            document.body.classList.add('update-banner-shown');
        });

        // Emit event that update is ready
        document.dispatchEvent(new CustomEvent('updateStateChange', { 
            detail: { isUpdateReady: true } 
        }));

        // Event handler
        restartBtn.addEventListener('click', async () => {
            try {
                await window.arenaCoach.updater.quitAndInstall();
            } catch (error) {
                console.error('Failed to install update:', error);
                NotificationManager.show('Failed to install update', 'error');
            }
        });

        // Animate in after layout classes are applied
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                banner.classList.add('update-notification-show');
            });
        });
    }

    showUpdateError(message) {
        NotificationManager.show(`Update failed: ${message}`, 'error', 6000);
    }

    removeBanner() {
        const bannerToRemove = this.currentBanner;
        if (bannerToRemove) {
            this.currentBanner = null; // Immediately clear the instance property
            
            // Remove class from app-main to remove space for banner
            const appMain = document.querySelector('.app-main');
            if (appMain) {
                appMain.classList.remove('update-banner-shown');
            }
            
            // Remove class from body to reset toast notifications
            document.body.classList.remove('update-banner-shown');
            
            // Emit event that update is no longer ready
            document.dispatchEvent(new CustomEvent('updateStateChange', { 
                detail: { isUpdateReady: false } 
            }));
            
            bannerToRemove.classList.remove('update-notification-show');
            setTimeout(() => {
                if (bannerToRemove.parentNode) {
                    bannerToRemove.parentNode.removeChild(bannerToRemove);
                }
            }, UpdateNotificationManager.BANNER_REMOVAL_DELAY_MS);
        }
    }
}