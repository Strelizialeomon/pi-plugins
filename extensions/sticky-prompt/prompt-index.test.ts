import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { buildIndex, pickSticky, summarize, totalHeight, type ContentBlock } from "./prompt-index.ts";

/** 只有高度、不是提问的块（assistant / 工具输出等）。 */
function other(height: number): ContentBlock {
	return { height, isPrompt: false, text: "" };
}

/** 用户提问块。 */
function prompt(height: number, text: string): ContentBlock {
	return { height, isPrompt: true, text };
}

// ---------------------------------------------------------------- 摘要提取

test("摘要取第一段：遇到空行就截断", () => {
	assert.equal(summarize("第一段\n\n第二段", 100), "第一段");
});

test("摘要压平空白：换行与连续空格都压成单个空格", () => {
	assert.equal(summarize("多行\n文本\t带   空格", 100), "多行 文本 带 空格");
});

test("摘要去掉首尾空白", () => {
	assert.equal(summarize("\n\n  开头结尾都有空白  \n\n", 100), "开头结尾都有空白");
});

test("摘要：只含空格/制表的行也算空行（与 CC 的 /\\n\\s*\\n/ 同义）", () => {
	assert.equal(summarize("第一行\n   \n第二行", 100), "第一行");
	assert.equal(summarize("第一行\n\t\n第二行", 100), "第一行");
});

test("摘要：行内换行（不是空行）只压成空格", () => {
	assert.equal(summarize("第一行\n第二行", 100), "第一行 第二行");
});

test("摘要过滤：归一化后为空 → null", () => {
	assert.equal(summarize("", 100), null);
	assert.equal(summarize("   \n\t \n ", 100), null);
});

test("摘要过滤：以 < 开头（系统注入）→ null", () => {
	assert.equal(summarize("<system-reminder>别显示我</system-reminder>", 100), null);
	assert.equal(summarize("  <div>也算了", 100), null);
});

test("摘要过滤：< 出现在中间不受影响", () => {
	assert.equal(summarize("用 <div> 包起来", 100), "用 <div> 包起来");
});

test("摘要截断：超宽补省略号，且可视宽度不超上限", () => {
	const long = "一二三四五六七八九十".repeat(20);
	const out = summarize(long, 20);
	assert.notEqual(out, null);
	assert.ok(visibleWidth(out ?? "") <= 20, `实际宽度 ${visibleWidth(out ?? "")}`);
	// truncateToWidth 会在省略号前后塞 ANSI 复位，所以要剥掉转义再断言。
	assert.ok(stripTerminalSequences(out ?? "").endsWith("…"), `实际输出 ${JSON.stringify(out)}`);
});

test("摘要截断：纯 ASCII 超宽也补省略号", () => {
	const out = summarize("a".repeat(200), 20) ?? "";
	assert.ok(visibleWidth(out) <= 20);
	assert.ok(stripTerminalSequences(out).endsWith("…"));
});

test("摘要截断：宽字符与 emoji 按显示宽度算，不按字符数", () => {
	const out = summarize("宽宽宽宽宽宽宽宽宽宽", 7) ?? "";
	assert.ok(visibleWidth(out) <= 7, `实际宽度 ${visibleWidth(out)}`);
});

test("摘要：宽度为 0 或负数 → null（没地方显示就不显示）", () => {
	assert.equal(summarize("有内容", 0), null);
	assert.equal(summarize("有内容", -3), null);
});

test("摘要：不超宽时原样返回，不加省略号", () => {
	assert.equal(summarize("短", 10), "短");
});

// ---------------------------------------------------------------- 区间表

test("区间表：只收提问块，行号按全部块累计", () => {
	const blocks = [other(3), prompt(2, "A"), other(5), prompt(1, "B")];
	assert.deepEqual(buildIndex(blocks), [
		{ block: 1, start: 3, end: 5 },
		{ block: 3, start: 10, end: 11 },
	]);
});

test("区间表：高度为 0 的提问块不产生区间", () => {
	assert.deepEqual(buildIndex([prompt(0, "空的"), other(2)]), []);
});

test("区间表：高度非法（负数 / NaN / 小数）被规整", () => {
	assert.deepEqual(buildIndex([other(-5), prompt(2.9, "A"), other(Number.NaN)]), [{ block: 1, start: 0, end: 2 }]);
});

test("区间表：从内容第 0 行起算——header 高度进入行号，不会被漏掉", () => {
	// 这块 other(7) 就是 header / 资源区。提问的 start 必须是 7，不是 0。
	const blocks = [other(7), prompt(2, "提问")];
	const intervals = buildIndex(blocks);
	assert.equal(intervals[0]?.start, 7, "header 高度必须计入行号，否则整张表会偏一行");
});

test("totalHeight：逐块之和", () => {
	assert.equal(totalHeight([other(3), prompt(2, "A"), other(5)]), 10);
	assert.equal(totalHeight([other(-1), other(Number.NaN)]), 0);
});

// ---------------------------------------------------------------- 选谁

const W = 200;

test("选中：整条完全在视口顶之上的最后一条", () => {
	const blocks = [other(2), prompt(3, "第一条"), other(4), prompt(3, "第二条")];
	const intervals = buildIndex(blocks);
	// intervals[0] = [2,5)  intervals[1] = [9,12)

	assert.equal(pickSticky(blocks, intervals, 0, W), null, "没滚过任何提问");
	assert.equal(pickSticky(blocks, intervals, 4, W), null, "第一条还没整条滚出去");
	assert.equal(pickSticky(blocks, intervals, 5, W)?.text, "第一条", "恰好 end === scrollTop 应入选");
	assert.equal(pickSticky(blocks, intervals, 5, W)?.index, 0);
	assert.equal(pickSticky(blocks, intervals, 8, W)?.text, "第一条", "第二条还没露头");
	assert.equal(pickSticky(blocks, intervals, 12, W)?.text, "第二条");
	assert.equal(pickSticky(blocks, intervals, 999, W)?.text, "第二条", "全滚出去了选最近那条");
});

test("选中：end === scrollTop + 1 不入选（差一行也不算滚出去）", () => {
	const blocks = [other(0), prompt(3, "第一条"), other(4), prompt(3, "第二条")];
	const intervals = buildIndex(blocks);
	// intervals[0] = [0,3)  intervals[1] = [7,10)
	assert.equal(pickSticky(blocks, intervals, 2, W), null);
	assert.equal(pickSticky(blocks, intervals, 3, W)?.text, "第一条");
});

test("选中：scrollTop 是小数时向下取整后再比", () => {
	const blocks = [prompt(3, "第一条"), other(10)];
	const intervals = buildIndex(blocks);
	assert.equal(pickSticky(blocks, intervals, 2.9, W), null);
	assert.equal(pickSticky(blocks, intervals, 3.5, W)?.text, "第一条");
});

test("选中：无候选 / 全候选两种极端", () => {
	assert.equal(pickSticky([], [], 100, W), null);
	const blocks = [prompt(2, "唯一一条"), other(50)];
	assert.equal(pickSticky(blocks, buildIndex(blocks), 2, W)?.text, "唯一一条");
});

test("选中：摘要不可用的候选要跳过并继续往上找，不能就此返回 null", () => {
	const blocks = [prompt(2, "真正该显示的"), other(1), prompt(2, "<system-reminder>注入"), other(10)];
	const intervals = buildIndex(blocks);
	// 滚到最底：最近那条是「注入」，被过滤后应回退到「真正该显示的」
	assert.equal(pickSticky(blocks, intervals, 15, W)?.text, "真正该显示的");
});

test("选中：所有候选都不可用时返回 null", () => {
	const blocks = [prompt(2, "<注入>"), other(3), prompt(2, "   ")];
	assert.equal(pickSticky(blocks, buildIndex(blocks), 100, W), null);
});

test("选中：返回的 interval 能定位到点击跳转的目标行", () => {
	const blocks = [other(4), prompt(3, "目标"), other(9)];
	const picked = pickSticky(blocks, buildIndex(blocks), 7, W);
	assert.equal(picked?.interval.start, 4);
	assert.equal(picked?.interval.end, 7);
	assert.equal(picked?.interval.block, 1);
});
