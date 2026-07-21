import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createOtokMcpServer } from "./server";

const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024; // generous over the 512k content cap
/** Wall-clock guard per HTTP request (the SDK client's own timeout is shorter). */
const REQUEST_TIMEOUT_MS = 120_000;

export interface HttpServerOptions {
  /** TCP port to listen on (0 = ephemeral, used by tests). */
  port: number;
  /** oToK API base URL forwarded to the per-request SDK client (OTOK_API_BASE). */
  baseUrl?: string;
  /** Reject request bodies larger than this many bytes (default 4 MiB). */
  maxBodyBytes?: number;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

function jsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

/**
 * Extract the caller's oToK API key from `Authorization: Bearer otok_…`.
 * The key is used for this one request's SDK client and nothing else — it is
 * never logged and never stored.
 */
function bearerKey(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  const key = match?.[1];
  return key !== undefined && key.startsWith("otok_") ? key : undefined;
}

/** Read the request body up to `maxBytes`; resolves null when exceeded. */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let exceeded = false;
    req.on("data", (chunk: Buffer) => {
      if (exceeded) return;
      size += chunk.length;
      if (size > maxBytes) {
        exceeded = true;
        req.pause();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!exceeded) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

/**
 * Stateless Streamable HTTP endpoint: every POST must carry the caller's own
 * workspace API key as `Authorization: Bearer otok_live_…`, which becomes the
 * per-request SDK client — a fresh MCP server + transport pair is built per
 * request and torn down with the response, so no session state (and no key)
 * survives a request. `GET /healthz` answers unauthenticated for probes.
 */
export function startHttpServer(options: HttpServerOptions): Promise<Server> {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const server = createServer((req, res) => {
    void handleRequest(req, res, options, maxBodyBytes);
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, () => resolve(server));
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: HttpServerOptions,
  maxBodyBytes: number,
): Promise<void> {
  try {
    for (const [name, value] of Object.entries(CORS_HEADERS)) {
      res.setHeader(name, value);
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.method !== "POST") {
      // Stateless mode: no SSE streams to GET, no sessions to DELETE.
      jsonRpcError(
        res,
        405,
        -32000,
        "Method not allowed. This stateless MCP endpoint accepts POST only (and GET /healthz).",
      );
      return;
    }
    const apiKey = bearerKey(req);
    if (apiKey === undefined) {
      jsonRpcError(
        res,
        401,
        -32001,
        'Unauthorized: send your oToK workspace API key as "Authorization: Bearer otok_live_…". Keys are created in oToK under Settings → API keys.',
      );
      return;
    }
    const rawBody = await readBody(req, maxBodyBytes);
    if (rawBody === null) {
      jsonRpcError(
        res,
        413,
        -32000,
        `Request body exceeds the ${maxBodyBytes}-byte limit.`,
      );
      return;
    }
    let parsedBody: unknown;
    try {
      parsedBody = rawBody === "" ? undefined : JSON.parse(rawBody);
    } catch {
      jsonRpcError(res, 400, -32700, "Parse error: request body is not valid JSON.");
      return;
    }

    // Fresh server + transport per request (stateless): the caller's key
    // exists only inside this request's closure.
    const mcpServer = createOtokMcpServer({ apiKey, baseUrl: options.baseUrl });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void mcpServer.close();
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch {
    // Never leak internals (or the key) into error responses or logs.
    if (!res.headersSent) {
      jsonRpcError(res, 500, -32603, "Internal error.");
    } else {
      res.end();
    }
  }
}
