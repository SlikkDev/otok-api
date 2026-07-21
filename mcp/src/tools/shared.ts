import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { OtokApiError } from "@otok/node";
import type {
  AudienceEstimate,
  AudienceListParams,
  AudienceSummary,
  ContentInput,
  EmailCampaign,
  EmailCampaignCreateParams,
  EmailCampaignCreateResult,
  EmailCampaignListParams,
  EmailCampaignUpdateParams,
  EmailCampaignUpdateResult,
  Newsletter,
  NewsletterCreateParams,
  NewsletterIssue,
  NewsletterIssueCreateParams,
  NewsletterIssueCreateResult,
  NewsletterIssueListParams,
  NewsletterIssueUpdateParams,
  NewsletterIssueUpdateResult,
  NewsletterListParams,
  Paginated,
  SenderProfile,
  SenderProfileListParams,
} from "@otok/node";
import { z } from "zod";

/**
 * The slice of the SDK client the tools consume, typed structurally so tests
 * can substitute a plain mock object (the SDK's resource classes carry a
 * private `http` field, which nominal typing would force onto mocks).
 */
export interface ToolClient {
  audiences: {
    list(params?: AudienceListParams): Promise<Paginated<AudienceSummary>>;
  };
  senderProfiles: {
    list(params?: SenderProfileListParams): Promise<Paginated<SenderProfile>>;
  };
  emailCampaigns: {
    list(params?: EmailCampaignListParams): Promise<Paginated<EmailCampaign>>;
    get(id: string): Promise<EmailCampaign>;
    create(params: EmailCampaignCreateParams): Promise<EmailCampaignCreateResult>;
    update(
      id: string,
      params: EmailCampaignUpdateParams,
    ): Promise<EmailCampaignUpdateResult>;
    estimate(id: string): Promise<AudienceEstimate>;
    send(id: string): Promise<EmailCampaign>;
    schedule(id: string, scheduledAt: string): Promise<EmailCampaign>;
    unschedule(id: string): Promise<EmailCampaign>;
  };
  newsletters: {
    list(params?: NewsletterListParams): Promise<Paginated<Newsletter>>;
    get(id: string): Promise<Newsletter>;
    create(params: NewsletterCreateParams): Promise<Newsletter>;
    listIssues(
      newsletterId: string,
      params?: NewsletterIssueListParams,
    ): Promise<Paginated<NewsletterIssue>>;
    getIssue(issueId: string): Promise<NewsletterIssue>;
    createIssue(
      newsletterId: string,
      params?: NewsletterIssueCreateParams,
    ): Promise<NewsletterIssueCreateResult>;
    updateIssue(
      issueId: string,
      params: NewsletterIssueUpdateParams,
    ): Promise<NewsletterIssueUpdateResult>;
    deleteIssue(issueId: string): Promise<{ success: boolean }>;
    publishIssue(issueId: string): Promise<NewsletterIssue>;
    scheduleIssue(issueId: string, scheduledAt: string): Promise<NewsletterIssue>;
    unscheduleIssue(issueId: string): Promise<NewsletterIssue>;
  };
}

/** Everything a tool needs at call time. */
export interface ToolContext {
  client: ToolClient;
}

// ─────────────────────────── Content contract ───────────────────────────

/**
 * Shared authoring tutorial, embedded in the descriptions of every tool that
 * accepts a `content` parameter — the descriptions must TEACH the format,
 * because the caller is a language model authoring email content directly.
 */
export const CONTENT_GUIDE = `CONTENT AUTHORING — the "content" parameter is an object with optional "direction" ("ltr" | "rtl" — use "rtl" for Hebrew/Arabic) plus EXACTLY ONE of:
1. "markdown" (recommended for authoring) — a CommonMark subset: # ## ### headings, paragraphs, **bold**, *italic*, [links](https://…), - bullet lists, ![alt](https://…) images (absolute https URLs only), and --- dividers. Two extra directive lines, each alone on its own line:
   ::button[Label](https://example.com)   -> a themed call-to-action button
   ::snippet[name-or-uuid]                -> splices a reusable workspace snippet (footer, header, signature) by name or UUID
   Raw HTML never passes through — tags are stripped to their text with a warning.
2. "blocks" — a typed array of { kind, … } objects; kinds: heading (text, level 1–3), paragraph (text), button (label, url), bullets (items), spacer, image (url, alt), divider, snippet (id or name).
3. "design_json" — the raw stored editor document; ONLY for replaying content read back from the API, never for fresh authoring.
PERSONALIZATION: any text — including subject and preheader — may embed [[path : fallback]] variable tokens, e.g. "Hi [[first_name : there]]" resolves per recipient (fallback used when the value is empty). Optional formatting modifiers: [[path | upper]], [[signup_date | date]].
Every write response carries compile: { ok, errors, warnings } — fix errors before launching; warnings are lossy-but-accepted conversions (stripped HTML, dropped non-https image, clamped heading level, unknown ::directive kept as text). Total content size is capped at 512,000 characters.`;

const contentBlockSchema = z.object({
  kind: z
    .enum([
      "heading",
      "paragraph",
      "button",
      "bullets",
      "spacer",
      "image",
      "divider",
      "snippet",
    ])
    .describe("Block type; the other fields apply per kind."),
  text: z
    .string()
    .optional()
    .describe("heading/paragraph text; may embed [[path : fallback]] tokens."),
  level: z
    .number()
    .int()
    .min(1)
    .max(3)
    .optional()
    .describe("heading only — level 1–3 (default 2)."),
  label: z.string().optional().describe("button only — the button text."),
  url: z
    .string()
    .optional()
    .describe("button link / image source; image URLs must be absolute https."),
  items: z.array(z.string()).optional().describe("bullets only — the list items."),
  alt: z.string().optional().describe("image only — alt text."),
  id: z.string().uuid().optional().describe("snippet only — resolve by snippet UUID."),
  name: z
    .string()
    .optional()
    .describe("snippet only — resolve by case-insensitive exact name."),
});

/**
 * The shared content contract: optional direction + exactly one source.
 * The refine catches zero/two-plus sources client-side with a recoverable
 * message (the API would answer 400 `invalid_content`).
 */
export const contentInputSchema = z
  .object({
    direction: z
      .enum(["ltr", "rtl"])
      .optional()
      .describe("Text direction; rtl for Hebrew/Arabic content."),
    markdown: z
      .string()
      .optional()
      .describe(
        "CommonMark subset plus ::button[Label](https://url) and ::snippet[name-or-uuid] directive lines.",
      ),
    blocks: z
      .array(contentBlockSchema)
      .optional()
      .describe("Typed block array, rendered in order."),
    design_json: z
      .record(z.unknown())
      .optional()
      .describe("Raw editor document — only for replaying content read back from the API."),
  })
  .refine(
    (c) =>
      [c.markdown, c.blocks, c.design_json].filter((v) => v !== undefined)
        .length === 1,
    { message: "content requires exactly ONE of markdown | blocks | design_json" },
  );

/**
 * The zod shape above cannot express the SDK's `never`-field discriminated
 * union statically; the refine guarantees the exactly-one-source invariant at
 * runtime, so the cast is sound.
 */
export function asContentInput(
  value: z.infer<typeof contentInputSchema>,
): ContentInput {
  return value as unknown as ContentInput;
}

// ─────────────────────────── Results ───────────────────────────

const OMITTED_NOTE =
  "[omitted from tool output — stored document/compiled output; change content via the content parameter]";

/**
 * Replace the bulky stored-document/compiled columns with a marker so tool
 * results stay small for the model. `plain_text` is deliberately KEPT — it is
 * the readable rendering of the content. Nulls stay null so "no content yet"
 * remains visible.
 */
export function slim(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...record };
  for (const key of ["design_json", "compiled_html", "compiled_styles"]) {
    if (key in out && out[key] !== null && out[key] !== undefined) {
      out[key] = OMITTED_NOTE;
    }
  }
  return out;
}

export function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/**
 * Result for campaign/issue writes: the slimmed record, prefaced with a note
 * when the compile envelope reports errors or warnings so the model reacts
 * instead of skimming past them.
 */
export function writeResult(record: Record<string, unknown>): CallToolResult {
  const compile = record["compile"] as
    | { ok: boolean; errors: string[]; warnings: string[] }
    | undefined;
  let note = "";
  if (compile && !compile.ok) {
    note =
      "COMPILE ERRORS — the content did not compile cleanly. Fix the errors listed under compile.errors (re-send the content), then launch.\n";
  } else if (compile && compile.warnings.length > 0) {
    note =
      "Compiled with warnings (lossy-but-accepted conversions) — review compile.warnings below.\n";
  }
  return {
    content: [{ type: "text", text: note + JSON.stringify(slim(record), null, 2) }],
  };
}

/** First ~600 chars of the record's plain_text, for dry-run previews. */
export function contentPreview(record: Record<string, unknown>): string | null {
  const plain = record["plain_text"];
  if (typeof plain !== "string" || plain === "") return null;
  return plain.length > 600 ? `${plain.slice(0, 600)}…` : plain;
}

// ─────────────────────────── Confirm gate ───────────────────────────

/** Shared tail of every dry-run summary. */
export const CONFIRM_INSTRUCTION =
  "Show this summary to the user and get their explicit approval. Only after the user approves, call the same tool again with the same arguments plus confirm: true.";

export const confirmSchema = z
  .boolean()
  .default(false)
  .describe(
    "Safety gate. false (the default) performs NO action — it returns a dry-run summary to show the user. Pass true ONLY after the user explicitly approved that summary.",
  );

export function dryRunResult(headline: string, summary: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: `${headline}\n${JSON.stringify(summary, null, 2)}\n${CONFIRM_INSTRUCTION}`,
      },
    ],
  };
}

// ─────────────────────────── Errors ───────────────────────────

/**
 * Per-code recovery hints appended to API errors so the model can self-correct.
 * For `unknown_snippet` the API's own message already lists the workspace's
 * available snippet names — it is surfaced verbatim above the hint.
 */
const RECOVERY_HINTS: Record<string, string> = {
  unknown_snippet:
    "The error message above lists the workspace's available snippet names verbatim — re-send the content using one of those names (or the snippet's UUID) in ::snippet[…] / the snippet block.",
  invalid_content:
    "Re-check the content payload: exactly ONE of markdown | blocks | design_json, image URLs absolute https, and total size under 512,000 characters.",
  invalid_scheduled_at:
    "scheduled_at must be an ISO 8601 UTC instant in the future, e.g. 2026-08-01T09:00:00Z.",
  campaign_not_found:
    "No such campaign in this workspace — use list_email_campaigns to find the right id.",
  newsletter_not_found:
    "No such newsletter in this workspace — use list_newsletters to find the right id.",
  issue_not_found:
    "No such issue in this workspace — use list_newsletter_issues to find the right id.",
  sender_profile_not_found:
    "The sender_profile_id does not belong to this workspace — sender profiles are managed in oToK under Settings.",
  campaign_not_editable:
    "Only draft or scheduled campaigns can be edited — this one was already claimed by a launch.",
  campaign_not_sendable: "Only draft or scheduled campaigns can be sent.",
  campaign_not_schedulable: "Only draft or scheduled campaigns can be scheduled.",
  campaign_not_scheduled:
    "The campaign is not currently scheduled, so there is nothing to cancel.",
  already_sending:
    "The send sweep already claimed this campaign — it is sending now and can no longer be unscheduled.",
  launch_failed:
    "A launch gate failed and the campaign was marked failed (its final status rides the details as error.campaign_status). Fix the reported problem, then edit and send again.",
  issue_published:
    "Published issues can never be deleted — exclude the issue from the public archive instead (update_newsletter_issue with include_in_archive: false).",
  issue_already_published:
    "The issue is already published; scheduling applies only to unpublished issues.",
  issue_missing_content:
    "Publishing/scheduling requires a subject and compiled content — set them with update_newsletter_issue first.",
  issue_not_scheduled:
    "The issue is not currently scheduled, so there is nothing to cancel.",
  external_reference_in_use:
    "That external_reference already belongs to an issue of a DIFFERENT newsletter — one reference maps to one issue per workspace.",
  duplicate_name:
    "A record with that name already exists (names are unique per workspace, case-insensitive) — pick another name.",
  FEATURE_NOT_INCLUDED_IN_PLAN:
    "The workspace's plan does not include the feature behind this tool — upgrading the plan in oToK unlocks it.",
  PLAN_LIMIT_EXCEEDED:
    "The workspace reached its plan limit for this resource — remove/archive existing records or upgrade the plan in oToK.",
};

/** Format any thrown error as a recoverable tool error result. */
export function errorResult(err: unknown): CallToolResult {
  let text: string;
  if (err instanceof OtokApiError) {
    const lines = [
      `oToK API error (HTTP ${err.status}${err.code ? `, code "${err.code}"` : ""}): ${err.message}`,
    ];
    const hint = err.code !== undefined ? RECOVERY_HINTS[err.code] : undefined;
    if (hint) lines.push(hint);
    if (err.body !== undefined) lines.push(`Details: ${JSON.stringify(err.body)}`);
    text = lines.join("\n");
  } else {
    text = `Request failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  return { isError: true, content: [{ type: "text", text }] };
}

/** Run a tool body, converting thrown errors into recoverable error results. */
export async function runTool(
  fn: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return errorResult(err);
  }
}
