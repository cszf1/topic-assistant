/**
 * Meoo 官方 AI 服务与受控代理 Edge Function (双轨智能路由)
 *
 * 【设计定位】
 * 科研选题工具对接 Meoo 平台的云端网关，双轨分流：
 *
 *   轨道 A —— Meoo 官方内置免 Key 模式（默认）
 *     前端不带 x-target-url 时，用平台注入的 MEOO_PROJECT_API_KEY 调官方模型池，
 *     终端用户无需自备任何密钥。
 *
 *   轨道 B —— 受控代理模式（突破浏览器 CORS）
 *     前端带 x-target-url 时，函数在云端代发请求并补 CORS 头，
 *     让 OpenCode Zen 这类不给跨域头的服务也能在纯静态页面里用。
 *
 * 【安全边界 —— 以下三条是硬约束，改动前务必理解为什么】
 *
 *   1. 代理模式绝不回退平台密钥。
 *      曾经的写法是 customKey || env(MEOO_PROJECT_API_KEY)，
 *      于是任何人发一个指向自己服务器的 x-target-url 且不带 key，
 *      就能让本函数把平台密钥当 Authorization 送到他手里。已实测复现，现已禁止。
 *
 *   2. 目标地址必须过 SSRF 校验。
 *      x-target-url 不做限制时可指向 169.254.169.254（云元数据）、127.0.0.1、
 *      10./172.16./192.168. 内网段乃至 file://，把边缘函数变成内网跳板。
 *      实测 127.0.0.1 曾成功返回 200。现只放行 https 且拒绝私有/保留地址。
 *
 *   3. 目标主机必须在白名单内。
 *      否则这就是一个公开的匿名开放代理，会被刷爆云函数额度。
 *      白名单可用环境变量 PROXY_ALLOWED_HOSTS 覆盖（逗号分隔，支持 .example.com 后缀匹配）。
 *
 * 【文档】https://docs.meoo.com/ai ｜ https://docs.meoo.com/file-6
 */

// Meoo 官方内置模型（轨道 A 白名单）
const MEOO_OFFICIAL_MODELS = [
  'deepseek-v3.2', // 深度求索：代码与推理能力突出
  'glm-5',         // 智谱 AI：中文理解能力优秀
  'kimi-k2.5',     // 月之暗面：长文本上下文理解
  'qwen3.6-plus',  // 通义千问旗舰版：综合能力强
  'qwen3-max',     // 通义千问增强版：适合复杂推理
  'MiniMax-M2.5',  // MiniMax：多模态综合能力强
];

// 轨道 B 默认放行的上游主机（后缀匹配，含子域）
const DEFAULT_ALLOWED_HOSTS = [
  'opencode.ai',
  'api.deepseek.com',
  'api.siliconflow.cn',
  'openrouter.ai',
  'api.openai.com',
  'open.bigmodel.cn',
  'api.moonshot.cn',
  'api.minimax.chat',
  'dashscope.aliyuncs.com',
  'api.meoo.host',
];

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-target-url, x-custom-api-key',
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

function allowedHosts(): string[] {
  const raw = Deno.env.get('PROXY_ALLOWED_HOSTS');
  if (!raw) return DEFAULT_ALLOWED_HOSTS;
  const list = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return list.length ? list : DEFAULT_ALLOWED_HOSTS;
}

/** 私有/保留地址判定：挡住内网跳板与云元数据端点 */
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;

  // IPv6 回环与唯一本地地址
  const v6 = h.replace(/^\[|\]$/g, '');
  if (v6 === '::1' || v6 === '::' || /^f[cd][0-9a-f]{2}:/i.test(v6) || /^fe80:/i.test(v6)) return true;

  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some(n => n > 255)) return true;
  if (a === 127 || a === 0 || a === 10) return true;                 // 回环 / 本网 / 私有 A
  if (a === 169 && b === 254) return true;                           // 链路本地（云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true;                  // 私有 B
  if (a === 192 && b === 168) return true;                           // 私有 C
  if (a === 100 && b >= 64 && b <= 127) return true;                 // 运营商级 NAT
  if (a >= 224) return true;                                         // 组播 / 保留
  return false;
}

/**
 * 校验代理目标。返回 { ok:true, url } 或 { ok:false, status, message }。
 * 允许通过 PROXY_ALLOW_INSECURE=true 放开 http 与私网限制，仅供本地联调，生产不要开。
 */
function validateTarget(raw: string):
  { ok: true; url: URL } | { ok: false; status: number; message: string } {
  let u: URL;
  try { u = new URL(raw); }
  catch { return { ok: false, status: 400, message: '自定义接口地址不是合法 URL：' + raw }; }

  const relaxed = Deno.env.get('PROXY_ALLOW_INSECURE') === 'true';

  if (u.protocol !== 'https:' && !(relaxed && u.protocol === 'http:')) {
    return { ok: false, status: 400,
      message: '自定义接口只允许 https 协议（当前为 ' + u.protocol + '），以防凭据明文外发或被用作内网跳板' };
  }
  if (!relaxed && isBlockedHost(u.hostname)) {
    return { ok: false, status: 403,
      message: '目标地址指向内网或保留网段，已拒绝：' + u.hostname };
  }
  if (!relaxed) {
    const host = u.hostname.toLowerCase();
    const ok = allowedHosts().some(a => host === a || host.endsWith('.' + a));
    if (!ok) {
      return { ok: false, status: 403,
        message: '目标主机不在放行名单内：' + host +
          '。如确需使用，请在云服务环境变量 PROXY_ALLOWED_HOSTS 中追加该域名。' };
    }
  }
  return { ok: true, url: u };
}

Deno.serve(async (req) => {
  // ---------- 1. CORS 预检 ----------
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  const tail = path.split('/').slice(-2).join('/');
  const lastSeg = path.split('/').pop() || '';

  // ---------- 2. 路由模式识别 ----------
  const customTargetUrl = req.headers.get('x-target-url') || url.searchParams.get('target_url');
  const isProxyMode = Boolean(customTargetUrl);
  // 代理模式下只认显式传入的密钥；绝不回退平台密钥（见文件头安全约束 1）
  const clientKey = (req.headers.get('x-custom-api-key') ||
    (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')).trim();

  // ---------- 3. 模型列表 ----------
  // 覆盖 GET /meoo-ai、/meoo-ai/models、/v1/models 等形态
  const isModelsReq = req.method === 'GET' &&
    (lastSeg === 'models' || lastSeg === 'meoo-ai' || tail.endsWith('models'));

  if (isModelsReq) {
    if (isProxyMode) {
      const v = validateTarget(customTargetUrl!);
      if (!v.ok) return json({ error: { message: v.message } }, v.status);
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (clientKey) headers['Authorization'] = 'Bearer ' + clientKey;
        const upstreamRes = await fetch(upstreamUrl(v.url.href, 'models'), { method: 'GET', headers });
        const text = await upstreamRes.text();
        return new Response(text, {
          status: upstreamRes.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
        });
      } catch (err) {
        return json({ error: { message: '代理拉取模型列表失败：' + ((err as Error)?.message || err) } }, 502);
      }
    }
    return json({
      object: 'list',
      data: MEOO_OFFICIAL_MODELS.map(id => ({ id, object: 'model', owned_by: 'meoo' })),
    });
  }

  if (req.method !== 'POST' || !tail.endsWith('chat/completions')) {
    return json({ error: { message: '接口路径不匹配，仅支持 GET /models 与 POST /chat/completions' } }, 404);
  }

  let input: Record<string, unknown>;
  try { input = await req.json(); }
  catch { return json({ error: { message: '请求体解析失败：必须为合法的 JSON 格式' } }, 400); }

  // ---------- 4. 双轨分流：确定上游与凭据 ----------
  let targetBaseUrl = '';
  let finalApiKey = '';

  if (isProxyMode) {
    const v = validateTarget(customTargetUrl!);
    if (!v.ok) return json({ error: { message: v.message } }, v.status);
    if (!clientKey) {
      // 宁可明确报错，也不能悄悄拿平台密钥去请求外部地址
      return json({ error: {
        message: '使用自定义接口时必须提供该接口自己的 API Key（请求头 x-custom-api-key）；' +
          '本网关不会将平台内置密钥发送至第三方地址。' } }, 401);
    }
    targetBaseUrl = v.url.href;
    finalApiKey = clientKey;
  } else {
    targetBaseUrl = Deno.env.get('MEOO_PROJECT_BASE_URL') ||
      'https://api.meoo.host/meoo-ai/compatible-mode/v1';
    finalApiKey = Deno.env.get('MEOO_PROJECT_API_KEY') ||
      Deno.env.get('MEOOPROJECTAPI_KEY') || '';
    if (!finalApiKey) {
      return json({ error: {
        message: 'Meoo AI 服务尚未绑定 MEOO_PROJECT_API_KEY，请在 Meoo 控制台开启 AI 服务' } }, 503);
    }
    const model = String(input.model || '');
    if (!MEOO_OFFICIAL_MODELS.includes(model)) {
      return json({ error: {
        message: '不支持的 Meoo 内置模型 [' + model + ']，当前支持：' +
          MEOO_OFFICIAL_MODELS.join('、') + '。如需第三方模型，请通过 x-target-url 指定自定义接口。' } }, 400);
    }
  }

  // ---------- 5. 规范化请求体 ----------
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

  // ---------- 6. 转发并流式直通 ----------
  try {
    const upstreamRes = await fetch(upstreamUrl(targetBaseUrl, 'chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + finalApiKey },
      body: JSON.stringify(body),
    });
    // 直接透传 ReadableStream，保住前端的思维链打字机实时效果
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: {
        ...corsHeaders,
        'Content-Type': upstreamRes.headers.get('content-type') ||
          (body.stream ? 'text/event-stream' : 'application/json; charset=utf-8'),
        'Cache-Control': 'no-cache',
      },
    });
  } catch (error) {
    // 不回显上游原始错误细节，避免把内部地址结构暴露给前端
    return json({ error: { message: '上游服务调用异常：' + ((error as Error)?.message || error) } }, 502);
  }
});
