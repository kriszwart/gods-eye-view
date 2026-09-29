# Welcome pass implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New users get a way in: a one-time welcome plate introducing the registers with a tour button, a help overlay on "?", and a visible share button that copies the current view's link.

**Architecture:** All three are shell UI beside the observatory precedent: the welcome is a localStorage-remembered one-time plate wired through LayerBindings, help is a static overlay assembled from the same copy sources the legends use, share reuses the existing ShareLinkManager URL state.

**Tech Stack:** Vanilla ES modules, node:test, Puppeteer gates.

**Spec:** user-approved design in chat, 29 September 2026 (welcome plate + tour CTA, "?" help overlay, share copy button).

## Facts established

- GEV has a first-run system: src/firstRunExperience.js (recon its trigger/storage; scopeMask.js and celestialRing.js reference first-run styling; src/ui/styles/first-run.css exists). The Phenomena welcome must compose with or cleanly replace its trigger, never double-show.
- Hero tour: the anomalies layer exposes playTour()/stopTour() (index.js:393, chrono action at :528); INTEGRATION_NOTES names layer.playTour() for voice. The welcome's tour button must enable the anomalies layer if off, then play the tour (recon the manager enable channel LayerBindings already holds).
- Share links: src/sharelink.js ShareLinkManager (class, line 97) maintains the URL hash (#lat/lon/alt/v/l tokens). A copy button needs the CURRENT url string (recon: the manager keeps location.hash current, so navigator.clipboard.writeText(location.href) may be the whole mechanism; verify the hash is kept live rather than built on demand).
- Persistent shell buttons precedent: the observatory toggle (_createObservatoryToggle in layerBindings.js, guarded on document, cleaned in stop()); plate precedents: observatory/spotter (Escape, aria-pressed, orphan close on detach).
- Design system: hairline plates, registration corners, sentence case, one accent per register (welcome shows all four accents deliberately: magenta/violet sky, gold ancient, ion claims), AA contrast, reduced motion (no entrance animation under reduce), usable at 390 px.
- localStorage key convention: recon what GEV already uses (firstRunExperience) and follow.
- Clipboard in qa: Puppeteer can grant clipboard permissions per context; else stub navigator.clipboard.writeText in the page and assert the call + the copied string shape.

## Global constraints

- Gates green per commit: npm run format:check, npm test, npm run check:boundaries, npm run build; browser gates on the controller-managed :4173 (never restart; stale-cache 504s are the controller's; devCctv/toolProjectRoot full-suite failures are the known environmental collision, prove by isolation). One commit per task. British English, sentence case, no em dashes in added lines.
- Honesty: the welcome copy describes the registers with their existing honesty lines' spirit (unverified claims stay "unverified public claims"); no credibility framing; no marketing superlatives.
- The welcome shows ONCE per browser (localStorage; a cleared store shows it again; qa uses fresh contexts so it always shows there unless pre-seeded); every path dismissible (Escape, Close, both CTAs); it never blocks the app (boot completes independently; the plate overlays after #loading-screen removal).
- layerState.js untouched. Portable rules as ever. No new fetches before the app (the welcome uses only strings).

---

### Task 1: the welcome plate

**Files:**
- Create: `src/app/welcome.js` (builds the plate: title "Phenomena", tagline, three register lines with accent chips (sky events: magenta/violet; ancient sites: gold; live claims: ion, wording carries "unverified public claims"), one chronometer line, buttons "Take the hero tour" and "Explore freely"; onOpenChange callback per the observatory fix lesson)
- Modify: `src/ui/layerBindings.js` (show-once wiring: localStorage key following the firstRunExperience convention; compose with firstRunExperience so both never show together: recon its trigger and rule the ordering, documenting it; tour CTA enables anomalies via the manager if off, then calls the module's playTour through the layer lookup, then dismisses; Escape/Close/Explore dismiss and remember), `src/ui/styles/anomaly-atlas.css`, `scripts/qa-anomalies.mjs` (fresh context: welcome shows after boot; Escape dismisses and localStorage remembers (reload in the same context: absent); tour CTA path: anomalies enabled and tour started (assert tourToken/diagnostic or the tour button label flip); pre-seeded context: welcome absent; existing checks kept)
- [ ] Screenshots 1440/390 into qa-shots/welcome-pass/.
- [ ] Commit `feat(atlas): the atlas welcomes new eyes`

### Task 2: the help overlay

**Files:**
- Create: `src/app/helpOverlay.js` (static plate: keyboard map (dial arrows and Home/End, Escape, search focus, the "?" itself), the legend essentials in one block (brightness = how unexplained, hue = status, ion ring = hero, gold = ancient, ion = live claims + the honesty lines verbatim from their modules: import the string constants, never retype), a Sources and credits pointer (open the existing sources panel if a channel exists, else name it))
- Modify: `src/ui/layerBindings.js` (a small "?" button beside the observatory toggle; keydown "?" toggles when no input/textarea focused; Escape closes; aria-pressed; orphan close on detach), `src/ui/styles/anomaly-atlas.css`, `scripts/qa-anomalies.mjs` (press "?": overlay opens with the keyboard map and the anomalies honesty line text; "?" again closes; Escape closes; typing "?" inside the search box does NOT open it; existing checks kept)
- [ ] Commit `feat(atlas): help is a keypress away`

### Task 3: share the view, record

**Files:**
- Create or fold: the share button (likely small enough to live in layerBindings beside the other shell buttons; a separate module only if the copy/confirm logic grows): copies location.href via navigator.clipboard.writeText, button flashes "Copied" for ~2 s (sentence case), falls back to a prompt/select shim if clipboard is unavailable (state the fallback), aria-live polite announcement
- Modify: `src/ui/layerBindings.js`, `src/ui/styles/anomaly-atlas.css`, `scripts/qa-anomalies.mjs` (stub or permit clipboard; click share: the written string contains the current hash tokens (enable a layer first, assert its token in the copied string); the button announces; existing checks kept), CHANGELOG.md (entry "Welcome pass" covering all three)
- [ ] Commits `feat(atlas): the view travels in one click` then `docs(changelog): record the welcome pass`

## Self-review notes

- Show-once is per-browser by design; qa isolates via fresh contexts.
- Honesty lines imported, never retyped, so the copy cannot drift from the registers' own words.
- All three surfaces follow the observatory's lifecycle lessons (onOpenChange, persistent toggles, orphan close).
