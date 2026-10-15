# pi-plugins

给 [Pi](https://pi.dev) coding agent 用的插件集合。一个仓 = 一个 Pi package：`extensions/` 下的每个子目录就是一个插件。

## 目录

```
pi-plugins/
├── package.json          Pi 靠它认包（keywords 里的 pi-package）+ 声明 peer 依赖
├── tsconfig.json         只用于编辑器提示和 `npm run check`，运行时靠 jiti 直接跑 TS
├── extensions/           ← 插件放这里；每个子目录一个 index.ts
├── templates/hello/      复制它开始写新插件（放在 extensions/ 外，不会被自动加载）
└── .github/workflows/    CI：type check + 单测
```

## 写一个新插件

```bash
cp -r templates/hello extensions/<你的插件名>
```

然后改 `extensions/<你的插件名>/index.ts`：默认导出工厂函数，在里面注册能力。

| 想要 | 用 |
|---|---|
| 加 `/命令` | `pi.registerCommand("name", { description, handler })` |
| 加模型能调的工具 | `pi.registerTool(defineTool({ name, description, parameters, execute }))` |
| 监听生命周期 | `pi.on("session_start" \| "tool_call" \| "agent_end" \| …, handler)` |
| 弹窗 / 通知 / 状态栏 | `ctx.ui.*` |
| 存不喂给模型的会话数据 | `pi.appendEntry()` |

细节看官方文档：`docs/extensions.md`（能力清单和契约）、`docs/packages.md`（打包规则）、`docs/tui.md`（自绘界面）。Pi 自带示例在 `examples/extensions/`，是最可靠的写法参考。

**把纯逻辑放在单独文件里**（像 `templates/hello/greeting.ts`），`index.ts` 只做接线——这样单测不用起 Pi。

## 开发

```bash
npm install
npm run check   # tsc --noEmit
npm test        # node --test，Node 24 原生跑 .ts
```

装进 Pi 试跑（本地包，改完 `/reload` 就生效）：

```bash
pi install ~/code/pi-plugins
```

只想临时试一个文件，不进配置：

```bash
pi --extension ./extensions/<你的插件名>/index.ts
```

## 两条硬规则

1. **不要给某个插件单独开依赖**——依赖声明在根 `package.json`。Pi 会把整包依赖装到包自己的 `node_modules`，装完 `npm install` 一下对齐本地。
2. **Pi 提供的包只能写进 `peerDependencies`（`"*"`），不许写进 `dependencies`**：`@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`typebox`。写进 `dependencies` 会出现两份物理副本，导致重复的类/注册表实例。本地开发和类型检查把它们放 `devDependencies` 即可（已配好）。

## 内置插件：workflow-tools

`extensions/workflow-tools/` 提供四个模型可调用的工具，共用一套任务运行时（任务 ID、状态、取消、清理）。

| 工具 | 干什么 |
|---|---|
| `ask_user_question` | 结构化选项卡：1～4 题、单选/多选、自由输入（Other 行内输入）|
| `monitor` | 监听一条 shell 命令的输出行，或订阅一个已登记任务的事件 |
| `subagent` | 在独立 Pi 子会话里跑专用 agent：单个 / 并行 / 链式 |
| `task_stop` | 停掉还在跑的 monitor 或 subagent（打整个进程组） |

### 启用

```bash
pi install ~/code/pi-plugins        # 装进 Pi
pi --extension ./extensions/workflow-tools/index.ts   # 或只临时加载这一个插件
```

### 要知道的几条约定

- **无 UI 环境直接拒绝**：`ask_user_question` 在 `json` / `print` 模式下返回 `ui_unavailable`，不会挂着等一个不存在的终端。RPC 模式没有自绘卡片，多选会降级成连续单选并在 `annotations[id].degraded` 标记。
- **答案以 `id` 为 key**：每题必须给 `id`，`answers` / `responses` / `annotations` 都用它索引。别依赖问题文本——两条文字相同的问题会互相覆盖。
- **事件不是逐行进上下文的**：`monitor` 默认按 30 秒窗口把进度合并成一条摘要；传 `deliver: "terminal"` 则进度完全不进上下文，只在任务结束时推一条终态。`tail -f` 这类高频输出不会把上下文灌爆。
- **终态一定叫得醒你**：终态用 `triggerTurn: true` 推送，会话空闲时也会起一个新回合，不需要轮询或 sleep。
- **并发上限按会话算**：monitor 与 subagent **合计**最多 8 个任务；单次超过 8 个的闸只加在并行 `tasks` 上（`chain` 逐步串行，不受此限），超了直接返回 `concurrency_exceeded`。其中**「同时最多 4 个在运行」只给 subagent 排队用**——它要新起 Pi 进程、烧模型钱，满槽就等空槽（排位目前不进返回值）。⚠️ **monitor 不排队、但会占名额**：闸只看有没有空槽、不看任务种类，所以有空槽时 monitor 照样占一个运行位，4 个常驻 monitor（`timeout_ms: 0`）能把后续 subagent 一直顶在队列里。
- **子会话真的独立**：子 Pi 用 `-ne -nc -ns --no-mcp` 起，不带用户级扩展、命令、skills 和 MCP——否则 reviewer 会连上 MCP，还可能递归派发 subagent。
- **项目级 agent 默认不参与**：要显式传 `agentScope: "project" | "both"`，且项目得先被信任（`confirmProjectAgents: false` 表示调用方自行承担）。

### 问答卡片怎么操作（TUI）

卡片按终端尺寸排版，整体不超过「终端行数 − 4」。**超屏的题目、选项描述、备注一律剪掉**，并在剪的位置标出 `─── ✂ ─── N lines hidden `（末尾带一个空格，无收尾横线）。上一版的「全文可读、`PgUp`/`PgDn` 翻页」自本版起取消：`PgUp` / `PgDn` 不再归卡片；预览（`preview`）这个字段整个去掉了。

| 按键（沿用 Pi 键位配置，默认如下） | 行为 |
|---|---|
| `↑` / `↓` | 列表里移动焦点，不改变勾选；焦点移出窗口时窗口跟随 |
| `Enter` | 单选：选中当前项并提交本题；多选：确认已有勾选；提交屏：整体提交；编辑态：采用输入 |
| `1`–`9` | 直选对应序号项；单选直接作答，多选只切换勾选 |
| `Space` | 多选切换勾选；单选等同 `Enter` |
| `Tab` / `Shift+Tab` / `←` `→` | 前后切题（不隐式确认）；单题卡片没有可切的目标，这些键不生效 |
| `n` | 编辑当前题备注 |
| `Esc` | 取消整批（含焦点在 Other 行时；备注重开时退回列表并保留草稿）|

- **选项行与颜色**：单选 `❯ 1. 标签 ✔`（勾在尾部），多选 `❯ 1. [✔] 标签`（框在前）；焦点用强调色、已选用成功色并加粗、描述用次级色。字形随终端能力切换，回退档是 `> 1. [×] 标签`（`√` 与 `×` 不是 ASCII，与上游回退表一致）。颜色不是唯一提示——光标、勾、方框各自独立可辨。
- **Other 行本身就是输入框**：切到 `❯ N. Other: ` 直接打字或粘贴，文字就接在冒号后面，不弹边框编辑器。`Enter` 采用并确认本题（空输入报错）；`↑↓` 走开、文字留着，回来接着改；`←→` 移文本光标，`Backspace` 删字，多行内容按受限高度滚动。底层复用 Pi 的编辑器，粘贴、emoji、中文与 IME 都走它。
- **草稿与答案分开**：焦点离开 Other 行不清空正文，回来接着改；没采用的草稿不进答案。单选与 Other 互斥，多选里 Other 是可独立取消的补充项——**把正文删空就是取消它**。
- **备注**：`n` 给当前题加备注，随答案一起回传，落在 `annotations[id].notes`。**只填备注不算作答**——本题仍需一个选择或非空 Other。
- **Chat about this**：单选时列表末尾有这一项，选中即结束整卡、返回 `kind: "chat"`，候选答案与草稿全部丢弃。它给的是「先不选，聊两句」的出口，多选与提交屏都没有它。
- **多题走标签栏**：顶部一行 `← ☒ 甲 ☐ 乙 ✔ 提交 →`，`Tab` 横向切换；一屏一题，末屏是提交屏，缺项会被挡回并定位到那一题；提交屏内容放不下时用 `↑↓` 翻看，末行标出还剩多少行。单题卡片不渲染标签栏，答完即结束。
- **全屏模式**：卡片以浮层方式打开，启动到挂载只此一条路径。代价是卡片开着期间宿主的视口滚动键也让给卡片，想回看转录得先取消卡片。
- **提交回执**：转录里只留「一行头 + 每题一条」的摘要（`· 题目 → 答案`），过长的答案截断并加省略号；完整答案仍在结构化结果里交给模型。
- **模式边界**：`json` / `print` 返回 `ui_unavailable`；RPC 仍用 Pi 的基础选择交互降级（多选拆成连续单选、标 `degraded`），拿不到标签栏、备注与 Chat。

### agent 定义

放在 `~/.pi/agent/agents/*.md`（用户级）或 `<repo>/.pi/agents/*.md`（项目级）：

```markdown
---
name: reviewer
description: 只挑刺，不改文件
tools: read, grep
model: claude-opus-5-5
---
你是 reviewer。只找问题，不写实现。
```

只认 `name` / `description` / `tools` / `model` 四个字段，正文就是系统提示。**没有 thinking level 字段**——那个只能由调用参数或父会话继承决定。

### 配合 spec-flow 用

审核档位的卡片、reviewer 的派出与结果回收可以直接表达成工具调用：

```
ask_user_question                  → 摆出审核档位卡
subagent(run_in_background: true)  → 派 reviewer；完成后运行时自动推一条终态把主会话叫醒
```

档位语义的唯一真相源是外部 spec-flow skill，插件只负责展示和回传。**插件不自动派 reviewer**——派发与裁决始终是用户和主 agent 的事。

⚠️ 插件**不强制**卡上必须有「文档检查」行和份数账行，也不认识「这是不是一张闸卡」——那两行要由**主 agent 写进问题的 `description` 里**。别以为摆个卡就自动合规了。

### 工具参数速查

`ask_user_question`：`questions[]`，每题 `{ id, question, header(≤12 字), multiSelect, options[2..4] }`；选项 `{ label, description }`。`id` 必填且题内唯一——答案以它作 key。`Other` 与 `Chat about this` 由卡片自动提供，两者都是保留字，别自己加。结果 `{ kind, answers, responses?, annotations? }`：`kind` 取值 `answered` / `chat` / `cancelled` / `busy` / `ui_unavailable` / `invalid_arguments`，`notes` 落在 `annotations[id].notes`。

`monitor`：`{ description, command? , task_id?, timeout_ms?, deliver? }`。`command` 与 `task_id` 二选一。`timeout_ms` 默认 300000、最大 1800000、`0` 表示持续，**只对 `command` 有效**。`deliver` 默认 `"digest"`（30 秒窗口合并），传 `"terminal"` 则进度完全不进上下文。

`subagent`：三种互斥形态——`{ agent, task, ... }`、`{ tasks: [...] }`（≤8 个）、`{ chain: [...] }`。可选 `cwd` / `run_in_background` / `model` / `thinking_level` / `isolation`（`"none"` \| `"worktree"`）/ `agentScope`（`"user"` 默认 \| `"project"` \| `"both"`）/ `confirmProjectAgents`。

`task_stop`：`{ task_id }`。传**已终态**的 id 返回终态快照并带 `alreadyFinished`（不算失败）；传**不存在**的 id 返回可识别的参数错误（`isError`）。

## 发布（可选）

`package.json` 里现在有 `"private": true` 防手滑。要发 npm 时去掉它，并保留 `pi-package` 关键字，才能进 [Pi package gallery](https://pi.dev/packages)。
