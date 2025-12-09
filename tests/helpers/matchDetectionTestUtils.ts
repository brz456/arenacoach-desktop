import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import MatchLogWatcher from '../../src/match-detection/parsing/MatchLogWatcher';
import MatchChunker, { MatchChunkerOptions } from '../../src/match-detection/chunking/MatchChunker';
import { MetadataService } from '../../src/services/MetadataService';
import { MetadataStorageService } from '../../src/services/MetadataStorageService';

/**
 * Path to the fixtures directory
 */
export const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');
export const FIXTURES_LOGS_DIR = path.join(FIXTURES_DIR, 'logs');

/**
 * Load a fixture log file into an array of non-empty lines.
 * @param relativePath - Path relative to tests/fixtures/logs/
 */
export async function loadFixtureLog(relativePath: string): Promise<string[]> {
  const fullPath = path.join(FIXTURES_LOGS_DIR, relativePath);
  const content = await fs.readFile(fullPath, 'utf-8');
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

/**
 * Create a temporary directory for test output.
 * Returns the absolute path to the created directory.
 */
export async function createTempTestDir(prefix: string = 'desktop-vitest-'): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return tempDir;
}

/**
 * Create a MatchLogWatcher configured for testing.
 * Ensures the logDir exists before constructing the watcher.
 */
export async function createTestMatchLogWatcher(
  logDir: string,
  timeoutMinutes: number = 10
): Promise<MatchLogWatcher> {
  // Ensure logDir exists (MatchLogWatcher validates directory existence)
  await fs.mkdir(logDir, { recursive: true });
  return new MatchLogWatcher(logDir, timeoutMinutes);
}

/**
 * Create a MatchChunker configured for testing.
 * Automatically includes outputDir in allowedOutputRoots for security checks.
 * Calls init() before returning.
 */
export async function createTestMatchChunker(
  outputDir: string,
  overrides?: Partial<Omit<MatchChunkerOptions, 'outputDir'>>
): Promise<MatchChunker> {
  // Merge outputDir into allowedOutputRoots so security checks pass
  const allowedOutputRoots = [outputDir, ...(overrides?.allowedOutputRoots || [])];

  const options: MatchChunkerOptions = {
    outputDir,
    ...overrides,
    allowedOutputRoots,
  };

  const chunker = new MatchChunker(options);
  await chunker.init();
  return chunker;
}

/**
 * Create MetadataService and MetadataStorageService configured for testing.
 * Uses the provided metadataDir for storage instead of the default userData path.
 */
export async function createTestMetadataServices(metadataDir: string): Promise<{
  metadataService: MetadataService;
  metadataStorage: MetadataStorageService;
}> {
  const metadataStorage = new MetadataStorageService({ storageDir: metadataDir });
  await metadataStorage.initialize();

  const metadataService = new MetadataService(metadataStorage);

  return { metadataService, metadataStorage };
}

/**
 * Clean up a temporary test directory.
 */
export async function cleanupTempDir(tempDir: string): Promise<void> {
  await fs.rm(tempDir, { recursive: true, force: true });
}

/**
 * Creates a per-bufferId operation queue that serializes async operations.
 * Mirrors main.ts enqueueLifecycleOp pattern.
 *
 * Error handling: Errors are collected (not swallowed) and the chain continues.
 * This matches production where errors are caught at the event listener level,
 * allowing subsequent lifecycle operations to proceed.
 * Use getErrors() to assert on collected errors deterministically.
 */
export function createLifecycleOpQueue(): {
  enqueueOp: (bufferId: string, op: () => Promise<void>) => void;
  waitForAll: () => Promise<void>;
  getErrors: () => Error[];
} {
  const queues = new Map<string, Promise<void>>();
  const errors: Error[] = [];

  const enqueueOp = (bufferId: string, op: () => Promise<void>): void => {
    const prev = queues.get(bufferId) ?? Promise.resolve();
    // Collect errors but continue chain (matches production error isolation)
    const next = prev.then(op).catch((err: Error) => {
      errors.push(err);
    });
    queues.set(bufferId, next);
  };

  const waitForAll = (): Promise<void> => {
    return Promise.all(Array.from(queues.values())).then(() => {});
  };

  const getErrors = (): Error[] => [...errors];

  return { enqueueOp, waitForAll, getErrors };
}
