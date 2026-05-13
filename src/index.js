// =========================
// LINE 群聊翻译机器人
// 商业激活码版 · Supabase/PostgreSQL 持久化
// =========================

const express = require("express");
const line = require("@line/bot-sdk");
const { Translate } = require("@google-cloud/translate").v2;
const { createClient } = require("@supabase/supabase-js");

const PORT = process.env.PORT || 3001;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const BOT_USER_ID = process.env.BOT_USER_ID || "";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const ADMIN_TAILSCALE_ONLY = process.env.ADMIN_TAILSCALE_ONLY !== "false";
const LOG_FULL_WEBHOOK_BODY = process.env.LOG_FULL_WEBHOOK_BODY === "true";
const MAX_LINE_TEXT_LENGTH = 4900;
const CACHE_MAX_SIZE = 200;
const BILLING_TIME_ZONE = "Asia/Bangkok";

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

const middlewareConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
});

const translateClient = new Translate();

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
};

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

function getConversation(event) {
  const source = event.source || {};

  if (source.type === "group" && source.groupId) {
    return { id: `group:${source.groupId}`, sourceType: "group", label: "群聊" };
  }

  if (source.type === "room" && source.roomId) {
    return { id: `room:${source.roomId}`, sourceType: "room", label: "多人聊天室" };
  }

  if (source.type === "user" && source.userId) {
    return { id: `user:${source.userId}`, sourceType: "user", label: "私聊" };
  }

  return { id: null, sourceType: "unknown", label: "未知来源" };
}

function buildDefaultActivation(conversation) {
  return {
    conversation_id: conversation.id,
    source_type: conversation.sourceType,
    enabled: true,
    mode: "bilingual",
    from_lang: "zh",
    to_lang: "th",
  };
}

function buildActivationFromTemplate(conversation, template = {}) {
  return {
    ...buildDefaultActivation(conversation),
    enabled: true,
    mode: template.mode || "bilingual",
    from_lang: template.from_lang || "zh",
    to_lang: template.to_lang || "th",
  };
}

function isActivateCommand(text) {
  return /^\/?(?:activate|激活)(?:\s+|$)/i.test(text.trim());
}

function parseActivationCode(text) {
  const match = text.trim().match(/^\/?(?:activate|激活)\s+(.+)$/i);
  return match ? match[1].trim() : "";
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

function isCustomerUsable(customer) {
  if (!customer) return { ok: false, reason: "not_found" };
  if (!customer.activation_code_enabled) return { ok: false, reason: "code_disabled" };
  if (!["active", "trial"].includes(customer.status)) return { ok: false, reason: "status" };
  if (customer.expires_at && new Date(customer.expires_at).getTime() <= Date.now()) {
    return { ok: false, reason: "expired" };
  }
  if (getRemainingChars(customer) <= 0) {
    return { ok: false, reason: "quota" };
  }
  return { ok: true, reason: "" };
}

function getBangkokDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: BILLING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  return {
    year: Number(parts.find((part) => part.type === "year")?.value || 0),
    month: Number(parts.find((part) => part.type === "month")?.value || 0),
    day: Number(parts.find((part) => part.type === "day")?.value || 0),
  };
}

function getCurrentBillingPeriod(cycleDay = 1) {
  const safeCycleDay = Math.min(28, Math.max(1, Number.parseInt(cycleDay || "1", 10) || 1));
  const { year, month, day } = getBangkokDateParts();
  let periodYear = year;
  let periodMonth = month;

  if (day < safeCycleDay) {
    periodMonth -= 1;
    if (periodMonth < 1) {
      periodMonth = 12;
      periodYear -= 1;
    }
  }

  return `${String(periodYear).padStart(4, "0")}-${String(periodMonth).padStart(2, "0")}`;
}

function formatBillingPeriodStart(period, cycleDay = 1) {
  const [year, month] = String(period || "").split("-").map((part) => Number.parseInt(part, 10));
  if (!year || !month) return "";
  const day = Math.min(28, Math.max(1, Number.parseInt(cycleDay || "1", 10) || 1));
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function formatNextBillingReset(customer) {
  const currentPeriod = getCurrentBillingPeriod(customer?.billing_cycle_day);
  const [year, month] = currentPeriod.split("-").map((part) => Number.parseInt(part, 10));
  if (!year || !month) return "";

  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const day = Math.min(28, Math.max(1, Number.parseInt(customer?.billing_cycle_day || "1", 10) || 1));
  return `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function getEffectiveMonthlyUsedChars(customer) {
  if (!customer) return 0;
  if (customer.billing_period && customer.billing_period !== getCurrentBillingPeriod(customer.billing_cycle_day)) return 0;
  return Number(customer.used_chars || 0);
}

function getMonthlyRemainingChars(customer) {
  return Math.max(0, Number(customer?.quota_chars || 0) - getEffectiveMonthlyUsedChars(customer));
}

function getExtraRemainingChars(customer) {
  return Math.max(0, Number(customer?.extra_quota_chars || 0) - Number(customer?.extra_used_chars || 0));
}

function getRemainingChars(customer) {
  return getMonthlyRemainingChars(customer) + getExtraRemainingChars(customer);
}

function countChargeableChars(text) {
  return Array.from(text || "").length;
}

function formatDate(value) {
  if (!value) return "未设置";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().slice(0, 10);
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function adminTokenFromRequest(req) {
  return req.query.token || req.body?.token || req.get("x-admin-token") || "";
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
  if (!ADMIN_TOKEN) {
    res.status(503).send("Admin page is disabled. Set ADMIN_TOKEN in .env to enable it.");
    return;
  }

  const remoteAddress = getRemoteAddress(req);
  const requestHost = getRequestHost(req);
  const isPrivateAdminRequest =
    isLocalOrTailscaleAddress(remoteAddress) || isLocalOrTailscaleAddress(requestHost);

  if (ADMIN_TAILSCALE_ONLY && !isPrivateAdminRequest) {
    res.status(403).send("Admin page is only available from localhost or Tailscale.");
    return;
  }

  if (adminTokenFromRequest(req) !== ADMIN_TOKEN) {
    res.status(401).send(renderAdminLogin(req.query.error || ""));
    return;
  }

  next();
}

function parseNonNegativeInteger(value) {
  return Math.max(0, Number.parseInt(value || "0", 10) || 0);
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
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BILLING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value || "";
  const month = parts.find((part) => part.type === "month")?.value || "";
  const day = parts.find((part) => part.type === "day")?.value || "";
  return year && month && day ? `${year}-${month}-${day}` : String(value).slice(0, 10);
}

function normalizeCustomerInput(body) {
  const billingCycleDay = Math.min(28, Math.max(1, Number.parseInt(body.billing_cycle_day || "1", 10) || 1));

  return {
    name: String(body.name || "").trim(),
    activation_code: String(body.activation_code || "").trim(),
    activation_code_enabled: body.activation_code_enabled === "on",
    status: String(body.status || "active").trim(),
    quota_chars: parseNonNegativeInteger(body.quota_chars),
    used_chars: parseNonNegativeInteger(body.used_chars),
    extra_quota_chars: parseNonNegativeInteger(body.extra_quota_chars),
    extra_used_chars: parseNonNegativeInteger(body.extra_used_chars),
    billing_cycle_day: billingCycleDay,
    billing_period: getCurrentBillingPeriod(billingCycleDay),
    expires_at: normalizeExpiryDate(body.expires_at),
    notes: String(body.notes || "").trim() || null,
  };
}

function validateCustomerInput(input) {
  const validStatuses = new Set(["active", "trial", "paused", "expired", "cancelled"]);

  if (!input.name) return "客户名称不能为空。";
  if (!input.activation_code) return "激活码不能为空。";
  if (!validStatuses.has(input.status)) return "客户状态不正确。";
  if (!input.expires_at || Number.isNaN(new Date(input.expires_at).getTime())) {
    return "到期日期格式不正确，例如：2026-06-12";
  }
  if (input.used_chars > input.quota_chars) return "已用额度不能大于总额度。";
  if (input.extra_used_chars > input.extra_quota_chars) return "额外已用额度不能大于额外总额度。";

  return "";
}

function buildAdminRedirect(token, message) {
  const params = new URLSearchParams({ token });
  if (message) params.set("message", message);
  return `/admin?${params.toString()}`;
}

async function loadAdminData() {
  const [{ data: customers, error: customersError }, { data: activations, error: activationsError }] =
    await Promise.all([
      supabase.from("customers").select("*").order("created_at", { ascending: false }),
      supabase
        .from("activations")
        .select("id, customer_id, conversation_id, source_type, enabled, mode, from_lang, to_lang, last_active_at")
        .order("last_active_at", { ascending: false, nullsFirst: false }),
    ]);

  if (customersError) throw customersError;
  if (activationsError) throw activationsError;

  return {
    customers: customers || [],
    activations: activations || [],
  };
}

function summarizeActivations(activations) {
  const summary = new Map();

  for (const activation of activations) {
    const item = summary.get(activation.customer_id) || {
      count: 0,
      enabledCount: 0,
      lastActiveAt: "",
      sourceTypes: new Set(),
    };

    item.count += 1;
    if (activation.enabled) item.enabledCount += 1;
    if (!item.lastActiveAt && activation.last_active_at) item.lastActiveAt = activation.last_active_at;
    item.sourceTypes.add(activation.source_type);
    summary.set(activation.customer_id, item);
  }

  return summary;
}

function renderAdminLogin(errorMessage) {
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
    button { margin-top: 14px; padding: 10px 14px; border: 0; border-radius: 6px; background: #1f6feb; color: #fff; font-weight: 700; cursor: pointer; }
    .error { color: #b42318; margin-bottom: 12px; }
  </style>
</head>
<body>
  <main>
    <h1>管理入口</h1>
    ${errorMessage ? `<p class="error">${escapeHtml(errorMessage)}</p>` : ""}
    <form method="get" action="/admin">
      <label for="token">ADMIN_TOKEN</label>
      <input id="token" name="token" type="password" autocomplete="current-password" autofocus>
      <button type="submit">进入</button>
    </form>
  </main>
</body>
</html>`;
}

function renderAdminPage({ customers, activations, token, message }) {
  const activationSummary = summarizeActivations(activations);
  const activationRows = activations
    .slice(0, 50)
    .map(
      (activation) => `<tr>
        <td>${escapeHtml(activation.source_type)}</td>
        <td><code>${escapeHtml(activation.conversation_id)}</code></td>
        <td>${escapeHtml(activation.mode)}</td>
        <td>${escapeHtml(activation.from_lang)} -> ${escapeHtml(activation.to_lang)}</td>
        <td>${activation.enabled ? "开启" : "关闭"}</td>
        <td>${escapeHtml(formatDate(activation.last_active_at))}</td>
      </tr>`
    )
    .join("");

  const customerRows = customers
    .map((customer) => {
      const item = activationSummary.get(customer.id) || {
        count: 0,
        enabledCount: 0,
        lastActiveAt: "",
        sourceTypes: new Set(),
      };
      const monthlyUsed = getEffectiveMonthlyUsedChars(customer);
      const monthlyRemaining = getMonthlyRemainingChars(customer);
      const extraRemaining = getExtraRemainingChars(customer);
      const remaining = getRemainingChars(customer);
      const monthlyUsagePercent =
        Number(customer.quota_chars || 0) > 0
          ? Math.min(100, Math.round((monthlyUsed / Number(customer.quota_chars || 0)) * 100))
          : 0;
      const extraUsagePercent =
        Number(customer.extra_quota_chars || 0) > 0
          ? Math.min(
              100,
              Math.round((Number(customer.extra_used_chars || 0) / Number(customer.extra_quota_chars || 0)) * 100)
            )
          : 0;
      const statusOptions = ["active", "trial", "paused", "expired", "cancelled"]
        .map(
          (status) => `<option value="${status}" ${customer.status === status ? "selected" : ""}>${status}</option>`
        )
        .join("");
      const currentPeriod = getCurrentBillingPeriod(customer.billing_cycle_day);
      const periodStart = formatBillingPeriodStart(currentPeriod, customer.billing_cycle_day);
      const nextReset = formatNextBillingReset(customer);

      return `<details class="customer">
        <summary>
          <span class="summary-main">
            <strong>${escapeHtml(customer.name)}</strong>
            <code>${escapeHtml(customer.activation_code)}</code>
            <span class="badge">${escapeHtml(customer.status)}</span>
          </span>
          <span class="summary-stats">
            到期 ${escapeHtml(formatDateInput(customer.expires_at)) || "未设置"} · 月剩 ${formatNumber(monthlyRemaining)} · 额外剩 ${formatNumber(extraRemaining)} · 总剩 ${formatNumber(remaining)} · 绑定 ${item.count}
          </span>
        </summary>

        <div class="customer-body">
          <div class="quota-strip">
            <div>
              <b>月套餐</b>
              <span>${formatNumber(customer.quota_chars)} / 已用 ${formatNumber(monthlyUsed)} / 剩 ${formatNumber(monthlyRemaining)}</span>
              <div class="meter"><span style="width:${monthlyUsagePercent}%"></span></div>
            </div>
            <div>
              <b>加油包</b>
              <span>${formatNumber(customer.extra_quota_chars || 0)} / 已用 ${formatNumber(customer.extra_used_chars || 0)} / 剩 ${formatNumber(extraRemaining)}</span>
              <div class="meter"><span style="width:${extraUsagePercent}%"></span></div>
            </div>
            <div>
              <b>使用情况</b>
              <span>总剩 ${formatNumber(remaining)} · 当前账期 ${escapeHtml(periodStart)} · 下次重置 ${escapeHtml(nextReset)} · 最近 ${escapeHtml(formatDate(item.lastActiveAt))}</span>
            </div>
          </div>

          <form method="post" action="/admin/customers/${escapeHtml(customer.id)}">
            <input type="hidden" name="token" value="${escapeHtml(token)}">
            <input type="hidden" name="billing_period" value="${escapeHtml(getCurrentBillingPeriod(customer.billing_cycle_day))}">
            <div class="grid">
              <label>客户名称<input name="name" value="${escapeHtml(customer.name)}"></label>
              <label>激活码<input name="activation_code" value="${escapeHtml(customer.activation_code)}"></label>
              <label>状态<select name="status">${statusOptions}</select></label>
              <label>到期日期<input name="expires_at" type="date" value="${escapeHtml(formatDateInput(customer.expires_at))}"></label>
              <label>月套餐额度<input name="quota_chars" type="number" min="0" step="1" value="${escapeHtml(customer.quota_chars)}"></label>
              <label>本月已用<input name="used_chars" type="number" min="0" step="1" value="${escapeHtml(monthlyUsed)}"></label>
              <label>额外总额度<input name="extra_quota_chars" type="number" min="0" step="1" value="${escapeHtml(customer.extra_quota_chars || 0)}"></label>
              <label>额外已用<input name="extra_used_chars" type="number" min="0" step="1" value="${escapeHtml(customer.extra_used_chars || 0)}"></label>
              <label>账期日<input name="billing_cycle_day" type="number" min="1" max="28" step="1" value="${escapeHtml(customer.billing_cycle_day || 1)}"></label>
              <label class="check"><input name="activation_code_enabled" type="checkbox" ${customer.activation_code_enabled ? "checked" : ""}> 激活码启用</label>
              <label class="wide">备注<input name="notes" value="${escapeHtml(customer.notes || "")}"></label>
            </div>
            <p><button type="submit">保存客户</button></p>
          </form>

          <div class="actions">
            <form method="post" action="/admin/customers/${escapeHtml(customer.id)}/topup">
              <input type="hidden" name="token" value="${escapeHtml(token)}">
              <label>加购额度<input name="topup_chars" type="number" min="1" step="1" placeholder="例如 200000"></label>
              <label>备注<input name="topup_note" placeholder="收款/订单备注"></label>
              <button type="submit">增加加油包</button>
            </form>
            <form method="post" action="/admin/customers/${escapeHtml(customer.id)}/reset-monthly">
              <input type="hidden" name="token" value="${escapeHtml(token)}">
              <button type="submit" class="secondary">重置本月已用</button>
            </form>
          </div>
        </div>
      </details>`;
    })
    .join("");

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
    .panel, .customer { background: #fff; border: 1px solid #d9e0ea; border-radius: 8px; margin-bottom: 10px; }
    .panel { padding: 16px; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(160px, 1fr)); gap: 12px; }
    .wide { grid-column: span 2; }
    label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: #4b5870; }
    input, select { box-sizing: border-box; width: 100%; padding: 9px 10px; border: 1px solid #b7c2d1; border-radius: 6px; font-size: 14px; background: #fff; }
    code { background: #eef2f7; padding: 2px 5px; border-radius: 4px; }
    button { padding: 9px 13px; border: 0; border-radius: 6px; background: #1f6feb; color: #fff; font-weight: 700; cursor: pointer; }
    button.secondary { background: #536078; }
    summary { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 12px 14px; cursor: pointer; }
    summary::-webkit-details-marker { display: none; }
    .summary-main, .summary-stats { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .summary-stats { color: #536078; font-size: 13px; justify-content: flex-end; }
    .badge { background: #e8f2ff; color: #175cd3; border-radius: 999px; padding: 2px 8px; font-size: 12px; }
    .customer-body { border-top: 1px solid #e8edf3; padding: 14px; }
    .quota-strip { display: grid; grid-template-columns: 1fr 1fr 1.2fr; gap: 12px; margin-bottom: 14px; }
    .quota-strip div { background: #f8fafc; border: 1px solid #e8edf3; border-radius: 6px; padding: 10px; }
    .quota-strip b, .quota-strip span { display: block; }
    .quota-strip span { color: #536078; font-size: 13px; margin-top: 4px; }
    .actions { display: flex; align-items: end; gap: 12px; flex-wrap: wrap; border-top: 1px solid #e8edf3; margin-top: 14px; padding-top: 14px; }
    .actions form { display: flex; align-items: end; gap: 10px; flex-wrap: wrap; }
    .check { justify-content: end; flex-direction: row; align-items: center; }
    .check input { width: auto; }
    .meter { height: 8px; background: #edf1f6; border-radius: 999px; overflow: hidden; margin-top: 14px; }
    .meter span { display: block; height: 100%; background: #2da44e; }
    .meta { color: #536078; font-size: 13px; margin: 10px 0 0; }
    .message { background: #ecfdf3; border: 1px solid #abefc6; color: #067647; padding: 10px 12px; border-radius: 6px; margin-bottom: 14px; }
    .error { background: #fff1f0; border-color: #ffccc7; color: #a8071a; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d9e0ea; border-radius: 8px; overflow: hidden; }
    th, td { text-align: left; padding: 10px; border-bottom: 1px solid #e8edf3; font-size: 13px; vertical-align: top; }
    th { background: #f8fafc; color: #4b5870; }
    @media (max-width: 860px) {
      .grid, .quota-strip { grid-template-columns: 1fr; }
      .wide { grid-column: span 1; }
      summary { align-items: flex-start; flex-direction: column; }
      .summary-stats { justify-content: flex-start; }
      main { padding: 14px; }
    }
  </style>
</head>
<body>
  <header><h1>LINE 翻译机器人管理</h1></header>
  <main>
    ${message ? `<div class="message">${escapeHtml(message)}</div>` : ""}
    <section class="panel">
      <h2>新建客户/激活码</h2>
      <form method="post" action="/admin/customers">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <div class="grid">
          <label>客户名称<input name="name" placeholder="客户或公司名称"></label>
          <label>激活码<input name="activation_code" placeholder="TH-2026-A7K9Q2"></label>
          <label>状态
            <select name="status">
              <option value="active">active</option>
              <option value="trial">trial</option>
              <option value="paused">paused</option>
            </select>
          </label>
          <label>到期日期<input name="expires_at" type="date"></label>
          <label>月套餐额度<input name="quota_chars" type="number" min="0" step="1" value="100000"></label>
          <label>本月已用<input name="used_chars" type="number" min="0" step="1" value="0"></label>
          <label>额外总额度<input name="extra_quota_chars" type="number" min="0" step="1" value="0"></label>
          <label>额外已用<input name="extra_used_chars" type="number" min="0" step="1" value="0"></label>
          <label>账期日<input name="billing_cycle_day" type="number" min="1" max="28" step="1" value="1"></label>
          <input type="hidden" name="billing_period" value="${escapeHtml(getCurrentBillingPeriod())}">
          <label class="check"><input name="activation_code_enabled" type="checkbox" checked> 激活码启用</label>
          <label>备注<input name="notes" placeholder="收款/套餐/客户备注"></label>
        </div>
        <p><button type="submit">创建客户</button></p>
      </form>
    </section>

    <h2>客户列表</h2>
    ${customerRows || '<section class="panel">暂无客户。</section>'}

    <h2>最近绑定聊天环境</h2>
    <table>
      <thead><tr><th>类型</th><th>Conversation ID</th><th>模式</th><th>语言</th><th>开关</th><th>最后活跃</th></tr></thead>
      <tbody>${activationRows || '<tr><td colspan="6">暂无绑定记录。</td></tr>'}</tbody>
    </table>
  </main>
</body>
</html>`;
}

function redactWebhookBody(body) {
  const clone = JSON.parse(JSON.stringify(body));

  for (const event of clone.events || []) {
    const text = event?.message?.type === "text" ? event.message.text : "";
    if (text && isActivateCommand(text)) {
      event.message.text = "[REDACTED_ACTIVATION_COMMAND]";
    }
  }

  return clone;
}

function getCached(key) {
  if (!translationCache.has(key)) return null;

  const value = translationCache.get(key);
  translationCache.delete(key);
  translationCache.set(key, value);
  return value;
}

function setCache(key, value) {
  if (translationCache.has(key)) {
    translationCache.delete(key);
  }

  while (translationCache.size >= CACHE_MAX_SIZE) {
    translationCache.delete(translationCache.keys().next().value);
  }

  translationCache.set(key, value);
}

async function getActivationState(conversationId) {
  if (!conversationId) return null;

  const { data, error } = await supabase
    .from("activations")
    .select("*, customer:customers(*)")
    .eq("conversation_id", conversationId)
    .maybeSingle();

  if (error) {
    console.error("Load activation failed:", {
      error: error.message,
      conversationId,
      time: new Date().toISOString(),
    });
    return null;
  }

  if (!data) return null;
  return { activation: data, customer: data.customer };
}

async function createActivationState(conversation, customerId, template = {}) {
  const row = {
    ...buildActivationFromTemplate(conversation, template),
    customer_id: customerId,
    last_active_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("activations")
    .insert(row)
    .select("*, customer:customers(*)")
    .single();

  if (error) throw error;
  return { activation: data, customer: data.customer };
}

async function getEffectiveActivationState(event, conversation) {
  const currentState = await getActivationState(conversation.id);
  if (currentState || conversation.sourceType === "user") return currentState;

  const userId = event.source?.userId;
  if (!userId) return null;

  const privateState = await getActivationState(`user:${userId}`);
  if (!privateState) return null;

  const customerCheck = isCustomerUsable(privateState.customer);
  if (!customerCheck.ok) return null;

  try {
    return await createActivationState(
      conversation,
      privateState.customer.id,
      privateState.activation
    );
  } catch (error) {
    const duplicateConversation =
      error?.code === "23505" || /duplicate key|unique/i.test(error?.message || "");

    if (duplicateConversation) {
      return getActivationState(conversation.id);
    }

    console.error("Create inherited activation failed:", {
      error: error.message,
      conversationId: conversation.id,
      userId,
      customerId: privateState.customer.id,
      time: new Date().toISOString(),
    });
    return null;
  }
}

async function touchActivation(activationId) {
  const { error } = await supabase
    .from("activations")
    .update({ last_active_at: new Date().toISOString() })
    .eq("id", activationId);

  if (error) {
    console.warn("Touch activation failed:", {
      error: error.message,
      activationId,
      time: new Date().toISOString(),
    });
  }
}

async function updateActivation(activationId, patch) {
  const { data, error } = await supabase
    .from("activations")
    .update({
      ...patch,
      updated_at: new Date().toISOString(),
      last_active_at: new Date().toISOString(),
    })
    .eq("id", activationId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function chargeCustomerUsage(customerId, chargedChars) {
  if (chargedChars <= 0) return true;

  const { data, error } = await supabase.rpc("increment_customer_usage", {
    p_customer_id: customerId,
    p_chars: chargedChars,
  });

  if (!error) {
    return Array.isArray(data) ? data.length > 0 : Boolean(data);
  }

  console.warn("RPC increment_customer_usage failed, falling back to read/update:", {
    error: error.message,
    customerId,
    chargedChars,
    time: new Date().toISOString(),
  });

  const { data: customer, error: loadError } = await supabase
    .from("customers")
    .select("used_chars, quota_chars, extra_used_chars, extra_quota_chars, billing_period, billing_cycle_day")
    .eq("id", customerId)
    .single();

  if (loadError || !customer) {
    console.error("Load customer for fallback charge failed:", loadError?.message);
    return false;
  }

  const currentPeriod = getCurrentBillingPeriod(customer.billing_cycle_day);
  const monthlyUsed = customer.billing_period === currentPeriod ? Number(customer.used_chars || 0) : 0;
  const monthlyRemaining = Math.max(0, Number(customer.quota_chars || 0) - monthlyUsed);
  const extraUsed = Number(customer.extra_used_chars || 0);
  const extraRemaining = Math.max(0, Number(customer.extra_quota_chars || 0) - extraUsed);
  if (monthlyRemaining + extraRemaining < chargedChars) return false;

  const monthlyCharge = Math.min(monthlyRemaining, chargedChars);
  const extraCharge = chargedChars - monthlyCharge;

  const { error: updateError } = await supabase
    .from("customers")
    .update({
      used_chars: monthlyUsed + monthlyCharge,
      extra_used_chars: extraUsed + extraCharge,
      billing_period: currentPeriod,
      updated_at: new Date().toISOString(),
    })
    .eq("id", customerId);

  if (updateError) {
    console.error("Fallback charge failed:", updateError.message);
    return false;
  }

  return true;
}

const app = express();

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "line-translate-bot-commercial",
    cacheSize: translationCache.size,
    database: "supabase",
  });
});

app.use("/admin", express.urlencoded({ extended: false }));

app.get("/admin", requireAdmin, async (req, res) => {
  try {
    const data = await loadAdminData();
    res.status(200).send(
      renderAdminPage({
        ...data,
        token: adminTokenFromRequest(req),
        message: req.query.message || "",
      })
    );
  } catch (error) {
    console.error("Load admin page failed:", error);
    res.status(500).send("管理页面加载失败，请查看服务日志。");
  }
});

app.post("/admin/customers", requireAdmin, async (req, res) => {
  const token = adminTokenFromRequest(req);
  const input = normalizeCustomerInput(req.body);
  const validationError = validateCustomerInput(input);

  if (validationError) {
    res.redirect(buildAdminRedirect(token, validationError));
    return;
  }

  const { error } = await supabase.from("customers").insert(input);

  if (error) {
    console.error("Create customer failed:", error);
    res.redirect(buildAdminRedirect(token, `创建失败：${error.message}`));
    return;
  }

  res.redirect(buildAdminRedirect(token, "客户已创建。"));
});

app.post("/admin/customers/:id", requireAdmin, async (req, res) => {
  const token = adminTokenFromRequest(req);
  const input = normalizeCustomerInput(req.body);
  const validationError = validateCustomerInput(input);

  if (validationError) {
    res.redirect(buildAdminRedirect(token, validationError));
    return;
  }

  const { error } = await supabase
    .from("customers")
    .update({
      ...input,
      updated_at: new Date().toISOString(),
    })
    .eq("id", req.params.id);

  if (error) {
    console.error("Update customer failed:", error);
    res.redirect(buildAdminRedirect(token, `保存失败：${error.message}`));
    return;
  }

  res.redirect(buildAdminRedirect(token, "客户已保存。"));
});

app.post("/admin/customers/:id/topup", requireAdmin, async (req, res) => {
  const token = adminTokenFromRequest(req);
  const topupChars = parseNonNegativeInteger(req.body.topup_chars);
  const topupNote = String(req.body.topup_note || "").trim();

  if (topupChars <= 0) {
    res.redirect(buildAdminRedirect(token, "加购额度必须大于 0。"));
    return;
  }

  const { data: customer, error: loadError } = await supabase
    .from("customers")
    .select("extra_quota_chars, notes")
    .eq("id", req.params.id)
    .single();

  if (loadError || !customer) {
    console.error("Load customer for topup failed:", loadError);
    res.redirect(buildAdminRedirect(token, `加购失败：${loadError?.message || "客户不存在"}`));
    return;
  }

  const noteLine = `${new Date().toISOString()} 加购 ${topupChars} 字符${topupNote ? `：${topupNote}` : ""}`;
  const nextNotes = [customer.notes, noteLine].filter(Boolean).join("\n");
  const { error } = await supabase
    .from("customers")
    .update({
      extra_quota_chars: Number(customer.extra_quota_chars || 0) + topupChars,
      notes: nextNotes,
      updated_at: new Date().toISOString(),
    })
    .eq("id", req.params.id);

  if (error) {
    console.error("Top up customer failed:", error);
    res.redirect(buildAdminRedirect(token, `加购失败：${error.message}`));
    return;
  }

  res.redirect(buildAdminRedirect(token, `已增加加油包额度 ${formatNumber(topupChars)} 字符。`));
});

app.post("/admin/customers/:id/reset-monthly", requireAdmin, async (req, res) => {
  const token = adminTokenFromRequest(req);
  const { data: customer, error: loadError } = await supabase
    .from("customers")
    .select("billing_cycle_day")
    .eq("id", req.params.id)
    .single();

  if (loadError || !customer) {
    console.error("Load customer for monthly reset failed:", loadError);
    res.redirect(buildAdminRedirect(token, `重置失败：${loadError?.message || "客户不存在"}`));
    return;
  }

  const { error } = await supabase
    .from("customers")
    .update({
      used_chars: 0,
      billing_period: getCurrentBillingPeriod(customer.billing_cycle_day),
      updated_at: new Date().toISOString(),
    })
    .eq("id", req.params.id);

  if (error) {
    console.error("Reset monthly usage failed:", error);
    res.redirect(buildAdminRedirect(token, `重置失败：${error.message}`));
    return;
  }

  res.redirect(buildAdminRedirect(token, "本月已用额度已重置。"));
});

app.post("/webhook", line.middleware(middlewareConfig), async (req, res) => {
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

  if (BOT_USER_ID && event.source.userId === BOT_USER_ID) {
    console.log("Ignored bot self message:", {
      sourceType: event.source.type,
      userId: event.source.userId,
      time: new Date().toISOString(),
    });
    return null;
  }

  const text = event.message.text.trim();
  if (!text) return null;

  const conversation = getConversation(event);
  if (!conversation.id) return null;

  const lower = text.toLowerCase();

  if (isActivateCommand(text)) {
    return handleActivateCommand(event, text, conversation);
  }

  const state = await getEffectiveActivationState(event, conversation);

  if (isStatusCommand(lower)) {
    return reply(event, buildStatusText(conversation, state));
  }

  if (isUsageCommand(lower)) {
    if (!state) return reply(event, buildNeedActivationText());
    return reply(event, buildUsageText(state.customer));
  }

  if (isSetCommand(lower)) {
    if (!state) return reply(event, buildNeedActivationText());
    return handleSetCommand(event, lower, conversation, state.activation);
  }

  if (!state) return null;

  const customerCheck = isCustomerUsable(state.customer);
  if (!customerCheck.ok || !state.activation.enabled) return null;
  if (text.startsWith("!") || text.startsWith("//")) return null;

  const targetCommand = parseTargetLangCommand(text);
  if (targetCommand && !targetCommand.text) return reply(event, `请输入要翻译的内容，例如：/${targetCommand.targetLang.toUpperCase()} 你好`);

  const textToTranslate = targetCommand?.text || text;
  const chargeMultiplier = !targetCommand && state.activation.mode === "trilingual" ? 2 : 1;
  const chargedChars = countChargeableChars(textToTranslate) * chargeMultiplier;
  if (getRemainingChars(state.customer) < chargedChars) {
    return reply(event, buildQuotaExceededText(state.customer));
  }

  const sourceLang = normalizeCode(await detectLang(textToTranslate));
  if (sourceLang === "und") return null;

  console.log("Translating:", {
    sourceLang,
    targetLang: targetCommand?.targetLang || "",
    mode: state.activation.mode,
    conversationId: conversation.id,
    customerId: state.customer.id,
    textLength: textToTranslate.length,
    chargedChars,
    time: new Date().toISOString(),
  });

  const messages =
    targetCommand
      ? await buildDirectedMessages(textToTranslate, sourceLang, targetCommand.targetLang)
      : state.activation.mode === "trilingual"
        ? await buildTrilingualMessages(textToTranslate, sourceLang)
        : await buildBilingualMessages(textToTranslate, sourceLang, state.activation);

  if (messages.length === 0) return null;

  const charged = await chargeCustomerUsage(state.customer.id, chargedChars);
  if (!charged) {
    return reply(event, buildQuotaExceededText(state.customer));
  }

  await touchActivation(state.activation.id);
  return replyMessages(event, addOriginalQuote(event, messages));
}

async function handleActivateCommand(event, text, conversation) {
  if (conversation.sourceType !== "user") {
    return reply(event, "为了保护激活码，请先私聊机器人输入：activate 激活码。私聊激活后，再把机器人拉入群即可使用。");
  }

  const activationCode = parseActivationCode(text);

  if (!activationCode) {
    return reply(event, "请输入激活码：activate 你的激活码");
  }

  const { data: customer, error } = await supabase
    .from("customers")
    .select("*")
    .eq("activation_code", activationCode)
    .maybeSingle();

  if (error) {
    console.error("Find customer by activation code failed:", {
      error: error.message,
      conversationId: conversation.id,
      time: new Date().toISOString(),
    });
    return reply(event, "系统暂时无法激活，请稍后再试或联系管理员。");
  }

  if (!customer) {
    return reply(event, "激活码不存在，请检查后重新输入。");
  }

  const customerCheck = isCustomerUsable(customer);
  if (!customerCheck.ok) {
    return reply(event, buildActivationRejectedText(customerCheck.reason, customer));
  }

  const existing = await getActivationState(conversation.id);
  if (existing?.activation?.customer_id === customer.id) {
    return reply(event, "当前聊天环境已经激活，无需重复激活。");
  }

  if (existing?.activation?.customer_id && existing.activation.customer_id !== customer.id) {
    return reply(event, "当前聊天环境已绑定其他激活码，请联系管理员处理。");
  }

  try {
    await createActivationState(conversation, customer.id);
  } catch (insertError) {
    console.error("Create activation failed:", {
      error: insertError.message,
      conversationId: conversation.id,
      customerId: customer.id,
      time: new Date().toISOString(),
    });
    return reply(event, "激活失败，请稍后再试或联系管理员。");
  }

  return reply(
    event,
    [
      "激活成功，翻译已开启。",
      "现在可以把机器人拉入群聊或多人聊天室，无需在群里输入激活码。",
      `范围：${conversation.label}`,
      `模式：${getLangName("zh")} ↔ ${getLangName("th")}`,
      `剩余额度：${formatNumber(getRemainingChars(customer))} 字符`,
      `到期时间：${formatDate(customer.expires_at)}`,
    ].join("\n")
  );
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

async function handleSetCommand(event, lower, conversation, activation) {
  const parts = lower.trim().split(/\s+/);
  const sub = parts[1];

  if (sub === "on") {
    await updateActivation(activation.id, { enabled: true });
    return reply(event, "翻译已开启。");
  }

  if (sub === "off") {
    await updateActivation(activation.id, { enabled: false });
    return reply(event, "翻译已关闭。");
  }

  if (sub === "3lang") {
    await updateActivation(activation.id, {
      enabled: true,
      mode: "trilingual",
      from_lang: "zh",
      to_lang: "th",
    });

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

    await updateActivation(activation.id, {
      enabled: true,
      mode: "bilingual",
      from_lang: a,
      to_lang: b,
    });

    return reply(
      event,
      `已切换：${getLangName(a)} ↔ ${getLangName(b)}\n范围：${conversation.label}\n\n发送 set 3lang 可切换到三语模式。`
    );
  }

  return reply(event, buildSetHelpText("set 命令用法："));
}

function buildSetHelpText(title) {
  return [
    title,
    "",
    "set zh th    中文 ↔ 泰文（默认）",
    "set zh my    中文 ↔ 缅甸文",
    "set zh en    中文 ↔ 英文",
    "set th my    泰文 ↔ 缅甸文",
    "set on       开启翻译",
    "set off      关闭翻译",
    "set 3lang    三语模式（中/泰/缅）",
    "",
    "/TH 内容    指定翻译成泰文",
    "/MM 内容    指定翻译成缅文",
    "/ZH 内容    指定翻译成中文",
    "/EN 内容    指定翻译成英文",
    "/JP 内容    指定翻译成日文",
    "/DE /FR /ES  指定翻译成德/法/西",
    "",
    "/status      查看当前设置",
    "/usage       查看额度用量",
  ].join("\n");
}

function buildStatusText(conversation, state) {
  const lines = ["当前翻译状态", ""];

  lines.push(`来源：${conversation.label}`);

  if (!state) {
    lines.push("激活：未激活");
    lines.push("");
    lines.push("请先私聊机器人输入：activate 激活码");
    return lines.join("\n");
  }

  const { activation, customer } = state;
  const customerCheck = isCustomerUsable(customer);

  lines.push("激活：已激活");
  lines.push(`客户状态：${customer?.status || "unknown"}`);
  lines.push(`有效：${customerCheck.ok ? "是" : "否"}`);
  lines.push(`到期时间：${formatDate(customer?.expires_at)}`);
  lines.push(`开关：${activation.enabled ? "开启" : "关闭"}`);

  if (activation.mode === "trilingual") {
    lines.push("模式：三语模式");
    lines.push("语言：中文 / ภาษาไทย / မြန်မာဘာသာ");
  } else {
    lines.push("模式：双语模式");
    lines.push(`语言：${getLangName(activation.from_lang)} ↔ ${getLangName(activation.to_lang)}`);
  }

  lines.push("");
  lines.push("发送 set 查看命令列表。");
  lines.push("发送 /usage 查看额度。");

  return lines.join("\n");
}

function buildUsageText(customer) {
  if (!customer) return buildNeedActivationText();
  const monthlyUsed = getEffectiveMonthlyUsedChars(customer);
  const monthlyRemaining = getMonthlyRemainingChars(customer);
  const extraRemaining = getExtraRemainingChars(customer);

  return [
    "当前激活码用量",
    "",
    `月套餐：${formatNumber(customer.quota_chars)} 字符`,
    `本月已用：${formatNumber(monthlyUsed)} 字符`,
    `本月剩余：${formatNumber(monthlyRemaining)} 字符`,
    `加油包剩余：${formatNumber(extraRemaining)} 字符`,
    `总剩余：${formatNumber(getRemainingChars(customer))} 字符`,
    `到期时间：${formatDate(customer.expires_at)}`,
  ].join("\n");
}

function buildNeedActivationText() {
  return "当前聊天环境尚未激活。为了保护激活码，请先私聊机器人输入：activate 激活码。";
}

function buildQuotaExceededText(customer) {
  return [
    "当前激活码字符额度不足，已停止翻译。",
    `本月剩余：${formatNumber(getMonthlyRemainingChars(customer))} 字符`,
    `加油包剩余：${formatNumber(getExtraRemainingChars(customer))} 字符`,
    `总剩余：${formatNumber(getRemainingChars(customer))} 字符`,
    "请联系管理员增加额度。",
  ].join("\n");
}

function buildActivationRejectedText(reason, customer) {
  if (reason === "code_disabled") return "该激活码已被停用，请联系管理员。";
  if (reason === "status") return `该客户状态为 ${customer.status}，暂时不能激活。`;
  if (reason === "expired") return `该激活码已到期，到期时间：${formatDate(customer.expires_at)}`;
  if (reason === "quota") return "该激活码字符额度已用完，请联系管理员增加额度。";
  return "该激活码暂时不能使用，请联系管理员。";
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
