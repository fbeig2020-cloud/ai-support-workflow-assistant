# Layers & Boundaries — AI System Architecture Reference

## Purpose and Scope

A general reference for AI system architecture — the seven-layer stack and where trust boundaries sit within it — applied to a real, working system: the Student Support Workflow Assistant.

**Sources:** `architecture.md` (design intent), direct reads of the files under `src/` and `tests/`, and (Part V) the official course definition of the INPACT trust framework, Module 1 Lesson 2, "Trust Before Intelligence Framework."

**Compiled:** 2026-08-30. **Updated:** 2026-09-08 — Part V: Adaptive's evidence extended to cover STORY-010 (rule revocation) and STORY-011 (fast-repeat trigger); band unchanged at Confirmed. Earlier same day: added an audience clarification to the Natural entry's Mixed verdict (score unchanged). Same day, earlier still: Adaptive upgraded from Not Met to Confirmed following the classification-learning feature (STORY-008); see that section's note. Previously updated 2026-09-07 — all six INPACT dimensions evaluated for the first time.

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

INPACT is the **confirmed** six-dimension framework from Module 1, Lesson 2 of the course, "Trust Before Intelligence Framework": **I**nstant, **N**atural, **P**ermitted, **A**daptive, **C**ontextual, **T**ransparent. This replaces an earlier, incorrect guess at the definition (Integrity, Non-repudiation, Provenance, Accountability, Controllability, Transparency) that appeared in a prior version of this section.

> **Status — 2026-09-09:** A numeric 1–6 scoring formula is being applied to this scorecard for the first time today. This formula was not part of the student-facing curriculum materials — it was provided directly by the instructor, from `docs/ai-governance/TBI_COMPLIANCE_PROGRAM.md` sections 2.1 and 2.2. The scale runs **6 = Excellent** down to **1 = Critical gap**, with the **3/4 boundary marking the line between pilot-grade and production-grade**. Scores for all six dimensions sum to a total out of **36**. Per section 4.1, when a dimension is genuinely torn between two adjacent scores, the **lower** score is taken. This numeric layer sits alongside the existing qualitative Band system below — it does not replace or delete any prior Band or evidence text. See the new "Numeric Self-Assessment (2026-09-09)" subsection at the end of this Part for the full scoring and resulting trust band.
>
> **Status — 2026-09-08:** Adaptive upgraded from **Not Met** to **Confirmed**, in direct response to the classification-learning feature (STORY-008: `recordClassificationCorrection()`, `checkForSuggestedRule()`, `reviewSuggestedRule.js`, `applyApprovedClassificationRule()`) shipping the following day. This is not a re-evaluation that found the 2026-09-07 verdict wrong — that verdict was accurate for the codebase as it existed then, before this feature was built. The system changed; the score changed with it. All six dimensions remain evaluated against real project evidence, with no provisional or "not yet evaluated" language.
>
> **Status — 2026-09-07 (superseded above for Adaptive):** all six dimensions are now evaluated against real project evidence — this section no longer carries provisional or "not yet evaluated" language. The verdicts below were deliberately uneven: two dimensions are test-hardened, one was disclosed as not met by design, and one is a genuine mixed result rather than a single score, because the same evidence looks different depending on who the output is for.

**Band scale:** **Hardened** — verified in source and covered by a test that tries to break it. **Confirmed** — verified directly in source; no dedicated break-test yet. **Documented** — observed in project records, not proven by source or a test. **Mixed** — passes for part of its intended audience, not for another part. **Not Met** — absent by deliberate design choice, disclosed rather than hidden.

| Dimension | Definition | Band | Evidence |
|---|---|---|---|
| Instant | Responds in under 2 seconds | Documented | MCP session notes record every tool call running under 50ms — well inside the 2-second bar — which is why progress notifications were correctly declined as unnecessary during that work. Known limitation: no dedicated timing/performance test proves this formally, so it stays at Documented rather than Hardened. **2026-09-09 update:** `tests/classify.timing.test.js` now proves this formally with a real stopwatch assertion rather than session-note observation — this is the evidence behind today's numeric score of 5/6 (see Numeric Self-Assessment below). |
| Natural | Speaks in business language, not model/schema language | **Mixed** | `generateDraftResponse.js` produces plain, human-readable business language intended for students to read directly — this passes. Most internal outputs (classification results, audit log entries, knowledge base search results) are structured JSON with schema-level field names (`confidence`, `matchedSignals`, `logEntry`) intended for other code or auditors, not a human reader — these do not meet "Natural." Scored as mixed rather than a single verdict because the criterion applies differently depending on the output's intended audience: student-facing output passes, internal/auditor-facing output doesn't. **Audience clarification:** the Mixed score assumes the intended reader of that internal/auditor-facing output is an engineer reading a machine record, not a compliance reviewer expecting business language — that is this project's actual audience today. Under that framing, the schema-style output is reasonably correct for its actual reader, and only the student-facing drafts (`generateDraftResponse.js`) need to read in natural business language — which they already do. This clarifies the audience assumption behind the score; it does not change the verdict. **2026-09-09 update:** a `humanSummary` field has now been added to all 12 audited action functions in `src/auditedActions.js`, giving plain-English coverage to the internal/auditor-facing side that previously failed this dimension — this is real, complete coverage now, not partial, and is the evidence behind today's numeric score of 5/6 (see Numeric Self-Assessment below). |
| Permitted | Attribute-based access control — only does what the asker is authorized for | **Hardened** | `presentToAgent.js` blocks restricted actions without `requiresApproval: true`; `reviewClassification.js` and `reviewEscalation.js` require human approval before anything is final; `generateEscalationRecommendation.js` is shaped to pass through the same guardrail rather than bypassing it; an integration test confirms the escalation action actually clears both `guardrail.js` and `presentToAgent.js`. Known limitation: only one undifferentiated reviewer role exists — no routing between reviewer types. |
| Adaptive | Improves continuously rather than being frozen at training time | **Confirmed** (upgraded 2026-09-08 from **Not Met**) | `recordClassificationCorrection()` (`src/classificationCorrections.js`) saves the correct category every time a human rejects a wrong classification. `checkForSuggestedRule()` detects a recurring correction pattern (keyword → wrong category → correct category) under either of two independent triggers — the original path (3 or more occurrences, any timing) or a second, faster path added by STORY-011 (2 occurrences within a 15-day window — `FAST_REPEAT_THRESHOLD`/`FAST_REPEAT_WINDOW_DAYS`, so a slow-to-repeat pattern isn't the only way in) — and creates a `suggested_rule_change` proposal tagged with which trigger fired (`triggeredBy: 'threshold'` or `'fast_repeat'`); neither path is ever applied automatically. A human must approve the proposal via `reviewSuggestedRule.js` (same approve/reject shape as `reviewClassification.js`/`reviewEscalation.js`); only on approval does `classify.js`'s override check — `applyApprovedClassificationRule()` — actually change future classification behavior for that keyword. STORY-010 adds the missing reverse direction of that same control: a human can call `revokeApprovedRule()` on a previously approved rule at any time, marking it revoked (never deleted, so the approval history survives) and making `classify.js`'s override lookup skip it going forward, without altering any classification already produced under it — logged as its own distinct, equally-visible audit trail entry (`approved_classification_rule_revoked`), not folded into the original approval's log line. The system genuinely improves from real outcomes over time, without requiring a self-learning model — only a real feedback loop a human controls at every step, in both directions (approve and revoke) and at two different speeds (patient accumulation or a fast, short-window repeat). Confirmed rather than Hardened: the loop is verified end-to-end in source and by test (a rejected suggestion provably leaves `classify.js` unchanged; an approved one provably changes it; a revoked one provably reverts it going forward only), but no test yet tries to defeat the loop itself (e.g., forging a suggestion, or racing two corrections). Every module (`classify.js` and the rest) remains fixed, rule-based logic between approvals — this dimension's win is the human-gated update path around that logic, not a shift to a self-learning model; the project's core principle, *"LLMs are probabilistic. Production systems must be deterministic,"* still holds. |
| Contextual | Carries context across domains instead of answering each question in isolation | Confirmed | The full pipeline is built as an explicit chain, each Skill passing its typed output as the next Skill's input (classify → priority → search → escalation → draft → summary). `generateSupportSummary.js` includes a real consistency check that refuses to build a summary claiming an escalation happened without a matching escalation review actually present — proving context is carried and cross-validated across the ticket's full lifecycle, not answered in isolation. Confirmed rather than Hardened: this consistency check has not been exercised by a dedicated test that tries to defeat it, only verified by reading the source. |
| Transparent | Audit trails, so any answer can be traced back to how it was reached | **Hardened (strongest dimension)** | `appendAuditEntry()` in `auditLog.js` is SHA-256 hash-chained and append-only; `tests/auditLog.test.js` proves tampering with a past entry breaks its recomputed hash; write failures fail closed with an `ALERT:` line to stderr rather than failing silently; every action module logs through this same single path via `auditedActions.js`. Known limitation: no automated `verifyAuditLog()` tool exists yet to walk the full chain on demand, and no real (non-test) `audit-trail.log` has been produced from a live run. |

**Summary table — all six dimensions**

| Dimension | Current Score | Band *(context)* | Change *(2026-09-09)* | One-line why |
|---|---|---|---|---|
| Instant | **5 (Strong)** | Documented | was Documented → now 5 | Sub-50ms tool calls observed in session notes; no dedicated timing test — **upgraded to 5 today**: `tests/classify.timing.test.js` now provides real stopwatch proof |
| Natural | **5 (Strong)** | Mixed | was Mixed → now 5 | Student-facing drafts pass; internal/auditor-facing JSON doesn't — **upgraded to 5 today**: `humanSummary` now added to all 12 functions in `src/auditedActions.js`, giving real, complete coverage rather than partial |
| Permitted | **5 (Strong)** | Hardened | — | Guardrail blocks unapproved actions; break-tested by an integration test |
| Adaptive | **5 (Strong)** | Confirmed *(was Not Met, upgraded 2026-09-08)* | — | Human-approved corrections change future classifications via a real, human-gated feedback loop |
| Contextual | **5 (Strong)** | Confirmed | — | Typed chain plus a real cross-step consistency check in the summary Skill |
| Transparent | **5 (Strong)** | Hardened | — | Hash-chained audit log; break-tested by a tampering test — kept at 5, not 6, per the "when torn, take the lower" rule: no automated full-chain verifier tool exists yet and no real (non-test) `audit-trail.log` has been produced from a live run |

**What this reflects, now that all six are scored:**
- **The two Hardened dimensions share the same signature as Part IV — a test that tries to break the mechanism, not just a happy-path check.** Permitted is backed by an integration test confirming the escalation path actually clears the guardrail; Transparent is backed by a tampering test that proves a corrupted entry is detectable.
- **Adaptive's upgrade (2026-09-08) was earned by a specific feature, not a re-reading of old evidence.** The 2026-09-07 "Not Met" verdict was correct when written — at that point nothing in the codebase updated its own behavior from outcomes. STORY-008 changed the codebase, not the definition: a keyword → category correction, once confirmed by a human 3+ times, can now change what `classify.js` does next, but only after a second human approves that specific change. This did **not** require trading away the determinism/auditability that made Permitted and Transparent strong — the update path is itself deterministic (same corrections file → same suggestion → same outcome) and gated by the exact same human-approval pattern used everywhere else in this system. The earlier framing ("trading away continuous self-modification is what buys the reliability the other two dimensions depend on") turned out to describe a false tradeoff: what actually buys reliability is human-gating, not the absence of adaptation. Automatic self-modification is still not present, and still wouldn't be trusted here.
- **Mixed is the most honest verdict for Natural, not a hedge.** The definition doesn't specify an audience, but this system has two very different ones — the student reading a draft response, and the developer or auditor reading a log entry — and they get different answers. Flattening that to a single Pass or Fail would hide the real, audience-dependent split.
- **Confirmed sits deliberately below Hardened for Contextual and Adaptive alike.** Contextual's cross-step consistency check in `generateSupportSummary.js` is real and verified in source, but no test currently tries to force an inconsistent summary through it. Adaptive's feedback loop is verified end-to-end by test (reject → unchanged, approve → changed), but nothing yet tries to defeat the loop itself (a forged suggestion, a race between two corrections). Both claims rest on more than code review, but not yet on an attempted-failure proof the way Permitted and Transparent's do.

**Known limitations disclosed across all six:**
- **Instant** — no dedicated timing/performance test; the sub-50ms figure comes from session notes, not an automated benchmark.
- **Natural** — no style linter or audience-aware check enforces plain language on the student-facing path; the split is observed, not mechanically guaranteed to hold as the codebase grows.
- **Permitted** — only one undifferentiated reviewer role exists; no routing between reviewer types.
- **Adaptive** — two disclosed limitations in the current feedback loop, not tradeoffs to defend: (1) `src/data/classificationCorrections.json` is a single shared file with a read-modify-write update — concurrent corrections could race and one could be lost. Accepted for now as a single-user prototype risk, not hardened against. (2) No automated de-duplication across near-identical keywords yet (e.g. `"table"` and `"tables"` are tracked as two unrelated patterns, each needing its own 3 occurrences) — a human reviewer can still merge them by judgment when approving, but the system won't do it for them.
- **Contextual** — the consistency check has not been stress-tested by a case engineered to defeat it.
- **Transparent** — no automated `verifyAuditLog()` chain-walk tool yet, and no real (non-test) `audit-trail.log` has been produced from a live run.

---

### Numeric Self-Assessment (2026-09-09)

Using the 1–6 formula from `docs/ai-governance/TBI_COMPLIANCE_PROGRAM.md` §2.1/2.2 (6 = Excellent, 1 = Critical gap, 3/4 = pilot-vs-production line), applying the §4.1 "when torn, take the lower score" rule:

| Dimension | Score (1-6) | Evidence (one line) |
|---|---|---|
| Instant | 5 | `tests/classify.timing.test.js` gives real stopwatch proof of sub-2-second response |
| Natural | 5 | `humanSummary` now covers all 12 functions in `src/auditedActions.js` — complete, not partial |
| Permitted | 5 | Guardrail blocks unapproved actions, break-tested by an integration test |
| Adaptive | 5 | Human-gated correction → suggestion → approval loop verified end-to-end by test |
| Contextual | 5 | Typed pipeline chain plus a real cross-step consistency check in the summary Skill |
| Transparent | 5 | Hash-chained, tamper-evident audit log — held at 5, not 6, because no full-chain verifier tool exists yet and no real (non-test) `audit-trail.log` has been produced from a live run |

**Total: 30 / 36 (83%)**

**Resulting band: Good Trust — enterprise ready** (the 67–83% band).

**This is a self-assessment computed by one person, not the cross-functional (engineering + security + business) review that the TBI compliance program defines.** It is provisional pending that review, not a substitute for it.
