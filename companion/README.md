# Vinted Companion (phone web app)

Photograph items on your phone, jot down what you know, then export everything as a zip for the extension's **Bulk upload** tab.

**Open it:** https://tobomedia.github.io/vinted-manager/companion/ and add it to your home screen (iPhone: Share → Add to Home Screen). Installing it keeps your saved items safe; Safari can clear data for sites you haven't installed.

## How it works
1. **New item** → take photos or choose them from your library. Tap a photo to reorder or remove it (the first one is the cover).
2. Add whatever you know: price, condition, brand, size, notes. Everything except photos is optional. Items save automatically.
3. **Export** → **Create zip** → **Share zip…** (AirDrop, Files, Drive) or save it to the phone.
4. On your computer, open the extension's **Bulk upload** tab and click **Choose zip…** (or drag the zip onto the panel). Blank titles, descriptions, categories and so on can be filled by **✨ Draft all with Claude** in the extension, or typed into the preview table. Only the price has to come from you.

Photos are saved as JPGs, max 1600px, so iPhone HEIC photos work. Everything stays on the phone: nothing is uploaded anywhere until you share the zip.

## Export format
```
vinted-batch-2026-11-20_1430.zip
├── items.csv        folder,title,description,price,category,brand,size,condition,colour,parcel,notes
├── 001-zara-coat/   1.jpg 2.jpg …
└── 002-nike-hoodie/ …
```
Same columns as the extension's CSV template, plus `notes` (kept for AI-drafted listings later).

## Development
Plain HTML/JS, no build step. `npm test` runs the unit tests (zip + CSV, including a round-trip through the extension's CSV parser). After changing app files, bump `CACHE` in `sw.js`.
