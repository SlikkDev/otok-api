import type { ContactAcquisition, ContactUpdateParams, ContactUpsertParams } from "../src";

export const acquisition: ContactAcquisition = { event_id: "signup-example-001" };
export const upsert: ContactUpsertParams = { acquisition, inquiry: "never" };
export const patch: ContactUpdateParams = { owner_user_id: null, gbraid: "example-click" };

// @ts-expect-error A submission must have a stable event id.
export const missingEventId: ContactAcquisition = { landing_url: "https://example.com/signup" };
// @ts-expect-error PATCH rejects acquisition events.
export const patchAcquisition: ContactUpdateParams = { acquisition };
// @ts-expect-error PATCH rejects inquiry controls.
export const patchInquiry: ContactUpdateParams = { inquiry: "always" };

// ── Events + acquisitions (OFEAT-218 phases 1–4) ──
import type {
  Acquisition,
  AttendanceCreateParams,
  Contact,
  OtokEventUpsertParams,
} from "../src";

export const eventUpsert: OtokEventUpsertParams = {
  name: "Autumn webinar",
  external_id: "autumn-2026",
  status: "scheduled",
};
export const registerByContact: AttendanceCreateParams = { contact_id: "c-1" };
export const registerInline: AttendanceCreateParams = {
  contact: { email: "jane@example.com" },
  status: "cancelled", // accepted on WRITES as an alias for unregistered
  zoom_registration: "skip",
  join_url: "https://zoom.test/j/1",
  acquisition: { event_id: "webinar-signup-8891" },
};

// The touch blocks are optional (absent without the attribution feature) and
// nullable (present, but the contact has no touch).
export function readTouch(contact: Contact): Acquisition | null | undefined {
  return contact.first_touch;
}

// @ts-expect-error An event must be named.
export const namelessEvent: OtokEventUpsertParams = { external_id: "autumn-2026" };
// @ts-expect-error external_provider is Zoom's join key, never writable.
export const providerClaim: OtokEventUpsertParams = { name: "X", external_provider: "zoom" };
export const stampedLink: AttendanceCreateParams = {
  contact_id: "c-1",
  acquisition: {
    event_id: "e",
    // @ts-expect-error A registration's acquisition link is stamped by the server.
    attendance_id: "att-1",
  },
};
