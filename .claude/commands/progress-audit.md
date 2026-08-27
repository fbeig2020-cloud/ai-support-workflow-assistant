---
description: Run this repo's End-of-Session Audit — verify every file changed this session has a tagged PROGRESS.md entry
---

Execute the End-of-Session Audit defined in the root `CLAUDE.md` (under "Logging, Reporting & Progress Tracking" → "PROGRESS.md update rule" → "End-of-session audit"). Use the Session ID established earlier in this conversation (from `/session-start` or stated explicitly by the user) — if no Session ID has been established, stop and ask for it before proceeding.

1. **List every file modified in this session** (use `git status` / `git diff --stat` against the state at session start, or your own record of Edit/Write calls this session — whichever is more complete).
2. **Confirm each modification has a corresponding `PROGRESS.md` entry tagged with this session's ID**, following the required entry format in `CLAUDE.md` (task name, Date, Session, What changed, Verification, Notes if applicable).
3. **Audit only entries carrying your own Session ID.** Never touch, "clean up," or re-check another session's entries — other instances may be writing `PROGRESS.md` concurrently.
4. **Before appending anything**, re-read the current tail of `PROGRESS.md` — it may have changed since you last read it. Append after the current last line.
5. **If any entry is missing, write it now** before ending — include verification evidence (test result, `tsc --noEmit` pass, deploy confirmation, or explicit user confirmation). Do not mark anything `[x]` without that evidence on the same line.
6. **State the audit result explicitly**, in this exact form: `Session CC-<id>: PROGRESS.md audit: N changes, N entries, audit clean.` If it was not clean until you wrote missing entries, say so and show what was added.

If this session touched `/backend`, `/frontend`, `/scripts`, `/nginx`, or `/directives` with no corresponding `PROGRESS.md` touch at all, treat that as a hard gate failure per CLAUDE.md and fix it before reporting done.
