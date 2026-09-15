# Shared saved reports

Use reports built and shared in the oToK app from an external integration. API keys can list and run **shared, unarchived reports** in their workspace. Runs use workspace-wide data; sharing a report makes its results available to holders of workspace API keys. Private reports are unavailable.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/reports` | List shared saved report metadata |
| POST | `/api/v1/reports/:id/run` | Run a saved report |

Both endpoints require [API access](getting-started.md). A run also checks the plan feature required by its dataset.

## List reports

Accepts `limit` (default 25, cap 100) and `offset` (default 0); malformed values return 400. Returns `{ data, total, limit, offset }`, newest update first.

Each row has `id`, `name`, `description`, `dataset`, `shape` (`table` or `summary`), `chart_type`, `created_at` and `updated_at`. Definitions are not returned. Create, edit and share reports in the app.

## Run a report

Send an empty object to use the saved report's settings. For a table report, optionally override paging and sorting:

```json
{
  "page": { "size": 50, "offset": 0 },
  "sort": [{ "by": "created_at", "dir": "desc" }]
}
```

Use a sortable column key from your report for `by`. Page size is 1–200; offset is 0–10,000. Both page fields are required when `page` is sent. Sorting accepts up to 3 keys, each with a non-empty `by` (≤200 chars) and `dir` of `asc` or `desc`. These overrides apply to table reports. Inline definitions and other body properties are rejected.

The response is **201**, with one of these shapes:

- Table: `{ shape: "table", columns, rows, page: { size, offset, total }, meta }`.
- Summary: `{ shape: "summary", columns, rows, meta }`.

Read cell values using each column's `key`. Related-record reports can return several lines for one root record, so `page.total` counts lines, not unique contact ids. The result can include additional column descriptors, grouping and related-record metadata.

Check `meta.truncated` before treating a result as complete, and `meta.currencyWarnings` for currencies excluded from converted money values. Metadata also includes the dataset, shape, currency mode, timezone, week start and generation time.

| Status | Meaning |
|---|---|
| 400 | Invalid id, paging, sorting or unknown request fields |
| 401 | Invalid API key |
| 403 | API access or the dataset's plan feature is unavailable |
| 404 | Unknown, private, archived or cross-workspace report |
| 429 | Rate limit exceeded |
