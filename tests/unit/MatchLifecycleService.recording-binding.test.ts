import { describe, expect, it, vi } from 'vitest';
import { MatchLifecycleService } from '../../src/services/MatchLifecycleService';
import { MatchEventType, type MatchStartedEvent } from '../../src/match-detection/types/MatchEvent';
import { BRACKET_STRINGS } from '../../src/match-detection/types/MatchMetadata';

describe('MatchLifecycleService recording service rebinding', () => {
  it('starts using a recording service attached after construction', async () => {
    const metadataService = {
      createInitialMetadata: vi.fn(async () => undefined),
    } as any;
    const recordingService = {
      handleMatchStarted: vi.fn(async () => undefined),
    } as any;

    const lifecycleService = new MatchLifecycleService(metadataService, null);

    const firstEvent: MatchStartedEvent = {
      type: MatchEventType.MATCH_STARTED,
      timestamp: new Date('2026-03-26T10:00:00.000Z'),
      zoneId: 572,
      bufferId: 'buffer-before-enable',
      bracket: BRACKET_STRINGS.TWO_V_TWO,
      season: 1,
      isRanked: true,
      players: [],
    };

    await lifecycleService.handleMatchStarted(firstEvent);

    expect(metadataService.createInitialMetadata).toHaveBeenCalledTimes(1);
    expect(recordingService.handleMatchStarted).not.toHaveBeenCalled();

    lifecycleService.setRecordingService(recordingService);

    const secondEvent: MatchStartedEvent = {
      ...firstEvent,
      bufferId: 'buffer-after-enable',
      timestamp: new Date('2026-03-26T10:05:00.000Z'),
    };

    await lifecycleService.handleMatchStarted(secondEvent);

    expect(metadataService.createInitialMetadata).toHaveBeenCalledTimes(2);
    expect(recordingService.handleMatchStarted).toHaveBeenCalledTimes(1);
    expect(recordingService.handleMatchStarted).toHaveBeenCalledWith(secondEvent);
  });
});
