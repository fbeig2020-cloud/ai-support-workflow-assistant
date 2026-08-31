import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { classifySupportRequest } from "./src/classify.js";
import { searchKnowledgeBase } from "./src/knowledgeBaseSearch.js";
import { generateDraftResponse } from "./src/generateDraftResponse.js";
import { listQueuedTickets, addTicketToQueue, removeTicketFromQueue } from "./src/ticketQueue.js";
import { generateSupportSummaryAndLog, saveSupportSummaryAndLog } from "./src/auditedActions.js";
import { appendAuditEntry } from "./src/auditLog.js";

const server = new Server(
  { name: "ai-support-workflow-assistant", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {} } }
);

const RESOURCES = [
  {
    uri: "review://pending-requests",
    name: "pending-review-requests",
    description: "Tickets currently waiting in the human-review queue",
    mimeType: "application/json",
  },
];

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: RESOURCES,
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  if (uri === "review://pending-requests") {
    const tickets = listQueuedTickets();
    const payload = { result: tickets, skipped: tickets.skipped ?? [] };
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }

  throw new Error(`Unknown resource: ${uri}`);
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "classify",
      description: "Classify a support request into category and priority",
      inputSchema: {
        type: "object",
        properties: { requestText: { type: "string" } },
        required: ["requestText"],
      },
    },
    {
      name: "knowledgeBaseSearch",
      description: "Search the knowledge base using a classification result",
      inputSchema: {
        type: "object",
        properties: { classification: { type: "object" } },
        required: ["classification"],
      },
    },
    {
      name: "generateDraftResponse",
      description: "Generate a draft response from a classification and KB search result",
      inputSchema: {
        type: "object",
        properties: {
          classification: { type: "object" },
          kbSearchResult: { type: "object" },
        },
        required: ["classification", "kbSearchResult"],
      },
    },
    {
      name: "submitReviewDecision",
      description:
        "Call this when a human support reviewer has just told you their decision on a specific ticket that's sitting in the review queue — either 'approve it' (generate and save the ticket's final support summary, and remove it from the queue) or 'reject it' (send it back for another look). You need the ticket's requestId already in hand — read the pending-review-requests resource first if you don't have it — and the name of the reviewer giving the decision. Only call this after a human has actually stated approve or reject; never call it to guess what should happen to a ticket or to act on a ticket the reviewer hasn't looked at yet.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: { type: "string", minLength: 3, maxLength: 64 },
          decision: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["approve", "reject"] },
              reviewer: { type: "string", minLength: 1, maxLength: 100 },
              reason: { type: "string", maxLength: 500 },
            },
            required: ["action", "reviewer"],
          },
        },
        required: ["requestId", "decision"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "classify") {
    const result = classifySupportRequest(args.requestText);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }

  if (name === "knowledgeBaseSearch") {
    const result = await searchKnowledgeBase(args.classification);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }

  if (name === "generateDraftResponse") {
    const result = await generateDraftResponse(args.classification, args.kbSearchResult);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }

  if (name === "submitReviewDecision") {
    try {
      const { requestId, decision } = args;

      const queued = listQueuedTickets();
      const ticket = queued.find((t) => t.requestId === requestId);
      if (!ticket) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { found: false, message: `No queued ticket found for requestId "${requestId}".` },
                null,
                2
              ),
            },
          ],
        };
      }

      if (decision.action === "reject") {
        const rejectionReason = decision.reason ?? null;

        const logEntry = {
          timestamp: new Date().toISOString(),
          level: "info",
          service: "mcp-server",
          event: "ticket_rejected",
          outcome: "success",
          context: {
            requestId,
            reviewer: decision.reviewer,
            reason: rejectionReason,
          },
        };
        const auditResult = appendAuditEntry(logEntry);

        const rejectionCount = ticket.previouslyRejected === true ? (ticket.rejectionCount ?? 1) + 1 : 1;

        const requeueResult = addTicketToQueue({
          ...ticket,
          previouslyRejected: true,
          rejectionReason,
          rejectionCount,
        });

        if (!requeueResult.ok) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    ok: false,
                    error: `Rejection was logged, but the ticket could not be returned to the queue: ${requeueResult.message}`,
                    auditResult,
                    requeueResult,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: true,
                  message: `Rejection recorded for ${requestId}; ticket returned to the queue (rejectionCount=${rejectionCount}).`,
                  auditResult,
                  requeueResult,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // decision.action === "approve"
      const workflow = { ticketId: ticket.requestId, ...ticket };
      const summaryResult = generateSupportSummaryAndLog(workflow);
      if (!summaryResult.generated) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: false, error: summaryResult.message, summaryResult }, null, 2),
            },
          ],
        };
      }

      const saveResult = saveSupportSummaryAndLog(summaryResult);
      if (!saveResult.saved) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: false, error: saveResult.message, summaryResult, saveResult }, null, 2),
            },
          ],
        };
      }

      removeTicketFromQueue(requestId);

      return { content: [{ type: "text", text: JSON.stringify(summaryResult, null, 2) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ok: false, error: error instanceof Error ? error.message : String(error) },
              null,
              2
            ),
          },
        ],
      };
    }
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
