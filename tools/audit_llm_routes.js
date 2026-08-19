/*
 * 审计 web/ideate.js 当前内置的全部远程大模型线路（不需要 API Key）。
 * 验证：路由存在、认证契约合理、file:// Origin 的 CORS 预检可用。
 * 注意：无 Key 不能证明指定模型有权限/余额/可生成，最终须用页面“完整检查”。
 *
 * 用法：node tools/audit_llm_routes.js
 */
'use strict';
const { PROVIDER_PRESETS } = require('../web/ideate.js');

const failCodes = new Set([0, 404]);
function withTimeout(ms) {
  return typeof AbortSignal !== 'undefined' && AbortSignal.timeout
    ? AbortSignal.timeout(ms) : undefined;
}
async function status(url, init) {
  try {
    return (await fetch(url, Object.assign({ signal: withTimeout(15000) }, init || {}))).status;
  } catch (e) { return 0; }
}
async function cors(url) {
  try {
    const r = await fetch(url, {
      method: 'OPTIONS', signal: withTimeout(15000),
      headers: {
        Origin: 'null',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    const origin = r.headers.get('access-control-allow-origin');
    return { ok: origin === '*' || origin === 'null', origin: origin || '-' };
  } catch (e) { return { ok: false, origin: '-' }; }
}

(async () => {
  const rows = [];
  for (const p of PROVIDER_PRESETS.filter(x => x.id !== 'custom')) {
    const base = p.baseUrl.replace(/\/+$/, '');
    const models = await status(base + '/models');
    const chat = await status(base + '/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: p.defaultModel,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    });
    const co = await cors(base + '/chat/completions');
    const routeOK = !failCodes.has(models) && !failCodes.has(chat);
    rows.push({
      provider: p.name, models, chat, cors: co.origin,
      result: routeOK && co.ok ? 'PASS' : 'FAIL',
      model: p.defaultModel,
    });
  }
  console.table(rows);
  const failures = rows.filter(x => x.result === 'FAIL');
  console.log('\n说明：401/403 表示路由存在但需要有效 Key；这是无鉴权探针的预期结果。');
  console.log('最终模型权限、余额和正文响应需在页面中输入 Key 后点击“完整检查”。');
  if (failures.length) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
