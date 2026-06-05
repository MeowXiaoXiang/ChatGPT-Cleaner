// src/content/main.ts
// Chat Cleaner - Runtime Orchestration
// ------------------------------------------------------------
// 職責:
//   - 組裝 i18n、UI、observer、trimmer 與 debug console。
//   - 管理 content script lifecycle、Long Task gate、route reset。
//   - 協調 inventory、settings、scheduler、activity guard 等 runtime 模組。
//
// 邊界:
//   - 不直接持有 inventory / settings / trim scheduling 的內部狀態。
//   - 不處理 UI 細節、DOM trim 細節或 debug console 註冊細節。
// ------------------------------------------------------------

import { injectRuntimeStyle, isMarkedHidden } from "./dom-utils";
import { createI18n, createToast, mountUI, mountShowMore } from "./ui";
import { createObserverHandles } from "./observer";
import { createTurnInventory } from "./turn-inventory";
import { createTrimScheduler } from "./trim-scheduler";
import { createActivityGuard } from "./activity-guard";
import { createFollowUpTrims } from "./follow-up-trims";
import {
	persistSettings,
	readRuntimeFlags,
	readSettings,
	setCleanerEnabled,
	setDebugEnabled,
} from "./settings-store";
import {
	createDeleter,
	createTrimmer,
	batchDelete,
	getHidden,
	restoreMsg,
} from "./trim-engine";
import type { Selectors, Settings, Stats } from "./types";
import {
	clearDebugConsole,
	mountDebugConsole,
	type ActivityDebugReport,
	type DebugConsoleController,
	type DebugMetrics,
	type ForceTrimDebugResult,
	type InventoryDebugReport,
	type SelectorDebugReport,
	sampleElements,
} from "./debug";
import {
	LONG_TASK,
	MIN_TRIM_INTERVAL_MS,
	WAKE,
	SELECTORS as SEL,
	SELECTOR_ALL,
} from "./constants";

(async () => {
	// ---- flags ----
	const flags = await readRuntimeFlags();
	const DEBUG = flags.debug;
	const log = (...args: unknown[]) =>
		DEBUG && console.log("[chat-cleaner]", ...args);

	(window as any).__ccxChatCleanerSetDebug = async (force?: boolean) => {
		const current = await readRuntimeFlags();
		const next = typeof force === "boolean" ? force : !current.debug;
		await setDebugEnabled(next);
		location.reload();
		return next;
	};

	(window as any).__ccxChatCleanerToggle = async (force?: "0" | "1") => {
		const current = await readRuntimeFlags();
		const next = force == null ? !current.enabled : force !== "0";
		await setCleanerEnabled(next);
		location.reload();
		return next;
	};

	if (!flags.enabled) {
		log("disabled via extension storage enabled=false");
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
	const COMPOSER_DEBUG_SELECTOR =
		'textarea, input[type="text"], input[type="search"], [contenteditable="true"]';
	const INTERNAL_UI_SELECTOR = ".ccx-ui, .ccx-toast-container, .ccx-showmore-wrap";

	// ---- settings / state ----
	const state: Settings = await readSettings();
	const stats: Stats = { domRemoved: 0 };

	let maxObservedTurnCount = 0;
	let lastConversationKey = location.href;

	const styleTag = injectRuntimeStyle();
	const inventory = createTurnInventory({
		selectorAll: SELECTORS.ALL,
		log,
	});
	const activityGuard = createActivityGuard({ log });

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

	function getConversationKey() {
		return location.href;
	}

	function getVisibleTurnCount() {
		return inventory.getSnapshot().visibleCount;
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
		async onApply(next) {
			try {
				const oldMode = state.mode;

				const persisted = await persistSettings(next);
				state.maxKeep = persisted.maxKeep;
				state.mode = persisted.mode;
				state.notify = persisted.notify;

				if (oldMode !== state.mode) {
					inventory.resetRemovedCount();
				}

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
							() => inventory.scheduleResync("hideToDeletePurge")
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

	const deleteMsg = createDeleter(log, stats, (el, wasHidden) =>
		inventory.trackTurnDeleted(el, {
			wasHidden,
			countRemoved: state.mode === "delete",
		})
	);
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
		onTurnHidden: inventory.trackTurnHidden,
		onTurnRestored: inventory.trackTurnRestored,
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

	// ---- EMA 工具（Long Task gate）----
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
			const scheduledSnapshot = trimScheduler.getSnapshot();
			if (scheduledSnapshot.scheduled) {
				trimScheduler.queueAfterResume({ manual: scheduledSnapshot.manual });
			}
			trimScheduler.cancel(); // 暫停時取消既定排程
		} else if (shouldExit) {
			ltSuspended = false;
			log(
				`storm/suspend OFF | longTask rateEMA=${ltRateEMA.toFixed(
					2
				)}/s avg=${ltAvgDurEMA.toFixed(1)}ms`
			);
			const pendingTrim = trimScheduler.consumePendingAfterResume();
			if (pendingTrim.pending) {
				const manual = pendingTrim.manual;
				log(`resume pending trim | manual=${manual ? "1" : "0"}`);
				scheduleTrim("stormResumePending", { manual });
			} else {
				scheduleAutoTrim("stormResume"); // 恢復後排一次
			}
		}
	}

	// ---- 排程 ----
	function scheduleTrim(
		reason = "mutation",
		opts: { manual?: boolean; observedCount?: number } = {}
	) {
		if (!opts.manual && activityGuard.isActive()) {
			activityGuard.deferUntilIdle(() => scheduleTrim(reason, opts), reason);
			return;
		}
		trimScheduler.schedule(reason, opts);
	}

	function runScheduledTrim(
		reason: string,
		opts: { manual?: boolean; observedCount?: number } = {}
	) {
		const res = trimmer.trimMessages();
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

		void res;
	}

	const trimScheduler = createTrimScheduler({
		runTrim: runScheduledTrim,
		isSuspended: () => stormGate.suspended,
		isWakeCoolingDown: () => Date.now() < wakeCooldownUntil,
		log,
	});

	type AutoTrimReason = "init" | "mutation" | "stormResume" | "followUp";

	function scheduleAutoTrim(reason: AutoTrimReason) {
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

	const followUpTrims = createFollowUpTrims({
		log,
		runCheck: () => scheduleAutoTrim("followUp"),
	});

	// ---- Observer ----
	// 防止滾動載入時過度觸發的節流機制（從 constants.ts 導入 MIN_TRIM_INTERVAL_MS）
	let lastTrimTime = 0;

	const observerHandles = createObserverHandles({
		selectors: SELECTORS,
		log,
		onTurnMutations(batch) {
			for (const el of batch.removed) inventory.trackRemovedTurn(el);
			for (const el of batch.added) inventory.trackAddedTurn(el);
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
			inventory.resync("observerInit");
			scheduleAutoTrim("init");
			followUpTrims.schedule("observerInit");
		},
		onRouteChange() {
			log("route change -> reset stats + auto-hide tracking");
			stats.domRemoved = 0;
			inventory.reset("routeChange", { resetDeleteCount: true });
			followUpTrims.cancel();

			// 路由變化時，重置自動 hide 的對話追蹤狀態
			// 避免新對話沿用舊對話的歷史最大值與排程
			trimScheduler.cancel();
			trimScheduler.consumePendingAfterResume();
			refreshConversationTracking("routeChange");
			followUpTrims.schedule("routeChange");
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
		const inventorySnapshot = inventory.getSnapshot();
		const activityReport = explainActivity();
		return {
			mode: state.mode,
			maxKeep: state.maxKeep,
			visibleCount: inventorySnapshot.visibleCount,
			hiddenCount: inventorySnapshot.hiddenCount,
			removedCount: inventorySnapshot.removedCount,
			trimAvgMs: +trimScheduler.getSnapshot().trimAvgMs.toFixed(2),
			suspended: stormGate.suspended,
			longTaskRateEMA: +ltRateEMA.toFixed(2),
			longTaskAvgMsEMA: +ltAvgDurEMA.toFixed(1),
			ltThresholds: {
				enterRate: LT_ENTER_RATE,
				exitRate: LT_EXIT_RATE,
				enterAvg: LT_ENTER_AVG,
				exitAvg: LT_EXIT_AVG,
			},
			activity: {
				active: activityReport.active,
				composing: activityReport.composing,
				remainingMs: activityReport.remainingMs,
				composerCandidateCount: activityReport.composerCandidateCount,
				activeElementIsComposer: activityReport.activeElementIsComposer,
			},
		};
	}

	function forceTrim(): ForceTrimDebugResult | null {
		try {
			trimScheduler.cancel();
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

	function dumpInventory(): InventoryDebugReport {
		return inventory.dumpReport();
	}

	function getTurnAuthor(el: Element): "user" | "assistant" | "other" {
		const role =
			el.getAttribute("data-turn") ||
			el.getAttribute("data-message-author-role") ||
			el.querySelector("[data-message-author-role]")?.getAttribute(
				"data-message-author-role"
			) ||
			"";

		if (role === "user" || role === "assistant") return role;
		return "other";
	}

	function hasContentVisibilitySignal(el: Element): boolean {
		const nodes = [el, ...Array.from(el.querySelectorAll("[class], [style]"))];

		return nodes.some((node) => {
			const html = node as HTMLElement;
			const className =
				typeof html.className === "string" ? html.className : "";

			return (
				html.style.contentVisibility === "auto" ||
				className.includes("content-visibility:auto")
			);
		});
	}

	function isInternalElement(el: Element | null): boolean {
		return !!el?.closest?.(INTERNAL_UI_SELECTOR);
	}

	function isComposerElement(el: Element | null): boolean {
		return !!(
			el &&
			!isInternalElement(el) &&
			(el.matches?.(COMPOSER_DEBUG_SELECTOR) ||
				el.closest?.(COMPOSER_DEBUG_SELECTOR))
		);
	}

	function sampleElement(label: string, el: Element | null) {
		if (!el) return null;
		return sampleElements([{ label, el }])[0] ?? null;
	}

	function getSelectorProbeCounts() {
		return {
			mainCount: document.querySelectorAll("main").length,
			threadCount: document.querySelectorAll("#thread").length,
			turnIdCount: document.querySelectorAll("[data-turn-id]").length,
			turnAttrCount: document.querySelectorAll("[data-turn]").length,
			messageRoleCount: document.querySelectorAll("[data-message-author-role]")
				.length,
			conversationTestIdCount: document.querySelectorAll(
				'[data-testid*="conversation"]'
			).length,
			turnTestIdCount: document.querySelectorAll(
				'[data-testid^="conversation-turn-"]'
			).length,
			sectionTurnIdCount: document.querySelectorAll("section[data-turn-id]")
				.length,
			articleTurnIdCount: document.querySelectorAll("article[data-turn-id]")
				.length,
			composerCandidateCount: document.querySelectorAll(COMPOSER_DEBUG_SELECTOR)
				.length,
		};
	}

	function getCandidateSamples() {
		const items: Array<{ label: string; el: Element }> = [];

		const addSamples = (label: string, selector: string, limit = 3) => {
			items.push(
				...Array.from(document.querySelectorAll<Element>(selector))
					.slice(0, limit)
					.map((el) => ({ label, el }))
			);
		};

		addSamples("turn-id", "[data-turn-id]", 4);
		addSamples("message-role", "[data-message-author-role]", 4);
		addSamples("conversation-testid", '[data-testid*="conversation"]', 4);
		addSamples("thread-main", "#thread, main", 2);
		addSamples("composer", COMPOSER_DEBUG_SELECTOR, 2);

		return sampleElements(items);
	}

	function explainActivity(): ActivityDebugReport {
		const snapshot = activityGuard.getSnapshot();
		const activeElement =
			document.activeElement instanceof Element ? document.activeElement : null;

		return {
			active: snapshot.active,
			composing: snapshot.composing,
			activeUntil: snapshot.activeUntil,
			remainingMs: snapshot.remainingMs,
			composerSelector: COMPOSER_DEBUG_SELECTOR,
			composerCandidateCount: document.querySelectorAll(COMPOSER_DEBUG_SELECTOR)
				.length,
			activeElementIsComposer: isComposerElement(activeElement),
			activeElement: sampleElement("activeElement", activeElement),
		};
	}

	function explainSelectors(): SelectorDebugReport {
		const primary = Array.from(
			document.querySelectorAll<Element>(SELECTORS.LIST)
		);
		const fallback = Array.from(
			document.querySelectorAll<Element>(SEL.FALLBACK)
		);
		const combined = Array.from(
			document.querySelectorAll<Element>(SELECTORS.ALL)
		);

		const hiddenMarkedCount = combined.reduce(
			(count, el) => count + (isMarkedHidden(el) ? 1 : 0),
			0
		);
		const authorCounts = combined.reduce(
			(counts, el) => {
				counts[getTurnAuthor(el)]++;
				return counts;
			},
			{ user: 0, assistant: 0, other: 0 }
		);
		const contentVisibilityCount = combined.reduce(
			(count, el) => count + (hasContentVisibilitySignal(el) ? 1 : 0),
			0
		);

		return {
			primarySelector: SELECTORS.LIST,
			fallbackSelector: SEL.FALLBACK,
			combinedSelector: SELECTORS.ALL,
			page: {
				href: location.href,
				readyState: document.readyState,
				title: document.title,
				bodyChildCount: document.body?.childElementCount ?? 0,
			},
			primaryCount: primary.length,
			fallbackCount: fallback.length,
			combinedCount: combined.length,
			probeCounts: getSelectorProbeCounts(),
			hiddenMarkedCount,
			visibleCount: combined.length - hiddenMarkedCount,
			authorCounts,
			contentVisibilityCount,
			samples: sampleElements([
				...primary.slice(0, 4).map((el) => ({ label: "primary", el })),
				...fallback.slice(0, 4).map((el) => ({ label: "fallback", el })),
				...combined.slice(0, 4).map((el) => ({ label: "combined", el })),
			]),
			candidateSamples: getCandidateSamples(),
		};
	}

	let debugConsole: DebugConsoleController | null = null;
	if (DEBUG) {
		debugConsole = mountDebugConsole({
			getMetrics: getDebugMetrics,
			forceTrim,
			dumpInventory,
			explainSelectors,
			explainActivity,
		});
	} else {
		clearDebugConsole();
	}

	// 可程式化停止：釋放 observer / 註冊事件，乾淨卸載插件
	// 快速開關：修改 extension storage 並 reload
	(window as any).__ccxChatCleanerStop = () => {
		try {
			observerHandles.stop();
			observerActive = false;
			followUpTrims.dispose();
			trimScheduler.dispose();
			activityGuard.dispose();
			inventory.dispose();

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

	// __ccxChatCleanerToggle is installed near startup so it also works while disabled.
})();
