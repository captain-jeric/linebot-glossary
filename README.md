# LINE Translate Bot for Cloud Run

Cloud Run 需要配置的环境变量：

- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ADMIN_TOKEN`
- `ADMIN_TAILSCALE_ONLY=false`
- `LOG_FULL_WEBHOOK_BODY=false`

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
