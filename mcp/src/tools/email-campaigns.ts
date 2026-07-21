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

export const EMAIL_CAMPAIGN_TOOL_NAMES = [
  "list_audiences",
  "list_sender_profiles",
  "list_email_campaigns",
  "get_email_campaign",
  "create_email_campaign",
  "update_email_campaign",
  "send_email_campaign",
  "schedule_email_campaign",
  "unschedule_email_campaign",
] as const;

const campaignId = z
  .string()
  .uuid()
  .describe("The email campaign's id (from list_email_campaigns or a create result).");

const TARGETING_GUIDE = `TARGETING: "audience_id" references a saved workspace audience (discover ids with list_audiences; wins over audience_filters); "audience_filters" is an ad-hoc $where condition tree (the contacts list filter grammar); "contact_group_ids" adds contact-group targeting. Whatever you target, the send pipeline always applies the email consent + suppression baseline — an audience can only narrow it. "topic_key" scopes the send to a preference-center topic (opted-out contacts are excluded).`;

export function registerEmailCampaignTools(
  server: McpServer,
  { client }: ToolContext,
): void {
  server.registerTool(
    "list_audiences",
    {
      title: "List audiences",
      description:
        "List the workspace's saved audiences — the reusable targeting selectors campaigns accept as audience_id. Use this BEFORE create_email_campaign to discover the audience the user means by name and pass its id. READ-ONLY: rows carry id, name, kind (dynamic = live condition tree, static = frozen membership) and an advisory last_count size cache — never the audience's stored definition, and audiences cannot be created or edited here (they are managed in oToK). last_count may be stale; the send_email_campaign dry run shows the live recipient estimate. Pages with limit (default 25, max 100) + offset; optionally filter by kind.",
      inputSchema: {
        kind: z
          .enum(["dynamic", "static"])
          .optional()
          .describe("Only audiences of this kind."),
        limit: z.number().int().min(1).max(100).optional().describe("Page size (default 25, max 100)."),
        offset: z.number().int().min(0).optional().describe("Rows to skip (for paging)."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => runTool(async () => jsonResult(await client.audiences.list(args))),
  );

  server.registerTool(
    "list_sender_profiles",
    {
      title: "List email sender profiles",
      description:
        'List the workspace\'s email sender profiles (from-identities) — the selectors campaigns accept as sender_profile_id. Use this BEFORE create_email_campaign to pick the sender: prefer a profile with verified: true (its sending domain passed verification, so the launch gate will accept it); when the user does not name one, the is_default: true profile is the natural choice. READ-ONLY: rows carry from_name, the composed from_email, reply_to, provider, is_default, and the sending domain\'s verification status — profiles are managed in oToK (Settings → Email) and cannot be created or edited here. Pages with limit (default 25, max 100) + offset.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Page size (default 25, max 100)."),
        offset: z.number().int().min(0).optional().describe("Rows to skip (for paging)."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool(async () => jsonResult(await client.senderProfiles.list(args))),
  );

  server.registerTool(
    "list_email_campaigns",
    {
      title: "List email campaigns",
      description:
        "List the workspace's broadcast email campaigns, newest first, with status and delivery counters (sent/delivered/opened/clicked/bounced…). Rows omit the stored content — use get_email_campaign for one campaign's full record. Pages with limit (default 25, max 100) + offset; optionally filter by status.",
      inputSchema: {
        status: z
          .enum(["draft", "scheduled", "sending", "paused", "sent", "failed", "cancelled"])
          .optional()
          .describe("Only campaigns in this status."),
        limit: z.number().int().min(1).max(100).optional().describe("Page size (default 25, max 100)."),
        offset: z.number().int().min(0).optional().describe("Rows to skip (for paging)."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool(async () => {
        const page = await client.emailCampaigns.list(args);
        return jsonResult({ ...page, data: page.data.map(slim) });
      }),
  );

  server.registerTool(
    "get_email_campaign",
    {
      title: "Get an email campaign",
      description:
        "Fetch one email campaign: status, subject/preheader, targeting, schedule, delivery counters, and a plain_text rendering of its content.",
      inputSchema: { campaign_id: campaignId },
      annotations: { readOnlyHint: true },
    },
    async ({ campaign_id }) =>
      runTool(async () => jsonResult(slim(await client.emailCampaigns.get(campaign_id)))),
  );

  server.registerTool(
    "create_email_campaign",
    {
      title: "Create an email campaign",
      description: `Create a DRAFT broadcast email campaign — nothing is sent until send_email_campaign or schedule_email_campaign. The response carries compile: {ok, errors, warnings}; fix compile errors before launching.
DISCOVERY FIRST: call list_sender_profiles to pick the sender_profile_id (prefer verified: true) and list_audiences to resolve a saved audience the user names into its audience_id — do not guess ids.
IDEMPOTENCY: pass "external_reference" (your own stable key) to make the create replay-safe — a repeat call with the same reference updates that campaign's fields while it is still draft/scheduled (response has duplicate: true); once launched, replays return the campaign verbatim.
${TARGETING_GUIDE}
${CONTENT_GUIDE}`,
      inputSchema: {
        name: z.string().min(1).describe("Internal campaign name (shown in oToK, not to recipients)."),
        subject: z
          .string()
          .min(1)
          .max(400)
          .describe('Email subject; may embed [[path : fallback]] tokens, e.g. "Hi [[first_name : there]]".'),
        preheader: z
          .string()
          .optional()
          .describe("Inbox preview text shown after the subject; may embed [[…]] tokens."),
        sender_profile_id: z
          .string()
          .uuid()
          .describe("A verified sender profile id belonging to the workspace (400 sender_profile_not_found otherwise) — discover ids with list_sender_profiles."),
        content: contentInputSchema.describe(
          "The campaign body — see the content contract in this tool's description.",
        ),
        audience_id: z.string().uuid().optional().describe("Saved audience id (from list_audiences); wins over audience_filters."),
        audience_filters: z
          .record(z.unknown())
          .optional()
          .describe("Ad-hoc $where condition tree (validated on write)."),
        contact_group_ids: z
          .array(z.string().uuid())
          .optional()
          .describe("Additional contact-group targeting."),
        topic_key: z
          .string()
          .optional()
          .describe("Preference-center topic key — opted-out contacts are excluded."),
        external_reference: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe("Your idempotency key, unique per workspace (max 255 chars)."),
      },
    },
    async ({ content, ...rest }) =>
      runTool(async () =>
        writeResult(
          await client.emailCampaigns.create({ ...rest, content: asContentInput(content) }),
        ),
      ),
  );

  server.registerTool(
    "update_email_campaign",
    {
      title: "Update an email campaign",
      description: `Edit a draft/scheduled campaign — only the fields you pass are touched; pass null to clear a nullable field. A content change recompiles (check compile in the response) and detaches any in-app template — the patched content is what sends. Campaigns already claimed by a launch answer 409 campaign_not_editable.
${TARGETING_GUIDE}
${CONTENT_GUIDE}`,
      inputSchema: {
        campaign_id: campaignId,
        name: z.string().min(1).optional().describe("New internal name."),
        subject: z.string().max(400).nullable().optional().describe("New subject (null clears)."),
        preheader: z.string().nullable().optional().describe("New preheader (null clears)."),
        sender_profile_id: z.string().uuid().optional().describe("New sender profile id."),
        content: contentInputSchema
          .optional()
          .describe("Replacement body — see the content contract in this tool's description."),
        audience_id: z.string().uuid().nullable().optional().describe("Saved audience id (null clears)."),
        audience_filters: z
          .record(z.unknown())
          .nullable()
          .optional()
          .describe("Ad-hoc $where condition tree (null clears)."),
        contact_group_ids: z
          .array(z.string().uuid())
          .nullable()
          .optional()
          .describe("Contact-group targeting (null clears)."),
        topic_key: z.string().nullable().optional().describe("Preference-center topic key (null clears)."),
      },
    },
    async ({ campaign_id, content, ...rest }) =>
      runTool(async () =>
        writeResult(
          await client.emailCampaigns.update(campaign_id, {
            ...rest,
            content: content === undefined ? undefined : asContentInput(content),
          }),
        ),
      ),
  );

  server.registerTool(
    "send_email_campaign",
    {
      title: "Send an email campaign",
      description:
        "Launch a draft/scheduled campaign NOW — this emails real recipients and cannot be recalled. SAFETY: without confirm: true this tool performs NO action; it returns a dry-run summary (live audience estimate, subject, sender, status, content preview) to show the user. Only after the user explicitly approves, call again with confirm: true. A failed launch gate answers 422 launch_failed with the campaign's final status in the error details — an unverified sender is a common cause: check the campaign's sender against list_sender_profiles (verified: true) and fix targeting via list_audiences + update_email_campaign before retrying.",
      inputSchema: { campaign_id: campaignId, confirm: confirmSchema },
      annotations: { destructiveHint: true },
    },
    async ({ campaign_id, confirm }) =>
      runTool(async () => {
        if (!confirm) {
          const [campaign, estimate] = await Promise.all([
            client.emailCampaigns.get(campaign_id),
            client.emailCampaigns.estimate(campaign_id),
          ]);
          return dryRunResult("DRY RUN — no email was sent.", {
            dry_run: true,
            action: "send_email_campaign",
            estimated_recipients: estimate.estimated_recipients,
            campaign: {
              id: campaign.id,
              name: campaign.name,
              status: campaign.status,
              subject: campaign.subject,
              preheader: campaign.preheader,
              sender_profile_id: campaign.sender_profile_id,
              scheduled_at: campaign.scheduled_at,
              content_preview: contentPreview(campaign),
            },
          });
        }
        return jsonResult(slim(await client.emailCampaigns.send(campaign_id)));
      }),
  );

  server.registerTool(
    "schedule_email_campaign",
    {
      title: "Schedule an email campaign",
      description:
        "Schedule (or reschedule) a draft/scheduled campaign's launch for a future instant; an every-minute sweep launches it when due — real email goes out then without further approval. SAFETY: without confirm: true this tool performs NO action; it returns a dry-run summary (live audience estimate + the requested time) to show the user. Only after the user explicitly approves, call again with confirm: true.",
      inputSchema: {
        campaign_id: campaignId,
        scheduled_at: z
          .string()
          .datetime({ offset: true })
          .describe("ISO 8601 UTC instant in the future, e.g. 2026-08-01T09:00:00Z."),
        confirm: confirmSchema,
      },
      annotations: { destructiveHint: true },
    },
    async ({ campaign_id, scheduled_at, confirm }) =>
      runTool(async () => {
        if (!confirm) {
          const [campaign, estimate] = await Promise.all([
            client.emailCampaigns.get(campaign_id),
            client.emailCampaigns.estimate(campaign_id),
          ]);
          return dryRunResult("DRY RUN — nothing was scheduled.", {
            dry_run: true,
            action: "schedule_email_campaign",
            requested_scheduled_at: scheduled_at,
            estimated_recipients: estimate.estimated_recipients,
            campaign: {
              id: campaign.id,
              name: campaign.name,
              status: campaign.status,
              subject: campaign.subject,
              sender_profile_id: campaign.sender_profile_id,
              current_scheduled_at: campaign.scheduled_at,
              content_preview: contentPreview(campaign),
            },
            note: "Once scheduled, the every-minute sweep launches the campaign at the requested time with no further approval.",
          });
        }
        return jsonResult(
          slim(await client.emailCampaigns.schedule(campaign_id, scheduled_at)),
        );
      }),
  );

  server.registerTool(
    "unschedule_email_campaign",
    {
      title: "Unschedule an email campaign",
      description:
        "Cancel a scheduled campaign launch, returning it to draft. Safe: works only while the campaign is still scheduled — if the send sweep already claimed it the API answers 409 already_sending; any other status answers 409 campaign_not_scheduled.",
      inputSchema: { campaign_id: campaignId },
    },
    async ({ campaign_id }) =>
      runTool(async () =>
        jsonResult(slim(await client.emailCampaigns.unschedule(campaign_id))),
      ),
  );
}
