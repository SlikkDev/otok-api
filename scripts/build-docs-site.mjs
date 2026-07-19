#!/usr/bin/env node
/**
 * Build the static docs site into _site/.
 *
 * - Renders every markdown page under docs/api/ to HTML with a shared shell + nav.
 * - Copies docs/openapi.yaml into the site root for download.
 * - The Redoc API reference is built separately (see .github/workflows/docs.yml):
 *     npx @redocly/cli build-docs docs/openapi.yaml -o _site/reference/index.html
 *
 * Usage: node scripts/build-docs-site.mjs
 * Requires: marked (install with `npm install --no-save marked`).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = path.join(root, "docs", "api");
const outDir = path.join(root, "_site");

/** Guide order mirrors docs/api/README.md. */
const GUIDES = [
  ["getting-started", "Getting Started"],
  ["contacts", "Contacts"],
  ["tags-and-groups", "Tags & Contact Groups"],
  ["campaigns", "Campaigns (WhatsApp)"],
  ["templates", "Templates (WhatsApp)"],
  ["deals", "Deals & Pipelines"],
  ["payments", "Payments"],
  ["payment-requests", "Payment Requests"],
  ["orders", "Orders"],
  ["emails", "Transactional Emails"],
  ["webhooks", "Webhooks"],
  ["bookings", "Bookings & Meeting Types"],
];

const CSS = `
:root { --fg: #1f2430; --muted: #5b6472; --accent: #0f6fde; --border: #e3e6ea; --code-bg: #f5f7f9; }
* { box-sizing: border-box; }
body { margin: 0; color: var(--fg); font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
header.site { border-bottom: 1px solid var(--border); background: #fff; }
header.site .inner { max-width: 1080px; margin: 0 auto; padding: 14px 24px; display: flex; align-items: baseline; gap: 22px; flex-wrap: wrap; }
header.site .brand { font-weight: 700; font-size: 18px; color: var(--fg); text-decoration: none; }
header.site nav a { color: var(--muted); text-decoration: none; margin-right: 16px; font-size: 14px; }
header.site nav a:hover { color: var(--accent); }
.layout { max-width: 1080px; margin: 0 auto; padding: 28px 24px 64px; display: flex; gap: 40px; }
aside.toc { flex: 0 0 220px; font-size: 14px; }
aside.toc h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 18px 0 6px; }
aside.toc a { display: block; padding: 3px 0; color: var(--fg); text-decoration: none; }
aside.toc a:hover { color: var(--accent); }
aside.toc a.active { color: var(--accent); font-weight: 600; }
main.content { flex: 1 1 auto; min-width: 0; }
main.content h1 { margin-top: 0; }
main.content h1, main.content h2, main.content h3 { line-height: 1.3; }
main.content a { color: var(--accent); }
main.content pre { background: var(--code-bg); border: 1px solid var(--border); border-radius: 6px; padding: 14px 16px; overflow-x: auto; font-size: 13.5px; }
main.content code { background: var(--code-bg); border-radius: 4px; padding: 1px 5px; font-size: .9em; }
main.content pre code { background: none; padding: 0; }
main.content table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 14.5px; display: block; overflow-x: auto; }
main.content th, main.content td { border: 1px solid var(--border); padding: 7px 11px; text-align: left; vertical-align: top; }
main.content th { background: var(--code-bg); }
main.content blockquote { margin: 16px 0; padding: 2px 18px; border-left: 4px solid var(--accent); background: var(--code-bg); border-radius: 0 6px 6px 0; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; margin: 24px 0; }
.card { border: 1px solid var(--border); border-radius: 8px; padding: 16px 18px; text-decoration: none; color: var(--fg); display: block; }
.card:hover { border-color: var(--accent); }
.card h3 { margin: 0 0 6px; font-size: 16px; color: var(--accent); }
.card p { margin: 0; font-size: 13.5px; color: var(--muted); }
footer.site { border-top: 1px solid var(--border); color: var(--muted); font-size: 13px; }
footer.site .inner { max-width: 1080px; margin: 0 auto; padding: 16px 24px; }
@media (max-width: 800px) { .layout { flex-direction: column; } aside.toc { flex: none; } }
`;

/** Rewrite in-repo .md links to their rendered .html equivalents. */
function rewriteLink(href) {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) return href;
  const m = href.match(/^([^#?]*)\.md(#.*)?$/i);
  if (!m) return href;
  let base = m[1];
  if (path.basename(base).toLowerCase() === "readme") {
    base = path.join(path.dirname(base), "index");
  }
  return `${base}.html${m[2] || ""}`;
}

function renderMarkdown(md) {
  const renderer = new marked.Renderer();
  const origLink = renderer.link.bind(renderer);
  renderer.link = (token) => {
    token.href = rewriteLink(token.href);
    return origLink(token);
  };
  return marked.parse(md, { renderer, gfm: true });
}

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.body - rendered HTML body
 * @param {string} opts.rel - relative prefix from this page to the site root ("" or "../")
 * @param {string} [opts.active] - active guide slug
 */
function shell({ title, body, rel, active }) {
  const guideLinks = GUIDES.map(
    ([slug, name]) =>
      `<a href="${rel}api/${slug}.html"${active === slug ? ' class="active"' : ""}>${name}</a>`
  ).join("\n      ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${CSS}</style>
</head>
<body>
<header class="site">
  <div class="inner">
    <a class="brand" href="${rel}index.html">oToK Developer Docs</a>
    <nav>
      <a href="${rel}api/index.html">Guides</a>
      <a href="${rel}reference/index.html">API Reference</a>
      <a href="${rel}openapi.yaml">openapi.yaml</a>
      <a href="https://github.com/slikkdev/otok-api">GitHub</a>
    </nav>
  </div>
</header>
<div class="layout">
  <aside class="toc">
    <h2>Guides</h2>
      <a href="${rel}api/index.html"${active === "index" ? ' class="active"' : ""}>Overview</a>
      ${guideLinks}
    <h2>Reference</h2>
      <a href="${rel}reference/index.html">API Reference (Redoc)</a>
      <a href="${rel}openapi.yaml">OpenAPI 3.1 spec</a>
  </aside>
  <main class="content">
${body}
  </main>
</div>
<footer class="site">
  <div class="inner">oToK REST API — base URL <code>https://app.otok.io/api/v1/</code> · <a href="https://github.com/slikkdev/otok-api">slikkdev/otok-api</a></div>
</footer>
</body>
</html>
`;
}

const INDEX_BODY = `
<h1>oToK Developer Documentation</h1>
<p>Developer resources for integrating with <strong>oToK</strong> — a multichannel marketing
communication platform (WhatsApp, email, web). The REST API lets you sync contacts, run
WhatsApp campaigns, send template messages and transactional email, manage deals and
payments, and drive bookings from your own systems.</p>
<ul>
  <li>Base URL: <code>https://app.otok.io/api/v1/</code></li>
  <li>Auth: workspace API keys (<code>otok_live_…</code>), created in <strong>Settings → Developers</strong></li>
  <li>Requires a plan with API access (Growth or higher)</li>
</ul>
<div class="cards">
  <a class="card" href="reference/index.html"><h3>API Reference</h3><p>Browsable reference rendered from the OpenAPI 3.1 spec (Redoc).</p></a>
  <a class="card" href="api/getting-started.html"><h3>Getting Started</h3><p>API keys, authentication, errors, rate limits, pagination &amp; filtering.</p></a>
  <a class="card" href="openapi.yaml"><h3>openapi.yaml</h3><p>Download the machine-readable OpenAPI 3.1 description.</p></a>
</div>
<h2>Guides</h2>
<ul>
${GUIDES.map(([slug, name]) => `  <li><a href="api/${slug}.html">${name}</a></li>`).join("\n")}
</ul>
`;

// ── Build ──
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, "api"), { recursive: true });

// Guide pages + docs/api/README.md → api/index.html
for (const file of fs.readdirSync(docsDir)) {
  if (!file.endsWith(".md")) continue;
  const md = fs.readFileSync(path.join(docsDir, file), "utf8");
  const slug = file.toLowerCase() === "readme.md" ? "index" : file.replace(/\.md$/, "");
  const titleMatch = md.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1] : slug;
  const html = shell({
    title: `${title} — oToK API`,
    body: renderMarkdown(md),
    rel: "../",
    active: slug,
  });
  fs.writeFileSync(path.join(outDir, "api", `${slug}.html`), html);
  console.log(`rendered docs/api/${file} -> _site/api/${slug}.html`);
}

// Landing page
fs.writeFileSync(
  path.join(outDir, "index.html"),
  shell({ title: "oToK Developer Docs", body: INDEX_BODY, rel: "" })
);
console.log("rendered _site/index.html");

// Spec download
fs.copyFileSync(path.join(root, "docs", "openapi.yaml"), path.join(outDir, "openapi.yaml"));
console.log("copied docs/openapi.yaml -> _site/openapi.yaml");

// Disable Jekyll processing on GitHub Pages
fs.writeFileSync(path.join(outDir, ".nojekyll"), "");
console.log("done");
