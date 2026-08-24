/**
 * Command Center — rendering.
 * Real data is fetched at runtime by data-loader.js from .colaberry/plan.json
 * and .colaberry/progress.json — nothing here hard-codes a fact. Sample data
 * comes from sample-data.js. Every .cc-card is clickable and opens a
 * one-level-down detail view via modal.js.
 */
(function () {
  let DATA = null;
  let MANIFEST = null;

  const TABS = [
    { id: 'overview', label: 'Overview' },
    { id: 'outcomes', label: 'Outcomes' },
    { id: 'users', label: 'Users & Use Case' },
    { id: 'guardrails', label: 'Guardrails' },
    { id: 'systems', label: 'Systems' },
    { id: 'pm', label: 'Project Management' },
    { id: 'agents', label: 'AI Agents' },
    { id: 'kb', label: 'Knowledge Base' },
    { id: 'datamodel', label: 'Data Model' },
  ];
  const TAB_LABEL = Object.fromEntries(TABS.map((t) => [t.id, t.label]));

  // What each not-yet-built tab will hold, and what has to happen first.
  // Used for the placeholder page and as a fallback in its detail modal.
  const STUB_INFO = {
    outcomes: {
      will: 'One card per measure this system has to move.',
      first: 'The plan carries no numeric target yet — a target has to be set before this tab has anything to show.',
    },
    users: {
      will: 'The roles this is built for and what they’re trying to get done, taken from the story roles.',
      first: 'Straightforward to build from the two roles already in plan.json (support agent, system auditor) — next in line after Overview.',
    },
    guardrails: {
      will: 'REQ-008 and REQ-010 in full, each showing whether anything in the build currently enforces it.',
      first: 'The data already exists (see the Overview rollup) — this tab just needs its own detail view built.',
    },
    systems: {
      will: 'Every external system this assistant connects to, with live connection status.',
      first: 'The plan names no external system yet — this stays an empty state until one is scoped.',
    },
    pm: {
      will: 'A Gantt of r0/r1/r2 and every story underneath, each clickable to its own detail.',
      first: 'Release and story dates already exist in plan.json — needs a Gantt view built on top.',
    },
    agents: {
      will: 'One card per owner (Support Agent, support_agent, system_auditor) and the stories they’re on the hook for.',
      first: 'These are story owners, not scoped AI agents yet — the tab will say so rather than dressing up a job title as an agent.',
    },
    kb: {
      will: 'Every requirement, story, and decision this project knows about itself, plus a chat panel that cites which tab an answer came from.',
      first: 'Needs the other tabs’ data finalized first so the chat panel has something real to cite.',
    },
    datamodel: {
      will: 'The tables behind every tab above, with fields and relationships derived from the requirements.',
      first: 'Proposed before creation, not after — the model gets shown for review before any table is built.',
    },
  };

  let mode = 'real'; // default: never demo sample data by accident
  let activeTab = 'overview';

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso + 'T00:00:00Z');
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  function daysBetween(a, b) {
    return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
  }

  function nowISO() {
    return new Date().toISOString().slice(0, 10);
  }

  // A release with no starts_on/ends_on yet (schedule not populated in the
  // plan) is "unscheduled", not silently "complete" — the null/null case
  // would otherwise fall through every date comparison below to the final
  // "complete" branch, which would be a fabricated status, not a real one.
  function releaseStatus(release, today) {
    if (!release.starts_on || !release.ends_on) {
      return { label: 'unscheduled', cls: 'not-built' };
    }
    if (today < release.starts_on) {
      const n = daysBetween(today, release.starts_on);
      return { label: n === 1 ? 'starts tomorrow' : `starts in ${n} days`, cls: 'not-built' };
    }
    if (today >= release.starts_on && today <= release.ends_on) {
      return { label: 'in progress', cls: 'progress' };
    }
    return { label: 'complete', cls: 'built' };
  }

  function currentOrNextRelease(releases, today) {
    const active = releases.find((r) => r.starts_on && r.ends_on && today >= r.starts_on && today <= r.ends_on);
    if (active) return active;
    const upcoming = releases
      .filter((r) => r.starts_on && r.starts_on > today)
      .sort((a, b) => (a.starts_on > b.starts_on ? 1 : -1));
    return upcoming[0] || releases[releases.length - 1];
  }

  function pill(text, cls) {
    return `<span class="cc-pill ${cls}">${text}</span>`;
  }

  // ---------- drill-down detail content (one level down per card) ----------

  function detailSummary() {
    const real = DATA.real;
    const usersHtml = real.users.map((role) => `<li><strong>${role}</strong></li>`).join('');
    return {
      title: real.project.name,
      body: `<p>${real.project.descriptor}</p>
        <ul class="cc-detail-list">${usersHtml}</ul>
        <table class="cc-detail-table">
          <tr><th>Demo day</th><td>${fmtDate(real.project.demoDay)}</td></tr>
          <tr><th>Build ends</th><td>${fmtDate(real.project.buildEnds)}</td></tr>
          <tr><th>Requirements tracked</th><td>${real.requirements.length}</td></tr>
          <tr><th>Stories tracked</th><td>${real.stories.length}</td></tr>
        </table>`,
    };
  }

  function detailRelease() {
    const real = DATA.real;
    const today = nowISO();
    const body = real.releases
      .map((r) => {
        const st = releaseStatus(r, today);
        const stories = real.stories
          .filter((s) => s.release === r.key)
          .map(
            (s) => `<li><span class="req-id">${s.id}</span> ${s.title} — <em>${s.owner_agent}</em> ${pill(
              s.status.replace('_', ' '),
              s.status === 'verified' ? 'built' : 'not-built'
            )} <span class="cc-sub">due ${fmtDate(s.due_on)}</span></li>`
          )
          .join('');
        return `<div style="margin-bottom:14px">
          <div style="font-weight:600">${r.key} — ${r.name} ${pill(st.label, st.cls)}</div>
          <div class="cc-sub">${fmtDate(r.starts_on)} → ${fmtDate(r.ends_on)}</div>
          <ul class="cc-detail-list">${stories}</ul>
        </div>`;
      })
      .join('');
    return { title: 'Release you are in — full schedule', body };
  }

  function detailRequirements() {
    const real = DATA.real;
    const rows = real.requirements
      .map(
        (r) => `<li>
          <span class="req-id">${r.id}</span>
          <span class="req-text">[${r.kind}] ${r.statement} — ${r.fulfilled_by.join(', ')}</span>
          ${pill(r.built ? 'built' : 'not built', r.built ? 'built' : 'not-built')}
        </li>`
      )
      .join('');
    return { title: 'All requirements — full detail', body: `<ul class="cc-req-list">${rows}</ul>` };
  }

  function detailFoundational() {
    const real = DATA.real;
    const work = real.foundationalWork
      .map(
        (w) => `<div style="margin-bottom:14px">
          <div style="font-weight:600">${w.title}</div>
          <div class="cc-sub">${w.detail}</div>
          <div class="cc-sub">Files: ${w.files.join(', ')}</div>
          <div class="cc-sub">${w.verification} · shipped ${fmtDate(w.date)}</div>
        </div>`
      )
      .join('');
    // guardrails no longer carry mechanism/evidence/enforced under the new
    // plan.json schema (plan.derived.guardrails is just { id, statement }) —
    // showing only what's real rather than inventing an enforcement claim.
    const guardrails = real.guardrails
      .map(
        (g) => `<div style="margin-bottom:10px">
          <div><span class="req-id">${g.id}</span></div>
          <div class="cc-sub">${g.statement}</div>
        </div>`
      )
      .join('');
    return {
      title: 'Foundational work — full detail',
      body: `${work}<h4 style="margin:12px 0 6px">Guardrails this work backs</h4>${guardrails}`,
    };
  }

  function detailConnections() {
    const real = DATA.real;
    const sample = DATA.sample;
    if (mode === 'sample') {
      const rows = sample.connections
        .map(
          (c) => `<li><span class="cc-dot ${c.status}"></span> ${c.name} ${pill('sample', 'sample')} — checked ${new Date(c.lastChecked).toLocaleString()}</li>`
        )
        .join('');
      return {
        title: 'System connections (sample)',
        body: `<ul class="cc-detail-list">${rows}</ul><p class="cc-sub">Fabricated for preview only — no real connection has been made.</p>`,
      };
    }
    const count = real.systems.length;
    return {
      title: 'System connections',
      body: `<p>${count === 0 ? 'The plan names no external system yet, so there is nothing to connect to or check.' : real.systems.join(', ')}</p>
        <p class="cc-sub">Real connections will appear here, each with a live status dot, once a system is scoped in the plan.</p>`,
    };
  }

  function detailStats() {
    const rows = DATA.sample.stats.map((s) => `<li>${s.label}: <strong>${s.value}</strong> ${pill('sample', 'sample')}</li>`).join('');
    return {
      title: 'Illustrative volume — sample detail',
      body: `<ul class="cc-detail-list">${rows}</ul><p class="cc-sub">Made up, to preview shape. No workflow has run yet, so no real counts exist.</p>`,
    };
  }

  function detailStub(tabId) {
    const info = STUB_INFO[tabId];
    const real = DATA.real;
    let extra = '';
    if (tabId === 'guardrails') {
      extra = real.guardrails
        .map(
          (g) => `<div style="margin-bottom:10px"><span class="req-id">${g.id}</span><div class="cc-sub">${g.statement}</div></div>`
        )
        .join('');
    } else if (tabId === 'pm') {
      extra = real.releases
        .map((r) => {
          const stories = real.stories
            .filter((s) => s.release === r.key)
            .map((s) => `<li>${s.id} — ${s.title} (${s.owner_agent}, due ${fmtDate(s.due_on)})</li>`)
            .join('');
          return `<div style="margin-bottom:10px"><strong>${r.key} — ${r.name}</strong><ul class="cc-detail-list">${stories}</ul></div>`;
        })
        .join('');
    } else if (tabId === 'agents') {
      extra = `<ul class="cc-detail-list">${real.owners.map((o) => `<li>${o.name} — ${o.stories.join(', ')}</li>`).join('')}</ul>`;
    } else if (tabId === 'users') {
      extra = `<ul class="cc-detail-list">${real.users.map((role) => `<li><strong>${role}</strong></li>`).join('')}</ul>`;
    } else if (tabId === 'systems') {
      extra =
        real.systems.length === 0
          ? '<p class="cc-sub">No systems named in the plan yet.</p>'
          : `<ul class="cc-detail-list">${real.systems.map((s) => `<li>${s}</li>`).join('')}</ul>`;
    }
    return {
      title: `${TAB_LABEL[tabId]} — detail`,
      body: `<p><strong>What will live here:</strong> ${info.will}</p>
        <p><strong>What has to happen first:</strong> ${info.first}</p>
        ${extra}`,
    };
  }

  function getCardDetail(id) {
    switch (id) {
      case 'overview-summary':
        return detailSummary();
      case 'overview-release':
        return detailRelease();
      case 'overview-requirements':
        return detailRequirements();
      case 'overview-foundational':
        return detailFoundational();
      case 'overview-connections':
        return detailConnections();
      case 'overview-stats':
        return detailStats();
      default:
        return id.startsWith('stub-') ? detailStub(id.slice(5)) : null;
    }
  }

  function onCardClick(e) {
    const card = e.target.closest('.cc-card[data-card]');
    if (!card || !DATA) return;
    const detail = getCardDetail(card.dataset.card);
    if (!detail) return;
    window.CommandCenterModal.open(detail.title, detail.body);
  }

  // ---------- tab rendering ----------

  function renderOverview() {
    const real = DATA.real;
    const sample = DATA.sample;
    const today = nowISO();
    const focusRelease = currentOrNextRelease(real.releases, today);
    const focusStories = real.stories.filter((s) => s.release === focusRelease.key);
    const doneCount = focusStories.filter((s) => s.status === 'verified').length;

    const releaseStrip = real.releases
      .map((r) => {
        const st = releaseStatus(r, today);
        const isFocus = r.key === focusRelease.key;
        const storyCount = real.stories.filter((s) => s.release === r.key).length;
        return `<div class="cc-release-chip ${isFocus ? 'current' : ''}">
          <div class="rid">${r.key}${isFocus ? ' — you are here' : ''}</div>
          <div class="rname">${r.name}</div>
          <div class="rdates">${fmtDate(r.starts_on)} → ${fmtDate(r.ends_on)} · ${storyCount} stories</div>
          <div class="rstatus">${pill(st.label, st.cls)}</div>
        </div>`;
      })
      .join('');

    const reqRows = real.requirements
      .map(
        (r) => `<li>
          <span class="req-id">${r.id}</span>
          <span class="req-text">${r.statement} <span style="color:var(--cc-text-muted)">— ${r.fulfilled_by.join(', ')}</span></span>
          ${pill(r.built ? 'built' : 'not built', r.built ? 'built' : 'not-built')}
        </li>`
      )
      .join('');

    const foundational = real.foundationalWork
      .map(
        (w) => `<div style="margin-bottom:10px">
          <div style="font-weight:600;font-size:13px">${w.title}</div>
          <div style="font-size:13px;color:var(--cc-text-muted);margin:2px 0 6px">${w.detail}</div>
          <div style="font-size:12px;color:var(--cc-text-muted)">${w.files.join(', ')} · ${w.verification} · shipped ${fmtDate(w.date)}</div>
        </div>`
      )
      .join('');

    let connectionsHtml;
    if (mode === 'sample') {
      connectionsHtml = sample.connections
        .map(
          (c) => `<div class="cc-live-row">
            <span class="cc-dot ${c.status}"></span>
            <span class="name">${c.name}</span>
            ${pill('sample', 'sample')}
            <span class="checked">checked ${new Date(c.lastChecked).toLocaleString()}</span>
          </div>`
        )
        .join('');
    } else if (real.connections.length === 0) {
      connectionsHtml = `<div class="cc-live-row">
        <span class="cc-dot unknown"></span>
        <span class="name">No systems connected yet</span>
        <span class="checked">never checked</span>
      </div>`;
    } else {
      connectionsHtml = real.connections
        .map(
          (c) => `<div class="cc-live-row">
            <span class="cc-dot ${c.status}"></span>
            <span class="name">${c.name}</span>
            <span class="checked">checked ${new Date(c.lastChecked).toLocaleString()}</span>
          </div>`
        )
        .join('');
    }

    const statsHtml =
      mode === 'sample'
        ? `<div class="cc-card" data-card="overview-stats">
            <h3>Illustrative volume ${pill('sample', 'sample')}</h3>
            <p class="cc-sub">Made up, to show the shape of this card. Real numbers appear once the workflow runs.</p>
            <div class="cc-stat-grid">
              ${sample.stats
                .map((s) => `<div class="cc-stat"><div class="v">${s.value}</div><div class="l">${s.label}</div></div>`)
                .join('')}
            </div>
          </div>`
        : '';

    const usersLine = real.users.map((role) => `<strong>${role}</strong>`).join('<br/>');

    // The plan's schedule (demo day / build-end dates) isn't populated yet in
    // this schema sync (plan.project has no date fields, plan.schedule is
    // null) — show that honestly instead of computing NaN days from missing
    // dates.
    const demoPrepText =
      real.project.demoDay && real.project.buildEnds
        ? `Demo day ${fmtDate(real.project.demoDay)} · build ends ${fmtDate(real.project.buildEnds)} · ${daysBetween(real.project.buildEnds, real.project.demoDay)} days of demo prep after build ends.`
        : 'Demo day and build-end dates are not yet scheduled in the plan.';

    document.getElementById('tab-content').innerHTML = `
      <div class="cc-grid">
        <div class="cc-card cc-span-2" data-card="overview-summary">
          <h2>${real.project.name}</h2>
          <p class="cc-sub">${real.project.descriptor}</p>
          <div style="font-size:13px">${usersLine}</div>
        </div>

        <div class="cc-card cc-span-2" data-card="overview-release">
          <h3>Release you are in</h3>
          <div class="cc-release-strip">${releaseStrip}</div>
          <div class="cc-foot">${focusRelease.key} stories complete: ${doneCount} of ${focusStories.length} · ${demoPrepText}</div>
        </div>

        <div class="cc-card cc-span-2" data-card="overview-requirements">
          <h3>What's live, requirement by requirement</h3>
          <p class="cc-sub">All 10 requirements from the plan. "Built" means code in this repo enforces or delivers it today — not that a story is scheduled.</p>
          <ul class="cc-req-list">${reqRows}</ul>
        </div>

        <div class="cc-card" data-card="overview-foundational">
          <h3>Foundational work shipped early</h3>
          <p class="cc-sub">Ahead of the r0 story schedule, outside STORY-00x numbering.</p>
          ${foundational}
        </div>

        <div class="cc-card" data-card="overview-connections">
          <h3>System connections</h3>
          <p class="cc-sub">Grey means unknown, not healthy — nothing is wired up to check yet.</p>
          ${connectionsHtml}
        </div>

        ${statsHtml}
      </div>
      <p class="cc-foot">Generated from .colaberry/plan.json and .colaberry/progress.json as of ${fmtDate(today)}. Click any card for detail.</p>
    `;
  }

  function renderStub(tabId, label) {
    const info = STUB_INFO[tabId];
    document.getElementById('tab-content').innerHTML = `
      <div class="cc-stub cc-card" data-card="stub-${tabId}">
        <h2>${label}</h2>
        <p><strong>Not built yet.</strong> Overview came first, per plan — this tab is next in line.</p>
        <p class="cc-sub" style="margin-bottom:6px"><strong>What will live here:</strong> ${info.will}</p>
        <p class="cc-sub" style="margin-bottom:0"><strong>What has to happen first:</strong> ${info.first}</p>
        <p class="cc-sub" style="margin-top:10px">Click this card for what's already known.</p>
      </div>
    `;
  }

  function renderLoading() {
    document.getElementById('tab-content').innerHTML = `<div class="cc-card">Loading project state from .colaberry/…</div>`;
  }

  function renderLoadError(err) {
    document.getElementById('tab-content').innerHTML = `
      <div class="cc-card cc-load-error">
        <h3>Could not load project data</h3>
        <p>${err.message}</p>
        <p class="cc-sub">error class: ${err.errorClass || 'Error'}</p>
      </div>`;
    console.error('[command-center] data load failed', err.errorClass || 'Error', err);
  }

  function renderDataAgeBar() {
    const bar = document.getElementById('data-age-bar');
    if (!bar || !MANIFEST) return;
    const age = window.commandCenterDataAge(MANIFEST);
    const days = Math.floor(age.days);
    const label = days <= 0 ? 'updated today' : days === 1 ? '1 day ago' : `${days} days ago`;
    let text = `Data last updated ${fmtDate(age.updated.toISOString().slice(0, 10))} (${label})`;
    if (age.isStale) {
      text += ` — WARNING: over ${age.staleAfterDays} days old, may be out of date.`;
    }
    bar.textContent = text;
    bar.classList.toggle('stale', age.isStale);
  }

  function render() {
    document.body.setAttribute('data-mode', mode);
    document.querySelectorAll('nav.cc-tabs button').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === activeTab);
    });
    renderDataAgeBar();
    if (!DATA) return;
    if (activeTab === 'overview') {
      renderOverview();
    } else {
      const tab = TABS.find((t) => t.id === activeTab);
      renderStub(tab.id, tab.label);
    }
  }

  async function init() {
    const nav = document.querySelector('nav.cc-tabs');
    nav.innerHTML = TABS.map((t) => `<button data-tab="${t.id}">${t.label}</button>`).join('');
    nav.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-tab]');
      if (!btn) return;
      activeTab = btn.dataset.tab;
      render();
    });

    document.getElementById('mode-switch').addEventListener('click', () => {
      mode = mode === 'real' ? 'sample' : 'real';
      render();
    });

    document.getElementById('tab-content').addEventListener('click', onCardClick);

    renderLoading();
    try {
      const loaded = await window.loadCommandCenterData();
      DATA = loaded.data;
      MANIFEST = loaded.manifest;
    } catch (err) {
      renderLoadError(err);
      renderDataAgeBar();
      return;
    }
    render();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
