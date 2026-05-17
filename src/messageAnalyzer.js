const DOMAIN_KEYWORDS = {
  boi: [
    "boi",
    "投资促进",
    "促进投资",
    "บีโอไอ",
    "ส่งเสริมการลงทุน",
  ],
  tax: [
    "tax",
    "vat",
    "wht",
    "withholding",
    "税",
    "增值税",
    "预扣税",
    "扣缴",
    "发票",
    "ภาษี",
    "vat",
    "หัก ณ ที่จ่าย",
  ],
  import: [
    "import",
    "customs",
    "duty",
    "进口",
    "清关",
    "关税",
    "机器设备",
    "นำเข้า",
    "ศุลกากร",
    "อากร",
  ],
  accounting: [
    "accounting",
    "invoice",
    "audit",
    "财务",
    "会计",
    "审计",
    "账",
    "บัญชี",
    "ใบกำกับภาษี",
  ],
  legal: [
    "contract",
    "law",
    "legal",
    "合同",
    "法律",
    "法规",
    "合规",
    "สัญญา",
    "กฎหมาย",
  ],
  production: [
    "production",
    "factory",
    "quality",
    "生产",
    "工厂",
    "品质",
    "设备",
    "ผลิต",
    "โรงงาน",
  ],
};

const STOPWORDS = new Set([
  "请问",
  "可以",
  "是否",
  "怎么",
  "如何",
  "这个",
  "那个",
  "公司",
  "一下",
  "hello",
  "thanks",
  "thank",
  "please",
]);

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[，。！？、；：“”‘’（）【】《》]/g, " ")
    .replace(/[,.!?;:"'()[\]{}<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTerm(value) {
  return normalizeText(value).replace(/\s+/g, "");
}

function detectDomains(text) {
  const normalized = normalizeText(text);
  const domains = [];

  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    if (keywords.some((keyword) => normalized.includes(keyword.toLowerCase()))) {
      domains.push(domain);
    }
  }

  return domains.length > 0 ? domains : ["general"];
}

function shouldKeepCandidate(term) {
  const text = String(term || "").trim();
  const normalized = normalizeTerm(text);

  if (!normalized) return false;
  if (normalized.length < 2) return false;
  if (normalized.length > 40) return false;
  if (/^\d+$/.test(normalized)) return false;
  if (STOPWORDS.has(normalized)) return false;
  if (/^[^\p{L}\p{N}]+$/u.test(normalized)) return false;

  return true;
}

function dedupeTerms(terms) {
  const seen = new Set();
  const result = [];

  for (const term of terms) {
    const text = String(term || "").trim();
    const key = normalizeTerm(text);
    if (!shouldKeepCandidate(text) || seen.has(key)) continue;
    seen.add(key);
    result.push({
      text,
      normalizedText: key,
    });
  }

  return result.slice(0, 8);
}

function extractChineseCandidates(text) {
  const candidates = [];
  const mixedRe = /(?:[A-Za-z]{2,}[A-Za-z0-9-]*\s*)?[\u4E00-\u9FFF]{2,12}(?:\s*[A-Za-z0-9-]{2,})?/g;
  const chunks = String(text || "").match(mixedRe) || [];

  for (const chunk of chunks) {
    candidates.push(chunk);
    const compact = chunk.replace(/\s+/g, "");
    const subChunks = compact.match(/[\u4E00-\u9FFF]{2,8}/g) || [];
    candidates.push(...subChunks);
  }

  const acronyms = String(text || "").match(/\b[A-Z][A-Z0-9]{1,8}\b/g) || [];
  candidates.push(...acronyms);
  return candidates;
}

function extractThaiCandidates(text) {
  const candidates = String(text || "").match(/[\u0E00-\u0E7F]{3,30}/g) || [];
  const acronyms = String(text || "").match(/\b[A-Z][A-Z0-9]{1,8}\b/g) || [];
  return [...candidates, ...acronyms];
}

function extractEnglishCandidates(text) {
  const candidates = [];
  const acronyms = String(text || "").match(/\b[A-Z][A-Z0-9]{1,8}\b/g) || [];
  candidates.push(...acronyms);

  const phraseRe = /\b[A-Za-z][A-Za-z-]+(?:\s+[A-Za-z][A-Za-z-]+){1,3}\b/g;
  const phrases = String(text || "").match(phraseRe) || [];
  candidates.push(...phrases);
  return candidates;
}

function extractCandidateTerms(text, language = "und") {
  const source = String(text || "").trim();
  if (!source) return [];

  const candidates = [];
  if (language === "zh" || language === "zh-TW" || /[\u4E00-\u9FFF]/.test(source)) {
    candidates.push(...extractChineseCandidates(source));
  }

  if (language === "th" || /[\u0E00-\u0E7F]/.test(source)) {
    candidates.push(...extractThaiCandidates(source));
  }

  if (language === "en" || /[A-Za-z]/.test(source)) {
    candidates.push(...extractEnglishCandidates(source));
  }

  return dedupeTerms(candidates);
}

function analyzeMessage(text, language = "und") {
  return {
    normalizedText: normalizeText(text),
    domains: detectDomains(text),
    candidates: extractCandidateTerms(text, language),
  };
}

module.exports = {
  analyzeMessage,
  detectDomains,
  extractCandidateTerms,
  normalizeTerm,
  normalizeText,
};
