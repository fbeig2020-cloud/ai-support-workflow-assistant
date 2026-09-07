# Layers & Boundaries — AI System Architecture Reference

## Purpose and Scope

A general reference for AI system architecture — the seven-layer stack and where trust boundaries sit within it — applied to a real, working system: the Student Support Workflow Assistant.

**Sources:** `architecture.md` (design intent), direct reads of the files under `src/` and `tests/`, and (Part V) the official course definition of the INPACT trust framework, Module 1 Lesson 2, "Trust Before Intelligence Framework."

**Compiled:** 2026-08-30. **Updated:** 2026-09-07 — Part V's INPACT definition corrected (see that section's note).

This document mirrors [architecture/7-layer-architecture-mapping.md](7-layer-architecture-mapping.md) in evidence-tier discipline: every claim is marked **Confirmed** (verified by reading the cited source or test directly), **Documented** (described in `architecture.md`, not independently re-verified here), or **Gap** (named out of scope, or found genuinely absent).

---

## Part I — The Seven-Layer Reference

A vendor-neutral way to decompose any AI system, from the compute it runs on to the feedback loop that keeps it honest in production. Layers 1–5 build the working system; layer 6 cuts across all of them rather than sitting on top; layer 7 closes the loop back to the top.

| # | Layer | Purpose | Typical contents |
|---|---|---|---|
| 1 | Infrastructure | The compute, storage, and network substrate everything else runs on. Bounds availability, cost, and blast radius. | Cloud/on-prem compute, container orchestration, VPCs, secrets vaults |
| 2 | Data | Ingests, stores, and prepares the data the system reasons over. Quality here bounds everything above it. | Data lakes/warehouses, ETL, feature stores, vector/embedding stores, lineage tools |
| 3 | Model | Produces the actual predictions or generations. The probabilistic core. | Foundation model APIs, fine-tuned models, model registries, eval harnesses |
| 4 | Orchestration / Reasoning | Sequences model calls into workflows — planning, tool use, retrieval. Structures non-determinism into repeatable process. | Agent frameworks, RAG pipelines, tool-calling logic, retry/fallback logic |
| 5 | Application / Interaction | Where the system meets its users or other systems — the contract surface. | APIs, chat UIs, dashboards, webhooks, SDKs |
| 6 | Governance & Trust | Cross-cutting: policy, access control, human checkpoints, auditability. Every other layer answers to this one. | RBAC/auth, approval gates, audit trails, model cards, escalation protocols |
| 7 | Observability & Feedback | Watches the system in production and feeds signal back upstream. Turns "worked in the demo" into "works reliably." | Structured logging, correlation IDs, drift monitoring, incident response |

**How they interact:**
- **Bottom-up dependency, cross-cutting accountability.** Layer 6 doesn't sit on top of 1–5 — it cuts across them, so a governance failure at any single layer breaks the whole chain even if every other layer works correctly.
- **Layer 7 closes the loop.** Without observability, governance is a paper policy: you can write an approval gate into layer 4, but you only know it's actually firing in production because layer 7 logs it.
- **Governance concentrates where reversibility is lowest.** The model layer and the orchestration layer draw the most governance attention in practice, because that's where probabilistic output turns into real-world action.

---

## Part II — Trust Boundaries

A trust boundary is any point where data, control, or a decision crosses from one zone of trust into another — where the system can no longer assume the thing on the other side is honest, correct, or safe, and must validate it instead.

In conventional software the boundary is usually "outside the system vs. inside it." AI systems add a second kind of boundary *inside* the system itself: the line between "the model said it" and "it's true, safe, or authorized." A model's output looks identical whether it's correct, hallucinated, or the product of an injected instruction — so that line has to be enforced deliberately, not assumed.

### What goes wrong without them

- **Prompt injection** — Retrieved content or tool output is treated as trusted instruction rather than data, letting an attacker's embedded commands get obeyed.
- **Privilege escalation** — Model output is passed straight into a privileged action with no check — the model becomes a confused deputy, talked into actions the calling user was never authorized to perform.
- **Data exfiltration** — No boundary between what the model can read and what it's allowed to output lets sensitive data leak into a response, a log, or a downstream call.
- **Hallucination as fact** — No boundary between "model output" and "verified output" lets a fabricated result flow downstream and get acted on as ground truth.
- **Runaway autonomy** — No checkpoint at the tool-execution layer lets an agent chain real-world actions with no gate, turning one bad inference into a cascade.
- **Broken accountability** — It's unclear which side of a boundary produced a decision, so an incident review can't tell whether a human actually approved something or the system just assumed it.

### Where they typically sit in an AI architecture

1. **User input → model input.** Untrusted until validated — includes prompt-injection defense, not just the usual SQL/XSS concerns.
2. **Retrieved content → model context.** RAG results, scraped pages, and tool output the model can't distinguish from real instructions — one of the most exploited boundaries in AI systems today.
3. **Model output → executed action.** The line between "the model suggested X" and "X happened." Needs a gate that validates the intended action against a schema or allowlist before it runs.
4. **Model output → human review.** Where AI produces a draft or recommendation versus where a human actually approves it.
5. **Agent → agent.** In multi-agent systems, each typically holds different permissions; one agent must not borrow another's credentials or authorized scope.
6. **Application → external service.** Outbound calls to third-party APIs — risk here comes from the AI-generated *content* of the call, not just whether it fires.
7. **Dev/staging → production.** A model or agent with sandbox access should never have a silent path into production systems or data.
8. **Logs/telemetry → any reader of them.** Verbatim-logged model input/output is itself a crossing — secrets, PII, or injected content can leak into dashboards never meant to see them.

**The design rule underneath all eight:** treat every crossing as a place to validate, not a place to assume — schema-validate what crosses in each direction, gate any action with real-world side effects behind an explicit check, and log the crossing itself so it's provable after the fact.

---

## Part III — Applied: Student Support Workflow Assistant

The same seven layers, mapped onto the real components and Skills defined in `architecture.md` — Support Request Analyzer, Priority Assessment, Knowledge Base Search, Escalation Recommendation, Support Response Preparation, and Final Summary — and checked directly against the source in `src/`.

| # | Layer | Real components & Skills | Practice in this build |
|---|---|---|---|
| 1 | Infrastructure | The Command Center dashboard (STORY-000), reading live from `.colaberry/plan.json` and `progress.json` | Not fully specified — `architecture.md` §8 explicitly scopes out scaling, multi-region, and HA for a single-instance workflow. Thinnest layer by design. |
| 2 | Data | Support Request Store (tracks `pending_analysis → pending_review → finalized`); `src/data/knowledgeBase.json`; `src/data/responseTemplates.json`; Saved Summaries store | Hand-authored JSON files, not a live index or vector store — retrieval is exact/rule-based against fixed data |
| 3 | Model | Analyzer + Priority (`classify.js`); Knowledge Base Search (`knowledgeBaseSearch.js`); Escalation Recommendation (`generateEscalationRecommendation.js`); Response Preparation (`generateDraftResponse.js`); Final Summary (`generateSupportSummary.js`) | **Confirmed deterministic, no model call anywhere** — see verification below |
| 4 | Orchestration / Reasoning | Fixed pipeline order per §4: Analyzer → Priority → KB Search → (conditional) Escalation → Response Prep; the guardrail enforced by `guardrail.js` and `presentToAgent.js` | `guardrail.js`: *"the LLM is probabilistic; this check is not."* Blocks any restricted action without an explicit human-approval flag. |
| 5 | Application / Interaction | Support Request Entry; the Command Center dashboard; the Human Review and Approval surface showing classification, priority, search result, escalation, and draft together | One bundled review surface by design, so a reviewer never triages across separate screens |
| 6 | Governance & Trust | `reviewClassification.js`, `reviewEscalation.js` (approve / reject / revise); `auditLog.js` + `auditedActions.js` (hash-chained, append-only, fail-closed); `saveSupportSummary.js` (explicit manual save) | Landed in build order right after core classification (Phases 3–4) — ahead of search, drafting, and escalation. The strongest layer in the actual build. |
| 7 | Observability & Feedback | The audit trail doing double duty as governance evidence and observability record; 179/179 tests passing across the Skill suite | No production monitoring, correlation IDs, or dashboards yet — §8 names a live end-to-end orchestrator as an explicit, tracked gap |

**Verified against source — 2026-08-30:** checked directly, not inferred from documentation — every module in the reasoning layer was grepped for model/API calls (`anthropic`, `openai`, `chat.completions`, `claude-*`, `gpt-*`). Every match found was a comment, not a call — each module documents its own determinism against the same principle from `CLAUDE.md`: *"LLMs are probabilistic. Production systems must be deterministic."*

- `classify.js` — rule-based classification, no model call
- `generateEscalationRecommendation.js` — "Deterministic decision (no model call...)"
- `generateDraftResponse.js` — pure template assembly from `responseTemplates.json`
- `generateSupportSummary.js` — pure, idempotent compilation; no I/O, no model call
- `guardrail.js` — "the LLM is probabilistic; this check is not"

**What this mapping surfaces:**
1. **Layer 6 is the strongest layer in the actual build, not layer 1 or 7.** Human Review (Phase 3) and the Audit Trail (Phase 4) shipped right after core classification — before search, drafting, or escalation existed at all.
2. **Layer 3 is fully deterministic, confirmed at the source.** Every reasoning module — classification, priority, search, escalation, drafting, and summary — is template or rule logic with no model call anywhere in `src/`. There is no non-determinism left to govern in the reasoning layer itself; every remaining risk in this system lives at layers 5 and 6 (what the human reviewer sees and approves), not layer 3.
3. **Layers 1 and 7 are the acknowledged gaps** — named as out of scope or not-yet-built directly in `architecture.md` §8, not inferred by this mapping. Any decision built on this document should carry that caveat forward.

---

## Part IV — Boundary-Annotated Data Flow

Parts II and III name trust boundaries and map layers separately — neither says where, on the system's actual data flow, each boundary sits. This closes that gap by walking `architecture.md` §5 step by step and marking each crossing directly.

| §5 step | Crossing | Boundary type | Control | Status |
|---|---|---|---|---|
| 1–2 | Student → Support Request Entry → Store | User input → system | `classifySupportRequest()` rejects non-string or empty `requestText`, fails closed to `DEFAULT_CATEGORY` / `DEFAULT_PRIORITY`, and logs a `ValidationError` — `classify.js:159` | Confirmed |
| 8–9 | Skill outputs bundled → Human Review and Approval | Output → human review | `reviewClassification.js` / `reviewEscalation.js` — approve, reject, or revise | Confirmed |
| 10 | Approved draft → Final Response to Student | Output → executed action | `presentToAgent()` + `guardrail.js` — *"the LLM is probabilistic; this check is not"* | Confirmed |
| every step | Decision → Audit Trail | Logs → any reader | `auditLog.js` / `auditedActions.js` — hash-chained, append-only, fail-closed | Confirmed |
| 12 | Summary generated → Saved Summaries store | Write boundary (9th — not in Part II's original 8) | `saveSupportSummary.js` — explicit, separate, human-triggered save; generation alone never persists | Confirmed |

Row 1's citation is a direct source read: `classify.js:159` was opened and the guard verified line-for-line on 2026-08-30. The guard fires when the Analyzer processes the stored request text (§5 step 3) — there is no separate Support Request Entry or Support Request Store module in `src/`, so this is the earliest validation point that actually exists in the built pipeline, not a distinct entry-surface check. Rows 2, 4, and 5 are confirmed at the level of file existence plus consumption by code already read in full (`generateSupportSummary.js` reads and validates each module's output shape directly); their internal validation logic was not independently line-read the way row 1's was.

---

## Part V — INPACT Trust Band Scorecard

INPACT is now the **confirmed** six-dimension framework from Module 1, Lesson 2 of the course, "Trust Before Intelligence Framework": **I**nstant, **N**atural, **P**ermitted, **A**daptive, **C**ontextual, **T**ransparent. This replaces an earlier, incorrect guess at the definition (Integrity, Non-repudiation, Provenance, Accountability, Controllability, Transparency) that appeared in a prior version of this section.

> **Correction — 2026-09-07:** the definition below is confirmed against the course materials, not provisional. Two of the six dimensions — Permitted and Transparent — have been evaluated against real project evidence. The other four — Instant, Natural, Adaptive, Contextual — have not been evaluated yet and are marked accordingly below, with no invented evidence.

**Status scale:** **Pass** — evaluated against real project evidence, and held up. **Not yet evaluated** — no evidence gathered yet, deliberately unscored rather than assumed to fail.

| Dimension | Definition | Status | Evidence |
|---|---|---|---|
| Instant | Responds in under 2 seconds | Not yet evaluated | No latency measurement has been taken against this system. |
| Natural | Speaks in business language, not model/schema language | Not yet evaluated | Output phrasing has not been reviewed against this criterion. |
| Permitted | Attribute-based access control — only does what the asker is authorized for | **Pass** | `presentToAgent.js` blocks restricted actions without `requiresApproval: true`; `reviewClassification.js` and `reviewEscalation.js` require human approval before anything is final; `generateEscalationRecommendation.js` is shaped to pass through the same guardrail rather than bypassing it; an integration test confirms the escalation action actually clears both `guardrail.js` and `presentToAgent.js`. Known limitation: only one undifferentiated reviewer role exists — no routing between reviewer types. |
| Adaptive | Improves continuously rather than being frozen at training time | Not yet evaluated | No continuous-improvement mechanism has been assessed. |
| Contextual | Carries context across domains instead of answering each question in isolation | Not yet evaluated | Cross-domain context carry-over has not been assessed. |
| Transparent | Audit trails, so any answer can be traced back to how it was reached | **Pass (strongest dimension)** | `appendAuditEntry()` in `auditLog.js` is SHA-256 hash-chained and append-only; `tests/auditLog.test.js` proves tampering with a past entry breaks its recomputed hash; write failures fail closed with an `ALERT:` line to stderr rather than failing silently; every action module logs through this same single path via `auditedActions.js`. Known limitation: no automated `verifyAuditLog()` tool exists yet to walk the full chain on demand, and no real (non-test) `audit-trail.log` has been produced from a live run. |

**What this reflects so far:**
- **Both evaluated dimensions pass by the same standard as Part IV — a test that tries to break the mechanism, not just a happy-path check.** Permitted is backed by an integration test confirming the escalation path actually clears the guardrail; Transparent is backed by a tampering test that proves a corrupted entry is detectable.
- **The four open dimensions are unscored, not failing.** Instant and Adaptive in particular need infrastructure this build doesn't have yet — latency instrumentation and a live improvement loop — so scoring them without that evidence would mean guessing again, the exact mistake this correction fixes.

**Known limitations disclosed so far:**
- **Permitted** — only one undifferentiated reviewer role exists; no routing between reviewer types.
- **Transparent** — no automated `verifyAuditLog()` chain-walk tool yet, and no real (non-test) `audit-trail.log` has been produced from a live run.
- **Instant, Natural, Adaptive, Contextual** — open. Evaluate each against real evidence before treating this scorecard as complete.
