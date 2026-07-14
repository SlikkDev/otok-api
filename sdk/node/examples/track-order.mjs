/**
 * Track a store order in oToK: upsert the customer as a contact, create an
 * idempotent deal keyed by the order id, and send a receipt email once.
 *
 * Run (after `npm run build` in sdk/node):
 *   OTOK_API_KEY=otok_live_… OTOK_BASE_URL=https://your-otok-host/api node examples/track-order.mjs
 */
import { OtokClient } from "../dist/index.js";

const otok = new OtokClient({
  apiKey: process.env.OTOK_API_KEY,
  baseUrl: process.env.OTOK_BASE_URL, // e.g. https://your-otok-host/api
});

const order = {
  orderId: "A-1001",
  customer: {
    email: "jane@example.com",
    phone: "+12025551234",
    firstName: "Jane",
    lastName: "Doe",
    tags: ["Customer"],
    address: { city: "Tel Aviv", country: "IL" },
  },
  total: 249.9,
  currency: "USD",
  note: "2 items: SKU-1 ×1, SKU-9 ×1",
  receipt: {
    subject: "Your order A-1001 is confirmed",
    html: "<h1>Thanks, Jane!</h1><p>Order A-1001 — total $249.90.</p>",
    text: "Thanks, Jane! Order A-1001 — total $249.90.",
  },
};

// Safe to re-run: the contact upserts, the deal is keyed by
// external_reference "order:A-1001", and the receipt's idempotency key
// guarantees at most one email per order.
const { contact, deal, receipt } = await otok.commerce.trackOrder(order);

console.log("contact:", contact.id, contact.email);
console.log("deal:", deal.id, deal.status, deal.external_reference);
console.log("receipt:", receipt?.id, receipt?.status, "duplicate:", receipt?.duplicate);

// When the order is paid/fulfilled, close the deal:
// await otok.deals.setStatus(deal.id, { status: "won" });
