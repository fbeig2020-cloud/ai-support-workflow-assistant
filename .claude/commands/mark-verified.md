---
description: Mark a story's acceptance criteria verified in .colaberry/progress.json and recompute totals
---

Mark `$ARGUMENTS` (a STORY-ID, e.g. `STORY-008`, optionally followed by a commit SHA) as verified in
`.colaberry/progress.json`, following the pattern already used for STORY-001 through STORY-007 in this
repo's history (e.g. commits `aa50ebc9`, `7b3fc504`, `5968beb2`).

If no STORY-ID was given in `$ARGUMENTS`, stop and ask which story to mark verified.

1. **Cross-check against `.colaberry/plan.json` first.** Find the story in `plan.json.stories` by id. Its
   `acceptance` array is the source of truth for what "verified" means — do not verify criteria that
   aren't in `plan.json`, and do not silently drop any. If the story doesn't exist in `plan.json`, stop.
2. **Confirm the criteria actually pass.** Do not mark verified from intent — check the story's
   acceptance criteria against real, working code/tests in this session (or ask the user to confirm
   each one). This mirrors the Definition of Done in `CLAUDE.md`: "No `[x]` mark without verification
   evidence."
3. **Determine the verifying commit.** Default to the current `HEAD` (`git rev-parse HEAD` for
   `commit_sha`, `git log -1 --format=%aI HEAD` for `commit_at`). Build `commit_url` from the actual
   `git remote get-url origin` (normalize `git@host:org/repo.git` or `https://host/org/repo.git` to
   `https://host/org/repo/commit/<sha>`) — do not hardcode a different repo's URL, and do not assume the
   URL already recorded on other stories still matches this repo's current remote. If `$ARGUMENTS`
   included an explicit SHA, use that instead and look up its `commit_at` via `git log -1 --format=%aI <sha>`.
4. **Update the story's entry in `.colaberry/progress.json`:**
   - Set each entry in `criteria[]` to `"passed": true` only for criteria confirmed in step 2. If any
     criterion isn't actually met yet, leave it `false`, keep `verification.state` as `"in_progress"` (not
     `"verified"`), and populate `verification.outstanding` with that criterion's text.
   - Only when *every* criterion passes: set `verification.state` to `"verified"`, `criteria_passed` to
     `criteria_total` (which must equal `criteria.length`), `verified_at` to the current ISO-8601
     timestamp, `commit_sha`/`commit_url`/`commit_at` from step 3, `points_awarded` to `100` (matching
     every other verified story in this file — flag it to the user if a different value seems warranted),
     and `outstanding` to `[]`.
5. **Recompute the top-level `totals` block** in `progress.json` from the `stories[]` array itself — never
   hand-adjust individual totals fields:
   - `stories_total` = `stories.length`
   - `stories_verified` / `stories_submitted` / `stories_in_progress` / `stories_not_started` = counts by
     each story's `verification.state`
   - `criteria_total` = sum of every story's `acceptance_total`
   - `criteria_passed` = sum of every story's `verification.criteria_passed`
   - `points_awarded` = sum of every story's `verification.points_awarded` (treat `null` as `0`)
6. **Validate the result before moving on**: both files still parse as JSON, and the numbers you just wrote
   are internally consistent. This is exactly what the `check-colaberry-schema` PostToolUse hook also
   checks on save — if it blocks your edit, it found something this step missed; fix that, don't fight it.
7. **Update `PROGRESS.md`** per the hard gate in `CLAUDE.md` — `.colaberry/progress.json` ships with the
   repo, so this needs an entry with verification evidence, tagged with the current Session ID.
8. **Report** the new `totals` line and which story's state changed.
