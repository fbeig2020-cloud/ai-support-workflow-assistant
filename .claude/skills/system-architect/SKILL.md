---
name: system-architect
description: Use when the user has a project idea and wants a system architecture, a technical design, or a diagram of how it would work.
---

# System Architect

Turn a one-paragraph project idea into a concrete system architecture: real components, a data-flow diagram, and plain-English explanations. Output ships as `project-blueprint/architecture.md`.

## Input

A one-paragraph description of a project idea. If the user hasn't given one yet, ask for it before proceeding — this skill has nothing to design without it.

## Process

### 1. Extract the real components

Read the idea closely and identify only the components it actually implies. Do not start from a generic template (frontend + backend + database + AI layer) and fill it in by default — that produces designs that ignore what the idea actually said.

For each candidate component, ask: does this specific idea need it?

- **Frontend / client** — does a person interact with this directly? Web app, mobile app, CLI, chat interface, browser extension — pick the shape the idea implies, not "a frontend" generically.
- **Backend / API** — is there server-side logic, orchestration, or a place business rules live? Name what it actually does (e.g. "booking API", "webhook receiver"), not just "backend."
- **Database / storage** — what data needs to persist, and what shape is it (relational records, documents, files, vectors)? Skip this if the idea is genuinely stateless.
- **External services** — payment processors, email/SMS providers, third-party APIs, auth providers, maps, calendars — only the ones the idea actually calls for.
- **AI / agent layer** — only if the idea involves generation, classification, agentic decision-making, or an LLM call. Name the role it plays (e.g. "classifier", "conversational agent", "summarizer"), not just "AI."
- **Anything else the idea implies** — background jobs, queues, schedulers, real-time channels (websockets), file/media processing, notification systems. Add components freely if the idea calls for them; omit any of the above freely if it doesn't.

If the idea is ambiguous about a component (e.g., unclear whether it needs a database), make the simplest reasonable assumption, state it as an assumption in the writeup, and proceed — don't stall on it.

### 2. Decide whether human-in-the-loop is required — do not default to it

Human review, approval, or oversight is a component like any other in step 1: it belongs in the design only if this specific idea calls for it. Never add a human-approval step as a standing template default, and never omit one just to keep the design fully automated — decide it fresh, from the idea, every time.

Include a human-in-the-loop component when the idea gives an **explicit signal** (words like "approve," "review," "reviewer," "sign-off," "confirm before," "a person must check," "human in the loop") or a strong **implicit signal** — the AI's output would trigger something high-stakes, irreversible, safety-critical, legally/financially binding, or publicly visible without a chance to catch errors (e.g. sending communications on a real person's behalf, medical/legal/financial determinations, deleting data, publishing content, taking actions on someone else's account).

Do not include one when the idea describes a low-stakes, reversible, or explicitly fully-automated flow (e.g. "automatically," "without human intervention," "no manual steps") — in that case, adding a review gate contradicts what was asked for.

If it's genuinely ambiguous, make the simplest reasonable call and state it as an assumption (per step 1's ambiguity rule) rather than defaulting either way.

When a human-in-the-loop component is included, treat it exactly like any other component from step 1: give it a real name tied to what it actually does in this system (e.g. "Editor Approval Queue," not generic "Human Review"), place it correctly in the data flow, and explain it in plain English in step 3.

### 3. Design the data flow

Work out how a user action actually moves through the system end to end: entry point → processing → storage/external calls → response. This becomes the mermaid diagram. The diagram must reflect this specific idea's real flow, not a generic layered-boxes template — arrows should represent actual calls/data movement (e.g. "submits form", "queries", "calls API", "returns result"), not just "connects to."

### 4. Write the plain-English explanation

For each component, write exactly one sentence a non-technical person could follow: what it is and what job it does in this system, in everyday language. No jargon without immediately explaining it. This is not a summary of the mermaid box label — it should read like you're describing the system to someone who has never seen an architecture diagram.

### 5. Assemble and save

Write the output to `project-blueprint/architecture.md` (create the `project-blueprint/` directory if it doesn't exist). Structure:

```markdown
# Architecture: <short project name>

## Idea

<the one-paragraph idea as given>

## Components

- **<Component name>**: <one plain-English sentence> — *(idea-specific: <quoted words from the idea> | generic architecture necessity: <why this is standard practice regardless of idea wording>)*
- **<Component name>**: <one plain-English sentence> — *(...)*
...

## Human-in-the-Loop

<Either: "Included — <component name>. Reason: <explicit quote from the idea, or the specific high-stakes/irreversible condition that implied it>." Or: "Not included. The idea describes <reversible/low-stakes/explicitly automated behavior> with no signal calling for human review or approval.">

## Data Flow

```mermaid
flowchart TD
    <genuine flowchart reflecting this idea's actual components and flow>
```

## Assumptions

<any assumptions made about ambiguous requirements, or "None." if none were needed>
```

The mermaid flowchart must use the actual component names from the Components section (not generic placeholders), and edges should be labeled with what moves across them where that clarifies the flow (e.g. `-->|user request|`, `-->|stores record|`).

Every component gets its provenance tagged as either **idea-specific** (traceable to actual words in the idea) or **generic architecture necessity** (infrastructure the named requirement can't function without — e.g. a datastore backing a stated "save this" requirement) — never leave a component unlabeled, and never tag a generic-practice addition as idea-specific just because it seems obviously good design.

## When finished, report

State explicitly:
1. The exact path the file was saved to (`project-blueprint/architecture.md`).
2. The final one-paragraph idea description used.
3. The component list identified, with a one-line reason each was included, and whether that reason was idea-specific or a generic architecture necessity.
4. The human-in-the-loop decision made for this project and why (included or not, and the signal — explicit or implicit — that drove the call).
