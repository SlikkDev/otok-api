# @otok/mcp

Official [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server for the [oToK](https://github.com/SlikkDev/otok-api) marketing platform — lets AI assistants (Claude Desktop, Claude Code, claude.ai, and any other MCP client) work the public `/v1` API through safe, well-described tools.

This is the **general oToK MCP server**; new API domains slot in over time. The current surface is **email marketing**:

- **Email campaigns** — list/create/edit broadcast campaigns, estimate the audience, send, schedule, unschedule
- **Smart newsletters** — manage newsletters and their sequenced issues, publish/schedule issues (per-subscriber catch-up delivery)

Tool descriptions teach the model the whole authoring contract — the markdown extensions (`::button[Label](https://url)`, `::snippet[name-or-uuid]`), the `[[path : fallback]]` personalization tokens, and the `compile: {ok, errors, warnings}` envelope — so an assistant can author real email content without reading the API docs first.

- **Node 18+**; runtime deps: `@modelcontextprotocol/sdk`, `zod`, `@otok/node`
- Two transports: **stdio** (default, local clients) and **stateless Streamable HTTP** (hosted endpoint)
- The API key is used per session (stdio) or per request (HTTP) and is **never logged or stored**

## The confirm contract (safety)

The four tools that put real email in real inboxes — `send_email_campaign`, `schedule_email_campaign`, `publish_newsletter_issue`, `schedule_newsletter_issue` — take a `confirm` boolean that **defaults to false**:

- `confirm: false` (or omitted) performs **zero mutation**. The tool returns a dry-run summary — live audience estimate / active subscriber count, subject, sender, content preview — and instructs the assistant to show it to the human and re-call with `confirm: true` only after explicit approval.
- `confirm: true` performs exactly the action.

`delete_newsletter_issue` has no confirm gate because the API only allows deleting never-published issues; published issues can never be deleted (exclude them from the archive instead).

## Setup

You need a workspace API key: **Settings → API keys** in oToK (keys look like `otok_live_…` and are shown once).

### Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "otok": {
      "command": "npx",
      "args": ["-y", "@otok/mcp"],
      "env": { "OTOK_API_KEY": "otok_live_…" }
    }
  }
}
```

### Claude Code

```bash
claude mcp add otok -e OTOK_API_KEY=otok_live_… -- npx -y @otok/mcp
```

### claude.ai (remote connector)

If your oToK deployment exposes the hosted MCP endpoint, add a custom connector in claude.ai (**Settings → Connectors → Add custom connector**) pointing at:

```
https://your-otok-domain/mcp
```

and supply your API key as the Bearer token (`Authorization: Bearer otok_live_…`). Every request authenticates with the caller's own key — the hosted endpoint holds no credentials of its own.

## Transports

### stdio (default)

```bash
OTOK_API_KEY=otok_live_… npx -y @otok/mcp
```

### Stateless Streamable HTTP

```bash
npx -y @otok/mcp --http --port 3001
```

- Every request must carry `Authorization: Bearer otok_live_…`; anything else gets a clean JSON-RPC auth error (HTTP 401). The key builds a per-request API client and lives only for that request.
- `GET /healthz` answers `{"status":"ok"}` without auth (for probes/load balancers).
- CORS is open (`Authorization` + the MCP headers allowed) so browser-based MCP clients work.
- Request bodies are capped at 4 MiB; requests are time-bounded.
- Stateless: no sessions, no SSE streams — `GET`/`DELETE` on the MCP path answer 405.

## Environment variables

| Variable | Mode | Meaning |
|---|---|---|
| `OTOK_API_KEY` | stdio only | Workspace API key (`otok_live_…`). HTTP mode authenticates per request instead. |
| `OTOK_API_BASE` | both | API base URL **including** the `/api` segment. Defaults to the public oToK API. |

## Tools

| Tool | What it does |
|---|---|
| `list_audiences` | Read-only targeting discovery — saved audiences (`audience_id` selectors); never returns the stored definition |
| `list_sender_profiles` | Read-only sender discovery — from-identities with the `verified` send-readiness signal |
| `list_email_campaigns` | List campaigns (status filter, paging, delivery counters) |
| `get_email_campaign` | One campaign, with a `plain_text` rendering of its content |
| `create_email_campaign` | Create a draft campaign (idempotent via `external_reference`) |
| `update_email_campaign` | Edit a draft/scheduled campaign; content changes recompile |
| `send_email_campaign` | **confirm-gated** — dry-run summary first, launch on `confirm: true` |
| `schedule_email_campaign` | **confirm-gated** — schedule a future launch |
| `unschedule_email_campaign` | Cancel a scheduled launch (back to draft) |
| `list_newsletters` | List newsletters with live `active_subscriber_count` |
| `get_newsletter` | One newsletter with its stored configuration |
| `create_newsletter` | Create a newsletter (name suffices) |
| `list_newsletter_issues` | List a newsletter's issues (`issue_number` is assigned at publish) |
| `get_newsletter_issue` | One issue, with a `plain_text` rendering of its content |
| `create_newsletter_issue` | Create a draft issue (idempotent via `external_reference`) |
| `update_newsletter_issue` | Edit an issue (published issues stay editable) |
| `delete_newsletter_issue` | Delete a never-published issue (permanent) |
| `publish_newsletter_issue` | **confirm-gated** — publish now, wake catch-up delivery |
| `schedule_newsletter_issue` | **confirm-gated** — schedule a future publish |
| `unschedule_newsletter_issue` | Cancel a scheduled publish (back to draft) |

Content-bearing tools accept one shared `content` parameter: `{ direction?, markdown | blocks | design_json }` (exactly one source). See any create/update tool's description for the full authoring guide the model reads.

## Local development

`@otok/mcp` depends on `"@otok/node": "^0.7.0"`. Until that version is on npm, install it from a locally packed tarball — the tarball satisfies the range, so the published dependency spec never changes:

```bash
# From the repo root
npm --prefix sdk/node ci
npm --prefix sdk/node run build
mkdir -p mcp/.local   # npm pack does not create a missing destination directory
npm pack ./sdk/node --pack-destination mcp/.local   # positional spec — npm pack ignores --prefix

cd mcp
npm install --no-save ./.local/otok-node-*.tgz   # installs the tarball + all other deps
npm run typecheck && npm run build && npm test
```

CI (`.github/workflows/ci.yml`, `mcp` job) runs the same steps. `mcp/` deliberately ships **without `package-lock.json`** for now — a lockfile would pin the `file:` tarball path; regenerate and commit it once the registry serves `@otok/node@^0.7.0`.

> **tsconfig note:** unlike `sdk/node` (`moduleResolution: "Node"`), this package uses `module`/`moduleResolution: "Node16"` because the MCP SDK's subpaths (`@modelcontextprotocol/sdk/server/mcp.js`) resolve only through its `exports` map, which node10 resolution cannot see. Output is still CommonJS.

## Releasing

Tag-driven, mirroring the Node SDK (`.github/workflows/release-mcp.yml`, npm trusted publishing/OIDC with an `NPM_TOKEN` fallback for the first publish):

1. **Publish `@otok/node` first** — the workflow refuses to publish while `@otok/node@^0.7.0` is not installable from npm.
2. Bump `version` in `mcp/package.json` **and** `SERVER_VERSION` in `mcp/src/server.ts`.
3. Tag `mcp-v<version>` and push the tag (or run the workflow manually via *workflow_dispatch* — it publishes and pushes the tag itself).

## Security notes

- The server is a thin, stateless bridge: your API key goes only into the `Authorization` header of requests to the oToK API — never into logs, files, or session state.
- All authorization is the API key's: the tools can do exactly what the key's workspace permissions and plan allow, nothing more.
- Destructive actions are consent-gated client-side via the confirm contract *and* validated server-side by the API's own state machine (draft/scheduled-only sends, never-deletable published issues, etc.).

## License

MIT
