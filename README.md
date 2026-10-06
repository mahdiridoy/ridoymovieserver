# MovieBox Web — ridoymovieserver

**Live site:** https://mahdiridoy.github.io/ridoymovieserver/

Static, dependency-free browser version of [MovieBox-TUI](https://github.com/mesamirh/MovieBox-Tui) — search, details, in-browser player, favorites, history, Live TV (M3U import) and Stremio addons. Plain HTML/CSS/JS (37 JS files, no npm, no bundler, no framework). Local-only data, zero telemetry.

## Repository layout

| Path | Purpose |
| :--- | :--- |
| `web/` | The entire static app — upload artifact root (`index.html` sits at the site root) |
| `.github/workflows/web.yml` | GitHub Pages deploy workflow (integrity gate → upload → deploy) |
| `WEB_MIGRATION.md` | Migration plan and architecture notes for the web conversion |
| `FINAL_QA_REPORT.md` | Pre-deploy QA evidence (automated, responsive, functional, subpath) |
| `FINAL_DEPLOYMENT_REPORT.md` | Deployment record and live-site verification evidence |
| `web-check-imports.cjs` | Import-integrity checker — run `node web-check-imports.cjs` |
| `LICENSE-MIT`, `LICENSE-APACHE` | Dual license |

## Deployment

Pushing to `main` with changes under `web/**` or `.github/workflows/web.yml` triggers the **Deploy MovieBox Web** workflow:

1. **Verify static app integrity** — required files present, no `innerHTML=` / `eval(` / `new Function` outside `web/js/utils/sanitize.js`
2. `actions/configure-pages`
3. `actions/upload-pages-artifact` with `path: web`
4. `actions/deploy-pages`

GitHub Pages must use the **GitHub Actions** build type (Settings → Pages → Build and deployment → Source: **GitHub Actions**). The workflow can also be run manually via **workflow_dispatch**.

**Production URL:** https://mahdiridoy.github.io/ridoymovieserver/ — served from the repo root with hash routes (`#/search?q=...`, `#/watch/...`, `#/tv`, `#/favorites`, …), so any route deep-links without server rewrites.

## Run locally

```bash
python -m http.server 8080 -d web
```

Open http://localhost:8080 — hash routes work on any static host.

## Proxy

MovieBox, 4KHDHub and Dramachi send no CORS headers, so set a proxy URL in *Settings → Data & network* (`POST {proxy}` with `{url, method, headers, body}` → `{status, headers, body}`). **No proxy server ships with this repository** — each user configures their own.

## Known limitations

1. **CORS-blocked DASH/HLS playback** — many stream hosts send no cross-origin permission headers; the player fails fast with an honest in-page explanation (and copy-URL for external players). Requires server-side CORS headers to play in-browser.
2. **BDIX intranet providers** (`circleftp.net:5000`, `172.16.50.x`) only resolve on BDIX networks — by design.
3. **Codec support** depends on the browser/OS (e.g. some HEVC/AC-3 variants).
4. The service worker precaches the shell only; other assets use runtime stale-while-revalidate (documented design).

## Privacy

Zero telemetry, analytics, or user tracking. History, favorites, and settings remain in the browser's local storage.

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE). Based on [MovieBox-TUI](https://github.com/mesamirh/MovieBox-Tui).

## Disclaimer

MovieBox Web does not host or store media. It plays publicly available streams. Users must comply with local laws.
