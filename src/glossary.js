const { supabase } = require("./db");
const { analyzeMessage } = require("./messageAnalyzer");

const MESSAGE_TERM_EXAMPLE_LIMIT = 5;
const SUGGESTION_MIN_COUNT = 20;

function getJsonLanguageValues(value, language) {
  if (!value || typeof value !== "object") return [];
  const direct = value[language];
  const fallback = language === "zh-TW" ? value.zh : null;
  const values = [];

  for (const item of [direct, fallback]) {
    if (Array.isArray(item)) values.push(...item);
    else if (item) values.push(item);
  }

  return values.map((item) => String(item || "").trim()).filter(Boolean);
}

async function matchGlossaryTerms(text, language = "und", limit = 10) {
  const source = String(text || "").trim().toLowerCase();
  if (!source) return [];

  const { data, error } = await supabase
    .from("glossary_terms")
    .select("id, concept_id, terms, aliases, domain, status, risk_level, requires_disclaimer")
    .eq("status", "active")
    .limit(200);

  if (error) {
    console.warn("Load glossary terms failed:", {
      error: error.message,
      time: new Date().toISOString(),
    });
    return [];
  }

  const matches = [];
  for (const term of data || []) {
    const values = [
      ...getJsonLanguageValues(term.terms, language),
      ...getJsonLanguageValues(term.aliases, language),
    ];

    if (values.some((value) => source.includes(value.toLowerCase()))) {
      matches.push(term);
      if (matches.length >= limit) break;
    }
  }

  return matches;
}

async function recordCandidateTerm(candidate, language, domains, example) {
  const { data, error } = await supabase.rpc("record_message_term", {
    p_text: candidate.text,
    p_normalized_text: candidate.normalizedText,
    p_language: language || "und",
    p_domains: domains || ["general"],
    p_example: example,
    p_example_limit: MESSAGE_TERM_EXAMPLE_LIMIT,
  });

  if (error) {
    console.warn("Record message term failed:", {
      error: error.message,
      candidate: candidate.normalizedText,
      time: new Date().toISOString(),
    });
    return null;
  }

  const row = Array.isArray(data) ? data[0] : null;
  if (!row?.id || row.status !== "candidate" || Number(row.count || 0) < SUGGESTION_MIN_COUNT) {
    return row;
  }

  const { error: suggestionError } = await supabase.rpc("create_term_suggestion_if_needed", {
    p_message_term_id: row.id,
    p_min_count: SUGGESTION_MIN_COUNT,
  });

  if (suggestionError) {
    console.warn("Create term suggestion failed:", {
      error: suggestionError.message,
      messageTermId: row.id,
      time: new Date().toISOString(),
    });
  }

  return row;
}

async function recordMessageAnalysis({ text, language, sourceType, conversationId }) {
  const analysis = analyzeMessage(text, language);
  if (!analysis.candidates.length) return { ...analysis, matches: [] };

  const matches = await matchGlossaryTerms(text, language);
  const example = String(text || "").slice(0, 500);

  await Promise.all(
    analysis.candidates.map((candidate) =>
      recordCandidateTerm(candidate, language, analysis.domains, example)
    )
  );

  console.log("Glossary analysis recorded:", {
    language,
    sourceType,
    conversationId,
    candidateCount: analysis.candidates.length,
    matchedCount: matches.length,
    domains: analysis.domains,
    time: new Date().toISOString(),
  });

  return {
    ...analysis,
    matches,
  };
}

module.exports = {
  matchGlossaryTerms,
  recordMessageAnalysis,
};
