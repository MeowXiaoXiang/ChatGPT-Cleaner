// src/content/observer.ts
// Chat Cleaner - DOM Observer
// ------------------------------------------------------------
// 功能職責 (Responsibilities):
//   - 自動尋找訊息容器並附掛 MutationObserver
//   - 偵測路由變化（history/hash/DOM URL 變動）並自動重綁
//   - 過濾本插件內部 UI 的變動，避免誤觸發上游排程
//   - 使用 requestAnimationFrame 合批，將同一畫格的多筆 mutation 一次回傳
//
// 設計要點 (Design Notes):
//   - 一律使用 childList + subtree 監看，避免 wrapper 導致漏事件
//   - 若訊息容器在同一 URL 下被替換，會自我偵測並重新綁定
//   - MutationRecord 過濾內部 UI 變動，降低上游負擔
//   - 路由 rebind 採 80ms 輕節流，避免連續觸發
//   - rAF 合批，避免高頻 mutation 時過度觸發上游邏輯
// ------------------------------------------------------------

import type { CreateObserverDeps, ObserverHandles } from "./types";

// 需忽略的內部 UI 節點（避免自觸發）
const INTERNAL_UI_IGNORE_SELECTOR = [
	".ccx-ui",
	".ccx-toast-container",
	".ccx-showmore-wrap",
	"#ccx-debug",
	"#ccx-debug *",
].join(",");

// 判斷節點是否屬於本插件 UI
function isInternalUI(node: Node | null | undefined): boolean {
	const el = node as Element | null;
	return !!(
		el &&
		el.nodeType === 1 &&
		el.closest?.(INTERNAL_UI_IGNORE_SELECTOR)
	);
}

// 判斷 MutationRecord 是否完全屬於內部 UI
function recordIsInternalOnly(m: MutationRecord): boolean {
	if (!isInternalUI(m.target)) return false;
	for (let i = 0; i < m.addedNodes.length; i++) {
		if (!isInternalUI(m.addedNodes[i])) return false;
	}
	for (let i = 0; i < m.removedNodes.length; i++) {
		if (!isInternalUI(m.removedNodes[i])) return false;
	}
	return true;
}

export function createObserverHandles(
	deps: CreateObserverDeps & { onRouteChange?: () => void }
): ObserverHandles {
	const { selectors, log, onMutation, onInit, onRouteChange } = deps;

	let observer: MutationObserver | null = null; // 主觀測器
	let pendingNavWaiter: MutationObserver | null = null; // 一次性等待容器
	let routeWatcher: MutationObserver | null = null; // DOM URL 監聽

	let currentTarget: Element | null = null;
	let routeWatchersInstalled = false;
	let lastURL = location.href;

	// Rebind 節流 (80ms)
	let rebindTimer: ReturnType<typeof setTimeout> | null = null;
	function scheduleRebind() {
		if (rebindTimer) return;
		rebindTimer = window.setTimeout(() => {
			rebindTimer = null;
			start();
		}, 80);
	}

	// rAF 合批 (同一畫格收斂 mutation)
	let rafHandle: number | null = null;
	const pendingBatch: MutationRecord[] = [];
	function enqueueAndMaybeFlush(batch: MutationRecord[]) {
		if (!batch.length) return;
		pendingBatch.push(...batch);
		if (rafHandle != null) return;
		rafHandle = requestAnimationFrame(() => {
			const flushed = pendingBatch.splice(0, pendingBatch.length);
			rafHandle = null;
			if (flushed.length) onMutation(flushed);
		});
	}

	// 附掛主 observer 到訊息容器
	function attach(container: Element) {
		// 若已附掛在同一容器則跳過
		if (currentTarget === container && observer) {
			log("observer already attached:", short(container), "skip");
			return;
		}
		currentTarget = container;

		observer?.disconnect();

		observer = new MutationObserver((muts) => {
			// 若容器失聯（SPA 替換），重啟等待流程
			if (currentTarget && !currentTarget.isConnected) {
				observer!.disconnect();
				currentTarget = null;
				// 清除合批
				if (rafHandle != null) {
					cancelAnimationFrame(rafHandle);
					rafHandle = null;
				}
				// 在清空前 flush 一次，避免丟掉最後的 mutation
				if (pendingBatch.length) {
					onMutation(pendingBatch.splice(0));
				}

				waitForMessageContainerOnce((c) => attach(c));
				return;
			}

			// 過濾內部 UI 變動
			const filtered = muts.filter((m) => !recordIsInternalOnly(m));
			if (!filtered.length) return;

			// 合批回拋
			enqueueAndMaybeFlush(filtered);
		});

		observer.observe(container, { childList: true, subtree: true });
		log("observer attached:", short(container), "subtree=true");
	}

	// 等待訊息容器出現（一次性）
	function waitForMessageContainerOnce(
		onReady: (container: Element) => void
	) {
		const firstTurn = document.querySelector(
			selectors.ALL
		) as Element | null;
		if (firstTurn?.parentElement) {
			onReady(firstTurn.parentElement);
			onInit();
			return;
		}

		pendingNavWaiter?.disconnect();

		const fallback = (document.querySelector("main") ||
			document.body) as Element;
		pendingNavWaiter = new MutationObserver((muts) => {
			for (const m of muts) {
				for (let i = 0; i < m.addedNodes.length; i++) {
					const n = m.addedNodes[i] as Element;
					if (!n || n.nodeType !== 1) continue;
					if (isInternalUI(n)) continue;

					const turn = n.matches?.(selectors.ALL)
						? n
						: n.querySelector?.(selectors.ALL);
					if (!turn) continue;

					const parent = (turn as Element).parentElement;
					if (!parent) continue;

					pendingNavWaiter?.disconnect();
					pendingNavWaiter = null;

					onReady(parent);
					onInit();
					return;
				}
			}
		});
		pendingNavWaiter.observe(fallback, { childList: true, subtree: true });
	}

	// 啟動：尋找容器並附掛 observer
	function start() {
		stopCore();
		waitForMessageContainerOnce((container) => attach(container));
	}

	// 停止主 observer 與一次性 waiter（不包含路由監聽）
	function stopCore() {
		observer?.disconnect();
		observer = null;

		pendingNavWaiter?.disconnect();
		pendingNavWaiter = null;

		if (rafHandle != null) {
			cancelAnimationFrame(rafHandle);
			rafHandle = null;
		}

		// flush 掉最後一批 mutation，避免直接丟掉
		if (pendingBatch.length) {
			onMutation(pendingBatch.splice(0));
		}
	}

	// 完整停止（包含路由監聽與 rebind 節流）
	function stop() {
		stopCore();
		if (routeWatcher) {
			routeWatcher.disconnect();
			routeWatcher = null;
		}
		window.removeEventListener("popstate", onMaybeRouteChange);
		window.removeEventListener("hashchange", onMaybeRouteChange);
		routeWatchersInstalled = false;

		if (rebindTimer) {
			clearTimeout(rebindTimer);
			rebindTimer = null;
		}
		currentTarget = null;
		lastURL = location.href;
	}

	// 啟用路由監聽（popstate/hashchange + DOM URL 變更）
	function setupRouteWatchers() {
		if (routeWatchersInstalled) return;
		routeWatchersInstalled = true;

		window.addEventListener("popstate", onMaybeRouteChange, {
			passive: true,
		});
		window.addEventListener("hashchange", onMaybeRouteChange, {
			passive: true,
		});

		if (routeWatcher) routeWatcher.disconnect();
		routeWatcher = new MutationObserver(() => {
			if (location.href !== lastURL) {
				lastURL = location.href;
				log("URL mutated → rebind when container appears");
				scheduleRebind();
				onRouteChange?.();
			}
		});
		routeWatcher.observe(document, { childList: true, subtree: true });
	}

	// 當 URL 改變時（history/hash）觸發 rebind
	function onMaybeRouteChange() {
		if (location.href !== lastURL) {
			lastURL = location.href;
			log("URL changed → rebind");
			scheduleRebind();
			onRouteChange?.();
		}
	}

	return { attach, start, stop, setupRouteWatchers };
}

/* ----------------------------- */
/* 工具函式：短字串輸出 (debug)   */
/* ----------------------------- */
function short(el?: Element | null): string {
	if (!el) return "(null)";
	const tag = (el.tagName || "").toLowerCase();

	// 安全存取 HTMLElement 屬性
	const html = el as HTMLElement;

	const id = html.id ? `#${html.id}` : "";

	// className 可能是 SVGAnimatedString；保守轉字串後切分
	const rawClass = (html.className as any) ?? "";
	const classStr =
		typeof rawClass === "string" ? rawClass : rawClass.baseVal ?? "";
	const cls = classStr
		? "." + classStr.split(/\s+/).filter(Boolean).slice(0, 2).join(".")
		: "";

	const kids = html.childElementCount ? `[${html.childElementCount}]` : "";

	const s = `${tag}${id}${cls}${kids}`;
	return s.length > 60 ? s.slice(0, 60) + "…" : s;
}
