// This test exists to give the "Natural" INPACT dimension a real, automated,
// repeatable check instead of relying on manual observation that the
// student-facing draft path stays free of internal/technical jargon as the
// codebase grows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDraftResponse } from '../src/generateDraftResponse.js';
import { classifySupportRequest } from '../src/classify.js';
import { searchKnowledgeBase } from '../src/knowledgeBaseSearch.js';

const BANNED_TERMS = [
  'confidence',
  'matchedSignals',
  'logEntry',
  'undefined',
  'null',
  '{{',
  'requiresApproval',
  'kbConfidence',
];

function containsJargon(text) {
  const lower = text.toLowerCase();
  return BANNED_TERMS.some((term) => lower.includes(term.toLowerCase()));
}

// --- containsJargon helper ---------------------------------------------------

test('containsJargon flags text containing a banned internal term, case-insensitively', () => {
  assert.equal(containsJargon('Our CONFIDENCE in this match is high.'), true);
  assert.equal(containsJargon('See the matchedSignals for details.'), true);
  assert.equal(containsJargon('This field is currently NULL.'), true);
});

test('containsJargon returns false for clean student-facing text', () => {
  assert.equal(containsJargon('Hello, thanks for reaching out. Here are the steps to resolve this.'), false);
});

// --- Full pipeline: draft text stays jargon-free -----------------------------

test('a login problem ticket produces a jargon-free draft', async () => {
  const classification = classifySupportRequest("I can't log in, I'm locked out of my account.");
  const kbResult = await searchKnowledgeBase(classification);
  const draft = await generateDraftResponse(classification, kbResult);

  assert.equal(containsJargon(draft.draftText), false);
});

test('a Power BI dashboard issue ticket produces a jargon-free draft', async () => {
  const classification = classifySupportRequest('Power BI dashboard refresh failed for the whole team.');
  const kbResult = await searchKnowledgeBase(classification);
  const draft = await generateDraftResponse(classification, kbResult);

  assert.equal(containsJargon(draft.draftText), false);
});

test('a vague, general support request produces a jargon-free draft', async () => {
  const classification = classifySupportRequest('Something seems off with my account, not sure what.');
  const kbResult = await searchKnowledgeBase(classification);
  const draft = await generateDraftResponse(classification, kbResult);

  assert.equal(containsJargon(draft.draftText), false);
});
