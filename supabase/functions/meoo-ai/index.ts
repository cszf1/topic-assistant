/**
 * Meoo 官方 AI 服务 Edge Function
 * 
 * 【设计定位】
 * 本函数是科研选题工具对接 Meoo 平台的云端代理插槽 (Edge Proxy)。
 * 当项目导入 Meoo 平台后，平台可无缝接管本函数，使用平台的内置 AI 服务和密钥额度。
 * 
 * 【官方文档参考】
 * - AI 服务介绍与模型清单: https://docs.meoo.com/ai
 * - 云服务能力与密钥规范:   https://docs.meoo.com/file-6
 * 
 * 【核心特性】
 * 1. 零密钥暴露：API Key 由 Meoo 平台自动注入到环境变量 MEOO_PROJECT_API_KEY，前端完全无需接触密钥；
 * 2. 彻底解决 CORS：提供全开放的 Access-Control 标头与 OPTIONS 预检支持，避免纯前端跨域被拦截；
 * 3. 毫秒级打字机流式：采用 ReadableStream 直通透传，原生支持 Server-Sent Events (SSE)；
 * 4. 兼容官方 6 大模型：对齐通义千问、DeepSeek、GLM、Kimi、MiniMax 等最新模型。
 */

// Meoo 官方当前支持的文本对话与推理模型列表
const MODELS = [
  'deepseek-v3.2', // 深度求索：代码与推理能力突出
  'glm-5',          // 智谱 AI：中文理解能力优秀
  'kimi-k2.5',      // 月之暗面：长文本上下文理解
  'qwen3.6-plus',   // 通义千问旗舰版：综合能力强
  'qwen3-max',      // 通义千问增强版：适合复杂推理任务
  'MiniMax-M2.5',   // MiniMax：多模态与综合对话能力强
];

// 全局 CORS 标头定义，允许任意浏览器前端安全发起跨域请求
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

/**
 * 构造统一的 JSON 响应对象
 * @param {unknown} body 响应数据体
 * @param {number} status HTTP 状态码
 * @returns {Response}
 */
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/**
 * 安全拼接上游 API 完整路径，去除多余的斜杠
 * @param {string} baseUrl 基础 URL
 * @param {string} path 相对路径
 * @returns {string}
 */
function upstreamUrl(baseUrl: string, path: string) {
  return baseUrl.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}

Deno.serve(async (req) => {
  // -------------------------------------------------------------
  // 步骤 1: 处理浏览器的 OPTIONS 预检请求
  // 浏览器在发送自定义 Header（如 authorization、apikey）前会先发 OPTIONS 请求，
  // 此处直接返回放行标头，避免前端出现 CORS 404 / 403 阻断。
  // -------------------------------------------------------------
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  const tail = path.split('/').slice(-2).join('/');

  // -------------------------------------------------------------
  // 步骤 2: 模型列表探测接口 (支持 GET /meoo-ai 或 /v1/models)
  // 供前端界面拉取可用模型列表，保持与 OpenAI /v1/models 协议标准一致。
  // -------------------------------------------------------------
  if (req.method === 'GET' && (tail === 'meoo-ai' || tail === 'ai/models' || tail.endsWith('models'))) {
    return json({
      object: 'list',
      data: MODELS.map(id => ({ id, object: 'model', owned_by: 'meoo' })),
    });
  }

  // 校验请求路径，仅允许 chat/completions 入口
  if (req.method !== 'POST' || !tail.endsWith('chat/completions')) {
    return json({ error: { message: '接口路径不匹配，仅支持 POST /chat/completions' } }, 404);
  }

  // -------------------------------------------------------------
  // 步骤 3: 从 Meoo 平台环境变量中读取服务端凭据
  // MEOO_PROJECT_API_KEY: 平台开通 AI 服务后自动注入的 Service AK
  // -------------------------------------------------------------
  const apiKey = Deno.env.get('MEOO_PROJECT_API_KEY') || Deno.env.get('MEOOPROJECTAPI_KEY');
  const baseUrl = Deno.env.get('MEOO_PROJECT_BASE_URL') || Deno.env.get('MEOOPROJECT_BASE_URL') || 'https://api.meoo.host/meoo-ai/compatible-mode/v1';

  if (!apiKey) {
    return json({ error: { message: 'Meoo AI 服务尚未绑定 MEOO_PROJECT_API_KEY，请在 Meoo 控制台开启 AI 服务' } }, 503);
  }

  // 解析并校验前端提交的请求体
  let input: Record<string, unknown>;
  try {
    input = await req.json();
  } catch {
    return json({ error: { message: '请求体解析失败：必须为合法的 JSON 格式' } }, 400);
  }

  const model = String(input.model || '');
  if (!MODELS.includes(model)) {
    return json({
      error: {
        message: `不支持的模型 [${model}]，当前 Meoo 平台支持的模型为: ${MODELS.join(', ')}`,
      },
    }, 400);
  }

  // -------------------------------------------------------------
  // 步骤 4: 规范化请求体并转发至 Meoo 上游官方接口
  // 默认启用 stream 流式输出，保证打字机效果。
  // -------------------------------------------------------------
  const body: Record<string, unknown> = {
    model,
    messages: input.messages,
    stream: input.stream !== false,
  };
  if (typeof input.temperature === 'number') body.temperature = input.temperature;
  if (typeof input.max_tokens === 'number') body.max_tokens = input.max_tokens;
  if (typeof input.max_completion_tokens === 'number') body.max_completion_tokens = input.max_completion_tokens;
  if (input.response_format) body.response_format = input.response_format;

  try {
    const upstreamRes = await fetch(upstreamUrl(baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    // -------------------------------------------------------------
    // 步骤 5: 响应直通透传 (ReadableStream)
    // 直接把上游的 body 流（SSE / JSON）透传回前端，同时附带 CORS 标头，
    // 既实现了毫秒级的流式打字机效果，又消除了前端跨域限制。
    // -------------------------------------------------------------
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: {
        ...corsHeaders,
        'Content-Type': upstreamRes.headers.get('content-type') || (body.stream ? 'text/event-stream' : 'application/json; charset=utf-8'),
      },
    });
  } catch (error: any) {
    return json({ error: { message: `Meoo 上游网关通信异常: ${error?.message || error}` } }, 502);
  }
});
