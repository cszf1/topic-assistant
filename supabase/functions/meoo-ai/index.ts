// Meoo 内置 AI 的 OpenAI-compatibility proxy。
// 部署前设置：MEOOPROJECTAPI_KEY、MEOOPROJECT_BASE_URL（例如供应商的 /v1 根地址）。
// 密钥只存在于 Edge Function 环境中，绝不下发至浏览器。

const MODELS = ['deepseek-v3.2', 'glm-5', 'kimi-k2.5', 'qwen3.6-plus', 'MiniMax-M2.5'];
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
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  const path = new URL(req.url).pathname.replace(/\/+$/, '');
  const tail = path.split('/').slice(-2).join('/');

  // 为前端既有的“拉取模型”和“完整检查”提供固定的可选模型清单。
  if (req.method === 'GET' && (tail === 'meoo-ai' || tail === 'ai/models')) {
    return json({ object: 'list', data: MODELS.map(id => ({ id, object: 'model', owned_by: 'meoo' })) });
  }
  if (req.method !== 'POST' || tail !== 'chat/completions') {
    return json({ error: { message: 'Not found' } }, 404);
  }

  const apiKey = Deno.env.get('MEOOPROJECTAPI_KEY');
  const baseUrl = Deno.env.get('MEOOPROJECT_BASE_URL');
  if (!apiKey || !baseUrl) {
    return json({ error: { message: 'Meoo 服务尚未完成服务器配置' } }, 503);
  }

  let input: Record<string, unknown>;
  try { input = await req.json(); } catch { return json({ error: { message: '请求体必须为 JSON' } }, 400); }
  const model = String(input.model || '');
  if (!MODELS.includes(model)) {
    return json({ error: { message: '不支持的 Meoo 内置模型：' + model } }, 400);
  }

  // 只代理 Chat Completions 所需字段，避免把客户端任意请求变成开放代理。
  const body: Record<string, unknown> = {
    model,
    messages: input.messages,
    stream: false,
  };
  if (typeof input.temperature === 'number') body.temperature = input.temperature;
  if (input.response_format) body.response_format = input.response_format;

  try {
    const response = await fetch(upstreamUrl(baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: { ...corsHeaders, 'Content-Type': response.headers.get('content-type') || 'application/json; charset=utf-8' },
    });
  } catch (error) {
    return json({ error: { message: 'Meoo 上游服务暂不可用' } }, 502);
  }
});
