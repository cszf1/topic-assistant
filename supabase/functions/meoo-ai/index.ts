// Meoo 官方 AI 服务 Edge Function
// 文档参考: https://docs.meoo.com/ai 与 https://docs.meoo.com/file-6
//
// 密钥由 Meoo 平台在开启云服务时自动注入为环境变量 MEOO_PROJECT_API_KEY，
// 绝不下发至前端浏览器，避免 API Key 泄露。

const MODELS = [
  'deepseek-v3.2',
  'glm-5',
  'kimi-k2.5',
  'qwen3.6-plus',
  'qwen3-max',
  'MiniMax-M2.5',
];

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function upstreamUrl(baseUrl: string, path: string) {
  return baseUrl.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}

Deno.serve(async (req) => {
  // 1. 处理 OPTIONS 预检请求，彻底解除浏览器同源限制
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  const tail = path.split('/').slice(-2).join('/');

  // 2. 模型列表接口 (兼容 GET /meoo-ai, /v1/models 或 /models)
  if (req.method === 'GET' && (tail === 'meoo-ai' || tail === 'ai/models' || tail.endsWith('models'))) {
    return json({
      object: 'list',
      data: MODELS.map(id => ({ id, object: 'model', owned_by: 'meoo' })),
    });
  }

  if (req.method !== 'POST' || !tail.endsWith('chat/completions')) {
    return json({ error: { message: 'Not found' } }, 404);
  }

  // 3. 读取 Meoo 平台注入的环境变量（兼容官方标准命名与备选命名）
  const apiKey = Deno.env.get('MEOO_PROJECT_API_KEY') || Deno.env.get('MEOOPROJECTAPI_KEY');
  const baseUrl = Deno.env.get('MEOO_PROJECT_BASE_URL') || Deno.env.get('MEOOPROJECT_BASE_URL') || 'https://api.meoo.host/meoo-ai/compatible-mode/v1';

  if (!apiKey) {
    return json({ error: { message: 'Meoo AI 服务尚未绑定 MEOO_PROJECT_API_KEY，请在 Meoo 控制台开启 AI 服务' } }, 503);
  }

  let input: Record<string, unknown>;
  try {
    input = await req.json();
  } catch {
    return json({ error: { message: '请求体必须为合法 JSON' } }, 400);
  }

  const model = String(input.model || '');
  if (!MODELS.includes(model)) {
    return json({ error: { message: `不支持的 Meoo 内置模型: ${model}，当前支持: ${MODELS.join(', ')}` } }, 400);
  }

  // 4. 组装请求体并透传流式配置
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

    // 5. 原样流式（ReadableStream）响应，保证打字机效果
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: {
        ...corsHeaders,
        'Content-Type': upstreamRes.headers.get('content-type') || (body.stream ? 'text/event-stream' : 'application/json; charset=utf-8'),
      },
    });
  } catch (error: any) {
    return json({ error: { message: `Meoo 上游服务调用异常: ${error?.message || error}` } }, 502);
  }
});
