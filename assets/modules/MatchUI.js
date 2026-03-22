// Match UI - Handles match display, filtering, and interactions
class MatchUI {
    /**
     * Get bracket labels from SSoT (game-data via preload).
     * Throws if preload not loaded - no silent fallbacks.
     */
    static getBracketLabels() {
        const labels = window.arenaCoach?.gameData?.BRACKET_LABELS;
        if (!labels) {
            throw new Error('[MatchUI] BRACKET_LABELS not available - preload may not have loaded');
        }
        return labels;
    }

    static getBracketDisplayNames() {
        const displayNames = window.arenaCoach?.gameData?.BRACKET_DISPLAY_NAMES;
        if (!displayNames) {
            throw new Error('[MatchUI] BRACKET_DISPLAY_NAMES not available - preload may not have loaded');
        }
        return displayNames;
    }

    /**
     * Get match duration in seconds from match metadata.
     * Solo Shuffle: derive total duration ONLY from shuffleRounds endTimestamp (ms relative to shuffle start).
     * Non-shuffle: use matchDuration when present (server-authoritative seconds).
     */
    static getMatchDurationSeconds(matchData) {
        if (!matchData) return undefined;

        const soloShuffleLabel = MatchUI.getBracketLabels().SoloShuffle;
        if (matchData.bracket === soloShuffleLabel) {
            if (!Array.isArray(matchData.shuffleRounds)) return undefined;

            const endTimestamps = matchData.shuffleRounds
                .map(r => r?.endTimestamp)
                .filter(ts => Number.isFinite(ts) && ts >= 0);

            if (endTimestamps.length === 0) return undefined;

            const maxEndTimestamp = Math.max(...endTimestamps);
            return Math.round(maxEndTimestamp / 1000);
        }

        if (Number.isFinite(matchData.matchDuration) && matchData.matchDuration >= 0) {
            return matchData.matchDuration;
        }

        return undefined;
    }

    // Filter constants
    static FILTER_FAVOURITES = 'favourites';

    // Status constants for explicit state management
    static STATUS_PENDING = 'pending';
    static STATUS_UPLOADING = 'uploading';
    static STATUS_QUEUED = 'queued';
    static STATUS_PROCESSING = 'processing';
    static STATUS_COMPLETED = 'completed';
    static STATUS_FAILED = 'failed';
    static STATUS_INCOMPLETE = 'incomplete';
    static STATUS_IN_PROGRESS = 'in_progress';
    static STATUS_EXPIRED = 'expired';
    static STATUS_NOT_FOUND = 'not_found';
    static STATUS_UNKNOWN = 'unknown';

    // Non-terminal statuses are not selectable (deletion is blocked for these states)
    static NON_SELECTABLE_STATUSES = new Set([
        MatchUI.STATUS_PENDING,
        MatchUI.STATUS_UPLOADING,
        MatchUI.STATUS_QUEUED,
        MatchUI.STATUS_PROCESSING,
        MatchUI.STATUS_IN_PROGRESS
    ]);

    static isSelectableStatus(status) {
        if (!status || status === MatchUI.STATUS_UNKNOWN) {
            return false;
        }
        return !MatchUI.NON_SELECTABLE_STATUSES.has(status);
    }

    /**
     * Get current authentication state
     * @returns {Object} Object with isAuthenticated and isPremium boolean flags
     */
    getAuthState() {
        const authState = window.app?.renderer?.authUI;
        return {
            isAuthenticated: !!authState?.isAuthenticated,
            isPremium: !!authState?.currentUser?.is_premium
        };
    }

    /**
     * Set navigation manager reference for back button support
     */
    setNavigationManager(navigationManager) {
        this.navigationManager = navigationManager;
    }

    /**
     * Populate status button with text and optional loading spinner
     * @param {HTMLElement} button - The button element to populate
     * @param {string} text - The text to display
     * @param {boolean} showSpinner - Whether to show loading spinner
     */
    static _populateStatusButton(button, text, showSpinner = false) {
        // Add accessibility attributes
        button.setAttribute('aria-label', `Status: ${text}`);

        if (showSpinner) {
            // Create loading spinner element
            const spinner = document.createElement('div');
            spinner.className = 'loading-spinner';

            // Create text span element
            const textSpan = document.createElement('span');
            textSpan.textContent = text;

            // Replace all content atomically and add busy state
            button.replaceChildren(spinner, textSpan);
            button.setAttribute('aria-busy', 'true');
        } else {
            // Just text content, remove busy state
            button.replaceChildren(text);
            button.removeAttribute('aria-busy');
        }
    }

    // Team ID constants for team identification
    static TEAM_ID_0 = '0';
    static TEAM_ID_1 = '1';

    // UI Configuration constants for infinite scroll
    static MATCHES_PER_PAGE = 25;
    static SCROLL_THRESHOLD = 200; // Pixels from bottom to trigger loading more matches
    static MAX_MATCHES_TO_DISPLAY = 500; // Max matches to keep in memory to prevent performance degradation

    // Helper function to format status text consistently
    static formatStatusText(status) {
        if (!status) return 'Unknown';
        return status.charAt(0).toUpperCase() + status.slice(1);
    }

    constructor() {
        this.isDetecting = false;
        this.currentMatch = null;
        this.recentMatches = []; // Cache for UI display
        this.filteredMatches = []; // Filtered matches for display
        this.isLoadingMatches = false;
        this.isRecording = false; // Track recording state for UI disabling
        this.isInMatch = false; // Track match state for UI disabling
        this.showMmrBadge = undefined; // Loaded from SSoT (settings) during init
        this.defaultMistakeView = 'all'; // Loaded from SSoT (settings) during init
        this.navigationManager = null; // Will be set by ArenaCoachRenderer
        // Infinite scroll state
        this.currentOffset = 0;
        this.hasMoreMatches = true;
        this.isLoadingMore = false;
        this.renderedMatchCount = 0; // Track how many matches have been rendered
        this._renderVersion = 0; // Cancels stale renders on rapid filter clicks

        // Multi-select state management
        this.selectedMatchBufferIds = new Set(); // Track selected match bufferIds
        this.selectedByDate = new Map(); // Map<dateLabel, Set<bufferId>>
        this.bulkActionsBar = null; // Reference to bulk actions UI element

        // Initialize the centralized MatchDataService to reduce coupling
        window.MatchDataService.initialize(this);
        /*
         * Two-Map Race Condition Management System
         *
         * Handles the distributed event ordering challenge where job completion events
         * may arrive before job creation events due to asynchronous processing across
         * the worker → SSE → IPC pipeline.
         *
         * - jobToMatchHashMap: Tracks active jobs waiting for completion events
         * - unprocessedCompletions: Stores completion events that arrived before creation
         *
         * This ensures deterministic behavior and prevents memory leaks regardless
         * of event arrival order in the distributed system.
         */
        this.jobToMatchHashMap = new Map(); // Jobs waiting for completion events
        this.unprocessedCompletions = new Map(); // Completion events waiting for job creation
        this.ipcListeners = []; // Store cleanup functions for IPC listeners

        // Context menu state (explicit initialization for cleanup)
        this._contextMenuCloseHandler = null;

        this.setupElements();
        this.setupEvents();
        this.setupMatchListeners();
        this.initializeStatus();
        this.startRecordingStateMonitoring(); // Start event-driven recording state monitoring
        this.startMatchActiveMonitoring(); // Start event-driven match state monitoring
        this.setupSettingsListener(); // Listen for settings changes
    }

    setupElements() {
        this.matchIndicator = document.getElementById('match-indicator');
        this.matchStatus = document.getElementById('match-status');
        this.currentMatchInfo = document.getElementById('current-match-info');
        this.toggleDetectionBtn = document.getElementById('toggle-detection');
        this.recentMatchesList = document.getElementById('recent-matches-list');

        // Modern filter state
        this.activeBrackets = new Set(); // Track active bracket filters
        this.collapsedDates = new Set(); // Track collapsed date sections
        this.activeFilter = 'all'; // Track current active filter for message display
    }

    setupEvents() {
        this.toggleDetectionBtn?.addEventListener('click', () => this.handleToggleDetection());

        // Infinite scroll detection
        this.recentMatchesList?.addEventListener('scroll', () => this.handleScroll());
    }

    handleScroll() {
        if (this.isLoadingMore || !this.hasMoreMatches || this.recentMatches.length >= MatchUI.MAX_MATCHES_TO_DISPLAY) return;

        const container = this.recentMatchesList;
        const scrollBottom = container.scrollTop + container.clientHeight;
        const scrollHeight = container.scrollHeight;

        // Load more when within threshold pixels of bottom
        if (scrollHeight - scrollBottom <= MatchUI.SCROLL_THRESHOLD) {
            this.loadMoreMatches();
        }
    }

    async loadMoreMatches() {
        if (this.isLoadingMore || !this.hasMoreMatches) return;

        // Add loading indicator
        this.showLoadingMore();

        await window.MatchDataService.loadMore(); // Load more matches in append mode

        // Remove loading indicator
        this.hideLoadingMore();
    }

    showLoadingMore() {
        // Remove any existing loading indicator
        this.hideLoadingMore();

        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'loading-more-indicator';

        const loadingText = document.createElement('p');
        loadingText.textContent = 'Loading more matches...';
        loadingDiv.appendChild(loadingText);

        this.recentMatchesList.appendChild(loadingDiv);
    }

    hideLoadingMore() {
        const existing = this.recentMatchesList.querySelector('.loading-more-indicator');
        if (existing) {
            existing.remove();
        }
    }

    setupMatchListeners() {
        // Match detection events
        this.ipcListeners.push(
            window.arenaCoach.match.onMatchStarted((event) => {
                this.handleMatchStarted(event);
            })
        );

        // Match list refresh events (triggered by match processing)
        this.ipcListeners.push(
            window.arenaCoach.match.onMatchListNeedsRefresh(async (_event) => {
                await window.MatchDataService.refresh();
                await this.updateUI();
            })
        );

        this.ipcListeners.push(
            window.arenaCoach.match.onMatchEnded((event) => {
                this.handleMatchEnded(event);
            })
        );

        this.ipcListeners.push(
            window.arenaCoach.match.onMatchEndedIncomplete((event) => {
                this.handleMatchEndedIncomplete(event);
            })
        );

        this.ipcListeners.push(
            window.arenaCoach.match.onTimeout(({ timeoutMs }) => {
                this.handleTimeout(timeoutMs);
            })
        );

        // Track job creation to map jobId -> matchHash
        this.ipcListeners.push(
            window.arenaCoach.match.onAnalysisJobCreated(async (event) => {
                if (event.matchHash && event.jobId) {
                    // Persist 'queued' status to JSON files via IPC (Single Source of Truth)
                    try {
                        await window.arenaCoach.match.updateLiveStatus(event.matchHash, MatchUI.STATUS_QUEUED);
                    } catch (error) {
                        console.error(`Failed to persist queued status for match ${event.matchHash}:`, error);
                    }

                    // Check if completion event already arrived (race condition handling)
                    if (this.unprocessedCompletions.has(event.jobId)) {
                        const completionData = this.unprocessedCompletions.get(event.jobId);
                        this.updateMatchAnalysis(event.matchHash, completionData.status);
                        if (completionData.error) {
                            NotificationManager.show(`Analysis failed: ${completionData.error}`, 'error');
                        }
                        // Clean up - completion has been processed
                        this.unprocessedCompletions.delete(event.jobId);
                    } else {
                        // Normal case: creation before completion
                        this.jobToMatchHashMap.set(event.jobId, event.matchHash);
                    }

                    // Refresh UI to show the newly created match
                    // This ensures match cards appear when metadata files are created
                    await window.MatchDataService.refresh();
                }
            })
        );


        // Handle analysis progress - persist to JSON via Single Source of Truth pattern
        this.ipcListeners.push(
            window.arenaCoach.match.onAnalysisProgress(async (event) => {
                // Persist status changes to JSON files via IPC (Single Source of Truth)
                if (event.jobId) {
                    const matchHash = this.jobToMatchHashMap.get(event.jobId);
                    if (matchHash) {
                        try {
                            // Call IPC to persist status and progress message to JSON files
                            // Skip failure/ambiguous statuses in progress events:
                            // - 'failed': handled by analysisFailed event with error details
                            // - 'not_found': transient during warmup, terminal after warmup triggers analysisFailed
                            if (event.status === 'failed' || event.status === 'not_found') {
                                return;
                            }

                            // Map to UI status constants (no silent fallback)
                            const statusMap = {
                                'completed': MatchUI.STATUS_COMPLETED,
                                'queued': MatchUI.STATUS_QUEUED,
                                'processing': MatchUI.STATUS_PROCESSING,
                                'pending': MatchUI.STATUS_PENDING,
                                'uploading': MatchUI.STATUS_UPLOADING
                            };
                            const statusToUse = statusMap[event.status];
                            if (!statusToUse) {
                                console.warn('[MatchUI] Unknown analysisProgress status:', event.status);
                                return; // Don't persist unknown status as processing
                            }

                            await window.arenaCoach.match.updateLiveStatus(
                                matchHash,
                                statusToUse,
                                event.message || null,
                                event.queuePosition || null,
                                event.totalInQueue || null
                            );
                        } catch (error) {
                            console.error(`Failed to persist progress for match ${matchHash}:`, error);
                            NotificationManager.show('Failed to update match status', 'error');
                        }
                    }
                }
            })
        );

        // Handle job retries - show retrying status with attempt info
        this.ipcListeners.push(
            window.arenaCoach.match.onJobRetry((event) => {
                try {
                    const { matchHash, attempt, errorType } = event;

                    // Find and update the specific status button using direct DOM manipulation
                    const statusBtn = document.getElementById(`status-persistent-${matchHash}`);
                    if (statusBtn) {
                        // Update button class for retrying state
                        statusBtn.className = 'analysis-button-inline status-retrying';

                        // Use helper method to populate button content with spinner
                        const text = `Retrying (${attempt})`;
                        MatchUI._populateStatusButton(statusBtn, text, true);
                    }

                    // Log detailed info for debugging
                    console.log(`[JobRetry] ${matchHash}: attempt ${attempt}, ${errorType} error`);
                } catch (error) {
                    console.error('Error handling job retry event:', error);
                }
            })
        );

        // Handle analysis completion - update UI after JSON files are updated
        this.ipcListeners.push(
            window.arenaCoach.match.onAnalysisCompleted(async (event) => {
                try {
                    if (event.matchHash) {
                        // Direct usage since matchHash is always present in completion events
                        const finalStatus = event.status || MatchUI.STATUS_COMPLETED;
                        await this.updateMatchAnalysis(event.matchHash, finalStatus);

                        // Handle freemium quota notifications
                        if (event.freeQuotaExhausted) {
                            this.maybeShowQuotaExhaustedModal(event);
                        } else if (event.entitlementMode === 'freemium') {
                            NotificationManager.show(
                                `This match used 1 free shuffle/3v3 analysis this week (${Math.max(event.freeQuotaRemaining, 0)} of ${event.freeQuotaLimit} free shuffle/3v3 analyses remaining).`,
                                'info'
                            );
                        }

                        // If video player is open for this match, reload to show events
                        if (this._currentVideoMatchHash === event.matchHash) {
                            await this.reloadVideoPlayer(event.matchHash);
                        }

                        // Clean up job mapping (if it exists)
                        if (event.jobId) {
                            this.jobToMatchHashMap.delete(event.jobId);
                        }
                    }
                } catch (error) {
                    console.error('Error handling analysis completion:', error);
                }
            })
        );

        // Handle analysis failures - show notification and clean up job tracking
        // UI refresh is handled by match:metadataUpdated after failure metadata is persisted
        this.ipcListeners.push(
            window.arenaCoach.match.onAnalysisFailed((event) => {
                try {
                    if (event.jobId) {
                        const matchHash = this.jobToMatchHashMap.get(event.jobId);
                        if (matchHash) {
                            // Show user-friendly notification using error badge config
                            const { long } = MatchUI.getErrorBadgeConfig(event.errorCode);
                            NotificationManager.show(`Analysis failed: ${long || event.error}`, 'error');
                            // Clean up job tracking - UI refresh handled by metadataUpdated event
                            this.jobToMatchHashMap.delete(event.jobId);
                        } else {
                            // Race condition: failure before creation
                            this.unprocessedCompletions.set(event.jobId, {
                                status: MatchUI.STATUS_FAILED,
                                error: event.error || 'Unknown error',
                                errorCode: event.errorCode
                            });
                        }
                    }
                } catch (error) {
                    console.error('Error handling analysis failure:', error);
                }
            })
        );


        // Handle status updates - update status button directly instead of full re-render
        this.ipcListeners.push(
            window.arenaCoach.match.onStatusUpdated((event) => {
                try {
                    // This handler is for live updates of non-terminal statuses.
                    // The 'completed' state is handled by onAnalysisCompleted, which triggers a full reload
                    // to ensure all metadata is present.
                    if (event.status === 'completed') {
                        // Do nothing. The onAnalysisCompleted flow will handle the re-render.
                        return;
                    }

                    // Update in-memory match object so re-opening video shows correct status
                    const matchInMemory = this.recentMatches.find(m => m.matchHash === event.matchHash);
                    if (matchInMemory) {
                        matchInMemory.uploadStatus = event.status;
                        matchInMemory.queuePosition = event.queuePosition;
                        matchInMemory.totalInQueue = event.totalInQueue;
                    }

                    // Find and update the specific status button (match cards)
                    const statusBtn = document.getElementById(`status-persistent-${event.matchHash}`);
                    if (statusBtn) {
                        // Update button class
                        statusBtn.className = `analysis-button-inline status-${event.status}`;

                        // Use helper method to populate button content
                        const text = MatchUI.formatStatusForDisplay(
                            event.status,
                            event.queuePosition,
                            event.totalInQueue
                        );
                        const showSpinner = [MatchUI.STATUS_UPLOADING, MatchUI.STATUS_PROCESSING].includes(event.status);
                        MatchUI._populateStatusButton(statusBtn, text, showSpinner);
                    }

                    // Also update video status bar if this match is currently open
                    if (this._currentVideoMatchHash && event.matchHash === this._currentVideoMatchHash) {
                        // Build a lightweight match object with live status data
                        const liveMatch = {
                            uploadStatus: event.status,
                            queuePosition: event.queuePosition,
                            totalInQueue: event.totalInQueue,
                            // Empty/default values for fields that only exist after completion
                            events: [],
                            hasEventEnrichment: false,
                            freeQuotaExhausted: false,
                        };
                        this.updateVideoEnrichmentStatus(liveMatch);
                    }

                    // If the button is not found, we do nothing. It will be rendered correctly
                    // during the next full list render. A fallback to re-render all matches here
                    // would be inefficient.
                } catch (error) {
                    console.error('Error handling status update:', error);
                }
            })
        );

        // Handle metadata updates - guaranteed refresh after failure metadata is persisted
        this.ipcListeners.push(
            window.arenaCoach.match.onMetadataUpdated(async (event) => {
                console.debug('[MatchUI] Metadata updated, refreshing UI:', event.matchHash);
                await window.MatchDataService.refresh();

                // Auto-refresh video player if the updated match is currently open
                if (this._videoPlayer && this._currentVideoMatchHash === event.matchHash) {
                    await this.reloadVideoPlayer(event.matchHash);
                }
            })
        );

        // Detection state events - sync button state with actual detection status
        this.ipcListeners.push(
            window.arenaCoach.match.onDetectionStarted(() => {
                this.isDetecting = true;
                this.updateUI();
            })
        );

        this.ipcListeners.push(
            window.arenaCoach.match.onDetectionStopped(() => {
                this.isDetecting = false;
                this.updateUI();
            })
        );
    }

    async initializeStatus() {
        // Load settings from SSoT - failure surfaces error (no silent default)
        try {
            const settings = await window.arenaCoach.settings.get();
            if (typeof settings.showMmrBadge !== 'boolean') {
                console.error('[MatchUI] Invalid showMmrBadge type from settings:', typeof settings.showMmrBadge);
                NotificationManager.show('Settings error: invalid MMR badge preference', 'error');
                // this.showMmrBadge remains undefined - badge won't render
            } else {
                this.showMmrBadge = settings.showMmrBadge;
            }

            if (settings.defaultMistakeView !== 'mine' && settings.defaultMistakeView !== 'all') {
                console.error(
                    '[MatchUI] Invalid defaultMistakeView from settings:',
                    settings.defaultMistakeView
                );
                NotificationManager.show('Settings error: invalid events default preference', 'error');
            } else {
                this.defaultMistakeView = settings.defaultMistakeView;
            }
        } catch (error) {
            console.error('[MatchUI] Failed to load settings:', error);
            NotificationManager.show('Failed to load settings', 'error');
            // this.showMmrBadge remains undefined - badge won't render
        }

        // Core initialization proceeds regardless of settings load
        try {
            const detectionStatus = await window.arenaCoach.match.getDetectionStatus();
            this.isDetecting = !!detectionStatus?.running;
            this.currentMatch = await window.arenaCoach.match.getCurrentMatch();
            await window.MatchDataService.refresh();
            await this.updateUI();
        } catch (error) {
            console.error('[MatchUI] Failed to initialize match detection status:', error);
        }
    }

    async loadRecentMatches(reset = true) {
        try {
            if (reset) {
                this.isLoadingMatches = true;
                this.currentOffset = 0;
                this.hasMoreMatches = true;
                this.recentMatches = [];
            } else {
                this.isLoadingMore = true;
            }

            const matches = await window.arenaCoach.matches.list(MatchUI.MATCHES_PER_PAGE, this.currentOffset);
            const validMatches = matches
                .map(this.convertStoredMatchToUIFormat.bind(this))
                .filter(match => match !== null);

            if (reset) {
                this.recentMatches = validMatches;
            } else {
                this.recentMatches.push(...validMatches);
            }

            // Update pagination state
            this.currentOffset += MatchUI.MATCHES_PER_PAGE;
            this.hasMoreMatches = matches.length === MatchUI.MATCHES_PER_PAGE;

        } catch (error) {
            console.error('Failed to load recent matches:', error);
            if (reset) {
                this.recentMatches = [];
            }
        } finally {
            this.isLoadingMatches = false;
            this.isLoadingMore = false;
        }
    }

    getAnalysisStatus(uploadStatus) {
        switch (uploadStatus) {
            case MatchUI.STATUS_COMPLETED:
                return MatchUI.STATUS_COMPLETED;
            case MatchUI.STATUS_FAILED:
                return MatchUI.STATUS_FAILED;
            case MatchUI.STATUS_INCOMPLETE:
                return MatchUI.STATUS_INCOMPLETE;
            case MatchUI.STATUS_EXPIRED:
                return MatchUI.STATUS_EXPIRED;
            case MatchUI.STATUS_NOT_FOUND:
                return MatchUI.STATUS_NOT_FOUND;
            case MatchUI.STATUS_PENDING:
            case MatchUI.STATUS_UPLOADING:
            case MatchUI.STATUS_QUEUED:
            case MatchUI.STATUS_PROCESSING:
            case MatchUI.STATUS_IN_PROGRESS:
                return 'analyzing';
            default:
                console.warn(`Encountered unknown upload status: "${uploadStatus}"`);
                return MatchUI.STATUS_UNKNOWN;
        }
    }

    convertStoredMatchToUIFormat(storedMatch) {
        // Validate basic structure
        if (!storedMatch || typeof storedMatch !== 'object' || !storedMatch.matchData) return null;

        // Show both complete (with matchHash) and incomplete matches (for inspection)
        // Complete matches must have matchHash for upload/analysis
        if (storedMatch.matchCompletionStatus === 'complete' && !storedMatch.matchHash) return null;

        const matchData = storedMatch.matchData;
        const matchHash = storedMatch.matchHash;

        // Match duration (seconds) - single source of truth helper
        const matchDurationSeconds = MatchUI.getMatchDurationSeconds(matchData);

        // Helper function to get team players from SSoT structure
        const getTeamPlayers = (teamId) => {
            return matchData.players ? matchData.players.filter(p => p.teamId === teamId) : [];
        };

        // Find the recording player once for reuse
        const recordingPlayer = matchData.playerId && matchData.players
            ? matchData.players.find(p => p.id === matchData.playerId)
            : null;

        // Helper function to get display MMR
        const getDisplayMMR = () => {
            // Always show average of both teams for consistency
            const team0 = matchData.team0MMR || 0;
            const team1 = matchData.team1MMR || 0;
            return Math.round((team0 + team1) / 2);
        };

        // Helper function to compute match result from SSoT
        const getMatchResult = () => {
            if (recordingPlayer && matchData.winningTeamId !== undefined) {
                return recordingPlayer.teamId === matchData.winningTeamId;
            }
            // During initial metadata, result is unknown
            return null;
        };

        // Convert stored match metadata to UI format
        const uiMatch = {
            bufferId: storedMatch.bufferId,
            matchHash: matchHash,
            timestamp: matchData.timestamp,
            bracket: matchData.bracket, // For filtering
            isFavourite: storedMatch.isFavourite === true,
            endEvent: matchDurationSeconds !== undefined ? {
                timestamp: matchData.timestamp,
                duration: matchDurationSeconds,
                matchResult: getMatchResult(),
                matchHash: matchHash
            } : null,
            analysisStatus: this.getAnalysisStatus(storedMatch.uploadStatus),
            // Map data from SSoT only
            mapId: matchData.mapId,
            // Player data from SSoT only
            playerSpecId: recordingPlayer?.specId || null,
            displayMMR: getDisplayMMR(),
            analyzed_player_overall_score: storedMatch.analyzed_player_overall_score,
            // Team composition data from SSoT
            team0_players: getTeamPlayers(0),
            team1_players: getTeamPlayers(1),
            // MMR data from SSoT
            team0MMR: matchData.team0MMR,
            team1MMR: matchData.team1MMR,
            // Player identification
            analyzedPlayerId: matchData.playerId,
            winning_team_id: matchData.winningTeamId,
            analyzed_player_win_status: getMatchResult(),
            // Match details from SSoT
            season: matchData.season,
            isRanked: matchData.isRanked,
            // Analysis UUID
            uuid: storedMatch.uuid, // UUID for delete functionality
            // Match timing
            durationSeconds: matchDurationSeconds,
            // Solo Shuffle round and round results
            // Use wins/losses from the recording player's metadata
            playerWins: recordingPlayer?.wins,
            playerLosses: recordingPlayer?.losses,
            shuffleRounds: matchData.shuffleRounds || null,
            // Events data for timeline markers
            events: matchData.events || [],
            playerId: matchData.playerId,
            players: matchData.players || [],
            // Store progress message from JSON storage for UI display
            progressMessage: storedMatch.progressMessage || null,
            // Error tracking fields for failure badges
            errorMessage: storedMatch.errorMessage || null,
            errorCode: storedMatch.errorCode || null,
            isPermanent: storedMatch.isPermanent === true,
            // Track live status from JSON storage (Single Source of Truth)
            // Priority: matchCompletionStatus takes precedence over uploadStatus
            currentStatus: (storedMatch.matchCompletionStatus === 'in_progress' ?
                MatchUI.STATUS_IN_PROGRESS :
                storedMatch.matchCompletionStatus === 'incomplete' ?
                    MatchUI.STATUS_INCOMPLETE :
                    storedMatch.uploadStatus) || MatchUI.STATUS_UNKNOWN,
            // Raw upload status for video status bar
            uploadStatus: storedMatch.uploadStatus,
            // Freemium state for video view
            entitlementMode: storedMatch.entitlementMode,
            freeQuotaExhausted: storedMatch.freeQuotaExhausted === true,
            hasEventEnrichment: storedMatch.hasEventEnrichment === true
        };

        return uiMatch;
    }

    async handleToggleDetection() {
        try {
            this.toggleDetectionBtn.disabled = true;

            if (this.isDetecting) {
                await window.arenaCoach.match.stopDetection();
                this.isDetecting = false;
                this.updateMatchStatus('Detection inactive', 'disconnected');
                this.toggleDetectionBtn.textContent = 'Start Detection';
                NotificationManager.show('Match detection stopped', 'info');

                // HeaderStatusUI updates automatically via IPC events
            } else {
                await window.arenaCoach.match.startDetection();
                this.isDetecting = true;
                this.updateMatchStatus('Detection active', 'connected');
                this.toggleDetectionBtn.textContent = 'Stop Detection';
                NotificationManager.show('Match detection started', 'success');

                // HeaderStatusUI updates automatically via IPC events
            }
        } catch (error) {
            console.error('Failed to toggle detection:', error);
            NotificationManager.show(`Failed to toggle detection: ${error}`, 'error');
        } finally {
            this.toggleDetectionBtn.disabled = false;
        }
    }

    async handleMatchStarted(event) {
        // Handle undefined/null events gracefully
        if (!event) {
            console.warn('Match started event received with no data');
            NotificationManager.show('Match started (no details available)', 'info');
            return;
        }

        this.currentMatch = event;
        this.updateUI(); // Disable detection button during match

        // HeaderStatusUI will handle its own state via events
        // Only update match list UI here 
        this.renderRecentMatches();

        // Use event data directly instead of querying backend
        const bracketName = this.formatBracketName(event?.bracket || 'Unknown');
        NotificationManager.show(`${bracketName} match started!`, 'success');
    }

    async handleMatchEnded(event) {
        // Handle undefined/null events gracefully
        if (!event) {
            console.warn('Match ended event received with no data');
            if (this.currentMatch) {
                this.currentMatch = null;
                this.updateUI(); // Re-enable detection button
                this.renderRecentMatches(); // HeaderStatusUI handles its own state
            }
            return;
        }

        this.currentMatch = null;
        this.updateUI(); // Re-enable detection button

        // Reload recent matches from storage to pick up the newly completed match
        await window.MatchDataService.refresh();

        // HeaderStatusUI will handle its own state via events - no updateUI() needed
        this.renderRecentMatches();

        // Compute match result from SSoT metadata
        let resultText = 'Match ended';
        let durationText = '';
        let isVictory = false;

        if (event.metadata) {
            // Compute match result the same way as in convertStoredMatchToUIFormat
            if (event.metadata.playerId && event.metadata.players && event.metadata.winningTeamId !== undefined) {
                const player = event.metadata.players.find(p => p.id === event.metadata.playerId);
                isVictory = player ? (player.teamId === event.metadata.winningTeamId) : false;
                resultText = isVictory ? 'Victory!' : 'Defeat';
            }

            const durationSeconds = MatchUI.getMatchDurationSeconds(event.metadata);
            if (durationSeconds !== undefined) {
                durationText = this.formatDuration(durationSeconds);
            }
        }

        const message = durationText ? `Match ended: ${resultText} (${durationText})` : `Match ended: ${resultText}`;
        NotificationManager.show(message, isVictory ? 'success' : 'info');
    }

    async handleTimeout(timeoutMs) {
        this.currentMatch = null;
        await this.updateUI();
        NotificationManager.show(`Match detection timeout - no activity detected after ${timeoutMs}ms`, 'info');
    }

    async handleMatchEndedIncomplete(event) {
        console.debug('Match ended incomplete:', event);
        this.currentMatch = null;
        this.updateUI(); // Re-enable detection button

        // HeaderStatusUI will handle its own state via events - no need for updateUI()
        // Only update match list UI here
        this.renderRecentMatches();

        // Show notification with trigger reason (centralized mapping via IPC)
        const triggerText = await this.getTriggerMessage(event.trigger);
        NotificationManager.show(`Match ended early (${triggerText})`, 'warning');
    }

    async getTriggerMessage(trigger) {
        // Use centralized trigger message from backend (single source of truth via IPC)
        return window.arenaCoach.match.getTriggerMessage(trigger);
    }

    async updateMatchAnalysis(matchHash) {
        try {
            // Reload matches from storage to get the updated analysis status
            await window.MatchDataService.refresh();
            // Update the UI to reflect the new status
            await this.updateUI();
        } catch (error) {
            console.error(`Failed to update UI for match analysis ${matchHash}:`, error);
            NotificationManager.show('Failed to update match list', 'error');
        }
    }

    updateMatchStatus(status, className) {
        // Update main UI elements
        if (this.matchStatus) {
            this.matchStatus.textContent = status;
        }
        if (this.matchIndicator) {
            this.matchIndicator.className = `status-indicator ${className}`;
        }

        // Status is now only displayed in header - settings no longer duplicate this information
    }

    async updateUI() {
        // HeaderStatusUI updates automatically via IPC events
        // Service status indicator still needs manual update for now
        if (window.app?.renderer?.headerStatusUI) {
            window.app.renderer.headerStatusUI.updateServiceStatusIndicator();
        }

        // Update detection status
        if (this.isDetecting) {
            this.updateMatchStatus('Detection active', 'connected');
            if (this.toggleDetectionBtn) this.toggleDetectionBtn.textContent = 'Stop Detection';
        } else {
            this.updateMatchStatus('Detection inactive', 'disconnected');
            if (this.toggleDetectionBtn) this.toggleDetectionBtn.textContent = 'Start Detection';
        }

        // Update current match info
        if (this.currentMatchInfo) {
            if (this.currentMatch) {
                // Get current match data with bracket info from SSoT
                const currentMatchData = await window.arenaCoach.match.getCurrentMatch();
                if (currentMatchData) {
                    const bracketName = this.formatBracketName(currentMatchData.bracket);
                    const startTime = new Date(currentMatchData.timestamp).toLocaleTimeString();
                    this.currentMatchInfo.textContent = `${bracketName} since ${startTime}`;
                } else {
                    this.currentMatchInfo.textContent = 'Active match (loading...)';
                }
            } else {
                this.currentMatchInfo.textContent = 'No active match';
            }
        }

        // Update recent matches list
        this.renderRecentMatches();
    }

    renderRecentMatches(append = false) {
        // Only clear content on initial load, not when appending
        if (!append) {
            this.recentMatchesList.innerHTML = '';
        }

        // Show loading state (only for initial load)
        if (this.isLoadingMatches && !append) {
            const loadingState = document.createElement('div');
            loadingState.className = 'empty-state';

            const loadingMessage = document.createElement('p');
            loadingMessage.textContent = 'Loading matches...';

            loadingState.appendChild(loadingMessage);
            this.recentMatchesList.appendChild(loadingState);
            return;
        }

        if (!this.recentMatches || this.recentMatches.length === 0) {
            if (!append) {
                const emptyState = document.createElement('div');
                emptyState.className = 'empty-state';

                const emptyMessage = document.createElement('p');
                emptyMessage.textContent = 'No matches detected yet';

                const hintMessage = document.createElement('p');
                hintMessage.className = 'hint';
                hintMessage.textContent = 'Arena matches will appear here when detected';

                emptyState.append(emptyMessage, hintMessage);
                this.recentMatchesList.appendChild(emptyState);
            }
            return;
        }

        // Initialize filtered matches and render
        if (!append) {
            this.filteredMatches = [...this.recentMatches];
            this.renderedMatchCount = 0; // Reset rendered count on full reload
        } else {
            // When appending, add new matches to filtered list
            this.filteredMatches = [...this.recentMatches];
        }

        this.renderFilteredMatches(append);
    }

    groupMatchesByDate(matches) {
        const today = new Date();
        const yesterday = new Date(today - 24 * 60 * 60 * 1000);

        const groups = {
            'Today': [],
            'Yesterday': [],
        };

        matches.forEach(match => {
            const matchDate = new Date(match.timestamp);
            if (this.isSameDay(matchDate, today)) {
                groups['Today'].push(match);
            } else if (this.isSameDay(matchDate, yesterday)) {
                groups['Yesterday'].push(match);
            } else {
                const dateKey = matchDate.toLocaleDateString([], { month: 'short', day: 'numeric' });
                if (!groups[dateKey]) groups[dateKey] = [];
                groups[dateKey].push(match);
            }
        });

        // Remove empty groups
        Object.keys(groups).forEach(key => {
            if (groups[key].length === 0) {
                delete groups[key];
            }
        });

        return groups;
    }

    getFilterSpecificMessage() {
        const labels = MatchUI.getBracketLabels();
        const filterMap = {
            'all': {
                main: 'No matches found',
                hint: ''
            },
            [labels.TwoVTwo]: {
                main: `No ${labels.TwoVTwo} matches found`,
                hint: ''
            },
            [labels.ThreeVThree]: {
                main: `No ${labels.ThreeVThree} matches found`,
                hint: ''
            },
            [labels.SoloShuffle]: {
                main: `No ${labels.SoloShuffle} matches found`,
                hint: ''
            },
            [labels.Skirmish]: {
                main: `No ${labels.Skirmish} matches found`,
                hint: ''
            },
            'favourites': {
                main: 'No favourited matches yet',
                hint: 'Click the star icon on any match to add it to favourites'
            },
        };

        return filterMap[this.activeFilter] || filterMap['all'];
    }

    isSameDay(date1, date2) {
        return date1.getDate() === date2.getDate() &&
            date1.getMonth() === date2.getMonth() &&
            date1.getFullYear() === date2.getFullYear();
    }

    getDateLabel(match) {
        const today = new Date();
        const yesterday = new Date(today - 24 * 60 * 60 * 1000);
        const matchDate = new Date(match.timestamp);

        if (this.isSameDay(matchDate, today)) {
            return 'Today';
        } else if (this.isSameDay(matchDate, yesterday)) {
            return 'Yesterday';
        } else {
            return matchDate.toLocaleDateString([], { month: 'short', day: 'numeric' });
        }
    }

    /**
     * Helper to apply map image fallback to card
     */
    _applyMapImageFallback(cardImage, mapId) {
        if (!mapId) return;
        const mapImagePath = AssetManager.getMapImagePath(mapId);
        if (mapImagePath) {
            cardImage.setAttribute('data-bg-image', mapImagePath);
            cardImage.classList.add('has-background');
        }
    }

    async createMatchCard(match) {
        const card = document.createElement('div');
        card.className = 'match-card';

        // Add data attribute for the match bufferId
        if (match.bufferId) {
            card.setAttribute('data-buffer-id', match.bufferId);
        }

        // Check if this match is selected
        if (this.selectedMatchBufferIds.has(match.bufferId)) {
            card.classList.add('selected');
        }

        // Create image section
        const cardImage = document.createElement('div');
        cardImage.className = 'match-card-image';

        // Add checkbox for selection (only for terminal statuses - not processing matches)
        // Processing matches cannot be deleted, so they should not be selectable
        const isSelectable =
            typeof match.bufferId === 'string' &&
            match.bufferId.length > 0 &&
            MatchUI.isSelectableStatus(match.currentStatus);

        if (isSelectable) {
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'match-checkbox';
            checkbox.setAttribute('data-buffer-id', match.bufferId);
            checkbox.setAttribute('aria-label', 'Select match');
            checkbox.checked = this.selectedMatchBufferIds.has(match.bufferId);

            // Get date label for this match
            const dateLabel = this.getDateLabel(match);

            checkbox.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent card click
                this.toggleSelectMatch(match.bufferId, dateLabel, checkbox.checked);
                card.classList.toggle('selected', checkbox.checked);
            });

            cardImage.appendChild(checkbox);
        }

        // Add star button for favourite toggle (always present, positioned after checkbox)
        const starBtn = document.createElement('button');
        starBtn.className = 'match-favourite-btn';
        if (isSelectable) {
            starBtn.classList.add('has-checkbox'); // Offset when checkbox present
        }
        if (match.isFavourite) {
            starBtn.classList.add('is-favourite');
        }
        starBtn.setAttribute('aria-label', match.isFavourite ? 'Remove from favourites' : 'Add to favourites');
        starBtn.setAttribute('title', match.isFavourite ? 'Remove from favourites' : 'Add to favourites');

        // Create star icon using AssetManager (21px)
        const starIcon = AssetManager.createSvgIcon({
            pathData: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
            width: 21,
            height: 21,
            viewBox: '0 0 24 24',
            fill: 'currentColor'
        });
        starBtn.appendChild(starIcon);

        // Add click handler
        if (match.bufferId) {
            starBtn.addEventListener('click', async (e) => {
                e.stopPropagation(); // Prevent card click

                // In-flight guard to prevent rapid double-clicks
                if (starBtn.disabled) return;
                starBtn.disabled = true;

                const nextValue = !match.isFavourite;

                try {
                    // Await IPC before updating UI state
                    await window.arenaCoach.matches.setFavourite(match.bufferId, nextValue);

                    // Update in-memory match state only after IPC succeeds
                    match.isFavourite = nextValue;

                    // Update corresponding entry in recentMatches
                    const recentMatch = this.recentMatches.find(m => m.bufferId === match.bufferId);
                    if (recentMatch) {
                        recentMatch.isFavourite = nextValue;
                    }

                    // Update button state
                    starBtn.classList.toggle('is-favourite', nextValue);
                    starBtn.setAttribute('aria-label', nextValue ? 'Remove from favourites' : 'Add to favourites');
                    starBtn.setAttribute('title', nextValue ? 'Remove from favourites' : 'Add to favourites');

                    // Only re-apply filters when on favourites view (to remove unfavourited cards)
                    // Otherwise, button state is already updated in-place - no re-render needed
                    if (this.activeFilter === MatchUI.FILTER_FAVOURITES) {
                        this.applyFilters();
                    }
                } catch (error) {
                    console.error('[MatchUI] Failed to toggle favourite:', error);
                    // Leave UI state unchanged on error
                } finally {
                    // Re-enable button after IPC completes
                    starBtn.disabled = false;
                }
            });
        } else {
            // Disable button if bufferId is missing
            starBtn.disabled = true;
            starBtn.style.cursor = 'not-allowed';
        }

        cardImage.appendChild(starBtn);

        // Try to get video thumbnail first, then fall back to map image (use bufferId)
        let thumbnailPath = null;
        if (match.bufferId) {
            try {
                thumbnailPath = await window.arenaCoach.recording.getThumbnailPath(match.bufferId);
            } catch (error) {
                console.warn('[MatchUI] Failed to get thumbnail for bufferId:', match.bufferId);
            }
        }

        if (thumbnailPath) {
            // Thumbnail exists (validated in main process), use it
            cardImage.style.backgroundImage = `url("file://${thumbnailPath.replace(/\\/g, '/')}")`;
            cardImage.style.backgroundSize = 'cover';
            cardImage.style.backgroundPosition = 'center';
            cardImage.classList.add('has-background');
        } else {
            // Fall back to map image (thumbnail missing or doesn't exist)
            this._applyMapImageFallback(cardImage, match.mapId);
        }

        // Add video preview on hover if video exists
        // Setup video preview using bufferId (works for complete and incomplete matches)
        if (match.bufferId) {
            const duration = match.durationSeconds ?? match.endEvent?.duration;
            this.setupVideoPreview(cardImage, match.bufferId, duration);
        }

        // Status overlay removed - we show victory/loss next to duration instead

        // Create MMR overlay with rank icon (bottom left) - respects showMmrBadge setting
        // Only render when explicitly true (undefined = settings not loaded)
        if (match.displayMMR && this.showMmrBadge === true) {
            const mmrOverlay = document.createElement('div');
            mmrOverlay.className = 'card-overlay bottom-left mmr-overlay';

            // Add rank icon only if rating is 1400+
            const rankIconPath = AssetManager.getRatingIconPath(match.displayMMR);
            if (rankIconPath) {
                const rankIcon = document.createElement('img');
                rankIcon.className = 'rank-icon';
                rankIcon.src = rankIconPath;
                rankIcon.alt = 'Rank';
                mmrOverlay.appendChild(rankIcon);
            }

            // Add MMR text
            const mmrText = document.createElement('span');
            mmrText.textContent = `${match.displayMMR} MMR`;

            mmrOverlay.appendChild(mmrText);
            cardImage.appendChild(mmrOverlay);
        }

        // Create duration overlay with victory/loss (bottom right)
        const duration = match.durationSeconds ?? match.endEvent?.duration;
        const hasDuration = duration != null;

        // Show overlay if we have duration OR Solo Shuffle W-L
        const soloShuffleLabel = MatchUI.getBracketLabels().SoloShuffle;
        const shouldShowOverlay = hasDuration ||
            (match.bracket === soloShuffleLabel && match.playerWins != null && match.playerLosses != null);

        if (shouldShowOverlay) {
            const durationOverlay = document.createElement('div');
            durationOverlay.className = 'card-overlay bottom-right duration-victory-overlay';

            // Create duration span if available
            let durationSpan = null;
            if (hasDuration) {
                durationSpan = document.createElement('span');
                durationSpan.className = 'duration-text';
                durationSpan.textContent = this.formatDuration(duration);
            }

            // Show rounds for Solo Shuffle, win/loss for other brackets
            if (match.bracket === soloShuffleLabel) {
                // Show playerWins-playerLosses for Solo Shuffle
                const wins = match.playerWins != null ? match.playerWins : 0;
                const losses = match.playerLosses != null ? match.playerLosses : 0;

                const roundsSpan = document.createElement('span');
                roundsSpan.className = 'victory-indicator rounds';

                const winSpan = document.createElement('span');
                winSpan.className = 'win';
                winSpan.textContent = String(wins);

                const dash = document.createTextNode('-');

                const lossSpan = document.createElement('span');
                lossSpan.className = 'loss';
                lossSpan.textContent = String(losses);

                roundsSpan.replaceChildren(winSpan, dash, lossSpan);

                durationOverlay.append(roundsSpan);
                if (durationSpan) {
                    const separator = document.createElement('span');
                    separator.textContent = ' - ';
                    separator.className = 'separator';
                    durationOverlay.append(separator, durationSpan);
                }
            } else if (match.analyzed_player_win_status === true) {
                const victorySpan = document.createElement('span');
                victorySpan.className = 'victory-indicator victory';
                victorySpan.textContent = 'Victory';

                durationOverlay.append(victorySpan);
                if (durationSpan) {
                    const separator = document.createElement('span');
                    separator.textContent = ' - ';
                    separator.className = 'separator';
                    durationOverlay.append(separator, durationSpan);
                }
            } else if (match.analyzed_player_win_status === false) {
                const victorySpan = document.createElement('span');
                victorySpan.className = 'victory-indicator loss';
                victorySpan.textContent = 'Loss';

                durationOverlay.append(victorySpan);
                if (durationSpan) {
                    const separator = document.createElement('span');
                    separator.textContent = ' - ';
                    separator.className = 'separator';
                    durationOverlay.append(separator, durationSpan);
                }
            } else if (durationSpan) {
                // Match result not determined yet - show only duration
                durationOverlay.append(durationSpan);
            }
            cardImage.appendChild(durationOverlay);
        }

        // Create persistent status overlay (always visible for processing states)
        const isProcessingState = [
            MatchUI.STATUS_PENDING,
            MatchUI.STATUS_UPLOADING,
            MatchUI.STATUS_QUEUED,
            MatchUI.STATUS_PROCESSING,
            MatchUI.STATUS_IN_PROGRESS
        ].includes(match.currentStatus);

        if (isProcessingState) {
            const persistentOverlay = document.createElement('div');
            persistentOverlay.className = 'top-right status-overlay-persistent';

            const statusBtn = document.createElement('button');
            statusBtn.id = `status-persistent-${match.matchHash}`; // Unique ID for direct updates
            statusBtn.className = `analysis-button-inline status-${match.currentStatus}`;
            statusBtn.style.cursor = 'default'; // Override cursor to indicate non-interactive

            // Use helper method to populate button content
            const text = MatchUI.formatStatusForDisplay(
                match.currentStatus,
                match.queuePosition,
                match.totalInQueue
            );
            const showSpinner = [MatchUI.STATUS_UPLOADING, MatchUI.STATUS_PROCESSING].includes(match.currentStatus);
            MatchUI._populateStatusButton(statusBtn, text, showSpinner);

            persistentOverlay.appendChild(statusBtn);
            cardImage.appendChild(persistentOverlay);
        }

        // Create hover overlay (top right) - show for completed/failed/expired actions
        // Ensure overlays are mutually exclusive - only show hover overlay when not showing persistent overlay
        const showDeleteButton = [MatchUI.STATUS_COMPLETED, MatchUI.STATUS_FAILED, MatchUI.STATUS_INCOMPLETE, MatchUI.STATUS_EXPIRED, MatchUI.STATUS_NOT_FOUND].includes(match.currentStatus);
        const showFailedButton = match.currentStatus === MatchUI.STATUS_FAILED;
        const showExpiredButton = match.currentStatus === MatchUI.STATUS_EXPIRED;
        const showNotFoundButton = match.currentStatus === MatchUI.STATUS_NOT_FOUND;
        const showIncompleteButton = match.currentStatus === MatchUI.STATUS_INCOMPLETE;
        const hasActionButtons = showDeleteButton || showFailedButton || showExpiredButton || showNotFoundButton || showIncompleteButton;

        // Only show hover overlay if not showing persistent overlay (mutually exclusive)
        if (!isProcessingState && hasActionButtons) {
            const hoverOverlay = document.createElement('div');
            hoverOverlay.className = 'top-right analysis-overlay-hover';

            // For failed matches, show error badge with details
            if (showFailedButton) {
                const { short, long } = MatchUI.getErrorBadgeConfig(match.errorCode);
                const failedBtn = document.createElement('button');
                failedBtn.className = 'analysis-button-inline status-failed';
                failedBtn.textContent = short ?? 'Failed';
                if (long) failedBtn.title = long;
                hoverOverlay.appendChild(failedBtn);
            }

            // For expired matches, show grey "Expired" button instead of analysis button
            if (showExpiredButton) {
                const expiredBtn = document.createElement('button');
                expiredBtn.className = 'analysis-button-inline status-expired';
                expiredBtn.textContent = 'Expired';
                hoverOverlay.appendChild(expiredBtn);
            }

            // For not found matches, show "Analysis Not Found" button
            if (showNotFoundButton) {
                const notFoundBtn = document.createElement('button');
                notFoundBtn.className = 'analysis-button-inline status-not_found';
                notFoundBtn.textContent = 'Analysis Not Found';
                notFoundBtn.title = 'Analysis not found on server (likely removed due to deduplication)';
                hoverOverlay.appendChild(notFoundBtn);
            }

            // For incomplete matches, show "Incomplete" button
            if (showIncompleteButton) {
                const incompleteBtn = document.createElement('button');
                incompleteBtn.className = 'analysis-button-inline status-incomplete';
                incompleteBtn.textContent = 'Incomplete';
                incompleteBtn.title = 'Match ended early and was not fully analyzed';
                hoverOverlay.appendChild(incompleteBtn);
            }

            // For completed matches: show events count or quota exhausted badge
            if (match.currentStatus === MatchUI.STATUS_COMPLETED) {
                if (match.freeQuotaExhausted === true) {
                    // Quota exhausted badge (yellow/amber)
                    const quotaBtn = document.createElement('button');
                    quotaBtn.className = 'analysis-button-inline status-quota-exhausted';
                    quotaBtn.textContent = 'Shuffle/3v3 Quota Reached';
                    quotaBtn.title = 'Weekly free shuffle/3v3 quota was exhausted - events not available';
                    hoverOverlay.appendChild(quotaBtn);
                } else if (match.hasEventEnrichment || (match.events && match.events.length > 0)) {
                    // Count total events across all categories
                    const totalEvents = (match.events || []).reduce(
                        (sum, cat) => sum + (cat.items?.length || 0), 0
                    );
                    if (totalEvents > 0) {
                        const eventsBtn = document.createElement('button');
                        eventsBtn.className = 'analysis-button-inline status-enriched';
                        eventsBtn.textContent = `${totalEvents} Event${totalEvents !== 1 ? 's' : ''}`;
                        eventsBtn.title = 'Match has enrichment events';
                        hoverOverlay.appendChild(eventsBtn);
                    }
                }
            }

            // Delete button (only for completed/failed/expired/not_found/incomplete matches)
            if (showDeleteButton) {
                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'delete-button-inline';

                // Create delete icon using standardized SVG utility
                const deleteIcon = AssetManager.createSvgIcon({
                    pathData: 'M3 6h18v2H3V6zm2 3v11c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V9H5zm3 2h2v7H8v-7zm4 0h2v7h-2v-7zM8 4V2c0-.55.45-1 1-1h6c.55 0 1 .45 1 1v2h4v2H4V4h4z'
                });

                deleteBtn.appendChild(deleteIcon);
                deleteBtn.title = 'Delete Analysis';
                deleteBtn.addEventListener('click', async (e) => {
                    e.stopPropagation(); // Prevent card interactions
                    await this.handleDeleteAnalysis(match, e.currentTarget);
                });
                hoverOverlay.appendChild(deleteBtn);
            }

            cardImage.appendChild(hoverOverlay);
        }


        // Create content section
        const cardContent = document.createElement('div');
        cardContent.className = 'match-card-content';

        // Always show team composition from SSoT data
        const teamComposition = this.createTeamCompositionDisplay(
            match.team0_players,
            match.team1_players,
            match.analyzedPlayerId,
            match.winning_team_id,
            match.analyzed_player_win_status,
            match.soloShuffleRound
        );

        const footer = this.createSimplifiedFooter(match.timestamp);
        cardContent.append(teamComposition, footer);

        card.append(cardImage, cardContent);

        // Add click handler for video playback
        card.addEventListener('click', async (e) => {
            e.preventDefault();
            await this.handleMatchCardClick(match);
        });

        // Add right-click context menu
        card.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation(); // Prevent bubble so close handler doesn't fire immediately
            this.showMatchContextMenu(e, match);
        });

        return card;
    }

    /**
     * Setup video preview on hover for match card
     */
    setupVideoPreview(cardImage, bufferId, matchDuration = null) {
        let videoElement = null;
        let previewTimeout = null;
        let videoPath = null;
        let previewDisabled = false; // Flag to skip preview for short/corrupt videos
        let intentionalStop = false; // Flag to suppress error logging during cleanup

        // Calculate thumbnail time: halfway through the recording (matches backend)
        const thumbnailTime = matchDuration ? matchDuration / 2 : 0;

        const startPreview = async () => {
            // Skip if preview was disabled due to short video
            if (previewDisabled) return;

            // Reset intentional stop flag for new preview attempt
            intentionalStop = false;

            // Clear any pending timeout
            if (previewTimeout) {
                clearTimeout(previewTimeout);
                previewTimeout = null;
            }

            // Delay preview start to avoid flashing on quick hovers
            previewTimeout = setTimeout(async () => {
                try {
                    // Get video info if not cached (use bufferId for lookup)
                    if (!videoPath) {
                        const recordingInfo = await window.arenaCoach.recording.getRecordingInfo(bufferId);
                        // Check for failure or missing video
                        if (!recordingInfo.success || !recordingInfo.videoPath || !recordingInfo.videoExists) {
                            return;
                        }

                        // Skip preview for videos too short to play (< 2s)
                        if (recordingInfo.videoDuration !== null && recordingInfo.videoDuration < 2) {
                            previewDisabled = true;
                            return;
                        }

                        videoPath = recordingInfo.videoPath;
                    }

                    // Create video element
                    videoElement = document.createElement('video');
                    videoElement.className = 'match-card-video-preview';
                    videoElement.src = `file://${videoPath.replace(/\\/g, '/')}`;
                    videoElement.muted = true; // Must be muted for autoplay
                    videoElement.loop = true;
                    videoElement.playsInline = true;

                    // Add error handler for unexpected video loading issues
                    videoElement.addEventListener('error', (_e) => {
                        // Skip logging if this was triggered by intentional cleanup (src='')
                        if (intentionalStop) return;
                        console.warn('[MatchUI] Unexpected video loading error:', videoPath);
                        // Clean up and don't show preview
                        if (videoElement) {
                            videoElement.remove();
                            videoElement = null;
                        }
                        // Keep the existing thumbnail/map image
                    }, { once: true });

                    // Wait for video metadata to load before seeking and showing
                    videoElement.addEventListener('loadedmetadata', () => {
                        if (!videoElement) return;
                        videoElement.currentTime = thumbnailTime; // Start from thumbnail timestamp

                        // Only show video after seeking to correct time
                        videoElement.addEventListener('seeked', () => {
                            const ve = videoElement;
                            if (!ve || !cardImage.isConnected) return;

                            // Hide the background image and show video
                            cardImage.style.backgroundImage = 'none';
                            if (!ve.parentNode) {
                                try { cardImage.appendChild(ve); } catch (_e) { return; }
                            }

                            // Start playback
                            ve.play().catch(err => {
                                console.warn('[MatchUI] Video preview autoplay failed:', err);
                                // Clean up on error
                                if (ve) {
                                    ve.remove();
                                    if (videoElement === ve) videoElement = null;
                                }
                            });
                        }, { once: true }); // Only fire once
                    }, { once: true }); // Only fire once
                } catch (error) {
                    console.warn('[MatchUI] Failed to start video preview:', error);
                }
            }, 200); // 200ms delay before starting preview
        };

        const stopPreview = () => {
            // Clear any pending timeout
            if (previewTimeout) {
                clearTimeout(previewTimeout);
                previewTimeout = null;
            }

            // Remove video element and restore background
            if (videoElement) {
                videoElement.pause();
                // Mark as intentional stop to suppress error handler logging
                intentionalStop = true;
                // Explicitly release file handle (Windows requires this for immediate unlock)
                videoElement.src = '';
                videoElement.load();
                videoElement.remove();
                videoElement = null;

                // Restore the background image
                const existingBg = cardImage.getAttribute('data-original-bg');
                if (existingBg) {
                    // Restore saved inline background
                    cardImage.style.backgroundImage = existingBg;
                } else {
                    // No inline background was saved, remove the override so CSS background shows
                    cardImage.style.removeProperty('background-image');
                }
            }
        };

        // Store original background for restoration
        if (cardImage.style.backgroundImage) {
            cardImage.setAttribute('data-original-bg', cardImage.style.backgroundImage);
        }

        // Add hover event listeners
        cardImage.addEventListener('mouseenter', startPreview);
        cardImage.addEventListener('mouseleave', stopPreview);

        // Clean up on card removal
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.removedNodes) {
                    if (node === cardImage || node.contains?.(cardImage)) {
                        stopPreview();
                        observer.disconnect();
                        return;
                    }
                }
            }
        });
        observer.observe(cardImage.parentElement || document.body, { childList: true, subtree: true });
    }

    /**
     * Handle match card click - open video player if recording exists
     */
    async handleMatchCardClick(match) {
        try {
            // Check recording info for this match (use bufferId for lookup)
            const recordingInfo = await window.arenaCoach.recording.getRecordingInfo(match.bufferId);

            // Handle failure case
            if (!recordingInfo.success) {
                if (recordingInfo.code === 'METADATA_NOT_FOUND') {
                    NotificationManager.show('Match data not found.', 'warning');
                } else {
                    NotificationManager.show('Unable to load recording info. Please try again.', 'error');
                }
                return;
            }

            const { videoPath, videoExists, videoDuration, recordingStatus, recordingErrorMessage } = recordingInfo;

            if (videoPath && videoExists) {
                // Check if video duration is too short to be playable (< 2s)
                if (videoDuration !== null && videoDuration < 2) {
                    NotificationManager.show(`Recording too short to play (${videoDuration.toFixed(1)}s)`, 'warning');
                    return;
                }

                this.openVideoPlayer(match, videoPath);
            } else if (videoPath && !videoExists) {
                // Video path exists in metadata but file is missing
                NotificationManager.show('Video file not found. The recording for this match is missing.', 'warning');
            } else {
                // No video path - show context-aware message based on recordingStatus
                if (recordingStatus === 'deleted_quota') {
                    // Recording was deleted due to storage limit
                    NotificationManager.show('Recording deleted due to storage limit.', 'info');
                } else if (recordingStatus === 'failed_timeout') {
                    // OBS stop timed out
                    NotificationManager.show('Recording failed: OBS timed out.', 'error');
                } else if (recordingStatus === 'failed_io' || recordingStatus === 'failed_unknown') {
                    // Recording was attempted but failed
                    const msg = recordingErrorMessage || 'Recording failed due to a system error.';
                    NotificationManager.show(msg, 'error');
                } else if (recordingStatus === 'not_applicable' || recordingStatus === null) {
                    // Recording was never attempted for this match
                    NotificationManager.show('No recording available. This match was not recorded.', 'info');
                } else {
                    // Fallback for unknown status
                    NotificationManager.show('No recording available for this match.', 'info');
                }
            }
        } catch (error) {
            console.error('[MatchUI] Failed to check for recording:', error);
            NotificationManager.show('Failed to check for recording.', 'error');
        }
    }

    /**
     * Open video player by replacing main content
     */
    openVideoPlayer(match, videoPath) {
        // If a previous player exists, destroy it first (prevents leaks on re-open)
        if (this._videoPlayer) {
            this._videoPlayer.destroy();
            this._videoPlayer = null;
        }

        // Remember the previous view (matches vs settings) before switching
        this.previousView = (this.settingsContent && !this.settingsContent.classList.contains('hidden')) ? 'settings' : 'matches';

        // Notify NavigationManager that video player is opening
        if (this.navigationManager) {
            this.navigationManager.onVideoPlayerOpened();
        }

        // Hide whichever list is showing
        if (this.recentMatchesList) this.recentMatchesList.classList.add('hidden');
        if (this.settingsContent) this.settingsContent.classList.add('hidden');

        this.createVideoPlayerContent(match, videoPath);
        this.currentView = 'video';
        if (window.app?.renderer?.navigationManager) {
            window.app.renderer.navigationManager.currentView = 'video';
        }
    }

    /**
     * Create video player content in main area
     */
    createVideoPlayerContent(match, videoPath) {
        const targetContainer = document.getElementById('main-content-area');

        // Build top bar outside the video container
        const topBar = document.createElement('div');
        topBar.id = 'video-top-bar';
        topBar.className = 'video-top-bar';

        const backBtn = document.createElement('button');
        backBtn.className = 'video-back-btn';
        backBtn.setAttribute('aria-label', 'Back to Matches');
        backBtn.textContent = '‹';
        backBtn.addEventListener('click', () => this.closeVideoPlayer());

        const titleEl = document.createElement('div');
        titleEl.className = 'video-title';

        // Get player data for spec icon
        const players = [...(match.team0_players || []), ...(match.team1_players || [])];
        const me = players.find(p => p.id === match.analyzedPlayerId);
        const specIconPath = me ? AssetManager.getSpecIconPath(me.specId) : null;

        // Define variables needed for title construction
        const bracket = match.bracket || 'Match';
        const mmr = match.displayMMR ? `${match.displayMMR} MMR` : 'MMR N/A';

        // Add spec icon if available
        if (specIconPath) {
            const specIcon = document.createElement('img');
            specIcon.className = 'video-title-spec-icon';
            specIcon.src = specIconPath;
            specIcon.alt = `Spec ${me.specId}`;
            titleEl.appendChild(specIcon);
        }

        const titleTextEl = document.createElement('span');
        titleTextEl.className = 'video-title-text';

        // Build: Name | Bracket | MMR | Result with secure DOM construction
        const segments = [];

        // Name (secure - no innerHTML)
        segments.push(document.createTextNode(me?.name || 'Unknown'));

        // Separator
        segments.push(document.createTextNode(' | '));

        // Bracket
        segments.push(document.createTextNode(bracket));

        // Separator
        segments.push(document.createTextNode(' | '));

        // MMR
        segments.push(document.createTextNode(mmr));

        // Result
        const soloShuffleLabel = MatchUI.getBracketLabels().SoloShuffle;
        if (bracket === soloShuffleLabel) {
            const wins = match.playerWins != null ? match.playerWins : 0;
            const losses = match.playerLosses != null ? match.playerLosses : 0;

            segments.push(document.createTextNode(' | '));
            const winSpan = document.createElement('span');
            winSpan.className = 'win';
            winSpan.textContent = String(wins);

            const sep = document.createTextNode('-');

            const lossSpan = document.createElement('span');
            lossSpan.className = 'loss';
            lossSpan.textContent = String(losses);

            segments.push(winSpan, sep, lossSpan);
        } else if (match.analyzed_player_win_status === true || match.analyzed_player_win_status === false) {
            segments.push(document.createTextNode(' | '));
            const resSpan = document.createElement('span');
            resSpan.className = match.analyzed_player_win_status ? 'win' : 'loss';
            resSpan.textContent = match.analyzed_player_win_status ? 'Victory' : 'Defeat';
            segments.push(resSpan);
        }

        // Append all segments securely
        segments.forEach(node => titleTextEl.appendChild(node));

        titleEl.appendChild(titleTextEl);

        topBar.append(backBtn, titleEl);

        // Outer view container
        const outerView = document.createElement('div');
        outerView.id = 'video-player-view';
        outerView.className = 'video-player-view';

        // Create video element without native controls
        const videoElement = document.createElement('video');
        const url = `file://${videoPath.replace(/\\/g, '/')}`;
        videoElement.src = url;
        videoElement.controls = false;  // CRITICAL CHANGE
        videoElement.autoplay = true;
        videoElement.className = 'video-player-element';

        // Handle video loading errors (shouldn't happen since we check file existence first)
        videoElement.addEventListener('error', (e) => {
            console.error('[MatchUI] Video playback error:', e, videoPath);
            // Close the player and show notification
            this.closeVideoPlayer();
            NotificationManager.show('Unable to play the video file.', 'error');
        });

        // Video player container (passed to VideoPlayer class)
        const videoPlayerContainer = document.createElement('div');
        videoPlayerContainer.className = 'video-player-container';

        videoPlayerContainer.appendChild(videoElement);

        // Create enrichment status bar above video
        const statusBar = document.createElement('div');
        statusBar.className = 'video-enrichment-status';
        statusBar.id = 'video-enrichment-status';

        const statusText = document.createElement('span');
        statusText.className = 'video-enrichment-status-text';
        statusText.id = 'video-enrichment-status-text';

        statusBar.appendChild(statusText);
        outerView.appendChild(statusBar);
        outerView.appendChild(videoPlayerContainer);

        // Remove any existing video UI first (idempotent)
        document.getElementById('video-top-bar')?.remove();
        document.getElementById('video-player-view')?.remove();

        // Do NOT clear targetContainer; keep existing views in DOM
        targetContainer.append(topBar, outerView);

        // Track current video match for auto-refresh
        this._currentVideoMatchHash = match.matchHash;
        this._videoStatusTextEl = statusText;

        // Initialize video player after DOM is ready and store for cleanup
        this._videoPlayer = new VideoPlayer({
            videoElement: videoElement,
            containerElement: videoPlayerContainer,
            metadata: match,
            shuffleRounds: match.shuffleRounds || [],
            defaultMistakeView: this.defaultMistakeView
        });

        // Render initial enrichment status
        this.updateVideoEnrichmentStatus(match);
    }

    /**
     * Close video player and return to matches
     */
    closeVideoPlayer() {
        // Clean up VideoPlayer instance and its event listeners
        if (this._videoPlayer) {
            this._videoPlayer.destroy();
            this._videoPlayer = null;
        }

        const videoView = document.getElementById('video-player-view');
        const topBar = document.getElementById('video-top-bar');

        // The video element is now fully cleaned up by VideoPlayer.destroy()
        videoView?.remove();
        topBar?.remove();

        // Notify NavigationManager that video player is closing
        if (this.navigationManager) {
            this.navigationManager.onVideoPlayerClosed();
        }

        // Restore whichever view we were on before opening video
        if (this.previousView === 'settings' && this.settingsContent) {
            this.settingsContent.classList.remove('hidden');
            if (this.recentMatchesList) this.recentMatchesList.classList.add('hidden');
            this.currentView = 'settings';
            if (window.app?.renderer?.navigationManager) {
                window.app.renderer.navigationManager.currentView = 'settings';
            }
        } else {
            if (this.recentMatchesList) this.recentMatchesList.classList.remove('hidden');
            if (this.settingsContent) this.settingsContent.classList.add('hidden');
            this.currentView = 'matches';
            if (window.app?.renderer?.navigationManager) {
                window.app.renderer.navigationManager.currentView = 'matches';
            }
        }

        this.previousView = null;
        this._currentVideoMatchHash = null;
        this._videoStatusTextEl = null;
    }

    /**
     * Update the video enrichment status bar based on match state
     * @param {Object} match - The match object with status and events
     */
    updateVideoEnrichmentStatus(match) {
        const statusText = this._videoStatusTextEl || document.getElementById('video-enrichment-status-text');
        const statusBar = document.getElementById('video-enrichment-status');

        if (!statusText || !statusBar) return;

        const uploadStatus = match.uploadStatus || match.analysisStatus || 'unknown';
        const hasEvents = match.events && Array.isArray(match.events) && match.events.length > 0;
        const hasEventEnrichment = match.hasEventEnrichment === true;

        // Remove all state classes first
        statusBar.classList.remove('in-progress', 'completed', 'failed', 'quota-exhausted');

        // In-progress states: use same text as badge via formatStatusForDisplay
        const inProgressStatuses = ['queued', 'pending', 'uploading', 'processing', 'analyzing'];
        if (inProgressStatuses.includes(uploadStatus)) {
            statusBar.classList.add('in-progress');
            const displayText = MatchUI.formatStatusForDisplay(
                uploadStatus,
                match.queuePosition,
                match.totalInQueue
            );
            // Add spinner for active processing states (same as badge)
            const showSpinner = ['uploading', 'processing', 'analyzing'].includes(uploadStatus);
            if (showSpinner) {
                const spinner = document.createElement('div');
                spinner.className = 'loading-spinner';
                const textSpan = document.createElement('span');
                textSpan.textContent = displayText;
                statusText.replaceChildren(spinner, textSpan);
            } else {
                statusText.textContent = displayText;
            }
        } else if (uploadStatus === 'completed') {
            if (hasEvents || hasEventEnrichment) {
                statusBar.classList.add('completed');
                // Count total events across all categories
                const totalEvents = (match.events || []).reduce(
                    (sum, cat) => sum + (cat.items?.length || 0), 0
                );
                statusText.textContent = totalEvents > 0
                    ? `Enriched - ${totalEvents} event${totalEvents !== 1 ? 's' : ''} loaded`
                    : 'Enriched - events loaded';
            } else if (match.freeQuotaExhausted === true) {
                statusBar.classList.add('quota-exhausted');
                statusText.innerHTML = 'Free shuffle/3v3 quota reached - <a href="#" class="quota-signup-link">Upgrade to premium</a> for unlimited events';
                // Add click handler for the link
                const signupLink = statusText.querySelector('.quota-signup-link');
                if (signupLink) {
                    signupLink.addEventListener('click', async (e) => {
                        e.preventDefault();
                        try {
                            const isAuthenticated = await window.arenaCoach.auth.isAuthenticated();
                            if (isAuthenticated) {
                                const loginResult = await window.arenaCoach.auth.getWebLoginUrl();
                                if (loginResult?.success && loginResult.url) {
                                    window.arenaCoach.window.openExternal(loginResult.url);
                                    return;
                                }
                                NotificationManager.show(
                                    loginResult?.error || 'Failed to open premium signup.',
                                    'error'
                                );
                                return;
                            }
                            const env = await window.arenaCoach.getEnvironment();
                            const accountUrl = env.isDevelopment
                                ? 'http://localhost:5173/account'
                                : 'https://arenacoach.gg/account';
                            await window.arenaCoach.window.openExternal(accountUrl);
                        } catch (error) {
                            console.error('Failed to open premium signup:', error);
                            NotificationManager.show('Failed to open premium signup.', 'error');
                        }
                    });
                }
            } else {
                statusBar.classList.add('completed');
                statusText.textContent = 'No events for this match';
            }
        } else if (uploadStatus === 'failed') {
            statusBar.classList.add('failed');
            const errorMsg = match.errorMessage || 'Analysis failed';
            statusText.textContent = errorMsg;
        } else if (uploadStatus === 'expired') {
            statusBar.classList.add('failed');
            statusText.textContent = 'Analysis expired';
        } else {
            // Unknown or pending state
            statusText.textContent = '';
            statusBar.style.display = 'none';
            return;
        }

        statusBar.style.display = '';
    }

    /**
     * Reload the video player with updated match data (preserves playback time)
     * @param {string} matchHash - The hash of the match to reload
     */
    async reloadVideoPlayer(matchHash) {
        // Best-effort: capture current playback state
        let currentTime = 0;
        let wasPlaying = false;
        if (this._videoPlayer && this._videoPlayer.video) {
            if (!isNaN(this._videoPlayer.video.currentTime)) {
                currentTime = this._videoPlayer.video.currentTime;
            }
            wasPlaying = !this._videoPlayer.video.paused;
        }

        try {
            // Fetch updated metadata from local storage
            const storedMatch = await window.arenaCoach.matches.load(matchHash);
            if (!storedMatch) return;

            const updatedMatch = this.convertStoredMatchToUIFormat(storedMatch);
            if (!updatedMatch) return;

            // Get video path via recording info
            const recordingInfo = await window.arenaCoach.recording.getRecordingInfo(updatedMatch.bufferId);
            if (!recordingInfo.success || !recordingInfo.videoPath || !recordingInfo.videoExists) return;
            const videoPath = recordingInfo.videoPath;

            console.debug('[MatchUI] Reloading video player with updated match data:', matchHash);

            // Re-open video player in place
            this.openVideoPlayer(updatedMatch, videoPath);

            // Restore playback state
            if (this._videoPlayer && this._videoPlayer.video) {
                if (currentTime > 0) {
                    this._videoPlayer.video.currentTime = currentTime;
                }
                if (wasPlaying) {
                    this._videoPlayer.video.play().catch(() => {
                        // Autoplay may be blocked, ignore
                    });
                }
            }
        } catch (error) {
            console.error('[MatchUI] Failed to reload video player:', error);
        }
    }

    /**
     * Show quota exhausted modal (at most once per weekly reset)
     * @param {Object} event - The analysis completed event
     */
    maybeShowQuotaExhaustedModal(_event) {
        // Per-week guard using localStorage (aligned with Wednesday 00:00 UTC reset)
        const now = new Date();
        const utcDay = now.getUTCDay(); // 0=Sun, 1=Mon, 2=Tue, ...
        const daysSinceWednesday = (utcDay + 4) % 7; // Wed=0, Thu=1, ..., Tue=6
        const wednesdayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceWednesday));
        const weekKey = wednesdayStart.toISOString().slice(0, 10);
        const lastShownWeek = localStorage.getItem('quotaExhaustedModalWeek');

        if (lastShownWeek === weekKey) {
            // Already shown this week, skip
            return;
        }

        // Mark as shown for this week
        localStorage.setItem('quotaExhaustedModalWeek', weekKey);

        // Create and show modal
        this.showQuotaExhaustedModal();
    }

    /**
     * Show the quota exhausted modal UI
     */
    showQuotaExhaustedModal() {
        // Remove any existing modal
        document.getElementById('quota-exhausted-modal')?.remove();

        // Use unified modal structure (same as delete confirmation)
        const modal = document.createElement('div');
        modal.id = 'quota-exhausted-modal';
        modal.className = 'app-modal';

        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';

        const dialog = document.createElement('div');
        dialog.className = 'modal-dialog';

        const title = document.createElement('h3');
        title.textContent = 'Free Shuffle/3v3 Quota Reached';

        const message = document.createElement('p');
        const siteLink = document.createElement('a');
        siteLink.href = '#';
        siteLink.textContent = 'arenacoach.gg';
        siteLink.addEventListener('click', (e) => {
            e.preventDefault();
            window.arenaCoach.window.openExternal('https://arenacoach.gg');
        });
        message.appendChild(document.createTextNode("Matches will still be saved and events are available anytime at "));
        message.appendChild(siteLink);
        message.appendChild(document.createTextNode(" - 2v2/skirmish stay free, and free shuffle/3v3 analyses reset weekly."));

        const upsell = document.createElement('p');
        upsell.className = 'modal-upsell';
        upsell.textContent = 'Upgrade to premium for unlimited shuffle/3v3 analyses and events.';

        const actions = document.createElement('div');
        actions.className = 'modal-actions';

        const laterBtn = document.createElement('button');
        laterBtn.className = 'btn secondary';
        laterBtn.textContent = 'Later';
        laterBtn.addEventListener('click', () => modal.remove());

        const signUpBtn = document.createElement('button');
        signUpBtn.className = 'btn';
        signUpBtn.textContent = 'Get Premium';
        signUpBtn.addEventListener('click', async () => {
            try {
                const isAuthenticated = await window.arenaCoach.auth.isAuthenticated();
                if (isAuthenticated) {
                    const loginResult = await window.arenaCoach.auth.getWebLoginUrl();
                    if (loginResult?.success && loginResult.url) {
                        window.arenaCoach.window.openExternal(loginResult.url);
                        modal.remove();
                        return;
                    }
                    NotificationManager.show(
                        loginResult?.error || 'Failed to open premium signup.',
                        'error'
                    );
                    return;
                }
                const env = await window.arenaCoach.getEnvironment();
                const accountUrl = env.isDevelopment
                    ? 'http://localhost:5173/account'
                    : 'https://arenacoach.gg/account';
                await window.arenaCoach.window.openExternal(accountUrl);
            } catch (error) {
                console.error('Failed to open premium signup:', error);
                NotificationManager.show('Failed to open premium signup.', 'error');
            }
            modal.remove();
        });

        backdrop.addEventListener('click', () => modal.remove());

        actions.append(laterBtn, signUpBtn);
        dialog.append(title, message, upsell, actions);
        modal.append(backdrop, dialog);

        document.body.appendChild(modal);

        // Focus the secondary button for accessibility
        setTimeout(() => laterBtn.focus(), 100);
    }

    _determinePlayerTeam({ team0Players, team1Players, analyzedPlayerId, winningTeamId, analyzedPlayerWinStatus }) {
        // Early return with null if we don't have essential data (expected during initial metadata phase)
        if (!analyzedPlayerId || (!team0Players && !team1Players)) {
            return null; // Cannot determine team without player ID or team data
        }

        // First, check if the player is directly in team0
        if (team0Players && team0Players.some(player => player.id === analyzedPlayerId)) {
            return true; // Player is on team 0
        }

        // Then check if the player is directly in team1
        if (team1Players && team1Players.some(player => player.id === analyzedPlayerId)) {
            return false; // Player is on team 1
        }

        // Fallback: Use winning team ID and player win status to determine team
        if (winningTeamId !== null && winningTeamId !== undefined && analyzedPlayerWinStatus !== null && analyzedPlayerWinStatus !== undefined) {
            const winningTeamIdStr = String(winningTeamId);
            if (analyzedPlayerWinStatus === true && winningTeamIdStr === MatchUI.TEAM_ID_0) {
                return true; // Player won and winning team is 0
            }
            if (analyzedPlayerWinStatus === true && winningTeamIdStr === MatchUI.TEAM_ID_1) {
                return false; // Player won and winning team is 1
            }
            if (analyzedPlayerWinStatus === false && winningTeamIdStr === MatchUI.TEAM_ID_0) {
                return false; // Player lost and winning team is 0, so player is on team 1
            }
            if (analyzedPlayerWinStatus === false && winningTeamIdStr === MatchUI.TEAM_ID_1) {
                return true; // Player lost and winning team is 1, so player is on team 0
            }
        }

        // Log warning for unexpected cases where we have player data but still can't determine team
        const hasPlayerData = analyzedPlayerId && (team0Players?.length > 0 || team1Players?.length > 0);
        if (hasPlayerData) {
            console.warn('[MatchUI] Could not determine player team', {
                analyzedPlayerId,
                team0Count: team0Players?.length || 0,
                team1Count: team1Players?.length || 0,
                winningTeamId,
                analyzedPlayerWinStatus
            });
        }

        // Cannot determine team - caller handles null by showing teams in natural order
        return null;
    }

    createTeamCompositionDisplay(team0Players, team1Players, analyzedPlayerId, winningTeamId, analyzedPlayerWinStatus, soloShuffleRound) {
        const composition = document.createElement('div');
        composition.className = 'team-composition';

        // Add Solo Shuffle round indicator if present
        if (soloShuffleRound !== null && soloShuffleRound !== undefined) {
            const roundIndicator = document.createElement('div');
            roundIndicator.className = 'solo-shuffle-round';
            roundIndicator.textContent = `Round ${soloShuffleRound}`;
            composition.appendChild(roundIndicator);
        }

        // Determine which team the analyzed player is on
        const playerOnTeam0 = this._determinePlayerTeam({
            team0Players,
            team1Players,
            analyzedPlayerId,
            winningTeamId,
            analyzedPlayerWinStatus
        });

        // Handle team display based on player team determination
        let leftTeam, rightTeam;
        if (playerOnTeam0 === null) {
            // Cannot determine player team (expected during initial metadata phase)
            // Show teams in their natural order (team0 left, team1 right)
            leftTeam = this.createTeamSide(team0Players, analyzedPlayerId);
            rightTeam = this.createTeamSide(team1Players, analyzedPlayerId);
        } else if (playerOnTeam0) {
            // Player is on team 0 - put player's team on the left
            leftTeam = this.createTeamSide(team0Players, analyzedPlayerId);
            rightTeam = this.createTeamSide(team1Players, analyzedPlayerId);
        } else {
            // Player is on team 1 - put player's team on the left
            leftTeam = this.createTeamSide(team1Players, analyzedPlayerId);
            rightTeam = this.createTeamSide(team0Players, analyzedPlayerId);
        }

        // Create VS divider
        const vsDivider = document.createElement('div');
        vsDivider.className = 'vs-divider';

        const vsText = document.createElement('span');
        vsText.textContent = 'VS';
        vsText.className = 'vs-divider-text';

        vsDivider.appendChild(vsText);

        // Create team container for the teams and VS divider
        const teamContainer = document.createElement('div');
        teamContainer.className = 'team-container';
        teamContainer.append(leftTeam, vsDivider, rightTeam);

        composition.appendChild(teamContainer);
        return composition;
    }

    createTeamSide(players, analyzedPlayerId) {
        const teamSide = document.createElement('div');
        teamSide.className = 'team-side';


        if (!players || players.length === 0) {
            // Fallback for matches without team data
            const placeholder = document.createElement('div');
            placeholder.className = 'team-player';

            const placeholderIcon = document.createElement('div');
            placeholderIcon.className = 'team-player-placeholder';

            placeholder.appendChild(placeholderIcon);
            teamSide.appendChild(placeholder);
            return teamSide;
        }

        players.forEach(player => {
            // Only create spec icon, no player names as requested
            const specIconPath = AssetManager.getSpecIconPath(player.specId);
            if (specIconPath) {
                const specIcon = document.createElement('img');
                specIcon.className = 'spec-icon';
                specIcon.src = specIconPath;
                specIcon.alt = `Spec ${player.specId}`;

                // Highlight the analyzed player's character using their unique ID
                if (player.id === analyzedPlayerId) {
                    specIcon.classList.add('user-player');
                }

                teamSide.appendChild(specIcon);
            }
        });

        return teamSide;
    }

    createSimplifiedFooter(matchStartTimestamp) {
        const footer = document.createElement('div');
        footer.className = 'simplified-footer';

        const dateTime = document.createElement('span');
        dateTime.className = 'match-datetime';

        if (matchStartTimestamp) {
            // Handle both Date objects and timestamp numbers/strings
            let matchTime;
            if (matchStartTimestamp instanceof Date) {
                matchTime = matchStartTimestamp;
            } else {
                const timestampNum = parseInt(matchStartTimestamp, 10);
                if (!isNaN(timestampNum)) {
                    matchTime = new Date(timestampNum);
                } else {
                    matchTime = null;
                }
            }

            if (matchTime) {
                dateTime.textContent = matchTime.toLocaleDateString([], {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                    hour12: true
                });
            } else {
                dateTime.textContent = 'Unknown date';
            }
        } else {
            dateTime.textContent = 'Unknown date';
        }

        footer.appendChild(dateTime);
        return footer;
    }



    static formatStatusForDisplay(status, queuePosition = null, totalInQueue = null) {
        switch (status) {
            case MatchUI.STATUS_QUEUED:
                if (totalInQueue && totalInQueue > 0) {
                    if (queuePosition) {
                        return `Queue ${queuePosition}/${totalInQueue}`;
                    } else {
                        return `Queue (${totalInQueue} total)`;
                    }
                }
                return 'Queued';
            case MatchUI.STATUS_UPLOADING:
                return 'Uploading';
            case MatchUI.STATUS_PROCESSING:
                // Processing jobs are active, don't show queue position
                return 'Processing';
            case MatchUI.STATUS_INCOMPLETE:
                return 'Incomplete';
            case MatchUI.STATUS_EXPIRED:
                return 'Expired';
            case MatchUI.STATUS_PENDING:
                return 'Pending';
            case MatchUI.STATUS_IN_PROGRESS:
                return 'In Progress';
            case MatchUI.STATUS_UNKNOWN:
            default:
                return 'Processing';
        }
    }

    /**
     * Get error badge configuration for terminal failure states
     * @param {string|null} errorCode - Error code from backend or parser
     * @returns {{ short: string|null, long: string|null }}
     */
    static getErrorBadgeConfig(errorCode) {
        const map = {
            // Parser permanent errors (from @wow/combat-log-parser)
            MISSING_HP_DATA: {
                short: 'Missing Data',
                long: 'Combat log is missing required HP data',
            },
            MISSING_IDENTITY_DATA: {
                short: 'Missing Data',
                long: 'Combat log is missing required identity data',
            },
            MISSING_ADVANCED_LOGGING: {
                short: 'Advanced Logging',
                long: 'Advanced Combat Logging was not enabled',
            },
            NO_MATCHES_FOUND: {
                short: 'No Matches',
                long: 'Log contains no arena matches',
            },
            MALFORMED_MATCHES: {
                short: 'Invalid Log',
                long: 'Arena matches found but all were malformed or incomplete',
            },
            // Desktop synthetic errors
            JOB_NOT_FOUND: {
                short: 'Analysis Missing',
                long: 'Analysis not found on server (may have been cleaned up)',
            },
            BACKEND_CONTRACT_VIOLATION: {
                short: 'Analysis Error',
                long: 'Unexpected analysis response',
            },
            ANALYSIS_TIMEOUT: {
                short: 'Timed Out',
                long: 'Analysis timed out after maximum attempts',
            },
        };

        const config = (errorCode && map[errorCode]) || null;

        return {
            short: config?.short ?? null,
            long: config?.long ?? null,
        };
    }

    async handleDeleteAnalysis(match, deleteButton = null) {
        // Show confirmation dialog
        const confirmed = await this.showDeleteConfirmation(match);
        if (!confirmed) {
            return; // User cancelled
        }

        if (deleteButton) {
            deleteButton.disabled = true;
            deleteButton.classList.add('loading'); // Use CSS spinner
            deleteButton.innerHTML = ''; // Clear icon to show spinner
        }

        try {
            let notificationMessage = 'Match deleted successfully';
            let notificationType = 'success';

            // Perform local deletion by bufferId (works for complete and incomplete)
            try {
                await window.arenaCoach.matches.delete(match.bufferId);
            } catch (localError) {
                console.error(`Local deletion for ${match.bufferId} failed.`, localError);
                notificationMessage = 'Failed to delete match';
                notificationType = 'error';
            }

            // Refresh UI and show notification
            await window.MatchDataService.refresh();
            NotificationManager.show(notificationMessage, notificationType);

        } catch (error) {
            NotificationManager.show(`Failed to delete analysis: ${error.message}`, 'error');
        } finally {
            // Restore the specific button that was clicked
            if (deleteButton) {
                deleteButton.disabled = false;
                deleteButton.classList.remove('loading'); // Remove spinner class
                deleteButton.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M3 6h18v2H3V6zm2 3v11c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V9H5zm3 2h2v7H8v-7zm4 0h2v7h-2v-7zM8 4V2c0-.55.45-1 1-1h6c.55 0 1 .45 1 1v2h4v2H4V4h4z"/>
                </svg>`; // Restore trash icon
            }
        }
    }

    // Helper methods for delete response handling
    isDeleteSuccessResponse(response) {
        return response === true || (typeof response === 'object' && response.deleted === true);
    }

    isDeleteAlreadyDeletedResponse(response) {
        return typeof response === 'object' && response.error &&
            (response.error.includes('not found') || response.error.includes('already deleted'));
    }


    async showDeleteConfirmation(_match) {
        return new Promise((resolve) => {
            // Use same modal structure as bulk delete
            const modal = document.createElement('div');
            modal.className = 'delete-confirmation-modal';

            const backdrop = document.createElement('div');
            backdrop.className = 'modal-backdrop';

            const dialog = document.createElement('div');
            dialog.className = 'modal-dialog';

            const title = document.createElement('h3');
            title.textContent = 'Delete 1 Item';

            const message = document.createElement('p');
            message.textContent = 'The selected item will be permanently deleted.';

            const actions = document.createElement('div');
            actions.className = 'modal-actions';

            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'btn secondary';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.addEventListener('click', () => {
                modal.remove();
                resolve(false);
            });

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'btn danger';
            deleteBtn.textContent = 'Delete';
            deleteBtn.addEventListener('click', () => {
                modal.remove();
                resolve(true);
            });

            backdrop.addEventListener('click', () => {
                modal.remove();
                resolve(false);
            });

            actions.append(cancelBtn, deleteBtn);
            dialog.append(title, message, actions);
            modal.append(backdrop, dialog);

            document.body.appendChild(modal);

            // Focus delete button for accessibility
            setTimeout(() => cancelBtn.focus(), 100);
        });
    }


    applyFilters() {
        // Apply bracket and favourites filtering
        this.filteredMatches = this.recentMatches.filter(match => {
            // Favourites filter - special filter type (not a bracket)
            if (this.activeFilter === MatchUI.FILTER_FAVOURITES) {
                return match.isFavourite === true;
            }

            // Bracket filtering - only apply if brackets are selected
            if (this.activeBrackets.size > 0) {
                const matchBracket = match.bracket; // Use bracket field from metadata
                if (!this.activeBrackets.has(matchBracket)) {
                    return false;
                }
            }

            return true;
        });

        // Re-render with filtered matches
        this.renderFilteredMatches();
    }


    renderFilteredMatches(append = false) {
        const matchesToRender = this.filteredMatches;

        // Append mode: add new matches to existing list
        if (append) {
            const newMatches = matchesToRender.slice(this.renderedMatchCount);
            if (newMatches.length > 0) {
                this.appendNewMatches(newMatches);
                this.renderedMatchCount = matchesToRender.length;
            }
            return;
        }

        // Full render: increment version to cancel any in-flight render (handles rapid filter clicks)
        const renderVersion = ++this._renderVersion;

        // Empty state
        if (!matchesToRender || matchesToRender.length === 0) {
            const emptyState = document.createElement('div');
            emptyState.className = 'empty-state';

            const emptyMessage = document.createElement('p');
            const hintMessage = document.createElement('p');
            hintMessage.className = 'hint';

            if (this.filteredMatches.length === 0 && this.recentMatches.length > 0) {
                const filterMessages = this.getFilterSpecificMessage();
                emptyMessage.textContent = filterMessages.main;
                if (filterMessages.hint) {
                    hintMessage.textContent = filterMessages.hint;
                    emptyState.append(emptyMessage, hintMessage);
                } else {
                    emptyState.appendChild(emptyMessage);
                }
            } else {
                emptyMessage.textContent = 'No matches detected yet';
                hintMessage.textContent = 'Arena matches will appear here when detected';
                emptyState.append(emptyMessage, hintMessage);
            }
            this.recentMatchesList.replaceChildren(emptyState);
            this.renderedMatchCount = 0;
            return;
        }

        // Full render: build DOM off-screen then swap (prevents rubberbanding)
        const groupedMatches = this.groupMatchesByDate(matchesToRender);
        const matchCount = matchesToRender.length;

        (async () => {
            try {
                const fragment = document.createDocumentFragment();

                for (const [dateLabel, matches] of Object.entries(groupedMatches)) {
                    // Abort if a newer render started (rapid filter clicks)
                    if (renderVersion !== this._renderVersion) return;

                    const section = document.createElement('div');
                    section.className = 'date-section';
                    if (this.collapsedDates.has(dateLabel)) {
                        section.classList.add('collapsed');
                    }

                    const { header } = this._createDateHeader(dateLabel, matches);

                    const gridWrapper = document.createElement('div');
                    gridWrapper.className = 'grid-animator';

                    const grid = document.createElement('div');
                    grid.className = 'match-grid';

                    for (const match of matches) {
                        if (renderVersion !== this._renderVersion) return;
                        const card = await this.createMatchCard(match);
                        grid.appendChild(card);
                    }

                    gridWrapper.appendChild(grid);
                    section.append(header, gridWrapper);
                    fragment.appendChild(section);
                }

                if (renderVersion !== this._renderVersion) return;

                // Single DOM swap - no rubberbanding
                this.recentMatchesList.replaceChildren(fragment);
                this.renderedMatchCount = matchCount;
            } catch (err) {
                console.error('[MatchUI] renderFilteredMatches failed:', err);
            }
        })();
    }

    appendNewMatches(newMatches) {
        // Find the last date section to potentially append to
        let lastSection = this.recentMatchesList.querySelector('.date-section:last-of-type');
        let lastGrid = lastSection ? lastSection.querySelector('.match-grid') : null;
        const lastDateCheckbox = lastSection ? lastSection.querySelector('.date-select-checkbox[data-date]') : null;
        let lastDateLabel = lastDateCheckbox ? lastDateCheckbox.getAttribute('data-date') : null;

        (async () => {
            try {
                for (const match of newMatches) {
                    const card = await this.createMatchCard(match);
                    const matchDateLabel = this.getDateLabel(match);

                    if (matchDateLabel === lastDateLabel && lastGrid) {
                        // Same date group - just append
                        lastGrid.appendChild(card);

                        // Update date checkbox count
                        const actualCount = Array.from(
                            lastGrid.querySelectorAll('.match-checkbox[data-buffer-id]')
                        ).filter(cb => cb.getAttribute('data-buffer-id')).length;
                        const dateCheckbox = lastGrid.closest('.date-section')?.querySelector('.date-select-checkbox');
                        if (dateCheckbox) {
                            dateCheckbox.setAttribute('data-total-matches', actualCount);
                            if (actualCount > 0) dateCheckbox.disabled = false;
                            this.updateDateCheckboxState(lastDateLabel);
                        }
                    } else {
                        // New date group - create section
                        const section = document.createElement('div');
                        section.className = 'date-section';
                        if (this.collapsedDates.has(matchDateLabel)) {
                            section.classList.add('collapsed');
                        }

                        const { header } = this._createDateHeader(matchDateLabel, [match]);

                        const gridWrapper = document.createElement('div');
                        gridWrapper.className = 'grid-animator';

                        const grid = document.createElement('div');
                        grid.className = 'match-grid';
                        grid.appendChild(card);

                        gridWrapper.appendChild(grid);
                        section.append(header, gridWrapper);
                        this.recentMatchesList.appendChild(section);

                        lastGrid = grid;
                        lastDateLabel = matchDateLabel;
                    }
                }
            } catch (err) {
                console.error('[MatchUI] appendNewMatches failed:', err);
            }
        })();
    }

    toggleDateSection(dateLabel, section, header) {
        if (this.collapsedDates.has(dateLabel)) {
            // Expand the section
            this.collapsedDates.delete(dateLabel);
            section.classList.remove('collapsed');
            header.classList.remove('collapsed');
        } else {
            // Collapse the section
            this.collapsedDates.add(dateLabel);
            section.classList.add('collapsed');
            header.classList.add('collapsed');
        }
    }



    formatBracketName(bracket) {
        const labels = MatchUI.getBracketLabels();
        const displayNames = MatchUI.getBracketDisplayNames();
        const bracketMap = {
            [labels.TwoVTwo]: displayNames.TwoVTwo,
            [labels.ThreeVThree]: displayNames.ThreeVThree,
            [labels.SoloShuffle]: displayNames.SoloShuffle,
            [labels.Skirmish]: displayNames.Skirmish
        };
        return bracketMap[bracket] || bracket;
    }

    formatDuration(seconds) {
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
    }

    // Helper method to create date headers
    _createDateHeader(dateLabel, matches) {
        const header = document.createElement('div');
        header.className = 'date-header';
        if (this.collapsedDates.has(dateLabel)) {
            header.classList.add('collapsed');
        }

        // Date checkbox for "select all"
        const dateCheckbox = document.createElement('input');
        dateCheckbox.type = 'checkbox';
        dateCheckbox.className = 'date-select-checkbox';
        dateCheckbox.setAttribute('data-date', dateLabel);
        dateCheckbox.setAttribute('aria-label', `Select all matches for ${dateLabel}`);

        // Count selectable matches
        const selectableCount = matches.filter(m => m.bufferId && MatchUI.isSelectableStatus(m.currentStatus)).length;
        dateCheckbox.setAttribute('data-total-matches', selectableCount);

        if (selectableCount === 0) {
            dateCheckbox.disabled = true;
        } else {
            // Set initial state
            const selectedInDate = this.selectedByDate.get(dateLabel);
            const selectedCount = selectedInDate ? selectedInDate.size : 0;
            dateCheckbox.checked = selectedCount === selectableCount && selectableCount > 0;
            dateCheckbox.indeterminate = selectedCount > 0 && selectedCount < selectableCount;

            // Click handler queries DOM for current bufferIds (works for both full render and append)
            dateCheckbox.addEventListener('click', (e) => {
                e.stopPropagation();
                const section = dateCheckbox.closest('.date-section');
                const checkboxes = section.querySelectorAll('.match-checkbox[data-buffer-id]');
                const bufferIds = Array.from(checkboxes)
                    .map(cb => cb.getAttribute('data-buffer-id'))
                    .filter(Boolean);
                if (bufferIds.length === 0) {
                    dateCheckbox.checked = false;
                    return;
                }
                this.toggleSelectDate(dateLabel, bufferIds, dateCheckbox.checked);
            });
        }

        // Create date/arrow button for collapse/expand
        const dateButton = document.createElement('button');
        dateButton.className = 'date-collapse-button';
        if (this.collapsedDates.has(dateLabel)) {
            dateButton.classList.add('collapsed');
        }

        const dateText = document.createElement('span');
        dateText.textContent = dateLabel;
        dateButton.appendChild(dateText);

        // Add click handler for collapse/expand
        dateButton.addEventListener('click', (e) => {
            e.stopPropagation();
            const section = header.closest('.date-section');
            if (section) {
                this.toggleDateSection(dateLabel, section, header);
            }
        });

        // Add elements to header
        header.appendChild(dateCheckbox);
        header.appendChild(dateButton);

        return { header, dateCheckbox };
    }

    // Selection management methods
    toggleSelectMatch(bufferId, dateLabel, isSelected) {
        if (!bufferId) return;

        if (isSelected) {
            this.selectedMatchBufferIds.add(bufferId);
            // Add to date tracking
            if (!this.selectedByDate.has(dateLabel)) {
                this.selectedByDate.set(dateLabel, new Set());
            }
            this.selectedByDate.get(dateLabel).add(bufferId);
        } else {
            this.selectedMatchBufferIds.delete(bufferId);
            // Remove from date tracking
            const dateSet = this.selectedByDate.get(dateLabel);
            if (dateSet) {
                dateSet.delete(bufferId);
                if (dateSet.size === 0) {
                    this.selectedByDate.delete(dateLabel);
                }
            }
        }

        this.updateDateCheckboxState(dateLabel);
        this.updateBulkActionsBar();
    }

    toggleSelectDate(dateLabel, matchBufferIds, isSelected) {
        // Defensive: no-op if nothing to select (all matches are processing/non-terminal)
        if (!matchBufferIds || matchBufferIds.length === 0) {
            return;
        }

        // NOTE: This method relies on .match-card[data-buffer-id] and .match-checkbox[data-buffer-id] selectors.
        // Any structural changes to match card DOM requires updating these selectors.
        if (isSelected) {
            // Select all matches for this date
            if (!this.selectedByDate.has(dateLabel)) {
                this.selectedByDate.set(dateLabel, new Set());
            }
            const dateSet = this.selectedByDate.get(dateLabel);
            matchBufferIds.forEach(bufferId => {
                this.selectedMatchBufferIds.add(bufferId);
                dateSet.add(bufferId);
            });
        } else {
            // Deselect all matches for this date
            const dateSet = this.selectedByDate.get(dateLabel);
            if (dateSet) {
                dateSet.forEach(bufferId => {
                    this.selectedMatchBufferIds.delete(bufferId);
                });
                this.selectedByDate.delete(dateLabel);
            }
        }

        // Update all match checkboxes for this date
        matchBufferIds.forEach(bufferId => {
            const checkbox = document.querySelector(`.match-checkbox[data-buffer-id="${bufferId}"]`);
            if (checkbox) {
                checkbox.checked = isSelected;
            }
            const card = document.querySelector(`.match-card[data-buffer-id="${bufferId}"]`);
            if (card) {
                card.classList.toggle('selected', isSelected);
            }
        });

        this.updateBulkActionsBar();
    }

    updateDateCheckboxState(dateLabel) {
        const dateCheckbox = document.querySelector(`.date-select-checkbox[data-date="${dateLabel}"]`);
        if (!dateCheckbox) return;

        const totalMatches = parseInt(dateCheckbox.getAttribute('data-total-matches'), 10) || 0;
        const selectedCount = this.getSelectedCountByDate(dateLabel);

        if (selectedCount === 0) {
            dateCheckbox.checked = false;
            dateCheckbox.indeterminate = false;
        } else if (selectedCount === totalMatches && totalMatches > 0) {
            dateCheckbox.checked = true;
            dateCheckbox.indeterminate = false;
        } else {
            dateCheckbox.checked = false;
            dateCheckbox.indeterminate = true;
        }
    }

    clearSelection() {
        this.selectedMatchBufferIds.clear();
        this.selectedByDate.clear();

        // Update all checkboxes
        document.querySelectorAll('.match-checkbox').forEach(cb => cb.checked = false);
        document.querySelectorAll('.date-select-checkbox').forEach(cb => {
            cb.checked = false;
            cb.indeterminate = false;
        });
        document.querySelectorAll('.match-card.selected').forEach(card => {
            card.classList.remove('selected');
        });

        this.updateBulkActionsBar();
    }

    getSelectedCountByDate(dateLabel) {
        const dateSet = this.selectedByDate.get(dateLabel);
        return dateSet ? dateSet.size : 0;
    }

    updateBulkActionsBar() {
        const count = this.selectedMatchBufferIds.size;

        if (count > 0) {
            if (!this.bulkActionsBar) {
                this.createBulkActionsBar();
            }
            // Update count
            const countEl = this.bulkActionsBar.querySelector('.selection-count');
            if (countEl) {
                countEl.textContent = `${count} selected`;
            }
            this.bulkActionsBar.classList.add('visible');
        } else {
            if (this.bulkActionsBar) {
                this.bulkActionsBar.classList.remove('visible');
            }
        }
    }

    createBulkActionsBar() {
        // Remove existing if any
        if (this.bulkActionsBar) {
            this.bulkActionsBar.remove();
        }

        const bar = document.createElement('div');
        bar.className = 'bulk-actions-bar';

        const countSpan = document.createElement('span');
        countSpan.className = 'selection-count';
        countSpan.textContent = '0 selected';

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'bulk-delete-btn';
        deleteBtn.textContent = 'Delete';
        deleteBtn.setAttribute('aria-label', 'Delete selected matches');
        deleteBtn.addEventListener('click', () => this.showBulkDeleteConfirmation());

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'bulk-cancel-btn';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.setAttribute('aria-label', 'Cancel selection');
        cancelBtn.addEventListener('click', () => this.clearSelection());

        bar.append(countSpan, cancelBtn, deleteBtn);
        document.body.appendChild(bar);
        this.bulkActionsBar = bar;
    }

    showBulkDeleteConfirmation() {
        const count = this.selectedMatchBufferIds.size;
        if (count === 0) return;

        // Create modal
        const modal = document.createElement('div');
        modal.className = 'delete-confirmation-modal';

        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';

        const dialog = document.createElement('div');
        dialog.className = 'modal-dialog';

        const title = document.createElement('h3');
        title.textContent = `Delete ${count} Item${count > 1 ? 's' : ''}`;

        const message = document.createElement('p');
        message.textContent = `The selected item${count > 1 ? 's' : ''} will be permanently deleted.`;

        // Show breakdown by date if multiple dates
        if (this.selectedByDate.size > 1) {
            const breakdown = document.createElement('ul');
            breakdown.className = 'deletion-breakdown';
            this.selectedByDate.forEach((hashes, date) => {
                const li = document.createElement('li');
                li.textContent = `${date}: ${hashes.size} match${hashes.size > 1 ? 'es' : ''}`;
                breakdown.appendChild(li);
            });
            dialog.appendChild(breakdown);
        }

        const actions = document.createElement('div');
        actions.className = 'modal-actions';

        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'btn danger';
        confirmBtn.textContent = 'Delete';
        confirmBtn.addEventListener('click', () => {
            modal.remove();
            this.executeBulkDelete();
        });

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn secondary';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => modal.remove());

        actions.append(cancelBtn, confirmBtn);
        dialog.append(title, message, actions);
        modal.append(backdrop, dialog);

        backdrop.addEventListener('click', () => modal.remove());

        document.body.appendChild(modal);
    }

    async executeBulkDelete() {
        const bufferIdsToDelete = Array.from(this.selectedMatchBufferIds);
        const total = bufferIdsToDelete.length;
        let successCount = 0;
        let failCount = 0;

        // Show progress notification
        NotificationManager.show(`Deleting ${total} matches...`, 'info');

        // Delete matches sequentially
        for (const bufferId of bufferIdsToDelete) {
            try {
                await window.arenaCoach.matches.delete(bufferId);
                successCount++;
            } catch (error) {
                console.error(`Failed to delete match ${bufferId}:`, error);
                failCount++;
            }
        }

        // Clear selection
        this.clearSelection();

        // Refresh the match list
        await window.MatchDataService.refresh();

        // Show result notification
        if (failCount === 0) {
            NotificationManager.show(`Successfully deleted ${successCount} match${successCount > 1 ? 'es' : ''}`, 'success');
        } else {
            NotificationManager.show(
                `Deleted ${successCount} match${successCount > 1 ? 'es' : ''}, ${failCount} failed`,
                'warning'
            );
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
            console.warn('[MatchUI] Failed to get recording status, keeping last-known value:', error);
            this.updateRecordingDisabledState();
        }
    }

    // Update UI elements based on recording state
    updateRecordingDisabledState() {
        const isDisabled = this.isRecording;
        const tooltip = isDisabled ? 'Stop recording to change this setting' : '';

        // The detection toggle button is disabled during recording OR during a match
        if (this.toggleDetectionBtn) {
            // Check if disabled by either recording or match
            const shouldDisable = isDisabled || this.isInMatch;
            const currentTooltip = isDisabled ? tooltip :
                this.isInMatch ? 'Cannot stop detection during an active match' : '';

            this.toggleDetectionBtn.disabled = shouldDisable;
            this.toggleDetectionBtn.title = currentTooltip;
            // Use the same class for both recording and match states
            this.toggleDetectionBtn.classList.toggle('disabled-while-recording', shouldDisable);
        }
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
            console.warn('[MatchUI] Failed to get current match, keeping last-known value:', error);
            this.updateMatchDisabledState();
        }
    }

    // Update UI elements based on match state
    updateMatchDisabledState() {
        // Update the detection button state when match state changes
        this.updateRecordingDisabledState();
    }

    // Listen for settings changes (decoupled from SettingsUI)
    setupSettingsListener() {
        // Ensure idempotency - remove existing listener first
        this.stopSettingsListener();

        this._onSettingsUpdated = (event) => {
            // Validate event shape explicitly
            const detail = event.detail;
            if (!detail || typeof detail !== 'object') {
                console.error('[MatchUI] Invalid settings:updated event detail:', detail);
                return;
            }
            if (detail.key === 'showMmrBadge') {
                if (typeof detail.value !== 'boolean') {
                    console.error('[MatchUI] Invalid showMmrBadge value from event:', typeof detail.value);
                    return;
                }
                this.showMmrBadge = detail.value;
                this.renderFilteredMatches(false);
                return;
            }

            if (detail.key === 'defaultMistakeView') {
                if (detail.value !== 'mine' && detail.value !== 'all') {
                    console.error('[MatchUI] Invalid defaultMistakeView value from event:', detail.value);
                    return;
                }
                this.defaultMistakeView = detail.value;
            }
        };
        window.addEventListener('settings:updated', this._onSettingsUpdated);
    }

    // Stop listening for settings changes
    stopSettingsListener() {
        if (this._onSettingsUpdated) {
            window.removeEventListener('settings:updated', this._onSettingsUpdated);
            this._onSettingsUpdated = null;
        }
    }

    /**
     * Show context menu for match card
     * @param {MouseEvent} e - The contextmenu event
     * @param {Object} match - The match data
     */
    showMatchContextMenu(e, match) {
        // Remove any existing context menu
        this.hideMatchContextMenu();

        const menu = document.createElement('div');
        menu.className = 'match-context-menu';
        menu.style.left = `${e.clientX}px`;
        menu.style.top = `${e.clientY}px`;

        // Show in Folder option
        const openLocationOption = document.createElement('div');
        openLocationOption.className = 'context-menu-item';
        const folderIcon = AssetManager.createSvgIcon({
            pathData: 'M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z'
        });
        const folderLabel = document.createElement('span');
        folderLabel.textContent = 'Show in Folder';
        openLocationOption.appendChild(folderIcon);
        openLocationOption.appendChild(folderLabel);
        openLocationOption.addEventListener('click', async () => {
            this.hideMatchContextMenu();
            try {
                if (!match.bufferId) {
                    NotificationManager.show('No recording found for this match', 'info');
                    return;
                }
                // Use ID-based reveal - main process looks up path from metadata
                const result = await window.arenaCoach.recording.revealVideoInFolder(match.bufferId);
                if (!result.success) {
                    if (result.code === 'NO_MEDIA') {
                        NotificationManager.show('No recording found for this match', 'info');
                    } else if (result.code === 'NOT_FOUND') {
                        NotificationManager.show('Recording file not found', 'warning');
                    } else {
                        NotificationManager.show(`Failed to open folder: ${result.error}`, 'error');
                    }
                }
            } catch (error) {
                console.error('Failed to show in folder:', error);
                NotificationManager.show('Failed to open folder', 'error');
            }
        });
        menu.appendChild(openLocationOption);

        // Export Match Log option
        const exportOption = document.createElement('div');
        exportOption.className = 'context-menu-item';
        const exportIcon = AssetManager.createSvgIcon({
            pathData: 'M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11zm-3-7v4h-2v-4H9l4-4 4 4h-2z'
        });
        const exportLabel = document.createElement('span');
        exportLabel.textContent = 'Export Match Log';
        exportOption.appendChild(exportIcon);
        exportOption.appendChild(exportLabel);
        exportOption.addEventListener('click', async () => {
            this.hideMatchContextMenu();
            try {
                if (!match.bufferId) {
                    NotificationManager.show('No match data available to export', 'info');
                    return;
                }
                const result = await window.arenaCoach.logs.export(match.bufferId);
                if (result.success) {
                    // zipPath guaranteed by discriminated union
                    const revealResult = await window.arenaCoach.shell.showItemInFolder(result.zipPath);
                    if (revealResult.success) {
                        NotificationManager.show('Match log exported to Downloads', 'success');
                    } else {
                        NotificationManager.show('Match log exported to Downloads', 'success');
                        console.warn('[MatchUI] Could not reveal exported file:', revealResult.error, revealResult.code);
                    }
                } else {
                    // error guaranteed by discriminated union
                    NotificationManager.show(`Export failed: ${result.error}`, 'error');
                }
            } catch (error) {
                console.error('Failed to export match log:', error);
                NotificationManager.show('Failed to export match log', 'error');
            }
        });
        menu.appendChild(exportOption);

        // Prevent native context menu on the custom menu itself
        menu.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });

        document.body.appendChild(menu);

        // Track close handler for cleanup
        const closeHandler = (event) => {
            if (!menu.contains(event.target)) {
                this.hideMatchContextMenu();
            }
        };

        // Store handler reference for cleanup
        this._contextMenuCloseHandler = closeHandler;

        // Attach close listeners immediately (stopPropagation on originating event prevents immediate close)
        document.addEventListener('click', closeHandler);
        document.addEventListener('contextmenu', closeHandler);
    }

    /**
     * Hide the match context menu
     */
    hideMatchContextMenu() {
        // Remove listeners if they exist
        if (this._contextMenuCloseHandler) {
            document.removeEventListener('click', this._contextMenuCloseHandler);
            document.removeEventListener('contextmenu', this._contextMenuCloseHandler);
            this._contextMenuCloseHandler = null;
        }

        const existingMenu = document.querySelector('.match-context-menu');
        if (existingMenu) {
            existingMenu.remove();
        }
    }

    destroy() {
        // Clean up context menu if open
        this.hideMatchContextMenu();

        // Stop recording state monitoring
        this.stopRecordingStateMonitoring();
        // Stop match state monitoring
        this.stopMatchActiveMonitoring();
        // Stop settings listener
        this.stopSettingsListener();

        this.ipcListeners.forEach(cleanup => cleanup());
        this.ipcListeners = [];

        // Clear maps to prevent memory leaks
        this.jobToMatchHashMap.clear();
        this.unprocessedCompletions.clear();
    }
}
