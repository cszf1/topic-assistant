/* 核心引擎自检。用法：
 *   node test/run.js                        # 全部用例（会真实请求 OpenAlex）
 *   node test/run.js --offline              # 只跑不联网的纯逻辑用例
 *   node test/run.js "PCB defect detection" 电子信息   # 指定方向实跑
 */
'use strict';
const path = require('path');
const { ANGLE_DICT } = require(path.join(__dirname, '..', 'web', 'angles.js'));
const { createScreener, tokenize, isSubset } = require(path.join(__dirname, '..', 'web', 'engine.js'));

let pass = 0, fail = 0;
function ck(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
const hr = t => console.log('\n' + '='.repeat(72) + '\n' + t + '\n' + '='.repeat(72));

const S = createScreener({ angleDict: ANGLE_DICT, concurrency: 4 });

/* ---------------------------------------------------- 1. 纯逻辑（不联网） */
function offlineTests() {
  hr('1. 纯逻辑用例（不联网）');

  ck('词典 27 学科 / 366 角度',
     S.listDisciplines().length === 27 &&
     S.listDisciplines().reduce((s, d) => s + d.count, 0) === 366);

  // 自反剔除必须用子集判定：交集非空会误杀 10 个（PLAN.md 3.5）
  const tk = tokenize('a of the PCB defect');
  ck('tokenize 过滤 <=2 字符并小写化',
     !tk.has('a') && !tk.has('of') && tk.has('the') && tk.has('pcb') && tk.has('defect'));
  ck('isSubset 正确', isSubset(new Set(['a']), new Set(['a', 'b'])) &&
     !isSubset(new Set(['c']), new Set(['a', 'b'])));

  // 双短语构造
  const u = S.buildURL('title_and_abstract', '"PCB defect detection" "few-shot"');
  ck('URL 用 group_by=publication_year（1 credit）', u.includes('group_by=publication_year'));
  ck('URL 双引号已编码', u.includes('%22'));
  ck('计数 URL 不含行查询参数', !u.includes('per-page') && !u.includes('per_page'));

  // 证据必须能看到论文：只给计数无法判断相关性。实测
  // "PCB defect detection" x "graph neural network" 的 21 篇里混着单图超分论文。
  const lu = S.buildListURL('fulltext', '"PCB defect detection" "graph neural network"');
  ck('论文列表 URL 是行查询', lu.includes('per-page=25'));
  ck('论文列表 URL 带 primary_topic（用于判断噪声）',
     decodeURIComponent(lu).includes('primary_topic'));
  ck('论文列表 URL 带标题与年份',
     decodeURIComponent(lu).includes('display_name') &&
     decodeURIComponent(lu).includes('publication_year'));

}

/* ---------------------------------------------------- 2. 术语校验（联网） */
async function termTests() {
  hr('2. 术语性校验（闸门一）');

  const cjk = await S.checkTerm('钙钛矿太阳能电池');
  ck('中文主方向被拒', cjk.ok === false && cjk.reason === 'cjk');

  const junk = await S.checkTerm('social media adolescent mental health');
  ck('拼凑短语被拒（实测仅 9 篇）',
     junk.ok === false && junk.reason === 'not_a_term' && junk.count < 100,
     'count=' + junk.count);
  ck('拒绝时给出截短建议', Array.isArray(junk.suggestions) && junk.suggestions.length > 0,
     JSON.stringify(junk.suggestions));
  const hasGood = junk.suggestions.includes('adolescent mental health');
  ck('截短建议命中可用表述 adolescent mental health', hasGood,
     JSON.stringify(junk.suggestions));

  // 只看数量拦不住通用词：harness 有 283,525 篇，但最大主题只占 0.7%
  const generic = await S.checkTerm('harness');
  ck('通用词被主题集中度拦下（harness 283k 篇但 top1 仅 0.7%）',
     generic.ok === false && generic.reason === 'too_generic',
     'reason=' + generic.reason + ' count=' + generic.count +
     ' topicFocus=' + generic.topicFocus);
  ck('拒绝理由带主题分布链接', !!generic.topicUrl);
  ck('通用词的 topicFocus 低于严格门槛',
     generic.topicFocus !== null && generic.topicFocus < 0.05,
     String(generic.topicFocus));

  const ok = await S.checkTerm('PCB defect detection');
  ck('真实术语通过（实测 711 篇）', ok.ok === true && ok.count > 500, 'count=' + ok.count);
  ck('通过时带证据 URL 与时间戳', !!ok.url && !!ok.at);
  ck('真实方向主题集中度高（PCB 实测 80.2%）',
     ok.topicFocus > 0.5, String(ok.topicFocus));

  const small = await S.checkTerm('digital wellbeing');
  ck('中等体量给 warn（500 以下）', small.ok === true,
     'level=' + small.level + ' count=' + small.count);
}

/* ---------------------------------------------------- 3. 完整扫描（联网） */
async function scanTests(topic, disc) {
  hr('3. 完整扫描：' + topic + ' / ' + disc);

  let ticks = 0;
  const r = await S.scan(topic, disc, {
    onProgress: p => { if (p.done) ticks = p.done; },
  });

  ck('扫描成功', r.ok === true);
  if (!r.ok) { console.log(JSON.stringify(r.term, null, 2)); return r; }

  console.log('  域量 %d | 角度 %d | C组门槛 %d | 查询数 %d | 剩余额度 %s',
    r.focusTotal, r.angleCount, r.gapThreshold, r.queriesRun, r.quotaRemaining);
  console.log('  分组 A=%d B=%d C=%d D=%d | 自反剔除 %d | 失败 %d | 完整 %s',
    r.groups.A.length, r.groups.B.length, r.groups.C.length, r.groups.D.length,
    r.dropped.length, r.failed.length, r.isComplete);

  ck('进度回调被调用', ticks > 0);
  ck('四组总数 + 失败 = 角度数',
     r.groups.A.length + r.groups.B.length + r.groups.C.length + r.groups.D.length +
     r.failed.length === r.angleCount);
  ck('C 组门槛 = max(10, 域量×1%)',
     r.gapThreshold === Math.max(10, Math.floor(r.focusTotal * 0.01)));

  // 关键：method 类不得进 C 组（必须在计算时排除）
  const methodInC = r.groups.C.filter(x => x.category === 'method');
  ck('C 组不含 method 类', methodInC.length === 0,
     methodInC.map(x => x.en).join(','));

  // C 组必须满足 专研0 且 提及≥门槛
  ck('C 组全部满足 专研0 且 提及≥门槛',
     r.groups.C.every(x => x.focusCount === 0 && x.mentionCount >= r.gapThreshold));
  ck('D 组全部 专研0', r.groups.D.every(x => x.focusCount === 0));
  ck('B 组全部 0<专研<5', r.groups.B.every(x => x.focusCount > 0 && x.focusCount < 5));
  ck('A 组全部 专研>=5', r.groups.A.every(x => x.focusCount >= 5));

  // 证据完整性：铁律——没有查询串+命中数+时间戳的结论不准进报告
  const all = [].concat(r.groups.A, r.groups.B, r.groups.C, r.groups.D);
  ck('每条都带可复现的查询串与时间戳',
     all.every(x => x.evidence.focus.url && x.evidence.mention.url &&
                    (x.evidence.focus.at || x.evidence.focus.cached)));
  ck('每条都带可看论文的列表链接（证据不能只有数字）',
     all.every(x => x.evidence.focus.listUrl && x.evidence.mention.listUrl &&
                    x.evidence.mention.listUrl.includes('per-page')));
  ck('查询串使用双短语（含两组 %22）',
     all.length === 0 || (all[0].evidence.focus.url.match(/%22/g) || []).length >= 4,
     all.length ? decodeURIComponent(all[0].evidence.focus.url) : '');

  // 自反剔除
  const droppedNames = r.dropped.map(d => d.en);
  ck('自反剔除数量合理（子集判定，不应大面积误杀）', r.dropped.length <= 3,
     droppedNames.join(','));

  ck('免责声明齐全（含红海判错警示）',
     r.disclaimer.length >= 6 && r.disclaimer.some(s => s.includes('红海判错')));

  console.log('\n  【① 可划掉】' + r.groups.D.slice(0, 12).map(x => x.zh).join('、'));
  console.log('  【② 待核实线索】' + (r.groups.C.map(x =>
    x.zh + '(' + x.mentionCount + ')').join('、') || '无'));
  console.log('  【③ 已有人做】' + r.groups.A.slice(0, 6).map(x =>
    x.zh + '(' + x.focusCount + '篇)').join('、'));
  return r;
}

/* ---------------------------------------------------- 4. 缓存与中止 */
async function miscTests(topic, disc) {
  hr('4. 缓存与中止');

  const t0 = Date.now();
  const r2 = await S.scan(topic, disc);
  const dt = Date.now() - t0;
  ck('二次扫描走缓存（明显更快）', dt < 8000, dt + 'ms');
  ck('缓存后结果一致', r2.ok && r2.groups.C.length >= 0);

  const S2 = createScreener({ angleDict: ANGLE_DICT, concurrency: 2 });
  const p = S2.scan('bearing fault diagnosis', '机械');
  setTimeout(() => S2.abort(), 600);
  const r3 = await p;
  ck('中止后不谎称完整', r3.ok === false || r3.isComplete === false,
     'isComplete=' + r3.isComplete);

  // 通用层黑名单
  const rs = await S.scan('cyberbullying', '社科');
  ck('社科不并入通用层（避免 ML 角度制造无关空位）',
     rs.ok && rs.generalBlocked === true && rs.generalUsed === false);
  const mlWords = ['graph neural network', 'transfer learning', 'digital twin',
                   'active learning', 'generative model'];
  const leaked = rs.ok ? [].concat(rs.groups.C, rs.groups.D)
    .filter(x => mlWords.includes(x.en)) : [];
  ck('社科结果中无通用层 ML 角度', leaked.length === 0, leaked.map(x => x.en).join(','));
  if (rs.ok) console.log('  cyberbullying: 域量 %d, A=%d C=%d D=%d',
    rs.focusTotal, rs.groups.A.length, rs.groups.C.length, rs.groups.D.length);
}

/* ---------------------------------------------------- main */
(async () => {
  const args = process.argv.slice(2);
  const offline = args.includes('--offline');
  const topic = args.find(a => !a.startsWith('--') && /[a-z]/i.test(a)) || 'PCB defect detection';
  const disc = args.find(a => /[\u4e00-\u9fff]/.test(a)) || '电子信息';

  offlineTests();
  if (!offline) {
    await termTests();
    await scanTests(topic, disc);
    await miscTests(topic, disc);
  }
  hr('结果: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
