# Reliability Audit — Step 1: External Call Inventory

## Timeouts, retries with backoff, and circuit breakers — why they matter for AI systems

**Timeout** — a hard limit on how long you'll wait for a call (a model API, a DB query, a file read) before giving up and treating it as failed. Without one, a hung upstream call hangs your process too — indefinitely, since nothing forces it to return.

**Retry with backoff** — automatically re-attempting a failed call, but waiting longer between each attempt (exponential backoff, usually with jitter) instead of hammering the upstream immediately. This absorbs *transient* failures — a dropped packet, a momentary rate limit, a brief model-provider blip — without amplifying load on a system that's already struggling.

**Circuit breaker** — after N consecutive failures to a given dependency, stop calling it for a cooldown period and fail fast instead. This protects your own system (threads/connections don't pile up waiting on a dead dependency) and the upstream (it gets a chance to recover instead of being retried into the ground by every caller).

Why these matter more, not less, for AI systems specifically:
- Model API calls are slower and more variable than a typical DB query (seconds, not milliseconds), so an unbounded call blocks resources far longer.
- LLM providers rate-limit and occasionally degrade under load — retry-with-backoff is the difference between "handled a 429 gracefully" and "got the API key throttled harder."
- Agentic/workflow systems often chain several external calls per user action — one unguarded hop can stall or crash the entire chain, not just one feature.
- Non-determinism means you can't always tell "slow" from "hung" from "wrong shape back" — timeouts and typed failure handling are what convert an ambiguous stall into a clean, loggable failure.

Concrete failure prevention: a timeout turns "the model API is down and my process hangs forever" into "request fails after 10s, user sees a clear error." Backoff turns "I got rate-limited so I hit the API again immediately, got rate-limited harder, and now every user of this feature is failing" into "the retry after 2s succeeds." A circuit breaker turns "the DB is down and 500 concurrent requests are each independently retrying it, taking the DB fully offline" into "everyone gets a fast, clear failure for 30 seconds while the DB recovers, then traffic resumes."

---

## External-call audit of this repo

First, a scope correction worth flagging: `CLAUDE.md` describes a large Node/Express + React "Colaberry Agent Project" (`backend/`, `frontend/`, Mandrill, Basecamp, etc.). None of that exists in this checkout. The actual project here — per `.colaberry/plan.json` — is a small, deliberately deterministic **AI-Powered Business Support Workflow Assistant** living in `src/`. This audit covers the code that's actually here, not the CLAUDE.md description.

Result: **the shipped assistant itself makes zero network calls.** Every classification/search/draft/summary module is rule-based or template-based by design (the comments cite CLAUDE.md's "LLMs are probabilistic, production must be deterministic" principle directly). The only I/O is local disk, and the only real call to an external system in the whole repo is a Python eval script that isn't part of the runtime assistant.

| # | What's called | Where | Today, if slow/down/malformed |
|---|---|---|---|
| 1 | **Anthropic API** (`client.messages.create`, model calls) | `scripts/score_prompt.py:128-141` | **No explicit timeout** — relies on whatever the SDK's undocumented default is. **No retry/backoff** — one attempt per eval case; a transient error or rate limit just gets logged as a failed case and the script moves to the next case immediately (no backoff, so a rate-limit will likely repeat on the very next call too). **No circuit breaker** — if the API is fully down, the script burns through every remaining case in the file one at a time rather than failing fast after the first few. It does *not* crash or hang forever in the "process locks up" sense for generic errors (caught, logged, loop continues) — except a genuine network hang would ride on the SDK's default timeout, which isn't configured or verified here, so "hangs for an undefined, possibly very long time" is the honest answer for that case. `AuthenticationError` is the one case handled well: it hard-stops the whole run instead of failing 200 times identically. |
| 2 | **Local file: `src/data/knowledgeBase.json`** | `src/knowledgeBaseSearch.js:111-163` | Explicit 5s timeout (`withTimeout`/`Promise.race`), tagged error classes for missing/corrupt/denied/timeout, never throws — fails closed to `found:false` with a message. Well-handled. |
| 3 | **Local file: `src/data/responseTemplates.json`** | `src/generateDraftResponse.js:100-158` | Same pattern as #2 — 5s timeout, tagged errors, fails closed to `generated:false`. Well-handled. |
| 4 | **Local file writes: `audit/audit-trail.log`** | `src/auditLog.js:81-107` | Sync read-then-append wrapped in try/catch; never throws; on any failure (disk full, permission denied, corrupt chain) it prints an `ALERT:` to stderr and returns `{ ok: false }` rather than blocking the caller. Well-handled, though the "alert" is just a stderr line — nothing currently reads/pages on it. |
| 5 | **Local file writes: `summaries/<ticketId>.json`** | `src/saveSupportSummary.js:128-161` | Same shape as #4 — sync write, try/catch, fail-closed with stderr `ALERT:`, never throws to the caller. Well-handled. |
| 6 | **HTTP fetch of `.colaberry/*.json`** (via the local static server) | `command-center/data-loader.js:29-58` | Explicit 5s `AbortController` timeout, tagged error classes (`TimeoutError`/`NetworkError`/`UpstreamUnavailable`/`ContractViolation`), surfaced to the UI via `renderLoadError` instead of hanging the page. Well-handled. |

Local file I/O (#2-#6) isn't really "a call to something outside itself" in the strict sense (nothing on someone else's machine, no third-party dependency) — included for completeness, but not competing for the #1 slot below.

## Recommendation: harden #1 — the Anthropic API call in `score_prompt.py`

This is the only call in the entire repo to a genuine external system outside your control, and it's also the *only* call site with none of the three protections in place — everything else in this codebase (all local I/O) already has an explicit timeout and fails closed. That combination — real external dependency, zero resilience — is what makes it the highest-value fix, even though the blast radius is "just" a dev tool:

- **Most likely to actually fail this way**: model APIs rate-limit and have transient blips far more often than your local disk does. This script will hit that in normal use, not just in a rare edge case.
- **Highest cost of the failure modes present**: an unconfigured timeout on a network call is the one place in this repo where "hangs indefinitely" is a live possibility rather than a solved problem — everywhere else already made timeouts explicit specifically to rule that out.
- **Cheapest to fix, most standard shape**: add an explicit request timeout, wrap the call in retry-with-exponential-backoff for transient errors (429/5xx/timeouts) with a small attempt cap, and stop the run early after N consecutive failures instead of grinding through every remaining eval case one at a time. This is a well-trodden pattern, not a design problem.

No code changed as part of this audit — implementation of the timeout/retry/circuit-breaker hardening for `score_prompt.py` is the proposed next step, not yet done.
