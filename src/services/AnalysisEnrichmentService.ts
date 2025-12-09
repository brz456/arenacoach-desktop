import { UploadStatus, StoredMatchMetadata } from '../match-detection/types/StoredMatchTypes';
import { MetadataStorageService } from './MetadataStorageService';
import { MatchEventCategory, MatchEventItem } from '../match-detection/types/MatchMetadata';
import { FreemiumQuotaFields } from '../Freemium';

/**
 * Interface for analysis completion payload.
 * Defines the fields that are allowed for metadata enrichment.
 */
export interface AnalysisPayload {
  // Core analysis tracking
  uuid: string;

  // Essential server analysis results
  user_id?: number | string; // Can be string from API, converted to number
  upload_timestamp?: string;

  // Analysis metadata that might contain overall score
  metadata?: {
    match?: {
      analyzedPlayerOverallScore?: number;
    };
  };

  // Event system (skill-capped only)
  // Backend returns nested per-round categories: MatchEventCategory[][] (always array-of-arrays)
  // We normalize this deterministic shape into a flat category list for desktop storage.
  events?: MatchEventCategory[][];
}

/**
 * Service responsible for enriching match metadata with analysis data.
 * This service handles post-upload analysis completion and enriches
 * the existing metadata with server analysis results.
 */
export class AnalysisEnrichmentService {
  private metadataStorageService: MetadataStorageService;

  constructor(metadataStorageService: MetadataStorageService) {
    this.metadataStorageService = metadataStorageService;
  }

  /**
   * Single atomic completion finalizer for both authenticated and non-authenticated paths.
   * Handles all completion persistence with proper idempotency.
   *
   * @param jobId - The job ID to finalize
   * @param analysisId - Optional analysis ID (present for entitled users)
   * @param analysisPayload - Optional payload with enrichment data (present for entitled users)
   * @param freemiumFields - Freemium quota state to persist for video view
   */
  public async finalizeCompletion(
    jobId: string,
    analysisId: string | undefined,
    analysisPayload: AnalysisPayload | undefined,
    freemiumFields: FreemiumQuotaFields
  ): Promise<void> {
    try {
      // Find existing match metadata by jobId (proper correlation)
      const existingMatch = await this.metadataStorageService.findMatchByJobId(jobId);

      if (!existingMatch?.matchHash) {
        console.warn('[AnalysisEnrichmentService] No existing metadata found for jobId:', jobId);
        return;
      }

      // Non-entitled path: mark as completed with freemium state
      if (!analysisId || !analysisPayload) {
        // Skip if already completed (idempotency)
        if (existingMatch.uploadStatus === UploadStatus.COMPLETED) {
          return;
        }

        // Single write for completion with freemium state
        const additionalFields: Partial<StoredMatchMetadata> = {
          entitlementMode: freemiumFields.entitlementMode,
          freeQuotaExhausted: freemiumFields.freeQuotaExhausted,
        };
        // Only mark QUOTA_EXHAUSTED when events were withheld due to cap
        // (not when match simply has no events)
        if (freemiumFields.freeQuotaExhausted) {
          additionalFields.errorCode = 'QUOTA_EXHAUSTED';
        }
        await this.metadataStorageService.updateMatchStatus(
          existingMatch.matchHash,
          UploadStatus.COMPLETED,
          additionalFields
        );

        console.info('[AnalysisEnrichmentService] Marked match as completed (non-entitled):', {
          matchHash: existingMatch.matchHash,
          jobId,
          entitlementMode: freemiumFields.entitlementMode,
          freeQuotaExhausted: freemiumFields.freeQuotaExhausted,
        });
        return;
      }

      // Entitled path (skill-capped or freemium): enrich with analysis data
      await this.enrichWithAnalysisResults(
        existingMatch,
        analysisPayload,
        analysisId,
        freemiumFields
      );
    } catch (error) {
      console.error('[AnalysisEnrichmentService] Failed to finalize completion:', error);
      throw error;
    }
  }

  /**
   * Enrich existing match metadata with analysis completion data.
   * Performs a single atomic write with all enrichment data including events.
   * This is now a private method called by finalizeCompletion for entitled users.
   */
  private async enrichWithAnalysisResults(
    existingMatch: StoredMatchMetadata,
    analysisPayload: AnalysisPayload,
    analysisId: string,
    freemiumFields: FreemiumQuotaFields
  ): Promise<void> {
    try {
      if (!existingMatch?.matchHash) {
        console.warn('[AnalysisEnrichmentService] No matchHash for enrichment');
        return;
      }

      // Prepare matchData with proper Date rehydration
      const md = existingMatch.matchData || {};
      const ts = md.timestamp instanceof Date ? md.timestamp : new Date(String(md.timestamp));

      if (!ts || Number.isNaN(ts.getTime())) {
        console.warn('[AnalysisEnrichmentService] Invalid/missing timestamp; cannot enrich');
        return;
      }

      // Backend sends nested per-round structure (always array-of-arrays, even single-round matches)
      // Normalize deterministically to the desktop's canonical flat category list.
      const flatEvents = this.normalizeEventsToFlatCategories(analysisPayload.events);
      const hasNewEvents = flatEvents.length > 0;

      // Idempotency: skip only if same analysis and no new events
      const sameIds =
        existingMatch.analysisId === analysisId && existingMatch.uuid === analysisPayload.uuid;
      if (existingMatch.uploadStatus === UploadStatus.COMPLETED && sameIds && !hasNewEvents) {
        return;
      }

      // Build single atomic update with all enrichment data
      const enrichmentUpdate: Partial<StoredMatchMetadata> = {
        // Core analysis tracking
        analysisId, // Already a string - normalized at emission boundary
        uuid: analysisPayload.uuid,

        // Update matchData with rehydrated timestamp and flat events
        matchData: {
          ...md,
          timestamp: ts,
          events: flatEvents,
        },

        // Mark as enriched if we have new events
        hasEventEnrichment: hasNewEvents ? true : existingMatch.hasEventEnrichment || false,

        // Freemium state for video view
        entitlementMode: freemiumFields.entitlementMode,
        freeQuotaExhausted: freemiumFields.freeQuotaExhausted,
      };

      // Only add optional fields if they exist
      if (analysisPayload.upload_timestamp) {
        enrichmentUpdate.upload_timestamp = analysisPayload.upload_timestamp;
      }

      if (analysisPayload.user_id !== undefined) {
        const userId =
          typeof analysisPayload.user_id === 'string'
            ? parseInt(analysisPayload.user_id, 10)
            : analysisPayload.user_id;

        if (Number.isFinite(userId)) {
          enrichmentUpdate.user_id = userId;
        }
      }

      // Single atomic write with all enrichment data
      await this.metadataStorageService.updateMatchStatus(
        existingMatch.matchHash,
        UploadStatus.COMPLETED,
        enrichmentUpdate
      );

      console.info('[AnalysisEnrichmentService] Enriched metadata with server events:', {
        matchHash: existingMatch.matchHash,
        analysisId,
        categoriesReceived: flatEvents.length,
      });
    } catch (error) {
      console.error(
        '[AnalysisEnrichmentService] Failed to enrich metadata with analysis results:',
        error
      );
      throw error;
    }
  }

  /**
   * Normalizes nested per-round event categories to flat desktop format.
   * Backend sends MatchEventCategory[][] (rounds), desktop persists MatchEventCategory[] (flat timeline).
   * Validates structure, filters invalid items, sorts deterministically (categories alphabetical, items by timestamp).
   */
  private normalizeEventsToFlatCategories(events: unknown): MatchEventCategory[] {
    // Nested per-round categories -> flatten deterministically
    if (isNestedEvents(events)) {
      const byCategory = new Map<string, MatchEventItem[]>();

      for (const round of events) {
        for (const cat of round) {
          const items = (cat.items || []).filter(isMatchEventItem);
          if (!byCategory.has(cat.category)) byCategory.set(cat.category, []);
          byCategory.get(cat.category)!.push(...items);
        }
      }

      // Build sorted categories; order categories alphabetically for deterministic output
      const categories = Array.from(byCategory.entries())
        .map(([category, items]) => ({
          category,
          items: items.slice().sort((a, b) => a.timestamp - b.timestamp),
        }))
        .sort((a, b) => a.category.localeCompare(b.category));

      return categories;
    }

    // Invalid structure -> reject deterministically
    return [];
  }
}

// ------------------------
// Type guards (no any)
// ------------------------
function isMatchEventItem(u: unknown): u is MatchEventItem {
  if (typeof u !== 'object' || u === null) return false;
  const o = u as Record<string, unknown>;
  if (typeof o.timestamp !== 'number') return false;
  if (o.description !== undefined && typeof o.description !== 'string') return false;
  // data can be unknown; severity optional number
  if (o.severity !== undefined && typeof o.severity !== 'number') return false;
  return true;
}

function isMatchEventCategory(u: unknown): u is MatchEventCategory {
  if (typeof u !== 'object' || u === null) return false;
  const o = u as Record<string, unknown>;
  const category = o['category'];
  if (typeof category !== 'string') return false;
  const items = o['items'];
  if (!Array.isArray(items)) return false;
  return items.every(isMatchEventItem);
}

function isNestedEvents(u: unknown): u is MatchEventCategory[][] {
  return (
    Array.isArray(u) && u.every(round => Array.isArray(round) && round.every(isMatchEventCategory))
  );
}
