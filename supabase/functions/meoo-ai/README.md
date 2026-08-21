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

### 4. 重定向必须逐跳重新校验
`fetch` 默认 `redirect: 'follow'`，只校验初始 URL 挡不住绕过：放行名单里的域名
（或存在开放重定向的域名）只需回一个 `Location: http://127.0.0.1/`，本函数就成了内网跳板。
已实测复现（请求链 `redirector -> INTERNAL`）。现改用 `redirect: 'manual'`，
每一跳的 `Location` 都重跑 `validateTarget()`，跳数上限 3，且跳转后不再携带请求体与凭据。

### 5. 轨道 A 必须限额
网关 URL 写在纯静态页面里，等于公开；而轨道 A 花的是平台密钥。
若不限制，任何人 POST 一次 `{model:'glm-5', max_tokens:1000000}` 就能烧掉额度。
现施加：输出上限 16384 tokens（超出即夹取）、消息条数 ≤ 32、单次输入 ≤ 60000 字符（超出 413）。
轨道 B 用户自付费，不受这些限制。

### 6. 只从请求头取代理目标
不接受 `?target_url=` query——query 形态可被 `<img src>`、顶层导航等无需预检的方式触发。

### 7. 不拿 Authorization 顶替上游凭据
Supabase 在 `verify_jwt=true` 时要求调用方带 `Authorization: Bearer <anon/service_role>`，
那是平台凭据。早期实现会在缺少 `x-custom-api-key` 时回退读它并转发给上游，等于外泄平台凭据。
现缺少 `x-custom-api-key` 直接返回 401。

---

## 环境变量

| 变量名 | 必填 | 说明 |
|---|---|---|
| `MEOO_PROJECT_API_KEY` | 轨道 A 必填 | Meoo 平台 Service AK，开启 AI 服务后由平台自动注入 |
| `MEOO_PROJECT_BASE_URL` | 否 | 官方兼容接口根地址，默认 `https://api.meoo.host/meoo-ai/compatible-mode/v1` |
| `PROXY_ALLOWED_HOSTS` | 否 | 覆盖轨道 B 放行名单，逗号分隔；支持后缀匹配（`example.com` 同时匹配其子域） |
| `PROXY_ALLOW_INSECURE` | 否 | 仅本地联调用：置 `true` 可放开 http 与私网限制。**生产环境绝不要开** |
| `GATEWAY_ALLOWED_ORIGINS` | 建议填 | 允许调用本网关的页面来源，逗号分隔（如 `https://cszf1.github.io`）。留空则对全网开放，轨道 A 的平台额度谁都能花 |

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
node --experimental-strip-types test/edge-function-test.cjs   # 28 项：CORS、双轨分流、SSE 透传
node --experimental-strip-types test/edge-security-test.cjs   # 30 项：重定向绕过、白名单变体、限额、头注入
```

`edge-security-test.cjs` 覆盖的攻击面：白名单域名 302 到内网、`evil-opencode.ai` 前缀混淆、
`opencode.ai.evil.com` 后缀混淆、`@` 符号、尾点域名、十进制/十六进制/八进制 IP、
IPv4 映射 IPv6、`[::1]`、CGNAT、CRLF 头注入、轨道 A 限额、`?target_url=` 入口、安全响应头。

## 部署后必做

1. 配 `GATEWAY_ALLOWED_ORIGINS` 为你的站点源，否则网关对全网开放；
2. 确认 `PROXY_ALLOW_INSECURE` 未设置；
3. 若上游不在默认放行名单内，用 `PROXY_ALLOWED_HOSTS` 追加而不是关掉校验。
