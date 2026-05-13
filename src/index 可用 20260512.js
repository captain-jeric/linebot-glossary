// =========================
// LINE 群聊翻译机器人
// Phase 1 · 中泰缅三语稳定版
// 基于已验证可用的 index 可用 备份.js 改造
// =========================

const express = require("express");
const line = require("@line/bot-sdk");
const { Translate } = require("@google-cloud/translate").v2;

const PORT = process.env.PORT || 3001;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const BOT_USER_ID = process.env.BOT_USER_ID || "";
const LOG_FULL_WEBHOOK_BODY = process.env.LOG_FULL_WEBHOOK_BODY === "true";
const MAX_LINE_TEXT_LENGTH = 4900;
const CACHE_MAX_SIZE = 200;

const requiredEnvNames = [
  "LINE_CHANNEL_SECRET",
  "GOOGLE_APPLICATION_CREDENTIALS",
];

if (!LINE_CHANNEL_ACCESS_TOKEN) {
  throw new Error("Missing required environment variable: LINE_CHANNEL_ACCESS_TOKEN");
}

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
};

const LANG_FLAG = {
  zh: "🇨🇳",
  th: "🇹🇭",
  my: "🇲🇲",
  en: "🇬🇧",
};

const conversationConfig = new Map();
const translationCache = new Map();

function createDefaultConfig() {
  return {
    enabled: true,
    mode: "bilingual",
    from: "zh",
    to: "th",
  };
}

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
  return LANG_FLAG[normalized] || "🌐";
}

function getConversation(event) {
  const source = event.source || {};

  if (source.type === "group" && source.groupId) {
    return { id: `group:${source.groupId}`, label: "群聊" };
  }

  if (source.type === "room" && source.roomId) {
    return { id: `room:${source.roomId}`, label: "多人聊天室" };
  }

  if (source.type === "user" && source.userId) {
    return { id: `user:${source.userId}`, label: "私聊" };
  }

  return { id: null, label: "未知来源" };
}

function getConfig(conversationId) {
  if (!conversationId) return createDefaultConfig();

  if (!conversationConfig.has(conversationId)) {
    conversationConfig.set(conversationId, createDefaultConfig());
  }

  return conversationConfig.get(conversationId);
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

const app = express();

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "line-translate-bot-3lang",
    cacheSize: translationCache.size,
    conversationsConfigured: conversationConfig.size,
  });
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
      console.log(JSON.stringify(req.body, null, 2));
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
  const cfg = getConfig(conversation.id);
  const lower = text.toLowerCase();

  if (lower.startsWith("set ") || lower === "set") {
    return handleSetCommand(event, lower, conversation, cfg);
  }

  if (lower === "/lang" || lower === "/status" || lower === "/状态") {
    return reply(event, buildStatusText(conversation, cfg));
  }

  if (!cfg.enabled) return null;
  if (text.startsWith("!") || text.startsWith("//")) return null;

  const sourceLang = normalizeCode(await detectLang(text));
  if (sourceLang === "und") return null;

  console.log("Translating:", {
    sourceLang,
    mode: cfg.mode,
    conversationId: conversation.id,
    textLength: text.length,
    time: new Date().toISOString(),
  });

  if (cfg.mode === "trilingual") {
    return handleTrilingual(event, text, sourceLang);
  }

  return handleBilingual(event, text, sourceLang, cfg);
}

async function handleBilingual(event, text, sourceLang, cfg) {
  const langFrom = normalizeCode(cfg.from || "zh");
  const langTo = normalizeCode(cfg.to || "th");

  let targetLang;
  if (sourceLang === langFrom) {
    targetLang = langTo;
  } else if (sourceLang === langTo) {
    targetLang = langFrom;
  } else {
    targetLang = langFrom;
  }

  if (sourceLang === targetLang) return null;

  const translated = await callTranslate(text, targetLang, sourceLang);
  if (!translated || translated.trim() === text) return null;

  const prefix = `${getLangFlag(sourceLang)} ${getLangName(sourceLang)} → ${getLangName(targetLang)}`;
  return reply(event, buildLineText(prefix, translated));
}

async function handleTrilingual(event, text, sourceLang) {
  const targets = THREE_LANGS.filter((lang) => lang !== sourceLang);
  if (targets.length === 0) return null;

  const results = await Promise.all(
    targets.map(async (targetLang) => ({
      targetLang,
      translated: await callTranslate(text, targetLang, sourceLang),
    }))
  );

  const messages = results
    .filter(({ translated }) => translated && translated.trim() !== text)
    .map(({ targetLang, translated }) => {
      const prefix = `${getLangFlag(sourceLang)} ${getLangName(sourceLang)} → ${getLangName(targetLang)}`;
      return { type: "text", text: buildLineText(prefix, translated) };
    });

  if (messages.length === 0) return null;

  try {
    console.log("Replying trilingual translation:", {
      messageCount: messages.length,
      time: new Date().toISOString(),
    });

    return await lineClient.replyMessage({
      replyToken: event.replyToken,
      messages,
    });
  } catch (error) {
    console.error("LINE reply failed (trilingual):", {
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

function buildLineText(prefix, translated) {
  const availableLength = Math.max(0, MAX_LINE_TEXT_LENGTH - prefix.length - 1);
  return `${prefix}\n${translated.slice(0, availableLength)}`;
}

function handleSetCommand(event, lower, conversation, cfg) {
  const parts = lower.trim().split(/\s+/);
  const sub = parts[1];

  if (sub === "on") {
    cfg.enabled = true;
    return reply(event, "✅ 翻译已开启\n✅ เปิดการแปลแล้ว\n✅ ဘာသာပြန်ဖွင့်ပြီ");
  }

  if (sub === "off") {
    cfg.enabled = false;
    return reply(event, "⛔ 翻译已关闭\n⛔ ปิดการแปลแล้ว\n⛔ ဘာသာပြန်ပိတ်ပြီ");
  }

  if (sub === "3lang") {
    cfg.mode = "trilingual";
    return reply(
      event,
      [
        "✅ 三语模式已开启",
        "中文 / ภาษาไทย / မြန်မာဘာသာ 三语互译",
        "每条消息将同时收到两条翻译。",
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
      return reply(event, buildSetHelpText("⚠️ 不支持该语言对，可用命令："));
    }

    cfg.mode = "bilingual";
    cfg.from = a;
    cfg.to = b;

    return reply(
      event,
      `✅ 已切换：${getLangName(a)} ↔ ${getLangName(b)}\n范围：${conversation.label}\n\n发送 set 3lang 可切换到三语模式。`
    );
  }

  return reply(event, buildSetHelpText("📖 set 命令用法："));
}

function buildSetHelpText(title) {
  return [
    title,
    "",
    "set zh th    中文 ↔ 泰文（默认）",
    "set zh my    中文 ↔ 缅甸文",
    "set zh en    中文 ↔ 英文",
    "set th my    泰文 ↔ 缅甸文",
    "set 3lang    三语模式（中/泰/缅）",
    "set on       开启翻译",
    "set off      关闭翻译",
    "",
    "/lang        查看当前设置",
  ].join("\n");
}

function buildStatusText(conversation, cfg) {
  const lines = ["📋 当前翻译设置\n"];

  lines.push(`来源：${conversation.label}`);
  lines.push(`开关：${cfg.enabled ? "✅ 开启" : "⛔ 关闭"}`);

  if (cfg.mode === "trilingual") {
    lines.push("模式：🔺 三语模式");
    lines.push("语言：中文 / ภาษาไทย / မြန်မာဘာသာ");
  } else {
    lines.push("模式：双语模式");
    lines.push(`语言：${getLangName(cfg.from)} ↔ ${getLangName(cfg.to)}`);
  }

  lines.push("\n跳过翻译：消息开头加 ! 或 //");
  lines.push("发送 set 查看命令列表。");

  return lines.join("\n");
}

async function detectLang(text) {
  if (/[\u1000-\u109F]/.test(text)) return "my";
  if (/[\u0E00-\u0E7F]/.test(text)) return "th";
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
  try {
    console.log("Replying:", {
      sourceType: event.source?.type,
      groupId: event.source?.groupId,
      roomId: event.source?.roomId,
      userId: event.source?.userId,
      replyLength: text.length,
      time: new Date().toISOString(),
    });

    return await lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: "text", text }],
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
