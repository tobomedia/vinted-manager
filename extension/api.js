import { mockApi } from './mock.js';

export const IN_EXT = !!globalThis.chrome?.runtime?.id;
export const MOCK = !IN_EXT || new URLSearchParams(location.search).has('mock');

const OPS = ['me', 'items', 'deleteItem', 'setPrice', 'relist', 'backupItem', 'restoreItem', 'diagnose',
  'catalogs', 'brands', 'sizes', 'conditions', 'colours', 'packageSizes', 'uploadPhoto', 'createDraft'];

function realApi() {
  const call = async (op, ...args) => {
    const r = await chrome.runtime.sendMessage({ type: 'vinted', op, args });
    if (!r) throw new Error('No response from extension background');
    if (!r.ok) throw new Error(r.error);
    return r.data;
  };
  return Object.fromEntries(OPS.map((op) => [op, (...a) => call(op, ...a)]));
}

export const api = MOCK ? mockApi() : realApi();
