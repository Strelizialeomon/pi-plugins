# 上一条用户输入吸顶（Sticky Prompt）

- 日期：2026-10-16
- 类型：方案期 spec
- 状态：待审
- Issue：（待 spec 合并后开）
- 现状基线：`3b21a24`（main）
- 适用环境：Pi 1.2.x 全屏终端交互模式（`tuiMode: "fullscreen"`，Pi 的默认值）
- 前序规格：无（本文件不改任何既有规格）
- 用户确认：本轮三轮拍板——**路线**「本仓自建，一次做全」；**形态**「摘要式吸顶行（非活体渲染）」；**机制**「全要」。原话是「一行摘要（Claude Code 同款）」，这里要说明：**「一行」是本规格的形态选择，不是对 Claude Code 的描述**——CC 的吸顶内容是压平过的单段摘要、可以折行成多行（见 §5）。真正照搬的是「摘要式」而非「活体渲染」。

## 1. 目标

在全屏 TUI 的 transcript 区顶部常驻一行，显示**最近一条已完全滚出视口顶部的用户提问**的摘要。

1. 某条提问整条滚出视口顶之后，吸顶行出现，显示该提问的摘要。
2. 继续上滚越过更早的提问，吸顶行换成更早那条。
3. 点击吸顶行，视口滚回那条提问的顶部。
4. 滚回底部（跟随最新输出）时吸顶行消失。
5. 纯展示：不写入会话、不进模型上下文、不改任何既有行为。
6. 关掉开关后完全无副作用——根布局回归原状，不留痕迹。

**本规格的吸顶行恒为 1 行或 0 行**（宽度撑满、超出即截断），不做折行、不做多行。

本文件定义需求、行为和验收，不编排实施任务或提交顺序。

## 2. 一手依据（本机安装的 Pi 1.2.x）

### 2.1 滚动区与布局

| 结论 | 当场核对的依据 |
|---|---|
| Pi **没有** sticky / 置顶行原语 | `pi-coding-agent/docs/tui.md:38` 只有 `` - `ScrollView` provides a bounded scrollable viewport. ``；该文件全文没有 sticky / pinned 字样 |
| 全屏下 transcript 与 dock 是**兄弟节点**，不在同一个滚动容器里 | `dist/modes/interactive/chat-viewport.js:4` `new ScrollView(options.document, { follow: "end", primary: true, overscroll: "chain", ... })`；`:12` dock 的 `VStack`；`:22` root `VStack([{component: transcript, basis:0, grow:1, ...}, {component: dock, basis:"auto", grow:0, ...}])` |
| **滚动内容的第 0 行不是第一条聊天消息**——`ScrollView` 的内容是 `documentContainer`，其子节点依序是 header、资源区、chat | `interactive-mode.js:389-391`：`addChild(this.headerContainer)` / `addChild(this.loadedResourcesContainer)` / `addChild(this.chatContainer)`；`chat-viewport.js:4` 传给 `ScrollView` 的就是这个 `options.document` |
| 根布局可在运行时改写，取用点是 `tui.layoutRoot` 与 `tui.currentLayout` | `pi-tui/dist/tui-alt-screen.js:44-45` 声明 `layoutRoot;` / `currentLayout;`（`.d.ts` 里是 TS private，运行时可达）；它的 `entries` 是 `StackEntry[]`，可原地 `splice` 重排 |
| 公开的正式接口是 `ViewportTUI.setLayoutRoot()`——但它**不是**本规格走的那条路 | `pi-tui/dist/tui.d.ts:249` `interface ViewportTUI extends TUI`、`:251` `setLayoutRoot(component: Component \| undefined): void`；`TuiAltScreen` 实现了它（`tui-alt-screen.d.ts:97`）。本规格不做「换掉整个布局根」，而是就地改 `entries` 顺序（见 §4.6） |

### 2.2 行区间从哪来

| 结论 | 当场核对的依据 |
|---|---|
| Pi 每帧的布局帧里**带每个组件的精确行区间** | `pi-tui/dist/layout.d.ts:9-19` `interface LayoutBox { component; rect; clip; children; parent?; lines?; lineOffset?; scrollView?; scrollContentLines?; }`——`lineOffset` 即该组件相对其父的行偏移 |
| 取帧的两个函数**可以深引拿到**（虽然不在包根公开导出里） | `pi-tui/dist/index.d.ts` 全文无这两个名字；但 `pi-tui/package.json` **没有 `exports` 字段**（只有 `main` / `types`），所以 `@earendil-works/pi-tui/dist/layout.js` 可深引，其中 `layout.d.ts:39` `getLayoutBoxesAt(frame, x, y)`、`:40` `getScrollViewBox(frame, scrollView)` |
| 因此**不需要**自己按组件渲染高度累加行数 | 同上。自己累加要双渲染整条 transcript、还要维护缓存失效；用布局帧是零额外渲染、且与 Pi 同源 |

### 2.3 怎么认出「用户提问」

| 结论 | 当场核对的依据 |
|---|---|
| 用户提问的渲染组件是**包根公开导出**的，可直接 `instanceof` | `dist/index.d.ts:36` 导出 `UserMessageComponent`（同列表还有 `AssistantMessageComponent`）；`index.js:42` 同；`interactive-mode.js:82` 导入的就是同一个类，transcript 里确实 `new UserMessageComponent(...)`（`:3202`、`:3207`） |
| 提问正文就存在该组件实例上（TS private，运行时可达） | `dist/modes/interactive/components/user-message.js:17` `this.text = text`；`user-message.d.ts:7` 是 `private text` |
| ⚠️ **OSC 133 的 `\x1b]133;A` 不是用户提问专有**——助手消息同样打 | `user-message.js:4` 与 `assistant-message.js:4` 是同一个常量、两处 `:45` / `:65` 都做首行前缀；助手侧仅 `hasToolCalls` 或空行时在 `assistant-message.js:62` 提前返回跳过 |
| 因此 Pi 自带的 `scrollToPrompt()` 跳的是「消息区块」，**不能**拿来识别用户提问 | `pi-tui/dist/tui-alt-screen.js:24` `OSC133_PROMPT_START = /^\x1b\]133;A(?:\x07\|\\x1b\\\\)/`、`:302-315` 用它扫行；`tui-alt-screen.d.ts:110` 是 `private scrollToPrompt` |

### 2.4 滚动状态与输入

| 结论 | 当场核对的依据 |
|---|---|
| 滚动状态与滚动操作全是**公开 API**，无需碰私有面 | `pi-tui/dist/components/scroll-view.d.ts`：`:37` `get scrollTop`、`:38` `get isFollowingEnd`、`:39` `get viewportHeight`、`:48` `scrollTo(...)`、`:49` `scrollBy(...)`、`:52` `updateLayout(...)`。（同文件 `:19` `private readonly child` 才是私有的） |
| 扩展拿到的 `tui` 是**指向活渲染器的 Proxy**，私有成员运行时可达 | `interactive-mode.js:383` `this.ui = createInteractiveTuiReference(() => this.renderer)`；`tui-renderer.js:37` 起是 `createInteractiveTuiReference`，`:39-58` 的 `get` 陷阱里 `:41` 是 `Reflect.get(tui, property, tui)`（TS `private` 编译后不存在） |
| 扩展的两条入口都拿到这个 Proxy | `setWidget` 的工厂：`interactive-mode.js:1881` `component = content(this.ui, theme)`；`custom` 的工厂：`:2354` `Promise.resolve(factory(this.ui, theme, this.keybindings, close))` |
| 注入的根级 entry **会拿到自己的 layout box，能收到鼠标事件** | `tui-alt-screen.js:636-650` 的 `dispatchMouseToLayout`；「整行热区」因此可行 |
| 鼠标只在**全屏模式**路由到组件；regular 模式终端自己管滚动，且无布局系统 | `docs/tui.md`「Handle mouse input」节：`Fullscreen mode routes normalized mouse events to components.` / `Regular mode leaves mouse input to the terminal because the terminal owns scrollback.` |
| Pi 官方要求「每个交互都要留键盘路径」 | 同节末句：`Design every interaction with a keyboard path even when fullscreen mouse input is available.` |

### 2.5 上游态度

| 结论 | 当场核对的依据 |
|---|---|
| 维护者确实建议「做成扩展」，原话一字不差 | `github.com/earendil-works/pi` issue #7802（**建于 2026-08-07T23:58:40Z**），维护者 badlogic 于 **2026-08-10T15:09:13Z** 回复原文：`you can do this as an extension` |
| 但要说清：那两条 issue **都不是被人工裁决关掉的** | #7802 于创建后 **10 秒**被机器人自动关闭（`closed_at` `2026-08-07T23:58:50Z`，`state_reason: not_planned`，首条评论是 `All issues from new contributors are auto-closed by default`）；#8447（**建于 2026-08-21T15:01:40Z**）同样在 10 秒后被自动关闭，**全程只有机器人那一条评论，没有任何维护者表态**。两条的维护者动作都只是「没有重新打开」 |
| 核心求小是写在贡献指南里的 | `CONTRIBUTING.md`：`PRs that bloat the core will likely be rejected.`（另有 `pi's core is minimal`） |
| 生态里已有同类实现可作技法参考 | `npm:pi-affix-prompt`（MIT，v1.0.5）。它抓活 `tui` 靠注册一个即刻移除的 `setWidget`（`index.ts:341` `captureTui`）、钩 `ScrollView.updateLayout`（`:441`）、改 `root.entries` 顺序（`:390-430`，entry 选项在 `:414`）、纯逻辑单独放 `state-machine.ts` 便于单测 |

**已经能取到、不必再当风险的一条**：行区间的来源是 Pi 自己的布局帧（§2.2），不是我们猜的。早期草稿曾写「取不到行区间 API、只能自己累加」——那是错的，已改。

## 3. 范围

### 包含

- 全屏模式下用户提问的**吸顶行**：何时显示、显示谁、显示成什么样。
- 摘要的提取规则（第一段、压平空白、按宽度截断）。
- **点击跳转**：热区、目标位置、跳转后的状态。
- **布局注入**：注入位置、entry 选项、关闭时恢复、不干扰他人 entry。
- **私有面探针与降级**：结构不符时的行为。
- **开关与持久化**：命令、落点、原子写、默认值。
- README 与自动化测试。

### 不包含

- **regular 模式**（`tuiMode: "regular"`）：没有布局系统、终端持有滚动，本规格下插件完全 inert（不注入、不报错、不注册）。
- **活体渲染 / peel & stick**（把原消息按 1:1 贴上去、主题与 markdown 全跟随）：用户选的是「摘要式」。
- **多行吸顶**：吸顶行恒为 1 行或 0 行。
- **把吸顶内容写进模型上下文**：纯展示，不调 `appendEntry`，不改任何消息。
- **为吸顶行新增键位**：见 §4.5 与 §10。
- **自己按组件累加渲染高度来算行区间**：走布局帧（§6 第 1 条），不做第二套。
- **改 Pi 本体或向上游提 PR**：上游虽未人工否决，但维护者建议做扩展、贡献指南也写明核心求小（§2.5）。
- **与 `pi-affix-prompt` 共存**：两者都会改根布局 `entries`，同装会打架。本规格假定不装它。

## 4. 交互与行为

### 4.0 坐标系（先说清，后面都依赖它）

本规格里所有「行号」都是**滚动内容的绝对行号**，其**第 0 行是 `documentContainer` 的首行（header）**，不是第一条聊天消息（§2.1）。

- 判据里的 `scrollTop` 与区间表里的 `start` / `end` 用**同一个坐标系**，所以 header 与资源区的高度天然包含在内，不需要单独补偿。
- 但区间表**必须从内容第 0 行开始累计**。若从 `chatContainer` 直接开始累计，整张表会整体偏移一个 header 的高度——判据会迟、跳转会偏。

### 4.1 何时显示

下面全部成立时才显示；任一不成立时吸顶行高度为 **0**（不占行）：

- 运行在全屏模式（`tui.mode === "fullscreen"`）；
- 开关为开；
- 布局探针通过（§4.6）；
- 滚动视口**不处于跟随末尾**（`ScrollView.isFollowingEnd === false`）；
- 存在候选（§4.2）。

「跟随末尾」这一条照 Claude Code 的语义：你正看着最新输出时不需要锚点。

### 4.2 显示谁

**候选** = 行区间**完全位于视口顶之上**的用户提问，即 `区间.end <= scrollTop`（坐标系见 §4.0）。

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
- 渲染不得超出给定宽度，用 pi-tui 的 `visibleWidth()` / `truncateToWidth()`（包根导出，`pi-tui/dist/index.d.ts:35`）而不是自己数长度。

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
- **探针（注入前）**：校验 ① 根布局形状符合预期（至少两项，且能按 `component.primary === true` 找到 transcript）；② 布局帧取得到且形状符合预期（§2.2 的两个深引函数存在、`getScrollViewBox` 能在帧里定位到那个 transcript）。任一不符 → **不注入**、不抛错，并 `notify(..., "warning")` 一次。
- **每帧校验**：挂在吸顶行自己的 `render()` 里（那一段本来就每帧跑，滚动会触发 TUI 重渲染），**不引入任何订阅机制**——`ScrollView` 与 `TUI` 都没有 onScroll / onChange 这一类公开 API。结构被外力改变时按需修正，但不重复插入同一条。
- 全屏之外（regular 模式）直接跳过，不算探针失败（那是正常跳过，不报警）。

### 4.7 开关与持久化

- 一个 `/sticky-prompt` 命令用于切换开关（有无参数、参数形态见 §6 第 8 条）。
- 开关持久化到 `~/.pi/agent/sticky-prompt.json`；**原子写**：先写 `.tmp` 再 `rename`，避免中途崩溃留下截断文件。
- 读不到 / 读坏了 → 用默认值，不报错。
- **默认：开**。

## 5. 与 Claude Code 的对照

**先划清可核与不可核**：CC 那一列来自作者对本机 Claude Code 2.1.301 原生二进制里嵌的 JS 的阅读（Bun 打包，源码明文可 grep），本机没有第二份可交叉验证的副本，**属于单源、未经独立复核**。下表只保证「我读到的代码是这样」，不保证「CC 在别的版本也这样」。

| 维度 | Claude Code（2.1.301，单源） | 本规格 | 说明 |
|---|---|---|---|
| 显示谁 | 先定出首个可见项，再从它**往上**逐条回溯，第一条用户提问即中选；另有一道 `itemTop + 1 >= scrollTop` 的守卫跳过仍在视口内的项 | 候选 = `区间.end <= scrollTop`，取其中最后一条 | CC 的主规则是「首个可见项之上的最近一条提问」，守卫是次级近似；本规格用无歧义的「整条完全在其上」（§6 第 2 条） |
| 何时隐藏 | 视口吸底时（`isSticky()`）不显示 | 同（`isFollowingEnd`） | 语义一致 |
| 摘要 | 第一段、空白压成单空格、上限 500 字 | 第一段、空白压成单空格、**不设字数上限**，按宽度截断 | §6 第 3 条 |
| **是否恒一行** | **不保证**：压平后仍可能折行成多行 | **恒 1 行或 0 行** | 这是本规格与 CC 的**有意差异**，也是用户拍板的那一项（见文件头「用户确认」） |
| 过滤 | 元消息、仅记录可见、首块非 text、归一化后以 `<` 开头 | 归一化后为空或以 `<` 开头 | 我们只认 `UserMessageComponent`，能进 transcript 的已是渲染出来的用户消息（§6 第 5 条） |
| 点击 | `scrollToElement(该消息节点, 1)`，留 1 行余量 | `scrollTo(该提问起始行)`，无余量 | §6 第 4 条 |
| 载体 | 滚动容器带 `stickyScroll` 开关 + context 回传给外层布局 | 根布局 `entries` 里插一条常驻 entry | Pi 没有 sticky 原语，只能注入布局 |
| 高度补偿 | 需要（吸顶行高度随内容连续变化） | **不需要**（恒 0 或 1 行，`scrollTop` 不随视口高度变） | §6 第 6 条，且列入实测 |

## 6. 自定细节（作者确定，非用户逐项指定）

1. **行区间取自 Pi 的布局帧**，而不是自己按组件渲染高度累加（§2.2）。理由：同源、零额外渲染、不必维护缓存失效。代价：要深引 `@earendil-works/pi-tui/dist/layout.js`（该包无 `exports` 字段，可深引，但它不在包根的公开导出清单里）。**不做「自己累加」的兜底**——探针拿不到帧就停用，避免两套代码。
2. **候选判据用精确的 `区间.end <= scrollTop`**，而不是照抄 CC 的 `itemTop + 1 >= scrollTop` 守卫。CC 那是对「项顶 +1」的近似；我们既然拿到的是精确区间，就用无歧义的「整条完全在其上」。
3. **摘要不设固定字数上限**（CC 是 500 字）。终端宽度已是天然上限，再加字数限制只会让宽屏下显示更少。
4. **点击跳转不留余量**：滚到该提问的起始行，顶部对齐视口顶。CC 留 1 行，是因为它的吸顶行本身占据视口第 0 行；我们跳转时吸顶行会消失，留余量反而多空一行。
5. **过滤条件比 CC 少**：不检查元消息 / 仅记录可见 / 首块类型——因为我们只认 `UserMessageComponent` 实例，能进 transcript 的已是渲染出来的用户消息，元信息不在其中。只保留「归一化后为空 / 以 `<` 开头」两条。
6. **不做滚动补偿**：吸顶行是 0↔1 的离散跳变。`scrollTop` 是内容坐标且被 clamp 在 `contentHeight − viewportHeight`，0↔1 行跳变只改可视窗、不动内容（已核 `scroll-view.js` 的 `updateLayout` / `scrollBy` / `scrollTo`）。CC 需要补偿是因为它的吸顶行高度随内容连续变化。**这条列入 §7.2 实测**；实测发现跳行则改为同帧补偿 `scrollTo`。
7. **指示符与配色**：左侧 `↑` + 一格空格，其余是摘要；用主题的语义 token（`muted` / `accent` 一类，见 `docs/themes.md:108`），不写死颜色。具体 token 在实施时对照现有主题表定。
8. **命令名 `/sticky-prompt`**，无参数即切换开关并 `notify` 一行当前状态；不引入子命令。理由：开关只有一个布尔，加子命令是过度设计。
9. **摘要保留原文 markdown 标记**，只压平空白——不做 markdown 渲染。一行摘要里渲染 markdown 只会把 `**` 变成粗细变化，反而更难读。
10. **设置落点 `~/.pi/agent/sticky-prompt.json`**，与 `pi-affix-prompt` 同目录同惯例。Pi 没有一等的扩展设置 API（`docs/settings.md` 只列内置项），扩展自管。**原子写**（`.tmp` + `rename`），读失败或内容损坏一律回落默认值。
11. **开关默认「开」**：这是个低风险的展示功能，默认开才有人会发现它；不想要的人一条命令就关掉。
12. **注入 entry 的选项固定为** `{ basis: "auto", grow: 0, shrink: 0, minSize: 0 }`；与参考实现一致（`/tmp/affix-probe/index.ts:414`）。`grow: 0` + `shrink: 0` 是关键——它保证吸顶行不会跟 transcript 抢空间。
13. **坐标系不在区间表里做 header 补偿**：整张表从内容第 0 行起算（§4.0），header 高度自然含在内。不额外引入一个「header 偏移量」的常量。
14. **探针失败只告警一次**：用一个模块级标志位，避免每帧刷屏。
15. **关闭时不 dispose 吸顶行组件**：保留实例，再打开时复用，避免重复构造；只在插件卸载时清理。

## 7. 验收标准

### 7.1 自动化

纯逻辑与布局改写都要能在不起 Pi 的情况下测。

- [ ] **摘要**：能取到第一段（遇首个空行截断）；连续空白（空格 / 制表 / 换行）压成单个空格；首尾空白去掉。
- [ ] **摘要过滤**：归一化后为空 → 不作候选；以 `<` 开头 → 不作候选；两者都跳过该条并继续往上找。
- [ ] **摘要截断**：超宽时尾部出现 `…`，且结果的可视宽度不超过给定宽度（含宽字符与 emoji 用例）。
- [ ] **候选选择**：给定「行区间表 + scrollTop」断言选中的下标。覆盖边界：恰好 `end === scrollTop`（应入选）、`end === scrollTop + 1`（不应入选）、无候选、全部候选、候选全部被 §4.3 过滤掉。
- [ ] **坐标系**：区间表从内容第 0 行起算——喂一个带 header 高度的假帧，断言选中的是正确那条（这是 §4.0 那条偏移 bug 的回归护栏）。
- [ ] **外观**：吸顶行 `render()` 在「显示」态返回**恰好 1 行**、在「隐藏」态返回**恰好 0 行**；显示态那行的可视宽度等于给定宽度（撑满）；行内出现指示符 `↑`。
- [ ] **取色随主题**：吸顶行的输出用的是主题 token 产出的样式，而非硬编码 ANSI 序列（断言换主题后输出样式跟着变）。
- [ ] **纯展示**：跑一遍「显示 → 点击 → 隐藏」全过程，断言语会话条目数不变、没有调用 `appendEntry`、开关值与设置文件内容不被读写以外的路径改动。
- [ ] **显隐**：`isFollowingEnd` 为真时不显示；开关为关时不显示；探针失败时不显示。
- [ ] **布局注入**：给定假 root，注入后 `entries[0]` 是吸顶行、其余 entry 是**同一对象引用**（不是复制、不是嵌套）。
- [ ] **关闭恢复**：关开关后 `entries` 的组件顺序与选项回到注入前。
- [ ] **结构不符**：root 项数不足 / 找不到 `primary === true` / 布局帧取不到时，不注入、不抛错、告警恰好一次。
- [ ] **幂等**：连续多帧调用不产生重复 entry。
- [ ] **不嵌套他人 entry**：root 上有第三方 entry 时，注入与移除都不把它包进新容器。
- [ ] **设置读写**：读不到 → 默认值（开）；内容损坏 → 默认值；写入走「临时文件 + rename」（断言无半截文件）。
- [ ] **命令**：`/sticky-prompt` 切换开关并写入设置文件；连按两次回到原状态。
- [ ] `npm run check`、`npm test` 通过，无新增第三方运行时依赖。

### 7.2 真实终端

- [ ] 全屏模式：发几条消息后往上滚，某条提问整条滚出顶后吸顶行出现，内容是该提问的第一段。
- [ ] 继续上滚越过更早那条：吸顶行换人，内容是更早那条。
- [ ] **吸顶行出现 / 消失的瞬间，正文不跳行**（§6 第 6 条的实测）。
- [ ] 点击吸顶行：视口滚回那条提问的顶部，吸顶行随之消失；**滚到的位置正确**（不是偏一行——§4.0 那条的实测）。
- [ ] 点击时视口已在半途（该提问部分可见）：点一下仍然回到其顶部。
- [ ] 停在最底部（跟随最新输出）：吸顶行不出现。
- [ ] 关掉开关：吸顶行消失、根布局恢复；`/reload` 后仍是关的。
- [ ] `tuiMode: "regular"`：无副作用、不报错、不告警。
- [ ] 与本仓 `workflow-tools` 共存：问答卡片浮层正常开合，吸顶行不干扰它。
- [ ] 一次长会话（≥ 50 条提问）里滚动流畅，无明显卡顿。
- [ ] 记录 Pi 版本、终端种类、模式与结果；未验的组合明确标未验。

## 8. 机制清单

| 机制 | 解决什么 / 没有它会怎样 |
|---|---|
| 布局注入（往根布局 `entries` 前插一条） | 让「屏幕顶部常驻一行」成立。没有它，唯一可用的位置是编辑器上方，到不了 transcript 顶部。 |
| 消息行区间表（`{start, end, comp}`，取自布局帧） | 让「哪条提问在第几行」可知，用于判断谁滚出去了、以及点击该滚到哪。没有它，判据和跳转目标都算不出来。 |
| 吸顶判据 + 显隐 | 决定显示谁、何时消失。没有它，吸顶行会常亮不消，或该出现时不出现。 |
| 点击跳转 | 你要的核心交互：点一下回到那条消息看全文。没有它，只能靠手动滚。 |
| 摘要提取 | 把整条提问压成一行。没有它，长提问会撑爆吸顶行。 |
| 开关 + 持久化 | 给用户一个关掉它的入口，且关掉的状态跨会话保留。没有它，行为不对时用户只能卸载插件。 |
| 私有面探针 + 降级 | Pi 改布局结构时不静默画错：不注入 + 告警一次。没有它，升级后吸顶行会静默错位或报错，而且很难定位到是这个插件干的。 |

## 9. 改动边界

实施预计涉及：

- **新增** `extensions/sticky-prompt/prompt-index.ts`：纯逻辑——从布局帧派生行区间表、候选选择、摘要提取。不依赖 Pi 运行时（帧以参数注入），便于单测。
- **新增** `extensions/sticky-prompt/sticky-bar.ts`：吸顶行组件——`render()` 里读 ScrollView 的 `scrollTop` 派生显隐与内容、鼠标点击、主题取色。
- **新增** `extensions/sticky-prompt/index.ts`：接线——注册 `/sticky-prompt` 命令、读写设置、抓活 `tui`、探针、注入/移除布局 entry。
- **新增** `extensions/sticky-prompt/prompt-index.test.ts`、`extensions/sticky-prompt/layout.test.ts`。
- `README.md`：新增一节「内置插件：sticky-prompt」（安装、操作、限制）。
- 本规格文件自身。

本规格交付只新增文档，不修改任何实现文件或既有规格。

## 10. 待定与风险

- **深引 `@earendil-works/pi-tui/dist/layout.js`（本规格最大的账）**：它不在包根公开导出清单里，只是因为这个包没有 `exports` 字段才引得到。Pi 一旦加上 `exports` 字段，这条通路立刻断。探针会挡住（不注入 + 告警），但那时功能就没了，要改回自己累加。
- **其余私有面依赖**：`tui.layoutRoot` / `tui.currentLayout`（TS private，运行时可达）、`UserMessageComponent` 实例上的 `text`（TS private）。`ScrollView` 那边不用碰私有面——`scrollTop` / `isFollowingEnd` / `scrollTo` 全是公开 API。
- **`text` 字段名依赖**：`user-message.d.ts:7` 是 `private text`，类型上读不到，只能运行时取。若 Pi 改名，摘要会取空——表现为「吸顶行出现但内容为空」；探针应把这种情形也当结构异常处理，而不是画一条空行。
- **键盘路径（未纳入）**：Pi 官方 TUI 文档要求每个交互都留键盘路径。本规格认为「滚上去就能看到全文」已在实质上满足该要求，故不为吸顶行新增键位；若你认为需要一个「一键跳回」的快捷键，那是**新机制**，需另开一份规格。
- **视口少一行的观感**：吸顶行出现时 transcript 视口少一行（内容不跳，只是底部少露一行）。若实测觉得别扭，可改为覆盖式绘制（画在 transcript 第 0 行之上）——那是另一种机制，需另开规格。
- **与其他改根布局的扩展冲突**：`pi-affix-prompt` 也改 `root.entries`，同装会互相踩。本规格只保证不主动破坏他人 entry，不保证与同类插件共存。
- **未验组合**：Windows / WSL / Linux 的鼠标事件、窄终端（宽度 < 20）、Claude Code 侧的对照数据（单源，见 §5 开头），本机只能验 macOS。这些标未验。

## 11. 审核修订记录

2026-10-16，方案期**轻审**（1 个 agent，用户在闸卡上点档）。审核结论原样见 PR #19 评论。共 13 条发现（高 0 / 中 5 / 低 8），**全部采纳**。

| # | 严重度 | 发现 | 处置 |
|---|---|---|---|
| 1 | 中 | 上游两条 issue 的日期写错；且把「自动关闭」说成维护者裁决，「明确不要进核心」超出证据 | 已改：§2.5 换成原始时间戳（08-07 / 08-21），明写两条都只是 10 秒内机器人自动关闭、维护者动作仅为「没有重新打开」；§3 的措辞同步降级 |
| 2 | 中 | 「行区间 API 取不到、只能自己累加」不成立——pi-tui 无 `exports` 字段，`dist/layout.js` 可深引 | 已改：§2.2 新增整节依据；§6 第 1 条改为走布局帧且不做兜底；§3「不包含」补一条；§10 新增「深引」风险并把原「缓存失效」风险删除 |
| 3 | 中 | §4.7 说「命令名见 §6」，§6 里没有 | 已改：§4.7 直接写 `/sticky-prompt`；§6 新增第 8 条说明其参数形态 |
| 4 | 中 | §9「挂滚动状态订阅」没有 API 支撑，也没进机制清单 | 已改：§4.6 明确挂在自己的 `render()` 上、不引入订阅（并注明 `ScrollView`/`TUI` 无 onScroll 类 API）；§9 同步改写 |
| 5 | 中 | 行区间的坐标原点没定义，而滚动内容第 0 行是 header 不是聊天 | 已改：新增 §4.0 定义坐标系；§2.1 新增该现状依据；§4.2 / §4.5 指回 §4.0；§6 新增第 13 条；§7.1 与 §7.2 各加一条回归验收 |
| 6 | 低 | 「开关 + 持久化」在正文里是机制，但不在清单 | 已改：§8 增至 7 条；文件头「用户确认」注明机制清单的最终条数 |
| 7 | 低 | §4.4 外观四条只有「不超宽」有验收项 | 已改：§7.1 新增「外观」「取色随主题」两条 |
| 8 | 低 | 「纯展示」无验收项 | 已改：§7.1 新增「纯展示」一条 |
| 9 | 低 | 自定细节放在 §6 而非末尾；另有几处作者自定项没进 §6 | 位置**不改**——与仓内既有版式（`2026-10-15-other-image-paste.md` 等同为 §6→§10→§11）一致；缺失的自定项已补：§6 新增第 10~12 条（原子写、默认开、entry 选项） |
| 10 | 低 | §2 表用公开的 `setLayoutRoot` 论证，但正文实际走 `tui.layoutRoot` | 已改：§2.1 拆成两行，明写「本规格不走 `setLayoutRoot`」并把真正的取用点列出来 |
| 11 | 低 | §10 把 `updateLayout` 算进非公开面，与 §2 矛盾 | 已改：§10 改为明写 `ScrollView` 的 `scrollTop` / `isFollowingEnd` / `scrollTo` 全是公开 API，不碰私有面 |
| 12 | 低 | `tui-renderer.js:37-70` 超出文件长度（共 66 行） | 已改：§2.4 缩到 `:37` 起 + `:39-58` 陷阱 + `:41` 那行 |
| 13 | 低 | §5 对 CC 的描述有两处内部张力；CC 侧不可复核 | 已改：§5 开头声明单源不可复核；第 1 行拆开「主规则 / 次级守卫」；新增「是否恒一行」一行，明确「恒一行是本规格的选择、不是 CC 的行为」，并同步修文件头「用户确认」的表述 |

**未采纳的发现**：无。
