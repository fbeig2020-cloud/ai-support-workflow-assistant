/**
 * Sample-mode fixture only. This is believable, clearly-fake preview data —
 * never real project state — so it stays a JS literal instead of living in
 * .colaberry/ alongside the real plan/progress files.
 */
window.COMMAND_CENTER_SAMPLE = {
  stats: [
    { label: 'Tickets triaged this week', value: 42, sample: true },
    { label: 'Draft responses generated', value: 18, sample: true },
    { label: 'Escalations flagged', value: 3, sample: true },
    { label: 'Agent approval rate', value: '91%', sample: true },
  ],
  connections: [
    { name: 'Ticketing System', status: 'up', lastChecked: '2026-08-17T09:00:00Z', sample: true },
    { name: 'Knowledge Base', status: 'up', lastChecked: '2026-08-17T09:00:00Z', sample: true },
    { name: 'Identity / Access Directory', status: 'down', lastChecked: '2026-08-17T08:45:00Z', sample: true },
  ],
};
