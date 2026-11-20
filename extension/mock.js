// Fake API used when the dashboard is opened outside the extension (or with ?mock).
const titles = ['Levi 501 jeans W32', 'Nike Air Max 90 UK9', 'Zara wool coat M', 'North Face fleece L', 'Vintage band tee',
  'Adidas track top S', 'Barbour wax jacket', 'H&M summer dress 10', 'Carhartt beanie', 'Dr Martens 1460 UK7',
  'Ralph Lauren polo M', 'Patagonia shorts', 'Uniqlo puffer XS', 'Mango blazer 12', 'Converse high tops UK5'];

export function mockApi() {
  const now = Date.now() / 1000;
  let items = titles.map((title, i) => ({
    id: 4000000 + i,
    title,
    price: { amount: String(8 + ((i * 7) % 40)), currency_code: 'GBP' },
    view_count: [3, 120, 45, 8, 2, 60, 15, 30, 1, 210, 12, 40, 6, 90, 18][i],
    favourite_count: [0, 14, 4, 1, 0, 7, 2, 3, 0, 22, 1, 5, 0, 9, 2][i],
    created_at_ts: now - 86400 * [35, 3, 10, 22, 40, 6, 18, 12, 28, 2, 16, 9, 30, 5, 21][i],
    is_hidden: i === 7,
    is_reserved: i === 11,
    photo: { url: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="54"><rect width="40" height="54" fill="hsl(${i * 24},45%,60%)"/></svg>`)}` },
  }));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  return {
    async me() { await wait(150); return { id: 1, login: 'demo_seller' }; },
    async items() { await wait(250); return structuredClone(items); },
    async deleteItem(id) { await wait(300); items = items.filter((i) => i.id !== id); return { deleted: id }; },
    async setPrice(id, price) { await wait(300); const it = items.find((i) => i.id === id); it.price.amount = String(price); return { id, price }; },
    async relist(id) {
      await wait(500);
      const it = items.find((i) => i.id === id);
      const copy = { ...it, id: it.id + 100000, view_count: 0, favourite_count: 0, created_at_ts: Date.now() / 1000 };
      items = [copy, ...items.filter((i) => i.id !== id)];
      return { oldId: id, newId: copy.id };
    },
    async backupItem(id) {
      await wait(200);
      const it = items.find((i) => i.id === id);
      return { id, item: structuredClone({ ...it, photos: [it.photo] }), photos: [it.photo.url] };
    },
    async restoreItem(b) {
      await wait(400);
      const copy = { ...structuredClone(b.item), id: b.id + 200000, view_count: 0, favourite_count: 0, created_at_ts: Date.now() / 1000 };
      items = [copy, ...items];
      return { oldId: b.id, newId: copy.id };
    },
    async catalogs() {
      await wait(150);
      return [
        { id: 5, title: 'Men', catalogs: [
          { id: 2050, title: 'Clothing', catalogs: [{ id: 257, title: 'Jeans' }, { id: 1206, title: 'Coats' }, { id: 76, title: 'T-shirts' }] },
          { id: 1231, title: 'Shoes', catalogs: [{ id: 1242, title: 'Trainers' }, { id: 1233, title: 'Boots' }] }] },
        { id: 1904, title: 'Women', catalogs: [
          { id: 4, title: 'Clothing', catalogs: [{ id: 183, title: 'Jeans' }, { id: 10, title: 'Dresses' }] }] },
      ];
    },
    async brands(keyword) {
      await wait(80);
      const all = ["Levi's", 'Nike', 'Adidas', 'Zara', 'The North Face', 'Dr. Martens', 'Barbour', 'Carhartt'];
      return all.filter((b) => b.toLowerCase().replace(/[^a-z]/g, '').includes(keyword.toLowerCase().replace(/[^a-z]/g, '').slice(0, 3)))
        .map((title) => ({ id: 100 + all.indexOf(title), title }));
    },
    async sizes(catalogId) {
      await wait(80);
      if ([257, 183].includes(catalogId)) return ['W28', 'W30', 'W32', 'W34', 'W32 | L32'].map((title, i) => ({ id: 200 + i, title }));
      if ([1242, 1233].includes(catalogId)) return ['UK 7', 'UK 8', 'UK 9', 'UK 10'].map((title, i) => ({ id: 300 + i, title }));
      return ['XS', 'S', 'M', 'L', 'XL'].map((title, i) => ({ id: 400 + i, title }));
    },
    async conditions() { return null; },
    async packageSizes() { return null; },
    async colours() { return ['Black', 'White', 'Blue', 'Red', 'Green', 'Grey', 'Navy'].map((title, i) => ({ id: i + 1, title })); },
    async uploadPhoto(dataUrl) { await wait(60); if (!dataUrl.startsWith('data:image/jpeg')) throw new Error('bad photo'); return { id: Math.floor(Math.random() * 1e6), orientation: 0 }; },
    async createDraft(f) {
      await wait(200);
      if (!f.catalog_id || !f.status_id || !f.photos.length) throw new Error('missing fields');
      return { id: 9000000 + Math.floor(Math.random() * 1000) };
    },
    async diagnose() {
      await wait(300);
      return [
        { name: 'Logged-in user', ok: true, info: 'demo_seller (#1)' },
        { name: 'CSRF token', ok: true, info: 'found' },
        { name: 'Wardrobe items', ok: true, info: `${items.length} items` },
      ];
    },
  };
}
