import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { renderQuestionResult, renderTaskResult } from "./renderers.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

for (const width of [40, 80, 120]) {
	test(`答案回执一行一条、超长截断、不撑高转录：${width} 列`, () => {
		const answer = `${"中文 English 😀 ".repeat(150)}\nANSWER_END`;
		const result = { details: { kind: "answered", answers: { q: answer }, responses: { q: answer } }, content: [{ type: "text", text: "structured answer" }] };
		const component = renderQuestionResult(result, theme, [{ id: "q", header: "范围", question: "?", multiSelect: false, options: [] }]);
		const lines = component.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width), "回执不得溢出列宽");
		assert.equal(lines.length, 2, "头行 + 每题一行");
		const text = lines.map(stripTerminalSequences).join("\n");
		assert.match(text, /已回答 1 题/);
		assert.match(text, /· 范围 → /);
		assert.match(text, /…/, "超长答案应带省略号");
		assert.ok(!text.includes("ANSWER_END"), "长答案在转录里被截断");
		assert.ok(!text.includes("\n·  "), "每题只占一行");
		component.invalidate();
		assert.equal(component.render(width).length, 2);
		// 展示截断不影响交给模型的结构化结果。
		assert.equal(result.details.answers.q, answer);
	});
}

test("多题回执一题一行，答案里的换行不撑开行数", () => {
	const result = { details: { kind: "answered", answers: { a: "A", b: "第一行\n第二行" } }, content: [] };
	const lines = renderQuestionResult(result, theme, [
		{ id: "a", header: "甲", question: "?", multiSelect: false, options: [] },
		{ id: "b", header: "乙", question: "?", multiSelect: false, options: [] },
	]).render(80);
	assert.equal(lines.length, 3, "头行 + 两条");
	assert.match(stripTerminalSequences(lines[2]!), /· 乙 → 第一行 第二行/);
});

test("chat 的回执写明用户选择先讨论", () => {
	const text = renderQuestionResult({ details: { kind: "chat" }, content: [] }, theme).render(80).map(stripTerminalSequences).join("\n");
	assert.match(text, /先讨论/);
	assert.ok(!text.includes("已回答"));
});

test("取消、忙碌、无 UI 和参数错误的回执互相区分", () => {
	const render = (kind: string, error = false) => renderQuestionResult({ details: { kind, mode: "json" }, content: [{ type: "text", text: "参数不合法" }], isError: error }, theme).render(80).join("\n");
	assert.match(render("cancelled"), /已取消/);
	assert.match(render("busy"), /已有活动选项卡/);
	assert.match(render("ui_unavailable"), /无交互界面（json）/);
	assert.match(render("invalid_arguments", true), /参数不合法/);
});

test("其他工具仍使用原来的结果渲染，不受问答回执改动影响", () => {
	const lines = renderTaskResult("x".repeat(100), ["tail"]).render(20);
	assert.equal(lines.length, 3);
	assert.ok(lines.every((line) => visibleWidth(line) <= 20));
	assert.ok(!lines.join("\n").includes("已回答"));
});
