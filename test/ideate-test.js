/* 选题生成层测试（含 fetchModels 与 PROVIDER_PRESETS 测试）
 * 用法: node test/ideate-test.js
 */
'use strict';
const path = require('path');
const { ANGLE_DICT } = require(path.join(__dirname, '..', 'web', 'angles.js'));
const { createIdeator, fallbackIdeas, IDEATE_SYSTEM_PROMPT, buildUserPrompt,
  PROVIDER_PRESETS, normalizeBaseUrl, endpoint, isLikelyChatModel,
  stripReasoning, extractPayloadText, isReasoningModel, estimateMaxTokens } =
  require(path.join(__dirname, '..', 'web', 'ideate.js'));
// 第 12 节对抗场景用到模块级工具函数（用 M 命名空间避免与局部 ide 实例重名）
const M = { stripReasoning, extractPayloadText, isReasoningModel, estimateMaxTokens };

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
        body.max_completion_tokens > 6144 && !('max_tokens' in body), JSON.stringify(body.max_completion_tokens));
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
      ck('普通模型保留 max_tokens 字段', body.max_tokens === 6144 && !('max_completion_tokens' in body),
        String(body.max_tokens));
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

  hr('9. 多协议适配（Anthropic / Gemini / Responses）');
  const protoIdeaJson = JSON.stringify({ ideas: [{
    zh: '协议题目', objectEn: 'retinal vessel segmentation',
  }] });

  // Anthropic：x-api-key + anthropic-version，system 提到顶层，正文在 content[].text
  let anthReq = null;
  const anthIde = createIdeator({
    protocol: 'anthropic-messages', apiKey: 'sk-ant-xxx',
    baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4',
    maxRetries: 0, stream: false,
    fetchImpl: async (url, init) => {
      anthReq = { url, headers: init.headers, body: JSON.parse(init.body) };
      return { ok: true, status: 200, headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({
          content: [{ type: 'text', text: protoIdeaJson }], stop_reason: 'end_turn' }) };
    } });
  const anthRes = await anthIde.generate({ ...PROFILE, count: 1 });
  ck('Anthropic 走 /messages 端点', /\/messages$/.test(anthReq.url), anthReq.url);
  ck('Anthropic 用 x-api-key 与 anthropic-version',
    anthReq.headers['x-api-key'] === 'sk-ant-xxx' &&
    anthReq.headers['anthropic-version'] === '2023-06-01' &&
    !('Authorization' in anthReq.headers));
  ck('Anthropic system 提到顶层且 messages 无 system 角色',
    typeof anthReq.body.system === 'string' && anthReq.body.system.length > 0 &&
    anthReq.body.messages.every(m => m.role !== 'system'));
  ck('Anthropic max_tokens 必填且解析 content[].text',
    anthReq.body.max_tokens === 6144 && anthRes.ok &&
    anthRes.ideas[0].objectEn === 'retinal vessel segmentation');
  ck('Anthropic 默认不声称可浏览器直连并给出提示',
    anthIde.protocolInfo.browserDirect === false &&
    /Edge Function/.test(anthIde.protocolInfo.browserNote || ''));

  // Gemini：路径带 :generateContent，contents + systemInstruction，x-goog-api-key
  let gemReq = null;
  const gemIde = createIdeator({
    protocol: 'gemini-generateContent', apiKey: 'AIza-xxx',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-pro', maxRetries: 0, stream: false,
    fetchImpl: async (url, init) => {
      gemReq = { url, headers: init.headers, body: JSON.parse(init.body) };
      return { ok: true, status: 200, headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ candidates: [{ content: { parts: [
          { text: '思维链不要', thought: true },
          { text: protoIdeaJson },
        ] }, finishReason: 'STOP' }] }) };
    } });
  const gemRes = await gemIde.generate({ ...PROFILE, count: 1 });
  ck('Gemini 走 models/{model}:generateContent',
    /models\/gemini-2\.5-pro:generateContent$/.test(gemReq.url), gemReq.url);
  ck('Gemini 用 x-goog-api-key 鉴权',
    gemReq.headers['x-goog-api-key'] === 'AIza-xxx' && !('Authorization' in gemReq.headers));
  ck('Gemini 转成 contents + systemInstruction，助手角色为 model',
    Array.isArray(gemReq.body.contents) &&
    gemReq.body.contents.every(x => x.role === 'user' || x.role === 'model') &&
    !!gemReq.body.systemInstruction);
  ck('Gemini 用 generationConfig.maxOutputTokens',
    gemReq.body.generationConfig.maxOutputTokens === 6144 &&
    !('max_tokens' in gemReq.body));
  ck('Gemini 解析 parts 并跳过 thought',
    gemRes.ok && gemRes.ideas[0].objectEn === 'retinal vessel segmentation' &&
    !/思维链/.test(gemRes.raw));

  // Gemini 流式：:streamGenerateContent?alt=sse
  let gemStreamUrl = null;
  const gemStreamBytes = new TextEncoder().encode([
    'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: protoIdeaJson }] } }] }),
    '',
    'data: [DONE]',
    '',
  ].join('\n'));
  const gemStreamIde = createIdeator({
    protocol: 'gemini-generateContent', apiKey: 'AIza-xxx',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-flash', maxRetries: 0,
    fetchImpl: async (url) => {
      gemStreamUrl = url;
      let sent = false;
      return { ok: true, status: 200,
        headers: { get: k => k === 'content-type' ? 'text/event-stream' : null },
        body: { getReader: () => ({
          async read() {
            if (sent) return { done: true };
            sent = true;
            return { done: false, value: gemStreamBytes };
          },
          releaseLock() {}, cancel() {},
        }) } };
    } });
  const gemStreamRes = await gemStreamIde.generate({ ...PROFILE, count: 1 });
  ck('Gemini 流式走 :streamGenerateContent?alt=sse',
    /:streamGenerateContent\?alt=sse$/.test(gemStreamUrl), gemStreamUrl);
  ck('Gemini 流式解析成功',
    gemStreamRes.ok && gemStreamRes.via === 'stream' &&
    gemStreamRes.ideas[0].objectEn === 'retinal vessel segmentation');

  // Anthropic 流式截断：delta.stop_reason = max_tokens 必须识别为截断
  let anthStreamCalls = 0;
  const anthTruncBytes = new TextEncoder().encode([
    'event: content_block_delta',
    'data: ' + JSON.stringify({ delta: { type: 'text_delta', text: '{"ideas":[{"zh":"半' } }),
    '',
    'event: message_delta',
    'data: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }),
    '',
  ].join('\n'));
  const anthOkBytes = new TextEncoder().encode([
    'event: content_block_delta',
    'data: ' + JSON.stringify({ delta: { type: 'text_delta', text: protoIdeaJson } }),
    '',
    'event: message_stop',
    'data: ' + JSON.stringify({ type: 'message_stop' }),
    '',
  ].join('\n'));
  const anthStreamIde = createIdeator({
    protocol: 'anthropic-messages', apiKey: 'sk-ant-xxx',
    baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4',
    maxRetries: 0,
    fetchImpl: async () => {
      anthStreamCalls++;
      const payload = anthStreamCalls === 1 ? anthTruncBytes : anthOkBytes;
      let sent = false;
      return { ok: true, status: 200,
        headers: { get: k => k === 'content-type' ? 'text/event-stream' : null },
        body: { getReader: () => ({
          async read() {
            if (sent) return { done: true };
            sent = true;
            return { done: false, value: payload };
          },
          releaseLock() {}, cancel() {},
        }) } };
    } });
  const anthStreamRes = await anthStreamIde.generate({ ...PROFILE, count: 1 });
  ck('Anthropic 流式 stop_reason=max_tokens 视为截断并重试',
    anthStreamRes.ok && anthStreamRes.recovered === true && anthStreamCalls === 2,
    'calls=' + anthStreamCalls);

  // Responses 协议：/responses + input + max_output_tokens
  let respReq = null;
  const respIde = createIdeator({
    protocol: 'openai-responses', apiKey: 'sk-xxx',
    baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini',
    maxRetries: 0, stream: false,
    fetchImpl: async (url, init) => {
      respReq = { url, body: JSON.parse(init.body) };
      return { ok: true, status: 200, headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ output_text: protoIdeaJson, status: 'completed' }) };
    } });
  const respRes = await respIde.generate({ ...PROFILE, count: 1 });
  ck('Responses 走 /responses 端点', /\/responses$/.test(respReq.url), respReq.url);
  ck('Responses 用 input + max_output_tokens，system 转 developer',
    Array.isArray(respReq.body.input) &&
    respReq.body.max_output_tokens === 6144 &&
    respReq.body.input.some(m => m.role === 'developer') &&
    !('messages' in respReq.body));
  ck('Responses 解析 output_text', respRes.ok &&
    respRes.ideas[0].objectEn === 'retinal vessel segmentation');

  // 未知协议回退到 openai-chat，不能直接报错
  const fallbackProto = createIdeator({ protocol: 'nope', apiKey: 'k',
    baseUrl: 'https://x/v1', model: 'm' });
  ck('未知协议安全回退到 openai-chat', fallbackProto.protocol === 'openai-chat');

  hr('10. 思维链隔离与输出预算（真实故障回归）');

  const cotJson = JSON.stringify({ ideas: [{
    zh: '思维链隔离题', objectEn: 'retinal vessel segmentation', methodEn: 'few-shot learning',
  }] });
  function sseOnce(payload){
    let sent = false;
    return { ok: true, status: 200,
      headers: { get: k => k === 'content-type' ? 'text/event-stream' : null },
      body: { getReader: () => ({
        async read(){ if (sent) return { done: true }; sent = true;
          return { done: false, value: new TextEncoder().encode(payload) }; },
        releaseLock(){}, cancel(){},
      }) } };
  }
  async function runContent(model, content){
    const ide2 = createIdeator({ apiKey: 'k', baseUrl: 'https://x/v1', model, maxRetries: 0,
      fetchImpl: async () => sseOnce(
        'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n' +
        'data: [DONE]\n\n') });
    return ide2.generate({ ...PROFILE, count: 1 });
  }

  // <think> 三种真实形态都不能把思维链当成答案
  const cotCases = [
    ['完整 think 块', '<think>我先分析学生条件，再逐一权衡</think>' + cotJson],
    ['只有闭合标签（首块丢失）', '我先分析学生条件，再逐一权衡</think>' + cotJson],
    ['thinking 标签', '<thinking>内部推演</thinking>' + cotJson],
    ['大写 THINK', '<THINK>内部推演</THINK>' + cotJson],
  ];
  for (const [name, content] of cotCases) {
    const r = await runContent('qwq-32b', content);
    ck('思维链剥离: ' + name,
      r.ok && !/分析学生条件|内部推演/.test(r.raw) && r.ideas[0].zh === '思维链隔离题',
      (r.raw || '').slice(0, 60));
  }

  // 模型漏写闭合标签时，正文 JSON 仍要被抢救出来
  const unclosed = await runContent('qwq-32b', '<think>思考中但忘了闭合 ' + cotJson);
  ck('思维链未闭合时仍抢救出正文 JSON',
     unclosed.ok && unclosed.ideas[0].zh === '思维链隔离题' && !/思考中/.test(unclosed.raw),
     (unclosed.raw || '').slice(0, 60));

  // reasoning_content 独立字段不得混入正文
  const rcIde = createIdeator({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'deepseek-reasoner',
    maxRetries: 0,
    fetchImpl: async () => sseOnce(
      'data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: '长长的思维链推演' } }] }) + '\n\n' +
      'data: ' + JSON.stringify({ choices: [{ delta: { content: cotJson } }] }) + '\n\n' +
      'data: [DONE]\n\n') });
  const rcRes = await rcIde.generate({ ...PROFILE, count: 1 });
  ck('reasoning_content 不混入正文',
     rcRes.ok && !/思维链推演/.test(rcRes.raw), (rcRes.raw || '').slice(0, 60));

  // Mistral 风格 content 数组里混着 thinking 段
  const mistralIde = createIdeator({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'magistral-small',
    maxRetries: 0,
    fetchImpl: async () => sseOnce(
      'data: ' + JSON.stringify({ choices: [{ delta: { content: [
        { type: 'thinking', text: '内部思考不可外泄' },
        { type: 'text', text: cotJson },
      ] } }] }) + '\n\n' + 'data: [DONE]\n\n') });
  const mistralRes = await mistralIde.generate({ ...PROFILE, count: 1 });
  ck('Mistral content 数组中的 thinking 段被过滤',
     mistralRes.ok && !/不可外泄/.test(mistralRes.raw), (mistralRes.raw || '').slice(0, 60));

  // 输出预算：推理模型必须比同题数的非推理模型拿到更多预算
  async function budgetOf(model, count){
    let seen = null;
    const ide3 = createIdeator({ apiKey: 'k', baseUrl: 'https://x/v1', model, maxRetries: 0,
      fetchImpl: async (url, init) => {
        const b = JSON.parse(init.body);
        seen = b.max_tokens ?? b.max_completion_tokens;
        return sseOnce('data: ' + JSON.stringify({ choices: [{ delta: { content: cotJson } }] }) +
          '\n\ndata: [DONE]\n\n');
      } });
    await ide3.generate({ ...PROFILE, count });
    return seen;
  }
  const bPlain8 = await budgetOf('deepseek-chat', 8);
  const bReason8 = await budgetOf('deepseek-reasoner', 8);
  const bPlain2 = await budgetOf('deepseek-chat', 2);
  ck('推理模型获得更大输出预算', bReason8 > bPlain8, bPlain8 + ' -> ' + bReason8);
  ck('题数越多预算越大', bPlain8 > bPlain2, bPlain2 + ' -> ' + bPlain8);
  ck('非推理模型不白付思维链预算', bReason8 - bPlain8 >= 4096, String(bReason8 - bPlain8));

  // 关键回归：length 截断后重试必须真的加大预算，而不是原样重发
  const budgets = [];
  const truncIde = createIdeator({ apiKey: 'k', baseUrl: 'https://x/v1',
    model: 'deepseek-reasoner', maxRetries: 0,
    fetchImpl: async (url, init) => {
      budgets.push(JSON.parse(init.body).max_tokens);
      if (budgets.length < 3) {
        return sseOnce('data: ' + JSON.stringify({ choices: [{
          delta: { content: '{"ideas":[{"zh":"半' }, finish_reason: 'length' }] }) +
          '\n\ndata: [DONE]\n\n');
      }
      return sseOnce('data: ' + JSON.stringify({ choices: [{ delta: { content: cotJson } }] }) +
        '\n\ndata: [DONE]\n\n');
    } });
  const truncRes = await truncIde.generate({ ...PROFILE, count: 8 });
  ck('截断重试逐轮加大预算（不是原样重发）',
     truncRes.ok && budgets.length === 3 &&
     budgets[1] > budgets[0] && budgets[2] > budgets[1],
     budgets.join(' -> '));

  // 只有思维链、正文为空：应加大预算重试而不是直接判死
  let roCalls = 0;
  const roIde = createIdeator({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'deepseek-reasoner',
    maxRetries: 0, stream: false,
    fetchImpl: async () => {
      roCalls++;
      if (roCalls === 1) {
        return { ok: true, status: 200, headers: { get: () => 'application/json' },
          text: async () => JSON.stringify({ choices: [{ message: {
            content: '', reasoning_content: '我想了很久但没输出正文' } }] }) };
      }
      return { ok: true, status: 200, headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ choices: [{ message: { content: cotJson } }] }) };
    } });
  const roRes = await roIde.generate({ ...PROFILE, count: 1 });
  ck('只返回思维链时加大预算重试而非直接失败',
     roRes.ok && roCalls === 2 && roRes.recovered === true, 'calls=' + roCalls);

  hr('11. 模型列表探测与 baseUrl 约定');

  const jsonRes = payload => ({ ok: true, status: 200,
    headers: { get: () => 'application/json' }, text: async () => JSON.stringify(payload) });
  const notFound = { ok: false, status: 404,
    headers: { get: () => 'text/plain' }, text: async () => 'not found' };

  // 用户只填 https://api.x.com（不带 /v1）时必须自动探测 /v1/models
  const probed = [];
  const probeIde = createIdeator({ apiKey: 'k', baseUrl: 'https://api.x.com', model: 'm',
    fetchImpl: async (url) => {
      probed.push(url);
      return url.endsWith('/v1/models')
        ? jsonRes({ data: [{ id: 'gpt-4o-mini' }, { id: 'text-embedding-3-small' }] })
        : notFound;
    } });
  const probeRes = await probeIde.fetchModels();
  ck('缺少 /v1 时自动探测补全',
     probeRes.ok && probeRes.apiRoot === 'https://api.x.com/v1' &&
     probed.length === 2 && probed[0].endsWith('/models'), probed.join(' , '));
  ck('模型列表过滤 embedding 条目',
     probeRes.models.length === 1 && probeRes.models[0] === 'gpt-4o-mini',
     JSON.stringify(probeRes.models));

  // # 结尾锁定地址：不得再自动补 /v1（Open-WebUI 等非 /v1 网关）
  const pinned = [];
  const pinIde = createIdeator({ apiKey: 'k', baseUrl: 'http://host:3000/api#', model: 'm',
    fetchImpl: async (url) => { pinned.push(url); return jsonRes({ data: [{ id: 'llama3' }] }); } });
  const pinRes = await pinIde.fetchModels();
  ck('# 结尾强制原样地址，不补 /v1',
     pinRes.ok && pinned.length === 1 && pinned[0] === 'http://host:3000/api/models',
     pinned.join(' , '));

  // 裸数组与 Gemini models/ 前缀都要能吃
  const bareIde = createIdeator({ apiKey: 'k', baseUrl: 'https://api.x.com/v1', model: 'm',
    fetchImpl: async () => jsonRes(['model-a', 'model-b']) });
  const bareRes = await bareIde.fetchModels();
  ck('裸数组模型列表可解析', bareRes.ok && bareRes.models.length === 2, JSON.stringify(bareRes.models));

  const gemListIde = createIdeator({ protocol: 'gemini-generateContent', apiKey: 'k',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'm',
    fetchImpl: async () => jsonRes({ models: [{ name: 'models/gemini-2.5-pro' }] }) });
  const gemListRes = await gemListIde.fetchModels();
  ck('Gemini models/ 前缀被剥离',
     gemListRes.ok && gemListRes.models[0] === 'gemini-2.5-pro', JSON.stringify(gemListRes.models));

  // 鉴权失败不该换地址重试（换了也没用，只会多打一次）
  let authTries = 0;
  const authIde = createIdeator({ apiKey: 'bad', baseUrl: 'https://api.x.com', model: 'm',
    fetchImpl: async () => { authTries++;
      return { ok: false, status: 401, headers: { get: () => 'text/plain' },
        text: async () => 'invalid key' }; } });
  let authErr = null;
  try { await authIde.fetchModels(); } catch (e) { authErr = e; }
  ck('鉴权失败不做多地址重试',
     !!authErr && authErr.kind === 'auth' && authTries === 1, 'tries=' + authTries);

  // 全部候选失败时，报错要给出可操作提示
  const deadIde = createIdeator({ apiKey: 'k', baseUrl: 'https://api.x.com', model: 'm',
    fetchImpl: async () => notFound });
  let deadErr = null;
  try { await deadIde.fetchModels(); } catch (e) { deadErr = e; }
  ck('全部探测失败时提示 # 与手填模型',
     !!deadErr && /#/.test(deadErr.message) && /手填/.test(deadErr.message),
     (deadErr && deadErr.message || '').slice(0, 120));

  // 聊天请求不受探测影响：仍用用户配置的根地址
  let chatUrl = null;
  const chatRootIde = createIdeator({ apiKey: 'k', baseUrl: 'https://api.x.com/v1#', model: 'm',
    maxRetries: 0, stream: false,
    fetchImpl: async (url) => { chatUrl = url;
      return jsonRes({ choices: [{ message: { content: JSON.stringify({ ideas: [{
        zh: 'A', objectEn: 'x', methodEn: 'y' }] }) } }] }); } });
  const chatRootRes = await chatRootIde.generate({ ...PROFILE, count: 1 });
  ck('# 锁定地址下聊天端点仍正确',
     chatRootRes.ok && chatUrl === 'https://api.x.com/v1/chat/completions', String(chatUrl));

  hr('12. 对抗场景（思维链标签字面量与畸形输入）');

  // 题目正文本身含 </think> 字面量：不得被当成思维链边界而切坏 JSON
  const literalJson = JSON.stringify({ ideas: [{
    zh: '基于</think>标签解析的推理链评测', objectEn: 'chain of thought parsing',
    methodEn: 'prompt engineering' }] });
  const litOut = M.extractPayloadText(literalJson);
  let litParsed = null;
  try { litParsed = JSON.parse(litOut.text); } catch (e) {}
  ck('正文含 </think> 字面量时 JSON 不被破坏',
     !!litParsed && litParsed.ideas[0].zh.indexOf('</think>') >= 0,
     litOut.text.slice(0, 60));

  const litWithCot = M.extractPayloadText('<think>先想想</think>' + literalJson);
  let litParsed2 = null;
  try { litParsed2 = JSON.parse(litWithCot.text); } catch (e) {}
  ck('真思维链 + 正文字面量可同时正确处理',
     !!litParsed2 && litParsed2.ideas[0].methodEn === 'prompt engineering',
     litWithCot.text.slice(0, 60));

  // 闭合思维链里的草稿 JSON 不能顶替正文答案
  const draftOut = M.extractPayloadText(
    '<think>草拟：{"ideas":[{"zh":"草稿","objectEn":"wrong"}]} 不对，重写</think>' +
    JSON.stringify({ ideas: [{ zh: '正式题目', objectEn: 'right', methodEn: 'm' }] }));
  let draftParsed = null;
  try { draftParsed = JSON.parse(draftOut.text); } catch (e) {}
  ck('思维链内草稿 JSON 不顶替正文',
     !!draftParsed && draftParsed.ideas[0].zh === '正式题目', draftOut.text.slice(0, 50));

  // 未闭合时从思维链抢救出的 JSON 必须打标记，便于上层区分可信度
  const salvOut = M.extractPayloadText(
    '<think>草拟：' + JSON.stringify({ ideas: [{ zh: '草稿题', objectEn: 'd', methodEn: 'm' }] }));
  ck('未闭合抢救打 salvagedFromReasoning 标记',
     salvOut.salvagedFromReasoning === true, String(salvOut.salvagedFromReasoning));

  // 畸形输入不得卡死或抛异常
  const evilInputs = [
    ['大量未闭合开标签', new Array(400).join('<think>') + '{"ideas":[]}'],
    ['大量闭合标签', new Array(400).join('</think>') + '{"ideas":[]}'],
    ['交错嵌套', '<think><thinking><think>x</think></thinking>{"ideas":[]}'],
    ['空标签对', '<think></think>{"ideas":[]}'],
    ['超长无标签文本', new Array(50000).join('x')],
  ];
  let evilOk = true;
  let evilMs = 0;
  for (const pair of evilInputs) {
    const t0 = Date.now();
    try { M.stripReasoning(pair[1]); } catch (e) { evilOk = false; }
    evilMs += Date.now() - t0;
  }
  ck('畸形思维链输入不卡死不抛错', evilOk && evilMs < 3000, evilMs + 'ms');

  // 预算边界
  ck('预算上限被 clamp 到 32768',
     M.estimateMaxTokens(999, 'deepseek-chat', 0) === 32768,
     String(M.estimateMaxTokens(999, 'deepseek-chat', 0)));
  ck('题数非法时预算不产生 NaN',
     Number.isFinite(M.estimateMaxTokens(0, 'm', 0)) &&
     Number.isFinite(M.estimateMaxTokens(undefined, 'm', 0)));
  ck('non-reasoning 变体不被误判为推理模型',
     M.isReasoningModel('grok-4-fast-non-reasoning') === false &&
     M.isReasoningModel('qwen3-32b-no-think') === false &&
     M.isReasoningModel('deepseek-reasoner') === true);

  hr('结果: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
