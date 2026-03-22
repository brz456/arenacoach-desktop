import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { activeFlavor } from './config/wowFlavor';

export interface WoWInstallation {
  path: string;
  combatLogPath: string;
  addonsPath: string;
  addonInstalled: boolean;
  arenaCoachAddonPath: string;
}

/**
 * Check if a file or directory exists.
 * Only ENOENT is treated as non-existence; other errors (EACCES, EPERM, etc.) propagate.
 */
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Synchronous path existence check.
 * Only ENOENT is treated as non-existence; other errors (EACCES, EPERM, etc.) propagate.
 */
function pathExistsSync(filePath: string): boolean {
  try {
    fs.statSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

const WINDOWS_INSTALL_PATHS = [
  'C:\\World of Warcraft',
  'C:\\Program Files (x86)\\World of Warcraft',
  'C:\\Program Files\\World of Warcraft',
  'D:\\World of Warcraft',
  'D:\\Program Files (x86)\\World of Warcraft',
  'D:\\Program Files\\World of Warcraft',
  'E:\\World of Warcraft',
  'E:\\Program Files (x86)\\World of Warcraft',
  'E:\\Program Files\\World of Warcraft',
  'F:\\World of Warcraft',
  'F:\\Program Files (x86)\\World of Warcraft',
  'F:\\Program Files\\World of Warcraft',
  // Battle.net default paths
  'C:\\Program Files (x86)\\Battle.net\\World of Warcraft',
  'C:\\Program Files\\Battle.net\\World of Warcraft',
] as const;

// Addon management constants
const ADDON_NAME = 'ArenaCoach';
const ADDON_FILES = ['ArenaCoach.lua', 'ArenaCoach.toc', 'icon64.tga'] as const;

export interface AddonInstallationResult {
  success: boolean;
  message: string;
  installedFiles?: string[];
  error?: string;
}

interface SourceValidationResult {
  isValid: boolean;
  error?: string;
}

export class AddonManager {
  /**
   * Check if ArenaCoach addon is properly installed in the given WoW installation
   */
  public static async checkAddonInstallation(
    installation: Omit<WoWInstallation, 'addonInstalled' | 'arenaCoachAddonPath'>
  ): Promise<boolean> {
    const addonPath = path.join(installation.addonsPath, ADDON_NAME);

    // Check if addon directory exists
    if (!(await pathExists(addonPath))) {
      console.debug(`ArenaCoach addon directory not found at: ${addonPath}`);
      return false;
    }

    // Check if all required files exist
    for (const fileName of ADDON_FILES) {
      const filePath = path.join(addonPath, fileName);
      if (!(await pathExists(filePath))) {
        console.debug(`ArenaCoach addon file missing: ${filePath}`);
        return false;
      }
    }

    console.debug(`ArenaCoach addon properly installed at: ${addonPath}`);
    return true;
  }

  /**
   * Install ArenaCoach addon to the specified WoW installation
   */
  public static async installAddon(
    installation: WoWInstallation
  ): Promise<AddonInstallationResult> {
    try {
      const addonPath = path.join(installation.addonsPath, ADDON_NAME);

      // Validate source directory exists before attempting installation
      const sourceValidation = await this.validateSourceDirectory();
      if (!sourceValidation.isValid) {
        return {
          success: false,
          message: 'Source addon files not found',
          error: sourceValidation.error || 'Unknown source validation error',
        };
      }

      // Ensure addon directory exists
      try {
        await fs.promises.mkdir(addonPath, { recursive: true });
      } catch (error) {
        if (error instanceof Error) {
          return {
            success: false,
            message: 'Failed to create addon directory',
            error: `Directory creation failed: ${error.message}`,
          };
        }
        throw error;
      }

      // Get source addon files path (from desktop/addon directory)
      const sourceAddonPath = this.getSourceAddonPath();
      const installedFiles: string[] = [];

      // Copy each addon file
      for (const fileName of ADDON_FILES) {
        const sourcePath = path.join(sourceAddonPath, fileName);
        const targetPath = path.join(addonPath, fileName);

        try {
          // Verify source file exists
          if (!(await pathExists(sourcePath))) {
            return {
              success: false,
              message: `Source addon file not found: ${fileName}`,
              error: `Missing source file: ${sourcePath}`,
            };
          }

          // Copy file
          await fs.promises.copyFile(sourcePath, targetPath);
          installedFiles.push(targetPath);
          console.debug(`Copied addon file: ${sourcePath} -> ${targetPath}`);
        } catch (error) {
          // Cleanup any partially copied files on error
          await this.cleanupPartialInstallation(addonPath, installedFiles);

          if (error instanceof Error) {
            return {
              success: false,
              message: `Failed to copy addon file: ${fileName}`,
              error: `File copy failed: ${error.message}`,
            };
          }
          throw error;
        }
      }

      console.log(`Successfully installed ArenaCoach addon to: ${addonPath}`);
      return {
        success: true,
        message: 'ArenaCoach addon installed successfully',
        installedFiles,
      };
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error installing addon: ${error.message}`);
        return {
          success: false,
          message: 'Addon installation failed',
          error: error.message,
        };
      } else {
        console.error('Unknown error installing addon:', error);
        return {
          success: false,
          message: 'Unknown error during addon installation',
          error: 'Unknown error occurred',
        };
      }
    }
  }

  /**
   * Validate that installed addon files exist
   */
  public static async validateAddonFiles(installation: WoWInstallation): Promise<boolean> {
    const addonPath = path.join(installation.addonsPath, ADDON_NAME);

    // Check if all required files exist
    for (const fileName of ADDON_FILES) {
      const installedPath = path.join(addonPath, fileName);

      if (!(await pathExists(installedPath))) {
        console.debug(`Addon file missing: ${installedPath}`);
        return false;
      }
    }

    return true;
  }

  /**
   * Validate source addon directory and files exist
   */
  private static async validateSourceDirectory(): Promise<SourceValidationResult> {
    try {
      const sourceAddonPath = this.getSourceAddonPath();

      // Check if source directory exists
      if (!(await pathExists(sourceAddonPath))) {
        return {
          isValid: false,
          error: `Source addon directory not found: ${sourceAddonPath}. Please ensure addon files are properly installed.`,
        };
      }

      // Check if all required files exist
      for (const fileName of ADDON_FILES) {
        const filePath = path.join(sourceAddonPath, fileName);
        if (!(await pathExists(filePath))) {
          return {
            isValid: false,
            error: `Source addon file missing: ${fileName}. Please reinstall the application.`,
          };
        }
      }

      return { isValid: true };
    } catch (error) {
      return {
        isValid: false,
        error: `Error validating source directory: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  // Private helper methods

  /**
   * Get the path to source addon files.
   * Returns a single deterministic path - no fallbacks, no probing.
   * If the path doesn't exist, validateSourceDirectory() will surface an explicit error.
   */
  private static getSourceAddonPath(): string {
    if (!app.isPackaged) {
      // Development: __dirname is desktop/dist, addon is at desktop/addon
      return path.resolve(__dirname, '..', 'addon');
    }
    // Production: addon files are unpacked via asarUnpack directive
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'addon');
  }

  /**
   * Clean up partially installed files in case of installation failure
   */
  private static async cleanupPartialInstallation(
    addonPath: string,
    installedFiles: string[]
  ): Promise<void> {
    // Remove any files that were successfully copied
    for (const filePath of installedFiles) {
      try {
        await fs.promises.unlink(filePath);
      } catch (error) {
        console.warn(`[AddonManager] Failed to remove file during cleanup: ${filePath}`, error);
      }
    }

    // Try to remove the addon directory if it's empty
    try {
      await fs.promises.rmdir(addonPath);
    } catch (error) {
      // ENOTEMPTY or ENOENT are expected (directory has other files or doesn't exist)
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'ENOENT') {
        console.warn(
          `[AddonManager] Failed to remove addon directory during cleanup: ${addonPath}`,
          error
        );
      }
    }
  }
}

export class WoWInstallationDetector {
  /**
   * Detect WoW installations on Windows
   */
  public static async detectInstallations(): Promise<WoWInstallation[]> {
    // Parallelize validation checks for better performance
    const validationPromises = WINDOWS_INSTALL_PATHS.map(potentialPath =>
      this.validateInstallation(potentialPath)
    );

    // Guardrail: ensure one unexpected failure cannot reject the entire scan.
    const results = await Promise.allSettled(validationPromises);

    const installations: WoWInstallation[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        if (result.value !== null) {
          installations.push(result.value);
        }
      } else {
        console.debug('[WoWInstallationDetector] Unexpected rejection while scanning candidate paths', {
          reason: result.reason,
        });
      }
    }

    return installations;
  }

  /**
   * Detect WoW installations with user-provided paths merged with default paths
   * Deduplicates paths (case-insensitive on Windows) and validates each
   * SSoT ordering: user paths first, then default paths
   */
  public static async detectInstallationsWithOverrides(
    userPaths: string[] = []
  ): Promise<WoWInstallation[]> {
    // Combine user paths and default paths (user paths first for SSoT ordering)
    const allPaths = [...userPaths, ...WINDOWS_INSTALL_PATHS];

    // Deduplicate paths (case-insensitive on Windows)
    const seenPaths = new Set<string>();
    const uniquePaths: string[] = [];

    for (const p of allPaths) {
      const normalizedKey = p.toLowerCase();
      if (!seenPaths.has(normalizedKey)) {
        seenPaths.add(normalizedKey);
        uniquePaths.push(p);
      }
    }

    // Parallelize validation checks
    const validationPromises = uniquePaths.map(potentialPath =>
      this.validateInstallation(potentialPath)
    );

    // Guardrail: ensure one unexpected failure cannot reject the entire scan.
    const results = await Promise.allSettled(validationPromises);

    // Filter out null results and deduplicate by installation path
    const installations: WoWInstallation[] = [];
    const seenInstallPaths = new Set<string>();

    for (const installation of results) {
      if (installation.status === 'fulfilled') {
        const value = installation.value;
        if (value !== null) {
          const normalizedInstallPath = value.path.toLowerCase();
          if (!seenInstallPaths.has(normalizedInstallPath)) {
            seenInstallPaths.add(normalizedInstallPath);
            installations.push(value);
          }
        }
      } else {
        console.debug('[WoWInstallationDetector] Unexpected rejection while scanning candidate paths', {
          reason: installation.reason,
        });
      }
    }

    return installations;
  }

  /**
   * Validate a potential WoW installation path for the active flavor
   * Accepts both parent directory and subdirectory paths for compatibility
   */
  public static async validateInstallation(installPath: string): Promise<WoWInstallation | null> {
    try {
      // Normalize path - handle both parent dir and subdirectory selection
      const normalizedPath = this.normalizeWoWPath(installPath);

      const flavorPath = path.join(normalizedPath, activeFlavor.dirName);

      // Check for active flavor installation only
      if (await pathExists(flavorPath)) {
        console.debug(`Found ${activeFlavor.id} directory at: ${flavorPath}`);
        if (await this.validateInstallationStructure(normalizedPath)) {
          console.debug(`Successfully validated WoW installation at: ${normalizedPath}`);
          return await this.createInstallationObject(normalizedPath);
        } else {
          console.debug(`Installation structure validation failed for: ${normalizedPath}`);
        }
      } else {
        console.debug(`${activeFlavor.id} directory not found at: ${flavorPath}`);
      }

      return null;
    } catch (error) {
      // Validation is best-effort. Any per-path probe error must not reject global detection.
      const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
      console.debug(
        `[WoWInstallationDetector] Error validating candidate path (code=${code}): ${installPath}`,
        error
      );
      return null;
    }
  }

  /**
   * Normalize WoW installation path to handle both parent and subdirectory selection
   * Includes security validation to prevent path traversal attacks
   */
  private static normalizeWoWPath(inputPath: string): string {
    // Security: Validate input to prevent path traversal attacks
    if (!inputPath || typeof inputPath !== 'string') {
      throw new Error('Invalid path: path must be a non-empty string');
    }

    // Check for null bytes (security)
    if (inputPath.includes('\0')) {
      throw new Error('Invalid path: null byte detected');
    }

    const normalizedInput = path.normalize(inputPath);

    // Segment-based traversal check: reject only if any segment is exactly '..'
    const segments = normalizedInput.split(path.sep);
    if (segments.some(segment => segment === '..')) {
      throw new Error('Invalid path: directory traversal detected');
    }

    return this.findWoWRootFromPath(normalizedInput);
  }

  /**
   * Robust upward search to find WoW root directory
   * Iterates until filesystem root; no artificial depth limit
   */
  private static findWoWRootFromPath(startPath: string): string {
    const basename = path.basename(startPath);

    // Check if user selected the active flavor subdirectory
    if (basename === activeFlavor.dirName) {
      return path.dirname(startPath);
    }

    // Reject any WoW version that isn't the active flavor
    if (basename.startsWith('_') && basename.endsWith('_') && basename !== activeFlavor.dirName) {
      throw new Error(
        `Unsupported WoW installation: ${basename}. Only the active WoW flavor is supported: ${activeFlavor.id} (${activeFlavor.dirName}).`
      );
    }

    // For Logs or other subdirectories, search upward for active flavor directory
    let currentPath = startPath;
    while (true) {
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        // Reached filesystem root
        break;
      }

      // Check if parent contains active flavor directory
      const flavorPath = path.join(parentPath, activeFlavor.dirName);
      try {
        if (pathExistsSync(flavorPath)) {
          return parentPath;
        }
      } catch {
        // Best-effort detection probe: missing/disconnected drives can throw (e.g. Windows UNKNOWN).
        // Treat probe errors as "not found" and continue walking upward.
      }

      currentPath = parentPath;
    }

    // Assume user selected parent directory if no active flavor found in upward search
    return startPath;
  }

  // Private helper methods

  private static async checkExecutable(installPath: string): Promise<boolean> {
    // Modern Battle.net installations put the executable INSIDE the flavor directory
    const flavorDir = path.join(installPath, activeFlavor.dirName);
    const executablePath = path.join(flavorDir, activeFlavor.windowsExecutable);
    return pathExists(executablePath);
  }

  /**
   * Validate .flavor.info file
   * Ensures we're detecting a genuine WoW installation for the active flavor
   */
  private static async validateFlavorInfo(flavorDir: string): Promise<boolean> {
    const flavorInfoPath = path.join(flavorDir, '.flavor.info');

    if (!(await pathExists(flavorInfoPath))) {
      console.debug(`Flavor info file not found: ${flavorInfoPath}`);
      return false;
    }

    const content = await fs.promises.readFile(flavorInfoPath, 'utf-8');
    const lines = content.split('\n');
    const flavor = lines[1]?.trim() || '';

    // Validate against the active flavor's expected value
    const isValidFlavor = flavor === activeFlavor.flavorInfoValue;
    if (!isValidFlavor) {
      console.debug(
        `Invalid flavor detected in ${flavorInfoPath}: expected '${activeFlavor.flavorInfoValue}', got '${flavor}'`
      );
    }
    return isValidFlavor;
  }

  /**
   * Enhanced validation for WoW installation (active flavor)
   * Includes .flavor.info validation
   * Parallelized for optimal performance
   */
  private static async validateInstallationStructure(installPath: string): Promise<boolean> {
    const flavorDir = path.join(installPath, activeFlavor.dirName);
    const addonsPath = path.join(flavorDir, 'Interface', 'AddOns');
    const logsPath = path.join(flavorDir, 'Logs');

    // Run all validation checks in parallel for better performance
    const [executableExists, flavorValid, addonsPathExists, logsPathExists] = await Promise.all([
      this.checkExecutable(installPath),
      this.validateFlavorInfo(flavorDir),
      pathExists(addonsPath),
      pathExists(logsPath),
    ]);

    return executableExists && flavorValid && addonsPathExists && logsPathExists;
  }

  private static async createInstallationObject(installPath: string): Promise<WoWInstallation> {
    const flavorPath = path.join(installPath, activeFlavor.dirName);
    const addonsPath = path.join(flavorPath, 'Interface', 'AddOns');
    const arenaCoachAddonPath = path.join(addonsPath, ADDON_NAME);

    // Check if addon is installed using the basic installation object for AddonManager
    const basicInstallation = {
      path: installPath,
      combatLogPath: path.join(flavorPath, 'Logs'),
      addonsPath,
    };

    const addonInstalled = await AddonManager.checkAddonInstallation(basicInstallation);

    return {
      path: installPath,
      combatLogPath: path.join(flavorPath, 'Logs'), // Point to Logs directory, not specific file
      addonsPath,
      addonInstalled,
      arenaCoachAddonPath,
    };
  }
}
