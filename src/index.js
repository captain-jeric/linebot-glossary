// =========================
// linebot-Glossary
// USERID 授权版 · Supabase/PostgreSQL 持久化
// =========================

const express = require("express");
const line = require("@line/bot-sdk");
const crypto = require("crypto");
const { Translate } = require("@google-cloud/translate").v2;
const { supabase } = require("./db");
const { registerAdminGlossaryRoutes } = require("./adminGlossary");
const { recordMessageAnalysis } = require("./glossary");

const PORT = process.env.PORT || 8080;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const BOT_USER_ID = process.env.BOT_USER_ID || "";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const ADMIN_TAILSCALE_ONLY = process.env.ADMIN_TAILSCALE_ONLY === "true";
const ADMIN_ALLOWED_EMAILS = new Set(
  (process.env.ADMIN_ALLOWED_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const SESSION_SECRET = process.env.SESSION_SECRET || ADMIN_TOKEN || "";
const LOG_FULL_WEBHOOK_BODY = process.env.LOG_FULL_WEBHOOK_BODY === "true";
const MAX_LINE_TEXT_LENGTH = 4900;
const CACHE_MAX_SIZE = 200;
const BILLING_TIME_ZONE = "Asia/Bangkok";
const SYSTEM_DEFAULT_MODE = "bilingual";
const SYSTEM_DEFAULT_FROM_LANG = "zh";
const SYSTEM_DEFAULT_TO_LANG = "th";
const ADMIN_SESSION_COOKIE = "linebot_admin_session";
const ADMIN_OAUTH_STATE_COOKIE = "linebot_admin_oauth_state";
const ADMIN_SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;

const requiredEnvNames = [
  "LINE_CHANNEL_SECRET",
  "LINE_CHANNEL_ACCESS_TOKEN",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
];

for (const envName of requiredEnvNames) {
  if (!process.env[envName]) {
    throw new Error(`Missing required environment variable: ${envName}`);
  }
}

const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
});

function parseJsonEnv(name) {
  const value = process.env[name];
  if (!value) return null;

  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${name} is not valid JSON: ${error.message}`);
  }
}

function buildTranslateClientOptions() {
  const credentials =
    parseJsonEnv("GOOGLE_APPLICATION_CREDENTIALS_JSON") ||
    parseJsonEnv("GOOGLE_SERVICE_ACCOUNT_JSON");

  if (!credentials) return {};

  return {
    credentials,
    projectId: credentials.project_id,
  };
}

const translateClient = new Translate(buildTranslateClientOptions());

const THREE_LANGS = ["zh", "th", "my"];

const LANG_NAME = {
  zh: "中文",
  "zh-TW": "繁體中文",
  th: "ภาษาไทย",
  my: "မြန်မာဘာသာ",
  en: "English",
  ja: "日本語",
  de: "Deutsch",
  fr: "Français",
  es: "Español",
  ru: "Русский",
  ms: "Bahasa Melayu",
  ko: "한국어",
  id: "Bahasa Indonesia",
  vi: "Tiếng Việt",
  hi: "हिन्दी",
  ar: "العربية",
};

const LANG_FLAG = {
  zh: "🇨🇳",
  "zh-TW": "🇹🇼",
  th: "🇹🇭",
  my: "🇲🇲",
  en: "🇬🇧",
  ja: "🇯🇵",
  de: "🇩🇪",
  fr: "🇫🇷",
  es: "🇪🇸",
  ru: "🇷🇺",
  ms: "🇲🇾",
  ko: "🇰🇷",
  id: "🇮🇩",
  vi: "🇻🇳",
  hi: "🇮🇳",
  ar: "🇸🇦",
};

const LANG_SHORT_LABEL = {
  zh: "中/中文",
  "zh-TW": "繁/繁中",
  th: "泰/ไทย",
  my: "缅/မြန်မာ",
  en: "英/EN",
  ja: "日/日本語",
  de: "德/Deutsch",
  fr: "法/Français",
  es: "西/Español",
  ru: "俄/RU",
  ms: "马/MS",
  ko: "韩/KO",
  id: "印尼/ID",
  vi: "越/VI",
  hi: "印地/HI",
  ar: "阿/AR",
};

const TARGET_LANG_COMMANDS = {
  zh: "zh",
  cn: "zh",
  tw: "zh-TW",
  hk: "zh-TW",
  tc: "zh-TW",
  th: "th",
  mm: "my",
  my: "my",
  en: "en",
  jp: "ja",
  ja: "ja",
  de: "de",
  fr: "fr",
  es: "es",
  ru: "ru",
  ms: "ms",
  ko: "ko",
  kr: "ko",
  id: "id",
  in: "id",
  vi: "vi",
  vn: "vi",
  hi: "hi",
  ar: "ar",
};

const ADMIN_LANGUAGE_OPTIONS = [
  "zh",
  "zh-TW",
  "th",
  "my",
  "en",
  "ja",
  "ko",
  "ms",
  "id",
  "vi",
  "hi",
  "ar",
  "ru",
  "de",
  "fr",
  "es",
];

function getReplyLocaleFromLang(lang) {
  const normalized = normalizeCode(lang);
  if (normalized === "zh" || normalized === "zh-TW") return "zh";
  if (normalized === "th") return "th";
  if (normalized === "ja") return "ja";
  return "en";
}

function getReplyLocale(user) {
  if (!user) return "en";
  return getReplyLocaleFromLang(user.from_lang || SYSTEM_DEFAULT_FROM_LANG);
}

function getLocalizedConversationLabel(event, locale) {
  const sourceType = event.source?.type;
  const labels = {
    zh: { group: "群聊", room: "多人聊天室", user: "私聊", unknown: "未知来源" },
    en: { group: "Group chat", room: "Multi-person chat", user: "Private chat", unknown: "Unknown source" },
    th: { group: "กลุ่ม", room: "ห้องแชทหลายคน", user: "แชทส่วนตัว", unknown: "ไม่ทราบแหล่งที่มา" },
    ja: { group: "グループチャット", room: "複数人チャット", user: "個別チャット", unknown: "不明な送信元" },
  };
  return (labels[locale] || labels.en)[sourceType] || (labels[locale] || labels.en).unknown;
}

function getLocalizedStatusValue(user, locale) {
  if (isUserExpired(user)) {
    return {
      zh: "已过期",
      en: "Expired",
      th: "หมดอายุ",
      ja: "期限切れ",
    }[locale] || "Expired";
  }

  if (user?.status === "active") {
    return {
      zh: "active",
      en: "active",
      th: "ใช้งานได้",
      ja: "有効",
    }[locale] || "active";
  }

  if (user?.status === "paused") {
    return {
      zh: "paused",
      en: "paused",
      th: "ระงับ",
      ja: "一時停止",
    }[locale] || "paused";
  }

  return user?.status || "";
}

function getLocalizedModeName(mode, locale) {
  if (mode === "trilingual") {
    return {
      zh: "三语模式",
      en: "Trilingual mode",
      th: "โหมด 3 ภาษา",
      ja: "3言語モード",
    }[locale] || "Trilingual mode";
  }

  return {
    zh: "双语模式",
    en: "Bilingual mode",
    th: "โหมด 2 ภาษา",
    ja: "2言語モード",
  }[locale] || "Bilingual mode";
}

function getLocalizedConfigSource(source, locale) {
  const labels = {
    zh: { conversation: "当前群聊", user: "用户默认", system: "系统默认" },
    en: { conversation: "Current chat", user: "User default", system: "System default" },
    th: { conversation: "แชทปัจจุบัน", user: "ค่าเริ่มต้นของผู้ใช้", system: "ค่าเริ่มต้นของระบบ" },
    ja: { conversation: "現在のチャット", user: "ユーザー初期設定", system: "システム初期設定" },
  };
  return (labels[locale] || labels.en)[source] || (labels[locale] || labels.en).system;
}

function getLocalizedYesNo(value, locale) {
  if (value) {
    return {
      zh: "是",
      en: "Yes",
      th: "ใช่",
      ja: "はい",
    }[locale] || "Yes";
  }

  return {
    zh: "否",
    en: "No",
    th: "ไม่ใช่",
    ja: "いいえ",
  }[locale] || "No";
}

function getLocalizedOnOff(value, locale) {
  if (value) {
    return {
      zh: "开启",
      en: "On",
      th: "เปิด",
      ja: "オン",
    }[locale] || "On";
  }

  return {
    zh: "关闭",
    en: "Off",
    th: "ปิด",
    ja: "オフ",
  }[locale] || "Off";
}

function getDirectTranslationHelpLines(locale) {
  const lines = {
    zh: [
      "/TH 内容    指定翻译成泰文",
      "/MM 内容    指定翻译成缅文",
      "/ZH 内容    指定翻译成中文",
      "/TW 内容    指定翻译成繁体中文",
      "/EN 内容    指定翻译成英文",
      "/JP 内容    指定翻译成日文",
      "/DE 内容    指定翻译成德文",
      "/FR 内容    指定翻译成法文",
      "/ES 内容    指定翻译成西文",
      "/RU 内容    指定翻译成俄文",
      "/MS 内容    指定翻译成马来文",
      "/KO 内容    指定翻译成韩文",
      "/ID 内容    指定翻译成印尼文",
      "/VI 内容    指定翻译成越南文",
      "/HI 内容    指定翻译成印地文",
      "/AR 内容    指定翻译成阿拉伯文",
    ],
    en: [
      "/TH text    Translate to Thai",
      "/MM text    Translate to Burmese",
      "/ZH text    Translate to Chinese",
      "/TW text    Translate to Traditional Chinese",
      "/EN text    Translate to English",
      "/JP text    Translate to Japanese",
      "/DE text    Translate to German",
      "/FR text    Translate to French",
      "/ES text    Translate to Spanish",
      "/RU text    Translate to Russian",
      "/MS text    Translate to Malay",
      "/KO text    Translate to Korean",
      "/ID text    Translate to Indonesian",
      "/VI text    Translate to Vietnamese",
      "/HI text    Translate to Hindi",
      "/AR text    Translate to Arabic",
    ],
    th: [
      "/TH ข้อความ    แปลเป็นภาษาไทย",
      "/MM ข้อความ    แปลเป็นภาษาพม่า",
      "/ZH ข้อความ    แปลเป็นภาษาจีน",
      "/TW ข้อความ    แปลเป็นจีนตัวเต็ม",
      "/EN ข้อความ    แปลเป็นภาษาอังกฤษ",
      "/JP ข้อความ    แปลเป็นภาษาญี่ปุ่น",
      "/DE ข้อความ    แปลเป็นภาษาเยอรมัน",
      "/FR ข้อความ    แปลเป็นภาษาฝรั่งเศส",
      "/ES ข้อความ    แปลเป็นภาษาสเปน",
      "/RU ข้อความ    แปลเป็นภาษารัสเซีย",
      "/MS ข้อความ    แปลเป็นภาษามาเลย์",
      "/KO ข้อความ    แปลเป็นภาษาเกาหลี",
      "/ID ข้อความ    แปลเป็นภาษาอินโดนีเซีย",
      "/VI ข้อความ    แปลเป็นภาษาเวียดนาม",
      "/HI ข้อความ    แปลเป็นภาษาฮินดี",
      "/AR ข้อความ    แปลเป็นภาษาอาหรับ",
    ],
    ja: [
      "/TH テキスト    タイ語に翻訳",
      "/MM テキスト    ミャンマー語に翻訳",
      "/ZH テキスト    中国語に翻訳",
      "/TW テキスト    繁体字中国語に翻訳",
      "/EN テキスト    英語に翻訳",
      "/JP テキスト    日本語に翻訳",
      "/DE テキスト    ドイツ語に翻訳",
      "/FR テキスト    フランス語に翻訳",
      "/ES テキスト    スペイン語に翻訳",
      "/RU テキスト    ロシア語に翻訳",
      "/MS テキスト    マレー語に翻訳",
      "/KO テキスト    韓国語に翻訳",
      "/ID テキスト    インドネシア語に翻訳",
      "/VI テキスト    ベトナム語に翻訳",
      "/HI テキスト    ヒンディー語に翻訳",
      "/AR テキスト    アラビア語に翻訳",
    ],
  };

  return lines[locale] || lines.en;
}

function getTranslationPairHelpLines(locale) {
  const lines = {
    zh: [
      "支持任意两种语言组合，例如：",
      "set zh th    默认中文 ↔ 泰文",
      "set zh ja    默认中文 ↔ 日文",
      "set th ja    默认泰文 ↔ 日文",
    ],
    en: [
      "Any two supported languages can be paired, for example:",
      "set zh th    Default Chinese ↔ Thai",
      "set zh ja    Default Chinese ↔ Japanese",
      "set th ja    Default Thai ↔ Japanese",
    ],
    th: [
      "สามารถจับคู่ภาษาใดก็ได้ 2 ภาษา เช่น:",
      "set zh th    ค่าเริ่มต้นภาษาจีน ↔ ภาษาไทย",
      "set zh ja    ค่าเริ่มต้นภาษาจีน ↔ ภาษาญี่ปุ่น",
      "set th ja    ค่าเริ่มต้นภาษาไทย ↔ ภาษาญี่ปุ่น",
    ],
    ja: [
      "対応言語から任意の2言語を組み合わせできます。例：",
      "set zh th    初期言語 中国語 ↔ タイ語",
      "set zh ja    初期言語 中国語 ↔ 日本語",
      "set th ja    初期言語 タイ語 ↔ 日本語",
    ],
  };

  return lines[locale] || lines.en;
}

const translationCache = new Map();
const TRADITIONAL_CHINESE_HINT_RE =
  /[個們這裡嗎麼為與對時會說國語學體後發現讓買賣開關東廣門問間電車書長萬無風來過還點應當產業務員實認識聽見網頁電腦機構幫寫讀頭貓鳥魚馬龍雲台灣臺]/;

function normalizeCode(code) {
  if (!code) return "und";
  const value = String(code).trim().toLowerCase().replace("_", "-");
  if (value === "zh-tw" || value === "zh-hk" || value === "zhtw" || value === "zhhk") return "zh-TW";
  if (value === "tw" || value === "hk" || value === "tc") return "zh-TW";
  if (value.startsWith("zh")) return "zh";
  if (value === "jp") return "ja";
  if (value === "mm") return "my";
  if (value === "kr") return "ko";
  return value;
}

function toGoogleCode(code) {
  const normalized = normalizeCode(code);
  if (normalized === "zh") return "zh-CN";
  if (normalized === "zh-TW") return "zh-TW";
  if (normalized === "und") return undefined;
  return normalized;
}

function getLangName(code) {
  const normalized = normalizeCode(code);
  return LANG_NAME[normalized] || normalized.toUpperCase();
}

function getLangFlag(code) {
  const normalized = normalizeCode(code);
  return LANG_FLAG[normalized] || normalized.toUpperCase();
}

function getLangShortLabel(code) {
  const normalized = normalizeCode(code);
  return LANG_SHORT_LABEL[normalized] || getLangName(normalized);
}

function isSupportedDefaultLang(code) {
  return ADMIN_LANGUAGE_OPTIONS.includes(normalizeCode(code));
}

function isUserIdCommand(lower) {
  return lower === "userid" || lower === "/userid" || lower === "user id" || lower === "/user id";
}

function isGroupIdCommand(lower) {
  return lower === "/groupid" || lower === "groupid" || lower === "group id" || lower === "/group id";
}

function isStatusCommand(lower) {
  return lower === "/status" || lower === "/lang" || lower === "/状态";
}

function isUsageCommand(lower) {
  return lower === "/usage" || lower === "/用量";
}

function isHelpCommand(lower) {
  return lower === "/help" || lower === "help" || lower === "/帮助" || lower === "帮助";
}

function isSetCommand(lower) {
  return lower.startsWith("set ") || lower === "set";
}

function parseTargetLangCommand(text) {
  const match = text.trim().match(/^\/([a-z]{2})(?:\s+|$)([\s\S]*)$/i);
  if (!match) return null;

  const targetLang = TARGET_LANG_COMMANDS[match[1].toLowerCase()];
  if (!targetLang) return null;

  const body = String(match[2] || "").trim();
  if (!body) return { targetLang, text: "" };
  return { targetLang, text: body };
}

function getBangkokDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BILLING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value || "";
  const month = parts.find((part) => part.type === "month")?.value || "";
  const day = parts.find((part) => part.type === "day")?.value || "";
  return year && month && day ? `${year}-${month}-${day}` : "";
}

function addMonthsToDateString(dateString, months) {
  const safeMonths = Math.max(1, Number.parseInt(months || "1", 10) || 1);
  const base = /^\d{4}-\d{2}-\d{2}$/.test(String(dateString || ""))
    ? new Date(`${dateString}T12:00:00+07:00`)
    : new Date();
  const originalDay = base.getDate();
  const next = new Date(base);
  next.setMonth(next.getMonth() + safeMonths);
  if (next.getDate() !== originalDay) next.setDate(0);
  return getBangkokDateString(next);
}

function defaultExpiryDate() {
  return addMonthsToDateString(getBangkokDateString(), 12);
}

function parseExpiryMonths(value, fallback = 12) {
  const parsed = Number.parseInt(value || String(fallback), 10);
  return [1, 3, 6, 9, 12].includes(parsed) ? parsed : fallback;
}

function resolveExpiryDateFromDuration(body, fallbackMonths = 12) {
  const months = parseExpiryMonths(body.expiry_months, fallbackMonths);
  const calculatedDate = addMonthsToDateString(getBangkokDateString(), months);
  const customDate = String(body.expires_at || "").trim();

  if (customDate) return customDate;
  return calculatedDate;
}

function formatDate(value) {
  if (!value) return "未设置";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return getBangkokDateString(date);
}

function normalizeExpiryDate(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return `${text}T23:59:59+07:00`;
  }
  return text;
}

function formatDateInput(value) {
  if (!value) return "";
  return formatDate(value);
}

function parseNonNegativeInteger(value) {
  return Math.max(0, Number.parseInt(value || "0", 10) || 0);
}

function parsePositiveInteger(value, fallback = 1) {
  const parsed = Number.parseInt(value || String(fallback), 10);
  return parsed > 0 ? parsed : fallback;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function countChargeableChars(text) {
  return Array.from(text || "").length;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getQuotaChars(user) {
  return Number(user?.quota_chars || 0);
}

function getUsedChars(user) {
  return Number(user?.used_chars || 0);
}

function getStoredRemainingChars(user) {
  return Math.max(0, getQuotaChars(user) - getUsedChars(user));
}

function isUserExpired(user) {
  if (!user?.expires_at) return true;
  return new Date(user.expires_at).getTime() <= Date.now();
}

function getRemainingChars(user) {
  if (!user || isUserExpired(user) || user.status !== "active") return 0;
  return getStoredRemainingChars(user);
}

function isUserUsable(user) {
  if (!user) return { ok: false, reason: "not_found" };
  if (user.status !== "active") return { ok: false, reason: "status" };
  if (isUserExpired(user)) return { ok: false, reason: "expired" };
  if (getRemainingChars(user) <= 0) return { ok: false, reason: "quota" };
  return { ok: true, reason: "" };
}

function isChineseCode(code) {
  const normalized = normalizeCode(code);
  return normalized === "zh" || normalized === "zh-TW";
}

function isExplicitChinesePair(a, b) {
  const normalizedA = normalizeCode(a);
  const normalizedB = normalizeCode(b);
  return isChineseCode(normalizedA) && isChineseCode(normalizedB) && normalizedA !== normalizedB;
}

function matchesConfiguredLang(sourceLang, configuredLang, pairedLang) {
  const source = normalizeCode(sourceLang);
  const configured = normalizeCode(configuredLang);
  if (source === configured) return true;
  if (isChineseCode(source) && isChineseCode(configured) && !isExplicitChinesePair(configured, pairedLang)) {
    return true;
  }
  return false;
}

function getBilingualTargetLang(sourceLang, activation) {
  const source = normalizeCode(sourceLang);
  const langFrom = normalizeCode(activation.from_lang || SYSTEM_DEFAULT_FROM_LANG);
  const langTo = normalizeCode(activation.to_lang || SYSTEM_DEFAULT_TO_LANG);

  if (matchesConfiguredLang(source, langFrom, langTo)) return langTo;
  if (matchesConfiguredLang(source, langTo, langFrom)) return langFrom;
  return langFrom;
}

function hasConversationTranslationConfig(conversationBinding) {
  return Boolean(
    conversationBinding?.mode ||
      conversationBinding?.from_lang ||
      conversationBinding?.to_lang
  );
}

function getEffectiveTranslationConfig(user, conversationBinding) {
  const hasConversationConfig = hasConversationTranslationConfig(conversationBinding);
  const source = hasConversationConfig ? "conversation" : user ? "user" : "system";

  return {
    source,
    mode: conversationBinding?.mode || user?.mode || SYSTEM_DEFAULT_MODE,
    from_lang: normalizeCode(conversationBinding?.from_lang || user?.from_lang || SYSTEM_DEFAULT_FROM_LANG),
    to_lang: normalizeCode(conversationBinding?.to_lang || user?.to_lang || SYSTEM_DEFAULT_TO_LANG),
  };
}

function getCached(key) {
  if (!translationCache.has(key)) return null;

  const value = translationCache.get(key);
  translationCache.delete(key);
  translationCache.set(key, value);
  return value;
}

function setCache(key, value) {
  if (translationCache.has(key)) translationCache.delete(key);

  while (translationCache.size >= CACHE_MAX_SIZE) {
    translationCache.delete(translationCache.keys().next().value);
  }

  translationCache.set(key, value);
}

async function findUserByLineUserId(lineUserId) {
  if (!lineUserId) return null;

  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("line_user_id", lineUserId)
    .maybeSingle();

  if (error) {
    console.error("Load user failed:", {
      error: error.message,
      lineUserId,
      time: new Date().toISOString(),
    });
    return null;
  }

  return data || null;
}

async function findUserById(userId) {
  if (!userId) return null;

  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    console.error("Load user by id failed:", {
      error: error.message,
      userId,
      time: new Date().toISOString(),
    });
    return null;
  }

  return data || null;
}

function getConversationBindingKey(event) {
  if (event.source?.type === "group" && event.source?.groupId) {
    return { sourceType: "group", conversationId: event.source.groupId };
  }

  if (event.source?.type === "room" && event.source?.roomId) {
    return { sourceType: "room", conversationId: event.source.roomId };
  }

  return null;
}

async function findConversationBinding(bindingKey) {
  if (!bindingKey?.conversationId) return null;

  const { data, error } = await supabase
    .from("conversation_users")
    .select("user_id, translation_enabled, mode, from_lang, to_lang")
    .eq("source_type", bindingKey.sourceType)
    .eq("conversation_id", bindingKey.conversationId)
    .maybeSingle();

  if (error) {
    console.error("Load conversation user failed:", {
      error: error.message,
      sourceType: bindingKey.sourceType,
      conversationId: bindingKey.conversationId,
      time: new Date().toISOString(),
    });
    return null;
  }

  if (!data) return null;

  const user = await findUserById(data.user_id);
  if (!user) {
    console.warn("Conversation binding has no valid user:", {
      sourceType: bindingKey.sourceType,
      conversationId: bindingKey.conversationId,
      userId: data.user_id,
      time: new Date().toISOString(),
    });
  }

  return {
    translationEnabled: data.translation_enabled !== false,
    mode: data.mode || "",
    from_lang: data.from_lang || "",
    to_lang: data.to_lang || "",
    user,
  };
}

async function bindConversationToUser(bindingKey, userId) {
  if (!bindingKey?.conversationId || !userId) return;

  const { error } = await supabase
    .from("conversation_users")
    .insert({
      source_type: bindingKey.sourceType,
      conversation_id: bindingKey.conversationId,
      user_id: userId,
    });

  if (error) {
    if (error.code === "23505") return;

    console.warn("Bind conversation user failed:", {
      error: error.message,
      sourceType: bindingKey.sourceType,
      conversationId: bindingKey.conversationId,
      userId,
      time: new Date().toISOString(),
    });
    return;
  }

  console.log("Conversation bound to user:", {
    sourceType: bindingKey.sourceType,
    conversationId: bindingKey.conversationId,
    userId,
    time: new Date().toISOString(),
  });
}

async function setConversationTranslationEnabled(bindingKey, enabled) {
  if (!bindingKey?.conversationId) return false;

  const { error } = await supabase
    .from("conversation_users")
    .update({
      translation_enabled: enabled,
      updated_at: new Date().toISOString(),
    })
    .eq("source_type", bindingKey.sourceType)
    .eq("conversation_id", bindingKey.conversationId);

  if (error) {
    console.warn("Update conversation translation switch failed:", {
      error: error.message,
      sourceType: bindingKey.sourceType,
      conversationId: bindingKey.conversationId,
      enabled,
      time: new Date().toISOString(),
    });
    return false;
  }

  return true;
}

async function setConversationLanguageConfig(bindingKey, config) {
  if (!bindingKey?.conversationId) return false;

  const { error } = await supabase
    .from("conversation_users")
    .update({
      mode: config.mode,
      from_lang: config.from_lang,
      to_lang: config.to_lang,
      updated_at: new Date().toISOString(),
    })
    .eq("source_type", bindingKey.sourceType)
    .eq("conversation_id", bindingKey.conversationId);

  if (error) {
    console.warn("Update conversation language config failed:", {
      error: error.message,
      sourceType: bindingKey.sourceType,
      conversationId: bindingKey.conversationId,
      config,
      time: new Date().toISOString(),
    });
    return false;
  }

  return true;
}

async function touchUser(userId) {
  if (!userId) return;

  const { error } = await supabase
    .from("users")
    .update({ last_active_at: new Date().toISOString() })
    .eq("id", userId);

  if (error) {
    console.warn("Touch user failed:", {
      error: error.message,
      userId,
      time: new Date().toISOString(),
    });
  }
}

async function chargeUserUsage(userId, chargedChars) {
  if (chargedChars <= 0) return true;

  const { data, error } = await supabase.rpc("increment_user_usage", {
    p_user_id: userId,
    p_chars: chargedChars,
  });

  if (!error) {
    return Array.isArray(data) ? data.length > 0 : Boolean(data);
  }

  console.warn("RPC increment_user_usage failed:", {
    error: error.message,
    userId,
    chargedChars,
    time: new Date().toISOString(),
  });
  return false;
}

function adminTokenFromRequest(req) {
  return req.query.token || req.body?.token || req.get("x-admin-token") || "";
}

function getCookie(req, name) {
  const cookies = String(req.get("cookie") || "").split(";");

  for (const cookie of cookies) {
    const [rawKey, ...rawValue] = cookie.trim().split("=");
    if (rawKey === name) return decodeURIComponent(rawValue.join("="));
  }

  return "";
}

function buildCookie(name, value, maxAgeSeconds) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/admin",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ];

  if (maxAgeSeconds === 0) {
    parts.push("Max-Age=0");
  } else if (maxAgeSeconds) {
    parts.push(`Max-Age=${maxAgeSeconds}`);
  }

  return parts.join("; ");
}

function signValue(value) {
  if (!SESSION_SECRET) return "";
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}

function createSignedCookieValue(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${signValue(encoded)}`;
}

function readSignedCookieValue(value) {
  if (!value || !SESSION_SECRET) return null;

  const [encoded, signature] = value.split(".");
  if (!encoded || !signature) return null;

  const expected = signValue(encoded);
  const valid =
    signature.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));

  if (!valid) return null;

  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch (_error) {
    return null;
  }
}

function createAdminSession(email) {
  return createSignedCookieValue({
    email: String(email || "").toLowerCase(),
    exp: Date.now() + ADMIN_SESSION_MAX_AGE_SECONDS * 1000,
  });
}

function getAdminSession(req) {
  const payload = readSignedCookieValue(getCookie(req, ADMIN_SESSION_COOKIE));
  if (!payload?.email || !payload?.exp || payload.exp < Date.now()) return null;
  if (!ADMIN_ALLOWED_EMAILS.has(String(payload.email).toLowerCase())) return null;
  return payload;
}

function isGoogleAdminConfigured() {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && SESSION_SECRET && ADMIN_ALLOWED_EMAILS.size > 0);
}

function getExternalBaseUrl(req) {
  const proto = String(req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0];
  return `${proto}://${req.get("host")}`;
}

function getGoogleRedirectUri(req) {
  return `${getExternalBaseUrl(req)}/admin/auth/google/callback`;
}

function getRemoteAddress(req) {
  return String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
}

function getRequestHost(req) {
  return String(req.get("host") || "")
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(":")[0];
}

function isLocalOrTailscaleAddress(address) {
  if (!address) return false;
  if (address === "127.0.0.1" || address === "::1" || address === "localhost") return true;
  if (address.startsWith("fd7a:115c:a1e0:")) return true;

  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return false;

  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function requireAdmin(req, res, next) {
  const remoteAddress = getRemoteAddress(req);
  const requestHost = getRequestHost(req);
  const isPrivateAdminRequest =
    isLocalOrTailscaleAddress(remoteAddress) || isLocalOrTailscaleAddress(requestHost);

  if (ADMIN_TAILSCALE_ONLY && !isPrivateAdminRequest) {
    res.status(403).send("Admin page is only available from localhost or Tailscale.");
    return;
  }

  const session = getAdminSession(req);
  if (session) {
    req.adminEmail = session.email;
    next();
    return;
  }

  if (ADMIN_TOKEN && adminTokenFromRequest(req) === ADMIN_TOKEN) {
    req.adminEmail = "ADMIN_TOKEN";
    next();
    return;
  }

  res.status(401).send(renderAdminLogin(req.query.error || ""));
}

function normalizeUserInput(body, existing = {}) {
  const existingExpiryDate = formatDateInput(existing.expires_at);
  const hasExistingUser = Boolean(existing.id || existing.line_user_id);
  const expiryDate =
    body.expiry_months !== undefined && !hasExistingUser
      ? resolveExpiryDateFromDuration(body, 12)
      : String(body.expires_at || existingExpiryDate || defaultExpiryDate()).trim();

  return {
    line_user_id: String(body.line_user_id || "").trim(),
    name: String(body.name || "").trim(),
    status: String(body.status || "active").trim(),
    mode: String(body.mode || "bilingual").trim(),
    from_lang: normalizeCode(body.from_lang || "zh"),
    to_lang: normalizeCode(body.to_lang || "th"),
    quota_chars:
      body.quota_chars === undefined
        ? parseNonNegativeInteger(existing.quota_chars)
        : parseNonNegativeInteger(body.quota_chars),
    used_chars:
      body.used_chars === undefined
        ? parseNonNegativeInteger(existing.used_chars)
        : parseNonNegativeInteger(body.used_chars),
    expires_at: normalizeExpiryDate(expiryDate),
    notes: String(body.notes || "").trim() || null,
  };
}

function buildUserUpdatePayload(input) {
  return {
    line_user_id: input.line_user_id,
    name: input.name,
    status: input.status,
    mode: input.mode,
    from_lang: input.from_lang,
    to_lang: input.to_lang,
    quota_chars: input.quota_chars,
    used_chars: input.used_chars,
    expires_at: input.expires_at,
    notes: input.notes,
    updated_at: new Date().toISOString(),
  };
}

function validateUserInput(input) {
  const validStatuses = new Set(["active", "paused"]);
  const validModes = new Set(["bilingual", "trilingual"]);
  const validLangs = new Set(ADMIN_LANGUAGE_OPTIONS);

  if (!input.line_user_id) return "USERID 不能为空。";
  if (!input.name) return "用户名不能为空。";
  if (!validStatuses.has(input.status)) return "用户状态不正确。";
  if (!validModes.has(input.mode)) return "翻译模式不正确。";
  if (!validLangs.has(input.from_lang) || !validLangs.has(input.to_lang)) return "默认语言不正确。";
  if (input.mode === "bilingual" && input.from_lang === input.to_lang) return "默认语言和互译语言不能相同。";
  if (!input.expires_at || Number.isNaN(new Date(input.expires_at).getTime())) {
    return "有效期格式不正确，例如：2027-05-15";
  }
  if (input.quota_chars <= 0) return "购买流量必须大于 0。";
  if (input.used_chars > input.quota_chars) return "已用字符不能大于总购买字符。";

  return "";
}

function buildAdminRedirect(token, message) {
  const params = new URLSearchParams();
  if (token) params.set("token", token);
  if (message) params.set("message", message);
  const query = params.toString();
  return query ? `/admin?${query}` : "/admin";
}

function buildAdminRedirectWithOptions(token, message, options = {}) {
  const params = new URLSearchParams();
  if (token) params.set("token", token);
  if (message) params.set("message", message);
  if (options.search) params.set("search", options.search);
  if (options.limit) params.set("limit", options.limit);
  if (options.renewUserId) params.set("renew_userid", options.renewUserId);
  const query = params.toString();
  const hash = options.hash ? `#${options.hash}` : "";
  return `${query ? `/admin?${query}` : "/admin"}${hash}`;
}

function buildAdminRedirectWithRenewUser(token, message, lineUserId) {
  const params = new URLSearchParams();
  if (token) params.set("token", token);
  if (message) params.set("message", message);
  if (lineUserId) params.set("renew_userid", lineUserId);
  const query = params.toString();
  return `${query ? `/admin?${query}` : "/admin"}#recharge`;
}

function sanitizeAdminSearchTerm(value) {
  return String(value || "").trim().replace(/[,%]/g, " ").slice(0, 80);
}

function applyUserSearch(query, searchTerm) {
  if (!searchTerm) return query;
  const pattern = `*${searchTerm}*`;
  return query.or(`line_user_id.ilike.${pattern},name.ilike.${pattern},notes.ilike.${pattern}`);
}

async function loadConversationBindings(limit = 50, search = "") {
  const searchTerm = sanitizeAdminSearchTerm(search);
  let query = supabase
    .from("conversation_users")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (searchTerm) {
    query = query.ilike("conversation_id", `%${searchTerm}%`);
  }

  const { data, error } = await query;

  if (error) throw error;

  const bindings = data || [];
  const userIds = [...new Set(bindings.map((binding) => binding.user_id).filter(Boolean))];
  let usersById = new Map();

  if (userIds.length > 0) {
    const { data: users, error: usersError } = await supabase
      .from("users")
      .select("id, line_user_id, name, status, expires_at")
      .in("id", userIds);

    if (usersError) throw usersError;
    usersById = new Map((users || []).map((user) => [user.id, user]));
  }

  return bindings.map((binding) => ({
    ...binding,
    user: usersById.get(binding.user_id) || null,
  }));
}

async function loadRenewalHistory(userId, limit = 10) {
  if (!userId) return [];

  const { data, error } = await supabase
    .from("user_renewals")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

async function loadAdminData(renewUserId = "", search = "", conversationSearch = "") {
  const now = new Date().toISOString();
  const trimmedRenewUserId = String(renewUserId || "").trim();
  const safeLimit = 20;
  const searchTerm = sanitizeAdminSearchTerm(search);
  const conversationSearchTerm = sanitizeAdminSearchTerm(conversationSearch);
  const usersQuery = applyUserSearch(
    supabase
      .from("users")
      .select("*")
      .order("expires_at", { ascending: true })
      .limit(safeLimit),
    searchTerm
  );
  const queries = [
    usersQuery,
    loadConversationBindings(50, conversationSearchTerm),
  ];

  if (trimmedRenewUserId) {
    queries.push(
      supabase
        .from("users")
        .select("*")
        .eq("line_user_id", trimmedRenewUserId)
        .maybeSingle()
    );
  }

  const results = await Promise.all(queries);
  const [
    { data: users, error: usersError },
    conversationBindings,
  ] = results;
  const renewResult = results[2];

  if (usersError) throw usersError;
  if (renewResult?.error) throw renewResult.error;
  const renewalHistory = await loadRenewalHistory(renewResult?.data?.id);

  return {
    users: users || [],
    conversationBindings,
    renewUser: renewResult?.data || null,
    renewalHistory,
    renewUserId: trimmedRenewUserId,
    renewUserNotFound: Boolean(trimmedRenewUserId && !renewResult?.data),
    searchTerm,
    conversationSearchTerm,
  };
}

function renderQuotaOptions(selectedValue = 100000) {
  const selected = Number(selectedValue || 0);
  const options = [];

  for (let value = 100000; value <= 1000000; value += 100000) {
    options.push(
      `<option value="${value}" ${selected === value ? "selected" : ""}>${formatNumber(value)} 字符</option>`
    );
  }

  return options.join("");
}

function renderMonthOptions(selectedValue = 12, includeBlank = false) {
  const selected = includeBlank && !selectedValue ? "" : parsePositiveInteger(selectedValue, 12);
  const options = [1, 3, 6, 9, 12]
    .map((value) => `<option value="${value}" ${selected === value ? "selected" : ""}>${value} 个月</option>`)
    .join("");
  if (!includeBlank) return options;
  return `<option value="" ${selected === "" ? "selected" : ""}>按月数调整</option>${options}`;
}

function renderLanguageOptions(selectedValue = "zh") {
  const selected = normalizeCode(selectedValue || "zh");
  return ADMIN_LANGUAGE_OPTIONS.map(
    (code) => `<option value="${code}" ${selected === code ? "selected" : ""}>${getLangShortLabel(code)}</option>`
  ).join("");
}

function renderOptionalLanguageOptions(selectedValue = "") {
  const selected = selectedValue ? normalizeCode(selectedValue) : "";
  return [
    `<option value="" ${selected ? "" : "selected"}>使用用户默认</option>`,
    ...ADMIN_LANGUAGE_OPTIONS.map(
      (code) => `<option value="${code}" ${selected === code ? "selected" : ""}>${getLangShortLabel(code)}</option>`
    ),
  ].join("");
}

function renderOptionalModeOptions(selectedValue = "") {
  const selected = String(selectedValue || "");
  return [
    `<option value="" ${selected ? "" : "selected"}>使用用户默认</option>`,
    `<option value="bilingual" ${selected === "bilingual" ? "selected" : ""}>双语模式</option>`,
    `<option value="trilingual" ${selected === "trilingual" ? "selected" : ""}>三语模式</option>`,
  ].join("");
}

function renderReadonlyMetric(label, value) {
  return `<div class="metric"><b>${escapeHtml(label)}</b><span>${escapeHtml(value)}</span></div>`;
}

function renderInlineMetric(label, value) {
  return `<div class="metric inline-metric"><b>${escapeHtml(label)}：</b><span>${escapeHtml(value)}</span></div>`;
}

function renderAdminLogin(errorMessage) {
  const googleConfigured = isGoogleAdminConfigured();
  const tokenConfigured = Boolean(ADMIN_TOKEN);

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>linebot-Glossary 管理</title>
  <style>
    body { margin: 0; font-family: Arial, "PingFang SC", sans-serif; background: #f5f7fb; color: #172033; }
    main { max-width: 420px; margin: 12vh auto; padding: 24px; background: #fff; border: 1px solid #d9e0ea; border-radius: 8px; }
    label { display: block; font-size: 13px; color: #4b5870; margin-bottom: 8px; }
    input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #b7c2d1; border-radius: 6px; font-size: 15px; }
    button, .button { display: inline-block; margin-top: 14px; padding: 10px 14px; border: 0; border-radius: 6px; background: #1f6feb; color: #fff; font-weight: 700; cursor: pointer; text-decoration: none; }
    .secondary { background: #536078; }
    .error { color: #b42318; margin-bottom: 12px; }
    .meta { color: #536078; font-size: 13px; line-height: 1.5; }
  </style>
</head>
<body>
  <main>
    <h1>管理入口</h1>
    ${errorMessage ? `<p class="error">${escapeHtml(errorMessage)}</p>` : ""}
    ${
      googleConfigured
        ? '<p><a class="button" href="/admin/login/google">使用 Google 账号登录</a></p>'
        : '<p class="meta">Google 登录尚未配置。请设置 GOOGLE_CLIENT_ID、GOOGLE_CLIENT_SECRET、SESSION_SECRET 和 ADMIN_ALLOWED_EMAILS。</p>'
    }
    ${
      tokenConfigured
        ? `<form method="get" action="/admin">
            <label for="token">备用 ADMIN_TOKEN</label>
            <input id="token" name="token" type="password" autocomplete="current-password" ${googleConfigured ? "" : "autofocus"}>
            <button class="secondary" type="submit">使用备用 token 进入</button>
          </form>`
        : ""
    }
  </main>
</body>
</html>`;
}

function renderUserRows(users, token) {
  return (users || [])
    .map((user) => {
      const quotaChars = getQuotaChars(user);
      const usedChars = getUsedChars(user);
      const remainingChars = getStoredRemainingChars(user);
      const status = isUserExpired(user) ? "已过期" : user.status;
      const mode = user.mode === "trilingual" ? "三语模式" : "双语模式";
      const languages =
        user.mode === "trilingual"
          ? "中文 / ภาษาไทย / မြန်မာဘာသာ"
          : `${getLangName(user.from_lang)} ↔ ${getLangName(user.to_lang)}`;

      return `<details class="user">
        <summary>
          <span class="summary-main">
            <strong>${escapeHtml(user.name)}</strong>
            <code>${escapeHtml(user.line_user_id)}</code>
            <span class="badge ${isUserExpired(user) ? "danger-badge" : ""}">${isUserExpired(user) ? "expired" : escapeHtml(user.status)}</span>
          </span>
          <span class="summary-stats">
            有效期至 ${escapeHtml(formatDateInput(user.expires_at))} · 剩余 ${formatNumber(remainingChars)} 字符
          </span>
        </summary>

        <div class="user-body">
          <div class="metric-grid">
            ${renderReadonlyMetric("用户名", user.name)}
            ${renderReadonlyMetric("USERID", user.line_user_id)}
            ${renderReadonlyMetric("状态", status)}
            ${renderReadonlyMetric("有效期至", formatDate(user.expires_at))}
            ${renderReadonlyMetric("模式", mode)}
            ${renderReadonlyMetric("语言", languages)}
            ${renderReadonlyMetric("总购买字符", `${formatNumber(quotaChars)} 字符`)}
            ${renderReadonlyMetric("已用字符", `${formatNumber(usedChars)} 字符`)}
            ${renderReadonlyMetric("剩余字符", `${formatNumber(remainingChars)} 字符`)}
            ${renderReadonlyMetric("最近使用", formatDate(user.last_active_at))}
            ${renderReadonlyMetric("备注", user.notes || "-")}
          </div>
          <form method="post" action="/admin/users/${escapeHtml(user.id)}" class="edit-form">
            <input type="hidden" name="token" value="${escapeHtml(token)}">
            <div class="edit-grid">
              <label>USERID<input name="line_user_id" value="${escapeHtml(user.line_user_id)}" required></label>
              <label>用户名<input name="name" value="${escapeHtml(user.name)}" required></label>
              <label>状态
                <select name="status">
                  <option value="active" ${user.status === "active" ? "selected" : ""}>active</option>
                  <option value="paused" ${user.status === "paused" ? "selected" : ""}>paused</option>
                </select>
              </label>
              <label>模式
                <select name="mode">
                  <option value="bilingual" ${user.mode === "bilingual" ? "selected" : ""}>双语模式</option>
                  <option value="trilingual" ${user.mode === "trilingual" ? "selected" : ""}>三语模式</option>
                </select>
              </label>
              <label>默认语言<select name="from_lang">${renderLanguageOptions(user.from_lang)}</select></label>
              <label>互译语言<select name="to_lang">${renderLanguageOptions(user.to_lang)}</select></label>
              <label>总购买字符<input name="quota_chars" type="number" min="0" step="1" value="${quotaChars}" required></label>
              <label>已用字符<input name="used_chars" type="number" min="0" step="1" value="${usedChars}" required></label>
              <label>有效期
                <select name="expiry_months" data-expiry-months data-expiry-target="user-expiry-${escapeHtml(user.id)}">${renderMonthOptions("", true)}</select>
              </label>
              <label>有效期至
                <input id="user-expiry-${escapeHtml(user.id)}" name="expires_at" type="date" value="${escapeHtml(formatDateInput(user.expires_at))}" required>
              </label>
              <label class="wide">备注<input name="notes" value="${escapeHtml(user.notes || "")}"></label>
              <div class="form-actions edit-actions">
                <button type="submit">保存用户</button>
              </div>
            </div>
          </form>
        </div>
      </details>`;
    })
    .join("");
}

function renderRenewalHistoryRows(renewalHistory) {
  if (!renewalHistory || renewalHistory.length === 0) {
    return '<p class="meta">暂无充值记录。</p>';
  }

  return `<div class="history-list">
    ${renewalHistory
      .map((item) => `<div class="history-row">
        <span>${escapeHtml(formatDate(item.created_at))}</span>
        <span>${escapeHtml(item.type)}</span>
        <span>${formatNumber(item.chars_delta)} 字符</span>
        <span>有效期：${escapeHtml(formatDate(item.expires_at_before))} → ${escapeHtml(formatDate(item.expires_at_after))}</span>
        <span>${escapeHtml(item.note || "-")}</span>
      </div>`)
      .join("")}
  </div>`;
}

function renderRenewalPanel({ renewUser, renewUserId, renewUserNotFound, renewalHistory, token }) {
  const quotaChars = getQuotaChars(renewUser);
  const usedChars = getUsedChars(renewUser);
  const remainingChars = getStoredRemainingChars(renewUser);
  const nextExpiry = defaultExpiryDate();
  const userStatus = renewUser
    ? isUserExpired(renewUser)
      ? "已过期"
      : renewUser.status
    : "";

  return `<section id="recharge" class="panel recharge-panel">
      <h2>流量充值</h2>
      <form method="get" action="/admin#recharge" class="lookup-form">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <label>USERID<input name="renew_userid" value="${escapeHtml(renewUserId || "")}" placeholder="输入 USERID 后检索" required></label>
        <button type="submit">检索</button>
      </form>

      ${
        renewUserNotFound
          ? `<p class="message error">找不到该 USERID：${escapeHtml(renewUserId)}</p>`
          : ""
      }

      ${
        renewUser
          ? `<div class="renew-user">
              <div class="renew-split">
                <div class="renew-metrics">
                  <div class="renew-metric-row single">
                    ${renderInlineMetric("USERID", renewUser.line_user_id)}
                  </div>
                  <div class="renew-metric-row">
                    ${renderReadonlyMetric("用户名", renewUser.name)}
                    ${renderReadonlyMetric("状态", userStatus)}
                  </div>
                  <div class="renew-metric-row">
                    ${renderReadonlyMetric("总购买字符", `${formatNumber(quotaChars)} 字符`)}
                    ${renderReadonlyMetric("剩余字符", `${formatNumber(remainingChars)} 字符`)}
                  </div>
                  <div class="renew-metric-row">
                    ${renderReadonlyMetric("已用字符", `${formatNumber(usedChars)} 字符`)}
                    ${renderReadonlyMetric("有效期至", formatDate(renewUser.expires_at))}
                  </div>
                  <div class="renew-metric-row">
                    ${renderReadonlyMetric("最近使用", formatDate(renewUser.last_active_at))}
                    ${renderReadonlyMetric("充值后有效期", `${nextExpiry}`)}
                  </div>
                </div>

                <div class="renew-actions">
                  <form method="post" action="/admin/users/${escapeHtml(renewUser.id)}/recharge" class="renew-card">
                    <input type="hidden" name="token" value="${escapeHtml(token)}">
                    <input type="hidden" name="line_user_id" value="${escapeHtml(renewUser.line_user_id)}">
                    <h3>充值流量</h3>
                    <div class="renew-grid compact">
                      <label>增加流量
                        <select name="recharge_chars">${renderQuotaOptions(100000)}</select>
                      </label>
                      <label>套餐时长
                        <select name="recharge_months" data-expiry-months data-expiry-target="recharge-expiry">${renderMonthOptions(12)}</select>
                      </label>
                      <label>充值后有效期
                        <input id="recharge-expiry" name="expires_at" type="date" value="${escapeHtml(nextExpiry)}">
                      </label>
                      <label class="wide">备注<input name="note" placeholder="收款/订单备注"></label>
                    </div>
                    <p class="meta">默认按套餐时长重新计算有效期；如填写了日期，则以填写日期为准。</p>
                    <div class="form-actions recharge-actions">
                      <button type="submit">提交充值</button>
                    </div>
                  </form>
                </div>
              </div>
              <h3>最近充值记录</h3>
              ${renderRenewalHistoryRows(renewalHistory)}
            </div>`
          : `<p class="meta">输入 USERID 并点击检索后，可查看用户基本信息并充值流量。</p>`
      }
    </section>`;
}

function renderConversationRows(conversationBindings, token) {
  if (!conversationBindings || conversationBindings.length === 0) {
    return '<p class="meta">暂无群聊或多人聊天室绑定。</p>';
  }

  return `<div class="conversation-list">
    ${conversationBindings
      .map((binding) => {
        const user = binding.user;
        const config = getEffectiveTranslationConfig(user, binding);
        const configSource = hasConversationTranslationConfig(binding) ? "群聊设置" : "使用用户默认";
        const languageSummary =
          config.mode === "trilingual"
            ? "中文 / ภาษาไทย / မြန်မာဘာသာ"
            : `${getLangName(config.from_lang)} ↔ ${getLangName(config.to_lang)}`;
        return `<details class="conversation-item">
          <summary>
            <span class="summary-main">
              <strong>${binding.source_type === "group" ? "群聊" : "多人聊天室"}</strong>
              <code>${escapeHtml(binding.conversation_id)}</code>
              <span class="badge">${binding.translation_enabled === false ? "自动翻译关闭" : "自动翻译开启"}</span>
            </span>
            <span class="summary-stats">${escapeHtml(user ? `${user.name} / ${user.line_user_id}` : "未找到绑定用户")}</span>
          </summary>
          <div class="user-body">
            <div class="metric-grid">
              ${renderReadonlyMetric("绑定用户", user ? user.name : "-")}
              ${renderReadonlyMetric("USERID", user ? user.line_user_id : "-")}
              ${renderReadonlyMetric("绑定来源", binding.source_type)}
              ${renderReadonlyMetric("语言配置", configSource)}
              ${renderReadonlyMetric("模式", config.mode === "trilingual" ? "三语模式" : "双语模式")}
              ${renderReadonlyMetric("语言", languageSummary)}
              ${renderReadonlyMetric("更新时间", formatDate(binding.updated_at))}
            </div>
            <form method="post" action="/admin/conversations/${escapeHtml(binding.id)}" class="edit-form">
              <input type="hidden" name="token" value="${escapeHtml(token)}">
              <div class="edit-grid">
                <label>改绑到 USERID<input name="line_user_id" placeholder="留空则只切换开关/解绑"></label>
                <label>自动翻译
                  <select name="translation_enabled">
                    <option value="true" ${binding.translation_enabled !== false ? "selected" : ""}>开启</option>
                    <option value="false" ${binding.translation_enabled === false ? "selected" : ""}>关闭</option>
                  </select>
                </label>
                <label>群聊模式
                  <select name="mode">${renderOptionalModeOptions(binding.mode)}</select>
                </label>
                <label>默认语言
                  <select name="from_lang">${renderOptionalLanguageOptions(binding.from_lang)}</select>
                </label>
                <label>互译语言
                  <select name="to_lang">${renderOptionalLanguageOptions(binding.to_lang)}</select>
                </label>
                <div class="form-actions edit-actions">
                  <button type="submit" name="action" value="save">保存绑定</button>
                  <button type="submit" name="action" value="unbind" class="secondary">解绑</button>
                </div>
              </div>
            </form>
          </div>
        </details>`;
      })
      .join("")}
  </div>`;
}

function renderAdminPage({ users, conversationBindings, renewUser, renewUserId, renewUserNotFound, renewalHistory, searchTerm, conversationSearchTerm, token, message, adminEmail }) {
  const defaultExpiry = defaultExpiryDate();

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>linebot-Glossary 管理</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font-family: Arial, "PingFang SC", sans-serif; background: #f4f6fa; color: #172033; }
    header { background: #0f172a; color: #fff; padding: 18px 24px; }
    main { max-width: 1180px; margin: 0 auto; padding: 22px; }
    h1 { margin: 0; font-size: 22px; }
    h2 { font-size: 18px; margin: 24px 0 12px; }
    form { margin: 0; }
    .panel, .user { background: #fff; border: 1px solid #d9e0ea; border-radius: 8px; margin-bottom: 10px; }
    .panel { padding: 16px; }
    .recharge-panel { scroll-margin-top: 14px; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(180px, 1fr)); gap: 14px; align-items: start; }
    .create-grid, .edit-grid { display: grid; grid-template-columns: repeat(4, minmax(180px, 1fr)); gap: 12px 14px; align-items: start; }
    .wide { grid-column: span 2; }
    .full { grid-column: 1 / -1; }
    .inline-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: end; }
    .create-actions { grid-template-columns: minmax(0, calc(50% - 6px)) auto; justify-content: start; }
    label { display: flex; flex-direction: column; gap: 6px; min-width: 0; font-size: 13px; color: #4b5870; }
    input, select { box-sizing: border-box; width: 100%; height: 38px; padding: 8px 10px; border: 1px solid #b7c2d1; border-radius: 6px; font-size: 14px; line-height: 20px; background: #fff; }
    input[type="date"] { appearance: auto; cursor: pointer; }
    select { appearance: auto; cursor: pointer; }
    input[type="checkbox"] { width: 16px; height: 16px; padding: 0; flex: 0 0 auto; }
    code { background: #eef2f7; padding: 2px 5px; border-radius: 4px; }
    button { width: 92px; min-width: 92px; height: 38px; padding: 0 13px; border: 0; border-radius: 6px; background: #1f6feb; color: #fff; font-size: 15px; font-weight: 700; cursor: pointer; white-space: nowrap; }
    button.secondary { background: #536078; }
    summary { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 12px 14px; cursor: pointer; }
    summary::-webkit-details-marker { display: none; }
    .summary-main, .summary-stats { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .summary-stats { color: #536078; font-size: 13px; justify-content: flex-end; }
    .badge { background: #e8f2ff; color: #175cd3; border-radius: 999px; padding: 2px 8px; font-size: 12px; }
    .danger-badge { background: #fff1f0; color: #a8071a; }
    .user-body { border-top: 1px solid #e8edf3; padding: 14px; }
    .edit-form { border-top: 1px solid #e8edf3; margin-top: 14px; padding-top: 14px; }
    .renew-grid { display: grid; grid-template-columns: minmax(240px, 1.4fr) minmax(150px, 1fr) minmax(150px, 1fr) minmax(150px, 1fr); gap: 14px; align-items: start; }
    .renew-grid.compact { grid-template-columns: repeat(2, minmax(180px, 1fr)); }
    .lookup-form { display: grid; grid-template-columns: minmax(260px, calc(50% - 6px)) auto; gap: 12px; align-items: end; justify-content: start; }
    .metric-grid { display: grid; grid-template-columns: repeat(4, minmax(160px, 1fr)); gap: 10px; margin-top: 14px; }
    .metric { background: #f8fafc; border: 1px solid #e8edf3; border-radius: 6px; padding: 9px 10px; min-height: 38px; box-sizing: border-box; }
    .metric b, .metric span { display: block; }
    .metric b { color: #4b5870; font-size: 12px; font-weight: 600; }
    .metric span { color: #172033; font-size: 14px; margin-top: 3px; overflow-wrap: anywhere; }
    .inline-metric { display: flex; align-items: center; gap: 0; min-height: 38px; }
    .inline-metric b, .inline-metric span { display: inline; margin-top: 0; white-space: nowrap; }
    .inline-metric span { overflow: hidden; text-overflow: ellipsis; }
    .renew-user { border-top: 1px solid #e8edf3; margin-top: 14px; padding-top: 14px; }
    .renew-split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; align-items: stretch; }
    .renew-metrics { display: grid; gap: 10px; }
    .renew-metric-row { display: grid; grid-template-columns: repeat(2, minmax(150px, 1fr)); gap: 10px; }
    .renew-metric-row.single { grid-template-columns: 1fr; }
    .renew-metrics .metric { margin: 0; }
    .renew-actions { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
    .renew-card { min-height: 100%; border: 1px solid #e8edf3; border-radius: 8px; padding: 14px; background: #fbfcfe; box-sizing: border-box; }
    .renew-card h3 { margin: 0 0 12px; font-size: 16px; }
    .list-toolbar { display: flex; align-items: end; justify-content: space-between; gap: 14px; margin-top: 24px; flex-wrap: wrap; }
    .list-toolbar h2 { margin: 0; }
    .limit-form, .search-form { display: flex; align-items: end; gap: 10px; flex-wrap: nowrap; }
    .search-form label { width: min(420px, 100%); }
    .search-form button { flex: 0 0 auto; }
    .limit-form label { width: 130px; }
    .form-actions { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 14px; }
    .recharge-actions { justify-content: flex-end; margin-top: 24px; }
    .check { display: inline-flex; flex-direction: row; align-items: center; gap: 8px; min-height: 38px; color: #4b5870; }
    .check input { width: 16px; }
    .meta { color: #536078; font-size: 13px; margin: 10px 0 0; }
    .message { background: #ecfdf3; border: 1px solid #abefc6; color: #067647; padding: 10px 12px; border-radius: 6px; margin-bottom: 14px; }
    .message.error { background: #fff1f0; border-color: #ffccc7; color: #a8071a; margin-top: 14px; }
    .history-list, .conversation-list { display: grid; gap: 8px; margin-top: 10px; }
    .history-row { display: grid; grid-template-columns: 90px 90px 130px minmax(180px, 1fr) minmax(160px, 1fr); gap: 10px; padding: 9px 10px; background: #f8fafc; border: 1px solid #e8edf3; border-radius: 6px; font-size: 13px; }
    .conversation-item { background: #fff; border: 1px solid #d9e0ea; border-radius: 8px; }
    @media (max-width: 860px) {
      .grid, .create-grid, .edit-grid, .renew-grid, .renew-grid.compact, .lookup-form, .metric-grid, .renew-metric-row, .renew-actions, .renew-split, .inline-row, .create-actions, .history-row { grid-template-columns: 1fr; }
      .wide { grid-column: span 1; }
      .list-toolbar { align-items: stretch; flex-direction: column; }
      .limit-form, .search-form { align-items: stretch; }
      .limit-form label, .search-form label { width: 100%; }
      .search-form { flex-wrap: nowrap; }
      .search-form label { flex: 1 1 auto; }
      summary { align-items: flex-start; flex-direction: column; }
      .summary-stats { justify-content: flex-start; }
      main { padding: 14px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>linebot-Glossary 管理</h1>
    <p class="meta">当前管理员：${escapeHtml(adminEmail || "unknown")} · <a href="/admin/logout">退出</a></p>
    <p class="meta"><a href="/admin${token ? `?token=${encodeURIComponent(token)}` : ""}">用户管理</a> · <a href="/admin${token ? `?token=${encodeURIComponent(token)}` : ""}#conversations">群聊绑定</a> · <a href="/admin/suggestions${token ? `?token=${encodeURIComponent(token)}` : ""}">候选词</a> · <a href="/admin/glossary${token ? `?token=${encodeURIComponent(token)}` : ""}">术语库</a></p>
  </header>
  <main>
    ${message ? `<div class="message">${escapeHtml(message)}</div>` : ""}

    <section class="panel">
      <h2>新增用户</h2>
      <form method="post" action="/admin/users">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <div class="create-grid">
          <label>USERID<input name="line_user_id" placeholder="Uxxxxxxxxxxxxxxxx" required></label>
          <label>用户名<input name="name" placeholder="后台自定义名称" required></label>
          <label>初始流量<select name="quota_chars">${renderQuotaOptions(100000)}</select></label>
          <label>状态
            <select name="status">
              <option value="active">active</option>
              <option value="paused">paused</option>
            </select>
          </label>
          <input type="hidden" name="mode" value="bilingual">
          <label>默认语言<select name="from_lang">${renderLanguageOptions("zh")}</select></label>
          <label>互译语言<select name="to_lang">${renderLanguageOptions("th")}</select></label>
          <label>有效期
            <select name="expiry_months" data-expiry-months data-expiry-target="create-expiry">${renderMonthOptions(12)}</select>
          </label>
          <label>有效期至<input id="create-expiry" name="expires_at" type="date" value="${escapeHtml(defaultExpiry)}"></label>
          <input type="hidden" name="used_chars" value="0">
          <div class="full inline-row create-actions">
            <label>备注<input name="notes" placeholder="收款/套餐/客户备注"></label>
            <button type="submit">创建用户</button>
          </div>
        </div>
      </form>
    </section>

    ${renderRenewalPanel({ renewUser, renewUserId, renewUserNotFound, renewalHistory, token })}

    <div class="list-toolbar">
      <h2>用户管理</h2>
      <form method="get" action="/admin" class="search-form">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        ${renewUserId ? `<input type="hidden" name="renew_userid" value="${escapeHtml(renewUserId)}">` : ""}
        ${conversationSearchTerm ? `<input type="hidden" name="conversation_search" value="${escapeHtml(conversationSearchTerm)}">` : ""}
        <label>搜索用户<input name="search" value="${escapeHtml(searchTerm || "")}" placeholder="USERID / 用户名 / 备注"></label>
        <button type="submit" class="secondary">搜索</button>
      </form>
    </div>
    ${renderUserRows(users, token) || '<section class="panel">暂无用户。</section>'}

    <section id="conversations" class="panel">
      <h2>群聊绑定管理</h2>
      <form method="get" action="/admin#conversations" class="search-form">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        ${renewUserId ? `<input type="hidden" name="renew_userid" value="${escapeHtml(renewUserId)}">` : ""}
        ${searchTerm ? `<input type="hidden" name="search" value="${escapeHtml(searchTerm)}">` : ""}
        <label>搜索群聊ID<input name="conversation_search" value="${escapeHtml(conversationSearchTerm || "")}" placeholder="groupId / roomId"></label>
        <button type="submit" class="secondary">搜索</button>
      </form>
      ${renderConversationRows(conversationBindings, token)}
    </section>
  </main>
  <script>
    const expiryBaseDate = "${escapeHtml(getBangkokDateString())}";

    function formatBangkokDate(date) {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "${BILLING_TIME_ZONE}",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(date);
      const year = parts.find((part) => part.type === "year")?.value || "";
      const month = parts.find((part) => part.type === "month")?.value || "";
      const day = parts.find((part) => part.type === "day")?.value || "";
      return year && month && day ? year + "-" + month + "-" + day : "";
    }

    function addMonthsToExpiryDate(dateString, months) {
      const base = new Date(dateString + "T12:00:00+07:00");
      const originalDay = base.getDate();
      const next = new Date(base);
      next.setMonth(next.getMonth() + Number.parseInt(months || "12", 10));
      if (next.getDate() !== originalDay) next.setDate(0);
      return formatBangkokDate(next);
    }

    document.querySelectorAll("[data-expiry-months]").forEach((select) => {
      select.addEventListener("change", () => {
        const target = document.getElementById(select.dataset.expiryTarget || "");
        if (!select.value) return;
        if (target) target.value = addMonthsToExpiryDate(expiryBaseDate, select.value);
      });
    });

    document.querySelectorAll('input[type="date"]').forEach((input) => {
      const openPicker = () => {
        if (typeof input.showPicker === "function") input.showPicker();
      };
      input.addEventListener("click", openPicker);
      input.addEventListener("focus", openPicker);
    });
  </script>
</body>
</html>`;
}

function redactWebhookBody(body) {
  const clone = JSON.parse(JSON.stringify(body));

  for (const event of clone.events || []) {
    if (event?.source?.userId) event.source.userId = "[USER_ID]";
  }

  return clone;
}

const app = express();

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "linebot-glossary",
    cacheSize: translationCache.size,
    database: "supabase",
  });
});

app.use("/admin", express.urlencoded({ extended: false }));

app.get("/admin/login/google", (req, res) => {
  if (!isGoogleAdminConfigured()) {
    res.redirect(buildAdminRedirect("", "Google 登录尚未配置。"));
    return;
  }

  const state = crypto.randomBytes(24).toString("base64url");
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: getGoogleRedirectUri(req),
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });

  res.setHeader("Set-Cookie", buildCookie(ADMIN_OAUTH_STATE_COOKIE, state, 600));
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

app.get("/admin/auth/google/callback", async (req, res) => {
  try {
    if (!isGoogleAdminConfigured()) {
      res.redirect(buildAdminRedirect("", "Google 登录尚未配置。"));
      return;
    }

    const expectedState = getCookie(req, ADMIN_OAUTH_STATE_COOKIE);
    const actualState = String(req.query.state || "");
    const code = String(req.query.code || "");

    if (!code || !expectedState || actualState !== expectedState) {
      res.redirect(buildAdminRedirect("", "Google 登录状态无效，请重新登录。"));
      return;
    }

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: getGoogleRedirectUri(req),
        grant_type: "authorization_code",
      }),
    });

    const tokenBody = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenBody.access_token) {
      console.error("Google OAuth token exchange failed:", tokenBody);
      res.redirect(buildAdminRedirect("", "Google 登录失败，请查看服务日志。"));
      return;
    }

    const userResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${tokenBody.access_token}` },
    });
    const userInfo = await userResponse.json();
    const email = String(userInfo.email || "").toLowerCase();

    if (!userResponse.ok || userInfo.email_verified !== true || !ADMIN_ALLOWED_EMAILS.has(email)) {
      console.warn("Google admin login rejected:", {
        email,
        emailVerified: userInfo.email_verified,
        time: new Date().toISOString(),
      });
      res.redirect(buildAdminRedirect("", "该 Google 账号不在管理员白名单中。"));
      return;
    }

    res.setHeader("Set-Cookie", [
      buildCookie(ADMIN_SESSION_COOKIE, createAdminSession(email), ADMIN_SESSION_MAX_AGE_SECONDS),
      buildCookie(ADMIN_OAUTH_STATE_COOKIE, "", 0),
    ]);
    res.redirect("/admin");
  } catch (error) {
    console.error("Google admin login failed:", error);
    res.redirect(buildAdminRedirect("", "Google 登录失败，请稍后重试。"));
  }
});

app.get("/admin/logout", (_req, res) => {
  res.setHeader("Set-Cookie", buildCookie(ADMIN_SESSION_COOKIE, "", 0));
  res.redirect("/admin");
});

registerAdminGlossaryRoutes(app, {
  requireAdmin,
  adminTokenFromRequest,
});

app.get("/admin", requireAdmin, async (req, res) => {
  try {
    const data = await loadAdminData(req.query.renew_userid || "", req.query.search || "", req.query.conversation_search || "");
    res.status(200).send(
      renderAdminPage({
        ...data,
        token: adminTokenFromRequest(req),
        message: req.query.message || "",
        adminEmail: req.adminEmail,
      })
    );
  } catch (error) {
    console.error("Load admin page failed:", error);
    res.status(500).send("管理页面加载失败，请查看服务日志。");
  }
});

app.post("/admin/users", requireAdmin, async (req, res) => {
  const token = adminTokenFromRequest(req);
  const input = normalizeUserInput(req.body);
  const validationError = validateUserInput(input);

  if (validationError) {
    res.redirect(buildAdminRedirect(token, validationError));
    return;
  }

  const { data: user, error } = await supabase.from("users").insert(input).select("id, expires_at").single();

  if (error) {
    console.error("Create user failed:", error);
    res.redirect(buildAdminRedirect(token, `创建失败：${error.message}`));
    return;
  }

  const { error: renewalError } = await supabase.from("user_renewals").insert({
    user_id: user.id,
    type: "purchase",
    chars_delta: input.quota_chars,
    expires_at_before: null,
    expires_at_after: input.expires_at,
    note: input.notes || `初始购买 ${input.quota_chars} 字符，有效期 1 年`,
  });

  if (renewalError) {
    console.warn("Record purchase failed:", renewalError.message);
  }

  res.redirect(buildAdminRedirect(token, "用户已创建。"));
});

app.post("/admin/users/:id", requireAdmin, async (req, res) => {
  const token = adminTokenFromRequest(req);
  const { data: existing, error: loadError } = await supabase
    .from("users")
    .select("*")
    .eq("id", req.params.id)
    .single();

  if (loadError || !existing) {
    res.redirect(buildAdminRedirect(token, `保存失败：${loadError?.message || "找不到该用户"}`));
    return;
  }

  const input = normalizeUserInput(req.body, existing);
  const validationError = validateUserInput(input);

  if (validationError) {
    res.redirect(buildAdminRedirect(token, validationError));
    return;
  }

  const { error } = await supabase
    .from("users")
    .update(buildUserUpdatePayload(input))
    .eq("id", existing.id);

  if (error) {
    console.error("Update user failed:", error);
    res.redirect(buildAdminRedirect(token, `保存失败：${error.message}`));
    return;
  }

  res.redirect(buildAdminRedirectWithOptions(token, "用户信息已保存。", { renewUserId: input.line_user_id }));
});

app.post("/admin/users/:id/recharge", requireAdmin, async (req, res) => {
  const token = adminTokenFromRequest(req);
  const lineUserId = String(req.body.line_user_id || "").trim();
  const rechargeChars = parseNonNegativeInteger(req.body.recharge_chars);
  const note = String(req.body.note || "").trim();

  if (rechargeChars <= 0) {
    res.redirect(buildAdminRedirectWithRenewUser(token, "充值流量必须大于 0。", lineUserId));
    return;
  }

  const { data: user, error: loadError } = await supabase
    .from("users")
    .select("id, line_user_id")
    .eq("id", req.params.id)
    .single();

  if (loadError || !user) {
    res.redirect(buildAdminRedirectWithRenewUser(token, `充值失败：${loadError?.message || "找不到该用户"}`, lineUserId));
    return;
  }

  const nextExpiryDate = resolveExpiryDateFromDuration({
    expiry_months: req.body.recharge_months,
    expires_at: req.body.expires_at,
  }, 12);
  if (Number.isNaN(new Date(normalizeExpiryDate(nextExpiryDate)).getTime())) {
    res.redirect(buildAdminRedirectWithRenewUser(token, "充值后有效期格式不正确。", lineUserId));
    return;
  }

  const { data: rechargeData, error: updateError } = await supabase.rpc("recharge_user_flow", {
    p_user_id: user.id,
    p_chars: rechargeChars,
    p_expires_at: normalizeExpiryDate(nextExpiryDate),
  });

  const rechargeResult = Array.isArray(rechargeData) ? rechargeData[0] : null;

  if (updateError || !rechargeResult) {
    console.error("Recharge user failed:", updateError);
    res.redirect(buildAdminRedirectWithRenewUser(token, `充值失败：${updateError?.message || "更新用户失败"}`, user.line_user_id));
    return;
  }

  const { error: renewalError } = await supabase.from("user_renewals").insert({
    user_id: user.id,
    type: "recharge",
    chars_delta: rechargeChars,
    expires_at_before: rechargeResult.expires_at_before,
    expires_at_after: rechargeResult.expires_at,
    note: note || `流量充值 ${rechargeChars} 字符，有效期设置为 ${nextExpiryDate}`,
  });

  if (renewalError) {
    console.warn("Record recharge failed:", renewalError.message);
  }

  res.redirect(buildAdminRedirectWithRenewUser(token, "流量充值已完成。", user.line_user_id));
});

app.post("/admin/conversations/:id", requireAdmin, async (req, res) => {
  const token = adminTokenFromRequest(req);
  const action = String(req.body.action || "save");

  if (action === "unbind") {
    const { error } = await supabase
      .from("conversation_users")
      .delete()
      .eq("id", req.params.id);

    if (error) {
      console.error("Unbind conversation failed:", error);
      res.redirect(buildAdminRedirectWithOptions(token, `解绑失败：${error.message}`, { hash: "conversations" }));
      return;
    }

    res.redirect(buildAdminRedirectWithOptions(token, "群聊绑定已解绑。", { hash: "conversations" }));
    return;
  }

  const lineUserId = String(req.body.line_user_id || "").trim();
  const translationEnabled = String(req.body.translation_enabled || "true") === "true";
  const mode = String(req.body.mode || "").trim();
  const fromLang = req.body.from_lang ? normalizeCode(req.body.from_lang) : "";
  const toLang = req.body.to_lang ? normalizeCode(req.body.to_lang) : "";
  const validModes = new Set(["", "bilingual", "trilingual"]);
  const validLangs = new Set(["", ...ADMIN_LANGUAGE_OPTIONS]);

  if (!validModes.has(mode)) {
    res.redirect(buildAdminRedirectWithOptions(token, "保存失败：群聊模式不正确。", { hash: "conversations" }));
    return;
  }

  if (!validLangs.has(fromLang) || !validLangs.has(toLang)) {
    res.redirect(buildAdminRedirectWithOptions(token, "保存失败：群聊语言不正确。", { hash: "conversations" }));
    return;
  }

  if (mode !== "trilingual" && fromLang && toLang && fromLang === toLang) {
    res.redirect(buildAdminRedirectWithOptions(token, "保存失败：默认语言和互译语言不能相同。", { hash: "conversations" }));
    return;
  }

  const updatePayload = {
    translation_enabled: translationEnabled,
    mode: mode || null,
    from_lang: fromLang || null,
    to_lang: toLang || null,
    updated_at: new Date().toISOString(),
  };

  if (lineUserId) {
    const user = await findUserByLineUserId(lineUserId);
    if (!user) {
      res.redirect(buildAdminRedirectWithOptions(token, `保存失败：找不到 USERID ${lineUserId}`, { hash: "conversations" }));
      return;
    }
    updatePayload.user_id = user.id;
  }

  const { error } = await supabase
    .from("conversation_users")
    .update(updatePayload)
    .eq("id", req.params.id);

  if (error) {
    console.error("Update conversation binding failed:", error);
    res.redirect(buildAdminRedirectWithOptions(token, `保存失败：${error.message}`, { hash: "conversations" }));
    return;
  }

  res.redirect(buildAdminRedirectWithOptions(token, "群聊绑定已保存。", { hash: "conversations" }));
});

app.post("/webhook", line.middleware({ channelSecret: process.env.LINE_CHANNEL_SECRET }), async (req, res) => {
  try {
    const events = req.body.events || [];

    console.log("Webhook received:", {
      eventCount: events.length,
      time: new Date().toISOString(),
    });

    if (LOG_FULL_WEBHOOK_BODY) {
      console.log("Webhook body:");
      console.log(JSON.stringify(redactWebhookBody(req.body), null, 2));
    }

    await Promise.all(
      events.map(async (event) => {
        try {
          await handleEvent(event);
        } catch (error) {
          console.error("Event handling failed:", {
            error: error.message,
            stack: error.stack,
            eventType: event?.type,
            sourceType: event?.source?.type,
            groupId: event?.source?.groupId,
            roomId: event?.source?.roomId,
            userId: event?.source?.userId,
            time: new Date().toISOString(),
          });
        }
      })
    );

    res.status(200).end();
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).end();
  }
});

async function handleEvent(event) {
  console.log("Incoming event:", {
    eventType: event.type,
    messageType: event.message?.type,
    sourceType: event.source?.type,
    groupId: event.source?.groupId,
    roomId: event.source?.roomId,
    userId: event.source?.userId,
    isRedelivery: event.deliveryContext?.isRedelivery,
    time: new Date().toISOString(),
  });

  if (event.type !== "message") return null;
  if (!event.message || event.message.type !== "text") return null;
  if (!["user", "group", "room"].includes(event.source?.type)) return null;
  if (event.deliveryContext?.isRedelivery) return null;

  const lineUserId = event.source?.userId || "";
  if (!lineUserId) return null;

  if (BOT_USER_ID && lineUserId === BOT_USER_ID) {
    console.log("Ignored bot self message:", {
      sourceType: event.source.type,
      userId: lineUserId,
      time: new Date().toISOString(),
    });
    return null;
  }

  const text = event.message.text.trim();
  if (!text) return null;

  const lower = text.toLowerCase();
  const targetCommand = parseTargetLangCommand(text);
  const actorUser = await findUserByLineUserId(lineUserId);
  const actorUserCheck = actorUser ? isUserUsable(actorUser) : { ok: false, reason: "not_found" };
  const bindingKey = getConversationBindingKey(event);

  if (bindingKey && actorUserCheck.ok) {
    await bindConversationToUser(bindingKey, actorUser.id);
  }

  const conversationBinding = bindingKey ? await findConversationBinding(bindingKey) : null;
  const conversationTranslationEnabled = conversationBinding?.translationEnabled !== false;
  const user = actorUser || conversationBinding?.user || null;
  const translationConfig = getEffectiveTranslationConfig(user, conversationBinding);
  const replyLocale = getReplyLocale(user);

  if (isHelpCommand(lower)) {
    return reply(event, buildPublicHelpText(replyLocale));
  }

  if (isUserIdCommand(lower)) {
    return reply(event, buildUserIdText(lineUserId, user, replyLocale));
  }

  if (isGroupIdCommand(lower)) {
    return reply(event, buildGroupIdText(event, lineUserId, replyLocale));
  }

  if (isUsageCommand(lower)) {
    return reply(event, buildUserUsageText(user, replyLocale));
  }

  if (!user) {
    if (event.source?.type === "user") return reply(event, buildNeedPermissionText(lineUserId, replyLocale));
    if (isStatusCommand(lower) || isSetCommand(lower) || targetCommand) {
      return reply(event, buildNeedPermissionText(lineUserId, replyLocale));
    }
    if (bindingKey) {
      console.log("Ignored group message without conversation binding:", {
        sourceType: bindingKey.sourceType,
        conversationId: bindingKey.conversationId,
        lineUserId,
        time: new Date().toISOString(),
      });
    }
    return null;
  }

  if (isStatusCommand(lower)) {
    return reply(event, buildStatusText(event, user, { conversationTranslationEnabled, translationConfig, locale: replyLocale }));
  }

  if (isSetCommand(lower)) {
    const actorLocale = getReplyLocale(actorUser);
    if (!actorUser) return reply(event, buildNeedPermissionText(lineUserId, actorLocale));
    if (!actorUserCheck.ok) {
      return reply(event, buildUserRejectedText(lineUserId, actorUserCheck.reason, actorUser, actorLocale));
    }
    if (bindingKey && (lower === "set on" || lower === "set off")) {
      const enabled = lower === "set on";
      const updated = await setConversationTranslationEnabled(bindingKey, enabled);
      if (!updated) return reply(event, buildSetToggleFailedText(actorLocale));
      await touchUser(actorUser.id);
      return reply(event, buildSetToggleSuccessText(enabled, actorLocale));
    }
    return handleSetCommand(event, lower, actorUser, { bindingKey, locale: actorLocale });
  }

  const userCheck = isUserUsable(user);
  if (!userCheck.ok) {
    if (event.source?.type === "user" || targetCommand) {
      return reply(event, buildUserRejectedText(lineUserId, userCheck.reason, user, replyLocale));
    }
    return null;
  }

  if (text.startsWith("!") || text.startsWith("//")) return null;

  if (targetCommand && !targetCommand.text) {
    return reply(event, buildMissingTargetText(targetCommand.targetLang, replyLocale));
  }

  if (bindingKey && !conversationTranslationEnabled && !targetCommand) return null;

  const textToTranslate = targetCommand?.text || text;
  const mode = translationConfig.mode;
  const fromLang = translationConfig.from_lang;
  const toLang = translationConfig.to_lang;
  const chargeMultiplier = !targetCommand && mode === "trilingual" ? 2 : 1;
  const chargedChars = countChargeableChars(textToTranslate) * chargeMultiplier;

  if (getRemainingChars(user) < chargedChars) {
    return reply(event, buildQuotaExceededText(lineUserId, user, replyLocale));
  }

  const sourceLang = normalizeCode(await detectLang(textToTranslate));
  if (sourceLang === "und") return null;

  recordMessageAnalysis({
    text: textToTranslate,
    language: sourceLang,
    sourceType: event.source?.type || "",
    conversationId: bindingKey?.conversationId || "",
  }).catch((error) => {
    console.warn("Glossary analysis failed:", {
      error: error.message,
      time: new Date().toISOString(),
    });
  });

  const bilingualTargetLang =
    !targetCommand && mode === "bilingual"
      ? getBilingualTargetLang(sourceLang, { from_lang: fromLang, to_lang: toLang })
      : null;

  console.log("Translating:", {
    sourceLang,
    targetLang: targetCommand?.targetLang || "",
    mode,
    sourceType: event.source?.type,
    lineUserId,
    billingLineUserId: user.line_user_id,
    textLength: textToTranslate.length,
    chargedChars,
    time: new Date().toISOString(),
  });

  const messages =
    targetCommand
      ? await buildDirectedMessages(textToTranslate, sourceLang, targetCommand.targetLang)
      : mode === "trilingual"
        ? await buildTrilingualMessages(textToTranslate, sourceLang)
        : await buildDirectedMessages(textToTranslate, sourceLang, bilingualTargetLang);

  if (messages.length === 0) {
    if (event.source?.type === "user" || targetCommand) {
      return reply(event, buildTranslateFailedText(replyLocale));
    }
    return null;
  }

  const charged = await chargeUserUsage(user.id, chargedChars);
  if (!charged) {
    return reply(event, buildQuotaExceededText(lineUserId, user, replyLocale));
  }

  await touchUser(user.id);
  return replyMessages(event, addOriginalQuote(event, messages));
}

function buildNeedPermissionText(lineUserId, locale = "en") {
  const lines = {
    zh: ["请联系管理员添加权限。", `USERID：${lineUserId}`],
    en: ["Please contact the administrator to activate access.", `USERID: ${lineUserId}`],
    th: ["กรุณาติดต่อผู้ดูแลเพื่อเปิดสิทธิ์การใช้งาน", `USERID: ${lineUserId}`],
    ja: ["管理者に連絡して利用権限を有効にしてください。", `USERID: ${lineUserId}`],
  };
  return (lines[locale] || lines.en).join("\n");
}

function buildUserIdText(lineUserId, user, locale = "en") {
  if (!user) {
    const lines = {
      zh: ["当前账号尚未开通权限。", "请联系管理员添加权限。", `USERID：${lineUserId}`],
      en: ["This account is not activated yet.", "Please contact the administrator to activate access.", `USERID: ${lineUserId}`],
      th: ["บัญชีนี้ยังไม่ได้เปิดสิทธิ์", "กรุณาติดต่อผู้ดูแลเพื่อเปิดสิทธิ์การใช้งาน", `USERID: ${lineUserId}`],
      ja: ["このアカウントはまだ有効化されていません。", "管理者に連絡して利用権限を有効にしてください。", `USERID: ${lineUserId}`],
    };
    return (lines[locale] || lines.en).join("\n");
  }

  const lines = {
    zh: [`USERID：${lineUserId}`, "发送 /usage 查看额度。"],
    en: [`USERID: ${lineUserId}`, "Send /usage to check your quota."],
    th: [`USERID: ${lineUserId}`, "ส่ง /usage เพื่อตรวจสอบโควตา"],
    ja: [`USERID: ${lineUserId}`, "/usage を送信すると残量を確認できます。"],
  };
  return (lines[locale] || lines.en).join("\n");
}

function buildGroupIdText(event, lineUserId, locale = "en") {
  if (event.source?.type === "group") {
    const lines = {
      zh: [`群聊ID：${event.source.groupId || ""}`, "可复制该 ID 给管理员查询群聊绑定。"],
      en: [`Group ID: ${event.source.groupId || ""}`, "Send this ID to the administrator to check the group binding."],
      th: [`Group ID: ${event.source.groupId || ""}`, "ส่ง ID นี้ให้ผู้ดูแลเพื่อตรวจสอบการผูกกลุ่ม"],
      ja: [`グループID：${event.source.groupId || ""}`, "このIDを管理者に送ると、グループ連携を確認できます。"],
    };
    return (lines[locale] || lines.en).join("\n");
  }

  if (event.source?.type === "room") {
    const lines = {
      zh: [`聊天室ID：${event.source.roomId || ""}`, "可复制该 ID 给管理员查询群聊绑定。"],
      en: [`Chat room ID: ${event.source.roomId || ""}`, "Send this ID to the administrator to check the chat binding."],
      th: [`Chat room ID: ${event.source.roomId || ""}`, "ส่ง ID นี้ให้ผู้ดูแลเพื่อตรวจสอบการผูกห้องแชท"],
      ja: [`チャットルームID：${event.source.roomId || ""}`, "このIDを管理者に送ると、チャット連携を確認できます。"],
    };
    return (lines[locale] || lines.en).join("\n");
  }

  const lines = {
    zh: ["当前是私聊，没有群聊ID。", `USERID：${lineUserId}`],
    en: ["This is a private chat, so there is no group ID.", `USERID: ${lineUserId}`],
    th: ["นี่คือแชทส่วนตัว จึงไม่มี Group ID", `USERID: ${lineUserId}`],
    ja: ["これは個別チャットのため、グループIDはありません。", `USERID: ${lineUserId}`],
  };
  return (lines[locale] || lines.en).join("\n");
}

function buildUserUsageText(user, locale = "en") {
  if (!user) {
    const lines = {
      zh: ["当前账号尚未开通权限。", "请联系管理员添加权限。", "发送 userid 查看 USERID。"],
      en: ["This account is not activated yet.", "Please contact the administrator to activate access.", "Send userid to check your USERID."],
      th: ["บัญชีนี้ยังไม่ได้เปิดสิทธิ์", "กรุณาติดต่อผู้ดูแลเพื่อเปิดสิทธิ์การใช้งาน", "ส่ง userid เพื่อตรวจสอบ USERID"],
      ja: ["このアカウントはまだ有効化されていません。", "管理者に連絡して利用権限を有効にしてください。", "userid を送信すると USERID を確認できます。"],
    };
    return (lines[locale] || lines.en).join("\n");
  }

  const remainingChars = getStoredRemainingChars(user);
  const quotaChars = getQuotaChars(user);
  const usedChars = getUsedChars(user);

  const builders = {
    zh: () => [
      "当前额度",
      `账号：${user.name}`,
      `状态：${getLocalizedStatusValue(user, locale)}`,
      `有效期至：${formatDate(user.expires_at)}`,
      `总购买字符：${formatNumber(quotaChars)} 字符`,
      `已用字符：${formatNumber(usedChars)} 字符`,
      `剩余字符：${formatNumber(remainingChars)} 字符`,
      user.mode === "trilingual"
        ? "当前为三语模式，普通消息按输入字符 x 2 扣额度。"
        : "当前为双语模式，普通消息按输入字符数扣额度。",
    ],
    en: () => [
      "Current quota",
      `Account: ${user.name}`,
      `Status: ${getLocalizedStatusValue(user, locale)}`,
      `Valid until: ${formatDate(user.expires_at)}`,
      `Total purchased: ${formatNumber(quotaChars)} chars`,
      `Used: ${formatNumber(usedChars)} chars`,
      `Remaining: ${formatNumber(remainingChars)} chars`,
      user.mode === "trilingual"
        ? "Current mode: trilingual. Normal messages use input chars x 2."
        : "Current mode: bilingual. Normal messages use input chars.",
    ],
    th: () => [
      "โควตาปัจจุบัน",
      `บัญชี: ${user.name}`,
      `สถานะ: ${getLocalizedStatusValue(user, locale)}`,
      `ใช้ได้ถึง: ${formatDate(user.expires_at)}`,
      `จำนวนที่ซื้อทั้งหมด: ${formatNumber(quotaChars)} ตัวอักษร`,
      `ใช้ไปแล้ว: ${formatNumber(usedChars)} ตัวอักษร`,
      `คงเหลือ: ${formatNumber(remainingChars)} ตัวอักษร`,
      user.mode === "trilingual"
        ? "ขณะนี้เป็นโหมด 3 ภาษา ข้อความทั่วไปคิดโควตาเป็นจำนวนตัวอักษร x 2"
        : "ขณะนี้เป็นโหมด 2 ภาษา ข้อความทั่วไปคิดโควตาตามจำนวนตัวอักษร",
    ],
    ja: () => [
      "現在の残量",
      `アカウント：${user.name}`,
      `状態：${getLocalizedStatusValue(user, locale)}`,
      `有効期限：${formatDate(user.expires_at)}`,
      `購入文字数：${formatNumber(quotaChars)} 文字`,
      `使用済み：${formatNumber(usedChars)} 文字`,
      `残り：${formatNumber(remainingChars)} 文字`,
      user.mode === "trilingual"
        ? "現在は3言語モードです。通常メッセージは入力文字数 x 2 で消費されます。"
        : "現在は2言語モードです。通常メッセージは入力文字数で消費されます。",
    ],
  };

  return (builders[locale] || builders.en)().join("\n");
}

function buildStatusText(event, user, options = {}) {
  const locale = options.locale || "en";
  const userCheck = isUserUsable(user);
  const config = options.translationConfig || getEffectiveTranslationConfig(user, null);

  const text = {
    zh: {
      title: "当前翻译状态",
      source: "来源",
      username: "用户名",
      valid: "有效",
      status: "状态",
      expires: "有效期至",
      configSource: "配置来源",
      mode: "模式",
      languages: "语言",
      defaultLang: "默认语言",
      pairedLang: "互译语言",
      otherLangs: "其他语言：翻译成默认语言",
      conversationTranslation: "群聊自动翻译",
      usageHint: "发送 /usage 查看额度。",
    },
    en: {
      title: "Current translation status",
      source: "Source",
      username: "Name",
      valid: "Valid",
      status: "Status",
      expires: "Valid until",
      configSource: "Config source",
      mode: "Mode",
      languages: "Languages",
      defaultLang: "Default language",
      pairedLang: "Paired language",
      otherLangs: "Other languages: translated to the default language",
      conversationTranslation: "Group auto-translation",
      usageHint: "Send /usage to check your quota.",
    },
    th: {
      title: "สถานะการแปลปัจจุบัน",
      source: "แหล่งที่มา",
      username: "ชื่อบัญชี",
      valid: "ใช้งานได้",
      status: "สถานะ",
      expires: "ใช้ได้ถึง",
      configSource: "แหล่งที่มาของการตั้งค่า",
      mode: "โหมด",
      languages: "ภาษา",
      defaultLang: "ภาษาเริ่มต้น",
      pairedLang: "ภาษาคู่แปล",
      otherLangs: "ภาษาอื่นจะแปลเป็นภาษาเริ่มต้น",
      conversationTranslation: "แปลอัตโนมัติในกลุ่ม",
      usageHint: "ส่ง /usage เพื่อตรวจสอบโควตา",
    },
    ja: {
      title: "現在の翻訳状態",
      source: "送信元",
      username: "ユーザー名",
      valid: "利用可能",
      status: "状態",
      expires: "有効期限",
      configSource: "設定元",
      mode: "モード",
      languages: "言語",
      defaultLang: "初期言語",
      pairedLang: "相互翻訳言語",
      otherLangs: "その他の言語：初期言語に翻訳",
      conversationTranslation: "グループ自動翻訳",
      usageHint: "/usage を送信すると残量を確認できます。",
    },
  }[locale] || {};

  const lines = [text.title, ""];

  lines.push(`${text.source}: ${getLocalizedConversationLabel(event, locale)}`);
  lines.push(`USERID: ${event.source?.userId || ""}`);
  lines.push(`${text.username}: ${user.name}`);
  lines.push(`${text.valid}: ${getLocalizedYesNo(userCheck.ok, locale)}`);
  lines.push(`${text.status}: ${getLocalizedStatusValue(user, locale)}`);
  lines.push(`${text.expires}: ${formatDate(user.expires_at)}`);
  lines.push(`${text.configSource}: ${getLocalizedConfigSource(config.source, locale)}`);
  lines.push(`${text.mode}: ${getLocalizedModeName(config.mode, locale)}`);
  if (config.mode === "trilingual") {
    lines.push(`${text.languages}: 中文 / ภาษาไทย / မြန်မာဘာသာ`);
  } else {
    lines.push(`${text.defaultLang}: ${getLangName(config.from_lang)}`);
    lines.push(`${text.pairedLang}: ${getLangName(config.to_lang)}`);
    lines.push(text.otherLangs);
  }
  if (getConversationBindingKey(event)) {
    lines.push(`${text.conversationTranslation}: ${getLocalizedOnOff(options.conversationTranslationEnabled !== false, locale)}`);
  }
  lines.push("");
  lines.push(text.usageHint);

  return lines.join("\n");
}

function buildUserRejectedText(lineUserId, reason, user, locale = "en") {
  if (reason === "status") {
    const lines = {
      zh: ["账号已暂停，请联系管理员。", `USERID：${lineUserId}`],
      en: ["This account is paused. Please contact the administrator.", `USERID: ${lineUserId}`],
      th: ["บัญชีนี้ถูกระงับ กรุณาติดต่อผู้ดูแล", `USERID: ${lineUserId}`],
      ja: ["このアカウントは一時停止中です。管理者に連絡してください。", `USERID: ${lineUserId}`],
    };
    return (lines[locale] || lines.en).join("\n");
  }
  if (reason === "expired") {
    const lines = {
      zh: ["账号有效期已过，请联系管理员充值流量。", `USERID：${lineUserId}`, `有效期至：${formatDate(user?.expires_at)}`],
      en: ["This account has expired. Please contact the administrator to recharge.", `USERID: ${lineUserId}`, `Valid until: ${formatDate(user?.expires_at)}`],
      th: ["บัญชีนี้หมดอายุแล้ว กรุณาติดต่อผู้ดูแลเพื่อเติมโควตา", `USERID: ${lineUserId}`, `ใช้ได้ถึง: ${formatDate(user?.expires_at)}`],
      ja: ["このアカウントは期限切れです。管理者に連絡してチャージしてください。", `USERID: ${lineUserId}`, `有効期限：${formatDate(user?.expires_at)}`],
    };
    return (lines[locale] || lines.en).join("\n");
  }
  if (reason === "quota") {
    return buildQuotaExceededText(lineUserId, user, locale);
  }
  return buildNeedPermissionText(lineUserId, locale);
}

function buildQuotaExceededText(lineUserId, user, locale = "en") {
  const remaining = formatNumber(getStoredRemainingChars(user));
  const lines = {
    zh: ["当前字符余额不足，请联系管理员充值流量。", `USERID：${lineUserId}`, `剩余字符：${remaining} 字符`],
    en: ["Not enough character quota. Please contact the administrator to recharge.", `USERID: ${lineUserId}`, `Remaining: ${remaining} chars`],
    th: ["โควตาตัวอักษรไม่เพียงพอ กรุณาติดต่อผู้ดูแลเพื่อเติมโควตา", `USERID: ${lineUserId}`, `คงเหลือ: ${remaining} ตัวอักษร`],
    ja: ["文字数残量が不足しています。管理者に連絡してチャージしてください。", `USERID: ${lineUserId}`, `残り：${remaining} 文字`],
  };
  return (lines[locale] || lines.en).join("\n");
}

function buildPublicHelpText(locale = "en") {
  const builders = {
    zh: () => [
      "常用命令",
      "userid       查看 USERID",
      "/groupid    查看当前群聊ID",
      "/usage      查看额度",
      "/status     查看当前状态",
      "set on      开启群聊自动翻译",
      "set off     关闭群聊自动翻译，只保留指定翻译",
      "set 3lang   开启中文 / 泰文 / 缅文三语模式",
      "",
      "指定翻译方法",
      ...getDirectTranslationHelpLines(locale),
      "",
      "设置默认翻译语言",
      "私聊中设置用户默认；群聊中设置当前群聊。",
      "支持任意两种语言组合。",
      "其他语言会翻译成第一种默认语言。",
      ...getTranslationPairHelpLines(locale),
    ],
    en: () => [
      "Common commands",
      "userid       Show USERID",
      "/groupid    Show current group ID",
      "/usage      Check quota",
      "/status     Show current status",
      "set on      Turn on group auto-translation",
      "set off     Turn off group auto-translation; directed translation still works",
      "set 3lang   Turn on Chinese / Thai / Burmese trilingual mode",
      "",
      "Directed translation",
      ...getDirectTranslationHelpLines(locale),
      "",
      "Set default translation languages",
      "In private chat: sets your default. In group chat: sets this chat only.",
      "Any two supported languages can be paired.",
      "Other languages will be translated to the first default language.",
      ...getTranslationPairHelpLines(locale),
    ],
    th: () => [
      "คำสั่งที่ใช้บ่อย",
      "userid       ดู USERID",
      "/groupid    ดู ID ของกลุ่มปัจจุบัน",
      "/usage      ตรวจสอบโควตา",
      "/status     ดูสถานะปัจจุบัน",
      "set on      เปิดการแปลอัตโนมัติในกลุ่ม",
      "set off     ปิดการแปลอัตโนมัติในกลุ่ม แต่ยังใช้คำสั่งแปลแบบระบุภาษาได้",
      "set 3lang   เปิดโหมด 3 ภาษา จีน / ไทย / พม่า",
      "",
      "แปลแบบระบุภาษา",
      ...getDirectTranslationHelpLines(locale),
      "",
      "ตั้งค่าภาษาแปลเริ่มต้น",
      "ในแชทส่วนตัว: ตั้งค่าเริ่มต้นของคุณ ในกลุ่ม: ตั้งค่าเฉพาะกลุ่มนี้",
      "สามารถจับคู่ภาษาใดก็ได้ 2 ภาษา",
      "ภาษาอื่นจะแปลเป็นภาษาเริ่มต้นภาษาแรก",
      ...getTranslationPairHelpLines(locale),
    ],
    ja: () => [
      "よく使うコマンド",
      "userid       USERIDを表示",
      "/groupid    現在のグループIDを表示",
      "/usage      残量を確認",
      "/status     現在の状態を表示",
      "set on      グループ自動翻訳をオン",
      "set off     グループ自動翻訳をオフ。指定翻訳は利用できます",
      "set 3lang   中国語 / タイ語 / ミャンマー語の3言語モードをオン",
      "",
      "指定翻訳",
      ...getDirectTranslationHelpLines(locale),
      "",
      "初期翻訳言語の設定",
      "個別チャットではユーザー初期設定、グループでは現在のチャットだけを設定します。",
      "対応言語から任意の2言語を組み合わせできます。",
      "その他の言語は1つ目の初期言語に翻訳されます。",
      ...getTranslationPairHelpLines(locale),
    ],
  };

  return (builders[locale] || builders.en)().join("\n");
}

function buildSetToggleFailedText(locale = "en") {
  return {
    zh: "切换群聊翻译开关失败，请稍后再试。",
    en: "Failed to change the group translation switch. Please try again later.",
    th: "เปลี่ยนสถานะการแปลในกลุ่มไม่สำเร็จ กรุณาลองใหม่ภายหลัง",
    ja: "グループ翻訳スイッチの変更に失敗しました。しばらくしてから再試行してください。",
  }[locale] || "Failed to change the group translation switch. Please try again later.";
}

function buildSetToggleSuccessText(enabled, locale = "en") {
  if (enabled) {
    return {
      zh: "群聊自动翻译已开启。",
      en: "Group auto-translation is on.",
      th: "เปิดการแปลอัตโนมัติในกลุ่มแล้ว",
      ja: "グループ自動翻訳をオンにしました。",
    }[locale] || "Group auto-translation is on.";
  }

  return {
    zh: "群聊自动翻译已关闭。\n之后只有 /TH、/ZH、/MM 等指定翻译命令会触发翻译。",
    en: "Group auto-translation is off.\nOnly directed commands such as /TH, /ZH, and /MM will trigger translation.",
    th: "ปิดการแปลอัตโนมัติในกลุ่มแล้ว\nต่อจากนี้เฉพาะคำสั่งระบุภาษา เช่น /TH, /ZH, /MM เท่านั้นที่จะเรียกการแปล",
    ja: "グループ自動翻訳をオフにしました。\n今後は /TH、/ZH、/MM などの指定翻訳コマンドだけが翻訳を実行します。",
  }[locale] || "Group auto-translation is off.\nOnly directed commands such as /TH, /ZH, and /MM will trigger translation.";
}

function buildSetTrilingualFailedText(isConversationConfig, locale = "en") {
  const lines = {
    zh: isConversationConfig ? "切换当前群聊三语模式失败，请稍后再试。" : "切换三语模式失败，请稍后再试。",
    en: isConversationConfig ? "Failed to switch this chat to trilingual mode. Please try again later." : "Failed to switch to trilingual mode. Please try again later.",
    th: isConversationConfig ? "เปลี่ยนแชทนี้เป็นโหมด 3 ภาษาไม่สำเร็จ กรุณาลองใหม่ภายหลัง" : "เปลี่ยนเป็นโหมด 3 ภาษาไม่สำเร็จ กรุณาลองใหม่ภายหลัง",
    ja: isConversationConfig ? "このチャットを3言語モードに切り替えられませんでした。しばらくしてから再試行してください。" : "3言語モードに切り替えられませんでした。しばらくしてから再試行してください。",
  };
  return lines[locale] || lines.en;
}

function buildSetTrilingualSuccessText(isConversationConfig, locale = "en") {
  const builders = {
    zh: () => [
      isConversationConfig ? "当前群聊三语模式已开启。" : "三语模式已开启。",
      "中文 / ภาษาไทย / မြန်မာဘာသာ 三语互译。",
      "每条消息按 输入字符数 x 2 扣额度。",
      "",
      "切回双语：set zh th",
    ],
    en: () => [
      isConversationConfig ? "This chat is now in trilingual mode." : "Trilingual mode is on.",
      "Chinese / Thai / Burmese will be translated between each other.",
      "Each normal message uses input chars x 2.",
      "",
      "Switch back to bilingual: set zh th",
    ],
    th: () => [
      isConversationConfig ? "เปิดโหมด 3 ภาษาในแชทนี้แล้ว" : "เปิดโหมด 3 ภาษาแล้ว",
      "จีน / ไทย / พม่า จะแปลถึงกัน",
      "แต่ละข้อความทั่วไปคิดโควตาเป็นจำนวนตัวอักษร x 2",
      "",
      "กลับไปโหมด 2 ภาษา: set zh th",
    ],
    ja: () => [
      isConversationConfig ? "このチャットの3言語モードをオンにしました。" : "3言語モードをオンにしました。",
      "中国語 / タイ語 / ミャンマー語を相互翻訳します。",
      "通常メッセージは入力文字数 x 2 で消費されます。",
      "",
      "2言語モードに戻す：set zh th",
    ],
  };

  return (builders[locale] || builders.en)().join("\n");
}

function buildSetLanguageFailedText(isConversationConfig, locale = "en") {
  const lines = {
    zh: isConversationConfig ? "切换当前群聊语言失败，请稍后再试。" : "切换语言失败，请稍后再试。",
    en: isConversationConfig ? "Failed to change this chat's languages. Please try again later." : "Failed to change languages. Please try again later.",
    th: isConversationConfig ? "เปลี่ยนภาษาของแชทนี้ไม่สำเร็จ กรุณาลองใหม่ภายหลัง" : "เปลี่ยนภาษาไม่สำเร็จ กรุณาลองใหม่ภายหลัง",
    ja: isConversationConfig ? "このチャットの言語を切り替えられませんでした。しばらくしてから再試行してください。" : "言語を切り替えられませんでした。しばらくしてから再試行してください。",
  };
  return lines[locale] || lines.en;
}

function buildSetLanguageSuccessText(isConversationConfig, fromLang, toLang, locale = "en") {
  const builders = {
    zh: () => [
      `${isConversationConfig ? "当前群聊已切换" : "已切换"}：${getLangName(fromLang)} ↔ ${getLangName(toLang)}`,
      `默认语言：${getLangName(fromLang)}`,
      `其他语言会翻译成：${getLangName(fromLang)}`,
      "",
      "发送 set 3lang 可切换到三语模式。",
    ],
    en: () => [
      `${isConversationConfig ? "This chat has been switched" : "Switched"}: ${getLangName(fromLang)} ↔ ${getLangName(toLang)}`,
      `Default language: ${getLangName(fromLang)}`,
      `Other languages will be translated to: ${getLangName(fromLang)}`,
      "",
      "Send set 3lang to switch to trilingual mode.",
    ],
    th: () => [
      `${isConversationConfig ? "เปลี่ยนภาษาของแชทนี้แล้ว" : "เปลี่ยนภาษาแล้ว"}: ${getLangName(fromLang)} ↔ ${getLangName(toLang)}`,
      `ภาษาเริ่มต้น: ${getLangName(fromLang)}`,
      `ภาษาอื่นจะแปลเป็น: ${getLangName(fromLang)}`,
      "",
      "ส่ง set 3lang เพื่อเปลี่ยนเป็นโหมด 3 ภาษา",
    ],
    ja: () => [
      `${isConversationConfig ? "このチャットを切り替えました" : "切り替えました"}：${getLangName(fromLang)} ↔ ${getLangName(toLang)}`,
      `初期言語：${getLangName(fromLang)}`,
      `その他の言語は次に翻訳されます：${getLangName(fromLang)}`,
      "",
      "set 3lang を送信すると3言語モードに切り替えられます。",
    ],
  };

  return (builders[locale] || builders.en)().join("\n");
}

function buildSameLanguageText(locale = "en") {
  return {
    zh: "默认语言和互译语言不能相同。",
    en: "The default language and paired language cannot be the same.",
    th: "ภาษาเริ่มต้นและภาษาคู่แปลต้องไม่เหมือนกัน",
    ja: "初期言語と相互翻訳言語を同じにすることはできません。",
  }[locale] || "The default language and paired language cannot be the same.";
}

function buildMissingTargetText(targetLang, locale = "en") {
  const command = `/${targetLang.toUpperCase()}`;
  return {
    zh: `请输入要翻译的内容，例如：${command} 你好`,
    en: `Please enter text to translate, for example: ${command} hello`,
    th: `กรุณาใส่ข้อความที่ต้องการแปล เช่น ${command} สวัสดี`,
    ja: `翻訳するテキストを入力してください。例：${command} こんにちは`,
  }[locale] || `Please enter text to translate, for example: ${command} hello`;
}

function buildTranslateFailedText(locale = "en") {
  return {
    zh: "暂时无法完成翻译，请稍后再试或换一种表达。",
    en: "Translation is temporarily unavailable. Please try again later or rephrase.",
    th: "ขณะนี้ยังแปลไม่ได้ กรุณาลองใหม่ภายหลังหรือเปลี่ยนวิธีเขียน",
    ja: "一時的に翻訳できません。しばらくしてから再試行するか、別の表現にしてください。",
  }[locale] || "Translation is temporarily unavailable. Please try again later or rephrase.";
}

async function handleSetCommand(event, lower, user, options = {}) {
  const parts = lower.trim().split(/\s+/);
  const sub = parts[1];
  const bindingKey = options.bindingKey || null;
  const isConversationConfig = Boolean(bindingKey);
  const locale = options.locale || getReplyLocale(user);

  async function saveConfig(payload) {
    if (isConversationConfig) {
      return setConversationLanguageConfig(bindingKey, payload);
    }

    const { error } = await supabase
      .from("users")
      .update({
        ...payload,
        updated_at: new Date().toISOString(),
        last_active_at: new Date().toISOString(),
      })
      .eq("id", user.id);

    if (error) {
      console.error("Update user language config failed:", error);
      return false;
    }

    return true;
  }

  if (sub === "3lang") {
    const saved = await saveConfig({
      mode: "trilingual",
      from_lang: "zh",
      to_lang: "th",
    });

    if (!saved) {
      return reply(event, buildSetTrilingualFailedText(isConversationConfig, locale));
    }

    await touchUser(user.id);
    return reply(event, buildSetTrilingualSuccessText(isConversationConfig, getReplyLocaleFromLang("zh")));
  }

  if (parts.length === 3) {
    const a = normalizeCode(parts[1]);
    const b = normalizeCode(parts[2]);

    if (!isSupportedDefaultLang(a) || !isSupportedDefaultLang(b)) {
      return reply(event, buildSetHelpText(getUnsupportedLanguageTitle(locale), locale));
    }

    if (a === b) {
      return reply(event, buildSameLanguageText(locale));
    }

    const saved = await saveConfig({
      mode: "bilingual",
      from_lang: a,
      to_lang: b,
    });

    if (!saved) {
      return reply(event, buildSetLanguageFailedText(isConversationConfig, locale));
    }

    await touchUser(user.id);
    return reply(event, buildSetLanguageSuccessText(isConversationConfig, a, b, getReplyLocaleFromLang(a)));
  }

  await touchUser(user.id);
  return reply(event, buildSetHelpText(getSetUsageTitle(locale), locale));
}

function getUnsupportedLanguageTitle(locale) {
  return {
    zh: "不支持该语言，可用命令示例：",
    en: "Unsupported language. Examples:",
    th: "ไม่รองรับภาษานี้ ตัวอย่างคำสั่ง:",
    ja: "この言語には対応していません。コマンド例：",
  }[locale] || "Unsupported language. Examples:";
}

function getSetUsageTitle(locale) {
  return {
    zh: "set 命令用法：",
    en: "How to use set:",
    th: "วิธีใช้คำสั่ง set:",
    ja: "set コマンドの使い方：",
  }[locale] || "How to use set:";
}

function buildSetHelpText(title, locale = "en") {
  const builders = {
    zh: () => [
      title,
      "",
      ...getDirectTranslationHelpLines(locale),
      "",
      "可设置的默认翻译语言：",
      "私聊中设置用户默认；群聊中设置当前群聊。",
      "支持任意两种语言组合。",
      "其他语言会翻译成第一种默认语言。",
      ...getTranslationPairHelpLines(locale),
      "",
      "set on       开启群聊自动翻译",
      "set off      关闭群聊自动翻译，只保留 /TH 等指定翻译",
      "",
      "/status      查看当前状态",
      "/usage       查看额度",
      "/groupid     查看当前群聊ID",
      "userid       查看 USERID",
    ],
    en: () => [
      title,
      "",
      ...getDirectTranslationHelpLines(locale),
      "",
      "Default translation languages:",
      "In private chat: sets your default. In group chat: sets this chat only.",
      "Any two supported languages can be paired.",
      "Other languages will be translated to the first default language.",
      ...getTranslationPairHelpLines(locale),
      "",
      "set on       Turn on group auto-translation",
      "set off      Turn off group auto-translation; /TH and other directed commands still work",
      "",
      "/status      Show current status",
      "/usage       Check quota",
      "/groupid     Show current group ID",
      "userid       Show USERID",
    ],
    th: () => [
      title,
      "",
      ...getDirectTranslationHelpLines(locale),
      "",
      "ภาษาที่ตั้งเป็นค่าเริ่มต้นได้:",
      "ในแชทส่วนตัว: ตั้งค่าเริ่มต้นของคุณ ในกลุ่ม: ตั้งค่าเฉพาะกลุ่มนี้",
      "สามารถจับคู่ภาษาใดก็ได้ 2 ภาษา",
      "ภาษาอื่นจะแปลเป็นภาษาเริ่มต้นภาษาแรก",
      ...getTranslationPairHelpLines(locale),
      "",
      "set on       เปิดการแปลอัตโนมัติในกลุ่ม",
      "set off      ปิดการแปลอัตโนมัติในกลุ่ม แต่ /TH และคำสั่งระบุภาษาอื่นยังใช้ได้",
      "",
      "/status      ดูสถานะปัจจุบัน",
      "/usage       ตรวจสอบโควตา",
      "/groupid     ดู ID ของกลุ่มปัจจุบัน",
      "userid       ดู USERID",
    ],
    ja: () => [
      title,
      "",
      ...getDirectTranslationHelpLines(locale),
      "",
      "設定できる初期翻訳言語：",
      "個別チャットではユーザー初期設定、グループでは現在のチャットだけを設定します。",
      "対応言語から任意の2言語を組み合わせできます。",
      "その他の言語は1つ目の初期言語に翻訳されます。",
      ...getTranslationPairHelpLines(locale),
      "",
      "set on       グループ自動翻訳をオン",
      "set off      グループ自動翻訳をオフ。/TH などの指定翻訳は利用できます",
      "",
      "/status      現在の状態を表示",
      "/usage       残量を確認",
      "/groupid     現在のグループIDを表示",
      "userid       USERIDを表示",
    ],
  };

  return (builders[locale] || builders.en)().join("\n");
}

async function buildBilingualMessages(text, sourceLang, activation) {
  const targetLang = getBilingualTargetLang(sourceLang, activation);
  if (!targetLang) return [];
  return buildDirectedMessages(text, sourceLang, targetLang);
}

async function buildDirectedMessages(text, sourceLang, targetLang) {
  const normalizedSource = normalizeCode(sourceLang);
  const normalizedTarget = normalizeCode(targetLang);
  if (normalizedSource === normalizedTarget) return [];

  const translated = await callTranslate(text, normalizedTarget, normalizedSource);
  if (!translated || translated.trim() === text) return [];

  return [{ type: "text", text: buildTranslationLine(normalizedTarget, translated) }];
}

async function buildTrilingualMessages(text, sourceLang) {
  if (!THREE_LANGS.includes(sourceLang)) return [];

  const targets = THREE_LANGS.filter((lang) => lang !== sourceLang);
  if (targets.length === 0) return [];

  const results = await Promise.all(
    targets.map(async (targetLang) => ({
      targetLang,
      translated: await callTranslate(text, targetLang, sourceLang),
    }))
  );

  const lines = [];
  const separator = "\n\n";
  let remainingLength = MAX_LINE_TEXT_LENGTH;

  for (const { targetLang, translated } of results) {
    if (!translated || translated.trim() === text) continue;

    const line = buildTranslationLine(
      targetLang,
      translated,
      remainingLength - (lines.length > 0 ? separator.length : 0)
    );
    if (!line) break;

    lines.push(line);
    remainingLength -= line.length + (lines.length > 1 ? separator.length : 0);
  }

  if (lines.length === 0) return [];
  return [{ type: "text", text: lines.join(separator) }];
}

function buildTranslationPrefix(targetLang) {
  return `${getLangFlag(targetLang)} ${getLangShortLabel(targetLang)}：`;
}

function buildTranslationLine(targetLang, translated, maxLength = MAX_LINE_TEXT_LENGTH) {
  const prefix = buildTranslationPrefix(targetLang);
  const availableLength = maxLength - prefix.length;
  if (availableLength <= 0) return "";
  return `${prefix}${translated.slice(0, availableLength)}`;
}

async function detectLang(text) {
  if (/[\u1000-\u109F]/.test(text)) return "my";
  if (/[\u0E00-\u0E7F]/.test(text)) return "th";
  if (/[\u3040-\u30FF]/.test(text)) return "ja";
  if (TRADITIONAL_CHINESE_HINT_RE.test(text)) return "zh-TW";
  if (/[\u4E00-\u9FFF]/.test(text)) return "zh";

  try {
    const [detection] = await translateClient.detect(text);
    const first = Array.isArray(detection) ? detection[0] : detection;
    return first?.language || "und";
  } catch (error) {
    console.error("Detect language failed:", error.message);
    return "und";
  }
}

async function callTranslate(text, targetLang, sourceLang) {
  const source = normalizeCode(sourceLang);
  const target = normalizeCode(targetLang);
  const cacheKey = `${source}|${target}|${text}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const options = { to: toGoogleCode(target) };
    const googleSource = toGoogleCode(source);

    if (googleSource) {
      options.from = googleSource;
    }

    const [result] = await translateClient.translate(text, options);
    setCache(cacheKey, result);
    return result;
  } catch (error) {
    console.error("Translate API failed:", {
      error: error.message,
      source,
      target,
      time: new Date().toISOString(),
    });
    return null;
  }
}

async function reply(event, text) {
  return replyMessages(event, [{ type: "text", text }]);
}

function addOriginalQuote(event, messages) {
  const quoteToken = event.message?.quoteToken;
  if (!quoteToken || !Array.isArray(messages) || messages.length === 0) return messages;

  return messages.map((message, index) => {
    if (index !== 0 || message.type !== "text") return message;
    return { ...message, quoteToken };
  });
}

async function replyMessages(event, messages) {
  try {
    console.log("Replying:", {
      sourceType: event.source?.type,
      groupId: event.source?.groupId,
      roomId: event.source?.roomId,
      userId: event.source?.userId,
      messageCount: messages.length,
      time: new Date().toISOString(),
    });

    return await lineClient.replyMessage({
      replyToken: event.replyToken,
      messages,
    });
  } catch (error) {
    console.error("LINE reply failed:", {
      error: error.message,
      sourceType: event.source?.type,
      groupId: event.source?.groupId,
      roomId: event.source?.roomId,
      userId: event.source?.userId,
      time: new Date().toISOString(),
    });
    return null;
  }
}

app.use((error, _req, res, _next) => {
  console.error("Application error:", error);
  if (!res.headersSent) {
    res.status(500).json({ ok: false, message: "Internal Server Error" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`LINE translate bot running on port ${PORT}`);
  console.log(`Bot user ID configured: ${BOT_USER_ID ? "yes" : "no"}`);
});
