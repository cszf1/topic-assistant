#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
选题体检站 · 双口径扫描验证脚本
PLAN.md 里所有实测数字都由本脚本产生，可直接复现。

用法:
    python probe/scan.py --list                          # 列出词典覆盖的学科
    python probe/scan.py "PCB defect detection"          # 全学科词典(宁全勿精)
    python probe/scan.py "gut microbiome depression" --discipline 医学
    python probe/scan.py "perovskite solar cell stability" --discipline 材料 --top 8
    python probe/scan.py "social media polarization" --discipline 社科 --no-general
    python probe/scan.py "PCB defect detection" --anchor      # 加领域锚(诊断用,实测冗余)

核心机制 (MFR = 提及/专研比):
    MFR = 锚定提及数 / 专研数
        分子 title_and_abstract.search -> 真正以此为主题的论文
        分母 fulltext.search + primary_topic 锚 -> 领域内提及该概念的论文
    低 MFR -> 已被正面攻克(红海)
    高 MFR -> 领域反复提及却无人正面做(候选空位)
    专研0 + 锚定提及多 -> 绝对空白但相关性已背书
    专研0 + 锚定提及少 -> 无意义组合(含模型幻觉术语,自动过滤)

四条硬约束(全部由实测得出,见 PLAN.md):
    1. MFR 阈值严禁跨方向/跨学科硬编码 -> 只做方向内相对排序
       实测: 社科红海 168x > 材料空位 69x
    2. method 类角度不进空位榜 -> 方法类词汇的提及数是背景噪声
       实测: 社科 x meta-analysis = 899x 是假空位
    3. 与主方向词重叠的角度必须剔除 -> 否则 MFR 自反退化
       实测: PCB defect detection x defect detection = 主方向自身
    4. 分母必须加 primary_topic 领域锚 -> 否则混入领域外文献
       实测: 教育方向的分母里有 "AI in cancer detection" 141 篇
    附: 专研<5 的角度标低置信,不进红海榜(MFR 由极少论文决定)

成本: 全部走 group_by 查询 = 1 credit/次 (行查询是 10 credit)
      OpenAlex 按 IP 额度: 1000 credits / 0.1 USD / ~12h
"""
import csv
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

BASE = "https://api.openalex.org/works"
DICT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         "..", "data", "angle_dict.csv")
GENERAL = "通用"                  # 跨学科通用层的 discipline 名
# 通用层含大量 ML 技术角度, 对工科合适, 对社科/人文会制造大批无关"空位"。
# 实测: 社科方向 C 组的 6 个无关项全部来自通用层(active learning/transfer
# learning/digital twin/GNN/generative model, 提及 15-134 伪装成空位)。
GENERAL_BLOCKLIST = {"社科", "法学", "传播", "语言", "教育", "心理", "管理"}
NO_GAP_CATEGORIES = {"method"}    # 不进空位榜的类别(背景噪声, PLAN 3.7)
MIN_FOCUS_FOR_CROWDED = 5         # 专研数低于此 -> 低置信, 不进红海榜(PLAN 3.9)
RETRIES = 3                       # 单查询重试次数(网络抖动会导致角度静默缺失)
QUOTE = chr(34)                   # 双引号: 短语检索, v3 的关键
GAP_MIN_MENTION = 10              # 绝对空白的最低提及数(下限, 实际取与域量的较大者)
GAP_RATIO = 0.01                  # 绝对空白阈值 = 主方向专研总量的 1% (避免跨学科硬编码)
TERM_MIN_STRICT = 100             # 主方向加引号后低于此 -> 拒绝执行(非真实术语短语)
TERM_MIN_WARN = 500               # 低于此 -> 警告样本偏少
# 自反检测的停用词: 这些通用词的重叠不构成自反(否则主方向含 learning/detection
# 就会误杀几乎所有角度 —— 实测 "machine learning for defect detection" 曾误杀 10 个)
SELF_REF_STOPWORDS = {
    "learning", "detection", "analysis", "system", "systems", "network", "networks",
    "model", "modeling", "modelling", "method", "methods", "based", "using", "data",
    "approach", "study", "research", "prediction", "classification", "recognition",
    "optimization", "design", "assessment", "evaluation", "management", "processing",
    "application", "applications", "technology", "performance", "control",
}
NL = chr(10)


# ---------------------------------------------------------------- 数据访问

def query(mode, expr, anchor=None):
    """一次原子查询。mode: title_and_abstract | fulltext

    anchor: primary_topic.id 领域锚(用 | 分隔), 修正分母的领域漂移。
    统一用 group_by=publication_year -- 1 credit 同时拿到 count 与分年趋势。
    返回 (count, by_year, query_url, fetched_at, cost_usd)
    """
    flt = mode + ".search:" + urllib.parse.quote(expr)
    if anchor:
        flt += ",primary_topic.id:" + anchor
    url = BASE + "?filter=" + flt + "&group_by=publication_year"
    last = None
    for attempt in range(RETRIES):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "topic-checkup/1.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.load(r)
                cost = float(r.headers.get("X-RateLimit-Cost-USD", 0) or 0)
            by_year = {g["key"]: g["count"] for g in data.get("group_by", [])}
            return (data["meta"]["count"], by_year, url,
                    datetime.now(timezone.utc).isoformat(timespec="seconds"), cost)
        except Exception as e:
            last = e
            if attempt < RETRIES - 1:
                time.sleep(1.5 * (attempt + 1))       # 线性退避
    print("    !! 查询失败(重试%d次) [%s] %s: %s" % (RETRIES, mode, expr, last),
          file=sys.stderr)
    return None, {}, url, None, 0.0


def get_anchors(topic, n=5):
    """取主方向的 top-n primary_topic 作为领域锚 (PLAN 3.8)。

    修正分母漂移: fulltext 全库匹配会混入领域外文献。
    返回 (anchor_str, [(name, count)], url, cost)
    """
    url = (BASE + "?filter=title_and_abstract.search:"
           + urllib.parse.quote(topic) + "&group_by=primary_topic.id")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "topic-checkup/1.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.load(r)
            cost = float(r.headers.get("X-RateLimit-Cost-USD", 0) or 0)
        top = data.get("group_by", [])[:n]
        ids = [t["key"].rsplit("/", 1)[-1] for t in top]
        names = [(t["key_display_name"], t["count"]) for t in top]
        return "|".join(ids), names, url, cost
    except Exception as e:
        print("    !! 领域锚获取失败: %s (降级为未锚定 MFR)" % e, file=sys.stderr)
        return None, [], url, 0.0


# ---------------------------------------------------------------- 词典

def _read_dict():
    """读词典并剔除 # 注释行。"""
    with open(DICT_PATH, encoding="utf-8") as f:
        return [r for r in csv.DictReader(f)
                if r.get("discipline")
                and not r["discipline"].lstrip().startswith("#")]


def list_disciplines():
    rows = _read_dict()
    seen = []
    for r in rows:
        if r["discipline"] not in seen:
            seen.append(r["discipline"])
    return seen, len(rows)


def tokenize(s):
    """粗分词: 小写 + 去非字母数字, 用于自反检测。"""
    flat = "".join(c.lower() if c.isalnum() else " " for c in s)
    return {t for t in flat.split() if len(t) > 2}


def load_angles(discipline=None, topic=None, include_general=True):
    """载入角度词典。

    discipline=None  -> 全部学科(宁全勿精, 代价是查询数多)
    include_general  -> 自动并入"通用"跨学科层
    传 topic 时剔除与主方向词重叠的角度(自反陷阱, PLAN 3.5)
    返回 (kept, dropped)
    """
    try:
        rows = _read_dict()
        if discipline:
            want = {discipline}
            if include_general and discipline not in GENERAL_BLOCKLIST:
                want.add(GENERAL)
            elif include_general:
                print("  提示: %s 学科默认不并入通用层(其 ML 技术角度会制造无关空位),"
                      " 需要可加 --force-general" % discipline, file=sys.stderr)
            rows = [r for r in rows if r["discipline"] in want]
        angles, seen = [], set()
        for r in rows:                      # 去重(不同学科可能收同一角度)
            key = r["angle_en"].lower()
            if key not in seen:
                seen.add(key)
                angles.append((r["angle_en"], r["angle_zh"], r["category"]))
    except FileNotFoundError:
        print("角度词典未找到 (%s)，使用内置精简集" % DICT_PATH, file=sys.stderr)
        angles = [(a, a, "?") for a in
                  ["few-shot", "self-supervised", "transformer", "diffusion model",
                   "domain adaptation", "contrastive learning", "lightweight",
                   "graph neural network", "federated learning", "multimodal"]]

    if not topic:
        return angles, []
    tt = tokenize(topic)
    kept, dropped = [], []
    for en, zh, cat in angles:
        at = tokenize(en)
        # 只有角度词集"完全被主方向包含"才算自反(子集判定)。
        # 旧实现用交集非空, 会因 learning/detection 这类通用词大面积误杀。
        if at and at <= tt:
            dropped.append((en, zh, cat, sorted(at)))
            continue
        # 去掉停用词后仍被完全包含, 也算自反(如 "defect detection" vs 主方向)
        core = at - SELF_REF_STOPWORDS
        if core and core <= tt:
            dropped.append((en, zh, cat, sorted(core)))
        else:
            kept.append((en, zh, cat))
    return kept, dropped


# ---------------------------------------------------------------- 扫描

def scan(topic, top_n=6, sleep=0.08, discipline=None, include_general=True,
         use_anchor=False):
    angles, dropped = load_angles(discipline, topic, include_general)
    total_cost = 0.0

    if any(ch >= chr(0x4e00) and ch <= chr(0x9fff) for ch in topic):
        print("  !! 主方向含中文。OpenAlex 以英文文献为主, 中文检索词命中率极低,"
              " 请改用英文检索词。", file=sys.stderr)

    anchor, anchor_names, anchor_url = None, [], None
    if use_anchor:
        anchor, anchor_names, anchor_url, ac = get_anchors(topic)
        total_cost += ac

    t_focus, t_by_year, t_url, t_at, c = query("title_and_abstract", QUOTE + topic + QUOTE)
    total_cost += c

    # === 主方向术语性校验: v3 的前置条件 ===
    # 双短语口径要求主方向是真实存在的术语短语。多概念拼接会让结果整体归零。
    # 实测: "social media adolescent mental health" 加引号仅 9 篇(无引号 5506),
    #       "gut microbiome depression" 仅 8 篇(无引号 2417) —— v1/v2 掩盖了这一点。
    if t_focus is not None and t_focus < TERM_MIN_STRICT:
        print(NL + "!" * 78)
        print("主方向术语性校验未通过: %s 加引号后仅 %d 篇" % (topic, t_focus))
        print("这很可能不是一个规范的领域术语, 而是多个概念的拼接。")
        print("双短语口径下会导致几乎所有角度落入'无意义组合', 结果不可用。")
        print("建议: 逐步截短主方向再试, 例如")
        parts = topic.split()
        for k in range(len(parts) - 1, 1, -1):
            print("   - " + " ".join(parts[len(parts) - k:]))
        print("或改用该领域公认的规范术语(如 cyberbullying / gut brain axis)。")
        print("!" * 78)
        return dict(topic=topic, focus_total=t_focus, topic_query=t_url,
                    fetched_at=t_at, term_check="failed", angles=[],
                    is_complete=False)
    if t_focus is not None and t_focus < TERM_MIN_WARN:
        print("  !! 主方向加引号后仅 %d 篇(建议 >=%d): 样本偏少, 只看分类不要看对比"
              % (t_focus, TERM_MIN_WARN), file=sys.stderr)

    print(NL + "=" * 78)
    print("主方向: " + topic)
    tag_gen = " + 通用层" if (discipline and include_general) else ""
    print("  学科词典: %s%s   角度数: %d"
          % (discipline or "全部学科", tag_gen, len(angles)))
    print("  专研总量(标题+摘要): %s" % t_focus)
    if t_by_year:
        yrs = ("2020", "2021", "2022", "2023", "2024", "2025")
        print("  近年趋势: " + " -> ".join("%s:%d" % (y, t_by_year.get(y, 0)) for y in yrs))
    print("  证据: " + t_url)
    print("  抓取: %s" % t_at)
    if anchor_names:
        print("  领域锚(修正分母漂移): " + anchor)
        for nm, ct in anchor_names:
            print("    - %s (%d)" % (nm, ct))
    elif use_anchor:
        print("  !! 领域锚不可用，本次为未锚定 MFR(结论偏乐观，见 PLAN 3.8)")
    if dropped:
        # 不静默丢弃 -- 否则用户以为漏了
        print("  已剔除 %d 个自反角度(与主方向词重叠 -> MFR 无意义):" % len(dropped))
        for en, zh, cat, ov in dropped[:6]:
            print("    - %s (%s)  重叠词: %s" % (zh, en, ", ".join(ov)))
        if len(dropped) > 6:
            print("    ... 及其他 %d 个" % (len(dropped) - 6))
    print("=" * 78)

    rows, failed = [], []
    for idx, (en, zh, cat) in enumerate(angles, 1):
        # v3: 双短语 AND —— 主方向与角度各自加引号, 消除 token-AND 散射噪声。
        # 旧版无引号会让 "PCB defect detection semantic communication" 退化为
        # 「正文含 {PCB,defect,detection,semantic,communication}」, 制造大批假空位。
        expr = QUOTE + topic + QUOTE + " " + QUOTE + en + QUOTE
        focus, f_by, f_url, f_at, c1 = query("title_and_abstract", expr)
        mention, m_by, m_url, m_at, c2 = query("fulltext", expr)
        total_cost += c1 + c2
        if focus is None or mention is None:
            failed.append((zh, "分子/分母查询失败"))
            continue
        anchored, a_url, anchor_failed = mention, m_url, False
        if anchor:
            av, _, a_url, _, c3 = query("fulltext", expr, anchor=anchor)
            total_cost += c3
            if av is None:
                # 关键: 不能静默回退到未锚定值 —— 那会让 MFR 虚高约 10 倍,
                # 把该角度错排到"候选空位"榜首。标记为不可用并跳过。
                anchor_failed = True
                print("    !! %s: 锚定查询失败, 该角度作废(不混用口径)" % zh,
                      file=sys.stderr)
            else:
                anchored = av
        if anchor_failed:
            failed.append((zh, "锚定查询失败"))
            continue
        # 相对阈值: 随方向体量缩放, 修正"跨学科硬编码阈值"的自相矛盾
        gap_thr = max(GAP_MIN_MENTION, int((t_focus or 0) * GAP_RATIO))
        if focus == 0:
            mfr = None
            tag = ("绝对空白·相关性已背书" if anchored >= gap_thr
                   else "无意义组合/术语不存在·剔除")
        elif anchored == 0:
            mfr, tag = 0.0, "领域内零提及·锚可能不准"
        else:
            mfr, tag = float(anchored) / focus, ""
        rows.append(dict(angle_en=en, angle_zh=zh, category=cat,
                         focus_count=focus, mention_count=mention,
                         mention_anchored=anchored, mfr=mfr,
                         mfr_raw=(float(mention) / focus) if focus else None,
                         # method 类不得进绝对空白: 必须在【计算时】排除, 只在展示层
                         # 拦会让 JSON 仍标 true (实测 bearing 的 meta-analysis、
                         # 社科的 ethnography 都这么漏出来)
                         is_absolute_gap=(focus == 0 and anchored >= gap_thr
                                          and cat not in NO_GAP_CATEGORIES),
                         low_confidence=(0 < focus < MIN_FOCUS_FOR_CROWDED),
                         tag=tag, focus_query=f_url, mention_query=m_url,
                         mention_anchored_query=a_url, fetched_at=f_at))
        ms = ("%8.0fx" % mfr) if mfr is not None else "       ∞"
        flag = " *method" if cat in NO_GAP_CATEGORIES else ""
        print("  [%3d/%d] %-20s 专研%6d 提及%7d %s%s  %s"
              % (idx, len(angles), zh, focus, anchored, ms, flag, tag))
        time.sleep(sleep)

    # 方向内相对排序 -- method 类隔离, 低置信隔离
    scored = [r for r in rows if r["mfr"] is not None]
    tech = [r for r in scored if r["category"] not in NO_GAP_CATEGORIES]
    meth = [r for r in scored if r["category"] in NO_GAP_CATEGORIES]
    tech.sort(key=lambda r: -r["mfr"])
    n = len(tech)
    for i, r in enumerate(tech):
        r["percentile_in_topic"] = round(100 * (1 - float(i) / n), 1) if n else None
    solid = [r for r in tech if r["focus_count"] >= MIN_FOCUS_FOR_CROWDED]
    weak = [r for r in tech if r["focus_count"] < MIN_FOCUS_FOR_CROWDED]

    print(NL + "-" * 78)
    print("■ 候选空位 (方向内 MFR 最高 %d 项 · 已排除 method 类 · 阈值不可跨方向比较)" % top_n)
    for r in tech[:top_n]:
        lc = " [低置信]" if r["low_confidence"] else ""
        print("    %-20s 专研%6d 提及%7d %7.0fx  [%s] 分位%s%s"
              % (r["angle_zh"], r["focus_count"], r["mention_anchored"],
                 r["mfr"], r["category"], r["percentile_in_topic"], lc))

    gaps = [r for r in rows if r["is_absolute_gap"]]        # 计算时已排除 method
    gaps_method = [r for r in rows
                   if r["mfr"] is None and r["category"] in NO_GAP_CATEGORIES
                   and r["mention_anchored"] >= max(GAP_MIN_MENTION,
                                                    int((t_focus or 0) * GAP_RATIO))]
    if gaps:
        print(NL + "■ 绝对空白 (%d 项: 专研0 但提及>=%d[=域量的%.0f%%], 相关性已被文献背书)"
              % (len(gaps), max(GAP_MIN_MENTION, int((t_focus or 0) * GAP_RATIO)),
                 GAP_RATIO * 100))
        for r in sorted(gaps, key=lambda r: -r["mention_anchored"])[:top_n]:
            print("    %-20s 专研%6d 提及%7d       ∞  [%s]"
                  % (r["angle_zh"], r["focus_count"], r["mention_anchored"], r["category"]))

    if gaps_method:
        print(NL + "■ (method 类的绝对空白, 仅备查, 不作选题建议): %s"
              % ", ".join(r["angle_zh"] for r in gaps_method))

    junk = [r for r in rows if r["mfr"] is None and not r["is_absolute_gap"]]
    if junk:
        print(NL + "■ 已过滤 %d 项无意义组合(专研0且提及不足, 含术语不存在): %s"
              % (len(junk), ", ".join(r["angle_zh"] for r in junk[:8])))

    if weak:
        names = ", ".join("%s(%d篇)" % (r["angle_zh"], r["focus_count"]) for r in weak[:8])
        print(NL + "■ 低置信 %d 项 (专研<%d, MFR 由极少论文决定, 仅作线索): %s"
              % (len(weak), MIN_FOCUS_FOR_CROWDED, names))

    print(NL + "■ 红海 (方向内 MFR 最低 3 项 · 已排除低置信项)")
    for r in solid[-3:][::-1]:
        print("    %-20s 专研%6d 提及%7d %7.1fx  [%s] %s"
              % (r["angle_zh"], r["focus_count"], r["mention_anchored"],
                 r["mfr"], r["category"], r["tag"]))

    if meth:
        print(NL + "■ method 类(单独看, MFR 偏高含背景噪声, 不代表空位)")
        for r in sorted(meth, key=lambda r: -r["mfr"])[:3]:
            print("    %-20s 专研%6d 提及%7d %7.0fx"
                  % (r["angle_zh"], r["focus_count"], r["mention_anchored"], r["mfr"]))

    if solid:
        lo, hi = solid[-1]["mfr"], solid[0]["mfr"]
        if lo > 0:
            print(NL + "  >> 方向内区分跨度: %.0fx ~ %.0fx = %.0f 倍" % (lo, hi, hi / lo))
    per = 3 if anchor else 2
    print("  >> 本次成本: $%.4f   查询数: %d   口径: %s"
          % (total_cost, 1 + (1 if anchor else 0) + per * len(rows),
             "锚定 MFR" if anchor else "未锚定 MFR"))
    print("-" * 78)
    if failed:
        # 铁律: 不完整的扫描必须显式告知, 否则用户会把残缺结果当全量
        print("  !! 本次扫描不完整: %d/%d 个角度查询失败, 下列角度缺席排名 ——"
              % (len(failed), len(angles)))
        for zh, why in failed[:10]:
            print("     - %s (%s)" % (zh, why))
        print("     结论仅基于成功的 %d 个角度, 请重跑补齐后再据此决策。"
              % len(rows))
    print("  候选空位是提示，不是新颖性保证。投入前须自行核实原创性。")
    print("  高 MFR 只说明「被提及多而被专研少」，不能证明该方向有研究价值。")
    print("  红海判定同样可能出错且代价更大(会劝退真金矿): 本判定仅基于 OpenAlex")
    print("  英文文献计数, 若有导师认可的切入点, 不应因此放弃。")
    print("  分位是相对本次词典的 N 个角度, 不是领域内分位。")

    return dict(topic=topic, discipline=discipline, focus_total=t_focus,
                topic_query=t_url, by_year=t_by_year, fetched_at=t_at,
                anchor_topic_ids=anchor, anchor_topics=anchor_names,
                anchor_query=anchor_url, angles=rows,
                failed_angles=[dict(angle_zh=z, reason=w) for z, w in failed],
                is_complete=(len(failed) == 0),
                dropped_self_referential=[
                    dict(angle_en=en, angle_zh=zh, category=cat, overlap=ov)
                    for en, zh, cat, ov in dropped])


# ---------------------------------------------------------------- CLI

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    if sys.argv[1] == "--list":
        ds, total = list_disciplines()
        print("词典共 %d 个角度，覆盖 %d 个学科分组:" % (total, len(ds)))
        for d in ds:
            print("    " + d)
        demo = ds[1] if len(ds) > 1 else ds[0]
        print(NL + '用法: python probe/scan.py "你的方向" --discipline ' + demo)
        sys.exit(0)

    topic = sys.argv[1]
    top_n = int(sys.argv[sys.argv.index("--top") + 1]) if "--top" in sys.argv else 6
    disc = (sys.argv[sys.argv.index("--discipline") + 1]
            if "--discipline" in sys.argv else None)
    inc_gen = "--no-general" not in sys.argv
    if "--force-general" in sys.argv:
        GENERAL_BLOCKLIST = set()
    # v3: 双短语已限定领域, 实测加锚仅让分母缩 20-40% 且排序不变 -> 锚默认关闭
    use_anchor = "--anchor" in sys.argv

    result = scan(topic, top_n=top_n, discipline=disc,
                  include_general=inc_gen, use_anchor=use_anchor)

    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "out")
    os.makedirs(out_dir, exist_ok=True)
    safe = "".join(ch if ch.isalnum() or ch in " -_" else "_" for ch in topic)
    path = os.path.join(out_dir, safe.strip().replace(" ", "_") + ".json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(NL + "完整证据(含每条查询串+时间戳)已落盘: " + os.path.normpath(path))
