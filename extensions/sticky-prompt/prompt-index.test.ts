import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { pickSticky, summarize, type StickySource } from "./prompt-index.ts";

/** 一块内容：高度 + 如果是用户提问就带正文。 */
interface Block {
	height: number;
	prompt?: string;
}

/** 造一个块来源，并记下「到底测量了哪几块」——早退有没有生效全靠它验。 */
function sourceOf(blocks: Block[]): { source: StickySource; measured: number[] } {
	const measured: number[] = [];
	return {
		measured,
		source: {
			count: () => blocks.length,
			measure: (index) => {
				measured.push(index);
				return blocks[index]?.height ?? 0;
			},
			describe: (index) => {
				const block = blocks[index];
				return { isPrompt: block?.prompt !== undefined, text: block?.prompt ?? "" };
			},
		},
	};
}

const W = 200;

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

test("摘要截断：CJK 宽字符超宽补省略号，可视宽度不超上限", () => {
	const out = summarize("一二三四五六七八九十".repeat(20), 20);
	assert.notEqual(out, null);
	assert.ok(visibleWidth(out ?? "") <= 20, `实际宽度 ${visibleWidth(out ?? "")}`);
	// truncateToWidth 会在省略号前后塞 ANSI 复位，所以要剥掉转义再断言。
	assert.ok(stripTerminalSequences(out ?? "").endsWith("…"), `实际输出 ${JSON.stringify(out)}`);
});

test("摘要截断：emoji 按显示宽度算，不会被从中间劈开也不超宽", () => {
	const out = summarize("🎉🎊🎈🎁🎂🍰🚀🛰️🌍🌏".repeat(6), 12) ?? "";
	assert.ok(visibleWidth(out) <= 12, `实际宽度 ${visibleWidth(out)}`);
	assert.ok(stripTerminalSequences(out).endsWith("…"));
});

test("摘要截断：纯 ASCII 超宽也补省略号", () => {
	const out = summarize("a".repeat(200), 20) ?? "";
	assert.ok(visibleWidth(out) <= 20);
	assert.ok(stripTerminalSequences(out).endsWith("…"));
});

test("摘要：宽度为 0 或负数 → null（没地方显示就不显示）", () => {
	assert.equal(summarize("有内容", 0), null);
	assert.equal(summarize("有内容", -3), null);
});

test("摘要：不超宽时原样返回，不加省略号", () => {
	assert.equal(summarize("短", 10), "短");
});

// ---------------------------------------------------------------- 选谁

test("选中：整条完全在视口顶之上的最后一条", () => {
	// 行号：[0,2) 别块 | [2,5) 第一条 | [5,9) 别块 | [9,12) 第二条
	const { source } = sourceOf([
		{ height: 2 },
		{ height: 3, prompt: "第一条" },
		{ height: 4 },
		{ height: 3, prompt: "第二条" },
	]);

	assert.equal(pickSticky(source, 0, W), null, "没滚过任何提问");
	assert.equal(pickSticky(source, 4, W), null, "第一条还没整条滚出去");
	assert.equal(pickSticky(source, 5, W)?.text, "第一条", "恰好 end === scrollTop 应入选");
	assert.equal(pickSticky(source, 8, W)?.text, "第一条", "第二条还没露头");
	assert.equal(pickSticky(source, 12, W)?.text, "第二条");
	assert.equal(pickSticky(source, 999, W)?.text, "第二条", "全滚出去了选最近那条");
});

test("选中：end === scrollTop + 1 不入选（差一行也不算滚出去）", () => {
	const { source } = sourceOf([{ height: 3, prompt: "第一条" }, { height: 4 }, { height: 3, prompt: "第二条" }]);
	// 第一条 [0,3)，第二条 [7,10)
	assert.equal(pickSticky(source, 2, W), null);
	assert.equal(pickSticky(source, 3, W)?.text, "第一条");
	assert.equal(pickSticky(source, 9, W)?.text, "第一条");
	assert.equal(pickSticky(source, 10, W)?.text, "第二条");
});

test("选中：scrollTop 是小数时向下取整后再比", () => {
	const { source } = sourceOf([{ height: 3, prompt: "第一条" }, { height: 10 }]);
	assert.equal(pickSticky(source, 2.9, W), null);
	assert.equal(pickSticky(source, 3.5, W)?.text, "第一条");
});

test("选中：无候选 / 全候选两种极端", () => {
	assert.equal(pickSticky(sourceOf([]).source, 100, W), null);
	const { source } = sourceOf([{ height: 2, prompt: "唯一一条" }, { height: 50 }]);
	assert.equal(pickSticky(source, 2, W)?.text, "唯一一条");
});

test("选中：摘要不可用的候选要跳过并继续往前找，不能就此返回 null", () => {
	const { source } = sourceOf([
		{ height: 2, prompt: "真正该显示的" },
		{ height: 1 },
		{ height: 2, prompt: "<system-reminder>注入" },
		{ height: 10 },
	]);
	// 滚到最底：最近那条是「注入」，被过滤后应回退到「真正该显示的」
	assert.equal(pickSticky(source, 15, W)?.text, "真正该显示的");
});

test("选中：所有候选都不可用时返回 null", () => {
	const { source } = sourceOf([{ height: 2, prompt: "<注入>" }, { height: 3 }, { height: 2, prompt: "   " }]);
	assert.equal(pickSticky(source, 100, W), null);
});

test("选中：返回的 start 能直接当点击跳转的目标行", () => {
	const { source } = sourceOf([{ height: 4 }, { height: 3, prompt: "目标" }, { height: 9 }]);
	const picked = pickSticky(source, 7, W);
	assert.equal(picked?.start, 4);
	assert.equal(picked?.end, 7);
	assert.equal(picked?.index, 1);
});

test("选中：高度非法（负数 / NaN / 小数）被规整，不会把行号算歪", () => {
	const { source } = sourceOf([
		{ height: -5 },
		{ height: Number.NaN },
		{ height: 2.9, prompt: "A" },
		{ height: 1 },
	]);
	const picked = pickSticky(source, 3, W);
	assert.equal(picked?.start, 0, "负数与 NaN 都按 0 算，小数截断");
	assert.equal(picked?.end, 2);
});

// ---------------------------------------------------------------- 坐标与早退

test("坐标：header 高度计入行号——不会整体偏一行", () => {
	// 头两块（高度 5）就是 header / 资源区。提问在 [5,8)。
	const { source } = sourceOf([{ height: 5 }, { height: 3, prompt: "目标提问" }]);
	assert.equal(pickSticky(source, 4, W), null, "忘了算 header 高度就会在这里漏出来");
	assert.equal(pickSticky(source, 8, W)?.start, 5, "点击要跳的那一行也必须是 5");
});

test("早退：游标一越过视口顶就不再测量后面的块", () => {
	const { source, measured } = sourceOf([
		{ height: 2 },
		{ height: 3, prompt: "目标" },
		{ height: 40 },
		{ height: 40 },
		{ height: 40 },
	]);
	pickSticky(source, 5, W);
	assert.deepEqual(measured, [0, 1, 2], "越过 scrollTop=5 后就该停在第 2 块，不该去量后面三块");
});

test("早退：滚到很靠上时只量到提问本身", () => {
	const { source, measured } = sourceOf([{ height: 3, prompt: "目标" }, { height: 40 }, { height: 40 }]);
	pickSticky(source, 3, W);
	assert.deepEqual(measured, [0, 1]);
});

test("早退：没有候选时也会走完（不许因为找不到就提前放弃）", () => {
	const { source, measured } = sourceOf([{ height: 1 }, { height: 1 }, { height: 1 }]);
	assert.equal(pickSticky(source, 100, W), null);
	assert.deepEqual(measured, [0, 1, 2], "scrollTop 比总高还大时应当量完全部");
});
