/* ==========================================================================
 * 选题决策助手 · 选题核查层（verifyIdeas）
 *
 * 定位：面向普通本科生的科研选题决策助手，本文件负责其中的【事实核查】环节。
 *
 * 职责边界（这是整个产品可信度的根基，不得越界）：
 *   LLM   负责「想出题目」        —— 语义合理性，模型强项
 *   本层  负责「核实能不能做」    —— 文献计数与条件匹配，模型不可靠
 *
 * 为什么必须有本层：模型对"这个题目有没有人做过"完全不可靠，它会自信地说
 * "这个方向较少研究"而拿不出任何依据。本层把该判断换成可复核的真实计数。
 *
 * 为什么不能只有本层：实测机械组合生成的题目大量是胡说
 * （如「基于可重构智能表面的PCB缺陷检测」），语义合理性只能靠 LLM。
 *
 * 与旧版 scan() 的区别：
 *   scan()        输入一个方向，扫 44 个技术角度 -> 89 次查询，本科生看不懂输出
 *   verifyIdeas() 输入 N 个具体题目，每题 2 次查询 -> 5 题仅 10 次查询
 *   额度从"一天 11 次咨询"变成"一天约 100 次"。
 * ========================================================================== */
'use strict';

/* ---------------------------------------------------------------- 饱和度分级
 * 用本科生能懂的话表述，而不是 MFR 比值。
 * 分档依据 eval/M0-report.md 的结论：本科生的最优区不是绝对空白
 * （0 篇没有 baseline、没人指路、可能是死路），而是"有少量前人可参考但未做透"。
 */
const SATURATION_LEVELS = [
  { max: 0,    key: 'empty',    label: '几乎无人做过',
    forUndergrad: 'risky',
    note: '完全没有专门研究。听起来诱人，但对本科生风险最高：没有可参考的做法，也可能是前人试过发现走不通。除非导师明确支持，否则不建议作为毕设首选。' },
  { max: 2,    key: 'frontier', label: '仅有极少先驱',
    forUndergrad: 'caution',
    note: '只有 1~2 篇论文。可以精读这几篇看别人怎么做，但缺乏成熟方法可循，需要较强自学能力。' },
  { max: 25,   key: 'sweet',    label: '有前人可参考且未做透',
    forUndergrad: 'best',
    note: '既有足够文献可以照着学（不会无从下手），又没被做烂（还有改进空间）。这是本科生最理想的区间。' },
  { max: 120,  key: 'crowded',  label: '已有较多研究',
    forUndergrad: 'ok',
    note: '常规做法已被覆盖。可以做，但需要找一个更细的切入点，否则容易和别人重复。' },
  { max: Infinity, key: 'red',  label: '非常成熟·容易撞车',
    forUndergrad: 'avoid',
    note: '大量论文已做透。除非你有独特的数据或硬件条件，否则很难做出增量，答辩时容易被问住。' },
];

function gradeSaturation(focusCount) {
  for (const lv of SATURATION_LEVELS) if (focusCount <= lv.max) return lv;
  return SATURATION_LEVELS[SATURATION_LEVELS.length - 1];
}

/* ---------------------------------------------------------------- 条件匹配
 * 硬条件冲突检测。这是"敢说这题你别做"的唯一合法依据 ——
 * 只陈述可枚举的条件冲突，绝不对研究价值本身下判决。
 */
const CONDITION_RULES = [
  {
    id: 'gpu',
    test: (need, has) => need.gpu === 'multi' && has.gpu !== 'multi',
    level: 'blocker',
    msg: n => '需要多卡GPU训练，你填的算力条件达不到。可改用轻量模型或调用现成预训练模型。',
  },
  {
    id: 'gpu-single',
    test: (need, has) => need.gpu === 'single' && has.gpu === 'none',
    level: 'warning',
    msg: n => '需要至少一张消费级GPU，你填的是无GPU。可考虑用云平台免费额度（如 Colab / 阿里云学生机）或换用不需训练的方案。',
  },
  {
    id: 'dataset-collect',
    test: (need, has) => need.dataset === 'self-collect' && has.dataset === 'none',
    level: 'blocker',
    msg: n => '需要自己采集并标注数据，而你没有采集条件。这类题目在一学期内极难完成，建议换用有公开数据集的方向。',
  },
  {
    id: 'dataset-private',
    test: (need, has) => need.dataset === 'private' && has.dataset !== 'private',
    level: 'blocker',
    msg: n => '依赖医院/企业等非公开数据，你没有这类数据渠道。没有数据这题无法开工。',
  },
  {
    id: 'weeks',
    test: (need, has) => Number(need.weeks) > Number(has.weeks || 0),
    level: 'blocker',
    msg: n => '预计需要约 ' + n.weeks + ' 周，超出你可投入的时间。可缩小范围（如只做其中一个子问题）。',
  },
  {
    id: 'skill',
    test: (need, has) => need.codingLevel === 'strong' && has.codingLevel === 'beginner',
    level: 'warning',
    msg: n => '需要较强编程能力，你填的是入门水平。建议先做一个有完整开源实现可复现的题目。',
  },
];

function matchConditions(needs, conditions) {
  const need = needs || {};
  const has = conditions || {};
  const conflicts = [];
  for (const rule of CONDITION_RULES) {
    try {
      if (rule.test(need, has)) {
        conflicts.push({ id: rule.id, level: rule.level, message: rule.msg(need) });
      }
    } catch (e) { /* 条件缺失时跳过该规则，不阻断 */ }
  }
  const blockers = conflicts.filter(c => c.level === 'blocker');
  const warnings = conflicts.filter(c => c.level === 'warning');
  let verdict = 'go';
  if (blockers.length) verdict = 'no-go';
  else if (warnings.length) verdict = 'conditional';
  return { verdict, conflicts, blockers, warnings };
}

/* ---------------------------------------------------------------- 核查主流程 */

/**
 * 核查一批候选选题。
 *
 * @param {Object} screener  createScreener() 返回的引擎实例（提供 query/fetchPaperList 等）
 * @param {Array}  ideas     候选选题，每项：
 *        { zh, objectEn, methodEn?, needs?:{gpu,dataset,weeks,codingLevel}, rationale? }
 *        objectEn = 研究对象英文规范术语；methodEn = 技术手段（可空，空则只查对象）
 * @param {Object} opts      { conditions, onProgress, concurrency }
 */
async function verifyIdeas(screener, ideas, opts) {
  const o = opts || {};
  const conditions = o.conditions || {};
  const list = (ideas || []).filter(x => x && x.objectEn);
  const results = [];
  let done = 0;

  const limit = Math.max(1, Math.min(o.concurrency || 3, list.length || 1));
  let idx = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (idx < list.length) {
      const i = idx++;
      const idea = list[i];
      results[i] = await verifyOne(screener, idea, conditions);
      done += 1;
      if (o.onProgress) o.onProgress({ done, total: list.length, current: idea });
    }
  }));

  const ok = results.filter(r => r && !r.error);
  // 排序：先按本科生适配（可做的在前），再按饱和度最优区，再按文献量
  const fitRank = { go: 0, conditional: 1, 'no-go': 2 };
  const satRank = { sweet: 0, frontier: 1, crowded: 2, empty: 3, red: 4 };
  ok.sort((a, b) => {
    const f = fitRank[a.fitness.verdict] - fitRank[b.fitness.verdict];
    if (f) return f;
    const s = satRank[a.saturation.key] - satRank[b.saturation.key];
    if (s) return s;
    return b.saturation.focusCount - a.saturation.focusCount;
  });

  return {
    ok: true,
    conditions,
    ideas: ok,
    failed: results.filter(r => r && r.error),
    isComplete: results.every(r => r && !r.error),
    queriesRun: results.filter(Boolean).length * 2,
    recommended: ok.filter(r => r.fitness.verdict === 'go' &&
                                 ['sweet', 'crowded'].includes(r.saturation.key)).slice(0, 3),
    disclaimer: [
      '文献数量是 OpenAlex 实测结果，可点开逐篇核对；「需要什么条件」「预计周期」是估计值，仅供参考。',
      '「几乎无人做过」不等于有价值 —— 也可能是前人试过发现走不通。',
      '「非常成熟」不等于你不能做 —— 若导师有独特思路或你有特殊数据，仍然可行。',
      '只统计 OpenAlex 收录的英文文献，中文期刊与专利不在计数内，实际研究量可能更多。',
      '最终选题请务必与导师确认，本工具只做初筛。',
    ],
  };
}

async function verifyOne(screener, idea, conditions) {
  const objectEn = String(idea.objectEn || '').trim();
  const methodEn = String(idea.methodEn || '').trim();
  // 双短语：有技术手段就查组合，否则只查研究对象
  const ph = methodEn
    ? '"' + objectEn + '" "' + methodEn + '"'
    : '"' + objectEn + '"';

  const f = await screener.query('title_and_abstract', ph);
  const m = await screener.query('fulltext', ph);

  if (f.count === null || m.count === null) {
    return {
      error: f.error || m.error || 'query_failed',
      zh: idea.zh, objectEn, methodEn, phrase: ph,
    };
  }

  const level = gradeSaturation(f.count);
  const fitness = matchConditions(idea.needs, conditions);
  const webUrls = screener.buildWebSearchURLs(ph);

  return {
    zh: idea.zh || (methodEn ? objectEn + ' + ' + methodEn : objectEn),
    objectEn, methodEn, phrase: ph,
    rationale: idea.rationale || null,        // LLM 给的"为什么推荐"，标注为推断
    needs: idea.needs || null,                // LLM 估计的条件需求，标注为推断
    saturation: {                             // 🔵 实测
      focusCount: f.count,                    // 专门以此为主题的论文数
      mentionCount: m.count,                  // 领域内正文提及数
      key: level.key,
      label: level.label,
      forUndergrad: level.forUndergrad,
      note: level.note,
      byYear: f.byYear,
      evidence: {
        focusUrl: f.url, focusListUrl: f.listUrl, focusAt: f.at,
        mentionUrl: m.url, mentionListUrl: m.listUrl, mentionAt: m.at,
        webUrls,
      },
    },
    fitness,                                  // 🔵 规则判定
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    verifyIdeas, verifyOne, gradeSaturation, matchConditions,
    SATURATION_LEVELS, CONDITION_RULES,
  };
}
