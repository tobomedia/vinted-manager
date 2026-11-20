import { DEFAULT_SETTINGS, normalizeItem, isStale, newPrice, randomDelayMs, summarize, sortItems, makeBackup, parseBackup, backupFilename, backupSummary } from './logic.js';
import { api, IN_EXT, MOCK } from './api.js';
import { initUpload } from './upload.js';
import { AI_MODELS } from './ai.js';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const gbp = (n) => '£' + n.toFixed(2);

// ---------- settings ----------
const store = {
  async get() {
    try {
      if (IN_EXT) return { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get('settings')).settings };
      return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('vtm-settings') || '{}') };
    } catch { return { ...DEFAULT_SETTINGS }; }
  },
  async set(s) {
    try {
      if (IN_EXT) await chrome.storage.local.set({ settings: s });
      else localStorage.setItem('vtm-settings', JSON.stringify(s));
    } catch {}
  },
};

// ---------- state ----------
const state = { user: null, items: [], filter: 'all', q: '', sort: { key: 'viewsPerDay', dir: 1 }, sel: new Set(), busy: false, stop: false, settings: DEFAULT_SETTINGS };

function log(msg, cls = '') {
  const li = document.createElement('li');
  li.className = cls;
  li.textContent = `${new Date().toLocaleTimeString()} — ${msg}`;
  $('log').prepend(li);
}

// ---------- render ----------
function visible() {
  const s = state.settings, q = state.q.toLowerCase();
  let list = state.filter === 'drafts'
    ? state.items.filter((i) => i.status === 'draft')
    : state.items.filter((i) => i.status !== 'sold' && i.status !== 'draft');
  if (state.filter === 'all') list = list.filter((i) => i.status === 'active');
  if (state.filter === 'stale') list = list.filter((i) => isStale(i, s));
  if (state.filter === 'other') list = list.filter((i) => i.status !== 'active');
  if (q) list = list.filter((i) => i.title.toLowerCase().includes(q));
  return sortItems(list, state.sort.key, state.sort.dir);
}

function render() {
  const s = state.settings, sum = summarize(state.items, s);
  $('tiles').innerHTML = [
    ['Active listings', sum.active],
    ['Underperforming', sum.stale, sum.stale ? 'warn' : ''],
    ['Total views', sum.totalViews.toLocaleString()],
    ['Total favourites', sum.totalFavs.toLocaleString()],
    ['Wardrobe value', gbp(sum.value)],
  ].map(([k, v, c = '']) => `<div class="tile ${c}"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');

  const drafts = state.items.filter((i) => i.status === 'draft').length;
  $('draftsChip').textContent = drafts ? `Drafts (${drafts})` : 'Drafts';
  const list = visible();
  $('rows').innerHTML = list.map((i) => {
    const stale = isStale(i, s);
    const tag = i.status !== 'active' ? `<span class="tag">${i.status}</span>` : stale ? '<span class="tag stale">Underperforming</span>' : '';
    return `<tr data-id="${i.id}">
      <td><input type="checkbox" class="sel" ${state.sel.has(i.id) ? 'checked' : ''} aria-label="Select ${esc(i.title)}"></td>
      <td>${i.thumb ? `<img src="${esc(i.thumb)}" alt="" loading="lazy">` : ''}</td>
      <td><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a></td>
      <td class="num">${gbp(i.price)}</td>
      <td class="num">${i.views}</td>
      <td class="num">${i.favs}</td>
      <td class="num">${i.viewsPerDay.toFixed(1)}</td>
      <td class="num">${i.ageDays == null ? '–' : Math.floor(i.ageDays) + 'd'}</td>
      <td>${tag}</td></tr>`;
  }).join('');
  $('empty').hidden = list.length > 0;

  document.querySelectorAll('th[data-sort]').forEach((th) => {
    th.classList.toggle('asc', th.dataset.sort === state.sort.key && state.sort.dir === 1);
    th.classList.toggle('desc', th.dataset.sort === state.sort.key && state.sort.dir === -1);
  });
  // drop selections that are no longer visible
  const ids = new Set(list.map((i) => i.id));
  for (const id of state.sel) if (!ids.has(id)) state.sel.delete(id);
  $('selAll').checked = list.length > 0 && list.every((i) => state.sel.has(i.id));
  $('bulkbar').hidden = state.sel.size === 0;
  $('selCount').textContent = `${state.sel.size} selected`;
  for (const b of ['relistBtn', 'priceBtn', 'exportBtn', 'deleteBtn', 'refreshBtn', 'restoreBtn']) $(b).disabled = state.busy;
  $('stopBtn').hidden = !state.busy;
  document.body.classList.toggle('busy', state.busy);
  $('dryBadge').hidden = !s.dryRun;
  $('mockBadge').hidden = !MOCK;
  $('who').textContent = state.user ? `Signed in as ${state.user.login} · vinted.co.uk` : 'Not loaded';
}

// ---------- data ----------
async function load() {
  state.busy = true; render();
  try {
    state.user = await api.me();
    const raw = await api.items(state.user.id);
    state.items = raw.map((r) => normalizeItem(r));
    log(`Loaded ${state.items.length} items`, 'ok');
  } catch (e) {
    log(`Load failed: ${e.message}. Open vinted.co.uk, make sure you're logged in, then Refresh.`, 'err');
  } finally { state.busy = false; render(); }
}

// ---------- modal ----------
function modal(title, bodyHtml, okLabel = 'Confirm', danger = false) {
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = bodyHtml;
  $('modalOk').textContent = okLabel;
  $('modalOk').className = danger ? 'danger' : '';
  $('modal').showModal();
  return new Promise((res) => $('modal').addEventListener('close', () => res($('modal').returnValue === 'ok'), { once: true }));
}

const selectedItems = () => state.items.filter((i) => state.sel.has(i.id));
const itemList = (items, fmt = (i) => esc(i.title)) => `<ul>${items.map((i) => `<li>${fmt(i)}</li>`).join('')}</ul>`;
const dryNote = () => state.settings.dryRun ? '<p class="warn">Dry run is ON — nothing will change on Vinted. Turn it off in Settings.</p>' : '';

// ---------- bulk runner ----------
const VERBS = { Delete: 'Deleting', Backup: 'Backing up', Restore: 'Restoring', Relist: 'Relisting', Price: 'Changing price' };
const fmtDur = (ms) => {
  const sec = Math.max(1, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
const bulkMs = (n, s) => n * ((s.delayMinSec + s.delayMaxSec) * 500 + 2000); // avg pause + action
const backupMs = (n) => n * 6000; // ~5–6s per item in practice
let runId = 0;

// readOnly jobs (backups) ignore dry run, use short pauses and keep the selection.
// stage (e.g. '1 of 2') labels multi-step jobs like backup-then-delete.
async function runBulk(label, items, fn, { readOnly = false, stage = '' } = {}) {
  const s = state.settings, live = readOnly || !s.dryRun;
  const id = ++runId, t0 = Date.now(), total = items.length;
  state.busy = true; state.stop = false; render();
  $('progress').hidden = false; $('status').hidden = false;
  $('progressBar').style.width = '0';
  let done = 0, ok = 0;
  // Time left: measured pace once something has finished, otherwise an estimate.
  const left = () => {
    const n = total - done;
    if (!n || !live) return '';
    const per = done ? (Date.now() - t0) / done : readOnly ? backupMs(1) : bulkMs(1, s);
    return ` · about ${fmtDur(per * n)} left`;
  };
  const show = (text) => { $('status').textContent = `${stage ? `Step ${stage}: ` : ''}${text}${left()}`; };
  for (const it of items) {
    if (state.stop) { log(`${label}: stopped by you after ${done}/${total}`, 'err'); break; }
    show(`${VERBS[label] || label} ${done + 1} of ${total}: ${it.title}`);
    try {
      if (!live) log(`[dry run] ${label}: ${it.title}`);
      else { const msg = await fn(it); log(`${label}: ${it.title}${msg ? ' — ' + msg : ''}`, 'ok'); }
      ok++;
    } catch (e) {
      log(`${label} failed for "${it.title}": ${e.message}`, 'err');
    }
    done++;
    $('progressBar').style.width = `${(done / items.length) * 100}%`;
    if (done < total && !state.stop && live && !MOCK) {
      const end = Date.now() + (readOnly ? 1000 + Math.random() * 1500 : randomDelayMs(s));
      await new Promise((r) => {
        const tick = () => {
          const ms = end - Date.now();
          if (state.stop || ms <= 0) { clearInterval(iv); r(); return; }
          show(`${label}: ${done} of ${total} done · next in ${Math.ceil(ms / 1000)}s`);
        };
        const iv = setInterval(tick, 250);
        tick();
      });
    }
  }
  const stopped = state.stop;
  log(`${label}: ${ok}/${items.length} succeeded`, ok === items.length ? 'ok' : 'err');
  state.busy = false;
  if (!readOnly) state.sel.clear();
  $('status').textContent = `${label}: ${ok} of ${total} succeeded${stopped ? ' (stopped)' : ''}`;
  // Only hide if no other run (e.g. the delete after a backup) has started since.
  setTimeout(() => { if (id === runId) { $('progress').hidden = true; $('status').hidden = true; } }, 4000);
  if (!readOnly && !s.dryRun) await load(); else render();
  return { stopped };
}

// ---------- actions ----------
async function doDelete() {
  const items = selectedItems();
  if (!await modal(`Delete ${items.length} item${items.length > 1 ? 's' : ''}?`,
    `${dryNote()}<p>This permanently removes them from Vinted. It can't be undone.</p>
     ${state.settings.dryRun ? '' : `<p class="note">Takes about ${fmtDur(bulkMs(items.length, state.settings))}, plus about ${fmtDur(backupMs(items.length))} for the backup. Keep this tab open until it finishes.</p>`}
     <label><input id="bk" type="checkbox" checked> Download a backup first (photos + details, so you can restore them later)</label>
     ${itemList(items)}`, 'Delete', true)) return;
  let targets = items;
  if ($('bk').checked) {
    const { entries, stopped } = await exportBackup(items, { stage: '1 of 2' });
    if (stopped) { log('Delete cancelled: backup was stopped', 'err'); return; }
    const saved = new Set(entries.map((e) => e.id));
    const missed = items.filter((i) => !saved.has(i.id));
    if (missed.length) log(`Not deleting ${missed.length} item(s) that couldn't be backed up: ${missed.map((i) => i.title).join(', ')}`, 'err');
    targets = items.filter((i) => saved.has(i.id));
    if (!targets.length) return;
  }
  await runBulk('Delete', targets, async (it) => { await api.deleteItem(it.id, { draft: it.status === 'draft' }); }, { stage: $('bk').checked ? '2 of 2' : '' });
}

// ---------- backup / restore ----------
function download(name, obj) {
  const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  return blob.size;
}

async function exportBackup(items, { stage = '' } = {}) {
  const entries = [];
  const { stopped } = await runBulk('Backup', items, async (it) => {
    const b = await api.backupItem(it.id);
    entries.push(b);
    return `${b.photos.length} photo${b.photos.length === 1 ? '' : 's'}`;
  }, { readOnly: true, stage });
  if (entries.length && !stopped) {
    const name = backupFilename(state.user?.login);
    const size = download(name, makeBackup(state.user, entries));
    log(`Saved ${name} (${entries.length} items, ${(size / 1048576).toFixed(1)} MB). Keep this file safe; it's what Restore uses.`, 'ok');
  }
  return { entries, stopped };
}

async function doRestore(file) {
  let entries;
  try { entries = parseBackup(await file.text()); }
  catch (e) { log(`Can't restore ${file.name}: ${e.message}`, 'err'); return; }
  const listed = new Set(state.items.map((i) => i.id));
  const fresh = entries.filter((e) => !listed.has(e.id)).map(backupSummary);
  const dup = entries.filter((e) => listed.has(e.id)).map(backupSummary);
  if (!fresh.length) { log(`Nothing to restore: all ${entries.length} items in ${file.name} are still in your wardrobe`, 'err'); return; }
  const byId = new Map(entries.map((e) => [e.id, e]));
  if (!await modal(`Restore ${fresh.length} item${fresh.length > 1 ? 's' : ''}?`,
    `${dryNote()}<p>Each item is created as a new listing using the photos and details saved in <b>${esc(file.name)}</b>.</p>
     ${dup.length ? `<p class="note">${dup.length} item(s) are still in your wardrobe, so they'll be skipped to avoid duplicates: ${dup.map((i) => esc(i.title)).join(', ')}</p>` : ''}
     ${fresh.length > 15 ? '<p class="warn">Creating lots of listings at once may get flagged by Vinted. Consider restoring 10–15 a day.</p>' : ''}
     ${itemList(fresh, (i) => `${esc(i.title)} · ${gbp(i.price)} · ${i.photos} photo${i.photos === 1 ? '' : 's'}`)}`, 'Restore')) return;
  await runBulk('Restore', fresh, async (it) => { const r = await api.restoreItem(byId.get(it.id)); return `new id ${r.newId}`; });
}

async function doRelist() {
  const items = selectedItems();
  const s = state.settings;
  const mins = Math.round((items.length * (s.delayMinSec + s.delayMaxSec)) / 2 / 60);
  if (!await modal(`Relist ${items.length} item${items.length > 1 ? 's' : ''}?`,
    `${dryNote()}<p>Each item is re-created as a brand-new listing (same photos, title, price, details), then the old one is deleted.</p>
     <p class="note">You'll lose the old listing's views and favourites. The original is only deleted after the new one is created successfully. Estimated time: ~${mins} min.</p>
     ${items.length > 15 ? '<p class="warn">Relisting many items at once is the most likely thing to get flagged by Vinted. Consider doing 10–15 a day.</p>' : ''}
     ${itemList(items)}`, 'Relist')) return;
  await runBulk('Relist', items, async (it) => { const r = await api.relist(it.id); return `new id ${r.newId}`; });
}

async function doPrice() {
  const items = selectedItems();
  const ok = await modal(`Change price of ${items.length} item${items.length > 1 ? 's' : ''}`,
    `${dryNote()}<label for="pm">Change</label>
     <div class="row"><select id="pm"><option value="pct">Reduce by %</option><option value="amount">Reduce by £</option><option value="set">Set to £</option></select>
     <input id="pv" type="number" min="0" step="0.01" value="10" style="width:100px"></div>
     <div id="pp"></div>`, 'Apply');
  // (preview is rendered live below via input listeners before confirm)
  if (!ok) return;
  const mode = state._priceMode, value = state._priceValue;
  const plan = [];
  for (const it of items) {
    try { plan.push({ it, p: newPrice(it.price, mode, value) }); }
    catch (e) { log(`Skipped "${it.title}": ${e.message}`, 'err'); }
  }
  await runBulk('Price', plan.map((x) => ({ ...x.it, _p: x.p })), async (it) => {
    await api.setPrice(it.id, it._p);
    return `${gbp(it.price)} → ${gbp(it._p)}`;
  });
}

function wirePricePreview() {
  const upd = () => {
    const pm = $('pm'), pv = $('pv');
    if (!pm) return;
    state._priceMode = pm.value; state._priceValue = Number(pv.value);
    $('pp').innerHTML = itemList(selectedItems(), (i) => {
      try { return `${esc(i.title)}: ${gbp(i.price)} → <strong>${gbp(newPrice(i.price, pm.value, Number(pv.value)))}</strong>`; }
      catch (e) { return `${esc(i.title)}: <em>${esc(e.message)}</em>`; }
    });
  };
  $('modalBody').addEventListener('input', upd);
  $('modalBody').addEventListener('change', upd);
  upd();
}

async function doSettings() {
  const s = state.settings;
  const ok = await modal('Settings', `
    <p class="note">An item is <b>underperforming</b> when it's been listed at least N days and has fewer than M views.</p>
    <div class="row"><div><label for="sd">Min age (days)</label><input id="sd" type="number" min="1" value="${s.staleDays}"></div>
    <div><label for="sv">Max views</label><input id="sv" type="number" min="0" value="${s.staleViews}"></div></div>
    <p class="note">Random pause between bulk actions, so it doesn't look like a bot.</p>
    <div class="row"><div><label for="dmin">Min delay (s)</label><input id="dmin" type="number" min="5" value="${s.delayMinSec}"></div>
    <div><label for="dmax">Max delay (s)</label><input id="dmax" type="number" min="5" value="${s.delayMaxSec}"></div></div>
    <label><input id="dry" type="checkbox" ${s.dryRun ? 'checked' : ''}> Dry run (log actions without changing anything)</label>
    <h3>Claude drafting (bulk upload)</h3>
    <p class="note">Fills blank titles, descriptions, categories and so on from each item's photos and notes. Uses your own Anthropic API key from <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>, billed to your Anthropic account. The key stays in this browser and is only sent to Anthropic.</p>
    <label for="aiKey">Anthropic API key</label><input id="aiKey" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-…" value="${esc(s.aiKey || '')}">
    <label for="aiModel">Model</label><select id="aiModel">${AI_MODELS.map((m) => `<option value="${m.id}" ${m.id === s.aiModel ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>`, 'Save');
  if (!ok) return;
  const num = (id, d) => (Number.isFinite(+$(id).value) && $(id).value !== '' ? +$(id).value : d);
  state.settings = {
    staleDays: num('sd', s.staleDays), staleViews: num('sv', s.staleViews),
    delayMinSec: Math.max(5, num('dmin', s.delayMinSec)), delayMaxSec: Math.max(5, num('dmax', s.delayMaxSec)),
    dryRun: $('dry').checked,
    aiKey: $('aiKey').value.trim(), aiModel: $('aiModel').value,
  };
  await store.set(state.settings);
  log('Settings saved', 'ok');
  render();
}

async function doDiagnose() {
  log('Checking connection to Vinted…');
  try {
    const res = await api.diagnose();
    for (const r of res) log(`${r.ok ? '✓' : '✗'} ${r.name}: ${r.info}`, r.ok ? 'ok' : 'err');
  } catch (e) { log(`Check failed: ${e.message}`, 'err'); }
}

// ---------- events ----------
$('refreshBtn').onclick = load;
$('settingsBtn').onclick = doSettings;
$('diagnoseBtn').onclick = doDiagnose;
$('deleteBtn').onclick = doDelete;
$('exportBtn').onclick = () => exportBackup(selectedItems());
$('restoreBtn').onclick = () => $('restoreFile').click();
$('restoreFile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) doRestore(f); };
$('relistBtn').onclick = doRelist;
$('priceBtn').onclick = () => { setTimeout(wirePricePreview, 0); doPrice(); };
$('stopBtn').onclick = () => { state.stop = true; };
$('clearSel').onclick = () => { state.sel.clear(); render(); };
$('search').oninput = (e) => { state.q = e.target.value; render(); };
document.querySelectorAll('.chip').forEach((c) => (c.onclick = () => {
  document.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === c));
  state.filter = c.dataset.filter; render();
}));
document.querySelectorAll('th[data-sort]').forEach((th) => (th.onclick = () => {
  const k = th.dataset.sort;
  state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : k === 'title' ? 1 : -1 };
  render();
}));
$('rows').addEventListener('change', (e) => {
  if (!e.target.classList.contains('sel')) return;
  const id = Number(e.target.closest('tr').dataset.id);
  e.target.checked ? state.sel.add(id) : state.sel.delete(id);
  render();
});
$('selAll').onchange = (e) => {
  for (const i of visible()) e.target.checked ? state.sel.add(i.id) : state.sel.delete(i.id);
  render();
};
window.addEventListener('beforeunload', (e) => { if (state.busy) e.preventDefault(); });

document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t));
  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== 'view-' + t.dataset.view));
}));
initUpload({ log, modal, getSettings: () => state.settings, onDone: load });

(async () => {
  state.settings = await store.get();
  if (MOCK) log('Demo mode: showing fake data. Load the extension in Chrome to use your real account.');
  await load();
})();
