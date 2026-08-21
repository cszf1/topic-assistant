/* 选题生成层测试（含 fetchModels 与 PROVIDER_PRESETS 测试）
 * 用法: node test/ideate-test.js
 */
'use strict';
const path = require('path');
const { ANGLE_DICT } = require(path.join(__dirname, '..', 'web', 'angles.js'));
const { createIdeator, fallbackIdeas, IDEATE_SYSTEM_PROMPT, buildUserPrompt,
  PROVIDER_PRESETS, normalizeBaseUrl, endpoint, isLikelyChatModel } =
  require(path.join(__dirname, '..', 'web', 'ideate.js'));

let pass = 0, fail = 0;
const ck = (n, c, e) => { if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (e ? '  -> ' + e : '')); } };
const hr = t => console.log('\n' + '='.repeat(72) + '\n' + t + '\n' + '='.repeat(72));

const PROFILE = {
  major: '电子信息工程', grade: '大四', interest: '图像识别',
  gpu: 'none', dataset: 'public', codingLevel: 'mid', weeks: 16,
  goal: 'thesis', count: 4,
};

/* 造一个会返回合法 JSON 的 mock LLM */
function mockLLM() {
  return {
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ ideas: [
      { zh: '基于小样本学习的PCB表面缺陷检测', objectEn: 'PCB defect detection',
        methodEn: 'few-shot learning',
        needs: { gpu: 'none', dataset: 'public', weeks: 12, codingLevel: 'mid' },
        rationale: '缺陷样本天然稀少，且有公开数据集，不需要显卡训练' },
      { zh: '基于知识蒸馏的轻量化缺陷检测模型', objectEn: 'defect detection',
        methodEn: 'knowledge distillation',
        needs: { gpu: 'single', dataset: 'public', weeks: 14, codingLevel: 'mid' },
        rationale: '可在小模型上跑通，适合本科阶段' },
      { zh: '基于扩散模型的缺陷样本生成', objectEn: 'defect detection',
        methodEn: 'diffusion model',
        needs: { gpu: 'multi', dataset: 'public', weeks: 20, codingLevel: 'strong' },
        rationale: '有挑战性，但需要较强算力' },
      { zh: '基于图神经网络的电路板元件关系建模', objectEn: 'PCB inspection',
        methodEn: 'graph neural network',
        needs: { gpu: 'single', dataset: 'self-collect', weeks: 18, codingLevel: 'strong' },
        rationale: '电路板天然是图结构' },
    ] }) } }] }),
  };
}

(async () => {
  hr('1. 服务商预设与内置 BaseURL');
  ck('只保留官方文档可确认且可用的远程线路',
     Array.isArray(PROVIDER_PRESETS) && PROVIDER_PRESETS.length === 8);
  const ids = PROVIDER_PRESETS.map(p => p.id);
  ck('包含 7 个远程服务商与 custom',
     ['deepseek', 'siliconflow', 'zhipu', 'moonshot', 'minimax',
      'openrouter', 'openai', 'custom'].every(id => ids.includes(id)));
  ck('不包含本地模型与已知不可用的阿里百炼',
     !ids.includes('ollama') && !ids.includes('lmstudio') &&
     !ids.includes('qwen') && !ids.includes('lingyi'));
  ck('各远程预设包含已核实 URL、默认模型与日期',
     PROVIDER_PRESETS.filter(p => p.id !== 'custom').every(p =>
       p.baseUrl && p.defaultModel && p.verifiedAt));
  const deepseek = PROVIDER_PRESETS.find(p => p.id === 'deepseek');
  ck('DeepSeek 使用官方文档的 base_url 与现行模型',
     deepseek.baseUrl === 'https://api.deepseek.com' &&
     deepseek.defaultModel === 'deepseek-v4-flash');
  const minimax = PROVIDER_PRESETS.find(p => p.id === 'minimax');
  ck('MiniMax 使用现行官方 OpenAI 线路与模型',
     minimax.baseUrl === 'https://api.minimaxi.com/v1' && minimax.defaultModel === 'MiniMax-M3');
  ck('BaseURL 接受完整 chat/models 端点并归一化',
     normalizeBaseUrl('https://x.test/v1/chat/completions/') === 'https://x.test/v1' &&
     endpoint('https://x.test/v1/models', 'chat/completions') === 'https://x.test/v1/chat/completions');

  hr('2. fetchModels 模型拉取功能');
  const mockModelsFetch = async (url) => {
    if (url.endsWith('/models')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          object: 'list',
          data: [
            { id: 'deepseek-chat', object: 'model' },
            { id: 'deepseek-reasoner', object: 'model' },
            { id: 'deepseek-chat', object: 'model' }, // 测试重复项去重
            { id: 'text-embedding-v4', object: 'model' },
            { id: 'BAAI/bge-reranker-v2', object: 'model' },
            { id: 'gpt-image-1', object: 'model' },
          ]
        })
      };
    }
    return mockLLM();
  };

  const modelIdeator = createIdeator({
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-test',
    model: 'deepseek-chat',
    fetchImpl: mockModelsFetch
  });

  const mList = await modelIdeator.fetchModels();
  ck('fetchModels 成功拉取模型列表', mList.ok && Array.isArray(mList.models), JSON.stringify(mList));
  ck('fetchModels 自动去重，并排除 embedding/reranker/image 模型',
     mList.models.length === 2 && mList.rawTotal === 6 &&
     mList.models.includes('deepseek-chat') && mList.models.includes('deepseek-reasoner'));
  ck('聊天模型过滤器不会误删普通文本模型',
     isLikelyChatModel({}, 'qwen-plus') && !isLikelyChatModel({}, 'text-embedding-v4'));
  const diag = await modelIdeator.diagnose();
  ck('diagnose 同时验证模型枚举与真实聊天响应',
     diag.ok && diag.models.ok && diag.chat.ok && diag.chat.content.startsWith('{'));

  const listFailChatOk = createIdeator({
    baseUrl: 'https://x/v1', apiKey: 'k', model: 'm',
    fetchImpl: async url => url.endsWith('/models')
      ? { ok: false, status: 404, text: async () => 'no models route' }
      : mockLLM()
  });
  const partialDiag = await listFailChatOk.diagnose();
  ck('/models 失败不误判可正常聊天的线路',
     partialDiag.ok && !partialDiag.models.ok && partialDiag.chat.ok);

  // 测试异常处理
  const failModelIdeator = createIdeator({
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'bad-key',
    model: 'deepseek-chat',
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'Unauthorized invalid api key' })
  });
  let fetchErr = null;
  try { await failModelIdeator.fetchModels(); } catch (e) { fetchErr = e; }
  ck('fetchModels 401 报错时抛出明确信息', !!fetchErr && fetchErr.message.includes('401'));

  // DeepSeek 出错时返回无 content-type 的纯文本，不能把真实原因吐成“不是 JSON”
  const plainTextIdeator = createIdeator({
    baseUrl: 'https://api.deepseek.com', apiKey: 'bad', model: 'deepseek-v4-flash',
    fetchImpl: async () => ({ ok: false, status: 401, headers: { get: () => null },
      text: async () => 'Authentication Fails (governor)' })
  });
  let plainErr = null;
  try { await plainTextIdeator.fetchModels(); } catch (e) { plainErr = e; }
  ck('无 content-type 的纯文本 401 仍报认证失败并带原文',
     !!plainErr && plainErr.kind === 'auth' &&
     plainErr.message.includes('Authentication Fails'), plainErr && plainErr.message);

  // 真正的非 JSON（如被网关/门户拦截返回 200 HTML）必须报出可诊断信息
  const htmlIdeator = createIdeator({
    baseUrl: 'https://x/v1', apiKey: 'k', model: 'm',
    fetchImpl: async () => ({ ok: true, status: 200,
      headers: { get: k => k === 'content-type' ? 'text/html; charset=utf-8' : null },
      text: async () => '<!doctype html><html><head><title>登录转发</title></head>' })
  });
  let htmlErr = null;
  try { await htmlIdeator.fetchModels(); } catch (e) { htmlErr = e; }
  ck('200 非 JSON 时报出状态码/content-type/正文片段',
     !!htmlErr && htmlErr.kind === 'invalid_response' &&
     htmlErr.message.includes('HTTP 200') &&
     htmlErr.message.includes('text/html') &&
     htmlErr.message.includes('<!doctype html>'), htmlErr && htmlErr.message);

  hr('3. prompt 设计（防止模型越界替数据下判断）');
  ck('system prompt 明令禁止模型判断新颖性/论文数',
     IDEATE_SYSTEM_PROMPT.includes('严禁判断题目是否新颖') &&
     IDEATE_SYSTEM_PROMPT.includes('有多少篇论文'));
  ck('禁止输出「创新性高」「研究较少」这类不可证实的话',
     IDEATE_SYSTEM_PROMPT.includes('创新性高') && IDEATE_SYSTEM_PROMPT.includes('研究较少'));
  ck('要求英文术语是学界通用写法（否则检索不到）',
     IDEATE_SYSTEM_PROMPT.includes('学界通用写法') &&
     IDEATE_SYSTEM_PROMPT.includes('不要自创缩写'));
  ck('needs 取值被限定枚举', IDEATE_SYSTEM_PROMPT.includes('"none" | "single" | "multi"'));
  ck('要求诚实评估难度', IDEATE_SYSTEM_PROMPT.includes('不要为了让题目好看而低报难度'));

  const up = buildUserPrompt(PROFILE);
  ck('user prompt 把条件翻译成人话（无显卡→中文描述）',
     up.includes('没有显卡') && up.includes('只能用网上的公开数据集'));
  ck('user prompt 告知模型条件是硬约束、系统会自动筛',
     up.includes('硬约束') && up.includes('条件匹配'));
  ck('user prompt 带上题目数量', up.includes('4 个候选题目'));

  hr('4. 生成与归一化');
  const ide = createIdeator({ apiKey: 'sk-test', baseUrl: 'https://x/v1',
                              model: 'mock', fetchImpl: async () => mockLLM() });
  ck('configured() 正确', ide.configured() === true);
  const r = await ide.generate(PROFILE);
  ck('生成 4 个候选题', r.ok && r.ideas.length === 4, String(r.ideas.length));
  ck('每题都有中文题目与 objectEn',
     r.ideas.every(x => x.zh && x.objectEn));
  ck('needs 字段完整且取值合法',
     r.ideas.every(x => ['none','single','multi'].includes(x.needs.gpu) &&
                        ['public','self-collect','private'].includes(x.needs.dataset) &&
                        Number.isFinite(x.needs.weeks) &&
                        ['beginner','mid','strong'].includes(x.needs.codingLevel)));
  ck('source 标为 llm（供界面标注为模型推断）',
     r.ideas.every(x => x.source === 'llm'));
  ck('覆盖不同难度（既有 gpu:none 也有 gpu:multi）',
     r.ideas.some(x => x.needs.gpu === 'none') && r.ideas.some(x => x.needs.gpu === 'multi'));

  hr('4b. 供应商返回格式兼容');
  const oneIdea = { zh: '视网膜血管分割', objectEn: 'retinal vessel segmentation',
    methodEn: 'attention U-Net', needs: { gpu: 'single', dataset: 'public', weeks: 12, codingLevel: 'mid' } };
  const compatResponse = body => ({ ok: true, status: 200,
    json: async () => body, text: async () => JSON.stringify(body) });
  const compatCases = [
    ['content 分片数组', { choices: [{ message: { content: [{ type: 'text', text: JSON.stringify({ ideas: [oneIdea] }) }] } }] }],
    ['旧式 completions.text', { choices: [{ text: JSON.stringify({ ideas: [oneIdea] }) }] }],
    ['Responses output_text', { output_text: JSON.stringify({ ideas: [oneIdea] }) }],
    ['tool call arguments', { choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ ideas: [oneIdea] }) } }] } }] }],
    ['候选列表别名', { candidates: [oneIdea] }],
  ];
  for (const [name, body] of compatCases) {
    const compatible = createIdeator({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'm',
      maxRetries: 0, fetchImpl: async () => compatResponse(body) });
    let result = null;
    try { result = await compatible.generate({ ...PROFILE, count: 1 }); } catch (e) {}
    ck(name + ' -> 解析成功', !!result && result.ideas.length === 1 &&
      result.ideas[0].objectEn === oneIdea.objectEn);
  }
  const trailing = ide.parseIdeas('{"ideas":[{"title":"带尾逗号","object_en":"retinal vessel segmentation",},],}')[0];
  ck('尾逗号 -> 解析成功', trailing && trailing.objectEn === 'retinal vessel segmentation');
  const aliases = ide.parseIdeas('{"items":[{"title":"中文题目","research_object":"retinal vessel segmentation","requirements":{"gpu":"无显卡","dataset":"公开数据集","codingLevel":"中等","weeks":"12周"}}]}')[0];
  ck('字段别名与中文条件 -> 归一化成功', aliases && aliases.needs.gpu === 'none' &&
    aliases.needs.dataset === 'public' && aliases.needs.codingLevel === 'mid' && aliases.needs.weeks === 12);
  const stringComma = ide.parseIdeas('{"ideas":[{"zh":"对比 a,b,}","objectEn":"retinal vessel segmentation",}]}')[0];
  ck('字符串内逗号不被尾逗号修复篡改', stringComma && stringComma.zh === '对比 a,b,}');
  const bracketText = ide.parseIdeas('参见 [12]，建议如下：{"ideas":[{"objectEn":"retinal vessel segmentation"}]}');
  ck('解释文字中的中括号不截胡 JSON', bracketText.length === 1 &&
    bracketText[0].objectEn === 'retinal vessel segmentation');
  let truncatedRetryCalls = 0;
  const truncatedRetryIde = createIdeator({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'm',
    maxRetries: 0,
    fetchImpl: async () => {
      truncatedRetryCalls++;
      if (truncatedRetryCalls === 1) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          text: async () => JSON.stringify({
            choices: [{
              finish_reason: 'length',
              message: { content: '{"ideas":[{"zh":"半截","objectEn":"retinal vessel segmentation"' },
            }],
          }),
        };
      }
      return compatResponse({ choices: [{ finish_reason: 'stop', message: {
        content: JSON.stringify({ ideas: [oneIdea] }) } }] });
    } });
  const recovered = await truncatedRetryIde.generate({ ...PROFILE, count: 1 });
  ck('首次截断后自动紧凑重试', recovered.ok && recovered.recovered === true && truncatedRetryCalls === 2);

  const parsedObjectIde = createIdeator({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'm',
    maxRetries: 0, fetchImpl: async () => compatResponse({ output_parsed: { ideas: [oneIdea] } }) });
  const parsedObject = await parsedObjectIde.generate({ ...PROFILE, count: 1 });
  ck('结构化 output_parsed -> 解析成功', parsedObject.ok &&
    parsedObject.ideas[0].objectEn === oneIdea.objectEn);

  let truncatedJsonErr = null;
  try { ide.parseIdeas('{"ideas":[{"zh":"未完成","objectEn":"retinal vessel segmentation","needs":{"gpu":"single","dataset":"public'); } catch (e) { truncatedJsonErr = e; }
  ck('半截 JSON -> 明确识别为截断', !!truncatedJsonErr && truncatedJsonErr.kind === 'truncated_json');

  hr('5. 容错解析（模型输出不规范时不能崩）');
  const cases = [
    ['裹 markdown 代码块', '```json\n{"ideas":[{"zh":"题目A","objectEn":"bearing fault diagnosis","methodEn":"few-shot learning"}]}\n```'],
    ['前后有解释文字', '好的，以下是建议：\n{"ideas":[{"zh":"题目B","objectEn":"cyberbullying"}]}\n希望有帮助！'],
    ['顶层就是数组', '[{"zh":"题目C","objectEn":"gut brain axis","methodEn":"machine learning"}]'],
    ['字段用下划线命名', '{"ideas":[{"zh":"题目D","object_en":"solid state electrolyte","method_en":"machine learning","needs":{"coding_level":"strong"}}]}'],
    ['needs 取值非法', '{"ideas":[{"zh":"题目E","objectEn":"perovskite solar cell","needs":{"gpu":"超算","dataset":"随便","weeks":"很久","codingLevel":"神"}}]}'],
    ['推理模型 content 含 think 块', '<think>先推理一大段</think>\n{"ideas":[{"zh":"题目F","objectEn":"bearing fault diagnosis"}]}'],
  ];
  for (const [name, txt] of cases) {
    try {
      const out = ide.parseIdeas(txt);
      ck(name + ' -> 解析成功', out.length >= 1 && !!out[0].objectEn, JSON.stringify(out[0] || {}));
    } catch (e) { ck(name + ' -> 解析成功', false, e.message); }
  }
  const bad = ide.parseIdeas('{"ideas":[{"zh":"题目E","objectEn":"perovskite solar cell","needs":{"gpu":"超算","dataset":"随便","weeks":"很久","codingLevel":"神"}}]}')[0];
  ck('非法 needs 被兜底为保守默认值',
     bad.needs.gpu === 'single' && bad.needs.dataset === 'public' &&
     bad.needs.weeks === 14 && bad.needs.codingLevel === 'mid',
     JSON.stringify(bad.needs));
  ck('缺 objectEn 的条目被丢弃',
     ide.parseIdeas('{"ideas":[{"zh":"只有中文"},{"zh":"有的","objectEn":"cyberbullying"}]}').length === 1);

  let threw = null;
  try { ide.parseIdeas('这不是JSON'); } catch (e) { threw = e; }
  ck('完全无法解析时抛出明确错误', !!threw && threw.message.includes('不是合法 JSON'));

  hr('6. 未配置模型时的行为');
  const noKey = createIdeator({});
  ck('configured() 为 false', noKey.configured() === false);
  let e2 = null;
  try { await noKey.generate(PROFILE); } catch (e) { e2 = e; }
  ck('未配置时抛 NOT_CONFIGURED（供界面切兜底）',
     !!e2 && e2.code === 'NOT_CONFIGURED');
  ck('config 不泄露 apiKey',
     createIdeator({ apiKey: 'sk-secret' }).config.apiKey === '***');

  hr('7. 无模型兜底（必须自带警告）');
  const fb = fallbackIdeas(ANGLE_DICT, '电子信息', 6);
  ck('兜底能生成 6 个候选', fb.length === 6, String(fb.length));
  ck('每个都带 warning 说明语义未经判断',
     fb.every(x => x.warning && x.warning.includes('语义合理性未经模型判断')));
  ck('source 标为 template', fb.every(x => x.source === 'template'));

  hr('8. LLM 调用异常处理');
  const errIde = createIdeator({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'm',
    maxRetries: 0,
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'invalid api key' }) });
  let e3 = null;
  try { await errIde.generate(PROFILE); } catch (e) { e3 = e; }
  ck('HTTP 401 时抛出含状态码的错误', !!e3 && e3.message.includes('401'), e3 && e3.message);

  let sentBody = null;
  const minIde = createIdeator({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'm',
    maxRetries: 0,
    fetchImpl: async (url, init) => { sentBody = JSON.parse(init.body); return mockLLM(); } });
  const rr = await minIde.generate(PROFILE);
  ck('正式调用使用最小兼容负载，不强塞 temperature/response_format',
     rr.ok && !('temperature' in sentBody) && !('response_format' in sentBody),
     JSON.stringify(sentBody));

  ck('正式调用默认带有 JSON 输出预算', rr.ok && sentBody.max_tokens === 6144,
     JSON.stringify(sentBody));

  // 验证 buildChatBody 的模型名参数减法：o1 模型应重命名 max_tokens → max_completion_tokens 并删 temperature
  const o1BodyIde = createIdeator({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'o1-mini',
    maxRetries: 0, temperature: 0.7,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      ck('o1 模型 max_tokens 重命名为 max_completion_tokens',
        body.max_completion_tokens === 6144 && !('max_tokens' in body), JSON.stringify(body));
      ck('o1 模型删除 temperature 参数', !('temperature' in body));
      ck('o1 模型 system 角色降级为 user',
        body.messages.every(m => m.role !== 'system'));
      return mockLLM();
    } });
  const o1Result = await o1BodyIde.generate(PROFILE);
  ck('o1 模型生成成功', o1Result.ok && o1Result.ideas.length === 4);

  // 验证普通模型保留 max_tokens 且不重命名
  const normalBodyIde = createIdeator({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'gpt-4o-mini',
    maxRetries: 0,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      ck('普通模型保留 max_tokens 字段', body.max_tokens === 6144 && !('max_completion_tokens' in body));
      return mockLLM();
    } });
  const normalResult = await normalBodyIde.generate(PROFILE);
  ck('普通模型生成成功', normalResult.ok && normalResult.ideas.length === 4);

  // 验证流式 SSE 通道：mock 返回 SSE 格式流
  const streamedIdeaJson = JSON.stringify({ ideas: [{
    zh: '流式题目', objectEn: 'retinal vessel segmentation',
    needs: { gpu: 'single', dataset: 'public', weeks: 12, codingLevel: 'mid' },
  }] });
  const sseText = [
    'data: ' + JSON.stringify({ choices: [{ delta: { content: streamedIdeaJson } }] }),
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const sseBody = new TextEncoder().encode(sseText);
  const sseIde = createIdeator({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'm',
    maxRetries: 0,
    fetchImpl: async () => ({
      ok: true, status: 200,
      headers: { get: k => k === 'content-type' ? 'text/event-stream' : null },
      body: {
        getReader() {
          let sent = false;
          return {
            async read() {
              if (sent) return { done: true };
              sent = true;
              return { done: false, value: sseBody };
            },
            releaseLock() {},
          };
        },
      },
    }),
  });
  const sseResult = await sseIde.generate({ ...PROFILE, count: 1 });
  ck('SSE 流式通道解析成功', sseResult.ok && sseResult.ideas.length === 1 &&
    sseResult.ideas[0].objectEn === 'retinal vessel segmentation');

  // 通用流式 mock 工厂：把任意 SSE 文本分片成字节块供读取
  const makeStreamIde = (sseRaw, chunkSize) => {
    const bytes = new TextEncoder().encode(sseRaw);
    const size = chunkSize || bytes.length;
    let offset = 0;
    return createIdeator({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'm',
      maxRetries: 0,
      fetchImpl: async () => ({
        ok: true, status: 200,
        headers: { get: k => k === 'content-type' ? 'text/event-stream' : null },
        body: {
          getReader: () => ({
            async read() {
              if (offset >= bytes.length) return { done: true };
              const slice = bytes.slice(offset, offset + size);
              offset += size;
              return { done: false, value: slice };
            },
            releaseLock() {},
          }),
        },
      }),
    });
  };

  // CRLF + OpenRouter 心跳注释行 + 分片到达
  const crlfRaw = [
    ': OPENROUTER PROCESSING',
    '',
    'data: ' + JSON.stringify({ choices: [{ delta: { content: streamedIdeaJson.slice(0, 20) } }] }),
    '',
    'data: ' + JSON.stringify({ choices: [{ delta: { content: streamedIdeaJson.slice(20) } }] }),
    '',
    'data: [DONE]',
    '',
  ].join('\r\n');
  const crlfResult = await makeStreamIde(crlfRaw, 24).generate({ ...PROFILE, count: 1 });
  ck('CRLF/注释行/分片流拼接成功', crlfResult.ok &&
    crlfResult.ideas[0].objectEn === 'retinal vessel segmentation');

  // SSE 规范：同一事件内多条 data: 需用 \n 拼接后再解析
  const multiLineIdeaJson = JSON.stringify({ ideas: [{
    zh: '多行题目', objectEn: 'retinal vessel segmentation',
  }] }, null, 1);
  const multiLineRaw = 'data: ' +
    JSON.stringify({ choices: [{ delta: { content: multiLineIdeaJson } }] })
      .split('\n').join('\ndata: ') + '\n\ndata: [DONE]\n\n';
  const multiLineResult = await makeStreamIde(multiLineRaw).generate({ ...PROFILE, count: 1 });
  ck('同一事件多行 data 拼接成功', multiLineResult.ok &&
    multiLineResult.ideas[0].zh === '多行题目');

  // Anthropic 风格流：event 行 + delta.text
  const anthropicRaw = [
    'event: content_block_delta',
    'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: streamedIdeaJson } }),
    '',
    'event: message_stop',
    'data: ' + JSON.stringify({ type: 'message_stop' }),
    '',
  ].join('\n');
  const anthropicResult = await makeStreamIde(anthropicRaw).generate({ ...PROFILE, count: 1 });
  ck('Anthropic delta.text 流解析成功', anthropicResult.ok &&
    anthropicResult.ideas[0].objectEn === 'retinal vessel segmentation');

  // Gemini 风格流：candidates[].content.parts[].text，且跳过 thought 分片
  const geminiRaw = [
    'data: ' + JSON.stringify({ candidates: [{ content: { parts: [
      { text: '忽略的思维链', thought: true },
      { text: streamedIdeaJson },
    ] } }] }),
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const geminiResult = await makeStreamIde(geminiRaw).generate({ ...PROFILE, count: 1 });
  ck('Gemini candidates 流解析并跳过 thought', geminiResult.ok &&
    geminiResult.ideas[0].objectEn === 'retinal vessel segmentation' &&
    !/思维链/.test(geminiResult.raw));

  // 流式被长度上限截断：必须识别为截断并自动紧凑重试，不能当成完整结果
  let streamTruncCalls = 0;
  const truncStreamBytes = new TextEncoder().encode([
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '{"ideas":[{"zh":"半截"' } }] }),
    '',
    'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }),
    '',
    'data: [DONE]',
    '',
  ].join('\n'));
  const streamTruncIde = createIdeator({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'm',
    maxRetries: 0,
    fetchImpl: async (url, init) => {
      streamTruncCalls++;
      const reqBody = JSON.parse(init.body);
      if (reqBody.stream && streamTruncCalls === 1) {
        let sent = false;
        return { ok: true, status: 200,
          headers: { get: k => k === 'content-type' ? 'text/event-stream' : null },
          body: { getReader: () => ({
            async read() {
              if (sent) return { done: true };
              sent = true;
              return { done: false, value: truncStreamBytes };
            },
            releaseLock() {},
          }) } };
      }
      let sent2 = false;
      const okBytes = new TextEncoder().encode([
        'data: ' + JSON.stringify({ choices: [{ delta: { content: streamedIdeaJson }, finish_reason: 'stop' }] }),
        '',
        'data: [DONE]',
        '',
      ].join('\n'));
      return { ok: true, status: 200,
        headers: { get: k => k === 'content-type' ? 'text/event-stream' : null },
        body: { getReader: () => ({
          async read() {
            if (sent2) return { done: true };
            sent2 = true;
            return { done: false, value: okBytes };
          },
          releaseLock() {},
        }) } };
    } });
  const streamTruncResult = await streamTruncIde.generate({ ...PROFILE, count: 1 });
  ck('流式 finish_reason=length 视为截断并紧凑重试',
    streamTruncResult.ok && streamTruncResult.recovered === true && streamTruncCalls === 2,
    'calls=' + streamTruncCalls);

  // 截断信号但正文已完整：不得白花一次付费重试
  let salvageCalls = 0;
  const salvageIde = createIdeator({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'm',
    maxRetries: 0, stream: false,
    fetchImpl: async () => {
      salvageCalls++;
      return { ok: true, status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ choices: [{ finish_reason: 'length', message: {
          content: streamedIdeaJson } }] }) };
    } });
  const salvaged = await salvageIde.generate({ ...PROFILE, count: 1 });
  ck('截断信号但 JSON 完整时直接重用，不重试',
    salvaged.ok && salvaged.salvagedFromTruncation === true && salvageCalls === 1,
    'calls=' + salvageCalls);

  // 参数减法不应把 max_tokens 改成 Gemini 原生字段（OpenAI 兼容端会报非法参数）
  const geminiCompatIde = createIdeator({ apiKey: 'k', baseUrl: 'https://x/v1',
    model: 'google/gemini-2.5-pro', maxRetries: 0, stream: false,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      ck('Gemini 兼容端保留 max_tokens 不改写',
        body.max_tokens === 6144 && !('max_output_tokens' in body) &&
        !('max_completion_tokens' in body), JSON.stringify(body));
      return mockLLM();
    } });
  const geminiCompat = await geminiCompatIde.generate(PROFILE);
  ck('Gemini 兼容端生成成功', geminiCompat.ok);

  let abortCalls = 0;
  const abortIde = createIdeator({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'm',
    maxRetries: 0,
    fetchImpl: async (url, init) => {
      abortCalls++;
      const reqBody = JSON.parse(init.body);
      if (reqBody.stream) {
        // 流式请求：abort 在响应前触发，直接返回中止
        abortIde.abort();
        return { ok: true, status: 200,
          headers: { get: () => 'text/event-stream' },
          body: { getReader: () => ({ async read() { return { done: true }; }, releaseLock() {} }) } };
      }
      const response = { ok: true, status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
          content: 'not-json' } }] }) };
      abortIde.abort(); // 精确模拟第一次请求返回后、解析/紧凑重试前用户点击停止
      return response;
    } });
  let abortErr = null;
  try { await abortIde.generate(PROFILE); } catch (e) { abortErr = e; }
  ck('格式失败后用户停止不再发出紧凑重试', abortCalls === 1 && !!abortErr,
     'calls=' + abortCalls);

  // 可恢复的 5xx：只在流式通道内重试一次，总共 2 次请求，
  // 且不得在流式失败后额外再发一次非流式（否则就是重复计费）。
  let calls = 0;
  const streamOkBytes = new TextEncoder().encode([
    'data: ' + JSON.stringify({ choices: [{ delta: { content: streamedIdeaJson }, finish_reason: 'stop' }] }),
    '',
    'data: [DONE]',
    '',
  ].join('\n'));
  const retryIde = createIdeator({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'm',
    maxRetries: 1,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 500, text: async () => 'temporary' };
      let sent = false;
      return { ok: true, status: 200,
        headers: { get: k => k === 'content-type' ? 'text/event-stream' : null },
        body: { getReader: () => ({
          async read() {
            if (sent) return { done: true };
            sent = true;
            return { done: false, value: streamOkBytes };
          },
          releaseLock() {},
          cancel() {},
        }) } };
    } });
  const retried = await retryIde.generate({ ...PROFILE, count: 1 });
  ck('可恢复 5xx 仅在流式内重试一次（不重复计费）',
     retried.ok && calls === 2, 'calls=' + calls);

  // 非可恢复的流内错误：必须终止，不得静默改发非流式
  let streamErrCalls = 0;
  const streamErrBytes = new TextEncoder().encode([
    'data: ' + JSON.stringify({ error: { message: 'upstream refused' } }),
    '',
  ].join('\n'));
  const streamErrIde = createIdeator({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'm',
    maxRetries: 0,
    fetchImpl: async () => {
      streamErrCalls++;
      let sent = false;
      return { ok: true, status: 200,
        headers: { get: k => k === 'content-type' ? 'text/event-stream' : null },
        body: { getReader: () => ({
          async read() {
            if (sent) return { done: true };
            sent = true;
            return { done: false, value: streamErrBytes };
          },
          releaseLock() {},
          cancel() {},
        }) } };
    } });
  let streamErrCaught = null;
  try { await streamErrIde.generate(PROFILE); } catch (e) { streamErrCaught = e; }
  ck('流内错误终止且不重发非流式',
     !!streamErrCaught && streamErrCaught.kind === 'stream_error' && streamErrCalls === 1,
     'calls=' + streamErrCalls + ' kind=' + (streamErrCaught && streamErrCaught.kind));

  // 半截 JSON 不得静默缩成更少的题目
  let shrinkErr = null;
  try {
    ide.parseIdeas('{"ideas":[{"zh":"A","objectEn":"x1"},{"zh":"B","objectEn":"x2"},{"zh":"C","objectEn":');
  } catch (e) { shrinkErr = e; }
  ck('多题被截断时报截断而不静默缩成 1 题',
     !!shrinkErr && shrinkErr.kind === 'truncated_json',
     shrinkErr && shrinkErr.kind);

  // API key 不得出现在流内错误消息里
  const leakKey = 'sk-leak-1234567890';
  const leakBytes = new TextEncoder().encode('data: ' +
    JSON.stringify({ error: { message: 'bad Authorization Bearer ' + leakKey } }) + '\n\n');
  const leakIde = createIdeator({ apiKey: leakKey, baseUrl: 'https://x/v1', model: 'm',
    maxRetries: 0,
    fetchImpl: async () => {
      let sent = false;
      return { ok: true, status: 200,
        headers: { get: k => k === 'content-type' ? 'text/event-stream' : null },
        body: { getReader: () => ({
          async read() {
            if (sent) return { done: true };
            sent = true;
            return { done: false, value: leakBytes };
          },
          releaseLock() {},
          cancel() {},
        }) } };
    } });
  let leakErr = null;
  try { await leakIde.generate(PROFILE); } catch (e) { leakErr = e; }
  ck('流内错误消息对 API key 脱敏',
     !!leakErr && !leakErr.message.includes(leakKey) && leakErr.message.includes('***'),
     leakErr && leakErr.message.slice(0, 80));

  hr('结果: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
