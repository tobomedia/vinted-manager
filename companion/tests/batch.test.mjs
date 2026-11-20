import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBatch, toCSV, slug, warnings, parsePrice, batchFilename, displayName } from '../lib/batch.js';
import { zipParts, crc32 } from '../lib/zip.js';
// The extension's own CSV parser: the export must round-trip through it.
import { parseCSV } from '../../extension/upload-logic.js';

const photo = (s) => new TextEncoder().encode(s);

test('slug and display name', () => {
  assert.equal(slug("Levi's 501 – Größe W32!"), 'levi-s-501-grosse-w32');
  assert.equal(slug('   '), '');
  assert.equal(displayName({ brand: 'Nike', size: 'M' }), 'Nike M');
  assert.equal(displayName({}), 'Untitled item');
});

test('price parsing and warnings', () => {
  assert.equal(parsePrice('£12.5'), 12.5);
  assert.equal(parsePrice('8,99'), 8.99);
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice('abc'), null);
  assert.deepEqual(warnings({ photos: [], price: '' }), ['No photos', 'No price']);
  assert.deepEqual(warnings({ photos: [1], price: '0.5' }), ['Price under £1']);
  assert.deepEqual(warnings({ photos: [1], price: '5' }), []);
});

test('batch → CSV round-trips through the extension parser', () => {
  const items = [
    { title: 'Zara coat', price: '15', brand: 'Zara', size: 'M', condition: 'Very good', notes: 'small mark, "left" sleeve\nsecond line', photos: [photo('a'), photo('b')] },
    { brand: 'Nike', size: 'L', price: '', photos: [photo('c')] },
    { title: 'No photos yet', photos: [] },
    { title: 'Zara coat', price: '9', photos: [photo('d')] },
  ];
  const b = buildBatch(items);
  assert.equal(b.count, 3);
  assert.deepEqual(b.skipped.map((i) => i.title), ['No photos yet']);
  assert.deepEqual(b.files.map((f) => f.path), ['001-zara-coat/1.jpg', '001-zara-coat/2.jpg', '002-nike-l/1.jpg', '003-zara-coat/1.jpg']);

  const rows = parseCSV(b.csv);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].folder, '001-zara-coat');
  assert.equal(rows[0].price, '15.00');
  assert.equal(rows[0].condition, 'Very good');
  assert.equal(rows[0].notes, 'small mark, "left" sleeve\nsecond line');
  assert.equal(rows[1].title, '');
  assert.equal(rows[1].brand, 'Nike');
});

test('CSV escaping', () => {
  assert.ok(toCSV([]).startsWith('﻿folder,title'));
  assert.match(toCSV([{ title: 'a,b' }]), /,"a,b",/);
});

test('zip is valid and unzips to the same files', () => {
  const b = buildBatch([{ title: 'Coat', price: '5', photos: [photo('jpeg-bytes-1'), photo('jpeg-bytes-2')] }]);
  const entries = [{ name: 'items.csv', data: photo(b.csv) }, ...b.files.map((f) => ({ name: f.path, data: f.photo }))];
  const parts = zipParts(entries, new Date(2026, 10, 20, 12, 30));
  const dir = mkdtempSync(join(tmpdir(), 'vc-zip-'));
  const zipPath = join(dir, 'batch.zip');
  writeFileSync(zipPath, Buffer.concat(parts.map((p) => Buffer.from(p))));
  execFileSync('unzip', ['-tq', zipPath]); // throws if CRCs or structure are wrong
  execFileSync('unzip', ['-q', zipPath, '-d', join(dir, 'out')]);
  assert.equal(readFileSync(join(dir, 'out', '001-coat', '2.jpg'), 'utf8'), 'jpeg-bytes-2');
  assert.equal(parseCSV(readFileSync(join(dir, 'out', 'items.csv'), 'utf8'))[0].folder, '001-coat');
});

test('crc32 known value and filename', () => {
  assert.equal(crc32(photo('123456789')), 0xcbf43926);
  assert.equal(batchFilename(new Date(2026, 10, 20, 9, 5)), 'vinted-batch-2026-11-20_0905.zip');
});
