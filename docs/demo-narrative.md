# Demo Narrative — PREP-1

**Project:** AI-Powered Business Support Workflow Assistant
**Purpose:** The spoken story for presenting this project in class — the problem, the one moment that lands, and the guardrail that makes it trustworthy.

---

## 1. The Problem

Support agents get buried in tickets. For every single one, they have to
figure out what kind of problem it is, how urgent it is, look up the fix,
and write a reply — all by hand, one ticket at a time.

## 2. The One Moment

*(Say this while running `node demo.js` live.)*

"Watch this. Here's a real support message: 'I can't log in, my password
isn't working even though I'm sure it's right.' I'll run it through the
assistant now."

*(run `node demo.js`)*

"In seconds: it's tagged as a login problem, medium priority, matched to
the right troubleshooting article, and a draft reply is written — ready
for a human to check and send."

## 3. The Guardrail

"Notice what it did NOT do: it didn't send anything, didn't close the
ticket, didn't touch anything real. It only prepared a recommendation.
A human always has to approve it before anything happens — that's built
into the system, not just a promise. See `src/guardrail.js`."

---

## Demo ticket used (fake / sample data only)

> "I can't log in, my password isn't working even though I'm sure it's right."

No real customer or company data is used anywhere in this demo.
