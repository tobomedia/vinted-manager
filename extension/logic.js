// Pure helpers — no browser APIs, unit-tested in tests/logic.test.mjs.

export const DEFAULT_SETTINGS = {
  staleDays: 14,
  staleViews: 20,
  delayMinSec: 20,
  delayMaxSec: 45,
  dryRun: true,
  aiKey: '',
  aiModel: 'claude-haiku-5-5',
};

const DAY = 86400000;

function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

// Vinted's wardrobe payload varies; map whatever we get to one stable shape.
export function normalizeItem(raw, now = Date.now()) {
  const photo = raw.photo || raw.photos?.[0] || {};
  const created =
    toMs(raw.created_at_ts) ??
    toMs(raw.created_at) ??
    toMs(photo.high_resolution?.timestamp) ??
    null;
  const price = Number(raw.price?.amount ?? raw.price_numeric ?? raw.price ?? 0);
  const ageDays = created ? Math.max(0, (now - created) / DAY) : null;
  const views = Number(raw.view_count ?? 0);
  const status = raw.is_closed ? 'sold' : raw.is_draft ? 'draft' : raw.is_hidden ? 'hidden' : raw.is_reserved ? 'reserved' : 'active';
  return {
    id: raw.id,
    title: raw.title || '(untitled)',
    price,
    currency: raw.price?.currency_code || raw.currency || 'GBP',
    views,
    favs: Number(raw.favourite_count ?? 0),
    created,
    ageDays,
    viewsPerDay: ageDays ? views / Math.max(ageDays, 1) : views,
    status,
    thumb: photo.thumbnails?.find((t) => t.type === 'thumb150x210')?.url || photo.url || '',
    url: raw.url || `https://www.vinted.co.uk/items/${raw.id}`,
  };
}

export function isStale(item, s = DEFAULT_SETTINGS) {
  return item.status === 'active' && item.ageDays != null && item.ageDays >= s.staleDays && item.views < s.staleViews;
}

// mode: 'pct' (reduce by %), 'amount' (reduce by £), 'set' (exact price)
export function newPrice(current, mode, value) {
  let p;
  if (mode === 'pct') p = current * (1 - value / 100);
  else if (mode === 'amount') p = current - value;
  else if (mode === 'set') p = value;
  else throw new Error('Unknown price mode ' + mode);
  p = Math.round(p * 100) / 100;
  if (!(p >= 1)) throw new Error(`Price would be £${p.toFixed(2)} — Vinted minimum is £1`);
  return p;
}

export function randomDelayMs(s = DEFAULT_SETTINGS, rnd = Math.random) {
  const min = Math.max(1, s.delayMinSec), max = Math.max(min, s.delayMaxSec);
  return Math.round((min + rnd() * (max - min)) * 1000);
}

export function summarize(items, s = DEFAULT_SETTINGS) {
  const active = items.filter((i) => i.status === 'active');
  const views = active.reduce((a, i) => a + i.views, 0);
  return {
    active: active.length,
    stale: active.filter((i) => isStale(i, s)).length,
    totalViews: views,
    totalFavs: active.reduce((a, i) => a + i.favs, 0),
    value: active.reduce((a, i) => a + i.price, 0),
  };
}

export function sortItems(items, key, dir = 1) {
  return [...items].sort((a, b) => {
    const x = a[key] ?? -Infinity, y = b[key] ?? -Infinity;
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir;
  });
}

// ---- backup files ----
const BACKUP_APP = 'vinted-manager-backup';
const BACKUP_VERSION = 1;

export function makeBackup(user, entries, now = new Date()) {
  return {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    user: user ? { id: user.id, login: user.login } : null,
    items: entries.map(withoutPhotoLinks),
  };
}

// Vinted's photo URLs may die once the listing is deleted, and restore only uses
// the embedded `photos`, so drop the links to avoid confusion.
function withoutPhotoLinks(entry) {
  const { photos: _links, photo: _cover, ...item } = entry.item || {};
  return { ...entry, item };
}

export function backupFilename(login, now = new Date()) {
  const stamp = now.toISOString().slice(0, 16).replace('T', '_').replace(':', '');
  return `vinted-backup-${(login || 'wardrobe').replace(/[^\w-]/g, '')}-${stamp}.json`;
}

// Returns the backup's item entries, or throws a readable error.
export function parseBackup(text) {
  let d;
  try { d = JSON.parse(text); } catch { throw new Error('Not a JSON file'); }
  if (d?.app !== BACKUP_APP) throw new Error('Not a Vinted Manager backup');
  if (d.version > BACKUP_VERSION) throw new Error(`Backup version ${d.version} is newer than this extension supports`);
  if (!Array.isArray(d.items)) throw new Error('Backup has no items');
  d.items.forEach((e, n) => {
    if (!e?.item?.title) throw new Error(`Item ${n + 1} is missing its details`);
    if (!Array.isArray(e.photos) || !e.photos.length || !e.photos.every((p) => typeof p === 'string' && p.startsWith('data:image/')))
      throw new Error(`"${e.item.title}" has no usable photos`);
  });
  return d.items;
}

export function backupSummary(entry) {
  const it = entry.item;
  return { id: entry.id, title: it.title, price: Number(it.price?.amount ?? it.price_numeric ?? it.price ?? 0), photos: entry.photos.length };
}
