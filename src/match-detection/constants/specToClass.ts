/**
 * Mapping from WoW specialization IDs to class IDs.
 * Sources data from @wow/game-data (SSoT).
 */

import { SPEC_BY_ID } from '@wow/game-data';

/**
 * Get class ID from specialization ID.
 * @param specId The specialization ID from COMBATANT_INFO
 * @returns Class ID, or 0 if unknown specialization
 */
export function getClassIdFromSpec(specId: number): number {
  return SPEC_BY_ID[specId]?.classId ?? 0;
}
