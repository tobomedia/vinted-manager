// Service worker: opens the dashboard and relays Vinted API calls into a
// logged-in vinted.co.uk tab, so requests use your real session + cookies.
const VINTED = 'https://www.vinted.co.uk';

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

function waitForLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function vintedTab() {
  const [existing] = await chrome.tabs.query({ url: `${VINTED}/*` });
  if (existing) {
    if (existing.status !== 'complete') await waitForLoad(existing.id);
    return existing;
  }
  const tab = await chrome.tabs.create({ url: `${VINTED}/`, active: false });
  await waitForLoad(tab.id);
  return tab;
}

async function run(op, args) {
  const tab = await vintedTab();
  const target = { tabId: tab.id };
  await chrome.scripting.executeScript({ target, world: 'MAIN', files: ['page-lib.js'] });
  const [res] = await chrome.scripting.executeScript({
    target,
    world: 'MAIN',
    func: (op, args) => window.__vtm.run(op, args),
    args: [op, args],
  });
  return res.result;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'vinted') return;
  run(msg.op, msg.args || []).then(sendResponse, (e) =>
    sendResponse({ ok: false, error: String(e?.message || e) })
  );
  return true; // async response
});
