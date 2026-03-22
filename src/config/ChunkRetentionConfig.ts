/**
 * Centralized configuration for chunk file retention
 * Single source of truth for desktop app chunk retention timing
 */
export class ChunkRetentionConfig {
  private static readonly MS_PER_DAY = 24 * 60 * 60 * 1000;

  /**
   * Chunk file retention window in days
   * Chunk files older than CHUNK_RETENTION_DAYS days are eligible for deletion
   * during periodic maintenance. Used for:
   * - Periodic aged chunk cleanup
   * - Retention policy enforcement
   */
  public static readonly CHUNK_RETENTION_DAYS = 7;

  /**
   * Get retention window in milliseconds
   */
  public static get RETENTION_MS(): number {
    return this.CHUNK_RETENTION_DAYS * this.MS_PER_DAY;
  }
}
