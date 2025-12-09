/**
 * System monitoring types for match detection service
 */

export interface SystemMetrics {
  linesProcessed: number;
  errorsHandled: number;
  lastProcessingTime: number;
  memoryUsage?: {
    heapUsed: number; // MB
    rss: number; // MB - Resident Set Size (total memory)
  };
}

