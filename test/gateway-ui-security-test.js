/* 真实浏览器验证子代理报告的 H1（UI 声称与实际不一致）与 M2（清除不彻底）。 */
const { spawn } = require('child_process');
const http=require('http'),path=require('path'),os=require('os'),fs=require('fs');
const CHROME=path.join(os.homedir(),'AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe');
const PORT=9336,WEB=path.join(__dirname,'..','web');
const MIME={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function gj(u){return new Promise((s,j)=>{http.get(u,r=>{let b='';r.on('data',c=>b+=c);
  r.on('end',()=>{try{s(JSON.parse(b));}catch(e){j(e);}});}).on('error',j);});}
const srv=http.createServer((q,p)=>{let f=q.url.split('?')[0];if(f==='/')f='/index.html';
  const fp=path.join(WEB,f);if(!fp.startsWith(WEB)||!fs.existsSync(fp)){p.writeHead(404);return p.end();}
  p.writeHead(200,{'Content-Type':MIME[path.extname(fp)]||'text/plain'});fs.createReadStream(fp).pipe(p);});
let bad=0,total=0;
const ck=(n,o,i)=>{total++;console.log((o?'  PASS ':'  FAIL ')+n+(i?'  -> '+i:''));if(!o)bad++;};
const hr=t=>console.log('\n'+'='.repeat(66)+'\n'+t+'\n'+'='.repeat(66));

(async()=>{
  await new Promise(r=>srv.listen(8903,'127.0.0.1',r));
  const ch=spawn(CHROME,['--headless=new','--disable-gpu','--no-sandbox','--remote-debugging-port='+PORT,
    '--user-data-dir='+path.join(os.tmpdir(),'h1-'+Date.now()),'about:blank'],{stdio:'ignore'});
  let t=null;
  for(let i=0;i<40;i++){await sleep(300);try{const l=await gj('http://127.0.0.1:'+PORT+'/json/list');
    t=l.find(x=>x.type==='page');if(t)break;}catch(e){}}
  if(!t){console.log('CDP_TIMEOUT');ch.kill();process.exit(2);}
  const net=require('net'),crypto=require('crypto');const wu=new URL(t.webSocketDebuggerUrl);
  const sk=net.connect(Number(wu.port),wu.hostname);sk.on('error',()=>{});
  await new Promise(r=>sk.once('connect',r));
  sk.write('GET '+wu.pathname+' HTTP/1.1\r\nHost: '+wu.host+'\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: '+crypto.randomBytes(16).toString('base64')+'\r\nSec-WebSocket-Version: 13\r\n\r\n');
  await new Promise(r=>sk.once('data',r));
  let idc=0;const W=new Map();let rx=Buffer.alloc(0);
  sk.on('data',c=>{rx=Buffer.concat([rx,c]);
    while(rx.length>=2){const op=rx[0]&0x0f;let len=rx[1]&0x7f,off=2;
      if(len===126){len=rx.readUInt16BE(2);off=4;}else if(len===127){len=Number(rx.readBigUInt64BE(2));off=10;}
      if(rx.length<off+len)break;const pl=rx.slice(off,off+len).toString('utf8');rx=rx.slice(off+len);
      if(op===1){try{const m=JSON.parse(pl);if(m.id&&W.has(m.id)){W.get(m.id)(m);W.delete(m.id);}}catch(e){}}}});
  function sd(m,p){const id=++idc;const b=Buffer.from(JSON.stringify({id,method:m,params:p||{}}));
    const h=[0x81];const mk=crypto.randomBytes(4);
    if(b.length<126)h.push(0x80|b.length);else if(b.length<65536)h.push(0x80|126,b.length>>8&255,b.length&255);
    else h.push(0x80|127,0,0,0,0,b.length>>>24&255,b.length>>>16&255,b.length>>>8&255,b.length&255);
    const x=Buffer.alloc(b.length);for(let i=0;i<b.length;i++)x[i]=b[i]^mk[i%4];
    sk.write(Buffer.concat([Buffer.from(h),mk,x]));return new Promise(r=>W.set(id,r));}
  const ev=async e=>{const r=await sd('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});
    return r.result&&r.result.result?r.result.result.value:undefined;};
  await sd('Page.enable');await sd('Runtime.enable');
  const go=async()=>{await sd('Page.navigate',{url:'http://127.0.0.1:8903/index.html'});await sleep(1600);};

  // ============ H1: 选 builtin 但清空网关地址 ============
  hr('H1 · builtin + 空网关地址：界面不得声称免 Key');
  await go();
  await ev(`localStorage.setItem('xt_llm_cfg', JSON.stringify({version:4,preset:'custom',
    protocol:'openai-chat', baseUrl:'https://api.deepseek.com/v1', apiKey:'sk-LEAK-CANARY',
    model:'deepseek-chat', gatewayUrl:'https://p.supabase.co/functions/v1/meoo-ai',
    gatewayMode:'builtin'})); 'ok'`);
  await go();
  const before = JSON.parse(await ev(`JSON.stringify({
    badge: document.getElementById('gwBadge').textContent,
    keyDisabled: document.getElementById('apiKey').disabled })`));
  ck('地址完整时正常显示免 Key', /免\s*Key/.test(before.badge), before.badge);

  // 清空网关地址 —— 这是子代理指出的触发点
  await ev(`const el=document.getElementById('gatewayUrl'); el.value='';
            el.dispatchEvent(new Event('input')); 'ok'`);
  await sleep(400);
  const after = JSON.parse(await ev(`JSON.stringify({
    badge: document.getElementById('gwBadge').textContent,
    flow: document.getElementById('gwFlowNote').textContent,
    keyDisabled: document.getElementById('apiKey').disabled,
    keyValue: document.getElementById('apiKey').value,
    desyncClass: document.getElementById('gwBadge').className })`));
  ck('★ 徽标不再声称已启用免 Key', !/免\s*Key/.test(after.badge), after.badge);
  ck('★ 徽标明示实际为直连', /直连/.test(after.badge), after.badge);
  ck('徽标带警示样式', /gw-desync/.test(after.desyncClass), after.desyncClass);
  ck('★ 去向说明警告将携带本地密钥直连',
     /实际为浏览器直连/.test(after.flow) && /携带你本地填写的密钥/.test(after.flow),
     after.flow.slice(0, 100));
  ck('密钥输入框解除禁用（否则用户看不到也改不了）', after.keyDisabled === false);
  ck('密钥值仍在（未被静默丢弃）', after.keyValue === 'sk-LEAK-CANARY');

  // ============ M4: 缺 scheme ============
  hr('M4 · baseUrl 缺 https:// 时不得把密钥发往本站');
  await ev(`document.querySelector('[data-gwmode="off"]').click();
            const b=document.getElementById('baseUrl'); b.value='api.deepseek.com';
            b.dispatchEvent(new Event('input')); 'ok'`);
  await sleep(400);
  const noScheme = JSON.parse(await ev(`JSON.stringify({
    flow: document.getElementById('gwFlowNote').textContent,
    badge: document.getElementById('cfgBadge').textContent })`));
  ck('★ 明确指出地址缺少 https:// 前缀',
     /缺少\s*https/.test(noScheme.flow), noScheme.flow.slice(0, 90));
  ck('配置徽标判为未填完', /未填完/.test(noScheme.badge), noScheme.badge);

  // ============ M3: 切预设刷新去向 ============
  hr('M3 · 切换服务商预设后去向面板同步');
  await ev(`document.querySelector('[data-gwmode="proxy"]').click();
            document.getElementById('gatewayUrl').value='https://p.supabase.co/functions/v1/meoo-ai';
            document.getElementById('gatewayUrl').dispatchEvent(new Event('input'));
            document.getElementById('baseUrl').value='https://opencode.ai/zen/go/v1';
            document.getElementById('baseUrl').dispatchEvent(new Event('input')); 'ok'`);
  await sleep(300);
  const beforeSw = await ev(`document.getElementById('gwFlowNote').textContent`);
  ck('切换前上游为 opencode.ai', /opencode\.ai/.test(beforeSw));
  await ev(`const s=document.getElementById('presetSelect'); s.value='deepseek';
            s.dispatchEvent(new Event('change')); 'ok'`);
  await sleep(500);
  const afterSw = await ev(`document.getElementById('gwFlowNote').textContent`);
  ck('★ 切预设后去向面板已同步为新上游',
     /deepseek/.test(afterSw) && !/opencode\.ai/.test(afterSw), afterSw.slice(0, 90));

  // ============ M2: 清除全部数据 ============
  hr('M2 · 清除全部本地数据必须彻底');
  await ev(`(function(){
    // 先塞一份文献缓存，模拟真实使用过
    try { localStorage.setItem('xt_cache', JSON.stringify({ 'probe-key': { count: 42 } })); } catch(e){}
    return 'seeded';
  })()`);
  await go();
  await ev(`localStorage.setItem('xt_llm_cfg', JSON.stringify({version:4,preset:'custom',
    protocol:'openai-chat', baseUrl:'https://api.deepseek.com/v1', apiKey:'sk-MUST-VANISH',
    model:'deepseek-chat', gatewayUrl:'https://p.supabase.co/functions/v1/meoo-ai',
    gatewayMode:'proxy'}));
    localStorage.setItem('xt_cache', JSON.stringify({'probe-key':{count:42}})); 'ok'`);
  await go();
  await ev(`window.confirm=()=>true; document.getElementById('clearAllBtn').click(); 'ok'`);
  await sleep(600);
  const cleared = JSON.parse(await ev(`JSON.stringify({
    cfg: localStorage.getItem('xt_llm_cfg'),
    cache: localStorage.getItem('xt_cache'),
    xtKeys: Object.keys(localStorage).filter(k=>/^xt_/.test(k)),
    dom: { key: document.getElementById('apiKey').value,
           gw: document.getElementById('gatewayUrl').value,
           base: document.getElementById('baseUrl').value } })`));
  ck('★ 配置键已彻底移除', cleared.cfg === null, String(cleared.cfg).slice(0, 60));
  ck('★ 文献缓存已移除', cleared.cache === null, String(cleared.cache).slice(0, 40));
  ck('★ 无任何 xt_ 残留键', cleared.xtKeys.length === 0, JSON.stringify(cleared.xtKeys));
  ck('DOM 中密钥/地址已清空',
     !cleared.dom.key && !cleared.dom.gw && !cleared.dom.base, JSON.stringify(cleared.dom));

  // 清除后触发一次缓存写入，验证内存副本没把旧缓存写回
  // 通过真实业务路径触发缓存写入：点演示数据会跑 OpenAlex 核验并写缓存。
  // 若内存副本没清，旧的 probe-key 会被整体写回。
  await ev(`document.getElementById('demoBtn').click(); 'clicked'`);
  await sleep(3500);
  const rewrite = await ev(`localStorage.getItem('xt_cache') || '(空)'`);
  ck('★ 清除后再写缓存不会带回旧数据',
     !String(rewrite).includes('probe-key'),
     String(rewrite).slice(0, 70));

  hr('结果: ' + (total-bad) + '/' + total + ' 通过, ' + bad + ' 失败');
  ch.kill(); srv.close(); await sleep(200); process.exit(bad?1:0);
})().catch(e=>{console.log('ERROR',e.message);process.exit(1);});
