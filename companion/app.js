import { store, persist } from './lib/store.js';
import { toJpeg } from './lib/image.js';
import { buildBatch, batchFilename, displayName, warnings, parsePrice, CONDITIONS, PARCELS, MAX_PHOTOS } from './lib/batch.js';
import { zipParts } from './lib/zip.js';

const $ = (id) => document.getElementById(id);
const FIELDS = ['title', 'price', 'condition', 'brand', 'size', 'notes', 'description', 'category', 'colour', 'parcel'];
const uid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

let items = [];   // all saved items, oldest first (kept in memory; IndexedDB is the backup)
let cur = null;   // item being edited
let sel = -1;     // selected photo index
let zip = null;   // { file, ids } prepared for export

// tiny DOM builder
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat().filter((k) => k != null && k !== false));
  return el;
}

const thumbs = new WeakMap();
function photoUrl(p) {
  let u = thumbs.get(p.buf);
  if (!u) { u = URL.createObjectURL(new Blob([p.buf], { type: 'image/jpeg' })); thumbs.set(p.buf, u); }
  return u;
}

// Two taps to confirm destructive buttons (no browser dialogs).
function confirmTap(btn, label, fn) {
  const orig = btn.textContent;
  btn.onclick = () => {
    if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = orig; btn.classList.remove('confirming'); fn(); return; }
    btn.dataset.armed = '1'; btn.textContent = label; btn.classList.add('confirming');
    setTimeout(() => { if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = orig; btn.classList.remove('confirming'); } }, 3000);
  };
}

function msg(el, text, err = false) {
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('err', err);
}

// ---------- routing (hash, so the phone's back gesture works) ----------
function route() {
  const v = location.hash.slice(1);
  const view = v === 'edit' && cur ? 'edit' : v === 'export' ? 'export' : 'list';
  for (const id of ['list', 'edit', 'export']) $(`v-${id}`).hidden = id !== view;
  if (view === 'list') { if (cur) finishEdit(); renderList(); }
  if (view === 'export') renderExport();
  window.scrollTo(0, 0);
}
// Setting the hash to its current value fires no hashchange, so route directly then.
const go = (v) => { if (location.hash !== (v ? `#${v}` : '')) location.hash = v; else route(); };
window.addEventListener('hashchange', route);

// ---------- list ----------
function renderList() {
  $('count').textContent = items.length ? `(${items.length})` : '';
  $('empty').hidden = items.length > 0;
  $('exportBtn').disabled = !items.some((i) => i.photos.length);
  $('items').replaceChildren(...[...items].reverse().map((it) => {
    const w = warnings(it), price = parsePrice(it.price);
    const meta = [price != null ? `£${price.toFixed(2)}` : null, `${it.photos.length} photo${it.photos.length === 1 ? '' : 's'}`, it.condition || null].filter(Boolean).join(' · ');
    return h('li', {}, h('button', { class: 'item', onclick: () => openItem(it) },
      it.photos[0] ? h('img', { src: photoUrl(it.photos[0]), alt: '' }) : h('span', { class: 'ph' }),
      h('span', {}, h('span', { class: 'name' }, displayName(it)), h('span', { class: 'meta' }, meta)),
      it.exportedAt ? h('span', { class: 'badge done' }, 'Exported') : w.length ? h('span', { class: 'badge warn', title: w.join(', ') }, `! ${w[0]}`) : null,
    ));
  }));
}

// ---------- edit ----------
const isEmpty = (it) => !it.photos.length && FIELDS.every((f) => !String(it[f] ?? '').trim());
const blank = () => ({ id: uid(), created: Date.now(), photos: [], ...Object.fromEntries(FIELDS.map((f) => [f, ''])) });

function openItem(it) {
  cur = it || blank();
  sel = -1;
  const form = $('form');
  for (const f of FIELDS) form.elements[f].value = cur[f] ?? '';
  form.querySelector('details').open = !!(cur.description || cur.category || cur.colour || cur.parcel);
  $('editTitle').textContent = it ? displayName(it) : 'New item';
  $('delBtn').hidden = !items.includes(cur);
  $('saved').textContent = '';
  msg($('photoMsg'), '');
  renderPhotos();
  go('edit');
}

let saveTimer;
async function save(it = cur) {
  clearTimeout(saveTimer);
  if (!it || isEmpty(it)) return;
  try {
    await store.put(it);
    if (!items.includes(it)) { items.push(it); persist(); }
    if (it === cur) { $('saved').textContent = 'Saved'; $('delBtn').hidden = false; }
  } catch (e) {
    if (it === cur) msg($('photoMsg'), `Couldn't save: ${e.message}`, true);
  }
}
const saveSoon = () => { $('saved').textContent = ''; clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); };

function finishEdit() { const it = cur; cur = null; if (it) save(it); }

$('form').addEventListener('input', (e) => {
  if (!cur || !e.target.name) return;
  cur[e.target.name] = e.target.value;
  if (e.target.name === 'title') $('editTitle').textContent = displayName(cur);
  saveSoon();
});

function renderPhotos() {
  $('photos').replaceChildren(...cur.photos.map((p, i) =>
    h('li', { class: i === sel ? 'sel' : '', onclick: () => { sel = sel === i ? -1 : i; renderPhotos(); } },
      h('img', { src: photoUrl(p), alt: `Photo ${i + 1}` }),
      h('span', { class: 'n' }, i === 0 ? 'Cover' : String(i + 1)))));
  $('photoTools').hidden = sel < 0;
}

async function addFiles(fileList) {
  const it = cur, files = [...fileList];
  if (!it || !files.length) return;
  const room = MAX_PHOTOS - it.photos.length;
  if (room <= 0) return msg($('photoMsg'), `Vinted allows ${MAX_PHOTOS} photos per item.`, true);
  const todo = files.slice(0, room), errors = [];
  for (let i = 0; i < todo.length; i++) {
    if (it === cur) msg($('photoMsg'), `Adding photo ${i + 1} of ${todo.length}…`);
    try { it.photos.push(await toJpeg(todo[i])); if (it === cur) renderPhotos(); }
    catch (e) { errors.push(e.message); }
  }
  await save(it);
  if (it !== cur) return;
  const notes = [...errors];
  if (files.length > room) notes.push(`Only ${room} added: Vinted allows ${MAX_PHOTOS} photos per item.`);
  msg($('photoMsg'), notes.join(' '), notes.length > 0);
}
for (const id of ['camera', 'library']) $(id).addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });

$('photoTools').addEventListener('click', (e) => {
  const act = e.target.dataset?.act;
  if (!act || sel < 0 || act === 'remove') return;
  const ph = cur.photos;
  const to = act === 'left' ? Math.max(0, sel - 1) : act === 'right' ? Math.min(ph.length - 1, sel + 1) : 0;
  const [p] = ph.splice(sel, 1);
  ph.splice(to, 0, p);
  sel = to;
  renderPhotos(); saveSoon();
});
confirmTap($('photoTools').querySelector('[data-act="remove"]'), 'Tap again', () => {
  if (sel < 0) return;
  cur.photos.splice(sel, 1);
  sel = -1;
  renderPhotos(); saveSoon();
});

$('backBtn').onclick = $('doneBtn').onclick = () => go('');
$('nextBtn').onclick = async () => {
  if (isEmpty(cur)) return msg($('photoMsg'), 'Add a photo first.', true);
  await save();
  openItem(null);
};
confirmTap($('delBtn'), 'Tap again to delete', async () => {
  const it = cur;
  cur = null;
  items = items.filter((x) => x !== it);
  try { await store.del(it.id); } catch {}
  go('');
});

// ---------- export ----------
function renderExport() {
  const b = buildBatch(items);
  const mb = b.files.reduce((n, f) => n + f.photo.buf.byteLength, 0) / 1048576;
  const noPrice = items.filter((i) => i.photos.length && parsePrice(i.price) == null);
  $('exportSummary').replaceChildren(
    h('p', {}, h('span', { class: 'stat' }, `${b.count} item${b.count === 1 ? '' : 's'}`), h('br'),
      h('span', { class: 'muted' }, `${b.files.length} photos · about ${Math.max(0.1, mb).toFixed(1)} MB`)),
    b.skipped.length ? h('p', { class: 'muted small' }, `Left out (no photos): ${b.skipped.map(displayName).join(', ')}`) : null,
    noPrice.length ? h('p', { class: 'muted small' }, `${noPrice.length} without a price. You can add prices on your computer before uploading.`) : null,
  );
  zip = null;
  $('prepareBtn').hidden = false; $('prepareBtn').disabled = !b.count; $('prepareBtn').textContent = 'Create zip';
  $('shareBtn').hidden = true; $('downloadLink').hidden = true; $('clearBox').hidden = true;
  msg($('exportMsg'), '');
}

$('prepareBtn').onclick = async () => {
  const btn = $('prepareBtn');
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    const included = items.filter((i) => i.photos.length);
    const b = buildBatch(included);
    const enc = new TextEncoder();
    const entries = [{ name: 'items.csv', data: enc.encode(b.csv) }, ...b.files.map((f) => ({ name: f.path, data: new Uint8Array(f.photo.buf) }))];
    const name = batchFilename();
    const file = new File(zipParts(entries), name, { type: 'application/zip' });
    zip = { file, ids: included.map((i) => i.id) };
    btn.hidden = true;
    // Sharing must start from a tap, so it's a separate button after the zip is built.
    $('shareBtn').hidden = !navigator.canShare?.({ files: [file] });
    const a = $('downloadLink');
    if (a.href.startsWith('blob:')) URL.revokeObjectURL(a.href);
    a.href = URL.createObjectURL(file); a.download = name; a.hidden = false;
    a.textContent = $('shareBtn').hidden ? `Save ${name}` : 'Or save it to this phone';
    msg($('exportMsg'), `${name} is ready (${(file.size / 1048576).toFixed(1)} MB).`);
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Create zip';
    msg($('exportMsg'), `Couldn't create the zip: ${e.message}`, true);
  }
};

async function markExported() {
  if (!zip) return;
  const now = Date.now();
  for (const it of items) if (zip.ids.includes(it.id)) { it.exportedAt = now; await save(it).catch(() => {}); }
  $('clearBox').hidden = false;
}

$('shareBtn').onclick = async () => {
  try {
    await navigator.share({ files: [zip.file], title: zip.file.name });
    msg($('exportMsg'), 'Shared ✓');
    markExported();
  } catch (e) {
    if (e.name !== 'AbortError') msg($('exportMsg'), `Sharing didn't work (${e.message}). Use “save it to this phone” instead.`, true);
  }
};
$('downloadLink').addEventListener('click', () => { setTimeout(markExported, 500); });

confirmTap($('clearBtn'), 'Tap again to remove', async () => {
  const ids = new Set(zip?.ids || []);
  items = items.filter((i) => !ids.has(i.id));
  try { await store.delMany([...ids]); } catch {}
  zip = null;
  go('');
});

$('exportBtn').onclick = () => go('export');
$('exportBack').onclick = () => go('');
$('newBtn').onclick = () => openItem(null);

// ---------- setup ----------
$('conditionSel').append(h('option', { value: '' }, '–'), ...CONDITIONS.map((c) => h('option', { value: c }, c)));
$('parcelSel').append(h('option', { value: '' }, '–'), ...PARCELS.map(([code, label]) => h('option', { value: code }, label)));

function installTip() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  let dismissed = false;
  try { dismissed = localStorage.getItem('vc-tip') === '1'; } catch {}
  if (standalone || dismissed) return;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const tip = $('installTip');
  tip.replaceChildren(
    'Add this app to your home screen so your items stay saved: ',
    h('b', {}, ios ? 'Share → Add to Home Screen' : 'browser menu → Add to Home screen'), '.',
    h('button', { class: 'ghost', onclick: () => { tip.hidden = true; try { localStorage.setItem('vc-tip', '1'); } catch {} } }, 'Dismiss'));
  tip.hidden = false;
}

(async () => {
  try { items = await store.all(); }
  catch (e) { $('empty').textContent = `Couldn't open storage: ${e.message}`; }
  installTip();
  history.replaceState(null, '', location.pathname); // always start on the list
  route();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
