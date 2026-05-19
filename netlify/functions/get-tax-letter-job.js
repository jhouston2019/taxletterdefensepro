const { createClient } = require("@supabase/supabase-js");

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  const jobId =
    event.queryStringParameters?.job_id ||
    (event.body ? JSON.parse(event.body).job_id : null);

  if (!jobId) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "job_id is required" }),
    };
  }

  const { data: job, error } = await supabaseAdmin
    .from("tax_letter_jobs")
    .select(
      "id, created_at, user_id, analysis_json, strategy_json, wizard_json, " +
        "letter_full, preview_text, paid, is_unlocked, stripe_session_id"
    )
    .eq("id", jobId)
    .single();

  if (error || !job) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: "Job not found" }),
    };
  }

  // SECURITY: server enforces is_unlocked — never trust client
  const isUnlocked = job.is_unlocked === true;

  // Build analysis_summary from analysis_json for preview confidence signal
  let analysisSummary = null;
  if (job.analysis_json) {
    const a = job.analysis_json;
    analysisSummary =
      a.summary ||
      a.analysis_summary ||
      (a.notice_type ? `${a.notice_type} — ${a.primary_issue || ""}`.trim() : null) ||
      "IRS notice analyzed";
  }

  const analysisFull =
    job.analysis_json && typeof job.analysis_json.analysisOutput === "string"
      ? job.analysis_json.analysisOutput
      : analysisSummary;

  const responseBody = {
    success: true,
    job_id: job.id,
    analysis_summary: analysisSummary,
    analysis_full: analysisFull,
    analysis_json: job.analysis_json,
    strategy_json: job.strategy_json,
    preview_text: job.preview_text || null,
    paid: job.paid || false,
    is_unlocked: isUnlocked,
    unlocked: isUnlocked,
    locked: !isUnlocked,
    // Only return full letter if actually unlocked in DB
    letter_full: isUnlocked ? job.letter_full : null,
  };

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(responseBody),
  };
};
