"""Verified oToK webhook receiver (Flask).

Setup:
    1. pip install otok flask          (flask is an example-only dependency)
    2. Register the endpoint once and save the whsec_... secret:
           endpoint = client.webhook_endpoints.create({"url": "https://shop.example.com/otok-events"})
           print(endpoint["secret"])   # shown only once
    3. OTOK_WEBHOOK_SECRET=whsec_... flask --app examples/flask_webhook_receiver run

oToK signs every delivery with `X-Otok-Signature: t=<unix>,v1=<hex>` and
retries failed deliveries for ~16 hours - answer 2xx once processed, and
dedupe on event["id"] (retries reuse the same id).
"""

import os

from flask import Flask, request

from otok import OtokWebhookVerificationError, construct_event

app = Flask(__name__)
SECRET = os.environ["OTOK_WEBHOOK_SECRET"]


@app.post("/otok-events")
def otok_events() -> tuple:
    # Signature verification needs the RAW body - request.get_data() returns
    # the exact bytes received on the wire.
    try:
        event = construct_event(
            request.get_data(),
            request.headers.get("X-Otok-Signature"),
            SECRET,
        )
    except OtokWebhookVerificationError:
        return "bad signature", 400

    event_type = event["type"]
    data = event["data"]
    if event_type == "email.delivered":
        print(f"delivered -> {data['to']} (send {data['send_id']})")
    elif event_type == "email.bounced":
        print(f"bounced ({data.get('bounce_type', '?')}) -> {data['to']}: {data.get('reason', '')}")
        # e.g. stop emailing this address in your own store DB
    elif event_type == "email.complained":
        print(f"complaint -> {data['to']}")
    elif event_type == "email.opened":
        print(f"opened -> {data['to']} (machine_open: {data['machine_open']})")
    elif event_type == "email.clicked":
        print(f"clicked -> {data['url']}")

    # `metadata` echoes what you passed to POST /v1/emails (e.g. order ids).
    if "metadata" in data:
        print("metadata:", data["metadata"])

    return "ok", 200  # 2xx stops retries; dedupe on event["id"]
