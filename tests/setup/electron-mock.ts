import { vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';

const TEST_USER_DATA_DIR = path.join(process.cwd(), 'tmp', 'desktop-vitest-user-data');
fs.mkdirSync(TEST_USER_DATA_DIR, { recursive: true });

vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => {
      if (key === 'userData') return TEST_USER_DATA_DIR;
      // For other keys, fall back to process.cwd() to avoid surprises in tests
      return process.cwd();
    },
  },
}));
