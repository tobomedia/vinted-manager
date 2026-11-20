// Claude drafting for bulk upload: photos + notes → suggested listing fields.
// The request/response helpers are pure (unit-tested); draftListing() does the fetch.
//
// The extension has no build step and MV3 forbids remote code, so this calls the
// Messages API over plain fetch instead of bundling the SDK. The key is the user's
// own, kept in chrome.storage.local and sent only to api.anthropic.com.

export const AI_MODELS = [
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — cheapest, well under 1p per item', in: 0.10, out: 0.50 },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — balanced, about 1–2p per item', in: 2, out: 10 },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 — best quality, about 3–5p per item', in: 4, out: 20 },
];
export const DEFAULT_AI_MODEL = 'claude-haiku-5-5';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MAX_PHOTOS = 4; // the first few photos say enough; keeps the cost down

// Fields Claude may fill. Price is never touched: that's the seller's call.
export const AI_FIELDS = ['title', 'description', 'category', 'brand', 'size', 'condition', 'colour', 'parcel'];

const INSTRUCTIONS = `You write second-hand clothing and goods listings for Vinted UK.
You get photos of one item plus the seller's notes and any fields they have already filled in.
Return the listing fields as JSON.

Rules:
- Use only what the photos and notes show. Never invent measurements, materials, flaws or sizes you can't see or weren't told.
- title: up to 60 characters, brand first when known, then item type and key detail (e.g. "Levi's 501 straight leg jeans W32 L32").
- description: 2-5 short sentences in UK English, friendly and factual. Include measurements, flaws and fit from the notes. No hashtags, no emojis, no price.
- category: copy one path EXACTLY from the category list below, choosing the most specific match. Empty string if nothing fits.
- brand: as printed on a visible label or logo, or as given in the notes. Empty string if unknown — don't guess.
- size: as printed on the label or given in the notes (e.g. "M", "UK 10", "W32 | L32"). Empty string if unknown.
- condition: pick the closest; when unsure between two, pick the lower one.
- colour: one or two colours from the colour list, comma separated.
- parcel: S for small/light items (tops, accessories), M for most clothes and shoes, L for coats, boots and bulky items.
- If the seller already filled a field, keep their value.`;

export function draftSchema(conditions = []) {
  const str = { type: 'string' };
  return {
    type: 'object',
    properties: {
      title: str, description: str, category: str, brand: str, size: str,
      condition: conditions.length ? { type: 'string', enum: conditions } : str,
      colour: str,
      parcel: { type: 'string', enum: ['S', 'M', 'L'] },
    },
    required: AI_FIELDS,
    additionalProperties: false,
  };
}

// The category and colour lists are large and identical for every item, so they sit
// in a cached system block: after the first item they're billed at a tenth of the price.
export function buildDraftRequest({ model, row, images, categories = [], colours = [], conditions = [] }) {
  const known = AI_FIELDS.filter((k) => row[k]).map((k) => `${k}: ${row[k]}`).join('\n');
  const text = [
    `Seller's notes: ${row.notes?.trim() || '(none)'}`,
    known ? `Already filled in by the seller:\n${known}` : 'Nothing filled in yet.',
    'Write the listing fields for this item.',
  ].join('\n\n');
  return {
    model,
    max_tokens: 8000,
    system: [
      { type: 'text', text: INSTRUCTIONS },
      {
        type: 'text',
        text: `Category list (one per line):\n${categories.join('\n')}\n\nColour list: ${colours.join(', ')}\n\nConditions: ${conditions.join(', ')}`,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{
      role: 'user',
      content: [
        ...images.slice(0, MAX_PHOTOS).map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })),
        { type: 'text', text },
      ],
    }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema: draftSchema(conditions) } },
  };
}

export function parseDraftResponse(res) {
  if (res.stop_reason === 'refusal') throw new Error('Claude declined to describe this item');
  if (res.stop_reason === 'max_tokens') throw new Error('Claude ran out of room — try again');
  const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let out;
  try { out = JSON.parse(text); } catch { throw new Error("Claude's reply wasn't valid JSON — try again"); }
  const clean = {};
  for (const k of AI_FIELDS) clean[k] = typeof out[k] === 'string' ? out[k].trim() : '';
  return clean;
}

// Fill only the blanks: anything the seller typed wins.
export function mergeDraft(row, draft) {
  const next = { ...row };
  const filled = [];
  for (const k of AI_FIELDS) {
    if (!String(row[k] ?? '').trim() && draft[k]) { next[k] = draft[k]; filled.push(k); }
  }
  return { row: next, filled };
}

// Cost in US dollars from the response's usage block.
export function costUsd(model, usage = {}) {
  const m = AI_MODELS.find((x) => x.id === model) || AI_MODELS[0];
  const M = 1e6;
  return ((usage.input_tokens || 0) * m.in
    + (usage.cache_creation_input_tokens || 0) * m.in * 1.25
    + (usage.cache_read_input_tokens || 0) * m.in * 0.1
    + (usage.output_tokens || 0) * m.out) / M;
}

export async function draftListing({ apiKey, ...opts }) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2026-10-21',
      // required for calls made from a browser page; the key is the user's own
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(buildDraftRequest(opts)),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || res.statusText;
    if (res.status === 401) throw new Error('API key was rejected — check it in Settings');
    if (res.status === 429) throw new Error(`Rate limited by Anthropic — wait a minute and try again (${msg})`);
    throw new Error(`Anthropic API ${res.status}: ${msg}`);
  }
  return { draft: parseDraftResponse(body), usage: body.usage, cost: costUsd(opts.model, body.usage) };
}
