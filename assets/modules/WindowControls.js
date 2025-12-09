// Window Controls for Frameless Window
class WindowControls {
    constructor() {
        this.setupElements();
        this.setupEvents();
        this.updateMaximizeButton();
    }

    setupElements() {
        this.minimizeBtn = document.getElementById('minimize-btn');
        this.maximizeBtn = document.getElementById('maximize-btn');
        this.restoreBtn = document.getElementById('restore-btn');
        this.closeBtn = document.getElementById('close-btn');
    }

    setupEvents() {
        this.minimizeBtn?.addEventListener('click', () => this.handleMinimize());
        this.maximizeBtn?.addEventListener('click', () => this.handleMaximize());
        this.restoreBtn?.addEventListener('click', () => this.handleMaximize()); // Same handler for toggle
        this.closeBtn?.addEventListener('click', () => this.handleClose());

        // Listen for window maximize state changes
        window.addEventListener('resize', () => {
            // Small delay to ensure state is updated
            setTimeout(() => this.updateMaximizeButton(), 100);
        });
    }

    async handleMinimize() {
        try {
            await window.arenaCoach.window.minimize();
        } catch (error) {
            console.error('Failed to minimize window:', error);
        }
    }

    async handleMaximize() {
        try {
            await window.arenaCoach.window.maximize();
            await this.updateMaximizeButton();
        } catch (error) {
            console.error('Failed to maximize/restore window:', error);
        }
    }

    async handleClose() {
        try {
            await window.arenaCoach.window.close();
        } catch (error) {
            console.error('Failed to close window:', error);
        }
    }

    async updateMaximizeButton() {
        try {
            const isMaximized = await window.arenaCoach.window.isMaximized();

            if (isMaximized) {
                this.maximizeBtn?.classList.add('hidden');
                this.restoreBtn?.classList.remove('hidden');
            } else {
                this.maximizeBtn?.classList.remove('hidden');
                this.restoreBtn?.classList.add('hidden');
            }
        } catch (error) {
            console.error('Failed to check window maximized state:', error);
        }
    }
}