/**
 * Asset mapping constants for the frontend
 * Based on SSoT data from combat log parsing
 */

// Map ID to image filename mappings for Arena maps
const MAP_ID_TO_IMAGE = {
  // Classic Arena Maps
  1505: 'nagrand',        // Nagrand Arena
  572: 'ruins',          // Ruins of Lordaeron
  1672: 'blades',          // Blade's Edge Arena
  617: 'dalaran',         // Dalaran Sewers
  980: 'tolviron',        // Tol'viron Arena
  1134: 'tigerspeak',     // Tiger's Peak
  1504: 'blackrookhold',  // Black Rook Hold Arena
  2509: 'maldraxxus',     // The Maldraxxus Coliseum
  1911: 'mugambala',      // Mugambala
  2563: 'nokhudon',       // Nokhudon Proving Grounds
  2373: 'empyrean',       // Empyrean Domain
  2547: 'enigma',        // Enigma Crucible
  1825: "hook",          // Hook Point
  1552: 'ashamane',      // Ashamane's Fall
  2167: 'robodrome',     // The Robodrome
  2759: 'cage',          // Cage of Carnage
};

// Spec ID to icon filename mappings for WoW specializations
const SPEC_ID_TO_ICON = {
  // Death Knight
  250: 'deathknight_blood',
  251: 'deathknight_frost', 
  252: 'deathknight_unholy',
  
  // Demon Hunter
  577: 'demonhunter_havoc',
  581: 'demonhunter_vengeance',
  
  // Druid
  102: 'druid_balance',
  103: 'druid_feral',
  104: 'druid_guardian',
  105: 'druid_restoration',
  
  // Evoker
  1467: 'evoker_devastation',
  1468: 'evoker_preservation',
  1473: 'evoker_augmentation',
  
  // Hunter
  253: 'hunter_beastmastery',
  254: 'hunter_marksmanship',
  255: 'hunter_survival',
  
  // Mage
  62: 'mage_arcane',
  63: 'mage_fire',
  64: 'mage_frost',
  
  // Monk
  268: 'monk_brewmaster',
  270: 'monk_mistweaver',
  269: 'monk_windwalker',
  
  // Paladin
  65: 'paladin_holy',
  66: 'paladin_protection',
  70: 'paladin_retribution',
  
  // Priest
  256: 'priest_discipline',
  257: 'priest_holy',
  258: 'priest_shadow',
  
  // Rogue
  259: 'rogue_assassination',
  260: 'rogue_outlaw',
  261: 'rogue_subtlety',
  
  // Shaman
  262: 'shaman_elemental',
  263: 'shaman_enhancement',
  264: 'shaman_restoration',
  
  // Warlock
  265: 'warlock_affliction',
  266: 'warlock_demonology',
  267: 'warlock_destruction',
  
  // Warrior
  71: 'warrior_arms',
  72: 'warrior_fury',
  73: 'warrior_protection'
};

/**
 * Get map image filename for a given map ID
 * Returns null if mapId is not found (no fallback)
 */
function getMapImageFilename(mapId) {
  return MAP_ID_TO_IMAGE[mapId] || null;
}

/**
 * Get spec icon filename for a given spec ID
 * Returns null if specId is not found (no fallback)
 */
function getSpecIconFilename(specId) {
  return SPEC_ID_TO_ICON[specId] || null;
}

// Export for use in other files
window.AssetMappings = {
  getMapImageFilename,
  getSpecIconFilename
};