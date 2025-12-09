/**
 * Video Player with Timeline and Shuffle Round Segments
 * Handles all video playback controls and timeline rendering
 */
class VideoPlayer {
    // Event system constants
    static EVENT_CLUSTER_WINDOW_PERCENT = 0.02; // 2% of total duration
    static TOOLTIP_SPACING_PX = 6; // Gap between icon and tooltip
    static TOOLTIP_MARGIN_PX = 8; // Tooltip container margin
    static FILTER_CLICK_BLOCK_MS = 50; // Prevent filter panel re-opening
    static EVENT_PRE_ROLL_SEC = 3; // Seconds to seek before an event
    static ARROW_SEEK_STEP_SEC = 5; // Arrow key skip interval
    
    constructor({ videoElement, containerElement, metadata, shuffleRounds }) {
        this.video = videoElement;
        this.container = containerElement;
        this.metadata = metadata;
        this.shuffleRounds = shuffleRounds || [];
        
        // Load saved volume preferences
        const savedVolume = this.loadSavedVolume();
        
        // State management
        this.isPlaying = false;
        this.isDragging = false;
        this.volume = savedVolume.volume;
        this.muted = savedVolume.muted;
        this.playbackRate = 1;
        this.duration = 0;
        this.currentTime = 0;
        this.lastNonZeroVolume = savedVolume.volume > 0.01 ? savedVolume.volume : 1;
        
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
        this.timelineContainer = null;
        this.progressBar = null;
        this.scrubber = null;
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
        
        this.init();
    }
    
    /**
     * Get accent color with alpha from CSS variable
     */
    getAccentColor(alpha = 1) {
        const root = document.documentElement;
        const accent = getComputedStyle(root).getPropertyValue('--primary-accent').trim();
        // Accept rgb(), rgba(), or hex. If parsing fails, fall back to current value.
        if (accent.startsWith('rgb')) {
            const parts = accent.replace(/rgba?\(|\)|\s/g, '').split(',');
            const [r, g, b] = parts.slice(0, 3).map(Number);
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
        // Hex fallback (#RRGGBB)
        const m = accent.match(/^#([0-9a-fA-F]{6})$/);
        if (m) {
            const r = parseInt(m[1].slice(0, 2), 16);
            const g = parseInt(m[1].slice(2, 4), 16);
            const b = parseInt(m[1].slice(4, 6), 16);
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
        // Final fallback to current hard-coded purple
        return `rgba(79, 70, 229, ${alpha})`;
    }
    
    /**
     * Process events data from metadata into a flat array with positioning info
     */
    processEventsData(eventsData) {
        const processedEvents = [];
        
        eventsData.forEach(category => {
            if (category.items && Array.isArray(category.items)) {
                category.items.forEach(event => {
                    processedEvents.push({
                        category: category.category,
                        timestamp: event.timestamp,
                        description: event.description,
                        data: event.data
                    });
                });
            }
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
        };
        const cfg = iconMap[category];
        if (cfg && cfg.icon) {
            return `<img src="images/events/${cfg.icon}" alt="${cfg.label}" />`;
        }
        // Fallback neutral dot
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
        if (!playerId || !this.metadata?.players) return null;
        const player = this.metadata.players.find(p => p.id === playerId);
        return player?.specId || null;
    }
    
    
    init() {
        // Apply saved volume settings to video element
        this.video.volume = this.volume;
        this.video.muted = this.muted;
        
        this.bindVideoEvents();
        this.bindKeyboardShortcuts();
        this.renderControls();
        this.renderTimeline();
        
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
            this.volume = this.video.volume;
            this.muted = this.video.muted;
            this.updateVolumeControls();
        };
        
        const rateChangeHandler = () => {
            this.playbackRate = this.video.playbackRate;
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
            const activeElement = document.activeElement;
            const isTyping = activeElement && (
                activeElement.tagName === 'INPUT' ||
                activeElement.tagName === 'TEXTAREA' ||
                activeElement.isContentEditable
            );

            if (e.code === 'Space' && !isTyping) {
                e.preventDefault();
                this.togglePlayPause();
            }

            if (e.code === 'ArrowLeft' && !isTyping) {
                e.preventDefault();
                this.seek(this.video.currentTime - VideoPlayer.ARROW_SEEK_STEP_SEC);
            }

            if (e.code === 'ArrowRight' && !isTyping) {
                e.preventDefault();
                this.seek(this.video.currentTime + VideoPlayer.ARROW_SEEK_STEP_SEC);
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
        
        // Events lane (top of footer - for future markers)
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
            const updateAt = (clientX) => {
                const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
                const v = x / rect.width;
                this.setVolume(v, true); // Pass isUserDragging = true
                this.updateVolumeUI(volumeTrack, volumeLevel, volumeThumb);
            };
            updateAt(e.clientX);
            volumeBar.setPointerCapture?.(e.pointerId);
            const move = (ev) => updateAt(ev.clientX);
            const up = () => {
                volumeBar.releasePointerCapture?.(e.pointerId);
                window.removeEventListener('pointermove', move, true);
                window.removeEventListener('pointerup', up, true);
                window.removeEventListener('pointercancel', up, true);
                window.removeEventListener('blur', up, true);
            };
            window.addEventListener('pointermove', move, true);
            window.addEventListener('pointerup', up, true);
            window.addEventListener('pointercancel', up, true);
            window.addEventListener('blur', up, true);
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
        speedBtn.textContent = '1x';
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
        
        // Prevent focus highlights on all controls (except volume slider - handled separately)
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
        // Always show only the base character name (before first hyphen)
        // Keep logic simple and deterministic per consistent naming convention
        const raw = p.name ? String(p.name) : null;
        if (!raw) return null;
        const base = raw.split('-')[0];
        return base || null;
    }

    initializeFilterState() {
        const categories = new Set(this.events.map(e => e.category));
        categories.forEach(cat => this.filterState.set(cat, true));
        
        // Initialize player filter to only show recording player events by default
        const players = [...new Set(this.events.map(e => e.data?.playerId).filter(Boolean))];
        if (!this.playerFilterState) this.playerFilterState = new Map();
        players.forEach(playerId => {
            // Only enable the recording player by default
            this.playerFilterState.set(playerId, playerId === this.metadata?.playerId);
        });
    }

    toggleFilterPanel() {
        if (this._filterClickBlocked) return;
        
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
        // Build players from event data
        const players = [...new Map(this.events.map(e => [e.data?.playerId, e.data?.playerName]).filter(([id]) => !!id)).entries()];
        players.forEach(([playerId, playerName]) => {
            const row = document.createElement('label');
            row.className = 'events-filter-item';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            const enabled = this.playerFilterState.get(playerId);
            checkbox.checked = enabled !== false; // default on
            checkbox.addEventListener('change', () => {
                this.playerFilterState.set(playerId, checkbox.checked);
                this.renderEventMarkers();
            });
            
            const specIcon = document.createElement('img');
            specIcon.className = 'events-filter-spec';
            try {
                const specId = this.getPlayerSpecId?.(playerId);
                if (window.AssetManager?.getSpecIconPath && specId) {
                    const p = window.AssetManager.getSpecIconPath(specId);
                    if (p) specIcon.src = p;
                }
            } catch (e) {
                // Silently ignore spec icon errors
            }
            
            const nameGroup = document.createElement('span');
            nameGroup.className = 'events-filter-name-group';
            
            const text = document.createElement('span');
            text.className = 'events-filter-text';
            text.textContent = playerName || playerId;
            
            nameGroup.append(specIcon, text);
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
        
        // Close on outside click
        this._onFilterOutsideClick = (ev) => {
            if (!panel.contains(ev.target) && ev.target !== this.filterBtn) {
                this.closeFilterPanel();
            }
        };
        setTimeout(() => document.addEventListener('click', this._onFilterOutsideClick, true), 0);
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
        
        // Prevent immediate reopening from same click event
        this._filterClickBlocked = true;
        setTimeout(() => { this._filterClickBlocked = false; }, VideoPlayer.FILTER_CLICK_BLOCK_MS);
    }
    
    renderTimeline() {
        // Timeline track (with gradient background for rounds)
        this.track = document.createElement('div');
        this.track.className = 'timeline-track';
        
        // Played overlay (left of playhead) - used only for shuffle gradient
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
            const updateAt = (clientX) => {
                const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
                this.seek((x / rect.width) * this.duration);
            };
            updateAt(e.clientX);
            if (this.playhead) {
                this.playhead.classList.add('is-dragging');
            }
            this.hitbox.setPointerCapture?.(e.pointerId);
            const move = (ev) => updateAt(ev.clientX);
            const up = () => {
                this.hitbox.releasePointerCapture?.(e.pointerId);
                window.removeEventListener('pointermove', move, true);
                window.removeEventListener('pointerup', up, true);
                window.removeEventListener('pointercancel', up, true);
                window.removeEventListener('blur', up, true);
                if (this.playhead) {
                    this.playhead.classList.remove('is-dragging');
                }
            };
            window.addEventListener('pointermove', move, true);
            window.addEventListener('pointerup', up, true);
            window.addEventListener('pointercancel', up, true);
            window.addEventListener('blur', up, true);
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
            const recordingPlayerWon = this.calculateRecordingPlayerWon(round);
            const color = recordingPlayerWon
                ? `rgba(74, 222, 128, ${alpha})`
                : `rgba(248, 113, 113, ${alpha})`;
            // Create hard stop by duplicating stops at exact boundaries
            stops.push(`${transparent} ${startPct}%`, `${color} ${startPct}%`, `${color} ${endPct}%`, `${transparent} ${endPct}%`);
        });
        
        // Ensure end transparent
        stops.push(`${transparent} 100%`);
        return `linear-gradient(to right, ${stops.join(', ')})`;
    }
    
    calculateRecordingPlayerWon(round) {
        // Check if we have the required data
        if (!this.metadata?.playerId || round.winningTeamId === undefined) {
            return false;
        }
        
        // Find which team the recording player is on for this round
        const isOnTeam0 = round.team0Players?.includes(this.metadata.playerId);
        const isOnTeam1 = round.team1Players?.includes(this.metadata.playerId);
        
        if (isOnTeam0) {
            return round.winningTeamId === 0;
        } else if (isOnTeam1) {
            return round.winningTeamId === 1;
        }
        
        return false; // Player not found in either team
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
        const clusters = [];
        const list = Array.isArray(source) ? source : [];
        if (!list.length) return clusters;

        const durationMs = (typeof this.duration === 'number' && isFinite(this.duration) ? this.duration : 0) * 1000;
        if (durationMs <= 0) {
            // Deterministic fail-out: no duration -> no grouping
            return list.map(evt => ({ anchorMs: evt.timestamp, events: [evt] }));
        }
        const windowMs = Math.max(1, Math.floor(durationMs * VideoPlayer.EVENT_CLUSTER_WINDOW_PERCENT));

        let current = null;
        for (const evt of list) {
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
        if (!iconEl) return; // Robustness: skip if icon element not found
        
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
            
            const spec = document.createElement('img');
            spec.className = 'tooltip-spec';
            try {
                const specId = this.getPlayerSpecId(evt.data?.playerId);
                if (window.AssetManager?.getSpecIconPath && specId) {
                    const p = window.AssetManager.getSpecIconPath(specId);
                    if (p) spec.src = p;
                }
            } catch (e) {
                // Silently ignore spec icon errors
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

            playerInfo.append(spec, nameEl, desc);

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
        if (!this.duration) return;
        
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
    
    seekAt(clientX) {
        const rect = this.track.getBoundingClientRect();
        const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
        this.seek((x / rect.width) * this.duration);
    }
    
    startDraggingAt(clientX) {
        this.seekAt(clientX);
        this.isDragging = true;
        
        // Industry-standard: use initial track position for horizontal calculations
        const initialRect = this.track.getBoundingClientRect();
        
        const onMove = (e) => {
            // Use original track position for consistent horizontal mapping
            // This allows vertical mouse movement without breaking the drag
            const x = Math.max(0, Math.min(e.clientX - initialRect.left, initialRect.width));
            this.seek((x / initialRect.width) * this.duration);
        };
        
        const onUp = () => {
            this.isDragging = false;
            window.removeEventListener('mousemove', onMove, true);
            window.removeEventListener('mouseup', onUp, true);
            window.removeEventListener('blur', onUp, true);
            document.removeEventListener('mouseleave', onUp, true);
        };
        
        window.addEventListener('mousemove', onMove, true);
        window.addEventListener('mouseup', onUp, true);
        window.addEventListener('blur', onUp, true);
        document.addEventListener('mouseleave', onUp, true);
    }
    
    // Control methods
    togglePlayPause() {
        if (this.isPlaying) {
            this.video.pause();
        } else {
            this.video.play();
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
                this.setVolume(this.lastNonZeroVolume || 1);
            }
        } else {
            // Muting: keep current volume, just mute
            this.video.muted = true;
        }
        this.updateVolumeControls();
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
        this.video.volume = volume;
        this.video.muted = volume === 0;
        // Track last meaningful volume (not micro-movements during drag)
        // Only update if explicitly setting volume or if it's a significant value
        if (!isUserDragging && volume > 0) {
            this.lastNonZeroVolume = volume;
        } else if (isUserDragging && volume > 0.1) {
            // During drag, only update for values above 10%
            this.lastNonZeroVolume = volume;
        }
        this.updateVolumeControls();
        this.saveVolume();
    }

    updateVolumeUI(trackEl, levelEl, thumbEl) {
        const value = this.video.muted ? 0 : this.video.volume;
        const rect = trackEl.getBoundingClientRect();
        const percent = Math.max(0, Math.min(1, value));
        levelEl.style.width = `${percent * 100}%`;
        thumbEl.style.left = `${percent * rect.width}px`;
    }
    
    cyclePlaybackSpeed() {
        const speeds = [0.25, 0.5, 1, 1.5, 2];
        const currentIndex = speeds.indexOf(this.playbackRate);
        const nextIndex = (currentIndex + 1) % speeds.length;
        
        this.video.playbackRate = speeds[nextIndex];
    }
    
    updateSpeedButton() {
        this.speedBtn.textContent = `${this.playbackRate}x`;
    }
    
    
    toggleFullscreen() {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            this.container.requestFullscreen();
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
                return {
                    volume: typeof parsed.volume === 'number' ? Math.max(0, Math.min(1, parsed.volume)) : 1,
                    muted: typeof parsed.muted === 'boolean' ? parsed.muted : false
                };
            }
        } catch (e) {
            // Ignore localStorage errors (e.g., private browsing)
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
            // Ignore localStorage errors (e.g., private browsing)
        }
    }
    
    destroy() {
        this.stopProgressUpdates();
        
        // Remove keyboard shortcuts
        if (this._onKeyDown) {
            window.removeEventListener('keydown', this._onKeyDown, true);
            this._onKeyDown = null;
        }
        
        // Pause video and release its resources
        if (this.video) {
            this.video.pause();
            this.video.removeAttribute('src');
            this.video.load();
        }
        
        // Remove all video event listeners
        for (const [eventType, handler] of this.boundEventHandlers) {
            this.video.removeEventListener(eventType, handler);
        }
        this.boundEventHandlers.clear();
        
        // Clean up events system
        this.clearEventMarkers();
        this.closeFilterPanel();
        if (this.eventsObserver) {
            try { this.eventsObserver.disconnect(); } catch (_) {}
            this.eventsObserver = null;
        }
        if (this._eventRepositionRafId) {
            cancelAnimationFrame(this._eventRepositionRafId);
            this._eventRepositionRafId = null;
        }
        
        // Clean up DOM elements and their event listeners
        if (this.footer) {
            this.footer.remove();
            this.footer = null;
        }
        if (this._resizeObserver) {
            try { this._resizeObserver.disconnect(); } catch (_) {}
            this._resizeObserver = null;
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
            try { this._volumeObserver.disconnect(); } catch (_) {}
            this._volumeObserver = null;
        }
        
        // Clear DOM references
        this.eventsLane = null;
        this.timelineRow = null;
        this.controlsBar = null;
        this.track = null;
        this.playhead = null;
        this.currentTimeDisplay = null;
        this.durationDisplay = null;
        this.playPauseBtn = null;
        this.muteBtn = null;
        this.volumeSlider = null;
        this.speedBtn = null;
        this.filterBtn = null;
    }
}
