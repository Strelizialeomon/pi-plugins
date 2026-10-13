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

## 发布（可选）

`package.json` 里现在有 `"private": true` 防手滑。要发 npm 时去掉它，并保留 `pi-package` 关键字，才能进 [Pi package gallery](https://pi.dev/packages)。
