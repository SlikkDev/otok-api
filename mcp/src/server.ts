import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OtokClient } from "@otok/node";
import { registerAllTools, type ToolClient } from "./tools";

export const SERVER_NAME = "otok";
/** Keep in sync with package.json (the SDK_VERSION-in-source house pattern). */
export const SERVER_VERSION = "0.1.0";

const SERVER_INSTRUCTIONS = `oToK is a multichannel marketing platform; this server exposes its public API to AI assistants. Current surface: email marketing — broadcast email campaigns and smart newsletters (sequenced issues with per-subscriber catch-up delivery).

SAFETY CONTRACT: send_email_campaign, schedule_email_campaign, publish_newsletter_issue and schedule_newsletter_issue NEVER act unless called with confirm: true. Called without it they perform no mutation and return a dry-run summary (live audience size, subject, sender, content preview) — show that summary to the user, get explicit approval, and only then re-call with confirm: true.

AUTHORING: campaign bodies and issue content share one "content" parameter — markdown (with ::button[Label](https://url) and ::snippet[name-or-uuid] directive lines), a typed blocks array, or a raw design_json replay — plus [[path : fallback]] personalization tokens usable in any text including subjects. Every write response reports compile: {ok, errors, warnings}; fix errors before launching. The create tools are idempotent via external_reference.`;

export interface OtokMcpServerOptions {
  /**
   * Workspace API key (`otok_live_…`) — resolved per session in stdio mode
   * (the OTOK_API_KEY env var) and per request in HTTP mode (the caller's
   * Authorization bearer). Never logged or stored by this package.
   */
  apiKey: string;
  /**
   * oToK API base URL **including** the `/api` segment (the OTOK_API_BASE
   * env var). Defaults to the SDK's public default.
   */
  baseUrl?: string;
  /** Test seam: a pre-built SDK client. When set, apiKey/baseUrl are unused. */
  client?: ToolClient;
}

/**
 * Build a fully wired, transport-agnostic oToK MCP server: connect it to a
 * stdio transport for a per-session key, or to a fresh Streamable HTTP
 * transport per request for a per-request key.
 */
export function createOtokMcpServer(options: OtokMcpServerOptions): McpServer {
  const client =
    options.client ??
    new OtokClient({ apiKey: options.apiKey, baseUrl: options.baseUrl });
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerAllTools(server, { client });
  return server;
}
