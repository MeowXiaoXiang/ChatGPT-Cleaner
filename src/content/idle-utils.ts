// src/content/idle-utils.ts
// Chat Cleaner - Idle Utilities
// ------------------------------------------------------------
// 職責:
//   - 封裝 requestIdleCallback / cancelIdle。
//   - 在缺少原生 API 的環境提供 setTimeout fallback。
//
// 邊界:
//   - 不決定何時 trim，只提供 idle 排程原語。
// ------------------------------------------------------------

export type IdleHandle = number | ReturnType<typeof setTimeout>;

/* ----------------------------- */
/* Idle 調度 API                 */
/* ----------------------------- */

// 在瀏覽器「空閒時」執行任務
export function requestIdle(
	fn: IdleRequestCallback,
	opts?: { timeout?: number }
): IdleHandle {
	const anyWin = window as any;
	if (typeof anyWin.requestIdleCallback === "function") {
		return anyWin.requestIdleCallback(fn, opts);
	}
	// fallback：模擬 IdleDeadline，預設 timeRemaining ~16ms
	return window.setTimeout(() => {
		fn({
			didTimeout: false,
			timeRemaining: () => 16,
		} as IdleDeadline);
	}, opts?.timeout ?? 0);
}

// 取消 Idle 任務
export function cancelIdle(id: IdleHandle | null | undefined) {
	if (id == null) return;
	const anyWin = window as any;
	if (typeof anyWin.cancelIdleCallback === "function") {
		anyWin.cancelIdleCallback(id);
	} else {
		window.clearTimeout(id as number);
	}
}
