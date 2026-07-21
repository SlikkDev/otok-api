import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startHttpServer } from "../src/http";
import { ALL_TOOL_NAMES } from "../src/tools";

const API_KEY = "otok_live_http_test_key";
const MCP_ACCEPT = "application/json, text/event-stream";

let server: Server;
let baseUrl: string;
let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

beforeAll(async () => {
  // The spies watch the whole suite: no request — authorized or not — may
  // ever put the API key on the console.
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
    vi.spyOn(console, level),
  );
  server = await startHttpServer({ port: 0, maxBodyBytes: 2048 });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const spy of consoleSpies) spy.mockRestore();
});

function rpc(id: number, method: string, params: Record<string, unknown> = {}) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

const INITIALIZE = rpc(1, "initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "http-test", version: "0.0.0" },
});

function post(body: string, headers: Record<string, string> = {}) {
  return fetch(baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: MCP_ACCEPT,
      ...headers,
    },
    body,
  });
}

describe("healthz + CORS", () => {
  it("GET /healthz answers ok without auth", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("OPTIONS preflight allows the Authorization and MCP headers", async () => {
    const res = await fetch(baseUrl, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const allowed = res.headers.get("access-control-allow-headers") ?? "";
    expect(allowed).toContain("Authorization");
    expect(allowed).toContain("Mcp-Session-Id");
    expect(allowed).toContain("Mcp-Protocol-Version");
  });
});

describe("authentication", () => {
  it("a request without Authorization is rejected with a clean JSON-RPC error", async () => {
    const res = await post(INITIALIZE);
    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      jsonrpc: string;
      error: { code: number; message: string };
      id: null;
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toContain("Authorization: Bearer otok_live_");
    expect(body.id).toBeNull();
  });

  it("a non-Bearer scheme is rejected", async () => {
    const res = await post(INITIALIZE, { Authorization: "Basic dXNlcjpwdw==" });
    expect(res.status).toBe(401);
  });

  it("a bearer token that is not an oToK key is rejected", async () => {
    const res = await post(INITIALIZE, { Authorization: "Bearer not-a-key" });
    expect(res.status).toBe(401);
  });

  it("a GET to the MCP path is refused (stateless endpoint)", async () => {
    const res = await fetch(baseUrl, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(405);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("POST");
  });
});

describe("stateless MCP over Streamable HTTP", () => {
  it("initialize answers with the server identity", async () => {
    const res = await post(INITIALIZE, { Authorization: `Bearer ${API_KEY}` });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as {
      id: number;
      result: { serverInfo: { name: string; version: string } };
    };
    expect(body.id).toBe(1);
    expect(body.result.serverInfo.name).toBe("otok");
  });

  it("tools/list works per request without session state and lists every tool", async () => {
    const res = await post(rpc(2, "tools/list"), {
      Authorization: `Bearer ${API_KEY}`,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    const names = body.result.tools.map((t) => t.name).sort();
    expect(names).toEqual([...ALL_TOOL_NAMES].sort());
  });

  it("invalid JSON answers a -32700 parse error", async () => {
    const res = await post("{not json", { Authorization: `Bearer ${API_KEY}` });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it("bodies over the limit answer 413 without being processed", async () => {
    const res = await post(
      JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: { pad: "x".repeat(4096) } }),
      { Authorization: `Bearer ${API_KEY}` },
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("limit");
  });
});

describe("key hygiene", () => {
  it("the API key never reaches the console", () => {
    for (const spy of consoleSpies) {
      for (const callArgs of spy.mock.calls) {
        const rendered = callArgs.map((a: unknown) => String(a)).join(" ");
        expect(rendered).not.toContain(API_KEY);
        expect(rendered).not.toContain("otok_live_");
      }
    }
  });
});
