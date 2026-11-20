import { api, MOCK } from './api.js';
import { randomDelayMs } from './logic.js';
import {
  TEMPLATE_CSV, DEFAULT_CONDITIONS, DEFAULT_PARCELS, parseCSV, parsePrice, flattenCatalogs,
  matchCategory, matchByTitle, matchParcel, photosFor, basicErrors,
} from './upload-logic.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let ctx;              // { log, modal, getSettings, onDone }
let files = [];       // [{ path, file }]
let rows = [];        // resolved rows
let busy = false, stop = false;
const cache = new Map();
const uploaded = new Set(); // "folder|title" uploaded this session — avoids duplicates on re-pick

async function cached(key, fn) {
  if (!cache.has(key)) cache.set(key, fn().catch((e) => { cache.delete(key); throw e; }));
  return cache.get(key);
}

// ---------- resolve CSV rows → Vinted IDs ----------
async function resolveRow(row, leaves, colourList) {
  const photos = photosFor(row.folder, files);
  const r = { row, photos, errors: basicErrors(row, photos), f: {} };
  if (!photos.length && files.some((x) => /\.heic$/i.test(x.path) && x.path.toLowerCase().includes(`/${String(row.folder).toLowerCase()}/`)))
    r.errors.push('Photos are HEIC (iPhone) — export as JPG, or set iPhone Camera → Formats → Most Compatible');
  const set = (key, res) => {
    r.f[key] = res;
    if (res?.error) r.errors.push(res.error);
  };
  set('price', { id: parsePrice(row.price), label: row.price ? `£${parsePrice(row.price)?.toFixed(2) ?? row.price}` : '' });
  if (r.f.price.id == null) delete r.f.price.id;

  if (row.category) set('category', leaves ? matchCategory(row.category, leaves) : { error: 'Category list unavailable' });
  const catId = r.f.category?.id;

  const lookup = async (key, fn, fallback) => {
    try { return (await cached(key, fn)) || fallback; } catch (e) { if (fallback) return fallback; throw e; }
  };
  try {
    if (row.condition) set('condition', matchByTitle(row.condition, catId ? await lookup(`cond:${catId}`, () => api.conditions(catId), DEFAULT_CONDITIONS) : DEFAULT_CONDITIONS, 'Condition'));
    set('parcel', matchParcel(row.parcel, catId ? await lookup(`pkg:${catId}`, () => api.packageSizes(catId), DEFAULT_PARCELS) : DEFAULT_PARCELS));
    if (row.size) {
      if (!catId) set('size', { error: 'Fix category first' });
      else {
        const list = await lookup(`size:${catId}`, () => api.sizes(catId), []);
        set('size', list.length ? matchByTitle(row.size, list, 'Size') : { error: 'This category has no sizes — leave size blank' });
      }
    }
    if (row.brand) {
      const list = await lookup(`brand:${row.brand.toLowerCase()}:${catId}`, () => api.brands(row.brand, catId), []);
      set('brand', matchByTitle(row.brand, list, 'Brand'));
      if (r.f.brand.id) r.f.brand.title = list.find((b) => b.id === r.f.brand.id)?.title ?? row.brand;
    }
    if (row.colour) {
      const parts = row.colour.split(/\s*[,/&+]\s*/).filter(Boolean).slice(0, 2);
      const ms = parts.map((c) => matchByTitle(c, colourList || [], 'Colour'));
      const bad = ms.find((m) => m.error);
      set('colour', bad || { ids: ms.map((m) => m.id), label: ms.map((m) => m.label).join(', ') });
    }
  } catch (e) {
    r.errors.push(`Lookup failed: ${e.message}`);
  }
  r.ready = r.errors.length === 0;
  r.key = `${row.folder}|${row.title}`;
  if (uploaded.has(r.key)) r.state = { ok: true, msg: 'Already uploaded' };
  return r;
}

async function resolveAll() {
  const csvFile = files.find((f) => /(^|\/)[^/]+\.csv$/i.test(f.path) && f.path.split('/').length <= 2)
    || files.find((f) => /\.csv$/i.test(f.path));
  if (!csvFile) { ctx.log('No .csv file found in that folder. Add items.csv (use Download CSV template).', 'err'); return; }
  const parsed = parseCSV(await csvFile.file.text());
  if (!parsed.length) { ctx.log(`${csvFile.path} has no rows`, 'err'); return; }
  ctx.log(`Read ${parsed.length} rows from ${csvFile.path}. Matching categories, brands and sizes…`);

  let leaves = null, colourList = null;
  try { leaves = flattenCatalogs(await cached('catalogs', () => api.catalogs())); }
  catch (e) { ctx.log(`Couldn't load Vinted categories: ${e.message}. You can type category IDs instead.`, 'err'); }
  try { colourList = await cached('colours', () => api.colours()); } catch { /* colours optional */ }

  rows = [];
  for (const row of parsed) rows.push(await resolveRow(row, leaves, colourList));
  render();
  const ready = rows.filter((r) => r.ready && !r.state).length;
  ctx.log(`${ready} ready, ${rows.length - ready} need attention`, ready === rows.length ? 'ok' : '');
}

// ---------- render ----------
const thumbs = new Map();
function thumb(file) {
  if (!thumbs.has(file)) thumbs.set(file, URL.createObjectURL(file));
  return thumbs.get(file);
}

function cell(res, raw) {
  if (!raw && !res) return '<td class="muted">–</td>';
  if (res?.error) return `<td class="bad">${esc(res.error)}</td>`;
  return `<td>${esc(res?.label ?? raw)}</td>`;
}

function render() {
  $('previewWrap').hidden = rows.length === 0;
  $('uploadSummary').hidden = rows.length === 0;
  $('previewRows').innerHTML = rows.map((r) => {
    const status = r.state
      ? `<span class="tag ${r.state.ok ? 'ok' : 'err'}">${esc(r.state.msg)}</span>`
      : r.ready ? '<span class="tag ok">Ready</span>'
      : `<span class="tag err" title="${esc(r.errors.join('\n'))}">${r.errors.length} issue${r.errors.length > 1 ? 's' : ''}</span>`;
    const generic = r.errors.filter((e) => !Object.values(r.f).some((f) => f?.error === e));
    return `<tr>
      <td>${r.row._row}</td>
      <td><div class="ph">${r.photos[0] ? `<img src="${thumb(r.photos[0].file)}" alt="">` : ''}<span class="${r.photos.length ? '' : 'bad'}">${r.photos.length}</span></div></td>
      <td class="title-cell">${esc(r.row.title)}${generic.length ? `<div class="bad">${generic.map(esc).join('<br>')}</div>` : ''}</td>
      <td class="num">${esc(r.f.price?.label || '–')}</td>
      ${cell(r.f.category, r.row.category)}${cell(r.f.brand, r.row.brand)}${cell(r.f.size, r.row.size)}
      ${cell(r.f.condition, r.row.condition)}${cell(r.f.colour, r.row.colour)}${cell(r.f.parcel, r.row.parcel)}
      <td>${status}</td></tr>`;
  }).join('');
  const todo = rows.filter((r) => r.ready && !r.state?.ok).length;
  $('uploadCounts').textContent = `${rows.length} rows · ${todo} ready to upload · ${rows.filter((r) => !r.ready).length} need fixing`;
  $('uploadBtn').disabled = busy || todo === 0;
  $('uploadBtn').textContent = busy ? 'Uploading…' : `Upload ${todo} as drafts`;
  $('recheckBtn').disabled = busy;
  $('stopBtn').hidden = !busy;
}

// ---------- upload ----------
async function toDataUrl(file, max = 1600) {
  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch { throw new Error(`Can't read ${file.name} — use JPG or PNG (iPhone HEIC isn't supported)`); }
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}

async function uploadOne(r) {
  const photos = [];
  for (const p of r.photos) {
    photos.push(await api.uploadPhoto(await toDataUrl(p.file)));
    if (!MOCK) await new Promise((res) => setTimeout(res, 700 + Math.random() * 1000));
  }
  return api.createDraft({
    title: r.row.title, description: r.row.description, price: r.f.price.id,
    catalog_id: r.f.category.id, status_id: r.f.condition.id, package_size_id: r.f.parcel.id,
    size_id: r.f.size?.id ?? null, brand_id: r.f.brand?.id ?? null, brand: r.f.brand?.title ?? null,
    color_ids: r.f.colour?.ids ?? [], photos,
  });
}

async function uploadAll() {
  const todo = rows.filter((r) => r.ready && !r.state?.ok);
  const s = ctx.getSettings();
  const photoCount = todo.reduce((a, r) => a + r.photos.length, 0);
  const ok = await ctx.modal(`Upload ${todo.length} item${todo.length > 1 ? 's' : ''} as drafts?`,
    `${s.dryRun ? '<p class="warn">Dry run is ON. Nothing will be uploaded. Turn it off in Settings.</p>' : ''}
     <p>${photoCount} photos will be uploaded, and each item is saved to your Vinted <b>drafts</b>. Nothing goes live until you publish it in the app.</p>
     <p class="note">There's a ${s.delayMinSec}–${s.delayMaxSec}s pause between items.</p>
     <ul>${todo.map((r) => `<li>${esc(r.row.title)} — ${esc(r.f.price.label)}</li>`).join('')}</ul>`, 'Upload');
  if (!ok) return;

  busy = true; stop = false; render();
  $('progress').hidden = false;
  let done = 0, good = 0;
  for (const r of todo) {
    if (stop) { ctx.log(`Upload stopped after ${done}/${todo.length}`, 'err'); break; }
    r.state = { ok: false, msg: 'Uploading…' }; render();
    try {
      if (s.dryRun) { r.state = { ok: true, msg: 'Dry run ✓' }; ctx.log(`[dry run] Draft: ${r.row.title}`); }
      else {
        const d = await uploadOne(r);
        r.state = { ok: true, msg: 'Draft saved' };
        uploaded.add(r.key);
        ctx.log(`Draft saved: ${r.row.title} (id ${d.id})`, 'ok');
      }
      good++;
    } catch (e) {
      r.state = { ok: false, msg: 'Failed' };
      r.errors = [e.message];
      ctx.log(`Upload failed for "${r.row.title}": ${e.message}`, 'err');
    }
    done++;
    $('progressBar').style.width = `${(done / todo.length) * 100}%`;
    render();
    if (done < todo.length && !stop && !s.dryRun && !MOCK) {
      const ms = randomDelayMs(s);
      ctx.log(`Waiting ${Math.round(ms / 1000)}s before next item…`);
      const until = Date.now() + ms;
      while (Date.now() < until && !stop) await new Promise((res) => setTimeout(res, 300));
    }
  }
  ctx.log(`Upload: ${good}/${todo.length} succeeded${s.dryRun ? ' (dry run)' : ''}`, good === todo.length ? 'ok' : 'err');
  busy = false; render();
  setTimeout(() => { $('progress').hidden = true; $('progressBar').style.width = '0'; }, 1500);
  if (!s.dryRun && good) ctx.onDone?.();
}

// ---------- init ----------
export function initUpload(c) {
  ctx = c;
  $('folderInput').onchange = async (e) => {
    files = [...e.target.files].map((file) => ({ path: file.webkitRelativePath || file.name, file }));
    e.target.value = ''; // let the same folder be picked again after editing the CSV
    rows = []; render();
    if (files.length) await resolveAll();
  };
  $('recheckBtn').onclick = () => {
    ctx.log('Pick the folder again so the edited CSV is read fresh.');
    $('folderInput').click();
  };
  $('templateBtn').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + TEMPLATE_CSV], { type: 'text/csv' }));
    a.download = 'items.csv';
    a.click();
  };
  $('uploadBtn').onclick = uploadAll;
  $('stopBtn').addEventListener('click', () => { stop = true; });
}

// exposed for tests
export const _test = { setFiles: (f) => { files = f; }, resolveAll, getRows: () => rows };
