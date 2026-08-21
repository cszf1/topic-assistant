# Meoo 官方 AI 服务 Edge Function

本函数用于在 Meoo 平台接管应用时，作为内置 AI 的安全转发网关。

- 官方文档：[Meoo AI 服务](https://docs.meoo.com/ai) | [云服务能力介绍](https://docs.meoo.com/file-6)
- 安全机制：由 Meoo 平台在部署/开通服务时自动注入 `MEOO_PROJECT_API_KEY`，服务端直连，密钥绝不下发至浏览器。

## 支持的官方模型列表

- `deepseek-v3.2`：DeepSeek 代码与推理能力
- `glm-5`：智谱 GLM 中文理解
- `kimi-k2.5`：月之暗面长文本
- `qwen3.6-plus`：通义千问旗舰版
- `qwen3-max`：通义千问增强版（复杂推理）
- `MiniMax-M2.5`：MiniMax 多模态综合

## 环境变量说明

| 变量名 | 说明 | 默认值 / 来源 |
|---|---|---|
| `MEOO_PROJECT_API_KEY` | Meoo 平台 Service AK | 平台自动注入（控制台开启 AI 服务） |
| `MEOO_PROJECT_BASE_URL` | 上游兼容接口 Base URL | `https://api.meoo.host/meoo-ai/compatible-mode/v1` |

## 部署方式

当项目导入 Meoo 平台时，平台会自动识别 `supabase/functions/` 并完成托管；若通过 Supabase CLI 手动部署：

```bash
supabase functions deploy meoo-ai --no-verify-jwt
```
