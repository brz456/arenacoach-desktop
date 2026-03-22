/**
 * WoW Flavor SSoT (Single Source of Truth)
 *
 * This module defines the active WoW flavor (retail vs beta), resolved lazily
 * on first access and cached for the process lifetime.
 * All subsystems that vary by flavor must import `activeFlavor` from here.
 */

export type WowFlavorId = 'retail' | 'beta';

export interface WowFlavor {
  id: WowFlavorId;
  dirName: '_retail_' | '_beta_';
  windowsExecutable: 'Wow.exe' | 'WowB.exe';
  flavorInfoValue: 'wow' | 'wow_beta';
  processNameRegex: RegExp;
  obsWindowNameRegex: RegExp;
}

export const FLAVORS: Record<WowFlavorId, WowFlavor> = {
  retail: {
    id: 'retail',
    dirName: '_retail_',
    windowsExecutable: 'Wow.exe',
    flavorInfoValue: 'wow',
    processNameRegex: /wow\.exe/i,
    obsWindowNameRegex: /wow\.exe/i,
  },
  beta: {
    id: 'beta',
    dirName: '_beta_',
    windowsExecutable: 'WowB.exe',
    flavorInfoValue: 'wow_beta',
    processNameRegex: /wowb\.exe/i,
    obsWindowNameRegex: /wowb\.exe/i,
  },
};

/**
 * Active flavor for this build.
 * Defaults to Retail. Can be overridden via env:
 *   WOW_FLAVOR=beta
 *
 * Lazy: reads process.env.WOW_FLAVOR on first property access,
 * so dotenv.config() (or any other env setup) runs before resolution.
 */
function parseWowFlavorId(value: string | undefined): WowFlavorId {
  if (value == null) return 'retail';
  if (value === 'retail' || value === 'beta') return value;
  throw new Error(`[wowFlavor] Invalid WOW_FLAVOR='${value}'. Expected 'retail' or 'beta'.`);
}

let _resolved: WowFlavor | undefined;

function resolve(): WowFlavor {
  if (!_resolved) {
    _resolved = FLAVORS[parseWowFlavorId(process.env.WOW_FLAVOR)];
  }
  return _resolved;
}

export const activeFlavor: WowFlavor = {
  get id() { return resolve().id; },
  get dirName() { return resolve().dirName; },
  get windowsExecutable() { return resolve().windowsExecutable; },
  get flavorInfoValue() { return resolve().flavorInfoValue; },
  get processNameRegex() { return resolve().processNameRegex; },
  get obsWindowNameRegex() { return resolve().obsWindowNameRegex; },
};
