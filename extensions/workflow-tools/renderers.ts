/**
 * 四个工具的 TUI 渲染。
 *
 * 只是把状态摊成人能扫的几行：调用时显示在干什么，返回时显示结果与最后几行输出。
 * 真正的逻辑不在这里——这里只做呈现。
 */

import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { QuestionSpec } from "./question-card.ts";

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

/**
 * 问答回执：一行头 + 每题一条 `· 问题 → 答案`。
 * 答案在转录里会被长期保留，所以长答案截断到一行；完整答案仍由结构化结果交给模型。
 * 只调整问答工具，其他三个工具的显示不受影响。
 */
export function renderQuestionResult(
	result: { content: Array<{ type?: string; text?: string }>; details?: unknown; isError?: boolean },
	theme: Theme,
	questions: QuestionSpec[] = [],
): Component {
	const details = result.details as { kind?: string; answers?: Record<string, string>; mode?: string } | undefined;
	return {
		render(width) {
			const lines: string[] = [];
			if (details?.kind === "answered" && details.answers) {
				lines.push(theme.fg("success", theme.bold(`已回答 ${Object.keys(details.answers).length} 题`)));
				for (const [id, answer] of Object.entries(details.answers)) {
					const header = questions.find((question) => question.id === id)?.header || id;
					// 换行会被压平：回执是「一行一条」，答案里的换行不能把行数撑开。
					const flat = answer.replace(/\s+/g, " ").trim();
					lines.push(theme.fg("muted", truncateToWidth(`· ${header} → ${flat}`, width, "…")));
				}
			} else if (details?.kind === "chat") {
				lines.push(theme.fg("muted", truncateToWidth("用户选择先讨论，未作答。", width, "…")));
			} else {
				const status = details?.kind;
				const label = status === "cancelled" ? "已取消" : status === "busy" ? "已有活动选项卡" : status === "ui_unavailable" ? `无交互界面（${details?.mode ?? "未知模式"}）` : undefined;
				const text = label ?? result.content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n");
				lines.push(theme.fg(result.isError ? "error" : "warning", text));
			}
			return new Text(lines.join("\n"), 0, 0).render(width);
		},
		invalidate() {},
	};
}
