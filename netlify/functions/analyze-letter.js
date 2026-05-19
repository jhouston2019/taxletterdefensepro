let mammoth, Tesseract;

try {
  mammoth = require("mammoth");
  Tesseract = require("tesseract.js");
} catch (importError) {
  console.error("Import error:", importError);
}

const { createClient } = require("@supabase/supabase-js");
const Stripe = require("stripe");
const { randomUUID } = require("crypto");

const { wrapHandler, trackError } = require("./_error-tracking.js");
const { getSupabaseAdmin } = require("./_supabase.js");
const { generateFullJob } = require("./generate-full-job.js");
const { analyzeIRSLetter } = require("./irs-intelligence/index.js");
const { getBillingSnapshot } = require("./_billing-snapshot.js");

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

async function resolveAnalyzeAuth(event, body) {
  const token = (event.headers.authorization || event.headers.Authorization || "")
    .replace(/^Bearer\s+/i, "")
    .trim();

  if (!token || token === "bypass") {
    return { guestAnalyze: true, userId: null };
  }

  try {
    const {
      data: { user },
      error,
    } = await supabaseAdmin.auth.getUser(token);
    if (error || !user) return { guestAnalyze: true, userId: null };
    return { guestAnalyze: false, userId: user.id };
  } catch {
    return { guestAnalyze: true, userId: null };
  }
}

async function subscriptionGrantsSkipPayment(userId) {
  if (!userId) return false;
  try {
    const supabase = getSupabaseAdmin();
    const snap = await getBillingSnapshot(supabase, userId);
    if (!snap.active) return false;
    const rem = snap.usage.remaining;
    return rem === null || (typeof rem === "number" && rem > 0);
  } catch {
    return false;
  }
}

async function paidStripeSessionGrantsSkipPayment(userId, usageSessionId) {
  if (!usageSessionId || !userId || !stripe) return false;
  try {
    const sess = await stripe.checkout.sessions.retrieve(String(usageSessionId));
    if (sess.payment_status !== "paid") return false;
    if (String(sess.metadata?.user_id || "") !== String(userId)) return false;
    return true;
  } catch {
    return false;
  }
}

/** Production DB requires user_id NOT NULL; guests may omit email on step 2. */
async function resolveJobUserId(userId, email) {
  if (userId) return userId;

  const normalized = String(email || "").trim().toLowerCase();
  if (normalized) {
    const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email: normalized,
      email_confirm: true,
      user_metadata: { source: "wizard_analyze" },
    });
    if (created?.user?.id) return created.user.id;

    if (createError && /already|exists|registered|duplicate/i.test(String(createError.message || ""))) {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (error) throw error;
      const existing = (data?.users || []).find(
        (u) => String(u.email || "").trim().toLowerCase() === normalized
      );
      if (existing?.id) return existing.id;
    }

    if (createError) throw createError;
  }

  const { data: guest, error: guestError } = await supabaseAdmin.auth.admin.createUser({
    email: `guest+${randomUUID()}@guest.taxletterdefensepro.com`,
    email_confirm: true,
    user_metadata: { source: "wizard_guest_analyze", guest: true },
  });
  if (guest?.user?.id) return guest.user.id;
  if (guestError) throw guestError;
  return null;
}

function buildAnalysisJsonFromIntelligence(letterText, analysisResult) {
  const c = analysisResult.classification || {};
  const fin = analysisResult.financialInfo || {};

  const noticeType = c.noticeType || "IRS Notice";
  const primary =
    c.description || c.category || "Notice review and response";

  const summaryLine = `${noticeType} — ${primary}`.trim();

  return {
    notice_type: noticeType,
    notice_number: c.noticeNumber || c.formCode || "",
    primary_issue: primary,
    tax_year: c.taxYear || fin.taxYear || "",
    irs_amount: fin.balanceDue ?? fin.largestAmount ?? "",
    summary: summaryLine,
    analysis_summary: summaryLine,
    analysisOutput: analysisResult.analysisOutput || null,
    intelligence: {
      classification: c,
      financialInfo: fin,
      deadlineIntelligence: analysisResult.deadlineIntelligence,
    },
  };
}

const mainHandler = async (event) => {
  console.log("=== ANALYZE LETTER (single pipeline) ===");

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
      body: "",
    };
  }

  let parsedBody = {};
  try {
    parsedBody = JSON.parse(event.body || "{}");
  } catch {
    return {
      statusCode: 400,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Invalid JSON body" }),
    };
  }

  const { guestAnalyze, userId } = await resolveAnalyzeAuth(event, parsedBody);
  const usageSessionId =
    parsedBody.usageSessionId || parsedBody.usage_session_id || null;

  try {
    const {
      text,
      fileUrl,
      imageUrl,
      userEmail = null,
      strategyJson: bodyStrategy = null,
      wizardJson: bodyWizard = null,
      userInfo = null,
    } = parsedBody;

    let skip_payment = false;
    if (!guestAnalyze && userId) {
      skip_payment =
        (await subscriptionGrantsSkipPayment(userId)) ||
        (await paidStripeSessionGrantsSkipPayment(userId, usageSessionId));
    }

    let letterText = String(text || "").replace(/\u0000/g, "");

    if (fileUrl) {
      try {
        if (fileUrl.startsWith("data:")) {
          const base64Data = fileUrl.split(",")[1];
          const buffer = Buffer.from(base64Data, "base64");

          if (fileUrl.includes("application/pdf")) {
            console.log("PDF data URL: skipping server-side PDF parse; use extract-text or pasted text.");
          } else if (
            fileUrl.includes("application/vnd.openxmlformats") ||
            fileUrl.includes("application/msword")
          ) {
            if (!mammoth) {
              letterText += "\n\n[Word document uploaded but processing not available - please paste text manually]";
            } else {
              const { value } = await mammoth.extractRawText({ buffer });
              letterText += "\n\n" + value;
            }
          }
        } else {
          const fileResponse = await globalThis.fetch(fileUrl);
          if (!fileResponse.ok) {
            throw new Error(`Failed to fetch file: ${fileResponse.statusText}`);
          }
          const fileBuffer = await fileResponse.arrayBuffer();
          const uint8 = new Uint8Array(fileBuffer);

          if (fileUrl.endsWith(".pdf")) {
            console.log("PDF URL: skipping server-side PDF parse; use pasted text.");
          } else if (fileUrl.endsWith(".doc") || fileUrl.endsWith(".docx")) {
            if (!mammoth) {
              letterText += "\n\n[Word document uploaded but processing not available - please paste text manually]";
            } else {
              const { value } = await mammoth.extractRawText({ buffer: Buffer.from(uint8) });
              letterText += "\n\n" + value;
            }
          }
        }
      } catch (fileError) {
        console.error("File processing error:", fileError);
        letterText += "\n\n[File processing error - using text from request body if any]";
      }
    }

    if (imageUrl) {
      try {
        if (!Tesseract) {
          letterText += "\n\n[Image uploaded but OCR processing not available - please paste text manually]";
        } else {
          const {
            data: { text: extractedText },
          } = await Tesseract.recognize(imageUrl, "eng");
          letterText += "\n\n" + extractedText;
        }
      } catch (imageError) {
        console.error("Image processing error:", imageError);
        letterText += "\n\n[Image processing error - please paste text manually]";
      }
    }

    if (!letterText.trim()) {
      return {
        statusCode: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ error: "No text provided or extracted from files." }),
      };
    }

    const analysisResult = await analyzeIRSLetter(letterText, { userContext: {} });
    const analysisJson = buildAnalysisJsonFromIntelligence(letterText, analysisResult);

    const strategyJson = bodyStrategy || {
      tone: "professional and firm",
      approach: "dispute with supporting documentation",
      strategy: "dispute with supporting documentation",
    };

    const wizardJson = bodyWizard || (userInfo ? mapUserInfoToWizard(userInfo) : {});

    const { letterFull, previewText } = await generateFullJob({
      noticeText: letterText,
      analysisJson,
      strategyJson,
      wizardJson,
    });

    const storedAnalysisJson = {
      ...analysisJson,
      analysisOutput: analysisResult.analysisOutput || analysisJson.analysisOutput,
    };

    const isValidUUID =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const jobIdFromBody = String(
      parsedBody.job_id || parsedBody.jobId || ""
    ).trim();
    const requestedJobId = isValidUUID.test(jobIdFromBody) ? jobIdFromBody : null;

    const jobEmail = userEmail || bodyWizard?.email || null;
    const jobUserId = await resolveJobUserId(userId, jobEmail);

    let recordId = null;
    if (getSupabaseAdmin) {
      try {
        const supabase = getSupabaseAdmin();
        let updatedExisting = false;

        if (requestedJobId) {
          const { data: existing, error: lookupError } = await supabaseAdmin
            .from("tax_letter_jobs")
            .select("id")
            .eq("id", requestedJobId)
            .maybeSingle();

          if (lookupError) throw lookupError;

          if (existing?.id) {
            const { error: updateError } = await supabaseAdmin
              .from("tax_letter_jobs")
              .update({
                letter_full: letterFull,
                preview_text: previewText,
                analysis_json: storedAnalysisJson,
                strategy_json: strategyJson,
                wizard_json: wizardJson,
              })
              .eq("id", requestedJobId);

            if (updateError) throw updateError;
            recordId = requestedJobId;
            updatedExisting = true;
            console.log("Record updated:", recordId);
          }
        }

        if (!updatedExisting) {
          const row = {
            user_id: jobUserId,
            email: jobEmail || null,
            analysis_json: storedAnalysisJson,
            strategy_json: strategyJson,
            wizard_json: wizardJson,
            inputs_json: {
              source: "analyze-letter",
              guest: guestAnalyze,
              has_file_url: !!fileUrl,
              has_image_url: !!imageUrl,
              text_length: letterText.length,
            },
            letter_full: letterFull,
            preview_text: previewText,
            paid: !!skip_payment,
            is_unlocked: !!skip_payment,
          };

          let { data: insertData, error: insertError } = await supabase
            .from("tax_letter_jobs")
            .insert(row)
            .select("id, created_at")
            .single();

          if (
            insertError &&
            /strategy_json|wizard_json|column/i.test(
              String(insertError.message || insertError.details || "")
            )
          ) {
            delete row.strategy_json;
            delete row.wizard_json;
            ({ data: insertData, error: insertError } = await supabase
              .from("tax_letter_jobs")
              .insert(row)
              .select("id, created_at")
              .single());
          }

          if (insertError) throw insertError;
          recordId = insertData.id;
          console.log("Record saved:", recordId);
        }
      } catch (dbError) {
        console.error("Database error:", dbError);
        trackError(dbError, { functionName: "analyze-letter", phase: "db_insert" });
        return {
          statusCode: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
          body: JSON.stringify({ error: "Could not save your session. Please try again." }),
        };
      }
    } else {
      return {
        statusCode: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ error: "Database not configured" }),
      };
    }

    const redirectUrl = skip_payment
      ? `/result/${recordId}`
      : `/preview/${recordId}`;

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
      body: JSON.stringify({
        job_id: recordId,
        recordId,
        redirect_url: redirectUrl,
        preview_excerpt: previewText,
        guest_analyze: guestAnalyze,
        skip_payment: !!skip_payment,
      }),
    };
  } catch (err) {
    console.error("[analyze-letter] handler error:", err && err.message, err && err.stack);
    trackError(err, {
      functionName: "analyze-letter",
    });
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        error: err.message || "Analysis failed",
      }),
    };
  }
};

function mapUserInfoToWizard(userInfo) {
  if (!userInfo || typeof userInfo !== "object") return {};
  return {
    taxpayerName: userInfo.name,
    full_name: userInfo.name,
    address: [userInfo.address, userInfo.city].filter(Boolean).join(", "),
    ssnLast4: (userInfo.ssn || "").replace(/\D/g, "").slice(-4) || undefined,
  };
}

exports.handler = wrapHandler(mainHandler, "analyze-letter");
