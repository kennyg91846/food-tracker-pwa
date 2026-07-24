# Heart & Table — Phase 1 MVP

A no-backend PWA that logs foods, tracks macros, and shows how today's
intake compares to AHA/DASH-based heart-health targets. Data lives entirely
in your browser (IndexedDB via Dexie) — nothing is sent anywhere except the
food searches themselves, to USDA and Open Food Facts.

## Running it locally

Service workers and ES modules both require a real server — opening
`index.html` directly (`file://`) won't work. From this folder:

```bash
python3 -m http.server 8080
# or: npx serve .
```

Then visit `http://localhost:8080`.

## Get a free USDA API key (do this first)

The app works with `DEMO_KEY` out of the box, but that's capped at
**30 requests/hour** — you'll hit the limit almost immediately. Get a free
key (instant, no cost) at:

https://fdc.nal.usda.gov/api-key-signup

Then open the ⚙ Settings dialog in the app and paste it in. That raises
your limit to 1,000 requests/hour.

## Icons

`manifest.json` expects `icons/icon-192.png` and `icons/icon-512.png`.
Drop in any square PNGs at those sizes (or ask me to generate placeholder
ones) — the app runs fine without them, but Chrome/Android want them for
the "Add to Home Screen" install prompt to look right.

## What's deliberately NOT in Phase 1

- **Barcode scanning** — `api.js` already has `lookupBarcode()` wired up
  against Open Food Facts. Phase 2 just needs a camera UI (`html5-qrcode`
  or `ZXing-js`) calling that function — no new backend needed.
- **Micronutrients beyond potassium** — the USDA nutrient ID map in
  `api.js` (`USDA_NUTRIENT_IDS`) is easy to extend; add IDs for vitamins/
  minerals you want to track (e.g. 1087 calcium, 1089 iron, 1114 vitamin D).
- **Photo-based food recognition** — this needs a paid vision API or a
  hosted model; it's a separate, costed project, not a natural extension
  of this one. Worth revisiting once Phases 1–3 are solid.

## A note on the targets

`targets.json` holds the AHA/DASH reference values, each with its source
noted. Sodium defaults to the **2,300mg general upper limit**, not AHA's
1,500mg "ideal" figure — that stricter number is meant for people with
hypertension specifically, and using it as the default for everyone would
make a healthy diet look constantly over-limit. Adjust it in Settings if
your doctor has recommended the stricter target for you.

None of this is medical advice — it's a distillation of public guidance,
and the app says so on-screen.
