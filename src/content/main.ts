// src/content/main.ts
// Chat Cleaner - Main Entry
// ------------------------------------------------------------
// 功能職責 (Responsibilities):
//   - 組裝 i18n / UI / Observer / Trimmer
//   - 負責排程與狀態流管理
//
// 主要職能 (Key Functions):
//   - 單例防呆 & 啟用旗標（ccx_enabled / ccx_debug）
//   - Long Task Gate（PerformanceObserver）＋ 自動調速（EMA）
//   - MutationObserver → 動態排程 trim（Idle + Max 退避）
//   - Debug hooks / Stop / Toggle
//
// 設計要點 (Design Notes):
//   - Gate 依據 Long Task 的「次數/秒」與「平均耗時」EMA
//   - trim-engine 僅讀 stormGate.suspended 判斷刪除/隱藏
//   - 調速僅依據 trim 平均耗時，不依據 DOM Mutation 數量
// ------------------------------------------------------------

import { injectRuntimeStyle } from "./dom-utils";
import { createI18n, createToast, mountUI, mountShowMore } from "./ui";
import { createObserverHandles } from "./observer";
import {
	createDeleter,
	createTrimmer,
	batchDelete,
	getHidden,
} from "./trim-engine";
import { requestIdle, cancelIdle, IdleHandle } from "./idle-utils";
import type { DebounceState, Mode, Selectors, Settings, Stats } from "./types";
import { mountMonitor } from "./monitor";
import type { MonitorController, MonitorApi } from "./monitor";
import {
	DEFAULT_MAX_KEEP,
	DEFAULT_MODE,
	DEBOUNCE,
	TRIM_THRESHOLD,
	LONG_TASK,
	MIN_TRIM_INTERVAL_MS,
	WAKE,
	SELECTORS as SEL,
	SELECTOR_ALL,
} from "./constants";

// ---- 全域計時器綁定 ----
const setT = globalThis.setTimeout.bind(globalThis);
const clearT = globalThis.clearTimeout.bind(globalThis);

(() => {
	// ---- flags ----
	const DEBUG = localStorage.getItem("ccx_debug") === "1";
	const log = (...args: unknown[]) =>
		DEBUG && console.log("[chat-cleaner]", ...args);

	const ENABLED = localStorage.getItem("ccx_enabled") !== "0";
	if (!ENABLED) {
		log("disabled via ccx_enabled=0");
		return;
	}

	// ---- singleton guard ----
	if ((window as any).__ccxChatCleanerLoaded__) {
		console.warn(
			"[chat-cleaner] duplicate content script detected, stopping previous and reloading."
		);
		try {
			(window as any).__ccxChatCleanerStop?.();
		} catch {}
	}
	(window as any).__ccxChatCleanerLoaded__ = true;

	// ---- i18n / selectors ----
	const T = createI18n();

	const SELECTORS: Selectors = {
		LIST: SEL.PRIMARY,
		ALL: SELECTOR_ALL,
	};

	// ---- settings / state ----
	const state: Settings = {
		maxKeep: Math.max(
			1,
			parseInt(localStorage.getItem("ccx_max_keep") || String(DEFAULT_MAX_KEEP), 10)
		),
		notify: localStorage.getItem("ccx_notify") !== "0",
		mode: (localStorage.getItem("ccx_mode") as Mode) || DEFAULT_MODE,
		enabled: true,
		debug: DEBUG,
	};
	const stats: Stats = { domRemoved: 0 };

	// ---- 調速參數（從 constants.ts 導入）----
	const TRIM_SLOW_MS = TRIM_THRESHOLD.SLOW_MS;
	const STEP_UP_MS = TRIM_THRESHOLD.STEP_UP_MS;
	const STEP_DOWN_MS = TRIM_THRESHOLD.STEP_DOWN_MS;

	const debounce: DebounceState = {
		delay: DEBOUNCE.DELAY_INIT,
		min: DEBOUNCE.DELAY_MIN,
		max: DEBOUNCE.DELAY_MAX,
		emaAlpha: DEBOUNCE.EMA_ALPHA,
		trimAvgMs: 0,
	};

	let scheduled = false;
	let idleId: IdleHandle | null = null;
	let timerId: ReturnType<typeof setTimeout> | null = null;

	const styleTag = injectRuntimeStyle();

	// Long Task Gate（從 constants.ts 導入）
	const BUCKET_MS = LONG_TASK.BUCKET_MS;
	const LT_ALPHA_RATE = LONG_TASK.ALPHA_RATE;
	const LT_ALPHA_DUR = LONG_TASK.ALPHA_DUR;
	const LT_DECAY = LONG_TASK.DECAY;

	const LT_ENTER_RATE = LONG_TASK.ENTER_RATE;
	const LT_EXIT_RATE = LONG_TASK.EXIT_RATE;
	const LT_ENTER_AVG = LONG_TASK.ENTER_AVG;
	const LT_EXIT_AVG = LONG_TASK.EXIT_AVG;
	const LT_MIN_SUSP_MS = LONG_TASK.MIN_SUSPEND_MS;

	// Long Task 觀測視窗（每秒歸零）
	let ltCountWindow = 0;
	let ltDurSumWindow = 0;

	// Long Task EMA 值
	let ltRateEMA = 0;
	let ltAvgDurEMA = 0;

	// Gate 狀態
	let ltSuspended = false;
	let ltEnteredAt = 0;

	// Long Task 觀測器
	let ltObserver: PerformanceObserver | null = null;
	const LT_SUPPORTED =
		"PerformanceObserver" in window &&
		((PerformanceObserver as any).supportedEntryTypes || []).includes(
			"longtask"
		);

	if (LT_SUPPORTED) {
		ltObserver = new PerformanceObserver((list) => {
			const entries = list.getEntries() as PerformanceEntry[];
			for (const e of entries) {
				ltCountWindow++;
				ltDurSumWindow += (e as any).duration || 0; // ms
			}
		});
		try {
			ltObserver.observe({ type: "longtask", buffered: true } as any);
		} catch {
			ltObserver.observe({ entryTypes: ["longtask"] as any });
		}
	} else {
		log("Long Task not supported; gate will never suspend.");
	}

	// 提供給 trimmer 的 stormGate（僅需 suspended）
	const stormGate = {
		get suspended() {
			return ltSuspended;
		},
	};

	function cancelScheduledTrim() {
		if (idleId != null) {
			cancelIdle(idleId);
			idleId = null;
		}
		if (timerId != null) {
			clearT(timerId);
			timerId = null;
		}
		scheduled = false;
	}

	const { showToast, showResult } = createToast(T);

	const ui = mountUI({
		T,
		initial: {
			maxKeep: state.maxKeep,
			mode: state.mode,
			notify: state.notify,
		},
		onApply(next) {
			try {
				const oldMode = state.mode;

				state.maxKeep = next.maxKeep;
				state.mode = next.mode;
				state.notify = next.notify;

				localStorage.setItem("ccx_max_keep", String(state.maxKeep));
				localStorage.setItem("ccx_mode", state.mode);
				localStorage.setItem("ccx_notify", state.notify ? "1" : "0");

				// hide → delete：先清既有「已隱藏」節點，保持狀態單一
				if (oldMode === "hide" && state.mode === "delete") {
					const hiddenNodes = getHidden(SELECTORS.ALL);
					if (hiddenNodes.length) {
						batchDelete(hiddenNodes, deleteMsg, log, (count) => {
							log(`purge(hidden→delete) ${count}`);
							if (state.notify && count > 0) {
								showToast(
									`${count} ${T("toastDeleted", "deleted")}`,
									"delete"
								);
							}
						});
					}
				}

				if (state.mode === "hide") showMore.update(); // 只在 hide 模式需要

				scheduleTrim("apply");
				showToast(T("toastApplied", "Applied"), "ok");
			} catch (e) {
				console.error("[chat-cleaner] Apply failed", e);
				showToast(
					T("toastApplyFailed", "Apply failed, check console"),
					"err"
				);
			}
		},
		onMonitor: () => {
			const tryOpen = () => {
				if (__ccxMonitorCtl?.showPanel) {
					__ccxMonitorCtl.showPanel();
					return true;
				}
				const win = (window as any).__ccxMonitor;
				if (win?.showPanel) {
					win.showPanel();
					return true;
				}
				return false;
			};
			if (tryOpen()) return;
			setTimeout(() => tryOpen() || setTimeout(tryOpen, 350), 50);
		},
	});

	const deleteMsg = createDeleter(log, stats);
	const trimmer = createTrimmer({
		selectors: SELECTORS,
		modeRef: () => state.mode,
		maxKeepRef: () => state.maxKeep,
		notifyRef: () => state.notify,
		stormGate, // 只讀 suspended
		deleteMsg,
		showResult: (res, auto) => {
			if (state.notify) showResult(res, state.mode, auto);
		},
		log,
	});

	// ---- Show More（只在 hide 模式顯示）----
	const showMore = mountShowMore({
		T,
		selectorAll: SELECTORS.ALL,
		trimmer,
		modeRef: () => state.mode,
		maxKeepRef: () => state.maxKeep,
	});

	// ---- 喚醒守門（從 constants.ts 導入）----
	let wakeCooldownUntil = 0;
	let resumeMuteUntil = 0;
	const WAKE_COOLDOWN_MS = WAKE.COOLDOWN_MS;
	const RESUME_MUTE_MS = WAKE.RESUME_MUTE_MS;

	let observerActive = false;

	// ---- EMA 工具 ----
	function EMA(p: number | null | undefined, c: number, a: number) {
		return p == null ? c : p * (1 - a) + c * a;
	}

	// —— 心跳結算（1s）
	let bucketTimer: ReturnType<typeof setInterval> | null = null;

	function flushBuckets() {
		if (document.visibilityState !== "visible") return;

		// Long Task 結算
		const ltCount = ltCountWindow;
		const ltAvg = ltCount ? ltDurSumWindow / ltCount : 0;

		ltCountWindow = 0;
		ltDurSumWindow = 0;

		ltRateEMA = EMA(ltRateEMA, ltCount, LT_ALPHA_RATE);
		ltAvgDurEMA = EMA(ltAvgDurEMA, ltAvg, LT_ALPHA_DUR);

		if (ltCount === 0) {
			// 無 long task：快速衰減
			ltRateEMA *= LT_DECAY;
			ltAvgDurEMA *= LT_DECAY;
		}

		// Gate 決策（含 hysteresis + cooldown）
		const shouldEnter =
			LT_SUPPORTED &&
			!ltSuspended &&
			(ltRateEMA >= LT_ENTER_RATE || ltAvgDurEMA >= LT_ENTER_AVG);

		const canExitByTime = Date.now() - ltEnteredAt >= LT_MIN_SUSP_MS;
		const shouldExit =
			ltSuspended &&
			canExitByTime &&
			ltRateEMA < LT_EXIT_RATE &&
			ltAvgDurEMA < LT_EXIT_AVG;

		if (shouldEnter) {
			ltSuspended = true;
			ltEnteredAt = Date.now();
			log(
				`storm/suspend ON | longTask rateEMA=${ltRateEMA.toFixed(
					2
				)}/s avg=${ltAvgDurEMA.toFixed(1)}ms`
			);
			cancelScheduledTrim(); // 暫停時取消既定排程
		} else if (shouldExit) {
			ltSuspended = false;
			log(
				`storm/suspend OFF | longTask rateEMA=${ltRateEMA.toFixed(
					2
				)}/s avg=${ltAvgDurEMA.toFixed(1)}ms`
			);
			scheduleTrim("stormResume"); // 恢復後排一次
		}
	}

	// ---- 自動調速（只依 trimAvgMs）----
	function autoTuneDebounce(reason: string) {
		const prev = debounce.delay;

		if (debounce.trimAvgMs > TRIM_SLOW_MS) {
			debounce.delay = Math.min(
				debounce.max,
				Math.round(debounce.delay + STEP_UP_MS)
			);
		} else if (debounce.trimAvgMs < TRIM_SLOW_MS * (2 / 3)) {
			debounce.delay = Math.max(
				debounce.min,
				Math.round(debounce.delay - STEP_DOWN_MS)
			);
		}

		if (debounce.delay !== prev) {
			log(
				`debounce=${
					debounce.delay
				}ms [${reason}] | trim=${debounce.trimAvgMs.toFixed(2)}ms`
			);
		}
	}

	// ---- 排程 ----
	function scheduleTrim(reason = "mutation") {
		if (scheduled) return;
		if (stormGate.suspended) {
			log(`skip schedule [${reason}] (suspended)`);
			return;
		}
		if (Date.now() < wakeCooldownUntil) {
			// 回前景冷卻期間
			log(`skip schedule [${reason}] (wakeCooldown)`);
			return;
		}

		scheduled = true;
		log(`scheduleTrim [${reason}] delay=${debounce.delay}ms`);

		const run = () => {
			cancelScheduledTrim();

			const t0 = performance.now();
			const res = trimmer.trimMessages();
			const t1 = performance.now();

			if (state.mode === "hide") showMore.update();

			debounce.trimAvgMs = EMA(
				debounce.trimAvgMs,
				t1 - t0,
				debounce.emaAlpha
			);
			autoTuneDebounce("afterTrim");

			void res;
		};

		idleId = requestIdle(run, { timeout: debounce.delay });
		timerId = setT(() => {
			if (scheduled) {
				cancelIdle(idleId);
				idleId = null;
				run();
			}
		}, debounce.max);
	}

	// ---- Observer ----
	// 防止滾動載入時過度觸發的節流機制（從 constants.ts 導入 MIN_TRIM_INTERVAL_MS）
	let lastTrimTime = 0;

	const observerHandles = createObserverHandles({
		selectors: SELECTORS,
		log,
		onMutation(muts) {
			if (Date.now() < resumeMuteUntil) return; // 回前景首波：略過

			// 節流：避免短時間內過度觸發 trim
			const now = Date.now();
			if (now - lastTrimTime < MIN_TRIM_INTERVAL_MS) {
				log("skip mutation (throttled)");
				return;
			}

			// 單輪遍歷：命中新訊息節點則排程一次
			let hit = false;
			for (const m of muts) {
				for (const n of m.addedNodes as any) {
					const el = n as Element;
					if (
						!hit &&
						el?.nodeType === 1 &&
						(el.matches?.(SELECTORS.ALL) ||
							el.querySelector?.(SELECTORS.ALL))
					) {
						hit = true;
					}
				}
			}
			if (hit) {
				lastTrimTime = now;
				scheduleTrim("mutation");
			}
		},
		onInit() {
			scheduleTrim("init");
		},
		onRouteChange() {
			log("route change -> reset stats + clear hidden marks");
			stats.domRemoved = 0;
			
			// 路由變化時，清除所有隱藏標記
			// 因為新對話頁面的 DOM 是全新的，舊標記不應影響
			// 這也避免了 SPA 切換時的狀態污染
			cancelScheduledTrim();
		},
	});

	// ---- lifecycle ----
	log("init settings =>", {
		maxKeep: state.maxKeep,
		notify: state.notify,
		mode: state.mode,
	});

	observerHandles.setupRouteWatchers();

	const onPageShow = () => {
		if (!observerActive) {
			observerHandles.start();
			observerActive = true;
		}
	};
	const onVisibilityChange = () => {
		if (document.visibilityState === "visible") {
			const now = Date.now();
			wakeCooldownUntil = now + WAKE_COOLDOWN_MS;
			resumeMuteUntil = now + RESUME_MUTE_MS;

			if (!observerActive) {
				observerHandles.start();
				observerActive = true;
			}
		}
	};

	window.addEventListener("pageshow", onPageShow, { passive: true });
	document.addEventListener("visibilitychange", onVisibilityChange, {
		passive: true,
	});

	// 首次啟動
	observerHandles.start();
	observerActive = true;
	log("running:", {
		maxKeep: state.maxKeep,
		mode: state.mode,
		notify: state.notify,
	});

	// —— 啟動心跳結算（1s 一次）
	if (bucketTimer == null) {
		bucketTimer = setInterval(flushBuckets, BUCKET_MS);
	}

	// Monitor Panel：暴露 metrics 與控制 API（forceTrim, showPanel 等）
	// Monitor Panel 總是可用，不依賴任何 flag
	let __ccxMonitorCtl: MonitorController | null = null;

	// 總是啟用 Monitor Panel
	{
		const api: MonitorApi = {
			getMetrics: () => ({
				debounceDelay: debounce.delay,
				trimAvgMs: +debounce.trimAvgMs.toFixed(2),

				suspended: stormGate.suspended,
				longTaskRateEMA: +ltRateEMA.toFixed(2),
				longTaskAvgMsEMA: +ltAvgDurEMA.toFixed(1),
				ltThresholds: {
					enterRate: LT_ENTER_RATE,
					exitRate: LT_EXIT_RATE,
					enterAvg: LT_ENTER_AVG,
					exitAvg: LT_EXIT_AVG,
					minSuspendMs: LT_MIN_SUSP_MS,
				},

				maxKeep: state.maxKeep,
				mode: state.mode,
				stats: { ...stats },
			}),
			forceTrim: () => scheduleTrim("manual"),
			forceTrimNow: () => {
				try {
					cancelScheduledTrim();
					const t0 = performance.now();
					const res = trimmer.trimMessages();
					const t1 = performance.now();
					if (state.mode === "hide") showMore.update();
					console.log(
						"[chat-cleaner] forceTrimNow:",
						res,
						`${(t1 - t0).toFixed(2)}ms`
					);
				} catch (e) {
					console.error("[chat-cleaner] forceTrimNow failed", e);
				}
			},
		};

		__ccxMonitorCtl = mountMonitor(api);

		if (DEBUG) {
			console.log(
				[
					"%cChat Cleaner – Console Logging Enabled",
					"▶ In DevTools Console, select the Content script context (not top).",
					"▶ Monitor Panel:",
					"    __ccxMonitor.showPanel()",
					"    __ccxMonitor.hidePanel()",
					"▶ Commands:",
					"    __ccxMonitor.getMetrics()",
					"    __ccxMonitor.forceTrim()",
					"    __ccxMonitor.forceTrimNow()",
				].join("\n"),
				"color:#93c5fd;font-weight:700;"
			);
		}
	}

	// 可程式化停止：釋放 observer / 註冊事件，乾淨卸載插件
	// 快速開關：修改 localStorage 並 reload
	(window as any).__ccxChatCleanerStop = () => {
		try {
			observerHandles.stop();
			observerActive = false;
			cancelScheduledTrim();

			if (bucketTimer != null) {
				clearInterval(bucketTimer);
				bucketTimer = null;
			}

			try {
				ltObserver?.disconnect?.();
			} catch {}
			styleTag?.remove?.();

			window.removeEventListener("pageshow", onPageShow as any);
			document.removeEventListener(
				"visibilitychange",
				onVisibilityChange as any
			);

			ui.destroy();
			showMore.destroy();

			try {
				__ccxMonitorCtl?.destroy();
				__ccxMonitorCtl = null;
			} catch {}

			document.getElementById("ccx-monitor")?.remove?.();
			document.getElementById("ccx-monitor-tip")?.remove?.();
			document.querySelector(".ccx-ui")?.remove?.();
		} catch {}

		(window as any).__ccxChatCleanerLoaded__ = false;
		log("stopped");
	};

	// ---- 快速開關（寫入 localStorage 後 reload）----
	(window as any).__ccxChatCleanerToggle = (force?: "0" | "1") => {
		const cur = localStorage.getItem("ccx_enabled") !== "0";
		const next = force ?? (cur ? "0" : "1");
		localStorage.setItem("ccx_enabled", next);
		location.reload();
	};
})();
