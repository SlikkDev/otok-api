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
