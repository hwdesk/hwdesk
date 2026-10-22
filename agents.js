/*!
 * agents.js — hwdesk 多 AI Agent Hub（对话 + 一键交付）
 * ------------------------------------------------------------
 * 框架参照 bytefolk/roleweave 的三层结构，降维为本地零依赖实现：
 *
 *   roleweave apps/server/src/agent-registry.ts
 *     → AgentHub.REGISTRY   每个 AI 是一个 Agent（id/label/能力/风格）
 *   roleweave apps/server/src/model-selection.ts
 *     → AgentHub.recommend  按任务推荐 Agent（复用 Laya 路由原型）
 *   roleweave apps/desktop/renderer/src/turns/*
 *     → AgentHub.composePrompt / addTurn / chat   会话 turns
 *
 * hwdesk 是 file:// 单文件应用，页面不起服务、不存凭据：
 * 「对话」= 页面组装完整提示词 → 复制到所选 AI 自己的窗口发送 →
 * 把回复粘贴回对话记录；「一键交付」= 生成 WorkBuddy 交付指令 +
 * 写入交付库（needsReview 的任务先进审批队列）。
 *
 * 依赖约定：与 laya.js / humanize.js / db.js 互不依赖；
 * 页面通过 opts 注入钩子：
 *   routeFor(item)    -> Laya.routeAI(item) 的结果（choice 原型）
 *   analyzeFor(item)  -> Laya.analyze(item) 的综合决策
 *   contextFor(item)  -> ContextKit.pack(...).brief 上下文简报
 *   humanizeFor(item) -> Humanize.checklist(item) 交付要求
 */
(function (global) {
  "use strict";

  var AgentHub = {};
  AgentHub.VERSION = "1.1.0";

  /* ---------- Agent 注册表（roleweave AgentHostDescriptor 的本地版） ----------
   * archetypes: 覆盖 laya.js Laya.AI_REGISTRY 里的哪些原型
   * strengths : 关键词证据（推荐时命中加分）
   * style     : 提示词风格指令（composePrompt 会附加）
   */
  AgentHub.REGISTRY = {
    workbuddy: {
      label: "WorkBuddy", emoji: "🧩",
      archetypes: ["polisher", "formatter"],
      strengths: ["交付", "提交", "上传", "平台", "学在城院", "整理", "执行"],
      desc: "全流程执行代理：能登录学在城院完成上传与作答，交付动作只能由它执行",
      style: "作为我的执行代理，请完整执行任务并把结果与回执一起回报。"
    },
    qoder: {
      label: "Qoder", emoji: "⌨️",
      archetypes: ["coder"],
      strengths: ["代码", "编程", "仿真", "PLC", "单片机", "调试", "嵌入式", "C语言", "Keil"],
      desc: "编程与嵌入式/PLC 实验、仿真、调试",
      style: "请给出可直接运行的代码/工程，关键步骤加注释，并说明验证方法。"
    },
    claude: {
      label: "Claude", emoji: "🎼",
      archetypes: ["reasoner", "writer"],
      strengths: ["推导", "证明", "论证", "分析", "建模", "论文"],
      desc: "深度推理、推导证明、长链分析",
      style: "请一步一步推导，先给出思路框架再展开细节，最后核对一遍关键步骤。"
    },
    qwen: {
      label: "千问", emoji: "❓",
      archetypes: ["writer", "formatter"],
      strengths: ["报告", "PPT", "演示", "排版", "总结", "汇报"],
      desc: "写作、报告、PPT 文案与排版",
      style: "请按学生作业口径写作，结构清晰但不要过度分点，标题口语化。"
    },
    deepseek: {
      label: "DeepSeek", emoji: "🐋",
      archetypes: ["reasoner"],
      strengths: ["推导", "计算", "证明", "数学", "物理", "力学", "电路", "分析"],
      desc: "数理推导、计算与分析",
      style: "请严格按步骤推导，单位与符号规范，最后代入一组数据验证。"
    },
    kimi: {
      label: "Kimi", emoji: "🌙",
      archetypes: ["writer", "reasoner"],
      strengths: ["文献", "长文", "阅读", "综述", "报告", "论文", "Word"],
      desc: "长文档阅读、综述与长文写作",
      style: "请先概述你从参考材料里抓到的要点，再据此写作，引用处注明出处。"
    },
    doubao: {
      label: "豆包", emoji: "🫘",
      archetypes: ["fastsolver"],
      strengths: ["选择", "填空", "判断", "简答", "线上作答", "练习", "快"],
      desc: "客观题、短作答，速度优先",
      style: "请直接给出答案，每题附一句依据，不要展开长分析。"
    },
    jimeng: {
      label: "即梦", emoji: "🎨",
      archetypes: ["formatter"],
      strengths: ["图", "插图", "封面", "配图", "海报", "PPT", "可视化"],
      desc: "图像生成：PPT 配图、封面、示意图",
      style: "请为以下内容生成配图：风格贴近学生课件，避免过度精美暴露 AI 生成痕迹。"
    }
  };

  /* 交付格式 → 偏好 Agent（choice 的先验证据） */
  AgentHub.FORMAT_HINTS = [
    [/PPT|演示/, ["jimeng", "qwen"]],
    [/Word|文档|报告/, ["kimi", "qwen"]]
  ];

  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  /* ---------- 模型选择（roleweave model-selection 的本地版） ----------
   * 返回按适配度排序的 Agent 列表：
   *   [{ agent, id, score, reasons, recommended }]
   * opts.routeFor(item) 可注入 Laya.routeAI 结果（choice 原型概率分布）。
   */
  AgentHub.recommend = function (item, opts) {
    opts = opts || {};
    var text = (item.name || "") + " " + (item.note || "") + " " + (item.course || "");
    var route = typeof opts.routeFor === "function" ? opts.routeFor(item) : null;

    var scores = {}, reasons = {};
    Object.keys(AgentHub.REGISTRY).forEach(function (k) {
      scores[k] = 0; reasons[k] = [];
    });

    /* 1) Laya choice 路由：top 原型 +3，次原型 +1 */
    if (route && route.probs) {
      var keys = Object.keys(route.probs).sort(function (a, b) { return route.probs[b] - route.probs[a]; });
      keys.slice(0, 2).forEach(function (arch, idx) {
        var w = idx === 0 ? 3 : 1;
        Object.keys(AgentHub.REGISTRY).forEach(function (k) {
          if (AgentHub.REGISTRY[k].archetypes.indexOf(arch) !== -1) {
            scores[k] += w;
            reasons[k].push("Laya 路由原型「" + arch + "」" + (idx === 0 ? "首选" : "次选"));
          }
        });
      });
    }

    /* 2) Agent 关键词命中 */
    Object.keys(AgentHub.REGISTRY).forEach(function (k) {
      AgentHub.REGISTRY[k].strengths.forEach(function (w) {
        if (text.indexOf(w) !== -1) {
          scores[k] += 2;
          reasons[k].push("命中「" + w + "」");
        }
      });
    });

    /* 3) 交付格式先验 */
    AgentHub.FORMAT_HINTS.forEach(function (h) {
      if (h[0].test(item.format || "")) {
        h[1].forEach(function (k) {
          scores[k] += 1;
          reasons[k].push("交付格式「" + item.format + "」");
        });
      }
    });

    /* 排序输出 */
    var out = Object.keys(AgentHub.REGISTRY).map(function (k) {
      return { id: k, agent: AgentHub.REGISTRY[k], score: scores[k], reasons: reasons[k] };
    });
    out.sort(function (a, b) { return b.score - a.score; });
    out.forEach(function (r, i) { r.recommended = i === 0; });
    return out;
  };

  /* ---------- 对话历史 → 提示词片段（多轮 / 跨 AI 续聊） ----------
   * turns 传 AgentHub.chat(item.id).turns（可空）。
   * 只带最近若干轮并标注产出它的 AI：换 AI 时也能接着上一位的方案比较、核对，
   * 而不是让新 AI 从零重来。
   */
  AgentHub.HISTORY_TURNS = 8;
  AgentHub.formatHistory = function (turns) {
    if (!turns || !turns.length) return "";
    var recent = turns.slice(-AgentHub.HISTORY_TURNS);
    var out = ["【已有对话记录】以下是我与 AI 针对本任务已有的对话（括号内是产出该轮的 AI），"
      + "请在此基础上继续或核对，不要从头重来："];
    recent.forEach(function (t, i) {
      if (!t) return;
      var who = t.role === "ai" ? (t.agentLabel || t.agent || "AI") : "我";
      out.push((i + 1) + ". " + who + "：" + String(t.text || "").trim());
    });
    out.push("（以上为历史对话，下面是本次的新要求）");
    return out.join("\n");
  };

  /* ---------- 提示词组装：任务卡 + 决策 + 上下文 + 交付要求 + 风格 ----------
   * userMsg 是我在对话框里输入的额外要求（可空）。
   * opts.history 传已有对话轮次，会拼进提示词（多轮 / 跨 AI 续聊）。
   */
  AgentHub.composePrompt = function (item, agentId, userMsg, opts) {
    opts = opts || {};
    var ag = AgentHub.REGISTRY[agentId];
    if (!ag) return "";
    var d = typeof opts.analyzeFor === "function" ? opts.analyzeFor(item) : null;

    var lines = [];
    lines.push("【hwdesk 任务委托 · " + ag.label + "】");
    lines.push("作业：" + (item.name || "-") + "（课程：" + (item.course || "-") +
      "，截止：" + (item.due || "无期限") + "，交付格式：" + (item.format || "文字") + "）");
    if (item.note) lines.push("我的要求：" + item.note);
    if (d) {
      lines.push("Laya 决策：优先级 " + d.priority + "（" + d.urgency.label + "，" +
        d.complexity.label + "），建议由「" + d.route.label + "」类能力完成。");
    }
    if (typeof opts.contextFor === "function") {
      var brief = opts.contextFor(item);
      if (brief) lines.push("\n" + brief);
    }
    if (typeof opts.humanizeFor === "function") {
      var cl = opts.humanizeFor(item);
      if (cl) lines.push("\n" + cl);
    }
    lines.push("\n" + ag.style);
    /* 已有对话（多轮 / 跨 AI）：把前面的轮次带进提示词，换 AI 也能接着上一位的方案比较、核对 */
    var hist = AgentHub.formatHistory(opts.history);
    if (hist) lines.push("\n" + hist);
    if (userMsg) lines.push("\n我这次的具体要求：" + userMsg);
    lines.push("\n请直接给出可交付的成稿。");
    return lines.join("\n");
  };

  /* ---------- 一键交付指令：交给 WorkBuddy 执行 ----------
   * draftExcerpt：对话里选定要交付的 AI 回复（摘录）。
   */
  AgentHub.deliverCmd = function (item, agentId, draftExcerpt, opts) {
    opts = opts || {};
    var ag = AgentHub.REGISTRY[agentId] || { label: agentId || "AI" };
    var d = typeof opts.analyzeFor === "function" ? opts.analyzeFor(item) : null;
    var needsReview = d ? d.review.needed : true;

    var s = "【一键交付】请把以下成稿提交到学在城院：" + (item.name || "-") +
      "（课程：" + (item.course || "-") + "，交付格式：" + (item.format || "文字") + "）\n" +
      "成稿来源：" + ag.label + "（我在 hwdesk 对话框确认过效果）\n";
    if (draftExcerpt) s += "成稿内容：\n" + draftExcerpt + "\n";
    s += needsReview
      ? "提交前先给我看一眼最终稿（该任务需我本人自查确认）。"
      : "确认无误后直接提交，完成后回报结果。";
    if (typeof opts.humanizeFor === "function") {
      var cl = opts.humanizeFor(item);
      if (cl) s += "\n\n" + cl;
    }
    return { cmd: s, needsReview: needsReview };
  };

  /* ---------- 与直连桥协作（可选） ----------
   * bridge.js（AI 直连桥）负责「派发 / 打开 AI 网页」，agents.js 负责
   * 「对话 / 一键交付」。两者都加载时，发送提示词可顺带打开该 AI 的网页，
   * 省去手动找入口。bridge.js 未加载时返回 null，页面退回纯复制流程。
   */
  AgentHub.openUrl = function (agentId) {
    var b = global.Bridge;
    if (!b || !b.AI) return null;
    var e = b.AI[agentId];
    return (e && e.url) ? e.url : null;
  };

  /* ---------- 会话 turns（roleweave conversation 的本地版） ----------
   * 对话记录存 DB chats 库，每任务一条：{ id:"c"+itemId, itemId, name, turns:[], updatedAt }
   * turn: { role:"user"|"ai", agent, agentLabel, text, time }
   * user turn 的 text 存我输入的要求；prompt 存组装后的完整提示词（可复制复看）。
   */
  function getDb() {
    return typeof global.DB !== "undefined" ? global.DB : null;
  }

  AgentHub.chat = function (itemId) {
    var db = getDb();
    if (!db) return null;
    return db.find("chats", "c" + itemId);
  };

  AgentHub.addTurn = function (item, turn) {
    var db = getDb();
    if (!db) return null;
    var rec = AgentHub.chat(item.id);
    if (!rec) {
      rec = { id: "c" + item.id, itemId: item.id, name: item.name, turns: [], updatedAt: "" };
    }
    var n = new Date(), pad = function (x) { return (x < 10 ? "0" : "") + x; };
    turn.time = n.getFullYear() + "-" + pad(n.getMonth() + 1) + "-" + pad(n.getDate()) +
      " " + pad(n.getHours()) + ":" + pad(n.getMinutes());
    rec.turns.push(turn);
    if (rec.turns.length > 60) rec.turns = rec.turns.slice(-60);   // 防膨胀
    rec.updatedAt = turn.time;
    var existed = !!db.find("chats", rec.id);
    if (existed) db.update("chats", rec.id, { turns: rec.turns, updatedAt: rec.updatedAt });
    else db.insert("chats", rec);
    return rec;
  };

  AgentHub.clearChat = function (itemId) {
    var db = getDb();
    if (!db) return;
    db.remove("chats", "c" + itemId);
  };

  /* ---------- 我的默认 Agent（⭐ 是 Laya 自动推荐；这里是用户手动指定） ----------
   * 打开「AI 对话」板块时优先选中默认项；存本机 localStorage，与业务数据分离。
   * 非法 id 一律视为未设置；传空串清除。 */
  var LS_DEF = "wb_hwdesk_default_agent";
  AgentHub.setDefault = function (agentId) {
    try {
      if (!global.localStorage) return;
      if (agentId && AgentHub.REGISTRY[agentId]) {
        global.localStorage.setItem(LS_DEF, agentId);
      } else if (!agentId) {
        global.localStorage.removeItem(LS_DEF);   /* 显式清除（空串 / null） */
      }
      /* 非法 id：忽略，保留原默认 */
    } catch (e) { /* 隐私模式等，静默 */ }
  };
  AgentHub.getDefault = function () {
    try {
      var id = global.localStorage ? global.localStorage.getItem(LS_DEF) : null;
      return (id && AgentHub.REGISTRY[id]) ? id : "";
    } catch (e) { return ""; }
  };

  /* UMD-lite */
  global.AgentHub = AgentHub;
})(typeof window !== "undefined" ? window : globalThis);
