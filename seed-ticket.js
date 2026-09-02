// One-off demo/testing script — not a permanent part of the project.
// Seeds a single realistic ticket into the queue via addTicketToQueue.
// Safe to delete after use.

import { addTicketToQueue } from './src/ticketQueue.js';

const ticket = {
  requestId: 'TICKET-DEMO-001',
  category: 'login_problem',
  priority: 'high',
  summary: "I can't log into my account, it keeps saying my password is wrong.",
  matchedSignals: ['log in', 'password', "can't log"],
  createdAt: new Date().toISOString(),
};

const result = addTicketToQueue(ticket);
console.log(JSON.stringify(result, null, 2));
