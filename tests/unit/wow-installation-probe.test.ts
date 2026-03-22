import { describe, it, expect, vi, afterEach } from 'vitest';

describe('WoWInstallationDetector probe tolerance', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('fs');
  });

  it('validateInstallation returns null when statSync throws UNKNOWN (probe tolerance)', async () => {
    vi.resetModules();

    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');

      const statSync = (p: import('fs').PathLike) => {
        const pathString = String(p);
        if (pathString === '/mnt/_retail_') {
          const err = new Error("UNKNOWN: unknown error, stat '/mnt/_retail_'") as NodeJS.ErrnoException;
          err.code = 'UNKNOWN';
          throw err;
        }
        const err = new Error(`ENOENT: no such file or directory, stat '${pathString}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      };

      const access = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      return {
        ...actual,
        statSync,
        promises: {
          ...actual.promises,
          access,
        },
      };
    });

    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const { WoWInstallationDetector } = await import('../../src/wowInstallation');
    const result = await WoWInstallationDetector.validateInstallation('/mnt/disconnected');

    expect(result).toBeNull();
    expect(
      debugSpy.mock.calls.some(call =>
        String(call[0]).startsWith('[WoWInstallationDetector] Error validating candidate path')
      )
    ).toBe(false);
  });

  it('validateInstallation returns null when fs access throws UNKNOWN', async () => {
    vi.resetModules();

    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');

      // Keep statSync benign here; exercise the validateInstallation try/catch via pathExists().
      const statSync = (_p: import('fs').PathLike) => {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      };

      const access = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('UNKNOWN'), { code: 'UNKNOWN' }));

      return {
        ...actual,
        statSync,
        promises: {
          ...actual.promises,
          access,
        },
      };
    });

    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const { WoWInstallationDetector } = await import('../../src/wowInstallation');
    await expect(WoWInstallationDetector.validateInstallation('/mnt/whatever')).resolves.toBeNull();

    expect(
      debugSpy.mock.calls.some(call =>
        String(call[0]).includes('[WoWInstallationDetector] Error validating candidate path (code=UNKNOWN): /mnt/whatever')
      )
    ).toBe(true);
  });
});
