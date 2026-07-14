"""Verified oToK webhook receiver (Django) - a runnable single-file app.

Setup:
    1. pip install otok django            (django is an example-only dependency)
    2. Register the endpoint once and save the whsec_... secret:
           endpoint = client.webhook_endpoints.create({"url": "https://shop.example.com/otok-events"})
           print(endpoint["secret"])       # shown only once
    3. OTOK_WEBHOOK_SECRET=whsec_... python examples/django_webhook_receiver.py runserver

In a regular Django project you only need the `otok_events` view below:
mount it in urls.py and exempt it from CSRF (webhooks carry no CSRF token —
the HMAC signature is the authentication).
"""

import os
import sys

import django
from django.conf import settings
from django.http import HttpRequest, HttpResponse
from django.urls import path
from django.views.decorators.csrf import csrf_exempt

from otok import OtokWebhookVerificationError, construct_event

SECRET = os.environ["OTOK_WEBHOOK_SECRET"]


@csrf_exempt
def otok_events(request: HttpRequest) -> HttpResponse:
    if request.method != "POST":
        return HttpResponse(status=405)
    # Signature verification needs the RAW body - request.body is the exact
    # bytes received on the wire (do not parse it first).
    try:
        event = construct_event(
            request.body,
            request.headers.get("X-Otok-Signature"),
            SECRET,
        )
    except OtokWebhookVerificationError:
        return HttpResponse("bad signature", status=400)

    if event["type"] == "email.bounced":
        data = event["data"]
        print(f"bounced ({data.get('bounce_type', '?')}) -> {data['to']}")
    # ...handle the other event types; dedupe on event["id"]...

    return HttpResponse("ok", status=200)  # 2xx stops retries


# ── Minimal single-file Django wiring (skip this in a real project) ──

settings.configure(
    DEBUG=True,
    ALLOWED_HOSTS=["*"],
    ROOT_URLCONF=__name__,
    SECRET_KEY="example-only",  # example wiring, not a real secret
)
urlpatterns = [path("otok-events", otok_events)]
django.setup()

if __name__ == "__main__":
    from django.core.management import execute_from_command_line

    execute_from_command_line(sys.argv)
