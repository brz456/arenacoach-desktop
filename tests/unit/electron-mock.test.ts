import { describe, it, expect } from 'vitest';
import { MetadataStorageService } from '../../src/services/MetadataStorageService';

describe('Electron Mock', () => {
  it('allows MetadataStorageService import without crashing', () => {
    // Just importing should work with the electron mock
    expect(MetadataStorageService).toBeDefined();
  });

  it('can instantiate MetadataStorageService', () => {
    const service = new MetadataStorageService();
    expect(service).toBeInstanceOf(MetadataStorageService);
  });
});
