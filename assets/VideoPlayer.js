/**
 * Video Player with Timeline and Shuffle Round Segments
 * Handles all video playback controls and timeline rendering
 */
class VideoPlayer {
    // Event system constants
    static EVENT_CLUSTER_WINDOW_PERCENT = 0.02; // 2% of total duration
    static TOOLTIP_SPACING_PX = 6; // Gap between icon and tooltip
    static TOOLTIP_MARGIN_PX = 8; // Tooltip container margin
    static EVENT_PRE_ROLL_SEC = 3; // Seconds to seek before an event

    // Playback control constants
    static PLAYBACK_SPEEDS = [0.25, 0.5, 1, 1.5, 2];
    static DEFAULT_PLAYBACK_SPEED = 1;
    static ARROW_SEEK_STEP_SEC = 5; // Arrow key skip interval
    static JL_SEEK_STEP_SEC = 10; // J/L key skip interval
    static VOLUME_STEP = 0.05; // Volume adjustment per keypress
    
    constructor({ videoElement, containerElement, metadata, shuffleRounds, defaultMistakeView = 'all' }) {
        // Validate required elements
        if (!videoElement || !(videoElement instanceof HTMLVideoElement)) {
            throw new Error('VideoPlayer: videoElement is required and must be an HTMLVideoElement');
        }
        if (!containerElement || !(containerElement instanceof HTMLElement)) {
            throw new Error('VideoPlayer: containerElement is required and must be an HTMLElement');
        }

        this.video = videoElement;
        this.container = containerElement;
        this.metadata = metadata;
        this.shuffleRounds = shuffleRounds || [];
        this.defaultMistakeView = defaultMistakeView === 'mine' ? 'mine' : 'all';

        // Load and apply saved volume preferences (video element is canonical source)
        const savedVolume = this.loadSavedVolume();
        this.video.volume = savedVolume.volume;
        this.video.muted = savedVolume.muted;
        this.lastNonZeroVolume = savedVolume.volume > 0.01 ? savedVolume.volume : 1;

        // State management
        this.isPlaying = false;
        this.isDragging = false;
        this.duration = 0;
        this.currentTime = 0;
        
        // Events system
        this.events = this.processEventsData(metadata?.events || []);
        this.clusters = [];
        this.clusterTicks = [];
        this.clusterIcons = [];
        this.activeTooltip = null;
        // Filters
        this.filterState = new Map(); // category => boolean
        this.filterPanel = null;
        this._onFilterOutsideClick = null;
        
        // RAF tracking
        this.rafId = null;
        this._timelineRafId = null;
        this._eventRepositionRafId = null;
        
        // DOM references
        this.controlsBar = null;
        this.currentTimeDisplay = null;
        this.durationDisplay = null;
        
        // Events DOM references
        this.eventsLane = null;
        this.eventsObserver = null;
        
        // Event listener tracking for cleanup
        this.boundEventHandlers = new Map();
        
        // Keyboard shortcuts
        this._onKeyDown = null;
        this._onResize = null;
        this._onFullscreen = null;
        this._resizeObserver = null;
        this._footerResizeObserver = null;

        // Active drag cleanup (for mid-drag destroy)
        this._activeDragCleanup = null;

        this.init();
    }
    
    /**
     * Get accent color with alpha from CSS variable.
     * Expects --primary-accent to be rgb(), rgba(), or #RRGGBB format.
     */
    getAccentColor(alpha = 1) {
        const root = document.documentElement;
        const accent = getComputedStyle(root).getPropertyValue('--primary-accent').trim();

        // Parse rgb() / rgba()
        if (accent.startsWith('rgb')) {
            const parts = accent.replace(/rgba?\(|\)|\s/g, '').split(',');
            const [r, g, b] = parts.slice(0, 3).map(Number);
            if ([r, g, b].every(Number.isFinite)) {
                return `rgba(${r}, ${g}, ${b}, ${alpha})`;
            }
        }

        // Parse hex (#RRGGBB)
        const m = accent.match(/^#([0-9a-fA-F]{6})$/);
        if (m) {
            const r = parseInt(m[1].slice(0, 2), 16);
            const g = parseInt(m[1].slice(2, 4), 16);
            const b = parseInt(m[1].slice(4, 6), 16);
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }

        // Unparseable format - warn and return empty to clear inline style (CSS is SSoT)
        console.warn('VideoPlayer: Could not parse --primary-accent for alpha adjustment:', accent);
        return '';
    }
    
    /**
     * Process events data from metadata into a flat array with positioning info
     */
    processEventsData(eventsData) {
        if (!Array.isArray(eventsData)) {
            throw new Error('VideoPlayer: eventsData must be an array');
        }
        const processedEvents = [];

        eventsData.forEach((category, index) => {
            if (!category || typeof category !== 'object') {
                throw new Error(`VideoPlayer: Event category at index ${index} must be an object`);
            }
            if (!category.category || typeof category.category !== 'string') {
                throw new Error('VideoPlayer: Event category must have a non-empty string category');
            }
            // Skip categories with no items, but throw if items exists and isn't an array
            if (category.items === undefined || category.items === null) {
                return;
            }
            if (!Array.isArray(category.items)) {
                throw new Error(`VideoPlayer: category.items must be an array, got: ${typeof category.items}`);
            }
            category.items.forEach((event, eventIndex) => {
                if (!event || typeof event !== 'object') {
                    throw new Error(`VideoPlayer: Event at index ${eventIndex} in category "${category.category}" must be an object`);
                }
                if (!Number.isFinite(event.timestamp)) {
                    throw new Error(`VideoPlayer: Event timestamp must be a finite number, got: ${event.timestamp}`);
                }
                processedEvents.push({
                    category: category.category,
                    timestamp: event.timestamp,
                    description: event.description,
                    data: event.data
                });
            });
        });
        
        // Sort by timestamp for consistent rendering order
        return processedEvents.sort((a, b) => a.timestamp - b.timestamp);
    }
    
    /**
     * Get icon SVG for event category
     */
    getEventIcon(category) {
        const iconMap = {
            'death': { icon: 'death-skull.svg', label: 'Death' },
            'cc': { icon: 'crossed-chains.svg', label: 'CC' },
            'interrupt': { icon: 'tread.svg', label: 'Interrupt' },
            'dispel': { icon: 'magic-swirl.svg', label: 'Dispel' },
            'defensive': { icon: 'shield-disabled.svg', label: 'Defensive' },
            'offensive': { icon: 'stopwatch.svg', label: 'Offensive' },
            'cooldown': { icon: 'hourglass.svg', label: 'Cooldown' },
        };
        const cfg = iconMap[category];
        if (cfg && cfg.icon) {
            return `<img src="images/events/${cfg.icon}" alt="${cfg.label}" />`;
        }
        // Unknown category - warn and return neutral dot
        console.warn('VideoPlayer: Unknown event category, using neutral icon:', category);
        return `
            <svg viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="12" r="8"/>
            </svg>
        `;
    }
    
    /**
     * Get player spec ID from metadata
     */
    getPlayerSpecId(playerId) {
        if (!playerId || !this.metadata || !Array.isArray(this.metadata.players)) return null;
        const player = this.metadata.players.find(p => p.id === playerId);
        return player?.specId ?? null;
    }

    normalizePlayerName(name) {
        if (!name) return null;
        const raw = String(name).trim();
        if (!raw) return null;
        const base = raw.split('-')[0].trim();
        return base || null;
    }
    
    
    init() {
        // Set default playback rate (volume already applied in constructor)
        this.video.playbackRate = VideoPlayer.DEFAULT_PLAYBACK_SPEED;

        // Render controls first so update* methods have valid DOM references
        this.renderControls();
        this.renderTimeline();

        // Bind events after controls exist
        this.bindVideoEvents();
        this.bindKeyboardShortcuts();

        // Sync control states with video element
        this.updateSpeedButton();
        this.updateVolumeControls();

        // Wait for video metadata before initializing timeline
        if (this.video.duration) {
            this.onLoadedMetadata();
        }
        // The 'loadedmetadata' listener attached in bindVideoEvents() handles the async case
    }
    
    bindVideoEvents() {
        // Create bound handlers for proper cleanup
        const playHandler = () => {
            this.isPlaying = true;
            this.updatePlayPauseButton();
            this.startProgressUpdates();
        };
        
        const pauseHandler = () => {
            this.isPlaying = false;
            this.updatePlayPauseButton();
            this.stopProgressUpdates();
        };
        
        const volumeChangeHandler = () => {
            this.updateVolumeControls();
        };
        
        const rateChangeHandler = () => {
            // Enforce invariant: playback rate must be in PLAYBACK_SPEEDS
            if (!VideoPlayer.PLAYBACK_SPEEDS.includes(this.video.playbackRate)) {
                console.warn('VideoPlayer: Unsupported playback rate', this.video.playbackRate, '- normalizing to default');
                this.video.playbackRate = VideoPlayer.DEFAULT_PLAYBACK_SPEED;
                return; // Will trigger another ratechange event
            }
            this.updateSpeedButton();
        };
        
        const seekedHandler = () => {
            this.updateTimeline();
        };
        
        const loadedMetadataHandler = () => {
            this.onLoadedMetadata();
            this.updateFullscreenLayout();
        };
        
        // Click/double-click handlers for video element
        const videoClickHandler = () => this.togglePlayPause();
        const videoDoubleClickHandler = () => this.toggleFullscreen();
        
        // Add event listeners and store for cleanup
        this.video.addEventListener('play', playHandler);
        this.video.addEventListener('pause', pauseHandler);
        this.video.addEventListener('volumechange', volumeChangeHandler);
        this.video.addEventListener('ratechange', rateChangeHandler);
        this.video.addEventListener('seeked', seekedHandler);
        this.video.addEventListener('loadedmetadata', loadedMetadataHandler);
        this.video.addEventListener('click', videoClickHandler);
        this.video.addEventListener('dblclick', videoDoubleClickHandler);
        
        // Store handlers for cleanup
        this.boundEventHandlers.set('play', playHandler);
        this.boundEventHandlers.set('pause', pauseHandler);
        this.boundEventHandlers.set('volumechange', volumeChangeHandler);
        this.boundEventHandlers.set('ratechange', rateChangeHandler);
        this.boundEventHandlers.set('seeked', seekedHandler);
        this.boundEventHandlers.set('loadedmetadata', loadedMetadataHandler);
        this.boundEventHandlers.set('click', videoClickHandler);
        this.boundEventHandlers.set('dblclick', videoDoubleClickHandler);
    }
    
    bindKeyboardShortcuts() {
        this._onKeyDown = (e) => {
            // Ignore if typing in input fields
            const activeElement = document.activeElement;
            const isTyping = activeElement && (
                activeElement.tagName === 'INPUT' ||
                activeElement.tagName === 'TEXTAREA' ||
                activeElement.isContentEditable
            );
            if (isTyping) return;

            // Scope to player context: only handle if focus is on body/container/video
            const inPlayerContext = !activeElement ||
                activeElement === document.body ||
                this.container.contains(activeElement);
            if (!inPlayerContext) return;

            // Ignore modifier keys (Ctrl/Alt/Meta) for all shortcuts
            const hasModifier = e.ctrlKey || e.altKey || e.metaKey;
            if (hasModifier) return;

            const key = e.key;
            const keyLower = key.toLowerCase();

            // Character-based shortcuts (e.key for keyboard layout compatibility)
            switch (keyLower) {
                // Play/Pause: K (ignore repeat for toggle)
                case 'k':
                    if (e.repeat) return;
                    e.preventDefault();
                    this.togglePlayPause();
                    return;

                // Seek: J/L (10s) - allow repeat
                case 'j':
                    e.preventDefault();
                    this.seek(this.video.currentTime - VideoPlayer.JL_SEEK_STEP_SEC);
                    return;
                case 'l':
                    e.preventDefault();
                    this.seek(this.video.currentTime + VideoPlayer.JL_SEEK_STEP_SEC);
                    return;

                // Mute: M (ignore repeat for toggle)
                case 'm':
                    if (e.repeat) return;
                    e.preventDefault();
                    this.toggleMute();
                    return;

                // Fullscreen: F (ignore repeat for toggle)
                case 'f':
                    if (e.repeat) return;
                    e.preventDefault();
                    this.toggleFullscreen();
                    return;
            }

            // Number keys 0-9: seek to 0%-90% (e.key for layout compatibility)
            if (key >= '0' && key <= '9') {
                e.preventDefault();
                const digit = parseInt(key, 10);
                this.seek((digit / 10) * this.duration);
                return;
            }

            // Playback speed: < / > (e.key for layout compatibility)
            if (key === '<') {
                e.preventDefault();
                this.decreasePlaybackSpeed();
                return;
            }
            if (key === '>') {
                e.preventDefault();
                this.increasePlaybackSpeed();
                return;
            }

            // Special keys (e.code for physical key position)
            switch (e.code) {
                // Play/Pause: Space (ignore repeat for toggle)
                case 'Space':
                    if (e.repeat) return;
                    e.preventDefault();
                    this.togglePlayPause();
                    break;

                // Seek: Arrow keys (5s) - allow repeat
                case 'ArrowLeft':
                    e.preventDefault();
                    this.seek(this.video.currentTime - VideoPlayer.ARROW_SEEK_STEP_SEC);
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    this.seek(this.video.currentTime + VideoPlayer.ARROW_SEEK_STEP_SEC);
                    break;

                // Volume: Up/Down arrows - allow repeat
                case 'ArrowUp':
                    e.preventDefault();
                    this.setVolume(Math.min(1, this.video.volume + VideoPlayer.VOLUME_STEP));
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    this.setVolume(Math.max(0, this.video.volume - VideoPlayer.VOLUME_STEP));
                    break;

                // Beginning/End: Home/End
                case 'Home':
                    e.preventDefault();
                    this.seek(0);
                    break;
                case 'End':
                    e.preventDefault();
                    this.seek(this.duration);
                    break;
            }
        };

        window.addEventListener('keydown', this._onKeyDown, true);
    }
    
    onLoadedMetadata() {
        this.duration = this.video.duration;
        if (this.shuffleRounds && this.shuffleRounds.length) {
            this.renderShuffleSegments();
        } else {
            // Non-shuffle: set faint base + strong played colors
            if (this.track && this.played) {
                this.track.style.backgroundImage = '';
                this.track.style.backgroundColor = this.getAccentColor(0.25);
                this.played.style.backgroundImage = '';
                this.played.style.backgroundColor = this.getAccentColor(1);
            }
        }
        this.renderEventMarkers();
        this.updateDurationDisplay();
    }
    
    renderControls() {
        // Create footer structure (bottom-up)
        this.footer = document.createElement('div');
        this.footer.className = 'player-footer';
        
        // Events lane (top of footer - contains event cluster icons)
        this.eventsLane = document.createElement('div');
        this.eventsLane.className = 'events-lane';
        
        // Timeline row (middle of footer)
        this.timelineRow = document.createElement('div');
        this.timelineRow.className = 'timeline-row';
        
        // Controls bar (bottom of footer)
        this.controlsBar = document.createElement('div');
        this.controlsBar.className = 'controls-bar';
        
        // Build controls with left/right grouping
        const controlsLeft = document.createElement('div');
        controlsLeft.className = 'controls-left';
        
        const controlsRight = document.createElement('div');
        controlsRight.className = 'controls-right';
        
        // Play/Pause button
        const playPauseBtn = document.createElement('button');
        playPauseBtn.className = 'control-btn play-pause-btn';
        playPauseBtn.innerHTML = `
            <svg class="play-icon" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z"/>
            </svg>
            <svg class="pause-icon" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
            </svg>
        `;
        playPauseBtn.addEventListener('click', () => this.togglePlayPause());
        playPauseBtn.tabIndex = -1; // Prevent tab focus to ensure spacebar works
        this.playPauseBtn = playPauseBtn;
        
        // Volume controls (custom bar with pointer capture)
        const volumeContainer = document.createElement('div');
        volumeContainer.className = 'volume-container';
        
        const muteBtn = document.createElement('button');
        muteBtn.className = 'control-btn mute-btn';
        muteBtn.innerHTML = `
            <svg class="volume-on-icon" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
            </svg>
            <svg class="volume-off-icon" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
            </svg>
        `;
        muteBtn.addEventListener('click', () => this.toggleMute());
        muteBtn.tabIndex = -1;
        this.muteBtn = muteBtn;

        // Custom volume bar structure
        const volumeBar = document.createElement('div');
        volumeBar.className = 'volume-bar';
        const volumeTrack = document.createElement('div');
        volumeTrack.className = 'volume-track';
        const volumeLevel = document.createElement('div');
        volumeLevel.className = 'volume-level';
        const volumeThumb = document.createElement('div');
        volumeThumb.className = 'volume-thumb';
        volumeTrack.appendChild(volumeLevel);
        volumeBar.appendChild(volumeTrack);
        volumeBar.appendChild(volumeThumb);

        // Pointer events with capture for robust drag
        volumeBar.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            const rect = volumeTrack.getBoundingClientRect();
            if (rect.width <= 0) return; // Guard against zero-width element
            // Clean up any existing drag before starting new one
            if (this._activeDragCleanup) {
                this._activeDragCleanup();
            }
            const pointerId = e.pointerId;
            const updateAt = (clientX) => {
                const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
                const v = x / rect.width;
                this.setVolume(v, true);
            };
            updateAt(e.clientX);
            volumeBar.setPointerCapture?.(pointerId);
            const move = (ev) => updateAt(ev.clientX);
            const cleanup = () => {
                this._activeDragCleanup = null;
                if (volumeBar.hasPointerCapture?.(pointerId)) {
                    volumeBar.releasePointerCapture(pointerId);
                }
                window.removeEventListener('pointermove', move, true);
                window.removeEventListener('pointerup', cleanup, true);
                window.removeEventListener('pointercancel', cleanup, true);
                window.removeEventListener('blur', cleanup, true);
            };
            this._activeDragCleanup = cleanup;
            window.addEventListener('pointermove', move, true);
            window.addEventListener('pointerup', cleanup, true);
            window.addEventListener('pointercancel', cleanup, true);
            window.addEventListener('blur', cleanup, true);
        });

        // Store refs for UI updates
        this._volumeTrack = volumeTrack;
        this._volumeLevel = volumeLevel;
        this._volumeThumb = volumeThumb;
        
        // Update volume UI after layout is ready
        requestAnimationFrame(() => {
            if (this._volumeTrack && this._volumeLevel && this._volumeThumb) {
                this.updateVolumeUI(this._volumeTrack, this._volumeLevel, this._volumeThumb);
            }
        });
        
        // Also update on volume track resize
        if (typeof ResizeObserver !== 'undefined' && volumeTrack) {
            const volumeObserver = new ResizeObserver(() => {
                if (this._volumeTrack && this._volumeLevel && this._volumeThumb) {
                    this.updateVolumeUI(this._volumeTrack, this._volumeLevel, this._volumeThumb);
                }
            });
            volumeObserver.observe(volumeTrack);
            this._volumeObserver = volumeObserver;
        }

        volumeContainer.append(muteBtn, volumeBar);
        
        // Time display
        const timeDisplay = document.createElement('div');
        timeDisplay.className = 'time-display';
        
        this.currentTimeDisplay = document.createElement('span');
        this.currentTimeDisplay.className = 'current-time';
        this.currentTimeDisplay.textContent = '0:00';
        
        const timeSeparator = document.createElement('span');
        timeSeparator.textContent = ' / ';
        
        this.durationDisplay = document.createElement('span');
        this.durationDisplay.className = 'duration-time';
        this.durationDisplay.textContent = '0:00';
        
        timeDisplay.append(this.currentTimeDisplay, timeSeparator, this.durationDisplay);
        
        // Left controls group
        controlsLeft.append(playPauseBtn, volumeContainer, timeDisplay);
        
        // Filter button (disabled when no events)
        const filterBtn = document.createElement('button');
        filterBtn.className = 'control-btn filter-btn';
        filterBtn.innerHTML = `
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z"/>
            </svg>
        `;
        filterBtn.title = this.events.length > 0 ? 'Filter events & players' : 'No events available';
        filterBtn.disabled = this.events.length === 0;
        filterBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!filterBtn.disabled) {
                this.toggleFilterPanel();
            }
        });
        filterBtn.tabIndex = -1; // Prevent tab focus to ensure spacebar works
        this.filterBtn = filterBtn;
        
        // Speed control
        const speedBtn = document.createElement('button');
        speedBtn.className = 'control-btn speed-btn';
        speedBtn.textContent = `${VideoPlayer.DEFAULT_PLAYBACK_SPEED}x`;
        speedBtn.addEventListener('click', () => this.cyclePlaybackSpeed());
        speedBtn.tabIndex = -1; // Prevent tab focus to ensure spacebar works
        this.speedBtn = speedBtn;
        
        // Fullscreen button
        const fullscreenBtn = document.createElement('button');
        fullscreenBtn.className = 'control-btn fullscreen-btn';
        fullscreenBtn.innerHTML = `
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>
            </svg>
        `;
        fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());
        fullscreenBtn.tabIndex = -1; // Prevent tab focus to ensure spacebar works
        
        // Right controls group
        controlsRight.append(filterBtn, speedBtn, fullscreenBtn);
        
        this.controlsBar.append(controlsLeft, controlsRight);
        
        // Prevent focus highlights on button controls
        [playPauseBtn, muteBtn, speedBtn, filterBtn, fullscreenBtn].forEach(btn => {
            btn.addEventListener('mousedown', e => e.preventDefault()); // Prevent focus ring
        });
        
        // Assemble footer structure
        this.footer.append(this.eventsLane, this.timelineRow, this.controlsBar);
        this.container.appendChild(this.footer);
        // After controls are in DOM, adjust layout for fullscreen to avoid covering video
        requestAnimationFrame(() => this.updateFullscreenLayout());
        // Observe footer size changes to keep layout correct in fullscreen
        if (typeof ResizeObserver !== 'undefined' && this.footer) {
            this._footerResizeObserver = new ResizeObserver(() => this.updateFullscreenLayout());
            this._footerResizeObserver.observe(this.footer);
        }
        
        // Set up events lane for resize observation
        this.setupEventLaneResizeObserver();
        this.initializeFilterState();
    }

    /**
     * Deterministic player display name from metadata (name[-realm][-region])
     */
    getPlayerDisplayName(playerId) {
        if (!playerId || !this.metadata || !Array.isArray(this.metadata.players)) return null;
        const p = this.metadata.players.find(pl => pl.id === playerId);
        if (!p) return null;
        return this.normalizePlayerName(p.name);
    }

    getFilterPlayers() {
        const playersById = new Map();
        const upsertPlayer = (playerId, playerName, hasEvent) => {
            if (!playerId) return;
            const existing = playersById.get(playerId);
            const normalizedName = this.normalizePlayerName(playerName);
            if (!existing) {
                playersById.set(playerId, {
                    playerId,
                    playerName: normalizedName || playerId,
                    eventCount: hasEvent === true ? 1 : 0
                });
                return;
            }
            if (hasEvent === true) {
                existing.eventCount += 1;
            }
            if ((existing.playerName === existing.playerId || !existing.playerName) && normalizedName) {
                existing.playerName = normalizedName;
            }
        };

        if (Array.isArray(this.metadata?.players)) {
            this.metadata.players.forEach(player => {
                upsertPlayer(player?.id, player?.name, false);
            });
        }

        this.events.forEach(event => {
            upsertPlayer(event?.data?.playerId, event?.data?.playerName, true);
        });

        return [...playersById.values()].sort((a, b) => {
            if (b.eventCount !== a.eventCount) {
                return b.eventCount - a.eventCount;
            }
            const nameA = String(a.playerName || a.playerId || '').toLowerCase();
            const nameB = String(b.playerName || b.playerId || '').toLowerCase();
            const byName = nameA.localeCompare(nameB);
            if (byName !== 0) return byName;
            return String(a.playerId).localeCompare(String(b.playerId));
        });
    }

    shouldEnableAllPlayersByDefault(recordingPlayerId) {
        if (!recordingPlayerId) return true;
        return this.defaultMistakeView === 'all';
    }

    initializeFilterState() {
        const categories = new Set(this.events.map(e => e.category));
        categories.forEach(cat => this.filterState.set(cat, true));

        // Initialize player filter from all known players, not only players with event items.
        const players = this.getFilterPlayers();
        if (!this.playerFilterState) this.playerFilterState = new Map();
        const recordingPlayerId = this.metadata?.playerId;
        const enableAllPlayersByDefault = this.shouldEnableAllPlayersByDefault(recordingPlayerId);
        players.forEach(player => {
            if (player.eventCount === 0) {
                this.playerFilterState.set(player.playerId, false);
                return;
            }
            this.playerFilterState.set(
                player.playerId,
                enableAllPlayersByDefault ? true : player.playerId === recordingPlayerId
            );
        });
    }

    toggleFilterPanel() {
        if (this.filterPanel) {
            this.closeFilterPanel();
            return;
        }
        const panel = document.createElement('div');
        panel.className = 'events-filter-panel';
        
        // Single column layout
        const filterList = document.createElement('div');
        filterList.className = 'events-filter-list';
        
        // Categories section
        const catHead = document.createElement('div');
        catHead.className = 'events-filter-heading';
        catHead.textContent = 'Events';
        filterList.appendChild(catHead);
        
        const categories = [...new Set(this.events.map(e => e.category))];
        categories.forEach(cat => {
            const row = document.createElement('label');
            row.className = 'events-filter-item';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = this.filterState.get(cat) !== false;
            checkbox.addEventListener('change', () => {
                this.filterState.set(cat, checkbox.checked);
                this.renderEventMarkers();
            });
            
            const text = document.createElement('span');
            text.className = 'events-filter-text';
            const labelMap = { cc: 'CC', death: 'Death', defensive: 'Defensive', interrupt: 'Interrupt' };
            text.textContent = labelMap[cat] || (cat.charAt(0).toUpperCase() + cat.slice(1));
            
            row.append(checkbox, text);
            filterList.appendChild(row);
        });
        
        // Players section
        const playerHead = document.createElement('div');
        playerHead.className = 'events-filter-heading';
        playerHead.textContent = 'Players';
        filterList.appendChild(playerHead);
        // Build players from match metadata first, with event-data fallback for names.
        const players = this.getFilterPlayers();
        players.forEach(({ playerId, playerName, eventCount }) => {
            const hasEvents = eventCount > 0;
            const row = document.createElement('label');
            row.className = 'events-filter-item';
            if (!hasEvents) {
                row.classList.add('is-disabled');
                row.title = 'No events for this player in this match';
            }
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.disabled = !hasEvents;
            const enabled = this.playerFilterState.get(playerId);
            checkbox.checked = hasEvents ? enabled !== false : false; // default on when available
            checkbox.addEventListener('change', () => {
                // Defensive invariant in case this handler is ever invoked programmatically.
                if (!hasEvents) return;
                this.playerFilterState.set(playerId, checkbox.checked);
                this.renderEventMarkers();
            });
            
            const nameGroup = document.createElement('span');
            nameGroup.className = 'events-filter-name-group';

            // Only create spec icon if we have a valid path
            const specId = this.getPlayerSpecId(playerId);
            if (typeof window.AssetManager?.getSpecIconPath === 'function' && specId) {
                const p = window.AssetManager.getSpecIconPath(specId);
                if (p) {
                    const specIcon = document.createElement('img');
                    specIcon.className = 'events-filter-spec';
                    specIcon.src = p;
                    specIcon.alt = '';
                    nameGroup.appendChild(specIcon);
                }
            }

            const text = document.createElement('span');
            text.className = 'events-filter-text events-filter-player-name';
            const displayName = playerName || playerId;
            text.textContent = displayName;

            const count = document.createElement('span');
            count.className = 'events-filter-player-count';
            count.textContent = `(${eventCount})`;

            nameGroup.append(text, count);
            row.append(checkbox, nameGroup);
            filterList.appendChild(row);
        });
        
        panel.appendChild(filterList);
        // Position panel above the filter button, aligned to button right edge
        const btnRect = this.filterBtn.getBoundingClientRect();
        const containerRect = this.container.getBoundingClientRect();
        panel.style.right = `${containerRect.right - btnRect.right}px`;
        panel.style.bottom = `${this.container.offsetHeight - (btnRect.top - containerRect.top) + 8}px`;
        this.container.appendChild(panel);
        this.filterPanel = panel;
        
        // Close on outside click (check button and its children like SVG/path)
        const handler = (ev) => {
            const clickedPanel = panel.contains(ev.target);
            const clickedFilterBtn = this.filterBtn.contains(ev.target);
            if (!clickedPanel && !clickedFilterBtn) {
                this.closeFilterPanel();
            }
        };
        this._onFilterOutsideClick = handler;
        // Defer listener to next microtask to avoid catching the opening click
        queueMicrotask(() => {
            if (this._onFilterOutsideClick !== handler) return;
            document.addEventListener('click', handler, true);
        });
    }

    closeFilterPanel() {
        if (this.filterPanel) {
            this.filterPanel.remove();
            this.filterPanel = null;
        }
        if (this._onFilterOutsideClick) {
            document.removeEventListener('click', this._onFilterOutsideClick, true);
            this._onFilterOutsideClick = null;
        }
    }
    
    renderTimeline() {
        // Timeline track (with gradient background for rounds)
        this.track = document.createElement('div');
        this.track.className = 'timeline-track';
        
        // Played overlay (left of playhead) - shows progress with optional shuffle round colors
        this.played = document.createElement('div');
        this.played.className = 'timeline-played';

        // Playhead (colored circle indicator)
        this.playhead = document.createElement('div');
        this.playhead.className = 'timeline-playhead';

        // Hitbox for larger clickable area
        this.hitbox = document.createElement('div');
        this.hitbox.className = 'timeline-hitbox';
        
        this.track.appendChild(this.played);
        this.track.appendChild(this.playhead);
        this.track.appendChild(this.hitbox);
        this.timelineRow.appendChild(this.track);
        
        // Pointer-based interactions (robust drag with capture)
        const onPointerDown = (e) => {
            e.preventDefault();
            const rect = this.track.getBoundingClientRect();
            if (rect.width <= 0) return; // Guard against zero-width element
            // Clean up any existing drag before starting new one
            if (this._activeDragCleanup) {
                this._activeDragCleanup();
            }
            const captureEl = e.currentTarget; // Capture on element that received the event
            const pointerId = e.pointerId;
            const updateAt = (clientX) => {
                const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
                this.seek((x / rect.width) * this.duration);
            };
            updateAt(e.clientX);
            this.isDragging = true;
            if (this.playhead) {
                this.playhead.classList.add('is-dragging');
            }
            captureEl.setPointerCapture?.(pointerId);
            const move = (ev) => updateAt(ev.clientX);
            const cleanup = () => {
                this._activeDragCleanup = null;
                this.isDragging = false;
                if (captureEl.hasPointerCapture?.(pointerId)) {
                    captureEl.releasePointerCapture(pointerId);
                }
                window.removeEventListener('pointermove', move, true);
                window.removeEventListener('pointerup', cleanup, true);
                window.removeEventListener('pointercancel', cleanup, true);
                window.removeEventListener('blur', cleanup, true);
                if (this.playhead) {
                    this.playhead.classList.remove('is-dragging');
                }
            };
            this._activeDragCleanup = cleanup;
            window.addEventListener('pointermove', move, true);
            window.addEventListener('pointerup', cleanup, true);
            window.addEventListener('pointercancel', cleanup, true);
            window.addEventListener('blur', cleanup, true);
        };
        this.hitbox.addEventListener('pointerdown', onPointerDown);
        this.playhead.addEventListener('pointerdown', onPointerDown);

        // Observe size changes to keep overlay/playhead in sync (resize/fullscreen/layout)
        if (typeof ResizeObserver !== 'undefined') {
            this._resizeObserver = new ResizeObserver(() => this._scheduleTimelineUpdate());
            this._resizeObserver.observe(this.track);
        }
        this._onResize = () => this._scheduleTimelineUpdate();
        this._onFullscreen = () => {
            // Adjust layout for fullscreen and update timeline
            requestAnimationFrame(() => {
                this.updateFullscreenLayout();
                this._scheduleTimelineUpdate();
            });
        };
        window.addEventListener('resize', this._onResize, true);
        document.addEventListener('fullscreenchange', this._onFullscreen, true);
    }

    /**
     * Ensure the custom footer does not cover the video in fullscreen.
     * Reduces video height by footer height when this.container is fullscreen.
     */
    updateFullscreenLayout() {
        const isFullscreen = document.fullscreenElement === this.container;
        const footerHeight = this.footer ? this.footer.offsetHeight : 0;
        if (isFullscreen && footerHeight > 0) {
            // Reserve space for controls at the bottom
            this.video.style.height = `calc(100% - ${footerHeight}px)`;
            this.video.style.maxHeight = `calc(100% - ${footerHeight}px)`;
            this.video.style.display = 'block';
        } else {
            // Reset when not fullscreen
            this.video.style.height = '';
            this.video.style.maxHeight = '';
            this.video.style.display = '';
        }
    }
    
    buildShuffleGradient(rounds, totalSec, alpha = 1) {
        if (!rounds?.length || !totalSec) return null;
        // Hard edges only: color strictly within [start, end], transparent elsewhere.
        const ordered = [...rounds].sort((a, b) => a.startTimestamp - b.startTimestamp);
        const stops = [];
        const toPct = (ms) => Math.max(0, Math.min(100, +(((ms / 1000) / totalSec) * 100).toFixed(3)));
        const transparent = 'rgba(0,0,0,0)';

        // Start transparent
        stops.push(`${transparent} 0%`);

        ordered.forEach(round => {
            const startPct = toPct(round.startTimestamp);
            const endPct = toPct(round.endTimestamp);
            if (!(endPct > startPct)) return;

            const result = this.calculateRecordingPlayerWon(round);
            let color;
            if (result === true) {
                color = `rgba(74, 222, 128, ${alpha})`; // Win - green
            } else if (result === false) {
                color = `rgba(248, 113, 113, ${alpha})`; // Loss - red
            } else {
                // Unknown outcome is expected for early-ended/incomplete rounds.
                // Skip this segment without noisy logs.
                return;
            }
            // Create hard stop by duplicating stops at exact boundaries
            stops.push(`${transparent} ${startPct}%`, `${color} ${startPct}%`, `${color} ${endPct}%`, `${transparent} ${endPct}%`);
        });

        // Ensure end transparent
        stops.push(`${transparent} 100%`);
        return `linear-gradient(to right, ${stops.join(', ')})`;
    }
    
    /**
     * Determine if recording player won the round.
     * Returns: true (won), false (lost), or null (unknown/missing data)
     */
    calculateRecordingPlayerWon(round) {
        // Missing required data - return null (unknown)
        if (!this.metadata?.playerId || round.winningTeamId === undefined) {
            return null;
        }

        // Find which team the recording player is on
        const isOnTeam0 = round.team0Players?.includes(this.metadata.playerId);
        const isOnTeam1 = round.team1Players?.includes(this.metadata.playerId);

        if (isOnTeam0) {
            return round.winningTeamId === 0;
        } else if (isOnTeam1) {
            return round.winningTeamId === 1;
        }

        // Player not found in either team - return null (unknown)
        return null;
    }
    
    renderShuffleSegments() {
        if (!this.duration || !this.shuffleRounds?.length) return;
        
        const totalSec = this.duration;
        const baseGradient = this.buildShuffleGradient(this.shuffleRounds, totalSec, 0.25);
        const fullGradient = this.buildShuffleGradient(this.shuffleRounds, totalSec, 1);

        if (this.track) {
            // Always set base color; overlay colored rounds as a transparent gradient
            this.track.style.backgroundColor = this.getAccentColor(0.25);
            this.track.style.backgroundImage = baseGradient || '';
        }
        if (this.played) {
            // Always set base played color; overlay colored rounds
            this.played.style.backgroundColor = this.getAccentColor(1);
            this.played.style.backgroundImage = fullGradient || '';
        }
    }
    
    /**
     * Render clustered event markers: timeline ticks + icons above timeline
     */
    renderEventMarkers() {
        if (!this.duration || !this.events.length || !this.track || !this.eventsLane) {
            return;
        }

        // Clear existing markers
        this.clearEventMarkers();

        // Active categories
        const active = new Set(
            [...this.filterState.entries()].filter(([,v]) => v).map(([k]) => k)
        );
        // Player filter
        const playerActive = this.playerFilterState ? new Set(
            [...this.playerFilterState.entries()].filter(([,v]) => v).map(([k]) => k)
        ) : null;
        let filtered = this.events;
        
        // Always apply category filter (empty active set = show nothing)
        filtered = filtered.filter(e => active.has(e.category));
        
        // Apply player filter - if no players selected, show no events
        if (playerActive) {
            filtered = filtered.filter(e => e.data?.playerId && playerActive.has(e.data.playerId));
        }
        // Build clusters by time proximity
        this.clusters = this.clusterEventsByTime(filtered);

        // Position and render
        this.calculateClusterPositions();
        this.renderEventTicks();
        this.renderClusterIcons();
        this.bindClusterInteractions();
    }

    /**
     * Group events into anchored time clusters using a duration-relative window.
     * Window = durationMs * EVENT_CLUSTER_WINDOW_PERCENT.
     * Greedy grouping anchored at the first event: subsequent events join while within the window from the anchor.
     * If duration is unavailable, do not group (each event forms its own cluster).
     */
    clusterEventsByTime(source) {
        if (!Array.isArray(source)) {
            throw new Error('VideoPlayer: clusterEventsByTime requires an array');
        }
        const clusters = [];
        if (!source.length) return clusters;

        const durationMs = (typeof this.duration === 'number' && isFinite(this.duration) ? this.duration : 0) * 1000;
        if (durationMs <= 0) {
            // Deterministic fail-out: no duration -> no grouping
            return source.map(evt => ({ anchorMs: evt.timestamp, events: [evt] }));
        }
        const windowMs = Math.max(1, Math.floor(durationMs * VideoPlayer.EVENT_CLUSTER_WINDOW_PERCENT));

        let current = null;
        for (const evt of source) {
            if (!current) {
                current = { anchorMs: evt.timestamp, events: [evt] };
                clusters.push(current);
                continue;
            }
            const delta = evt.timestamp - current.anchorMs;
            if (delta <= windowMs) {
                current.events.push(evt);
            } else {
                current = { anchorMs: evt.timestamp, events: [evt] };
                clusters.push(current);
            }
        }
        return clusters;
    }

    /**
     * Calculate pixel x for each cluster using geometry (no magic insets)
     */
    calculateClusterPositions() {
        if (!this.track || !this.eventsLane || !this.clusters.length) return;
        
        const laneRect = this.eventsLane.getBoundingClientRect();
        const trackRect = this.track.getBoundingClientRect();
        const durationMs = this.duration * 1000;

        this.clusters.forEach((cluster, index) => {
            cluster.id = `c${index}`;
            const pct = Math.max(0, Math.min(1, cluster.anchorMs / durationMs));
            const leftInTrack = pct * this.track.clientWidth;
            const leftInLane = (trackRect.left - laneRect.left) + leftInTrack;
            cluster._leftPxTrack = leftInTrack;
            cluster._leftPxLane = leftInLane;
        });
    }

    /**
     * Render thin vertical ticks directly on the timeline track (one per cluster)
     */
    renderEventTicks() {
        this.clusterTicks = [];
        this.clusters.forEach(cluster => {
            const tick = document.createElement('div');
            tick.className = 'event-tick';
            tick.dataset.clusterId = cluster.id;
            // Absolute within track
            tick.style.left = `${cluster._leftPxTrack}px`;
            this.track.appendChild(tick);
            this.clusterTicks.push(tick);
        });
    }

    /**
     * Render floating icons above timeline (one per cluster)
     */
    renderClusterIcons() {
        this.clusterIcons = [];
        this.clusters.forEach(cluster => {
            const first = cluster.events[0];
            const iconWrap = document.createElement('div');
            iconWrap.className = 'cluster-icon';
            iconWrap.dataset.clusterId = cluster.id;
            iconWrap.dataset.category = first.category;
            iconWrap.style.left = `${cluster._leftPxLane}px`;

            const icon = document.createElement('div');
            icon.className = 'cluster-icon-svg';
            icon.innerHTML = this.getEventIcon(first.category);

            // Expand hoverable area with an invisible ring to bridge the gap to tooltip
            const hit = document.createElement('div');
            hit.className = 'cluster-hitbox';
            // no visual styles here; CSS will size/position

            iconWrap.appendChild(hit);
            iconWrap.appendChild(icon);
            this.eventsLane.appendChild(iconWrap);
            this.clusterIcons.push(iconWrap);
        });
    }

    /**
     * Bind hover/click interactions across ticks and icons
     */
    bindClusterInteractions() {
        const activate = (clusterId) => {
            // Only icons are interactive/active
            this.clusterIcons.forEach(i => i.classList.toggle('is-active', i.dataset.clusterId === clusterId));
            const cluster = this.clusters.find(c => c.id === clusterId);
            if (cluster) this.showClusterTooltip(cluster);
        };
        const deactivate = () => {
            this.clusterIcons.forEach(i => i.classList.remove('is-active'));
            this.hideEventTooltip();
        };
        const seekTo = (clusterId) => {
            const cluster = this.clusters.find(c => c.id === clusterId);
            if (cluster) {
                const target = Math.max(0, (cluster.anchorMs / 1000) - VideoPlayer.EVENT_PRE_ROLL_SEC);
                this.seek(target);
            }
        };

        // Icons only (hover area includes child hitbox)
        this.clusterIcons.forEach(el => {
            el.addEventListener('mouseenter', () => activate(el.dataset.clusterId));
            el.addEventListener('mouseleave', (e) => {
                // Keep tooltip if moving into it
                const to = e.relatedTarget;
                if (to && (this.activeTooltip && this.activeTooltip.contains(to))) return;
                deactivate();
            });
            el.addEventListener('click', () => seekTo(el.dataset.clusterId));
        });
    }

    /**
     * Show tooltip for a cluster (list of events with icon + time + description)
     */
    showClusterTooltip(cluster) {
        this.hideEventTooltip();
        
        const iconEl = this.clusterIcons.find(i => i.dataset.clusterId === cluster.id);
        if (!iconEl) {
            console.warn('VideoPlayer: Cluster icon not found for cluster', cluster.id);
            return;
        }
        
        const tooltip = document.createElement('div');
        tooltip.className = 'event-tooltip';

        const list = document.createElement('div');
        list.className = 'event-tooltip-list';

        cluster.events.forEach(evt => {
            const row = document.createElement('div');
            row.className = 'event-tooltip-item';

            const icon = document.createElement('span');
            icon.className = 'tooltip-icon';
            icon.innerHTML = this.getEventIcon(evt.category);

            const time = document.createElement('span');
            time.className = 'tooltip-time';
            time.textContent = this.formatTime(evt.timestamp / 1000);

            const playerInfo = document.createElement('span');
            playerInfo.className = 'tooltip-player';

            // Only create spec icon if we have a valid path
            const specId = this.getPlayerSpecId(evt.data?.playerId);
            if (typeof window.AssetManager?.getSpecIconPath === 'function' && specId) {
                const p = window.AssetManager.getSpecIconPath(specId);
                if (p) {
                    const spec = document.createElement('img');
                    spec.className = 'tooltip-spec';
                    spec.src = p;
                    spec.alt = '';
                    playerInfo.appendChild(spec);
                }
            }

            const nameEl = document.createElement('span');
            nameEl.className = 'tooltip-player-name';
            const displayName = this.getPlayerDisplayName(evt.data?.playerId);
            if (displayName) {
                nameEl.textContent = displayName + ': ';
            }

            const desc = document.createElement('span');
            desc.className = 'tooltip-description';
            desc.textContent = evt.description;

            playerInfo.append(nameEl, desc);

            // Click row to seek to the event exactly
            row.addEventListener('click', (e) => {
                e.stopPropagation();
                const target = Math.max(0, (evt.timestamp / 1000) - VideoPlayer.EVENT_PRE_ROLL_SEC);
                this.seek(target);
            });

            row.append(icon, time, playerInfo);
            list.appendChild(row);
        });

        tooltip.appendChild(list);

        // Position tooltip above the icon
        const containerRect = this.container.getBoundingClientRect();
        const iconRect = iconEl.getBoundingClientRect();
        
        tooltip.style.left = `${cluster._leftPxLane}px`;
        const bottomFromContainer = this.container.offsetHeight - (iconRect.top - containerRect.top) + VideoPlayer.TOOLTIP_SPACING_PX;
        tooltip.style.bottom = `${bottomFromContainer}px`;
        this.container.appendChild(tooltip);
        
        // Clamp to container bounds
        const tipRect = tooltip.getBoundingClientRect();
        const minLeft = containerRect.left + VideoPlayer.TOOLTIP_MARGIN_PX;
        const maxLeft = containerRect.right - VideoPlayer.TOOLTIP_MARGIN_PX - tipRect.width;
        let correctedLeft = Math.max(minLeft, Math.min(tipRect.left, maxLeft));
        tooltip.style.left = `${correctedLeft - containerRect.left + tipRect.width / 2}px`;
        this.activeTooltip = tooltip;

        // Keep active highlight while hovering tooltip
        tooltip.addEventListener('mouseleave', (e) => {
            const to = e.relatedTarget;
            // If moving back to a tick/icon of same cluster, keep it
            if (to && to.closest('.cluster-icon')) return;
            this.clusterIcons.forEach(i => i.classList.remove('is-active'));
            this.hideEventTooltip();
        });
    }
    
    
    /**
     * Hide active tooltip
     */
    hideEventTooltip() {
        if (this.activeTooltip) {
            this.activeTooltip.remove();
            this.activeTooltip = null;
        }
    }
    
    /**
     * Clear all event markers from DOM
     */
    clearEventMarkers() {
        this.clusterTicks.forEach(tick => tick.remove());
        this.clusterTicks = [];
        this.clusterIcons.forEach(icon => icon.remove());
        this.clusterIcons = [];
        this.hideEventTooltip();
    }
    
    /**
     * Set up ResizeObserver for responsive event repositioning
     */
    setupEventLaneResizeObserver() {
        if (typeof ResizeObserver !== 'undefined' && this.eventsLane) {
            this.eventsObserver = new ResizeObserver(() => {
                // Use RAF to avoid excessive calculations while staying responsive
                if (this._eventRepositionRafId) {
                    cancelAnimationFrame(this._eventRepositionRafId);
                }
                this._eventRepositionRafId = requestAnimationFrame(() => {
                    this._eventRepositionRafId = null;
                    this.repositionEventMarkers();
                });
            });
            this.eventsObserver.observe(this.eventsLane);
        }
    }
    
    /**
     * Reposition event markers on timeline resize
     */
    repositionEventMarkers() {
        if (!this.duration || !this.track || !this.clusters.length) return;
        
        this.calculateClusterPositions();
        
        this.clusterTicks.forEach(tick => {
            const cluster = this.clusters.find(c => c.id === tick.dataset.clusterId);
            if (cluster) tick.style.left = `${cluster._leftPxTrack}px`;
        });
        
        this.clusterIcons.forEach(icon => {
            const cluster = this.clusters.find(c => c.id === icon.dataset.clusterId);
            if (cluster) icon.style.left = `${cluster._leftPxLane}px`;
        });
    }
    
    startProgressUpdates() {
        const updateProgress = () => {
            if (!this.isDragging) {
                this.currentTime = this.video.currentTime;
                this.updateTimeline();
                this.updateCurrentTimeDisplay();
            }
            
            if (this.isPlaying) {
                this.rafId = requestAnimationFrame(updateProgress);
            }
        };
        
        updateProgress();
    }
    
    stopProgressUpdates() {
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }
    
    updateTimeline() {
        if (!this.duration || !this.track) return;

        const progressPercent = (this.currentTime / this.duration) * 100;

        if (this.playhead) {
            this.playhead.style.left = `${progressPercent}%`;
        }

        // Update played overlay width from start to playhead (gradient when present)
        if (this.played) {
            const width = this.track.clientWidth;
            const playedWidth = (progressPercent / 100) * width;
            this.played.style.left = `0px`;
            this.played.style.width = `${playedWidth}px`;

            // Keep gradient scaled to full timeline, not compressed into played width
            if (this.shuffleRounds && this.shuffleRounds.length) {
                this.played.style.backgroundSize = `${width}px 100%`;
                this.played.style.backgroundPosition = '0 0';
            }
        }

        // Right side remains base track color (no overlay)
    }

    _scheduleTimelineUpdate() {
        if (this._timelineRafId) cancelAnimationFrame(this._timelineRafId);
        this._timelineRafId = requestAnimationFrame(() => {
            this._timelineRafId = null;
            this.updateTimeline();
        });
    }

    // Control methods
    togglePlayPause() {
        if (this.isPlaying) {
            this.video.pause();
        } else {
            this.video.play().catch(err => {
                console.warn('VideoPlayer: Failed to play video:', err);
            });
        }
    }
    
    updatePlayPauseButton() {
        if (this.isPlaying) {
            this.playPauseBtn.classList.add('is-playing');
        } else {
            this.playPauseBtn.classList.remove('is-playing');
        }
    }
    
    toggleMute() {
        if (this.video.muted) {
            // Unmuting: if volume is 0, restore to last non-zero (default max)
            this.video.muted = false;
            if (this.video.volume === 0) {
                this.video.volume = this.lastNonZeroVolume || 1;
            }
        } else {
            // Muting: keep current volume, just mute
            this.video.muted = true;
        }
        // UI updates via volumechange handler; persist explicitly
        this.saveVolume();
    }
    
    updateVolumeControls() {
        // Read directly from video element for accurate state
        const muted = this.video.muted;
        const volume = this.video.volume;
        
        if (muted || volume === 0) {
            this.muteBtn.classList.add('is-muted');
        } else {
            this.muteBtn.classList.remove('is-muted');
        }
        
        // Sync custom UI if present
        if (this._volumeTrack && this._volumeLevel && this._volumeThumb) {
            this.updateVolumeUI(this._volumeTrack, this._volumeLevel, this._volumeThumb);
        }
    }
    
    setVolume(volume, isUserDragging = false) {
        // Programmer contract: volume must be a finite number
        if (!Number.isFinite(volume)) {
            throw new Error(`VideoPlayer: setVolume called with invalid value: ${volume}`);
        }
        const clampedVolume = Math.max(0, Math.min(1, volume));
        this.video.volume = clampedVolume;
        this.video.muted = clampedVolume === 0;
        // Track last meaningful volume (not micro-movements during drag)
        if (!isUserDragging && clampedVolume > 0) {
            this.lastNonZeroVolume = clampedVolume;
        } else if (isUserDragging && clampedVolume > 0.1) {
            this.lastNonZeroVolume = clampedVolume;
        }
        // UI updates via volumechange handler; persist explicitly
        this.saveVolume();
    }

    updateVolumeUI(trackEl, levelEl, thumbEl) {
        const value = this.video.muted ? 0 : this.video.volume;
        const rect = trackEl.getBoundingClientRect();
        const percent = Math.max(0, Math.min(1, value));
        levelEl.style.width = `${percent * 100}%`;
        thumbEl.style.left = `${percent * rect.width}px`;
    }
    
    /**
     * Get current speed index. Assumes invariant: playback rate is always in PLAYBACK_SPEEDS.
     * Invariant enforced by rateChangeHandler.
     */
    getSpeedIndex() {
        const speeds = VideoPlayer.PLAYBACK_SPEEDS;
        const idx = speeds.indexOf(this.video.playbackRate);
        if (idx === -1) {
            throw new Error(`VideoPlayer: Invariant violation - playback rate ${this.video.playbackRate} not in PLAYBACK_SPEEDS`);
        }
        return idx;
    }

    cyclePlaybackSpeed() {
        const speeds = VideoPlayer.PLAYBACK_SPEEDS;
        const currentIndex = this.getSpeedIndex();
        const nextIndex = (currentIndex + 1) % speeds.length;
        this.video.playbackRate = speeds[nextIndex];
    }

    decreasePlaybackSpeed() {
        const speeds = VideoPlayer.PLAYBACK_SPEEDS;
        const currentIndex = this.getSpeedIndex();
        if (currentIndex > 0) {
            this.video.playbackRate = speeds[currentIndex - 1];
        }
    }

    increasePlaybackSpeed() {
        const speeds = VideoPlayer.PLAYBACK_SPEEDS;
        const currentIndex = this.getSpeedIndex();
        if (currentIndex < speeds.length - 1) {
            this.video.playbackRate = speeds[currentIndex + 1];
        }
    }

    updateSpeedButton() {
        this.speedBtn.textContent = `${this.video.playbackRate}x`;
    }
    
    
    toggleFullscreen() {
        if (document.fullscreenElement) {
            document.exitFullscreen().catch(err => {
                console.warn('VideoPlayer: Failed to exit fullscreen:', err);
            });
        } else {
            this.container.requestFullscreen().catch(err => {
                console.warn('VideoPlayer: Failed to enter fullscreen:', err);
            });
        }
    }
    
    seek(time) {
        this.video.currentTime = Math.max(0, Math.min(time, this.duration));
        this.currentTime = this.video.currentTime;
        this.updateTimeline();
        this.updateCurrentTimeDisplay();
    }
    
    updateCurrentTimeDisplay() {
        if (this.currentTimeDisplay) {
            this.currentTimeDisplay.textContent = this.formatTime(this.currentTime);
        }
    }
    
    updateDurationDisplay() {
        if (this.durationDisplay) {
            this.durationDisplay.textContent = this.formatTime(this.duration);
        }
    }
    
    formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }
    
    loadSavedVolume() {
        try {
            const saved = localStorage.getItem('videoPlayerVolume');
            if (saved) {
                const parsed = JSON.parse(saved);
                const volumeValid = Number.isFinite(parsed.volume);
                const mutedValid = typeof parsed.muted === 'boolean';
                // Warn if saved data has invalid fields
                if (!volumeValid || !mutedValid) {
                    console.warn('VideoPlayer: Invalid saved volume preferences, using defaults:', parsed);
                }
                const volume = volumeValid ? Math.max(0, Math.min(1, parsed.volume)) : 1;
                const muted = mutedValid ? parsed.muted : false;
                return { volume, muted };
            }
        } catch (e) {
            console.warn('VideoPlayer: Failed to load volume preferences:', e);
        }
        return { volume: 1, muted: false };
    }

    saveVolume() {
        try {
            localStorage.setItem('videoPlayerVolume', JSON.stringify({
                volume: this.video.volume,
                muted: this.video.muted
            }));
        } catch (e) {
            console.warn('VideoPlayer: Failed to save volume preferences:', e);
        }
    }
    
    destroy() {
        this.stopProgressUpdates();
        
        // Remove keyboard shortcuts
        if (this._onKeyDown) {
            window.removeEventListener('keydown', this._onKeyDown, true);
            this._onKeyDown = null;
        }

        // Clean up any active drag (releases pointer capture and window listeners)
        if (this._activeDragCleanup) {
            this._activeDragCleanup();
        }

        // Pause video, remove listeners, and release resources
        if (this.video) {
            this.video.pause();
            for (const [eventType, handler] of this.boundEventHandlers) {
                this.video.removeEventListener(eventType, handler);
            }
            this.video.removeAttribute('src');
            this.video.load();
        }
        this.boundEventHandlers.clear();
        
        // Clean up events system
        this.clearEventMarkers();
        this.closeFilterPanel();
        if (this.eventsObserver) {
            this.eventsObserver.disconnect();
            this.eventsObserver = null;
        }
        if (this._eventRepositionRafId) {
            cancelAnimationFrame(this._eventRepositionRafId);
            this._eventRepositionRafId = null;
        }
        if (this._timelineRafId) {
            cancelAnimationFrame(this._timelineRafId);
            this._timelineRafId = null;
        }

        // Clean up DOM elements and their event listeners
        if (this.footer) {
            this.footer.remove();
            this.footer = null;
        }
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }
        if (this._footerResizeObserver) {
            this._footerResizeObserver.disconnect();
            this._footerResizeObserver = null;
        }
        if (this._onResize) {
            window.removeEventListener('resize', this._onResize, true);
            this._onResize = null;
        }
        if (this._onFullscreen) {
            document.removeEventListener('fullscreenchange', this._onFullscreen, true);
            this._onFullscreen = null;
        }
        if (this._volumeObserver) {
            this._volumeObserver.disconnect();
            this._volumeObserver = null;
        }
        
        // Clear DOM references
        this.eventsLane = null;
        this.timelineRow = null;
        this.controlsBar = null;
        this.track = null;
        this.played = null;
        this.playhead = null;
        this.hitbox = null;
        this.currentTimeDisplay = null;
        this.durationDisplay = null;
        this.playPauseBtn = null;
        this.muteBtn = null;
        this._volumeTrack = null;
        this._volumeLevel = null;
        this._volumeThumb = null;
        this.speedBtn = null;
        this.filterBtn = null;
    }
}

window.VideoPlayer = VideoPlayer;
