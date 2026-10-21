/*!
 * humanize.js — 去AI化（降AI检测率）+ 上下文摄取引擎（hwdesk 版）
 * ------------------------------------------------------------
 * 两层能力：
 *
 * 1) Humanize：交付物人性化
 *    - Humanize.risk(text)     估算文本的 AI 检测风险（0-100），
 *                              信号：AI 高频套话密度 + 句长方差
 *    - Humanize.levelFor(item) 按交付格式决定润色强度 strict/light/off
 *    - Humanize.directives(item) 生成具体的降AI率写作指令
 *    - Humanize.checklist(item)  写进执行指令的完整润色要求 + 交付前审核
 *
 * 2) ContextKit：平台上下文摄取
 *    - ContextKit.pack(item, items, materials)
 *      汇集同课程历史已完成任务 + 匹配的课件/作业要求/范文材料，
 *      序列化为上下文简报，供执行 AI 参考以提高正确率并贴合
 *      学生既有文风。
 *
 * 零依赖、完全离线，与 hwdesk file:// 架构一致。
 */
(function (global) {
  "use strict";

  /* ==================== Humanize ==================== */
  var Humanize = {};
  Humanize.VERSION = "1.0.0";

  /* AI 高频套话黑名单（中文语境常见检测信号） */
  Humanize.CLICHES = [
    /综上所述/, /总而言之/, /总体而言/, /值得注意的是/, /不言而喻/,
    /众所周知/, /在当今.{0,8}时代/, /在当今社会/, /随着.{0,10}的(飞速|快速|迅猛|不断)发展/,
    /首先[^。]{0,80}其次/, /一方面[^。]{0,80}另一方面/, /不仅[^。]{0,40}而且/,
    /起着(至关)?重要的作用/, /让我们(一起)?/, /赋能/, /闭环(?!电)/, /无疑/,
    /本(报告|文档|作业)将(从|围绕)/, /旨在/
  ];

  /* 交付格式 → 润色强度与文风要求 */
  Humanize.FORMAT_RULES = {
    "Word文档": { level: "strict", desc: "书面报告，检测敏感度最高" },
    "PPT演示":  { level: "strict", desc: "演示文稿，标题与讲稿都需口语化" },
    "PDF报告":  { level: "strict", desc: "成册交付物，检测敏感度高" },
    "文字":     { level: "light",  desc: "普通文字作答" },
    "其他":     { level: "light",  desc: "其他形式" }
  };

  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  /* ---------- 检测风险评估（对已生成文本的自查工具） ---------- */
  Humanize.risk = function (text) {
    if (!text || !text.trim()) return null;
    text = String(text);
    var chars = text.replace(/\s/g, "").length || 1;

    /* 信号1：套话命中 */
    var hits = [];
    Humanize.CLICHES.forEach(function (re) {
      var m = text.match(re);
      if (m) hits.push(m[0]);
    });

    /* 信号2：句长方差过低（节奏机械） */
    var sentences = text.split(/[。！？!?;\n]+/).map(function (s) {
      return s.replace(/\s/g, "").length;
    }).filter(function (n) { return n > 0; });
    var uniformPenalty = 0, rhythm = "自然";
    if (sentences.length >= 4) {
      var mean = sentences.reduce(function (a, b) { return a + b; }, 0) / sentences.length;
      var varr = sentences.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / sentences.length;
      var cv = Math.sqrt(varr) / (mean || 1);          // 变异系数
      if (cv < 0.35) { uniformPenalty = 22; rhythm = "句长过于均匀"; }
      else if (cv < 0.5) { uniformPenalty = 8; rhythm = "节奏略单一"; }
    }

    var density = hits.length / chars;
    var score = Math.round(clamp(
      hits.length * 14 + density * 2500 + uniformPenalty, 0, 100));
    var label = score >= 60 ? "高风险" : (score >= 30 ? "中风险" : "低风险");
    return {
      score: score, label: label, hits: hits, rhythm: rhythm,
      uniformPenalty: uniformPenalty, sentenceCount: sentences.length
    };
  };

  /* ---------- 润色强度决策 ---------- */
  Humanize.levelFor = function (item) {
    var fmt = item.format || "文字";
    var rule = Humanize.FORMAT_RULES[fmt] || Humanize.FORMAT_RULES["其他"];
    var level = rule.level;
    /* 书面报告型文字（附件+报告）升级为 strict；客观题线上作答降为 off */
    if (fmt === "文字" && item.type === "附件+报告") level = "strict";
    if (item.type === "线上作答") {
      var cx = (typeof Laya !== "undefined") ? Laya.complexity(item) : { level: 3 };
      level = cx.level <= 2 ? "off" : "light";
    }
    var labels = { strict: "严格润色", light: "轻度润色", off: "无需润色" };
    return { level: level, label: labels[level], format: fmt, desc: rule.desc };
  };

  /* ---------- 降AI率写作指令 ---------- */
  Humanize.BASE_DIRECTIVES = [
    "长短句交错，段落长短不一，避免整篇节奏均匀",
    "用第一人称视角写过程（如「我先测了…」「这里我卡了一下，查了课本第3章」），穿插具体细节：实测数值、页码、时间",
    "禁用AI高频套话：综上所述、总而言之、值得注意的是、随着…的飞速发展、不仅…而且、起着重要作用等",
    "过渡句允许口语化、允许少量不完美（如先说结论再补原因），不要每段都工整对仗"
  ];
  Humanize.FORMAT_DIRECTIVES = {
    "Word文档": ["标题不要用「XX分析」「XX研究」这类模板腔，可带点具体内容（如「Buck电路波形不对的排查记录」）", "实验数据保留原始量纲与合理误差，结论写得保守一点，像学生口吻"],
    "PPT演示": ["每页要点不超过5条，标题用口语化短语而不是完整句", "在备注区保留讲稿痕迹（口语、有语气词）", "排版不要每页同构，允许有图多字少/字多图少的页"],
    "PDF报告": ["参照课程给定的模板格式，封面/页眉按学校要求", "图表编号、单位、坐标轴刻度按实验讲义规范"],
    "文字": ["答题语气自然直接，像在作业本上手写，不要「总-分-总」大结构"]
  };

  Humanize.directives = function (item) {
    var lv = Humanize.levelFor(item);
    if (lv.level === "off") return [];
    var out = Humanize.BASE_DIRECTIVES.slice();
    (Humanize.FORMAT_DIRECTIVES[lv.format] || []).forEach(function (d) { out.push(d); });
    return out;
  };

  /* ---------- 写进执行指令的完整润色要求 ---------- */
  Humanize.checklist = function (item) {
    var lv = Humanize.levelFor(item);
    if (lv.level === "off") return "";
    var ds = Humanize.directives(item);
    var s = "【去AI化要求 · " + lv.label + "（交付格式：" + lv.format + "）】\n";
    ds.forEach(function (d, i) { s += "  " + (i + 1) + ") " + d + "\n"; });
    s += "  交付前自查：对照上述要求通读一遍，出现套话或节奏均匀的段落立即重写；如可用检测工具，AI率须低于30%再交付。";
    return s;
  };

  /* ==================== ContextKit ==================== */
  var ContextKit = {};
  ContextKit.VERSION = "1.0.0";

  /*
   * item      当前任务
   * items     全部作业（含已提交，用于同课程历史）
   * materials 上下文库材料 [{title, course, kind, note}]
   * 返回 { brief, historyCount, materialCount }
   */
  ContextKit.pack = function (item, items, materials) {
    items = items || []; materials = materials || [];

    /* 1) 同课程历史已完成任务（风格锚点 + 范围提示） */
    var history = [];
    items.forEach(function (it) {
      if (it.status === "submitted" && it.course === item.course && it.id !== item.id) {
        history.push(it);
      }
    });

    /* 2) 匹配材料：同课程 或 通用材料 */
    var matched = materials.filter(function (m) {
      return m.course === item.course || m.course === "通用";
    });

    if (!history.length && !matched.length) {
      return { brief: "", historyCount: 0, materialCount: 0 };
    }

    var lines = [];
    lines.push("【上下文参考（来自学在城院与本工作台，用于提高正确率并贴合我的文风）】");
    if (matched.length) {
      lines.push("· 课程材料：");
      matched.forEach(function (m) {
        lines.push("  - " + m.kind + "「" + m.title + "」（" + m.course + "）" +
          (m.note ? "：" + String(m.note).slice(0, 200) : ""));
      });
    }
    if (history.length) {
      lines.push("· 我之前已完成的同课程任务（文风与深度参考）：");
      history.forEach(function (it) {
        lines.push("  - 《" + it.name + "》（" + it.type + (it.note ? "，备注：" + it.note : "") + "）");
      });
      lines.push("  完成本次任务时保持与上述任务一致的个人风格与详略程度。");
    }
    lines.push("· 优先依据上述课件与作业要求作答，不要凭通用知识自由发挥。");

    return {
      brief: lines.join("\n"),
      historyCount: history.length,
      materialCount: matched.length
    };
  };

  /* UMD-lite */
  global.Humanize = Humanize;
  global.ContextKit = ContextKit;
})(typeof window !== "undefined" ? window : globalThis);
