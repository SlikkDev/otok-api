import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  asContentInput,
  confirmSchema,
  contentInputSchema,
  contentPreview,
  CONTENT_GUIDE,
  dryRunResult,
  jsonResult,
  runTool,
  slim,
  writeResult,
  type ToolContext,
} from "./shared";

export const NEWSLETTER_TOOL_NAMES = [
  "list_newsletters",
  "get_newsletter",
  "create_newsletter",
  "list_newsletter_issues",
  "get_newsletter_issue",
  "create_newsletter_issue",
  "update_newsletter_issue",
  "delete_newsletter_issue",
  "publish_newsletter_issue",
  "schedule_newsletter_issue",
  "unschedule_newsletter_issue",
] as const;

const newsletterId = z
  .string()
  .uuid()
  .describe("The newsletter's id (from list_newsletters).");

const issueId = z
  .string()
  .uuid()
  .describe("The issue's id (from list_newsletter_issues or a create result).");

export function registerNewsletterTools(
  server: McpServer,
  { client }: ToolContext,
): void {
  server.registerTool(
    "list_newsletters",
    {
      title: "List newsletters",
      description:
        "List the workspace's smart newsletters (sequenced issues with per-subscriber catch-up delivery), newest first, each with its live active_subscriber_count. Pages with limit (default 25, max 100) + offset.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Page size (default 25, max 100)."),
        offset: z.number().int().min(0).optional().describe("Rows to skip (for paging)."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => runTool(async () => jsonResult(await client.newsletters.list(args))),
  );

  server.registerTool(
    "get_newsletter",
    {
      title: "Get a newsletter",
      description:
        "Fetch one newsletter: status, sender profile, live active_subscriber_count, plus the stored configuration (enrollment policy, catch-up cadence, archive settings — managed in oToK).",
      inputSchema: { newsletter_id: newsletterId },
      annotations: { readOnlyHint: true },
    },
    async ({ newsletter_id }) =>
      runTool(async () => jsonResult(await client.newsletters.get(newsletter_id))),
  );

  server.registerTool(
    "create_newsletter",
    {
      title: "Create a newsletter",
      description:
        "Create a newsletter — a name alone suffices; cadence, enrollment policy and archive settings take their defaults and are configured in oToK. A duplicate name answers 409 duplicate_name; the plan's newsletter cap answers 403 PLAN_LIMIT_EXCEEDED.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(120)
          .describe("Newsletter name, unique per workspace (case-insensitive, max 120 chars)."),
        description: z.string().optional().describe("Optional internal description."),
        sender_profile_id: z
          .string()
          .uuid()
          .optional()
          .describe("Verified sender profile id; omit to use the workspace default at send time."),
      },
    },
    async (args) => runTool(async () => jsonResult(await client.newsletters.create(args))),
  );

  server.registerTool(
    "list_newsletter_issues",
    {
      title: "List newsletter issues",
      description:
        "List a newsletter's issues, newest first. issue_number is assigned AT PUBLISH — issue #N is always the Nth published issue; drafts show null. Rows omit the stored content — use get_newsletter_issue for one issue's full record. Pages with limit (default 25, max 100) + offset; optionally filter by status.",
      inputSchema: {
        newsletter_id: newsletterId,
        status: z
          .enum(["draft", "scheduled", "published"])
          .optional()
          .describe("Only issues in this status."),
        limit: z.number().int().min(1).max(100).optional().describe("Page size (default 25, max 100)."),
        offset: z.number().int().min(0).optional().describe("Rows to skip (for paging)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ newsletter_id, ...params }) =>
      runTool(async () => {
        const page = await client.newsletters.listIssues(newsletter_id, params);
        return jsonResult({ ...page, data: page.data.map(slim) });
      }),
  );

  server.registerTool(
    "get_newsletter_issue",
    {
      title: "Get a newsletter issue",
      description:
        "Fetch one issue: subject/preheader, status, issue_number (null until published), schedule, archive flag, and a plain_text rendering of its content.",
      inputSchema: { issue_id: issueId },
      annotations: { readOnlyHint: true },
    },
    async ({ issue_id }) =>
      runTool(async () => jsonResult(slim(await client.newsletters.getIssue(issue_id)))),
  );

  server.registerTool(
    "create_newsletter_issue",
    {
      title: "Create a newsletter issue",
      description: `Create a DRAFT issue in a newsletter's sequence — nothing is delivered until publish_newsletter_issue or schedule_newsletter_issue. All fields are optional (an issue can start as an empty placeholder), but publishing requires a subject and compiled content. The response carries compile: {ok, errors, warnings}.
IDEMPOTENCY: pass "external_reference" (your own stable key) to make the create replay-safe — a repeat call with the same reference updates the matched issue's content/fields (response has duplicate: true) and never touches its status, scheduled_at, or issue_number. One reference maps to one issue per workspace — reusing it under a different newsletter answers 409 external_reference_in_use.
${CONTENT_GUIDE}`,
      inputSchema: {
        newsletter_id: newsletterId,
        subject: z
          .string()
          .max(400)
          .optional()
          .describe("Email subject; may embed [[path : fallback]] tokens."),
        preheader: z
          .string()
          .optional()
          .describe("Inbox preview text shown after the subject; may embed [[…]] tokens."),
        include_in_archive: z
          .boolean()
          .optional()
          .describe("Whether the issue appears in the newsletter's public archive (default true)."),
        external_reference: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe("Your idempotency key, unique per workspace (max 255 chars)."),
        content: contentInputSchema
          .optional()
          .describe("The issue body — see the content contract in this tool's description."),
      },
    },
    async ({ newsletter_id, content, ...rest }) =>
      runTool(async () =>
        writeResult(
          await client.newsletters.createIssue(newsletter_id, {
            ...rest,
            content: content === undefined ? undefined : asContentInput(content),
          }),
        ),
      ),
  );

  server.registerTool(
    "update_newsletter_issue",
    {
      title: "Update a newsletter issue",
      description: `Edit an issue — only the fields you pass are touched; pass null to clear subject/preheader. Published issues stay editable (a content change recompiles and future deliveries use it); a scheduled issue's content cannot be cleared — unschedule first.
${CONTENT_GUIDE}`,
      inputSchema: {
        issue_id: issueId,
        subject: z.string().max(400).nullable().optional().describe("New subject (null clears)."),
        preheader: z.string().nullable().optional().describe("New preheader (null clears)."),
        include_in_archive: z
          .boolean()
          .optional()
          .describe("Whether the issue appears in the newsletter's public archive."),
        content: contentInputSchema
          .optional()
          .describe("Replacement body — see the content contract in this tool's description."),
      },
    },
    async ({ issue_id, content, ...rest }) =>
      runTool(async () =>
        writeResult(
          await client.newsletters.updateIssue(issue_id, {
            ...rest,
            content: content === undefined ? undefined : asContentInput(content),
          }),
        ),
      ),
  );

  server.registerTool(
    "delete_newsletter_issue",
    {
      title: "Delete a newsletter issue",
      description:
        "Permanently delete a NEVER-PUBLISHED (draft or scheduled) issue — this cannot be undone. Published issues can never be deleted (the API answers 400 issue_published); exclude them from the public archive instead (update_newsletter_issue with include_in_archive: false).",
      inputSchema: { issue_id: issueId },
      annotations: { destructiveHint: true },
    },
    async ({ issue_id }) =>
      runTool(async () => jsonResult(await client.newsletters.deleteIssue(issue_id))),
  );

  server.registerTool(
    "publish_newsletter_issue",
    {
      title: "Publish a newsletter issue",
      description:
        "Publish an issue NOW: it is assigned the next issue number, delivered immediately to every caught-up subscriber, and enters catch-up delivery for subscribers still working through earlier issues — real email to real people. SAFETY: without confirm: true this tool performs NO action; it returns a dry-run summary (issue details, content preview, and the newsletter's active_subscriber_count) to show the user. Only after the user explicitly approves, call again with confirm: true. Publishing requires a subject and compiled content (409 issue_missing_content); publishing an already-published issue is a no-op.",
      inputSchema: { issue_id: issueId, confirm: confirmSchema },
      annotations: { destructiveHint: true },
    },
    async ({ issue_id, confirm }) =>
      runTool(async () => {
        if (!confirm) {
          const issue = await client.newsletters.getIssue(issue_id);
          const newsletter = await client.newsletters.get(issue.newsletter_id);
          return dryRunResult("DRY RUN — nothing was published.", {
            dry_run: true,
            action: "publish_newsletter_issue",
            issue: {
              id: issue.id,
              subject: issue.subject,
              preheader: issue.preheader,
              status: issue.status,
              include_in_archive: issue.include_in_archive,
              content_preview: contentPreview(issue),
            },
            newsletter: {
              id: newsletter.id,
              name: newsletter.name,
              status: newsletter.status,
              active_subscriber_count: newsletter.active_subscriber_count,
            },
            note:
              issue.status === "published"
                ? "This issue is ALREADY published — publishing again is a no-op."
                : "Publishing assigns the next issue number, delivers the issue to all caught-up subscribers immediately, and starts catch-up delivery (at the newsletter's cadence) for subscribers still behind.",
          });
        }
        return jsonResult(slim(await client.newsletters.publishIssue(issue_id)));
      }),
  );

  server.registerTool(
    "schedule_newsletter_issue",
    {
      title: "Schedule a newsletter issue",
      description:
        "Schedule (or reschedule) an issue's publish for a future instant; an every-minute sweep publishes it when due — real email goes out then without further approval. SAFETY: without confirm: true this tool performs NO action; it returns a dry-run summary (issue details + the newsletter's active_subscriber_count + the requested time) to show the user. Only after the user explicitly approves, call again with confirm: true. Requires a subject and compiled content (409 issue_missing_content); already-published issues answer 409 issue_already_published.",
      inputSchema: {
        issue_id: issueId,
        scheduled_at: z
          .string()
          .datetime({ offset: true })
          .describe("ISO 8601 UTC instant in the future, e.g. 2026-08-01T09:00:00Z."),
        confirm: confirmSchema,
      },
      annotations: { destructiveHint: true },
    },
    async ({ issue_id, scheduled_at, confirm }) =>
      runTool(async () => {
        if (!confirm) {
          const issue = await client.newsletters.getIssue(issue_id);
          const newsletter = await client.newsletters.get(issue.newsletter_id);
          return dryRunResult("DRY RUN — nothing was scheduled.", {
            dry_run: true,
            action: "schedule_newsletter_issue",
            requested_scheduled_at: scheduled_at,
            issue: {
              id: issue.id,
              subject: issue.subject,
              status: issue.status,
              current_scheduled_at: issue.scheduled_at,
              content_preview: contentPreview(issue),
            },
            newsletter: {
              id: newsletter.id,
              name: newsletter.name,
              active_subscriber_count: newsletter.active_subscriber_count,
            },
            note: "Once scheduled, the every-minute sweep publishes the issue at the requested time with no further approval — delivery then behaves exactly like publish_newsletter_issue.",
          });
        }
        return jsonResult(
          slim(await client.newsletters.scheduleIssue(issue_id, scheduled_at)),
        );
      }),
  );

  server.registerTool(
    "unschedule_newsletter_issue",
    {
      title: "Unschedule a newsletter issue",
      description:
        "Cancel a scheduled issue publish, returning it to draft. Safe: works only while the issue is scheduled — any other status answers 409 issue_not_scheduled.",
      inputSchema: { issue_id: issueId },
    },
    async ({ issue_id }) =>
      runTool(async () =>
        jsonResult(slim(await client.newsletters.unscheduleIssue(issue_id))),
      ),
  );
}
