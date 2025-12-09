import { promises as fs } from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';

/**
 * Simulates real combat log creation by streaming lines from an existing log file.
 * Useful for testing MatchLogWatcher and MatchChunker integration.
 * Based on real-world timing patterns observed in WoW combat logs.
 *
 * Supports both test mode (isolated testing) and production mode (writes to real WoW directory).
 */
export default class CombatLogSimulator extends EventEmitter {
  private sourceLogPath: string;
  private outputLogPath: string;
  private lines: string[] = [];
  private currentLineIndex = 0;
  private interval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private productionMode: boolean;

  // Deterministic mode support
  private random: () => number;
  private seed: number;

  // Test mode configuration
  private testMode: TestMode;

  // Simulation parameters (tunable for testing, based on real WoW behavior)
  private readonly DEFAULT_LINES_PER_BATCH = 400; // Lines written per interval (realistic)
  private readonly DEFAULT_BATCH_INTERVAL_MS = 200; // Interval between batches (realistic)
  private readonly BURST_MODE_LINES = 4; // Lines for combat bursts (realistic)
  private readonly BURST_MODE_INTERVAL_MS = 75; // Fast interval during combat (realistic)

  constructor(
    sourceLogPath: string,
    outputLogPath?: string,
    options: CombatLogSimulatorOptions = {}
  ) {
    super();
    this.sourceLogPath = this.validatePath(sourceLogPath, 'Source log path');

    // Determine production mode from options or environment
    this.productionMode = options.productionMode ?? process.env.PRODUCTION_MODE === 'true';

    // Set output path based on mode
    if (this.productionMode) {
      // Production mode path will be resolved during initialization
      this.outputLogPath = ''; // Temporary placeholder
    } else {
      if (!outputLogPath) {
        throw new Error('Output log path is required in test mode');
      }
      this.outputLogPath = this.validatePath(outputLogPath, 'Output log path');
    }

    // Initialize deterministic mode - check environment variable first
    const envSeed = process.env.SIMULATOR_SEED
      ? parseInt(process.env.SIMULATOR_SEED, 10)
      : undefined;
    this.seed = options.seed ?? envSeed ?? this.generateRandomSeed();
    this.random = this.createSeededRandom(this.seed);

    // Initialize test mode configuration
    this.testMode = this.getTestModeConfig();

    const seedSource = options.seed
      ? '(parameter)'
      : envSeed
        ? '(SIMULATOR_SEED env)'
        : '(generated)';
    const modeInfo = this.productionMode
      ? 'PRODUCTION (writes to real WoW directory)'
      : 'TEST (isolated)';
    console.info(`[CombatLogSimulator] Mode: ${modeInfo}`);
    if (!this.productionMode) {
      console.info(`[CombatLogSimulator] Output: ${this.outputLogPath}`);
    }
    console.info(`[CombatLogSimulator] Using seed: ${this.seed} ${seedSource}`);
    console.info(
      `[CombatLogSimulator] Test mode: ${this.testMode.name} - ${this.testMode.description}`
    );
  }

  /**
   * Resolve production log path for writing to real WoW directory
   */
  private async resolveProductionLogPath(customPath?: string): Promise<string> {
    if (customPath) {
      return this.validatePath(customPath, 'Custom WoW logs path');
    }

    // Generate proper WoW combat log filename with timestamp
    const timestamp = new Date();
    const month = String(timestamp.getMonth() + 1).padStart(2, '0');
    const day = String(timestamp.getDate()).padStart(2, '0');
    const year = String(timestamp.getFullYear()).slice(-2);
    const hour = String(timestamp.getHours()).padStart(2, '0');
    const minute = String(timestamp.getMinutes()).padStart(2, '0');
    const second = String(timestamp.getSeconds()).padStart(2, '0');

    const filename = `WoWCombatLog-${month}${day}${year}_${hour}${minute}${second}.txt`;

    // Resolve Windows WoW logs directory from WSL
    const wowLogsDir = await this.getWindowsWoWLogsDirectory();
    const fullPath = path.join(wowLogsDir, filename);

    console.info(`[CombatLogSimulator] Production log will be written to: ${fullPath}`);
    return fullPath;
  }

  /**
   * Get Windows WoW logs directory path from WSL environment
   */
  private async getWindowsWoWLogsDirectory(): Promise<string> {
    // Construct Windows path accessible from WSL
    // WoW is typically installed in Program Files (x86)
    const windowsPath = `/mnt/c/Program Files (x86)/World of Warcraft/_retail_/Logs`;

    // Validate the directory exists
    try {
      await fs.access(windowsPath);
    } catch (error) {
      console.error(`[CombatLogSimulator] Error accessing WoW logs directory:`, error);
      throw new Error(
        `Unable to access Windows WoW logs directory: ${windowsPath}. Please ensure WoW is installed and the directory exists.`
      );
    }

    return windowsPath;
  }

  /**
   * Validate file path to prevent path injection attacks
   * Following security patterns from wowInstallation.ts
   */
  private validatePath(inputPath: string, pathDescription: string): string {
    // Security: Validate input to prevent path traversal attacks
    if (!inputPath || typeof inputPath !== 'string') {
      throw new Error(`Invalid ${pathDescription.toLowerCase()}: path must be a non-empty string`);
    }

    // Check for path traversal patterns and null bytes
    if (inputPath.includes('..') || inputPath.includes('\0')) {
      throw new Error(
        `Invalid ${pathDescription.toLowerCase()}: directory traversal or null byte detected`
      );
    }

    // Extended length check for Windows paths
    if (inputPath.length > 500) {
      throw new Error(
        `Invalid ${pathDescription.toLowerCase()}: path too long (max 500 characters)`
      );
    }

    const normalizedPath = path.normalize(inputPath);

    // Additional security check after normalization
    if (normalizedPath.includes('..')) {
      throw new Error(
        `Invalid ${pathDescription.toLowerCase()}: directory traversal detected after normalization`
      );
    }

    // In production mode, validate Windows path format for cross-filesystem writes
    if (this.productionMode && pathDescription.toLowerCase().includes('wow')) {
      if (!normalizedPath.startsWith('/mnt/c/') && !normalizedPath.startsWith('C:\\')) {
        console.warn(
          `[CombatLogSimulator] Warning: ${pathDescription} may not be accessible from WSL: ${normalizedPath}`
        );
      }
    }

    return normalizedPath;
  }

  /**
   * Generate a random seed from current timestamp
   */
  private generateRandomSeed(): number {
    return Date.now() % 2147483647; // Keep within 32-bit signed integer range
  }

  /**
   * Create a seeded pseudo-random number generator using Linear Congruential Generator (LCG)
   * This provides deterministic randomness for reproducible test scenarios
   */
  private createSeededRandom(seed: number): () => number {
    let currentSeed = seed;

    return () => {
      // LCG formula: (a * seed + c) % m
      // Using constants from Numerical Recipes: a=1664525, c=1013904223, m=2^32
      currentSeed = (currentSeed * 1664525 + 1013904223) % 4294967296;
      return currentSeed / 4294967296; // Normalize to [0, 1)
    };
  }

  /**
   * Get the current seed (useful for logging and reproduction)
   */
  public getSeed(): number {
    return this.seed;
  }

  /**
   * Configure test mode based on environment variable
   * Default: realistic (matches real WoW timing patterns)
   * Stress mode: slower timing for race condition detection
   */
  private getTestModeConfig(): TestMode {
    const modeEnv = process.env.LOG_SIM_MODE?.toLowerCase() || 'realistic';

    switch (modeEnv) {
      case 'stress':
      case 'debug':
        return {
          name: 'stress',
          description: 'Slow timing for race condition detection',
          getLinesBatch: () => (this.random() < 0.8 ? 1 : 2),
          getInterval: () => 50 + this.random() * 100, // 50-150ms
          burstProbability: 0.3,
        };

      case 'realistic':
      case 'fast':
      case 'production':
      default:
        return {
          name: 'realistic',
          description: 'Real WoW combat log timing patterns',
          getLinesBatch: () => {
            // WoW combat bursts: 10-50 lines during intense combat
            const isBurst = this.random() < 0.8;
            return isBurst
              ? Math.floor(10 + this.random() * 40)
              : Math.floor(1 + this.random() * 3);
          },
          getInterval: () => {
            // WoW tick rate: 16-50ms for combat events
            return Math.floor(16 + this.random() * 34);
          },
          burstProbability: 0.8,
        };
    }
  }

  /**
   * Load the source combat log file
   */
  public async loadSourceLog(): Promise<void> {
    try {
      console.info('[CombatLogSimulator] Loading source log:', this.sourceLogPath);

      try {
        await fs.access(this.sourceLogPath);
      } catch {
        throw new Error(`Source log file not found: ${this.sourceLogPath}`);
      }

      const content = await fs.readFile(this.sourceLogPath, 'utf-8');
      this.lines = content.split('\n').filter(line => line.trim());

      console.info('[CombatLogSimulator] Loaded log with', this.lines.length, 'lines');

      // Resolve production path if needed
      if (this.productionMode && !this.outputLogPath) {
        this.outputLogPath = await this.resolveProductionLogPath();
        console.info(`[CombatLogSimulator] Output: ${this.outputLogPath}`);
      }

      // Create empty output file (simulating fresh combat log)
      await this.initializeOutputLog();
    } catch (error) {
      console.error('[CombatLogSimulator] Error loading source log:', error);
      throw error;
    }
  }

  /**
   * Start streaming simulation
   */
  public startSimulation(options: SimulationOptions = {}): void {
    if (this.isRunning) {
      console.warn('[CombatLogSimulator] Simulation already running');
      return;
    }

    if (this.lines.length === 0) {
      throw new Error('No source log loaded. Call loadSourceLog() first.');
    }

    const linesPerBatch = options.linesPerBatch || this.DEFAULT_LINES_PER_BATCH;
    const batchInterval = options.batchIntervalMs || this.DEFAULT_BATCH_INTERVAL_MS;
    const enableBurstMode = options.enableBurstMode ?? true;
    const useAdvancedTiming = options.useAdvancedTiming ?? false;

    this.isRunning = true;
    this.currentLineIndex = 0;

    console.info('[CombatLogSimulator] Starting simulation with', {
      totalLines: this.lines.length,
      linesPerBatch,
      batchInterval,
      enableBurstMode,
      useAdvancedTiming,
    });

    this.emit('simulationStarted', {
      totalLines: this.lines.length,
      outputPath: this.outputLogPath,
    });

    // Start the streaming process
    this.scheduleNextBatch(linesPerBatch, batchInterval, enableBurstMode, useAdvancedTiming);
  }

  /**
   * Stop the simulation
   */
  public stopSimulation(): void {
    if (this.interval) {
      clearTimeout(this.interval);
      this.interval = null;
    }

    this.isRunning = false;

    console.info('[CombatLogSimulator] Simulation stopped');
    this.emit('simulationStopped', {
      linesProcessed: this.currentLineIndex,
      totalLines: this.lines.length,
    });
  }

  /**
   * Schedule next batch of lines to be written
   */
  private scheduleNextBatch(
    linesPerBatch: number,
    batchInterval: number,
    enableBurstMode: boolean,
    useAdvancedTiming: boolean = false
  ): void {
    if (!this.isRunning || this.currentLineIndex >= this.lines.length) {
      // Simulation complete
      this.isRunning = false;
      console.info('[CombatLogSimulator] Simulation completed');
      this.emit('simulationCompleted', {
        linesProcessed: this.currentLineIndex,
        totalLines: this.lines.length,
      });
      return;
    }

    // Determine batch size and timing
    const currentLine = this.lines[this.currentLineIndex];
    let actualLinesPerBatch: number;
    let actualInterval: number;

    if (useAdvancedTiming && currentLine) {
      // Use sophisticated timing patterns from realistic test
      actualLinesPerBatch = this.getAdvancedBatchSize(currentLine);
      actualInterval = this.getAdvancedDelay([currentLine]);
    } else {
      // Use original burst mode logic (or fallback for advanced timing without currentLine)
      const isInCombatBurst = enableBurstMode && currentLine && this.detectCombatBurst(currentLine);
      actualLinesPerBatch = isInCombatBurst ? this.BURST_MODE_LINES : linesPerBatch;
      actualInterval = isInCombatBurst ? this.BURST_MODE_INTERVAL_MS : batchInterval;
    }

    // Write batch (async)
    this.writeBatch(actualLinesPerBatch).catch(error => {
      // Explicit error handling with guaranteed safety
      const safeHandleError = () => {
        try {
          console.error('[CombatLogSimulator] Error writing batch:', error);
          this.emit('error', error);
        } catch (emitError) {
          // If emit fails, fall back to console only
          console.error('[CombatLogSimulator] Critical: Failed to emit error event:', emitError);
        }

        try {
          this.stopSimulation();
        } catch (stopError) {
          console.error('[CombatLogSimulator] Critical: Failed to stop simulation:', stopError);
        }
      };

      safeHandleError();
    });

    // Schedule next batch
    this.interval = setTimeout(() => {
      if (this.isRunning) {
        this.scheduleNextBatch(linesPerBatch, batchInterval, enableBurstMode, useAdvancedTiming);
      }
    }, actualInterval) as NodeJS.Timeout;
  }

  /**
   * Write a batch of lines to the output file
   */
  private async writeBatch(linesCount: number): Promise<void> {
    const endIndex = Math.min(this.currentLineIndex + linesCount, this.lines.length);
    const batch = this.lines.slice(this.currentLineIndex, endIndex);

    if (batch.length === 0) return;

    try {
      // Append lines to output file (simulating real combat log writing)
      const content = batch.join('\n') + '\n';
      await fs.appendFile(this.outputLogPath, content, 'utf-8');

      const batchInfo = {
        startIndex: this.currentLineIndex,
        endIndex: endIndex,
        linesWritten: batch.length,
        totalProgress: ((endIndex / this.lines.length) * 100).toFixed(1) + '%',
      };

      // Check for important events in this batch
      const hasArenaStart = batch.some(line => line.includes('ARENA_MATCH_START'));
      const hasArenaEnd = batch.some(line => line.includes('ARENA_MATCH_END'));

      if (hasArenaStart || hasArenaEnd) {
        console.info('[CombatLogSimulator] Arena event batch:', {
          ...batchInfo,
          hasArenaStart,
          hasArenaEnd,
        });
      }

      this.emit('batchWritten', batchInfo);
      this.currentLineIndex = endIndex;
    } catch (error) {
      console.error('[CombatLogSimulator] Error writing batch:', error);
      this.emit('error', error as Error);
      this.stopSimulation();
    }
  }

  /**
   * Detect if we're in a combat burst based on log content
   */
  private detectCombatBurst(currentLine: string): boolean {
    // High activity events that indicate combat
    const combatEvents = [
      'SPELL_CAST_SUCCESS',
      'SPELL_DAMAGE',
      'SPELL_HEAL',
      'SWING_DAMAGE',
      'SPELL_AURA_APPLIED',
      'SPELL_INTERRUPT',
      'UNIT_DIED',
      'ARENA_MATCH_START',
      'ARENA_MATCH_END',
    ];

    return combatEvents.some(event => currentLine.includes(event));
  }

  /**
   * Initialize output log file with header
   */
  private async initializeOutputLog(): Promise<void> {
    // Ensure output directory exists
    const outputDir = path.dirname(this.outputLogPath);
    await fs.mkdir(outputDir, { recursive: true });

    // Create empty file (simulating WoW starting to write combat log)
    await fs.writeFile(this.outputLogPath, '', 'utf-8');

    console.info('[CombatLogSimulator] Initialized output log:', this.outputLogPath);
  }

  /**
   * Get current simulation status
   */
  public getStatus(): SimulationStatus {
    return {
      isRunning: this.isRunning,
      currentLineIndex: this.currentLineIndex,
      totalLines: this.lines.length,
      progress: this.lines.length > 0 ? this.currentLineIndex / this.lines.length : 0,
    };
  }

  /**
   * Skip to a specific line (useful for testing specific scenarios)
   */
  public skipToLine(lineIndex: number): void {
    if (lineIndex >= 0 && lineIndex < this.lines.length) {
      this.currentLineIndex = lineIndex;
      console.info('[CombatLogSimulator] Skipped to line:', lineIndex);
    }
  }

  /**
   * Find the line index of a specific arena match (useful for targeted testing)
   */
  public findArenaMatchStart(matchNumber: number = 0): number {
    let foundMatches = 0;

    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i];
      if (line && line.includes('ARENA_MATCH_START')) {
        if (foundMatches === matchNumber) {
          return i;
        }
        foundMatches++;
      }
    }

    return -1; // Not found
  }

  /**
   * Get advanced batch size based on content and test mode
   */
  private getAdvancedBatchSize(currentLine: string): number {
    if (!currentLine) return 1;

    // Important events are usually written individually
    if (currentLine.includes('ARENA_MATCH_START') || currentLine.includes('ARENA_MATCH_END')) {
      return 1;
    }

    // Use test mode configuration for batch sizing
    return this.testMode.getLinesBatch();
  }

  /**
   * Get advanced delay between writes based on test mode
   */
  private getAdvancedDelay(batch: string[]): number {
    const hasArenaEvent = batch.some(
      line => line && (line.includes('ARENA_MATCH_START') || line.includes('ARENA_MATCH_END'))
    );

    if (hasArenaEvent) {
      // Arena events should be processed quickly regardless of mode
      return Math.floor(10 + this.random() * 40); // 10-50ms
    }

    // Use test mode configuration for general timing
    return this.testMode.getInterval();
  }

  /**
   * Static factory method for production mode testing
   */
  public static createProductionSimulator(
    sourceLogPath: string,
    options: Omit<CombatLogSimulatorOptions, 'productionMode'> = {}
  ): CombatLogSimulator {
    return new CombatLogSimulator(sourceLogPath, undefined, { ...options, productionMode: true });
  }

  /**
   * Static factory method for test mode (existing behavior)
   */
  public static createTestSimulator(
    sourceLogPath: string,
    outputLogPath: string,
    options: Omit<CombatLogSimulatorOptions, 'productionMode'> = {}
  ): CombatLogSimulator {
    return new CombatLogSimulator(sourceLogPath, outputLogPath, {
      ...options,
      productionMode: false,
    });
  }

  /**
   * Static factory method for creating a static (non-changing) combat log file
   * Used for testing that the app only processes actively written files
   */
  public static async createStaticLogFile(
    sourceLogPath: string,
    outputLogPath: string
  ): Promise<void> {
    try {
      console.info('[CombatLogSimulator] Creating static log file from:', sourceLogPath);

      // Validate source file exists
      await fs.access(sourceLogPath);

      // Read entire source file
      const content = await fs.readFile(sourceLogPath, 'utf-8');

      // Ensure output directory exists
      const outputDir = path.dirname(outputLogPath);
      await fs.mkdir(outputDir, { recursive: true });

      // Write entire content at once (creating a complete, static file)
      await fs.writeFile(outputLogPath, content, 'utf-8');

      const lines = content.split('\n').filter(line => line.trim()).length;
      console.info('[CombatLogSimulator] Created static log file:', {
        outputPath: outputLogPath,
        lines: lines,
        size: content.length,
      });
    } catch (error) {
      console.error('[CombatLogSimulator] Error creating static log file:', error);
      throw error;
    }
  }
}

export interface CombatLogSimulatorOptions {
  productionMode?: boolean;
  wowLogsPath?: string;
  seed?: number;
}

export interface SimulationOptions {
  linesPerBatch?: number;
  batchIntervalMs?: number;
  enableBurstMode?: boolean;
  useAdvancedTiming?: boolean; // Use sophisticated timing patterns from realistic test
}

export interface SimulationStatus {
  isRunning: boolean;
  currentLineIndex: number;
  totalLines: number;
  progress: number;
}

export interface TestMode {
  name: string;
  description: string;
  getLinesBatch: () => number;
  getInterval: () => number;
  burstProbability: number;
}

// Allow running the simulator directly for production testing
if (require.main === module) {
  const runProductionSimulation = async (): Promise<void> => {
    console.info('🚀 WoW Combat Log Simulator - Production Mode');
    console.info('='.repeat(60));

    // Default source log path - can be overridden with command line argument
    const defaultSourceLog = path.resolve(__dirname, '../fixtures/logs/shuffle-single-match.txt');

    const sourceLogPath = process.argv[2] || defaultSourceLog;

    // Check if source log exists
    try {
      await fs.access(sourceLogPath);
    } catch {
      throw new Error(`Source combat log not found: ${sourceLogPath}`);
    }

    try {
      // Create production simulator
      const simulator = CombatLogSimulator.createProductionSimulator(sourceLogPath);

      // Load source log
      await simulator.loadSourceLog();

      // Set up completion handler
      simulator.on('simulationCompleted', stats => {
        console.info('✅ Simulation completed successfully!');
        console.info(`   Lines processed: ${stats.linesProcessed}/${stats.totalLines}`);
        console.info('   Your desktop app should now detect and process the combat log.');
        process.exit(0);
      });

      // Set up error handler
      simulator.on('error', error => {
        console.error('❌ Simulation failed:', error.message);
        process.exit(1);
      });

      // Start simulation with realistic timing
      console.info('⏳ Starting simulation...');
      simulator.startSimulation({
        enableBurstMode: true,
        useAdvancedTiming: false,
      });
    } catch (error) {
      console.error('❌ Failed to start simulation:', (error as Error).message);
      console.info('\n💡 Usage:');
      console.info(
        '   PRODUCTION_MODE=true node -r ts-node/register src/match-detection/test/CombatLogSimulator.ts [source-log-path]'
      );
      console.info(`   Default source log: ${defaultSourceLog}`);
      process.exit(1);
    }
  };

  runProductionSimulation().catch(console.error);
}
