import * as path from 'path';
import { MatchStartedEvent, MatchEndedEvent } from '../match-detection/types/MatchEvent';
import {
  StoredMatchMetadata,
  UploadStatus,
  VideoMetadataUpdate,
} from '../match-detection/types/StoredMatchTypes';
import { MatchMetadata } from '../match-detection/types/MatchMetadata';
import { MetadataStorageService } from './MetadataStorageService';
import { generateMatchHash } from '../match-detection/utils/MatchHashGenerator';
import { EarlyEndTrigger, getTriggerMessage } from '../match-detection/types/EarlyEndTriggers';

/**
 * Service responsible for pure match metadata data operations.
 * No structural validation (moved to MatchLifecycleService).
 *
 * Phase 1: createInitialMetadata() - Create with bufferId filename on MATCH_STARTED
 * Phase 2: markMatchIncomplete() / markMatchValidationFailed() - Mark incomplete matches
 * Phase 3: finalizeCompleteMatch() - Generate matchHash and complete metadata (assumes validation passed)
 */
export class MetadataService {
  private metadataStorageService: MetadataStorageService;

  constructor(metadataStorageService: MetadataStorageService) {
    this.metadataStorageService = metadataStorageService;
  }

  /**
   * Phase 1: Create initial metadata immediately on MATCH_STARTED with bufferId-based filename
   * BREAKING CHANGE: No longer requires combatant data, uses bufferId for stable correlation
   */
  public async createInitialMetadata(matchStartedEvent: MatchStartedEvent): Promise<void> {
    const bufferId = matchStartedEvent.bufferId;
    const now = new Date();

    console.info('[MetadataService] Status transition:', {
      operation: 'createInitialMetadata',
      bufferId,
      oldStatus: undefined,
      newStatus: 'in_progress',
      enrichmentPhase: matchStartedEvent.players?.length ? 'combatants_added' : 'initial',
    });

    const initialMetadata: MatchMetadata = {
      timestamp: matchStartedEvent.timestamp,
      mapId: matchStartedEvent.zoneId,
      bracket: matchStartedEvent.bracket || 'Unknown',
      season: matchStartedEvent.season || 0,
      isRanked: matchStartedEvent.isRanked || false,
      players: matchStartedEvent.players || [], // May be empty initially
    };

    const storedMetadata: StoredMatchMetadata = {
      matchData: initialMetadata,
      matchCompletionStatus: 'in_progress',
      enrichmentPhase: matchStartedEvent.players?.length ? 'combatants_added' : 'initial',
      createdAt: now,
      lastUpdatedAt: now,
      bufferId: bufferId, // Store for correlation throughout lifecycle
      uploadStatus: UploadStatus.PENDING,
    };

    // Save using bufferId filename (stable throughout lifecycle)
    await this.metadataStorageService.saveMatch(storedMetadata);

    console.info('[MetadataService] Created initial metadata:', {
      bufferId,
      bracket: initialMetadata.bracket,
      playerCount: initialMetadata.players.length,
    });
  }

  /**
   * Internal: Single enrichment point - merges available metadata regardless of completion outcome.
   * SSoT: Always enrich with whatever data we have, separate from status/validation.
   */
  private async enrichMetadata(
    bufferId: string,
    metadata: Partial<MatchMetadata>
  ): Promise<StoredMatchMetadata> {
    const storedMetadata = await this.metadataStorageService.loadMatchByBufferId(bufferId);
    if (!storedMetadata) {
      throw new Error(`[MetadataService] No metadata found for bufferId: ${bufferId}`);
    }

    // Merge enriched data into stored metadata
    storedMetadata.matchData = { ...storedMetadata.matchData, ...metadata };
    storedMetadata.lastUpdatedAt = new Date();

    // Update enrichment phase if we gained players
    if (metadata.players && metadata.players.length > 0) {
      storedMetadata.enrichmentPhase = 'combatants_added';
    }

    return storedMetadata;
  }

  /**
   * Phase 2: Mark match as incomplete for early ended matches.
   * Optionally enriches with partial metadata if available.
   */
  public async markMatchIncomplete(
    bufferId: string,
    trigger: EarlyEndTrigger,
    metadata?: Partial<MatchMetadata>
  ): Promise<void> {
    let storedMetadata = await this.metadataStorageService.loadMatchByBufferId(bufferId);
    if (!storedMetadata) {
      console.warn(`[MetadataService] No metadata found for bufferId: ${bufferId}`);
      return;
    }

    console.info('[MetadataService] Status transition:', {
      operation: 'markMatchIncomplete',
      bufferId,
      oldStatus: storedMetadata.matchCompletionStatus,
      newStatus: 'incomplete',
      trigger,
      hasEnrichment: !!metadata,
    });

    // Enrich with available metadata before marking incomplete
    if (metadata) {
      storedMetadata = await this.enrichMetadata(bufferId, metadata);
    }

    storedMetadata.matchCompletionStatus = 'incomplete';
    storedMetadata.uploadStatus = UploadStatus.INCOMPLETE;
    storedMetadata.enrichmentPhase = 'finalized';
    storedMetadata.errorMessage = getTriggerMessage(trigger);
    storedMetadata.lastUpdatedAt = new Date();

    await this.metadataStorageService.saveMatch(storedMetadata);

    console.info('[MetadataService] Marked match incomplete:', {
      bufferId,
      trigger,
      playerCount: storedMetadata.matchData.players?.length || 0,
      hasShuffleRounds: !!storedMetadata.matchData.shuffleRounds,
    });
  }

  /**
   * Phase 2: Mark match as validation failed (structural issues).
   * Always enriches with parsed metadata so invalid matches retain full data for inspection.
   */
  public async markMatchValidationFailed(
    bufferId: string,
    trigger: string,
    reason: string,
    metadata?: MatchMetadata
  ): Promise<void> {
    let storedMetadata = await this.metadataStorageService.loadMatchByBufferId(bufferId);
    if (!storedMetadata) {
      console.warn(`[MetadataService] No metadata found for bufferId: ${bufferId}`);
      return;
    }

    console.info('[MetadataService] Status transition:', {
      operation: 'markMatchValidationFailed',
      bufferId,
      oldStatus: storedMetadata.matchCompletionStatus,
      newStatus: 'incomplete',
      trigger,
      reason,
      hasEnrichment: !!metadata,
    });

    // CRITICAL: Enrich with full parsed metadata even for invalid matches
    // This preserves players, shuffleRounds, etc. for inspection
    if (metadata) {
      storedMetadata = await this.enrichMetadata(bufferId, metadata);
    }

    storedMetadata.matchCompletionStatus = 'incomplete';
    storedMetadata.uploadStatus = UploadStatus.INCOMPLETE;
    storedMetadata.enrichmentPhase = 'finalized';
    storedMetadata.errorMessage = reason;
    storedMetadata.lastUpdatedAt = new Date();

    await this.metadataStorageService.saveMatch(storedMetadata);

    console.info('[MetadataService] Marked match validation failed:', {
      bufferId,
      reason,
      playerCount: storedMetadata.matchData.players?.length || 0,
      shuffleRoundCount: storedMetadata.matchData.shuffleRounds?.length || 0,
    });
  }

  /**
   * Phase 3: Finalize metadata for complete match.
   * Pure data operation - assumes validation passed in MatchLifecycleService.
   * Returns matchHash for upload coordination.
   */
  public async finalizeCompleteMatch(matchEndEvent: MatchEndedEvent): Promise<string> {
    const bufferId = matchEndEvent.bufferId;

    // Enrich with full metadata (single enrichment path)
    const storedMetadata = await this.enrichMetadata(bufferId, matchEndEvent.metadata);

    // Generate matchHash using enriched players
    const players = storedMetadata.matchData.players || [];
    const matchHash = generateMatchHash(storedMetadata.matchData.timestamp, players);

    console.info('[MetadataService] Status transition:', {
      operation: 'finalizeCompleteMatch',
      bufferId,
      oldStatus: storedMetadata.matchCompletionStatus,
      newStatus: 'complete',
      matchHash: matchHash,
    });

    // Finalize as complete with service-generated hash
    storedMetadata.matchHash = matchHash;
    storedMetadata.matchCompletionStatus = 'complete';
    storedMetadata.enrichmentPhase = 'finalized';

    // Remove error state fields
    delete storedMetadata.errorMessage;
    delete storedMetadata.failedAt;
    delete storedMetadata.progressMessage;

    storedMetadata.lastUpdatedAt = new Date();
    await this.metadataStorageService.saveMatch(storedMetadata);

    console.info('[MetadataService] Finalized metadata:', {
      bufferId,
      matchHash,
      playerCount: players.length,
      winningTeamId: matchEndEvent.metadata.winningTeamId,
      duration: matchEndEvent.metadata.matchDuration,
    });

    return matchHash;
  }

  /**
   * Load match metadata by bufferId
   */
  public async loadMatchByBufferId(bufferId: string): Promise<StoredMatchMetadata | null> {
    return this.metadataStorageService.loadMatchByBufferId(bufferId);
  }

  /**
   * Delete match metadata and associated video/thumbnail by bufferId.
   * Used for cancellation cleanup where we want no persistent state.
   * Returns true if deletion succeeded, false if match not found or deletion failed.
   */
  public async deleteMatchByBufferId(bufferId: string): Promise<boolean> {
    return this.metadataStorageService.deleteMatch(bufferId);
  }

  /**
   * Ensure matchHash exists for a bufferId (for upload coordination).
   * Returns existing hash if present, throws if match is incomplete or missing.
   */
  public async ensureMatchHashForBufferId(bufferId: string): Promise<string> {
    const stored = await this.metadataStorageService.loadMatchByBufferId(bufferId);
    if (!stored) {
      throw new Error(`No metadata found for bufferId: ${bufferId}`);
    }

    if (stored.matchCompletionStatus !== 'complete') {
      throw new Error(
        `Match ${bufferId} is ${stored.matchCompletionStatus}, cannot get hash for incomplete match`
      );
    }

    if (!stored.matchHash) {
      throw new Error(`Complete match ${bufferId} missing matchHash`);
    }

    return stored.matchHash;
  }

  /**
   * Update video metadata by bufferId (works for complete and incomplete matches)
   */
  public async updateVideoMetadataByBufferId(
    bufferId: string,
    videoData: VideoMetadataUpdate
  ): Promise<void> {
    await this.metadataStorageService.updateVideoMetadataByBufferId(bufferId, videoData);
  }

  /**
   * Get set of temp video paths that are referenced by match metadata.
   * Used by RecordingService to avoid deleting rename-fallback recordings.
   * @param tempDir The temp directory to check against (normalized for comparison)
   * @returns Set of normalized absolute paths within tempDir that are referenced
   */
  public async getReferencedTempPaths(tempDir: string): Promise<Set<string>> {
    const allMatches = await this.metadataStorageService.listAllMatches();
    const tempPaths = new Set<string>();

    // Normalize tempDir for comparison
    const normalizedTempDir = path.resolve(tempDir);
    const isWindows = process.platform === 'win32';

    for (const match of allMatches) {
      if (!match.videoPath) continue;

      // Normalize videoPath for comparison
      const normalizedVideoPath = path.resolve(match.videoPath);

      // Check if videoPath is within tempDir (case-insensitive on Windows)
      const tempDirForCompare = isWindows ? normalizedTempDir.toLowerCase() : normalizedTempDir;
      const videoPathForCompare = isWindows
        ? normalizedVideoPath.toLowerCase()
        : normalizedVideoPath;

      if (videoPathForCompare.startsWith(tempDirForCompare + path.sep)) {
        // Store the normalized path for consistent lookup
        tempPaths.add(normalizedVideoPath);
      }
    }

    return tempPaths;
  }
}
