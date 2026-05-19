const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");
const { wrapHandler, trackError } = require("./_error-tracking.js");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ok = () => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: "ok" });

const mainHandler = async (event) => {
  if (process.env.BYPASS_PAYMENT === "true") {
    return ok();
  }

  try {
    const sig = event.headers["stripe-signature"];
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64")
      : Buffer.from(event.body || "");
    let stripeEvent;

    try {
      stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch {
      return ok();
    }

    if (stripeEvent.type === "checkout.session.completed") {
      const stripeSession = stripeEvent.data.object;
      const jobId = stripeSession.metadata?.job_id;
      const userId = stripeSession.metadata?.user_id;
      const stripeSessionId = stripeSession.id;
      const customerEmail =
        stripeSession.customer_details?.email || stripeSession.customer_email;

      console.log("Webhook: checkout.session.completed", {
        jobId,
        userId,
        stripeSessionId,
        customerEmail,
      });

      if (!stripeSession.metadata?.job_id) {
        console.warn(
          "Stripe webhook: payment received with no job_id in metadata. Pricing page direct-buy path may still be active."
        );
        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ received: true }),
        };
      }

      if (jobId) {
        const updatePayload = {
          paid: true,
          is_unlocked: true,
          stripe_session_id: stripeSessionId,
        };
        if (userId) {
          updatePayload.user_id = userId;
        }

        const { error: updateError } = await supabaseAdmin
          .from("tax_letter_jobs")
          .update(updatePayload)
          .eq("id", jobId);

        if (updateError) {
          console.error("Webhook: FAILED to unlock job", jobId, updateError.message);
        } else {
          console.log("Webhook: successfully unlocked job", jobId);
        }
      }

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ received: true }),
      };
    }

    return ok();
  } catch (e) {
    trackError(e, { functionName: "stripe-webhook" });
    return ok();
  }
};

exports.handler = wrapHandler(mainHandler, "stripe-webhook");
