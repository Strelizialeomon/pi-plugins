/** Manual terminal fixture; load explicitly with pi -ne -e <this file>, then /question-smoke. */
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import workflowTools from "../index.ts";
import { askQuestions, type QuestionSpec } from "../question-card.ts";
import { renderQuestionResult } from "../renderers.ts";

export default function (pi: ExtensionAPI) {
	workflowTools(pi);
	let questions: QuestionSpec[] = [];
	pi.registerMessageRenderer("question-smoke:receipt", (message, _options, theme) =>
		renderQuestionResult({ details: message.details, content: [{ type: "text", text: String(message.content) }] }, theme, questions),
	);
	pi.registerCommand("question-smoke", {
		description: "Open the question-card terminal fixture without calling a model",
		async handler(args, ctx) {
			ctx.ui.setStatus("question-smoke", undefined);
			const long = args.trim() === "long";
			const base: QuestionSpec = {
				id: "scope", header: "优化范围", multiSelect: true,
				question: long ? `${"请完整阅读问题与选项说明，确认优化范围。".repeat(20)} QUESTION_END` : "本次优化包含哪些内容？",
				options: [
					{ label: "完整阅读", description: long ? `${"换行后可翻页查看完整内容。".repeat(30)} DESCRIPTION_END` : "完整显示题目与选项说明。" },
					{ label: "可靠输入", description: "允许粘贴多行内容并保留草稿。" },
				],
			};
			questions = args.trim() === "multi"
				? [base, ...[2, 3, 4].map((i) => ({ ...base, id: `q${i}`, header: `问题${i}`, question: `第 ${i} 题选择哪个？`, multiSelect: false }))]
				: [base];
			const result = await askQuestions(ctx, questions, ctx.signal);
			const digest = createHash("sha256").update(JSON.stringify(result)).digest("hex").slice(0, 12);
			ctx.ui.setStatus("question-smoke", `QA ${result.kind} ${digest}`);
			pi.sendMessage({ customType: "question-smoke:receipt", content: JSON.stringify(result), details: result, display: true });
		},
	});
}
