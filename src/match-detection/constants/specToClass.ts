/**
 * Mapping from WoW specialization IDs to class IDs.
 */

// Class IDs
export enum WowClass {
  Warrior = 1,
  Paladin = 2,
  Hunter = 3,
  Rogue = 4,
  Priest = 5,
  DeathKnight = 6,
  Shaman = 7,
  Mage = 8,
  Warlock = 9,
  Monk = 10,
  Druid = 11,
  DemonHunter = 12,
  Evoker = 13,
}

/**
 * Maps specialization ID to class ID.
 */
export const SPEC_TO_CLASS: Record<number, number> = {
  // Death Knight
  250: WowClass.DeathKnight, // Blood
  251: WowClass.DeathKnight, // Frost
  252: WowClass.DeathKnight, // Unholy

  // Demon Hunter
  577: WowClass.DemonHunter, // Havoc
  581: WowClass.DemonHunter, // Vengeance

  // Druid
  102: WowClass.Druid, // Balance
  103: WowClass.Druid, // Feral
  104: WowClass.Druid, // Guardian
  105: WowClass.Druid, // Restoration

  // Evoker
  1467: WowClass.Evoker, // Devastation
  1468: WowClass.Evoker, // Preservation
  1473: WowClass.Evoker, // Augmentation

  // Hunter
  253: WowClass.Hunter, // Beast Mastery
  254: WowClass.Hunter, // Marksmanship
  255: WowClass.Hunter, // Survival

  // Mage
  62: WowClass.Mage, // Arcane
  63: WowClass.Mage, // Fire
  64: WowClass.Mage, // Frost

  // Monk
  268: WowClass.Monk, // Brewmaster
  270: WowClass.Monk, // Mistweaver
  269: WowClass.Monk, // Windwalker

  // Paladin
  65: WowClass.Paladin, // Holy
  66: WowClass.Paladin, // Protection
  70: WowClass.Paladin, // Retribution

  // Priest
  256: WowClass.Priest, // Discipline
  257: WowClass.Priest, // Holy
  258: WowClass.Priest, // Shadow

  // Rogue
  259: WowClass.Rogue, // Assassination
  260: WowClass.Rogue, // Outlaw
  261: WowClass.Rogue, // Subtlety

  // Shaman
  262: WowClass.Shaman, // Elemental
  263: WowClass.Shaman, // Enhancement
  264: WowClass.Shaman, // Restoration

  // Warlock
  265: WowClass.Warlock, // Affliction
  266: WowClass.Warlock, // Demonology
  267: WowClass.Warlock, // Destruction

  // Warrior
  71: WowClass.Warrior, // Arms
  72: WowClass.Warrior, // Fury
  73: WowClass.Warrior, // Protection
};

/**
 * Get class ID from specialization ID.
 * @param specId The specialization ID from COMBATANT_INFO
 * @returns Class ID, or 0 if unknown specialization
 */
export function getClassIdFromSpec(specId: number): number {
  return SPEC_TO_CLASS[specId] || 0;
}
