// src/content/activity-guard.ts
// Chat Cleaner - Activity Guard
// ------------------------------------------------------------
// 職責:
//   - 偵測使用者在 composer/input 內的近期活動。
//   - 讓自動 trim 延後到互動冷卻後，避免打斷輸入。
//
// 邊界:
//   - 只影響自動 trim；manual Apply 與 debug forceTrim 由 main.ts 繞過。
// ------------------------------------------------------------

import type { LogFn } from "./types";
import { ACTIVITY_GUARD, PAGE_SELECTORS, UI_SELECTORS } from "./constants";

const INTERNAL_UI_SELECTOR = UI_SELECTORS.INTERNAL.join(",");

export interface ActivityGuardSnapshot {
	active: boolean;
	composing: boolean;
	activeUntil: number;
	remainingMs: number;
}

export interface ActivityGuard {
	isActive(): boolean;
	deferUntilIdle(callback: () => void, reason: string): void;
	getSnapshot(): ActivityGuardSnapshot;
	dispose(): void;
}

export function createActivityGuard(opts: {
	log: LogFn;
	cooldownMs?: number;
}): ActivityGuard {
	const { log, cooldownMs = ACTIVITY_GUARD.COOLDOWN_MS } = opts;
	let activeUntil = 0;
	let composing = false;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;

	function isInternalTarget(target: EventTarget | null): boolean {
		const el = target as Element | null;
		return !!(el?.nodeType === 1 && el.closest?.(INTERNAL_UI_SELECTOR));
	}

	function isComposerTarget(target: EventTarget | null): boolean {
		const el = target as Element | null;
		return !!(
			el?.nodeType === 1 &&
			!isInternalTarget(el) &&
			(el.matches?.(PAGE_SELECTORS.COMPOSER) ||
				el.closest?.(PAGE_SELECTORS.COMPOSER))
		);
	}

	function markActive() {
		activeUntil = Date.now() + cooldownMs;
	}

	function onInputLike(event: Event) {
		if (!isComposerTarget(event.target)) return;
		markActive();
	}

	function onCompositionStart(event: Event) {
		if (!isComposerTarget(event.target)) return;
		composing = true;
		markActive();
	}

	function onCompositionEnd(event: Event) {
		if (!isComposerTarget(event.target)) return;
		composing = false;
		markActive();
	}

	function isActive(): boolean {
		return composing || Date.now() < activeUntil;
	}

	function deferUntilIdle(callback: () => void, reason: string) {
		if (retryTimer != null) clearTimeout(retryTimer);
		const remaining = Math.max(0, activeUntil - Date.now());
		const delay = composing
			? cooldownMs
			: remaining + ACTIVITY_GUARD.RETRY_PADDING_MS;
		log(`delay auto trim [${reason}] (activityGuard ${delay}ms)`);
		retryTimer = setTimeout(() => {
			retryTimer = null;
			callback();
		}, delay);
	}

	function getSnapshot(): ActivityGuardSnapshot {
		const remainingMs = Math.max(0, activeUntil - Date.now());
		return {
			active: isActive(),
			composing,
			activeUntil,
			remainingMs,
		};
	}

	function dispose() {
		if (retryTimer != null) {
			clearTimeout(retryTimer);
			retryTimer = null;
		}
		document.removeEventListener("beforeinput", onInputLike, true);
		document.removeEventListener("input", onInputLike, true);
		document.removeEventListener("keydown", onInputLike, true);
		document.removeEventListener("paste", onInputLike, true);
		document.removeEventListener("focusin", onInputLike, true);
		document.removeEventListener("compositionstart", onCompositionStart, true);
		document.removeEventListener("compositionend", onCompositionEnd, true);
	}

	document.addEventListener("beforeinput", onInputLike, true);
	document.addEventListener("input", onInputLike, true);
	document.addEventListener("keydown", onInputLike, true);
	document.addEventListener("paste", onInputLike, true);
	document.addEventListener("focusin", onInputLike, true);
	document.addEventListener("compositionstart", onCompositionStart, true);
	document.addEventListener("compositionend", onCompositionEnd, true);

	return {
		isActive,
		deferUntilIdle,
		getSnapshot,
		dispose,
	};
}
