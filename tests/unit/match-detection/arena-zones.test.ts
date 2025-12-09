import { describe, it, expect } from 'vitest';
import {
  ARENA_ZONE_IDS,
  ARENA_ZONE_NAMES,
  isArenaZone,
  getArenaName,
} from '../../../src/match-detection/constants/ArenaZones';

describe('ArenaZones', () => {
  describe('isArenaZone', () => {
    it('returns true for known arena zones', () => {
      const knownArenas = [
        { id: 1672, name: "Blade's Edge Arena" },
        { id: 617, name: 'Dalaran Sewers' },
        { id: 1505, name: 'Nagrand Arena' },
        { id: 572, name: 'Ruins of Lordaeron' },
        { id: 2167, name: 'Robodrome' },
        { id: 1134, name: "Tiger's Peak" },
        { id: 980, name: "Tol'viron Arena" },
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

  describe('getArenaName', () => {
    it('returns correct name for known arena IDs', () => {
      expect(getArenaName(1672)).toBe("Blade's Edge Arena");
      expect(getArenaName(617)).toBe('Dalaran Sewers');
      expect(getArenaName(1505)).toBe('Nagrand Arena');
      expect(getArenaName(1552)).toBe("Ashamane's Fall");
      expect(getArenaName(1825)).toBe('Hook Point');
      expect(getArenaName(2759)).toBe('Cage of Carnage');
    });

    it('returns fallback name for unknown zone IDs', () => {
      expect(getArenaName(2222)).toBe('Unknown Arena (2222)');
      expect(getArenaName(9999)).toBe('Unknown Arena (9999)');
      expect(getArenaName(0)).toBe('Unknown Arena (0)');
    });
  });

  describe('ARENA_ZONE_IDS', () => {
    it('contains all known arena IDs', () => {
      const expectedArenaIds = [
        1672, 617, 1505, 572, 2167, 1134, 980, 1504, 2373, 1552, 1911, 1825, 2509, 2547, 2563, 2759,
      ];

      expect(ARENA_ZONE_IDS.size).toBe(expectedArenaIds.length);

      for (const id of expectedArenaIds) {
        expect(ARENA_ZONE_IDS.has(id)).toBe(true);
      }
    });
  });

  describe('ARENA_ZONE_NAMES', () => {
    it('has a name entry for every arena zone ID', () => {
      for (const zoneId of ARENA_ZONE_IDS) {
        expect(ARENA_ZONE_NAMES[zoneId]).toBeDefined();
        expect(typeof ARENA_ZONE_NAMES[zoneId]).toBe('string');
        expect(ARENA_ZONE_NAMES[zoneId].length).toBeGreaterThan(0);
      }
    });
  });
});
