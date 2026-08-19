/* 选题核查层测试（mock fetch，零额度消耗）
 * 用法: node test/verify-test.js
 */
'use strict';
const path = require('path');
const { ANGLE_DICT } = require(path.join(__dirname, '..', 'web', 'angles.js'));
const { createScreener } = require(path.join(__dirname, '..', 'web', 'engine.js'));
const { verifyIdeas, gradeSaturation, matchConditions } =
  require(path.join(__dirname, '..', 'web', 'verify.js'));

let pass = 0, fail = 0;
const ck = (n, c, e) => { if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (e ? '  -> ' + e : '')); } };
const hr = t => console.log('\n' + '='.repeat(72) + '\n' + t + '\n' + '='.repeat(72));

/* mock：按题目返回不同文献量，覆盖全部饱和度档位 */
const COUNTS = {
  '"PCB defect detection" "graph neural network"': { f: 0,   m: 21 },   // empty
  '"PCB defect detection" "digital twin"':         { f: 2,   m: 33 },   // frontier
  '"PCB defect detection" "few-shot learning"':    { f: 18,  m: 98 },   // sweet
  '"PCB defect detection" "transfer learning"':    { f: 80,  m: 202 },  // crowded
  '"PCB defect detection" "deep learning"':        { f: 900, m: 2000 }, // red
  '"medical image segmentation" "diffusion model"':{ f: 12,  m: 150 },  // sweet
};
function mockFetch(url) {
  const dec = decodeURIComponent(String(url));
  const m = dec.match(/search:((?:"[^"]*"\s*)+)/);
  const key = m ? m[1].trim() : '';
  const c = COUNTS[key] || { f: 5, m: 40 };
  const n = dec.includes('fulltext.search') ? c.m : c.f;
  if (dec.includes('per-page=')) {
    return Promise.resolve(json({ meta: { count: n }, results: [
      { id: 'https://openalex.org/W1', display_name: 'Mock Paper', publication_year: 2024,
        cited_by_count: 7, doi: 'https://doi.org/10.1/x',
        primary_topic: { display_name: 'Mock Topic' } }] }));
  }
  return Promise.resolve(json({ meta: { count: n }, group_by: [
    { key: '2025', key_display_name: '2025', count: Math.round(n * 0.3) },
    { key: '2024', key_display_name: '2024', count: Math.round(n * 0.25) }] }));
  function json(b) { return { ok: true, status: 200,
    headers: { get: () => '999' }, json: async () => b }; }
}

const S = createScreener({ angleDict: ANGLE_DICT, fetchImpl: mockFetch });

(async () => {
  hr('1. 饱和度分级（用本科生能懂的话，且最优区不是绝对空白）');
  ck('0 篇 -> 几乎无人做过 / risky（不推荐首选）',
     gradeSaturation(0).key === 'empty' && gradeSaturation(0).forUndergrad === 'risky');
  ck('2 篇 -> 仅有极少先驱 / caution', gradeSaturation(2).key === 'frontier');
  ck('18 篇 -> 有前人可参考且未做透 / best（本科生最优区）',
     gradeSaturation(18).key === 'sweet' && gradeSaturation(18).forUndergrad === 'best');
  ck('80 篇 -> 已有较多研究 / ok', gradeSaturation(80).key === 'crowded');
  ck('900 篇 -> 非常成熟·容易撞车 / avoid',
     gradeSaturation(900).key === 'red' && gradeSaturation(900).forUndergrad === 'avoid');

  hr('2. 硬条件冲突（这是"敢说别做"的唯一合法依据）');
  const noGpu = { gpu: 'none', dataset: 'public', weeks: 16, codingLevel: 'mid' };
  ck('需多卡但无GPU -> no-go',
     matchConditions({ gpu: 'multi', weeks: 10 }, noGpu).verdict === 'no-go');
  ck('需单卡但无GPU -> conditional（给替代方案，不直接否决）',
     matchConditions({ gpu: 'single', weeks: 10 }, noGpu).verdict === 'conditional');
  ck('需自采数据但无采集条件 -> no-go',
     matchConditions({ dataset: 'self-collect', weeks: 10 },
       { ...noGpu, dataset: 'none' }).verdict === 'no-go');
  ck('周期 24 周 > 可投入 16 周 -> no-go',
     matchConditions({ weeks: 24 }, noGpu).verdict === 'no-go');
  ck('条件都满足 -> go',
     matchConditions({ gpu: 'none', dataset: 'public', weeks: 12 }, noGpu).verdict === 'go');
  const c = matchConditions({ gpu: 'multi', weeks: 30 }, noGpu);
  ck('冲突项带可操作的中文说明', c.conflicts.every(x => x.message && x.message.length > 8));
  ck('多个 blocker 全部列出而非只报一个', c.blockers.length === 2, String(c.blockers.length));

  hr('3. verifyIdeas 全流程');
  const ideas = [
    { zh: '基于图神经网络的PCB缺陷检测', objectEn: 'PCB defect detection',
      methodEn: 'graph neural network',
      needs: { gpu: 'single', dataset: 'public', weeks: 14, codingLevel: 'mid' },
      rationale: 'PCB 是电路拓扑，天然适合图结构建模' },
    { zh: '基于小样本学习的PCB缺陷检测', objectEn: 'PCB defect detection',
      methodEn: 'few-shot learning',
      needs: { gpu: 'none', dataset: 'public', weeks: 12, codingLevel: 'mid' },
      rationale: '缺陷样本天然稀少，小样本学习贴合真实痛点' },
    { zh: '基于迁移学习的PCB缺陷检测', objectEn: 'PCB defect detection',
      methodEn: 'transfer learning',
      needs: { gpu: 'none', dataset: 'public', weeks: 10, codingLevel: 'beginner' } },
    { zh: '基于深度学习的PCB缺陷检测', objectEn: 'PCB defect detection',
      methodEn: 'deep learning',
      needs: { gpu: 'multi', dataset: 'public', weeks: 20, codingLevel: 'strong' } },
    { zh: '基于扩散模型的医学图像分割', objectEn: 'medical image segmentation',
      methodEn: 'diffusion model',
      needs: { gpu: 'multi', dataset: 'private', weeks: 30, codingLevel: 'strong' } },
  ];
  const conds = { gpu: 'none', dataset: 'public', weeks: 16, codingLevel: 'mid' };

  let ticks = 0;
  const r = await verifyIdeas(S, ideas, { conditions: conds, onProgress: () => ticks++ });

  ck('返回 ok', r.ok === true);
  ck('进度回调被调用 5 次', ticks === 5, String(ticks));
  ck('每题仅 2 次查询（5题=10次，而非旧版89次）', r.queriesRun === 10, String(r.queriesRun));
  ck('全部核查成功', r.isComplete === true && r.ideas.length === 5);

  const byZh = {};
  r.ideas.forEach(x => { byZh[x.zh] = x; });

  ck('图神经网络题 -> 0篇 判为 empty/risky',
     byZh['基于图神经网络的PCB缺陷检测'].saturation.key === 'empty');
  ck('小样本题 -> 18篇 判为 sweet（最优区）',
     byZh['基于小样本学习的PCB缺陷检测'].saturation.key === 'sweet');
  ck('深度学习题 -> 900篇 判为 red 且因需多卡GPU被 no-go',
     byZh['基于深度学习的PCB缺陷检测'].saturation.key === 'red' &&
     byZh['基于深度学习的PCB缺陷检测'].fitness.verdict === 'no-go');
  ck('医学题 -> 需私有数据+30周+多卡，三重冲突 no-go',
     byZh['基于扩散模型的医学图像分割'].fitness.blockers.length === 3,
     String(byZh['基于扩散模型的医学图像分割'].fitness.blockers.length));

  ck('每题都带可复现证据（查询串+论文列表+外链）',
     r.ideas.every(x => x.saturation.evidence.focusUrl &&
                        x.saturation.evidence.focusListUrl.includes('per-page') &&
                        x.saturation.evidence.webUrls.googleScholar));
  ck('LLM 给的 rationale/needs 原样保留（供界面标注为推断）',
     byZh['基于小样本学习的PCB缺陷检测'].rationale.includes('样本') &&
     byZh['基于小样本学习的PCB缺陷检测'].needs.weeks === 12);

  hr('4. 排序与推荐');
  console.log('  排序结果：');
  r.ideas.forEach((x, i) => console.log(
    '    ' + (i + 1) + '. [' + (x.fitness.verdict + '/' + x.saturation.key).padEnd(20) + '] ' +
    x.zh.padEnd(26) + ' 专研' + String(x.saturation.focusCount).padStart(4) + ' 篇  ' +
    x.saturation.label));
  ck('可做的（go）排在 no-go 之前',
     r.ideas.findIndex(x => x.fitness.verdict === 'no-go') >
     r.ideas.findIndex(x => x.fitness.verdict === 'go'));
  ck('推荐位只给 go + 最优区，且 ≤3 个',
     r.recommended.length <= 3 &&
     r.recommended.every(x => x.fitness.verdict === 'go' &&
                              ['sweet', 'crowded'].includes(x.saturation.key)),
     r.recommended.map(x => x.zh).join(','));
  console.log('  最终推荐：' + (r.recommended.map(x => x.zh).join(' / ') || '无'));

  ck('免责含「无人做过≠有价值」与「成熟≠不能做」双侧',
     r.disclaimer.some(s => s.includes('不等于有价值')) &&
     r.disclaimer.some(s => s.includes('不等于你不能做')));
  ck('免责提示需与导师确认', r.disclaimer.some(s => s.includes('导师')));

  hr('5. 查询失败不谎称完整');
  const Sf = createScreener({ angleDict: ANGLE_DICT, retries: 1, retryBaseDelay: 1,
    fetchImpl: u => decodeURIComponent(String(u)).includes('few-shot')
      ? Promise.resolve({ ok: false, status: 500, headers: { get: () => null } })
      : mockFetch(u) });
  const rf = await verifyIdeas(Sf, ideas, { conditions: conds });
  ck('失败题目进 failed 且 isComplete=false',
     rf.isComplete === false && rf.failed.length === 1 &&
     rf.failed[0].zh.includes('小样本'));
  ck('失败题目不出现在结果列表', !rf.ideas.some(x => x.zh.includes('小样本')));

  hr('结果: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
