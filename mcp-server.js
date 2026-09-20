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
        "Call this when a brand-new support ticket arrives. Creates the ticket in the queue and classifies it, searches the knowledge base, and drafts a response, all automatically as part of the same call — no separate classify/search/draft steps needed. Normally returns status 'classified' with a real category, priority, kbSearchResult, and draftResponse already set, ready for a human to approve or reject via submitReviewDecision. If automatic classification unexpectedly fails, the ticket is still saved with status 'unclassified' and classificationError: true so it isn't lost; use classifyQueuedTicket to retry it later. If the knowledge-base search or draft-response step unexpectedly fails after a successful classification, the ticket is still saved with kbSearchFailed/draftGenerationFailed set instead, rather than losing the ticket or its real classification. Requires studentEmail for internal contact tracking — that email (and studentName, if given) is stored separately and is never shown back to you, never logged, and never used in classification or drafting.",
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
        "Recovery tool for a queued ticket that has no working classification — either one ingestSupportTicket saved with classificationError: true after automatic classification failed, or an older ticket that predates automatic classification and is still sitting at status 'unclassified'. Classifies it, searches the knowledge base, and drafts a response, then saves all of it back onto the ticket — so a recovered ticket ends up as complete as a freshly-ingested one. If the ticket is already classified, this quietly does nothing and says so — it never overwrites a category that's already there. If the ticket has no requestText to classify from, it fails with a clear message instead of guessing.",
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
    const result = await ingestSupportTicket(args, options);
    if (result.logEntry?.error_class) {
      await emitLog(toolInvocationError({ correlationId, tool: name, errorClass: result.logEntry.error_class }));
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }

  if (name === "classifyQueuedTicket") {
    const result = await classifyQueuedTicket(args?.requestId, options);
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

        // STORY-013: once reclassification actually succeeded, any
        // kbSearchResult/draftResponse already on the ticket are tied to the
        // now-superseded category — regenerate both against the fresh
        // classification so nothing stale survives next to the new one.
        // Skipped entirely when reclassificationFailed (nothing changed to
        // regenerate against — same case that already sets
        // reclassificationSkipped below). Neither call is expected to
        // throw (both are documented "never throws" contracts), but this is
        // guarded defensively anyway, same as ingestSupportTicket.js.
        let kbSearchResult;
        let kbSearchFailed;
        let kbSearchFailedMessage;
        let draftResponse;
        let draftGenerationFailed;
        let draftGenerationFailedMessage;
        if (!reclassificationFailed) {
          try {
            kbSearchResult = await searchKnowledgeBase(freshClassification, options);
          } catch (error) {
            kbSearchFailed = true;
            kbSearchFailedMessage = error instanceof Error ? error.message : String(error);
          }
          try {
            draftResponse = await generateDraftResponse(freshClassification, kbSearchResult, options);
          } catch (error) {
            draftGenerationFailed = true;
            draftGenerationFailedMessage = error instanceof Error ? error.message : String(error);
          }
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
            kbSearchFound: kbSearchResult?.found,
            kbSearchConfidence: kbSearchResult?.confidence,
            kbSearchFailed,
            draftGenerated: draftResponse?.generated,
            draftGenerationFailed,
          },
        };
        const auditResult = appendAuditEntry(logEntry, options);

        const rejectionCount = ticket.previouslyRejected === true ? (ticket.rejectionCount ?? 1) + 1 : 1;

        const requeueResult = addTicketToQueue(
          {
            ...ticket,
            ...(reclassificationFailed
              ? { reclassificationSkipped: true }
              : {
                  category: freshClassification.category,
                  priority: freshClassification.priority,
                  // Explicitly overwritten (not merged) with the fresh
                  // search/draft output, same as ingestSupportTicket.js /
                  // classifyQueuedTicket.js — never left mismatched with the
                  // new category.
                  kbSearchResult,
                  kbSearchFailed,
                  kbSearchFailedMessage,
                  draftResponse,
                  draftGenerationFailed,
                  draftGenerationFailedMessage,
                }),
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
      //
      // STORY-013: this call was missing entirely before — approve never
      // recorded a real human review decision, which is one of the reasons
      // generateSupportSummary() below always failed closed on
      // invalid_classification_review for every real ticket. Its "approved"
      // output shape already satisfies generateSupportSummary.js's
      // isValidReview() as-is.
      const classificationReviewResult = reviewClassification(
        { category: ticket.category, priority: ticket.priority },
        decision
      );
      if (!classificationReviewResult.ok) {
        await emitLog(
          toolInvocationError({
            correlationId,
            tool: name,
            errorClass: classificationReviewResult.logEntry?.error_class ?? "ValidationError",
          })
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: false,
                  error: `Approval could not be processed: ${classificationReviewResult.reason}.`,
                  classificationReviewResult,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Built explicitly (not a blind `...ticket` spread) since
      // generateSupportSummary() needs classification nested as
      // { category, priority }, not the ticket's flat fields. kbSearchResult
      // is genuinely optional there and passed through as-is (undefined if
      // the ticket predates this feature — already handled gracefully).
      // draftResponse is NOT optional there, but tolerant of a
      // generated: false result — ticket.draftResponse is passed through
      // as-is when present (whether it found a good draft or not; either
      // way it's the real, honest result generateDraftResponse() produced),
      // and only synthesized as an honest "not generated" stub when the
      // ticket has no draftResponse at all (a pre-STORY-013 ticket).
      const workflow = {
        ticketId: ticket.requestId,
        requestText: ticket.requestText,
        classification: { category: ticket.category, priority: ticket.priority },
        classificationReview: classificationReviewResult,
        kbSearchResult: ticket.kbSearchResult,
        draftResponse: ticket.draftResponse ?? {
          generated: false,
          editable: true,
          draftText: "",
          message: "This ticket predates automatic draft-response generation.",
        },
      };
      const summaryResult = generateSupportSummaryAndLog(workflow, options);
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

      const saveResult = saveSupportSummaryAndLog(summaryResult, options);
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
