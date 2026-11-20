# Vinted Manager

Tools for managing a vinted.co.uk wardrobe.

| Folder | What it is |
|---|---|
| [`extension/`](extension/) | Chrome extension: dashboard, bulk delete / price change / relist, backup & restore, bulk upload from CSV + photo folders. See [extension/README.md](extension/README.md). |
| `companion/` | *(planned)* Phone web app to photograph items and export a CSV + photo folders for the extension's bulk upload. |

**Caveat:** Vinted has no public seller API. The extension uses the same private endpoints as the website, inside your logged-in tab. Automation is against Vinted's terms, so use it at your own risk and keep batches small.
