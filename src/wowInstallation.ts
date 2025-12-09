import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

export interface WoWInstallation {
  path: string;
  version: 'retail'; // Only retail is supported
  combatLogPath: string;
  addonsPath: string;
  addonInstalled: boolean;
  arenaCoachAddonPath: string;
}

// Windows installation constants
const WINDOWS_EXECUTABLE = 'Wow.exe';
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
    try {
      const addonPath = path.join(installation.addonsPath, ADDON_NAME);

      // Check if addon directory exists
      if (!(await this.pathExists(addonPath))) {
        console.debug(`ArenaCoach addon directory not found at: ${addonPath}`);
        return false;
      }

      // Check if all required files exist
      for (const fileName of ADDON_FILES) {
        const filePath = path.join(addonPath, fileName);
        if (!(await this.pathExists(filePath))) {
          console.debug(`ArenaCoach addon file missing: ${filePath}`);
          return false;
        }
      }

      console.debug(`ArenaCoach addon properly installed at: ${addonPath}`);
      return true;
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error checking addon installation: ${error.message}`);
      } else {
        console.error('Unknown error checking addon installation:', error);
      }
      return false;
    }
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
          if (!(await this.pathExists(sourcePath))) {
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
    try {
      const addonPath = path.join(installation.addonsPath, ADDON_NAME);

      // Check if all required files exist
      for (const fileName of ADDON_FILES) {
        const installedPath = path.join(addonPath, fileName);

        if (!(await this.pathExists(installedPath))) {
          console.debug(`Addon file missing: ${installedPath}`);
          return false;
        }
      }

      return true;
    } catch (error) {
      console.error('Error validating addon files:', error);
      return false;
    }
  }

  /**
   * Validate source addon directory and files exist
   */
  private static async validateSourceDirectory(): Promise<SourceValidationResult> {
    try {
      const sourceAddonPath = this.getSourceAddonPath();

      // Check if source directory exists
      if (!(await this.pathExists(sourceAddonPath))) {
        return {
          isValid: false,
          error: `Source addon directory not found: ${sourceAddonPath}. Please ensure addon files are properly installed.`,
        };
      }

      // Check if all required files exist
      for (const fileName of ADDON_FILES) {
        const filePath = path.join(sourceAddonPath, fileName);
        if (!(await this.pathExists(filePath))) {
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
   * Get the path to source addon files with fallback mechanisms for production
   */
  private static getSourceAddonPath(): string {
    // In development, use the local addon directory
    if (process.env.NODE_ENV === 'development') {
      // Use absolute path to ensure we find the addon files regardless of cwd
      const possibleDevPaths = [
        // Current working directory (for normal dev)
        path.join(process.cwd(), 'addon'),
        // Relative to compiled JS location
        path.join(__dirname, '..', 'addon'),
        path.join(__dirname, '..', '..', 'addon'),
        // Built app location (for development builds)
        path.join(app.getAppPath(), 'addon'),
      ];

      // Return the first path that exists
      for (const devPath of possibleDevPaths) {
        try {
          if (fs.existsSync(devPath)) {
            return devPath;
          }
        } catch (error) {
          // Continue trying other paths
        }
      }

      // Fallback to default path
      return path.join(process.cwd(), 'addon');
    }

    // In production, addon files are unpacked via asarUnpack directive
    // They are always located at resources/app.asar.unpacked/addon
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'addon');
  }

  /**
   * Clean up partially installed files in case of installation failure
   */
  private static async cleanupPartialInstallation(
    addonPath: string,
    installedFiles: string[]
  ): Promise<void> {
    try {
      // Remove any files that were successfully copied
      for (const filePath of installedFiles) {
        try {
          await fs.promises.unlink(filePath);
        } catch (error) {
          // Continue cleanup even if individual file removal fails
        }
      }

      // Try to remove the addon directory if it's empty
      try {
        await fs.promises.rmdir(addonPath);
      } catch (error) {
        // Directory might not be empty or might not exist, which is fine
      }
    } catch (error) {
      console.error('Error during cleanup:', error);
    }
  }

  /**
   * Check if a file or directory exists
   */
  private static async pathExists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

export class WoWInstallationDetector {
  /**
   * Detect WoW installations on Windows
   */
  public static async detectInstallations(): Promise<WoWInstallation[]> {
    try {
      // Parallelize validation checks for better performance
      const validationPromises = WINDOWS_INSTALL_PATHS.map(potentialPath =>
        this.validateInstallation(potentialPath)
      );

      const results = await Promise.all(validationPromises);

      // Filter out null results and return valid installations
      return results.filter(
        (installation): installation is WoWInstallation => installation !== null
      );
    } catch (error) {
      console.error('Error detecting WoW installations:', error);
      return [];
    }
  }

  /**
   * Detect WoW installations with user-provided paths merged with default paths
   * Deduplicates paths (case-insensitive on Windows) and validates each
   * SSoT ordering: user paths first, then default paths
   */
  public static async detectInstallationsWithOverrides(
    userPaths: string[] = []
  ): Promise<WoWInstallation[]> {
    try {
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

      const results = await Promise.all(validationPromises);

      // Filter out null results and deduplicate by installation path
      const installations: WoWInstallation[] = [];
      const seenInstallPaths = new Set<string>();

      for (const installation of results) {
        if (installation !== null) {
          const normalizedInstallPath = installation.path.toLowerCase();
          if (!seenInstallPaths.has(normalizedInstallPath)) {
            seenInstallPaths.add(normalizedInstallPath);
            installations.push(installation);
          }
        }
      }

      return installations;
    } catch (error) {
      console.error('Error detecting WoW installations with overrides:', error);
      return [];
    }
  }

  /**
   * Validate a potential WoW retail installation path
   * Accepts both parent directory and subdirectory paths for compatibility
   */
  public static async validateInstallation(installPath: string): Promise<WoWInstallation | null> {
    try {
      // Normalize path - handle both parent dir and subdirectory selection
      const normalizedPath = this.normalizeWoWPath(installPath);

      const retailPath = path.join(normalizedPath, '_retail_');

      // Check for retail installation only
      if (await this.pathExists(retailPath)) {
        console.debug(`Found retail directory at: ${retailPath}`);
        if (await this.validateInstallationStructure(normalizedPath)) {
          console.debug(`Successfully validated WoW installation at: ${normalizedPath}`);
          return await this.createInstallationObject(normalizedPath);
        } else {
          console.debug(`Installation structure validation failed for: ${normalizedPath}`);
        }
      } else {
        console.debug(`Retail directory not found at: ${retailPath}`);
      }

      return null;
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error validating installation at '${installPath}': ${error.message}`);
      } else {
        console.error(`Unknown error validating installation at '${installPath}':`, error);
      }
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

    // Check for path traversal patterns
    if (inputPath.includes('..') || inputPath.includes('\0') || inputPath.length > 260) {
      throw new Error('Invalid path: directory traversal or malformed path detected');
    }

    const normalizedInput = path.normalize(inputPath);

    // Additional security check after normalization
    if (normalizedInput.includes('..')) {
      throw new Error('Invalid path: directory traversal detected after normalization');
    }

    return this.findWoWRootFromPath(normalizedInput);
  }

  /**
   * Robust upward search to find WoW root directory
   * Replaces brittle depth assumptions with dynamic search
   */
  private static findWoWRootFromPath(startPath: string): string {
    const basename = path.basename(startPath);

    // Check if user selected retail subdirectory
    if (basename === '_retail_') {
      return path.dirname(startPath);
    }

    // Reject any WoW version that isn't retail
    if (basename.startsWith('_') && basename.endsWith('_') && basename !== '_retail_') {
      throw new Error(
        `Unsupported WoW installation: ${basename}. Only retail (_retail_) is supported.`
      );
    }

    // For Logs or other subdirectories, search upward for _retail_ directory
    let currentPath = startPath;
    for (let i = 0; i < 5; i++) {
      // Limit search depth to prevent infinite loops
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        // Reached filesystem root
        break;
      }

      // Check if parent contains _retail_ directory
      const retailPath = path.join(parentPath, '_retail_');
      try {
        if (fs.existsSync(retailPath)) {
          return parentPath;
        }
      } catch {
        // Continue searching if access fails
      }

      currentPath = parentPath;
    }

    // Assume user selected parent directory if no _retail_ found in upward search
    return startPath;
  }

  // Private helper methods

  private static async checkExecutable(installPath: string): Promise<boolean> {
    // Modern Battle.net installations put Wow.exe INSIDE the _retail_ directory
    const retailDir = path.join(installPath, '_retail_');
    const executablePath = path.join(retailDir, WINDOWS_EXECUTABLE);
    return this.pathExists(executablePath);
  }

  /**
   * Validate .flavor.info file
   * Ensures we're detecting a genuine retail WoW installation
   */
  private static async validateFlavorInfo(retailDir: string): Promise<boolean> {
    const flavorInfoPath = path.join(retailDir, '.flavor.info');

    if (!(await this.pathExists(flavorInfoPath))) {
      console.debug(`Flavor info file not found: ${flavorInfoPath}`);
      return false;
    }

    try {
      const content = await fs.promises.readFile(flavorInfoPath, 'utf-8');
      const lines = content.split('\n');
      const flavor = lines[1]?.trim() || '';

      // Retail WoW should have 'wow' as the flavor
      const isRetail = flavor === 'wow';
      if (!isRetail) {
        console.debug(
          `Invalid flavor detected in ${flavorInfoPath}: expected 'wow', got '${flavor}'`
        );
      }
      return isRetail;
    } catch (error) {
      if (error instanceof Error) {
        console.error(
          `Error reading or parsing .flavor.info at ${flavorInfoPath}: ${error.message}`
        );
      } else {
        console.error(`Unknown error reading .flavor.info at ${flavorInfoPath}:`, error);
      }
      return false;
    }
  }

  /**
   * Enhanced validation for retail WoW installation
   * Includes .flavor.info validation
   * Parallelized for optimal performance
   */
  private static async validateInstallationStructure(installPath: string): Promise<boolean> {
    const retailDir = path.join(installPath, '_retail_');
    const addonsPath = path.join(retailDir, 'Interface', 'AddOns');
    const logsPath = path.join(retailDir, 'Logs');

    // Run all validation checks in parallel for better performance
    const [executableExists, flavorValid, addonsPathExists, logsPathExists] = await Promise.all([
      this.checkExecutable(installPath),
      this.validateFlavorInfo(retailDir),
      this.pathExists(addonsPath),
      this.pathExists(logsPath),
    ]);

    return executableExists && flavorValid && addonsPathExists && logsPathExists;
  }

  private static async createInstallationObject(installPath: string): Promise<WoWInstallation> {
    const retailPath = path.join(installPath, '_retail_');
    const addonsPath = path.join(retailPath, 'Interface', 'AddOns');
    const arenaCoachAddonPath = path.join(addonsPath, ADDON_NAME);

    // Check if addon is installed using the basic installation object for AddonManager
    const basicInstallation = {
      path: installPath,
      version: 'retail' as const,
      combatLogPath: path.join(retailPath, 'Logs'),
      addonsPath,
    };

    const addonInstalled = await AddonManager.checkAddonInstallation(basicInstallation);

    return {
      path: installPath,
      version: 'retail',
      combatLogPath: path.join(retailPath, 'Logs'), // Point to Logs directory, not specific file
      addonsPath,
      addonInstalled,
      arenaCoachAddonPath,
    };
  }

  private static async pathExists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
