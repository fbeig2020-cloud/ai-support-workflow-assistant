# Transport Decision Record — MCP Server

## Questions and Answers

1. **Who calls this server, and from where?**
   Just me, from my own laptop, via Claude Code.

2. **How many people or processes call it at the same time, realistically?**
   Just me, one at a time. (Note: in a future job context this could differ, 
   but that's out of scope for this project as it stands today.)

3. **Does it need to run on more than one machine, now or within a year?**
   No — single machine only, with no plans to change within the next year.

4. **Does anything about it have to survive between requests?**
   No. Every tool reads from or writes to disk (the ticket queue, the audit 
   trail, the summaries folder) rather than holding anything important in the 
   server process's own memory. Stopping and restarting the server between 
   calls would lose nothing.

5. **What is the worst thing that happens if it is unavailable for an hour?**
   Wasted personal time during development/demos — no real harm to a student, 
   and no data loss, since nothing important lives only in memory.

## Decision

**Transport chosen: STDIO**

**State model chosen: Stateless server process, persistent state on disk.**

## Rationale

Every answer points the same direction: this is a single-user, single-machine, 
one-at-a-time capstone project with no need for anything to survive in the 
server's memory between calls. STDIO exactly matches this — it's a direct, 
local connection between Claude Code and my server process, with no need for 
a network address, authentication, or handling concurrent connections. Adding 
HTTP/SSE transport would introduce real complexity (a listening port, 
concurrent request handling, possibly authentication) that solves problems 
this project doesn't have.

## Option Rejected

**HTTP/SSE transport** — rejected because it exists to solve problems this 
project doesn't have: multiple simultaneous callers, callers on different 
machines, or a server that needs to keep running independently of any one 
client session. None of my five answers support that need.

## Revisit Condition

I would revisit this decision if the server ever needs to be called by more 
than one person or process at the same time, or from a machine other than 
the one running it.

## If This Were Real: What Would Change

This project is scoped as a capstone demonstrating the pattern, not a 
production system real students depend on. If it became real — actual 
students relying on it to get their tickets answered — my answers to three 
of the five questions above would change, and so would the decision:

- **Question 3** would change from "single machine" to "yes, it needs to run 
  somewhere always-on" — not tied to whether my personal laptop happens to be 
  powered on and connected.
- **Question 5** would change from "wasted personal time" to genuine harm: 
  a real student's problem goes unanswered while the system is down, which is 
  a much more serious failure mode than an inconvenience to me.
- **Question 2** would likely also change, since a real deployment could mean 
  multiple support agents or students interacting with the system around the 
  same time, not just me, one at a time.

If those answers changed, **STDIO would no longer be the right choice** — it 
only works when a client launches the server directly as a local subprocess 
on the same machine. A real deployment would need **HTTP/SSE transport** 
(or similar), hosted somewhere that stays running independently of my own 
laptop, so the server keeps answering requests even when I'm not at my 
computer.

This is a deliberate, documented scope boundary for the capstone — not an 
oversight. Taking this project from "demonstrates the pattern" to "students 
actually depend on it" would be a real next phase, requiring this transport 
decision to be revisited honestly at that point, not assumed to carry over 
unchanged.
