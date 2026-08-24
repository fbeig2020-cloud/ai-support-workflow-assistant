/**
 * Command Center — data loader.
 *
 * Fetches the real project state at runtime from .colaberry/plan.json,
 * .colaberry/progress.json, and .colaberry/manifest.json — nothing about
 * REAL data is hard-coded in this app anymore. Sample-mode fixtures stay in
 * sample-data.js (see that file for why).
 *
 * plan.json is schema_version 2 (owned by the Colaberry platform): requirements
 * carry `kind`/`statement`/`fulfilled_by` (an array of story ids) instead of
 * the old `type`/`text`/`builtBy`; stories carry `owner_agent`/`due_on`
 * instead of `owner`/`due`; releases carry `key`/`starts_on`/`ends_on`
 * instead of `id`/`start`/`end`; the old `meta`/`guardrails`/`systems`/`users`
 * moved to `project`/`derived.guardrails`/`derived.systems`/`derived.roles`.
 * Neither plan.json nor progress.json carries a `built`/`status` field
 * anymore — this loader computes both by joining progress.json's
 * `stories[].verification.state` onto plan.json's stories and requirements
 * by id, so app.js can keep reading a plain `built`/`status` field without
 * knowing about the join.
 *
 * Requires the page to be served over http(s); fetch() cannot read local
 * files when index.html is opened directly via file://. Run
 * `node scripts/serveCommandCenter.js` from the repo root.
 */
(function () {
  const FETCH_TIMEOUT_MS = 5000;
  const STALE_AFTER_DAYS = 7;

  async function fetchJson(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(path, { signal: controller.signal });
    } catch (err) {
      const wrapped = new Error(
        `Could not reach ${path}. If you opened this file directly (file://), local fetch is blocked — ` +
          `serve it instead: node scripts/serveCommandCenter.js from the repo root, then open the printed URL.`
      );
      wrapped.errorClass = err.name === 'AbortError' ? 'TimeoutError' : 'NetworkError';
      wrapped.cause = err;
      throw wrapped;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const err = new Error(`${path} responded ${res.status} ${res.statusText}`);
      err.errorClass = 'UpstreamUnavailable';
      throw err;
    }
    try {
      return await res.json();
    } catch (err) {
      const wrapped = new Error(`${path} did not parse as JSON: ${err.message}`);
      wrapped.errorClass = 'ContractViolation';
      throw wrapped;
    }
  }

  /** @param {Array<{id:string}>} [progressStories] @returns {Record<string, object>} */
  function indexProgressStories(progressStories) {
    return Object.fromEntries((progressStories || []).map((s) => [s.id, s]));
  }

  /**
   * A story is "verified" only if progress.json says so explicitly — a story
   * missing from progress.json (not yet synced) defaults to 'not_started'
   * rather than crashing or silently counting as done.
   * @param {string} storyId
   * @param {Record<string, object>} progressStoriesById
   * @returns {string}
   */
  function storyStatus(storyId, progressStoriesById) {
    const entry = progressStoriesById[storyId];
    return (entry && entry.verification && entry.verification.state) || 'not_started';
  }

  window.loadCommandCenterData = async function loadCommandCenterData() {
    const [plan, progress, manifest] = await Promise.all([
      fetchJson('../.colaberry/plan.json'),
      fetchJson('../.colaberry/progress.json'),
      fetchJson('../.colaberry/manifest.json'),
    ]);

    const progressStoriesById = indexProgressStories(progress.stories);

    const stories = (plan.stories || []).map((s) => ({
      ...s,
      status: storyStatus(s.id, progressStoriesById),
    }));

    const requirements = (plan.requirements || []).map((r) => {
      const fulfilledBy = Array.isArray(r.fulfilled_by) ? r.fulfilled_by : [];
      const built =
        fulfilledBy.length > 0 && fulfilledBy.every((id) => storyStatus(id, progressStoriesById) === 'verified');
      return { ...r, built };
    });

    const real = {
      project: plan.project,
      guardrails: (plan.derived && plan.derived.guardrails) || [],
      systems: (plan.derived && plan.derived.systems) || [],
      users: (plan.derived && plan.derived.roles) || [],
      requirements,
      releases: plan.releases,
      stories,
      // progress.json's schema is owned by the Colaberry platform (schema_version 2,
      // { stories: [{ id, criteria, verification }] }) and no longer carries these
      // three arrays. Default to empty so a missing key degrades to an empty state
      // instead of crashing render (real.foundationalWork.map(...) etc. in app.js).
      foundationalWork: progress.foundationalWork || [],
      owners: progress.owners || [],
      connections: progress.connections || [],
    };

    return {
      data: { real, sample: window.COMMAND_CENTER_SAMPLE },
      manifest,
    };
  };

  // Pure — used by app.js to render the data-age bar on every tab.
  window.commandCenterDataAge = function commandCenterDataAge(manifest, now) {
    const raw = manifest.generated_at || manifest.dataUpdated;
    const updated = new Date(raw);
    const nowDate = now || new Date();
    const days = (nowDate - updated) / 86400000;
    return {
      updated,
      days,
      isStale: days > STALE_AFTER_DAYS,
      staleAfterDays: STALE_AFTER_DAYS,
    };
  };
})();
