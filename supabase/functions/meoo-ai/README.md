# Meoo 内置 AI Edge Function

部署前在 Supabase 项目环境变量中设置：

```text
MEOOPROJECTAPI_KEY=Meoo 平台提供的服务端 Key
MEOOPROJECT_BASE_URL=Meoo 提供的 OpenAI 兼容 API 根地址（含 /v1，如适用）
```

部署函数：

```bash
supabase functions deploy meoo-ai
```

然后将 `web/index.html` 中的 `MEOO_EDGE_FUNCTION_URL` 替换为：

```text
https://<你的项目>.supabase.co/functions/v1/meoo-ai
```

函数仅允许列出的 Meoo 模型和 `/chat/completions`，不会向浏览器暴露 `MEOOPROJECTAPI_KEY`。
