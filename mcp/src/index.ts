#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startHttpServer } from "./http";
import { createOtokMcpServer, SERVER_VERSION } from "./server";

export {
  createOtokMcpServer,
  SERVER_NAME,
  SERVER_VERSION,
  type OtokMcpServerOptions,
} from "./server";
export { startHttpServer, type HttpServerOptions } from "./http";
export {
  ALL_TOOL_NAMES,
  TOOL_DOMAINS,
  type ToolClient,
  type ToolContext,
  type ToolDomain,
} from "./tools";

const DEFAULT_HTTP_PORT = 3001;

const USAGE = `otok-mcp ${SERVER_VERSION} — MCP server for the oToK public API

Usage:
  otok-mcp                    stdio transport (default) — reads OTOK_API_KEY
  otok-mcp --http [--port N]  stateless Streamable HTTP on port N (default ${DEFAULT_HTTP_PORT});
                              every request must carry "Authorization: Bearer otok_live_…"
  otok-mcp --help | --version

Environment:
  OTOK_API_KEY   workspace API key (stdio mode only; HTTP mode authenticates per request)
  OTOK_API_BASE  API base URL including /api (default: the public oToK API)`;

function parsePort(args: string[]): number {
  const index = args.indexOf("--port");
  if (index === -1) return DEFAULT_HTTP_PORT;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    console.error(`[otok-mcp] invalid --port value: ${args[index + 1] ?? "(missing)"}`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    console.log(SERVER_VERSION);
    return;
  }
  const baseUrl = process.env.OTOK_API_BASE || undefined;

  if (args.includes("--http")) {
    const port = parsePort(args);
    const server = await startHttpServer({ port, baseUrl });
    const address = server.address();
    const boundPort =
      address !== null && typeof address === "object" ? address.port : port;
    // stderr, and never anything secret: HTTP mode holds no key of its own.
    console.error(
      `[otok-mcp] stateless Streamable HTTP listening on port ${boundPort} — POST with "Authorization: Bearer otok_live_…"; health probe at GET /healthz`,
    );
    return;
  }

  const apiKey = process.env.OTOK_API_KEY;
  if (!apiKey) {
    console.error(
      [
        "[otok-mcp] OTOK_API_KEY is not set.",
        "",
        "stdio mode authenticates with a workspace API key (an otok_live_… key,",
        "created in oToK under Settings → API keys). Set it in the MCP client's",
        "server config, e.g. for Claude Desktop:",
        "",
        '  { "mcpServers": { "otok": {',
        '      "command": "npx", "args": ["-y", "@otok/mcp"],',
        '      "env": { "OTOK_API_KEY": "otok_live_…" } } } }',
        "",
        "For the hosted HTTP mode run: otok-mcp --http --port 3001",
      ].join("\n"),
    );
    process.exit(1);
  }
  const server = createOtokMcpServer({ apiKey, baseUrl });
  await server.connect(new StdioServerTransport());
  console.error("[otok-mcp] ready on stdio");
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(
      `[otok-mcp] fatal: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });
}
