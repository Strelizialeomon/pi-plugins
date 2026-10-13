# Pi 工作流工具：选项卡、任务监控与 Subagent

- 日期：2026-10-13
- 项目：`pi-plugins`
- 类型：方案期 spec
- 状态：已实施（PR #3）
- Issue：#2
- 现状核对：2026-10-13，读取仓库文件、`git ls-tree`，并运行 `npm run check`、`npm test`

## 1. 背景

`pi-plugins` 目前只有插件集合骨架，没有实际插件。仓库已经约定每个插件放在 `extensions/<name>/index.ts`，由默认导出的工厂函数注册 Pi 命令、工具和生命周期监听；纯逻辑应拆到独立文件，测试用 Node 原生测试运行（`README.md:3-34`、`README.md:36-42`）。

当前工作流需要三个相互配合的能力：

1. 用结构化选项卡承载 spec-flow 的审核档位、机制选择和合并选择；
2. 让长时间运行的 shell 或子任务在后台产生事件，并主动通知主会话；
3. 在隔离上下文中运行一个或多个专用 subagent，支持前台、后台、并行和链式执行。

本 spec 以 Claude Code 2.1.296 的外部行为为参考，以 Pi **1.2.x** 的扩展 API 为落点（仓库声明 `^1.2.0`，本机 `pi --version` 为 1.2.0）。Claude Code 的内部运行时代码位于原生二进制中，本 spec 只固定可观察的工具契约和交互行为，不假设其内部实现。

## 2. 目标

新增一个 Pi 插件，提供以下模型可调用工具：

- `ask_user_question`：结构化选项卡；
- `monitor`：监听 shell 事件或插件内部任务事件；
- `subagent`：运行独立 Pi 子会话；
- `task_stop`：停止 monitor 或 subagent。

四个工具共享一个任务运行时，统一处理任务 ID、状态、输出、取消、超时、通知和会话结束清理。

完成后，spec-flow 的审核闸卡可以直接表达为结构化交互：用户点审核档位，**主 agent** 按该选择派出 reviewer subagent（插件只负责展示卡片与回传事件，不自行派发、也不替用户判档），monitor 接收完成事件，主会话得到带任务 ID 和结果摘要的通知。

## 3. 范围

### 3.1 本次包含

- 一个插件目录：`extensions/workflow-tools/`；
- 选项卡的单题、多题、单选、多选、自由输入和可选预览；
- shell stdout 按行产生事件的 monitor；
- subagent 完成、失败、停止和超时事件的内部监听；
- subagent 的单个、并行、链式执行；
- 前台等待和后台立即返回两种执行方式；
- subagent 的用户级 agent 定义，及显式开启的项目级 agent 定义；
- 子 Pi 的独立上下文、模型 / thinking level 继承与覆盖；
- AbortSignal、`task_stop`、`session_shutdown` 和 `/reload` 的清理；
- 工具调用、结果和后台状态的 TUI 渲染；
- 纯逻辑单测、类型检查和 README 使用说明。

### 3.2 本次不包含

- 远程云端 subagent；
- Monitor 的 WebSocket 输入；
- 跨 Pi 进程的任务持久化与恢复；
- 自动创建、合并或发布 PR；
- 自动替用户选择 spec-flow 审核档位；
- 将 subagent 结果宣称为独立第三方审核；
- 新增第三方依赖；
- 修改 Pi 核心或 fork Pi。

WebSocket、远程任务和任务恢复保留为后续扩展点，不进入本次验收。

## 4. 交互契约

### 4.1 `ask_user_question`

工具参数：

```ts
{
  questions: Array<{
    id: string;
    question: string;
    header: string;
    options: Array<{
      label: string;
      description: string;
      preview?: string;
    }>;
    multiSelect: boolean;
  }>;
}
```

约束：

- `questions` 至少 1 个、最多 4 个；
- 每题必传 `id`，题内唯一（不要求跨调用唯一）；`id` 是 `answers` 和 `annotations` 的 key，模型不得依赖完整问题文本作 key（两条文字相同的问题会互相覆盖）；
- 每个问题至少 2 个、最多 4 个选项；
- `header` 最多 12 个字符；
- 选项 label 保持短句，推荐项直接在 label 中写 `（推荐）`；
- `Other` 由卡片组件自动提供，不要求模型显式传入；
- `preview` 只作为当前选项的辅助预览，不进入默认答案文本；
- 同一会话同时只能有一个活动中的问题卡：工具以 `executionMode: "sequential"` 注册，第二个并发调用**立即返回可识别的 `busy` 结果**，不排队、不挤掉前一张卡；
- TUI 模式下使用自定义卡片；RPC 模式使用 Pi 支持的基础选择交互（RPC 侧只有单值 `select`），因此多选在 RPC 下降级为**按题连续单选**（每题末尾附一个「完成」项），`preview` 在 RPC 下丢弃并在 `annotations[id].degraded` 标记 `true`；JSON / print 模式返回结构化的 `ui_unavailable` 错误，不等待不存在的终端输入。

工具结果：

```ts
{
  answers: Record<string, string>;
  responses?: Record<string, string>;
  annotations?: Record<string, {
    preview?: string;
    notes?: string;
    degraded?: boolean;
  }>;
}
```

`answers` 用问题 `id` 作为 key；多选结果用逗号分隔。某题由 `Other` 自由输入回答时，同一 `id` 的原文同时写进 `answers[id]` 和 `responses[id]`（`answers` 供模型直接消费，`responses` 供需要逐题区分的场景）。`annotations` 的 key 与 `answers` 同构（同为 `id`）。用户取消时返回可识别的取消结果，主模型不得把取消解释成用户选择了某个选项。

### 4.2 `monitor`

工具参数：

```ts
{
  description: string;
  timeout_ms?: number;
  command?: string;
  task_id?: string;
  deliver?: "digest" | "terminal";
}
```

输入源只能二选一：

- `command`：启动 shell，stdout 每一行作为一个事件；
- `task_id`：监听插件内部登记的 subagent 或其他任务事件。

约束：

- `description` 用于用户通知和模型上下文；
- `timeout_ms` 默认 300000，最大 1800000；传 `0` 表示持续到任务结束或会话关闭。**`timeout_ms` 只对 `command` 模式有效**：`command` 模式自己持有生命周期，超时产生 `expired`；`task_id` 模式是订阅视图、不持有生命周期，不设自有超时，订阅随被订阅任务的终态结束（这条同时消掉「默认 5 分钟超时早于 10 分钟重审」的误报）；
- 没有输入源、同时传两种输入源、任务 ID 不存在，都返回参数错误；
- `task_id` 指向**已经终态**的任务时，立即返回该任务的终态快照并标记 `alreadyFinished: true`，不新建订阅、不等待；
- 单个事件写入任务环形缓冲，默认最多保留 200 行；单行进入模型上下文前限制为 4096 字符；
- 进上下文的投递策略写死：**终态事件必推且只推一条**，用 `pi.sendMessage(..., { triggerTurn: true })` —— 会话空闲时也会启动新回合唤醒模型；只 append 进会话、不启动回合的写法不算送达。**进度事件不逐行进上下文**，按 30 秒窗口合并成一条摘要（`deliver: "digest"`，默认）；`deliver: "terminal"` 时进度只落环形缓冲和日志文件、完全不进上下文。两者都不要求模型轮询或 sleep；
- 终态事件（`completed`、`failed`、`stopped` 或 `expired`）由任务运行时**统一发送一次**；`monitor(task_id)` 只是订阅视图，不产生第二条终态；
- 用户界面通过 `ctx.ui.notify()` 报告启动、异常、结束和超时，并用 `setStatus()` 显示活动任务数量和最近一行事件；
- shell 进程以**独立进程组**启动；取消与关闭时对**整个进程组**发信号，而不只是直接子进程（`npm test | tee log` 这类写法会把孙进程留在原地）；
- shell 进程关闭时必须关闭 stdout / stderr 监听器，并从任务注册表移除。

工具启动结果：

```ts
{
  taskId: string;
  status: "running" | "completed" | "failed" | "stopped" | "expired";
  timeoutMs?: number;
  persistent: boolean;
  alreadyFinished?: boolean;
}
```

`monitor` 是事件订阅器，不负责替模型反复执行查询命令。对于 subagent，应优先使用 `task_id` 内部事件源；只有外部进程没有接入任务运行时时才使用 `command`。

### 4.3 `subagent`

工具支持三种互斥模式：

```ts
// 单个
{
  agent: string;
  task: string;
  cwd?: string;
  run_in_background?: boolean;
  model?: string;
  thinking_level?: string;
  isolation?: "none" | "worktree";
  agentScope?: "user" | "project" | "both";
  confirmProjectAgents?: boolean;
}

// 并行
{
  agentScope?: "user" | "project" | "both";
  confirmProjectAgents?: boolean;
  tasks: Array<{
    agent: string;
    task: string;
    cwd?: string;
  }>;
}

// 链式
{
  agentScope?: "user" | "project" | "both";
  confirmProjectAgents?: boolean;
  chain: Array<{
    agent: string;
    task: string;
    cwd?: string;
  }>;
}
```

行为：

- agent 定义默认从 `~/.pi/agent/agents/*.md` 读取，`agentScope` 默认 `"user"`；项目级 agent 从 `<repo>/.pi/agents/*.md` 读取，只有显式传 `agentScope: "project" | "both"` 才参与；
- 项目级 agent 启用前必须通过 Pi 的项目可信判断；`confirmProjectAgents` 默认 `true`（遇到项目级 agent 先向用户确认），传 `false` 表示调用方已自行承担该信任决定；
- agent 定义提供名称、描述、可用工具和可选模型，正文作为系统提示 —— 这四项就是 Pi agent 文件格式当前解析的全部字段，**没有 thinking level 字段**；thinking level 只能由调用参数或父会话继承决定；
- 子会话通过独立 Pi 进程启动，使用 `--mode json -p --no-session`；
- 没有显式覆盖时继承父会话当前 provider/model/thinking level；
- agent 的系统提示写入权限为 600 的临时文件，通过 `--append-system-prompt` 传给子 Pi，任务结束后删除；
- `run_in_background: false` 时工具等待子会话完成并返回结果；
- `run_in_background: true` 时立即返回 `taskId`；子会话完成后由**任务运行时**统一发一条终态（`triggerTurn: true`），`subagent` 自身不再另推一条；
- 并发上限按**会话级**计：同一会话内**所有任务（monitor 与 subagent 合计）最多 8 个**；其中**「同时最多 4 个在运行」只约束 subagent**——它要新起子 Pi 进程，超出并发槽的 subagent 排队并在结果里报告排位，monitor 不受该名额约束。一次调用本身就要超过 8 个任务时直接返回 `concurrency_exceeded`。任一任务失败不取消其他任务，最终结果逐任务报告；
- 链式任务按顺序执行，前一步的最终文本通过 `{previous}` 注入下一步；中间步骤失败时停止后续步骤；
- `isolation: "worktree"` 只在显式请求时创建独立 worktree，并在结果中返回路径；存在未提交改动时不得自动删除 worktree；
- Ctrl+C 或工具信号取消时，向子 Pi 所在的**独立进程组**发送 SIGTERM，5 秒后仍未退出再对整个进程组发送 SIGKILL；
- 结果包含任务状态、最终文本、模型、耗时、token / cost 摘要、工具调用数量和 stderr 摘要。

并行结果向模型返回简短摘要，完整输出保存在任务详情和日志文件中，避免一次性撑大主上下文。

### 4.4 `task_stop`

参数：

```ts
{
  task_id: string;
}
```

行为：

- 可停止 monitor 或 subagent；
- 对 shell 进程**所在的整个进程组**先发 SIGTERM，5 秒后仍未退出再发 SIGKILL（与 §4.3 同一策略）；
- 对子 Pi 传播 AbortSignal，并按同一进程组策略终止；
- 停止结果写入任务详情，并由任务运行时统一发送一条 `stopped` 终态；
- `task_id` 不存在时返回参数错误；任务已处于终态时返回该终态快照并标记 `alreadyFinished: true`，不当作错误；
- 不自动删除含未提交改动的 worktree。

## 5. 任务运行时

任务运行时是本功能的唯一生命周期管理点。它至少维护：

```ts
interface WorkflowTask {
  id: string;
  kind: "monitor" | "subagent";
  status: "running" | "completed" | "failed" | "stopped" | "expired";
  description: string;
  startedAt: number;
  deadline?: number;
  outputFile?: string;
  worktreePath?: string;
}
```

运行时必须提供：

- 原子生成任务 ID；
- 查询、追加事件、结束和停止；
- 每任务独立 AbortController，以及**会话级**并发信号量：任务总数上限 8（monitor 与 subagent 合计）；「同时最多 4 个在运行」只约束 subagent，monitor 不受该名额约束；
- 环形输出缓冲和完整日志文件；
- `task_id` 到 monitor / subagent 的事件订阅；订阅已终态任务时立即回放终态快照并标记 `alreadyFinished: true`，不新建订阅；
- **终态唯一发送点**：每个任务从运行态转入终态时恰好发一条终态事件（`triggerTurn: true`），重复的 close、abort、timeout 必须幂等，订阅者不产生第二条；
- 进度事件先过投递窗口（默认 30 秒）合并后才可能进模型上下文，`deliver: "terminal"` 时完全不进；
- 所有子进程以独立进程组启动，取消和清理对进程组发信号，而不只是直接子进程；
- 会话进入收尾（`session_shutdown`、`/reload`、`/new`、`/resume`、`/fork`）时的顺序写死：先置 `shuttingDown` 状态位并**拒绝新的 spawn**，再停止所有存活任务、对每个进程组发信号，并 await 到进程真正退出才算清理完成；收尾期开始后到达的推送直接丢弃，不写进已被替换的旧会话；
- `/reload` 后旧运行时不再使用，避免旧 `ctx` 和进程泄漏。

## 6. 与 spec-flow 的使用方式

### 6.1 审核档位卡

`ask_user_question` 的卡模板只固定**展示形态**；档位语义的唯一真相源是外部 spec-flow skill（`~/.claude/skills/spec-flow/SKILL.md`），插件不内嵌、不复制四档定义——外部 skill 改了档位，卡片文案跟着改，不另建同步机制：

- 卡上承载 2～4 个档位选项，默认文案取外部 skill 的四档（不审 / 轻审 / 重审 / 重审 + 变异）；
- 卡上必须含固定一行「文档检查：绿 / 红+摘要 / 无入口」；
- 一份以上交付物时，卡上必须含份数账「本次 N 份 × 该档 = 约 X 个 agent / Y 分钟」，并写明批次成员（PR / 分支清单）。

工具只负责展示和返回选择，不替用户判断档位，也不自动沿用上一次选择；档位定了之后由**主 agent** 派 reviewer，插件不派。

### 6.2 交付物完成监控

主 agent 派出后台 reviewer 后：

1. `subagent(run_in_background: true)` 返回任务 ID；
2. **不需要**再发 `monitor(task_id)` 去等它完成——任务运行时在终态时会直接推一条（`triggerTurn: true`），会话空闲也会被唤醒；
3. 只有中途想看进度时才 `monitor(task_id)`（可选；它只产生订阅、不产生第二条终态）；
4. reviewer 的终态、以及可选的进度摘要，通过 custom message 回到主会话；
5. 主 agent 汇总所有 reviewer 结果；
6. 用户仍需单独决定“改 / 不改”和是否合并。

超时别踩坑：`monitor(command=...)` 的默认 `timeout_ms` 是 5 分钟，短于重审自报的约 10 分钟；要盯满全程就显式调到 600000 以上，或改用 `task_id` 订阅（后者不受 `timeout_ms` 约束）。

Subagent 是当前主 agent 的执行分身。插件可以提供多个 reviewer 角色和不同提示词，但不把它们描述为独立第三方裁决。

## 7. 现状文件与预期落点

当前仓库的插件入口和开发约定：

- `README.md:3-13`：插件目录和 package 结构；
- `README.md:22-34`：扩展注册方式和逻辑 / 接线分离约定；
- `README.md:36-59`：检查命令、Pi 安装方式和 peer dependency 规则；
- `package.json:18-35`：`npm test`、`npm run check`、Node 版本和 Pi 包依赖；
- `extensions/`：当前没有实际插件，仅有 `.gitkeep`。

实现阶段预期新增：

```text
extensions/workflow-tools/index.ts
extensions/workflow-tools/task-runtime.ts
extensions/workflow-tools/question-card.ts
extensions/workflow-tools/monitor.ts
extensions/workflow-tools/subagent.ts
extensions/workflow-tools/renderers.ts
extensions/workflow-tools/*.test.ts
```

README 需要增加安装、启用、工具参数和 spec-flow 使用示例。根 `package.json` 不新增 Pi 运行时依赖；已有 Pi 包继续只放在 `peerDependencies` 和本地类型检查用的 `devDependencies`。

## 8. 验收标准

### 8.1 选项卡

- [ ] 单选问题可用方向键和 Enter 完成；
- [ ] 多选问题可用空格切换并返回逗号分隔答案；
- [ ] 1～4 个问题可以切换，返回顺序稳定，`answers` / `annotations` 的 key 是模型传入的 `id`；
- [ ] `Other` 可以进入自由输入，并同时写入 `answers[id]` 和 `responses[id]`；
- [ ] 预览只跟随当前选项，提交后可在 `annotations[id].preview` 中取得；
- [ ] 取消、无 UI、非法参数、并发调用均有可识别结果（并发那一路返回 `busy`，不排队、不覆盖前一张卡）；
- [ ] RPC 模式下多选按题连续单选降级，`preview` 丢弃且 `annotations[id].degraded` 为 `true`；
- [ ] spec-flow 审核卡能承载 2～4 个档位选项，并强制带上「文档检查」行与份数账行（用固定样例卡人工比对 SKILL.md；Pi 侧当前没有 spec-flow skill，这条不做端到端自动化）。

### 8.2 Monitor

- [ ] 启动 shell watcher 后立即返回唯一 `taskId`；
- [ ] stdout 每行可转成一个事件；
- [ ] 内部 subagent 状态可通过 `task_id` 订阅；订阅已终态任务时立即回放终态快照并带 `alreadyFinished: true`，不挂到超时；
- [ ] **会话空闲时也能收到终态**：后台派任务 → 回合结束 → 等任务跑完，期间不敲任何输入，模型仍被唤醒并拿到终态（`triggerTurn: true`）；
- [ ] 任务完成、失败、停止、超时各只产生一个终态；同时挂 `subagent` 自带通知和 `monitor(task_id)` 订阅，仍只收到一条；
- [ ] `task_stop` 可以停止存活 monitor；
- [ ] 上下文不被灌爆，可量化：`deliver: "terminal"` 下 10 万行输出只产生 1 条进模型的消息；默认 `deliver: "digest"` 下进模型的消息数 ≤ ⌈运行时长 / 30s⌉ + 1；
- [ ] session shutdown 和 `/reload` 不遗留子进程：事后 `pgrep -g <进程组>` 查为空（含 `cmd | tee log` 这类孙进程）；
- [ ] 收尾期内的 spawn 被拒绝，不会留下注册表之外的孤儿进程。

### 8.3 Subagent

- [ ] 单个任务能在独立 Pi 上完成并返回最终文本；
- [ ] 子会话默认继承父模型和 thinking level，显式参数可以覆盖；
- [ ] 可配置 agent system prompt 和工具集合（agent 文件本身不提供 thinking level，该值只能来自参数或继承）；
- [ ] 项目级 agent 默认不生效：不传 `agentScope` 时 `<repo>/.pi/agents/*.md` 里的 agent 不参与；传 `agentScope: "project"` 且 `confirmProjectAgents` 缺省时先过信任确认；
- [ ] 并发上限是会话级：一条消息里发两个 `subagent(tasks: [8])`，第二个调用按会话信号量受限，不会起满 8 个进程；单次调用超过 8 个任务返回 `concurrency_exceeded`；monitor 只占 8 个任务位、不受「4 个在运行」约束，起完立即返回 `taskId`；
- [ ] 链式模式把 `{previous}` 替换为前一步结果，失败时停止后续；
- [ ] 后台模式立即返回任务 ID，完成后由运行时推一条终态通知主会话；
- [ ] 取消能终止子 Pi 所在的整个进程组，`pgrep` 查不到孤儿进程；
- [ ] worktree 模式不会误删未提交改动。

### 8.4 工程质量

- [ ] `npm run check` 通过；
- [ ] `npm test` 通过；
- [ ] 纯逻辑状态转换、任务终态幂等、参数校验和并发限制有单测；
- [ ] TUI 交互通过手工 smoke test；
- [ ] README 的安装方式和实际 package 目录一致；
- [ ] 不新增第三方运行时依赖。

## 9. 机制清单

| 机制 | 解决什么 | 没有它会怎样 |
|---|---|---|
| TaskRuntime | 统一管理 monitor 和 subagent 的 ID、状态、取消、清理和**会话级并发信号量**（8 个任务合计；4-running 只约束 subagent）；是终态的唯一发送点 | 两种后台任务各自维护生命周期，容易重复通知和泄漏进程 |
| Push bridge | 用 `triggerTurn: true` 把终态主动送回主会话（会话空闲也唤醒），而不是只 append 进队列 | 主模型只能轮询，长任务会占住回合或丢失完成通知 |
| Delivery digest | 进度事件按 30 秒窗口合并；`deliver: "terminal"` 可完全关掉进度投递 | 每秒多行的日志会生成等量模型消息，上下文和回合数爆炸 |
| Context guard | 环形缓冲（200 行）+ 单行截断（4096 字符）限制缓冲与回放量 | 长任务日志无上限增长，查询时一次性撑大上下文 |
| Mode fallback | TUI / RPC / JSON 三档交互降级：RPC 多选拆成连续单选，JSON 返回 `ui_unavailable` | 非 TUI 环境下卡片挂死等一个不存在的终端，模型拿到的答案形状还不一致 |
| Agent profile | 为 reviewer、scout、worker 配不同提示词和工具 | 所有 subagent 能力相同，无法限制审核范围 |
| Agent trust gate | 项目级 agent 默认不参与，须显式 `agentScope` 加可信确认 | 仓库里的 agent 文件能悄悄改变子会话行为，等于把项目目录当可信源 |
| Process group | 子进程以独立进程组启动，取消和清理对整组发信号 | `cmd \| tee log` 这类孙进程逃过 SIGTERM，变成孤儿 |
| Question card | 将拍板动作变成结构化答案；`answers` 以模型给定的 `id` 为 key | 用户需要手打选项，答案难以稳定解析；问题文本相同的两条会互相覆盖 |
| Worktree guard | 保护需要写文件的子 agent 和用户改动 | 子 agent 可能互相覆盖或误删未提交成果 |

## 10. 自定细节

以下是本 spec 未由用户另行指定、由本方案固定的细节（编号在本轮审核修订后重排）：

1. 插件目录名为 `extensions/workflow-tools/`。
2. 工具名为 `ask_user_question`、`monitor`、`subagent`、`task_stop`。
3. 选项卡数量上限：单个问题最多 4 个选项，多题最多 4 题，`header` 最多 12 个字符；与 Claude Code 的公开工具契约一致。
4. 题目标识改用模型传入的 `id`（Claude Code 用完整问题文本作 key，本方案在这一点上偏离：两条文字相同的问题会互相覆盖）；`answers` / `responses` / `annotations` 一律以 `id` 为 key。
5. `ask_user_question` 以 `executionMode: "sequential"` 注册，并发调用返回 `busy`，不排队、不覆盖前一张卡。
6. RPC 降级契约：多选拆成按题连续单选（每题末尾附一个「完成」项），`preview` 丢弃并置 `annotations[id].degraded = true`；JSON / print 模式返回 `ui_unavailable`。
7. monitor 默认超时 5 分钟，最大 30 分钟；`timeout_ms: 0` 表示持续任务。该参数**只对 `command` 模式有效**，`task_id` 订阅不受它约束——这正是「默认 5 分钟超时早于 10 分钟重审」那个坑的解。
8. 进上下文的投递：终态恒推一条且带 `triggerTurn: true`；`deliver` 默认 `"digest"`，进度事件按 30 秒窗口合并；`deliver: "terminal"` 时进度完全不进上下文。
9. monitor 环形缓冲保存最近 200 行，单行进入上下文最多 4096 字符。
10. 并发上限按**会话级**计：任务总数最多 8（monitor 与 subagent 合计）。其中「同时最多 4 个在运行」只约束 subagent，超出并发槽的 subagent 排队并在结果里报告排位；monitor 不受该名额约束，起完立即返回 `taskId`。单次调用超过 8 个任务返回 `concurrency_exceeded`。
11. subagent 默认继承父会话的 provider、model 和 thinking level；只有显式参数才覆盖。agent 文件格式本身不含 thinking level 字段。
12. 项目级 agent 位于 `<repo>/.pi/agents/*.md`，默认不启用（`agentScope` 缺省为 `"user"`）；启用须通过 Pi 的项目可信判断，`confirmProjectAgents` 默认 `true`。
13. `isolation: "worktree"` 只由调用方显式开启；任务结束时不自动删除有未提交改动的 worktree。
14. 子进程以独立进程组启动；取消和清理对整个进程组发 SIGTERM，5 秒后未退出再发 SIGKILL。
15. 会话收尾顺序写死：先置 `shuttingDown` 并拒绝新 spawn，再停任务、对进程组发信号并 await 到进程真正退出；收尾期开始后到达的推送直接丢弃。
16. 本次只做 shell 和内部 task 事件，WebSocket、远程 agent、任务恢复留到后续 spec。
17. 任务事件以 custom message 进入模型上下文，以 status / notify 呈现给用户。
18. 本次交付只新增 spec 和必要的 worktree 忽略规则，不实现代码，不创建 issue，不合并 PR。审核档位由用户在闸卡上点，不由方案预设。

## 11. 审核修订记录

2026-10-13，用户在闸卡上点「重审」（1 份 × 2 个 agent）。两份审核结论原样贴在 PR #1 评论：

- 规格符合性审核 8 条（0 严重 / 4 中 / 4 轻）；
- 对抗式设计审核 16 条（4 严重 / 9 中 / 3 轻）。

用户点选修订范围「严重 + 中」共 17 条，处置如下：

| # | 严重度 | 发现 | 处置 |
|---|---|---|---|
| 1 | 严重 | 终态只 append 进会话、不启动回合，会话空闲时模型收不到完成事件（全篇缺 `triggerTurn`） | 已改：§4.2 投递策略、§4.3 后台完成、§5 运行时、§6.2 步骤、§8.2 验收、§9 Push bridge |
| 2 | 严重 | 同一次完成推两条终态；monitor 默认超时 5 分钟短于重审的 10 分钟，会误报 `expired` | 已改：终态由运行时唯一发送、订阅不产生第二条；`timeout_ms` 只对 `command` 模式有效；§6.2 不再要求必发 monitor |
| 3 | 严重 | 订阅一个已终态的任务，行为未定义 | 已改：§4.2 / §4.4 / §5 规定立即回放终态快照并标记 `alreadyFinished`，§8.2 加验收 |
| 4 | 严重 | 每条事件都永久进模型上下文，`tail -f` 类监控灌爆上下文；原验收无论实现多烂都显示通过 | 已改：新增 `deliver` 参数（默认 `digest`，30 秒窗口合并；`terminal` 时进度完全不进），§8.2 改为可量化验收 |
| 5 | 中 | 同一条消息里并发两个 `ask_user_question` 的行为未定义 | 已改：`executionMode: "sequential"`，第二个调用返回 `busy`，§8.1 加验收 |
| 6 | 中 | RPC 只有单值 `select`，多选与 preview 没有降级契约 | 已改：RPC 多选拆成连续单选、preview 丢弃并置 `degraded`，§8.1 加验收 |
| 7 | 中 | `answers` 以问题文本为 key 会互相覆盖；`response` 是单值无法区分题目；`annotations` 的 key 未定义 | 已改：改用模型传入的 `id` 作 key，`response` 改为按 id 索引的 `responses`，偏离理由记进 §10 第 4 条 |
| 8 | 中 | `agentScope` 不在任何 schema；项目级 agent 目录未写出；§8 无对应验收 | 已改：三份 schema 补 `agentScope` / `confirmProjectAgents`，写出 `.pi/agents/*.md`，§8.3 加验收 |
| 9 | 中 | §2 写「插件按选择派出 reviewer」，与 §6.1、§10 及外部 spec-flow 硬规矩冲突 | 已改：§2 改为由主 agent 派发，插件只出卡片与回传事件 |
| 10 | 中 | 闸卡模板缺「文档检查」行与份数账；四档语义被复制进插件会漂；Pi 侧没有 spec-flow skill | 已改：§6.1 改为只固定展示形态、语义以外部 skill 为唯一真相源，两行列为必填；§8.1 改为人工比对 |
| 11 | 中 | 只 kill 直接子进程，孙进程逃过清理 | 已改：独立进程组加整组信号，§4.2 / §4.3 / §4.4 / §5 同步，§8.2 / §8.3 改为 `pgrep` 可数判定 |
| 12 | 中 | spawn 途中 shutdown 会漏掉未登记的进程；迟到的推送会写进已被替换的旧会话 | 已改：§5 写入 `shuttingDown` 收尾顺序（拒绝新 spawn、await 进程退出、丢弃迟到推送），§8.2 加验收 |
| 13 | 中 | 并发上限 8 / 4 未说明是每次调用还是整会话，超限行为也未定义 | 已改：锚到会话级信号量，超出排队并报告排位，单次超过 8 个返回 `concurrency_exceeded` |
| 14 | 中 | 版本基线写成 Pi 1.1.x，仓库实际是 1.2.0 | 已改：§1 改为 1.2.x |
| 15 | 中 | 断言 follow-up 队列能主动通知主会话，与 Pi 投递语义不符 | 与 #1 同一根因，同一处处置 |
| 16 | 中 | agent 定义被写成提供「可选 thinking level」，Pi agent 格式没有该字段 | 已改：§4.3 与 §8.3 写明该值只能来自调用参数或父会话继承 |
| 17 | 中 | 机制清单漏报：交互模式降级、上下文保护、项目级可信门 | 已改：§9 补 Mode fallback / Context guard / Agent trust gate / Delivery digest 四行 |
| 附 | 轻 | `task_stop` 传入不存在或已终态的 `id` 行为未定义（原列轻档，与 #3 属同一判据） | 已改：§4.4 一并定义 |

轻档还剩 4 条本轮未动，留待实施期处理：`isolation` 只存在于单个模式（与 §9 Worktree guard 的适用范围不匹配）、子进程未带 `-ne/-nc/--no-mcp` 等资源开关（子会话的“独立上下文”并不彻底）、`outputFile` 的落点与保留期未定义且命名风格 snake / camel 混用、§7 落点清单缺 TypeBox（工具 schema 必需，仓库未声明）。

### 口径澄清（实施后真机测试发现）

上表第 13 条的「锚到会话级信号量」写得含糊，实施与真机测试暴露出两种读法。现明确，并同步 §4.3 / §5 / §8.3 / §9 / §10.10：

- **8 个任务**是会话级的，monitor 与 subagent **合计**；
- **「同时最多 4 个在运行」只约束 subagent** —— 它要新起子 Pi 进程，超出排队并在结果里报告排位；
- **monitor 不受 4 这个名额约束**，起完立即返回 `taskId`（§4.2 的「立即返回」优先）。

真机实测：同时 7 个 `sleep` 存活、第 9 个任务被拒——这正是上述口径生效时的预期表现，不是缺陷。
