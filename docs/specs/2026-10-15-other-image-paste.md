# 选项卡 Other 行：从剪贴板粘贴（含图片）

- 日期：2026-10-15
- 类型：方案期 spec
- 状态：待审
- Issue：（待 spec 合并后开）
- 现状基线：`5da7265`（main）
- 适用环境：Pi 1.2.x 的终端交互模式（TUI）
- 前序规格：[`2026-10-15-question-card-cc-parity.md`](./2026-10-15-question-card-cc-parity.md)（选项卡本体，本文件不改它；两份并存，涉及 Other 行的粘贴行为以本文件为准）
- 用户确认：本轮用户要求「给 Other 增加粘贴图片」，并在两问卡上确认：**照官方做法**（图片存临时文件、路径写进正文，不把图片字节塞进正文）；**不画缩略图**；规格**新开一份**。

## 1. 目标

`ask_user_question` 卡片的 Other 行支持从系统剪贴板粘贴，行为与 Pi 主输入框一致：

1. 按宿主键位绑定的粘贴键（默认 `Ctrl+V`）把剪贴板内容接进 `Other: ` 正文。
2. 剪贴板里是**图片字节**（截图、网页「复制图片」）时，先落成临时文件，再把**文件路径**当作正文插入。
3. 剪贴板里是**文件**（Finder 里复制的文件）时，插入其原始路径。
4. 其余情况插入文本。
5. 插入结果就是普通正文：可继续编辑、可退格删掉、随答案交给模型。

本文件定义需求、行为和验收，不编排实施任务或提交顺序。

## 2. 一手依据（官方做法，本机安装的 Pi 1.2.0）

| 结论 | 当场核对的依据 |
|---|---|
| 粘贴键是应用级键位 `app.clipboard.pasteImage`，默认 `ctrl+v`（Windows / WSL 是 `alt+v`） | `docs/keybindings.md:129`：`` \| `app.clipboard.pasteImage` \| `ctrl+v` (`alt+v` on Windows and WSL) \| Paste files on macOS, images, or text from clipboard \| `` |
| 官方语义：文件用原路径、图片走临时文件、文本兜底 | `dist/modes/interactive/interactive-mode.js:2476` 注释原文：`// Handle clipboard paste (triggered on Ctrl+V). Copied files use their original paths, images are attached via temporary files, and plain text is the final fallback.` |
| 图片的实现是「落临时文件 + 插入路径」 | 同文件 `:2515-2525`：`const image = await readClipboardImage(); … const fileName = \`pi-clipboard-${crypto.randomUUID()}.${ext}\`; const filePath = path.join(os.tmpdir(), fileName); fs.writeFileSync(filePath, Buffer.from(image.bytes)); this.editor.insertTextAtCursor?.(filePath);` |
| 文件路径分支会防控制字符，并在光标两侧补空格 | 同文件 `:2496-2514`：`readClipboardFilePaths()` → 命中控制字符就抛错；按光标前后字符决定是否补空格，再 `insertTextAtCursor` |
| 图片进模型的形态是消息里的 `ImageContent`（base64 + mimeType），把「路径」变成图片靠读文件那一步 | `docs/message-types.md` 的 `ImageContent { type: "image"; data: string; mimeType: string }`；`docs/models.md:71` 提到 `inputLimits.images.resize` 作用于「new image attachments, `read` results, and tool-result images」 |
| 这个键只在编辑器组件里处理，浮层拿到焦点时编辑器收不到 | `dist/modes/interactive/components/custom-editor.js:68`：`if (this.keybindings.matches(data, "app.clipboard.pasteImage")) { this.onPasteImage?.(); return; }`——它是编辑器 `handleInput` 里的一支，不是全局监听 |
| 扩展拿不到 Pi 内部的剪贴板读取函数（包 `exports` 只放行根路径），但 pi-tui 的剪贴板接口可用 | `@earendil-works/pi-coding-agent` 的 `package.json` 只有 `"."` 与 `"./rpc-entry"` 两个导出；而 pi-tui 导出 `getNativeClipboard()`，其 `NativeClipboard` 有 `getText()` / `getImage(): Promise<Uint8Array \| null \| undefined>` / `getFilePaths?()`（`dist/native-platform.d.ts`） |
| 本机（macOS）剪贴板接口实测可用 | 当场跑 `getNativeClipboard()`：对象存在，三个方法都是 function；`getImage()` 返回 `null`（当时剪贴板里没有图片，不是不支持）；pi-tui 自带 `native/clipboard.h` + `native/darwin/` 原生模块 |
| 扩展侧给卡片的键位管理器就是应用键位那一份 | `interactive-mode.js:2372`：`factory(this.ui, theme, this.keybindings, close)`——`this.keybindings` 同时被 `custom-editor.js` 用来匹配 `app.clipboard.pasteImage` |

**没能取到的一手结论**：

- `readClipboardImage()` 内部的 mime 判定与各平台分支（该文件不在包导出里，读不到）。**扩展名只能按字节头认**：pi-tui 的 `getNativeClipboard().getImage()` 只返回字节、不返回 mime（`native-platform.d.ts` 的签名就是 `Promise<Uint8Array | null | undefined>`），宿主那份带 mime 的读取器又没从包根导出，见第 6 节第 1 条。
- 生态里的第三方扩展（`pi-inline-image-paste` 等）走「正文显示 `[图片 N]`、提交时才附上」的路线，且需要解绑内置键位。本规格**不采用**那条路线：它们是替换编辑器才需要解绑，我们是浮层，不存在这个冲突。

## 3. 范围

### 包含

- Other 行上的粘贴键：键位来源、生效条件、插入位置。
- 三类剪贴板内容（文件路径 / 图片字节 / 文本）的判定顺序与各自处理。
- 图片落临时文件的命名、目录、扩展名映射。
- 失败与降级行为（剪贴板不可用、内容为空、写文件失败）。
- 与既有方括号粘贴（`\x1b[200~ … \x1b[201~`）的关系。
- README 与自动化测试。

### 不包含

- **图片缩略图渲染**（用户明确不要；kitty / iTerm2 图形协议的相关能力本轮不用）。
- 改动结果契约：插入的是路径文本，`answers` / `responses` / `annotations` 结构不变。
- 终端文件拖拽（drop）——那是另一条通路，不在本规格内。
- RPC / `json` / `print` 模式：沿用现状降级，不提供粘贴。
- 覆盖或解绑 Pi 内置的 `app.clipboard.pasteImage`：卡片只在持有焦点时处理它，不修改宿主配置。
- 图片的压缩、缩放、格式转换。

## 4. 交互与行为

### 4.1 触发条件

- 键位取自宿主注入的键位配置里的 `app.clipboard.pasteImage`，**不写死 `Ctrl+V`**；宿主改绑后跟着变。
- 只在**焦点位于 Other 行**、且卡片持有焦点、且当前不是提交屏时处理；其他位置的粘贴键维持现状（不拦截）。
- 方括号粘贴（终端把文本包在 `\x1b[200~ … \x1b[201~` 里送达）走原有路径，**不经过本机制**——它已经是文本。

### 4.2 判定顺序

按下面的顺序取，取到就停：

1. **文件路径**：剪贴板里是文件 URL（`getFilePaths()`）→ 插入原路径。多个文件按行连接；路径里含控制字符时整批拒绝，显示错误并保持正文不变。
2. **图片字节**：`getImage()` 返回字节 → 落临时文件 → 插入该文件路径。
3. **文本**：`getText()` 非空 → 插入文本。
4. 都没有（或接口不可用）→ **什么都不做**，不报错、不插入空内容。

### 4.3 图片落盘

- 目录：`os.tmpdir()`（与宿主一致）。
- 文件名：`pi-clipboard-<uuid>.<ext>`，与主输入框同前缀，便于识别与清理。
- 扩展名按**字节头（魔数）**认；认不出来时用 `png`。
- 文件写失败 → 显示错误、正文不变；不得留下半截路径。

### 4.4 插入方式

- 插入点 = 编辑器当前光标位置（不是永远追加到末尾）。
- 插入的文本按普通正文处理：可继续编辑、退格删除；其中的换行不触发提交。
- 光标两侧已有非空白字符时补空格，避免路径与前后文粘成一个词（照宿主做法）。

### 4.5 与 Other 行其他按键的关系

- 该键在 Other 行的按键路由里**优先于「当正文输入」**（否则 `Ctrl+V` 会被当成控制字符塞进正文）。
- 不影响 `Enter` / `↑↓` / `Tab` / `Esc` 的既有语义（见选项卡规格 §7.2）。

## 5. 与主输入框的一致性

| 维度 | 主输入框（官方） | 本规格 | 说明 |
|---|---|---|---|
| 键位 | `app.clipboard.pasteImage` | 同 | 跟随宿主配置 |
| 判定顺序 | 文件 → 图片 → 文本 | 同 | — |
| 临时文件命名 | `pi-clipboard-<uuid>.<ext>` | 同 | — |
| 图片渲染 | 部分终端支持内联渲染 | **不渲染** | 用户明确不要缩略图 |
| 拖拽文件 | 支持（drop files to attach） | 不支持 | 本规格范围外 |

## 6. 自定细节（作者确定，非用户逐项指定）

1. **字节头 → 扩展名映射**：PNG `89 50 4E 47…`→`png`、JPEG `FF D8 FF`→`jpg`、GIF `GIF8`→`gif`、WebP `RIFF….WEBP`→`webp`、BMP `BM`→`bmp`、TIFF `II*\0` / `MM\0*` / BigTIFF `II+\0`→`tiff`；认不出来一律 `png`。
   **为什么不是按 mime**：`getImage()` 只给字节（见第 2 节末），拿不到 mime；兜底与上游一致（上游也是认不出就用 `png`）。
2. **剪贴板读取失败静默忽略**：宿主自己的实现就是静默吞掉剪贴板错误（`interactive-mode.js:2492` 的 `catch { // Silently ignore clipboard errors }`），本规格跟随；只有「路径含控制字符」与「写临时文件失败」两种会显错。
3. **不改卡片布局**：路径按普通正文渲染（`Other: /tmp/pi-clipboard-xxx.png`），超长时按选项卡规格 §6.1 的剪裁规则处理，不新增展示形式。
4. **不清理临时文件**：与宿主一致，交由系统清理 `os.tmpdir()`。卡片结束时不删——答案里引用的就是这个路径，删了模型就读不到。
5. **文件路径多值**：多个文件用换行连接（不是逗号），与宿主非 bash 模式一致。
6. **剪贴板接口通过依赖注入**：纯逻辑层接收一个「剪贴板读取器」参数，便于单测不碰真实剪贴板。

## 7. 验收标准

### 7.1 自动化

- [ ] 键位取自宿主配置：把 `app.clipboard.pasteImage` 改绑后，新键触发、旧键不触发（与选项卡规格 §7.5 的口径一致）。
- [ ] 焦点不在 Other 行时，粘贴键不被本机制接管（不插内容、不报错）。
- [ ] 提交屏上按粘贴键无副作用。
- [ ] 三类内容按「文件 → 图片 → 文本」顺序命中：注入假剪贴板，断言每类各自走到对应分支，且前一类命中时后面不被调用。
- [ ] 图片分支：写出的文件路径形如 `<tmpdir>/pi-clipboard-<uuid>.<ext>`，扩展名随**字节里的格式**变；文件内容与注入字节一致。
- [ ] 认不出的格式落到 `png`。
- [ ] 剪贴板空/不可用：不插入任何内容、不报错、正文不变。
- [ ] 文件路径含控制字符：显示错误、正文不变、不插入。
- [ ] 写文件失败（注入会抛的写入器）：显示错误、正文不变、不留半截路径。
- [ ] 插入位置是当前光标处，不是永远追加末尾；两侧非空白时补空格。
- [ ] 插入的文本可继续编辑、可退格删掉；其中换行不提交。
- [ ] 方括号粘贴仍走原路径（不受本机制影响）。
- [ ] 结果契约不变：`answers` / `responses` / `annotations` 结构与插入前一致，路径就是普通字符串。
- [ ] `npm run check`、`npm test` 通过，无新增第三方运行时依赖。

### 7.2 真实终端

- [ ] macOS：截图（⌘⇧⌃4）后按粘贴键，正文里出现 `/tmp/pi-clipboard-*.png`，文件确实存在且能被 `read` 工具读到（图片内容进上下文）。
- [ ] macOS：Finder 里复制一个文件后按粘贴键，插入的是它的原始路径。
- [ ] 复制一段文本后按粘贴键，插入的是文本。
- [ ] 剪贴板为空时按粘贴键，无任何变化、不报错。
- [ ] 记录终端种类、Pi 版本、模式与结果；未验的平台（Windows / WSL / Linux 的剪贴板后端）明确标为未验。

## 8. 机制清单

| 机制 | 解决什么 / 没有它会怎样 |
|---|---|
| 剪贴板三级回退（文件 → 图片 → 文本） | 让「复制的是文件 / 是图片 / 是文字」三种情况都有合理落点；没有它，图片与文件都无处安放。 |
| 图片落临时文件 + 插入路径 | 剪贴板图片在磁盘上没有文件，而模型只能读文件；没有它，要么把 base64 塞进正文（污染答案、撑爆上下文），要么这个能力根本做不了。 |
| 可注入的剪贴板读取器 | 让纯逻辑层能在单测里跑，不用碰真实剪贴板；没有它，这块只能靠真机手测。 |

## 9. 改动边界

实施预计涉及：

- **新增** `extensions/workflow-tools/clipboard-paste.ts`：剪贴板读取与三级回退的纯逻辑（不含渲染、不依赖卡片状态）。
- `extensions/workflow-tools/question-card-ui.ts`：Other 行的按键路由里接上粘贴键，并把结果插进行内编辑器。
- `extensions/workflow-tools/question-card-ui.test.ts`：按键与插入行为。
- **新增** `extensions/workflow-tools/clipboard-paste.test.ts`：三级回退与落盘的纯逻辑用例。
- `README.md`：卡片操作段补一条粘贴说明。
- 本规格文件自身。

本规格交付只新增当前文档，不修改上述实现或旧规格。

## 10. 待定与风险

- **Windows / WSL / Linux 未验**：键位是 `alt+v`，剪贴板后端分别是同名原生模块与 `wl-clipboard` / `xclip`。本机只有 macOS，这三条只能标未验。
- **`getNativeClipboard()` 在无原生模块时的行为**：返回 `undefined` 还是对象但方法抛错，未实测；实现按「拿不到就当没有」处理。
- **扩展名靠字节头认**：极端构造的字节可能认错格式（例如恰好以 `BM` 开头的非 BMP）；影响仅限于临时文件的扩展名，不改变图片内容。
- **超长路径**：路径本身可能很长，按选项卡规格的剪裁规则显示；被剪掉不影响插入的完整文本。

## 11. 修订记录

- 2026-10-15，实施 PR #17 合并后发现：规格 §4.3/§7.1 写的是「扩展名按 mime 映射」，而实施按字节头认（pi-tui 的 `getImage()` 不返回 mime，宿主带 mime 的读取器没从包根导出）。经用户点头，**直接改已合并规格的正文**：§4.3、§7.1 与自定细节第 1 条改成「按字节头（魔数）认」，并在第 2 节末与 §10 补上原因与风险。实现未改动。
