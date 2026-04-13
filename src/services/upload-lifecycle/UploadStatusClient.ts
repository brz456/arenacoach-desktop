import axios, { AxiosInstance } from 'axios';
import { ApiHeadersProvider } from '../ApiHeadersProvider';
import { ServiceHealthCheck } from '../ServiceHealthCheck';
import { BackendContractViolationError, UnauthorizedAuthError } from './errors';
import {
  UploadStatusResponse,
  UploadTrackingContract,
  isUploadAnalysisStatus,
} from './types';

export class UploadStatusClient {
  private readonly httpClient: AxiosInstance;

  constructor(
    apiBaseUrl: string,
    private headersProvider: ApiHeadersProvider,
    private healthCheck?: ServiceHealthCheck
  ) {
    this.httpClient = axios.create({
      baseURL: apiBaseUrl,
      timeout: 10000,
    });
  }

  async getStatus(tracking: UploadTrackingContract): Promise<UploadStatusResponse> {
    let response;
    try {
      response = await this.httpClient.get<UploadStatusResponse>(tracking.statusPath, {
        headers: this.headersProvider.getHeaders(),
      });
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        throw new UnauthorizedAuthError('Upload status request returned unauthorized (401)');
      }
      throw error;
    }
    if (!isUploadAnalysisStatus(response.data.analysisStatus)) {
      throw new BackendContractViolationError(
        `Backend contract violation: upload status returned unknown lifecycle state "${String(response.data.analysisStatus)}"`
      );
    }
    this.healthCheck?.reportSuccess();
    return response.data;
  }
}
