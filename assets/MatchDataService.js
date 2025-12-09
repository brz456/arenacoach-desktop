/**
 * Centralized service for managing match data and UI updates
 * 
 * Implements a simple singleton pattern to decouple components from direct
 * loadRecentMatches() calls, reducing tight coupling and improving maintainability.
 * 
 * This service acts as the single source of truth for match data refreshes,
 * allowing multiple components to trigger updates without knowing about each other.
 */
class MatchDataService {
  constructor() {
    if (MatchDataService.instance) {
      return MatchDataService.instance;
    }

    this.isRefreshing = false;
    this.refreshCallbacks = new Set();
    this.matchUI = null; // Will be set by MatchUI during initialization
    
    MatchDataService.instance = this;
  }

  /**
   * Initialize the service with the MatchUI instance
   * This allows the service to call MatchUI methods while maintaining loose coupling
   */
  initialize(matchUI) {
    this.matchUI = matchUI;
  }

  /**
   * Register a callback to be called when matches are refreshed
   * This allows components to react to match data changes
   */
  onRefresh(callback) {
    this.refreshCallbacks.add(callback);
    
    // Return an unsubscribe function
    return () => {
      this.refreshCallbacks.delete(callback);
    };
  }

  /**
   * Trigger a full refresh of match data
   * This replaces direct calls to loadRecentMatches() throughout the application
   */
  async refresh(reset = true) {
    if (!this.matchUI) {
      console.warn('[MatchDataService] Service not initialized with MatchUI instance');
      return;
    }

    // Prevent concurrent refreshes
    if (this.isRefreshing) {
      console.debug('[MatchDataService] Refresh already in progress, skipping');
      return;
    }

    try {
      this.isRefreshing = true;
      
      // Call the original loadRecentMatches logic
      await this.matchUI.loadRecentMatches(reset);
      this.matchUI.renderRecentMatches(!reset); // append mode if not reset
      
      // Notify all registered callbacks
      this.refreshCallbacks.forEach(callback => {
        try {
          callback();
        } catch (error) {
          console.error('[MatchDataService] Error in refresh callback:', error);
        }
      });
      
    } catch (error) {
      console.error('[MatchDataService] Failed to refresh match data:', error);
      throw error;
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Trigger an append-only refresh (for loading more matches)
   * This is used by the "Load More" functionality
   */
  async loadMore() {
    return this.refresh(false);
  }

  /**
   * Check if a refresh operation is currently in progress
   */
  get isCurrentlyRefreshing() {
    return this.isRefreshing;
  }
}

// Export singleton instance
window.MatchDataService = new MatchDataService();