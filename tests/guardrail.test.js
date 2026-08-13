import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAssistantOutput, RESTRICTED_ACTIONS } from '../src/guardrail.js';

/** A well-formed, human-approvable proposal. */
function proposal(overrides = {}) {
  return {
    type: 'send_message',
    description: 'Reply to the customer with the reset steps.',
    requiresApproval: true,
    status: 'proposed',
    ...overrides,
  };
}

// --- Happy path -------------------------------------------------------------

test('a proper proposed action is safe', () => {
  const result = validateAssistantOutput({ summary: 's', recommendedActions: [proposal()] });
  assert.equal(result.safe, true);
  assert.deepEqual(result.violations, []);
});

test('every restricted action type is safe when framed as a proper proposal', () => {
  for (const type of RESTRICTED_ACTIONS) {
    const result = validateAssistantOutput({ recommendedActions: [proposal({ type })] });
    assert.equal(result.safe, true, `expected type "${type}" to be safe as a proposal`);
  }
});

// --- Failure paths ----------------------------------------------------------

test('missing requiresApproval is unsafe', () => {
  const action = proposal();
  delete action.requiresApproval;
  const result = validateAssistantOutput({ recommendedActions: [action] });
  assert.equal(result.safe, false);
  assert.ok(result.violations.some((v) => v.reason === 'missing_requiresApproval'));
});

test('status other than "proposed" is unsafe', () => {
  const result = validateAssistantOutput({ recommendedActions: [proposal({ status: 'executed' })] });
  assert.equal(result.safe, false);
  assert.ok(result.violations.some((v) => v.reason === 'status_not_proposed'));
});

test('each forbidden execution flag is unsafe', () => {
  for (const flag of ['executed', 'sent', 'autoExecute', 'approved', 'completed']) {
    const result = validateAssistantOutput({ recommendedActions: [proposal({ [flag]: true })] });
    assert.equal(result.safe, false, `expected flag "${flag}" to be unsafe`);
    assert.ok(result.violations.some((v) => v.reason === `forbidden_flag:${flag}`));
  }
});

// --- Boundary cases ---------------------------------------------------------

test('empty recommendedActions is safe (nothing to approve)', () => {
  const result = validateAssistantOutput({ recommendedActions: [] });
  assert.equal(result.safe, true);
});

test('reports the correct index when one action in a list is bad', () => {
  const result = validateAssistantOutput({
    recommendedActions: [proposal(), proposal({ status: 'sent' }), proposal()],
  });
  assert.equal(result.safe, false);
  assert.ok(result.violations.every((v) => v.index === 1));
});

// --- Malformed input (fail-closed) ------------------------------------------

test('non-object output is unsafe', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    const result = validateAssistantOutput(bad);
    assert.equal(result.safe, false, `expected ${JSON.stringify(bad)} to be unsafe`);
  }
});

test('missing or non-array recommendedActions is unsafe', () => {
  assert.equal(validateAssistantOutput({}).safe, false);
  assert.equal(validateAssistantOutput({ recommendedActions: 'nope' }).safe, false);
});

test('an action that is not an object is unsafe', () => {
  const result = validateAssistantOutput({ recommendedActions: [null, 'x', 5] });
  assert.equal(result.safe, false);
  assert.equal(result.violations.length, 3);
});

// --- Idempotency / purity ---------------------------------------------------

test('validator is pure: same input twice yields identical result and no mutation', () => {
  const input = { recommendedActions: [proposal({ status: 'executed' })] };
  const snapshot = JSON.stringify(input);
  const first = validateAssistantOutput(input);
  const second = validateAssistantOutput(input);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(input), snapshot, 'input must not be mutated');
});
