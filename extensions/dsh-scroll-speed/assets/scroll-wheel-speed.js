/**
 * 滚轮意图模型 v5（dsh-TUI 补丁）
 *
 * 用「最近 400ms 内新手势的个数」判定速度（慢滚不加速，快滚才加速）：只有 <5ms 的连发算同一刻度，
 * 其余每次都是一个新的刻度起始（不依赖终端一档发几个事件）。
 *
 *   DSH_TUI_SCROLL_SLOW  慢滚每事件行数（可小数、跨事件累积），默认 0.34
 *   DSH_TUI_SCROLL_FAST  快滚每事件上限，默认 8
 *   DSH_TUI_SCROLL_ACCEL 0 = 关闭加速
 *   DSH_TUI_SCROLL_DEBUG 1 = 写 ~/.dsh-tui/wheel-speed.log（>2MB 自动清空）
 */
import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RATE_WINDOW_MS = 400;
const BURST_MS = 5;
const SLOW_STARTS = 9; // ≤9 个刻度/400ms（≈22 格/秒）保持纯慢速
const FAST_STARTS = 18; // ≥18 个刻度/400ms（≈45 格/秒）到上限

let lastAt = -1e9;
let dir = 0;
let carry = 0;
let starts = [];
let debugReady = false;

function envNumber(name, fallback) {
	const raw = process.env[name];
	if (!raw) return fallback;
	const n = Number.parseFloat(raw);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function writeLog(gap, n, mult, slow, fast, rows) {
	if (!process.env.DSH_TUI_SCROLL_DEBUG) return;
	try {
		const file = join(homedir(), ".dsh-tui", "wheel-speed.log");
		if (!debugReady) {
			debugReady = true;
			try { if (statSync(file).size > 2 * 1024 * 1024) writeFileSync(file, ""); } catch {}
		}
		appendFileSync(file, `${new Date().toISOString()} gap=${gap.toFixed(1)} n=${n} mult=${mult.toFixed(2)} slow=${slow} fast=${fast} rows=${rows} carry=${carry.toFixed(2)}\n`, { mode: 0o600 });
	} catch {}
}

export function wheelStep(direction) {
	const slow = clamp(envNumber("DSH_TUI_SCROLL_SLOW", 0.34), 0.05, 20);
	const fast = clamp(envNumber("DSH_TUI_SCROLL_FAST", 8), 1, 40);
	const accel = process.env.DSH_TUI_SCROLL_ACCEL !== "0";
	const now = performance.now();
	const gap = now - lastAt;

	if (direction !== dir) carry = 0;
	dir = direction;
	lastAt = now;

	if (gap >= BURST_MS) starts.push(now);
	while (starts.length && now - starts[0] > RATE_WINDOW_MS) starts.shift();

	let mult = 1;
	if (accel) {
		const t = clamp((starts.length - SLOW_STARTS) / (FAST_STARTS - SLOW_STARTS), 0, 1);
		mult = 1 + t * (fast / slow - 1);
	}

	const want = carry + direction * slow * mult;
	const rows = Math.trunc(want);
	carry = want - rows;
	writeLog(gap, starts.length, mult, slow, fast, rows);
	return rows;
}
