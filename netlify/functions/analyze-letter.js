let mammoth, Tesseract;

try {
  mammoth = require("mammoth");
  Tesseract = require("tesseract.js");
} catch (importError) {
  console.error("Import error:", importError);
}

const { createClient } = require("@supabase/supabase-js");
const Stripe = require("stripe");

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

async function findAuthUserIdByEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return null;

  let page = 1;
  const perPage = 200;
  while (page <= 10) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const match = (data?.users || []).find(
      (u) => String(u.email || "").trim().toLowerCase() === normalized
    );
    if (match?.id) return match.id;
    if (!data?.users?.length || data.users.length < perPage) break;
    page += 1;
  }
  return null;
}

async function resolveJobUserId({ userId, userEmail }) {
  if (userId) return userId;

  const email = String(userEmail || "").trim();
  if (!email) return null;

  const existingId = await findAuthUserIdByEmail(email);
  if (existingId) return existingId;

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { source: "wizard_guest_analyze" },
  });

  if (data?.user?.id) return data.user.id;

  if (error && /already|exists|registered|duplicate/i.test(String(error.message || ""))) {
    return findAuthUserIdByEmail(email);
  }

  if (error) throw error;
  return null;
}

function sanitizeForPostgresText(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\u0000/g, "");
}

function sanitizeJsonValue(value) {
  if (value == null) return value;
  try {
    return JSON.parse(
      JSON.stringify(value, (_, v) =>
        typeof v === "string" ? sanitizeForPostgresText(v) : v
      )
    );
  } catch {
    return value;
  }
}

function isRetriableInsertError(error) {
  if (error?.code === "23502") return false;
  const msg = String(error?.message || error?.details || error?.hint || "");
  return /column|schema cache|does not exist|row-level security|42703|PGRST204/i.test(msg);
}

async function insertTaxLetterJob(supabase, fullRow) {
  const withoutExtended = { ...fullRow };
  delete withoutExtended.strategy_json;
  delete withoutExtended.wizard_json;
  delete withoutExtended.hard_stop;

  const minimalRow = {
    user_id: fullRow.user_id ?? null,
    email: fullRow.email ?? null,
    analysis_json: fullRow.analysis_json,
    inputs_json: fullRow.inputs_json ?? null,
    letter_full: fullRow.letter_full,
    preview_text: fullRow.preview_text,
    paid: fullRow.paid ?? false,
    is_unlocked: fullRow.is_unlocked ?? false,
  };

  let lastError = null;
  for (const attemptRow of [fullRow, withoutExtended, minimalRow]) {
    const { data, error } = await supabase
      .from("tax_letter_jobs")
      .insert(attemptRow)
      .select("id, created_at")
      .single();

    if (!error) {
      return data.id;
    }

    lastError = error;
    console.error("[analyze-letter] insert attempt failed:", {
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code,
    });

    if (!isRetriableInsertError(error)) {
      throw error;
    }
  }

  throw lastError || new Error("All insert attempts failed");
}

function buildAnalysisJsonFromIntelligence(letterText, analysisResult) {
  const c = analysisResult.classification || {};
  const fin = analysisResult.financialInfo || {};
  const help = analysisResult.professionalHelpAssessment || {};
  const meta = analysisResult.metadata || {};

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
    requires_professional_help: !!(help.recommendProfessional || meta.requiresProfessionalHelp),
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

    let letterText = sanitizeForPostgresText(text || "");

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

    const hardStop = !!(
      analysisJson.requires_professional_help ||
      analysisResult.professionalHelpAssessment?.recommendProfessional ||
      analysisResult.metadata?.requiresProfessionalHelp
    );

    const { letterFull, previewText } = await generateFullJob({
      noticeText: letterText,
      analysisJson,
      strategyJson,
      wizardJson,
    });

    const safeLetterFull = sanitizeForPostgresText(letterFull);
    const safePreviewText = sanitizeForPostgresText(previewText);
    const storedAnalysisJson = sanitizeJsonValue({
      ...analysisJson,
      analysisOutput: analysisResult.analysisOutput || analysisJson.analysisOutput,
    });
    const safeStrategyJson = sanitizeJsonValue(strategyJson);
    const safeWizardJson = sanitizeJsonValue(wizardJson);

    const isValidUUID =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const jobIdFromBody = String(
      parsedBody.job_id || parsedBody.jobId || ""
    ).trim();
    const requestedJobId = isValidUUID.test(jobIdFromBody) ? jobIdFromBody : null;

    const jobUserId = await resolveJobUserId({ userId, userEmail });
    console.log("[analyze-letter] job user", {
      guestAnalyze,
      authUserId: userId || null,
      jobUserId: jobUserId || null,
      userEmail: userEmail || null,
    });

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
                letter_full: safeLetterFull,
                preview_text: safePreviewText,
                analysis_json: storedAnalysisJson,
                strategy_json: safeStrategyJson,
                wizard_json: safeWizardJson,
                hard_stop: hardStop,
              })
              .eq("id", requestedJobId);

            if (updateError) throw updateError;
            recordId = requestedJobId;
            updatedExisting = true;
            console.log("Record updated:", recordId);
          }
        }

        if (!updatedExisting) {
          recordId = await insertTaxLetterJob(supabase, {
            user_id: jobUserId,
            email: userEmail || null,
            analysis_json: storedAnalysisJson,
            strategy_json: safeStrategyJson,
            wizard_json: safeWizardJson,
            inputs_json: {
              source: "analyze-letter",
              guest: guestAnalyze,
              has_file_url: !!fileUrl,
              has_image_url: !!imageUrl,
              text_length: letterText.length,
            },
            letter_full: safeLetterFull,
            preview_text: safePreviewText,
            paid: !!skip_payment,
            is_unlocked: !!skip_payment,
            hard_stop: hardStop,
          });
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
          body: JSON.stringify({
            error: "Could not save your session. Please try again.",
            details: dbError.message || String(dbError),
            code: dbError.code || null,
          }),
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
        preview_excerpt: safePreviewText,
        hard_stop: hardStop,
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
