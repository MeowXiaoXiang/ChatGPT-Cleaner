import { isMarkedHidden } from "./dom-utils";
import type { LogFn } from "./types";

export interface TurnInventorySnapshot {
	visibleCount: number;
	hiddenCount: number;
	removedCount: number;
	knownTurnCount: number;
}

export interface TurnInventoryReport {
	knownTurnCount: number;
	turnHiddenCount: number;
	visibleCount: number;
	hiddenCount: number;
	removedCount: number;
	hiddenMapTrueCount: number;
	hiddenMapFalseCount: number;
	countsConsistent: boolean;
	sampleKeys: string[];
}

export interface TurnInventory {
	trackAddedTurn(el: Element): void;
	trackRemovedTurn(el: Element): void;
	trackTurnHidden(el: Element): void;
	trackTurnRestored(el: Element): void;
	trackTurnDeleted(
		el: Element,
		opts: { wasHidden: boolean; countRemoved: boolean }
	): void;
	resync(reason: string, opts?: { resetDeleteCount?: boolean }): void;
	scheduleResync(reason: string, opts?: { resetDeleteCount?: boolean }): void;
	reset(reason: string, opts?: { resetDeleteCount?: boolean }): void;
	resetRemovedCount(): void;
	getSnapshot(): TurnInventorySnapshot;
	dumpReport(): TurnInventoryReport;
	dispose(): void;
}

export function createTurnInventory(opts: {
	selectorAll: string;
	log: LogFn;
}): TurnInventory {
	const { selectorAll, log } = opts;
	const knownTurnIds = new Set<string>();
	const turnHidden = new Map<string, boolean>();
	const elementKeys = new WeakMap<Element, string>();

	let visibleCount = 0;
	let hiddenCount = 0;
	let deleteModeRemovedCount = 0;
	let tempSeq = 0;
	let resyncTimer: ReturnType<typeof setTimeout> | null = null;

	function reset(
		reason: string,
		options: { resetDeleteCount?: boolean } = {}
	) {
		knownTurnIds.clear();
		turnHidden.clear();
		visibleCount = 0;
		hiddenCount = 0;
		if (options.resetDeleteCount) deleteModeRemovedCount = 0;
		log(`inventory reset [${reason}]`);
	}

	function getTurnKey(el: Element): string {
		const existed = elementKeys.get(el);
		if (existed) return existed;

		const base =
			el.getAttribute("data-turn-id") ||
			el.getAttribute("data-testid") ||
			`ccx-temp-turn-${++tempSeq}`;

		elementKeys.set(el, base);
		return base;
	}

	function scheduleResync(
		reason: string,
		options: { resetDeleteCount?: boolean } = {}
	) {
		if (resyncTimer != null) return;
		resyncTimer = setTimeout(() => {
			resyncTimer = null;
			resync(reason, options);
		}, 0);
	}

	function ensureNonNegative(reason: string) {
		if (visibleCount >= 0 && hiddenCount >= 0) return;
		log(
			`inventory drift detected [${reason}] visible=${visibleCount} hidden=${hiddenCount}`
		);
		scheduleResync(`drift:${reason}`);
	}

	function resync(
		reason: string,
		options: { resetDeleteCount?: boolean } = {}
	) {
		reset(reason, options);
		const turns = Array.from(document.querySelectorAll<Element>(selectorAll));
		for (const el of turns) {
			const key = getTurnKey(el);
			const hidden = isMarkedHidden(el);
			knownTurnIds.add(key);
			turnHidden.set(key, hidden);
			if (hidden) hiddenCount++;
			else visibleCount++;
		}
		log(
			`inventory resync [${reason}] visible=${visibleCount} hidden=${hiddenCount} turns=${knownTurnIds.size}`
		);
	}

	function trackAddedTurn(el: Element) {
		const key = getTurnKey(el);
		if (knownTurnIds.has(key)) return;

		const hidden = isMarkedHidden(el);
		knownTurnIds.add(key);
		turnHidden.set(key, hidden);
		if (hidden) hiddenCount++;
		else visibleCount++;
		ensureNonNegative("trackAddedTurn");
	}

	function trackRemovedTurn(el: Element) {
		const key = getTurnKey(el);
		if (!knownTurnIds.has(key)) return;

		const hidden = turnHidden.get(key) ?? isMarkedHidden(el);
		knownTurnIds.delete(key);
		turnHidden.delete(key);
		if (hidden) hiddenCount--;
		else visibleCount--;
		ensureNonNegative("trackRemovedTurn");
	}

	function trackTurnHidden(el: Element) {
		const key = getTurnKey(el);
		if (!knownTurnIds.has(key)) {
			scheduleResync("hideUnknown");
			return;
		}

		if (turnHidden.get(key)) return;
		turnHidden.set(key, true);
		visibleCount--;
		hiddenCount++;
		ensureNonNegative("trackTurnHidden");
	}

	function trackTurnRestored(el: Element) {
		const key = getTurnKey(el);
		if (!knownTurnIds.has(key)) {
			scheduleResync("restoreUnknown");
			return;
		}

		if (!turnHidden.get(key)) return;
		turnHidden.set(key, false);
		hiddenCount--;
		visibleCount++;
		ensureNonNegative("trackTurnRestored");
	}

	function trackTurnDeleted(
		el: Element,
		options: { wasHidden: boolean; countRemoved: boolean }
	) {
		const key = getTurnKey(el);
		const known = knownTurnIds.has(key);
		const hidden = known ? turnHidden.get(key) ?? options.wasHidden : options.wasHidden;

		if (known) {
			knownTurnIds.delete(key);
			turnHidden.delete(key);
			if (hidden) hiddenCount--;
			else visibleCount--;
		} else {
			scheduleResync("deleteUnknown");
		}

		if (options.countRemoved) deleteModeRemovedCount++;
		ensureNonNegative("trackTurnDeleted");
	}

	function resetRemovedCount() {
		deleteModeRemovedCount = 0;
	}

	function getSnapshot(): TurnInventorySnapshot {
		return {
			visibleCount,
			hiddenCount,
			removedCount: deleteModeRemovedCount,
			knownTurnCount: knownTurnIds.size,
		};
	}

	function dumpReport(): TurnInventoryReport {
		let hiddenMapTrueCount = 0;
		let hiddenMapFalseCount = 0;
		for (const hidden of turnHidden.values()) {
			if (hidden) hiddenMapTrueCount++;
			else hiddenMapFalseCount++;
		}

		return {
			knownTurnCount: knownTurnIds.size,
			turnHiddenCount: turnHidden.size,
			visibleCount,
			hiddenCount,
			removedCount: deleteModeRemovedCount,
			hiddenMapTrueCount,
			hiddenMapFalseCount,
			countsConsistent:
				knownTurnIds.size === turnHidden.size &&
				visibleCount === hiddenMapFalseCount &&
				hiddenCount === hiddenMapTrueCount,
			sampleKeys: Array.from(knownTurnIds).slice(0, 8),
		};
	}

	function dispose() {
		if (resyncTimer != null) {
			clearTimeout(resyncTimer);
			resyncTimer = null;
		}
	}

	return {
		trackAddedTurn,
		trackRemovedTurn,
		trackTurnHidden,
		trackTurnRestored,
		trackTurnDeleted,
		resync,
		scheduleResync,
		reset,
		resetRemovedCount,
		getSnapshot,
		dumpReport,
		dispose,
	};
}
