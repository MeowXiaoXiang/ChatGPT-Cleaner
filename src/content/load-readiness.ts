// src/content/load-readiness.ts
// Chat Cleaner - Load Readiness Gate
// ------------------------------------------------------------
// 職責:
//   - 判斷 ChatGPT 對話是否已穩定到可安全執行 trim。
//   - 追蹤 wrapper / mounted turn / mutation quiet window。
//   - 在 ready 前暫存 trim 請求，ready 後一次性放行。
//
// 邊界:
//   - 不直接執行 trim，也不操作 UI。
//   - 不重寫 selector；只用現有 selector 與 wrapper 訊號做判斷。
// ------------------------------------------------------------

import { LOAD_READINESS, PAGE_SELECTORS } from "./constants";
import { hasMountedTurnContent } from "./dom-utils";
import type { LogFn, Selectors } from "./types";

type ReadinessState = "idle" | "waiting" | "ready";

export interface LoadReadinessSnapshot {
	ready: boolean;
	state: ReadinessState;
	reason: string;
	firstTurnAt: number;
	firstWrapperAt: number;
	lastRelevantMutationAt: number;
	stableSampleCount: number;
	wrapperCount: number;
	intersectingWrapperCount: number;
	placeholderWrapperCount: number;
	mountedTurnCount: number;
	virtualizationDetected: boolean;
	latestTurnMounted: boolean;
	pendingCount: number;
	timeout: boolean;
	timeoutReason: string;
}

export interface LoadReadinessGate {
	observeMutationBatch(muts: MutationRecord[]): void;
	requestCheck(reason: string): void;
	whenReady(
		callback: () => void,
		reason: string,
		opts?: { key?: string }
	): boolean;
	getSnapshot(): LoadReadinessSnapshot;
	reset(reason: string): void;
	dispose(): void;
}

interface StableSnapshot {
	threadExists: boolean;
	composerExists: boolean;
	wrapperCount: number;
	intersectingWrapperCount: number;
	placeholderWrapperCount: number;
	mountedTurnCount: number;
	virtualizationDetected: boolean;
	latestTurnMounted: boolean;
}

function now() {
	return Date.now();
}

function getConversationSnapshot(selectors: Selectors): StableSnapshot {
	const wrappers = Array.from(
		document.querySelectorAll<Element>(PAGE_SELECTORS.TURN_WRAPPER)
	);
	const turns = Array.from(document.querySelectorAll<Element>(selectors.ALL));
	const mountedTurnCount = turns.reduce(
		(count, turn) => count + (hasMountedTurnContent(turn) ? 1 : 0),
		0
	);
	const virtualizationDetected = wrappers.length > 0;
	let intersectingWrapperCount = 0;
	let placeholderWrapperCount = 0;

	for (const wrapper of wrappers) {
		if (wrapper.getAttribute("data-is-intersecting") === "true") {
			intersectingWrapperCount++;
		}
		if (!hasMountedTurnContent(wrapper.querySelector(selectors.ALL))) {
			placeholderWrapperCount++;
		}
	}

	const latestTurn = wrappers.length
		? wrappers[wrappers.length - 1]?.querySelector(selectors.ALL) ?? null
		: turns[turns.length - 1] ?? null;
	const latestTurnMounted = hasMountedTurnContent(latestTurn);

	return {
		threadExists: !!document.querySelector(PAGE_SELECTORS.THREAD),
		composerExists: !!document.querySelector(PAGE_SELECTORS.COMPOSER),
		wrapperCount: wrappers.length,
		intersectingWrapperCount,
		placeholderWrapperCount,
		mountedTurnCount,
		virtualizationDetected,
		latestTurnMounted,
	};
}

function mutationTouchesConversation(node: Node | null, selectors: Selectors): boolean {
	const el = node as Element | null;
	if (!el || el.nodeType !== 1) return false;

	return !!(
		el.matches?.(PAGE_SELECTORS.TURN_WRAPPER) ||
		el.matches?.(selectors.ALL) ||
		el.closest?.(PAGE_SELECTORS.TURN_WRAPPER) ||
		el.closest?.(selectors.ALL) ||
		el.querySelector?.(PAGE_SELECTORS.TURN_WRAPPER) ||
		el.querySelector?.(selectors.ALL)
	);
}

function createEmptySnapshot(
	state: ReadinessState,
	reason: string
): LoadReadinessSnapshot {
	return {
		ready: false,
		state,
		reason,
		firstTurnAt: 0,
		firstWrapperAt: 0,
		lastRelevantMutationAt: 0,
		stableSampleCount: 0,
		wrapperCount: 0,
		intersectingWrapperCount: 0,
		placeholderWrapperCount: 0,
		mountedTurnCount: 0,
		virtualizationDetected: false,
		latestTurnMounted: false,
		pendingCount: 0,
		timeout: false,
		timeoutReason: "",
	};
}

function getStableKey(snapshot: StableSnapshot): string {
	if (!snapshot.virtualizationDetected) {
		return String(snapshot.mountedTurnCount);
	}
	return [
		snapshot.wrapperCount,
		snapshot.mountedTurnCount,
		snapshot.placeholderWrapperCount,
		snapshot.latestTurnMounted ? 1 : 0,
	].join(":");
}

function getWaitReason(
	snapshot: StableSnapshot,
	quietMs: number,
	stableSampleCount: number
): string {
	if (!snapshot.threadExists) return "threadMissing";
	if (!snapshot.composerExists) return "composerMissing";
	if (quietMs < LOAD_READINESS.QUIET_MS) return "mutationsActive";
	if (!snapshot.latestTurnMounted) return "latestTurnNotMounted";
	if (stableSampleCount < LOAD_READINESS.STABLE_SAMPLES) return "sampling";
	return "waiting";
}

export function createLoadReadinessGate(opts: {
	selectors: Selectors;
	log: LogFn;
}): LoadReadinessGate {
	const { selectors, log } = opts;

	let state: ReadinessState = "idle";
	let reason = "idle";
	let firstTurnAt = 0;
	let firstWrapperAt = 0;
	let lastRelevantMutationAt = 0;
	let stableSampleCount = 0;
	let timeout = false;
	let timeoutReason = "";
	let waitStartedAt = 0;
	let sampleTimer: ReturnType<typeof setInterval> | null = null;
	let lastStableKey = "";
	let lastSnapshot = createEmptySnapshot("idle", "idle");

	const pending = new Map<string, () => void>();

	function updateSnapshot(
		snapshot: StableSnapshot,
		ready: boolean,
		currentReason: string
	) {
		lastSnapshot = {
			ready,
			state,
			reason: currentReason,
			firstTurnAt,
			firstWrapperAt,
			lastRelevantMutationAt,
			stableSampleCount,
			wrapperCount: snapshot.wrapperCount,
			intersectingWrapperCount: snapshot.intersectingWrapperCount,
			placeholderWrapperCount: snapshot.placeholderWrapperCount,
			mountedTurnCount: snapshot.mountedTurnCount,
			virtualizationDetected: snapshot.virtualizationDetected,
			latestTurnMounted: snapshot.latestTurnMounted,
			pendingCount: pending.size,
			timeout,
			timeoutReason,
		};
	}

	function stopSampling() {
		if (sampleTimer != null) {
			clearInterval(sampleTimer);
			sampleTimer = null;
		}
	}

	function flushPending() {
		const callbacks = Array.from(pending.values());
		pending.clear();
		for (const callback of callbacks) {
			try {
				callback();
			} catch (error) {
				log("load-readiness callback failed", error);
			}
		}
	}

	function collectAndEvaluate() {
		const sampledAt = now();
		const snapshot = getConversationSnapshot(selectors);

		if (snapshot.mountedTurnCount > 0 && firstTurnAt === 0) firstTurnAt = sampledAt;
		if (snapshot.wrapperCount > 0 && firstWrapperAt === 0) firstWrapperAt = sampledAt;
		if (lastRelevantMutationAt === 0) lastRelevantMutationAt = sampledAt;
		if (waitStartedAt === 0) waitStartedAt = sampledAt;

		const stableKey = getStableKey(snapshot);

		stableSampleCount =
			stableKey === lastStableKey ? stableSampleCount + 1 : 1;
		lastStableKey = stableKey;

		const quietMs = sampledAt - lastRelevantMutationAt;
		const ready =
			snapshot.threadExists &&
			snapshot.composerExists &&
			snapshot.latestTurnMounted &&
			quietMs >= LOAD_READINESS.QUIET_MS &&
			stableSampleCount >= LOAD_READINESS.STABLE_SAMPLES;

		if (!timeout && sampledAt - waitStartedAt >= LOAD_READINESS.TIMEOUT_MS) {
			timeout = true;
			timeoutReason = `wait>${LOAD_READINESS.TIMEOUT_MS}ms`;
			log(`load-readiness timeout (${reason}); continuing to wait`);
		}

		if (ready) {
			state = "ready";
			reason = "ready";
			timeout = false;
			timeoutReason = "";
			updateSnapshot(snapshot, true, reason);
			stopSampling();
			log(
				`load-ready wrappers=${snapshot.wrapperCount} mounted=${snapshot.mountedTurnCount} stable=${stableSampleCount}`
			);
			flushPending();
			return;
		}

		state = "waiting";
		reason = getWaitReason(snapshot, quietMs, stableSampleCount);
		updateSnapshot(snapshot, false, reason);
	}

	function ensureSampling(triggerReason: string) {
		if (state === "ready") return;
		if (state === "idle") {
			state = "waiting";
			reason = triggerReason;
		}
		if (sampleTimer != null) return;
		sampleTimer = setInterval(collectAndEvaluate, LOAD_READINESS.SAMPLE_MS);
		collectAndEvaluate();
	}

	function observeMutationBatch(muts: MutationRecord[]) {
		let relevant = false;

		for (const m of muts) {
			if (mutationTouchesConversation(m.target, selectors)) {
				relevant = true;
				break;
			}
			for (let i = 0; i < m.addedNodes.length && !relevant; i++) {
				if (mutationTouchesConversation(m.addedNodes[i], selectors)) relevant = true;
			}
			for (let i = 0; i < m.removedNodes.length && !relevant; i++) {
				if (mutationTouchesConversation(m.removedNodes[i], selectors)) relevant = true;
			}
			if (relevant) break;
		}

		if (!relevant) return;
		lastRelevantMutationAt = now();
		if (state !== "ready") ensureSampling("mutation");
	}

	function requestCheck(nextReason: string) {
		if (state === "ready") return;
		reason = nextReason;
		ensureSampling(nextReason);
	}

	function whenReady(
		callback: () => void,
		nextReason: string,
		options: { key?: string } = {}
	): boolean {
		if (state === "ready") {
			callback();
			return true;
		}

		pending.set(options.key || nextReason, callback);
		requestCheck(nextReason);
		return false;
	}

	function reset(nextReason: string) {
		stopSampling();
		state = "idle";
		reason = nextReason;
		firstTurnAt = 0;
		firstWrapperAt = 0;
		lastRelevantMutationAt = 0;
		stableSampleCount = 0;
		timeout = false;
		timeoutReason = "";
		waitStartedAt = 0;
		lastStableKey = "";
		pending.clear();
		lastSnapshot = createEmptySnapshot(state, reason);
	}

	function dispose() {
		stopSampling();
		pending.clear();
	}

	return {
		observeMutationBatch,
		requestCheck,
		whenReady,
		getSnapshot: () => {
			const live = getConversationSnapshot(selectors);
			return {
				...lastSnapshot,
				lastRelevantMutationAt,
				wrapperCount: live.wrapperCount,
				intersectingWrapperCount: live.intersectingWrapperCount,
				placeholderWrapperCount: live.placeholderWrapperCount,
				mountedTurnCount: live.mountedTurnCount,
				virtualizationDetected: live.virtualizationDetected,
				latestTurnMounted: live.latestTurnMounted,
				pendingCount: pending.size,
			};
		},
		reset,
		dispose,
	};
}
