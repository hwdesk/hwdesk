# 作业提交工作台（学在城院版）

桌面级个人作业工作台：双击桌面图标即开的独立 App 窗口。多区块布局（参照团队 RoleWeave 工作台）：总览 / 数据获取 / 数据资产 / 工作流 / **AI 对话** / 审批 / 行动 / 洞察 / 设置，内建 Laya 智能决策、多 AI Agent 对话、去AI化润色、平台数据采集、审批流与交付记录。

## 功能区块

| 区块 | 内容 |
|---|---|
| **总览** | 统计卡片（逾期 / 7 天内截止 / 需自查 / 已提交）、今天要处理（按 Laya 优先级排序）、作业看板 |
| **数据获取** | **一键同步学在城院**：点「🔄 一键同步」生成全平台同步指令（要求代理以 JSON 回报所有课程的课件 / 作业 / 成绩）→ 代理回报后把 JSON 粘进「导入同步结果」→ 自动批量入库：课件/成绩进**采集库**、新作业自动建档、截止日期自动更新，零手工登记；另保留单课程精拉（旧方式） |
| **数据资产** | 上下文库：手工登记课件 / 作业要求 / 范文（与采集库一并进入任务上下文简报） |
| **工作流** | Laya 决策中心：优先级排序、AI 路由（含置信度）、需自查标记、一键执行计划 |
| **AI 对话** | 选任务 → 选任意 AI（⭐ 为 Laya 推荐）→ 逐轮对话 → 回复满意后 **一键交付**；对话记录入**对话库** |
| **审批** | 需自查任务的草稿队列：通过并交付 / 退回修改（附修改指令），审批留痕入**审批库** |
| **行动** | 执行计划说明 + **交付库**（每项任务 pending → submitted / changes 的完整记录，含执行 AI） |
| **洞察** | 去AI化风险自查工具（粘贴成稿 → 套话密度 + 句式节奏评估）+ 操作日志 |
| **设置** | 默认执行 AI、Agent 对话 API 配置（预设 / Base URL / Key / 模型）、JSON 导出 / 导入（含全部库）、清空、决策模型参数说明 |

## 库管理（db.js）

功能区块各自独立分库，由 `db.js` 统一 CRUD / 迁移 / 容量上限（200 条/库）：

- `captures` 采集库 — 从学在城院拉取的课件、作业要求、历史作业登记
- `submissions` 交付库 — 每项任务的交付记录，状态机 `pending → submitted / changes`（changes 可重新提交回 pending，submitted 终态）
- `reviews` 审批库 — 审批决定与退回原因留痕
- `chats` 对话库 — 每项任务与多个 AI Agent 的对话记录（每任务一条，含 turns；上限 60 轮）
- 作业 / 日志 / 材料沿用原 `wb_hwdesk_*` 键（向后兼容）；导出备份包含全部七库

**平台数据链路**：本页面不直接登录学在城院（`file://` 页面无法爬取，凭据也不进页面）——「一键同步」生成全平台同步指令 → AI 代理登录平台拉取并以 **JSON** 回报课件、作业与成绩 → 粘贴进「导入同步结果」，`SyncKit.parse()` 校验 + `SyncKit.planMerge()` 算增量（采集去重、新作业自动建档、截止变化生成更新）→ 页面批量入库。代理只是透明的传输管道，往返之外零手工。

### 权限说明

仓库所有新增模块与数据层代码均在本仓库内；仓库归 冯浩然（waterbro-8）所有（admin 权限），天然拥有全部控制权，无需额外授权。

## Laya 决策模型

采用开源 System-1 决策模型 [Laya](https://huggingface.co/convaiinnovations/laya)（choice / score / noul 类型化问题 + 置信度门控）的决策语义，在 `laya.js` 中实现为**本地确定性引擎**（零依赖、完全离线），保持本应用 file:// 单文件窗口架构。接入真实 Laya 模型后端只需覆写 `Laya.decide()` 钩子。

决策流程：

1. **score · 紧急度（0-3）**：逾期 / 今天截止 → 3；1-3 天 → 2；4-7 天 → 1
2. **score · 复杂度（1-5）**：提交形式基础分 + 备注/名称关键词（推导/建模 +2、计算/实验 +1、抄写/简答 -1）+ 学生手动难度锚点（6:4 融合）
3. **优先级（0-100）**：`45%×紧急度 + 25%×时间压力 + 18%×复杂度 + 12%×交付物风险`，逾期额外 +8
4. **choice · AI 路由**：在 AI 注册表（深度推理 / 写作 / 快速作答 / 代码 / 格式工具）上按关键词 + 提交形式 + 课程先验计算选项概率，返回 top AI 与置信度
5. **noul · 学生自查**：`P(需自查)` 由复杂度、交付物类型、关键词、时间余量加权；**置信度低于行动阈值 0.625（与 Laya act/escalate 头一致）时强制升级学生审核**
6. **自动交付编排**：`Laya.buildPlan()` 生成分派计划——不同任务交给不同 AI，可自动交付的直接交付，需自查的先出草稿暂停等学生确认

API：`Laya.analyze(item)` 单条决策 / `Laya.rank(items)` 优先级排序 / `Laya.buildPlan(items)` 执行计划与批量指令。

## 多 AI Agent 对话（agents.js）

框架参照 [bytefolk/roleweave](https://github.com/bytefolk/roleweave) 的三层结构，降维为本地零依赖实现：

| RoleWeave | hwdesk |
|---|---|
| `apps/server/src/agent-registry.ts`（每个 AI 是一个 Agent Host） | `AgentHub.REGISTRY`（8 个 Agent：id / label / 能力原型 / 关键词 / 风格指令） |
| `apps/server/src/model-selection.ts`（每引擎模型目录） | `AgentHub.recommend()`（复用 Laya choice 路由 + 关键词 + 交付格式先验打分排序） |
| `apps/desktop/renderer/src/turns/*`（会话 turns） | `AgentHub.composePrompt()` / `addTurn()` / `chat()`（对话组装与留痕） |

注册的 Agent（不局限于任何一家，可任意调动）：

| Agent | 擅长 |
|---|---|
| 千问 Qwen | 写作、报告、PPT 文案与排版 |
| WorkBuddy | 全流程执行代理（**唯一能登录学在城院完成提交的**） |
| 即梦 Jimeng | 图像生成：PPT 配图、封面、示意图 |
| DeepSeek | 数理推导、计算与分析 |
| Kimi | 长文档阅读、综述与长文写作 |
| 豆包 Doubao | 客观题、短作答，速度优先 |
| Qoder | 编程、嵌入式/PLC、仿真调试 |
| Claude | 深度推理、推导证明、长链分析 |

对话流程（页面不起服务、不存凭据，符合零依赖约束）：

1. 选任务 + 选 AI（⭐ 标记 Laya 推荐位，可随时切换）
2. 「发送」→ `composePrompt()` 组装完整提示词：**任务卡 + Laya 决策 + ContextKit 上下文简报 + Humanize 交付要求 + 该 AI 的风格指令 + 你的要求** → 复制到该 AI 自己的窗口粘贴发送
3. 「记录 AI 回复」→ 把回复粘回，存入对话气泡（跨 Agent、多轮连续）
4. 满意的那条回复点「✅ 一键交付」→ `deliverCmd()` 生成 WorkBuddy 提交指令并复制，同时写入**交付库**（需自查的任务为 `pending` 进审批队列，否则 `submitted`）

与 `bridge.js`（AI 直连桥）的分工：**bridge 管派发**（自动打开豆包 / 元宝 / DeepSeek / Kimi / 千问的网页并复制指令），**agents 管对话与交付**（多轮记录、跨 Agent 对比、满意后一键交付）。两者同时加载时，「发送」会顺带打开所选 AI 的网页；bridge 未加载时自动退回纯复制流程（`AgentHub.openUrl()` 返回 null）。

2. **上下文摄取（提高正确率）**

教师在学在城院上发布的课件、作业要求，以及自己此前被认可的答案，是最强的参考信号。`上下文库` 允许把这些材料按课程登记（本地存储），`ContextKit.pack()` 会为每项任务组装上下文简报：

- 同课程的材料（课件 / 作业要求 / 范文）+ 标记为「通用」的材料
- 同课程**已提交过**的任务（自动作为文风与详略程度的锚点）
- 明确要求「优先依据课件作答，不凭通用知识自由发挥」

### 去AI化（降低 AI 检测率）

`humanize.js` 提供交付物降 AI 检测率的能力：

| API | 作用 |
|---|---|
| `Humanize.levelFor(item)` | 按交付格式决定润色强度：Word / PPT / PDF / 报告型文字 → `strict`；普通文字 → `light`；客观题线上作答 → `off` |
| `Humanize.directives(item)` | 具体写作指令：长短句交错、第一人称与实测细节、禁用 AI 高频套话黑名单、允许少量自然不完美；PPT 另有口语化标题 / ≤5 条要点 / 备注区讲稿痕迹 |
| `Humanize.checklist(item)` | 写进执行指令的完整要求 + **交付前自查**（AI 率需低于 30% 再交付） |
| `Humanize.risk(text)` | 已生成文本的检测风险评估（0-100），信号为套话密度 + 句长方差，可作为交付前的审查闸门 |

复盘：把成稿粘贴给代理调用 `Humanize.risk()`，高风险则重写指定段落后再交付。

运行测试（零依赖，Node ≥ 16）：

```
node test/db.test.mjs         # 库管理 + 交付状态机：10 项
node test/laya.test.mjs       # 决策引擎：22 项
node test/humanize.test.mjs   # 去AI化 + 上下文：22 项
node test/bridge.test.mjs     # AI 直连桥：13 项
node test/agent.test.mjs      # 作业 Agent 对话：17 项
node test/sso.test.mjs        # 学在城院登录凭据：12 项
node test/wiring.test.mjs     # 页面接线回归（el() 引用 + 选择器事件 + 初始化容错）：12 项
node test/agents.test.mjs     # 多 AI Agent 对话 + 一键交付：59 项
node test/sync.test.mjs       # 平台一键同步（指令/解析/增量合并）：34 项
```

`wiring.test.mjs` 静态解析 `作业提交工作台.html`，守住两类只在运行时才暴露的问题：
`el("id")` 引用了页面里不存在的元素（会让 `bind()` 抛错、初始化半途而废），
以及 DOM 与处理函数都在、却忘了接监听器（按钮点了没反应）。

## 学在城院登录门禁（sso.js）

**不登录学在城院账号进不了工作台**：首次打开（或凭据被清除后）整页被登录门禁拦住，输入本人学在城院账号密码（保存方式：仅本次 / 记住到本机）后才进入；侧边栏常显当前账号（打码）与「退出登录」（退出即清除本机凭据）。凭据经 `sso.js` 只写入**本人浏览器的 localStorage / sessionStorage**——仓库、页面源码、部署产物里永远没有任何账号密码。

- 「生成采集指令」自动附带登录段落：默认**只带账号**（密码由学生向本机代理当面提供）；勾选「指令中附带密码」才写入，且附禁止外传提醒
- 状态行打码显示（`3202****234`）；「清除凭据」一键抹掉全部三档存储
- 旧流程不变：真正的平台登录 / 拉取 / 提交仍由各人本机的 AI 代理执行

## 作业 Agent 对话（agent.js）

每个作业自带一个 **内嵌 Agent 对话抽屉**（作业卡上的「💬 对话」）：学生与 Agent 在工作台内交互成稿，点「📤 用最终结果提交」**直接通过工作台交付**——写入交付库并走交付状态机（需自查的进审批队列），全程不必离开页面。

- 后端为任意 **OpenAI 兼容 `/chat/completions`** 服务，内置预设：DeepSeek / Kimi（月之暗面）/ 通义千问 / 豆包（火山方舟，需自己的接入点）/ 自定义网关；配置存 `wb_hwdesk_agent` 键，**Key 只存本机 localStorage**
- 系统提示词自动组装：作业字段 + Laya 决策（路由类别 / 是否需自查）+ ContextKit 课程上下文 + Humanize 去AI化要求；Agent 被约定以 `【最终交付】` 输出定稿
- 流式输出（SSE），成稿后自动跑 `Humanize.risk()` 检测风险提示；对话历史按作业 ID 存 `wb_hwdesk_chats`

## AI 直连（bridge.js + agent.js 内嵌对话）

点「AI 代提交」不再强制经过 WorkBuddy：`bridge.js` 维护直连 AI 注册表（**豆包 / 腾讯元宝 / DeepSeek / Kimi / 通义千问 / WorkBuddy 本地代理**）。

- **支持浏览器直连 API 的 AI（DeepSeek / Kimi / 通义 / 豆包）**：在选择器点选后**不再跳转网页**——自动切换到该 Agent 并打开工作台**内嵌对话抽屉**（`agent.js`，OpenAI 兼容 API 流式直连），Agent 直接在后台生成，聊出成稿后点「用最终结果提交」进审批队列交付
- **元宝 / WorkBuddy**：无 API 预设（元宝）或走平台代理（WorkBuddy），保留旧流程 = 复制指令 + 打开对应网页 / 纯复制
- 目标挑选优先级：按 Laya 路由类别的单独指定 > 设置页的「默认执行 AI」> 注册表自动匹配；两者都未设时弹出选择器
- 选择器操作：点一行 = 本次用它执行（API 直连 AI 转内嵌对话）；点「设为默认」= 记住选择并执行；**Esc 或点弹窗外空白处 = 取消**（也支持 Enter / Space 选中聚焦行）
- 「WorkBuddy（本地代理）」保留旧复制流程——只有它能代登录学在城院完成真正的平台提交
- 偏好存 `wb_hwdesk_bridge` 键；`Bridge.pick(category)` / `Bridge.describe(pick)` 为纯计算 API，DOM 无关、可单测

## 桌面安装（Windows）

1. 把 `作业提交工作台.html`、`laya.js`、`humanize.js`、`db.js`、`bridge.js`、`agent.js`、`agents.js`、`sso.js`、`sync.js` 放到同一稳定目录（如 `C://Users//<你>//hwdesk//`）
2. 生成应用图标：仓库内 `hwdesk.ico` 可直接使用
3. 生成桌面快捷方式（Chrome 应用模式）：

```powershell
python make_lnk_com.py   # 需要 pywin32：pip install pywin32
```

或使用无依赖的纯 Python 版：`python make_lnk.py`（手工构造 .lnk 二进制）。

双击桌面图标 → 独立窗口打开，无地址栏。

## 技术要点

- 主页面为单文件 HTML，零外部网络依赖（无 CDN / 字体 / 框架），全部 CSS/JS/图标内联；决策引擎 `laya.js`、去AI化/上下文引擎 `humanize.js`、库管理层 `db.js`、多 Agent 中心 `agents.js`、平台同步引擎 `sync.js` 拆为同目录纯本地脚本（无网络请求），方便单测与后续接入真实 Laya 模型后端
- 引擎之间互不依赖：`agents.js` 通过页面注入的 `{ routeFor, analyzeFor, contextFor, humanizeFor }` 钩子使用其它引擎能力
- 图标 `.ico` 为纯 Python 手工生成（48×48 32bpp）
- `.lnk` 快捷方式提供两种生成方案：pywin32 COM 版（推荐）与纯二进制手工版
- Chrome `--app` 模式实现类原生窗口体验

## 隐私

- 页面源码与仓库不含任何账号密码；作业 / 材料 / 对话等业务数据只存本机 localStorage
- 学在城院凭据由每个成员在「登录」卡片自行输入，`sso.js` 只写本人浏览器本机存储，可随时一键清除
- 与学校平台的对接（登录、拉取作业、上传提交）由各人本机的 AI 代理执行，凭据不进入页面与仓库
