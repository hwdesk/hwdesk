/*!
 * laya.js — Laya 决策引擎（hwdesk 版）
 * ------------------------------------------------------------
 * 采用开源 System-1 决策模型 Laya（convaiinnovations/laya）的三种
 * 类型化问题原语与置信度门控语义：
 *   - score  : 有序量表打分（紧急度 0-3、复杂度 1-5）
 *   - choice : 候选项概率路由（AI 选择）
 *   - noul   : 是非概率判断（是否需要学生自查）
 *   - act/escalate 门控：置信度 >= ACT_THRESHOLD 才自动执行，
 *     否则升级给学生人工处理（与 Laya 成本敏感行动头一致）。
 *
 * 本文件是确定性的本地实现（零依赖、可离线），保持 hwdesk
 * 「file:// 单文件应用」的架构约束。未来若要接入真实 Laya 模型
 * 后端，只需覆写 Laya.decide(question, state) 一个钩子。
 */
(function (global) {
  "use strict";

  var Laya = {};

  Laya.VERSION = "1.0.0";

  /* 行动阈值：与 Laya act/escalate 头的成本最优策略一致（置信度
   * 高于该值才自动执行，否则升级人工）。 */
  Laya.ACT_THRESHOLD = 0.625;

  /* ---------- AI 注册表：choice 问题的候选选项 ---------- */
  Laya.AI_REGISTRY = {
    reasoner: {
      label: "深度推理AI",
      strengths: ["推导", "证明", "计算", "分析", "建模", "思考题", "力学", "电路"],
      desc: "理工科推导、证明、多步分析"
    },
    writer: {
      label: "写作AI",
      strengths: ["报告", "总结", "论述", "心得", "文献", "论文", "综述"],
      desc: "实验报告、论述题、总结类写作"
    },
    fastsolver: {
      label: "快速作答AI",
      strengths: ["选择", "填空", "判断", "简答", "线上作答", "练习"],
      desc: "线上客观题、短作答，速度优先"
    },
    coder: {
      label: "代码AI",
      strengths: ["代码", "编程", "仿真", "PLC", "单片机", "调试", "嵌入式"],
      desc: "编程、仿真、嵌入式/PLC 实验"
    },
    formatter: {
      label: "格式工具AI",
      strengths: ["排版", "转换", "PDF", "格式", "打印", "模板", "排版整理"],
      desc: "格式转换、排版、PDF 生成"
    }
  };

  /* 课程名 → AI 提示（choice 的先验加分项） */
  Laya.COURSE_HINTS = [
    [/嵌入式|单片机|PLC|C语言|程序设计|微机/, "coder"],
    [/物理|数学|力学|电路|电子技术|拖动|供电/, "reasoner"],
    [/英语|语文|思修|马克思|概论|管理/, "writer"]
  ];

  /* 复杂度关键词（score 问题证据） */
  Laya.COMPLEXITY_KEYWORDS = [
    { re: /推导|证明|建模|仿真|设计|综合|课程设计|大作业/, add: 2, why: "含推导/设计类关键词" },
    { re: /计算|分析|实验|代码|编程|绘图/, add: 1, why: "含计算/实验类关键词" },
    { re: /抄写|总结|心得|简答|选择|填空|翻译|背诵/, add: -1, why: "轻量任务关键词" }
  ];

  /* 提交形式的基础复杂度 */
  Laya.TYPE_BASE_COMPLEXITY = { "线上作答": 2, "文件上传": 2, "附件+报告": 4 };

  /* 复杂度 → 预计工时（小时），用于时间压力与交付顺序判断 */
  var EFFORT_HOURS = { 1: 0.5, 2: 1, 3: 2, 4: 4, 5: 6 };

  /* ---------- 工具 ---------- */
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  /* 距截止天数：负数=逾期；null=无期限 */
  function dayDiff(due, now) {
    if (!due) return null;
    var t = new Date(now.getTime());
    t.setHours(0, 0, 0, 0);
    var p = String(due).split("-");
    if (p.length !== 3) return null;
    var d2 = new Date(+p[0], +p[1] - 1, +p[2]);
    return Math.round((d2 - t) / 86400000);
  }

  /* ---------- score 问题：紧急度（0-3） ---------- */
  Laya.urgency = function (item, now) {
    now = now || new Date();
    var n = dayDiff(item.due, now);
    if (n === null) {
      return { level: 0, label: "无期限", confidence: 0.7, daysLeft: null };
    }
    if (n < 0)  return { level: 3, label: "已逾期" + (-n) + "天", confidence: 0.95, daysLeft: n };
    if (n === 0) return { level: 3, label: "今天截止", confidence: 0.95, daysLeft: 0 };
    if (n <= 3)  return { level: 2, label: "临期(" + n + "天)", confidence: 0.9, daysLeft: n };
    if (n <= 7)  return { level: 1, label: "近期(" + n + "天)", confidence: 0.9, daysLeft: n };
    return { level: 0, label: "余量充足(" + n + "天)", confidence: 0.9, daysLeft: n };
  };

  /* ---------- score 问题：复杂度（1-5） ---------- */
  Laya.complexity = function (item) {
    var text = (item.name || "") + " " + (item.note || "");
    var base = Laya.TYPE_BASE_COMPLEXITY[item.type] != null
      ? Laya.TYPE_BASE_COMPLEXITY[item.type] : 3;
    var kwScore = 0, evidences = [];
    Laya.COMPLEXITY_KEYWORDS.forEach(function (k) {
      if (k.re.test(text)) { kwScore += k.add; evidences.push(k.why); }
    });
    var level = clamp(base + kwScore, 1, 5);

    /* 学生手工指定的难度作为锚点，与启发式结果按 6:4 融合 */
    var anchor = { easy: 1, medium: 3, hard: 5 }[item.difficulty];
    if (anchor != null) {
      level = clamp(Math.round(0.6 * anchor + 0.4 * level), 1, 5);
    }

    var confidence = 0.6;                              // 纯猜测
    if (evidences.length) confidence = 0.85;           // 有关键词证据
    if (anchor != null) confidence = 0.92;             // 学生显式指定，最可信
    return { level: level, label: "复杂度" + level + "/5", confidence: confidence, evidences: evidences };
  };

  /* ---------- 辅助：时间压力（工时 vs 剩余时间） ---------- */
  function timePressure(item, urgencyDec, complexityDec) {
    var effort = EFFORT_HOURS[complexityDec.level] || 2;
    var hoursLeft = urgencyDec.daysLeft == null ? 336 : urgencyDec.daysLeft * 24;
    if (urgencyDec.daysLeft === 0) hoursLeft = 10;     // 当天按剩余半天计
    if (urgencyDec.daysLeft < 0) hoursLeft = 1;        // 已逾期，视为没有余量
    var ratio = effort / Math.max(hoursLeft, 1);
    var label = ratio >= 1 ? "时间不足" : (ratio >= 0.5 ? "压力较高" : (ratio >= 0.2 ? "压力适中" : "余量充足"));
    return { effortHours: effort, hoursLeft: hoursLeft, ratio: ratio, label: label };
  };

  /* ---------- choice 问题：AI 路由 ---------- */
  Laya.routeAI = function (item) {
    var text = (item.name || "") + " " + (item.note || "") + " " + (item.course || "");
    var scores = {}, reasons = {};
    Object.keys(Laya.AI_REGISTRY).forEach(function (k) {
      scores[k] = 0; reasons[k] = [];
    });

    /* 1) 关键词命中（最硬的证据） */
    var kwTotal = 0;
    Object.keys(Laya.AI_REGISTRY).forEach(function (k) {
      Laya.AI_REGISTRY[k].strengths.forEach(function (w) {
        if (text.indexOf(w) !== -1) {
          scores[k] += 2;
          kwTotal += 2;
          reasons[k].push("命中「" + w + "」");
        }
      });
    });

    /* 2) 提交形式先验 */
    var typePrior = { "线上作答": "fastsolver", "附件+报告": "writer", "文件上传": "writer" }[item.type];
    if (typePrior) { scores[typePrior] += 1; reasons[typePrior].push("提交形式「" + item.type + "」"); }

    /* 3) 课程先验 */
    Laya.COURSE_HINTS.forEach(function (h) {
      if (h[0].test(item.course || "")) { scores[h[1]] += 1; reasons[h[1]].push("课程匹配"); }
    });

    /* 4) 平滑归一化为概率分布（Laya choice 语义：返回各选项概率） */
    var keys = Object.keys(scores);
    var total = keys.reduce(function (s, k) { return s + scores[k]; }, 0);
    var SMOOTH = 0.35;
    var probs = {};
    keys.forEach(function (k) { probs[k] = (scores[k] + SMOOTH) / (total + SMOOTH * keys.length); });

    /* 5) 取 top 选项与置信度：只有存在关键词证据才给置信度加成，
     *    仅靠先验猜测的路由置信度低，按 act/escalate 门控升级人工 */
    var top = keys[0];
    keys.forEach(function (k) { if (probs[k] > probs[top]) top = k; });
    var confidence = kwTotal > 0
      ? clamp(probs[top] + 0.15, 0, 0.97)
      : clamp(probs[top] + 0.08, 0, 0.95);

    return {
      ai: top,
      label: Laya.AI_REGISTRY[top].label,
      probs: probs,
      confidence: confidence,
      reasons: reasons[top],
      escalated: confidence < Laya.ACT_THRESHOLD   // 低置信 → 升级人工
    };
  };

  /* ---------- noul 问题：是否需要学生自查 P(review) ---------- */
  Laya.needsReview = function (item, ctx) {
    /* ctx: { complexity, route } 已有决策结果，避免重复计算 */
    var cx = ctx && ctx.complexity ? ctx.complexity : Laya.complexity(item);
    var route = ctx && ctx.route ? ctx.route : Laya.routeAI(item);
    var text = (item.name || "") + " " + (item.note || "");
    var now = (ctx && ctx.now) || new Date();
    var urg = Laya.urgency(item, now);

    var p = 0.15, signals = [], reasons = [];
    if (cx.level >= 4) { p += 0.30; signals.push("complex"); reasons.push("复杂度高(" + cx.level + "/5)，AI 出错代价大"); }
    else if (cx.level === 3) { p += 0.10; }
    if (item.type === "附件+报告") { p += 0.20; signals.push("deliverable"); reasons.push("提交形式为附件+报告，属于打分型交付物"); }
    if (/实验|报告|答辩|审查|自查|论文|期末/.test(text)) { p += 0.15; signals.push("keyword"); reasons.push("含实验/报告/答辩类关键词"); }
    if (item.type === "线上作答" && cx.level <= 2) { p -= 0.10; reasons.push("客观题为主，自动作答风险低"); }
    if (urg.daysLeft != null && urg.daysLeft >= 5) { p += 0.10; signals.push("time"); reasons.push("时间充裕，允许人工复核"); }
    if (urg.daysLeft != null && urg.daysLeft < -2) { p -= 0.10; reasons.push("逾期已超2天，先交付优先"); }

    /* 路由置信度低于行动阈值 → 强制升级（Laya act/escalate 语义） */
    var routeEscalated = route.confidence < Laya.ACT_THRESHOLD;
    if (routeEscalated) reasons.push("AI 路由置信度 " + Math.round(route.confidence * 100) + "% 低于阈值 " + Math.round(Laya.ACT_THRESHOLD * 100) + "%，升级学生自查");

    p = clamp(p, 0.05, 0.95);
    var needed = p >= 0.5 || routeEscalated;
    var confidence = clamp(0.6 + 0.1 * signals.length, 0.6, 0.95);
    return { needed: needed, p: Math.round(p * 100) / 100, confidence: confidence, reasons: reasons };
  };

  /* ---------- 远端模型钩子：默认走本地确定性实现 ----------
   * 接入真实 Laya 后端时覆写本函数：
   *   Laya.decide = function(question, state){ ... 返回同构结果 ... }
   * question 形如 { type: "score", rubric: [...] } / { type: "choice", options: [...] } / { type: "noul" }
   */
  Laya.decide = null;

  /* ---------- 综合决策：单条作业 ---------- */
  Laya.analyze = function (item, now) {
    now = now || new Date();
    var urg = Laya.urgency(item, now);
    var cx = Laya.complexity(item);
    var tp = timePressure(item, urg, cx);
    var route = Laya.routeAI(item);
    var review = Laya.needsReview(item, { complexity: cx, route: route, now: now });

    /* 优先级 = 45% 紧急度 + 25% 时间压力 + 18% 复杂度 + 12% 交付物风险 */
    var urgencyN = urg.level / 3;
    var pressureN = clamp(tp.ratio * 1.2, 0, 1);
    var complexityN = (cx.level - 1) / 4;
    var riskN = item.type === "附件+报告" ? 1 : (item.type === "线上作答" ? 0.3 : 0.6);
    var priority = Math.round(100 * (0.45 * urgencyN + 0.25 * pressureN + 0.18 * complexityN + 0.12 * riskN));
    if (urg.daysLeft != null && urg.daysLeft < 0) priority = Math.min(100, priority + 8); // 逾期加权

    /* 可解释理由（按重要性排序） */
    var reasons = [];
    reasons.push(urg.label + "，" + tp.label);
    reasons.push(cx.label + (cx.evidences.length ? "（" + cx.evidences.join("、") + "）" : ""));
    reasons.push("推荐「" + route.label + "」执行（置信度 " + Math.round(route.confidence * 100) + "%）");
    if (review.needed) reasons.push("需学生自查：" + review.reasons.slice(0, 2).join("；"));
    else reasons.push("满足自动交付条件（置信度达标）");

    return {
      item: item,
      daysLeft: urg.daysLeft,
      urgency: urg,
      complexity: cx,
      pressure: tp,
      route: route,
      review: review,
      priority: priority,
      autoDeliver: !review.needed,
      reasons: reasons
    };
  };

  /* ---------- 排序：全部待办按 Laya 优先级排序 ---------- */
  Laya.rank = function (items, now) {
    now = now || new Date();
    var out = [];
    (items || []).forEach(function (it) {
      if (it.status === "todo") out.push(Laya.analyze(it, now));
    });
    out.sort(function (a, b) {
      if (b.priority !== a.priority) return b.priority - a.priority;
      var ea = a.pressure.effortHours, eb = b.pressure.effortHours;
      return ea - eb;                                   // 同优先级：耗时短的先交付
    });
    return out;
  };

  /* ---------- 执行计划：决策 → 分派不同 AI → 自动交付编排 ---------- */
  Laya.buildPlan = function (items, now) {
    now = now || new Date();
    var queue = Laya.rank(items, now);
    var auto = [], reviewList = [];
    queue.forEach(function (d) {
      (d.autoDeliver ? auto : reviewList).push(d);
    });

    function line(d, i) {
      var s = (i + 1) + ". 「" + d.item.name + "」（" + d.item.course + "，" +
        (d.daysLeft == null ? "无期限" : (d.daysLeft < 0 ? "已逾期" + (-d.daysLeft) + "天" : "剩" + d.daysLeft + "天")) +
        "，优先级" + d.priority + "）";
      s += " → 使用「" + d.route.label + "」完成";
      if (d.item.note) s += "（要求：" + d.item.note + "）";
      s += d.autoDeliver ? " → 完成后直接自动交付" : " → 先生成草稿暂停，等我本人审核确认后再交付";
      return s;
    }

    var instruction = "";
    if (queue.length) {
      instruction = "【Laya 执行计划 · 自动交付】请按以下优先级顺序处理我的作业并提交到学在城院：\n";
      queue.forEach(function (d, i) { instruction += line(d, i) + "\n"; });
      instruction += "要求：每项任务由指定 AI 独立完成以保证正确率；需我审核的任务先出草稿；全部完成后逐项回报结果。";
    }

    return {
      queue: queue,
      autoDeliverList: auto,
      reviewList: reviewList,
      reviewCount: reviewList.length,
      instruction: instruction
    };
  };

  /* UMD-lite：浏览器挂 window.Laya，Node 挂 globalThis.Laya */
  global.Laya = Laya;
})(typeof window !== "undefined" ? window : globalThis);
