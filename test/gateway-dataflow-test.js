/* 数据管理专项：验证三种模式下「密钥去向」严格正确。
 * 这是安全断言，不是功能断言——发错一次就是泄露。 */
const { createIdeator } = require(require('path').join(__dirname, '..', 'web', 'ideate.js'));

const KEY = 'sk-USER-PRIVATE-KEY-9527';
const GW = 'https://proj.supabase.co/functions/v1/meoo-ai';
const UP = 'https://opencode.ai/zen/go/v1';
const okJson = JSON.stringify({ ideas: [{ zh: 'T', objectEn: 'x' }] });

function sse(cap) {
  let sent = false;
  return { ok: true, status: 200,
    headers: { get: k => String(k).toLowerCase() === 'content-type' ? 'text/event-stream' : null },
    body: { getReader: () => ({
      async read() { if (sent) return { done: true }; sent = true;
        return { done: false, value: new TextEncoder().encode(
          'data: ' + JSON.stringify({ choices: [{ delta: { content: okJson } }] }) + '\n\ndata: [DONE]\n\n') }; },
      releaseLock() {}, cancel() {} }) } };
}
const jsonRes = d => ({ ok: true, status: 200,
  headers: { get: () => 'application/json' }, text: async () => JSON.stringify(d) });

let bad = 0, total = 0;
const ck = (n, ok, info) => { total++; console.log((ok ? '  PASS ' : '  FAIL ') + n + (info ? '  -> ' + info : '')); if (!ok) bad++; };
const hr = t => console.log('\n' + '='.repeat(70) + '\n' + t + '\n' + '='.repeat(70));
const P = { major: '电子信息', interest: 'PCB', gpu: 'single', dataset: 'public',
  codingLevel: 'mid', weeks: 16, count: 1 };

// 收集所有出网请求，用于审计
function spy() {
  const log = [];
  const impl = async (url, init) => {
    log.push({ url: String(url), headers: Object.assign({}, (init && init.headers) || {}) });
    if (String(url).endsWith('/models')) return jsonRes({ data: [{ id: 'm1' }, { id: 'm2' }] });
    return sse();
  };
  return { log, impl };
}
const hasKeyAnywhere = e =>
  JSON.stringify(e).includes(KEY);
const credHeaders = h => Object.keys(h).filter(k =>
  /^(authorization|x-api-key|x-goog-api-key|x-custom-api-key)$/i.test(k));

(async () => {
  // ===================== 模式 off =====================
  hr('1. 模式 off（浏览器直连，历史行为必须不变）');
  {
    const s = spy();
    const ide = createIdeator({ baseUrl: 'https://api.deepseek.com/v1', apiKey: KEY,
      model: 'deepseek-chat', maxRetries: 0, fetchImpl: s.impl });
    ck('configured 为真', ide.configured() === true);
    await ide.generate(P);
    await ide.fetchModels();
    ck('全部请求直连供应商域名',
       s.log.every(r => r.url.includes('api.deepseek.com')),
       s.log.map(r => new URL(r.url).host).join(','));
    ck('携带 Authorization',
       s.log.every(r => r.headers.Authorization === 'Bearer ' + KEY));
    ck('不出现网关专用头',
       s.log.every(r => !('x-target-url' in r.headers) && !('x-custom-api-key' in r.headers)));
    const f = ide.describeDataFlow();
    ck('自检报告 mode=off', f.mode === 'off' && f.requestHost === 'api.deepseek.com',
       JSON.stringify(f));
  }

  // ===================== 模式 builtin =====================
  hr('2. 模式 builtin（平台内置 AI，本地一个凭据都不该发）');
  {
    const s = spy();
    // 故意残留 baseUrl 与 apiKey，检验它们会不会被误发
    const ide = createIdeator({ gatewayMode: 'builtin', gatewayUrl: GW,
      baseUrl: 'https://api.deepseek.com/v1', apiKey: KEY,
      model: 'glm-5', maxRetries: 0, fetchImpl: s.impl });
    ck('configured 只要网关+模型即可为真', ide.configured() === true);
    await ide.generate(P);
    await ide.fetchModels();
    ck('所有请求只发往网关域名',
       s.log.length > 0 && s.log.every(r => r.url.startsWith(GW)),
       s.log.map(r => r.url.replace(GW, '<GW>')).join(' | '));
    const leaked = s.log.filter(hasKeyAnywhere);
    ck('★ 本地 apiKey 一次都没外发', leaked.length === 0,
       leaked.length ? '*** 泄露于 ' + leaked.length + ' 个请求 ***' : '零泄露');
    ck('★ 完全不带任何凭据头',
       s.log.every(r => credHeaders(r.headers).length === 0),
       s.log.map(r => credHeaders(r.headers).join('/') || '-').join(','));
    ck('不声明 x-target-url（内置模式无需上游）',
       s.log.every(r => !('x-target-url' in r.headers)));
    ck('模型列表不做 /v1 探测（网关地址是确定的）',
       s.log.filter(r => r.url.endsWith('/models')).length === 1,
       'models 请求数=' + s.log.filter(r => r.url.endsWith('/models')).length);
    const f = ide.describeDataFlow();
    ck('自检报告 sendsCredential=false',
       f.mode === 'builtin' && f.sendsCredential === false, JSON.stringify(f));
  }

  // ===================== 模式 proxy =====================
  hr('3. 模式 proxy（受控代理，key 只交给自己的网关）');
  {
    const s = spy();
    const ide = createIdeator({ gatewayMode: 'proxy', gatewayUrl: GW,
      baseUrl: UP, apiKey: KEY, model: 'gpt-5.6-luna', maxRetries: 0, fetchImpl: s.impl });
    ck('configured 需要网关+上游+密钥', ide.configured() === true);
    await ide.generate(P);
    await ide.fetchModels();
    ck('所有请求只发往网关域名',
       s.log.every(r => r.url.startsWith(GW)),
       s.log.map(r => new URL(r.url).host).join(','));
    ck('★ 浏览器从未直连第三方上游',
       s.log.every(r => !r.url.includes('opencode.ai')));
    ck('key 放在 x-custom-api-key',
       s.log.every(r => r.headers['x-custom-api-key'] === KEY));
    ck('★ key 不出现在 URL 里（URL 会进访问日志）',
       s.log.every(r => !r.url.includes(KEY)),
       s.log.every(r => !r.url.includes(KEY)) ? 'URL 干净' : '*** key 进了 URL ***');
    ck('★ 不向网关发裸 Authorization（语义唯一，避免被当成上游凭据误用）',
       s.log.every(r => !('Authorization' in r.headers)),
       s.log.map(r => credHeaders(r.headers).join('/')).join(','));
    ck('声明了上游地址 x-target-url',
       s.log.every(r => r.headers['x-target-url'] === 'https://opencode.ai/zen/go/v1'),
       s.log[0] && s.log[0].headers['x-target-url']);
    const f = ide.describeDataFlow();
    ck('自检报告标出上游与凭据字段',
       f.mode === 'proxy' && f.credentialHeaders.includes('x-custom-api-key') &&
       f.upstreamDeclaredTo.includes('opencode.ai'), JSON.stringify(f));
  }

  // ===================== 降级与边界 =====================
  hr('4. 降级与边界');
  {
    // 声明了模式但没填网关地址 -> 必须退回直连，不能把请求发到空地址
    const s = spy();
    const ide = createIdeator({ gatewayMode: 'proxy', gatewayUrl: '',
      baseUrl: 'https://api.deepseek.com/v1', apiKey: KEY, model: 'm',
      maxRetries: 0, fetchImpl: s.impl });
    ck('网关地址为空时安全退回 off', ide.gatewayMode === 'off', ide.gatewayMode);
    await ide.generate(P);
    ck('退回后正常直连供应商', s.log.every(r => r.url.includes('api.deepseek.com')));
  }
  {
    const ide = createIdeator({ gatewayMode: 'proxy', gatewayUrl: GW,
      baseUrl: UP, apiKey: '', model: 'm', fetchImpl: async () => sse() });
    ck('proxy 模式缺上游密钥时 configured 为假（网关会拒 401）',
       ide.configured() === false);
  }
  {
    const ide = createIdeator({ gatewayMode: 'nonsense', gatewayUrl: GW,
      baseUrl: UP, apiKey: KEY, model: 'm', fetchImpl: async () => sse() });
    ck('未知模式值退回 off', ide.gatewayMode === 'off', ide.gatewayMode);
  }
  {
    const ide = createIdeator({ gatewayMode: 'builtin', gatewayUrl: GW, apiKey: KEY,
      model: 'glm-5', fetchImpl: async () => sse() });
    ck('config getter 仍对 apiKey 脱敏', ide.config.apiKey === '***', ide.config.apiKey);
  }

  hr('结果: ' + (total - bad) + '/' + total + ' 通过, ' + bad + ' 失败');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.log('ERROR', e.message, e.stack); process.exit(1); });
