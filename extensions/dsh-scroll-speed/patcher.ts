/**
 * dsh-scroll-speed 的纯逻辑层 —— 不 import Pi 运行时，单测不用起 Pi。
 *
 * 补丁本体是三个静态文件（patch.mjs / scroll-wheel-speed.js / ensure.sh），
 * 随插件一起放在 assets/；这里只负责：装到 ~/.dsh/patches/scroll-speed/、
 * 调 patch.mjs、读它的状态、以及把 ensure.sh 挂进 ~/.zshrc 的 dst()。
 */

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 随插件携带的三个文件。顺序无所谓，缺一个就当安装不完整。 */
export const ASSETS = ["patch.mjs", "scroll-wheel-speed.js", "ensure.sh"] as const;

/** zshrc 里认这段注释，用来判断有没有挂过钩子。 */
export const HOOK_MARK = "# >>> dsh-scroll-speed >>>";
const HOOK_BLOCK = `${HOOK_MARK}
# 每次 dst 启动前自愈 dsh-tui 的滚轮补丁（升级 dsh-tui 后自动补回）。
if [ -x "$HOME/.dsh/patches/scroll-speed/ensure.sh" ]; then
  "$HOME/.dsh/patches/scroll-speed/ensure.sh"
fi
# <<< dsh-scroll-speed <<<
`;

/** 插件自带的 assets 目录。 */
export function assetDir(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "assets");
}

/** 补丁的安装位置。`DSH_SCROLL_PATCH_DIR` 可覆盖——单测指到临时目录。 */
export function patchDir(): string {
	return process.env.DSH_SCROLL_PATCH_DIR ?? join(homedir(), ".dsh", "patches", "scroll-speed");
}

/** zshrc 路径。`DSH_SCROLL_ZSHRC` 可覆盖——单测不碰真实配置。 */
export function zshrcPath(): string {
	return process.env.DSH_SCROLL_ZSHRC ?? join(homedir(), ".zshrc");
}

export interface Installed {
	dir: string;
	files: string[];
}

/** 把三个文件装到补丁目录（覆盖写，保持与插件版本一致）。 */
export function installAssets(dest: string = patchDir()): Installed {
	mkdirSync(dest, { recursive: true });
	const files: string[] = [];
	for (const name of ASSETS) {
		const from = join(assetDir(), name);
		if (!existsSync(from)) throw new Error(`插件缺少 assets/${name}`);
		const to = join(dest, name);
		copyFileSync(from, to);
		files.push(to);
	}
	chmodSync(join(dest, "ensure.sh"), 0o755);
	return { dir: dest, files };
}

export interface PatchStatus {
	target?: string;
	version?: string;
	patched?: boolean;
	helper?: boolean;
	backup?: boolean;
}

/** 解析 `patch.mjs --status` 的 `key : value` 输出。容错：认不出的行直接跳过。 */
export function parseStatus(text: string): PatchStatus {
	const status: PatchStatus = {};
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const at = line.indexOf(":");
		if (at < 0) continue;
		const key = line.slice(0, at).trim();
		const value = line.slice(at + 1).trim();
		switch (key) {
			case "target":
				status.target = value;
				break;
			case "version":
				status.version = value;
				break;
			case "patched":
				status.patched = value === "yes";
				break;
			case "helper":
				status.helper = value === "present";
				break;
			case "backup":
				status.backup = value === "present";
				break;
			default:
				break;
		}
	}
	return status;
}

function runPatch(dest: string, args: string[]): string {
	const script = join(dest, "patch.mjs");
	if (!existsSync(script)) throw new Error(`补丁未安装：${script}（先跑 /dsh-scroll apply）`);
	return execFileSync(process.execPath, [script, ...args], { encoding: "utf8" }).trim();
}

export function readStatus(dest: string = patchDir()): { raw: string; status: PatchStatus } {
	const raw = runPatch(dest, ["--status"]);
	return { raw, status: parseStatus(raw) };
}

export function applyPatch(dest: string = patchDir()): string {
	return runPatch(dest, ["--ensure"]);
}

export function revertPatch(dest: string = patchDir()): string {
	return runPatch(dest, ["--revert"]);
}

/** 读 zshrc；不存在就当空文件（不主动创建）。 */
export function readZshrc(file: string = zshrcPath()): string {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

/** 有没有挂过钩子。 */
export function hasHook(file: string = zshrcPath()): boolean {
	return readZshrc(file).includes(HOOK_MARK);
}

/**
 * 把 ensure.sh 挂进 zshrc。幂等：已有标记原样返回 present。
 * 追加而不是改写 dst()，避免和用户自己的函数定义打架；ensure 在函数外也能跑。
 */
export function installHook(file: string = zshrcPath()): "added" | "present" {
	const text = readZshrc(file);
	if (text.includes(HOOK_MARK)) return "present";
	writeFileSync(file, `${text}${text.endsWith("\n") || text === "" ? "" : "\n"}${HOOK_BLOCK}`, { mode: 0o600 });
	return "added";
}
