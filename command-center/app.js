/**
 * Command Center — rendering.
 * Reads everything from window.COMMAND_CENTER_DATA (data.js). No tab
 * hard-codes a fact; they all pull from the same object so pointing the
 * Command Center at a real backend later means changing data.js, not the tabs.
 */
(function () {
  const DATA = window.COMMAND_CENTER_DATA;

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

  // What each not-yet-built tab will hold, and what has to happen first.
  // Used only for the placeholder page — no invented data.
  const STUB_INFO = {
    outcomes: {
      will: 'One card per measure this system has to move.',
      first: 'The plan carries no numeric target yet — a target has to be set before this tab has anything to show.',
    },
    users: {
      will: 'The roles this is built for and what they’re trying to get done, taken from the story roles.',
      first: 'Straightforward to build from the two roles already in data.js (support agent, system auditor) — next in line after Overview.',
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
      first: 'Release and story dates already exist in data.js — needs a Gantt view built on top.',
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

  function releaseStatus(release, today) {
    if (today < release.start) {
      const n = daysBetween(today, release.start);
      return { label: n === 1 ? 'starts tomorrow' : `starts in ${n} days`, cls: 'not-built' };
    }
    if (today >= release.start && today <= release.end) {
      return { label: 'in progress', cls: 'progress' };
    }
    return { label: 'complete', cls: 'built' };
  }

  function currentOrNextRelease(releases, today) {
    const active = releases.find((r) => today >= r.start && today <= r.end);
    if (active) return active;
    const upcoming = releases.filter((r) => r.start > today).sort((a, b) => (a.start > b.start ? 1 : -1));
    return upcoming[0] || releases[releases.length - 1];
  }

  function pill(text, cls) {
    return `<span class="cc-pill ${cls}">${text}</span>`;
  }

  function renderOverview() {
    const real = DATA.real;
    const sample = DATA.sample;
    const today = real.meta.today;
    const focusRelease = currentOrNextRelease(real.releases, today);
    const focusStories = real.stories.filter((s) => s.release === focusRelease.id);
    const doneCount = focusStories.filter((s) => s.status === 'done').length;

    const releaseStrip = real.releases
      .map((r) => {
        const st = releaseStatus(r, today);
        const isFocus = r.id === focusRelease.id;
        return `<div class="cc-release-chip ${isFocus ? 'current' : ''}">
          <div class="rid">${r.id}${isFocus ? ' — you are here' : ''}</div>
          <div class="rname">${r.name}</div>
          <div class="rdates">${fmtDate(r.start)} → ${fmtDate(r.end)} · ${r.storyCount} stories</div>
          <div class="rstatus">${pill(st.label, st.cls)}</div>
        </div>`;
      })
      .join('');

    const reqRows = real.requirements
      .map((r) => {
        return `<li>
          <span class="req-id">${r.id}</span>
          <span class="req-text">${r.text} <span style="color:var(--cc-text-muted)">— ${r.builtBy}</span></span>
          ${pill(r.built ? 'built' : 'not built', r.built ? 'built' : 'not-built')}
        </li>`;
      })
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
        ? `<div class="cc-card">
            <h3>Illustrative volume ${pill('sample', 'sample')}</h3>
            <p class="cc-sub">Made up, to show the shape of this card. Real numbers appear once the workflow runs.</p>
            <div class="cc-stat-grid">
              ${sample.stats
                .map((s) => `<div class="cc-stat"><div class="v">${s.value}</div><div class="l">${s.label}</div></div>`)
                .join('')}
            </div>
          </div>`
        : '';

    const usersLine = real.users.map((u) => `<strong>${u.role}</strong> — ${u.wants}`).join('<br/>');

    document.getElementById('tab-content').innerHTML = `
      <div class="cc-grid">
        <div class="cc-card cc-span-2">
          <h2>${real.meta.name}</h2>
          <p class="cc-sub">${real.meta.tagline}</p>
          <div style="font-size:13px">${usersLine}</div>
        </div>

        <div class="cc-card cc-span-2">
          <h3>Release you are in</h3>
          <div class="cc-release-strip">${releaseStrip}</div>
          <div class="cc-foot">${focusRelease.id} stories complete: ${doneCount} of ${focusStories.length} · Demo day ${fmtDate(real.meta.demoDay)} · build ends ${fmtDate(real.meta.buildEnds)} · ${daysBetween(real.meta.buildEnds, real.meta.demoDay)} days of demo prep after build ends.</div>
        </div>

        <div class="cc-card cc-span-2">
          <h3>What's live, requirement by requirement</h3>
          <p class="cc-sub">All 10 requirements from the plan. "Built" means code in this repo enforces or delivers it today — not that a story is scheduled.</p>
          <ul class="cc-req-list">${reqRows}</ul>
        </div>

        <div class="cc-card">
          <h3>Foundational work shipped early</h3>
          <p class="cc-sub">Ahead of the r0 story schedule, outside STORY-00x numbering.</p>
          ${foundational}
        </div>

        <div class="cc-card">
          <h3>System connections</h3>
          <p class="cc-sub">Grey means unknown, not healthy — nothing is wired up to check yet.</p>
          ${connectionsHtml}
        </div>

        ${statsHtml}
      </div>
      <p class="cc-foot">Generated from PROGRESS.md, CLAUDE.md requirements/stories, and a live re-run of <code>npm test</code> as of ${fmtDate(today)}.</p>
    `;
  }

  function renderStub(tabId, label) {
    const info = STUB_INFO[tabId];
    document.getElementById('tab-content').innerHTML = `
      <div class="cc-stub cc-card">
        <h2>${label}</h2>
        <p><strong>Not built yet.</strong> Overview came first, per plan — this tab is next in line.</p>
        <p class="cc-sub" style="margin-bottom:6px"><strong>What will live here:</strong> ${info.will}</p>
        <p class="cc-sub" style="margin-bottom:0"><strong>What has to happen first:</strong> ${info.first}</p>
      </div>
    `;
  }

  function render() {
    document.body.setAttribute('data-mode', mode);
    document.querySelectorAll('nav.cc-tabs button').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === activeTab);
    });
    if (activeTab === 'overview') {
      renderOverview();
    } else {
      const tab = TABS.find((t) => t.id === activeTab);
      renderStub(tab.id, tab.label);
    }
  }

  function init() {
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

    render();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
