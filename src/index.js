// =========================
// LINE 翻译机器人
// USERID 授权版 · Supabase/PostgreSQL 持久化
// =========================

const express = require("express");
const line = require("@line/bot-sdk");
const crypto = require("crypto");
const { Translate } = require("@google-cloud/translate").v2;
const { createClient } = require("@supabase/supabase-js");

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

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);

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

const VALID_LANG_PAIRS = new Set([
  "my|zh",
  "th|zh",
  "en|zh",
  "my|th",
  "en|th",
  "en|my",
]);

const LANG_NAME = {
  zh: "中文",
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

const translationCache = new Map();

function normalizeCode(code) {
  if (!code) return "und";
  const value = String(code).toLowerCase();
  if (value.startsWith("zh")) return "zh";
  return value;
}

function toGoogleCode(code) {
  const normalized = normalizeCode(code);
  if (normalized === "zh") return "zh-CN";
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

function getConversationLabel(event) {
  if (event.source?.type === "group") return "群聊";
  if (event.source?.type === "room") return "多人聊天室";
  if (event.source?.type === "user") return "私聊";
  return "未知来源";
}

function isUserIdCommand(lower) {
  return lower === "userid" || lower === "/userid" || lower === "user id" || lower === "/user id";
}

function isStatusCommand(lower) {
  return lower === "/status" || lower === "/lang" || lower === "/状态";
}

function isUsageCommand(lower) {
  return lower === "/usage" || lower === "/用量";
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

function getCurrentBillingPeriod() {
  return getBangkokDateString().slice(0, 7);
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
  return addMonthsToDateString(getBangkokDateString(), 1);
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

function getEffectiveMonthlyUsedChars(user) {
  if (!user) return 0;
  if (user.billing_period && user.billing_period !== getCurrentBillingPeriod()) return 0;
  return Number(user.monthly_used_chars || 0);
}

function getMonthlyRemainingChars(user) {
  return Math.max(0, Number(user?.monthly_quota_chars || 0) - getEffectiveMonthlyUsedChars(user));
}

function getExtraRemainingChars(user) {
  return Math.max(0, Number(user?.extra_quota_chars || 0) - Number(user?.extra_used_chars || 0));
}

function isUserExpired(user) {
  if (!user?.expires_at) return true;
  return new Date(user.expires_at).getTime() <= Date.now();
}

function getRemainingChars(user) {
  if (!user || isUserExpired(user) || user.status !== "active") return 0;
  return getMonthlyRemainingChars(user) + getExtraRemainingChars(user);
}

function isUserUsable(user) {
  if (!user) return { ok: false, reason: "not_found" };
  if (user.status !== "active") return { ok: false, reason: "status" };
  if (isUserExpired(user)) return { ok: false, reason: "expired" };
  if (getRemainingChars(user) <= 0) return { ok: false, reason: "quota" };
  return { ok: true, reason: "" };
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
    .select("user_id, translation_enabled")
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
    user,
  };
}

async function bindConversationToUser(bindingKey, userId) {
  if (!bindingKey?.conversationId || !userId) return;

  const { error } = await supabase
    .from("conversation_users")
    .upsert(
      {
        source_type: bindingKey.sourceType,
        conversation_id: bindingKey.conversationId,
        user_id: userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "source_type,conversation_id" }
    );

  if (error) {
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
  return {
    line_user_id: String(body.line_user_id || "").trim(),
    name: String(body.name || "").trim(),
    status: String(body.status || "active").trim(),
    mode: String(body.mode || "bilingual").trim(),
    from_lang: normalizeCode(body.from_lang || "zh"),
    to_lang: normalizeCode(body.to_lang || "th"),
    monthly_quota_chars:
      body.monthly_quota_chars === undefined
        ? parseNonNegativeInteger(existing.monthly_quota_chars)
        : parseNonNegativeInteger(body.monthly_quota_chars),
    monthly_used_chars:
      body.monthly_used_chars === undefined
        ? parseNonNegativeInteger(existing.monthly_used_chars)
        : parseNonNegativeInteger(body.monthly_used_chars),
    extra_quota_chars:
      body.extra_quota_chars === undefined
        ? parseNonNegativeInteger(existing.extra_quota_chars)
        : parseNonNegativeInteger(body.extra_quota_chars),
    extra_used_chars:
      body.extra_used_chars === undefined
        ? parseNonNegativeInteger(existing.extra_used_chars)
        : parseNonNegativeInteger(body.extra_used_chars),
    billing_period: getCurrentBillingPeriod(),
    expires_at: normalizeExpiryDate(body.expires_at || defaultExpiryDate()),
    notes: String(body.notes || "").trim() || null,
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
  if (input.mode === "bilingual" && input.from_lang === input.to_lang) return "源语言和目标语言不能相同。";
  if (!input.expires_at || Number.isNaN(new Date(input.expires_at).getTime())) {
    return "到期日期格式不正确，例如：2026-06-15";
  }
  if (input.monthly_used_chars > input.monthly_quota_chars) return "月度已用不能大于月度额度。";
  if (input.extra_used_chars > input.extra_quota_chars) return "加油包已用不能大于加油包额度。";

  return "";
}

function buildAdminRedirect(token, message) {
  const params = new URLSearchParams();
  if (token) params.set("token", token);
  if (message) params.set("message", message);
  const query = params.toString();
  return query ? `/admin?${query}` : "/admin";
}

function buildAdminRedirectWithRenewUser(token, message, lineUserId) {
  const params = new URLSearchParams();
  if (token) params.set("token", token);
  if (message) params.set("message", message);
  if (lineUserId) params.set("renew_userid", lineUserId);
  const query = params.toString();
  return query ? `/admin?${query}` : "/admin";
}

function parseAdminListLimit(value) {
  const parsed = Number.parseInt(value || "20", 10);
  return [20, 50, 100].includes(parsed) ? parsed : 20;
}

async function loadAdminData(renewUserId = "", listLimit = 20) {
  const now = new Date().toISOString();
  const trimmedRenewUserId = String(renewUserId || "").trim();
  const safeLimit = parseAdminListLimit(listLimit);
  const queries = [
    supabase
      .from("users")
      .select("*")
      .eq("status", "active")
      .gte("expires_at", now)
      .order("expires_at", { ascending: true })
      .limit(safeLimit),
    supabase
      .from("users")
      .select("*")
      .or(`expires_at.lt.${now},status.eq.paused`)
      .order("expires_at", { ascending: false })
      .limit(safeLimit),
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
  const [{ data: activeUsers, error: activeError }, { data: expiredUsers, error: expiredError }] =
    results;
  const renewResult = results[2];

  if (activeError) throw activeError;
  if (expiredError) throw expiredError;
  if (renewResult?.error) throw renewResult.error;

  return {
    activeUsers: activeUsers || [],
    expiredUsers: expiredUsers || [],
    renewUser: renewResult?.data || null,
    renewUserId: trimmedRenewUserId,
    renewUserNotFound: Boolean(trimmedRenewUserId && !renewResult?.data),
    listLimit: safeLimit,
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

function renderLanguageOptions(selectedValue = "zh") {
  const selected = normalizeCode(selectedValue || "zh");
  return ADMIN_LANGUAGE_OPTIONS.map(
    (code) => `<option value="${code}" ${selected === code ? "selected" : ""}>${getLangShortLabel(code)}</option>`
  ).join("");
}

function renderListLimitOptions(selectedValue = 20) {
  const selected = parseAdminListLimit(selectedValue);
  return [20, 50, 100]
    .map((value) => `<option value="${value}" ${selected === value ? "selected" : ""}>${value} 条</option>`)
    .join("");
}

function renderReadonlyMetric(label, value) {
  return `<div class="metric"><b>${escapeHtml(label)}</b><span>${escapeHtml(value)}</span></div>`;
}

function renderAdminLogin(errorMessage) {
  const googleConfigured = isGoogleAdminConfigured();
  const tokenConfigured = Boolean(ADMIN_TOKEN);

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LINE 翻译机器人管理</title>
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

function renderUserRows(users) {
  return (users || [])
    .map((user) => {
      const monthlyUsed = getEffectiveMonthlyUsedChars(user);
      const monthlyRemaining = isUserExpired(user) ? 0 : getMonthlyRemainingChars(user);
      const extraRemaining = isUserExpired(user) ? 0 : getExtraRemainingChars(user);
      const totalRemaining = getRemainingChars(user);
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
            到期 ${escapeHtml(formatDateInput(user.expires_at))} · 月剩 ${formatNumber(monthlyRemaining)} · 加油包剩 ${formatNumber(extraRemaining)} · 总剩 ${formatNumber(totalRemaining)}
          </span>
        </summary>

        <div class="user-body">
          <div class="metric-grid">
            ${renderReadonlyMetric("用户名", user.name)}
            ${renderReadonlyMetric("USERID", user.line_user_id)}
            ${renderReadonlyMetric("状态", status)}
            ${renderReadonlyMetric("到期日期", formatDate(user.expires_at))}
            ${renderReadonlyMetric("模式", mode)}
            ${renderReadonlyMetric("语言", languages)}
            ${renderReadonlyMetric("月度额度", `${formatNumber(user.monthly_quota_chars)} 字符`)}
            ${renderReadonlyMetric("月度已用", `${formatNumber(monthlyUsed)} 字符`)}
            ${renderReadonlyMetric("月度剩余", `${formatNumber(monthlyRemaining)} 字符`)}
            ${renderReadonlyMetric("加油包额度", `${formatNumber(user.extra_quota_chars || 0)} 字符`)}
            ${renderReadonlyMetric("加油包已用", `${formatNumber(user.extra_used_chars || 0)} 字符`)}
            ${renderReadonlyMetric("加油包剩余", `${formatNumber(extraRemaining)} 字符`)}
            ${renderReadonlyMetric("总剩余", `${formatNumber(totalRemaining)} 字符`)}
            ${renderReadonlyMetric("最近使用", formatDate(user.last_active_at))}
            ${renderReadonlyMetric("备注", user.notes || "-")}
          </div>
        </div>
      </details>`;
    })
    .join("");
}

function renderRenewalPanel({ renewUser, renewUserId, renewUserNotFound, token }) {
  const monthlyUsed = getEffectiveMonthlyUsedChars(renewUser);
  const monthlyRemaining = renewUser && !isUserExpired(renewUser) ? getMonthlyRemainingChars(renewUser) : 0;
  const extraRemaining = renewUser && !isUserExpired(renewUser) ? getExtraRemainingChars(renewUser) : 0;
  const totalRemaining = renewUser ? getRemainingChars(renewUser) : 0;
  const userStatus = renewUser
    ? isUserExpired(renewUser)
      ? "已过期"
      : renewUser.status
    : "";

  return `<section class="panel">
      <h2>续费模块</h2>
      <form method="get" action="/admin" class="lookup-form">
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
              <div class="metric-grid">
                ${renderReadonlyMetric("用户名", renewUser.name)}
                ${renderReadonlyMetric("USERID", renewUser.line_user_id)}
                ${renderReadonlyMetric("状态", userStatus)}
                ${renderReadonlyMetric("到期日期", formatDate(renewUser.expires_at))}
                ${renderReadonlyMetric("月度额度", `${formatNumber(renewUser.monthly_quota_chars)} 字符`)}
                ${renderReadonlyMetric("月度已用", `${formatNumber(monthlyUsed)} 字符`)}
                ${renderReadonlyMetric("月度剩余", `${formatNumber(monthlyRemaining)} 字符`)}
                ${renderReadonlyMetric("加油包额度", `${formatNumber(renewUser.extra_quota_chars || 0)} 字符`)}
                ${renderReadonlyMetric("加油包已用", `${formatNumber(renewUser.extra_used_chars || 0)} 字符`)}
                ${renderReadonlyMetric("加油包剩余", `${formatNumber(extraRemaining)} 字符`)}
                ${renderReadonlyMetric("总剩余", `${formatNumber(totalRemaining)} 字符`)}
                ${renderReadonlyMetric("最近使用", formatDate(renewUser.last_active_at))}
              </div>

              <div class="renew-actions">
                <form method="post" action="/admin/users/${escapeHtml(renewUser.id)}/renew-monthly" class="renew-card">
                  <input type="hidden" name="token" value="${escapeHtml(token)}">
                  <input type="hidden" name="line_user_id" value="${escapeHtml(renewUser.line_user_id)}">
                  <h3>月度续费</h3>
                  <div class="renew-grid compact">
                    <label>续费月数
                      <select name="months">
                        <option value="1">1 个月</option>
                        <option value="3">3 个月</option>
                        <option value="6">6 个月</option>
                        <option value="12">12 个月</option>
                      </select>
                    </label>
                    <label>月度额度
                      <select name="monthly_quota_chars">${renderQuotaOptions(renewUser.monthly_quota_chars || 100000)}</select>
                    </label>
                    <label class="wide">备注<input name="note" placeholder="收款/订单备注"></label>
                  </div>
                  <div class="form-actions">
                    <label class="check"><input name="reset_monthly_used" type="checkbox" checked> 清零月度已用</label>
                    <button type="submit">提交月度续费</button>
                  </div>
                </form>

                <form method="post" action="/admin/users/${escapeHtml(renewUser.id)}/topup" class="renew-card">
                  <input type="hidden" name="token" value="${escapeHtml(token)}">
                  <input type="hidden" name="line_user_id" value="${escapeHtml(renewUser.line_user_id)}">
                  <h3>加油包充值</h3>
                  <div class="renew-grid compact">
                    <label>增加额度
                      <select name="topup_chars">${renderQuotaOptions(100000)}</select>
                    </label>
                    <label class="wide">备注<input name="note" placeholder="收款/订单备注"></label>
                  </div>
                  <p class="meta">加油包只增加额外字符，不改变到期日；账号过期后加油包不可用。</p>
                  <div class="form-actions">
                    <button type="submit">提交加油包充值</button>
                  </div>
                </form>
              </div>
            </div>`
          : `<p class="meta">输入 USERID 并点击检索后，可查看用户基本信息、月度续费和加油包充值选项。</p>`
      }
    </section>`;
}

function renderAdminPage({ activeUsers, expiredUsers, renewUser, renewUserId, renewUserNotFound, listLimit, token, message, adminEmail }) {
  const defaultExpiry = defaultExpiryDate();
  const safeListLimit = parseAdminListLimit(listLimit);

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LINE 翻译机器人管理</title>
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
    .grid { display: grid; grid-template-columns: repeat(4, minmax(180px, 1fr)); gap: 14px; align-items: start; }
    .create-grid { display: grid; grid-template-columns: repeat(4, minmax(180px, 1fr)); gap: 12px 14px; align-items: start; }
    .wide { grid-column: span 2; }
    .full { grid-column: 1 / -1; }
    .inline-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: end; }
    label { display: flex; flex-direction: column; gap: 6px; min-width: 0; font-size: 13px; color: #4b5870; }
    input, select { box-sizing: border-box; width: 100%; height: 38px; padding: 8px 10px; border: 1px solid #b7c2d1; border-radius: 6px; font-size: 14px; line-height: 20px; background: #fff; }
    input[type="checkbox"] { width: 16px; height: 16px; padding: 0; flex: 0 0 auto; }
    .field-row { display: grid; grid-template-columns: minmax(92px, .9fr) minmax(130px, 1.1fr); gap: 8px; }
    code { background: #eef2f7; padding: 2px 5px; border-radius: 4px; }
    button { padding: 9px 13px; border: 0; border-radius: 6px; background: #1f6feb; color: #fff; font-weight: 700; cursor: pointer; }
    button.secondary { background: #536078; }
    summary { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 12px 14px; cursor: pointer; }
    summary::-webkit-details-marker { display: none; }
    .summary-main, .summary-stats { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .summary-stats { color: #536078; font-size: 13px; justify-content: flex-end; }
    .badge { background: #e8f2ff; color: #175cd3; border-radius: 999px; padding: 2px 8px; font-size: 12px; }
    .danger-badge { background: #fff1f0; color: #a8071a; }
    .user-body { border-top: 1px solid #e8edf3; padding: 14px; }
    .quota-strip { display: grid; grid-template-columns: 1fr 1fr 1.2fr; gap: 12px; margin-bottom: 14px; }
    .quota-strip div { background: #f8fafc; border: 1px solid #e8edf3; border-radius: 6px; padding: 10px; }
    .quota-strip b, .quota-strip span { display: block; }
    .quota-strip span { color: #536078; font-size: 13px; margin-top: 4px; }
    .renew-grid { display: grid; grid-template-columns: minmax(240px, 1.4fr) minmax(150px, 1fr) minmax(150px, 1fr) minmax(150px, 1fr); gap: 14px; align-items: start; }
    .renew-grid.compact { grid-template-columns: repeat(2, minmax(180px, 1fr)); }
    .lookup-form { display: grid; grid-template-columns: minmax(260px, 1fr) auto; gap: 12px; align-items: end; }
    .metric-grid { display: grid; grid-template-columns: repeat(4, minmax(160px, 1fr)); gap: 10px; margin-top: 14px; }
    .metric { background: #f8fafc; border: 1px solid #e8edf3; border-radius: 6px; padding: 9px 10px; min-height: 38px; box-sizing: border-box; }
    .metric b, .metric span { display: block; }
    .metric b { color: #4b5870; font-size: 12px; font-weight: 600; }
    .metric span { color: #172033; font-size: 14px; margin-top: 3px; overflow-wrap: anywhere; }
    .renew-user { border-top: 1px solid #e8edf3; margin-top: 14px; padding-top: 14px; }
    .renew-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 14px; }
    .renew-card { border: 1px solid #e8edf3; border-radius: 8px; padding: 14px; background: #fbfcfe; }
    .renew-card h3 { margin: 0 0 12px; font-size: 16px; }
    .list-toolbar { display: flex; align-items: end; justify-content: space-between; gap: 14px; margin-top: 24px; flex-wrap: wrap; }
    .list-toolbar h2 { margin: 0; }
    .limit-form { display: flex; align-items: end; gap: 10px; }
    .limit-form label { width: 130px; }
    .form-actions { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 14px; }
    .check { display: inline-flex; flex-direction: row; align-items: center; gap: 8px; min-height: 38px; color: #4b5870; }
    .check input { width: 16px; }
    .meta { color: #536078; font-size: 13px; margin: 10px 0 0; }
    .message { background: #ecfdf3; border: 1px solid #abefc6; color: #067647; padding: 10px 12px; border-radius: 6px; margin-bottom: 14px; }
    .message.error { background: #fff1f0; border-color: #ffccc7; color: #a8071a; margin-top: 14px; }
    @media (max-width: 860px) {
      .grid, .create-grid, .quota-strip, .renew-grid, .renew-grid.compact, .field-row, .lookup-form, .metric-grid, .renew-actions, .inline-row { grid-template-columns: 1fr; }
      .wide { grid-column: span 1; }
      .list-toolbar { align-items: stretch; flex-direction: column; }
      .limit-form { align-items: stretch; }
      .limit-form label { width: 100%; }
      summary { align-items: flex-start; flex-direction: column; }
      .summary-stats { justify-content: flex-start; }
      main { padding: 14px; }
    }
  </style>
</head>
<body>
  <header><h1>LINE 翻译机器人管理</h1><p class="meta">当前管理员：${escapeHtml(adminEmail || "unknown")} · <a href="/admin/logout">退出</a></p></header>
  <main>
    ${message ? `<div class="message">${escapeHtml(message)}</div>` : ""}

    <section class="panel">
      <h2>新增用户</h2>
      <form method="post" action="/admin/users">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <div class="create-grid">
          <label>USERID<input name="line_user_id" placeholder="Uxxxxxxxxxxxxxxxx" required></label>
          <label>用户名<input name="name" placeholder="后台自定义名称" required></label>
          <label>月度额度<select name="monthly_quota_chars">${renderQuotaOptions(100000)}</select></label>
          <label>状态
            <select name="status">
              <option value="active">active</option>
              <option value="paused">paused</option>
            </select>
          </label>
          <input type="hidden" name="mode" value="bilingual">
          <label>源语言<select name="from_lang">${renderLanguageOptions("zh")}</select></label>
          <label>目标语言<select name="to_lang">${renderLanguageOptions("th")}</select></label>
          <label>到期日期
            <span class="field-row">
              <select class="expiry-preset" data-target="new-expires-at">
                <option value="1" selected>1 个月</option>
                <option value="3">3 个月</option>
                <option value="6">6 个月</option>
                <option value="12">12 个月</option>
                <option value="custom">自定义</option>
              </select>
              <input id="new-expires-at" name="expires_at" type="date" value="${escapeHtml(defaultExpiry)}">
            </span>
          </label>
          <input type="hidden" name="monthly_used_chars" value="0">
          <input type="hidden" name="extra_quota_chars" value="0">
          <input type="hidden" name="extra_used_chars" value="0">
          <div class="full inline-row">
            <label>备注<input name="notes" placeholder="收款/套餐/客户备注"></label>
            <button type="submit">创建用户</button>
          </div>
        </div>
      </form>
    </section>

    ${renderRenewalPanel({ renewUser, renewUserId, renewUserNotFound, token })}

    <div class="list-toolbar">
      <h2>有效用户（即将到期优先，前 ${safeListLimit} 条）</h2>
      <form method="get" action="/admin" class="limit-form">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        ${renewUserId ? `<input type="hidden" name="renew_userid" value="${escapeHtml(renewUserId)}">` : ""}
        <label>显示数量<select name="limit">${renderListLimitOptions(safeListLimit)}</select></label>
        <button type="submit" class="secondary">应用</button>
      </form>
    </div>
    ${renderUserRows(activeUsers) || '<section class="panel">暂无有效用户。</section>'}

    <h2>过期用户（刚刚过期优先，前 ${safeListLimit} 条）</h2>
    ${renderUserRows(expiredUsers) || '<section class="panel">暂无过期用户。</section>'}
  </main>
  <script>
    (() => {
      const today = new Date();
      const pad = (value) => String(value).padStart(2, "0");
      const formatDate = (date) => [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("-");
      const addMonths = (months) => {
        const next = new Date(today);
        const day = next.getDate();
        next.setMonth(next.getMonth() + Number(months || 1));
        if (next.getDate() !== day) next.setDate(0);
        return formatDate(next);
      };

      document.querySelectorAll(".expiry-preset").forEach((select) => {
        select.addEventListener("change", () => {
          const target = document.getElementById(select.dataset.target);
          if (!target || select.value === "custom") return;
          target.value = addMonths(select.value);
        });
      });
    })();
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
    service: "line-translate-bot-userid",
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

app.get("/admin", requireAdmin, async (req, res) => {
  try {
    const data = await loadAdminData(req.query.renew_userid || "", req.query.limit || "20");
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

  const { error } = await supabase.from("users").insert(input);

  if (error) {
    console.error("Create user failed:", error);
    res.redirect(buildAdminRedirect(token, `创建失败：${error.message}`));
    return;
  }

  res.redirect(buildAdminRedirect(token, "用户已创建。"));
});

app.post("/admin/users/:id/renew-monthly", requireAdmin, async (req, res) => {
  const token = adminTokenFromRequest(req);
  const lineUserId = String(req.body.line_user_id || "").trim();
  const chars = parseNonNegativeInteger(req.body.monthly_quota_chars);
  const months = Math.max(1, Number.parseInt(req.body.months || "1", 10) || 1);
  const note = String(req.body.note || "").trim();

  if (chars <= 0) {
    res.redirect(buildAdminRedirectWithRenewUser(token, "月度续费额度必须大于 0。", lineUserId));
    return;
  }

  const { data: user, error: loadError } = await supabase
    .from("users")
    .select("*")
    .eq("id", req.params.id)
    .single();

  if (loadError || !user) {
    res.redirect(buildAdminRedirectWithRenewUser(token, `月度续费失败：${loadError?.message || "找不到该用户"}`, lineUserId));
    return;
  }

  const today = getBangkokDateString();
  const currentExpiry = formatDateInput(user.expires_at);
  const baseDate =
    currentExpiry && new Date(`${currentExpiry}T23:59:59+07:00`).getTime() > Date.now()
      ? currentExpiry
      : today;
  const nextExpiryDate = addMonthsToDateString(baseDate, months);
  const patch = {
    status: "active",
    monthly_quota_chars: chars,
    expires_at: normalizeExpiryDate(nextExpiryDate),
    billing_period: getCurrentBillingPeriod(),
    updated_at: new Date().toISOString(),
  };

  if (req.body.reset_monthly_used === "on") patch.monthly_used_chars = 0;

  const { error: updateError } = await supabase.from("users").update(patch).eq("id", user.id);

  if (updateError) {
    console.error("Renew user failed:", updateError);
    res.redirect(buildAdminRedirectWithRenewUser(token, `月度续费失败：${updateError.message}`, user.line_user_id));
    return;
  }

  const { error: renewalError } = await supabase.from("user_renewals").insert({
    user_id: user.id,
    type: "monthly",
    chars_delta: chars,
    expires_at_before: user.expires_at,
    expires_at_after: patch.expires_at,
    note: note || `月度续费 ${months} 个月，月度额度 ${chars} 字符`,
  });

  if (renewalError) {
    console.warn("Record renewal failed:", renewalError.message);
  }

  res.redirect(buildAdminRedirectWithRenewUser(token, "月度续费已完成。", user.line_user_id));
});

app.post("/admin/users/:id/topup", requireAdmin, async (req, res) => {
  const token = adminTokenFromRequest(req);
  const lineUserId = String(req.body.line_user_id || "").trim();
  const topupChars = parseNonNegativeInteger(req.body.topup_chars);
  const note = String(req.body.note || "").trim();

  if (topupChars <= 0) {
    res.redirect(buildAdminRedirectWithRenewUser(token, "加油包额度必须大于 0。", lineUserId));
    return;
  }

  const { data: user, error: loadError } = await supabase
    .from("users")
    .select("*")
    .eq("id", req.params.id)
    .single();

  if (loadError || !user) {
    res.redirect(buildAdminRedirectWithRenewUser(token, `加油包充值失败：${loadError?.message || "找不到该用户"}`, lineUserId));
    return;
  }

  const { error: updateError } = await supabase
    .from("users")
    .update({
      extra_quota_chars: Number(user.extra_quota_chars || 0) + topupChars,
      updated_at: new Date().toISOString(),
    })
    .eq("id", user.id);

  if (updateError) {
    console.error("Topup user failed:", updateError);
    res.redirect(buildAdminRedirectWithRenewUser(token, `加油包充值失败：${updateError.message}`, user.line_user_id));
    return;
  }

  const { error: renewalError } = await supabase.from("user_renewals").insert({
    user_id: user.id,
    type: "topup",
    chars_delta: topupChars,
    expires_at_before: user.expires_at,
    expires_at_after: user.expires_at,
    note: note || `加油包充值 ${topupChars} 字符`,
  });

  if (renewalError) {
    console.warn("Record topup failed:", renewalError.message);
  }

  res.redirect(buildAdminRedirectWithRenewUser(token, "加油包充值已完成。", user.line_user_id));
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
  const bindingKey = getConversationBindingKey(event);

  if (bindingKey && actorUser) {
    await bindConversationToUser(bindingKey, actorUser.id);
  }

  const conversationBinding = bindingKey ? await findConversationBinding(bindingKey) : null;
  const conversationTranslationEnabled = conversationBinding?.translationEnabled !== false;
  const user = actorUser || conversationBinding?.user || null;

  if (isUserIdCommand(lower) || isUsageCommand(lower)) {
    return reply(event, buildUserUsageText(lineUserId, user));
  }

  if (!user) {
    if (event.source?.type === "user") return reply(event, buildNeedPermissionText(lineUserId));
    if (isStatusCommand(lower) || isSetCommand(lower) || targetCommand) {
      return reply(event, buildNeedPermissionText(lineUserId));
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
    return reply(event, buildStatusText(event, user, { conversationTranslationEnabled }));
  }

  if (isSetCommand(lower)) {
    if (!actorUser) return reply(event, buildNeedPermissionText(lineUserId));
    if (bindingKey && (lower === "set on" || lower === "set off")) {
      const enabled = lower === "set on";
      const updated = await setConversationTranslationEnabled(bindingKey, enabled);
      if (!updated) return reply(event, "切换群聊翻译开关失败，请稍后再试。");
      await touchUser(actorUser.id);
      return reply(event, enabled ? "群聊自动翻译已开启。" : "群聊自动翻译已关闭。\n之后只有 /TH、/ZH、/MM 等指定翻译命令会触发翻译。");
    }
    return handleSetCommand(event, lower, user);
  }

  const userCheck = isUserUsable(user);
  if (!userCheck.ok) {
    if (event.source?.type === "user" || targetCommand) {
      return reply(event, buildUserRejectedText(lineUserId, userCheck.reason, user));
    }
    return null;
  }

  if (text.startsWith("!") || text.startsWith("//")) return null;

  if (targetCommand && !targetCommand.text) {
    return reply(event, `请输入要翻译的内容，例如：/${targetCommand.targetLang.toUpperCase()} 你好`);
  }

  if (bindingKey && !conversationTranslationEnabled && !targetCommand) return null;

  const textToTranslate = targetCommand?.text || text;
  const mode = user.mode || "bilingual";
  const fromLang = user.from_lang || "zh";
  const toLang = user.to_lang || "th";
  const chargeMultiplier = !targetCommand && mode === "trilingual" ? 2 : 1;
  const chargedChars = countChargeableChars(textToTranslate) * chargeMultiplier;

  if (getRemainingChars(user) < chargedChars) {
    return reply(event, buildQuotaExceededText(lineUserId, user));
  }

  const sourceLang = normalizeCode(await detectLang(textToTranslate));
  if (sourceLang === "und") return null;

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
        : await buildBilingualMessages(textToTranslate, sourceLang, { from_lang: fromLang, to_lang: toLang });

  if (messages.length === 0) return null;

  const charged = await chargeUserUsage(user.id, chargedChars);
  if (!charged) {
    return reply(event, buildQuotaExceededText(lineUserId, user));
  }

  await touchUser(user.id);
  return replyMessages(event, addOriginalQuote(event, messages));
}

function buildNeedPermissionText(lineUserId) {
  return [`请联系管理员添加权限。`, `USERID：${lineUserId}`].join("\n");
}

function buildUserUsageText(lineUserId, user) {
  if (!user) {
    return [`当前账号尚未开通权限。`, `请联系管理员添加权限。`, `USERID：${lineUserId}`].join("\n");
  }

  const expired = isUserExpired(user);
  const monthlyRemaining = expired ? 0 : getMonthlyRemainingChars(user);
  const extraRemaining = expired ? 0 : getExtraRemainingChars(user);

  return [
    `USERID：${lineUserId}`,
    `用户名：${user.name}`,
    `状态：${expired ? "已过期" : user.status}`,
    `有效期：${formatDate(user.expires_at)}`,
    `月度剩余：${formatNumber(monthlyRemaining)} 字符`,
    `加油包剩余：${formatNumber(extraRemaining)} 字符`,
    `总剩余：${formatNumber(getRemainingChars(user))} 字符`,
  ].join("\n");
}

function buildStatusText(event, user, options = {}) {
  const userCheck = isUserUsable(user);
  const lines = ["当前翻译状态", ""];

  lines.push(`来源：${getConversationLabel(event)}`);
  lines.push(`USERID：${event.source?.userId || ""}`);
  lines.push(`用户名：${user.name}`);
  lines.push(`有效：${userCheck.ok ? "是" : "否"}`);
  lines.push(`状态：${isUserExpired(user) ? "已过期" : user.status}`);
  lines.push(`到期时间：${formatDate(user.expires_at)}`);
  lines.push(`模式：${user.mode === "trilingual" ? "三语模式" : "双语模式"}`);
  if (user.mode === "trilingual") {
    lines.push("语言：中文 / ภาษาไทย / မြန်မာဘာသာ");
  } else {
    lines.push(`语言：${getLangName(user.from_lang)} ↔ ${getLangName(user.to_lang)}`);
  }
  if (getConversationBindingKey(event)) {
    lines.push(`群聊自动翻译：${options.conversationTranslationEnabled === false ? "关闭" : "开启"}`);
  }
  lines.push("");
  lines.push("发送 /usage 查看额度。");

  return lines.join("\n");
}

function buildUserRejectedText(lineUserId, reason, user) {
  if (reason === "status") {
    return [`账号已暂停，请联系管理员。`, `USERID：${lineUserId}`].join("\n");
  }
  if (reason === "expired") {
    return [`账号已过期，请联系管理员续费。`, `USERID：${lineUserId}`, `到期日期：${formatDate(user?.expires_at)}`].join("\n");
  }
  if (reason === "quota") {
    return buildQuotaExceededText(lineUserId, user);
  }
  return buildNeedPermissionText(lineUserId);
}

function buildQuotaExceededText(lineUserId, user) {
  return [
    "当前字符额度不足，请联系管理员续费或购买加油包。",
    `USERID：${lineUserId}`,
    `月度剩余：${formatNumber(isUserExpired(user) ? 0 : getMonthlyRemainingChars(user))} 字符`,
    `加油包剩余：${formatNumber(isUserExpired(user) ? 0 : getExtraRemainingChars(user))} 字符`,
    `总剩余：${formatNumber(getRemainingChars(user))} 字符`,
  ].join("\n");
}

async function handleSetCommand(event, lower, user) {
  const parts = lower.trim().split(/\s+/);
  const sub = parts[1];

  if (sub === "3lang") {
    const { error } = await supabase
      .from("users")
      .update({
        mode: "trilingual",
        from_lang: "zh",
        to_lang: "th",
        updated_at: new Date().toISOString(),
        last_active_at: new Date().toISOString(),
      })
      .eq("id", user.id);

    if (error) {
      console.error("Update user language mode failed:", error);
      return reply(event, "切换三语模式失败，请稍后再试。");
    }

    return reply(
      event,
      [
        "三语模式已开启。",
        "中文 / ภาษาไทย / မြန်မာဘာသာ 三语互译。",
        "每条消息按 输入字符数 x 2 扣额度。",
        "",
        "切回双语：set zh th",
      ].join("\n")
    );
  }

  if (parts.length === 3) {
    const a = normalizeCode(parts[1]);
    const b = normalizeCode(parts[2]);
    const pairKey = [a, b].sort().join("|");

    if (!VALID_LANG_PAIRS.has(pairKey)) {
      return reply(event, buildSetHelpText("不支持该语言对，可用命令："));
    }

    const { error } = await supabase
      .from("users")
      .update({
        mode: "bilingual",
        from_lang: a,
        to_lang: b,
        updated_at: new Date().toISOString(),
        last_active_at: new Date().toISOString(),
      })
      .eq("id", user.id);

    if (error) {
      console.error("Update user language pair failed:", error);
      return reply(event, "切换语言失败，请稍后再试。");
    }

    return reply(event, `已切换：${getLangName(a)} ↔ ${getLangName(b)}\n\n发送 set 3lang 可切换到三语模式。`);
  }

  await touchUser(user.id);
  return reply(event, buildSetHelpText("set 命令用法："));
}

function buildSetHelpText(title) {
  return [
    title,
    "",
    "/TH 内容    指定翻译成泰文",
    "/MM 内容    指定翻译成缅文",
    "/ZH 内容    指定翻译成中文",
    "/EN 内容    指定翻译成英文",
    "/JP 内容    指定翻译成日文",
    "/DE /FR /ES  指定翻译成德/法/西",
    "/RU 内容    指定翻译成俄文",
    "/MS 内容    指定翻译成马来文",
    "/KO 内容    指定翻译成韩文",
    "/ID 内容    指定翻译成印尼文",
    "/VI 内容    指定翻译成越南文",
    "/HI 内容    指定翻译成印地文",
    "/AR 内容    指定翻译成阿拉伯文",
    "",
    "set on       开启群聊自动翻译",
    "set off      关闭群聊自动翻译，只保留 /TH 等指定翻译",
    "",
    "/status      查看当前状态",
    "/usage       查看额度",
    "userid       查看 USERID 和用量",
  ].join("\n");
}

async function buildBilingualMessages(text, sourceLang, activation) {
  const langFrom = normalizeCode(activation.from_lang || "zh");
  const langTo = normalizeCode(activation.to_lang || "th");

  let targetLang;
  if (sourceLang === langFrom) {
    targetLang = langTo;
  } else if (sourceLang === langTo) {
    targetLang = langFrom;
  } else {
    targetLang = "zh";
  }

  if (sourceLang === targetLang) return [];

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
  let remainingLength = MAX_LINE_TEXT_LENGTH;

  for (const { targetLang, translated } of results) {
    if (!translated || translated.trim() === text) continue;

    const line = buildTranslationLine(
      targetLang,
      translated,
      remainingLength - (lines.length > 0 ? 1 : 0)
    );
    if (!line) break;

    lines.push(line);
    remainingLength -= line.length + (lines.length > 1 ? 1 : 0);
  }

  if (lines.length === 0) return [];
  return [{ type: "text", text: lines.join("\n") }];
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
