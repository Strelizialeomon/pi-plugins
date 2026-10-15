import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { getKeybindings, KeybindingsManager, stripTerminalSequences, TUI_KEYBINDINGS, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
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

function withPreview(over: Partial<QuestionSpec> = {}): QuestionSpec {
	return question({
		options: [
			{ label: "A", description: "第一个", preview: "预览一\n预览二" },
			{ label: "B", description: "第二个" },
		],
		...over,
	});
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

test("单选且有预览、终端够宽时走并排：左栏 30 列、右栏占其余", (t) => {
	const card = harness(t, [withPreview()], 24, 80);
	const frame = card.lines();
	assert.ok(frame.some((line) => line.startsWith("❯ 1. A")), "左栏应从第 1 列开始");
	assert.ok(frame.some((line) => line.includes("┌")), "右栏应带边框");
	card.assertFits();
});

test("多选、无预览、终端过窄三种情况都不走并排", async (t) => {
	const multi = harness(t, [withPreview({ multiSelect: true })], 24, 80);
	assert.ok(!multi.lines().some((line) => line.includes("┌")), "多选不该有预览栏");
	await multi.close();

	const noPreview = harness(t, [question()], 24, 80);
	assert.ok(!noPreview.lines().some((line) => line.includes("┌")), "无预览不该有预览栏");
	await noPreview.close();

	// 单列时预览跟在正文之后、铺满整宽；并排时它一定从第 35 列（30 + 4）开始。
	const narrow = harness(t, [withPreview()], 24, 40);
	const narrowFrame = narrow.lines();
	assert.ok(!narrowFrame.some((line) => line[34] === "┌"), "40 列不该并排");
	assert.ok(narrowFrame.some((line) => line.startsWith("┌")), "单列时预览应铺满整宽");
});

test("卡片总高不超过终端行数 − 4，且高度跟着内容走", async (t) => {
	for (const rows of [12, 24, 40]) {
		const short = harness(t, [question()], rows);
		assert.ok(short.lines().length <= rows - 4, `${rows} 行终端下短内容卡片 ${short.lines().length} 行`);
		await short.close();

		const long = harness(t, [withPreview({ options: [
			{ label: "A", description: "一", preview: Array.from({ length: 60 }, (_, i) => `预览 ${i}`).join("\n") },
			{ label: "B", description: "二" },
		] })], rows);
		assert.ok(long.lines().length <= rows - 4, `${rows} 行终端下长内容卡片 ${long.lines().length} 行`);
		await long.close();
	}
});

test("并排时移动焦点不改形态，焦点落到无预览的选项时右栏显示占位", (t) => {
	const card = harness(t, [withPreview()], 24, 80);
	assert.ok(card.plain().includes("预览一"));
	card.input(DOWN);
	const after = card.plain();
	assert.ok(after.includes("┌"), "移动焦点后仍是并排");
	assert.ok(after.includes("本项无预览"), "无预览项应显示占位而非收起右栏");
});

test("40/80/120 列 × 12/24/40 行下每行都不超过可用列宽", async (t) => {
	for (const columns of [40, 80, 120]) {
		for (const rows of [12, 24, 40]) {
			const card = harness(t, [withPreview({ question: "问题".repeat(40) })], rows, columns);
			card.assertFits(columns);
			await card.close();
		}
	}
});

// —— 剪裁 ——

test("预览超行被剪掉，标注写明剪了几行，且排在内容之后、下边框之前", (t) => {
	const card = harness(t, [withPreview({ options: [
		{ label: "A", description: "一", preview: Array.from({ length: 40 }, (_, i) => `预览 ${i + 1}`).join("\n") },
		{ label: "B", description: "二" },
	] })], 24, 80);
	const frame = card.lines();
	const marker = frame.findIndex((line) => line.includes("✂"));
	assert.ok(marker > 0, "应出现剪裁标注");
	assert.match(frame[marker]!, /─── ✂ ─── \d+ lines hidden/);
	const hiddenCount = Number(/✂ ─── (\d+) lines hidden/.exec(frame[marker]!)![1]);
	assert.ok(hiddenCount > 0);
	assert.ok(frame[marker - 1]!.includes("预览"), "标注前应是内容行");
	assert.ok(frame[marker + 1]!.includes("└"), "标注后应紧接下边框");
});

test("终端变高后剪掉的行数跟着变少", async (t) => {
	const longPreview = withPreview({ options: [
		{ label: "A", description: "一", preview: Array.from({ length: 60 }, (_, i) => `预览 ${i + 1}`).join("\n") },
		{ label: "B", description: "二" },
	] });
	const hidden = async (rows: number) => {
		const card = harness(t, [longPreview], rows, 80);
		const line = card.lines().find((l) => l.includes("✂"))!;
		const count = Number(/✂ ─── (\d+) lines hidden/.exec(line)![1]);
		await card.close();
		return count;
	};
	assert.ok(await hidden(40) < await hidden(24), "更高的终端应少剪一些");
});

test("预览超过 2000 字符整块不渲染，改一句提示；1999 字符照常渲染", async (t) => {
	const over = harness(t, [withPreview({ options: [{ label: "A", description: "一", preview: "预".repeat(2001) }, { label: "B", description: "二" }] })], 40, 80);
	assert.ok(!over.plain().includes("预预预"), "超限预览不得渲染正文");
	assert.ok(over.plain().includes("预览过长"), "应给出提示句");
	await over.close();

	const under = harness(t, [withPreview({ options: [{ label: "A", description: "一", preview: "预".repeat(1999) }, { label: "B", description: "二" }] })], 40, 80);
	assert.ok(under.plain().includes("预预预"), "1999 字符应正常渲染");
});

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
	const q = withPreview({
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
	assert.deepEqual(await card.result, { kind: "chat" });
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

test("编辑态 Esc 退回列表并保留草稿，重新进入可继续改", (t) => {
	const card = harness(t, [question()], 24, 80);
	card.input(DOWN, DOWN, ENTER); // 进入 Other 编辑
	card.input("草", "稿");
	card.input(ESC);
	assert.ok(card.plain().includes("Other · 草稿"), "列表里应标出草稿");
	card.input(ENTER);
	assert.ok(card.plain().includes("草稿"), "重新进入应恢复草稿");
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
				{ label: `标签 👩🏽‍🚀 ${"长".repeat(30)}`, description: text, preview: text },
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
	adopted.input(DOWN, DOWN, ENTER);
	adopted.input("自", "己", "写", ENTER); // 采用 → 推进到第二题
	adopted.input(BACK_TAB); // 回第一题看列表
	assert.ok(adopted.plain().includes("自己写"), "采用后显示正文");
	assert.ok(!adopted.plain().includes("Type something"), "采用后不该再显示占位");
});
