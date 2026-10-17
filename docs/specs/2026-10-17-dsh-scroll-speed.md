# dsh-TUI 滚动手感：从「调数字」到「分层」

- 日期：2026-10-17
- 涉及：dsh-TUI 0.15.0（profile 副本）、Claude Code 2.1.302（native binary）、Ghostty 1.2.x
- 落地：`extensions/dsh-scroll-speed/`（Pi 插件，负责安装/状态/回滚）

## 1. 问题

dst 的滚轮「随便滚一下就划过很多内容」，慢滚调慢后快滚又不够快。前几轮一直在调一个数字（每事件几行），
调了四版都没解决——因为问题不在数字。

## 2. 结论：滚动是三层，不是一层

| 层 | 负责 | Claude Code 的做法 |
|---|---|---|
| **意图** | 一个 wheel 事件值几行 | 1 行/事件；按终端 base 1/2/3；`CLAUDE_CODE_SCROLL_SPEED` 覆盖；快速连发时按 40ms 窗口 ramp |
| **运动** | 意图怎么变成位移 | `pendingScrollDelta` 累加，每帧按预算补水（≤5 全放、6–11 走 2、≥12 走 3；比例模式 75%），多余欠到下一帧，不丢 |
| **像素** | 谁来搬这些行 | DECSTBM + `CSI n S/T` 硬件滚动 + 只重绘滚入行，DEC 2026 包成原子操作 |

dst 0.15 已经把后两层从 CC 移植过来了（`render-node-to-output.js`、`log-update.js`），
唯独第一层还停在上游硬编码 `±3`，加上上一轮手写的「令牌桶 12 行/秒」，快滚被硬顶死。

## 3. 三个致命细节

### 3.1 全局包不是运行时代码

`dsh-tui` 的全局 npm 包是 **delegating launcher**：它把 argv 转发到
`~/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui`。
改全局包的 `App.js` 不会生效（PTY 探针实测：36 个 wheel 事件，0 次进入补丁函数）。

### 3.2 Ghostty 一档 = 3 个事件

```
$ ghostty +show-config --default | grep mouse-scroll
mouse-scroll-multiplier = precision:1,discrete:3
```

所以 CC 的 1 行/事件 = 3 行/刻度；上游 dst 的 3 行/事件 = 9 行/刻度。

### 3.3 CC 的慢滚下限是 1 行/事件

给 CC 设 `CLAUDE_CODE_SCROLL_SPEED=0.34`，PTY 探针仍是 3 个事件 3 行——
源码里是 `max(1, floor(...))`，分数倍率压不到 1 行以下。
换句话说：**想比 1 行/刻度更慢，友商没有答案**，只能小数累积（代价是个别刻度不动）。

## 4. dst 的补丁（v5）

`scroll-wheel-speed.js`，三个要点：

1. **意图可小数**：`carry` 跨事件累积，`SLOW=0.34` → 一档 3 事件 ≈ 1 行；
2. **按「手势起始数」判速**：只有间隔 <5ms 的连发算同一刻度，统计最近 400ms 的起始数；
   ≤9 次（≈22 格/秒）完全不加速，≥18 次（≈45 格/秒）拉满 `FAST=8`；
3. **不丢意图**：不再有令牌桶，加速只改每事件行数，补水仍由渲染器负责。

为什么不用「事件间隔」判速：真机日志显示慢滚也是 24 事件/秒的密集连发（一档 3 个事件挤在 1ms 内），
按间隔判会把慢滚当快滚，这正是「怎么调慢滚都偏快」的根因。

## 5. 持久化

补丁在 `node_modules` 里，`dsh-tui update` 会覆盖。方案是**启动前自愈**：

```
~/.dsh/patches/scroll-speed/
├── patch.mjs             --ensure / --status / --revert
├── scroll-wheel-speed.js 参数唯一源
├── ensure.sh             dst 启动前调用（no-op ≈16ms）
├── stamp                 App.js mtime:size + 模板 sha
└── skip                  结构不兼容时记一笔，避免刷屏
```

`dst()` 启动前跑 `ensure.sh`：命中 stamp 直接返回；只有 App.js 或模板变了才起 node。
升级覆盖 → 自动备份 + 重打 + `node --check`；结构变了 → 提示一次、保持原厂、不硬改。

## 6. 如何应用

Pi 插件（推荐）：

```
/dsh-scroll apply     # 装 assets + 打补丁
/dsh-scroll hook      # 挂 ~/.zshrc 自愈钩子
/dsh-scroll status    # 查状态
/dsh-scroll revert    # 还原
```

手动：把 `assets/` 三个文件放到 `~/.dsh/patches/scroll-speed/`，跑
`node patch.mjs --ensure`，再把 `ensure.sh` 加进 `dst()`。

参数：`DSH_TUI_SCROLL_SLOW`（默认 0.34）、`DSH_TUI_SCROLL_FAST`（默认 8）、
`DSH_TUI_SCROLL_ACCEL=0` 关加速、`DSH_TUI_SCROLL_DEBUG=1` 写 `~/.dsh-tui/wheel-speed.log`。

## 7. 怎么验证

PTY 探针：应答 DA1 / DECRQM 2026 / XTVERSION，注入 SGR 滚轮序列，数 `CSI n S/T`：

| 输入 | CC | dst 补丁后 |
|---|---|---|
| 3 事件 @200ms | 3 行 | 1 行 |
| 15 事件 @25ms | 39 行 | 20–58 行（随密度） |

真机：`DSH_TUI_SCROLL_DEBUG=1 dst`，滚慢/快各几秒，看 `~/.dsh-tui/wheel-speed.log` 的
`gap / n / mult / rows`；`n` 就是判速用的起始数。

## 8. 教训

1. **先确认改的是不是运行的那份代码**（launcher vs profile 副本），否则一切调参都是安慰剂。
2. **参数不是模型**：同一个 step 值无法同时满足慢滚和快滚，需要独立的慢/快两个自由度。
3. **判速信号要匹配输入形态**：终端一档多事件时，「事件间隔」不是速度，「手势起始数」才是。
4. **持久化要在启动路径上**：定时任务/手工重打都会忘，挂在启动前的自愈最可靠。
