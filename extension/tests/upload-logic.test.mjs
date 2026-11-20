import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, flattenCatalogs, matchCategory, matchByTitle, matchParcel, photosFor, basicErrors, parsePrice, TEMPLATE_CSV, DEFAULT_CONDITIONS } from '../upload-logic.js';

test('parseCSV: quotes, newlines, BOM, headers, blank lines', () => {
  const rows = parseCSV('﻿Folder,Title,Price,Color\r\na,"Hi, ""you""",5,Red\n\nb,"two\nlines",6,\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'Hi, "you"');
  assert.equal(rows[0].colour, 'Red');
  assert.equal(rows[1].title, 'two\nlines');
  assert.equal(rows[1]._row, 4 - 1); // blank line skipped
});

test('parseCSV: semicolon delimited (Excel EU)', () => {
  assert.equal(parseCSV('folder;title;price\nx;Jeans;12,50')[0].price, '12,50');
});

test('template parses with all columns', () => {
  const [r] = parseCSV(TEMPLATE_CSV);
  assert.equal(r.folder, 'levi-jeans');
  assert.equal(r.parcel, 'M');
  assert.match(r.description, /\n/);
});

test('parsePrice', () => {
  assert.equal(parsePrice('£12.5'), 12.5);
  assert.equal(parsePrice('12,50'), 12.5);
  assert.equal(parsePrice('0.5'), null);
  assert.equal(parsePrice('abc'), null);
});

const tree = [
  { id: 5, title: 'Men', catalogs: [
    { id: 50, title: 'Clothing', catalogs: [{ id: 257, title: 'Jeans' }, { id: 76, title: 'Coats' }] },
    { id: 51, title: 'Shoes', catalogs: [{ id: 1231, title: 'Trainers' }] }] },
  { id: 1904, title: 'Women', catalogs: [{ id: 4, title: 'Clothing', catalogs: [{ id: 183, title: 'Jeans' }] }] },
];
const leaves = flattenCatalogs(tree);

test('flattenCatalogs', () => {
  assert.equal(leaves.length, 4);
  assert.deepEqual(leaves[0], { id: 257, path: 'Men > Clothing > Jeans', parts: ['Men', 'Clothing', 'Jeans'] });
});

test('matchCategory: full path, partial path, ambiguity, id, typo hint', () => {
  assert.equal(matchCategory('Men > Clothing > Jeans', leaves).id, 257);
  assert.equal(matchCategory('women/jeans', leaves).id, 183);
  assert.equal(matchCategory('Trainers', leaves).id, 1231);
  assert.match(matchCategory('Jeans', leaves).error, /Ambiguous/);
  assert.equal(matchCategory('999', leaves).id, 999);
  assert.match(matchCategory('Jean', leaves).error, /Did you mean.*Jeans/);
});

test('matchByTitle: case, punctuation, id, error lists options', () => {
  assert.equal(matchByTitle('very GOOD', DEFAULT_CONDITIONS, 'Condition').id, 2);
  const brands = [{ id: 10, title: "Levi's" }];
  assert.equal(matchByTitle('levis', brands, 'Brand').id, 10);
  assert.equal(matchByTitle('42', brands, 'Brand').id, 42);
  assert.match(matchByTitle('Mint', DEFAULT_CONDITIONS, 'Condition').error, /Options: New with tags/);
});

test('matchParcel defaults to medium', () => {
  assert.equal(matchParcel('').label, 'Medium');
  assert.equal(matchParcel('large').id, 3);
  assert.match(matchParcel('XL').error, /S, M or L/);
});

test('photosFor and basicErrors', () => {
  const files = ['shop/items.csv', 'shop/levi-jeans/10.jpg', 'shop/levi-jeans/2.JPG', 'shop/other/1.jpg', 'shop/levi-jeans/notes.txt'].map((path) => ({ path }));
  assert.deepEqual(photosFor('Levi-Jeans', files).map((f) => f.path), ['shop/levi-jeans/2.JPG', 'shop/levi-jeans/10.jpg']);
  assert.deepEqual(basicErrors({ folder: 'x', title: 'Jeans', price: '0', category: 'c', condition: 'd' }, []),
    ['Price "0" isn\'t valid (min £1)', 'No photos found in folder "x"']);
  assert.deepEqual(basicErrors({ folder: 'a', title: 'Good title', price: '5', category: 'c', condition: 'd' }, [{}]), []);
});
