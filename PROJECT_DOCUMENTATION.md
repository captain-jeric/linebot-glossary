# LINE Translate Bot 项目文档

## 1. 项目概述

这是一个部署在 Google Cloud Run 上的 LINE 翻译机器人。当前版本使用 LINE `USERID` 授权，不再使用激活码。

核心能力：

- LINE 私聊、群聊、多人聊天室文本翻译。
- 管理员后台按 `USERID` 新增和管理用户。
- 未授权用户私聊机器人时返回自己的 `USERID`，方便提交给管理员开通。
- 月度套餐和加油包字符扣减。
- 账号过期后，月度套餐和加油包都不可用。
- 管理后台支持新增用户、月度续费、加油包充值、有效用户和过期用户列表。
- Google OAuth 管理员登录。
- Supabase/PostgreSQL 持久化。

## 2. 技术栈

- Runtime：Node.js
- Web 框架：Express 5
- LINE SDK：`@line/bot-sdk`
- 翻译服务：Google Cloud Translation API v2
- 数据库：Supabase / PostgreSQL
- 部署：Google Cloud Run
- 容器：Docker

启动脚本：

```bash
npm start
```

入口文件：

```text
src/index.js
```

## 3. 环境变量

必填：

```text
LINE_CHANNEL_SECRET
LINE_CHANNEL_ACCESS_TOKEN
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

推荐配置：

```text
BOT_USER_ID
ADMIN_TOKEN
ADMIN_TAILSCALE_ONLY=false
ADMIN_ALLOWED_EMAILS=chenglingmei64@gmail.com,majiacheng@gmail.com,x.havecai@gmail.com
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
SESSION_SECRET
PORT=8080
LOG_FULL_WEBHOOK_BODY=false
GOOGLE_APPLICATION_CREDENTIALS_JSON
```

## 4. 数据库设计

数据库脚本：

```text
supabase-schema.sql
```

### 4.1 users 表

用户授权主表。

关键字段：

- `line_user_id`：LINE USERID，唯一。
- `name`：后台自定义用户名。
- `status`：`active` 或 `paused`。
- `mode`：`bilingual` 或 `trilingual`。
- `from_lang` / `to_lang`：双语模式语言。
- `monthly_quota_chars`：月度套餐额度。
- `monthly_used_chars`：当前月份已用月度额度。
- `extra_quota_chars`：加油包总额度。
- `extra_used_chars`：加油包已用额度。
- `billing_period`：当前账期，格式 `yyyy-mm`。
- `expires_at`：账号到期时间。
- `last_active_at`：最后使用时间。
- `notes`：备注。

### 4.2 user_renewals 表

续费流水表。

关键字段：

- `user_id`：关联用户。
- `type`：`monthly`、`topup` 或 `adjustment`。
- `chars_delta`：本次增加的字符数。
- `expires_at_before` / `expires_at_after`：续费前后的到期时间。
- `note`：管理员备注。

### 4.3 increment_user_usage RPC

`increment_user_usage(p_user_id, p_chars)` 用于原子扣减额度。

扣减顺序：

1. 优先扣月度套餐额度。
2. 月度套餐不足时扣加油包额度。
3. 总剩余额度不足时不扣费，并返回空结果。
4. 如果账号已过期或暂停，不扣费。

账期按 `Asia/Bangkok` 当前月份计算。账号过期后，加油包余额仍会保留在后台，但对用户不可用。

## 5. 用户逻辑

用户私聊机器人或在群里发消息时，系统读取 `event.source.userId`。

未授权用户私聊机器人时，无论发送什么文本，都回复：

```text
请联系管理员添加权限。
USERID：xxx
```

用户发送 `userid`、`/userid` 或 `/usage` 时：

- 未授权：返回开通提示和 `USERID`。
- 已授权：返回用户名、有效期、月度剩余、加油包剩余、总剩余。

翻译前检查顺序：

1. `USERID` 是否存在。
2. 状态是否为 `active`。
3. 是否未过期。
4. 总剩余字符是否足够。

## 6. 后台页面

后台地址：

```text
/admin
```

页面顺序：

1. 新增用户。
2. 续费模块。
3. 有效用户列表。
4. 过期用户列表。

有效用户：

- `status = active`
- `expires_at >= 当前时间`
- 按到期日期升序，快到期排在最上面。
- 只显示前 20 条。

过期用户：

- 已过期或暂停。
- 按到期日期降序，刚刚过期排在最上面。
- 只显示前 20 条。

续费模块：

- 先输入 `USERID` 检索用户。
- 检索成功后显示用户名、状态、到期日期、月度额度、月度已用、加油包额度、加油包已用和剩余额度。
- 月度续费：延长账号有效期，设置月度额度，可选择清零本月已用。
- 加油包充值：只增加额外字符，不改变到期时间。
- 月度额度和加油包充值额度使用下拉列表，10 万起，10 万递增，100 万封顶。
- 已用额度只展示，不在后台表单中直接修改。

## 7. 用户命令

```text
userid       查看 USERID 和用量
/userid      查看 USERID 和用量
/usage       查看用量
/status      查看状态
set zh th    中文 ↔ 泰文
set zh my    中文 ↔ 缅文
set zh en    中文 ↔ 英文
set th my    泰文 ↔ 缅文
set 3lang    中/泰/缅三语模式
/TH 内容     指定翻译成泰文
/MM 内容     指定翻译成缅文
/ZH 内容     指定翻译成中文
/EN 内容     指定翻译成英文
/JP 内容     指定翻译成日文
/DE 内容     指定翻译成德文
/FR 内容     指定翻译成法文
/ES 内容     指定翻译成西文
/RU 内容     指定翻译成俄文
/MS 内容     指定翻译成马来文
/KO 内容     指定翻译成韩文
/ID 内容     指定翻译成印尼文
/VI 内容     指定翻译成越南文
/HI 内容     指定翻译成印地文
/AR 内容     指定翻译成阿拉伯文
```

## 8. 部署要点

1. 在 Supabase SQL Editor 执行 `supabase-schema.sql`。
2. 在 Cloud Run 配置环境变量。
3. 在 LINE Developers 配置 Webhook URL：

```text
https://你的-cloud-run-url/webhook
```

4. 在 Google Cloud Console 配置后台 OAuth redirect URI：

```text
https://你的-cloud-run-url/admin/auth/google/callback
```
