// demo.js
// A live, in-class demo of the AI-Powered Business Support Workflow Assistant.
// Run with: node demo.js
//
// This uses FAKE, made-up ticket text only — no real company/customer data.
// It calls the project's real functions and prints their real output in a
// clean, readable way — no raw JavaScript objects on screen.

import { classifySupportRequest } from './src/classify.js';
import { searchKnowledgeBase } from './src/knowledgeBaseSearch.js';
import { generateDraftResponse } from './src/generateDraftResponse.js';

function heading(title) {
  console.log('\n' + '─'.repeat(64));
  console.log(title);
  console.log('─'.repeat(64));
}

function line(label, value) {
  console.log(`  ${label}: ${value}`);
}

async function runDemo() {
  // Step 0: the fake ticket
  const ticketText =
    "I can't log in, my password isn't working even though I'm sure it's right.";

  heading('STEP 0 — Incoming support ticket (fake / sample data)');
  console.log(`  "${ticketText}"`);

  // Step 1: classify
  heading('STEP 1 — Classify & prioritize');
  const classification = classifySupportRequest(ticketText);
  line('Category', classification.category);
  line('Priority', classification.priority);
  line('Matched signals', (classification.matchedSignals || []).join(', ') || '(none)');

  // Step 2: search knowledge base
  heading('STEP 2 — Search knowledge base for a fix');
  const kbResult = await searchKnowledgeBase(classification);
  line('Found a match?', kbResult.found ? 'Yes' : 'No');
  line('Confidence', kbResult.confidence);
  if (kbResult.results && kbResult.results.length > 0) {
    line('Matched article', kbResult.results[0].title || kbResult.results[0].id);
  }
  if (kbResult.message) {
    line('Note', kbResult.message);
  }

  // Step 3: generate draft response
  heading('STEP 3 — Generate draft reply (NOT sent, just proposed)');
  const draft = await generateDraftResponse(classification, kbResult);
  if (draft.draftText) {
    console.log('\n' + draft.draftText + '\n');
  } else if (draft.message) {
    console.log('\n' + draft.message + '\n');
  } else {
    console.log(draft);
  }

  // Step 4: the guardrail, made visible
  heading('STEP 4 — The guardrail, in plain sight');
  console.log(
    '  Notice: nothing above sent a message, closed a ticket, or changed\n' +
    '  anything real. Every result just sits here, waiting for a human\n' +
    '  to review and approve it. That rule is enforced in code, not just\n' +
    '  promised in a doc — see src/guardrail.js.'
  );
}

runDemo().catch((err) => {
  console.error('\nDemo hit an error (this is fine to show too — it means');
  console.error('the system failed closed instead of crashing silently):');
  console.error(err);
});
