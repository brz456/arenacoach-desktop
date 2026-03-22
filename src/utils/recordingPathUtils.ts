import * as path from 'path';

/**
 * Canonical default subdirectory for recordings
 */
export const DEFAULT_RECORDING_SUBDIR = 'ArenaCoach/Recordings';

/**
 * Calculate the effective recording directory based on user settings.
 * Pure function - SSoT for recording directory resolution.
 *
 * @param recordingLocation - User-configured recording location (may be undefined/null)
 * @param defaultBasePath - Default base path (typically app.getPath('videos'))
 * @returns The resolved recording directory path
 */
export function getEffectiveRecordingDirectory(
  recordingLocation: string | undefined | null,
  defaultBasePath: string
): string {
  const defaultDir = path.join(defaultBasePath, DEFAULT_RECORDING_SUBDIR);
  const trimmed = recordingLocation?.trim();

  if (!trimmed) {
    return defaultDir;
  }

  const normalizedPath = path.normalize(trimmed);
  const { root } = path.parse(normalizedPath);

  // Root detection: matches "C:\", "/", or "C:." (normalized form of "C:")
  const isRootDir = root !== '' && (normalizedPath === root || normalizedPath === root + '.');

  if (isRootDir) {
    return path.join(root, DEFAULT_RECORDING_SUBDIR);
  }

  return normalizedPath;
}
