# 7-Layer Architecture Mapping — AI Support Workflow Assistant

## Purpose and Scope

This document maps the AI Support Workflow Assistant onto a general 7-layer AI system reference architecture (Infrastructure → Data → Model → Orchestration/Reasoning → Application/Interaction → Governance & Trust → Observability & Feedback), using the project's real components and Skills rather than a generic example.

**Sources:** `project-blueprint/architecture.md` (design intent), `PROGRESS.md` (actual build history, session-by-session), and direct reads of the files under `src/` and `tests/`. Every claim below is marked with its evidence tier:

- **Confirmed** — verified by reading the cited source or test file directly
- **Documented** — described in `architecture.md` or `PROGRESS.md`, not independently re-verified in this pass
- **Gap** — named as out of scope, or found to be genuinely absent

One correction this document makes to the conceptual picture in `architecture.md`: the project is, as of the last recorded build entry (STORY-007), **a tested library of pure functions, not yet wired into a live orchestrator**. `PROGRESS.md`'s own STORY-003 entry states this directly: *"this repo has no runtime entry point/orchestrator yet (STORY-001/002/003 are all still called only from tests)."* Where `architecture.md` describes a component conceptually (e.g., "Support Request Store") but no corresponding file exists in `src/`, that's called out explicitly rather than presented as built.

---

## Layer 1 — Infrastructure

**Purpose:** Hosts compute, storage, and the CI/tooling substrate everything else runs on.

**Components & responsibilities:**
- `scripts/serveCommandCenter.js` — a zero-dependency Node static file server (`node:http`/`node:fs`/`node:path` only), path-traversal guarded, bound to `127.0.0.1`, serving the Command Center dashboard locally.
- `.github/workflows/test.yml` — GitHub Actions CI, running `npm test` (Node's built-in test runner, no external test framework) on every pull request.
- `.github/workflows/claude-code-review.yml` — automated PR review via the Claude Code GitHub Action.
- `.claude/hooks/block-system-writes.cjs` and `.claude/hooks/check-colaberry-schema.cjs` — local harness-level guardrails (not runtime infrastructure, but part of the tooling substrate this project builds on).

**Interactions:** CI (`test.yml`) is the only automated gate between a commit and `main` — it runs the full suite but does not yet enforce a required-status-check branch protection rule (a manual GitHub Settings step, not yet done per `PROGRESS.md`). The Command Center server is a separate, standalone tool for project-status visibility; it has no runtime connection to the support-workflow Skills themselves.

**Significance to this project:** This is deliberately the thinnest layer. There is no deployed service, database, or cloud environment — `architecture.md` §8 explicitly scopes out "load balancing, horizontal scaling, multi-region deployment." The project's infrastructure need today is "run the tests and view project status locally," and that's exactly what exists. **[Confirmed]**

---

## Layer 2 — Data

**Purpose:** Supplies the data each Skill reads and produces the records each Skill writes.

**Components & responsibilities:**
- `src/data/knowledgeBase.json` — 7 hand-authored troubleshooting articles, one per recognized category except the `general_support_request` catch-all.
- `src/data/responseTemplates.json` — one response template per category plus a mandatory `default` fallback, plus shared greeting/sign-off text.
- `audit/audit-trail.log` — the hash-chained JSON Lines audit record (created on first real write; gitignored).
- `summaries/<ticketId>.json` — one saved file per finalized ticket, written only by an explicit human-triggered save.
- `.colaberry/plan.json` / `.colaberry/progress.json` — project-status data (requirements, stories, verification state), consumed by the Command Center, unrelated to support-ticket data itself.

**Interactions:** `knowledgeBaseSearch.js` reads `knowledgeBase.json`; `generateDraftResponse.js` reads `responseTemplates.json`. Both reads are async, raced against an explicit 5-second timeout — a local file read is treated as an external boundary per CLAUDE.md's Failure-First Design, not assumed instantaneous. `auditLog.js` and `saveSupportSummary.js` are the only two write paths in the entire `src/` tree.

**Significance to this project:** There is **no live "Support Request Store"** as `architecture.md` §2 conceptually describes it (a record tracked through `pending_analysis → pending_review → finalized`). No such file exists in `src/`. **[Gap — conceptual only, not built]**. What does exist is a set of small, fixed, hand-authored JSON data files and two append/upsert write paths, both idempotent (`auditLog.js` appends without dedup by design; `saveSupportSummary.js` upserts by `ticketId` so re-saving never duplicates). **[Confirmed]**

---

## Layer 3 — Model

**Purpose:** Produces the actual classification, search, recommendation, and drafting outputs.

**Components & responsibilities:**
- `src/classify.js` — `classifySupportRequest()`, keyword-signal matching against fixed category and priority tables.
- `src/knowledgeBaseSearch.js` — `searchKnowledgeBase()`, scores articles by category match + tag overlap against a relevance threshold.
- `src/generateEscalationRecommendation.js` — `generateEscalationRecommendation()`, a fixed rule: recommend escalation only when the knowledge-base search came back `found: false`.
- `src/generateDraftResponse.js` — `generateDraftResponse()`, template substitution from `responseTemplates.json`.
- `src/generateSupportSummary.js` — `generateSupportSummary()`, pure compilation of prior artifacts into one document.

**Interactions:** Every one of these five modules takes the previous module's typed output as its input (a classification feeds priority and search; a search result feeds drafting and escalation; all five feed the final summary).

**Significance to this project:** **This layer has no model call anywhere.** Every module's own header comment cites the same principle: *"LLMs are probabilistic. Production systems must be deterministic."* This was independently verified for this project earlier in this documentation effort — every file was grepped for model/API-client signatures (`anthropic`, `openai`, `chat.completions`, `claude-*`, `gpt-*`); every match found was a comment, not a call. **[Confirmed]** Practically, this means the risks usually associated with an AI "Model" layer (hallucination, prompt injection into a model context, non-reproducible output) largely do not apply to this system's core reasoning — every result is reproducible from the same input by construction, confirmed by explicit idempotency tests in every one of the five modules' test files.

---

## Layer 4 — Orchestration / Reasoning

**Purpose:** Sequences the Model-layer outputs into a workflow and enforces the boundary between recommending an action and executing one.

**Components & responsibilities:**
- The fixed pipeline order: classify → (human review) → search → (escalation, conditional) → draft → (human review) → summarize → (manual save).
- `src/guardrail.js` — exports `RESTRICTED_ACTIONS` and `validateAssistantOutput()`, the deterministic check gating any restricted action.
- `src/presentToAgent.js` — the single sanctioned boundary that runs the guardrail before any output reaches a support agent; unsafe output surfaces **no actionable content** at all, not a degraded version of it.
- `src/auditedActions.js` — thin caller-side wrappers (`classifyAndLog`, `reviewAndLog`, `searchKnowledgeBaseAndLog`, `generateDraftResponseAndLog`, `generateEscalationRecommendationAndLog`, `reviewEscalationAndLog`, `generateSupportSummaryAndLog`, `saveSupportSummaryAndLog`) — one per action, each persisting that action's log entry via `auditLog.js`.

**Interactions:** `auditedActions.js` is the only reason the audit trail is populated outside of tests — calling `classifySupportRequest()` or any other pure function directly does **not** write to the audit trail; only its `...AndLog` wrapper does. This is a deliberate, documented seam (`PROGRESS.md`, STORY-003 entry), not an oversight.

**Significance to this project:** `guardrail.js`'s own header states the design principle directly: *"the LLM is probabilistic; this check is not."* `tests/guardrail.test.js` iterates every entry in `RESTRICTED_ACTIONS` to confirm each is actually blocked, not just documented as blocked. This is the layer where CLAUDE.md's core principle — reason and orchestrate probabilistically, execute deterministically — is actually enforced in code, not just stated in a document. **[Confirmed]**

---

## Layer 5 — Application / Interaction

**Purpose:** The surface where a student or a support agent actually interacts with the system.

**Components & responsibilities:**
- `architecture.md` describes **Support Request Entry** and a bundled **Human Review and Approval** surface showing classification, priority, search result, escalation, and draft together.
- The **Command Center** (`command-center/`) is a real, built dashboard — but it shows project build status (requirements, stories, releases), not support tickets.

**Interactions:** None yet, in the built system — this is the layer with the largest gap between design intent and what exists.

**Significance to this project:** **No Support Request Entry or Human Review UI has been built.** `src/` contains no file implementing either surface; the review functions (`reviewClassification.js`, `reviewEscalation.js`) accept a `decision` object as a function argument in code and in tests — there is no UI collecting that decision from a real person yet. **[Gap — conceptual only, not built]**. This is the layer to prioritize next if the project is moving from a tested function library toward something a real support agent can use.

---

## Layer 6 — Governance & Trust

**Purpose:** Cross-cutting checkpoints ensuring no output reaches a student unapproved and every decision is provable after the fact.

**Components & responsibilities:**
- `src/reviewClassification.js` / `src/reviewEscalation.js` — approve/reject/revise, each requiring a non-empty `reviewer` field before the decision is considered valid.
- `src/auditLog.js` — `appendAuditEntry()`, a SHA-256 hash-chained, append-only, fail-loud (stderr `ALERT:` on failure) audit log.
- `src/saveSupportSummary.js` — the deliberate, separate, manually-triggered save action; `generateSupportSummary()` never saves anything itself.
- `src/guardrail.js` / `src/presentToAgent.js` — shared with Layer 4; the same mechanism serves both orchestration and governance roles.

**Interactions:** Every action module's `logEntry` flows through exactly one write path (`auditLog.js`, via `auditedActions.js`). No module writes to the audit trail directly or by any second route.

**Significance to this project:** This is the most rigorously tested layer in the entire codebase. `tests/auditLog.test.js` includes a test literally titled *"editing a past entry breaks its recomputed hash (tampering is detectable)"* and another confirming a corrupted chain tail fails closed rather than being silently overwritten. `tests/reviewClassification.test.js` includes *"malformed decision is rejected: missing reviewer."* Per the build order in `PROGRESS.md`, the audit trail (STORY-003) shipped third, immediately after human review (STORY-002) and before knowledge-base search, drafting, or escalation existed at all — every Skill built afterward had a working, tested audit mechanism from its own first version. **[Confirmed]**

One self-disclosed limitation: `architecture.md` §7 flags a single undifferentiated reviewer role — no routing between, say, a teaching assistant and an instructor. This is a named assumption, not a silent gap.

---

## Layer 7 — Observability & Feedback

**Purpose:** Watches the system in production and feeds signal back upstream.

**Components & responsibilities:**
- Every Skill returns a structured `logEntry` matching CLAUDE.md's Observability Framework shape (`timestamp`, `level`, `service`, `event`, `outcome`, `context`, `error_class` where applicable).
- The full test suite: 179/179 tests passing as of the last recorded build entry (STORY-007), re-run 3 times consecutively at several points in the build history specifically to rule out flakiness.

**Interactions:** The audit trail (Layer 6) is the only thing currently doing observability work — every persisted record is both governance evidence and the sole operational trace of what happened.

**Significance to this project:** **No production monitoring exists.** There are no correlation IDs propagated across a request's lifecycle, no rolling success/failure-rate metrics, and no live dashboard — `architecture.md` §8 names a live end-to-end orchestrator as an explicit, tracked gap, and none of the `PROGRESS.md` entries after STORY-007 add one. **[Gap — explicitly acknowledged in the project's own docs, not discovered here]**. This is not a surprising gap given Layer 5 also isn't built: there is no live request path yet for a correlation ID to propagate across.

---

## Summary Table

| # | Layer | Status in this build | Key evidence |
|---|---|---|---|
| 1 | Infrastructure | Confirmed (minimal, local-only) | `scripts/serveCommandCenter.js`, `.github/workflows/test.yml` |
| 2 | Data | Confirmed (fixed files + 2 write paths); conceptual Store is a **gap** | `src/data/*.json`, `auditLog.js`, `saveSupportSummary.js` |
| 3 | Model | Confirmed — fully deterministic, no model call | Grep-verified across all of `src/`; every module's own header comment |
| 4 | Orchestration / Reasoning | Confirmed — tested | `guardrail.js`, `presentToAgent.js`, `auditedActions.js`; `tests/guardrail.test.js` |
| 5 | Application / Interaction | **Gap** — not built | No entry/review UI file exists in `src/` |
| 6 | Governance & Trust | Confirmed — hardened, tampering-tested | `auditLog.js`; `tests/auditLog.test.js`, `tests/reviewClassification.test.js` |
| 7 | Observability & Feedback | Confirmed at decision-level; **gap** at production level | Structured `logEntry` everywhere; no correlation IDs or dashboards |

---

## Key Takeaways

1. **The strongest layers are the ones with a BREAK test, not just a happy-path one.** Layers 4 and 6 both have tests that actively try to defeat the mechanism (tamper with a log, omit a reviewer, attempt a restricted action) — matching CLAUDE.md's Build-Break-Harden loop rather than just asserting the design works.
2. **Layer 3 has no non-determinism left to govern.** Every reasoning module is rule-based, not model-driven, confirmed directly in source across the whole `src/` tree.
3. **The two real gaps — Layer 5 (no UI) and Layer 7's production half (no live monitoring) — are connected, not independent.** There is no live request path yet, so there is nothing for a correlation ID to trace. Building Layer 5 is the natural next step, and it would make Layer 7's remaining gap immediately actionable rather than hypothetical.
4. **This document intentionally differs from `architecture.md`'s conceptual picture in two places** (Support Request Store, Support Request Entry / Human Review UI) — both are called out as gaps here rather than presented as built, since no corresponding file exists in `src/`.
