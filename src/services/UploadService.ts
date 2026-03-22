import * as fs from 'fs';
import * as path from 'path';
import axios, { isAxiosError } from 'axios';
import FormData from 'form-data';
import { ApiHeadersProvider } from './ApiHeadersProvider';
import { ServiceHealthCheck } from './ServiceHealthCheck';
import { MatchEndedEvent } from '../match-detection/types/MatchEvent';
import { toSafeAxiosErrorLog } from '../utils/errorRedaction';
import { activeFlavor } from '../config/wowFlavor';

/**
 * UploadService - Handles chunk uploads to the backend
 *
 * This service is responsible solely for uploading match chunks to the server.
 * It does not handle authentication checks, polling, or state management.
 * Authentication is optional via the ApiHeadersProvider.
 */
export class UploadService {
  // Upload timeout configuration (scales by file size for fast failure detection)
  // Backend caps uploads at 200 MB; these constants support 0.5 Mbps minimum uplink
  private static readonly BASE_MS = 30000; // 30 seconds base timeout
  private static readonly PER_MB_MS = 20000; // 20 seconds per MiB (rounded up)
  private static readonly MIN_MS = 60000; // 60 seconds minimum (fast retry for small files)
  private static readonly MAX_MS = 4200000; // 70 minutes maximum (supports 200 MB at 0.5 Mbps)

  constructor(
    private apiBaseUrl: string,
    private uploadEndpoint: string,
    private headersProvider: ApiHeadersProvider,
    private healthCheck?: ServiceHealthCheck
  ) {
    console.info('[UploadService] Initialized with:', {
      apiBaseUrl,
      uploadEndpoint,
      hasHealthCheck: !!healthCheck,
    });
  }

  /**
   * Compute upload timeout based on file size
   * Scales linearly with file size to support slow connections (0.5 Mbps minimum)
   * while enabling fast failure detection for small files
   */
  private static computeUploadTimeoutMs(fileSizeBytes: number): number {
    const fileSizeMiB = Math.ceil(fileSizeBytes / 1_048_576);
    const computed = UploadService.BASE_MS + UploadService.PER_MB_MS * fileSizeMiB;
    return Math.max(UploadService.MIN_MS, Math.min(computed, UploadService.MAX_MS));
  }

  /**
   * Upload a chunk file with match metadata to the server
   *
   * @param chunkFilePath - Path to the chunk file to upload
   * @param matchMetadata - Match metadata from the game
   * @param matchHash - Service-authoritative content identifier
   * @param jobId - Client-generated job ID for correlation
   * @throws Error if upload fails or file doesn't exist
   */
  async uploadChunk(
    chunkFilePath: string,
    matchMetadata: MatchEndedEvent,
    matchHash: string,
    jobId: string
  ): Promise<void> {
    // Verify chunk file exists
    await fs.promises.access(chunkFilePath);
    const stats = await fs.promises.stat(chunkFilePath);
    const timeoutMs = UploadService.computeUploadTimeoutMs(stats.size);

    console.info('[UploadService] Preparing upload:', {
      jobId,
      matchHash,
      fileSize: stats.size,
      timeoutMs,
      hasAuth: this.headersProvider.hasAuth(),
    });

    // Create form data for multipart upload
    const formData = new FormData();

    // Append the chunk file
    formData.append('file', fs.createReadStream(chunkFilePath), {
      filename: path.basename(chunkFilePath),
      contentType: 'text/plain',
    });

    // Append the client-generated job ID
    formData.append('jobId', jobId);

    // Append match metadata as JSON
    const workerPayload = {
      matchData: matchMetadata.metadata,
      matchHash,
      wowFlavor: activeFlavor.id,
    };
    formData.append('metadataJson', JSON.stringify(workerPayload));

    // Get headers with optional auth
    const headers = this.headersProvider.getHeaders(formData.getHeaders());

    try {
      // Make the upload request
      const response = await axios.post(`${this.apiBaseUrl}${this.uploadEndpoint}`, formData, {
        headers,
        timeout: timeoutMs,
      });

      // Check for successful response (any 2xx with success: true)
      if (response.status >= 200 && response.status < 300 && response.data?.success) {
        console.info('[UploadService] Upload successful:', {
          jobId,
          serverJobId: response.data.jobId,
          isIdempotent: response.data.isIdempotent || false,
          hasAuth: this.headersProvider.hasAuth(),
        });

        // Report success to health check
        this.healthCheck?.reportSuccess();

        // Validate server returned same jobId
        if (response.data.jobId !== jobId) {
          console.warn('[UploadService] Server returned different jobId than expected:', {
            clientJobId: jobId,
            serverJobId: response.data.jobId,
          });
        }
      } else {
        const backendMessage =
          typeof response.data?.error?.message === 'string' ? response.data.error.message : null;
        throw new Error(
          `Upload failed: HTTP ${response.status} - ${backendMessage || 'Unknown error'}`
        );
      }
    } catch (error) {
      // Handle idempotent responses (regardless of status code)
      if (isAxiosError(error) && error.response?.data?.isIdempotent) {
        console.info('[UploadService] Upload succeeded via idempotency:', {
          jobId,
          status: error.response.status,
        });
        // Report success even for idempotent responses
        this.healthCheck?.reportSuccess();
        return;
      }

      // Report failure for network or 5xx errors
      if (isAxiosError(error)) {
        const isNetworkOrServerError = !error.response || error.response.status >= 500;
        this.healthCheck?.reportFailure(isNetworkOrServerError);
      } else {
        // Unknown error type - assume it's a failure
        this.healthCheck?.reportFailure(true);
      }

      // Re-throw other errors
      console.error('[UploadService] Upload failed:', { jobId, ...toSafeAxiosErrorLog(error) });
      throw error;
    }
  }

  /**
   * Get current upload configuration for debugging
   */
  getConfig(): { apiBaseUrl: string; uploadEndpoint: string; hasAuth: boolean } {
    return {
      apiBaseUrl: this.apiBaseUrl,
      uploadEndpoint: this.uploadEndpoint,
      hasAuth: this.headersProvider.hasAuth(),
    };
  }
}
