import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { MetadataStorageService } from '../../src/services/MetadataStorageService';
import {
  StoredMatchMetadata,
  UploadStatus,
} from '../../src/match-detection/types/StoredMatchTypes';
import { BRACKET_STRINGS } from '../../src/match-detection/types/MatchMetadata';

const MATCH_HASH = 'a'.repeat(64);

function createMatch(): StoredMatchMetadata {
  return {
    matchHash: MATCH_HASH,
    bufferId: 'buffer-1',
    matchCompletionStatus: 'complete',
    enrichmentPhase: 'finalized',
    createdAt: new Date('2026-04-10T00:00:00.000Z'),
    lastUpdatedAt: new Date('2026-04-10T00:00:00.000Z'),
    uploadStatus: UploadStatus.PENDING,
    matchData: {
      timestamp: new Date('2026-04-10T00:00:00.000Z'),
      mapId: 572,
      bracket: BRACKET_STRINGS.TWO_V_TWO,
      season: 41,
      isRanked: true,
      playerId: 'Player-1',
      winningTeamId: 0,
      matchDuration: 120,
      team0MMR: 1800,
      team1MMR: 1800,
      players: [
        {
          id: 'Player-1',
          personalRating: 1800,
          classId: 1,
          specId: 71,
          teamId: 0,
        },
        {
          id: 'Player-2',
          personalRating: 1800,
          classId: 2,
          specId: 70,
          teamId: 1,
        },
      ],
    },
  };
}

describe('MetadataStorageService upload status updates', () => {
  let storageDir: string;
  let service: MetadataStorageService;

  beforeEach(async () => {
    storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-storage-service-'));
    service = new MetadataStorageService({ storageDir });
    await service.initialize();
  });

  afterEach(async () => {
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  it('does not regress processing back to queued when a stale queued write completes late', async () => {
    await service.saveMatch(createMatch());

    const processingStatus = await service.updateMatchStatus(MATCH_HASH, UploadStatus.PROCESSING, {
      progressMessage: 'Analyzing match data and generating insights...',
    });
    const queuedStatus = await service.updateMatchStatus(MATCH_HASH, UploadStatus.QUEUED, {
      jobId: 'accepted-job-1',
      progressMessage: 'Queued for processing...',
    });
    const savedMatch = await service.loadMatch(MATCH_HASH);

    expect(processingStatus).toBe(UploadStatus.PROCESSING);
    expect(queuedStatus).toBe(UploadStatus.PROCESSING);
    expect(savedMatch?.uploadStatus).toBe(UploadStatus.PROCESSING);
    expect(savedMatch?.jobId).toBe('accepted-job-1');
    expect(savedMatch?.progressMessage).toBe('Analyzing match data and generating insights...');
  });
});
