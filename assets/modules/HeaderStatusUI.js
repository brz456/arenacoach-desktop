class HeaderStatusUI {
    constructor() {
        this.ipcListeners = []; // Store cleanup functions for IPC listeners

        // Pure event-driven state - never query backend after initialization
        this.rendererState = {
            isInMatch: false,
            matchInfo: null, // { bracket, timestamp }
            isDetectionActive: false,
            isWoWRunning: false,
            // Freemium quota state
            quota: {
                limit: null,
                used: null,
                remaining: null,
                exhausted: false,
                entitlementMode: 'unknown', // 'skillcapped' | 'freemium' | 'unavailable' | 'unknown'
            },
        };

        this.setupElements();
        this.setupEventListeners(); // Setup BEFORE initialization
        this.initializeFromBackend(); // One-time initialization only
    }

    setupElements() {
        this.matchStatus = document.getElementById('header-match-status');
        this.matchText = document.getElementById('header-match-text');
        this.matchDot = document.getElementById('header-match-dot');

        // Service status elements for merged auth+service+quota indicator
        this.statusDot = document.getElementById('statusDot');
        this.statusIndicator = document.getElementById('statusIndicator');
        this.serviceStatusText = document.querySelector('.service-status .status-text');
    }

    async initializeFromBackend() {
        // ONLY for initial state - never during runtime
        try {
            const detectionStatus = await window.arenaCoach.match.getDetectionStatus();
            const currentMatch = await window.arenaCoach.match.getCurrentMatch();

            this.rendererState.isDetectionActive = detectionStatus?.running || false;
            this.rendererState.isWoWRunning = detectionStatus?.wowProcessStatus?.isRunning || false;
            this.rendererState.isInMatch = !!currentMatch;
            this.rendererState.matchInfo = currentMatch;


            this.renderMatchStatus(); // Pure function - no async calls
            await this.updateServiceStatusIndicator(); // Service status still needs async
            await this.fetchQuotaStatus(); // Fetch and render quota status
        } catch (error) {
            console.error('Failed to initialize renderer state:', error);
            this.renderMatchStatus(); // Still render with defaults
        }
    }


    setupEventListeners() {
        // Match lifecycle events - KEY FIX: Pure event-driven state management
        if (window.arenaCoach?.match?.onMatchStarted) {
            this.ipcListeners.push(
                window.arenaCoach.match.onMatchStarted((event) => {
                    this.rendererState.isInMatch = true;
                    this.rendererState.matchInfo = {
                        bracket: event.bracket,
                        timestamp: event.timestamp
                    };
                    this.renderMatchStatus();
                })
            );
        }

        if (window.arenaCoach?.match?.onMatchEnded) {
            this.ipcListeners.push(
                window.arenaCoach.match.onMatchEnded((_event) => {
                    // Event received - updating state
                    this.rendererState.isInMatch = false;
                    this.rendererState.matchInfo = null;
                    this.renderMatchStatus();
                })
            );
        }

        if (window.arenaCoach?.match?.onMatchEndedIncomplete) {
            this.ipcListeners.push(
                window.arenaCoach.match.onMatchEndedIncomplete((event) => {
                    // CRITICAL FIX: For double starts, a new match may have started
                    // Only set to not in match if this is a genuine end (not a double start)
                    // Double starts have trigger 'NEW_MATCH_START'
                    if (event.trigger !== 'NEW_MATCH_START') {
                        this.rendererState.isInMatch = false;
                        this.rendererState.matchInfo = null;
                    }
                    // Always render to update the UI based on current state
                    this.renderMatchStatus();
                })
            );
        }

        // WoW process events
        if (window.arenaCoach?.wow?.onProcessStart) {
            this.ipcListeners.push(
                window.arenaCoach.wow.onProcessStart(() => {
                    // Process started - updating state
                    this.rendererState.isWoWRunning = true;
                    this.renderMatchStatus();
                })
            );
        }

        if (window.arenaCoach?.wow?.onProcessStop) {
            this.ipcListeners.push(
                window.arenaCoach.wow.onProcessStop(() => {
                    // Process stopped - updating state
                    this.rendererState.isWoWRunning = false;
                    this.renderMatchStatus();
                })
            );
        }

        // Detection state events
        if (window.arenaCoach?.match?.onDetectionStarted) {
            this.ipcListeners.push(
                window.arenaCoach.match.onDetectionStarted(() => {
                    // Detection started - updating state
                    this.rendererState.isDetectionActive = true;
                    this.renderMatchStatus();
                })
            );
        }

        if (window.arenaCoach?.match?.onDetectionStopped) {
            this.ipcListeners.push(
                window.arenaCoach.match.onDetectionStopped(() => {
                    // Detection stopped - updating state
                    this.rendererState.isDetectionActive = false;
                    this.renderMatchStatus();
                })
            );
        }

        // Service status events (keep existing logic)
        this.setupServiceStatusListener();

        // Listen for auth status changes
        if (window.arenaCoach?.auth?.onAuthSuccess) {
            this.ipcListeners.push(
                window.arenaCoach.auth.onAuthSuccess(() => {
                    this.updateServiceStatus(); // Update merged auth+service status
                    this.fetchQuotaStatus(); // Refresh quota (identifier may change)
                })
            );
        }

        if (window.arenaCoach?.auth?.onLogout) {
            this.ipcListeners.push(
                window.arenaCoach.auth.onLogout(() => {
                    this.updateServiceStatus(); // Update merged auth+service status
                    this.fetchQuotaStatus(); // Refresh quota (identifier may change)
                })
            );
        }

        // Listen for analysis completion to refresh quota status
        if (window.arenaCoach?.match?.onAnalysisCompleted) {
            this.ipcListeners.push(
                window.arenaCoach.match.onAnalysisCompleted(() => {
                    this.fetchQuotaStatus(); // Quota may have changed
                })
            );
        }
    }

    renderMatchStatus() {
        // Pure function - uses only local state, no async calls or backend queries
        const { isInMatch, matchInfo, isDetectionActive, isWoWRunning } = this.rendererState;

        // Rendering status based on current state

        if (isInMatch && matchInfo) {
            // Show "In 3v3 Match" with purple dot
            this.matchStatus?.classList.add('in-progress');
            this.matchStatus?.classList.remove('active', 'ready');
            this.matchText.textContent = `In ${matchInfo.bracket || 'Match'} Match`;

            if (this.matchDot) {
                this.matchDot.className = 'status-dot in-progress';
            }
        } else if (isDetectionActive && isWoWRunning) {
            // Show "Ready" with ready dot
            this.matchStatus?.classList.add('ready');
            this.matchStatus?.classList.remove('active', 'in-progress');
            this.matchText.textContent = 'Ready';

            if (this.matchDot) {
                this.matchDot.className = 'status-dot ready';
            }
        } else if (isDetectionActive) {
            // Detection active but WoW not running - show "Idle"
            this.matchStatus?.classList.remove('active', 'in-progress', 'ready');
            this.matchText.textContent = 'Idle';

            if (this.matchDot) {
                this.matchDot.className = 'status-dot checking';
            }
        } else {
            // Detection inactive
            this.matchStatus?.classList.remove('active', 'in-progress', 'ready');
            this.matchText.textContent = 'Detection inactive';

            if (this.matchDot) {
                this.matchDot.className = 'status-dot not-authenticated';
            }
        }
    }

    /**
     * Fetches the initial service connection status and updates the UI indicator.
     * Called during HeaderStatusUI initialization to establish the current state.
     */
    async updateServiceStatus() {
        try {
            const status = await window.arenaCoach.service.getStatus();
            this.updateServiceStatusIndicator(status);
        } catch (error) {
            console.error('Failed to update service status:', error);
            this.updateServiceStatusIndicator(null); // Will fallback to not-authenticated
        }
    }

    /**
     * Updates the visual service status indicator dot and tooltip with merged auth + service logic.
     * Grey = Not authenticated, Green = Auth + Service OK, Yellow = Auth + Service Testing, Red = Auth + Service Failed
     */
    async updateServiceStatusIndicator(serviceStatus) {
        // Use instance variables if available, fallback to DOM queries
        const statusDot = this.statusDot || document.getElementById('statusDot');
        const statusIndicator = this.statusIndicator || document.getElementById('statusIndicator');
        const statusText = this.serviceStatusText || document.querySelector('.service-status .status-text');

        if (statusDot && statusIndicator) {
            try {
                // Check if user is authenticated and Skill Capped verified
                const isAuthenticated = await window.arenaCoach.auth.isAuthenticated();
                let isSkillCappedVerified = false;

                if (isAuthenticated) {
                    const user = await window.arenaCoach.auth.getCurrentUser();
                    isSkillCappedVerified = user?.is_skill_capped_verified === true;
                }

                if (isSkillCappedVerified) {
                    // Skill Capped verified - show service connection status
                    const actualServiceStatus = serviceStatus || await window.arenaCoach.service.getStatus();
                    const isConnected = !!actualServiceStatus?.connected;

                    if (isConnected) {
                        statusDot.className = 'status-dot connected';
                        statusIndicator.title = 'Service Connected';
                        if (statusText) statusText.textContent = 'Service Connected';
                    } else {
                        statusDot.className = 'status-dot disconnected';
                        statusIndicator.title = 'Service Disconnected';
                        if (statusText) statusText.textContent = 'Service Disconnected';
                    }
                } else {
                    // Non-SC user (logged in or not) - show quota status
                    const { remaining, limit, exhausted, entitlementMode } = this.rendererState.quota;

                    if (limit !== null && remaining !== null) {
                        const displayRemaining = Math.max(remaining, 0);

                        if (exhausted || displayRemaining === 0) {
                            statusDot.className = 'status-dot not-authenticated';
                            statusIndicator.title = 'Resets at midnight UTC';
                            if (statusText) statusText.textContent = `0 of ${limit} free today - verify Skill Capped for unlimited`;
                        } else {
                            statusDot.className = 'status-dot connected';
                            statusIndicator.title = 'Resets at midnight UTC';
                            if (statusText) statusText.textContent = `${displayRemaining} of ${limit} free analyses remaining today`;
                        }
                    } else if (entitlementMode === 'unavailable') {
                        // Service unavailable (fetch failed)
                        statusDot.className = 'status-dot disconnected';
                        statusIndicator.title = 'Service Unavailable';
                        if (statusText) statusText.textContent = 'Service Unavailable';
                    } else {
                        // Quota not yet loaded ('unknown') - show loading state
                        statusDot.className = 'status-dot not-authenticated';
                        statusIndicator.title = 'Loading...';
                        if (statusText) statusText.textContent = 'Loading...';
                    }
                }
            } catch (error) {
                console.error('Failed to update service status:', error);
                // Fallback - show quota if available
                const { remaining, limit } = this.rendererState.quota;
                if (limit !== null && remaining !== null) {
                    statusDot.className = 'status-dot not-authenticated';
                    if (statusText) statusText.textContent = `${Math.max(remaining, 0)} of ${limit} free analyses remaining today`;
                } else {
                    statusDot.className = 'status-dot not-authenticated';
                    if (statusText) statusText.textContent = 'Unavailable';
                }
            }
        }
    }

    /**
     * Sets up real-time service status change listener.
     * Registers the event handler for live updates and adds cleanup function to ipcListeners.
     */
    setupServiceStatusListener() {
        // Track last known connection state to detect actual changes
        let lastConnectedState = null;

        // Listen for real-time service status changes
        if (window.arenaCoach?.service?.onStatusChanged) {
            this.ipcListeners.push(
                window.arenaCoach.service.onStatusChanged((status) => {
                    const isConnected = status?.connected ?? false;

                    // Only re-fetch quota when connection state actually changes
                    if (lastConnectedState !== null && lastConnectedState !== isConnected) {
                        // When service status changes, re-fetch quota to update UI appropriately
                        // This handles both service going down (show "Service Unavailable")
                        // and service coming back up (refresh quota counts)
                        this.fetchQuotaStatus();
                    }

                    lastConnectedState = isConnected;
                })
            );
        }
    }

    /**
     * Fetches the current daily enrichment quota status from the backend.
     * Updates renderer state and refreshes service status indicator.
     */
    async fetchQuotaStatus() {
        try {
            // Check if user is authenticated and skill-capped first
            const isAuthenticated = await window.arenaCoach.auth.isAuthenticated();
            if (isAuthenticated) {
                const user = await window.arenaCoach.auth.getCurrentUser();
                if (user?.is_skill_capped_verified) {
                    // Skill Capped user - unlimited events, no quota needed
                    this.rendererState.quota = {
                        limit: null,
                        used: null,
                        remaining: null,
                        exhausted: false,
                        entitlementMode: 'skillcapped',
                    };
                    await this.updateServiceStatusIndicator();
                    return;
                }
            }

            // Fetch freemium quota for non-SkillCapped or anonymous users
            const result = await window.arenaCoach.service.getQuotaStatus();
            if (result.success && result.data) {
                this.rendererState.quota = {
                    limit: result.data.limit,
                    used: result.data.used,
                    remaining: result.data.remaining,
                    exhausted: result.data.exhausted,
                    entitlementMode: 'freemium',
                };
            } else {
                // Endpoint unavailable or error
                this.rendererState.quota = {
                    limit: null,
                    used: null,
                    remaining: null,
                    exhausted: false,
                    entitlementMode: 'unavailable',
                };
            }
            await this.updateServiceStatusIndicator();
        } catch (error) {
            console.error('Failed to fetch quota status:', error);
            // Mark as unavailable so UI shows "Service Unavailable"
            this.rendererState.quota = {
                limit: null,
                used: null,
                remaining: null,
                exhausted: false,
                entitlementMode: 'unavailable',
            };
            await this.updateServiceStatusIndicator();
        }
    }

    // Cleanup method to prevent memory leaks
    destroy() {
        this.ipcListeners.forEach(cleanup => cleanup());
        this.ipcListeners = [];
    }
}

window.HeaderStatusUI = HeaderStatusUI;
