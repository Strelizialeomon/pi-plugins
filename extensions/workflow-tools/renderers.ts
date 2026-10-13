/**
 * 四个工具的 TUI 渲染。
 *
 * 只是把状态摊成人能扫的几行：调用时显示在干什么，返回时显示结果与最后几行输出。
 * 真正的逻辑不在这里——这里只做呈现。
 */

import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

/** 一块左对齐的静态文本。每一行都按终端宽度截断，避免把界面撑破。 */
class TextBlock implements Component {
	// Node 的 TS 支持只做类型擦除，不认 `constructor(private x)` 这种参数属性，字段得显式声明
	readonly #lines: string[];

	constructor(lines: string[]) {
		this.#lines = lines;
	}

	render(width: number): string[] {
		return this.#lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		// 无缓存
	}
}

export function textBlock(lines: string[]): Component {
	return new TextBlock(lines);
}

/** 调用中：`任务描述 —— 细节`。 */
export function renderTaskCall(title: string, detail: string | undefined): Component {
	return textBlock([detail ? `${title} · ${detail}` : title]);
}

/** 返回后：一行结论 + 末尾几行输出。 */
export function renderTaskResult(headline: string, tail: string[] = []): Component {
	const lines = [headline];
	if (tail.length > 0) {
		lines.push("…");
		for (const line of tail) lines.push(`  ${line}`);
	}
	return textBlock(lines);
}
