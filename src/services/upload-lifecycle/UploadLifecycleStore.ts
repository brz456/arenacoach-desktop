import * as fs from 'fs';
import * as path from 'path';
import {
  AcceptedUploadRecord,
  LocalPendingUploadRecord,
  UploadLifecycleRecord,
  UploadTrackingContract,
  parseUploadTrackingContract,
} from './types';

interface RawUploadLifecycleEntry {
  matchHash?: unknown;
  timestamp?: unknown;
  createdAt?: unknown;
  bufferId?: unknown;
  acceptedAt?: unknown;
  tracking?: unknown;
}

export class UploadLifecycleStore {
  private static readonly PENDING_UPLOADS_FILENAME = 'pending-uploads.json';
  private pendingUploadsPath: string;

  constructor(private userDataPath: string) {
    this.pendingUploadsPath = path.join(
      userDataPath,
      UploadLifecycleStore.PENDING_UPLOADS_FILENAME
    );
  }

  private async atomicWrite(filePath: string, data: string): Promise<void> {
    const tmpPath = `${filePath}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(tmpPath, data, 'utf-8');
      await fs.promises.rename(tmpPath, filePath);
    } catch (error) {
      try {
        await fs.promises.unlink(tmpPath);
      } catch {
        // Ignore temp cleanup failure.
      }
      throw error;
    }
  }

  async savePendingUploads(uploads: Map<string, UploadLifecycleRecord>): Promise<void> {
    const data = Object.fromEntries(uploads);
    await this.atomicWrite(this.pendingUploadsPath, JSON.stringify(data, null, 2));
  }

  async loadPendingUploads(): Promise<Map<string, UploadLifecycleRecord>> {
    try {
      await fs.promises.access(this.pendingUploadsPath);
      const raw = await fs.promises.readFile(this.pendingUploadsPath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, RawUploadLifecycleEntry>;
      const normalized = new Map<string, UploadLifecycleRecord>();

      for (const [localUploadId, entry] of Object.entries(parsed)) {
        if (!entry || typeof entry.matchHash !== 'string') {
          continue;
        }

        const createdAt =
          typeof entry.createdAt === 'number'
            ? entry.createdAt
            : typeof entry.timestamp === 'number'
              ? entry.timestamp
              : Date.now();

        const acceptedTracking = this.normalizeAcceptedTracking(entry);
        if (acceptedTracking) {
          const acceptedRecord: AcceptedUploadRecord = {
            matchHash: entry.matchHash,
            createdAt,
            acceptanceState: 'accepted',
            tracking: acceptedTracking,
            acceptedAt: typeof entry.acceptedAt === 'number' ? entry.acceptedAt : createdAt,
          };
          normalized.set(localUploadId, acceptedRecord);
          continue;
        }

        if (typeof entry.bufferId !== 'string' || entry.bufferId.trim().length === 0) {
          continue;
        }

        const localPendingRecord: LocalPendingUploadRecord = {
          matchHash: entry.matchHash,
          createdAt,
          acceptanceState: 'local_pending',
          bufferId: entry.bufferId,
        };
        normalized.set(localUploadId, localPendingRecord);
      }

      return normalized;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return new Map();
      }

      console.error('[UploadLifecycleStore] Failed to load pending uploads:', error);
      throw error;
    }
  }

  private normalizeAcceptedTracking(entry: RawUploadLifecycleEntry): UploadTrackingContract | null {
    return parseUploadTrackingContract(entry.tracking);
  }
}
