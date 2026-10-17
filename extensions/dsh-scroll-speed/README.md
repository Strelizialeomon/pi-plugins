# dsh-scroll-speed

把 [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) 的滚轮换成 Claude Code 那套「意图 → 运动 → 像素」模型：
慢滚一格一行，快滚按手势密度加速，滚动本身走终端的 DECSTBM 硬件滚动。

> 这是给 **dsh-TUI** 打的补丁，不是 Pi 自己 TUI 的滚动。Pi 插件在这里的角色是「安装器 + 状态面板」。

## 命令

```
/dsh-scroll status    补丁打没打上、helper 在不在、开机自愈钩子挂没挂
/dsh-scroll apply     安装 assets 并打到 ~/.dsh/profiles/dsh-tui/... 的 App.js
/dsh-scroll revert    还原成原厂滚轮
/dsh-scroll hook      把 ensure.sh 挂进 ~/.zshrc（dsh 升级后自动补回）
```

装进 Pi：

```bash
pi install ~/code/pi-plugins
# 或临时试：
pi --extension ./extensions/dsh-scroll-speed/index.ts
```

## 参数

补丁装好后，行为由三个环境变量控制（写进 `dst()` 或临时前缀都行）：

| 变量 | 含义 | 默认 |
|---|---|---|
| `DSH_TUI_SCROLL_SLOW` | 慢滚每事件几行（可小数、跨事件累积） | `0.34` ≈ 1 行/刻度 |
| `DSH_TUI_SCROLL_FAST` | 快滚每事件上限 | `8` ≈ 24 行/刻度 |
| `DSH_TUI_SCROLL_ACCEL` | `0` 关加速，恒为 SLOW | 开 |
| `DSH_TUI_SCROLL_DEBUG` | `1` 写 `~/.dsh-tui/wheel-speed.log` | 关 |

速度判定不看单次间隔，而是数「最近 400ms 内新手势的个数」——只有 <5ms 的连发算同一刻度：

- ≤9 次（≈22 格/秒）：纯慢速，完全不加速
- ≥18 次（≈45 格/秒）：拉满 `FAST`
- 中间线性过渡

## 它到底改了什么

dsh-TUI 0.15 已经有「每帧补水（`pendingScrollDelta`）」和「DECSTBM 硬件滚动」，缺的是**意图层**：
上游每个 wheel 事件硬编码 `±3` 行。补丁做三件事：

1. `App.js` 的 wheel 分支改调 `__dshWheelStep(dir)`（新增 `scroll-wheel-speed.js`）；
2. 用上面的 SLOW/FAST 模型算每次事件该走几行；
3. 一个 `ensure.sh` 在 `dst` 启动前自检，dsh-tui 升级覆盖后自动重打。

实测（PTY 探针，Ghostty 一档 = 3 事件）：

| 输入 | 原厂 | 补丁后 |
|---|---|---|
| 3 事件 @200ms | 9 行 | **1 行** |
| 15 事件 @25ms | 90 行 | 20–58 行（按手势密度） |

对照 Claude Code 2.1.302：慢滚 1 行/事件、25ms 连发 15 事件 39 行；`CLAUDE_CODE_SCROLL_SPEED=0.34` 也压不到 1 行以下——它的下限就是 1 行/事件。

## 文件

```
assets/patch.mjs             幂等打补丁 --ensure / --status / --revert
assets/scroll-wheel-speed.js 意图模型（SLOW/FAST + 400ms 手势窗）
assets/ensure.sh             dst 启动前自愈（no-op 约 16ms）
patcher.ts                   installAssets / readStatus / installHook
index.ts                     /dsh-scroll 接线
```

安装位置：`~/.dsh/patches/scroll-speed/`；备份写在 dsh-tui 包内 `.scroll-speed-backup/App.js.orig`。

## 出问题

- `status` 里 `patched: no`：跑 `/dsh-scroll apply`。
- dsh-tui 升级后第一次启动提示「滚轮代码结构变了」：说明上游改了 wheel 分支，补丁会保持原厂不硬改；更新 `assets/patch.mjs` 的匹配规则即可。
- 想彻底回到原厂：`/dsh-scroll revert`，再从 `~/.zshrc` 删掉 `dsh-scroll-speed` 标记块。

完整踩坑与实测数据：`docs/specs/2026-10-17-dsh-scroll-speed.md`。
