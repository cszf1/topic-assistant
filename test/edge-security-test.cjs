/* 深入攻击 Edge Function：重定向绕过、白名单绕过变体、头注入。 */
const http = require('http');
const path = require('path');

const hits = [];
// 8821: 冒充白名单域名，返回 302 指向内网（模拟开放重定向 / 攻击者控制的子域）
const redirector = http.createServer((req, rp) => {
  hits.push({ who: 'redirector', url: req.url, auth: req.headers.authorization });
  rp.writeHead(302, { Location: 'http://127.0.0.1:8822/internal-secret' });
  rp.end();
});
// 8822: 扮演内网敏感服务
const internal = http.createServer((req, rp) => {
  let b = ''; req.on('data', c => b += c);
  req.on('end', () => {
    hits.push({ who: 'INTERNAL', url: req.url, auth: req.headers.authorization, body: b });
    rp.writeHead(200, { 'Content-Type': 'application/json' });
    rp.end(JSON.stringify({ secret: 'INTERNAL-DATA-LEAKED' }));
  });
});
// 8823: 白名单内的正常上游（不重定向），用于验证轨道 B 的请求体
const goodUpstream = http.createServer((req, rp) => {
  let b = ''; req.on('data', c => b += c);
  req.on('end', () => {
    hits.push({ who: 'GOOD', url: req.url, auth: req.headers.authorization, body: b });
    rp.writeHead(200, { 'Content-Type': 'text/event-stream' });
    rp.end('data: [DONE]\n\n');
  });
});

let bad = 0, total = 0;
const ck = (n, ok, i) => { total++; console.log((ok ? '  PASS ' : '  FAIL ') + n + (i ? '  -> ' + i : '')); if (!ok) bad++; };
const hr = t => console.log('\n' + '='.repeat(68) + '\n' + t + '\n' + '='.repeat(68));

(async () => {
  await new Promise(r => redirector.listen(8821, '127.0.0.1', r));
  await new Promise(r => internal.listen(8822, '127.0.0.1', r));
  await new Promise(r => goodUpstream.listen(8823, '127.0.0.1', r));

  let handler = null;
  global.Deno = {
    serve: h => { handler = h; },
    env: { get: k => ({
      MEOO_PROJECT_API_KEY: 'MEOO-SECRET',
      MEOO_PROJECT_BASE_URL: 'http://127.0.0.1:8822/v1',
      // 把 redirector 加入放行名单，模拟「白名单域名存在开放重定向」
      PROXY_ALLOWED_HOSTS: 'opencode.ai,api.deepseek.com',
    })[k] },
  };
  await import('../supabase/functions/meoo-ai/index.ts');

  const BASE = 'https://p.supabase.co/functions/v1/meoo-ai';
  const post = (headers, body) => handler(new Request(BASE + '/chat/completions',
    { method: 'POST', headers, body: JSON.stringify(body || { model: 'm', messages: [] }) }));

  // 把白名单域名的请求导到本地 redirector，模拟真实 DNS
  const realFetch = global.fetch;
  global.fetch = (u, o) => {
    const s = String(u);
    if (s.startsWith('https://opencode.ai')) {
      return realFetch(s.replace(/^https:\/\/opencode\.ai/, 'http://127.0.0.1:8821'), o);
    }
    if (s.startsWith('https://api.deepseek.com')) {
      return realFetch(s.replace(/^https:\/\/api\.deepseek\.com/, 'http://127.0.0.1:8823'), o);
    }
    return realFetch(u, o);
  };

  hr('A. 重定向绕过（白名单域名 302 到内网）');
  hits.length = 0;
  const rRedir = await post({ 'x-target-url': 'https://opencode.ai/zen/go/v1', 'x-custom-api-key': 'USERKEY' });
  const reachedInternal = hits.some(h => h.who === 'INTERNAL');
  const keyToInternal = hits.some(h => h.who === 'INTERNAL' && String(h.auth || '').includes('USERKEY'));
  ck('不跟随重定向进入内网', !reachedInternal,
     reachedInternal ? '*** 已抵达内网服务 ' + JSON.stringify(hits.filter(h => h.who === 'INTERNAL')[0]) + ' ***' : '未抵达');
  ck('用户密钥未随重定向泄露到内网', !keyToInternal,
     keyToInternal ? '*** 密钥随重定向发往内网 ***' : '未泄露');
  console.log('     (status=' + rRedir.status + ', 命中序列: ' + hits.map(h => h.who).join(' -> ') + ')');

  hr('B. 放行名单绕过变体');
  const variants = [
    ['前缀混淆 evil-opencode.ai', 'https://evil-opencode.ai/v1'],
    ['后缀混淆 opencode.ai.evil.com', 'https://opencode.ai.evil.com/v1'],
    ['@ 符号 user@evil', 'https://opencode.ai@evil.com/v1'],
    ['尾点域名 opencode.ai.', 'https://opencode.ai./v1'],
    ['大写 OPENCODE.AI', 'https://OPENCODE.AI/zen/go/v1'],
    ['十进制 IP 2130706433', 'https://2130706433/v1'],
    ['十六进制 IP 0x7f000001', 'https://0x7f000001/v1'],
    ['八进制 IP 0177.0.0.1', 'https://0177.0.0.1/v1'],
    ['IPv4 映射 IPv6 ::ffff:127.0.0.1', 'https://[::ffff:127.0.0.1]/v1'],
    ['IPv6 回环 [::1]', 'https://[::1]/v1'],
    ['短 IPv6 [::]', 'https://[::]/v1'],
    ['内网 172.20', 'https://172.20.0.1/v1'],
    ['CGNAT 100.64', 'https://100.64.0.1/v1'],
  ];
  for (const [name, url] of variants) {
    hits.length = 0;
    let st = 0;
    try { st = (await post({ 'x-target-url': url, 'x-custom-api-key': 'k' })).status; } catch (e) { st = -1; }
    const outbound = hits.length > 0;
    const rejected = (st === 400 || st === 403) && !outbound;
    // 大写域名是合法的（DNS 大小写不敏感），应当被放行而不是 403
    if (/大写/.test(name)) {
      ck('[合法变体] ' + name + ' 应被放行', st !== 403,
         'status=' + st + '（非 403 即正确通过白名单）');
    } else {
      ck(name, rejected, 'status=' + st + (outbound ? ' 且已发出请求!' : ''));
    }
  }

  hr('C. 请求头注入');
  const injections = [
    ['CRLF 注入', 'https://opencode.ai/v1\r\nX-Evil: 1'],
    ['换行注入', 'https://opencode.ai/v1\nX-Evil: 1'],
    ['空字节', 'https://opencode.ai/v1\u0000'],
  ];
  for (const [name, url] of injections) {
    let st = 0, threw = false;
    try { st = (await post({ 'x-target-url': url, 'x-custom-api-key': 'k' })).status; }
    catch (e) { threw = true; }
    ck(name + ' 被拒或抛错', threw || st === 400 || st === 403, threw ? 'throw' : 'status=' + st);
  }

  hr('D. builtin 轨道不受 x-target-url 干扰');
  hits.length = 0;
  const rB = await post({}, { model: 'glm-5', messages: [{ role: 'user', content: 'hi' }] });
  ck('builtin 打到 MEOO_PROJECT_BASE_URL', hits.some(h => h.who === 'INTERNAL'),
     hits.map(h => h.who).join(','));
  ck('builtin 用平台密钥', hits.some(h => String(h.auth || '').includes('MEOO-SECRET')));
  console.log('     (注：此处 BASE_URL 被测试设为本地地址，生产由平台注入，属预期)');

  hr('E. 轨道 A 限额（网关 URL 公开，平台密钥不能被随意消费）');
  hits.length = 0;
  const huge = await post({}, { model: 'glm-5', max_tokens: 1000000,
    messages: [{ role: 'user', content: 'x' }] });
  const sentBody = hits.length ? JSON.parse(hits[hits.length-1].body || '{}') : {};
  ck('max_tokens 被夹取到上限', sentBody.max_tokens === 16384,
     'max_tokens=' + sentBody.max_tokens);
  const manyMsgs = await post({}, { model: 'glm-5',
    messages: Array.from({length: 50}, () => ({ role: 'user', content: 'x' })) });
  ck('消息条数超限被拒 413', manyMsgs.status === 413, 'status=' + manyMsgs.status);
  const bigChars = await post({}, { model: 'glm-5',
    messages: [{ role: 'user', content: 'x'.repeat(70000) }] });
  ck('输入字符超限被拒 413', bigChars.status === 413, 'status=' + bigChars.status);
  const emptyMsgs = await post({}, { model: 'glm-5', messages: [] });
  ck('空 messages 被拒', emptyMsgs.status === 413 || emptyMsgs.status === 400,
     'status=' + emptyMsgs.status);
  // 轨道 B 用户自付费，不该被夹取
  hits.length = 0;
  await post({ 'x-target-url': 'https://api.deepseek.com/v1', 'x-custom-api-key': 'k' },
    { model: 'm', max_tokens: 1000000, messages: [{ role: 'user', content: 'x' }] });
  const proxyHit = hits.find(h => h.who === 'GOOD');
  const proxyBody = proxyHit ? JSON.parse(proxyHit.body || '{}') : {};
  ck('轨道 B 不夹取 max_tokens（用户自付费）', proxyBody.max_tokens === 1000000,
     'max_tokens=' + proxyBody.max_tokens);

  hr('F. Authorization 不再被当作上游凭据');
  hits.length = 0;
  const authFallback = await post(
    { 'x-target-url': 'https://opencode.ai/zen/go/v1',
      'authorization': 'Bearer SUPABASE-ANON-KEY-SHOULD-NOT-LEAK' },
    { model: 'm', messages: [{ role: 'user', content: 'x' }] });
  ck('缺 x-custom-api-key 时拒绝(401)，不拿 Authorization 顶替',
     authFallback.status === 401, 'status=' + authFallback.status);
  ck('Supabase 平台凭据未外发',
     !hits.some(h => String(h.auth || '').includes('SUPABASE-ANON-KEY')),
     hits.length ? String(hits[0].auth) : '无出网请求');

  hr('G. query 形式的 target_url 入口已关闭');
  hits.length = 0;
  const viaQuery = await handler(new Request(
    BASE + '/chat/completions?target_url=' + encodeURIComponent('http://127.0.0.1:8822/v1'),
    { method: 'POST', headers: { 'x-custom-api-key': 'k' },
      body: JSON.stringify({ model: 'glm-5', messages: [{ role: 'user', content: 'x' }] }) }));
  const usedUserKey = hits.some(h => String(h.auth || '') === 'Bearer k');
  const usedPlatformKey = hits.some(h => String(h.auth || '').includes('MEOO-SECRET'));
  ck('?target_url= 未被采纳为代理目标（仍走轨道 A）',
     !usedUserKey && usedPlatformKey,
     'status=' + viaQuery.status + ' 用户key=' + usedUserKey + ' 平台key=' + usedPlatformKey);

  hr('H. 安全响应头');
  const hdrs = (await post({}, { model: 'glm-5', messages: [{ role: 'user', content: 'x' }] })).headers;
  ck('带 X-Content-Type-Options: nosniff',
     hdrs.get('x-content-type-options') === 'nosniff', String(hdrs.get('x-content-type-options')));
  ck('带 CSP 限制脚本执行',
     /default-src 'none'/.test(hdrs.get('content-security-policy') || ''),
     String(hdrs.get('content-security-policy')));

  hr('结果: ' + (total - bad) + '/' + total + ' 通过, ' + bad + ' 失败');
  redirector.close(); internal.close(); goodUpstream.close();
  process.exit(bad ? 1 : 0);
})().catch(e => { console.log('ERROR', e.message); process.exit(1); });
