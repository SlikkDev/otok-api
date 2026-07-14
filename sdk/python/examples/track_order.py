"""Track a store order in oToK: upsert the customer as a contact, create an
idempotent deal keyed by the order id, and send a receipt email once.

Run:
    pip install otok
    OTOK_API_KEY=otok_live_... python examples/track_order.py
"""

import os

from otok import OtokClient

client = OtokClient(api_key=os.environ["OTOK_API_KEY"])

# Safe to re-run: the contact upserts, the deal is keyed by
# external_reference "order:A-1001", and the receipt's idempotency key
# guarantees at most one email per order.
result = client.commerce.track_order(
    {
        "order_id": "A-1001",
        "customer": {
            "email": "jane@example.com",
            "phone": "+12025551234",
            "first_name": "Jane",
            "last_name": "Doe",
            "tags": ["Customer"],
            "address": {"city": "Tel Aviv", "country": "IL"},
        },
        "total": 249.9,
        "currency": "USD",
        "note": "2 items: SKU-1 x1, SKU-9 x1",
        "receipt": {
            "subject": "Your order A-1001 is confirmed",
            "html": "<h1>Thanks, Jane!</h1><p>Order A-1001 - total $249.90.</p>",
            "text": "Thanks, Jane! Order A-1001 - total $249.90.",
        },
    }
)

print("contact:", result.contact["id"], result.contact.get("email"))
print("deal:", result.deal["id"], result.deal.get("status"), result.deal.get("external_reference"))
if result.receipt is not None:
    print(
        "receipt:",
        result.receipt["id"],
        result.receipt["status"],
        "duplicate:",
        result.receipt["duplicate"],
    )

# When the order is paid/fulfilled, close the deal:
# client.deals.set_status(result.deal["id"], {"status": "won"})
