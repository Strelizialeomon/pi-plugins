/**
 * dsh-scroll-speed —— 把 dsh-TUI 的滚轮换成 Claude Code 那套「意图」模型。
 *
 * 这个文件只做接线；装文件、调 patch.mjs、读写 zshrc 都在 patcher.ts。
 * 背景、实测数据和参数含义见同目录 README.md 与 docs/specs/2026-10-17-dsh-scroll-speed.md。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	applyPatch,
	hasHook,
	installAssets,
	installHook,
	patchDir,
	readStatus,
	revertPatch,
} from "./patcher.ts";

const COMMAND = "dsh-scroll";

function usage(): string {
	return [
		"用法：/dsh-scroll [status|apply|revert|hook]",
		"  status  看补丁有没有生效（默认）",
		"  apply   安装补丁文件并打到当前 dsh-tui profile",
		"  revert  还原成原厂滚轮",
		"  hook    把 ensure.sh 挂进 ~/.zshrc（dsh 升级后自动补回）",
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand(COMMAND, {
		description: "dsh-TUI 滚轮手感补丁：status / apply / revert / hook",
		handler: async (args, ctx) => {
			const sub = (args?.trim().split(/\s+/)[0] || "status").toLowerCase();
			const dir = patchDir();

			try {
				if (sub === "apply") {
					const installed = installAssets(dir);
					const out = applyPatch(dir);
					const hook = hasHook() ? "已挂" : "未挂（跑 /dsh-scroll hook 可自动补）";
					ctx.ui.notify(
						[`已安装 ${installed.files.length} 个文件 → ${installed.dir}`, out || "补丁已是最新", `开机自愈钩子：${hook}`].join("\n"),
						"info",
					);
					return;
				}

				if (sub === "revert") {
					ctx.ui.notify(revertPatch(dir), "info");
					return;
				}

				if (sub === "hook") {
					const result = installHook();
					ctx.ui.notify(
						result === "added" ? "已把 ensure.sh 挂进 ~/.zshrc（新开 shell 生效）" : "钩子已经在 ~/.zshrc 里了",
						"info",
					);
					return;
				}

				if (sub === "status") {
					const { raw } = readStatus(dir);
					const hook = hasHook() ? "present" : "missing";
					ctx.ui.notify([raw, `hook   : ${hook}`, `dir    : ${dir}`].join("\n"), "info");
					return;
				}

				ctx.ui.notify(usage(), "warning");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`[dsh-scroll] ${message}`, "error");
			}
		},
	});
}
