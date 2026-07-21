import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { OtokApiError } from "@otok/node";
import { describe, expect, it, vi } from "vitest";
import { createOtokMcpServer } from "../src/server";
import { ALL_TOOL_NAMES, TOOL_DOMAINS, type ToolClient } from "../src/tools";

const CONFIRM_GATED = [
  "send_email_campaign",
  "schedule_email_campaign",
  "publish_newsletter_issue",
  "schedule_newsletter_issue",
];

const CAMPAIGN_ID = "5f9f1b9b-0000-4000-8000-000000000001";
const NEWSLETTER_ID = "5f9f1b9b-0000-4000-8000-000000000002";
const ISSUE_ID = "5f9f1b9b-0000-4000-8000-000000000003";
const SENDER_ID = "5f9f1b9b-0000-4000-8000-000000000004";

function makeMockClient() {
  return {
    emailCampaigns: {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      estimate: vi.fn(),
      send: vi.fn(),
      schedule: vi.fn(),
      unschedule: vi.fn(),
    },
    newsletters: {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      listIssues: vi.fn(),
      getIssue: vi.fn(),
      createIssue: vi.fn(),
      updateIssue: vi.fn(),
      deleteIssue: vi.fn(),
      publishIssue: vi.fn(),
      scheduleIssue: vi.fn(),
      unscheduleIssue: vi.fn(),
    },
  };
}

type MockClient = ReturnType<typeof makeMockClient>;

async function connect(mock: MockClient) {
  const server = createOtokMcpServer({
    apiKey: "otok_live_testkey",
    client: mock as unknown as ToolClient,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  return { ...result, text: result.content[0]?.text ?? "" };
}

function allWriteFns(mock: MockClient) {
  return [
    mock.emailCampaigns.create,
    mock.emailCampaigns.update,
    mock.emailCampaigns.send,
    mock.emailCampaigns.schedule,
    mock.emailCampaigns.unschedule,
    mock.newsletters.create,
    mock.newsletters.createIssue,
    mock.newsletters.updateIssue,
    mock.newsletters.deleteIssue,
    mock.newsletters.publishIssue,
    mock.newsletters.scheduleIssue,
    mock.newsletters.unscheduleIssue,
  ];
}

describe("tool registry", () => {
  it("registers exactly the documented tool set across both domains", async () => {
    const client = await connect(makeMockClient());
    const { tools } = await client.listTools();
    const registered = tools.map((t) => t.name).sort();
    expect(registered).toEqual([...ALL_TOOL_NAMES].sort());
    expect(ALL_TOOL_NAMES).toHaveLength(18);
    expect(new Set(ALL_TOOL_NAMES).size).toBe(ALL_TOOL_NAMES.length);
    expect(TOOL_DOMAINS.map((d) => d.domain)).toEqual([
      "email-campaigns",
      "newsletters",
    ]);
  });

  it("every tool ships a description; gated tools document the confirm contract", async () => {
    const client = await connect(makeMockClient());
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
    }
    for (const name of CONFIRM_GATED) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool.description).toMatch(/confirm: true/);
      const properties = (tool.inputSchema as { properties: Record<string, unknown> })
        .properties;
      expect(properties).toHaveProperty("confirm");
    }
  });

  it("delete_newsletter_issue has no confirm gate and warns about published issues", async () => {
    const client = await connect(makeMockClient());
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "delete_newsletter_issue")!;
    const properties = (tool.inputSchema as { properties: Record<string, unknown> })
      .properties;
    expect(properties).not.toHaveProperty("confirm");
    expect(tool.description).toMatch(/NEVER-PUBLISHED/);
    expect(tool.description).toMatch(/issue_published/);
  });

  it("content-authoring tools teach the directives and variable tokens", async () => {
    const client = await connect(makeMockClient());
    const { tools } = await client.listTools();
    for (const name of [
      "create_email_campaign",
      "update_email_campaign",
      "create_newsletter_issue",
      "update_newsletter_issue",
    ]) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool.description, name).toContain("::button[Label](https://example.com)");
      expect(tool.description, name).toContain("::snippet[name-or-uuid]");
      expect(tool.description, name).toContain("[[path : fallback]]");
      expect(tool.description, name).toMatch(/EXACTLY ONE/);
    }
  });
});

describe("input validation", () => {
  it("missing required fields produce a recoverable error naming the field", async () => {
    const mock = makeMockClient();
    const client = await connect(mock);
    const result = await call(client, "create_email_campaign", {
      name: "July launch",
      sender_profile_id: SENDER_ID,
      content: { markdown: "# Hi" },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("subject");
    expect(mock.emailCampaigns.create).not.toHaveBeenCalled();
  });

  it("two content sources are rejected client-side with the exactly-one message", async () => {
    const mock = makeMockClient();
    const client = await connect(mock);
    const result = await call(client, "create_email_campaign", {
      name: "July launch",
      subject: "Subject",
      sender_profile_id: SENDER_ID,
      content: { markdown: "# Hi", blocks: [{ kind: "paragraph", text: "x" }] },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(
      "content requires exactly ONE of markdown | blocks | design_json",
    );
    expect(mock.emailCampaigns.create).not.toHaveBeenCalled();
  });

  it("a malformed scheduled_at never reaches the API", async () => {
    const mock = makeMockClient();
    const client = await connect(mock);
    const result = await call(client, "schedule_email_campaign", {
      campaign_id: CAMPAIGN_ID,
      scheduled_at: "tomorrow at nine",
      confirm: true,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("scheduled_at");
    expect(mock.emailCampaigns.schedule).not.toHaveBeenCalled();
  });
});

describe("reads and writes", () => {
  it("list_email_campaigns forwards filters and returns the page", async () => {
    const mock = makeMockClient();
    mock.emailCampaigns.list.mockResolvedValue({
      data: [{ id: CAMPAIGN_ID, name: "July launch", status: "draft" }],
      total: 1,
      limit: 10,
      offset: 0,
    });
    const client = await connect(mock);
    const result = await call(client, "list_email_campaigns", {
      status: "draft",
      limit: 10,
    });
    expect(mock.emailCampaigns.list).toHaveBeenCalledWith({
      status: "draft",
      limit: 10,
    });
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain("July launch");
  });

  it("create_email_campaign passes params through and slims bulky content columns", async () => {
    const mock = makeMockClient();
    mock.emailCampaigns.create.mockResolvedValue({
      id: CAMPAIGN_ID,
      name: "July launch",
      status: "draft",
      subject: "Big news, [[first_name : there]]!",
      duplicate: false,
      compile: { ok: true, errors: [], warnings: [] },
      design_json: { type: "doc", content: [] },
      compiled_html: "<table>…</table>",
      compiled_styles: ".x{}",
      plain_text: "Big news!",
    });
    const client = await connect(mock);
    const result = await call(client, "create_email_campaign", {
      name: "July launch",
      subject: "Big news, [[first_name : there]]!",
      sender_profile_id: SENDER_ID,
      external_reference: "crm:july-launch",
      content: { direction: "ltr", markdown: "# Hello\n\n::snippet[Footer]" },
    });
    expect(mock.emailCampaigns.create).toHaveBeenCalledWith({
      name: "July launch",
      subject: "Big news, [[first_name : there]]!",
      sender_profile_id: SENDER_ID,
      external_reference: "crm:july-launch",
      content: { direction: "ltr", markdown: "# Hello\n\n::snippet[Footer]" },
    });
    expect(result.isError).toBeFalsy();
    expect(result.text).not.toContain("<table>");
    expect(result.text).toContain("[omitted from tool output");
    expect(result.text).toContain("Big news!"); // plain_text is kept
  });

  it("a failing compile envelope is called out ahead of the record", async () => {
    const mock = makeMockClient();
    mock.emailCampaigns.create.mockResolvedValue({
      id: CAMPAIGN_ID,
      status: "draft",
      duplicate: false,
      compile: { ok: false, errors: ["Image URLs must be absolute https"], warnings: [] },
    });
    const client = await connect(mock);
    const result = await call(client, "create_email_campaign", {
      name: "July launch",
      subject: "Subject",
      sender_profile_id: SENDER_ID,
      content: { markdown: "![x](http://insecure.example/x.png)" },
    });
    expect(result.isError).toBeFalsy();
    expect(result.text).toMatch(/^COMPILE ERRORS/);
    expect(result.text).toContain("Image URLs must be absolute https");
  });

  it("update_newsletter_issue forwards explicit nulls and the content contract", async () => {
    const mock = makeMockClient();
    mock.newsletters.updateIssue.mockResolvedValue({
      id: ISSUE_ID,
      status: "draft",
      compile: { ok: true, errors: [], warnings: [] },
    });
    const client = await connect(mock);
    await call(client, "update_newsletter_issue", {
      issue_id: ISSUE_ID,
      preheader: null,
      content: { blocks: [{ kind: "heading", text: "Hi", level: 2 }] },
    });
    expect(mock.newsletters.updateIssue).toHaveBeenCalledWith(ISSUE_ID, {
      preheader: null,
      content: { blocks: [{ kind: "heading", text: "Hi", level: 2 }] },
    });
  });

  it("delete_newsletter_issue deletes without any confirm handshake", async () => {
    const mock = makeMockClient();
    mock.newsletters.deleteIssue.mockResolvedValue({ success: true });
    const client = await connect(mock);
    const result = await call(client, "delete_newsletter_issue", { issue_id: ISSUE_ID });
    expect(mock.newsletters.deleteIssue).toHaveBeenCalledWith(ISSUE_ID);
    expect(result.text).toContain("success");
  });
});

describe("confirm gate", () => {
  it("send_email_campaign without confirm performs ZERO writes and summarizes from reads only", async () => {
    const mock = makeMockClient();
    mock.emailCampaigns.get.mockResolvedValue({
      id: CAMPAIGN_ID,
      name: "July launch",
      status: "draft",
      subject: "Big news!",
      preheader: null,
      sender_profile_id: SENDER_ID,
      scheduled_at: null,
      plain_text: "Big news! Read all about it.",
    });
    mock.emailCampaigns.estimate.mockResolvedValue({ estimated_recipients: 1234 });
    const client = await connect(mock);
    const result = await call(client, "send_email_campaign", {
      campaign_id: CAMPAIGN_ID,
    });
    expect(mock.emailCampaigns.get).toHaveBeenCalledWith(CAMPAIGN_ID);
    expect(mock.emailCampaigns.estimate).toHaveBeenCalledWith(CAMPAIGN_ID);
    for (const fn of allWriteFns(mock)) expect(fn).not.toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain("DRY RUN");
    expect(result.text).toContain("1234");
    expect(result.text).toContain("Big news! Read all about it.");
    expect(result.text).toContain("confirm: true");
  });

  it("send_email_campaign with confirm performs exactly the send call", async () => {
    const mock = makeMockClient();
    mock.emailCampaigns.send.mockResolvedValue({
      id: CAMPAIGN_ID,
      status: "sending",
    });
    const client = await connect(mock);
    const result = await call(client, "send_email_campaign", {
      campaign_id: CAMPAIGN_ID,
      confirm: true,
    });
    expect(mock.emailCampaigns.send).toHaveBeenCalledTimes(1);
    expect(mock.emailCampaigns.send).toHaveBeenCalledWith(CAMPAIGN_ID);
    expect(mock.emailCampaigns.get).not.toHaveBeenCalled();
    expect(mock.emailCampaigns.estimate).not.toHaveBeenCalled();
    expect(result.text).toContain("sending");
  });

  it("schedule_email_campaign gates on confirm and passes the instant through", async () => {
    const mock = makeMockClient();
    mock.emailCampaigns.get.mockResolvedValue({
      id: CAMPAIGN_ID,
      name: "July launch",
      status: "draft",
      subject: "S",
      sender_profile_id: SENDER_ID,
      scheduled_at: null,
    });
    mock.emailCampaigns.estimate.mockResolvedValue({ estimated_recipients: 7 });
    mock.emailCampaigns.schedule.mockResolvedValue({
      id: CAMPAIGN_ID,
      status: "scheduled",
      scheduled_at: "2026-08-01T09:00:00Z",
    });
    const client = await connect(mock);

    const dry = await call(client, "schedule_email_campaign", {
      campaign_id: CAMPAIGN_ID,
      scheduled_at: "2026-08-01T09:00:00Z",
    });
    expect(mock.emailCampaigns.schedule).not.toHaveBeenCalled();
    expect(dry.text).toContain("DRY RUN");
    expect(dry.text).toContain("2026-08-01T09:00:00Z");

    await call(client, "schedule_email_campaign", {
      campaign_id: CAMPAIGN_ID,
      scheduled_at: "2026-08-01T09:00:00Z",
      confirm: true,
    });
    expect(mock.emailCampaigns.schedule).toHaveBeenCalledWith(
      CAMPAIGN_ID,
      "2026-08-01T09:00:00Z",
    );
  });

  it("publish_newsletter_issue without confirm reads issue + newsletter and explains catch-up", async () => {
    const mock = makeMockClient();
    mock.newsletters.getIssue.mockResolvedValue({
      id: ISSUE_ID,
      newsletter_id: NEWSLETTER_ID,
      subject: "Issue subject",
      preheader: null,
      status: "draft",
      include_in_archive: true,
      plain_text: "Dear reader…",
    });
    mock.newsletters.get.mockResolvedValue({
      id: NEWSLETTER_ID,
      name: "Weekly digest",
      status: "active",
      active_subscriber_count: 862,
    });
    const client = await connect(mock);
    const result = await call(client, "publish_newsletter_issue", {
      issue_id: ISSUE_ID,
    });
    expect(mock.newsletters.getIssue).toHaveBeenCalledWith(ISSUE_ID);
    expect(mock.newsletters.get).toHaveBeenCalledWith(NEWSLETTER_ID);
    for (const fn of allWriteFns(mock)) expect(fn).not.toHaveBeenCalled();
    expect(result.text).toContain("DRY RUN");
    expect(result.text).toContain("862");
    expect(result.text).toContain("catch-up delivery");
    expect(result.text).toContain("confirm: true");
  });

  it("publish_newsletter_issue with confirm performs exactly the publish call", async () => {
    const mock = makeMockClient();
    mock.newsletters.publishIssue.mockResolvedValue({
      id: ISSUE_ID,
      status: "published",
      issue_number: 4,
    });
    const client = await connect(mock);
    const result = await call(client, "publish_newsletter_issue", {
      issue_id: ISSUE_ID,
      confirm: true,
    });
    expect(mock.newsletters.publishIssue).toHaveBeenCalledTimes(1);
    expect(mock.newsletters.publishIssue).toHaveBeenCalledWith(ISSUE_ID);
    expect(mock.newsletters.getIssue).not.toHaveBeenCalled();
    expect(mock.newsletters.get).not.toHaveBeenCalled();
    expect(result.text).toContain("published");
  });

  it("schedule_newsletter_issue gates on confirm", async () => {
    const mock = makeMockClient();
    mock.newsletters.getIssue.mockResolvedValue({
      id: ISSUE_ID,
      newsletter_id: NEWSLETTER_ID,
      subject: "Issue subject",
      status: "draft",
      scheduled_at: null,
    });
    mock.newsletters.get.mockResolvedValue({
      id: NEWSLETTER_ID,
      name: "Weekly digest",
      active_subscriber_count: 12,
    });
    mock.newsletters.scheduleIssue.mockResolvedValue({
      id: ISSUE_ID,
      status: "scheduled",
      scheduled_at: "2026-08-01T09:00:00Z",
    });
    const client = await connect(mock);

    const dry = await call(client, "schedule_newsletter_issue", {
      issue_id: ISSUE_ID,
      scheduled_at: "2026-08-01T09:00:00Z",
    });
    expect(mock.newsletters.scheduleIssue).not.toHaveBeenCalled();
    expect(dry.text).toContain("DRY RUN");

    await call(client, "schedule_newsletter_issue", {
      issue_id: ISSUE_ID,
      scheduled_at: "2026-08-01T09:00:00Z",
      confirm: true,
    });
    expect(mock.newsletters.scheduleIssue).toHaveBeenCalledWith(
      ISSUE_ID,
      "2026-08-01T09:00:00Z",
    );
  });

  it("unschedule tools act directly — cancellation needs no confirm handshake", async () => {
    const mock = makeMockClient();
    mock.emailCampaigns.unschedule.mockResolvedValue({
      id: CAMPAIGN_ID,
      status: "draft",
    });
    mock.newsletters.unscheduleIssue.mockResolvedValue({
      id: ISSUE_ID,
      status: "draft",
    });
    const client = await connect(mock);
    await call(client, "unschedule_email_campaign", { campaign_id: CAMPAIGN_ID });
    await call(client, "unschedule_newsletter_issue", { issue_id: ISSUE_ID });
    expect(mock.emailCampaigns.unschedule).toHaveBeenCalledWith(CAMPAIGN_ID);
    expect(mock.newsletters.unscheduleIssue).toHaveBeenCalledWith(ISSUE_ID);
  });
});

describe("API error surfacing", () => {
  it("unknown_snippet surfaces the API's available-names message verbatim plus a hint", async () => {
    const mock = makeMockClient();
    const message =
      'Unknown snippet "Foter". Available snippets: Footer, Legal, Signature';
    mock.newsletters.createIssue.mockRejectedValue(
      new OtokApiError(400, message, "unknown_snippet", {
        error: { code: "unknown_snippet", message },
      }),
    );
    const client = await connect(mock);
    const result = await call(client, "create_newsletter_issue", {
      newsletter_id: NEWSLETTER_ID,
      content: { markdown: "::snippet[Foter]" },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(message);
    expect(result.text).toContain('code "unknown_snippet"');
    expect(result.text).toContain("re-send the content using one of those names");
  });

  it("launch_failed carries the campaign's final status from the error body", async () => {
    const mock = makeMockClient();
    mock.emailCampaigns.send.mockRejectedValue(
      new OtokApiError(422, "Content lint failed: spammy subject", "launch_failed", {
        error: {
          code: "launch_failed",
          message: "Content lint failed: spammy subject",
          campaign_status: "failed",
        },
      }),
    );
    const client = await connect(mock);
    const result = await call(client, "send_email_campaign", {
      campaign_id: CAMPAIGN_ID,
      confirm: true,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Content lint failed: spammy subject");
    expect(result.text).toContain('"campaign_status":"failed"');
  });

  it("plan-gate errors explain the feature gate", async () => {
    const mock = makeMockClient();
    mock.newsletters.list.mockRejectedValue(
      new OtokApiError(
        403,
        "Your plan does not include this feature",
        "FEATURE_NOT_INCLUDED_IN_PLAN",
        {
          statusCode: 403,
          message: "Your plan does not include this feature",
          error_code: "FEATURE_NOT_INCLUDED_IN_PLAN",
        },
      ),
    );
    const client = await connect(mock);
    const result = await call(client, "list_newsletters", {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("FEATURE_NOT_INCLUDED_IN_PLAN");
    expect(result.text).toContain("upgrading the plan");
  });

  it("state-machine 409s carry their code and a recovery hint", async () => {
    const mock = makeMockClient();
    mock.emailCampaigns.update.mockRejectedValue(
      new OtokApiError(409, "Campaign is no longer editable", "campaign_not_editable", {
        error: { code: "campaign_not_editable", message: "Campaign is no longer editable" },
      }),
    );
    const client = await connect(mock);
    const result = await call(client, "update_email_campaign", {
      campaign_id: CAMPAIGN_ID,
      name: "Renamed",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('code "campaign_not_editable"');
    expect(result.text).toContain("already claimed by a launch");
  });
});
