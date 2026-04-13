import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { UploadLifecycleStore } from '../../src/services/upload-lifecycle/UploadLifecycleStore';
import type { UploadLifecycleRecord } from '../../src/services/upload-lifecycle/types';

describe('UploadLifecycleStore', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true }))
    );
  });

  it('drops malformed pending uploads that do not include a bufferId', async () => {
    const userDataPath = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'upload-lifecycle-store-')
    );
    tempDirs.push(userDataPath);

    await fs.promises.writeFile(
      path.join(userDataPath, 'pending-uploads.json'),
      JSON.stringify({
        'local-upload-1': {
          matchHash: 'match-hash-1',
          timestamp: 1234,
        },
      }),
      'utf-8'
    );

    const store = new UploadLifecycleStore(userDataPath);
    const records = await store.loadPendingUploads();

    expect(records.has('local-upload-1')).toBe(false);
  });

  it('round-trips accepted upload state', async () => {
    const userDataPath = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'upload-lifecycle-store-')
    );
    tempDirs.push(userDataPath);

    const store = new UploadLifecycleStore(userDataPath);
    const records: Map<string, UploadLifecycleRecord> = new Map([
      [
        'local-upload-2',
        {
          matchHash: 'match-hash-2',
          createdAt: 100,
          acceptanceState: 'accepted' as const,
          tracking: {
            acceptedJobId: 'accepted-job-2',
            statusPath: '/api/upload/job-status/accepted-job-2',
            realtimePath: '/api/realtime/uploads/accepted-job-2',
          },
          acceptedAt: 200,
        },
      ],
    ]);

    await store.savePendingUploads(records);
    const loaded = await store.loadPendingUploads();

    expect(loaded.get('local-upload-2')).toEqual(records.get('local-upload-2'));
  });

  it('drops accepted uploads with malformed tracking paths', async () => {
    const userDataPath = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'upload-lifecycle-store-')
    );
    tempDirs.push(userDataPath);

    await fs.promises.writeFile(
      path.join(userDataPath, 'pending-uploads.json'),
      JSON.stringify({
        'local-upload-3': {
          matchHash: 'match-hash-3',
          createdAt: 1234,
          acceptedAt: 1235,
          tracking: {
            acceptedJobId: 'accepted-job-3',
            statusPath: 'https://evil.example/upload-status',
            realtimePath: '/api/realtime/uploads/accepted-job-3',
          },
        },
      }),
      'utf-8'
    );

    const store = new UploadLifecycleStore(userDataPath);
    const records = await store.loadPendingUploads();

    expect(records.has('local-upload-3')).toBe(false);
  });

  it('throws when pending upload state is malformed JSON', async () => {
    const userDataPath = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'upload-lifecycle-store-')
    );
    tempDirs.push(userDataPath);

    await fs.promises.writeFile(
      path.join(userDataPath, 'pending-uploads.json'),
      '{not-valid-json',
      'utf-8'
    );

    const store = new UploadLifecycleStore(userDataPath);

    await expect(store.loadPendingUploads()).rejects.toBeInstanceOf(SyntaxError);
  });
});
