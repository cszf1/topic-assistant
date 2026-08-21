# Meoo 官方 AI 服务与受控代理 Edge Function（双轨模式）

Meoo 平台接管本项目时的云端网关，同时承担「内置免 Key 出题」与「突破浏览器 CORS」两件事。

- 官方文档：[Meoo AI 服务](https://docs.meoo.com/ai) ｜ [云服务能力介绍](https://docs.meoo.com/file-6)
- 架构：**双轨智能路由（Dual-Track Router）**

---

## 轨道 A：Meoo 官方内置免 Key 模式（默认）

| 项 | 说明 |
|---|---|
| 触发条件 | 请求**不带** `x-target-url` |
| 凭据来源 | 平台自动注入的 `MEOO_PROJECT_API_KEY`（仅存于服务端） |
| 用户成本 | 零。不需要注册、不需要自备 Key |
| 可用模型 | `deepseek-v3.2`、`glm-5`、`kimi-k2.5`、`qwen3.6-plus`、`qwen3-max`、`MiniMax-M2.5` |

## 轨道 B：受控代理模式（突破 CORS）

| 项 | 说明 |
|---|---|
| 触发条件 | 请求头带 `x-target-url`，例如 `https://opencode.ai/zen/go/v1` |
| 凭据来源 | **必须**由前端通过 `x-custom-api-key` 提供，缺失直接 401 |
| 解决的问题 | OpenCode Zen 等服务不返回 CORS 头、且 OPTIONS 预检 404，浏览器无法直连 |
| 可用模型 | 上游支持的任意模型（不受轨道 A 白名单约束） |

---

## 安全边界（改动前请先读，这三条是有实测依据的）

### 1. 代理模式绝不回退平台密钥
早期实现写成 `customKey || env(MEOO_PROJECT_API_KEY)`，导致：任何人发一个指向自己服务器的
`x-target-url` 且不带 key，网关就会把平台密钥当 `Authorization` 送过去。已实测复现密钥外泄，
现改为缺少 `x-custom-api-key` 时返回 401。

### 2. 目标地址必须过 SSRF 校验
`x-target-url` 不加限制时可指向 `169.254.169.254`（云元数据）、`127.0.0.1`、
`10./172.16-31./192.168.` 内网段、`file://` 等，把边缘函数变成内网跳板；实测 `127.0.0.1` 曾成功返回 200。
现只放行 `https`，并拒绝回环、私有、链路本地、CGNAT、组播等保留网段。

### 3. 目标主机必须在放行名单内
否则等于对外提供匿名开放代理，云函数额度会被刷爆。

---

## 环境变量

| 变量名 | 必填 | 说明 |
|---|---|---|
| `MEOO_PROJECT_API_KEY` | 轨道 A 必填 | Meoo 平台 Service AK，开启 AI 服务后由平台自动注入 |
| `MEOO_PROJECT_BASE_URL` | 否 | 官方兼容接口根地址，默认 `https://api.meoo.host/meoo-ai/compatible-mode/v1` |
| `PROXY_ALLOWED_HOSTS` | 否 | 覆盖轨道 B 放行名单，逗号分隔；支持后缀匹配（`example.com` 同时匹配其子域） |
| `PROXY_ALLOW_INSECURE` | 否 | 仅本地联调用：置 `true` 可放开 http 与私网限制。**生产环境绝不要开** |

默认放行名单：`opencode.ai`、`api.deepseek.com`、`api.siliconflow.cn`、`openrouter.ai`、
`api.openai.com`、`open.bigmodel.cn`、`api.moonshot.cn`、`api.minimax.chat`、
`dashscope.aliyuncs.com`、`api.meoo.host`。

---

## 前端调用方式

```js
// 轨道 A：免 Key（什么都不用加）
fetch(FN_URL + '/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'glm-5', messages, stream: true }),
});

// 轨道 B：走 OpenCode Zen
fetch(FN_URL + '/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-target-url': 'https://opencode.ai/zen/go/v1',
    'x-custom-api-key': '<用户自己的 Zen Key>',
  },
  body: JSON.stringify({ model: 'gpt-5.6-luna', messages, stream: true }),
});
```

两条轨道都以 `ReadableStream` 直通透传上游响应，前端的思维链打字机效果不受影响。

---

## 本地验证

仓库根目录下的检验脚本覆盖 CORS、双轨分流、SSE 透传与上述三项安全边界，共 28 项断言：

```bash
node --experimental-strip-types .edge-test.cjs   # 需自行保留该脚本
```
