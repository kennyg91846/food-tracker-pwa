import { db, cacheFood, getCachedFood, addLogEntry, removeLogEntry, getLogForDate, sumNutrients, getSetting, setSetting, searchCachedFoodsByName, getLastLogEntryForFood } from './db.js';
import { searchFoodsDetailed, scaleNutrients, lookupBarcode } from './api.js?v=2';

const todayStr = () => new Date().toISOString().slice(0, 10);

let currentDate = todayStr();
let targets = null;
let lastSearchResults = [];
let pendingFood = null;
let userSettings = null;
let weeklyRepeatsExpanded = false;
let activeScanner = null;
let scannerRunning = false;
let scannerDecoding = false;

const OZ_TO_GRAMS = 28.349523125;
const LB_TO_KG = 0.45359237;
const IN_TO_CM = 2.54;
const UNIT_TO_GRAMS = {
  g: 1,
  kg: 1000,
  oz: OZ_TO_GRAMS,
  lb: 453.59237,
  cup: 240,
  tbsp: 15,
  tsp: 5,
  ml: 1,
  l: 1000,
  floz: 29.5735
};

const UNIT_LABEL = {
  g: 'g',
  kg: 'kg',
  oz: 'oz',
  lb: 'lb',
  cup: 'cup',
  tbsp: 'tbsp',
  tsp: 'tsp',
  ml: 'ml',
  l: 'L',
  floz: 'fl oz',
  serving: 'serving',
  slice: 'slice'
};

const ACTIVITY_FACTORS = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  'very-active': 1.9
};

const SOURCE_LABEL_FULL_SHOW_LIMIT = 15;
const SOURCE_LABEL_SEEN_KEY = 'sourceLabelSeenCounts';

const el = (id) => document.getElementById(id);

function loadSourceLabelSeenCounts() {
  try {
    const raw = localStorage.getItem(SOURCE_LABEL_SEEN_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    return {};
  }
}

const sourceLabelSeenCounts = loadSourceLabelSeenCounts();

function incrementSourceLabelSeen(source) {
  sourceLabelSeenCounts[source] = (Number(sourceLabelSeenCounts[source]) || 0) + 1;
  try {
    localStorage.setItem(SOURCE_LABEL_SEEN_KEY, JSON.stringify(sourceLabelSeenCounts));
  } catch {
    // Ignore storage failures; labels still render correctly.
  }
}

function suggestSimplerSearch(query) {
  const tokens = String(query || '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length <= 1) return '';
  return tokens[0];
}

function formatDateLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getLast7DayRange(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const end = new Date(d);
  const start = new Date(d);
  start.setDate(d.getDate() - 6);
  return {
    start: formatDateLocal(start),
    end: formatDateLocal(end)
  };
}

function dedupeFoodsById(foods) {
  const seen = new Set();
  const deduped = [];
  for (const food of foods) {
    if (!food?.id || seen.has(food.id)) continue;
    seen.add(food.id);
    deduped.push(food);
  }
  return deduped;
}

function foodDescriptor(food) {
  const parts = [];
  if (food?.brand) parts.push(food.brand);
  if (food?.detail) parts.push(food.detail);
  return parts.join(' • ');
}

function formatSourceLabel(source) {
  const normalized = String(source || '').toLowerCase();

  if (normalized === 'off') {
    const seen = Number(sourceLabelSeenCounts.off) || 0;
    const label = seen < SOURCE_LABEL_FULL_SHOW_LIMIT ? 'Open Food Facts' : 'OFF';
    incrementSourceLabelSeen('off');
    return label;
  }

  const map = {
    usda: 'USDA',
    local: 'Local history',
    manual: 'Manual'
  };
  return map[normalized] || source || 'Unknown';
}

function normalizeBarcodeInput(raw) {
  return String(raw || '').replace(/\D/g, '');
}

function isPlausibleBarcode(code) {
  return code.length >= 8 && code.length <= 14;
}

function describeScannerError(err) {
  const raw = String(err?.message || err || '').trim();
  const combined = `${String(err?.name || '')} ${raw}`.toLowerCase();

  if (combined.includes('notallowederror') || combined.includes('permission')) {
    return 'Camera permission was blocked. Allow camera access in your browser settings and try again.';
  }
  if (combined.includes('notfounderror') || combined.includes('no camera')) {
    return 'No camera was found on this device.';
  }
  if (combined.includes('notreadableerror') || combined.includes('in use')) {
    return 'Camera is busy in another app/tab. Close it there and try again.';
  }
  if (combined.includes('secure') || combined.includes('https')) {
    return 'Camera scanning requires HTTPS on phones. Open the app over HTTPS, or use manual UPC lookup.';
  }
  return raw || 'Unable to start camera scanner.';
}

function setScannerButtonState() {
  const btn = el('scan-toggle-btn');
  if (!btn) return;
  btn.textContent = scannerRunning ? 'Stop camera scan' : 'Start camera scan';
}

async function stopBarcodeScanner() {
  const scannerRegion = el('scanner-region');
  if (scannerRegion) scannerRegion.hidden = true;

  if (!activeScanner || !scannerRunning) {
    scannerRunning = false;
    scannerDecoding = false;
    setScannerButtonState();
    return;
  }

  try {
    await activeScanner.stop();
  } catch {
    // Ignore stop errors if camera stream is already gone.
  }

  try {
    activeScanner.clear();
  } catch {
    // Clear can fail if internals were already torn down.
  }

  scannerRunning = false;
  scannerDecoding = false;
  setScannerButtonState();
}

async function startBarcodeScanner() {
  const status = el('barcode-status');
  const scannerRegion = el('scanner-region');
  const isSecureForCamera = window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1';

  if (!isSecureForCamera) {
    status.textContent = 'Camera scanning requires HTTPS on phones. Open the app over HTTPS, or use manual UPC lookup.';
    return;
  }

  if (!window.Html5Qrcode) {
    status.textContent = 'Scanner library did not load. Refresh and try again.';
    return;
  }

  if (scannerRunning) return;
  scannerRegion.hidden = false;
  status.textContent = 'Starting camera...';

  if (!activeScanner) {
    activeScanner = new window.Html5Qrcode('scanner-reader');
  }

  const formats = window.Html5QrcodeSupportedFormats || {};
  const config = {
    fps: 10,
    qrbox: { width: 260, height: 120 },
    rememberLastUsedCamera: true,
    formatsToSupport: [
      formats.UPC_A,
      formats.UPC_E,
      formats.EAN_8,
      formats.EAN_13
    ].filter(Boolean)
  };

  const onScanSuccess = async (decodedText) => {
    if (scannerDecoding) return;

    const code = normalizeBarcodeInput(decodedText);
    if (!isPlausibleBarcode(code)) {
      status.textContent = `Scanned "${decodedText}" but it is not a valid UPC/EAN.`;
      return;
    }

    scannerDecoding = true;
    status.textContent = `Scanned ${code}. Looking up...`;
    el('barcode-input').value = code;
    await stopBarcodeScanner();
    await handleBarcodeLookup(code);
    scannerDecoding = false;
  };

  try {
    await activeScanner.start(
      { facingMode: { exact: 'environment' } },
      config,
      onScanSuccess,
      () => {}
    );
    scannerRunning = true;
    setScannerButtonState();
    status.textContent = 'Point the camera at a barcode.';
  } catch {
    try {
      await activeScanner.start(
        { facingMode: 'environment' },
        config,
        onScanSuccess,
        () => {}
      );
      scannerRunning = true;
      setScannerButtonState();
      status.textContent = 'Point the camera at a barcode.';
    } catch (err) {
      scannerRunning = false;
      scannerDecoding = false;
      scannerRegion.hidden = true;
      setScannerButtonState();
      status.textContent = describeScannerError(err);
    }
  }
}

async function handleBarcodeLookup(rawCode) {
  const status = el('barcode-status');
  const code = normalizeBarcodeInput(rawCode);

  if (!isPlausibleBarcode(code)) {
    status.textContent = 'Enter a valid UPC/EAN (8-14 digits).';
    return;
  }

  status.textContent = 'Looking up barcode...';
  try {
    const food = await lookupBarcode(code);
    if (!food) {
      status.textContent = `No product found for code ${code}.`;
      return;
    }

    await cacheFood(food);
    lastSearchResults = dedupeFoodsById([food, ...lastSearchResults]);

    const descriptor = foodDescriptor(food);
    status.textContent = descriptor
      ? `Found: ${food.name} (${descriptor}). Set serving and add to today's log.`
      : `Found: ${food.name}. Set serving and add to today's log.`;

    openServingDialogForFood(food, inferDefaultServing(food, { amount: 100, unit: 'g' }));
  } catch (err) {
    status.textContent = err?.message || 'Barcode lookup failed. Please try again.';
  }
}

async function addFoodWithServing(food, servingAmount, servingUnit) {
  const grams = convertServingToGrams(food, servingAmount, servingUnit);
  await cacheFood(food);
  const nutrients = scaleNutrients(food.nutrientsPer100g, grams);
  await addLogEntry({
    date: currentDate,
    foodId: food.id,
    foodName: food.name,
    source: food.source,
    servingUnit,
    servingAmount,
    grams,
    nutrients
  });
  renderLog();
  renderTargets();
  renderWeeklyRepeats();
}

async function loadTargets() {
  const res = await fetch('targets.json');
  targets = await res.json();
}

async function loadUserSettings() {
  const legacyHeightCm = Number(await getSetting('profileHeightCm', 170)) || 170;
  const legacyWeightKg = Number(await getSetting('profileWeightKg', 70)) || 70;

  userSettings = {
    usdaApiKey: await getSetting('usdaApiKey', ''),
    sodiumTarget: Number(await getSetting('sodiumTarget', targets.sodium.target)) || targets.sodium.target,
    usePersonalizedTargets: await getSetting('usePersonalizedTargets', false),
    profileAge: Number(await getSetting('profileAge', 35)) || 35,
    profileSex: await getSetting('profileSex', 'female'),
    profileHeightIn: Number(await getSetting('profileHeightIn', Math.round(legacyHeightCm / IN_TO_CM))) || Math.round(legacyHeightCm / IN_TO_CM),
    profileWeightLb: Number(await getSetting('profileWeightLb', Math.round(legacyWeightKg / LB_TO_KG))) || Math.round(legacyWeightKg / LB_TO_KG),
    profileActivity: await getSetting('profileActivity', 'light'),
    calorieGoalOverride: Number(await getSetting('calorieGoalOverride', 0)) || 0
  };
}

function calculatePersonalizedCalories(profile) {
  const age = Number(profile.profileAge);
  const heightIn = Number(profile.profileHeightIn);
  const weightLb = Number(profile.profileWeightLb);
  const weightKg = weightLb * LB_TO_KG;
  const heightCm = heightIn * IN_TO_CM;
  const sex = profile.profileSex === 'male' ? 'male' : 'female';
  const activityFactor = ACTIVITY_FACTORS[profile.profileActivity] || ACTIVITY_FACTORS.light;

  if (!age || !weightKg || !heightCm) return null;

  const sexConstant = sex === 'male' ? 5 : -161;
  const bmr = (10 * weightKg) + (6.25 * heightCm) - (5 * age) + sexConstant;
  return Math.round(bmr * activityFactor);
}

function updateProfileFieldsState() {
  const enabled = !!el('use-personalized-targets').checked;
  const container = el('profile-fields');
  if (!container) return;
  container.classList.toggle('is-disabled', !enabled);
}

function formatServingDisplay(amount, unit, grams) {
  if (amount && unit && UNIT_LABEL[unit]) {
    const roundedAmount = Number(amount).toFixed(1);
    return `${roundedAmount} ${UNIT_LABEL[unit]}`;
  }
  return `${(Number(grams || 0) / OZ_TO_GRAMS).toFixed(1)}oz`;
}

function parseLeadingQuantity(text) {
  const s = String(text || '').trim();
  if (!s) return null;

  const frac = s.match(/^(\d+)\s*\/\s*(\d+)/);
  if (frac) {
    const numerator = Number(frac[1]);
    const denominator = Number(frac[2]);
    if (denominator) return numerator / denominator;
  }

  const wholeAndFrac = s.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)/);
  if (wholeAndFrac) {
    const whole = Number(wholeAndFrac[1]);
    const numerator = Number(wholeAndFrac[2]);
    const denominator = Number(wholeAndFrac[3]);
    if (denominator) return whole + (numerator / denominator);
  }

  const decimal = s.match(/^(\d+(?:\.\d+)?)/);
  if (decimal) return Number(decimal[1]);
  return null;
}

function inferServingGrams(food) {
  const direct = Number(food?.servingGrams || 0);
  if (direct > 0) return direct;

  const detail = String(food?.detail || '');
  const fromDetail = detail.match(/(\d+(?:\.\d+)?)\s*(?:g|grm|gram|grams|gm)\s+serving/i);
  if (fromDetail) return Number(fromDetail[1]);
  return 0;
}

function inferDefaultServing(food, fallback = { amount: 3.5, unit: 'oz' }) {
  const servingGrams = inferServingGrams(food);
  if (servingGrams <= 0) return fallback;

  const householdText = String(food?.householdServingText || '').toLowerCase();
  const servingUnit = String(food?.servingUnit || '').toLowerCase();
  const servingQuantity = Number(food?.servingQuantity || 0);
  const looksLikeSlice = /\bslices?\b|\binch\s+slice\b/.test(householdText) || /\bslices?\b|\binch\s+slice\b/.test(servingUnit);

  if (looksLikeSlice) {
    const qty = parseLeadingQuantity(householdText) || (servingQuantity > 0 ? servingQuantity : 1);
    return { amount: qty, unit: 'slice' };
  }

  return { amount: 1, unit: 'serving' };
}

function convertServingToGrams(food, amount, unit) {
  const numericAmount = Number(amount) || 0;
  if (numericAmount <= 0) return 0;

  const servingGrams = inferServingGrams(food);
  const householdText = String(food?.householdServingText || '').toLowerCase();
  const servingUnit = String(food?.servingUnit || '').toLowerCase();
  const servingQuantity = Number(food?.servingQuantity || 0);
  const unitPattern = {
    cup: /\bcups?\b/,
    tbsp: /\b(tablespoons?|tbsp)\b/,
    tsp: /\b(teaspoons?|tsp)\b/,
    floz: /\b(fl\.?\s?oz|fluid\s+ounces?)\b/,
    slice: /\bslices?\b|\binch\s+slice\b/
  };

  if (servingGrams > 0 && unit === 'serving') {
    return numericAmount * servingGrams;
  }

  if (servingGrams > 0 && unit === 'slice') {
    if (unitPattern.slice.test(householdText) || unitPattern.slice.test(servingUnit)) {
      const qty = parseLeadingQuantity(householdText) || (servingQuantity > 0 ? servingQuantity : 1);
      return numericAmount * (servingGrams / qty);
    }
  }

  // If USDA gives a serving gram weight, prefer that for household units.
  if (servingGrams > 0 && unitPattern[unit]) {
    if (unitPattern[unit].test(householdText)) {
      const qty = parseLeadingQuantity(householdText) || 1;
      return numericAmount * (servingGrams / qty);
    }
    if (unit === 'cup') {
      return numericAmount * servingGrams;
    }
  }

  const ratio = UNIT_TO_GRAMS[unit] || OZ_TO_GRAMS;
  return numericAmount * ratio;
}

function computeGramTargets() {
  // Some targets are expressed as % of calories; convert to grams here.
  const sodiumTarget = Number(userSettings?.sodiumTarget) || targets.sodium.target;
  let calTarget = targets.calories.target;
  let proteinTarget = targets.protein.target;
  let fiberTarget = targets.fiber.target;

  if (userSettings?.usePersonalizedTargets) {
    const personalizedCalories = calculatePersonalizedCalories(userSettings);
    if (personalizedCalories) {
      const override = Number(userSettings.calorieGoalOverride) || 0;
      calTarget = override > 0 ? override : personalizedCalories;
      const proteinPerKg = Number(userSettings.profileAge) >= 65 ? 1.0 : 0.8;
      const weightKg = (Number(userSettings.profileWeightLb) || 0) * LB_TO_KG;
      proteinTarget = Math.round(weightKg * proteinPerKg) || targets.protein.target;
      fiberTarget = Math.round((calTarget / 1000) * 14);
    }
  }

  return {
    calories: { target: calTarget, direction: 'max-soft', unit: 'calories' },
    sodium: { target: sodiumTarget, direction: 'max', unit: 'mg' },
    saturatedFat: {
      target: Math.round((targets.saturatedFat.percentOfCalories / 100 * calTarget) / 9),
      direction: 'max',
      unit: 'g'
    },
    addedSugar: { target: targets.addedSugar.target, direction: 'max', unit: 'g' },
    fiber: { target: fiberTarget, direction: 'min', unit: 'g' },
    potassium: { target: targets.potassium.target, direction: 'min', unit: 'mg' },
    protein: { target: proteinTarget, direction: 'min', unit: 'g' }
  };
}

function barColor(pct, direction) {
  if (direction === 'max' || direction === 'max-soft') {
    if (pct <= 75) return 'good';
    if (pct <= 100) return 'caution';
    return 'over';
  }
  // "min" direction: good once you've hit the target, caution while approaching it
  if (pct >= 100) return 'good';
  if (pct >= 60) return 'caution';
  return 'over'; // notably short of a "more is better" target
}

async function renderTargets() {
  const entries = await getLogForDate(currentDate);
  const totals = sumNutrients(entries);
  const gramTargets = computeGramTargets();
  const list = el('targets-list');
  list.innerHTML = '';

  const niceNames = {
    calories: 'Calories', sodium: 'Sodium', saturatedFat: 'Sat. fat',
    addedSugar: 'Added sugar', fiber: 'Fiber', potassium: 'Potassium', protein: 'Protein'
  };

  for (const [key, t] of Object.entries(gramTargets)) {
    const consumed = totals[key] || 0;
    const pct = t.target ? (consumed / t.target) * 100 : 0;
    const fillPct = Math.max(0, Math.min(pct, 100));
    const cls = barColor(pct, t.direction);
    const displayUnit = t.unit === 'mg' ? 'mg' : t.unit === 'calories' ? ' Calories' : 'g';
    const row = document.createElement('div');
    row.className = 'target-row';
    row.innerHTML = `
      <span class="label">${niceNames[key]}</span>
      <div class="target-bar">
        <div class="fill ${cls}" style="width:${fillPct}%"></div>
        <div class="tick" style="left:100%"></div>
      </div>
      <span class="value" title="${Math.round(consumed)}/${Math.round(t.target)}${displayUnit}">${Math.round(consumed)}/${Math.round(t.target)}${displayUnit}</span>
    `;
    list.appendChild(row);
  }
}

async function renderLog() {
  const entries = await getLogForDate(currentDate);
  const list = el('log-list');
  list.innerHTML = '';
  el('log-empty').style.display = entries.length ? 'none' : 'block';

  for (const entry of entries) {
    const li = document.createElement('li');
    const servingDisplay = formatServingDisplay(entry.servingAmount, entry.servingUnit, entry.grams);
    const sourceLabel = formatSourceLabel(entry.source);
    li.innerHTML = `
      <div>
        <span class="food-name">${entry.foodName}</span>
        <span class="food-source">${sourceLabel}</span><br>
        <span class="food-macros">${servingDisplay} · ${Math.round(entry.nutrients.calories || 0)} Calories</span>
      </div>
      <button class="remove-btn" data-id="${entry.id}">Remove</button>
    `;
    list.appendChild(li);
  }
  list.querySelectorAll('.remove-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await removeLogEntry(Number(btn.dataset.id));
      renderLog();
      renderTargets();
      renderWeeklyRepeats();
    });
  });
}

function openServingDialogForFood(food, defaults) {
  if (!food) return;
  pendingFood = food;
  el('serving-food-name').textContent = food.name;
  el('serving-unit').value = defaults?.unit || 'oz';
  el('serving-amount').value = defaults?.amount || 3.5;
  el('serving-dialog').showModal();
}

function setWeeklyRepeatsExpanded(expanded) {
  weeklyRepeatsExpanded = !!expanded;
  const toggle = el('weekly-repeats-toggle');
  const content = el('weekly-repeats-content');
  if (!toggle || !content) return;

  toggle.setAttribute('aria-expanded', String(weeklyRepeatsExpanded));
  content.hidden = !weeklyRepeatsExpanded;

  const icon = toggle.querySelector('.weekly-toggle-icon');
  if (icon) {
    icon.textContent = weeklyRepeatsExpanded ? '−' : '+';
  }
}

async function renderWeeklyRepeats() {
  const list = el('weekly-repeats-list');
  const empty = el('weekly-repeats-empty');
  if (!list || !empty) return;

  const { start, end } = getLast7DayRange(currentDate);
  const entries = await db.log.where('date').between(start, end, true, true).toArray();
  if (!entries.length) {
    list.innerHTML = '';
    empty.style.display = 'block';
    return;
  }

  const grouped = new Map();
  for (const entry of entries) {
    const existing = grouped.get(entry.foodId) || {
      foodId: entry.foodId,
      foodName: entry.foodName,
      count: 0,
      lastEntry: entry
    };
    existing.count += 1;
    if ((entry.timestamp || 0) > (existing.lastEntry?.timestamp || 0)) {
      existing.lastEntry = entry;
    }
    grouped.set(entry.foodId, existing);
  }

  const top = [...grouped.values()]
    .sort((a, b) => b.count - a.count || (b.lastEntry?.timestamp || 0) - (a.lastEntry?.timestamp || 0))
    .slice(0, 5);

  list.innerHTML = '';
  empty.style.display = top.length ? 'none' : 'block';

  for (const item of top) {
    const food = await getCachedFood(item.foodId);
    const lastAmount = Number(item.lastEntry?.servingAmount || 0) || 1;
    const lastUnit = item.lastEntry?.servingUnit || 'oz';
    const li = document.createElement('li');
    const descriptor = foodDescriptor(food);
    li.innerHTML = `
      <div>
        <span class="food-name">${item.foodName}</span><br>
        ${descriptor ? `<span class="food-detail">${descriptor}</span><br>` : ''}
        <span class="weekly-meta">${item.count}x in last 7 days · last ${formatServingDisplay(lastAmount, lastUnit, item.lastEntry?.grams)}</span>
      </div>
      <div class="weekly-actions">
        ${food ? `<button class="mini-btn weekly-add-last" data-id="${item.foodId}" data-amount="${lastAmount}" data-unit="${lastUnit}">Add last</button>` : ''}
        ${food ? `<button class="mini-btn weekly-edit" data-id="${item.foodId}" data-amount="${lastAmount}" data-unit="${lastUnit}">Edit</button>` : ''}
      </div>
    `;
    list.appendChild(li);

    if (food) {
      const addBtn = li.querySelector('.weekly-add-last');
      const editBtn = li.querySelector('.weekly-edit');
      addBtn?.addEventListener('click', async () => {
        await addFoodWithServing(food, lastAmount, lastUnit);
      });
      editBtn?.addEventListener('click', () => {
        openServingDialogForFood(food, { amount: lastAmount, unit: lastUnit });
      });
    }
  }
}

async function handleSearch(query) {
  const resultsEl = el('search-results');
  resultsEl.innerHTML = '<li>Searching…</li>';
  let searchMeta = { usedQuery: query, fromFallback: false };
  let localMatches = [];
  try {
    localMatches = await searchCachedFoodsByName(query, 8);
    const detailed = await searchFoodsDetailed(query);
    const remoteFoods = detailed.foods.filter((food) => !localMatches.some((local) => local.id === food.id));
    lastSearchResults = dedupeFoodsById([...localMatches, ...remoteFoods]);
    searchMeta = { usedQuery: detailed.usedQuery, fromFallback: detailed.fromFallback };
  } catch (err) {
    resultsEl.innerHTML = `<li>${err.message}</li>`;
    return;
  }
  if (!lastSearchResults.length) {
    const suggestion = suggestSimplerSearch(query);
    const suggestionText = suggestion
      ? ` Did you mean "${suggestion}"?`
      : ' Try a simpler search term, or check spelling.';
    resultsEl.innerHTML = `<li>No results.${suggestionText}</li>`;
    return;
  }
  resultsEl.innerHTML = '';

  if (localMatches.length) {
    const localHint = document.createElement('li');
    localHint.className = 'search-hint';
    localHint.textContent = 'Recent matches from your local history';
    resultsEl.appendChild(localHint);
  }

  if (searchMeta.fromFallback) {
    const hint = document.createElement('li');
    hint.className = 'search-hint';
    hint.textContent = `Showing fallback results for: ${searchMeta.usedQuery}`;
    resultsEl.appendChild(hint);
  }

  const localMap = new Map(localMatches.map((food) => [food.id, food]));
  for (const food of lastSearchResults.slice(0, 15)) {
    const isLocal = localMap.has(food.id);
    let lastEntry = null;
    if (isLocal) {
      // Resolve the latest serving used for one-tap repeat add.
      lastEntry = await getLastLogEntryForFood(food.id);
    }

    const li = document.createElement('li');
    const sourceTag = isLocal ? 'local' : food.source;
    const sourceLabel = formatSourceLabel(sourceTag);
    const lastServingText = lastEntry
      ? `last: ${formatServingDisplay(lastEntry.servingAmount, lastEntry.servingUnit, lastEntry.grams)}`
      : 'per 100g';
    const previewCalories = lastEntry
      ? Math.round(scaleNutrients(food.nutrientsPer100g, Number(lastEntry.grams) || 0).calories || 0)
      : Math.round(food.nutrientsPer100g.calories || 0);
    const descriptor = foodDescriptor(food);

    li.innerHTML = `
      <div>
        <span class="food-name">${food.name}</span>
        <span class="food-source">${sourceLabel}</span><br>
          ${descriptor ? `<span class="food-detail">${descriptor}</span><br>` : ''}
        <span class="food-macros">${lastServingText}: ${previewCalories} Calories</span>
      </div>
      <div class="result-actions">
        ${lastEntry ? `<button class="quick-add-btn" data-id="${food.id}" data-amount="${Number(lastEntry.servingAmount || 0)}" data-unit="${lastEntry.servingUnit || 'oz'}">Add last</button>` : ''}
        <button class="add-btn" data-id="${food.id}">Edit</button>
      </div>
    `;
    resultsEl.appendChild(li);

    const editBtn = li.querySelector('.add-btn');
    if (editBtn) {
      editBtn.addEventListener('click', () => openServingDialog(food.id));
    }

    const quickBtn = li.querySelector('.quick-add-btn');
    if (quickBtn) {
      quickBtn.addEventListener('click', async () => {
        const amount = Number(quickBtn.dataset.amount) || 1;
        const unit = quickBtn.dataset.unit || 'oz';
        await addFoodWithServing(food, amount, unit);
      });
    }
  }
}

function openServingDialog(foodId) {
  const food = lastSearchResults.find((f) => f.id === foodId);
  openServingDialogForFood(food, inferDefaultServing(food, { amount: 3.5, unit: 'oz' }));
}

async function confirmAddServing() {
  if (!pendingFood) return;
  const unit = el('serving-unit').value;
  const servingAmount = Number(el('serving-amount').value) || 3.5;
  await addFoodWithServing(pendingFood, servingAmount, unit);
  pendingFood = null;
}

async function init() {
  await loadTargets();
  await loadUserSettings();

  el('date-picker').value = currentDate;
  el('date-picker').addEventListener('change', (e) => {
    currentDate = e.target.value || todayStr();
    renderLog();
    renderTargets();
    renderWeeklyRepeats();
  });

  el('search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = el('search-input').value.trim();
    if (q) handleSearch(q);
  });

  el('barcode-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = el('barcode-input').value;
    handleBarcodeLookup(code);
  });

  el('barcode-input').addEventListener('input', () => {
    const status = el('barcode-status');
    if (status.textContent) status.textContent = '';
  });

  setScannerButtonState();
  el('scan-toggle-btn').addEventListener('click', async () => {
    if (scannerRunning) {
      await stopBarcodeScanner();
      const status = el('barcode-status');
      status.textContent = 'Camera scan stopped.';
      return;
    }
    await startBarcodeScanner();
  });

  const searchInput = el('search-input');
  searchInput.addEventListener('pointerdown', () => {
    searchInput.value = '';
    requestAnimationFrame(() => {
      searchInput.setSelectionRange(0, 0);
    });
  });

  setWeeklyRepeatsExpanded(false);
  el('weekly-repeats-toggle').addEventListener('click', () => {
    setWeeklyRepeatsExpanded(!weeklyRepeatsExpanded);
  });

  el('serving-cancel').addEventListener('click', () => el('serving-dialog').close());
  el('serving-form').addEventListener('submit', (e) => {
    e.preventDefault();
    confirmAddServing();
    el('serving-dialog').close();
  });

  el('settings-btn').addEventListener('click', async () => {
    const heightIn = Number(userSettings.profileHeightIn) || 67;
    const wholeFeet = Math.floor(heightIn / 12);
    const extraInches = heightIn % 12;
    el('usda-key').value = userSettings.usdaApiKey;
    el('sodium-target').value = userSettings.sodiumTarget;
    el('use-personalized-targets').checked = !!userSettings.usePersonalizedTargets;
    el('profile-age').value = userSettings.profileAge;
    el('profile-sex').value = userSettings.profileSex;
    el('profile-height-ft').value = wholeFeet;
    el('profile-height-in').value = extraInches;
    el('profile-weight-lb').value = userSettings.profileWeightLb;
    el('profile-activity').value = userSettings.profileActivity;
    el('calorie-goal-override').value = userSettings.calorieGoalOverride || '';
    updateProfileFieldsState();
    el('settings-dialog').showModal();
  });

  el('use-personalized-targets').addEventListener('change', updateProfileFieldsState);

  el('settings-cancel').addEventListener('click', () => el('settings-dialog').close());
  el('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const feet = Math.max(0, Number(el('profile-height-ft').value) || 0);
    const inches = Math.max(0, Number(el('profile-height-in').value) || 0);
    const totalHeightIn = (feet * 12) + inches;

    const nextSettings = {
      usdaApiKey: el('usda-key').value.trim(),
      sodiumTarget: Number(el('sodium-target').value) || targets.sodium.target,
      usePersonalizedTargets: !!el('use-personalized-targets').checked,
      profileAge: Number(el('profile-age').value) || 35,
      profileSex: el('profile-sex').value === 'male' ? 'male' : 'female',
      profileHeightIn: totalHeightIn || 67,
      profileWeightLb: Number(el('profile-weight-lb').value) || 154,
      profileActivity: el('profile-activity').value,
      calorieGoalOverride: Number(el('calorie-goal-override').value) || 0
    };

    await setSetting('usdaApiKey', nextSettings.usdaApiKey);
    await setSetting('sodiumTarget', nextSettings.sodiumTarget);
    await setSetting('usePersonalizedTargets', nextSettings.usePersonalizedTargets);
    await setSetting('profileAge', nextSettings.profileAge);
    await setSetting('profileSex', nextSettings.profileSex);
    await setSetting('profileHeightIn', nextSettings.profileHeightIn);
    await setSetting('profileWeightLb', nextSettings.profileWeightLb);
    await setSetting('profileActivity', nextSettings.profileActivity);
    await setSetting('calorieGoalOverride', nextSettings.calorieGoalOverride);

    userSettings = nextSettings;
    el('settings-dialog').close();
    renderTargets();
  });

  renderLog();
  renderTargets();
  renderWeeklyRepeats();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {
      /* offline shell just won't be available — not fatal */
    });
  }

  window.addEventListener('beforeunload', () => {
    if (scannerRunning) {
      stopBarcodeScanner();
    }
  });
}

init();
