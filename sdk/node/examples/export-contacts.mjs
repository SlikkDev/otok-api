/**
 * Export every contact in the workspace to CSV on stdout, using the
 * auto-paginating iterator (pages of 500 — the documented cap for
 * GET /v1/contacts — fetched lazily).
 *
 * Run (after `npm run build` in sdk/node):
 *   OTOK_API_KEY=otok_live_… node examples/export-contacts.mjs > contacts.csv
 */
import { OtokClient } from "../dist/index.js";

const otok = new OtokClient({
  apiKey: process.env.OTOK_API_KEY,
  baseUrl: process.env.OTOK_BASE_URL, // optional override; defaults to https://app.otok.io/api
});

const csvField = (value) =>
  value == null ? "" : `"${String(value).replaceAll('"', '""')}"`;

console.log("id,name,email,phone,lifecycle_stage");

let count = 0;
// iter() accepts the same params as list() — filter, sort, search — and
// never exceeds the endpoint's documented page-size cap.
for await (const contact of otok.contacts.iter({ sort: "-created_at" })) {
  console.log(
    [
      csvField(contact.id),
      csvField(contact.name),
      csvField(contact.email),
      csvField(contact.phone),
      csvField(contact.lifecycle_stage),
    ].join(","),
  );
  count += 1;
}

console.error(`exported ${count} contacts`);
