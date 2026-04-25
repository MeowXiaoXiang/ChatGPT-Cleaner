// src/content/debug.ts
// Chat Cleaner - Debug Console
// ------------------------------------------------------------
// 功能職責 (Responsibilities):
//   - 提供 debug-only console API
//   - 不建立任何頁面 DOM，不影響正式產品 UI
//   - 統一管理 __ccxDebug 的註冊、watcher 與清理
// ------------------------------------------------------------

import type { Mode, TrimResult } from "./types";

export interface DebugMetrics {
	mode: Mode;
	maxKeep: number;
	visibleCount: number;
	hiddenCount: number;
	removedCount: number;
	trimAvgMs: number;
	suspended: boolean;
	longTaskRateEMA: number;
	longTaskAvgMsEMA: number;
	ltThresholds: {
		enterRate: number;
		exitRate: number;
		enterAvg: number;
		exitAvg: number;
	};
}

export interface ForceTrimDebugResult {
	result: TrimResult;
	ms: number;
}

export interface DebugConsoleApi {
	getMetrics(): DebugMetrics;
	report(): DebugMetrics;
	forceTrim(): ForceTrimDebugResult | null;
	watchMetrics(seconds?: number): void;
	stopWatch(): boolean;
}

export interface DebugConsoleController {
	api: DebugConsoleApi;
	destroy(): void;
}

export function mountDebugConsole(opts: {
	getMetrics: () => DebugMetrics;
	forceTrim: () => ForceTrimDebugResult | null;
}): DebugConsoleController {
	let watchTimer: number | null = null;
	let watchStopTimer: number | null = null;

	function clearWatchTimers(): boolean {
		const hadTimer = watchTimer != null || watchStopTimer != null;
		if (watchTimer != null) {
			clearInterval(watchTimer);
			watchTimer = null;
		}
		if (watchStopTimer != null) {
			clearTimeout(watchStopTimer);
			watchStopTimer = null;
		}
		return hadTimer;
	}

	function report(): DebugMetrics {
		const metrics = opts.getMetrics();
		const summary = {
			mode: metrics.mode,
			maxKeep: metrics.maxKeep,
			visible: metrics.visibleCount,
			hidden: metrics.hiddenCount,
			removed: metrics.removedCount,
			trimAvgMs: metrics.trimAvgMs,
			suspended: metrics.suspended,
			longTaskRate: metrics.longTaskRateEMA,
			longTaskAvgMs: metrics.longTaskAvgMsEMA,
		};

		console.groupCollapsed("[chat-cleaner] debug report");
		console.table(summary);
		console.log("raw metrics", metrics);
		console.groupEnd();

		return metrics;
	}

	const api: DebugConsoleApi = {
		getMetrics: opts.getMetrics,
		report,
		forceTrim: opts.forceTrim,
		watchMetrics(seconds = 10) {
			clearWatchTimers();

			const durationSeconds =
				Number.isFinite(seconds) && seconds > 0 ? seconds : 10;
			const durationMs = Math.round(durationSeconds * 1000);

			report();
			watchTimer = window.setInterval(report, 1000);
			watchStopTimer = window.setTimeout(() => {
				clearWatchTimers();
				console.log(
					`[chat-cleaner] metrics watch stopped after ${durationSeconds}s`
				);
			}, durationMs);

			console.log(
				`[chat-cleaner] watching metrics for ${durationSeconds}s`
			);
		},
		stopWatch() {
			const stopped = clearWatchTimers();
			if (stopped) console.log("[chat-cleaner] metrics watch stopped");
			return stopped;
		},
	};

	(window as any).__ccxDebug?.stopWatch?.();
	(window as any).__ccxDebug = api;
	(globalThis as any).__ccxDebug = api;

	console.log(
		[
			"%cChat Cleaner - Console Debug Enabled",
			"In DevTools Console, select the Content script context.",
			"Commands:",
			"  __ccxDebug.getMetrics()",
			"  __ccxDebug.report()",
			"  __ccxDebug.forceTrim()",
			"  __ccxDebug.watchMetrics(10)",
			"  __ccxDebug.stopWatch()",
		].join("\n"),
		"color:#93c5fd;font-weight:700;"
	);

	return {
		api,
		destroy() {
			clearWatchTimers();
			if ((window as any).__ccxDebug === api) {
				delete (window as any).__ccxDebug;
			}
			if ((globalThis as any).__ccxDebug === api) {
				delete (globalThis as any).__ccxDebug;
			}
		},
	};
}

export function clearDebugConsole() {
	(window as any).__ccxDebug?.stopWatch?.();
	delete (window as any).__ccxDebug;
	delete (globalThis as any).__ccxDebug;
}
