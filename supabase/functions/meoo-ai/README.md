# Meoo 官方 AI 服务与通用跨域代理 Edge Function (双轨模式)

本函数用于在 Meoo 平台接管应用时，作为内置 AI 与自定义接口的云端代理网关。

- 官方文档：[Meoo AI 服务](https://docs.meoo.com/ai) | [云服务能力介绍](https://docs.meoo.com/file-6)
- 架构形态：**双轨智能路由 (Dual-Track Router)**

---

## 路由模式说明

### 轨道 A：Meoo 官方内置免 Key 模式（默认）
- **触发条件**：前端未传入 `x-target-url`
- **特点**：由 Meoo 平台在云端自动读取 `MEOO_PROJECT_API_KEY`，消耗平台赠送额度，**用户无需自备 Key**。
- **支持模型**：`deepseek-v3.2`、`glm-5`、`kimi-k2.5`、`qwen3.6-plus`、`qwen3-max`、`MiniMax-M2.5`。

### 轨道 B：通用透明代理网关模式（突破 CORS 跨域）
- **触发条件**：前端传入 `x-target-url` 标头（例如 `https://opencode.ai/zen/go/v1` 或自建网关）
- **特点**：函数在云端充当透明代理节点，带上用户传入的密钥转发请求并补全 CORS 标头，使 OpenCode Zen 等不带跨域头的外部服务在浏览器中也能正常调用。
- **支持模型**：目标上游所支持的任意模型。

---

## 环境变量说明

| 变量名 | 说明 | 默认值 / 来源 |
|---|---|---|
| `MEOO_PROJECT_API_KEY` | Meoo 平台 Service AK | 平台自动注入（控制台开启 AI 服务） |
| `MEOO_PROJECT_BASE_URL` | Meoo 官方兼容接口 Base URL | `https://api.meoo.host/meoo-ai/compatible-mode/v1` |
