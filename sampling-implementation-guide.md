# Sampling Implementation Guide

*A step-by-step walkthrough for adding "sampling" to a server, using the Customer Support Assistant sample as the working example.*

---

## 1. Introduction: What Is Sampling?

When people hear the word "sampling," they usually think of music or statistics. In the context of an AI-powered server (like the Customer Support Assistant), **sampling means something different: it's the ability for a server to ask an AI model to generate text on its behalf, in the middle of doing its job.**

Think of it like this:

> Imagine a helpful office assistant (the **server**) who handles routine paperwork automatically. Every so often, the assistant runs into something that needs judgment or a human-quality written response — like drafting a reply to an upset customer. Instead of guessing, the assistant picks up the phone and asks a very knowledgeable colleague (the **AI model**, accessed through the **client** application) to help write that response. That phone call is "sampling."

In more technical terms: sampling is a capability, defined by the **Model Context Protocol (MCP)**, that lets a server pause what it's doing, send a request up to the connected AI client, and receive back a generated piece of text (a "completion") — which the server then uses to finish its task.

The key people/parts involved:

| Term | Plain-language meaning |
|---|---|
| **Server** | The program doing the work (e.g., the Customer Support Assistant). It knows the business logic but doesn't generate creative or nuanced text on its own. |
| **Client** | The application the server is connected to (e.g., Claude Desktop, an IDE, or a custom app). The client is the one actually connected to the AI model. |
| **Sampling request** | A message the server sends to the client saying, "Here's some context — please generate a response." |
| **Completion** | The text the AI model generates and sends back down to the server. |
| **Human-in-the-loop approval** | A safety checkpoint where a person can review and approve the request before it's sent, and the response before it's used. |

---

## 2. Why Sampling Matters

A non-technical way to think about why this feature is valuable:

1. **It lets "dumb" servers do "smart" things.** The server itself doesn't need to be an AI — it just needs to know *when* to ask for help and *what* to do with the answer. This keeps the server simple, predictable, and easy to maintain.
2. **It keeps a human (or a trusted client) in control.** Because the client sits between the server and the AI model, the client can review, edit, or block a sampling request before it ever reaches the model — and do the same with the response before the server uses it. This is a built-in safety net.
3. **It avoids duplicating AI access everywhere.** Without sampling, every server that wants "AI help" would need its own separate connection to an AI provider, its own API key, and its own cost tracking. With sampling, the server borrows the client's existing AI connection instead.
4. **It produces better, more natural results for tasks that are hard to hard-code**, such as:
   - Drafting a reply to a customer's message
   - Summarizing a long support ticket into a two-sentence summary
   - Detecting the emotional tone of a message (frustrated, confused, satisfied)
   - Suggesting the next best action for a support agent

In short: sampling is what turns a server from "a set of fixed rules" into "a set of fixed rules that knows when to ask for smart help."

---

## 3. Before You Start (Prerequisites)

You don't need to be a programmer to follow along and understand what's happening, but to actually *make the change*, someone will need:

- [ ] Access to the Customer Support Assistant sample server's source code
- [ ] A code editor (e.g., VS Code)
- [ ] Node.js installed (the sample server runs on Node.js)
- [ ] An MCP-compatible client to test with (e.g., Claude Desktop, or the MCP Inspector tool)
- [ ] About 30–45 minutes for the first pass

If you are a non-technical reader following along to *understand* the process (not necessarily to type the code yourself), you can skip straight to reading the explanations in plain language under each step — the code blocks are there for the person implementing it.

---

## 4. Step-by-Step: Adding Sampling to the Customer Support Assistant Sample

### Step 1 — Confirm the server declares the sampling capability

Every MCP server tells the client, up front, what it's able to do. Before a server can *ask* for sampling, it has to *declare* that it might use it — similar to a new employee listing "may occasionally need help from a specialist" on their intake form.

In the server's setup code, this looks like:

```ts
// server/index.ts
const server = new McpServer({
  name: "customer-support-assistant",
  version: "1.0.0",
}, {
  capabilities: {
    sampling: {}, // <-- tells the client "I may send sampling requests"
  },
});
```

**Plain language:** this one block of code is the server raising its hand and saying "heads up, I might ask you to generate some text for me later."

### Step 2 — Identify the moment in the workflow that needs AI help

Look through the Customer Support Assistant's existing tools and find a spot where the server currently either:
- has no good answer (e.g., it just returns the raw ticket text and hopes the human figures it out), or
- uses a rigid, canned response that doesn't feel personal.

For this sample, we'll use the **"draft a reply to a customer ticket"** tool as our example.

**Plain language:** this is the moment where our office assistant realizes "I can't write this reply myself — time to make the phone call."

### Step 3 — Write the sampling request

Inside that tool's code, instead of returning a hard-coded response, the server sends a `sampling/createMessage` request to the client. This is the actual "phone call."

```ts
// server/tools/draftReply.ts
async function draftReplyToCustomer(ticket: SupportTicket) {
  const response = await server.request({
    method: "sampling/createMessage",
    params: {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `A customer wrote the following support ticket:\n\n"${ticket.body}"\n\nWrite a warm, professional reply that acknowledges their issue and explains the next step. Keep it under 120 words.`,
          },
        },
      ],
      modelPreferences: {
        // Optional hints — the client decides the final model choice
        intelligencePriority: 0.7,
        speedPriority: 0.5,
      },
      systemPrompt: "You are a customer support specialist for a small software company. Be empathetic and concise.",
      maxTokens: 300,
    },
  });

  return response;
}
```

**Plain language breakdown of what's happening:**

- `messages` — this is the actual question/context being handed to the AI, just like you'd hand your colleague a sticky note with "here's the situation, please help."
- `modelPreferences` — optional dials the server can turn, hinting whether it wants a fast-and-cheap answer or a slow-and-thoughtful one. The client makes the final call on which AI model actually gets used.
- `systemPrompt` — background instructions that set the tone (e.g., "be empathetic and concise").
- `maxTokens` — a length cap, so the response doesn't run on forever.

### Step 4 — Handle the response safely

The client will show the request to whoever is in control (a human reviewer, or an automated policy, depending on setup) before it's sent to the AI, and again before the generated text is handed back. Once the server receives the completion, it should treat it like any other piece of untrusted external input — check it, don't blindly trust it.

```ts
// server/tools/draftReply.ts (continued)
if (response.content.type === "text") {
  const draftedReply = response.content.text.trim();

  // Basic sanity checks before using the AI's text
  if (draftedReply.length === 0) {
    throw new Error("Sampling returned an empty reply — falling back to manual review.");
  }

  return {
    ticketId: ticket.id,
    draftedReply,
    status: "pending_human_approval", // never auto-send without a human check
  };
}
```

**Plain language:** even though the AI wrote a nice reply, the server doesn't blindly forward it to the customer. It's marked as a *draft* awaiting a human's okay — the same way you wouldn't let a new employee's first email to a customer go out unread.

### Step 5 — Add a fallback for when sampling isn't available or fails

Not every client supports sampling, and network hiccups happen. The server should have a fallback so the whole feature doesn't break the tool.

```ts
async function draftReplySafely(ticket: SupportTicket) {
  try {
    return await draftReplyToCustomer(ticket);
  } catch (error) {
    // Sampling unavailable, timed out, or rejected by the client
    return {
      ticketId: ticket.id,
      draftedReply: "A support specialist will follow up with you shortly.",
      status: "manual_fallback",
    };
  }
}
```

**Plain language:** if the "phone call" to the AI doesn't go through, the assistant doesn't freeze up — it falls back to a safe, simple, pre-written message and flags the ticket for a human to handle directly.

### Step 6 — Test it end-to-end

1. Start the Customer Support Assistant server.
2. Connect it to an MCP client that supports sampling (Claude Desktop or the MCP Inspector both work well for testing).
3. Trigger the "draft a reply" tool on a sample support ticket.
4. Confirm you see the sampling request appear for approval in the client.
5. Approve it, and confirm a drafted reply comes back to the server.
6. Try disconnecting the client's AI access (or simulating an error) to confirm the fallback message appears instead of the tool crashing.

**Plain language:** this is the "practice run" — you're checking that the phone call works, that a human gets to approve it, and that if the phone line is down, the assistant still has something sensible to say.

---

## 5. Common Pitfalls to Watch For

| Pitfall | Why it matters | Fix |
|---|---|---|
| Forgetting to declare the `sampling` capability | The client won't know the server is allowed to ask for it | Add it during server setup (Step 1) |
| Sending sensitive customer data (full name, account number) in the prompt unnecessarily | Privacy risk — the text passes through the AI model | Strip or mask anything not needed to write a good reply |
| No length limit on the request | Can produce runaway costs or overly long responses | Always set `maxTokens` |
| Auto-sending the AI's draft without human review | Removes the safety checkpoint that sampling is designed to preserve | Keep a `pending_human_approval` status until reviewed |
| No fallback path | A single failed sampling call can break the whole tool | Wrap the call in a try/catch with a safe default (Step 5) |

---

## 6. Summary: Benefits of Sampling for This Project

Adding sampling to the Customer Support Assistant gives the project several concrete advantages:

- **Better customer replies.** Draft responses sound natural and specific to each ticket, instead of generic canned text.
- **Less manual writing work for support staff.** Agents review and tweak a draft instead of starting from a blank page.
- **Built-in safety.** Because the client mediates every request and response, there's always a checkpoint before AI-generated text reaches a real customer.
- **Simpler server code.** The server doesn't need to embed its own AI model or manage a separate AI subscription — it borrows the client's connection when needed.
- **Graceful degradation.** With a proper fallback in place, the assistant keeps working — just a little less "smart" — even if sampling is temporarily unavailable.
- **A pattern that scales.** Once this pattern exists for "draft a reply," the same approach can be reused for ticket summarization, sentiment detection, and other judgment-based tasks across the assistant.

Sampling turns the Customer Support Assistant from a rules-following script into a tool that knows when to ask for help — while keeping a human firmly in charge of what actually reaches the customer.
