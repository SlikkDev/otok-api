import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  EMAIL_CAMPAIGN_TOOL_NAMES,
  registerEmailCampaignTools,
} from "./email-campaigns";
import { NEWSLETTER_TOOL_NAMES, registerNewsletterTools } from "./newsletters";
import type { ToolContext } from "./shared";

export type { ToolClient, ToolContext } from "./shared";

/**
 * One entry per oToK domain exposed over MCP. Future surfaces (contacts,
 * deals, orders, …) slot in as new entries with their own tool module —
 * nothing else changes.
 */
export interface ToolDomain {
  /** Domain slug (matches the src/tools/<domain>.ts module name). */
  domain: string;
  /** The exact tool names the module registers, for registry checks. */
  toolNames: readonly string[];
  register(server: McpServer, ctx: ToolContext): void;
}

export const TOOL_DOMAINS: readonly ToolDomain[] = [
  {
    domain: "email-campaigns",
    toolNames: EMAIL_CAMPAIGN_TOOL_NAMES,
    register: registerEmailCampaignTools,
  },
  {
    domain: "newsletters",
    toolNames: NEWSLETTER_TOOL_NAMES,
    register: registerNewsletterTools,
  },
];

/** Every tool name the server registers, across all domains. */
export const ALL_TOOL_NAMES: readonly string[] = TOOL_DOMAINS.flatMap((d) => [
  ...d.toolNames,
]);

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  for (const domain of TOOL_DOMAINS) {
    domain.register(server, ctx);
  }
}
