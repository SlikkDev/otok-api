import { describe, expect, it, vi } from "vitest";
import { OtokClient } from "../src/client";
import { OtokApiError } from "../src/errors";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeClient(fetchImpl: typeof fetch) {
  return new OtokClient({
    apiKey: "otok_live_testkey",
    baseUrl: "https://example.test/api",
    fetch: fetchImpl,
  });
}

describe("email campaigns", () => {
  it("list serializes status and paging on the documented route", async () => {
    const fetchMock = vi.fn(async (url: any) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe("/api/v1/email-campaigns");
      expect(Object.fromEntries(parsed.searchParams)).toEqual({
        status: "draft",
        limit: "10",
        offset: "20",
      });
      return json(200, { data: [], total: 0, limit: 10, offset: 20 });
    });
    const otok = makeClient(fetchMock as any);
    await otok.emailCampaigns.list({ status: "draft", limit: 10, offset: 20 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("create POSTs the content contract and returns the compile envelope", async () => {
    const fetchMock = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toBe("https://example.test/api/v1/email-campaigns");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
        name: "July launch",
        subject: "Big news, [[first_name : there]]!",
        sender_profile_id: "5f9f1b9b-0000-4000-8000-000000000001",
        external_reference: "crm:july-launch",
        content: {
          direction: "ltr",
          markdown:
            "# Hello\n\n::button[Read more](https://example.com)\n\n::snippet[Footer]",
        },
        audience_id: "5f9f1b9b-0000-4000-8000-000000000002",
      });
      return json(201, {
        id: "ec-1",
        name: "July launch",
        status: "draft",
        subject: "Big news, [[first_name : there]]!",
        preheader: null,
        duplicate: false,
        compile: { ok: true, errors: [], warnings: [] },
      });
    });
    const otok = makeClient(fetchMock as any);
    const campaign = await otok.emailCampaigns.create({
      name: "July launch",
      subject: "Big news, [[first_name : there]]!",
      sender_profile_id: "5f9f1b9b-0000-4000-8000-000000000001",
      external_reference: "crm:july-launch",
      content: {
        direction: "ltr",
        markdown:
          "# Hello\n\n::button[Read more](https://example.com)\n\n::snippet[Footer]",
      },
      audience_id: "5f9f1b9b-0000-4000-8000-000000000002",
    });
    expect(campaign.duplicate).toBe(false);
    expect(campaign.compile).toEqual({ ok: true, errors: [], warnings: [] });
    // The stored override columns answer under the request field names.
    expect(campaign.subject).toBe("Big news, [[first_name : there]]!");
  });

  it("editable-window replay updates fields and reports duplicate + compile", async () => {
    const fetchMock = vi.fn(async () =>
      json(201, {
        id: "ec-1",
        status: "draft",
        duplicate: true,
        compile: {
          ok: true,
          errors: [],
          warnings: ["Headings deeper than level 3 were clamped to level 3"],
        },
      }),
    );
    const otok = makeClient(fetchMock as any);
    const campaign = await otok.emailCampaigns.create({
      name: "July launch",
      subject: "Subject",
      sender_profile_id: "5f9f1b9b-0000-4000-8000-000000000001",
      external_reference: "crm:july-launch",
      content: { markdown: "#### Deep heading" },
    });
    expect(campaign.duplicate).toBe(true);
    expect(campaign.compile!.warnings).toHaveLength(1);
  });

  it("post-launch replay returns the campaign verbatim without a compile envelope", async () => {
    const fetchMock = vi.fn(async () =>
      json(201, {
        id: "ec-1",
        status: "sent",
        sent_count: 1200,
        duplicate: true,
      }),
    );
    const otok = makeClient(fetchMock as any);
    const campaign = await otok.emailCampaigns.create({
      name: "July launch",
      subject: "Subject",
      sender_profile_id: "5f9f1b9b-0000-4000-8000-000000000001",
      external_reference: "crm:july-launch",
      content: { markdown: "Hello" },
    });
    expect(campaign.duplicate).toBe(true);
    expect(campaign.status).toBe("sent");
    expect("compile" in campaign).toBe(false);
  });

  it("issues the documented verb + path + body for get/update/estimate and the lifecycle POSTs", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (url: any, init: any) => {
      calls.push({
        method: init.method,
        path: new URL(String(url)).pathname,
        body: init.body === undefined ? undefined : JSON.parse(init.body),
      });
      return json(200, { id: "ec-1", estimated_recipients: 0 });
    });
    const otok = makeClient(fetchMock as any);

    await otok.emailCampaigns.get("ec-1");
    await otok.emailCampaigns.update("ec-1", {
      subject: "Updated",
      content: { blocks: [{ kind: "paragraph", text: "Hi" }] },
    });
    await otok.emailCampaigns.estimate("ec-1");
    await otok.emailCampaigns.send("ec-1");
    await otok.emailCampaigns.schedule("ec-1", "2026-08-01T09:00:00Z");
    await otok.emailCampaigns.unschedule("ec-1");

    expect(calls).toEqual([
      { method: "GET", path: "/api/v1/email-campaigns/ec-1", body: undefined },
      {
        method: "PATCH",
        path: "/api/v1/email-campaigns/ec-1",
        body: {
          subject: "Updated",
          content: { blocks: [{ kind: "paragraph", text: "Hi" }] },
        },
      },
      {
        method: "GET",
        path: "/api/v1/email-campaigns/ec-1/estimate",
        body: undefined,
      },
      // No request body on send/unschedule.
      {
        method: "POST",
        path: "/api/v1/email-campaigns/ec-1/send",
        body: undefined,
      },
      {
        method: "POST",
        path: "/api/v1/email-campaigns/ec-1/schedule",
        body: { scheduled_at: "2026-08-01T09:00:00Z" },
      },
      {
        method: "POST",
        path: "/api/v1/email-campaigns/ec-1/unschedule",
        body: undefined,
      },
    ]);
  });

  it("estimate returns estimated_recipients", async () => {
    const fetchMock = vi.fn(async () => json(200, { estimated_recipients: 842 }));
    const otok = makeClient(fetchMock as any);
    const estimate = await otok.emailCampaigns.estimate("ec-1");
    expect(estimate.estimated_recipients).toBe(842);
  });

  it("send surfaces the 422 launch_failed with the campaign's final status on the body", async () => {
    const fetchMock = vi.fn(async () =>
      json(422, {
        error: {
          code: "launch_failed",
          message: "Sender domain is not verified",
          campaign_status: "failed",
        },
      }),
    );
    const otok = makeClient(fetchMock as any);
    const err = await otok.emailCampaigns.send("ec-1").catch((e) => e);
    expect(err).toBeInstanceOf(OtokApiError);
    expect(err.status).toBe(422);
    expect(err.code).toBe("launch_failed");
    expect(err.message).toBe("Sender domain is not verified");
    // The gate marks the campaign failed — the final status rides the body.
    expect((err.body as any).error.campaign_status).toBe("failed");
  });

  it("surfaces the typed state-machine 409s and validation 400s", async () => {
    const responses = [
      json(409, {
        error: {
          code: "campaign_not_editable",
          message:
            "Campaign status is 'sent' — only draft or scheduled campaigns can be edited",
        },
      }),
      json(409, {
        error: {
          code: "campaign_not_sendable",
          message:
            "Campaign status is 'sending' — only draft or scheduled campaigns can be sent",
        },
      }),
      json(400, {
        error: {
          code: "invalid_scheduled_at",
          message: "scheduled_at must be a future instant",
        },
      }),
      json(409, {
        error: {
          code: "already_sending",
          message:
            "The send sweep already claimed this campaign — it is sending",
        },
      }),
      json(409, {
        error: {
          code: "campaign_not_scheduled",
          message:
            "Campaign status is 'draft' — only scheduled campaigns can be unscheduled",
        },
      }),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!);
    const otok = makeClient(fetchMock as any);

    let err = await otok.emailCampaigns
      .update("ec-1", { name: "X" })
      .catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.code).toBe("campaign_not_editable");

    err = await otok.emailCampaigns.send("ec-1").catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.code).toBe("campaign_not_sendable");

    err = await otok.emailCampaigns
      .schedule("ec-1", "2020-01-01T00:00:00Z")
      .catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.code).toBe("invalid_scheduled_at");

    err = await otok.emailCampaigns.unschedule("ec-1").catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.code).toBe("already_sending");

    err = await otok.emailCampaigns.unschedule("ec-1").catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.code).toBe("campaign_not_scheduled");
  });

  it("surfaces the content-contract 400s (unknown_snippet, invalid_content, sender_profile_not_found)", async () => {
    const responses = [
      json(400, {
        error: {
          code: "unknown_snippet",
          message: 'Unknown snippet "Footr". Available snippets: Footer, Header',
        },
      }),
      json(400, {
        error: {
          code: "invalid_content",
          message:
            'content must include exactly one of "markdown", "blocks", or "design_json"',
        },
      }),
      json(400, {
        error: {
          code: "sender_profile_not_found",
          message: "Sender profile not found in this workspace",
        },
      }),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!);
    const otok = makeClient(fetchMock as any);
    const params = {
      name: "C",
      subject: "S",
      sender_profile_id: "5f9f1b9b-0000-4000-8000-000000000001",
      content: { markdown: "::snippet[Footr]" },
    } as const;

    let err = await otok.emailCampaigns.create(params).catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.code).toBe("unknown_snippet");
    // The message lists the available snippet names (LLM-recoverable).
    expect(err.message).toContain("Available snippets: Footer, Header");

    err = await otok.emailCampaigns.create(params).catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.code).toBe("invalid_content");

    err = await otok.emailCampaigns.create(params).catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.code).toBe("sender_profile_not_found");
  });

  it("throws OtokApiError 404 campaign_not_found for an unknown id", async () => {
    const fetchMock = vi.fn(async () =>
      json(404, {
        error: { code: "campaign_not_found", message: "Email campaign not found" },
      }),
    );
    const otok = makeClient(fetchMock as any);
    const err = await otok.emailCampaigns.get("nope").catch((e) => e);
    expect(err).toBeInstanceOf(OtokApiError);
    expect(err.status).toBe(404);
    expect(err.code).toBe("campaign_not_found");
  });

  it("feature-gate 403 embeds the email_marketing feature id", async () => {
    const fetchMock = vi.fn(async () =>
      json(403, {
        message:
          "Your current plan does not include access to this feature: email_marketing. Please upgrade your plan.",
        error_code: "FEATURE_NOT_INCLUDED_IN_PLAN",
      }),
    );
    const otok = makeClient(fetchMock as any);
    const err = await otok.emailCampaigns.list().catch((e) => e);
    expect(err).toBeInstanceOf(OtokApiError);
    expect(err.status).toBe(403);
    expect(err.code).toBe("FEATURE_NOT_INCLUDED_IN_PLAN");
  });
});

describe("newsletters", () => {
  it("list serializes paging and passes active_subscriber_count through", async () => {
    const fetchMock = vi.fn(async (url: any) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe("/api/v1/newsletters");
      expect(Object.fromEntries(parsed.searchParams)).toEqual({
        limit: "10",
        offset: "20",
      });
      return json(200, {
        data: [{ id: "nl-1", name: "Product updates", active_subscriber_count: 42 }],
        total: 1,
        limit: 10,
        offset: 20,
      });
    });
    const otok = makeClient(fetchMock as any);
    const page = await otok.newsletters.list({ limit: 10, offset: 20 });
    expect(page.data[0]!.active_subscriber_count).toBe(42);
  });

  it("create POSTs the payload and surfaces duplicate_name / PLAN_LIMIT_EXCEEDED", async () => {
    const responses = [
      json(201, { id: "nl-1", name: "Product updates", active_subscriber_count: 0 }),
      json(409, {
        error: {
          code: "duplicate_name",
          message: "A newsletter with this name already exists",
        },
      }),
      json(403, {
        message:
          "Plan limit reached for max_newsletters (3). Please upgrade your plan to continue.",
        error_code: "PLAN_LIMIT_EXCEEDED",
      }),
    ];
    const fetchMock = vi.fn(async (url: any, init: any) => {
      if (fetchMock.mock.calls.length === 1) {
        expect(String(url)).toBe("https://example.test/api/v1/newsletters");
        expect(init.method).toBe("POST");
        expect(JSON.parse(init.body)).toEqual({
          name: "Product updates",
          description: "Monthly digest",
        });
      }
      return responses.shift()!;
    });
    const otok = makeClient(fetchMock as any);

    const newsletter = await otok.newsletters.create({
      name: "Product updates",
      description: "Monthly digest",
    });
    expect(newsletter.active_subscriber_count).toBe(0);

    let err = await otok.newsletters
      .create({ name: "Product updates" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(OtokApiError);
    expect(err.status).toBe(409);
    expect(err.code).toBe("duplicate_name");

    err = await otok.newsletters.create({ name: "Fourth" }).catch((e) => e);
    expect(err.status).toBe(403);
    expect(err.code).toBe("PLAN_LIMIT_EXCEEDED");
  });

  it("get reads the documented route and 404s newsletter_not_found", async () => {
    const responses = [
      json(200, { id: "nl-1", name: "Product updates", active_subscriber_count: 7 }),
      json(404, {
        error: { code: "newsletter_not_found", message: "Newsletter not found" },
      }),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!);
    const otok = makeClient(fetchMock as any);

    const newsletter = await otok.newsletters.get("nl-1");
    expect(newsletter.active_subscriber_count).toBe(7);
    const [url, init] = fetchMock.mock.calls[0] as [any, any];
    expect(String(url)).toBe("https://example.test/api/v1/newsletters/nl-1");
    expect(init.method).toBe("GET");

    const err = await otok.newsletters.get("nope").catch((e) => e);
    expect(err.status).toBe(404);
    expect(err.code).toBe("newsletter_not_found");
  });

  it("listIssues serializes status and paging on the nested route", async () => {
    const fetchMock = vi.fn(async (url: any) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe("/api/v1/newsletters/nl-1/issues");
      expect(Object.fromEntries(parsed.searchParams)).toEqual({
        status: "published",
        limit: "5",
      });
      return json(200, { data: [], total: 0, limit: 5, offset: 0 });
    });
    const otok = makeClient(fetchMock as any);
    await otok.newsletters.listIssues("nl-1", { status: "published", limit: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("createIssue POSTs the content contract and returns duplicate + compile", async () => {
    const fetchMock = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toBe(
        "https://example.test/api/v1/newsletters/nl-1/issues",
      );
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
        subject: "Issue subject",
        external_reference: "crm:issue-1",
        content: {
          direction: "rtl",
          blocks: [
            { kind: "heading", text: "שלום", level: 2 },
            { kind: "snippet", name: "Footer" },
          ],
        },
      });
      return json(201, {
        id: "iss-1",
        newsletter_id: "nl-1",
        issue_number: null,
        status: "draft",
        duplicate: false,
        compile: { ok: true, errors: [], warnings: [] },
      });
    });
    const otok = makeClient(fetchMock as any);
    const issue = await otok.newsletters.createIssue("nl-1", {
      subject: "Issue subject",
      external_reference: "crm:issue-1",
      content: {
        direction: "rtl",
        blocks: [
          { kind: "heading", text: "שלום", level: 2 },
          { kind: "snippet", name: "Footer" },
        ],
      },
    });
    expect(issue.duplicate).toBe(false);
    expect(issue.compile.ok).toBe(true);
    expect(issue.issue_number).toBeNull();
  });

  it("createIssue sends an empty object when no params are given", async () => {
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      expect(JSON.parse(init.body)).toEqual({});
      return json(201, {
        id: "iss-2",
        status: "draft",
        duplicate: false,
        compile: { ok: true, errors: [], warnings: [] },
      });
    });
    const otok = makeClient(fetchMock as any);
    const issue = await otok.newsletters.createIssue("nl-1");
    expect(issue.id).toBe("iss-2");
  });

  it("issue replay reports duplicate: true and never moves status or issue_number", async () => {
    const fetchMock = vi.fn(async () =>
      json(201, {
        id: "iss-1",
        newsletter_id: "nl-1",
        status: "published",
        issue_number: 4,
        duplicate: true,
        compile: { ok: true, errors: [], warnings: [] },
      }),
    );
    const otok = makeClient(fetchMock as any);
    const issue = await otok.newsletters.createIssue("nl-1", {
      external_reference: "crm:issue-1",
      content: { markdown: "Updated body" },
    });
    expect(issue.duplicate).toBe(true);
    // A replay updates content only — the publish state is untouched.
    expect(issue.status).toBe("published");
    expect(issue.issue_number).toBe(4);
  });

  it("createIssue 409s external_reference_in_use under a different newsletter", async () => {
    const fetchMock = vi.fn(async () =>
      json(409, {
        error: {
          code: "external_reference_in_use",
          message:
            "external_reference already belongs to an issue of a different newsletter",
        },
      }),
    );
    const otok = makeClient(fetchMock as any);
    const err = await otok.newsletters
      .createIssue("nl-2", { external_reference: "crm:issue-1" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(OtokApiError);
    expect(err.status).toBe(409);
    expect(err.code).toBe("external_reference_in_use");
  });

  it("issues the documented verb + path + body for each issue method", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (url: any, init: any) => {
      calls.push({
        method: init.method,
        path: new URL(String(url)).pathname,
        body: init.body === undefined ? undefined : JSON.parse(init.body),
      });
      return json(200, { id: "iss-1", success: true });
    });
    const otok = makeClient(fetchMock as any);

    await otok.newsletters.getIssue("iss-1");
    await otok.newsletters.updateIssue("iss-1", {
      subject: "New subject",
      include_in_archive: false,
    });
    await otok.newsletters.publishIssue("iss-1");
    await otok.newsletters.scheduleIssue("iss-1", "2026-08-01T09:00:00Z");
    await otok.newsletters.unscheduleIssue("iss-1");
    await otok.newsletters.deleteIssue("iss-1");

    expect(calls).toEqual([
      { method: "GET", path: "/api/v1/newsletter-issues/iss-1", body: undefined },
      {
        method: "PATCH",
        path: "/api/v1/newsletter-issues/iss-1",
        body: { subject: "New subject", include_in_archive: false },
      },
      // No request body on publish/unschedule.
      {
        method: "POST",
        path: "/api/v1/newsletter-issues/iss-1/publish",
        body: undefined,
      },
      {
        method: "POST",
        path: "/api/v1/newsletter-issues/iss-1/schedule",
        body: { scheduled_at: "2026-08-01T09:00:00Z" },
      },
      {
        method: "POST",
        path: "/api/v1/newsletter-issues/iss-1/unschedule",
        body: undefined,
      },
      {
        method: "DELETE",
        path: "/api/v1/newsletter-issues/iss-1",
        body: undefined,
      },
    ]);
  });

  it("surfaces the typed issue lifecycle errors", async () => {
    const responses = [
      json(409, {
        error: {
          code: "issue_missing_content",
          message:
            "An issue needs a subject and content before it can be published",
        },
      }),
      json(409, {
        error: {
          code: "issue_already_published",
          message:
            "Issue is already published — published issues cannot be scheduled",
        },
      }),
      json(400, {
        error: {
          code: "invalid_scheduled_at",
          message: "scheduled_at must be a future instant",
        },
      }),
      json(409, {
        error: {
          code: "issue_not_scheduled",
          message:
            "Issue status is 'draft' — only scheduled issues can be unscheduled",
        },
      }),
      json(400, {
        error: {
          code: "issue_published",
          message: "Published issues cannot be deleted",
        },
      }),
      json(404, {
        error: { code: "issue_not_found", message: "Issue not found" },
      }),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!);
    const otok = makeClient(fetchMock as any);

    let err = await otok.newsletters.publishIssue("iss-1").catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.code).toBe("issue_missing_content");

    err = await otok.newsletters
      .scheduleIssue("iss-1", "2026-08-01T09:00:00Z")
      .catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.code).toBe("issue_already_published");

    err = await otok.newsletters
      .scheduleIssue("iss-1", "2020-01-01T00:00:00Z")
      .catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.code).toBe("invalid_scheduled_at");

    err = await otok.newsletters.unscheduleIssue("iss-1").catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.code).toBe("issue_not_scheduled");

    err = await otok.newsletters.deleteIssue("iss-1").catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.code).toBe("issue_published");

    err = await otok.newsletters.getIssue("nope").catch((e) => e);
    expect(err.status).toBe(404);
    expect(err.code).toBe("issue_not_found");
  });

  it("feature-gate 403 embeds the newsletters feature id", async () => {
    const fetchMock = vi.fn(async () =>
      json(403, {
        message:
          "Your current plan does not include access to this feature: newsletters. Please upgrade your plan.",
        error_code: "FEATURE_NOT_INCLUDED_IN_PLAN",
      }),
    );
    const otok = makeClient(fetchMock as any);
    const err = await otok.newsletters.list().catch((e) => e);
    expect(err).toBeInstanceOf(OtokApiError);
    expect(err.status).toBe(403);
    expect(err.code).toBe("FEATURE_NOT_INCLUDED_IN_PLAN");
  });
});
