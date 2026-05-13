// =========================
// LINE 群聊翻译机器人
// 商业激活码版 · Supabase/PostgreSQL 持久化
// 版本说明：
// - 支持 LINE 私聊 / 群聊 / 多人聊天室翻译。
// - 支持私聊激活码绑定，群聊可继承用户私聊激活，避免在群里公开激活码。
// - 支持双语模式、三语模式、手动目标语言命令、引用原文回复、额度扣减和管理后台。
// - 数据持久化在 Supabase，翻译调用 Google Cloud Translate，HTTP 服务由 Express 承载。
// =========================

// ---- 基础依赖 ----
// express：提供 /webhook、/admin、/health 等 HTTP 路由。
// @line/bot-sdk：验证 LINE webhook 签名，并调用 replyMessage 回复消息。
// Google Translate v2：执行语言检测与翻译。
// Supabase client：读写客户、激活记录、额度等业务数据。
const express = require("express");
const line = require("@line/bot-sdk");
const { Translate } = require("@google-cloud/translate").v2;
const { createClient } = require("@supabase/supabase-js");

// ---- 环境变量与运行配置 ----
// PORT：容器或服务器监听端口，默认 3001。
// BOT_USER_ID：用于过滤机器人自己发出的消息，避免自我触发循环。
// ADMIN_TOKEN：后台管理入口密码；为空时后台不可用。
// ADMIN_TAILSCALE_ONLY：默认只允许 localhost/Tailscale 访问后台，设为 "false" 可关闭限制。
// LOG_FULL_WEBHOOK_BODY：调试开关，开启时会打印 webhook body，并自动遮盖激活码。
const PORT = process.env.PORT || 3001;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const BOT_USER_ID = process.env.BOT_USER_ID || "";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const ADMIN_TAILSCALE_ONLY = process.env.ADMIN_TAILSCALE_ONLY !== "false";
const LOG_FULL_WEBHOOK_BODY = process.env.LOG_FULL_WEBHOOK_BODY === "true";
// LINE 单条 text message 建议保守控制在 5000 字符以内，这里预留一点空间给标签。
const MAX_LINE_TEXT_LENGTH = 4900;
// 内存翻译缓存最大条数；命中缓存可减少 Google Translate 请求，但仍会扣客户额度。
const CACHE_MAX_SIZE = 200;
// 账期、到期日输入等业务时间按泰国时区处理，贴合主要运营场景。
const BILLING_TIME_ZONE = "Asia/Bangkok";

// 服务启动前强校验必要环境变量，避免容器启动后才在请求中报错。
const requiredEnvNames = [
  "LINE_CHANNEL_SECRET",
  "LINE_CHANNEL_ACCESS_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
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

// LINE Messaging API 客户端：负责向 LINE 回复消息。
const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
});

// Google Translate 客户端：依赖 GOOGLE_APPLICATION_CREDENTIALS 指向的 service account。
const translateClient = new Translate();

// Supabase 使用 service role key，服务端可绕过 RLS 进行后台管理和扣额度操作。
// 注意：service role key 必须只放在服务器环境变量中，不能暴露给前端。
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

// 后台 set 命令允许切换的固定双语语言对。
// 这里暂时只放核心常用组合；日/德/法/西通过 /JP /DE /FR /ES 手动命令预留。
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

// 方案 C 的显示元素：国旗 + 中文简称/目标语言本地名。
// 例如：🇹🇭 泰/ไทย：ข้อความแปล
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

// 手动目标语言命令映射。
// 用户在群里发送 "/TH 你好" 时，会强制翻译成泰文，并按单目标翻译扣 1 倍额度。
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

// 简单 LRU 风格内存缓存：key 为 source|target|text，value 为翻译结果。
// 进程重启后缓存会丢失；这是有意为之，避免引入额外存储复杂度。
const translationCache = new Map();

// 将 Google/用户输入中的语言代码归一化到程序内部使用的短代码。
// 中文可能返回 zh-CN/zh-TW 等，这里统一视为 zh。
function normalizeCode(code) {
  if (!code) return "und";
  const value = String(code).toLowerCase();
  if (value.startsWith("zh")) return "zh";
  return value;
}

// Google Translate 对中文目标语言更偏好 zh-CN；und 表示未知语言，不指定 source。
function toGoogleCode(code) {
  const normalized = normalizeCode(code);
  if (normalized === "zh") return "zh-CN";
  if (normalized === "und") return undefined;
  return normalized;
}

// 下面三个函数只负责展示，不参与翻译逻辑。
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

// 从 LINE webhook source 提取一个稳定的“聊天环境 ID”。
// user/group/room 各自加前缀，避免不同类型 ID 之间理论上发生冲突。
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

// 新激活记录的默认翻译设置：双语、中泰互译、开启状态。
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

// 群聊继承私聊激活时，复制私聊中的语言模式作为模板，
// 但强制启用，且 conversation_id/source_type 换成当前群或聊天室。
function buildActivationFromTemplate(conversation, template = {}) {
  return {
    ...buildDefaultActivation(conversation),
    enabled: true,
    mode: template.mode || "bilingual",
    from_lang: template.from_lang || "zh",
    to_lang: template.to_lang || "th",
  };
}

// activate/激活 命令支持可选斜杠，便于用户输入。
function isActivateCommand(text) {
  return /^\/?(?:activate|激活)(?:\s+|$)/i.test(text.trim());
}

// 只提取 activate 后面的激活码；如果用户只输入 activate，则返回空字符串。
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

// 解析手动目标语言命令，例如：
// /TH 你好 -> { targetLang: "th", text: "你好" }
// /status 不在 TARGET_LANG_COMMANDS 中，因此不会被误判成翻译命令。
function parseTargetLangCommand(text) {
  const match = text.trim().match(/^\/([a-z]{2})(?:\s+|$)([\s\S]*)$/i);
  if (!match) return null;

  const targetLang = TARGET_LANG_COMMANDS[match[1].toLowerCase()];
  if (!targetLang) return null;

  const body = String(match[2] || "").trim();
  if (!body) return { targetLang, text: "" };
  return { targetLang, text: body };
}

// 判断客户是否允许继续使用翻译服务。
// 这里包含激活码开关、客户状态、到期时间、总剩余额度等业务条件。
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

// 取泰国时区下的年月日，避免服务器部署在 UTC 或其他地区时账期计算漂移。
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

// 计算当前账期，格式 YYYY-MM。
// 如果账期日是 15 号，而今天是 13 号，则仍属于上一个账期。
// 账期日限制在 1-28，是为了避免 29/30/31 在不同月份不存在造成边界复杂度。
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

// 将账期 YYYY-MM + 账期日转换为用于后台展示的账期起始日期。
function formatBillingPeriodStart(period, cycleDay = 1) {
  const [year, month] = String(period || "").split("-").map((part) => Number.parseInt(part, 10));
  if (!year || !month) return "";
  const day = Math.min(28, Math.max(1, Number.parseInt(cycleDay || "1", 10) || 1));
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// 计算下一次月套餐额度重置日期，便于后台快速判断客户账期。
function formatNextBillingReset(customer) {
  const currentPeriod = getCurrentBillingPeriod(customer?.billing_cycle_day);
  const [year, month] = currentPeriod.split("-").map((part) => Number.parseInt(part, 10));
  if (!year || !month) return "";

  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const day = Math.min(28, Math.max(1, Number.parseInt(customer?.billing_cycle_day || "1", 10) || 1));
  return `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// 如果客户记录中的 billing_period 已经过期，则本月已用视为 0。
// 真正写回数据库发生在扣费 RPC 或后台手动保存/重置时。
function getEffectiveMonthlyUsedChars(customer) {
  if (!customer) return 0;
  if (customer.billing_period && customer.billing_period !== getCurrentBillingPeriod(customer.billing_cycle_day)) return 0;
  return Number(customer.used_chars || 0);
}

// 月套餐剩余额度 = 月套餐总额 - 当前账期已用。
function getMonthlyRemainingChars(customer) {
  return Math.max(0, Number(customer?.quota_chars || 0) - getEffectiveMonthlyUsedChars(customer));
}

// 加油包剩余额度独立于月套餐账期，不随月度重置清零。
function getExtraRemainingChars(customer) {
  return Math.max(0, Number(customer?.extra_quota_chars || 0) - Number(customer?.extra_used_chars || 0));
}

// 总剩余额度 = 月套餐剩余 + 加油包剩余。
function getRemainingChars(customer) {
  return getMonthlyRemainingChars(customer) + getExtraRemainingChars(customer);
}

// 使用 Array.from 按 Unicode code point 计数，避免 emoji/部分组合字符被简单 length 粗暴拆分。
function countChargeableChars(text) {
  return Array.from(text || "").length;
}

// 后台展示日期时只显示日期部分；具体到期时间保存为当天 23:59:59+07。
function formatDate(value) {
  if (!value) return "未设置";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().slice(0, 10);
}

// 所有额度数字统一加千分位，后台和 LINE 用量回复都更易读。
function formatNumber(value) {
  return Number(value || 0).toLocaleString("en-US");
}

// 后台页面是字符串模板拼接，所有用户可控文本必须 escape，防止 XSS。
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 后台 token 支持 query、表单 body、HTTP header 三种来源，
// 这样浏览器访问、表单提交和脚本调用都方便。
function adminTokenFromRequest(req) {
  return req.query.token || req.body?.token || req.get("x-admin-token") || "";
}

// Express 里可能拿到 IPv6 映射地址 ::ffff:127.0.0.1，这里做一次规整。
function getRemoteAddress(req) {
  return String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
}

// Host 可能带端口或 IPv6 方括号；这里只取主机名/IP 用于后台访问判断。
function getRequestHost(req) {
  return String(req.get("host") || "")
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(":")[0];
}

// 判断请求是否来自 localhost 或 Tailscale 私网。
// Tailscale IPv4 CGNAT 范围为 100.64.0.0/10；fd7a:115c:a1e0::/48 是 Tailscale IPv6 ULA。
function isLocalOrTailscaleAddress(address) {
  if (!address) return false;
  if (address === "127.0.0.1" || address === "::1" || address === "localhost") return true;
  if (address.startsWith("fd7a:115c:a1e0:")) return true;

  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return false;

  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

// 后台访问保护中间件：
// 1. 必须配置 ADMIN_TOKEN；
// 2. 默认必须来自 localhost/Tailscale；
// 3. token 必须匹配。
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

// 表单中的数字字段统一解析为非负整数，非法输入按 0 处理。
function parseNonNegativeInteger(value) {
  return Math.max(0, Number.parseInt(value || "0", 10) || 0);
}

// 后台只让运营输入日期，保存时自动转为泰国时间当天 23:59:59。
// 如果传入的是完整时间字符串，则原样保留，便于兼容旧数据。
function normalizeExpiryDate(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return `${text}T23:59:59+07:00`;
  }
  return text;
}

// 将数据库中的 timestamptz 格式化成 <input type="date"> 需要的 YYYY-MM-DD。
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

// 将后台“创建/编辑客户”表单规整成 customers 表可写入的数据结构。
// quota_chars/used_chars 表示月套餐额度；extra_* 表示加油包额度。
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

// 后台表单校验，只做业务层面的基本保护；数据库约束仍是最终防线。
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

// 所有后台写操作后都跳回 /admin，并把提示信息放在 query string 中。
function buildAdminRedirect(token, message) {
  const params = new URLSearchParams({ token });
  if (message) params.set("message", message);
  return `/admin?${params.toString()}`;
}

// 后台页面需要同时展示客户和最近绑定的聊天环境，两个查询可并行执行。
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

// 将 activations 聚合成按客户分组的摘要，减少后台列表中重复展示。
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

// ADMIN_TOKEN 不正确或未携带时展示的极简登录页。
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

// 后台主页面：
// - 顶部创建客户；
// - 中部折叠式客户列表，默认紧凑展示；
// - 底部展示最近绑定的聊天环境，便于排查群/私聊激活关系。
function renderAdminPage({ customers, activations, token, message }) {
  const activationSummary = summarizeActivations(activations);
  // 最近绑定记录只取前 50 条，避免后台页面在客户多时渲染过重。
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

      // 每个客户用 <details> 折叠展示：摘要一行即可看剩余额度，展开后再编辑。
      // 这样比把所有客户的完整表单都铺开更省空间，也更适合手机访问。
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

  // 页面没有引入前端框架，所有样式内联在 HTML 中，便于单文件部署和备份。
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

// 打印完整 webhook body 时，激活命令会被脱敏。
// 避免 LOG_FULL_WEBHOOK_BODY=true 时把客户激活码写进日志。
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

// 读取缓存时先 delete 再 set，相当于把该 key 移到 Map 末尾，形成简单 LRU。
function getCached(key) {
  if (!translationCache.has(key)) return null;

  const value = translationCache.get(key);
  translationCache.delete(key);
  translationCache.set(key, value);
  return value;
}

// 写缓存时超过上限就删除最早的 key，控制内存占用。
function setCache(key, value) {
  if (translationCache.has(key)) {
    translationCache.delete(key);
  }

  while (translationCache.size >= CACHE_MAX_SIZE) {
    translationCache.delete(translationCache.keys().next().value);
  }

  translationCache.set(key, value);
}

// 根据 conversation_id 读取当前聊天环境的激活状态，并一并关联客户资料。
// conversation_id 形如 user:xxx / group:xxx / room:xxx。
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

// 创建激活记录并返回完整状态。
// 用于私聊 activate，也用于群聊继承私聊激活时自动创建 group/room 绑定。
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

// 获取“实际可用”的激活状态。
// 若当前群/聊天室未激活，但发言人已经在私聊激活，则自动为该群/聊天室创建绑定。
// 这样用户可以先私聊机器人输入 activate，再把机器人拉入群，无需在群里公开激活码。
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
    // 并发情况下，两条群消息可能同时尝试创建同一个 conversation_id。
    // 如果遇到唯一键冲突，重新读取已有记录即可。
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

// 更新激活记录的最后活跃时间，用于后台查看哪些群最近在使用。
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

// 更新激活配置，例如 set on/off、set zh th、set 3lang。
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

// 扣客户额度。
// 优先调用数据库 RPC increment_customer_usage，在数据库内原子扣费，防止并发超扣。
// 如果 RPC 不存在或失败，则走兼容 fallback；生产环境应以 RPC 为准。
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

  // 月套餐优先扣，月套餐不足时再扣加油包。
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

// 健康检查接口，方便 Docker/云服务/人工确认服务是否存活。
app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "line-translate-bot-commercial",
    cacheSize: translationCache.size,
    database: "supabase",
  });
});

// 后台表单使用 application/x-www-form-urlencoded，不影响 LINE webhook 的 SDK middleware。
app.use("/admin", express.urlencoded({ extended: false }));

// 后台首页：加载客户、激活记录并渲染 HTML。
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

// 创建新客户/激活码。
// 新客户默认月套餐、本月已用、加油包额度都来自后台表单。
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

// 保存客户信息。
// 注意：保存时 billing_period 会按当前账期重算，防止旧账期的 used_chars 被误认为本期已用。
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

// 增加加油包额度。
// 这里是“累加”而不是覆盖 extra_quota_chars，避免运营误操作把旧额度清掉。
// 同时把加购记录追加到 notes，形成最轻量的操作流水。
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

// 手动重置本月已用额度。
// 用于账期调整、人工补偿或测试；加油包已用不会被重置。
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

// LINE Webhook 入口。
// line.middleware 会校验 LINE 签名，只有来自 LINE 的合法请求才能进入业务处理。
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

    // LINE 要求 webhook 尽快返回 200；这里并行处理同一个请求里的多个事件。
    // 单个事件失败不会影响其他事件，也不会让整个 webhook 卡死。
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

// 单条 LINE 事件处理主流程。
// 顺序很重要：先处理命令，再查激活，再决定是否翻译和扣费。
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

  // 防止机器人自己的消息再次触发翻译，形成无限循环。
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

  // 这里会自动处理“群聊继承私聊激活”的逻辑。
  const state = await getEffectiveActivationState(event, conversation);

  // 状态、用量、设置命令都属于控制命令，不走翻译和扣费。
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
  // 以 ! 或 // 开头的消息视为用户主动跳过翻译，适合群里发代码、命令或备注。
  if (text.startsWith("!") || text.startsWith("//")) return null;

  // 手动目标语言命令优先于当前模式，例如 /TH /MM /JP。
  const targetCommand = parseTargetLangCommand(text);
  if (targetCommand && !targetCommand.text) return reply(event, `请输入要翻译的内容，例如：/${targetCommand.targetLang.toUpperCase()} 你好`);

  // 三语自动模式会翻译成另外两种语言，因此按 2 倍扣额度；
  // 手动命令只翻一个目标语言，所以永远按 1 倍扣。
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

  // 只有确实生成了翻译消息后才扣额度。
  // 即使命中翻译缓存，也会扣客户额度，因为机器人仍然提供了一次翻译回复服务。
  const charged = await chargeCustomerUsage(state.customer.id, chargedChars);
  if (!charged) {
    return reply(event, buildQuotaExceededText(state.customer));
  }

  await touchActivation(state.activation.id);
  // 翻译消息引用用户原文，群聊中更容易看出每条翻译对应哪句话。
  return replyMessages(event, addOriginalQuote(event, messages));
}

// 私聊激活命令。
// 为保护激活码，群聊/多人聊天室中输入 activate 不会真正绑定，只提示用户去私聊。
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

  // 同一个私聊环境重复激活同一个客户，直接提示无需重复激活。
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

// 双语模式的目标语言选择：
// - 如果来源语言等于 from_lang，则翻译成 to_lang；
// - 如果来源语言等于 to_lang，则翻译成 from_lang；
// - 如果是其他语言，默认翻译成中文，服务中国用户时更自然。
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

// 指定单个目标语言的翻译构建。
// 普通双语翻译和 /TH /MM /JP 等手动命令都会走这里。
async function buildDirectedMessages(text, sourceLang, targetLang) {
  const normalizedSource = normalizeCode(sourceLang);
  const normalizedTarget = normalizeCode(targetLang);
  if (normalizedSource === normalizedTarget) return [];

  const translated = await callTranslate(text, normalizedTarget, normalizedSource);
  if (!translated || translated.trim() === text) return [];

  return [{ type: "text", text: buildTranslationLine(normalizedTarget, translated) }];
}

// 三语模式仅在中文/泰文/缅文之间工作。
// 输入其中一种语言时，输出另外两种语言，并合并成一条 LINE 消息，减少群聊刷屏。
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

  // 多行合并时也要遵守 LINE 单条消息长度上限。
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

// 翻译回复前缀，采用“国旗 + 中文简称/本地名 + 冒号”的方案 C。
function buildTranslationPrefix(targetLang) {
  return `${getLangFlag(targetLang)} ${getLangShortLabel(targetLang)}：`;
}

// 构建一行翻译内容，例如：
// 🇹🇭 泰/ไทย：สวัสดีครับ
function buildTranslationLine(targetLang, translated, maxLength = MAX_LINE_TEXT_LENGTH) {
  const prefix = buildTranslationPrefix(targetLang);
  const availableLength = maxLength - prefix.length;
  if (availableLength <= 0) return "";
  return `${prefix}${translated.slice(0, availableLength)}`;
}

// 群内 set 命令处理。
// set 只影响当前聊天环境的激活记录，不会反向修改用户私聊激活模板。
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

// set 命令帮助文案，尽量保持短，适合直接在 LINE 群里阅读。
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

// /status 输出当前聊天环境的激活和翻译配置。
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

// /usage 输出客户额度，包含月套餐、加油包和总剩余。
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

// 未激活时的统一提示，强调去私聊输入激活码。
function buildNeedActivationText() {
  return "当前聊天环境尚未激活。为了保护激活码，请先私聊机器人输入：activate 激活码。";
}

// 额度不足提示。这里不暴露客户名称或激活码，只给出剩余额度。
function buildQuotaExceededText(customer) {
  return [
    "当前激活码字符额度不足，已停止翻译。",
    `本月剩余：${formatNumber(getMonthlyRemainingChars(customer))} 字符`,
    `加油包剩余：${formatNumber(getExtraRemainingChars(customer))} 字符`,
    `总剩余：${formatNumber(getRemainingChars(customer))} 字符`,
    "请联系管理员增加额度。",
  ].join("\n");
}

// 激活失败原因映射到用户可读文案。
function buildActivationRejectedText(reason, customer) {
  if (reason === "code_disabled") return "该激活码已被停用，请联系管理员。";
  if (reason === "status") return `该客户状态为 ${customer.status}，暂时不能激活。`;
  if (reason === "expired") return `该激活码已到期，到期时间：${formatDate(customer.expires_at)}`;
  if (reason === "quota") return "该激活码字符额度已用完，请联系管理员增加额度。";
  return "该激活码暂时不能使用，请联系管理员。";
}

// 快速语言识别。
// 中文/泰文/缅文/日文先用 Unicode 范围判断，速度快且减少 Google detect 调用。
// 日文假名必须放在中文汉字前，因为日文常混用汉字，避免误判成中文。
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

// 调用 Google Translate。
// cacheKey 包含 source、target、原文，确保不同方向不会互相污染。
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

// 回复单条纯文本消息的便捷封装。
async function reply(event, text) {
  return replyMessages(event, [{ type: "text", text }]);
}

// 给翻译回复加 LINE 原生引用。
// quoteToken 来自用户原消息；只有第一条 text message 带引用，避免多条消息重复引用显得拥挤。
function addOriginalQuote(event, messages) {
  const quoteToken = event.message?.quoteToken;
  if (!quoteToken || !Array.isArray(messages) || messages.length === 0) return messages;

  return messages.map((message, index) => {
    if (index !== 0 || message.type !== "text") return message;
    return { ...message, quoteToken };
  });
}

// 统一 LINE 回复出口。
// 这里集中记录回复日志，也集中捕获 LINE API 错误。
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

// Express 兜底错误处理中间件。
app.use((error, _req, res, _next) => {
  console.error("Application error:", error);
  if (!res.headersSent) {
    res.status(500).json({ ok: false, message: "Internal Server Error" });
  }
});

// 监听 0.0.0.0，保证 Docker 容器外部可以通过端口访问。
app.listen(PORT, "0.0.0.0", () => {
  console.log(`LINE translate bot running on port ${PORT}`);
  console.log(`Bot user ID configured: ${BOT_USER_ID ? "yes" : "no"}`);
});
