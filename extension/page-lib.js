// Injected into the vinted.co.uk page (MAIN world). All knowledge of Vinted's
// private API lives here — if Vinted changes an endpoint, fix it in this file.
(() => {
  if (window.__vtm) return;

  const cookie = (name) =>
    document.cookie.split('; ').find((c) => c.startsWith(name + '='))?.split('=').slice(1).join('=');

  let csrfToken = null;
  async function csrf() {
    if (csrfToken) return csrfToken;
    csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || null;
    if (!csrfToken) {
      const html = await (await fetch('/', { credentials: 'include' })).text();
      const m =
        html.match(/name="csrf-token" content="([^"]+)"/) ||
        html.match(/CSRF_TOKEN\\?"\s*:\s*\\?"([0-9a-f-]{20,})/i);
      csrfToken = m?.[1] || null;
    }
    if (!csrfToken) throw new Error('Could not find CSRF token — are you logged in to vinted.co.uk?');
    return csrfToken;
  }

  async function req(method, path, body) {
    const headers = { accept: 'application/json, text/plain, */*' };
    const anon = cookie('anon_id');
    if (anon) headers['x-anon-id'] = decodeURIComponent(anon);
    if (method !== 'GET') headers['x-csrf-token'] = await csrf();
    if (body && !(body instanceof FormData)) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const r = await fetch(path, { method, headers, body, credentials: 'include' });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text.slice(0, 300); }
    if (!r.ok) {
      const msg = typeof data === 'string' ? data : data?.message || JSON.stringify(data).slice(0, 300);
      throw new Error(`${method} ${path} → HTTP ${r.status}: ${msg}`);
    }
    return data;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- reads ----
  async function me() {
    const d = await req('GET', '/api/v2/users/current');
    const u = d.user || d;
    return { id: u.id, login: u.login };
  }

  async function items(userId) {
    const all = [];
    for (let page = 1; page <= 20; page++) {
      const d = await req('GET', `/api/v2/wardrobe/${userId}/items?page=${page}&per_page=96&order=newest_first`);
      all.push(...(d.items || []));
      const p = d.pagination;
      if (!p || page >= p.total_pages) break;
      await sleep(400);
    }
    return all;
  }

  const editable = async (id) => (await req('GET', `/api/v2/item_upload/items/${id}`)).item;

  // Build the item payload Vinted's upload form sends, from an editable item.
  function toPayload(it) {
    const ids = (arr) => (arr || []).map((x) => (typeof x === 'object' ? x.id : x));
    return {
      id: it.id ?? null,
      currency: it.currency || it.price?.currency_code || 'GBP',
      temp_uuid: crypto.randomUUID(),
      title: it.title,
      description: it.description,
      brand_id: it.brand_id ?? it.brand_dto?.id ?? null,
      brand: it.brand_dto?.title ?? it.brand ?? null,
      size_id: it.size_id ?? null,
      catalog_id: it.catalog_id,
      isbn: it.isbn ?? null,
      is_unisex: it.is_unisex ?? null,
      status_id: it.status_id,
      video_game_rating_id: it.video_game_rating_id ?? null,
      price: Number(it.price?.amount ?? it.price_numeric ?? it.price),
      package_size_id: it.package_size_id,
      shipment_prices: it.shipment_prices ?? { domestic: null, international: null },
      color_ids: it.color_ids ?? ids([it.color1_id, it.color2_id].filter(Boolean)),
      assigned_photos: (it.photos || []).map((p) => ({ id: p.id, orientation: p.orientation ?? 0 })),
      measurement_length: it.measurement_length ?? null,
      measurement_width: it.measurement_width ?? null,
      item_attributes: it.item_attributes ?? [],
      manufacturer: it.manufacturer ?? null,
      manufacturer_labelling: it.manufacturer_labelling ?? null,
    };
  }

  // ---- writes ----
  // Live listings: Vinted's normal delete. Drafts have their own endpoint, which
  // Vinted's site calls on its core API host (the www host answers 400).
  async function deleteItem(id, opts = {}) {
    if (!opts.draft) {
      await req('POST', `/api/v2/items/${id}/delete`);
      return { deleted: id };
    }
    const core = location.origin.replace('://www.', '://core.');
    await req('DELETE', `${core}/api/v2/item_upload/drafts/${id}`);
    return { deleted: id };
  }

  async function setPrice(id, price) {
    const it = await editable(id);
    const item = { ...toPayload(it), id, price: Math.round(price * 100) / 100 };
    await req('PUT', `/api/v2/item_upload/items/${id}`, { item, feedback_id: null, parcel: null, upload_session_id: crypto.randomUUID() });
    return { id, price: item.price };
  }

  async function fetchBlob(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Photo download failed: HTTP ${r.status}`);
    return r.blob();
  }

  async function uploadPhotoBlob(blob) {
    const fd = new FormData();
    fd.append('photo[type]', 'item');
    fd.append('photo[temp_uuid]', crypto.randomUUID());
    fd.append('photo[file]', blob, 'photo.jpg');
    const d = await req('POST', '/api/v2/photos', fd);
    return { id: d.id, orientation: 0 };
  }

  const copyPhoto = async (url) => uploadPhotoBlob(await fetchBlob(url));

  const blobToDataUrl = (blob) => new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(blob);
  });

  // Decoded by hand: fetch('data:…') can be blocked by the page's CSP.
  function dataUrlToBlob(dataUrl) {
    const [head, b64] = dataUrl.split(',');
    const type = head.match(/^data:([^;]+)/)?.[1] || 'image/jpeg';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
  }

  async function createItem(it, assigned_photos) {
    const item = { ...toPayload(it), id: null, assigned_photos };
    const created = await req('POST', '/api/v2/item_upload/items', {
      item, feedback_id: null, parcel: null, upload_session_id: crypto.randomUUID(),
    });
    const newId = created.item?.id;
    if (!newId) throw new Error('New listing was not created: ' + JSON.stringify(created).slice(0, 200));
    return newId;
  }

  // Relist = create an identical new listing, THEN delete the old one.
  // If creation fails the original is untouched.
  async function relist(id) {
    const it = await editable(id);
    const photos = [];
    for (const p of it.photos || []) {
      photos.push(await copyPhoto(p.full_size_url || p.url));
      await sleep(800 + Math.random() * 1200);
    }
    if (!photos.length) throw new Error('Item has no photos to copy');
    const newId = await createItem(it, photos);
    await sleep(1500 + Math.random() * 2000);
    await deleteItem(id);
    return { oldId: id, newId };
  }

  // Backup = the full editable item + every photo as a data: URL. Photos are
  // embedded because their URLs may stop working once the item is deleted.
  async function backupItem(id) {
    const it = await editable(id);
    const photos = [];
    for (const p of it.photos || []) {
      photos.push(await blobToDataUrl(await fetchBlob(p.full_size_url || p.url)));
      await sleep(200 + Math.random() * 400);
    }
    if (!photos.length) throw new Error('Item has no photos to back up');
    return { id, item: it, photos };
  }

  // Restore = upload the saved photos and create a new listing from the saved item.
  async function restoreItem(backup) {
    const photos = [];
    for (const d of backup.photos) {
      photos.push(await uploadPhotoBlob(dataUrlToBlob(d)));
      await sleep(800 + Math.random() * 1200);
    }
    return { oldId: backup.id, newId: await createItem(backup.item, photos) };
  }

  // ---- bulk upload: lookups (several candidate endpoints, first that works wins) ----
  async function firstOk(paths, pick) {
    let last;
    for (const p of paths) {
      try { const v = pick(await req('GET', p)); if (v && (!Array.isArray(v) || v.length)) return v; }
      catch (e) { last = e; }
    }
    if (last) throw last;
    return null;
  }
  const q = encodeURIComponent;
  const catalogs = () => firstOk(['/api/v2/catalogs', '/api/v2/item_upload/catalogs'], (d) => d.catalogs);
  const brands = (keyword, catalogId) => firstOk(
    [`/api/v2/item_upload/brands?keyword=${q(keyword)}&category_id=${catalogId || ''}`, `/api/v2/brands?keyword=${q(keyword)}`],
    (d) => (d.brands || []).map((b) => ({ id: b.id, title: b.title })));
  const sizes = (catalogId) => firstOk(
    [`/api/v2/item_upload/size_groups?catalog_ids=${catalogId}`, `/api/v2/size_groups?catalog_ids=${catalogId}`],
    (d) => (d.size_groups || []).flatMap((g) => g.sizes || []).map((s) => ({ id: s.id, title: s.title })));
  const conditions = (catalogId) => firstOk(
    [`/api/v2/item_upload/conditions?catalog_id=${catalogId}`, `/api/v2/statuses`],
    (d) => (d.conditions || d.statuses || []).map((c) => ({ id: c.id, title: c.title })));
  const colours = () => firstOk(['/api/v2/item_upload/colors', '/api/v2/colors'],
    (d) => (d.colors || []).map((c) => ({ id: c.id, title: c.title })));
  const packageSizes = (catalogId) => firstOk(
    [`/api/v2/item_upload/package_sizes?catalog_id=${catalogId}`, `/api/v2/package_sizes`],
    (d) => (d.package_sizes || []).map((p) => ({ id: p.id, title: p.title, code: p.code || (p.title || '')[0] })));

  // dataUrl comes from the dashboard (files can't cross the extension message boundary as Blobs)
  const uploadPhoto = (dataUrl) => uploadPhotoBlob(dataUrlToBlob(dataUrl));

  async function createDraft(f) {
    const draft = {
      id: null, currency: 'GBP', temp_uuid: crypto.randomUUID(),
      title: f.title, description: f.description || f.title,
      brand_id: f.brand_id ?? null, brand: f.brand ?? null, size_id: f.size_id ?? null,
      catalog_id: f.catalog_id, isbn: null, is_unisex: null, status_id: f.status_id,
      video_game_rating_id: null, price: f.price, package_size_id: f.package_size_id,
      shipment_prices: { domestic: null, international: null },
      color_ids: f.color_ids || [], assigned_photos: f.photos,
      measurement_length: null, measurement_width: null, item_attributes: [],
      manufacturer: null, manufacturer_labelling: null,
    };
    const d = await req('POST', '/api/v2/item_upload/drafts', {
      draft, feedback_id: null, parcel: null, upload_session_id: crypto.randomUUID(),
    });
    const id = d.draft?.id || d.item?.id;
    if (!id) throw new Error('Draft not created: ' + JSON.stringify(d).slice(0, 200));
    return { id };
  }

  // Read-only health check of each endpoint the tool relies on.
  async function diagnose() {
    const out = [];
    const check = async (name, fn) => {
      try { out.push({ name, ok: true, info: await fn() }); }
      catch (e) { out.push({ name, ok: false, info: String(e.message || e) }); }
    };
    let user, list;
    await check('Logged-in user', async () => { user = await me(); return `${user.login} (#${user.id})`; });
    await check('CSRF token', async () => ((await csrf()) ? 'found' : 'missing'));
    if (user) await check('Wardrobe items', async () => { list = await items(user.id); return `${list.length} items`; });
    if (list?.[0]) await check('Editable item data', async () => {
      const it = await editable(list[0].id);
      return `fields: ${Object.keys(it).slice(0, 12).join(', ')}…`;
    });
    await check('Upload: categories', async () => `${(await catalogs())?.length ?? 0} top-level`);
    await check('Upload: brand search', async () => `"levi" → ${(await brands('levi'))?.[0]?.title ?? 'none'}`);
    await check('Upload: colours', async () => `${(await colours())?.length ?? 0} colours`);
    return out;
  }

  const ops = { me, items, deleteItem, setPrice, relist, backupItem, restoreItem, diagnose, catalogs, brands, sizes, conditions, colours, packageSizes, uploadPhoto, createDraft };
  window.__vtm = {
    async run(op, args) {
      try {
        if (!ops[op]) throw new Error('Unknown op ' + op);
        return { ok: true, data: await ops[op](...args) };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    },
  };
})();
