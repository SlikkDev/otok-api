import { describe, expect, it, vi } from "vitest";
import { OtokClient } from "../src/client";

function clientWith(...responses: unknown[]) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(responses.shift() ?? {}), {
    status: 201, headers: { "content-type": "application/json" },
  }));
  return {
    client: new OtokClient({ apiKey: "otok_live_testkey", baseUrl: "https://example.test/api", fetch }),
    fetch,
  };
}

describe("public contract additions", () => {
  it("preserves submission context and retry identity in an upsert", async () => {
    const { client, fetch } = clientWith({ id: "contact-1", duplicate: true });
    const body = {
      email: "jane@example.com", owner_email: "member@example.com", inquiry: "never" as const,
      acquisition: { event_id: "signup-example-001", landing_url: "https://example.com/signup", gbraid: "example-click" },
    };
    expect(await client.contacts.upsert(body)).toEqual({ id: "contact-1", duplicate: true });
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual(body);
  });

  it("uses product nesting only for cycle list and create", async () => {
    const { client, fetch } = clientWith({}, { id: "cycle-1", duplicate: true });
    await client.productCycles.list("product-1", { is_archived: false, limit: 5, offset: 10 });
    const created = await client.productCycles.create("product-1", { name: "Autumn course", capacity: 20 });
    expect(created.duplicate).toBe(true);
    await client.productCycles.get("cycle-1");
    await client.productCycles.update("cycle-1", { is_archived: true, manual_status: null });
    expect(fetch.mock.calls.map(([url, options]) => [new URL(String(url)).pathname, options?.method])).toEqual([
      ["/api/v1/products/product-1/cycles", "GET"], ["/api/v1/products/product-1/cycles", "POST"],
      ["/api/v1/product-cycles/cycle-1", "GET"], ["/api/v1/product-cycles/cycle-1", "PATCH"],
    ]);
    expect(new URL(String(fetch.mock.calls[0]![0])).searchParams.get("is_archived")).toBe("false");
    expect(JSON.parse(fetch.mock.calls[3]![1]!.body as string)).toEqual({ is_archived: true, manual_status: null });
  });

  it("paginates cycles without dropping the product or archive filter", async () => {
    const { client, fetch } = clientWith(
      { data: [{ id: "a" }], total: 2, limit: 1, offset: 0 },
      { data: [{ id: "b" }], total: 2, limit: 1, offset: 1 },
    );
    const rows = [];
    for await (const cycle of client.productCycles.iter("product-1", { limit: 1, is_archived: false })) rows.push(cycle.id);
    expect(rows).toEqual(["a", "b"]);
    const url = new URL(String(fetch.mock.calls[1]![0]));
    expect(url.pathname).toBe("/api/v1/products/product-1/cycles");
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: "1", offset: "1", is_archived: "false" });
  });

  it("runs reports with an empty object or exact table overrides", async () => {
    const { client, fetch } = clientWith({ shape: "summary", rows: [] }, { shape: "table", rows: [], page: { size: 25, offset: 50, total: 60 } });
    expect((await client.reports.run("report-1")).shape).toBe("summary");
    const body = { page: { size: 25, offset: 50 }, sort: [{ by: "created_at", dir: "desc" as const }] };
    expect((await client.reports.run("report-1", body)).shape).toBe("table");
    expect(fetch.mock.calls.map(([, options]) => JSON.parse(options!.body as string))).toEqual([{}, body]);
    expect(new URL(String(fetch.mock.calls[0]![0])).pathname).toBe("/api/v1/reports/report-1/run");
  });

  it("upserts an event and registers an attendee with its acquisition", async () => {
    const { client, fetch } = clientWith(
      { id: "event-1", external_id: "autumn-2026", duplicate: true },
      { id: "att-1", created: true, previous_status: null, zoom: { status: "registered", join_url: "https://zoom.test/j/1" } },
    );
    const event = await client.events.upsert({ name: "Autumn webinar", external_id: "autumn-2026" });
    expect(event.duplicate).toBe(true);
    const register = { contact: { email: "jane@example.com" }, acquisition: { event_id: "webinar-signup-8891" } };
    const result = await client.events.register(event.id, register);
    expect([result.created, result.zoom?.status]).toEqual([true, "registered"]);
    expect(fetch.mock.calls.map(([url, options]) => [new URL(String(url)).pathname, options?.method])).toEqual([
      ["/api/v1/events", "POST"], ["/api/v1/events/event-1/attendances", "POST"],
    ]);
    expect(fetch.mock.calls.map(([, options]) => JSON.parse(options!.body as string))).toEqual([
      { name: "Autumn webinar", external_id: "autumn-2026" }, register,
    ]);
  });

  it("files an event under a saved event and filters the listing by it", async () => {
    const { client, fetch } = clientWith(
      { id: "event-2", event_type_id: "et-1", event_type: { id: "et-1", name: "Weekly yoga" }, duplicate: false },
      { data: [], limit: 50, offset: 0 },
    );
    const event = await client.events.upsert({ name: "Weekly yoga — October", event_type_name: "Weekly yoga" });
    expect(event.event_type).toEqual({ id: "et-1", name: "Weekly yoga" });
    await client.events.list({ event_type_id: "et-1", limit: 5 });
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({
      name: "Weekly yoga — October", event_type_name: "Weekly yoga",
    });
    const listUrl = new URL(String(fetch.mock.calls[1]![0]));
    expect([listUrl.pathname, listUrl.searchParams.get("event_type_id"), listUrl.searchParams.get("limit")]).toEqual([
      "/api/v1/events", "et-1", "5",
    ]);
  });

  it("moves an attendance by its own id and lists acquisitions under the contact", async () => {
    const { client, fetch } = clientWith({ id: "att-1", previous_status: "registered" }, { data: [], total: 0, limit: 50, offset: 0 });
    expect((await client.events.updateAttendance("att-1", "attended")).previous_status).toBe("registered");
    await client.contacts.listAcquisitions("contact-1", { kind: "api", limit: 20 });
    expect(fetch.mock.calls.map(([url, options]) => [new URL(String(url)).pathname, options?.method])).toEqual([
      ["/api/v1/attendances/att-1", "PATCH"], ["/api/v1/contacts/contact-1/acquisitions", "GET"],
    ]);
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({ status: "attended" });
    expect(Object.fromEntries(new URL(String(fetch.mock.calls[1]![0])).searchParams)).toEqual({ kind: "api", limit: "20" });
  });

  it("paginates report metadata with the report list cap", async () => {
    const { client, fetch } = clientWith({ data: [], total: 0, limit: 100, offset: 3 });
    for await (const report of client.reports.iter({ limit: 500, offset: 3 })) void report;
    const url = new URL(String(fetch.mock.calls[0]![0]));
    expect(url.pathname).toBe("/api/v1/reports");
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: "100", offset: "3" });
  });
});
