/**
 * Meoo 官方 AI 服务与通用跨域代理 Edge Function (双轨智能路由模式)
 * 
 * 【设计定位】
 * 本函数是科研选题工具对接 Meoo 平台的云端代理插槽 (Edge Proxy)。
 * 采用【双轨智能路由】架构：
 * 
 * 1. 轨道 A（Meoo 官方内置免 Key 模式）：
 *    前端不指定自定义目标时，自动使用 Meoo 平台注入的环境变量 MEOO_PROJECT_API_KEY
 *    调用 Meoo 官方 6 大内置模型（通义千问、DeepSeek、GLM、Kimi、MiniMax 等），免除用户配置成本。
 * 
 * 2. 轨道 B（通用透明代理网关模式 - 突破浏览器 CORS 限制）：
 *    前端传入自定义目标（如 OpenCode Zen `https://opencode.ai/zen/go/v1`、自建 One-API 等）时，
 *    本函数在云端充当服务端代发节点，转发请求并加上 CORS 允许标头，彻底解决浏览器跨域 404 / 拦截问题。
 * 
 * 【官方文档参考】
 * - AI 服务介绍与模型清单: https://docs.meoo.com/ai
 * - 云服务能力与密钥规范:   https://docs.meoo.com/file-6
 */

// Meoo 官方当前内置支持的模型列表
const MEOO_OFFICIAL_MODELS = [
  'deepseek-v3.2', // 深度求索：代码与推理能力突出
  'glm-5',          // 智谱 AI：中文理解能力优秀
  'kimi-k2.5',      // 月之暗面：长文本上下文理解
  'qwen3.6-plus',   // 通义千问旗舰版：综合能力强
  'qwen3-max',      // 通义千问增强版：适合复杂推理任务
  'MiniMax-M2.5',   // MiniMax：多模态与综合对话能力强
];

// 全局 CORS 标头定义，彻底放行浏览器跨域与自定义请求头
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-target-url, x-custom-api-key',
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
  // -------------------------------------------------------------
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  const tail = path.split('/').slice(-2).join('/');

  // -------------------------------------------------------------
  // 识别路由模式：检查是否指定了自定义上游目标
  // -------------------------------------------------------------
  const customTargetUrl = req.headers.get('x-target-url') || url.searchParams.get('target_url');
  const isProxyMode = Boolean(customTargetUrl);

  // -------------------------------------------------------------
  // 步骤 2: 模型列表探测接口 (兼容 GET /meoo-ai, /v1/models 或 /models)
  // -------------------------------------------------------------
  if (req.method === 'GET' && (tail === 'meoo-ai' || tail === 'ai/models' || tail.endsWith('models'))) {
    if (isProxyMode) {
      // 代理模式：向自定义目标拉取模型列表
      try {
        const customKey = req.headers.get('x-custom-api-key') || req.headers.get('authorization') || '';
        const targetModelsUrl = upstreamUrl(customTargetUrl!, 'models');
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (customKey) headers['Authorization'] = customKey.startsWith('Bearer ') ? customKey : `Bearer ${customKey}`;
        
        const upstreamRes = await fetch(targetModelsUrl, { method: 'GET', headers });
        const data = await upstreamRes.json();
        return json(data, upstreamRes.status);
      } catch (err: any) {
        return json({ error: { message: `代理拉取模型列表失败: ${err?.message || err}` } }, 502);
      }
    }

    // 默认内置模式：返回 Meoo 官方 6 大模型清单
    return json({
      object: 'list',
      data: MEOO_OFFICIAL_MODELS.map(id => ({ id, object: 'model', owned_by: 'meoo' })),
    });
  }

  // 校验请求路径，仅允许 chat/completions 入口
  if (req.method !== 'POST' || !tail.endsWith('chat/completions')) {
    return json({ error: { message: '接口路径不匹配，仅支持 POST /chat/completions' } }, 404);
  }

  // 解析并校验前端提交的请求体
  let input: Record<string, unknown>;
  try {
    input = await req.json();
  } catch {
    return json({ error: { message: '请求体解析失败：必须为合法的 JSON 格式' } }, 400);
  }

  // -------------------------------------------------------------
  // 步骤 3: 确定请求终点与鉴权密钥 (双轨分流)
  // -------------------------------------------------------------
  let targetBaseUrl = '';
  let finalApiKey = '';

  if (isProxyMode) {
    // 【轨道 B: 通用透明代理模式 (如 OpenCode Zen / 自建网关)】
    targetBaseUrl = customTargetUrl!;
    // 优先使用前端传入的自定义密钥，未传则尝试使用 Meoo 密钥
    finalApiKey = req.headers.get('x-custom-api-key') ||
      (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') ||
      Deno.env.get('MEOO_PROJECT_API_KEY') || '';
  } else {
    // 【轨道 A: Meoo 官方内置免 Key 模式】
    targetBaseUrl = Deno.env.get('MEOO_PROJECT_BASE_URL') || 'https://api.meoo.host/meoo-ai/compatible-mode/v1';
    finalApiKey = Deno.env.get('MEOO_PROJECT_API_KEY') || Deno.env.get('MEOOPROJECTAPI_KEY') || '';

    if (!finalApiKey) {
      return json({ error: { message: 'Meoo AI 服务尚未绑定 MEOO_PROJECT_API_KEY，请在 Meoo 控制台开启 AI 服务' } }, 503);
    }

    const model = String(input.model || '');
    if (!MEOO_OFFICIAL_MODELS.includes(model)) {
      return json({
        error: {
          message: `不支持的 Meoo 内置模型 [${model}]，当前支持: ${MEOO_OFFICIAL_MODELS.join(', ')}。如需使用第三方模型，请指定自定义接口地址。`,
        },
      }, 400);
    }
  }

  // -------------------------------------------------------------
  // 步骤 4: 规范化请求体并转发至上游目标
  // -------------------------------------------------------------
  const body: Record<string, unknown> = {
    model: input.model,
    messages: input.messages,
    stream: input.stream !== false,
  };
  if (typeof input.temperature === 'number') body.temperature = input.temperature;
  if (typeof input.max_tokens === 'number') body.max_tokens = input.max_tokens;
  if (typeof input.max_completion_tokens === 'number') body.max_completion_tokens = input.max_completion_tokens;
  if (typeof input.reasoning_effort === 'string') body.reasoning_effort = input.reasoning_effort;
  if (input.response_format) body.response_format = input.response_format;

  try {
    const upstreamHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (finalApiKey) {
      upstreamHeaders['Authorization'] = `Bearer ${finalApiKey}`;
    }

    const upstreamRes = await fetch(upstreamUrl(targetBaseUrl, 'chat/completions'), {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(body),
    });

    // -------------------------------------------------------------
    // 步骤 5: 响应直通透传 (ReadableStream)
    // -------------------------------------------------------------
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: {
        ...corsHeaders,
        'Content-Type': upstreamRes.headers.get('content-type') || (body.stream ? 'text/event-stream' : 'application/json; charset=utf-8'),
      },
    });
  } catch (error: any) {
    return json({ error: { message: `上游服务调用异常: ${error?.message || error}` } }, 502);
  }
});
