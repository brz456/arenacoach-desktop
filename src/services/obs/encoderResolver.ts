import { EncoderMode, EncoderType } from '../RecordingTypes';

type EncoderResolutionReason =
  | 'auto_best_available'
  | 'manual_requested_available'
  | 'manual_requested_unavailable_fallback'
  | 'forced_cpu_fallback'
  | 'probe_failed'
  | 'probe_empty'
  | 'no_supported_h264';

type ResolvedEncoderReason = Extract<
  EncoderResolutionReason,
  | 'auto_best_available'
  | 'manual_requested_available'
  | 'manual_requested_unavailable_fallback'
  | 'forced_cpu_fallback'
>;
type NoOpEncoderReason = Extract<
  EncoderResolutionReason,
  'probe_failed' | 'probe_empty' | 'no_supported_h264'
>;

export type EncoderResolutionResult =
  | {
      kind: 'resolved';
      encoderId: string;
      mode: EncoderMode;
      reason: ResolvedEncoderReason;
      requestedEncoder: EncoderType;
    }
  | {
      kind: 'no-op';
      mode: EncoderMode;
      reason: NoOpEncoderReason;
      requestedEncoder: EncoderType;
    };

const ENCODER_FAMILY_PRIORITY: EncoderType[] = ['nvenc', 'amd', 'x264'];
const NVENC_EXACT_IDS = ['jim_nvenc', 'obs_nvenc_h264_tex'] as const;
const AMD_EXACT_IDS = ['h264_texture_amf'] as const;
const X264_EXACT_IDS = ['obs_x264'] as const;

function isUnsupportedCodec(id: string): boolean {
  const normalized = id.toLowerCase();
  return normalized.includes('av1') || normalized.includes('hevc') || normalized.includes('h265');
}

function normalizeUnique(ids: string[]): string[] {
  const seen = new Set<string>();
  const orderedUnique: string[] = [];

  for (const raw of ids) {
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    orderedUnique.push(trimmed);
  }

  return orderedUnique;
}

// Precondition: candidates are already trimmed + de-duplicated by normalizeUnique().
function chooseExactOrSortedMatch(
  normalizedCandidates: readonly string[],
  exactIds: readonly string[],
  predicate: (encoderId: string) => boolean
): string | undefined {
  for (const exact of exactIds) {
    if (normalizedCandidates.includes(exact)) {
      return exact;
    }
  }

  return normalizedCandidates.filter(predicate).sort()[0];
}

function findNvencEncoderId(availableIds: readonly string[]): string | undefined {
  return chooseExactOrSortedMatch(availableIds, NVENC_EXACT_IDS, encoderId => {
    const normalized = encoderId.toLowerCase();
    if (isUnsupportedCodec(normalized)) {
      return false;
    }
    return normalized.includes('nvenc');
  });
}

function findAmdEncoderId(availableIds: readonly string[]): string | undefined {
  return chooseExactOrSortedMatch(availableIds, AMD_EXACT_IDS, encoderId => {
    const normalized = encoderId.toLowerCase();
    if (isUnsupportedCodec(normalized)) {
      return false;
    }
    return normalized.includes('amf');
  });
}

function findX264EncoderId(availableIds: readonly string[]): string | undefined {
  return chooseExactOrSortedMatch(availableIds, X264_EXACT_IDS, encoderId => {
    const normalized = encoderId.toLowerCase();
    if (isUnsupportedCodec(normalized)) {
      return false;
    }
    return normalized.includes('x264');
  });
}

function getSupportedCandidates(
  availableIds: readonly string[]
): Record<EncoderType, string | undefined> {
  return {
    nvenc: findNvencEncoderId(availableIds),
    amd: findAmdEncoderId(availableIds),
    x264: findX264EncoderId(availableIds),
  };
}

function pickBestAvailable(supported: Record<EncoderType, string | undefined>): string | null {
  for (const encoderType of ENCODER_FAMILY_PRIORITY) {
    const encoderId = supported[encoderType];
    if (encoderId) {
      return encoderId;
    }
  }
  return null;
}

export function resolveEncoderSelection(input: {
  availableEncoderIds: string[] | undefined;
  mode: EncoderMode;
  preferredEncoder?: EncoderType;
  forceCpuFallback?: boolean;
}): EncoderResolutionResult {
  const requestedEncoder = input.preferredEncoder ?? 'x264';

  if (input.availableEncoderIds === undefined) {
    return {
      kind: 'no-op',
      mode: input.mode,
      reason: 'probe_failed',
      requestedEncoder,
    };
  }

  const availableEncoderIds = normalizeUnique(input.availableEncoderIds);
  if (availableEncoderIds.length === 0) {
    return {
      kind: 'no-op',
      mode: input.mode,
      reason: 'probe_empty',
      requestedEncoder,
    };
  }

  const supported = getSupportedCandidates(availableEncoderIds);

  if (input.forceCpuFallback) {
    const x264EncoderId = supported.x264;
    if (!x264EncoderId) {
      return {
        kind: 'no-op',
        mode: input.mode,
        reason: 'no_supported_h264',
        requestedEncoder,
      };
    }

    if (input.mode === 'manual' && requestedEncoder === 'x264') {
      return {
        kind: 'resolved',
        encoderId: x264EncoderId,
        mode: input.mode,
        reason: 'manual_requested_available',
        requestedEncoder,
      };
    }

    return {
      kind: 'resolved',
      encoderId: x264EncoderId,
      mode: input.mode,
      reason: 'forced_cpu_fallback',
      requestedEncoder,
    };
  }

  if (input.mode === 'manual') {
    const requestedEncoderId = supported[requestedEncoder];
    if (requestedEncoderId) {
      return {
        kind: 'resolved',
        encoderId: requestedEncoderId,
        mode: input.mode,
        reason: 'manual_requested_available',
        requestedEncoder,
      };
    }

    const fallback = pickBestAvailable(supported);
    if (!fallback) {
      return {
        kind: 'no-op',
        mode: input.mode,
        reason: 'no_supported_h264',
        requestedEncoder,
      };
    }

    return {
      kind: 'resolved',
      encoderId: fallback,
      mode: input.mode,
      reason: 'manual_requested_unavailable_fallback',
      requestedEncoder,
    };
  }

  const autoSelection = pickBestAvailable(supported);
  if (!autoSelection) {
    return {
      kind: 'no-op',
      mode: input.mode,
      reason: 'no_supported_h264',
      requestedEncoder,
    };
  }

  return {
    kind: 'resolved',
    encoderId: autoSelection,
    mode: input.mode,
    reason: 'auto_best_available',
    requestedEncoder,
  };
}

export function inferEncoderTypeFromId(encoderId: string | null | undefined): EncoderType | null {
  if (!encoderId) {
    return null;
  }

  const normalized = encoderId.toLowerCase();
  if (normalized.includes('nvenc')) {
    return 'nvenc';
  }
  if (normalized.includes('amf')) {
    return 'amd';
  }
  if (normalized.includes('x264')) {
    return 'x264';
  }
  return null;
}
