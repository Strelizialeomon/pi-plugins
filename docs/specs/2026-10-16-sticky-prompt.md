# 上一条用户输入吸顶（Sticky Prompt）

- 日期：2026-10-16
- 类型：方案期 spec
- 状态：待审
- Issue：（待 spec 合并后开）
- 现状基线：`3b21a24`（main）
- 适用环境：Pi 1.2.x 全屏终端交互模式（`tuiMode: "fullscreen"`，Pi 的默认值）
- 前序规格：无（本文件不改任何既有规格）
- 用户确认：本轮三轮拍板——**路线**「本仓自建，一次做全」；**形态**「一行摘要（Claude Code 同款）」；**机制**「6 条全要」。

## 1. 目标

在全屏 TUI 的 transcript 区顶部常驻一行，显示**最近一条已完全滚出视口顶部的用户提问**的摘要。

1. 某条提问整条滚出视口顶之后，吸顶行出现，显示该提问的摘要。
2. 继续上滚越过更早的提问，吸顶行换成更早那条。
3. 点击吸顶行，视口滚回那条提问的顶部。
4. 滚回底部（跟随最新输出）时吸顶行消失。
5. 纯展示：不写入会话、不进模型上下文、不改任何既有行为。
6. 关掉开关后完全无副作用——根布局回归原状，不留痕迹。

本文件定义需求、行为和验收，不编排实施任务或提交顺序。

## 2. 一手依据（本机安装的 Pi 1.2.x）

| 结论 | 当场核对的依据 |
|---|---|
| Pi **没有** sticky / 置顶行原语 | `pi-coding-agent/docs/tui.md:38` 只有 `- \`ScrollView\` provides a bounded scrollable viewport.`；该文件全文没有 sticky / pinned 字样 |
| 全屏下 transcript 与 dock 是**兄弟节点**，不在同一个滚动容器里 | `dist/modes/interactive/chat-viewport.js:4` `new ScrollView(options.document, { follow: "end", primary: true, overscroll: "chain", ... })`；`:12` dock 的 `VStack`；`:22` root `VStack([{component: transcript, basis:0, grow:1, ...}, {component: dock, basis:"auto", grow:0, ...}])` |
| 根布局可在运行时改写 | `pi-tui/dist/tui.d.ts:249` `interface ViewportTUI extends TUI`、`:251` `setLayoutRoot(component: Component \| undefined): void`；`TuiAltScreen` 实现了它（`tui-alt-screen.d.ts:97`） |
| 扩展拿到的 `tui` 是**指向活渲染器的 Proxy**，私有成员运行时可达 | `interactive-mode.js:383` `this.ui = createInteractiveTuiReference(() => this.renderer)`；`tui-renderer.js:37-70` 的 `get` 陷阱里是 `Reflect.get(tui, property, tui)`（TS 的 `private` 编译后不存在，故私有方法同样可读） |
| 扩展的两条入口都拿到这个 Proxy | `setWidget` 的工厂：`interactive-mode.js:1881` `component = content(this.ui, theme)`；`custom` 的工厂：`:2354` `Promise.resolve(factory(this.ui, theme, this.keybindings, close))` |
| **用户提问的渲染组件是包根公开导出的**，可直接 `instanceof` | `dist/index.d.ts:36` 导出 `UserMessageComponent`（同列表还有 `AssistantMessageComponent`）；`index.js:42` 同 |
| 提问正文就存在该组件实例上 | `dist/modes/interactive/components/user-message.js:17` `this.text = text`；构造签名 `(text: string, markdownTheme?, outputPad?, markdownTransformers?)` |
| 该组件 `render()` 在首行前缀 OSC 133 zone 标记 | 同文件 `:45` `lines[0] = OSC133_ZONE_START + lines[0]` |
| ⚠️ **OSC 133 的 `\x1b]133;A` 不是用户提问专有**——助手消息同样打 | `assistant-message.js:4` 同一个常量、`:65` 同样的首行前缀（仅 `hasToolCalls` 时在 `:62` 提前返回跳过） |
| 因此 Pi 自带的 `scrollToPrompt()` 跳的是「消息区块」，**不能**拿来识别用户提问 | `pi-tui/dist/tui-alt-screen.js:24` `OSC133_PROMPT_START = /^\x1b\]133;A(?:\x07\|\\x1b\\\\)/`、`:302-315` 用它扫行；`tui-alt-screen.d.ts:110` 是 `private scrollToPrompt` |
| 滚动状态与滚动操作是**公开 API**（无需碰私有面） | `pi-tui/dist/components/scroll-view.d.ts`：`get scrollTop`、`get viewportHeight`、`get isFollowingEnd`、`scrollTo(scrollTop, options?)`、`scrollBy(lines)`、`updateLayout(contentHeight, viewportHeight, requestRender)` |
| 鼠标只在**全屏模式**路由到组件；regular 模式终端自己管滚动，且无布局系统 | `docs/tui.md`「Handle mouse input」节：`Fullscreen mode routes normalized mouse events to components.` / `Regular mode leaves mouse input to the terminal because the terminal owns scrollback.` |
| Pi 官方要求「每个交互都要留键盘路径」 | 同节末句：`Design every interaction with a keyboard path even when fullscreen mouse input is available.` |
| 上游明确不要这个功能进核心 | `github.com/earendil-works/pi` issue #7802（2026-08-11，同需求）维护者 badlogic 回复原文：`you can do this as an extension`；issue #8447（2026-08-25，要 sticky header 原语）同样 `no-action` 关闭；`CONTRIBUTING.md`：`PRs that bloat the core will likely be rejected.` |
| 生态里已有同类实现可作技法参考 | `npm:pi-affix-prompt`（MIT，v1.0.5）。它抓活 `tui` 靠注册一个即刻移除的 `setWidget`（`index.ts:341` `captureTui`）、钩 `ScrollView.updateLayout`（`:441`）、改 `root.entries` 顺序（`:390-430`）、纯逻辑单独放 `state-machine.ts` 便于单测 |

**没能取到的一手结论**：

- `UserMessageComponent` 实例上的 `text` 是 TS `private` 字段（`user-message.d.ts` 里是 `private text`），**类型上读不到**，运行时才可达。这是本规格唯一「借道」实例内部的地方，已在 §10 标风险。
- Pi 未公开「组件的渲染行区间」查询接口：`getScrollViewBox()` / `getLayoutBoxesAt()` / `getPrimaryScrollView()` 都没从包根导出（`pi-coding-agent` 的 `exports` 只有 `"."` 与 `"./rpc-entry"`）。行区间只能自己按组件渲染高度累加得出。

## 3. 范围

### 包含

- 全屏模式下用户提问的**吸顶行**：何时显示、显示谁、显示成什么样。
- 摘要的提取规则（第一段、压平空白、按宽度截断）。
- **点击跳转**：热区、目标位置、跳转后的状态。
- **布局注入**：注入位置、entry 选项、关闭时恢复、不干扰他人 entry。
- **私有面探针与降级**：结构不符时的行为。
- 开关：命令、持久化位置、默认值。
- README 与自动化测试。

### 不包含

- **regular 模式**（`tuiMode: "regular"`）：没有布局系统、终端持有滚动，本规格下插件完全 inert（不注入、不报错、不注册）。
- **活体渲染 / peel & stick**（把原消息按 1:1 贴上去、主题与 markdown 全跟随）：用户明确选了「一行摘要」，不做这个。
- **多行吸顶**：吸顶行恒为 1 行或 0 行。
- **把吸顶内容写进模型上下文**：纯展示，不调 `appendEntry`，不改任何消息。
- **为吸顶行新增键位**：见 §4.5 与 §10。
- **改 Pi 本体或向上游提 PR**：上游已明确表态（§2 末）。
- **与 `pi-affix-prompt` 共存**：两者都会改根布局 `entries`，同装会打架。本规格假定不装它。

## 4. 交互与行为

### 4.1 何时显示

下面全部成立时才显示；任一不成立时吸顶行高度为 **0**（不占行）：

- 运行在全屏模式（`tui.mode === "fullscreen"`）；
- 开关为开；
- 布局探针通过（§4.6）；
- 滚动视口**不处于跟随末尾**（`ScrollView.isFollowingEnd === false`）；
- 存在候选（§4.2）。

「跟随末尾」这一条照 Claude Code 的语义：你正看着最新输出时不需要锚点。

### 4.2 显示谁

**候选** = 渲染区间**完全位于视口顶之上**的用户提问，即 `区间.end <= scrollTop`。

显示候选中的**最后一条**（离视口顶最近的那条）。随上滚越过更早的提问，它进入候选并成为最后一条，吸顶行随之换人。

无候选 → 隐藏。

### 4.3 摘要怎么取

从该提问的 `UserMessageComponent` 实例取正文，依次：

1. 读实例上的正文文本；
2. 去首尾空白；
3. 取**第一段**（遇首个空行截断）；
4. 把连续空白（含换行）压成单个空格；
5. 归一化后为**空**、或以 `<` 开头（系统注入的包装内容）→ 该条**不作候选**，跳过它继续往上找；
6. 按可用宽度截断，尾部加 `…`。

保留原文里的 markdown 标记（不渲染、不解析），只做空白压平。

### 4.4 外观

- 恒一行，宽度撑满 transcript 区。
- 结构：左侧一个指示符（`↑`），右侧是摘要。
- 颜色走主题 token，不写死 ANSI 颜色（具体 token 见 §6）。
- **整行都是点击热区**。
- 吸顶行的渲染不得超出给定宽度，用 pi-tui 的 `visibleWidth()` / `truncateToWidth()` 而不是自己数长度。

### 4.5 点击跳转

- 点击吸顶行任意位置 → `scrollView.scrollTo(目标区间.start)`，把该提问的顶部对齐到视口顶。
- 跳转后该提问进入视口，不再满足 §4.2 的「完全在其上」，吸顶行**自然消失**——不需要额外的抑制逻辑。
- 跳转只改滚动位置，不改开关、不改设置、不写会话。
- **键盘路径**：滚动到该提问即可看到全文，用 Pi 既有的 `tui.altScreen.*` 键位（`previousPrompt` / `lineUp` / `halfPageUp` 等）就能到达同一结果；本规格**不为吸顶行新增键位**，理由与待办见 §10。

### 4.6 布局注入与降级

- **注入位置**：根布局 `entries` 的**第 0 项**，即 transcript 之前。
- **entry 选项**：`{ component: 吸顶行, basis: "auto", grow: 0, shrink: 0, minSize: 0 }`。
- **只动根布局自身**：`entries.splice` 重排时，transcript 与 dock 两个 entry **原样复用**（同一对象），绝不嵌套、不重组他人的 entry——别的扩展可能按 `root.entries` 找自己，嵌套会让它找不到。
- **关闭即恢复**：关开关时把吸顶行 entry 移除，其余 entry 保持原有顺序与选项。
- **探针（注入前）**：校验根布局形状符合预期——至少两项，且能按 `component.primary === true` 找到 transcript。不符 → **不注入**、不抛错，并 `notify(..., "warning")` 一次（不重复刷屏）。
- **幂等**：每帧校验一次，结构被外力改变时按需修正，但不重复插入同一条。
- 全屏之外（regular 模式）直接跳过，不算探针失败（那是正常跳过，不报警）。

### 4.7 开关与持久化

- 一个 `/` 命令用于切换开关（命令名见 §6）。
- 开关持久化到 `~/.pi/agent/` 下的插件自有 JSON 文件；**原子写**：先写 `.tmp` 再 `rename`，避免中途崩溃留下截断文件。
- 读不到 / 读坏了 → 用默认值，不报错。
- **默认：开**。

## 5. 与 Claude Code 的对照

| 维度 | Claude Code（2.1.301） | 本规格 | 说明 |
|---|---|---|---|
| 显示谁 | 从首个可见项往上，找最近的用户提问，要求它已完全在视口顶之上 | 同 | CC 的判定是 `itemTop + 1 >= scrollTop` 的近似；本规格用精确的 `end <= scrollTop`（§6 第 1 条） |
| 何时隐藏 | 视口吸底（`isSticky()`）时不显示 | 同（`isFollowingEnd`） | 语义一致 |
| 摘要 | 第一段、空白压成单空格、上限 500 字 | 第一段、空白压成单空格、**不设字数上限**，按宽度截断 | §6 第 3 条 |
| 过滤 | `isMeta` / `isVisibleInTranscriptOnly` / 首块非 text / 归一化后以 `<` 开头 | 归一化后为空或以 `<` 开头（其余由「必须是 `UserMessageComponent`」天然满足） | 我们拿到的已是渲染出来的用户消息，元信息天然不在其中 |
| 点击 | `scrollToElement(该消息节点, 1)`，剩 1 行余量 | `scrollTo(该提问起始行)`，无余量 | §6 第 2 条 |
| 载体 | 滚动容器带 `stickyScroll` 开关 + context 回传给外层布局 | 根布局 `entries` 里插一条常驻 entry | Pi 没有 sticky 原语，只能注入布局 |
| 高度补偿 | 需要（吸顶行高度随内容连续变化） | **不需要**（恒 0 或 1 行，`scrollTop` 不随视口高度变） | 见 §6 第 6 条，且列入实测 |

## 6. 自定细节（作者确定，非用户逐项指定）

1. **候选判据用精确的 `区间.end <= scrollTop`**，而不是照抄 CC 的 `itemTop + 1 >= scrollTop`。CC 那是对「项顶 +1」的近似；我们既然自己算行区间，就用无歧义的「整条完全在其上」。
2. **点击跳转不留余量**：滚到该提问的起始行，顶部对齐视口顶。CC 留 1 行，是因为它的吸顶行本身占据了视口第 0 行；我们跳转时吸顶行会消失，留余量反而多空一行。
3. **摘要不设固定字数上限**（CC 是 500 字）。终端宽度已是天然上限，再加字数限制只会让宽屏下显示更少。
4. **「跟随末尾」用 `isFollowingEnd`**，与 CC 的 `isSticky()` 语义对应（都是「视口吸在内容末端」）。
5. **过滤条件比 CC 少**：不检查 `isMeta` / `isVisibleInTranscriptOnly` / 首块类型——因为我们只认 `UserMessageComponent` 实例，能进 transcript 的已是渲染出来的用户消息，元信息不在其中。只保留「归一化后为空 / 以 `<` 开头」两条。
6. **不做滚动补偿**：吸顶行是 0↔1 的离散跳变。`scrollTop` 是内容坐标，不随视口高度变化，所以显隐时**内容不会跟着跳**，只有「视口少一行 / 多一行」这个既成效果。CC 需要补偿是因为它的吸顶行高度随内容连续变化（peel & stick）。**这一条列入 §7.2 实测**；实测发现跳行则改为同帧补偿 `scrollTo`。
7. **指示符与配色**：左侧 `↑` + 一格空格，其余是摘要；优先用主题的语义 token（muted / accent 一类），不写死颜色，随主题切换。具体 token 在实施时对照现有主题表定。
8. **摘要保留原文 markdown 标记**，只压平空白——不做 markdown 渲染。一行摘要里渲染 markdown 只会把 `**` 变成粗细变化，反而更难读。
9. **设置文件落点**：`~/.pi/agent/` 下、以插件名命名的 JSON（如 `sticky-prompt.json`），与 `pi-affix-prompt` 同一目录同一惯例。Pi 没有一等的扩展设置 API，扩展自管（`docs/settings.md` 只覆盖内置项）。
10. **探针失败只告警一次**：用一个模块级标志位，避免每帧刷屏。
11. **关闭时不 dispose 吸顶行组件**：保留实例，再打开时复用，避免重复构造；只在插件卸载时清理。

## 7. 验收标准

### 7.1 自动化

纯逻辑与布局改写都要能在不起 Pi 的情况下测。

- [ ] **摘要**：能取到第一段（遇首个空行截断）；连续空白（空格 / 制表 / 换行）压成单个空格；首尾空白去掉。
- [ ] **摘要过滤**：归一化后为空 → 不作候选；以 `<` 开头 → 不作候选；两者都跳过该条并继续往上找。
- [ ] **摘要截断**：超宽时尾部出现 `…`，且结果的可视宽度不超过给定宽度（含宽字符与 emoji 用例）。
- [ ] **候选选择**：给定「行区间表 + scrollTop」断言选中的下标。覆盖边界：恰好 `end === scrollTop`（应入选）、`end === scrollTop + 1`（不应入选）、无候选、全部候选、候选全部被 §4.3 过滤掉。
- [ ] **显隐**：`isFollowingEnd` 为真时不显示；开关为关时不显示；探针失败时不显示。
- [ ] **布局注入**：给定假 root，注入后 `entries[0]` 是吸顶行、其余 entry 是**同一对象引用**（不是复制、不是嵌套）。
- [ ] **关闭恢复**：关开关后 `entries` 的组件顺序与选项回到注入前。
- [ ] **结构不符**：root 项数不足 / 找不到 `primary === true` 时，不注入、不抛错、告警恰好一次。
- [ ] **幂等**：连续多帧调用不产生重复 entry。
- [ ] **不嵌套他人 entry**：root 上有第三方 entry 时，注入与移除都不把它包进新容器。
- [ ] **设置读写**：读不到 → 默认值（开）；内容损坏 → 默认值；写入走「临时文件 + rename」（断言无半截文件）。
- [ ] `npm run check`、`npm test` 通过，无新增第三方运行时依赖。

### 7.2 真实终端

- [ ] 全屏模式：发几条消息后往上滚，某条提问整条滚出顶后吸顶行出现，内容是该提问的第一段。
- [ ] 继续上滚越过更早那条：吸顶行换人，内容是更早那条。
- [ ] **吸顶行出现 / 消失的瞬间，正文不跳行**（§6 第 6 条的实测）。
- [ ] 点击吸顶行：视口滚回那条提问的顶部，吸顶行随之消失。
- [ ] 点击时视口已在半途（该提问部分可见）：点一下仍然回到其顶部。
- [ ] 停在最底部（跟随最新输出）：吸顶行不出现。
- [ ] 关掉开关：吸顶行消失、根布局恢复；`/reload` 后仍是关的。
- [ ] `tuiMode: "regular"`：无副作用、不报错、不告警。
- [ ] 与本仓 `workflow-tools` 共存：问答卡片浮层正常开合，吸顶行不干扰它。
- [ ] 一次长会话（≥ 50 条提问）里滚动流畅，无明显卡顿（行区间表有缓存）。
- [ ] 记录 Pi 版本、终端种类、模式与结果；未验的组合明确标未验。

## 8. 机制清单

| 机制 | 解决什么 / 没有它会怎样 |
|---|---|
| 布局注入（往根布局 `entries` 前插一条） | 让「屏幕顶部常驻一行」成立。没有它，唯一可用的位置是编辑器上方，到不了 transcript 顶部。 |
| 消息行区间表（`{start, end, comp}`） | 让「哪条提问在第几行」可知，用于判断谁滚出去了、以及点击该滚到哪。没有它，判据和跳转目标都算不出来。 |
| 吸顶判据 + 显隐 | 决定显示谁、何时消失。没有它，吸顶行会常亮不消，或该出现时不出现。 |
| 点击跳转 | 你要的核心交互：点一下回到那条消息看全文。没有它，只能靠手动滚。 |
| 摘要提取 | 把整条提问压成一行。没有它，长提问会撑爆吸顶行。 |
| 私有面探针 + 降级 | Pi 改布局结构时不静默画错：不注入 + 告警一次。没有它，升级后吸顶行会静默错位或报错，而且很难定位到是这个插件干的。 |

## 9. 改动边界

实施预计涉及：

- **新增** `extensions/sticky-prompt/prompt-index.ts`：纯逻辑——行区间表、候选选择、摘要提取。不依赖 Pi 运行时，便于单测。
- **新增** `extensions/sticky-prompt/sticky-bar.ts`：吸顶行组件——渲染、鼠标点击、主题取色。
- **新增** `extensions/sticky-prompt/index.ts`：接线——注册命令、读写设置、抓活 `tui`、探针、注入/移除布局 entry、挂滚动状态订阅。
- **新增** `extensions/sticky-prompt/prompt-index.test.ts`、`extensions/sticky-prompt/layout.test.ts`。
- `README.md`：新增一节「内置插件：sticky-prompt」（安装、操作、限制）。
- 本规格文件自身。

本规格交付只新增文档，不修改任何实现文件或既有规格。

## 10. 待定与风险

- **私有面依赖（本规格最大的账）**：整件事架在 Pi 的非公开面上——根布局的 `entries` 结构、`ScrollView` 的 `child`/`updateLayout`、`UserMessageComponent` 实例上的 `text` 字段。探针能保证「坏了你知道」，**不保证不坏**。Pi 升版后需要人工核一遍。
- **`text` 字段名依赖**：`user-message.d.ts` 里 `text` 是 `private`，类型上读不到，只能运行时取。若 Pi 改名，摘要会取空——表现为「吸顶行出现但内容为空」，探针应把这种情形也当结构异常处理。
- **键盘路径（未纳入）**：Pi 官方 TUI 文档要求每个交互都留键盘路径。本规格认为「滚上去就能看到全文」已在实质上满足该要求，故不为吸顶行新增键位；若你认为需要一个「一键跳回」的快捷键，那是**新机制**，需另开一份规格。
- **视口少一行的观感**：吸顶行出现时 transcript 视口少一行（内容不跳，只是底部少露一行）。若实测觉得别扭，可改为覆盖式绘制（画在 transcript 第 0 行之上）——那是另一种机制，需另开规格。
- **长会话性能**：行区间表要按组件缓存（按组件身份 + 宽度记忆化），否则每帧重算整条 transcript 的高度会随会话变长而变慢。缓存失效条件（组件增删、宽度变化、展开/收起）要在实施时覆盖到。
- **与其他改根布局的扩展冲突**：`pi-affix-prompt` 也改 `root.entries`，同装会互相踩。本规格只保证不主动破坏他人 entry，不保证与同类插件共存。
- **未验组合**：Windows / WSL / Linux 的鼠标事件、窄终端（宽度 < 20）、其他主题下的取色，本机只能验 macOS。这些标未验。

## 11. 修订记录

- 2026-10-16，初版。
