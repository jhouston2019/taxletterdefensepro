const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");
const { wrapHandler, trackError } = require("./_error-tracking.js");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const corsHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function clientErrorMessage(err) {
  if (!err) return "Unknown error";
  if (err.type && err.message) return err.message;
  return err.message || String(err);
}

const mainHandler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Method not allowed", details: "Use POST" }),
    };
  }

  try {
    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      body = {};
    }

    const rawAuth = event.headers?.authorization || event.headers?.Authorization || "";
    const token = rawAuth.replace(/^Bearer\s+/i, "").trim();
    let userId = null;
    if (token) {
      const { data: authData } = await supabaseAdmin.auth.getUser(token);
      if (authData?.user?.id) {
        userId = authData.user.id;
      }
    }

    const jobIdRaw = (body?.job_id || body?.jobId || "").trim();
    const jobId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobIdRaw)
      ? jobIdRaw
      : "";

    const priceId = (process.env.STRIPE_PRICE_RESPONSE || "").trim();

    if (!process.env.SITE_URL) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({
          error: "SITE_URL is not configured",
          details:
            "Set SITE_URL in Netlify (e.g. https://taxletterdefensepro.com)",
        }),
      };
    }
    if (!process.env.STRIPE_SECRET_KEY) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Stripe is not configured" }),
      };
    }
    if (!jobId && !priceId) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({
          error: "STRIPE_PRICE_RESPONSE is required for catalog checkout",
        }),
      };
    }

    if (jobId) {
      const { data: job, error: jobErr } = await supabaseAdmin
        .from("tax_letter_jobs")
        .select("id, user_id")
        .eq("id", jobId)
        .maybeSingle();

      if (jobErr || !job) {
        return {
          statusCode: 404,
          headers: corsHeaders,
          body: JSON.stringify({ error: "Job not found" }),
        };
      }
      if (job.user_id != null && String(job.user_id) !== String(userId || "")) {
        return {
          statusCode: 403,
          headers: corsHeaders,
          body: JSON.stringify({ error: "Forbidden" }),
        };
      }
    }

    if (!priceId) {
      console.error("Missing STRIPE_PRICE_RESPONSE");
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({
          error: "Stripe price configuration missing",
        }),
      };
    }

    const lineItems = [
      {
        price: priceId,
        quantity: 1,
      },
    ];

    const siteUrl = (process.env.SITE_URL || "https://yourdomain.com").replace(/\/$/, "");
    const cancelUrl = jobId ? `${siteUrl}/preview/${jobId}` : `${siteUrl}/pricing`;

    let customerEmail;
    if (userId) {
      try {
        const { data: userData } = await supabaseAdmin.auth.admin.getUserById(userId);
        customerEmail = userData?.user?.email;
      } catch (_) {
        /* ignore */
      }
    }

    const sessionParams = {
      payment_method_types: ["card"],
      mode: "payment",
      line_items: lineItems,
      customer_creation: "always",
      metadata: {
        plan_type: body?.plan || "single",
        ...(jobId && { job_id: jobId }),
        ...(userId && { user_id: String(userId) }),
      },
      success_url: `${siteUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,
    };
    if (customerEmail) {
      sessionParams.customer_email = customerEmail;
    }

    console.log("STRIPE SECRET KEY PREFIX:", process.env.STRIPE_SECRET_KEY?.slice(0, 8));
    console.log("STRIPE PRICE RESPONSE:", process.env.STRIPE_PRICE_RESPONSE);
    console.log("PRICE ID TYPE:", typeof priceId);
    console.log("PRICE ID VALUE:", JSON.stringify(priceId));
    console.log("JOB ID:", jobId);
    console.log("LINE ITEMS:", JSON.stringify(lineItems, null, 2));
    console.log("FINAL SESSION PARAMS:", JSON.stringify(sessionParams, null, 2));

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      payment_method_types: sessionParams.payment_method_types,
      customer_creation: sessionParams.customer_creation,
      metadata: sessionParams.metadata,
      success_url: sessionParams.success_url,
      cancel_url: sessionParams.cancel_url,
      ...(sessionParams.customer_email && { customer_email: sessionParams.customer_email }),
    });

    const keyIsTest = String(process.env.STRIPE_SECRET_KEY || "").startsWith("sk_test_");
    console.log("[create-checkout-session]", {
      livemode: session.livemode,
      keyIsTest,
      hasJob: !!jobId,
    });

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        url: session.url,
        livemode: session.livemode,
        stripe_secret_key_mode: keyIsTest ? "test" : "live",
      }),
    };
  } catch (err) {
    console.error(err);
    trackError(err, { functionName: "create-checkout-session" });
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        message: err.message,
        type: err.type,
        code: err.code,
        raw: err.raw || null,
        stack: err.stack,
      }),
    };
  }
};

exports.handler = wrapHandler(mainHandler, "create-checkout-session");
