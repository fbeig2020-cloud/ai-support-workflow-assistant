# Governance Policy — AI Support Workflow Assistant

This document defines the governance rules for the AI Support Workflow Assistant in plain English. These are rules only — they describe what is and is not allowed. Nothing in this file enforces these rules; enforcement is implemented separately.

---

## Rule 1 — Escalation Recommendation

**What it governs:** The assistant recommending that a support ticket be escalated to a human specialist.

**Who's allowed, and under what conditions:** The assistant can recommend escalation only when a real search of the knowledge base came up empty or failed — never for tickets where a good answer was found. The recommendation lands in the support agent's queue; a human specialist picks it up from there. The assistant never contacts anyone directly.

**Is a refusal final:** If a human rejects the escalation recommendation, that decision stands for that review — but a different human can still look at the ticket later and choose to escalate it manually, since the AI's refusal only covers its own recommendation, not what a person is allowed to do.

---

## Rule 2 — Draft Reply

**What it governs:** The assistant drafting a reply to a support request.

**Who's allowed, and under what conditions:** The assistant can only draft a reply after the ticket has already been classified — never before. If the draft is based on a weak or low-confidence match from the knowledge base, a human must fix it before it can be sent; it cannot go out as-is.

**Is a refusal final:** The assistant never sends anything itself — a human always reads, edits, and sends the reply. There's no refusal to override; the human is the only one who ever sends.

---

## Rule 3 — Classification

**What it governs:** The assistant classifying and prioritizing a support request.

**Who's allowed, and under what conditions:** The assistant classifies every request automatically as soon as it comes in — no trigger needed.

**Is a refusal final:** No — a human can always change the classification directly if they think it's wrong. There's no case where the AI's classification is locked in and can't be overridden.

---

## Rule 4 — Final Summary Generation

**What it governs:** The assistant generating the final support summary once a ticket is resolved.

**Who's allowed, and under what conditions:** The assistant generates the summary automatically once the ticket is resolved — no human has to ask for it. A human can edit the summary's wording before saving it. Saving is a manual, human-triggered action — it is never auto-saved by the assistant.

**Is a refusal final:** Not applicable — there's no refusal here, just generate, then optional human edit, then manual human save.

---

## Rule 5 — Audit Trail Logging

**What it governs:** The audit trail logging every action the assistant takes.

**Who's allowed, and under what conditions:** Every action — classify, search, draft, escalate, summarize — gets logged automatically, no exceptions. If the audit log fails to write, the action fails closed — it does not go through, and an alert is raised instead.

**Is a refusal final:** No one, including a human, can edit or delete a past log entry. If a mistake needs correcting, a new entry is added explaining the correction — the original entry stays exactly as it was.
