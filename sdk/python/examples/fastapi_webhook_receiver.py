"""Verified oToK webhook receiver (FastAPI).

Setup:
    1. pip install otok fastapi uvicorn   (example-only dependencies)
    2. Register the endpoint once and save the whsec_... secret:
           endpoint = client.webhook_endpoints.create({"url": "https://shop.example.com/otok-events"})
           print(endpoint["secret"])      # shown only once
    3. OTOK_WEBHOOK_SECRET=whsec_... uvicorn examples.fastapi_webhook_receiver:app
"""

import os

from fastapi import FastAPI, Request, Response

from otok import OtokWebhookVerificationError, construct_event

app = FastAPI()
SECRET = os.environ["OTOK_WEBHOOK_SECRET"]


@app.post("/otok-events")
async def otok_events(request: Request) -> Response:
    # Signature verification needs the RAW body - await request.body()
    # returns the exact bytes received on the wire (do not use
    # request.json() first).
    raw_body = await request.body()
    try:
        event = construct_event(
            raw_body,
            request.headers.get("x-otok-signature"),
            SECRET,
        )
    except OtokWebhookVerificationError:
        return Response(content="bad signature", status_code=400)

    if event["type"] == "email.bounced":
        data = event["data"]
        print(f"bounced ({data.get('bounce_type', '?')}) -> {data['to']}")
    # ...handle the other event types; dedupe on event["id"]...

    return Response(content="ok", status_code=200)  # 2xx stops retries
