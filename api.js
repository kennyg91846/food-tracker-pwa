// api.js — talks to USDA FoodData Central and Open Food Facts.
// Both return data normalized to:
//   { id, source, name, nutrientsPer100g: { calories, protein, carbs, fat,
//     saturatedFat, fiber, sodium, addedSugar, potassium } }
// Units: calories in kcal, everything else in grams except sodium/potassium in mg.

import { getSetting } from './db.js';

const USDA_BASE = 'https://api.nal.usda.gov/fdc/v1';
const OFF_BASE = 'https://world.openfoodfacts.org';
const OFF_USER_AGENT_APP = 'HeartNutritionPWA - Personal use';
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const searchCache = new Map();

const KNOWN_OFF_OVERRIDES = {
  // Wegmans Organic White Sourdough (UPC 077890559031) package label values.
  '077890559031': {
    name: 'Organic White Sourdough',
    servingText: '1 inch slice',
    servingQuantity: 1,
    servingUnit: 'slice',
    servingGrams: (20 * 28.349523125) / 10, // 20 oz loaf, 10 servings
    perServing: {
      calories: 130,
      fat: 0,
      saturatedFat: 0,
      carbs: 27,
      fiber: 2,
      sugars: 1,
      addedSugar: 0,
      protein: 5,
      sodium: 290,
      potassium: 63
    }
  },
  // Same UPC as above, but some sources drop the leading zero.
  '77890559031': {
    name: 'Organic White Sourdough',
    servingText: '1 inch slice',
    servingQuantity: 1,
    servingUnit: 'slice',
    servingGrams: (20 * 28.349523125) / 10,
    perServing: {
      calories: 130,
      fat: 0,
      saturatedFat: 0,
      carbs: 27,
      fiber: 2,
      sugars: 1,
      addedSugar: 0,
      protein: 5,
      sodium: 290,
      potassium: 63
    }
  }
};

// USDA nutrient IDs we care about (see FDC docs for the full list).
const USDA_NUTRIENT_IDS = {
  1008: 'calories',      // Energy (kcal)
  1003: 'protein',
  1005: 'carbs',         // Carbohydrate, by difference
  1004: 'fat',
  1258: 'saturatedFat',  // Fatty acids, total saturated
  1079: 'fiber',
  1093: 'sodium',        // mg
  1235: 'addedSugar',    // Sugars, added
  1092: 'potassium'      // mg
};

async function getUsdaApiKey() {
  const key = await getSetting('usdaApiKey', '');
  return key || 'DEMO_KEY'; // DEMO_KEY works but is heavily rate-limited (30 req/hr)
}

function normalizeUsdaFood(food) {
  const nutrientsPer100g = {};
  for (const n of food.foodNutrients || []) {
    const id = n.nutrientId || n.nutrient?.id;
    const key = USDA_NUTRIENT_IDS[id];
    if (key) nutrientsPer100g[key] = n.value ?? n.amount ?? 0;
  }

  const brand = food.brandOwner || food.brandName || '';
  const detailParts = [];
  if (food.dataType) detailParts.push(food.dataType);
  if (food.foodCategory) detailParts.push(food.foodCategory);
  if (food.servingSize && food.servingSizeUnit) {
    detailParts.push(`${food.servingSize}${food.servingSizeUnit} serving`);
  }

  const servingSize = Number(food.servingSize || 0);
  const servingSizeUnit = String(food.servingSizeUnit || '').toLowerCase().trim();
  const gramUnits = new Set(['g', 'grm', 'gram', 'grams', 'gm']);
  const servingGrams = (servingSize > 0 && gramUnits.has(servingSizeUnit)) ? servingSize : 0;

  return {
    id: `usda:${food.fdcId}`,
    source: 'usda',
    name: food.description,
    brand,
    detail: detailParts.join(' • '),
    householdServingText: food.householdServingFullText || '',
    servingQuantity: 1,
    servingUnit: 'serving',
    servingGrams,
    nutrientsPer100g
  };
}

export async function searchUsda(query, pageSize = 10) {
  const apiKey = await getUsdaApiKey();
  const url = `${USDA_BASE}/foods/search?api_key=${encodeURIComponent(apiKey)}` +
              `&query=${encodeURIComponent(query)}&pageSize=${pageSize}`;
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 429) throw new Error('USDA rate limit hit — add your own free API key in Settings.');
    throw new Error(`USDA search failed (${res.status})`);
  }
  const data = await res.json();
  return (data.foods || []).map(normalizeUsdaFood);
}

function normalizeOffProduct(product) {
  const servingInfo = parseOffServingInfo(product);
  const n = product.nutriments || {};
  const brand = (product.brands || '').split(',')[0].trim();
  const detailParts = [];
  if (product.quantity) detailParts.push(product.quantity);
  if (product.categories) detailParts.push(product.categories.split(',')[0].trim());
  if (product.code) detailParts.push(`code ${String(product.code).slice(-4)}`);

  const normalized = {
    id: `off:${product.code}`,
    source: 'off',
    name: product.product_name || product.generic_name || 'Unknown product',
    brand,
    detail: detailParts.join(' • '),
    householdServingText: servingInfo.householdServingText,
    servingQuantity: servingInfo.servingQuantity,
    servingUnit: servingInfo.servingUnit,
    servingGrams: servingInfo.servingGrams,
    nutrientsPer100g: {
      calories: n['energy-kcal_100g'] ?? 0,
      protein: n['proteins_100g'] ?? 0,
      carbs: n['carbohydrates_100g'] ?? 0,
      fat: n['fat_100g'] ?? 0,
      saturatedFat: n['saturated-fat_100g'] ?? 0,
      fiber: n['fiber_100g'] ?? 0,
      sodium: (n['sodium_100g'] ?? 0) * 1000, // OFF gives sodium in g, we use mg
      addedSugar: n['sugars_100g'] ?? 0, // OFF rarely distinguishes added vs total sugar
      potassium: (n['potassium_100g'] ?? 0) * 1000
    }
  };

  return applyKnownOffOverride(normalized, product);
}

function perServingToPer100(value, servingGrams) {
  const numeric = Number(value) || 0;
  const grams = Number(servingGrams) || 0;
  if (grams <= 0) return 0;
  return (numeric * 100) / grams;
}

function normalizeCode(code) {
  return String(code || '').replace(/\D/g, '');
}

function findKnownOverride(code) {
  const raw = normalizeCode(code);
  if (!raw) return null;

  const variants = [
    raw,
    raw.replace(/^0+/, ''),
    raw.length > 12 ? raw.slice(-12) : raw,
    raw.length > 11 ? raw.slice(-11) : raw,
    raw.padStart(12, '0'),
    raw.padStart(13, '0')
  ];

  for (const variant of variants) {
    if (KNOWN_OFF_OVERRIDES[variant]) return KNOWN_OFF_OVERRIDES[variant];
  }
  return null;
}

function applyKnownOffOverride(normalizedFood, rawProduct) {
  const code = normalizeCode(rawProduct?.code || normalizedFood?.id?.split(':')[1] || '');
  const override = findKnownOverride(code);
  if (!override) return normalizedFood;

  const g = override.servingGrams;
  return {
    ...normalizedFood,
    name: override.name || normalizedFood.name,
    householdServingText: override.servingText,
    servingQuantity: override.servingQuantity,
    servingUnit: override.servingUnit,
    servingGrams: g,
    nutrientsPer100g: {
      calories: perServingToPer100(override.perServing.calories, g),
      protein: perServingToPer100(override.perServing.protein, g),
      carbs: perServingToPer100(override.perServing.carbs, g),
      fat: perServingToPer100(override.perServing.fat, g),
      saturatedFat: perServingToPer100(override.perServing.saturatedFat, g),
      fiber: perServingToPer100(override.perServing.fiber, g),
      sodium: perServingToPer100(override.perServing.sodium, g),
      addedSugar: perServingToPer100(override.perServing.addedSugar, g),
      potassium: perServingToPer100(override.perServing.potassium, g)
    }
  };
}

function parseOffServingInfo(product) {
  const servingSizeText = String(product?.serving_size || '').trim();
  const quantity = Number(product?.serving_quantity || 0);
  const unitRaw = String(product?.serving_quantity_unit || '').trim();
  const unit = unitRaw.toLowerCase();

  let servingGrams = 0;
  const gramsInServingSize = servingSizeText.match(/(\d+(?:\.\d+)?)\s*g\b/i);
  if (gramsInServingSize) {
    servingGrams = Number(gramsInServingSize[1]);
  } else if (quantity > 0 && ['g', 'gram', 'grams', 'gm'].includes(unit)) {
    servingGrams = quantity;
  }

  return {
    householdServingText: servingSizeText,
    servingQuantity: quantity > 0 ? quantity : 1,
    servingUnit: unit || 'serving',
    servingGrams
  };
}

export async function searchOpenFoodFacts(query, pageSize = 10) {
  const url = `${OFF_BASE}/cgi/search.pl?search_terms=${encodeURIComponent(query)}` +
              `&search_simple=1&action=process&json=1&page_size=${pageSize}`;
  const res = await fetch(url, { headers: { 'User-Agent': OFF_USER_AGENT_APP } });
  if (!res.ok) throw new Error(`Open Food Facts search failed (${res.status})`);
  const data = await res.json();
  return (data.products || []).map(normalizeOffProduct);
}

function normalizeQuery(query) {
  return String(query || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildQueryVariants(query) {
  const normalized = normalizeQuery(query);
  if (!normalized) return [];

  const tokens = normalized.split(' ').filter(Boolean);
  const variants = [normalized];

  if (tokens.length > 1) {
    variants.push(tokens[0]);
    variants.push(tokens.slice(0, -1).join(' '));
  }

  return [...new Set(variants.filter((v) => v.length >= 2))].slice(0, 3);
}

function dedupeFoods(foods) {
  const seen = new Set();
  const deduped = [];
  for (const food of foods) {
    if (seen.has(food.id)) continue;
    seen.add(food.id);
    deduped.push(food);
  }
  return deduped;
}

function relevanceScore(food, normalizedQuery) {
  const name = String(food.name || '').toLowerCase();
  const tokens = normalizedQuery.split(' ').filter(Boolean);
  let score = 0;

  if (name.includes(normalizedQuery)) score += 12;
  for (const token of tokens) {
    if (name.includes(token)) score += 4;
  }
  if (name.startsWith(tokens[0] || '')) score += 2;
  if (food.source === 'usda') score += 0.2;

  return score;
}

async function runSearchRound(query) {
  const results = await Promise.allSettled([searchUsda(query), searchOpenFoodFacts(query)]);
  const foods = [];
  for (const r of results) {
    if (r.status === 'fulfilled') foods.push(...r.value);
  }
  return foods;
}

/** Phase 2: barcode lookup via Open Food Facts. Wire this up once
 *  html5-qrcode (or similar) is added to the UI for camera scanning. */
export async function lookupBarcode(barcode) {
  const url = `${OFF_BASE}/api/v0/product/${encodeURIComponent(barcode)}.json`;
  const res = await fetch(url, { headers: { 'User-Agent': OFF_USER_AGENT_APP } });
  if (!res.ok) throw new Error(`Barcode lookup failed (${res.status})`);
  const data = await res.json();
  if (data.status !== 1) return null; // not found — fall back to manual entry
  return normalizeOffProduct(data.product);
}

/** Search both sources and merge results, with metadata for fallback handling. */
export async function searchFoodsDetailed(query) {
  const normalized = normalizeQuery(query);
  if (!normalized) {
    return { foods: [], usedQuery: normalized, fromFallback: false };
  }

  const cached = searchCache.get(normalized);
  if (cached && (Date.now() - cached.ts) < SEARCH_CACHE_TTL_MS) {
    return cached;
  }

  const variants = buildQueryVariants(normalized);
  let foods = [];
  let usedQuery = variants[0] || normalized;

  for (const variant of variants) {
    const roundFoods = await runSearchRound(variant);
    const hadAnyBefore = foods.length > 0;
    foods = dedupeFoods([...foods, ...roundFoods]);
    if (!hadAnyBefore && roundFoods.length > 0) {
      usedQuery = variant;
    }

    // Keep calls low: if primary query already found results, do not fan out.
    if (variant === variants[0] && foods.length > 0) break;
    // Stop early once we have enough candidate results.
    if (foods.length >= 12) {
      usedQuery = variant;
      break;
    }
    if (roundFoods.length > 0) {
      usedQuery = variant;
    }
  }

  const sorted = foods
    .slice()
    .sort((a, b) => relevanceScore(b, normalized) - relevanceScore(a, normalized));

  const payload = {
    foods: sorted,
    usedQuery,
    fromFallback: usedQuery !== normalized
  };

  searchCache.set(normalized, { ts: Date.now(), ...payload });
  return payload;
}

/** Compatibility wrapper used by earlier call sites. */
export async function searchFoods(query) {
  const detailed = await searchFoodsDetailed(query);
  return detailed.foods;
}

/** Scale a per-100g nutrient object to an arbitrary gram amount. */
export function scaleNutrients(per100g, grams) {
  const factor = grams / 100;
  const scaled = {};
  for (const [k, v] of Object.entries(per100g)) {
    scaled[k] = Math.round((Number(v) || 0) * factor * 10) / 10;
  }
  return scaled;
}
