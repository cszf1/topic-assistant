/* 双轨 Edge Function 真实检验：Node 模拟 Deno 运行时，加载真实 index.ts。
 * 覆盖：功能正确性 + 安全性（重点查 SSRF 与密钥外泄）。 */
const http = require('http');
const path = require('path');

// ---------- 假上游：分别扮演 Meoo 官方 与 第三方(攻击者) ----------
const hits = { meoo: [], third: [] };
const mkUpstream = (name, port) => new Promise(res => {
  const s = http.createServer((req, rp) => {
    let b = ''; req.on('data', c => b += c);
    req.on('end', () => {
      hits[name].push({ url: req.url, auth: req.headers.authorization || null, body: b });
      if (req.url.endsWith('/models')) {
        rp.writeHead(200, { 'Content-Type': 'application/json' });
        return rp.end(JSON.stringify({ data: [{ id: name + '-model-1' }, { id: name + '-model-2' }] }));
      }
      // SSE 流式
      rp.writeHead(200, { 'Content-Type': 'text/event-stream' });
      rp.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi-from-' + name } }] }) + '\n\n');
      rp.write('data: [DONE]\n\n');
      rp.end();
    });
  });
  s.listen(port, '127.0.0.1', () => res(s));
});

let bad = 0, total = 0;
const ck = (n, ok, info) => { total++; console.log((ok ? '  PASS ' : '  FAIL ') + n + (info ? '  -> ' + info : '')); if (!ok) bad++; };
const hr = t => console.log('\n' + '='.repeat(70) + '\n' + t + '\n' + '='.repeat(70));

(async () => {
  const up1 = await mkUpstream('meoo', 8811);
  const up2 = await mkUpstream('third', 8812);

  // ---------- 模拟 Deno 运行时 ----------
  let handler = null;
  const envStore = {
    MEOO_PROJECT_API_KEY: 'MEOO-SECRET-KEY-DO-NOT-LEAK',
    MEOO_PROJECT_BASE_URL: 'http://127.0.0.1:8811/v1',
  };
  global.Deno = {
    serve: h => { handler = h; },
    env: { get: k => envStore[k] },
  };

  // 让 opencode.ai 的请求实际落到本地假上游（不改函数代码，只拦 fetch）
  const realFetch = global.fetch;
  global.fetch = (u, o) => {
    const s2 = String(u);
    if (s2.startsWith('https://opencode.ai')) {
      return realFetch(s2.replace('https://opencode.ai/zen/go/v1', 'http://127.0.0.1:8812/v1'), o);
    }
    return realFetch(u, o);
  };

  await import('../supabase/functions/meoo-ai/index.ts');
  if (!handler) { console.log('FATAL 未捕获到 Deno.serve handler'); process.exit(1); }

  const BASE = 'https://proj.supabase.co/functions/v1/meoo-ai';
  const call = (opts = {}) => handler(new Request(opts.url || BASE + '/chat/completions', {
    method: opts.method || 'POST',
    headers: opts.headers || {},
    body: opts.body !== undefined ? opts.body : JSON.stringify({ model: 'glm-5', messages: [{ role: 'user', content: 'hi' }] }),
  }));

  // =================== CORS ===================
  hr('1. CORS 与预检');
  const opt = await handler(new Request(BASE + '/chat/completions', { method: 'OPTIONS' }));
  ck('OPTIONS 放行', opt.status >= 200 && opt.status < 300, 'status=' + opt.status);
  ck('返回 Allow-Origin: *', opt.headers.get('access-control-allow-origin') === '*');
  ck('Allow-Headers 含 x-target-url',
     (opt.headers.get('access-control-allow-headers') || '').includes('x-target-url'));

  // =================== 轨道 A ===================
  hr('2. 轨道 A：Meoo 官方内置免 Key 模式');
  const mA = await handler(new Request(BASE, { method: 'GET' }));
  const mAj = await mA.json();
  const mA2 = await handler(new Request(BASE + '/models', { method: 'GET' }));
  const mA2j = await mA2.json();
  ck('GET /models 也返回官方模型', Array.isArray(mA2j.data) && mA2j.data.length === 6,
     'n=' + (mA2j.data || []).length);
  ck('GET 返回官方 6 模型', Array.isArray(mAj.data) && mAj.data.length === 6, 'n=' + (mAj.data || []).length);
  ck('owned_by 标记为 meoo',
     Array.isArray(mAj.data) && mAj.data.length > 0 && mAj.data.every(m => m.owned_by === 'meoo'));

  hits.meoo.length = 0;
  const rA = await call();
  ck('合法模型转发成功', rA.status === 200, 'status=' + rA.status);
  ck('打到 Meoo 官方上游', hits.meoo.length === 1, 'hits=' + hits.meoo.length);
  ck('携带 Meoo 服务端密钥', hits.meoo[0] && hits.meoo[0].auth === 'Bearer ' + envStore.MEOO_PROJECT_API_KEY);
  const bodyA = hits.meoo[0] ? JSON.parse(hits.meoo[0].body) : {};
  ck('默认开启 stream', bodyA.stream === true, 'stream=' + bodyA.stream);
  const txtA = await rA.text();
  ck('SSE 内容透传', txtA.includes('hi-from-meoo'), txtA.slice(0, 40).replace(/\n/g, '\\n'));
  ck('响应带 CORS 头', rA.headers.get('access-control-allow-origin') === '*');

  const rBad = await call({ body: JSON.stringify({ model: 'gpt-5.6-luna', messages: [] }) });
  ck('白名单外模型被拒 400', rBad.status === 400, 'status=' + rBad.status);

  // =================== 轨道 B ===================
  hr('3. 轨道 B：通用代理（OpenCode Zen 场景）');
  hits.third.length = 0;
  const rB = await call({
    headers: { 'x-target-url': 'https://opencode.ai/zen/go/v1', 'x-custom-api-key': 'USER-OWN-ZEN-KEY' },
    body: JSON.stringify({ model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'hi' }] }),
  });
  ck('代理模式转发成功', rB.status === 200, 'status=' + rB.status);
  ck('打到自定义上游', hits.third.length === 1, 'hits=' + hits.third.length);
  ck('用的是用户自己的 Key', hits.third[0] && hits.third[0].auth === 'Bearer USER-OWN-ZEN-KEY',
     hits.third[0] ? hits.third[0].auth : 'n/a');
  ck('代理模式不受白名单限制', hits.third.length === 1 && rB.status === 200);
  ck('代理 SSE 透传', (await rB.text()).includes('hi-from-third'));

  hits.third.length = 0;
  const mB = await handler(new Request(BASE + '/models', { method: 'GET',
    headers: { 'x-target-url': 'https://opencode.ai/zen/go/v1', 'x-custom-api-key': 'K' } }));
  const mBj = await mB.json();
  ck('代理模式拉自定义模型列表',
     Array.isArray(mBj.data) && mBj.data[0] && mBj.data[0].id === 'third-model-1',
     JSON.stringify(mBj.data && mBj.data[0]));

  // =================== 安全审查 ===================
  hr('4. 安全审查（重点）');

  // 4.1 密钥外泄：代理模式不传 key
  hits.third.length = 0;
  await call({
    headers: { 'x-target-url': 'https://opencode.ai/zen/go/v1' },   // 白名单内地址但故意不带 key
    body: JSON.stringify({ model: 'anything', messages: [] }),
  });
  const leaked = hits.third[0] && String(hits.third[0].auth || '').includes(envStore.MEOO_PROJECT_API_KEY);
  ck('不把 Meoo 平台密钥发给第三方地址', !leaked,
     leaked ? '*** 已泄露: ' + hits.third[0].auth + ' ***' : '未携带平台密钥');

  // 4.2 SSRF：云元数据端点
  const ssrfTargets = [
    ['云元数据 169.254.169.254', 'https://169.254.169.254/latest/meta-data'],
    ['内网回环 127.0.0.1', 'https://127.0.0.1:8812/v1'],
    ['内网私有段 10.x', 'https://10.0.0.1/v1'],
    ['私有段 192.168.x', 'https://192.168.1.1/v1'],
    ['localhost 域名', 'https://localhost/v1'],
    ['file 协议', 'file:///etc/passwd'],
    ['明文 http', 'http://opencode.ai/zen/go/v1'],
  ];
  for (const [name, t] of ssrfTargets) {
    let blocked = false, note = '';
    try {
      const r = await call({ headers: { 'x-target-url': t, 'x-custom-api-key': 'k' },
        body: JSON.stringify({ model: 'm', messages: [] }) });
      blocked = r.status === 400 || r.status === 403;
      note = 'status=' + r.status;
    } catch (e) { blocked = true; note = 'throw'; }
    ck('SSRF 拦截 ' + name, blocked, note);
  }

  // 4.3 开放代理：任意外部域名
  let openProxy = false;
  try {
    const r = await call({ headers: { 'x-target-url': 'https://evil-random-domain.example.org/v1', 'x-custom-api-key': 'k' },
      body: JSON.stringify({ model: 'm', messages: [] }) });
    openProxy = r.status === 200;
  } catch (e) {}
  ck('目标地址有白名单限制（防被当免费代理刷）', !openProxy,
     openProxy ? '任意地址均可转发' : '有限制');

  hr('结果: ' + (total - bad) + '/' + total + ' 通过, ' + bad + ' 失败');
  up1.close(); up2.close();
  process.exit(bad ? 1 : 0);
})().catch(e => { console.log('ERROR', e.message, e.stack); process.exit(1); });
