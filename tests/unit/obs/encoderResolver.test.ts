import { describe, expect, it } from 'vitest';
import { resolveEncoderSelection } from '../../../src/services/obs/encoderResolver';

describe('resolveEncoderSelection', () => {
  it('selects NVENC in auto mode when available', () => {
    const result = resolveEncoderSelection({
      mode: 'auto',
      availableEncoderIds: ['obs_x264', 'jim_nvenc'],
    });

    expect(result).toEqual({
      kind: 'resolved',
      encoderId: 'jim_nvenc',
      mode: 'auto',
      reason: 'auto_best_available',
      requestedEncoder: 'x264',
    });
  });

  it('supports OBS NVENC H.264 tex id in auto mode', () => {
    const result = resolveEncoderSelection({
      mode: 'auto',
      availableEncoderIds: ['obs_x264', 'obs_nvenc_h264_tex'],
    });

    expect(result).toEqual({
      kind: 'resolved',
      encoderId: 'obs_nvenc_h264_tex',
      mode: 'auto',
      reason: 'auto_best_available',
      requestedEncoder: 'x264',
    });
  });

  it('prefers jim_nvenc when both NVENC IDs are available', () => {
    const result = resolveEncoderSelection({
      mode: 'auto',
      availableEncoderIds: ['jim_nvenc', 'obs_nvenc_h264_tex', 'obs_x264'],
    });

    expect(result).toEqual({
      kind: 'resolved',
      encoderId: 'jim_nvenc',
      mode: 'auto',
      reason: 'auto_best_available',
      requestedEncoder: 'x264',
    });
  });

  it('prefers NVENC over AMD when both are available in auto mode', () => {
    const result = resolveEncoderSelection({
      mode: 'auto',
      availableEncoderIds: ['h264_texture_amf', 'jim_nvenc', 'obs_x264'],
    });

    expect(result).toEqual({
      kind: 'resolved',
      encoderId: 'jim_nvenc',
      mode: 'auto',
      reason: 'auto_best_available',
      requestedEncoder: 'x264',
    });
  });

  it('falls back to AMD in auto mode when NVENC is unavailable', () => {
    const result = resolveEncoderSelection({
      mode: 'auto',
      availableEncoderIds: ['h264_texture_amf', 'obs_x264'],
    });

    expect(result).toEqual({
      kind: 'resolved',
      encoderId: 'h264_texture_amf',
      mode: 'auto',
      reason: 'auto_best_available',
      requestedEncoder: 'x264',
    });
  });

  it('falls back to x264 in auto mode when only x264 is available', () => {
    const result = resolveEncoderSelection({
      mode: 'auto',
      availableEncoderIds: ['obs_x264'],
    });

    expect(result).toEqual({
      kind: 'resolved',
      encoderId: 'obs_x264',
      mode: 'auto',
      reason: 'auto_best_available',
      requestedEncoder: 'x264',
    });
  });

  it('excludes AV1 and HEVC encoders from auto-selection', () => {
    const result = resolveEncoderSelection({
      mode: 'auto',
      availableEncoderIds: ['obs_nvenc_av1', 'obs_nvenc_hevc', 'obs_amf_hevc'],
    });

    expect(result).toEqual({
      kind: 'no-op',
      mode: 'auto',
      reason: 'no_supported_h264',
      requestedEncoder: 'x264',
    });
  });

  it('uses manual encoder when available', () => {
    const result = resolveEncoderSelection({
      mode: 'manual',
      preferredEncoder: 'amd',
      availableEncoderIds: ['h264_texture_amf', 'obs_x264'],
    });

    expect(result).toEqual({
      kind: 'resolved',
      encoderId: 'h264_texture_amf',
      mode: 'manual',
      reason: 'manual_requested_available',
      requestedEncoder: 'amd',
    });
  });

  it('uses manual x264 when explicitly requested and available', () => {
    const result = resolveEncoderSelection({
      mode: 'manual',
      preferredEncoder: 'x264',
      availableEncoderIds: ['obs_x264', 'jim_nvenc'],
    });

    expect(result).toEqual({
      kind: 'resolved',
      encoderId: 'obs_x264',
      mode: 'manual',
      reason: 'manual_requested_available',
      requestedEncoder: 'x264',
    });
  });

  it('falls back deterministically in manual mode when requested encoder is unavailable', () => {
    const result = resolveEncoderSelection({
      mode: 'manual',
      preferredEncoder: 'amd',
      availableEncoderIds: ['obs_x264', 'jim_nvenc'],
    });

    expect(result).toEqual({
      kind: 'resolved',
      encoderId: 'jim_nvenc',
      mode: 'manual',
      reason: 'manual_requested_unavailable_fallback',
      requestedEncoder: 'amd',
    });
  });

  it('returns no-op when probe succeeded but no supported H.264 encoder exists', () => {
    const result = resolveEncoderSelection({
      mode: 'manual',
      preferredEncoder: 'nvenc',
      availableEncoderIds: ['obs_av1', 'obs_hevc'],
    });

    expect(result).toEqual({
      kind: 'no-op',
      mode: 'manual',
      reason: 'no_supported_h264',
      requestedEncoder: 'nvenc',
    });
  });

  it('returns no-op when probe failed', () => {
    const result = resolveEncoderSelection({
      mode: 'auto',
      availableEncoderIds: undefined,
    });

    expect(result).toEqual({
      kind: 'no-op',
      mode: 'auto',
      reason: 'probe_failed',
      requestedEncoder: 'x264',
    });
  });

  it('returns no-op when probe returns empty list', () => {
    const result = resolveEncoderSelection({
      mode: 'manual',
      preferredEncoder: 'nvenc',
      availableEncoderIds: [],
    });

    expect(result).toEqual({
      kind: 'no-op',
      mode: 'manual',
      reason: 'probe_empty',
      requestedEncoder: 'nvenc',
    });
  });

  it('normalizes whitespace and de-duplicates encoder IDs', () => {
    const result = resolveEncoderSelection({
      mode: 'auto',
      availableEncoderIds: [' jim_nvenc ', 'jim_nvenc', 'obs_x264', 'obs_x264'],
    });

    expect(result).toEqual({
      kind: 'resolved',
      encoderId: 'jim_nvenc',
      mode: 'auto',
      reason: 'auto_best_available',
      requestedEncoder: 'x264',
    });
  });

  it('matches encoder families case-insensitively', () => {
    const result = resolveEncoderSelection({
      mode: 'auto',
      availableEncoderIds: [' JIM_NVENC ', 'OBS_X264'],
    });

    expect(result).toEqual({
      kind: 'resolved',
      encoderId: 'JIM_NVENC',
      mode: 'auto',
      reason: 'auto_best_available',
      requestedEncoder: 'x264',
    });
  });
});
