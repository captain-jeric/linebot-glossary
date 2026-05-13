// =========================
// LINE 群聊翻译机器人
// =========================
//
// 功能：
//
// - 接收 LINE Webhook 事件
// - 只处理文字消息
// - 调用 Google Translate API 翻译
// - 实时翻译私聊、群聊、多人聊天室
// - 把翻译结果回复到原群聊 / 聊天窗口
//
// 运行环境：
//
// - Node.js
// - Docker
// - LINE Messaging API
// - Google Cloud Translation API
//

const express = require("express");
const line = require("@line/bot-sdk");
const { Translate } = require("@google-cloud/translate").v2;

// =========================
// 读取环境变量
// =========================
//
// Docker Compose 里建议通过 env_file: .env 注入
//
// 必填：
//
// LINE_CHANNEL_ACCESS_TOKEN
// LINE_CHANNEL_SECRET
// GOOGLE_APPLICATION_CREDENTIALS
//
// 可选：
//
// PORT
// DEFAULT_TARGET_LANGUAGE
// BOT_USER_ID
// LOG_FULL_WEBHOOK_BODY
//

const PORT = process.env.PORT || 3001;
const DEFAULT_TARGET_LANGUAGE = process.env.DEFAULT_TARGET_LANGUAGE || "zh-CN";
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const BOT_USER_ID = process.env.BOT_USER_ID;
const LOG_FULL_WEBHOOK_BODY = process.env.LOG_FULL_WEBHOOK_BODY === "true";
const TARGET_LANGUAGE_FOR_CHINESE = "th";
const TARGET_LANGUAGE_FOR_THAI = "zh-CN";
const MAX_LINE_TEXT_LENGTH = 4900;

// =========================
// 检查必要配置
// =========================
//
// 如果缺少关键环境变量，程序启动时直接报错
// 这样比运行到一半才失败更容易排查
//

const requiredEnvNames = [
  "LINE_CHANNEL_SECRET",
  "GOOGLE_APPLICATION_CREDENTIALS",
];

if (!LINE_CHANNEL_ACCESS_TOKEN) {
  throw new Error(
    "Missing required environment variable: LINE_CHANNEL_ACCESS_TOKEN"
  );
}

for (const envName of requiredEnvNames) {
  if (!process.env[envName]) {
    throw new Error(`Missing required environment variable: ${envName}`);
  }
}

// =========================
// 初始化 LINE Bot Client
// =========================
//
// channelAccessToken:
// 用于调用 LINE API 发送 / 回复消息
//
// channelSecret:
// 用于验证 Webhook 请求确实来自 LINE
//

const clientConfig = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
};

const middlewareConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: clientConfig.channelAccessToken,
});

// =========================
// 初始化 Google Translate
// =========================
//
// SDK 会自动读取：
//
// GOOGLE_APPLICATION_CREDENTIALS
//
// 例如 Docker 容器内：
//
// /secrets/service-account.json
//

const translateClient = new Translate();

// =========================
// 创建 Express 应用
// =========================

const app = express();

// =========================
// 健康检查接口
// =========================
//
// 用途：
//
// - 确认容器是否正常运行
// - 确认 cloudflared 是否能访问 Node.js 服务
//
// 本机访问：
//
// http://localhost:3001/health
//

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "line-translate-bot",
  });
});

// =========================
// LINE Webhook 接口
// =========================
//
// LINE Developers 后台 Webhook URL 填：
//
// https://你的域名/webhook
//
// line.middleware(middlewareConfig)
//
// 会自动：
//
// - 校验 LINE 签名
// - 解析 LINE webhook body
// - 把事件放到 req.body.events
//

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

    // LINE 需要 webhook 尽快返回 200
    res.status(200).end();
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).end();
  }
});

// =========================
// 处理单个 LINE 事件
// =========================
//
// 当前处理：
//
// - message 事件
// - text 文字消息
// - user 私聊
// - group 群聊
// - room 多人聊天室
//
// 其他类型事件会直接忽略
//

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

  if (event.type !== "message") {
    return null;
  }

  if (!event.message || event.message.type !== "text") {
    return null;
  }

  if (!isSupportedSource(event.source)) {
    console.log("Ignored unsupported source:", {
      sourceType: event.source?.type,
      time: new Date().toISOString(),
    });
    return null;
  }

  if (event.deliveryContext?.isRedelivery) {
    console.log("Ignored redelivery event:", {
      sourceType: event.source.type,
      groupId: event.source.groupId,
      roomId: event.source.roomId,
      userId: event.source.userId,
      time: new Date().toISOString(),
    });
    return null;
  }

  if (BOT_USER_ID && event.source.userId === BOT_USER_ID) {
    console.log("Ignored bot self message:", {
      sourceType: event.source.type,
      groupId: event.source.groupId,
      roomId: event.source.roomId,
      userId: event.source.userId,
      time: new Date().toISOString(),
    });
    return null;
  }

  const originalText = event.message.text.trim();

  if (!originalText) {
    return null;
  }

  // =========================
  // 查看当前翻译规则
  // =========================
  //
  // 在 LINE 群里发送：
  //
  // /lang
  //

  if (originalText === "/lang") {
    return lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [
        {
          type: "text",
          text:
            "当前翻译规则：中文 -> 泰文，泰文 -> 中文。" +
            `其他语言 -> ${DEFAULT_TARGET_LANGUAGE}`,
        },
      ],
    });
  }

  // =========================
  // 跳过翻译
  // =========================
  //
  // 以 ! 开头的消息不会翻译
  //
  // 例如：
  //
  // !这句话不要翻译
  //

  if (originalText.startsWith("!")) {
    return null;
  }

  // =========================
  // 检测源语言
  // =========================
  //
  // detect(text)
  //
  // 会返回 Google 判断出的源语言
  //
  // 常见结果：
  //
  // - zh-CN / zh-TW / zh：中文
  // - th：泰文
  //

  const sourceLanguage = await detectSourceLanguage(originalText);
  const targetLanguage = getTargetLanguage(sourceLanguage);

  // =========================
  // 调用 Google Translate
  // =========================
  //
  // 规则：
  //
  // - 中文 -> 泰文
  // - 泰文 -> 中文
  // - 其他语言 -> DEFAULT_TARGET_LANGUAGE
  //

  let translatedText;

  try {
    const [result] = await translateClient.translate(
      originalText,
      targetLanguage
    );
    translatedText = result;
  } catch (error) {
    console.error("Translate API failed:", {
      error: error.message,
      sourceLanguage,
      targetLanguage,
      sourceType: event.source.type,
      groupId: event.source.groupId,
      roomId: event.source.roomId,
      userId: event.source.userId,
      time: new Date().toISOString(),
    });
    return null;
  }

  console.log("Translation:", {
    sourceType: event.source.type,
    groupId: event.source.groupId,
    roomId: event.source.roomId,
    userId: event.source.userId,
    sourceLanguage,
    targetLanguage,
    originalLength: originalText.length,
    time: new Date().toISOString(),
  });

  // =========================
  // 避免重复回复
  // =========================
  //
  // 如果原文和译文一样，一般代表：
  //
  // - 原文已经是目标语言
  // - 或者内容不需要翻译
  //

  if (!translatedText || translatedText.trim() === originalText) {
    return null;
  }

  // =========================
  // 回复翻译结果
  // =========================
  //
  // replyMessage 会回复到原来的聊天窗口
  //
  // 如果消息来自群聊，就回复到同一个群聊
  //

  const replyText = translatedText.slice(0, MAX_LINE_TEXT_LENGTH);

  console.log("Replying translation:", {
    sourceType: event.source.type,
    groupId: event.source.groupId,
    roomId: event.source.roomId,
    userId: event.source.userId,
    replyLength: replyText.length,
    time: new Date().toISOString(),
  });

  try {
    return await lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [
        {
          type: "text",
          text: replyText,
        },
      ],
    });
  } catch (error) {
    console.error("LINE reply failed:", {
      error: error.message,
      sourceType: event.source.type,
      groupId: event.source.groupId,
      roomId: event.source.roomId,
      userId: event.source.userId,
      time: new Date().toISOString(),
    });
    return null;
  }
}

// =========================
// 判断聊天来源是否支持
// =========================
//
// LINE 的文字消息可能来自：
//
// - user：私聊
// - group：群聊
// - room：多人聊天室
//
// 这三种都实时翻译
//

function isSupportedSource(source) {
  return ["user", "group", "room"].includes(source?.type);
}

// =========================
// 检测源语言
// =========================
//
// Google Translate v2 的 detect 返回值
// 在不同输入下可能是对象或数组
//
// 这里统一整理成 language 字符串
//

async function detectSourceLanguage(text) {
  const localLanguage = detectLanguageByCharacters(text);

  if (localLanguage) {
    return localLanguage;
  }

  const [detection] = await translateClient.detect(text);
  const firstDetection = Array.isArray(detection) ? detection[0] : detection;

  return firstDetection?.language || "und";
}

// =========================
// 本地字符判断
// =========================
//
// Google detect 对非常短的内容
// 例如“哈哈”、“555”、“ครับ”
// 可能会误判或返回 und
//
// 所以先用 Unicode 范围做一次快速判断
//

function detectLanguageByCharacters(text) {
  if (/[\u0E00-\u0E7F]/.test(text)) {
    return "th";
  }

  if (/[\u4E00-\u9FFF]/.test(text)) {
    return "zh";
  }

  return null;
}

// =========================
// 根据源语言选择目标语言
// =========================
//
// 中文：
//
// - zh
// - zh-CN
// - zh-TW
// - zh-HK
//
// 泰文：
//
// - th
//

function getTargetLanguage(sourceLanguage) {
  if (isChineseLanguage(sourceLanguage)) {
    return TARGET_LANGUAGE_FOR_CHINESE;
  }

  if (sourceLanguage === "th") {
    return TARGET_LANGUAGE_FOR_THAI;
  }

  return DEFAULT_TARGET_LANGUAGE;
}

// =========================
// 判断是否为中文
// =========================
//
// Google 返回的中文语言代码
// 通常以 zh 开头
//

function isChineseLanguage(language) {
  return typeof language === "string" && language.toLowerCase().startsWith("zh");
}

// =========================
// 统一错误处理
// =========================
//
// Webhook 签名错误或其他 Express 错误
// 会进入这里
//

app.use((error, req, res, next) => {
  console.error("Application error:", error);
  res.status(500).json({
    ok: false,
    message: "Internal Server Error",
  });
});

// =========================
// 启动服务
// =========================
//
// 监听 0.0.0.0
//
// Docker 容器外部才能访问这个服务
//

app.listen(PORT, "0.0.0.0", () => {
  console.log(`LINE translate bot is running on port ${PORT}`);
});
