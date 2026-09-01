// db.js — local storage schema using Dexie (thin wrapper over IndexedDB)
// Everything here lives on-device. Nothing is sent anywhere except the
// food-search API calls themselves (USDA / Open Food Facts).

import Dexie from './vendor/dexie.mjs';

export const db = new Dexie('heartNutritionPWA');

db.version(1).stores({
  // Cached per-100g nutrient data for foods we've looked up, so repeat
  // searches don't burn API rate limits.
  foodCache: 'id, source, name, cachedAt',

  // One row per logged food entry.
  log: '++id, date, foodId, timestamp',

  // Simple key/value store for settings and target overrides.
  settings: 'key'
});

/**
 * Save a normalized food record to the cache.
 * @param {{id: string, source: 'usda'|'off'|'manual', name: string, nutrientsPer100g: object}} food
 */
export async function cacheFood(food) {
  await db.foodCache.put({ ...food, cachedAt: Date.now() });
}

export async function getCachedFood(id) {
  return db.foodCache.get(id);
}

export async function searchCachedFoodsByName(query, limit = 10) {
  const normalized = String(query || '').trim().toLowerCase();
  if (!normalized) return [];

  const rows = await db.foodCache.toArray();
  return rows
    .filter((row) => {
      const haystack = [row.name, row.brand, row.detail]
        .map((v) => String(v || '').toLowerCase())
        .join(' ');
      return haystack.includes(normalized);
    })
    .sort((a, b) => (b.cachedAt || 0) - (a.cachedAt || 0))
    .slice(0, limit);
}

export async function getLastLogEntryForFood(foodId) {
  if (!foodId) return null;
  const rows = await db.log.where('foodId').equals(foodId).toArray();
  rows.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return rows.length ? rows[0] : null;
}

/**
 * Add a logged entry for a given date.
 * @param {{date: string, foodId: string, foodName: string, source: string, grams: number, nutrients: object}} entry
 *   `nutrients` here should already be scaled to `grams`, not per-100g.
 */
export async function addLogEntry(entry) {
  return db.log.add({ ...entry, timestamp: Date.now() });
}

export async function removeLogEntry(id) {
  return db.log.delete(id);
}

export async function getLogForDate(date) {
  return db.log.where('date').equals(date).toArray();
}

export async function getSetting(key, fallback) {
  const row = await db.settings.get(key);
  return row ? row.value : fallback;
}

export async function setSetting(key, value) {
  return db.settings.put({ key, value });
}

/** Sum nutrients across a day's log entries. */
export function sumNutrients(entries) {
  const totals = {};
  for (const e of entries) {
    for (const [k, v] of Object.entries(e.nutrients || {})) {
      totals[k] = (totals[k] || 0) + (Number(v) || 0);
    }
  }
  return totals;
}
