// src/content/idle-utils.ts
// Chat Cleaner - Idle Utilities
// ------------------------------------------------------------
// 功能職責 (Responsibilities):
//   - 封裝 requestIdleCallback / cancelIdle，統一跨瀏覽器行為
//
// 主要職能 (Key Functions):
//   - requestIdle：在空閒時間執行任務，避免 UI 卡頓
//   - cancelIdle：取消已排程的 Idle 任務
//
// 設計要點 (Design Notes):
//   - Chromium 原生支援 → 直接使用
//   - 其他環境 → fallback 至 setTimeout，模擬 ~16ms 的 timeRemaining
//   - 常用於 trim-engine 的批次刪除任務
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
