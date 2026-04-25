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

import { injectRuntimeStyle, isMarkedHidden } from "./dom-utils";
import { createI18n, createToast, mountUI, mountShowMore } from "./ui";
import { createObserverHandles } from "./observer";
import {
	createDeleter,
	createTrimmer,
	batchDelete,
	getHidden,
	restoreMsg,
} from "./trim-engine";
import { requestIdle, cancelIdle, IdleHandle } from "./idle-utils";
import type { DebounceState, Mode, Selectors, Settings, Stats } from "./types";
import {
	clearDebugConsole,
	mountDebugConsole,
	type DebugConsoleController,
	type DebugMetrics,
	type ForceTrimDebugResult,
} from "./debug";
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
	let maxObservedTurnCount = 0;
	let lastConversationKey = location.href;
	let inventoryResyncTimer: ReturnType<typeof setTimeout> | null = null;
	let pendingTrimAfterResume = false;
	let pendingTrimManual = false;
	let scheduledTrimManual = false;

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

	const inventory = {
		knownTurnIds: new Set<string>(),
		turnHidden: new Map<string, boolean>(),
		visibleCount: 0,
		hiddenCount: 0,
		deleteModeRemovedCount: 0,
		tempSeq: 0,
		elementKeys: new WeakMap<Element, string>(),
	};

	function resetInventory(
		reason: string,
		opts: { resetDeleteCount?: boolean } = {}
	) {
		inventory.knownTurnIds.clear();
		inventory.turnHidden.clear();
		inventory.visibleCount = 0;
		inventory.hiddenCount = 0;
		if (opts.resetDeleteCount) inventory.deleteModeRemovedCount = 0;
		log(`inventory reset [${reason}]`);
	}

	function getTurnKey(el: Element): string {
		const existed = inventory.elementKeys.get(el);
		if (existed) return existed;

		const base =
			el.getAttribute("data-turn-id") ||
			el.getAttribute("data-testid") ||
			`ccx-temp-turn-${++inventory.tempSeq}`;

		inventory.elementKeys.set(el, base);
		return base;
	}

	function scheduleInventoryResync(
		reason: string,
		opts: { resetDeleteCount?: boolean } = {}
	) {
		if (inventoryResyncTimer != null) return;
		inventoryResyncTimer = setT(() => {
			inventoryResyncTimer = null;
			resyncInventory(reason, opts);
		}, 0);
	}

	function ensureInventoryNonNegative(reason: string) {
		if (inventory.visibleCount >= 0 && inventory.hiddenCount >= 0) return;
		log(
			`inventory drift detected [${reason}] visible=${inventory.visibleCount} hidden=${inventory.hiddenCount}`
		);
		scheduleInventoryResync(`drift:${reason}`);
	}

	function resyncInventory(
		reason: string,
		opts: { resetDeleteCount?: boolean } = {}
	) {
		resetInventory(reason, opts);
		const turns = Array.from(document.querySelectorAll<Element>(SELECTORS.ALL));
		for (const el of turns) {
			const key = getTurnKey(el);
			const hidden = isMarkedHidden(el);
			inventory.knownTurnIds.add(key);
			inventory.turnHidden.set(key, hidden);
			if (hidden) inventory.hiddenCount++;
			else inventory.visibleCount++;
		}
		log(
			`inventory resync [${reason}] visible=${inventory.visibleCount} hidden=${inventory.hiddenCount} turns=${inventory.knownTurnIds.size}`
		);
	}

	function trackAddedTurn(el: Element) {
		const key = getTurnKey(el);
		if (inventory.knownTurnIds.has(key)) return;

		const hidden = isMarkedHidden(el);
		inventory.knownTurnIds.add(key);
		inventory.turnHidden.set(key, hidden);
		if (hidden) inventory.hiddenCount++;
		else inventory.visibleCount++;
		ensureInventoryNonNegative("trackAddedTurn");
	}

	function trackRemovedTurn(el: Element) {
		const key = getTurnKey(el);
		if (!inventory.knownTurnIds.has(key)) return;

		const hidden =
			inventory.turnHidden.get(key) ?? isMarkedHidden(el);
		inventory.knownTurnIds.delete(key);
		inventory.turnHidden.delete(key);
		if (hidden) inventory.hiddenCount--;
		else inventory.visibleCount--;
		ensureInventoryNonNegative("trackRemovedTurn");
	}

	function trackTurnHidden(el: Element) {
		const key = getTurnKey(el);
		if (!inventory.knownTurnIds.has(key)) {
			scheduleInventoryResync("hideUnknown");
			return;
		}

		if (inventory.turnHidden.get(key)) return;
		inventory.turnHidden.set(key, true);
		inventory.visibleCount--;
		inventory.hiddenCount++;
		ensureInventoryNonNegative("trackTurnHidden");
	}

	function trackTurnRestored(el: Element) {
		const key = getTurnKey(el);
		if (!inventory.knownTurnIds.has(key)) {
			scheduleInventoryResync("restoreUnknown");
			return;
		}

		if (!inventory.turnHidden.get(key)) return;
		inventory.turnHidden.set(key, false);
		inventory.hiddenCount--;
		inventory.visibleCount++;
		ensureInventoryNonNegative("trackTurnRestored");
	}

	function trackTurnDeleted(el: Element, wasHidden: boolean) {
		const key = getTurnKey(el);
		const known = inventory.knownTurnIds.has(key);
		const hidden = known
			? inventory.turnHidden.get(key) ?? wasHidden
			: wasHidden;

		if (known) {
			inventory.knownTurnIds.delete(key);
			inventory.turnHidden.delete(key);
			if (hidden) inventory.hiddenCount--;
			else inventory.visibleCount--;
		} else {
			scheduleInventoryResync("deleteUnknown");
		}

		if (state.mode === "delete") {
			inventory.deleteModeRemovedCount++;
		}
		ensureInventoryNonNegative("trackTurnDeleted");
	}

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
		scheduledTrimManual = false;
	}

	function queueTrimAfterResume(opts: { manual?: boolean } = {}) {
		pendingTrimAfterResume = true;
		pendingTrimManual = pendingTrimManual || !!opts.manual;
	}

	function getConversationKey() {
		return location.href;
	}

	function getVisibleTurnCount() {
		return inventory.visibleCount;
	}

	function refreshConversationTracking(reason: string) {
		lastConversationKey = getConversationKey();
		maxObservedTurnCount = 0;
		log(`auto-hide tracking reset [${reason}]`, lastConversationKey);
	}

	function ensureConversationTracking() {
		const key = getConversationKey();
		if (key !== lastConversationKey) {
			refreshConversationTracking("urlChanged");
		}
	}

	function syncHideBaseline(reason: string) {
		if (state.mode !== "hide") return;
		ensureConversationTracking();
		maxObservedTurnCount = getVisibleTurnCount();
		log(`auto-hide baseline sync [${reason}] => ${maxObservedTurnCount}`);
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

				if (oldMode !== state.mode) {
					inventory.deleteModeRemovedCount = 0;
				}

				localStorage.setItem("ccx_max_keep", String(state.maxKeep));
				localStorage.setItem("ccx_mode", state.mode);
				localStorage.setItem("ccx_notify", state.notify ? "1" : "0");

				// hide → delete：先清既有「已隱藏」節點，保持狀態單一
				if (oldMode === "hide" && state.mode === "delete") {
					const hiddenNodes = getHidden(SELECTORS.ALL);
					if (hiddenNodes.length) {
						batchDelete(
							hiddenNodes,
							deleteMsg,
							log,
							(count) => {
								log(`purge(hidden→delete) ${count}`);
								if (state.notify && count > 0) {
									showToast(
										`${count} ${T("toastDeleted", "deleted")}`,
										"delete"
									);
								}
							},
							() => scheduleInventoryResync("hideToDeletePurge")
						);
					}
				}

				if (state.mode === "hide") showMore.update(); // 只在 hide 模式需要

				scheduleTrim("apply", { manual: true });
				showToast(T("toastApplied", "Applied"), "ok");
			} catch (e) {
				console.error("[chat-cleaner] Apply failed", e);
				showToast(
					T("toastApplyFailed", "Apply failed, check console"),
					"err"
				);
			}
		},
	});

	const deleteMsg = createDeleter(log, stats, trackTurnDeleted);
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
		onTurnHidden: trackTurnHidden,
		onTurnRestored: trackTurnRestored,
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
			if (scheduled) {
				queueTrimAfterResume({ manual: scheduledTrimManual });
			}
			cancelScheduledTrim(); // 暫停時取消既定排程
		} else if (shouldExit) {
			ltSuspended = false;
			log(
				`storm/suspend OFF | longTask rateEMA=${ltRateEMA.toFixed(
					2
				)}/s avg=${ltAvgDurEMA.toFixed(1)}ms`
			);
			if (pendingTrimAfterResume) {
				const manual = pendingTrimManual;
				pendingTrimAfterResume = false;
				pendingTrimManual = false;
				log(`resume pending trim | manual=${manual ? "1" : "0"}`);
				scheduleTrim("stormResumePending", { manual });
			} else {
				scheduleAutoTrim("stormResume"); // 恢復後排一次
			}
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
	function scheduleTrim(
		reason = "mutation",
		opts: { manual?: boolean; observedCount?: number } = {}
	) {
		if (scheduled) return;
		if (stormGate.suspended) {
			queueTrimAfterResume({ manual: opts.manual });
			log(`skip schedule [${reason}] (suspended)`);
			return;
		}
		if (Date.now() < wakeCooldownUntil) {
			// 回前景冷卻期間
			log(`skip schedule [${reason}] (wakeCooldown)`);
			return;
		}

		scheduled = true;
		scheduledTrimManual = !!opts.manual;
		log(`scheduleTrim [${reason}] delay=${debounce.delay}ms`);

		const run = () => {
			cancelScheduledTrim();

			const t0 = performance.now();
			const res = trimmer.trimMessages();
			const t1 = performance.now();

			if (state.mode === "hide") {
				showMore.update();
				if (opts.manual) {
					syncHideBaseline(reason);
				} else if (typeof opts.observedCount === "number") {
					maxObservedTurnCount = Math.max(
						maxObservedTurnCount,
						opts.observedCount
					);
					log(
						`auto-hide max observed [${reason}] => ${maxObservedTurnCount}`
					);
				}
			}

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

	function scheduleAutoTrim(reason: "init" | "mutation" | "stormResume") {
		ensureConversationTracking();

		if (state.mode !== "hide") {
			scheduleTrim(reason);
			return;
		}

		const currentCount = getVisibleTurnCount();

		if (reason === "init") {
			maxObservedTurnCount = currentCount;
			log(`auto-hide init baseline => ${maxObservedTurnCount}`);

			if (currentCount > state.maxKeep) {
				scheduleTrim(reason, { observedCount: currentCount });
			}
			return;
		}

		if (maxObservedTurnCount === 0) {
			maxObservedTurnCount = currentCount;
			log(`auto-hide baseline establish [${reason}] => ${maxObservedTurnCount}`);
			return;
		}

		if (currentCount > maxObservedTurnCount) {
			scheduleTrim(reason, { observedCount: currentCount });
			return;
		}

		log(
			`skip auto trim [${reason}] count=${currentCount} max=${maxObservedTurnCount}`
		);
	}

	// ---- Observer ----
	// 防止滾動載入時過度觸發的節流機制（從 constants.ts 導入 MIN_TRIM_INTERVAL_MS）
	let lastTrimTime = 0;

	const observerHandles = createObserverHandles({
		selectors: SELECTORS,
		log,
		onTurnMutations(batch) {
			for (const el of batch.removed) trackRemovedTurn(el);
			for (const el of batch.added) trackAddedTurn(el);
		},
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
				scheduleAutoTrim("mutation");
			}
		},
		onInit() {
			resyncInventory("observerInit");
			scheduleAutoTrim("init");
		},
		onRouteChange() {
			log("route change -> reset stats + auto-hide tracking");
			stats.domRemoved = 0;
			resetInventory("routeChange", { resetDeleteCount: true });
			pendingTrimAfterResume = false;
			pendingTrimManual = false;
			
			// 路由變化時，重置自動 hide 的對話追蹤狀態
			// 避免新對話沿用舊對話的歷史最大值與排程
			cancelScheduledTrim();
			refreshConversationTracking("routeChange");
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

	function getDebugMetrics(): DebugMetrics {
		return {
			mode: state.mode,
			maxKeep: state.maxKeep,
			visibleCount: inventory.visibleCount,
			hiddenCount: inventory.hiddenCount,
			removedCount: inventory.deleteModeRemovedCount,
			trimAvgMs: +debounce.trimAvgMs.toFixed(2),
			suspended: stormGate.suspended,
			longTaskRateEMA: +ltRateEMA.toFixed(2),
			longTaskAvgMsEMA: +ltAvgDurEMA.toFixed(1),
			ltThresholds: {
				enterRate: LT_ENTER_RATE,
				exitRate: LT_EXIT_RATE,
				enterAvg: LT_ENTER_AVG,
				exitAvg: LT_EXIT_AVG,
			},
		};
	}

	function forceTrim(): ForceTrimDebugResult | null {
		try {
			cancelScheduledTrim();
			const t0 = performance.now();
			const res = trimmer.trimMessages();
			const t1 = performance.now();
			const ms = +(t1 - t0).toFixed(2);
			if (state.mode === "hide") {
				showMore.update();
				syncHideBaseline("manualNow");
			}
			console.log("[chat-cleaner] forceTrim:", res, `${ms}ms`);
			return { result: res, ms };
		} catch (e) {
			console.error("[chat-cleaner] forceTrim failed", e);
			return null;
		}
	}

	let debugConsole: DebugConsoleController | null = null;
	if (DEBUG) {
		debugConsole = mountDebugConsole({
			getMetrics: getDebugMetrics,
			forceTrim,
		});
	} else {
		clearDebugConsole();
	}

	// 可程式化停止：釋放 observer / 註冊事件，乾淨卸載插件
	// 快速開關：修改 localStorage 並 reload
	(window as any).__ccxChatCleanerStop = () => {
		try {
			observerHandles.stop();
			observerActive = false;
			cancelScheduledTrim();
			pendingTrimAfterResume = false;
			pendingTrimManual = false;
			if (inventoryResyncTimer != null) {
				clearT(inventoryResyncTimer);
				inventoryResyncTimer = null;
			}

			// 停用時完整還原 hide 模式留下的 aria-hidden / inert / class 標記
			const hiddenNodes = getHidden(SELECTORS.ALL);
			for (const el of hiddenNodes) {
				restoreMsg(el, "hide");
			}

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
				debugConsole?.destroy();
				debugConsole = null;
			} catch {}
			clearDebugConsole();

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
