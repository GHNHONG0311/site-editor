# Site Editor — local version

Runs on your own computer: open a website folder (or download one from GitHub), see it live,
click text to change it, swap images. Changes are written straight into the site's files.

- Install (Windows, PowerShell): `irm https://raw.githubusercontent.com/GHNHONG0311/site-editor/site-editor/apps/local/install.ps1 | iex`
- Start: double-click **Site Editor** on the desktop (or `node server.js`), then use http://localhost:4000
- Sites live in `%USERPROFILE%\site-editor-sites` (override with `SITE_EDITOR_SITES`).
- No dependencies beyond Node.js; Git is needed only for GitHub downloads.
- Tests: `node --test lib/*.test.js`

Ports: 4000 editor, 4001 preview (adds `public/inject.js` to each page), 4100 the site's own dev server.
