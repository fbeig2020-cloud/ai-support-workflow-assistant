import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySupportRequest } from '../src/classify.js';

// This test exists to give the "Instant" INPACT dimension a real, repeatable
// measurement (wall-clock via process.hrtime.bigint()) instead of relying on
// session notes or anecdotal "it felt fast" observations.

const LOGIN_TICKET = "I can't log in to my account, it says I'm locked out after too many attempts.";
const POWER_BI_TICKET = 'My Power BI dashboard report is blank after the dataset refresh failed.';

const MAX_MS = 200;

test('classifySupportRequest classifies a login ticket in under 200ms', () => {
  const start = process.hrtime.bigint();
  classifySupportRequest(LOGIN_TICKET);
  const end = process.hrtime.bigint();

  const elapsedMs = Number(end - start) / 1_000_000;
  console.log(`classifySupportRequest (login ticket): ${elapsedMs.toFixed(3)}ms`);

  assert.ok(elapsedMs < MAX_MS, `expected under ${MAX_MS}ms, got ${elapsedMs.toFixed(3)}ms`);
});

test('classifySupportRequest stays under 200ms across 20 runs on a Power BI ticket', () => {
  const RUNS = 20;
  const timingsMs = [];

  for (let i = 0; i < RUNS; i++) {
    const start = process.hrtime.bigint();
    classifySupportRequest(POWER_BI_TICKET);
    const end = process.hrtime.bigint();
    timingsMs.push(Number(end - start) / 1_000_000);
  }

  const avgMs = timingsMs.reduce((sum, t) => sum + t, 0) / timingsMs.length;
  const maxMs = Math.max(...timingsMs);
  console.log(`classifySupportRequest (Power BI ticket, ${RUNS} runs): avg=${avgMs.toFixed(3)}ms max=${maxMs.toFixed(3)}ms`);

  assert.ok(maxMs < MAX_MS, `expected max under ${MAX_MS}ms across ${RUNS} runs, got ${maxMs.toFixed(3)}ms`);
});
