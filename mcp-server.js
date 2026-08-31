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
      description: "Record a human reviewer's approve/reject decision for a queued ticket",
      inputSchema: {
        type: "object",
        properties: {
          requestId: { type: "string" },
          decision: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["approve", "reject"] },
              reviewer: { type: "string" },
              reason: { type: "string" },
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
                { ok: false, error: `No queued ticket found for requestId "${requestId}".` },
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
