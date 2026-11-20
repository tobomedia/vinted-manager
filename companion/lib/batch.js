// Pure helpers: turn saved items into the extension's bulk-upload format
// (items.csv + one photo folder per item). No browser APIs; unit-tested.

// Same columns as extension/upload-logic.js, plus `notes` (hints for AI drafting later).
export const COLUMNS = ['folder', 'title', 'description', 'price', 'category', 'brand', 'size', 'condition', 'colour', 'parcel', 'notes'];
export const CONDITIONS = ['New with tags', 'New without tags', 'Very good', 'Good', 'Satisfactory'];
export const PARCELS = [['S', 'Small'], ['M', 'Medium'], ['L', 'Large']];
export const MAX_PHOTOS = 20; // Vinted's limit

export function slug(s) {
  return String(s ?? '')
    .replace(/ß/g, 'ss').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 40).replace(/-+$/, '');
}

export const displayName = (it) => it.title?.trim() || [it.brand, it.size].filter(Boolean).join(' ').trim() || 'Untitled item';

export function parsePrice(v) {
  const n = Number(String(v ?? '').replace(/[£\s]/g, '').replace(',', '.'));
  return String(v ?? '').trim() && Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

// Friendly hints shown as "!" in the list. Only photos are actually required.
export function warnings(it) {
  const w = [];
  if (!it.photos?.length) w.push('No photos');
  const p = parsePrice(it.price);
  if (p == null) w.push('No price');
  else if (p < 1) w.push('Price under £1');
  return w;
}

const cell = (v) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCSV(rows) {
  const lines = [COLUMNS, ...rows.map((r) => COLUMNS.map((c) => r[c]))].map((r) => r.map(cell).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n'; // BOM so Excel reads £ and accents correctly
}

// items: saved items (oldest first). Items without photos are skipped.
// Returns { csv, files: [{ path, photo }], skipped: [item] }
export function buildBatch(items) {
  const ok = items.filter((it) => it.photos?.length);
  const used = new Set();
  const rows = [], files = [];
  ok.forEach((it, i) => {
    let folder = `${String(i + 1).padStart(3, '0')}-${slug(displayName(it)) || 'item'}`;
    while (used.has(folder)) folder += '-x';
    used.add(folder);
    const price = parsePrice(it.price);
    rows.push({
      folder,
      title: it.title?.trim() || '',
      description: it.description?.trim() || '',
      price: price == null ? '' : price.toFixed(2),
      category: it.category?.trim() || '',
      brand: it.brand?.trim() || '',
      size: it.size?.trim() || '',
      condition: it.condition || '',
      colour: it.colour?.trim() || '',
      parcel: it.parcel || '',
      notes: it.notes?.trim() || '',
    });
    it.photos.slice(0, MAX_PHOTOS).forEach((photo, n) => files.push({ path: `${folder}/${n + 1}.jpg`, photo }));
  });
  return { csv: toCSV(rows), files, skipped: items.filter((it) => !it.photos?.length), count: ok.length };
}

export function batchFilename(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `vinted-batch-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}.zip`;
}
