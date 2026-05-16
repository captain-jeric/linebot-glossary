# LINE Translate Bot 项目文档

## 1. 项目概述

这是一个部署在 Google Cloud Run 上的 LINE 翻译机器人，使用 LINE `USERID` 授权和 Supabase/PostgreSQL 持久化。机器人面向付费/授权用户，支持私聊翻译、群聊翻译、额度扣费、后台开通用户、流量充值和群聊绑定管理。

核心能力：

- LINE 私聊、群聊、多人聊天室文本翻译。
- 管理员后台按 `USERID` 新增、搜索、编辑和暂停用户。
- 未授权用户可发送 `userid` 获取自己的 LINE `USERID`。
- 单一流量余额模型：`quota_chars` 为总购买字符，`used_chars` 为已用字符。
- 账号过期、暂停或余额不足时不再翻译。
- 双语模式和中文/泰文/缅文三语模式。
- 群聊自动绑定付费账号，后台可改绑、解绑或切换自动翻译。
- Google OAuth 管理员登录，也支持备用 `ADMIN_TOKEN`。

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
ADMIN_ALLOWED_EMAILS=admin@example.com
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
SESSION_SECRET
PORT=8080
LOG_FULL_WEBHOOK_BODY=false
GOOGLE_APPLICATION_CREDENTIALS_JSON
```

说明：

- `BOT_USER_ID` 用于避免机器人处理自己发送的消息。
- `ADMIN_TOKEN` 是 Google 登录之外的备用后台入口。
- `ADMIN_TAILSCALE_ONLY=true` 时，后台只允许 localhost 或 Tailscale 地址访问。
- `GOOGLE_APPLICATION_CREDENTIALS_JSON` 可放 Google service account JSON，Cloud Run 也可以通过 runtime service account 授权 Translation API。

## 4. 数据库设计

数据库脚本：

```text
supabase-schema.sql
```

说明：

- `supabase-schema.sql` 用于新 Supabase 项目首次初始化，脚本不会删除已有表。
- 已有生产数据库不要重复当作“重建脚本”使用；如需从旧版月度套餐/加油包模型迁移，请先执行 `supabase-migration-flow-billing.sql`。
- 如旧库缺少群聊绑定表或 `translation_enabled` 字段，请执行 `supabase-migration-conversation-users.sql`。

### 4.1 users 表

用户授权主表。

关键字段：

- `line_user_id`：LINE USERID，唯一。
- `name`：后台自定义用户名。
- `status`：`active` 或 `paused`。
- `mode`：`bilingual` 或 `trilingual`。
- `from_lang` / `to_lang`：双语模式语言。`from_lang` 是默认语言，`to_lang` 是常用互译语言；其他语言默认翻译成 `from_lang`。
- `quota_chars`：总购买字符。
- `used_chars`：已用字符。
- `expires_at`：账号到期时间。
- `last_active_at`：最后使用时间。
- `notes`：备注。

### 4.2 user_renewals 表

购买、充值、调整流水表。

关键字段：

- `user_id`：关联用户。
- `type`：`purchase`、`recharge` 或 `adjustment`。
- `chars_delta`：本次增加的字符数。
- `expires_at_before` / `expires_at_after`：操作前后的到期时间。
- `note`：管理员备注。

后台在流量充值面板中展示最近 10 条记录。

### 4.3 conversation_users 表

群聊和多人聊天室绑定表。

关键字段：

- `source_type`：`group` 或 `room`。
- `conversation_id`：LINE `groupId` 或 `roomId`。
- `user_id`：该群聊扣费使用的用户。
- `translation_enabled`：是否开启群聊自动翻译。
- `mode`：群聊翻译模式，可为空。为空时使用用户默认模式。
- `from_lang` / `to_lang`：群聊默认语言和互译语言，可为空。为空时使用用户默认语言。

同一个群聊或多人聊天室只能绑定一个付费账号。后台支持改绑、解绑和切换自动翻译。

### 4.4 increment_user_usage RPC

`increment_user_usage(p_user_id, p_chars)` 用于原子扣减额度。

扣费规则：

1. 账号必须为 `active`。
2. `expires_at` 必须晚于当前时间。
3. `quota_chars - used_chars` 必须大于等于本次扣费字符数。
4. 扣费成功后增加 `used_chars` 并更新 `last_active_at`。

### 4.5 recharge_user_flow RPC

`recharge_user_flow(p_user_id, p_chars, p_expires_at)` 用于充值。

充值规则：

- 增加 `quota_chars`。
- 将账号状态设置为 `active`。
- 将 `expires_at` 设置为管理员选择的日期。
- 写入 `user_renewals` 作为充值记录。

## 5. 用户逻辑

用户私聊机器人时，系统读取 `event.source.userId`。

群聊或多人聊天室中：

- 当前可用的授权用户发言时，系统会把当前 `groupId` / `roomId` 自动绑定到该付费账号。
- 已暂停、已过期或余额不足的用户不会触发群聊绑定，也不能修改群聊翻译开关或默认语言。
- 同一群/聊天室内的其他成员发言时，如果自己的 USERID 未开通，系统会使用该群/聊天室绑定的付费账号进行翻译和扣费。
- 已授权用户可在群里发送 `set on` 开启自动翻译，发送 `set off` 关闭自动翻译。
- 已授权用户在群里发送 `set zh th` 等语言命令时，只修改当前群聊语言，不影响该用户的其他群聊或私聊默认语言。
- 已授权用户在私聊中发送 `set zh th` 等语言命令时，修改用户自己的默认语言。
- 关闭自动翻译后，普通消息不翻译；`/TH 内容`、`/ZH 内容`、`/MM 内容` 等指定翻译命令仍然会翻译。
- 私聊仍然必须使用本人 USERID 授权。

未授权用户私聊机器人时，机器人会回复开通提示和当前 `USERID`。

翻译前检查顺序：

1. 找到用户或群聊绑定用户。
2. 检查用户状态是否为 `active`。
3. 检查账号是否未过期。
4. 检查剩余字符是否足够。
5. 检测源语言并调用 Google Translation API。
6. 翻译成功后扣减字符。

普通消息的翻译配置优先级：

1. `/TH 内容`、`/ZH 内容` 等指定翻译命令。
2. 当前群聊语言配置。
3. 绑定用户的默认语言配置。
4. 系统默认 `zh th`。

双语模式下，第一种语言是默认语言，第二种语言是互译语言。支持列表中的任意两种语言组合。例如 `set th en` 表示默认泰文、常用互译英文；收到泰文会翻译成英文，收到英文会翻译成泰文，收到日文等其他语言会翻译成泰文。

## 6. 后台页面

后台地址：

```text
/admin
```

页面模块：

1. 新增用户。
2. 流量充值。
3. 有效用户列表。
4. 过期/暂停用户列表。
5. 群聊绑定管理。

新增用户：

- 输入 `USERID`、用户名、初始流量、状态、默认语言、互译语言、有效期和备注。
- 默认语言会写入用户配置，普通消息按该语言对翻译。
- 初始购买会写入 `user_renewals`。

流量充值：

- 输入 `USERID` 检索用户。
- 选择增加流量和套餐时长。
- 可手动填写充值后的有效期日期；不填时按套餐时长计算。
- 充值后账号状态恢复为 `active`。
- 面板展示最近充值记录。

用户列表：

- 支持按 `USERID`、用户名、备注搜索。
- 默认显示 20 条，可选择 50 或 100 条。
- 展开用户后可编辑 `USERID`、用户名、状态、模式、语言、总购买字符、已用字符、有效期和备注。

群聊绑定管理：

- 展示最近更新的群聊/聊天室绑定。
- 可改绑到另一个 `USERID`。
- 可开启或关闭该群聊自动翻译。
- 可设置当前群聊的翻译模式、默认语言和互译语言。
- 可解绑，让该群下次由授权用户重新触发绑定。

## 7. 用户命令

```text
help        查看帮助
/help       查看帮助
userid      查看 USERID
/userid     查看 USERID
/usage      查看额度
/status     查看状态
set on      开启群聊自动翻译
set off     关闭群聊自动翻译
set 3lang   开启中文 / 泰文 / 缅文三语模式
支持任意两种语言组合，例如：
set zh th   默认中文 ↔ 泰文
set zh ja   默认中文 ↔ 日文
set th ja   默认泰文 ↔ 日文
/TH 内容    指定翻译成泰文
/MM 内容    指定翻译成缅文
/ZH 内容    指定翻译成中文
/TW 内容    指定翻译成繁体中文
/EN 内容    指定翻译成英文
/JP 内容    指定翻译成日文
/DE 内容    指定翻译成德文
/FR 内容    指定翻译成法文
/ES 内容    指定翻译成西文
/RU 内容    指定翻译成俄文
/MS 内容    指定翻译成马来文
/KO 内容    指定翻译成韩文
/ID 内容    指定翻译成印尼文
/VI 内容    指定翻译成越南文
/HI 内容    指定翻译成印地文
/AR 内容    指定翻译成阿拉伯文
```

## 8. 部署要点

1. 新 Supabase 项目首次部署时，在 SQL Editor 执行 `supabase-schema.sql`。
2. 已有旧版生产库升级时，不要重建数据库；按需要执行 `supabase-migration-flow-billing.sql` 和 `supabase-migration-conversation-users.sql`。
3. 在 Cloud Run 配置环境变量。
4. 在 LINE Developers 配置 Webhook URL：

```text
https://你的-cloud-run-url/webhook
```

5. 在 Google Cloud Console 配置后台 OAuth redirect URI：

```text
https://你的-cloud-run-url/admin/auth/google/callback
```

6. 部署后访问健康检查：

```text
https://你的-cloud-run-url/health
```

## 9. 当前限制和后续建议

- 低余额/即将过期主动提醒尚未实现。
- 后台使用记录还没有单独流水表，目前只记录总已用字符。
- 群聊绑定列表默认展示最近 50 条。
- 搜索使用 Supabase `ilike`，适合简单运营检索，不是全文搜索。
