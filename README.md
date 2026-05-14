# LINE Translate Bot for Cloud Run

Cloud Run 需要配置的环境变量：

- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ADMIN_ALLOWED_EMAILS=chenglingmei64@gmail.com,majiacheng@gmail.com,x.havecai@gmail.com`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `SESSION_SECRET`
- `ADMIN_TOKEN` 备用登录入口，可选但建议保留一个强随机值
- `ADMIN_TAILSCALE_ONLY=false`
- `LOG_FULL_WEBHOOK_BODY=false`

后台 Google 登录配置：

1. 在 Google Cloud Console 创建 OAuth 2.0 Client ID，类型选择 Web application。
2. Authorized redirect URI 填：

```text
https://你的-cloud-run-url/admin/auth/google/callback
```

3. 把 Client ID 和 Client Secret 分别配置到 Cloud Run 环境变量：

```text
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
SESSION_SECRET=一段强随机字符串
ADMIN_ALLOWED_EMAILS=chenglingmei64@gmail.com,majiacheng@gmail.com,x.havecai@gmail.com
```

后台地址：

```text
https://你的-cloud-run-url/admin
```

Google Translate 凭证二选一：

- 推荐：给 Cloud Run 的运行服务账号授予 Cloud Translation API 权限，不需要设置凭证文件。
- 或者：把 service account JSON 存到 Secret Manager，并映射为 `GOOGLE_APPLICATION_CREDENTIALS_JSON` 环境变量。

LINE Webhook URL：

```text
https://你的-cloud-run-url/webhook
```

健康检查：

```text
https://你的-cloud-run-url/health
```
