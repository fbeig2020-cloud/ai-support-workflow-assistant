import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presentToAgent } from '../src/presentToAgent.js';

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

test('safe output is surfaced for human review', () => {
  const output = { summary: 'Customer locked out', recommendedActions: [proposal()] };
  const result = presentToAgent(output);
  assert.equal(result.ok, true);
  assert.equal(result.blocked, false);
  assert.equal(result.summary, 'Customer locked out');
  assert.deepEqual(result.pendingApproval, output.recommendedActions);
});

// --- Failure path: the boundary must block ---------------------------------

test('unsafe output (claims it executed) is blocked', () => {
  const result = presentToAgent({ recommendedActions: [proposal({ executed: true })] });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'guardrail_blocked');
  assert.ok(result.violations.length > 0);
});

test('a blocked result surfaces NO actionable content', () => {
  const result = presentToAgent({ recommendedActions: [proposal({ executed: true })] });
  assert.equal(result.pendingApproval, undefined);
});

test('R4 scenario: a send without approval is blocked, not surfaced', () => {
  const action = proposal({ type: 'send_message' });
  delete action.requiresApproval; // assistant tries to send without a human OK
  const result = presentToAgent({ recommendedActions: [action] });
  assert.equal(result.blocked, true);
  assert.equal(result.pendingApproval, undefined);
});

test('malformed output is blocked (fail-closed)', () => {
  for (const bad of [null, undefined, 'x', 42, [], {}]) {
    const result = presentToAgent(bad);
    assert.equal(result.blocked, true, `expected ${JSON.stringify(bad)} to be blocked`);
    assert.equal(result.pendingApproval, undefined);
  }
});

// --- Idempotency / purity ---------------------------------------------------

test('boundary is pure: same input twice yields identical result and no mutation', () => {
  const input = { summary: 's', recommendedActions: [proposal()] };
  const snapshot = JSON.stringify(input);
  const first = presentToAgent(input);
  const second = presentToAgent(input);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(input), snapshot, 'input must not be mutated');
});
