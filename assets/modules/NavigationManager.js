class NavigationManager {
    constructor(matchUI, settingsUI, sceneUI) {
        this.matchUI = matchUI; // Dependency injection instead of global coupling
        this.settingsUI = settingsUI; // Dependency injection for settings UI
        this.sceneUI = sceneUI; // Dependency injection for scene UI
        this.currentView = 'matches'; // Always show matches, filters just filter them
        this.activeFilter = 'all'; // Track current filter
        this.navigationHistory = ['matches']; // Track navigation history for back button
        this.currentHistoryIndex = 0; // Current position in history
        this.initializeNavigation();
    }

    initializeNavigation() {
        // Get navigation elements
        this.sceneTab = document.getElementById('scene-nav-tab');
        this.sceneContent = document.getElementById('scene-content');
        this.settingsTab = document.getElementById('settings-nav-tab');
        this.settingsContent = document.getElementById('settings-content');
        this.recentMatchesList = document.getElementById('recent-matches-list');

        // Add click handler to scene tab
        if (this.sceneTab) {
            this.sceneTab.addEventListener('click', (e) => this.handleSceneClick(e));
        }

        // Add click handler to settings tab
        if (this.settingsTab) {
            this.settingsTab.addEventListener('click', (e) => this.handleSettingsClick(e));
        }

        // Add click handlers to filter buttons (excluding settings)
        const filterButtons = document.querySelectorAll('.filter-btn[data-bracket]');
        filterButtons.forEach(btn => {
            btn.addEventListener('click', (e) => this.handleFilterClick(e));
        });

        // Initialize matches view as active (settings content hidden by default)
        this.showMatchesView();

        // Add mouse button 4 (back) navigation support
        this.initializeMouseNavigation();
    }

    /**
     * Initialize mouse button navigation (back/forward)
     */
    initializeMouseNavigation() {
        // Listen for mouse button events on the document
        document.addEventListener('mousedown', (e) => {
            if (e.button === 3) { // Mouse button 4 (back)
                e.preventDefault();
                this.navigateBack();
            } else if (e.button === 4) { // Mouse button 5 (forward)
                e.preventDefault();
                this.navigateForward();
            }
        });
    }

    /**
     * Add current view to navigation history
     */
    addToHistory(view) {
        // Don't add the same view consecutively
        if (this.navigationHistory[this.currentHistoryIndex] === view) {
            return;
        }

        // If we're not at the end of history (user went back then navigated),
        // remove forward history and add new entry
        if (this.currentHistoryIndex < this.navigationHistory.length - 1) {
            this.navigationHistory = this.navigationHistory.slice(0, this.currentHistoryIndex + 1);
        }

        // Add new view to history
        this.navigationHistory.push(view);
        this.currentHistoryIndex = this.navigationHistory.length - 1;

        // Limit history size to prevent memory issues
        if (this.navigationHistory.length > 50) {
            this.navigationHistory.shift();
            this.currentHistoryIndex--;
        }
    }

    /**
     * Navigate back in history using mouse button 4
     */
    navigateBack() {
        // Check if we can go back
        if (this.currentHistoryIndex <= 0) {
            return; // Already at the beginning of history
        }

        // Move back in history
        this.currentHistoryIndex--;
        const previousView = this.navigationHistory[this.currentHistoryIndex];

        // Navigate to the previous view without adding to history
        this.navigateToView(previousView, false);
    }

    /**
     * Navigate forward in history using mouse button 5
     */
    navigateForward() {
        // Check if we can go forward
        if (this.currentHistoryIndex >= this.navigationHistory.length - 1) {
            return; // Already at the end of history
        }

        // Move forward in history
        this.currentHistoryIndex++;
        const nextView = this.navigationHistory[this.currentHistoryIndex];

        // Navigate to the next view without adding to history
        this.navigateToView(nextView, false);
    }

    /**
     * Navigate to a specific view
     * @param {string} view - The view to navigate to
     * @param {boolean} addToHistory - Whether to add this navigation to history
     */
    navigateToView(view, addToHistory = true) {
        if (addToHistory) {
            this.addToHistory(view);
        }

        switch (view) {
            case 'matches':
                this.showMatchesView();
                break;
            case 'settings':
                this.showSettingsView();
                break;
            case 'scene':
                this.showSceneView();
                break;
            case 'video':
                // Video view is handled differently, so we might want to go back to matches instead
                this.showMatchesView();
                break;
            default:
                this.showMatchesView();
        }
    }

    handleSceneClick(e) {
        e.preventDefault();

        // Navigate to scene view with history tracking
        this.navigateToView('scene');
    }

    handleSettingsClick(e) {
        e.preventDefault();

        // Navigate to settings view with history tracking
        this.navigateToView('settings');
    }

    showMatchesView() {
        // Close video if present (DOM is the truth for this view)
        const videoView = document.getElementById('video-player-view');
        if (videoView && this.matchUI?.closeVideoPlayer) {
            this.matchUI.closeVideoPlayer();
        }

        this.currentView = 'matches';
        if (this.recentMatchesList) this.recentMatchesList.classList.remove('hidden');
        if (this.sceneContent) this.sceneContent.classList.add('hidden');
        if (this.settingsContent) this.settingsContent.classList.add('hidden');
        if (this.sceneTab) this.sceneTab.classList.remove('active');
        if (this.settingsTab) this.settingsTab.classList.remove('active');

        // Hide scene UI
        if (this.sceneUI) this.sceneUI.hide();

        // If no filter is active, set "All Brackets" as default
        const hasActiveFilter = document.querySelector('.filter-btn[data-bracket].active');
        if (!hasActiveFilter) {
            const allBracketsBtn = document.getElementById('all-brackets-btn');
            if (allBracketsBtn) {
                allBracketsBtn.classList.add('active');
                this.activeFilter = 'all';
            }
        }
    }

    showSceneView() {
        // Clear any active notifications (OBS preview blocks them)
        NotificationManager.clearAll();

        // Close video via matchUI to ensure proper cleanup
        const videoView = document.getElementById('video-player-view');
        if (videoView && this.matchUI?.closeVideoPlayer) {
            this.matchUI.closeVideoPlayer();
        }

        this.currentView = 'scene';
        if (this.recentMatchesList) this.recentMatchesList.classList.add('hidden');
        if (this.sceneContent) this.sceneContent.classList.remove('hidden');
        if (this.settingsContent) this.settingsContent.classList.add('hidden');
        if (this.sceneTab) this.sceneTab.classList.add('active');
        if (this.settingsTab) this.settingsTab.classList.remove('active');

        // Show scene UI
        if (this.sceneUI) this.sceneUI.show();

        // Clear all bracket button selections when showing scene
        document.querySelectorAll('.filter-btn[data-bracket]').forEach(btn => {
            btn.classList.remove('active');
        });
    }

    showSettingsView() {
        // Close video via matchUI to ensure proper cleanup
        const videoView = document.getElementById('video-player-view');
        if (videoView && this.matchUI?.closeVideoPlayer) {
            this.matchUI.closeVideoPlayer();
        }

        this.currentView = 'settings';
        if (this.recentMatchesList) this.recentMatchesList.classList.add('hidden');
        if (this.sceneContent) this.sceneContent.classList.add('hidden');
        if (this.settingsContent) this.settingsContent.classList.remove('hidden');
        if (this.sceneTab) this.sceneTab.classList.remove('active');
        if (this.settingsTab) this.settingsTab.classList.add('active');

        // Hide scene UI
        if (this.sceneUI) this.sceneUI.hide();

        // Clear all bracket button selections when showing settings
        document.querySelectorAll('.filter-btn[data-bracket]').forEach(btn => {
            btn.classList.remove('active');
        });

        // Settings UI synchronization is now handled automatically by MatchUI's single source of truth pattern
    }

    handleFilterClick(e) {
        e.preventDefault();
        const filterButton = e.currentTarget;
        const bracket = filterButton.dataset.bracket;

        // Close settings if open and show matches
        if (this.currentView === 'settings') {
            this.navigateToView('matches');
        }

        // Close scene if open and show matches
        if (this.currentView === 'scene') {
            this.navigateToView('matches');
        }

        // NEW: close video if open, then ensure matches view is shown
        if (this.currentView === 'video' && this.matchUI?.closeVideoPlayer) {
            this.matchUI.closeVideoPlayer();
            this.navigateToView('matches');
        }

        // Update active filter button
        document.querySelectorAll('.filter-btn[data-bracket]').forEach(btn => {
            btn.classList.remove('active');
        });
        filterButton.classList.add('active');

        // Update active filter
        this.activeFilter = bracket;

        // Apply filter to match list
        this.applyBracketFilter(bracket);
    }

    /**
     * Track when video player opens (called from MatchUI)
     */
    onVideoPlayerOpened() {
        this.addToHistory('video');
        this.currentView = 'video';
    }

    /**
     * Track when video player closes (called from MatchUI)
     */
    onVideoPlayerClosed() {
        // Don't add to history when closing video, just update current view
        this.currentView = 'matches';
    }

    applyBracketFilter(bracket) {
        // Apply filter through the injected match UI dependency
        if (this.matchUI) {
            // Reset all filters first
            this.matchUI.activeBrackets.clear();

            // Set the active filter for message display
            this.matchUI.activeFilter = bracket;

            // Apply new filter (unless it's "all")
            if (bracket !== 'all') {
                this.matchUI.activeBrackets.add(bracket);
            }

            // Re-apply filters and render
            this.matchUI.applyFilters();
        }
    }
}

window.NavigationManager = NavigationManager;
