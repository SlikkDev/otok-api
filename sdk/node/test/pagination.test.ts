import { describe, expect, it, vi } from "vitest";
import { OtokClient } from "../src/client";

/**
 * Build a fetch mock that serves a fixed dataset through the standard
 * `{ data, total, limit, offset }` envelope, honoring the request's
 * `limit`/`offset` query params and recording each requested page.
 */
function pagedFetch(totalRows: number) {
  const rows = Array.from({ length: totalRows }, (_, i) => ({ id: `row-${i}` }));
  const pages: Array<{ limit: number; offset: number; query: URLSearchParams }> =
    [];
  const fetchMock = vi.fn(async (url: any) => {
    const query = new URL(String(url)).searchParams;
    const limit = Number(query.get("limit"));
    const offset = Number(query.get("offset"));
    pages.push({ limit, offset, query });
    const body = {
      data: rows.slice(offset, offset + limit),
      total: rows.length,
      limit,
      offset,
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetchMock, pages };
}

function makeClient(fetchImpl: typeof fetch) {
  return new OtokClient({
    apiKey: "otok_live_testkey",
    baseUrl: "https://example.test/api",
    fetch: fetchImpl,
  });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

describe("pagination iterators", () => {
  it("contacts.iter pages at the documented cap (500) and yields every row", async () => {
    const { fetchMock, pages } = pagedFetch(1201);
    const otok = makeClient(fetchMock as any);
    const contacts = await collect(otok.contacts.iter());
    expect(contacts).toHaveLength(1201);
    expect(contacts[0]!.id).toBe("row-0");
    expect(contacts[1200]!.id).toBe("row-1200");
    expect(pages.map((p) => [p.limit, p.offset])).toEqual([
      [500, 0],
      [500, 500],
      [500, 1000],
    ]);
  });

  it("passes a smaller page-size override through", async () => {
    const { fetchMock, pages } = pagedFetch(5);
    const otok = makeClient(fetchMock as any);
    const tags = await collect(otok.tags.iter({ limit: 2 }));
    expect(tags).toHaveLength(5);
    expect(pages.map((p) => [p.limit, p.offset])).toEqual([
      [2, 0],
      [2, 2],
      [2, 4],
    ]);
  });

  it("clamps a page-size override above the documented cap", async () => {
    const { fetchMock, pages } = pagedFetch(1);
    const otok = makeClient(fetchMock as any);
    await collect(otok.contacts.iter({ limit: 9999 }));
    expect(pages[0]!.limit).toBe(500);
  });

  it("deals.iter uses the deals/payments cap (100), clamping overrides", async () => {
    const { fetchMock, pages } = pagedFetch(150);
    const otok = makeClient(fetchMock as any);
    const deals = await collect(otok.deals.iter({ limit: 250 }));
    expect(deals).toHaveLength(150);
    expect(pages.map((p) => [p.limit, p.offset])).toEqual([
      [100, 0],
      [100, 100],
    ]);
    expect(pages[0]!.query.get("limit")).toBe("100");
  });

  it("payments.iter defaults to the 100 cap", async () => {
    const { fetchMock, pages } = pagedFetch(3);
    const otok = makeClient(fetchMock as any);
    await collect(otok.payments.iter());
    expect(pages.map((p) => [p.limit, p.offset])).toEqual([[100, 0]]);
  });

  it("paymentRequests.iter uses the deals/payments cap (100) and forwards filters", async () => {
    const { fetchMock, pages } = pagedFetch(120);
    const otok = makeClient(fetchMock as any);
    const requests = await collect(
      otok.paymentRequests.iter({ status: "pending" }),
    );
    expect(requests).toHaveLength(120);
    expect(pages.map((p) => [p.limit, p.offset])).toEqual([
      [100, 0],
      [100, 100],
    ]);
    for (const page of pages) expect(page.query.get("status")).toBe("pending");
  });

  it("orders.iter uses the deals/payments cap (100), clamping overrides", async () => {
    const { fetchMock, pages } = pagedFetch(150);
    const otok = makeClient(fetchMock as any);
    const orders = await collect(otok.orders.iter({ limit: 250 }));
    expect(orders).toHaveLength(150);
    expect(orders[0]!.id).toBe("row-0");
    expect(orders[149]!.id).toBe("row-149");
    expect(pages.map((p) => [p.limit, p.offset])).toEqual([
      [100, 0],
      [100, 100],
    ]);
  });

  it("orders.iter forwards the caller's filters on every page", async () => {
    const { fetchMock, pages } = pagedFetch(250);
    const otok = makeClient(fetchMock as any);
    await collect(otok.orders.iter({ status: "paid", source: "api" }));
    expect(pages).toHaveLength(3);
    for (const page of pages) {
      expect(page.query.get("status")).toBe("paid");
      expect(page.query.get("source")).toBe("api");
    }
  });

  it("orders.iter terminates on a short page despite a stale total", async () => {
    // An order deleted between pages: the total still says more but the
    // next page is empty — the iterator must terminate, not loop.
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      const body =
        calls === 1
          ? { data: [{ id: "row-0" }], total: 80, limit: 100, offset: 0 }
          : { data: [], total: 80, limit: 100, offset: 1 };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const otok = makeClient(fetchMock as any);
    const orders = await collect(otok.orders.iter());
    expect(orders).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("orders.iter handles an empty result set with a single request", async () => {
    const { fetchMock, pages } = pagedFetch(0);
    const otok = makeClient(fetchMock as any);
    expect(await collect(otok.orders.iter())).toEqual([]);
    expect(pages.map((p) => [p.limit, p.offset])).toEqual([[100, 0]]);
  });

  it("forwards the caller's filter params on every page", async () => {
    const { fetchMock, pages } = pagedFetch(750);
    const otok = makeClient(fetchMock as any);
    await collect(
      otok.contacts.iter({
        filter: { lifecycle_stage: "customer" },
        sort: "-updated_at",
      }),
    );
    expect(pages).toHaveLength(2);
    for (const page of pages) {
      expect(page.query.get("filter")).toBe(
        JSON.stringify({ lifecycle_stage: "customer" }),
      );
      expect(page.query.get("sort")).toBe("-updated_at");
    }
  });

  it("starts at the caller's offset", async () => {
    const { fetchMock, pages } = pagedFetch(600);
    const otok = makeClient(fetchMock as any);
    const contacts = await collect(otok.contacts.iter({ offset: 550 }));
    expect(contacts).toHaveLength(50);
    expect(contacts[0]!.id).toBe("row-550");
    expect(pages.map((p) => [p.limit, p.offset])).toEqual([[500, 550]]);
  });

  it("handles an empty result set with a single request", async () => {
    const { fetchMock, pages } = pagedFetch(0);
    const otok = makeClient(fetchMock as any);
    const contacts = await collect(otok.contacts.iter());
    expect(contacts).toEqual([]);
    expect(pages).toHaveLength(1);
  });

  it("stops when a page comes back short even if total says more", async () => {
    // Rows deleted between pages: the server reports a stale total but an
    // empty page — the iterator must terminate rather than loop.
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      const body =
        calls === 1
          ? { data: [{ id: "row-0" }], total: 400, limit: 500, offset: 0 }
          : { data: [], total: 400, limit: 500, offset: 1 };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const otok = makeClient(fetchMock as any);
    const contacts = await collect(otok.contacts.iter());
    expect(contacts).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("is lazy — stops requesting once the consumer breaks", async () => {
    const { fetchMock, pages } = pagedFetch(1500);
    const otok = makeClient(fetchMock as any);
    for await (const contact of otok.contacts.iter()) {
      if (contact.id === "row-10") break; // within the first page
    }
    expect(pages).toHaveLength(1);
  });

  it("bookings, campaigns, templates, contact groups and meeting types iterate too", async () => {
    const { fetchMock, pages } = pagedFetch(2);
    const otok = makeClient(fetchMock as any);
    expect(await collect(otok.bookings.iter())).toHaveLength(2);
    expect(await collect(otok.campaigns.iter())).toHaveLength(2);
    expect(await collect(otok.templates.iter())).toHaveLength(2);
    expect(await collect(otok.contactGroups.iter())).toHaveLength(2);
    expect(await collect(otok.meetingTypes.iter())).toHaveLength(2);
    // All standard-convention endpoints page at the 500 cap.
    expect(pages.every((p) => p.limit === 500)).toBe(true);
  });
});
