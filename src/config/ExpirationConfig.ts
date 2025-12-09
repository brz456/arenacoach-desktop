/**
 * Centralized configuration for combat log expiration
 * Single source of truth for expiration timing across the entire system
 */
export class ExpirationConfig {
  /**
   * Combat log expiration window in hours
   * Combat logs older than 1 hour cannot be processed
   * This value is used system-wide for:
   * - JobQueueOrchestrator submission guard (reject expired combat logs)
   * - Periodic expiration checks
   * - Metadata status updates
   */
  public static readonly COMBAT_LOG_EXPIRATION_HOURS = 1;

  /**
   * Get expiration window in milliseconds
   */
  public static get EXPIRATION_MS(): number {
    return this.COMBAT_LOG_EXPIRATION_HOURS * 60 * 60 * 1000;
  }

  /**
   * Check if a timestamp is expired based on the centralized expiration window
   * @param timestamp The timestamp to check (in milliseconds)
   * @param currentTime Optional current time (defaults to Date.now())
   * @returns True if the timestamp is older than the expiration window
   */
  public static isExpired(timestamp: number, currentTime: number = Date.now()): boolean {
    // Disable expiration in development mode
    if (process.env.NODE_ENV !== 'production') {
      return false;
    }

    const ageMs = currentTime - timestamp;
    return ageMs > this.EXPIRATION_MS;
  }

  /**
   * Get the age of a timestamp in hours
   * @param timestamp The timestamp to check (in milliseconds)
   * @param currentTime Optional current time (defaults to Date.now())
   * @returns Age in hours
   */
  public static getAgeInHours(timestamp: number, currentTime: number = Date.now()): number {
    const ageMs = currentTime - timestamp;
    return ageMs / (60 * 60 * 1000);
  }
}