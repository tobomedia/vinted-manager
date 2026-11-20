import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipFiles, parseCSV, photosFor } from '../upload-logic.js';
import { zipParts } from '../../companion/lib/zip.js';
import { buildBatch } from '../../companion/lib/batch.js';

const concat = (parts) => { const n = parts.reduce((a, p) => a + p.length, 0); const o = new Uint8Array(n); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };

test('reads a companion-app zip (stored) end to end', async () => {
  const jpg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  const items = [{ id: 'a', created: 1, title: 'Levi jeans', price: '12', condition: 'Good', photos: [jpg.buffer, jpg.buffer] }];
  const b = buildBatch(items);
  const entries = [{ name: 'items.csv', data: new TextEncoder().encode(b.csv) },
    ...await Promise.all(b.files.map(async (f) => ({ name: f.path, data: new Uint8Array(f.photo) })))];
  const files = await unzipFiles(concat(zipParts(entries, new Date())).buffer);
  const csv = files.find((f) => f.path === 'items.csv');
  const [row] = parseCSV(await csv.file.text());
  assert.equal(row.title, 'Levi jeans');
  const photos = photosFor(row.folder, files);
  assert.equal(photos.length, 2);
  assert.deepEqual(new Uint8Array(await photos[0].file.arrayBuffer()), jpg);
  assert.equal(photos[0].file.type, 'image/jpeg');
});

test('reads a deflated zip made by the zip tool, skipping macOS junk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vm-unzip-'));
  mkdirSync(join(dir, 'batch/levi-jeans'), { recursive: true });
  mkdirSync(join(dir, 'batch/__MACOSX'), { recursive: true });
  const csv = 'folder,title\nlevi-jeans,' + 'Jeans '.repeat(50) + '\n';
  writeFileSync(join(dir, 'batch/items.csv'), csv);
  writeFileSync(join(dir, 'batch/levi-jeans/1.jpg'), 'x'.repeat(1000));
  writeFileSync(join(dir, 'batch/.DS_Store'), 'junk');
  writeFileSync(join(dir, 'batch/__MACOSX/._1.jpg'), 'junk');
  execFileSync('zip', ['-qr', 'b.zip', 'batch'], { cwd: dir });
  const files = await unzipFiles(new Uint8Array(readFileSync(join(dir, 'b.zip'))));
  assert.deepEqual(files.map((f) => f.path).sort(), ['batch/items.csv', 'batch/levi-jeans/1.jpg']);
  assert.equal(await files.find((f) => f.path.endsWith('.csv')).file.text(), csv);
  assert.equal((await files.find((f) => f.path.endsWith('.jpg')).file.text()).length, 1000);
});

test('rejects non-zip files', async () => {
  await assert.rejects(unzipFiles(new TextEncoder().encode('hello').buffer), /valid zip/);
});
