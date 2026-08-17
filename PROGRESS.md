# PROGRESS — AI Support Workflow Assistant

## Project DNA & Requirements

### R4 — Safety Guardrail (BUILT)

**Requirement:** The assistant must not send messages, close/resolve tickets, change
ticket priority, change permissions or user access, modify data, delete information, or
escalate a case automatically. It may *recommend* these actions, but a support agent
must approve them first.

**Acceptance criterion:** For any assistant output, `validateAssistantOutput()` returns
`safe: false` unless *every* recommended action is marked `requiresApproval: true` and
`status: 'proposed'` and carries no execution/self-approval flag (`executed`, `sent`,
`autoExecute`, `approved`, `completed`). Malformed output is rejected (fail-closed).
Restricted actions can only ever appear as human-approvable proposals.

**Status transition:** UNMAPPED → PLANNED (producing task now defined: `src/guardrail.js`).

- [x] Map the safety guardrail (R4) — validator + tests
  - Date: 2026-08-12
  - Session: CC-20260812-k7m2
  - What changed: Added `src/guardrail.js` (`validateAssistantOutput`, `RESTRICTED_ACTIONS`) and `tests/guardrail.test.js`; scaffolded `package.json` with `npm test` (Node built-in runner).
  - Verification: `npm test` — 11/11 pass (happy path, every restricted type, each failure flag, boundary empty-list, malformed fail-closed, correct-index, idempotency/purity).
  - Notes: Guardrail fails closed and requires approval on ALL actions (not only restricted types) to close the mislabeled-type loophole. Next: wire the validator as a boundary gate once the assistant produces outputs (moves R4 PLANNED → BUILT).

- [x] Wire the guardrail into the agent boundary (R4) — PLANNED → BUILT
  - Date: 2026-08-12
  - Session: CC-20260812-k7m2
  - What changed: Added `src/presentToAgent.js` — the single sanctioned boundary that runs the guardrail before any output reaches a support agent. Unsafe output is blocked and surfaces NO actionable content (`pendingApproval` omitted); safe output returns items pending human approval. Added `tests/presentToAgent.test.js`.
  - Verification: `npm test` — 17/17 pass (safe surfaced, unsafe blocked, blocked-surfaces-nothing, R4 send-without-approval blocked, malformed fail-closed, idempotency/purity).
  - Notes: Guardrail is now on the critical path, not just unit-tested in isolation. Fail-closed on the boundary. Next (HARDENED): add structured logging/correlation IDs on block, and an explicit human approval + idempotent execution step downstream.

## Curriculum Deliverables — Colaberry Enterprise AI Leadership Accelerator

- [x] Integration Engineer Field Guide (Week 7 deep dive)
  - Date: 2026-08-16
  - Session: CC-20260816-t9k4
  - What changed: Added `IntegrationEngineer_FieldGuide.html` — a self-contained knowledge-base-style field guide (left topic nav, header search, offline "Ask the guide" Q&A, light/dark theme) teaching integration-engineering review judgment for an AI Solution Architect. Extends the existing ACTA (Aegis Auto Claims Triage Assistant, Insurance) example established by the QA and UX Design field guides with the integration layer: Claimant Portal, Policy Admin System, DocScan AI (OCR), SentinelScore (fraud), ClaimPay, and NotifyHub. Contains 14 core-concept sections plus 6 full deliverables (Integration Architecture with a C4-style hub diagram, API Contract Spec, 5 sequence diagrams covering happy path/retry/circuit-breaker-failure/duplicate-webhook branches, Error-Handling & Retry/Idempotency Design with backoff-curve and circuit-breaker-state SVGs, a sourced Data Mapping table, and a 20-case Integration Test Plan covering 5xx/429/timeout/malformed-payload/duplicate-delivery). Each deliverable is individually downloadable as a styled standalone HTML, prints to a matching PDF layout, and the two tabular docs export to CSV. Colaberry logo fetched from the official URL and embedded as base64; brand colors, fonts, and metadata script tag match the mandatory spec exactly.
  - Verification: Python `html.parser` validation — 0 parse errors across the full 332KB document; Node `new Function()` syntax check on the embedded `<script>` block — passed; all 27 inline SVG figures validated well-formed; `deepdive-metadata` JSON tag validated via `json.loads`; file opened in the default browser for visual confirmation.
  - Notes: Followed the CSS/JS architecture already validated in `QAEngineer_FieldGuide.html` and `UXDesigner_FieldGuide.html` (same design-system classes, same offline search/ask/download engine) for cross-guide consistency within the curriculum track, with new content authored fresh for the integration-engineering discipline. No secrets introduced; no `/backend`, `/frontend`, or `/scripts` code touched, so no `tsc --noEmit` gate applies.

## Command Center

- [x] Command Center — Overview tab (shell + Overview built, other 8 tabs stubbed)
  - Date: 2026-08-17
  - Session: CC-20260817-q2p9
  - What changed: Added `command-center/` (static site, no build step): `index.html`, `styles.css`, `app.js`, and `data.js` as the single data source. Overview tab is fully built: project description, release-you-are-in strip (r0/r1/r2 with computed status from today's date), a requirement-by-requirement "what's live" rollup (all 10 REQs, only REQ-008 marked built), the R4 guardrail foundational-work callout, and a system-connections panel that shows a grey "no systems connected yet" state in Real mode. The other 8 tabs (Outcomes, Users & Use Case, Guardrails, Systems, Project Management, AI Agents, Knowledge Base, Data Model) are reachable from the nav but render an honest "not built yet" stub naming what will live there and what has to happen first, per the plan's own instruction to stop after Overview. Global Real/Sample toggle wired (defaults to Real; Sample mode shows a persistent banner and clearly-tagged fabricated stats/connections). Colour palette is a documented neutral placeholder, defined once in `styles.css :root`.
  - Verification: `node --check` passed on `app.js` and `data.js`; re-ran `npm test` — 17/17 pass, used as the evidence backing the REQ-008 "built" claim; opened `command-center/index.html` in the default browser to confirm it renders with no build step.
  - Notes: No colours were chosen for this project yet, so the palette is a neutral placeholder in one place as instructed. No external systems are named in the plan, so Systems stays an empty state in both the Overview panel and its own stub. Stopping here per the plan's instruction to get Overview right before building the other eight tabs.
STORY-000 setup complete

- [x] Command Center — STORY-000 verification fixes (card drill-down, runtime data files, data-age warning)
  - Date: 2026-08-17
  - Session: CC-20260817-r5n8
  - What changed: Fixed the 3 gaps found by the STORY-000 verification pass. (1) Card drill-down: every `.cc-card` now has `cursor:pointer` and an `onclick` (event-delegated in `app.js`) that opens a one-level-down detail view in a new generic modal widget (`command-center/modal.js`); detail content for all 6 Overview cards and all 8 stub-tab cards is built from real fetched data only, no invented numbers. (2) Runtime data files: created `.colaberry/plan.json` (meta/guardrails/requirements/releases/stories/systems/users) and `.colaberry/progress.json` (foundationalWork/owners/connections) holding the data that used to be hard-coded in `data.js`; deleted `data.js`; added `command-center/data-loader.js` which fetches both files at runtime (5s timeout, typed errors: NetworkError/TimeoutError/UpstreamUnavailable/ContractViolation) and `command-center/sample-data.js` for the (intentionally still-JS) sample-mode fixture; `app.js` now loads data asynchronously on `init()` and shows a loading/error state instead of rendering hard-coded facts. Release-status math now uses the live current date instead of a frozen `TODAY` constant. (3) Data-age warning: created `.colaberry/manifest.json` (`dataUpdated` + per-source timestamps); added a persistent `#data-age-bar` (shown on every tab, in `index.html`/`app.js`/`styles.css`) that reads the manifest and displays "Data last updated <date> (<n> days ago)", switching to a warning style when the data is more than 7 days old. Added `scripts/serveCommandCenter.js` — a zero-dependency Node static file server (`node:http`/`node:fs`/`node:path` only, path-traversal guarded, binds to 127.0.0.1) because `fetch()` of local JSON is blocked when `index.html` is opened via `file://`; added `npm run serve:command-center`.
  - Verification: `node --check` passed on `app.js`, `data-loader.js`, `modal.js`, `sample-data.js`, `scripts/serveCommandCenter.js`; all 3 new JSON files parse via `JSON.parse`; re-ran `npm test` — 17/17 pass, unaffected by this change; started the server and confirmed via `curl` that `index.html`, `app.js`, and all three `.colaberry/*.json` files are served with correct content types and that a raw path-traversal request is rejected; ran an end-to-end Node script (using native `fetch` against the running server) that calls the real `loadCommandCenterData()`/`commandCenterDataAge()` functions and asserts the merged shape (10 requirements, 2 guardrails, 3 releases, 7 stories, 1 foundational-work entry, 3 owners, 0 connections/systems) and the staleness math (0 days → not stale, 9 days → stale) all match expectations; opened `http://127.0.0.1:4173/command-center/` in the user's default browser via the running server for visual confirmation (no Playwright/browser-automation tool available in this repo to self-verify the UI visually, so this is user-confirmable, not self-confirmed).
  - Notes: Sample-mode data intentionally stays a JS fixture (`sample-data.js`), not a `.colaberry/*.json` file — it's synthetic preview data, never real project state, and mixing it into the real-data read path would risk exactly the "invented number" failure mode STORY-000 flagged. `owners` and `connections` were assigned to `progress.json` (not `plan.json`) since they reflect who's currently doing what / what's currently connected, not the plan itself — a judgment call, logged per the assumption-logging rule. Awaiting user review before committing.

- [x] Command Center — fix static server directory routing (styles.css/modal.js/app.js 404s)
  - Date: 2026-08-17
  - Session: CC-20260817-r5n8
  - What changed: `scripts/serveCommandCenter.js` only special-cased the exact literal path `/` to map to `command-center/index.html`; any other directory-style request — including `/command-center/`, the URL the user was actually loading — fell through to the file-stat check, found a directory, and 404'd before the browser ever received HTML, so none of the page's script/link tags were ever fetched (that's why only some filenames showed in the console — nothing about the individual files was broken). Replaced the single hardcoded root case with a general `resolveFile()` that maps *any* requested directory (root or nested, with or without a trailing slash) to the `index.html` inside it, and changed all responses (including 404s) to `Cache-Control: no-store` so a stale error response can't linger in the browser cache across server restarts during dev.
  - Verification: `node --check` passed; killed the previously running server process and started a fresh one; `curl` confirms the user's exact URL (`http://127.0.0.1:4173/command-center/`, trailing slash) now returns `200 text/html`, and every sub-resource it references (`styles.css`, `sample-data.js`, `data-loader.js`, `modal.js`, `app.js`) plus all three `.colaberry/*.json` files return `200`; also confirmed the no-trailing-slash form (`/command-center`) now works, the bare root `/` still correctly 404s (no `index.html` at repo root), and the path-traversal guard still rejects `../../../..` escapes; re-ran `npm test` — 17/17 pass, untouched by this fix. Re-opened the URL in the user's browser; asked the user to hard-refresh since the earlier 404 may be cached.
  - Notes: Root cause was a routing gap, not a missing/misnamed file — every file the user listed already existed and was already being served correctly once requested directly by full path. Awaiting user confirmation that the hard-refreshed page now loads cleanly.
