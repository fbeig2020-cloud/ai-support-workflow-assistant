# Repository Inventory Audit — AI Support Workflow Assistant

**Date:** 2026-08-30
**Scope:** Blunt, evidence-based inventory of the repository against 10 programme deliverables. Not a status report for encouragement purposes — an accurate accounting of what exists, what works, and what is recorded.

## Context that changes how to read everything below

Root `CLAUDE.md` describes a large Node/Express + React "Colaberry Agent Project" (`backend/`, `frontend/`, `system/`, `intelligence/`, `openclawCircuitBreaker.ts`, five design skills, a `screenshot-review` skill, a session-changelog generator, etc.). **None of that exists in this repo.** What was actually built is a small, self-contained "AI Support Workflow Assistant" (`src/`, `tests/`, `command-center/`, `.colaberry/`, `prompts/`) plus a set of standalone curriculum HTML field guides. The repo itself says this explicitly (`reliability-audit-step1.md`, lines 26-27). So a chunk of CLAUDE.md is aspirational template prose copied from a larger reference architecture, not a spec of this project — every CLAUDE.md claim about infra should be treated as unverified until it shows up as code. (This context is now also captured as a callout note at the top of `PROGRESS.md`.)

## Week-by-week build

- **8/12** — R4 safety guardrail (`guardrail.js`, `presentToAgent.js`) — the "assistant proposes, never executes" rule, actually enforced in code. 17 tests.
- **8/16–8/19** — Command Center dashboard (8 tabs, 1 real, 7 honestly stubbed), then three follow-on fixes; curriculum field guides start landing (one per session).
- **8/19–8/24** — The real core: STORY-001→007 (classify → human review → audit trail → KB search → draft response → escalation → summary). Test count climbs 31→179.
- **8/22** — Prompt library: two prompt versions, scored against an eval set (1.00 → 0.88 after adding adversarial cases → 1.00 after a fix). Genuine BUILD/BREAK/HARDEN evidence.
- **8/23** — A real incident: schema drift broke the Command Center, diagnosed and fixed, regression disclosed rather than hidden.
- **8/27** — Claude Code harness maturity: slash commands, a PreToolUse hook blocking `/system` writes, a PostToolUse schema-drift hook, two GitHub Actions workflows.
- **8/30** — 7-layer architecture mapping + capstone field guide.

PROGRESS.md itself is unusually disciplined — every `[x]` line carries real verification, and gaps are self-disclosed rather than papered over.

## The 10-item scorecard

| Item | Exists | Works | Recorded | Verdict |
|---|---|---|---|---|
| **Workspace & CLAUDE.md** | Yes, one 714-line file | Governance prose is real; infra it describes (backend, circuit breaker, telemetry) doesn't exist here | It's the founding commit, unedited since | **Thin.** It's a policy doc for a different, bigger project pasted in front of a small one. Never updated to match what got built. |
| **Agent skills** | One skill, `system-architect` | Yes — real 5-step process, demonstrably run (produced `architecture.md` + a backup, i.e. re-run) | Only indirectly, via PROGRESS.md | **Thin.** One real skill. CLAUDE.md name-drops seven more (`/baseline-ui`, `/screenshot-review`, `/telemetry-emission`...) that don't exist anywhere. |
| **Workflow assistant** | Yes — 12 modules, 2,261 lines, `demo.js` | Yes — 179/179 tests passing (verified live) | Slides exist (`demo prep/*.pptx`); a commit message claims a demo was "recorded" but **no video file exists in the repo** (confirmed and corrected in PROGRESS.md, see 2026-08-30 "Demo Preparation" entry) | **Solid**, with one loose thread — the claimed recording isn't actually there. No runtime entry point wiring the modules together end-to-end either, by the architecture doc's own admission. |
| **Prompt library** | One prompt (`classify-issue-type`), two versions, a real eval harness | Yes — actual scored runs, 5/5 → 7/8 → 8/8 | Yes, in PROGRESS.md with real numbers | **Solid**, but narrow — one prompt. Calling it a "library" overstates it. |
| **MCP server** | No | No | No | **Missing.** Zero implementation, zero config. The only MCP references in the repo are prose describing MCP as a topic, not a thing built. |
| **Subagent team** | `.claude/agents/README.md`, 1 line | No | No | **Missing.** Unchanged since "Step 1: scaffold" on 8/26. There is no Step 2. |
| **Automation & CI** | Two workflows, correctly configured; two real hooks (`PreToolUse` block, `PostToolUse` schema check) | Hooks: yes, tested and proven to catch a real bug. CI workflows: **never executed** — they trigger on `pull_request` and no PR has ever been opened; every commit went straight to `main` | Hooks: yes, in PROGRESS.md. CI: zero run history (`gh run list` shows only GitHub Pages builds) | **Thin.** The hooks are solid. The CI is a prop — correctly wired, never fired once. |
| **Reliability layer** | Idempotency: real (hash-chained audit log, upsert-by-id). Circuit breaker: referenced in CLAUDE.md, doesn't exist. Retry/backoff: none — the repo's own audit doc names the one external call (`score_prompt.py`) as having no timeout/retry and says fixing it is "not yet done" | Idempotency: yes, tested. The rest: no | Idempotency tests pass live; the gap is self-documented, not hidden | **Thin.** One piece (idempotency) is genuinely solid; circuit breaker and retry are doc-only claims about a file that doesn't exist. |
| **Governance engine** | CLAUDE.md's autonomy scoring, escalation.json writer, confidence thresholds — all prose, zero code. One real exception: `guardrail.js` enforces the "propose don't execute" rule at runtime | The one enforced rule: yes, tested. Everything else: no | The escalation protocol was exercised once (8/17, Command Center fix) by hand, not by any automated writer | **Thin.** One narrow, real enforcement mechanism sitting inside a large prose document that enforces nothing else. |
| **Architecture package** | `architecture.md` (172 lines) + `7-layer-architecture-mapping.md` (148 lines) | Yes — both are grounded in actual files/tests, not generic filler, and the 7-layer doc explicitly tags claims as Confirmed/Documented/Gap and names two real structural gaps | Yes — cross-checked against the real repo before writing, per PROGRESS.md | **Solid.** The best-executed item on this list. Honest about its own gaps, which is rare and worth keeping. |

## The one thing to spend two hours on

**MCP server.** Reasoning:

- It's the only item at a hard zero where "missing" isn't a nuance — there's no config, no code, no prose-only near-miss.
- The curriculum field guides literally list "AI, Claude, APIs, MCP, SQL, Power BI" as subject matter — MCP is a named topic in the programme, not a side interest. Having zero implementation while everything else has at least a thin version is the gap someone will notice first.
- Three tested, working functions already exist (`classify.js`, `generateDraftResponse.js`, `knowledgeBaseSearch.js`) that are trivial to wrap as MCP tools — this is a thin protocol shim over logic that already has 179 passing tests behind it, not new logic.
- It's demonstrable in the most literal sense: connect Claude Code or Claude Desktop to the server and show tool calls executing live against the assistant. A recording of that is real, unlike the phantom "recorded demo" commit that had no file behind it.
- Compared to the alternatives: fixing CI is real but is a five-minute action (open one PR), not a two-hour story-changer. Filling out `.claude/agents/` past its one-line stub is cheap but low-signal. Building real governance enforcement is valuable but harder to demo convincingly in two hours and is competing against a category that already has one credible enforced example.

Two-hour plan: `@modelcontextprotocol/sdk` stdio server, 3 tools (classify, draft response, KB search) wrapping the existing `src/` functions unchanged, a `.mcp.json`, and a short session connecting and calling each tool — screenshot or transcript that as the recording. This converts one full "missing" row to "solid, recorded" and is the only item on the list where two hours moves a full category, not half of one.
