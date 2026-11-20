// Pure helpers for bulk upload — CSV parsing, validation, name→ID matching.

export const COLUMNS = ['folder', 'title', 'description', 'price', 'category', 'brand', 'size', 'condition', 'colour', 'parcel'];
export const REQUIRED = ['folder', 'title', 'price', 'category', 'condition'];

export const TEMPLATE_CSV =
  COLUMNS.join(',') + '\n' +
  'levi-jeans,Levi\'s 501 straight jeans W32 L32,"Classic blue wash, barely worn.\nNo marks or tears.",18,Men > Clothing > Jeans,Levi\'s,W32 | L32,Very good,Blue,M\n';

// Fallbacks if Vinted's lookup endpoints don't return lists.
export const DEFAULT_CONDITIONS = [
  { id: 6, title: 'New with tags' }, { id: 1, title: 'New without tags' },
  { id: 2, title: 'Very good' }, { id: 3, title: 'Good' }, { id: 4, title: 'Satisfactory' },
];
export const DEFAULT_PARCELS = [{ id: 1, code: 'S', title: 'Small' }, { id: 2, code: 'M', title: 'Medium' }, { id: 3, code: 'L', title: 'Large' }];

// RFC-4180-ish CSV: quotes, escaped quotes, newlines in quotes, BOM, ; or , delimiter.
export function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delim = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.some((f) => f.trim() !== ''));
  if (!nonEmpty.length) return [];
  const headers = nonEmpty[0].map((h) => norm(h).replace(/^color$/, 'colour'));
  return nonEmpty.slice(1).map((r, idx) => {
    const o = { _row: idx + 2 };
    headers.forEach((h, j) => { o[h] = (r[j] ?? '').trim(); });
    return o;
  });
}

export const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’`]/g, "'").replace(/\s+/g, ' ').trim();
const loose = (s) => norm(s).replace(/[^a-z0-9]/g, '');
const asId = (v) => (/^\d+$/.test(String(v).trim()) ? Number(v) : null);

export function parsePrice(v) {
  const n = Number(String(v).replace(/[£\s]/g, '').replace(',', '.'));
  return Number.isFinite(n) && n >= 1 ? Math.round(n * 100) / 100 : null;
}

// Flatten Vinted's nested catalog tree into leaf paths.
export function flattenCatalogs(tree, prefix = []) {
  const out = [];
  for (const c of tree || []) {
    const path = [...prefix, c.title];
    const kids = c.catalogs || c.children || [];
    if (kids.length) out.push(...flattenCatalogs(kids, path));
    else out.push({ id: c.id, path: path.join(' > '), parts: path });
  }
  return out;
}

export function matchCategory(input, leaves) {
  const id = asId(input);
  if (id) return { id, label: `#${id}` };
  const parts = String(input).split(/\s*[>/|]\s*/).map(norm).filter(Boolean);
  if (!parts.length) return { error: 'Category is empty' };
  const leaf = parts[parts.length - 1];
  // candidates whose leaf name matches and whose path contains every typed part in order
  const fits = leaves.filter((l) => {
    const lp = l.parts.map(norm);
    if (lp[lp.length - 1] !== leaf) return false;
    let k = 0;
    for (const p of lp) if (p === parts[k]) k++;
    return k === parts.length;
  });
  if (fits.length === 1) return { id: fits[0].id, label: fits[0].path };
  if (fits.length > 1) return { error: `Ambiguous — add more of the path. Options: ${fits.slice(0, 4).map((f) => f.path).join(' · ')}` };
  const near = leaves.filter((l) => norm(l.parts[l.parts.length - 1]).includes(leaf)).slice(0, 4);
  return { error: `No category "${input}".${near.length ? ' Did you mean: ' + near.map((f) => f.path).join(' · ') : ''}` };
}

// Generic exact-ish title matcher for conditions, sizes, colours, brands.
export function matchByTitle(input, list, what) {
  const id = asId(input);
  if (id) return { id, label: `#${id}` };
  if (!String(input).trim()) return { error: `${what} is empty` };
  const exact = list.find((x) => norm(x.title) === norm(input)) || list.find((x) => loose(x.title) === loose(input));
  if (exact) return { id: exact.id, label: exact.title };
  const opts = list.slice(0, 8).map((x) => x.title).join(', ');
  return { error: `No ${what.toLowerCase()} "${input}".${opts ? ' Options: ' + opts : ''}` };
}

export function matchParcel(input, list = DEFAULT_PARCELS) {
  const v = norm(input || 'm');
  const code = { s: 'S', small: 'S', m: 'M', medium: 'M', l: 'L', large: 'L' }[v];
  const hit = list.find((p) => (p.code || '').toUpperCase() === code || norm(p.title) === v);
  return hit ? { id: hit.id, label: hit.title } : asId(input) ? { id: Number(input), label: `#${input}` } : { error: `Parcel "${input}" — use S, M or L` };
}

// files: [{ path: 'root/levi-jeans/1.jpg', ... }] — returns sorted photos in that folder
export function photosFor(folder, files) {
  const f = norm(folder).replace(/^\/+|\/+$/g, '');
  return files
    .filter((x) => /\.(jpe?g|png|webp)$/i.test(x.path))
    .filter((x) => { const parts = x.path.split('/'); return parts.length >= 2 && norm(parts[parts.length - 2]) === f; })
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

export function basicErrors(row, photos) {
  const e = [];
  for (const k of REQUIRED) if (!row[k]) e.push(`Missing ${k}`);
  if (row.price && parsePrice(row.price) == null) e.push(`Price "${row.price}" isn't valid (min £1)`);
  if (row.title && row.title.length < 5) e.push('Title too short (5+ chars)');
  if (row.folder && !photos.length) e.push(`No photos found in folder "${row.folder}"`);
  if (photos.length > 20) e.push(`${photos.length} photos — Vinted allows 20`);
  return e;
}
