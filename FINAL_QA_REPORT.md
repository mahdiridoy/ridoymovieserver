# FINAL_QA_REPORT — MovieBox Web (`web/` static conversion)

**Date:** 2026-10-06
**Scope:** Full QA / review / fix pass over the `web/` static conversion of MovieBox-TUI.
**Environment:** Headless Edge (CDP), local static server with `/MovieBox-Tui/` subpath simulation + test relay (`/relay`, fixture M3U) — harness located in `C:\Users\engrm\AppData\Local\Temp\opencode\moviebox-qa\`.
**Baseline → Final:** 41 PASS / 5 FAIL → **46 PASS / 0 FAIL**.

---

## 1. Automated Tests

| # | Check | Method | Result |
|---|-------|--------|--------|
| A1 | JS syntax (`node --check`) | 37 files | **PASS** — 0 failures |
| A2 | Import integrity | `node web-check-imports.cjs` | **PASS** — 37 files scanned, 0 problems |
| A3 | CI integrity gate (`.innerHTML=`, `eval(`, `new Function`) | exact `web.yml` equivalent (excludes sanctioned `utils/sanitize.js`) | **PASS** — 0 hits |
| A4 | Security scan | credentials / telemetry / cookie writes / insecure http / CDN allowlist | **PASS** — 0 credentials, 0 telemetry, 0 cookie writes; all `http://` are BDIX intranet hosts + SVG namespaces; CDN = pinned jsdelivr `hls.js@1.5.17`, `dashjs@4.7.4` + Cinemeta manifest (documented) |
| A5 | Asset check | `asset-check.cjs` — 46 files on disk | **PASS** — 0 missing assets (SW precaches shell only by design) |
| A6 | Runtime QA suite | headless Edge + CDP, full run after fixes | **PASS — 46/46, 0 FAIL** |
| A7 | Performance | cold load (subpath + SW) | **PASS** — load 822 ms (< 5 s), DCL 817 ms, 53 resources, 457 KB transfer |

---

## 2. Responsive Tests (6 key routes per width; horizontal-overflow check)

| Viewport | 360 | 375 | 390 | 414 | 768 | 1024 | 1366 | 1920 |
|---|---|---|---|---|---|---|---|---|
| Result | **PASS** | **PASS** | **PASS** | **PASS** | **PASS** | **PASS** | **PASS** | **PASS** |

Pre-fix baseline: 360 / 375 / 390 / 414 **FAIL** (`scrollWidth=470` — see FIX-1); 768–1920 already PASS. Post-fix: all 8 widths PASS (route sweep confirms no regression elsewhere).

---

## 3. Functional Tests

| Area | Result | Evidence |
|---|---|---|
| Home | **PASS** | Renders via test relay, hero present, 57 catalog links, `empty=false`, 0 app errors |
| Search | **PASS** | 9 result cards; cold deep-link `#/search?q=interstellar` syncs into `#top-search-input` (`top-input synced`) |
| Details | **PASS** | `Interstellar [Hindi]` title + Play CTA; favorite toggle persists across reload (`favorites=1`) |
| Series | **PASS** | `Breaking Bad [Hindi]`, 5 seasons / 7 episodes; season switch → S2, 13 episodes |
| Player | **PASS** | In-page mount with honest CORS fatal (`inpage-error` + explanation); leave button returns to `#/series/…` (actual remote playback = known limitation, §4) |
| Favorites | **PASS** | Toggle + persistence (Details); `#/favorites` deep-link reload preserved (Routing) |
| History | **PASS** | History entry listed (`rows=1`), clear-all works (`-> cleared`) |
| Settings | **PASS** | Proxy fields seeded; theme `mocha → latte` persisted; `proxyMode never → always` persisted across reload |
| Live TV | **PASS** | Fixture M3U import → 5 channels render; search filter → 2 |
| Addons | **PASS** | Invalid URL → honest toast; Cinemeta install → terminal state `installed` (v3.0.14), no crash |
| Routing | **PASS** | 4/4 — root `/` → `#/home`; unknown hash → "Page not found" + Go home; back/forward + active-nav tracking; deep-link reload preserves route |
| GitHub Pages | **PASS** | 4/4 under `/MovieBox-Tui/` subpath — assets/CSS/JS resolve (0 same-origin 404s), hash route works, service worker registers with `scope=…/MovieBox-Tui/` active, `manifest.json` fetches (3 icons) |

Route sweep (all routes incl. `/`, `/home`, `/movies`, `/series`, `/drama`, `/search`, details/series/drama deep links, `/tv`, `/favorites`, `/history`, `/addons`, `/settings`, `/about`, `/watch/…`, 404): **19/19 PASS**, 0 app errors, 0 same-origin 404s.
A11y smoke (landmarks + accessible names, 4 routes): **PASS**.

---

## 4. Known Browser Limitations (not defects)

1. **CORS-blocked DASH/HLS playback** — remote stream hosts send no cross-origin permission headers; the player shows an honest in-page fatal error with explanation instead of breaking (verified PASS). Requires server-side CORS headers to work.
2. **BDIX intranet hosts** (`circleftp.net:5000`, `172.16.50.x`) unreachable outside the BDIX network — by design.
3. **Codec support** depends on the browser/OS (e.g., some HEVC/AC-3 variants).
4. **Service worker precaches the shell only**; other assets use runtime stale-while-revalidate (documented design, not stale-cache bug).

---

## 5. Fixed Issues

| ID | Defect | Fix (file:line) | Evidence before → after |
|---|---|---|---|
| FIX-1 | Horizontal page scroll on viewports ≤ 414 px (360/375/390/414 all FAIL): `.top-search` flex item had default `min-width: auto` → automatic floor = min-content (211 px) → topbar min-content 470 px > viewport → `scrollWidth=470`; theme toggle pushed off-screen (right=470). Content-driven, reproduced in desktop **and** mobile emulation. | `web/css/responsive.css:51` — `.top-search { max-width: none; min-width: 0; }` | A/B probe: form min-width fix → `scrollWidth 470 → 360`, form shrinks to 77 px (usable), theme button visible (right=344). Post-fix responsive suite 8/8 PASS. |
| FIX-2 | Top search not synced on cold deep-link/reload of `#/search?q=…`: only `store.on('route')` listener (`web/js/app.js:160`) fires on `hashchange`; initial load never emitted `route`. | `web/js/app.js:246-248` — `boot()` now destructures `query` and adds `store.emit('route', { path, query })` (single existing listener, guarded by `path === '/search'`) | Pre-fix: Search FAIL (`top-input` empty on cold load). Post-fix: Search PASS — `top-input synced`; RouteSweep 19/19, Player/Routing/GitHub Pages suites unchanged PASS. |

Static re-verification after fixes: `node --check` OK, `web-check-imports.cjs` 0 problems, CI integrity gate CLEAN.

---

## 6. Remaining Issues

**None confirmed.**

- Non-blocking UX observation (not a defect): at 360 px the top search box shrinks to ~77 px total (input ≈ 29 px). It remains functional; a wider box would require removing/hiding the brand text — deliberately rejected to avoid unnecessary visual changes.
- All prior QA FAILs (4 responsive + 1 search) are fixed and re-verified (46/46).

---

## Rejected Change Suggestions (reviewed, not applied)

| # | Suggestion | Reason for rejection |
|---|---|---|
| R1 | Hide brand text on ≤ 560 px to free topbar space | Fixes overflow but removes visible branding — unnecessary visual change once `min-width: 0` suffices |
| R2 | Hide `.top-search` on mobile | Removes primary search entry on mobile — functionality loss |
| R3 | Refactor topbar layout / flex structure | Scope creep beyond smallest confirmed-defect fix |
| R4 | Emit `route` from `router.js` | Larger blast radius in routing core; boot-time emit achieves same with 2 lines |
| R5 | `input { width: 100% }` variant for FIX-1 | Also works empirically, but container `min-width: 0` is the canonical flexbox fix with clearer intent |

---

## Verdict

**Definition of Done: MET.**
Automated tests clean · 8/8 responsive widths PASS · 12/12 functional areas PASS · GitHub Pages deployment PASS · 2 confirmed defects found and fixed (re-verified) · 0 remaining issues · known browser limitations documented as limitations, not bugs.

**Pipeline disclosure:** the `task` (subagent dispatch) tool was not available in this session; the orchestrator executed all stage protocols (PM checklist → QA → Code Reviewer (10 questions) → Fixer → regression QA → Final Reviewer (10 questions)) directly, applying only reviewer-approved minimal diffs (2 files, 4 lines).
