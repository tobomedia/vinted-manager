# Vinted Manager (Chrome extension)

A dashboard for your vinted.co.uk wardrobe. It flags underperforming items and lets you **bulk delete**, **bulk change prices**, **relist (bump)** and **bulk upload from a spreadsheet** (saved as drafts).

## Install (2 min)
1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick this `extension/` folder.
3. Log in to https://www.vinted.co.uk in the same Chrome profile.
4. Click the extension's toolbar icon. The dashboard opens in a new tab.
5. Click **Check connection**. Every line should show ✓.

**Dry run is ON by default**, so actions are only logged. Once you're happy, turn it off in **Settings**.

## Features
- **Dashboard**: shows views, favourites, views/day and age for each item, plus totals.
- **Underperforming filter**: by default, items listed 14+ days ago with fewer than 20 views. You can change both numbers in Settings.
- **Export backup**: saves the selected items to a `.json` file, including the photos themselves (so it still works after the listings are deleted). Export only reads from Vinted, so it runs even with dry run on.
- **Bulk delete**: asks for confirmation first, because deleting is permanent. "Download a backup first" is ticked by default. Any item that fails to back up is not deleted.
- **Restore backup**: pick a backup file and each item is re-created as a new listing. Items still in your wardrobe are skipped so you don't get duplicates. Uses the same pauses and dry run setting as the other bulk actions.
- **Bulk price change**: reduce by %, reduce by £, or set an exact price, with a live preview. Won't go below £1.
- **Relist**: creates a new copy of the item (same photos and details) first, and only deletes the old one if that worked. Views and favourites on the old listing are lost.
- Random 20–45s pause between actions. There's a **Stop** button and an activity log.

## Bulk upload (Bulk upload tab)
1. Click **Download CSV template** and fill it in (Excel is fine, but save as CSV).
2. Put it in a folder alongside one sub-folder of photos per item:
   ```
   my-items/
   ├── items.csv
   ├── levi-jeans/    1.jpg 2.jpg 3.jpg   ← photos upload in file-name order
   └── nike-air-max/  1.jpg 2.jpg
   ```
3. Click **Choose folder…** and pick `my-items`. The preview shows each row as **Ready**, or highlights in red what needs fixing.
4. Click **Upload N as drafts**. Then review and publish the drafts in the Vinted app.

| Column | Required | Example | Notes |
|---|---|---|---|
| folder | ✓ | `levi-jeans` | sub-folder name holding that item's photos (JPG/PNG/WebP, max 20) |
| title | ✓ | `Levi's 501 jeans W32` | |
| description | | `Barely worn` | line breaks OK inside quotes |
| price | ✓ | `18` or `£18.50` | min £1 |
| category | ✓ | `Men > Clothing > Jeans` | just the last part (`Trainers`) works if it's unique |
| brand | | `Levi's` | matched against Vinted's brand list |
| size | | `W32`, `UK 9`, `M` | must match one of Vinted's sizes for that category |
| condition | ✓ | `Very good` | New with tags / New without tags / Very good / Good / Satisfactory |
| colour | | `Black / White` | up to 2 colours |
| parcel | | `S`, `M`, `L` | defaults to M |

If the tool can't match a name, you can type Vinted's numeric ID in that column instead. After editing the CSV, click **Re-pick folder** so the edited file is read fresh. Photos are resized to a maximum of 1600px before uploading. iPhone HEIC photos aren't supported, so export them as JPG.

## How it works / caveats
Vinted has no public API for sellers. The extension runs requests inside your logged-in vinted.co.uk tab, using the same private endpoints the website uses. That means:
- **Account risk.** Automation is against Vinted's terms. Keep batches small (relist roughly 10–15 a day) and keep the delays.
- **Endpoints can change without notice.** All Vinted-specific code is in `page-lib.js`. If **Check connection** shows a ✗, that's the file to fix.

## Files
| File | Purpose |
|---|---|
| `page-lib.js` | All Vinted API calls (runs in the vinted.co.uk page) |
| `background.js` | Opens the dashboard and passes its calls to a Vinted tab |
| `dashboard.*` | The UI |
| `logic.js`, `upload-logic.js` | Pure logic (stale rules, prices, CSV parsing, name→ID matching), unit-tested |
| `upload.js` | Bulk upload tab |
| `api.js` | Sends dashboard calls to the extension background (or to the mock) |
| `mock.js` | Demo data: open `dashboard.html` from a local server to try the UI without Vinted |

Dev: `npm test` runs the unit tests. To use demo mode, run `python3 -m http.server` in this folder, then open `/dashboard.html`.

## Roadmap
- AI-drafted listings from photos (optional, needs an Anthropic API key)
- Suggested relists (rule-based)
