import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WoWInstallationDetector, type WoWInstallation } from '../../src/wowInstallation';

function makeInstallation(rootPath: string): WoWInstallation {
  return {
    path: rootPath,
    combatLogPath: `${rootPath}/_retail_/Logs`,
    addonsPath: `${rootPath}/_retail_/Interface/AddOns`,
    addonInstalled: false,
    arenaCoachAddonPath: `${rootPath}/_retail_/Interface/AddOns/ArenaCoach`,
  };
}

describe('WoWInstallationDetector robustness', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('detectInstallations tolerates per-candidate rejection', async () => {
    const validCandidate = 'C:\\Program Files (x86)\\World of Warcraft';
    const expected = makeInstallation(validCandidate);

    vi.spyOn(WoWInstallationDetector, 'validateInstallation').mockImplementation(
      async (candidate: string): Promise<WoWInstallation | null> => {
        if (candidate === validCandidate) return expected;
        if (candidate.startsWith('D:\\')) {
          const err = new Error("UNKNOWN: unknown error, stat 'D:\\\\_retail_'") as NodeJS.ErrnoException;
          err.code = 'UNKNOWN';
          return Promise.reject(err);
        }
        return null;
      }
    );

    await expect(WoWInstallationDetector.detectInstallations()).resolves.toEqual([expected]);
  });

  it('detectInstallationsWithOverrides tolerates per-candidate rejection and returns fulfilled installations', async () => {
    const userPath = '/user/wow';
    const expected = makeInstallation(userPath);

    vi.spyOn(WoWInstallationDetector, 'validateInstallation').mockImplementation(
      async (candidate: string): Promise<WoWInstallation | null> => {
        if (candidate === userPath) return expected;
        if (candidate.startsWith('D:\\')) {
          const err = new Error("UNKNOWN: unknown error, stat 'D:\\\\_retail_'") as NodeJS.ErrnoException;
          err.code = 'UNKNOWN';
          return Promise.reject(err);
        }
        return null;
      }
    );

    await expect(
      WoWInstallationDetector.detectInstallationsWithOverrides([userPath])
    ).resolves.toEqual([expected]);
  });
});
