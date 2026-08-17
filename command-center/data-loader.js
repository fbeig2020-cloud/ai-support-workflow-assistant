/**
 * Command Center — data loader.
 *
 * Fetches the real project state at runtime from .colaberry/plan.json,
 * .colaberry/progress.json, and .colaberry/manifest.json — nothing about
 * REAL data is hard-coded in this app anymore. Sample-mode fixtures stay in
 * sample-data.js (see that file for why).
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

  window.loadCommandCenterData = async function loadCommandCenterData() {
    const [plan, progress, manifest] = await Promise.all([
      fetchJson('../.colaberry/plan.json'),
      fetchJson('../.colaberry/progress.json'),
      fetchJson('../.colaberry/manifest.json'),
    ]);

    const real = {
      meta: plan.meta,
      guardrails: plan.guardrails,
      requirements: plan.requirements,
      releases: plan.releases,
      stories: plan.stories,
      systems: plan.systems,
      users: plan.users,
      foundationalWork: progress.foundationalWork,
      owners: progress.owners,
      connections: progress.connections,
    };

    return {
      data: { real, sample: window.COMMAND_CENTER_SAMPLE },
      manifest,
    };
  };

  // Pure — used by app.js to render the data-age bar on every tab.
  window.commandCenterDataAge = function commandCenterDataAge(manifest, now) {
    const updated = new Date(manifest.dataUpdated);
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
