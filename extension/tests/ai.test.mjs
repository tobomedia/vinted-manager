import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDraftRequest, parseDraftResponse, mergeDraft, costUsd, draftSchema, AI_FIELDS, DEFAULT_AI_MODEL } from '../ai.js';
import { toCSV, parseCSV, needsDraft } from '../upload-logic.js';
import { DEFAULT_SETTINGS as SETTINGS } from '../logic.js';

const conds = ['New with tags', 'Very good', 'Good'];

test('request: model, cached lists, images first, structured output', () => {
  const req = buildDraftRequest({
    model: 'claude-haiku-5-5', row: { folder: 'a', notes: 'small mark on cuff', brand: 'Levi\'s' },
    images: ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'], categories: ['Men > Clothing > Jeans'], colours: ['Blue'], conditions: conds,
  });
  assert.equal(req.model, 'claude-haiku-5-5');
  assert.equal(req.system.at(-1).cache_control.type, 'ephemeral');
  assert.match(req.system.at(-1).text, /Men > Clothing > Jeans/);
  const content = req.messages[0].content;
  assert.equal(content.filter((b) => b.type === 'image').length, 4, 'capped at 4 photos');
  assert.deepEqual(content[0].source, { type: 'base64', media_type: 'image/jpeg', data: 'AAA' });
  assert.equal(content.at(-1).type, 'text');
  assert.match(content.at(-1).text, /small mark on cuff/);
  assert.match(content.at(-1).text, /brand: Levi's/);
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.equal(req.output_config.effort, 'low');
  assert.ok(!('thinking' in req) && !('temperature' in req));
});

test('schema: every field required, no extra props, condition enum', () => {
  const s = draftSchema(conds);
  assert.deepEqual(s.required, AI_FIELDS);
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.properties.condition.enum, conds);
  assert.deepEqual(draftSchema([]).properties.condition, { type: 'string' });
});

test('response parsing: text JSON, refusal, truncation, junk', () => {
  const ok = parseDraftResponse({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"title":" Jeans ","description":"d","category":"c","brand":"","size":"","condition":"Good","colour":"Blue","parcel":"M"}' }] });
  assert.equal(ok.title, 'Jeans');
  assert.equal(ok.brand, '');
  assert.throws(() => parseDraftResponse({ stop_reason: 'refusal', content: [] }), /declined/);
  assert.throws(() => parseDraftResponse({ stop_reason: 'max_tokens', content: [] }), /ran out/);
  assert.throws(() => parseDraftResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'nope' }] }), /valid JSON/);
});

test('merge fills only blanks and never touches price', () => {
  const { row, filled } = mergeDraft(
    { title: 'My title', price: '12', brand: '  ', notes: 'n' },
    { title: 'AI title', description: 'AI desc', brand: 'Nike', category: 'X', size: '', condition: 'Good', colour: 'Red', parcel: 'S' });
  assert.equal(row.title, 'My title');
  assert.equal(row.brand, 'Nike');
  assert.equal(row.price, '12');
  assert.equal(row.size, undefined);
  assert.deepEqual(filled, ['description', 'category', 'brand', 'condition', 'colour', 'parcel']);
});

test('cost from usage', () => {
  const c = costUsd('claude-haiku-5-5', { input_tokens: 5000, cache_read_input_tokens: 40000, output_tokens: 400 });
  assert.ok(Math.abs(c - (5000 * 0.1 + 40000 * 0.01 + 400 * 0.5) / 1e6) < 1e-12);
  assert.ok(costUsd('claude-opus-5-5', { output_tokens: 1000 }) > costUsd('claude-haiku-5-5', { output_tokens: 1000 }));
});

test('settings default to Haiku with no key', () => {
  assert.equal(SETTINGS.aiModel, DEFAULT_AI_MODEL);
  assert.equal(SETTINGS.aiKey, '');
});

test('edited rows save back to CSV and re-read identically', () => {
  const rows = [{ folder: '001-a', title: 'Coat, wool "long"', description: 'line1\nline2', price: '20', notes: 'n', category: 'Women > Coats' }];
  const [back] = parseCSV(toCSV(rows));
  for (const k of Object.keys(rows[0])) assert.equal(back[k], rows[0][k]);
  assert.equal(needsDraft(back), true);
  assert.equal(needsDraft({ title: 't', description: 'd', category: 'c', condition: 'Good', colour: 'Red' }), false);
});
