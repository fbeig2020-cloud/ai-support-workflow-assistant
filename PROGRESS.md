# PROGRESS — AI Support Workflow Assistant

## Project DNA & Requirements

### R4 — Safety Guardrail (PLANNED)

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
