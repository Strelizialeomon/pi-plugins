import { test } from "node:test";
import assert from "node:assert/strict";
import { validateQuestions, buildAnsweredResult, CANCELLED, BUSY, uiUnavailable } from "./question-card.ts";

const one = (over: Record<string, unknown> = {}) => ({
	id: "q1",
	question: "选哪个？",
	header: "选择",
	multiSelect: false,
	options: [
		{ label: "A", description: "第一个" },
		{ label: "B", description: "第二个" },
	],
	...over,
});

// —— 参数校验 ——

test("合法输入通过校验", () => {
	const result = validateQuestions({ questions: [one()] });
	assert.equal(result.ok, true);
});

test("题数为 0 或超过 4 都报错", () => {
	assert.equal(validateQuestions({ questions: [] }).ok, false);
	const five = Array.from({ length: 5 }, (_, i) => one({ id: `q${i}` }));
	assert.equal(validateQuestions({ questions: five }).ok, false);
});

test("缺 id 或 id 重复都报错（重复会让同文问题互相覆盖）", () => {
	assert.equal(validateQuestions({ questions: [one({ id: undefined })] }).ok, false);
	assert.equal(validateQuestions({ questions: [one(), one()] }).ok, false, "两条同 id 应被拒");
});

test("id 只需题内唯一，跨调用可重复", () => {
	assert.equal(validateQuestions({ questions: [one({ id: "a" }), one({ id: "b" })] }).ok, true);
});

test("选项数必须是 2～4", () => {
	assert.equal(validateQuestions({ questions: [one({ options: [{ label: "A", description: "" }] })] }).ok, false);
	const five = Array.from({ length: 5 }, (_, i) => ({ label: `L${i}`, description: "" }));
	assert.equal(validateQuestions({ questions: [one({ options: five })] }).ok, false);
});

test("header 超过 12 个字符报错，正好 12 通过", () => {
	assert.equal(validateQuestions({ questions: [one({ header: "x".repeat(13) })] }).ok, false);
	assert.equal(validateQuestions({ questions: [one({ header: "x".repeat(12) })] }).ok, true);
});

test("校验失败时给出可读原因，不抛错", () => {
	const result = validateQuestions({ questions: [] });
	assert.equal(result.ok, false);
	if (!result.ok) assert.ok(result.error.length > 0);
});

test("完全不像参数的输入也不抛错", () => {
	assert.equal(validateQuestions(null).ok, false);
	assert.equal(validateQuestions({}).ok, false);
	assert.equal(validateQuestions({ questions: "nope" }).ok, false);
});

// —— 答案组装：一律以 id 为 key ——

test("单选答案写进 answers[id]", () => {
	const result = buildAnsweredResult({
		picks: [{ id: "q1", selected: ["B"] }],
	});
	assert.deepEqual(result.answers, { q1: "B" });
});

test("多选答案用逗号分隔，顺序按用户勾选顺序", () => {
	const result = buildAnsweredResult({
		picks: [{ id: "q1", selected: ["B", "A", "C"] }],
	});
	assert.equal(result.answers.q1, "B, A, C");
});

test("Other 自由输入的原文同时写进 answers[id] 和 responses[id]", () => {
	const result = buildAnsweredResult({
		picks: [{ id: "q1", selected: [], other: "我自己写一个" }],
	});
	assert.equal(result.answers.q1, "我自己写一个");
	assert.equal(result.responses?.q1, "我自己写一个");
});

test("多选 + Other 时，勾选项不能被自由输入吃掉", () => {
	const result = buildAnsweredResult({
		picks: [{ id: "q1", selected: ["A", "B"], other: "补充一句" }],
	});
	assert.ok(result.answers.q1.includes("A"), `实际：${result.answers.q1}`);
	assert.ok(result.answers.q1.includes("B"), `实际：${result.answers.q1}`);
	assert.ok(result.answers.q1.includes("补充一句"), `实际：${result.answers.q1}`);
	assert.equal(result.responses?.q1, "补充一句", "responses 里只放自由输入那一段");
});

// —— 保留 label：模型不能占用卡片自己要用的文案 ——

test("选项 label 用保留字会被拒（Other / 选完了 / 取消）", () => {
	for (const reserved of ["Other", "✓ 选完了", "✗ 取消"]) {
		const options = [
			{ label: reserved, description: "" },
			{ label: "正常项", description: "" },
		];
		assert.equal(validateQuestions({ questions: [one({ options })] }).ok, false, `${reserved} 应被拒`);
	}
});

test("普通 label 不受影响", () => {
	const options = [
		{ label: "不审", description: "" },
		{ label: "轻审", description: "" },
		{ label: "重审", description: "" },
	];
	assert.equal(validateQuestions({ questions: [one({ options })] }).ok, true);
});

test("没走 Other 的题目不进 responses，保持结果干净", () => {
	const result = buildAnsweredResult({ picks: [{ id: "q1", selected: ["A"] }] });
	assert.equal(result.responses, undefined);
});

test("annotations 与 answers 同构，都用 id 作 key", () => {
	const result = buildAnsweredResult({
		picks: [{ id: "q1", selected: ["A"], notes: "我记一笔" }],
	});
	assert.deepEqual(Object.keys(result.annotations ?? {}), ["q1"]);
	assert.equal(result.annotations?.q1.notes, "我记一笔");
});

test("RPC 降级过的题目在 annotations 里带 degraded 标记", () => {
	const result = buildAnsweredResult({
		picks: [{ id: "q1", selected: ["A"], degraded: true }],
	});
	assert.equal(result.annotations?.q1.degraded, true);
});

test("多题一起答，各归各的 id —— 问题文本相同也不会串", () => {
	const result = buildAnsweredResult({
		picks: [
			{ id: "q1", selected: ["A"] },
			{ id: "q2", selected: ["B"] },
		],
	});
	assert.deepEqual(result.answers, { q1: "A", q2: "B" });
});

// —— 终态结果：取消 / 忙碌 / 无 UI 必须可识别，且互不混淆 ——

test("取消是可识别的独立结果，不带任何 answers", () => {
	assert.equal(CANCELLED.kind, "cancelled");
	assert.equal("answers" in CANCELLED, false, "取消不得伪装成用户选了某个选项");
});

test("并发调用返回 busy，同样是独立结果", () => {
	assert.equal(BUSY.kind, "busy");
	assert.equal("answers" in BUSY, false);
});

test("非 TUI 模式返回 ui_unavailable 并带上模式名", () => {
	const result = uiUnavailable("json");
	assert.equal(result.kind, "ui_unavailable");
	assert.equal(result.mode, "json");
});
