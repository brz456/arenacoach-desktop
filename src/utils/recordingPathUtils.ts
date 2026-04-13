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

/**
 * Resolve the directory the app should actually use for recordings.
 * Falls back to the safe default when the configured root is unavailable.
 */
export function resolveRecordingDirectoryWithFallback(
  recordingLocation: string | undefined | null,
  defaultBasePath: string,
  rootExists: (root: string) => boolean
): string {
  const safeDefaultDir = path.join(defaultBasePath, DEFAULT_RECORDING_SUBDIR);
  const effectiveDir = getEffectiveRecordingDirectory(recordingLocation, defaultBasePath);
  const windowsRootMatch = effectiveDir.match(/^[A-Za-z]:[\\/]/);
  const root = windowsRootMatch?.[0] ?? path.parse(effectiveDir).root;

  if (!root) {
    return effectiveDir;
  }

  return rootExists(root) ? effectiveDir : safeDefaultDir;
}
