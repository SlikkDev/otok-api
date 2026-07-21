"""The oToK API client."""

from __future__ import annotations

from typing import Optional

from ._http import (
    DEFAULT_MAX_RETRIES,
    DEFAULT_TIMEOUT_SECONDS,
    HttpClient,
    Transport,
)
from .commerce import CommerceApi
from .resources import (
    AudiencesApi,
    BookingsApi,
    CampaignsApi,
    ContactGroupsApi,
    ContactsApi,
    DealsApi,
    EmailCampaignsApi,
    EmailsApi,
    MeetingTypesApi,
    NewslettersApi,
    OrdersApi,
    PaymentRequestsApi,
    PaymentsApi,
    PipelinesApi,
    ProductsApi,
    SenderProfilesApi,
    SuppressionsApi,
    TagsApi,
    TemplatesApi,
    WebhookEndpointsApi,
)


class OtokClient:
    """Client for the oToK public API (/v1).

    ::

        from otok import OtokClient

        client = OtokClient(api_key=os.environ["OTOK_API_KEY"])  # "otok_live_…"
        contact = client.contacts.upsert({"email": "jane@example.com"})

    Rate limits: requests are throttled per API key (default 100/min; POST
    /v1/emails allows 300/min). The client retries 429 and 5xx responses
    with exponential backoff + jitter, honoring ``Retry-After``. Transient
    network errors (connection reset/refused, DNS failure, socket timeout)
    share the same bounded backoff, but only for requests that are safe to
    replay: GET/HEAD, or writes carrying an idempotency key
    (``idempotency_key``, ``external_reference``, ``external_refund_id``) —
    other writes surface the network error.

    :param api_key: API key (``otok_live_…``), sent as
        ``Authorization: Bearer <key>``.
    :param timeout: Request timeout in seconds. Default 30. With the default
        urllib transport this bounds each socket operation (connect, each
        read), not a whole attempt's wall-clock time.
    :param max_retries: Retry attempts after the first request. Default 2
        (i.e. up to 3 requests total). Set 0 to disable retries. Applies to
        429/5xx responses (all requests) and to transient network errors
        (safe or idempotency-keyed requests only).
    :param transport: Injectable transport implementation (used by tests).
        Defaults to the built-in ``urllib``-based transport.
    :param base_url: Internal/testing override only — leave unset.
    """

    def __init__(
        self,
        api_key: str,
        *,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        max_retries: int = DEFAULT_MAX_RETRIES,
        transport: Optional[Transport] = None,
        base_url: Optional[str] = None,
    ) -> None:
        self._http = HttpClient(
            api_key,
            base_url=base_url,
            timeout=timeout,
            max_retries=max_retries,
            transport=transport,
        )
        self.contacts = ContactsApi(self._http)
        self.tags = TagsApi(self._http)
        self.contact_groups = ContactGroupsApi(self._http)
        self.pipelines = PipelinesApi(self._http)
        self.deals = DealsApi(self._http)
        self.products = ProductsApi(self._http)
        self.suppressions = SuppressionsApi(self._http)
        self.emails = EmailsApi(self._http)
        self.campaigns = CampaignsApi(self._http)
        self.audiences = AudiencesApi(self._http)
        self.sender_profiles = SenderProfilesApi(self._http)
        self.email_campaigns = EmailCampaignsApi(self._http)
        self.newsletters = NewslettersApi(self._http)
        self.templates = TemplatesApi(self._http)
        self.payments = PaymentsApi(self._http)
        self.payment_requests = PaymentRequestsApi(self._http)
        self.orders = OrdersApi(self._http)
        self.meeting_types = MeetingTypesApi(self._http)
        self.bookings = BookingsApi(self._http)
        self.webhook_endpoints = WebhookEndpointsApi(self._http)
        #: High-level e-commerce helpers (identify_customer, track_order).
        self.commerce = CommerceApi(self.contacts, self.deals, self.emails)
