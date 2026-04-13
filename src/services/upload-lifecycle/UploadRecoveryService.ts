import * as path from 'path';
import * as fs from 'fs';
import type { MatchEndedEvent } from '../../match-detection/types/MatchEvent';
import { MatchEventType } from '../../match-detection/types/MatchEvent';
import { MetadataStorageService } from '../MetadataStorageService';
import { LocalPendingUploadRecord } from './types';

export interface RecoverableUpload {
  chunkFilePath: string;
  matchHash: string;
  matchEvent: MatchEndedEvent;
}

export class UploadRecoveryService {
  constructor(
    private metadataStorageService: MetadataStorageService,
    private chunksDirectory: string
  ) {}

  async recoverPendingUpload(
    record: LocalPendingUploadRecord
  ): Promise<RecoverableUpload | null> {
    const metadata = await this.metadataStorageService.loadMatchByBufferId(record.bufferId);

    if (!metadata || metadata.matchCompletionStatus !== 'complete') {
      return null;
    }

    const bufferId = metadata.bufferId;
    const matchHash = metadata.matchHash;

    if (!bufferId || !matchHash) {
      return null;
    }

    const chunkFilePath = path.join(this.chunksDirectory, `${bufferId}.txt`);
    try {
      await fs.promises.access(chunkFilePath);
    } catch {
      return null;
    }

    return {
      chunkFilePath,
      matchHash,
      matchEvent: {
        type: MatchEventType.MATCH_ENDED,
        timestamp: metadata.matchData.timestamp,
        bufferId,
        metadata: metadata.matchData,
      },
    };
  }
}
