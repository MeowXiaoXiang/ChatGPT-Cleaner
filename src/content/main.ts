// src/content/main.ts
// Chat Cleaner - Runtime Orchestration
// ------------------------------------------------------------
// 職責:
//   - 組裝 i18n、UI、observer、trimmer 與 debug console。
//   - 管理 content script lifecycle、route reset 與各 gate 的協調。
//   - 協調 inventory、settings、scheduler、activity guard 等 runtime 模組。
//
// 邊界:
//   - 不直接持有 inventory / settings / trim scheduling 的內部狀態。
//   - 不處理 UI 細節、DOM trim 細節或 debug console 註冊細節。
// ------------------------------------------------------------

import { injectRuntimeStyle } from "./dom-utils";
import { createI18n, createToast, mountUI, mountShowMore } from "./ui";
import { createObserverHandles } from "./observer";
import { createTurnInventory } from "./turn-inventory";
import { createTrimScheduler } from "./trim-scheduler";
import { createActivityGuard } from "./activity-guard";
import { createFollowUpTrims } from "./follow-up-trims";
import { createLoadReadinessGate } from "./load-readiness";
import { createLongTaskGate } from "./long-task-gate";
import { createRuntimeDiagnostics } from "./runtime-diagnostics";
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
	getVisible,
	getHidden,
	restoreMsg,
} from "./trim-engine";
import type { Selectors, Settings } from "./types";
import {
	clearDebugConsole,
	mountDebugConsole,
	type DebugConsoleController,
	type DebugMetrics,
	type ForceTrimDebugResult,
	type InventoryDebugReport,
} from "./debug";
import {
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
	// ---- settings / state ----
	const state: Settings = await readSettings();

	let maxObservedTurnCount = 0;
	let lastConversationKey = location.href;

	const styleTag = injectRuntimeStyle();
	const inventory = createTurnInventory({
		selectorAll: SELECTORS.ALL,
		log,
	});
	const activityGuard = createActivityGuard({ log });
	const loadReadiness = createLoadReadinessGate({
		selectors: SELECTORS,
		log,
	});
	const longTaskGate = createLongTaskGate({ log });

	// 提供給 trimmer 的 stormGate（僅需 suspended）
	const stormGate = {
		get suspended() {
			return longTaskGate.suspended;
		},
	};

	function getConversationKey() {
		return location.href;
	}

	function getVisibleTurnCount() {
		return getVisible(SELECTORS.ALL).length;
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

	const deleteMsg = createDeleter(log, (el, wasHidden) =>
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
		onShowMore(onDone) {
			loadReadiness.whenReady(
				() => {
					trimmer.showMoreMessages();
					onDone();
				},
				"showMore",
				{ key: "showMore" }
			);
		},
		modeRef: () => state.mode,
		maxKeepRef: () => state.maxKeep,
	});

	// ---- 喚醒守門（從 constants.ts 導入）----
	let wakeCooldownUntil = 0;
	let resumeMuteUntil = 0;
	let observerActive = false;

	// ---- 排程 ----
	function scheduleTrim(
		reason = "mutation",
		opts: { manual?: boolean; observedCount?: number } = {}
	) {
		if (!opts.manual && activityGuard.isActive()) {
			activityGuard.deferUntilIdle(() => scheduleTrim(reason, opts), reason);
			return;
		}

		loadReadiness.whenReady(
			() => trimScheduler.schedule(reason, opts),
			reason,
			{ key: `trim:${reason}:${opts.manual ? "1" : "0"}` }
		);
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

	const unsubscribeLongTaskGate = longTaskGate.subscribe((snapshot) => {
		if (snapshot.suspended) {
			const scheduledSnapshot = trimScheduler.getSnapshot();
			if (scheduledSnapshot.scheduled) {
				trimScheduler.queueAfterResume({ manual: scheduledSnapshot.manual });
			}
			trimScheduler.cancel();
			return;
		}

		const pendingTrim = trimScheduler.consumePendingAfterResume();
		if (pendingTrim.pending) {
			log(`resume pending trim | manual=${pendingTrim.manual ? "1" : "0"}`);
			scheduleTrim("stormResumePending", { manual: pendingTrim.manual });
		} else {
			scheduleAutoTrim("stormResume");
		}
	});

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
			loadReadiness.observeMutationBatch(muts);
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
							el.closest?.(SELECTORS.ALL) ||
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
			loadReadiness.requestCheck("observerInit");
			scheduleAutoTrim("init");
			followUpTrims.schedule("observerInit");
		},
		onRouteChange() {
			log("route change -> reset stats + auto-hide tracking");
			inventory.reset("routeChange", { resetDeleteCount: true });
			followUpTrims.cancel();
			showMore.destroy();

			// 路由變化時，重置自動 hide 的對話追蹤狀態
			// 避免新對話沿用舊對話的歷史最大值與排程
			trimScheduler.cancel();
			trimScheduler.consumePendingAfterResume();
			refreshConversationTracking("routeChange");
			loadReadiness.reset("routeChange");
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
		loadReadiness.requestCheck("pageshow");
	};
	const onVisibilityChange = () => {
		if (document.visibilityState === "visible") {
			const now = Date.now();
			wakeCooldownUntil = now + WAKE.COOLDOWN_MS;
			resumeMuteUntil = now + WAKE.RESUME_MUTE_MS;

			if (!observerActive) {
				observerHandles.start();
				observerActive = true;
			}
			loadReadiness.requestCheck("visibility");
		}
	};

	window.addEventListener("pageshow", onPageShow, { passive: true });
	document.addEventListener("visibilitychange", onVisibilityChange, {
		passive: true,
	});

	// 首次啟動
	observerHandles.start();
	observerActive = true;
	loadReadiness.requestCheck("startup");
	log("running:", {
		maxKeep: state.maxKeep,
		mode: state.mode,
		notify: state.notify,
	});

	const { explainActivity, explainSelectors } = createRuntimeDiagnostics({
		selectors: SELECTORS,
		fallbackSelector: SEL.FALLBACK,
		getActivitySnapshot: activityGuard.getSnapshot,
		getReadinessSnapshot: loadReadiness.getSnapshot,
	});

	function getDebugMetrics(): DebugMetrics {
		const inventorySnapshot = inventory.getSnapshot();
		const activityReport = explainActivity();
		const readinessSnapshot = loadReadiness.getSnapshot();
		const longTaskSnapshot = longTaskGate.getSnapshot();
		return {
			mode: state.mode,
			maxKeep: state.maxKeep,
			visibleCount: inventorySnapshot.visibleCount,
			hiddenCount: inventorySnapshot.hiddenCount,
			removedCount: inventorySnapshot.removedCount,
			trimAvgMs: +trimScheduler.getSnapshot().trimAvgMs.toFixed(2),
			suspended: stormGate.suspended,
			longTaskRateEMA: +longTaskSnapshot.rateEMA.toFixed(2),
			longTaskAvgMsEMA: +longTaskSnapshot.avgDurationEMA.toFixed(1),
			ltThresholds: longTaskSnapshot.thresholds,
			activity: {
				active: activityReport.active,
				composing: activityReport.composing,
				remainingMs: activityReport.remainingMs,
				composerCandidateCount: activityReport.composerCandidateCount,
				activeElementIsComposer: activityReport.activeElementIsComposer,
			},
			loadReadiness: readinessSnapshot,
		};
	}

	function forceTrim(): ForceTrimDebugResult | null {
		try {
			const readiness = loadReadiness.getSnapshot();
			if (!readiness.ready) {
				console.warn(
					`[chat-cleaner] forceTrim bypasses load readiness (${readiness.reason})`
				);
			}
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
			unsubscribeLongTaskGate();
			longTaskGate.dispose();
			followUpTrims.dispose();
			trimScheduler.dispose();
			activityGuard.dispose();
			loadReadiness.dispose();
			inventory.dispose();

			// 停用時完整還原 hide 模式留下的 aria-hidden / inert / class 標記
			const hiddenNodes = getHidden(SELECTORS.ALL);
			for (const el of hiddenNodes) {
				restoreMsg(el, "hide");
			}

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
