# Pi 工作流工具：选项卡、任务监控与 Subagent

- 日期：2026-10-13
- 项目：`pi-plugins`
- 类型：方案期 spec
- 状态：待实施
- 现状核对：2026-10-13，读取仓库文件、`git ls-tree`，并运行 `npm run check`、`npm test`

## 1. 背景

`pi-plugins` 目前只有插件集合骨架，没有实际插件。仓库已经约定每个插件放在 `extensions/<name>/index.ts`，由默认导出的工厂函数注册 Pi 命令、工具和生命周期监听；纯逻辑应拆到独立文件，测试用 Node 原生测试运行（`README.md:3-34`、`README.md:36-42`）。

当前工作流需要三个相互配合的能力：

1. 用结构化选项卡承载 spec-flow 的审核档位、机制选择和合并选择；
2. 让长时间运行的 shell 或子任务在后台产生事件，并主动通知主会话；
3. 在隔离上下文中运行一个或多个专用 subagent，支持前台、后台、并行和链式执行。

本 spec 以 Claude Code 2.1.296 的外部行为为参考，以 Pi 1.1.x 的扩展 API 为落点。Claude Code 的内部运行时代码位于原生二进制中，本 spec 只固定可观察的工具契约和交互行为，不假设其内部实现。

## 2. 目标

新增一个 Pi 插件，提供以下模型可调用工具：

- `ask_user_question`：结构化选项卡；
- `monitor`：监听 shell 事件或插件内部任务事件；
- `subagent`：运行独立 Pi 子会话；
- `task_stop`：停止 monitor 或 subagent。

四个工具共享一个任务运行时，统一处理任务 ID、状态、输出、取消、超时、通知和会话结束清理。

完成后，spec-flow 的审核闸卡可以直接表达为结构化交互：用户点审核档位，插件按选择派出 reviewer subagent，monitor 接收完成事件，主会话得到带任务 ID 和结果摘要的通知。

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
- 每个问题至少 2 个、最多 4 个选项；
- `header` 最多 12 个字符；
- 选项 label 保持短句，推荐项直接在 label 中写 `（推荐）`；
- `Other` 由卡片组件自动提供，不要求模型显式传入；
- `preview` 只作为当前选项的辅助预览，不进入默认答案文本；
- 同一会话同时只能有一个活动中的问题卡；
- TUI 模式下使用自定义卡片；RPC 模式使用 Pi 支持的基础选择交互；JSON / print 模式返回结构化的 `ui_unavailable` 错误，不等待不存在的终端输入。

工具结果：

```ts
{
  answers: Record<string, string>;
  response?: string;
  annotations?: Record<string, {
    preview?: string;
    notes?: string;
  }>;
}
```

`answers` 用完整问题文本作为 key；多选结果用逗号分隔。用户取消时返回可识别的取消结果，主模型不得把取消解释成用户选择了某个选项。

### 4.2 `monitor`

工具参数：

```ts
{
  description: string;
  timeout_ms?: number;
  command?: string;
  task_id?: string;
}
```

输入源只能二选一：

- `command`：启动 shell，stdout 每一行作为一个事件；
- `task_id`：监听插件内部登记的 subagent 或其他任务事件。

约束：

- `description` 用于用户通知和模型上下文；
- `timeout_ms` 默认 300000，最大 1800000；传 `0` 表示持续到任务结束或会话关闭；
- 没有输入源、同时传两种输入源、任务 ID 不存在，都返回参数错误；
- 单个事件写入任务环形缓冲，默认最多保留 200 行；单行进入模型上下文前限制为 4096 字符；
- 事件通过 `pi.sendMessage()` 送回主会话，使用 follow-up 队列，不要求模型轮询或 sleep；
- 用户界面通过 `ctx.ui.notify()` 报告启动、异常、结束和超时，并用 `setStatus()` 显示活动任务数量；
- 任务结束时发送终态事件：`completed`、`failed`、`stopped` 或 `expired`；
- shell 进程关闭时必须关闭 stdout / stderr 监听器，并从任务注册表移除。

工具启动结果：

```ts
{
  taskId: string;
  status: "running";
  timeoutMs: number;
  persistent: boolean;
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
}

// 并行
{
  tasks: Array<{
    agent: string;
    task: string;
    cwd?: string;
  }>;
}

// 链式
{
  chain: Array<{
    agent: string;
    task: string;
    cwd?: string;
  }>;
}
```

行为：

- agent 定义默认从 `~/.pi/agent/agents/*.md` 读取；项目级 agent 只有显式开启 `agentScope: "project" | "both"` 才参与；
- agent 定义提供名称、描述、系统提示、可用工具、可选模型和可选 thinking level；
- 子会话通过独立 Pi 进程启动，使用 `--mode json -p --no-session`；
- 没有显式覆盖时继承父会话当前 provider/model/thinking level；
- agent 的系统提示写入权限为 600 的临时文件，通过 `--append-system-prompt` 传给子 Pi，任务结束后删除；
- `run_in_background: false` 时工具等待子会话完成并返回结果；
- `run_in_background: true` 时立即返回 `taskId`，子会话完成后通过内部事件和 `pi.sendMessage()` 通知主会话；
- 并行最多 8 个任务，同时最多运行 4 个；任一任务失败不取消其他任务，最终结果逐任务报告；
- 链式任务按顺序执行，前一步的最终文本通过 `{previous}` 注入下一步；中间步骤失败时停止后续步骤；
- `isolation: "worktree"` 只在显式请求时创建独立 worktree，并在结果中返回路径；存在未提交改动时不得自动删除 worktree；
- Ctrl+C 或工具信号取消时，向子 Pi 发送 SIGTERM，5 秒后仍未退出再发送 SIGKILL；
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
- 对 shell 进程先发 SIGTERM，再按统一取消策略处理；
- 对子 Pi 传播 AbortSignal；
- 停止结果写入任务详情，并向主会话发送 `stopped` 事件；
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
- 每任务独立 AbortController；
- 环形输出缓冲和完整日志文件；
- `task_id` 到 monitor / subagent 的事件订阅；
- 会话结束时停止所有存活任务；
- `/reload` 后旧运行时不再使用，避免旧 `ctx` 和进程泄漏；
- 任务完成后只发送一次终态通知；重复的 close、abort、timeout 必须幂等。

## 6. 与 spec-flow 的使用方式

### 6.1 审核档位卡

`ask_user_question` 固定支持以下模板：

- 不审：主 agent 自查 diff 和范围；
- 轻审：派 1 个 reviewer；
- 重审：派 2 个 reviewer；
- 重审 + 变异：派 2 个 reviewer，再运行一次变异检查。

工具只负责展示和返回选择，不替用户判断档位，也不自动沿用上一次选择。

### 6.2 交付物完成监控

主 agent 派出后台 reviewer 后：

1. `subagent` 返回任务 ID；
2. `monitor(task_id)` 注册内部事件订阅；
3. reviewer 的进度和终态通过 custom message 回到主会话；
4. 主 agent 汇总所有 reviewer 结果；
5. 用户仍需单独决定“改 / 不改”和是否合并。

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
- [ ] 1～4 个问题可以切换，返回顺序稳定；
- [ ] `Other` 可以进入自由输入，并返回 `response`；
- [ ] 预览只跟随当前选项，提交后可在 `annotations` 中取得；
- [ ] 取消、无 UI、非法参数均有可识别结果；
- [ ] spec-flow 审核四档可以用一个问题卡完成。

### 8.2 Monitor

- [ ] 启动 shell watcher 后立即返回唯一 `taskId`；
- [ ] stdout 每行可转成一个事件；
- [ ] 内部 subagent 状态可通过 `task_id` 订阅；
- [ ] 事件会主动送回主会话，不需要模型轮询；
- [ ] 任务完成、失败、停止、超时各只产生一个终态；
- [ ] `task_stop` 可以停止存活 monitor；
- [ ] session shutdown 和 `/reload` 不遗留子进程；
- [ ] 环形缓冲和单行截断防止日志无限进入上下文。

### 8.3 Subagent

- [ ] 单个任务能在独立 Pi 上完成并返回最终文本；
- [ ] 子会话默认继承父模型和 thinking level，显式参数可以覆盖；
- [ ] 可配置 agent system prompt 和工具集合；
- [ ] 并行模式最多 8 个任务、最多 4 个同时运行，并逐项报告结果；
- [ ] 链式模式把 `{previous}` 替换为前一步结果，失败时停止后续；
- [ ] 后台模式立即返回任务 ID，完成后能通过 monitor / custom message 通知主会话；
- [ ] 取消能终止子 Pi，不留下孤儿进程；
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
| TaskRuntime | 统一管理 monitor 和 subagent 的 ID、状态、取消和清理 | 两种后台任务各自维护生命周期，容易重复通知和泄漏进程 |
| Push bridge | 将后台事件主动送回主会话 | 主模型只能轮询，长任务会占住回合或丢失完成通知 |
| Agent profile | 为 reviewer、scout、worker 配不同提示词和工具 | 所有 subagent 能力相同，无法限制审核范围 |
| Question card | 将拍板动作变成结构化答案 | 用户需要手打选项，答案难以稳定解析 |
| Worktree guard | 保护需要写文件的子 agent 和用户改动 | 子 agent 可能互相覆盖或误删未提交成果 |

## 10. 自定细节

以下是本 spec 未由用户另行指定、由本方案固定的细节：

1. 插件目录名为 `extensions/workflow-tools/`。
2. 工具名为 `ask_user_question`、`monitor`、`subagent`、`task_stop`。
3. 单个问题最多 4 个选项，多题最多 4 题；这与 Claude Code 的公开工具契约一致。
4. monitor 默认超时 5 分钟，最大 30 分钟；`timeout_ms: 0` 表示持续任务。
5. monitor 环形缓冲保存最近 200 行，单行进入上下文最多 4096 字符。
6. 并行 subagent 最多 8 个任务，同时最多 4 个进程。
7. subagent 默认继承父会话的 provider、model 和 thinking level；只有显式参数才覆盖。
8. project agent 默认不启用；启用前必须通过 Pi 的项目可信判断，或由调用参数显式确认。
9. `isolation: "worktree"` 只由调用方显式开启；任务结束时不自动删除有未提交改动的 worktree。
10. 本次只做 shell 和内部 task 事件，WebSocket、远程 agent、任务恢复留到后续 spec。
11. 任务事件以 custom message 进入模型上下文，以 status / notify 呈现给用户；不把每一条事件都永久写成独立普通用户消息。
12. 本次交付只新增 spec 和必要的 worktree 忽略规则，不实现代码，不创建 issue，不合并 PR，不做审核。
