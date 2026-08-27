---
description: Run this repo's Session Start Protocol — mint a Session ID, read CLAUDE.md and PROGRESS.md, summarize state
---

Execute the Session Start Protocol defined in the root `CLAUDE.md` (under "Logging, Reporting & Progress Tracking" → "Session start protocol"):

1. **Mint a unique Session ID** before any other work: format `CC-<YYYYMMDD>-<4 random alphanumeric chars>` (e.g. `CC-20260827-9k2p`). Use today's actual date. Generate the random suffix fresh — do not reuse a suffix already present in `PROGRESS.md`.
2. **Read `CLAUDE.md` fully** (root file; also note any subdirectory `CLAUDE.md` files relevant to work you expect to do this session).
3. **Read `PROGRESS.md` fully.** If it does not exist, note that it must be created before any work lands (per the PROGRESS.md update rule).
4. **Summarize current state**, leading with the Session ID, covering:
   - The first unchecked task in `PROGRESS.md`
   - Any open escalations or blockers noted there
   - Any rule in `CLAUDE.md` that seems most relevant to likely next work
5. **Make no code changes during this step.** This command is read-only reconnaissance only — do not edit, create, or delete any file.

State the minted Session ID clearly at the top of your summary so it can be reused for the rest of the session (including in later `/progress-audit` runs and commit bodies).
