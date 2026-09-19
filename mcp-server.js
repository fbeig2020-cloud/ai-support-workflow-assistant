import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { classifySupportRequest } from "./src/classify.js";
import { searchKnowledgeBase } from "./src/knowledgeBaseSearch.js";
import { generateDraftResponse } from "./src/generateDraftResponse.js";
import { listQueuedTickets, addTicketToQueue, removeTicketFromQueue } from "./src/ticketQueue.js";
import { generateSupportSummaryAndLog, saveSupportSummaryAndLog } from "./src/auditedActions.js";
import { ingestSupportTicket } from "./src/ingestSupportTicket.js";
import { classifyQueuedTicket } from "./src/classifyQueuedTicket.js";
import { reviewClassification } from "./src/reviewClassification.js";
import { appendAuditEntry } from "./src/auditLog.js";
import {
  toolInvocationStarted,
  toolInvocationFinished,
  diskReadStarted,
  diskReadFinished,
  requestRejected,
  toolInvocationError,
} from "./src/mcpLogEvents.js";

const server = new Server(
  { name: "ai-support-workflow-assistant", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {}, logging: {} } }
);

/**
 * Send one structured log notification (Observability Framework shape) to
 * the connected MCP client via the declared `logging` capability. A logging
 * failure (no client connected, transport closed) must never break the tool
 * call it's describing, so this always swallows its own errors.
 * @param {{ level: string, data: object }} event
 */
async function emitLog({ level, data }) {
  try {
    await server.sendLoggingMessage({ level, logger: "mcp-server", data });
  } catch {
    // Logging is best-effort observability, never a reason to fail a tool call.
  }
}

/** Wires searchKnowledgeBase's/generateDraftResponse's onDiskRead hook to structured logs. */
function onDiskReadFor(correlationId, tool) {
  return async (evt) => {
    if (evt.phase === "started") {
      await emitLog(diskReadStarted({ correlationId, tool, file: evt.file }));
    } else {
      await emitLog(
        diskReadFinished({
          correlationId,
          tool,
          file: evt.file,
          outcome: evt.outcome,
          durationMs: evt.durationMs,
          errorClass: evt.errorClass,
        })
      );
    }
  };
}

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

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [],
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
    {
      name: "ingestSupportTicket",
      description:
        "Call this when a brand-new support ticket arrives. Creates the ticket in the queue AND classifies it automatically as part of the same call — no separate classify step needed. Normally returns status 'classified' with a real category and priority already set. If automatic classification unexpectedly fails, the ticket is still saved with status 'unclassified' and classificationError: true so it isn't lost; use classifyQueuedTicket to retry it later. Requires studentEmail for internal contact tracking — that email (and studentName, if given) is stored separately and is never shown back to you, never logged, and never used in classification or drafting.",
      inputSchema: {
        type: "object",
        properties: {
          ticketId: { type: "string" },
          requestText: { type: "string" },
          studentEmail: { type: "string" },
          studentName: { type: "string" },
          source: { type: "string" },
        },
        required: ["ticketId", "requestText", "studentEmail"],
      },
    },
    {
      name: "classifyQueuedTicket",
      description:
        "Recovery tool for a queued ticket that has no working classification — either one ingestSupportTicket saved with classificationError: true after automatic classification failed, or an older ticket that predates automatic classification and is still sitting at status 'unclassified'. Classifies it and saves the result back onto the ticket. If the ticket is already classified, this quietly does nothing and says so — it never overwrites a category that's already there. If the ticket has no requestText to classify from, it fails with a clear message instead of guessing.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: { type: "string", minLength: 1 },
        },
        required: ["requestId"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const correlationId = randomUUID();
  const startedAt = Date.now();

  await emitLog(toolInvocationStarted({ correlationId, tool: name }));

  try {
    const result = await dispatchTool(name, args, correlationId);
    await emitLog(
      toolInvocationFinished({ correlationId, tool: name, outcome: "success", durationMs: Date.now() - startedAt })
    );
    return result;
  } catch (error) {
    if (!error.mcpLogRejectionLogged) {
      await emitLog(
        toolInvocationError({ correlationId, tool: name, errorClass: error.errorClass ?? "UnhandledToolError" })
      );
    }
    await emitLog(
      toolInvocationFinished({ correlationId, tool: name, outcome: "failure", durationMs: Date.now() - startedAt })
    );
    throw error;
  }
});

/**
 * Executes one tool call. Emits the tool-specific structured log events
 * (disk reads, fail-closed rejections, checked-failure error classes) that
 * only make sense with knowledge of which tool is running; the caller above
 * handles the tool-wide started/finished/error boundaries every tool shares.
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {string} correlationId
 * @param {{ queueDir?: string, logPath?: string }} [options]   Override the queue directory /
 *   audit log path (tests only).
 */
export async function dispatchTool(name, args, correlationId, options = {}) {
  if (name === "classify") {
    const result = classifySupportRequest(args.requestText);
    if (result.logEntry?.error_class) {
      await emitLog(toolInvocationError({ correlationId, tool: name, errorClass: result.logEntry.error_class }));
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }

  if (name === "ingestSupportTicket") {
    const result = ingestSupportTicket(args, options);
    if (result.logEntry?.error_class) {
      await emitLog(toolInvocationError({ correlationId, tool: name, errorClass: result.logEntry.error_class }));
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }

  if (name === "classifyQueuedTicket") {
    const result = classifyQueuedTicket(args?.requestId, options);
    if (!result.ok && result.errorClass) {
      await emitLog(toolInvocationError({ correlationId, tool: name, errorClass: result.errorClass }));
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }

  if (name === "knowledgeBaseSearch") {
    const result = await searchKnowledgeBase(args.classification, {
      onDiskRead: onDiskReadFor(correlationId, name),
    });
    if (result.logEntry?.error_class) {
      await emitLog(toolInvocationError({ correlationId, tool: name, errorClass: result.logEntry.error_class }));
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }

  if (name === "generateDraftResponse") {
    const result = await generateDraftResponse(args.classification, args.kbSearchResult, {
      onDiskRead: onDiskReadFor(correlationId, name),
    });
    if (result.logEntry?.error_class) {
      await emitLog(toolInvocationError({ correlationId, tool: name, errorClass: result.logEntry.error_class }));
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }

  if (name === "submitReviewDecision") {
    try {
      const { requestId, decision } = args;

      const queued = listQueuedTickets(options);
      const ticket = queued.find((t) => t.requestId === requestId);
      if (!ticket) {
        await emitLog(requestRejected({ correlationId, tool: name, reason: "ticket_not_found" }));
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

        const reviewResult = reviewClassification({ category: ticket.category, priority: ticket.priority }, decision);
        if (!reviewResult.ok) {
          await emitLog(
            toolInvocationError({
              correlationId,
              tool: name,
              errorClass: reviewResult.logEntry?.error_class ?? "ValidationError",
            })
          );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    ok: false,
                    error: `Rejection could not be processed: ${reviewResult.reason}.`,
                    reviewResult,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // Re-run classification on the original request text, per
        // reviewClassification.js's documented contract that the caller (not
        // that module) closes the reclassification loop on reject. Falls
        // back to the ticket's existing category/priority if the ticket
        // never had requestText to reclassify from, rather than silently
        // overwriting a real classification with classifySupportRequest's
        // fail-closed defaults.
        const freshClassification = classifySupportRequest(ticket.requestText);
        const reclassificationFailed = Boolean(freshClassification.logEntry?.error_class);
        if (reclassificationFailed) {
          await emitLog(
            toolInvocationError({ correlationId, tool: name, errorClass: freshClassification.logEntry.error_class })
          );
        }

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
        const auditResult = appendAuditEntry(logEntry, options);

        const rejectionCount = ticket.previouslyRejected === true ? (ticket.rejectionCount ?? 1) + 1 : 1;

        const requeueResult = addTicketToQueue(
          {
            ...ticket,
            ...(reclassificationFailed
              ? { reclassificationSkipped: true }
              : { category: freshClassification.category, priority: freshClassification.priority }),
            previouslyRejected: true,
            rejectionReason,
            rejectionCount,
          },
          options
        );

        if (!requeueResult.ok) {
          await emitLog(
            toolInvocationError({
              correlationId,
              tool: name,
              errorClass: requeueResult.logEntry?.error_class ?? "QueueWriteFailedError",
            })
          );
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
        await emitLog(
          toolInvocationError({
            correlationId,
            tool: name,
            errorClass: summaryResult.logEntry?.error_class ?? "SummaryGenerationFailedError",
          })
        );
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
        await emitLog(
          toolInvocationError({
            correlationId,
            tool: name,
            errorClass: saveResult.logEntry?.error_class ?? "SaveFailedError",
          })
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: false, error: saveResult.message, summaryResult, saveResult }, null, 2),
            },
          ],
        };
      }

      removeTicketFromQueue(requestId, options);

      return { content: [{ type: "text", text: JSON.stringify(summaryResult, null, 2) }] };
    } catch (error) {
      await emitLog(
        toolInvocationError({
          correlationId,
          tool: name,
          errorClass: error instanceof Error ? error.constructor.name : "UnknownError",
        })
      );
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

  await emitLog(requestRejected({ correlationId, tool: name, reason: "unknown_tool" }));
  const unknownToolError = Object.assign(new Error(`Unknown tool: ${name}`), { mcpLogRejectionLogged: true });
  throw unknownToolError;
}

// Only connect to real stdio when this file is run directly (`node mcp-server.js`),
// not when it's imported as a module (e.g. by tests importing dispatchTool) — otherwise
// the import itself hangs waiting on a real MCP client that will never arrive.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
