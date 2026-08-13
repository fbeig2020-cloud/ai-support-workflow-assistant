/**
 * R4 Safety Guardrail — AI Support Workflow Assistant.
 *
 * The assistant MAY recommend sensitive actions but MUST NOT perform them itself.
 * A support agent approves first. This module is the deterministic gate that
 * enforces that: it inspects the assistant's output and returns whether it is
 * safe to surface. Anything that even claims to have acted, or that skips the
 * human-approval flag, is rejected.
 *
 * Design principle (CLAUDE.md): the LLM is probabilistic; this check is not.
 *
 * @typedef {Object} RecommendedAction
 * @property {string} type            One of RESTRICTED_ACTIONS (or a benign type).
 * @property {string} [description]   Human-readable explanation of the proposal.
 * @property {boolean} requiresApproval  Must be exactly true.
 * @property {'proposed'} status      Must be exactly 'proposed'.
 *
 * @typedef {Object} AssistantOutput
 * @property {string} [summary]
 * @property {RecommendedAction[]} recommendedActions
 *
 * @typedef {Object} Violation
 * @property {number} index           Index in recommendedActions, or -1 for whole-output errors.
 * @property {string} [type]          The offending action's type, when available.
 * @property {string} reason          Stable machine-readable reason code.
 *
 * @typedef {Object} GuardrailResult
 * @property {boolean} safe
 * @property {Violation[]} violations
 */

/** Sensitive actions R4 forbids the assistant from performing on its own. */
export const RESTRICTED_ACTIONS = [
  'send_message',
  'close_ticket',
  'resolve_ticket',
  'change_priority',
  'change_permissions',
  'change_access',
  'modify_data',
  'delete_data',
  'escalate',
];

/** Fields that would mean the assistant already acted or self-approved — never allowed. */
const FORBIDDEN_EXECUTION_FLAGS = ['executed', 'sent', 'autoExecute', 'approved', 'completed'];

/**
 * Validate an assistant output against the R4 guardrail.
 * Fails closed: anything that cannot be proven safe is treated as unsafe.
 *
 * @param {unknown} output
 * @returns {GuardrailResult}
 */
export function validateAssistantOutput(output) {
  const violations = [];

  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    return { safe: false, violations: [{ index: -1, reason: 'output_not_an_object' }] };
  }
  if (!Array.isArray(output.recommendedActions)) {
    return { safe: false, violations: [{ index: -1, reason: 'recommendedActions_missing_or_not_array' }] };
  }

  output.recommendedActions.forEach((action, index) => {
    if (action === null || typeof action !== 'object' || Array.isArray(action)) {
      violations.push({ index, reason: 'action_not_an_object' });
      return;
    }
    // 1. Must be an explicit proposal awaiting a human.
    if (action.requiresApproval !== true) {
      violations.push({ index, type: action.type, reason: 'missing_requiresApproval' });
    }
    if (action.status !== 'proposed') {
      violations.push({ index, type: action.type, reason: 'status_not_proposed' });
    }
    // 2. Must not claim it already acted or self-approved.
    for (const flag of FORBIDDEN_EXECUTION_FLAGS) {
      if (action[flag] === true) {
        violations.push({ index, type: action.type, reason: `forbidden_flag:${flag}` });
      }
    }
  });

  return { safe: violations.length === 0, violations };
}
