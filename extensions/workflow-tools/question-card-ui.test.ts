import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { CURSOR_MARKER, getKeybindings, KeybindingsManager, stripTerminalSequences, TuiAltScreen, TuiMainScreen, TUI_KEYBINDINGS, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { askQuestions, type CardOutcome, type QuestionSpec } from "./question-card.ts";
import { FALLBACK_GLYPHS, pickGlyphs, UNICODE_GLYPHS, VISIBLE_ITEMS } from "./question-card-ui.ts";

// 字形按终端能力二选一；本文件锁定 Unicode 档，能力判定本身另有专门用例。
process.env.TERM = "xterm-256color";
process.env.LANG = "en_US.UTF-8";

const DOWN = "\x1b[B";
const BACK_TAB = "\x1b[Z";
const ESC = "\x1b";
const ENTER = "\r";
const TAB = "\t";
const SPACE = " ";

function question(over: Partial<QuestionSpec> = {}): QuestionSpec {
	return {
		id: "q", header: "选择", question: "请选择", multiSelect: false,
		options: [{ label: "A", description: "第一个" }, { label: "B", description: "第二个" }],
		...over,
	};
}

function harness(t: TestContext, questions: QuestionSpec[] = [question()], rows = 24, columns = 80, keybindings = getKeybindings()) {
	let component: (Component & { focused?: boolean; dispose?(): void }) | undefined;
	let settle!: (value: CardOutcome | undefined) => void;
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
	const terminal = { rows, columns };
	const tui = { terminal, requestRender() {} } as unknown as TUI;
	const ctx = {
		mode: "tui", hasUI: true,
		ui: { custom(factory: (tui: TUI, theme: Theme, kb: typeof keybindings, done: (value: CardOutcome | undefined) => void) => Component) {
			return new Promise<CardOutcome | undefined>((resolve) => {
				settle = resolve;
				component = factory(tui, theme, keybindings, resolve);
				component.focused = true;
			});
		} },
	} as unknown as ExtensionContext;
	const controller = new AbortController();
	const result = askQuestions(ctx, questions, controller.signal);
	// 关闭要走完整条链：settle → 卡片 dispose → askQuestions 的 finally 释放活动锁。
	// 少了最后一步，同一测试里第二张卡会直接拿到 busy，组件根本没挂上。
	const close = async () => { settle(undefined); component?.dispose?.(); await result; };
	t.after(close);
	const input = (...data: string[]) => { for (const chunk of data) component!.handleInput!(chunk); };
	const lines = (width = columns) => component!.render(width).map(stripTerminalSequences);
	const plain = (width = columns) => lines(width).join("\n");
	const assertFits = (width = columns) => {
		for (const line of lines(width)) assert.ok(visibleWidth(line) <= width, `${width} 列下溢出：${JSON.stringify(line)}`);
	};
	return { input, lines, plain, result, controller, close, component: () => component!, terminal, assertFits };
}

// —— 布局与尺寸 ——

test("卡片总高不超过终端行数 − 4，且高度跟着内容走", async (t) => {
	for (const rows of [12, 24, 40]) {
		const short = harness(t, [question()], rows);
		assert.ok(short.lines().length <= rows - 4, `${rows} 行终端下短内容卡片 ${short.lines().length} 行`);
		await short.close();

		const long = harness(t, [question({ options: [
			{ label: "A", description: `长描述 ${"很长".repeat(300)}` },
			{ label: "B", description: "二" },
		] })], rows);
		assert.ok(long.lines().length <= rows - 4, `${rows} 行终端下长内容卡片 ${long.lines().length} 行`);
		await long.close();
	}
});

test("40/80/120 列 × 12/24/40 行下每行都不超过可用列宽", async (t) => {
	for (const columns of [40, 80, 120]) {
		for (const rows of [12, 24, 40]) {
			const card = harness(t, [question({ question: "问题".repeat(40) })], rows, columns);
			card.assertFits(columns);
			await card.close();
		}
	}
});

// —— 剪裁 ——

test("超长题目被剪裁并标注，卡片不因此变高", (t) => {
	const rows = 24;
	const card = harness(t, [question({ question: "题目".repeat(200) })], rows);
	const frame = card.lines();
	assert.ok(frame.length <= rows - 4);
	assert.ok(frame.some((line) => /✂ ─── \d+ lines hidden/.test(line)), "题目超长也要标注");
	card.assertFits();
});

// —— 选项行与状态 ——

test("单选行是「光标 + 序号 + 标签 + 勾」，四态可区分", (t) => {
	const card = harness(t, [question()], 24, 80);
	assert.ok(card.plain().includes("❯ 1. A"), "焦点项带光标");
	assert.ok(!card.plain().includes("✔"), "未选时没有勾");
	card.input(SPACE);
	assert.ok(card.plain().includes("✔"), "选中后有勾");
	card.input(DOWN);
	const after = card.plain();
	assert.ok(after.includes("❯ 2. B"), "焦点移走");
	assert.ok(after.includes("✔"), "已选标记不随焦点消失");
	assert.ok(!/2\. B ✔/.test(after), "焦点项不应显示为已选");
});

test("多选行带前置方框，空格切换勾选", (t) => {
	const card = harness(t, [question({ multiSelect: true })], 24, 80);
	assert.ok(card.plain().includes("☐"), "未选是空框");
	card.input(SPACE);
	assert.ok(card.plain().includes("☒"), "勾选后是实框");
	card.input(SPACE);
	assert.ok(card.plain().includes("☐"), "再按一次取消");
});

test("单选 Enter 直接选中并结束本题（单题卡片没有提交屏）", async (t) => {
	const card = harness(t, [question()], 24, 80);
	card.input(DOWN, ENTER);
	assert.deepEqual(await card.result, { kind: "answered", answers: { q: "B" } });
});

test("数字键直选：单选直接作答，多选只切换勾选", async (t) => {
	const single = harness(t, [question()], 24, 80);
	single.input("1");
	assert.deepEqual(await single.result, { kind: "answered", answers: { q: "A" } });
	await single.close();

	const multi = harness(t, [question({ multiSelect: true })], 24, 80);
	multi.input("2");
	assert.ok(multi.plain().includes("☒"), "数字键在多选里是切换勾选");
	assert.ok(multi.plain().includes("❯ 2. ☒ B"), "焦点跟到第 2 项且它被勾上");
	multi.input(ENTER);
	assert.deepEqual(await multi.result, { kind: "answered", answers: { q: "B" } });
});

test("多选 Enter 只确认已有勾选，不把焦点项暗中加进去", async (t) => {
	const card = harness(t, [question({ multiSelect: true })], 24, 80);
	card.input(SPACE, DOWN, ENTER);
	assert.deepEqual(await card.result, { kind: "answered", answers: { q: "A" } });
});

test("没有任何有效选择时按 Enter 报错并停在原地", (t) => {
	const card = harness(t, [question({ multiSelect: true }), question({ id: "q2", header: "第二", question: "第二题问什么" })], 24, 80);
	card.input(ENTER);
	assert.ok(card.plain().includes("请选择一项"), "空多选不能推进");
	assert.ok(card.plain().includes("请选择"), "仍停在第一题");
});

test("列表项超过 5 项时窗口滚动，焦点跟随并给出位置提示", (t) => {
	// 4 个选项 + Other + Chat = 6 项 > 5（Chat 只在单选出现，所以这里必须是单选）。
	const q = question({
		options: [
			{ label: "A", description: "" },
			{ label: "B", description: "" },
			{ label: "C", description: "" },
			{ label: "D", description: "" },
		],
	});
	const card = harness(t, [q], 24, 80);
	assert.ok(card.plain().includes("1/6"), "应出现位置提示");
	for (let i = 0; i < 5; i++) card.input(DOWN);
	assert.ok(card.plain().includes("6/6"), "焦点走到末项时提示跟着走");
	assert.ok(card.plain().includes("❯ 6. Chat about this"), "末项必须可见");
	assert.equal(VISIBLE_ITEMS, 5);
});

// —— 标签栏与多题 ——

test("标签栏呈现每题状态，Tab 前后切题且不隐式确认", (t) => {
	const questions = [question({ id: "a", header: "甲" }), question({ id: "b", header: "乙", question: "第二题问什么" })];
	const card = harness(t, questions, 24, 80);
	const bar = card.lines()[0]!;
	assert.ok(bar.includes("甲") && bar.includes("乙") && bar.includes("✔ 提交"), `标签栏：${bar}`);
	card.input(TAB);
	assert.ok(card.plain().includes("第二题问什么"), "应切到第二题");
	assert.ok(!card.plain().includes("核对答案"), "切题不等于进提交屏");
	card.input(BACK_TAB);
	assert.ok(card.plain().includes("请选择"), "应切回第一题");
});

test("窄终端下标签栏三层降级，最窄时回退 Q{n} 且不溢出", async (t) => {
	const questions = [question({ id: "a", header: "很长很长的标题甲" }), question({ id: "b", header: "很长很长的标题乙" }), question({ id: "c", header: "很长很长的标题丙" })];
	const wide = harness(t, questions, 24, 120);
	assert.ok(wide.lines()[0]!.includes("很长很长的标题甲"), "宽终端用自然宽");
	await wide.close();

	const compressed = harness(t, questions, 24, 60);
	assert.ok(visibleWidth(compressed.lines()[0]!) <= 60);
	assert.ok(compressed.lines()[0]!.includes("…"), `中等宽度应压缩：${compressed.lines()[0]}`);
	await compressed.close();

	// 箭头 + 提交按钮本身就占掉一条窄终端的全部宽度时，才退到「只留当前题 Q{n}」。
	const narrow = harness(t, questions, 24, 14);
	const bar = narrow.lines()[0]!;
	assert.ok(visibleWidth(bar) <= 14, `标签栏不得溢出：${bar}`);
	assert.ok(bar.includes("Q1"), `极窄时应回退 Q{n}：${bar}`);
});

test("提交屏逐题列出答案，缺项不能提交并定位到该题", (t) => {
	const questions = [question({ id: "a", header: "甲" }), question({ id: "b", header: "乙", question: "第二题问什么" })];
	const card = harness(t, questions, 24, 80);
	card.input(ENTER); // 答第一题 → 推进到第二题
	card.input(TAB); // 直接跳到提交屏
	assert.ok(card.plain().includes("核对答案"), "应进入提交屏");
	card.input(ENTER);
	assert.ok(card.plain().includes("请先作答"), "缺项应被挡回");
	assert.ok(card.plain().includes("第二题问什么"), "应定位到缺的那一题");
});

test("改一题不丢另一题：回退修改后整体提交结果一致", async (t) => {
	const questions = [question({ id: "a", header: "甲" }), question({ id: "b", header: "乙", options: [{ label: "X", description: "" }, { label: "Y", description: "" }] })];
	const card = harness(t, questions, 24, 80);
	card.input(ENTER); // 甲 = A → 乙
	card.input(SPACE, ENTER); // 乙 = X → 提交屏
	card.input(BACK_TAB); // 回提交屏的前一屏：乙
	card.input(BACK_TAB); // 再回甲
	card.input(DOWN, ENTER); // 甲 改成 B → 乙
	card.input(ENTER); // 乙 确认 → 提交屏
	card.input(ENTER); // 提交
	const outcome = (await card.result) as { answers: Record<string, string> };
	assert.deepEqual(outcome.answers, { a: "B", b: "X" });
});

// —— 备注与 Chat ——

test("n 进入备注、Esc 退回保留草稿、只填备注不算作答", (t) => {
	const questions = [question({ id: "a", header: "甲" }), question({ id: "b", header: "乙", question: "第二题问什么" })];
	const card = harness(t, questions, 24, 80);
	card.input("n");
	assert.ok(card.plain().includes("备注"), "应进入备注编辑");
	card.input("说", "明");
	card.input(ESC);
	assert.ok(card.plain().includes("说明"), "Esc 后草稿仍在");
	card.input(TAB); // 到第二题
	card.input(TAB); // 到提交屏
	card.input(ENTER);
	assert.ok(card.plain().includes("请先作答"), "只填备注不算作答");
	assert.ok(card.plain().includes("请选择"), "应被定位回第一题");
});

test("备注随答案进入 annotations[id].notes", async (t) => {
	const card = harness(t, [question()], 24, 80);
	card.input("n", "补", "充");
	card.input(ENTER);
	card.input(SPACE, ENTER);
	const outcome = (await card.result) as { answers: Record<string, string>; annotations?: Record<string, { notes?: string }> };
	assert.deepEqual(outcome.answers, { q: "A" });
	assert.equal(outcome.annotations?.q?.notes, "补充");
});

test("单选提供 Chat，选中后返回 chat 且不留下答案", async (t) => {
	const card = harness(t, [question()], 24, 80);
	assert.ok(card.plain().includes("Chat about this"));
	card.input(SPACE); // 先选一项，确认它不会混进结果
	card.input(DOWN, DOWN, DOWN); // 走到 Chat 行（A、B、Other、Chat）
	card.input(ENTER);
	assert.deepEqual(await card.result, { kind: "chat", answers: {} });
});

test("多选与提交屏都没有 Chat", async (t) => {
	const multi = harness(t, [question({ multiSelect: true })], 24, 80);
	assert.ok(!multi.plain().includes("Chat about this"));
	await multi.close();

	const questions = [question({ id: "a", header: "甲" }), question({ id: "b", header: "乙" })];
	const card = harness(t, questions, 24, 80);
	card.input(TAB, TAB);
	assert.ok(card.plain().includes("核对答案"));
	assert.ok(!card.plain().includes("Chat about this"), "提交屏不该有 Chat");
});

// —— 字形、取消与键位 ——

test("字形能力判定：Unicode 档与简易回退档", () => {
	assert.deepEqual(pickGlyphs({ TERM: "xterm-256color", LANG: "en_US.UTF-8" }), UNICODE_GLYPHS);
	assert.deepEqual(pickGlyphs({ TERM: "dumb", LANG: "en_US.UTF-8" }), FALLBACK_GLYPHS);
	assert.deepEqual(pickGlyphs({ TERM: "xterm", LANG: "C" }), FALLBACK_GLYPHS);
});

test("回退档终端整卡换成 > √ [×] [ ]", async (t) => {
	const saved = { TERM: process.env.TERM, LANG: process.env.LANG };
	process.env.TERM = "dumb";
	try {
		const card = harness(t, [question({ multiSelect: true })], 24, 80);
		assert.ok(card.plain().includes("> 1. [ ] A"), `回退档选项行：${card.lines().find((l) => l.includes("A"))}`);
		card.input(SPACE);
		assert.ok(card.plain().includes("[×]"), "回退档勾选是 [×]");
	} finally {
		process.env.TERM = saved.TERM;
		process.env.LANG = saved.LANG;
	}
});

test("Esc 取消整批，不返回局部答案", async (t) => {
	const questions = [question({ id: "a", header: "甲" }), question({ id: "b", header: "乙" })];
	const card = harness(t, questions, 24, 80);
	card.input(ENTER); // 先答一题
	card.input(ESC);
	assert.deepEqual(await card.result, { kind: "cancelled" });
});

test("AbortSignal 取消卡片并释放活动锁，重复取消不影响后续调用", async (t) => {
	const card = harness(t, [question()], 24, 80);
	card.controller.abort();
	assert.deepEqual(await card.result, { kind: "cancelled" });
	card.controller.abort();
	await card.close();

	const next = harness(t, [question()], 24, 80);
	next.input(SPACE, ENTER);
	assert.deepEqual(await next.result, { kind: "answered", answers: { q: "A" } });
});

test("Other 行行内输入：打字接在后面，走开后文字留着", (t) => {
	const card = harness(t, [question()], 24, 80);
	card.input(DOWN, DOWN);
	card.input("草", "稿");
	assert.ok(card.plain().includes("Other: 草稿"), `打字该接在 Other: 后面：\n${card.plain()}`);
	card.input("\x1b[A"); // ↑ 离开这一行
	assert.ok(card.plain().includes("❯ 2. B"), "焦点回到上一项");
	assert.ok(card.plain().includes("Other: 草稿"), "走开后文字还留着");
	card.input("\x1b[B", "\x1b[B"); // 回到 Other
	assert.ok(card.plain().includes("Other: 草稿"), "回来还能接着改");
});
test("注入的按键配置生效：改绑确认键后旧键不再确认", async (t) => {
	const keys = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.confirm": "ctrl+y" });
	const card = harness(t, [question()], 24, 80, keys);
	card.input(DOWN);
	card.input(ENTER);
	assert.ok(card.lines().length > 0, "旧键不该再确认：卡片应还开着");
	assert.ok(card.plain().includes("❯ 2. B"), "旧键也不该移动或选中");
	card.input("\x19"); // Ctrl+Y
	assert.deepEqual(await card.result, { kind: "answered", answers: { q: "B" } });
});

test("单个选项的描述超长时被剪掉并标注，卡片不超上限", (t) => {
	const rows = 24;
	const card = harness(t, [question({ options: [
		{ label: "A", description: "描述".repeat(300) },
		{ label: "B", description: "二" },
	] })], rows, 80);
	const frame = card.lines();
	assert.ok(frame.length <= rows - 4, `卡片高度 ${frame.length}`);
	assert.ok(frame.some((line) => /✂ ─── \d+ lines hidden/.test(line)), "超长描述要标注");
	card.assertFits();
});

test("备注超长时被剪掉并标注，卡片不超上限", (t) => {
	const card = harness(t, [question()], 24, 80);
	card.input("n", ..."备注说明".repeat(40).split(""));
	card.input(ENTER);
	const frame = card.lines();
	assert.ok(frame.length <= 20, `卡片高度 ${frame.length}`);
	assert.ok(frame.some((line) => /✂ ─── \d+ lines hidden/.test(line)), "超长备注要标注");
});

test("中文、emoji、组合字符、显式换行与无空格长 URL 都不溢出", async (t) => {
	const url = `https://example.com/${"a".repeat(200)}`;
	const text = `组合字符 é 与 emoji 👨‍👩‍👧 和 👩🏽‍🚀\n显式换行\n${url}`;
	for (const columns of [40, 80, 120]) {
		const card = harness(t, [question({
			question: text,
			options: [
				{ label: `标签 👩🏽‍🚀 ${"长".repeat(30)}`, description: text },
				{ label: "B", description: url },
			],
		})], 40, columns);
		card.assertFits(columns);
		assert.ok(card.plain(columns).includes("é"), "组合字符不该被丢掉");
		await card.close();
	}
});

test("Other 行空着时显示占位文案，采用后换成正文", async (t) => {
	const single = harness(t, [question()], 24, 80);
	assert.ok(single.plain().includes("Type something."), `单选占位：${single.plain()}`);
	await single.close();

	const multi = harness(t, [question({ multiSelect: true })], 24, 80);
	assert.ok(multi.plain().includes("Type something"), "多选占位应存在");
	assert.ok(!multi.plain().includes("Type something."), "多选占位不带句号");
	await multi.close();

	// 单题卡片采用 Other 就直接结束了，看不到列表——用两题卡回退着看。
	const adopted = harness(t, [question({ id: "a", header: "甲" }), question({ id: "b", header: "乙" })], 24, 80);
	adopted.input(DOWN, DOWN);
	adopted.input("自", "己", "写", ENTER); // 采用 → 推进到第二题
	adopted.input(BACK_TAB); // 回第一题看列表
	assert.ok(adopted.plain().includes("自己写"), "采用后显示正文");
	assert.ok(!adopted.plain().includes("Type something"), "采用后不该再显示占位");
});

test("空格落在 Chat 行上同样是「先聊」，不会把它当成一个选项", async (t) => {
	const card = harness(t, [question()], 24, 80);
	card.input(DOWN, DOWN, DOWN); // 走到 Chat 行
	card.input(SPACE);
	assert.deepEqual(await card.result, { kind: "chat", answers: {} });
});

// —— 对抗式审核抓到的回归（每条都对着一个具体复现路径） ——

test("单选：选了普通项之后，已采用的 Other 不能留在答案里", async (t) => {
	const questions = [question({ id: "a", header: "甲" }), question({ id: "b", header: "乙", question: "第二题" })];
	const card = harness(t, questions, 24, 80);
	card.input(DOWN, DOWN); // 移到 Other 行
	card.input("补", "充", ENTER); // 打字 + 采用 → 推进到第二题
	card.input(BACK_TAB); // 回第一题（焦点还停在 Other 行上）
	card.input("\x1b[A"); // 先离开 Other 行——在它上面按数字是打字，不是选项编号
	card.input("1"); // 数字键直选 A —— 它必须顶掉 Other
	card.input(ENTER); // 第二题确认 → 提交屏
	card.input(ENTER); // 提交
	const outcome = (await card.result) as { answers: Record<string, string>; responses?: Record<string, string> };
	assert.deepEqual(outcome.answers, { a: "A", b: "A" });
	assert.equal(outcome.responses, undefined, "Other 已被普通项顶掉，不该再出现在 responses 里");
});

test("40×12 多题：选项列表不会被整块剪没，至少保住标签行", (t) => {
	const card = harness(t, [question(), question({ id: "b", header: "乙", question: "第二题" })], 12, 40);
	const frame = card.lines(40);
	assert.ok(frame.some((line) => line.includes("1. A")), `至少要看得见选项标签：\n${frame.join("\n")}`);
	card.assertFits(40);
});

test("提交屏放不下时给剪裁标注，且能上下翻到最后一条", (t) => {
	const questions = [question({ id: "a", header: "甲" }), question({ id: "b", header: "乙" }), question({ id: "c", header: "丙" })];
	const card = harness(t, questions, 12, 80);
	card.input(ENTER, ENTER, ENTER); // 三题各答第一项 → 提交屏
	assert.ok(card.plain().includes("核对答案"));
	assert.ok(!card.plain().includes("3. 丙"), "第三题确实放不下");
	assert.ok(card.plain().includes("✂"), "放不下要标注，不能静默丢弃");
	card.input(DOWN, DOWN, DOWN, DOWN);
	assert.ok(card.plain().includes("3. 丙"), "↓ 要能翻到最后一条");
});

test("焦点走到最后一项时窗口保留上下文，不塌成一项", (t) => {
	const card = harness(t, [question({
		options: [{ label: "甲", description: "" }, { label: "乙", description: "" }, { label: "丙", description: "" }, { label: "丁", description: "" }],
	})], 24, 80);
	for (let i = 0; i < 5; i++) card.input(DOWN);
	const frame = card.lines(80);
	assert.ok(frame.some((line) => line.includes("❯ 6. Chat about this")), "焦点应在末项");
	const items = frame.filter((line) => /^\s*(❯ )?\d\./.test(line));
	assert.equal(items.length, VISIBLE_ITEMS, `窗口该留住 ${VISIBLE_ITEMS} 项：\n${frame.join("\n")}`);
});

// —— 上一版就有、本轮重写测试时被漏掉的两块覆盖（编辑器粘贴与浮层补偿） ——

test("长粘贴还原全文可编辑，原生撤销仍可撤回整个粘贴", async (t) => {
	const card = harness(t, [question()], 24, 80);
	card.input(DOWN, DOWN, `\x1b[200~${"x".repeat(1100)}\x1b[201~`);
	card.input("\x1b[D", "\x7f", "z");
	card.input(ENTER);
	const result = (await card.result) as { kind: string; responses?: Record<string, string> };
	assert.equal(result.kind, "answered");
	assert.equal(result.responses?.q, `${"x".repeat(1098)}zx`);
});

test("编辑态撤销粘贴不产生粘贴标记残留", async (t) => {
	const card = harness(t, [question()], 24, 80);
	card.input(DOWN, DOWN, "prefix", `\x1b[200~${"x".repeat(1100)}\x1b[201~`, "\x1b[45;5u", ENTER);
	const result = (await card.result) as { kind: string; responses?: Record<string, string> };
	assert.equal(result.kind, "answered");
	assert.equal(result.responses?.q, "prefix");
});

test("中文、emoji 和组合字符按完整字素删除", async (t) => {
	const card = harness(t, [question()], 24, 80);
	card.input(DOWN, DOWN, "中文😀é", "\x7f", "\x7f", ENTER);
	assert.deepEqual(await card.result, { kind: "answered", answers: { q: "中文" }, responses: { q: "中文" } });
});

test("粘贴中的控制字节不取消或提交卡片", async (t) => {
	const card = harness(t, [question()], 24, 80);
	card.input(DOWN, DOWN, "\x1b[200~a", "\x1b", "\r\nb\x03", "\x1b[201~", ENTER);
	assert.deepEqual(await card.result, { kind: "answered", answers: { q: "a\nb" }, responses: { q: "a\nb" } });
});

test("窄矮屏编辑仍有可见光标，长输入可向前翻到开头", (t) => {
	const card = harness(t, [question()], 12, 40);
	card.input(DOWN, DOWN, `\x1b[200~${Array.from({ length: 30 }, (_, i) => `line-${i}`).join("\n")}\x1b[201~`);
	// CURSOR_MARKER 是 APC 转义序列，会被 stripTerminalSequences 抹掉——这一条要看原始帧。
	const raw = card.component().render(40);
	assert.ok(raw.length <= 8, `卡片不该超过上限：${raw.length}`);
	assert.ok(raw.some((line) => line.includes(CURSOR_MARKER)), "编辑态必须有可见光标");
});

const STUB_TERMINAL = {
	columns: 80, rows: 24, kittyProtocolActive: false,
	start() {}, stop() {}, async drainInput() {}, write() { return ""; },
	moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
};

/**
 * 按 Pi 的真实挂法走一遍：`ui.custom(factory, options)` 收到什么就照做什么。
 * 只测卡片自己处理按键是不够的——关闭路径走的是宿主浮层栈，挂法错了会留下死浮层。
 */
function mountedCard(t: TestContext, TuiClass: typeof TuiAltScreen | typeof TuiMainScreen, questions: QuestionSpec[]) {
	const tui = new TuiClass(STUB_TERMINAL as never, false);
	let component!: Component & { dispose?(): void };
	let close!: (value: CardOutcome | undefined) => void;
	const ctx = {
		mode: "tui", hasUI: true,
		ui: {
			custom(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (value: CardOutcome | undefined) => void) => typeof component, options?: { overlay?: boolean; overlayOptions?: unknown; onHandle?: (handle: unknown) => void }) {
				return new Promise<CardOutcome | undefined>((resolve) => {
					close = (value) => {
						if (options?.overlay) tui.hideOverlay();
						resolve(value);
					};
					component = factory(tui as unknown as TUI, { fg: (_c: string, text: string) => text, bold: (text: string) => text } as Theme, getKeybindings(), close);
					if (options?.overlay) options.onHandle?.(tui.showOverlay(component, options.overlayOptions as never));
					else { tui.addChild(component); tui.setFocus(component); }
				});
			},
		},
	} as unknown as ExtensionContext;
	const controller = new AbortController();
	const result = askQuestions(ctx, questions, controller.signal);
	t.after(async () => { controller.abort(); await result; });
	return { tui, abort: () => controller.abort(), result };
}

test("关闭时宿主浮层压在上面，卡片条目也不能留在浮层栈里", async (t) => {
	const card = mountedCard(t, TuiAltScreen, [question()]);
	// 模拟答题期间用户打开了 Pi 自己的浮层（全屏转录搜索），此时卡片被中止。
	// 关闭必须由卡片自己发起：命中 Pi 的 close 后它弹的是「栈顶那条」。
	card.tui.showOverlay({ render: () => [""], invalidate() {}, handleInput() {} }, { width: 10 });
	assert.equal(card.tui.hasOverlay(), true);
	card.abort();
	await card.result;
	assert.equal(card.tui.hasOverlay(), false, "残留的死浮层会让全屏视口键一直让路，且只有重启能恢复");
});

test("卡片自己的颜色序列不被破坏，外部文本里的转义序列会被剥掉", async (t) => {
	// 这条必须用会真吐 ANSI 的主题：恒等主题下「ESC 被清洗吃掉」是看不出来的
	// （真机上表现为整卡颜色变成可见的 `[39m`）。
	let component!: Component & { focused?: boolean; dispose?(): void };
	const theme = {
		fg: (color: string, text: string) => `\x1b[${color === "accent" ? "36" : "39"}m${text}\x1b[39m`,
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	} as Theme;
	const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {} } as unknown as TUI;
	const ctx = {
		mode: "tui", hasUI: true,
		ui: { custom(factory: (tui: TUI, theme: Theme, kb: KeybindingsManager, done: (v: CardOutcome | undefined) => void) => Component) {
			return new Promise<CardOutcome | undefined>((resolve) => {
				component = factory(tui, theme, getKeybindings(), resolve);
				component.focused = true;
			});
		} },
	} as unknown as ExtensionContext;
	const controller = new AbortController();
	const result = askQuestions(ctx, [question({
		question: "题\x1b[31m红",
		options: [{ label: "A\x1b[32m绿", description: "" }, { label: "B", description: "" }],
	})], controller.signal);
	t.after(async () => { controller.abort(); component.dispose?.(); await result; });

	const raw = component.render(80).join("\n");
	const plain = stripTerminalSequences(raw);
	assert.ok(raw.includes("\x1b[36m"), "焦点光标的强调色序列应完整保留");
	assert.ok(!plain.includes("[36m") && !plain.includes("[39m"), `不该有被截断的转义序列残留：${plain}`);
	assert.ok(!raw.includes("\x1b[31m") && !raw.includes("\x1b[32m"), "外部文本里的转义序列不能穿进渲染");
	assert.ok(plain.includes("题红") && plain.includes("A绿"), "剥掉转义后正文要留着");
});

// —— Other 行「打字即进编辑器」（上游的 Other 就是个内联输入框，不需要先按 Enter） ——

test("焦点在 Other 行时直接打字就进编辑器，并吃掉这一下输入", async (t) => {
	const card = harness(t, [question()], 24, 80);
	card.input(DOWN, DOWN); // 移到 Other
	card.input("你", "好"); // 直接打字
	assert.ok(card.plain().includes("你好"), "打字应进编辑器并落到草稿上");
	card.input(ENTER);
	const outcome = (await card.result) as { answers: Record<string, string> };
	assert.equal(outcome.answers.q, "你好");
});

test("Other 行上整段粘贴同样直接进编辑器", async (t) => {
	const card = harness(t, [question()], 24, 80);
	card.input(DOWN, DOWN, "\x1b[200~第一行\n第二行\x1b[201~");
	assert.ok(card.plain().includes("第一行"), "粘贴应进编辑器");
	card.input(ENTER);
	const outcome = (await card.result) as { responses?: Record<string, string> };
	assert.equal(outcome.responses?.q, "第一行\n第二行");
});

test("普通项上打字不误开编辑器", async (t) => {
	const card = harness(t, [question()], 24, 80);
	card.input("你", "好");
	assert.ok(!card.plain().includes("你好"), "焦点在普通项上打字不该开 Other 编辑器");
	assert.ok(card.plain().includes("❯ 1. A"), "焦点应留在原地");
});

// —— 终端按键编码：整卡只有 Other 行行内编辑器接得到这两种，别的路径一律丢弃 ——

test("终端把按键编成 kitty CSI-u 时，Other 行照样收得到", async (t) => {
	const card = harness(t, [question()], 24, 80);
	card.input(DOWN, DOWN);
	card.input("\x1b[97u", "\x1b[98u"); // kitty 编码的 a、b
	assert.ok(card.plain().includes("Other: ab"), `CSI-u 该被解码成正文：\n${card.plain()}`);
	card.input(ENTER);
	const outcome = (await card.result) as { responses?: Record<string, string> };
	assert.equal(outcome.responses?.q, "ab");
});

test("终端把按键编成 modifyOtherKeys 时，Other 行照样收得到", async (t) => {
	const card = harness(t, [question()], 24, 80);
	card.input(DOWN, DOWN);
	card.input("\x1b[27;1;97~"); // modifyOtherKeys 编码的 a
	assert.ok(card.plain().includes("Other: a"), `modifyOtherKeys 该被解码：\n${card.plain()}`);
	card.input(ENTER);
	const outcome = (await card.result) as { responses?: Record<string, string> };
	assert.equal(outcome.responses?.q, "a");
});

// —— 对抗式审核抓到的回归（每条对着一个具体复现路径） ——

test("多选：把 Other 正文删空即取消，答案里不再有它", async (t) => {
	const questions = [question({ id: "a", header: "甲", multiSelect: true }), question({ id: "b", header: "乙", question: "第二题" })];
	const card = harness(t, questions, 24, 80);
	card.input(DOWN, DOWN);
	card.input("补", "充", ENTER); // 采用 → 推进到第二题
	card.input(BACK_TAB); // 回第一题（焦点仍在 Other 行）
	card.input("\x7f", "\x7f"); // 把正文删空——注意全程不再按 Enter 落在 Other 行上：
	// 这里要验的正是「删空本身就该取消」，而不是「按 Enter 时被顺手清掉」。
	card.input("\x1b[A", "\x1b[A", " "); // 离开 Other 行 → 勾上 A
	card.input(ENTER, ENTER, ENTER); // 确认 → 提交屏 → 提交
	const outcome = (await card.result) as { answers: Record<string, string>; responses?: Record<string, string> };
	assert.deepEqual(outcome.answers, { a: "A", b: "A" });
	assert.equal(outcome.responses, undefined, "删空的 Other 不能留在答案里");
});

test("宿主抢过焦点再还回来，行内编辑器仍把光标行显示出来", (t) => {
	const card = harness(t, [question()], 24, 40);
	card.input(DOWN, DOWN);
	const component = card.component();
	component.focused = false;
	assert.ok(!component.render(40).join("\n").includes(CURSOR_MARKER), "失焦时不该占着硬件光标");
	component.focused = true;
	card.input("头", "x".repeat(200), "尾");
	const raw = component.render(40).join("\n");
	assert.ok(raw.includes(CURSOR_MARKER), "回到焦点后光标要回来");
	assert.ok(raw.includes("尾"), "开窗该跟着光标走到末尾");
});

test("宿主把确认键改绑后，Enter 不再清空 Other 正文", async (t) => {
	const keys = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.confirm": "ctrl+y" });
	const card = harness(t, [question()], 24, 80, keys);
	card.input(DOWN, DOWN, "重要内容");
	card.input(ENTER);
	assert.ok(card.plain().includes("重要内容"), "Enter 已不是确认键，就不该动正文");
	card.input("\x19"); // Ctrl+Y
	const outcome = (await card.result) as { responses?: Record<string, string> };
	assert.equal(outcome.responses?.q, "重要内容");
});

test("极窄终端下 Other 行不崩也不溢出", async (t) => {
	for (const columns of [12, 14, 20]) {
		const card = harness(t, [question()], 24, columns);
		card.input(DOWN, DOWN, "中文😀x");
		for (const line of card.component().render(columns)) {
			assert.ok(visibleWidth(line) <= columns, `${columns} 列溢出：${JSON.stringify(line)}`);
		}
		await card.close();
	}
});
