import { api, MOCK } from './api.js';
import { randomDelayMs } from './logic.js';
import {
  TEMPLATE_CSV, DEFAULT_CONDITIONS, DEFAULT_PARCELS, parseCSV, parsePrice, flattenCatalogs,
  matchCategory, matchByTitle, matchParcel, photosFor, basicErrors, unzipFiles, toCSV, needsDraft, norm,
} from './upload-logic.js';
import { draftListing, mergeDraft, AI_MODELS } from './ai.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let ctx;              // { log, modal, getSettings, onDone }
let files = [];       // [{ path, file }]
let rows = [];        // resolved rows
let busy = false, stop = false;
let leaves = null, colourList = null; // Vinted lookups, loaded once per pick
const cache = new Map();
const uploaded = new Set(); // "folder|title" uploaded this session — avoids duplicates on re-pick

async function cached(key, fn) {
  if (!cache.has(key)) cache.set(key, fn().catch((e) => { cache.delete(key); throw e; }));
  return cache.get(key);
}

// ---------- resolve CSV rows → Vinted IDs ----------
async function resolveRow(row) {
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
        r.sizeOptions = list.map((x) => x.title);
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

  leaves = null; colourList = null;
  try { leaves = flattenCatalogs(await cached('catalogs', () => api.catalogs())); }
  catch (e) { ctx.log(`Couldn't load Vinted categories: ${e.message}. You can type category IDs instead.`, 'err'); }
  try { colourList = await cached('colours', () => api.colours()); } catch { /* colours optional */ }

  rows = [];
  for (const row of parsed) rows.push(await resolveRow(row));
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

// Editable preview: every field is an input. Editing re-checks just that row and
// patches its hints and status, so focus and half-typed values are never lost.
const CONDITION_TITLES = DEFAULT_CONDITIONS.map((c) => c.title);
const PARCEL_OPTS = [['S', 'Small'], ['M', 'Medium'], ['L', 'Large']];
let drafting = false;

function hint(r, k) {
  const res = r.f[k];
  if (res?.error) return `<div class="hint bad">${esc(res.error)}</div>`;
  const raw = String(r.row[k] ?? '').trim();
  if (res?.label && norm(res.label) !== norm(raw) && !(k === 'price')) return `<div class="hint muted">→ ${esc(res.label)}</div>`;
  return '<div class="hint"></div>';
}

function editor(r, i, k) {
  const v = esc(r.row[k] ?? ''), off = busy || drafting || r.state?.ok ? 'disabled' : '';
  const at = `data-i="${i}" data-k="${k}" ${off}`;
  let el;
  if (k === 'condition') {
    const opts = r.row.condition && !CONDITION_TITLES.some((t) => norm(t) === norm(r.row.condition)) ? [r.row.condition, ...CONDITION_TITLES] : CONDITION_TITLES;
    el = `<select ${at}><option value="">–</option>${opts.map((t) => `<option ${norm(t) === norm(r.row.condition) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  } else if (k === 'parcel') {
    const cur = (r.f.parcel?.label || r.row.parcel || 'M').toString();
    el = `<select ${at}>${PARCEL_OPTS.map(([c, t]) => `<option value="${c}" ${norm(cur) === norm(c) || norm(cur) === norm(t) ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
  } else {
    const list = k === 'category' ? 'list="dl-cat"' : k === 'colour' ? 'list="dl-colour"' : k === 'size' ? `list="dl-size-${i}"` : '';
    const extra = k === 'price' ? 'inputmode="decimal" class="price"' : '';
    el = `<input ${at} ${list} ${extra} value="${v}">`;
    if (k === 'size') el += `<datalist id="dl-size-${i}">${(r.sizeOptions || []).map((t) => `<option value="${esc(t)}">`).join('')}</datalist>`;
  }
  return `<td data-cell="${k}">${el}${hint(r, k)}</td>`;
}

function statusHtml(r, i) {
  const s = r.state
    ? `<span class="tag ${r.state.ok ? 'ok' : 'err'}">${esc(r.state.msg)}</span>`
    : r.ready ? '<span class="tag ok">Ready</span>'
    : `<span class="tag err" title="${esc(r.errors.join('\n'))}">${r.errors.length} issue${r.errors.length > 1 ? 's' : ''}</span>`;
  return s;
}

const canDraft = (r) => !r.state?.ok && needsDraft(r.row) && r.photos.length > 0;
const draftBtnHtml = (r, i) => (canDraft(r)
  ? `<button class="ai tiny" data-draft="${i}" ${busy || drafting ? 'disabled' : ''} title="Fill this item's blank fields with Claude">✨ Draft</button>` : '');

// errors not tied to one field (photos, title length…) go under the title
const generalErrors = (r) => r.errors.filter((e) => !Object.values(r.f).some((f) => f?.error === e));

function rowHtml(r, i) {
  const off = busy || drafting || r.state?.ok ? 'disabled' : '';
  const gen = generalErrors(r);
  return `<tr data-row="${i}">
    <td>${r.row._row}</td>
    <td><div class="ph">${r.photos[0] ? `<img src="${thumb(r.photos[0].file)}" alt="">` : ''}<span class="${r.photos.length ? '' : 'bad'}">${r.photos.length}</span></div><div class="draft-slot">${draftBtnHtml(r, i)}</div></td>
    <td class="title-cell" data-cell="title">
      <input data-i="${i}" data-k="title" ${off} placeholder="Title" value="${esc(r.row.title ?? '')}">
      <textarea data-i="${i}" data-k="description" ${off} rows="2" placeholder="Description">${esc(r.row.description ?? '')}</textarea>
      ${r.row.notes ? `<div class="hint muted" title="${esc(r.row.notes)}">Notes: ${esc(r.row.notes)}</div>` : ''}
      <div class="hint bad gen">${gen.map(esc).join('<br>')}</div>
    </td>
    ${['price', 'category', 'brand', 'size', 'condition', 'colour', 'parcel'].map((k) => editor(r, i, k)).join('')}
    <td class="status">${statusHtml(r, i)}</td></tr>`;
}

function datalists() {
  return `<datalist id="dl-cat">${(leaves || []).map((l) => `<option value="${esc(l.path)}">`).join('')}</datalist>
    <datalist id="dl-colour">${(colourList || []).map((c) => `<option value="${esc(c.title)}">`).join('')}</datalist>`;
}

function render() {
  $('previewWrap').hidden = rows.length === 0;
  $('uploadSummary').hidden = rows.length === 0;
  $('previewRows').innerHTML = rows.map(rowHtml).join('');
  $('previewLists').innerHTML = datalists();
  renderSummary();
}

function renderSummary() {
  const todo = rows.filter((r) => r.ready && !r.state?.ok).length;
  const draftable = rows.filter(canDraft).length;
  $('uploadCounts').textContent = `${rows.length} rows · ${todo} ready to upload · ${rows.filter((r) => !r.ready).length} need fixing`;
  $('uploadBtn').disabled = busy || drafting || todo === 0;
  $('uploadBtn').textContent = busy ? 'Uploading…' : `Upload ${todo} as drafts`;
  $('draftBtn').disabled = busy || drafting || draftable === 0;
  $('draftBtn').textContent = drafting ? '✨ Drafting…' : draftable ? `✨ Draft all ${draftable} with Claude` : '✨ All drafted';
  $('draftBtn').hidden = rows.length === 0;
  $('recheckBtn').disabled = busy || drafting;
  $('saveCsvBtn').disabled = busy || drafting;
  $('stopBtn').hidden = !(busy || drafting);
}

// update hints + status for one row without touching its inputs
function patchRow(i) {
  const r = rows[i], tr = $('previewRows').querySelector(`tr[data-row="${i}"]`);
  if (!tr) return;
  for (const td of tr.querySelectorAll('td[data-cell]')) {
    const k = td.dataset.cell;
    if (k === 'title') { td.querySelector('.gen').innerHTML = generalErrors(r).map(esc).join('<br>'); continue; }
    const tmp = document.createElement('div');
    tmp.innerHTML = hint(r, k);
    td.querySelector('.hint').replaceWith(tmp.firstChild);
    if (k === 'size') td.querySelector('datalist').innerHTML = (r.sizeOptions || []).map((t) => `<option value="${esc(t)}">`).join('');
  }
  tr.querySelector('td.status').innerHTML = statusHtml(r, i);
  tr.querySelector('.draft-slot').innerHTML = draftBtnHtml(r, i);
  renderSummary();
}

async function onEdit(e) {
  const el = e.target, i = Number(el.dataset.i), k = el.dataset.k;
  if (!k || !rows[i]) return;
  const prev = rows[i];
  const row = { ...prev.row, [k]: el.value.trim() };
  const next = await resolveRow(row);
  if (prev.state && !prev.state.ok) next.state = null; // a failed upload can be retried after a fix
  rows[i] = next;
  patchRow(i);
}

// ---------- Claude drafting ----------
const b64 = (dataUrl) => dataUrl.slice(dataUrl.indexOf(',') + 1);

async function draftOne(i, s, model) {
  const r = rows[i];
  const images = [];
  for (const p of r.photos.slice(0, 4)) images.push(b64(await toDataUrl(p.file, 1024)));
  const { draft, cost } = await draftListing({
    apiKey: s.aiKey, model, row: r.row, images,
    categories: (leaves || []).map((l) => l.path),
    colours: (colourList || []).map((c) => c.title),
    conditions: CONDITION_TITLES,
  });
  const { row, filled } = mergeDraft(r.row, draft);
  rows[i] = await resolveRow(row);
  return { filled, cost };
}

async function draftRows(indexes) {
  const s = ctx.getSettings();
  if (!s.aiKey) {
    await ctx.modal('Add your Anthropic API key', '<p>Claude drafting needs an API key. Open <b>Settings</b> and paste one in. You can create a key at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>.</p>', 'OK');
    return;
  }
  if (!indexes.length) return;
  const model = s.aiModel || AI_MODELS[0].id;
  const label = (AI_MODELS.find((m) => m.id === model)?.label || model).split(' — ')[0];
  drafting = true; stop = false; render();
  $('progress').hidden = false;
  ctx.log(`Drafting ${indexes.length} item${indexes.length > 1 ? 's' : ''} with ${label}. Only blank fields are filled; price is left to you.`);
  let done = 0, good = 0, total = 0;
  for (const i of indexes) {
    if (stop) { ctx.log(`Drafting stopped after ${done}/${indexes.length}`, 'err'); break; }
    rows[i].state = { ok: false, msg: 'Drafting…' }; render();
    try {
      const { filled, cost } = await draftOne(i, s, model);
      total += cost; good++;
      ctx.log(`Drafted "${rows[i].row.title}": filled ${filled.join(', ') || 'nothing new'}`, 'ok');
    } catch (e) {
      rows[i].state = null;
      ctx.log(`Couldn't draft row ${rows[i].row._row}: ${e.message}`, 'err');
      if (/API key|401|Rate limited/.test(e.message)) break;
    }
    done++;
    $('progressBar').style.width = `${(done / indexes.length) * 100}%`;
  }
  drafting = false; render();
  setTimeout(() => { $('progress').hidden = true; $('progressBar').style.width = '0'; }, 1500);
  ctx.log(`Drafted ${good}/${indexes.length} with ${label}, about $${total.toFixed(total < 0.01 ? 4 : 2)} in API costs. Check each row before uploading.`, good ? 'ok' : 'err');
}

function saveCsv() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([toCSV(rows.map((r) => r.row))], { type: 'text/csv' }));
  a.download = 'items.csv';
  a.click();
  ctx.log('Saved items.csv with your edits. To reuse it later, put it in the batch folder in place of the old one.');
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

// read a dropped folder into [{ path, file }]
async function readDir(dirEntry, prefix) {
  const out = [];
  const reader = dirEntry.createReader();
  for (;;) {
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    for (const en of batch) {
      const path = `${prefix}/${en.name}`;
      if (en.isDirectory) out.push(...await readDir(en, path));
      else out.push({ path, file: await new Promise((res, rej) => en.file(res, rej)) });
    }
  }
  return out;
}

// ---------- init ----------
export function initUpload(c) {
  ctx = c;
  $('previewRows').addEventListener('change', onEdit);
  $('previewRows').addEventListener('click', (e) => {
    const b = e.target.closest('[data-draft]');
    if (b) draftRows([Number(b.dataset.draft)]);
  });
  $('draftBtn').onclick = () => draftRows(rows.map((r, i) => (canDraft(r) ? i : -1)).filter((i) => i >= 0));
  $('saveCsvBtn').onclick = saveCsv;
  let lastPick = 'zipInput';
  const load = async (picked, label) => {
    files = picked;
    rows = []; render();
    if (!files.length) return;
    ctx.log(`Loaded ${label} (${files.length} files)`);
    await resolveAll();
  };
  const loadZip = async (file) => {
    try { await load(await unzipFiles(file), file.name); }
    catch (e) { ctx.log(`Couldn't open ${file.name}: ${e.message}`, 'err'); }
  };
  $('zipInput').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = ''; // let the same file be picked again
    lastPick = 'zipInput';
    if (f) await loadZip(f);
  };
  $('folderInput').onchange = async (e) => {
    const picked = [...e.target.files].map((file) => ({ path: file.webkitRelativePath || file.name, file }));
    e.target.value = ''; // let the same folder be picked again after editing the CSV
    lastPick = 'folderInput';
    await load(picked, 'folder');
  };
  $('recheckBtn').onclick = () => {
    ctx.log(lastPick === 'zipInput' ? 'Pick the zip again.' : 'Pick the folder again so the edited CSV is read fresh.');
    $(lastPick).click();
  };

  // drag and drop a zip or a folder onto the intro panel
  const zone = document.querySelector('.upload-intro');
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drop'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drop'));
  zone.addEventListener('drop', async (e) => {
    e.preventDefault(); zone.classList.remove('drop');
    if (busy) return;
    const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    const dir = entries.find((en) => en.isDirectory);
    if (dir) { lastPick = 'folderInput'; return load(await readDir(dir, dir.name), dir.name); }
    const zip = [...e.dataTransfer.files].find((f) => /\.zip$/i.test(f.name));
    if (zip) { lastPick = 'zipInput'; return loadZip(zip); }
    ctx.log('Drop a .zip or a folder', 'err');
  });
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
