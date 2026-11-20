import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeItem, isStale, newPrice, randomDelayMs, summarize, sortItems, DEFAULT_SETTINGS } from '../logic.js';

const NOW = Date.UTC(2026, 10, 18);
const daysAgo = (d) => (NOW - d * 86400000) / 1000; // unix seconds

test('normalizeItem handles price object, ts seconds, status', () => {
  const i = normalizeItem({ id: 1, title: 'Jeans', price: { amount: '12.50', currency_code: 'GBP' }, view_count: 5, favourite_count: 2, photo: { high_resolution: { timestamp: daysAgo(10) } } }, NOW);
  assert.equal(i.price, 12.5);
  assert.equal(Math.round(i.ageDays), 10);
  assert.equal(i.status, 'active');
  assert.equal(i.viewsPerDay, 0.5);
});

test('normalizeItem status priority & missing date', () => {
  assert.equal(normalizeItem({ id: 2, is_hidden: true, is_reserved: true }, NOW).status, 'hidden');
  assert.equal(normalizeItem({ id: 3, is_closed: true }, NOW).status, 'sold');
  assert.equal(normalizeItem({ id: 4 }, NOW).ageDays, null);
});

test('isStale uses age + views and only active items', () => {
  const mk = (age, views, extra = {}) => normalizeItem({ id: 1, view_count: views, created_at_ts: daysAgo(age), ...extra }, NOW);
  assert.equal(isStale(mk(20, 5)), true);
  assert.equal(isStale(mk(20, 25)), false);
  assert.equal(isStale(mk(5, 0)), false);
  assert.equal(isStale(mk(20, 5, { is_hidden: true })), false);
  assert.equal(isStale(mk(8, 5), { ...DEFAULT_SETTINGS, staleDays: 7 }), true);
});

test('newPrice modes and floor', () => {
  assert.equal(newPrice(10, 'pct', 15), 8.5);
  assert.equal(newPrice(10, 'amount', 2), 8);
  assert.equal(newPrice(10, 'set', 6.999), 7);
  assert.throws(() => newPrice(1.5, 'amount', 1), /minimum/);
  assert.throws(() => newPrice(10, 'x', 1), /Unknown/);
});

test('randomDelayMs within bounds', () => {
  assert.equal(randomDelayMs({ delayMinSec: 20, delayMaxSec: 45 }, () => 0), 20000);
  assert.equal(randomDelayMs({ delayMinSec: 20, delayMaxSec: 45 }, () => 1), 45000);
  assert.equal(randomDelayMs({ delayMinSec: 30, delayMaxSec: 10 }, () => 1), 30000);
});

test('summarize and sort', () => {
  const items = [
    normalizeItem({ id: 1, price: 10, view_count: 3, created_at_ts: daysAgo(30) }, NOW),
    normalizeItem({ id: 2, price: 5, view_count: 50, favourite_count: 4, created_at_ts: daysAgo(30) }, NOW),
    normalizeItem({ id: 3, price: 99, is_closed: true }, NOW),
  ];
  assert.deepEqual(summarize(items), { active: 2, stale: 1, totalViews: 53, totalFavs: 4, value: 15 });
  assert.deepEqual(sortItems(items, 'views', -1).map((i) => i.id), [2, 1, 3]);
});

import { makeBackup, parseBackup, backupFilename, backupSummary } from '../logic.js';

test('backup round-trips and validates', () => {
  const entry = { id: 7, item: { title: 'Coat', price: { amount: '20.00' } }, photos: ['data:image/jpeg;base64,AAA='] };
  const file = JSON.stringify(makeBackup({ id: 1, login: 'me', extra: 'x' }, [entry], new Date(NOW)));
  assert.deepEqual(parseBackup(file), [entry]);
  const linked = { ...entry, item: { ...entry.item, photos: [{ url: 'https://x/a.jpg' }], photo: { url: 'https://x/b.jpg' } } };
  const stripped = makeBackup(null, [linked]).items[0];
  assert.deepEqual(stripped, entry);
  assert.ok(!JSON.stringify(stripped).includes('https://'));
  assert.deepEqual(backupSummary(entry), { id: 7, title: 'Coat', price: 20, photos: 1 });
  assert.throws(() => parseBackup('nope'), /JSON/);
  assert.throws(() => parseBackup('{"app":"other"}'), /Not a Vinted Manager/);
  const bad = makeBackup(null, [{ ...entry, photos: ['https://x/y.jpg'] }]);
  assert.throws(() => parseBackup(JSON.stringify(bad)), /no usable photos/);
  assert.equal(backupFilename('a b/c', new Date(NOW)), 'vinted-backup-abc-2026-11-18_0000.json');
});
