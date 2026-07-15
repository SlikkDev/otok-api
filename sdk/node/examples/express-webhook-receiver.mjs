/**
 * Verified oToK webhook receiver (Express).
 *
 * Setup:
 *   1. npm install express          (example-only dependency)
 *   2. Register the endpoint once and save the whsec_… secret. Omitting
 *      `events` subscribes to the three delivery events (email.delivered,
 *      email.bounced, email.complained); add email.opened / email.clicked
 *      explicitly to also receive the engagement events handled below:
 *        const ep = await otok.webhookEndpoints.create({ url: "https://your-server.example.com/otok-events" });
 *        console.log(ep.secret);    // shown only once
 *   3. OTOK_WEBHOOK_SECRET=whsec_… node examples/express-webhook-receiver.mjs
 *
 * oToK signs every delivery with `X-Otok-Signature: t=<unix>,v1=<hex>` and
 * retries failed deliveries for ≈16 hours — answer 2xx once processed, and
 * dedupe on event.id (retries reuse the same id).
 */
import express from "express";
import { constructEvent, OtokWebhookVerificationError } from "../dist/index.js";

const app = express();
const secret = process.env.OTOK_WEBHOOK_SECRET;

app.post(
  "/otok-events",
  // Signature verification needs the RAW body — do not use express.json() here.
  express.raw({ type: "application/json" }),
  (req, res) => {
    let event;
    try {
      event = constructEvent(req.body, req.header("x-otok-signature"), secret);
    } catch (err) {
      if (err instanceof OtokWebhookVerificationError) {
        return res.status(400).send("bad signature");
      }
      throw err;
    }

    switch (event.type) {
      case "email.delivered":
        console.log(`delivered → ${event.data.to} (send ${event.data.send_id})`);
        break;
      case "email.bounced":
        console.log(`bounced (${event.data.bounce_type ?? "?"}) → ${event.data.to}: ${event.data.reason ?? ""}`);
        // e.g. stop emailing this address in your own store DB
        break;
      case "email.complained":
        console.log(`complaint → ${event.data.to}`);
        break;
      // No "email.failed" case: that event type is deprecated and never
      // delivered — a failing POST /v1/emails fails synchronously on the
      // request itself.
      case "email.opened":
        console.log(`opened → ${event.data.to} (machine_open: ${event.data.machine_open})`);
        break;
      case "email.clicked":
        console.log(`clicked → ${event.data.url}`);
        break;
    }

    // `metadata` echoes what you passed to POST /v1/emails (e.g. order ids).
    if (event.data.metadata) console.log("metadata:", event.data.metadata);

    res.status(200).send("ok");
  },
);

app.listen(3030, () => console.log("listening on :3030 (POST /otok-events)"));
