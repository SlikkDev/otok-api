"""Export every contact in the workspace to CSV on stdout, using the
auto-paginating iterator (pages of 500 — the documented cap for
GET /v1/contacts — fetched lazily).

Run:
    pip install otok
    OTOK_API_KEY=otok_live_... python examples/export_contacts.py > contacts.csv
"""

import csv
import os
import sys

from otok import OtokClient

client = OtokClient(api_key=os.environ["OTOK_API_KEY"])

writer = csv.writer(sys.stdout)
writer.writerow(["id", "name", "email", "phone", "lifecycle_stage"])

count = 0
# iter() accepts the same params as list() — filter, sort, search — and
# never exceeds the endpoint's documented page-size cap.
for contact in client.contacts.iter({"sort": "-created_at"}):
    writer.writerow(
        [
            contact.get("id"),
            contact.get("name"),
            contact.get("email"),
            contact.get("phone"),
            contact.get("lifecycle_stage"),
        ]
    )
    count += 1

print(f"exported {count} contacts", file=sys.stderr)
