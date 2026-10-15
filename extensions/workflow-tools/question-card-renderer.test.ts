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
	test(`答案回执保留长正文与内部换行：${width} 列`, () => {
		const answer = `${"中文 English 😀 ".repeat(150)}\nANSWER_END`;
		const result = { details: { kind: "answered", answers: { q: answer }, responses: { q: answer } }, content: [{ type: "text", text: "structured answer" }] };
		const component = renderQuestionResult(result, theme, [{ id: "q", header: "范围", question: "?", multiSelect: false, options: [] }]);
		const lines = component.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		const text = lines.map(stripTerminalSequences).join("\n");
		assert.match(text, /已回答 1 题/);
		assert.match(text, /范围：/);
		assert.match(text, /ANSWER_END/);
		component.invalidate();
		assert.match(component.render(width).join("\n"), /ANSWER_END/);
		assert.equal(result.details.answers.q, answer);
	});
}

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
