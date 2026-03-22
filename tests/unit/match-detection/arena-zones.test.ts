import { describe, it, expect } from 'vitest';
import {
  ARENA_MAPS,
  ARENA_MAP_BY_ID,
  ARENA_ZONE_NAMES,
  getArenaZoneName,
  getArenaMapInfo,
} from '@wow/game-data';

/**
 * Tests for arena zone SSoT from @wow/game-data.
 * Validates arena zone names, ID lookups, and unknown-ID behavior.
 */
describe('ArenaZones (SSoT from @wow/game-data)', () => {
  // Helper: check if ID is a known arena
  const isArenaZone = (id: number): boolean => ARENA_MAP_BY_ID[id] !== undefined;

  describe('isArenaZone', () => {
    it('returns true for known arena zones', () => {
      const knownArenas = [
        { id: 1672, name: "Blade's Edge Arena" },
        { id: 617, name: 'Dalaran Sewers' },
        { id: 1505, name: 'Nagrand Arena' },
        { id: 572, name: 'Ruins of Lordaeron' },
        { id: 2167, name: 'The Robodrome' },
        { id: 1134, name: "Tiger's Peak" },
        { id: 980, name: "Tol'Viron Arena" },
        { id: 1504, name: 'Black Rook Hold Arena' },
        { id: 2373, name: 'Empyrean Domain' },
        { id: 1552, name: "Ashamane's Fall" },
        { id: 1911, name: 'Mugambala' },
        { id: 1825, name: 'Hook Point' },
        { id: 2509, name: 'Maldraxxus Coliseum' },
        { id: 2547, name: 'Enigma Crucible' },
        { id: 2563, name: 'Nokhudon Proving Grounds' },
        { id: 2759, name: 'Cage of Carnage' },
      ];

      for (const arena of knownArenas) {
        expect(isArenaZone(arena.id)).toBe(true);
      }
    });

    it('returns false for non-arena zones', () => {
      const nonArenaZones = [
        { id: 2222, name: 'Revendreth' },
        { id: 1, name: 'Durotar' },
        { id: 0, name: 'Invalid' },
        { id: 9999, name: 'Unknown Zone' },
      ];

      for (const zone of nonArenaZones) {
        expect(isArenaZone(zone.id)).toBe(false);
      }
    });
  });

  describe('getArenaZoneName', () => {
    it('returns correct zone name for known arena IDs', () => {
      expect(getArenaZoneName(1672)).toBe("Blade's Edge Arena");
      expect(getArenaZoneName(617)).toBe('Dalaran Sewers');
      expect(getArenaZoneName(1505)).toBe('Nagrand Arena');
      expect(getArenaZoneName(1552)).toBe("Ashamane's Fall");
      expect(getArenaZoneName(1825)).toBe('Hook Point');
      expect(getArenaZoneName(2759)).toBe('Cage of Carnage');
    });

    it('returns null for unknown zone IDs', () => {
      expect(getArenaZoneName(2222)).toBe(null);
      expect(getArenaZoneName(9999)).toBe(null);
      expect(getArenaZoneName(0)).toBe(null);
    });
  });

  describe('getArenaMapInfo', () => {
    it('returns full info for known arena IDs', () => {
      const info = getArenaMapInfo(1505);
      expect(info).not.toBe(null);
      expect(info?.id).toBe(1505);
      expect(info?.name).toBe('Nagrand Arena');
      expect(info?.zoneName).toBe('Nagrand Arena');
      expect(info?.imageKey).toBe('nagrand');
      expect(info?.bounds).toBeDefined();
    });

    it('returns null for unknown zone IDs', () => {
      expect(getArenaMapInfo(9999)).toBe(null);
    });
  });

  describe('ARENA_MAPS', () => {
    it('contains all 16 known arena maps', () => {
      const expectedArenaIds = [
        1672, 617, 1505, 572, 2167, 1134, 980, 1504, 2373, 1552, 1911, 1825, 2509, 2547, 2563, 2759,
      ];

      expect(ARENA_MAPS.length).toBe(expectedArenaIds.length);

      const actualIds = ARENA_MAPS.map(m => m.id);
      for (const id of expectedArenaIds) {
        expect(actualIds).toContain(id);
      }
    });
  });

  describe('ARENA_ZONE_NAMES', () => {
    it('has a zone name entry for every arena map', () => {
      for (const map of ARENA_MAPS) {
        expect(ARENA_ZONE_NAMES[map.id]).toBeDefined();
        expect(typeof ARENA_ZONE_NAMES[map.id]).toBe('string');
        expect(ARENA_ZONE_NAMES[map.id].length).toBeGreaterThan(0);
      }
    });
  });
});
