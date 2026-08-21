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
 *   4. 重定向必须逐跳重新校验。
 *      fetch 默认 redirect:'follow'，只校验初始 URL 是不够的：白名单内的域名
 *      （或存在开放重定向的域名）只需返回 Location: http://127.0.0.1/，
 *      就能把本函数当成内网跳板。已实测复现（redirector -> INTERNAL）。
 *      现改为 redirect:'manual'，每一跳的 Location 都重跑 validateTarget()，且限制跳数。
 *
 *   5. 轨道 A 必须限额。
 *      网关 URL 写在纯静态页面里，等于公开；而轨道 A 花的是平台密钥。
 *      若不限制 max_tokens 与请求体积，任何人 POST 一次
 *      {model:'glm-5', max_tokens:1000000} 就能烧掉额度。
 *      现对轨道 A 施加输出上限、消息条数/字符上限，并可用
 *      GATEWAY_ALLOWED_ORIGINS 限定来源（默认放开，便于本地调试）。
 *
 *   8. 上游必须有超时。
 *      Edge Function 按执行时长计费，上游挂住不返回就会一直占着连接烧额度。
 *      流式响应不能用墙钟总超时（推理模型的长流是正常的），
 *      所以只对「连接到首字节」设超时，流一旦开始就交给客户端与平台运行时管。
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
  'api.minimaxi.com',   // 与 PROVIDER_PRESETS 中的 minimax 预设保持一致
  'api.minimax.chat',
  'dashscope.aliyuncs.com',
  'api.meoo.host',
];

/*
 * 轨道 A 限额。轨道 B 花的是用户自己的密钥，不设这些上限。
 * 数值按本工具实际需要留足余量：8 题结构化 JSON 实测约 3000~4500 tokens。
 */
const BUILTIN_MAX_OUTPUT_TOKENS = 16384;
const BUILTIN_MAX_MESSAGES = 32;
const BUILTIN_MAX_CHARS = 60000;

/*
 * 上游连接超时（毫秒）。只覆盖「发出请求到拿到响应头」这一段：
 * 流式正文可能持续几十秒到几分钟（推理模型思维链很长），
 * 用墙钟总超时会把正常的长流硬砍掉。
 */
const UPSTREAM_TIMEOUT_MS = Number(Deno.env.get('UPSTREAM_TIMEOUT_MS') || '120000');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-target-url, x-custom-api-key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  // 上游 content-type 是透传的；若上游返回 text/html，
  // 没有这两个头就等于在本函数所在源上执行了它的脚本。
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
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

/** 允许调用本网关的页面来源；未配置则放开（便于本地调试与自建部署） */
function originAllowed(req: Request): boolean {
  const raw = Deno.env.get('GATEWAY_ALLOWED_ORIGINS');
  if (!raw) return true;
  const list = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return true;
  const origin = (req.headers.get('origin') || '').toLowerCase();
  if (!origin) return false;              // 配了名单就要求带 Origin
  return list.includes(origin);
}

/** 轨道 A 请求规模检查：防止有人拿平台密钥跑超长任务 */
function checkBuiltinQuota(input: Record<string, unknown>):
  { ok: true } | { ok: false; message: string } {
  const msgs = input.messages;
  if (!Array.isArray(msgs) || !msgs.length) {
    return { ok: false, message: 'messages 必须是非空数组' };
  }
  if (msgs.length > BUILTIN_MAX_MESSAGES) {
    return { ok: false, message: '内置模式最多 ' + BUILTIN_MAX_MESSAGES + ' 条消息，当前 ' + msgs.length };
  }
  let chars = 0;
  for (const m of msgs) {
    const cont = m && (m as Record<string, unknown>).content;
    chars += typeof cont === 'string' ? cont.length : JSON.stringify(cont ?? '').length;
  }
  if (chars > BUILTIN_MAX_CHARS) {
    return { ok: false, message: '内置模式单次输入上限 ' + BUILTIN_MAX_CHARS + ' 字符，当前 ' + chars };
  }
  return { ok: true };
}

/** 四段十进制判定，供 isBlockedHost 复用 */
function isBlockedIPv4(a: number, b: number, c: number, d: number): boolean {
  if ([a, b, c, d].some(n => !Number.isFinite(n) || n < 0 || n > 255)) return true;
  if (a === 0 || a === 127 || a === 10) return true;            // 本网 / 回环 / 私有 A
  if (a === 169 && b === 254) return true;                      // 链路本地（云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true;             // 私有 B
  if (a === 192 && b === 168) return true;                      // 私有 C
  if (a === 192 && b === 0 && c === 0) return true;             // IETF 协议分配 192.0.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true;         // 基准测试 198.18.0.0/15
  if (a === 100 && b >= 64 && b <= 127) return true;            // 运营商级 NAT
  if (a >= 224) return true;                                    // 组播 / 保留
  return false;
}

/**
 * 私有/保留地址判定：挡住内网跳板与云元数据端点。
 *
 * 这是文档宣称的最后一道防线，所以不能只认标准点分十进制：
 * 127.1、2130706433、0x7f000001、0177.0.0.1、[::ffff:127.0.0.1]、
 * [0:0:0:0:0:0:0:1] 都能指向回环，必须一并识别。
 */
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');   // 去掉尾点（opencode.ai. 之类）
  if (h === 'localhost' || h.endsWith('.localhost') ||
      h.endsWith('.internal') || h.endsWith('.local') ||
      h.endsWith('.home.arpa') || h === 'metadata' ||
      h.endsWith('.metadata.google.internal')) return true;

  // ---- IPv6 ----
  if (h.includes(':')) {
    const v6 = h.replace(/^\[|\]$/g, '');
    // IPv4 映射 / NAT64：::ffff:127.0.0.1、64:ff9b::7f00:1
    const mapped = v6.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (mapped) {
      return isBlockedIPv4(Number(mapped[1]), Number(mapped[2]), Number(mapped[3]), Number(mapped[4]));
    }
    // 展开后全零段视为回环/未指定
    const groups = v6.split(':').filter(x => x !== '');
    const allZeroOrOne = groups.every(g => /^0+$/.test(g) || g === '1');
    if (allZeroOrOne) return true;                       // ::1 / :: / 0:0:...:1
    if (/^f[cd][0-9a-f]{2}$/.test(groups[0] || '')) return true;   // fc00::/7 唯一本地
    if (/^fe[89ab][0-9a-f]$/.test(groups[0] || '')) return true;   // fe80::/10 链路本地
    if (/^64:ff9b/.test(v6)) return true;                          // NAT64 前缀
    return false;
  }

  // ---- 点分十进制 ----
  const dotted = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    return isBlockedIPv4(Number(dotted[1]), Number(dotted[2]), Number(dotted[3]), Number(dotted[4]));
  }

  // ---- 非标准 IP 写法：纯十进制 / 十六进制 / 八进制 / 短式 ----
  // 只要整个主机名由数字与点（含 0x/0 前缀）组成，就按 IP 解析后判定；
  // 解析不出来则一律拒绝，避免用奇怪写法绕过。
  if (/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+))*$/.test(h)) {
    const parts = h.split('.').map(p =>
      /^0x/.test(p) ? parseInt(p, 16) : (/^0\d+$/.test(p) ? parseInt(p, 8) : parseInt(p, 10)));
    if (parts.some(n => !Number.isFinite(n))) return true;
    let v = 0;
    if (parts.length === 1) v = parts[0];                        // 2130706433 / 0x7f000001
    else if (parts.length === 2) v = parts[0] * 0x1000000 + parts[1];        // 127.1
    else if (parts.length === 3) v = parts[0] * 0x1000000 + parts[1] * 0x10000 + parts[2];
    else if (parts.length === 4) v = parts[0] * 0x1000000 + parts[1] * 0x10000 + parts[2] * 0x100 + parts[3];
    else return true;
    if (v < 0 || v > 0xffffffff) return true;
    return isBlockedIPv4((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  }
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

/**
 * 安全转发：手动处理重定向，每一跳都重新过 validateTarget。
 *
 * 为何不用默认的 redirect:'follow'：白名单只能约束第一跳，
 * 上游一个 302 就能把请求带到 127.0.0.1 / 169.254.169.254。
 * verifyEachHop 为 false 时（轨道 A）只限制跳数、不做白名单校验，
 * 因为轨道 A 的目标是平台自己注入的可信地址。
 */
async function safeFetch(
  targetUrl: string,
  init: RequestInit,
  verifyEachHop: boolean,
  maxHops = 3,
): Promise<Response> {
  let current = targetUrl;
  let nextInit: RequestInit = init;
  for (let hop = 0; hop <= maxHops; hop++) {
    /*
     * 只给「等响应头」这一段设超时，拿到响应头就立刻解除：
     * 若把 signal 留到流读取阶段，AbortSignal.timeout 会在计时到点时
     * 把正在传输的 SSE 流一起掐断，正常的长思维链会被误杀。
     */
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(
      new Error('上游 ' + UPSTREAM_TIMEOUT_MS + 'ms 未响应')), UPSTREAM_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(current, { ...nextInit, redirect: 'manual', signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (res.status < 300 || res.status >= 400) return res;

    const loc = res.headers.get('location');
    if (!loc) return res;                        // 3xx 但无 Location，原样交回
    if (hop === maxHops) {
      throw new Error('上游重定向次数过多（>' + maxHops + '），已中止');
    }

    const next = new URL(loc, current).href;
    if (verifyEachHop) {
      const v = validateTarget(next);
      if (!v.ok) {
        // 这正是白名单绕过的入口，必须在此断开
        throw new Error('上游重定向到不允许的地址，已拦截：' + v.message);
      }
    }
    // 跳转后不再携带请求体与凭据，避免密钥跟着 Location 跑到别处
    nextInit = { method: 'GET', headers: { 'Content-Type': 'application/json' } };
    current = next;
  }
  throw new Error('上游重定向处理异常');
}

Deno.serve(async (req) => {
  // ---------- 1. CORS 预检 ----------
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // 可选的来源白名单：部署到生产后建议配 GATEWAY_ALLOWED_ORIGINS，
  // 否则这个网关对全网开放，轨道 A 的平台额度谁都能花。
  if (!originAllowed(req)) {
    return json({ error: { message: '请求来源不在允许名单内' } }, 403);
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  const tail = path.split('/').slice(-2).join('/');
  const lastSeg = path.split('/').pop() || '';

  // ---------- 2. 路由模式识别 ----------
  // 只从请求头取目标，不接受 ?target_url= query：
  // query 形态可被 <img src> / 顶层导航等无需预检的方式触发。
  const customTargetUrl = req.headers.get('x-target-url');
  const isProxyMode = Boolean(customTargetUrl);
  /*
   * 代理模式只认 x-custom-api-key。
   * 不能回退读 Authorization：Supabase 在 verify_jwt=true 时要求调用方带
   * Authorization: Bearer <anon/service_role>，那是平台凭据，
   * 一旦被当成上游 Bearer 转发出去，等于把平台密钥送给第三方。
   */
  const clientKey = (req.headers.get('x-custom-api-key') || '').trim();

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
        const upstreamRes = await safeFetch(upstreamUrl(v.url.href, 'models'),
          { method: 'GET', headers }, true);
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
    // 轨道 A 花的是平台密钥，必须限规模
    const q = checkBuiltinQuota(input);
    if (!q.ok) return json({ error: { message: q.message } }, 413);
  }

  // ---------- 5. 规范化请求体 ----------
  const body: Record<string, unknown> = {
    model: input.model,
    messages: input.messages,
    stream: input.stream !== false,
  };
  if (typeof input.temperature === 'number') body.temperature = input.temperature;
  // 轨道 A 夹取输出上限；轨道 B 用户自付费，原样尊重
  const capTokens = (n: number) => isProxyMode ? n : Math.min(n, BUILTIN_MAX_OUTPUT_TOKENS);
  if (typeof input.max_tokens === 'number') body.max_tokens = capTokens(input.max_tokens);
  if (typeof input.max_completion_tokens === 'number') {
    body.max_completion_tokens = capTokens(input.max_completion_tokens);
  }
  if (typeof input.reasoning_effort === 'string') body.reasoning_effort = input.reasoning_effort;
  if (input.response_format) body.response_format = input.response_format;

  // ---------- 6. 转发并流式直通 ----------
  try {
    const upstreamRes = await safeFetch(upstreamUrl(targetBaseUrl, 'chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + finalApiKey },
      body: JSON.stringify(body),
    }, isProxyMode);
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
