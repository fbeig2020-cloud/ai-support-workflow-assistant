import { validateAssistantOutput } from './guardrail.js';

/**
 * The R4 safety boundary — the ONLY sanctioned way to hand assistant output to
 * a support agent.
 *
 * It runs the guardrail first. If the output is unsafe, nothing actionable is
 * surfaced: the call is blocked and the violations are returned for logging and
 * triage. If the output is safe, the recommended actions are returned as items
 * the agent may review and approve. Nothing is ever executed here — approval and
 * execution happen elsewhere, by a human.
 *
 * Pure and idempotent: same input yields the same result, no side effects.
 *
 * @typedef {Object} BlockedResult
 * @property {false} ok
 * @property {true} blocked
 * @property {'guardrail_blocked'} reason
 * @property {import('./guardrail.js').Violation[]} violations
 *
 * @typedef {Object} SurfacedResult
 * @property {true} ok
 * @property {false} blocked
 * @property {string} summary
 * @property {import('./guardrail.js').RecommendedAction[]} pendingApproval
 *
 * @param {unknown} output
 * @returns {BlockedResult | SurfacedResult}
 */
export function presentToAgent(output) {
  const check = validateAssistantOutput(output);

  if (!check.safe) {
    // Failure path: block. Deliberately surface NO actions.
    return {
      ok: false,
      blocked: true,
      reason: 'guardrail_blocked',
      violations: check.violations,
    };
  }

  // Happy path: safe to review. These still require human approval to act.
  return {
    ok: true,
    blocked: false,
    summary: output.summary ?? '',
    pendingApproval: output.recommendedActions,
  };
}
