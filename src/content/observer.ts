// src/content/observer.ts
// Chat Cleaner - DOM Observer
// ------------------------------------------------------------
// 職責:
//   - 尋找 ChatGPT route-scoped thread 並附掛 MutationObserver。
//   - 偵測 SPA route 變化並重新綁定容器。
//   - 過濾 extension UI 造成的 mutation，避免誤觸發上游排程。
//
// 邊界:
//   - 一律使用 childList + subtree 監看，避免 wrapper 導致漏事件
//   - 使用 rAF 合批，避免高頻 mutation 時過度觸發上游邏輯
//   - 不直接執行 trim，只回報 mutation 與 route lifecycle
// ------------------------------------------------------------

import type {
	CreateObserverDeps,
	ObserverHandles,
	TurnMutationBatch,
} from "./types";
import { OBSERVER, PAGE_SELECTORS, UI_SELECTORS } from "./constants";

// 需忽略的內部 UI 節點（從 constants.ts 導入）
const INTERNAL_UI_IGNORE_SELECTOR = UI_SELECTORS.INTERNAL.join(",");

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
	deps: CreateObserverDeps
): ObserverHandles {
	const {
		selectors,
		log,
		onMutation,
		onTurnMutations,
		onInit,
		onRouteChange,
	} = deps;

	let observer: MutationObserver | null = null; // 主觀測器
	let pendingNavWaiter: MutationObserver | null = null; // 一次性等待容器
	let routeWatcher: MutationObserver | null = null; // DOM URL 監聽

	let currentTarget: Element | null = null;
	let routeWatchersInstalled = false;
	let lastURL = location.href;
	let pendingRouteContainer: Element | null = null;
	let pendingRouteTurnIds: Set<string> | null = null;

	// Rebind 節流
	let rebindTimer: number | null = null;
	function scheduleRebind() {
		if (rebindTimer != null) return;
		rebindTimer = window.setTimeout(() => {
			rebindTimer = null;
			start();
		}, OBSERVER.REBIND_DELAY_MS);
	}

	function findMessageContainer(turn: Element): Element | null {
		return turn.closest(PAGE_SELECTORS.THREAD);
	}

	function getTurnIdentity(turn: Element): string {
		return (
			turn.getAttribute("data-turn-id") ||
			turn.getAttribute("data-testid") ||
			""
		);
	}

	function captureTurnIds(container: Element | null): Set<string> {
		const ids = new Set<string>();
		container?.querySelectorAll<Element>(selectors.ALL).forEach((turn) => {
			const id = getTurnIdentity(turn);
			if (id) ids.add(id);
		});
		return ids;
	}

	// rAF 合批 (同一畫格收斂 mutation)
	let rafHandle: number | null = null;
	const pendingBatch: MutationRecord[] = [];

	function collectTurnElements(nodes: Iterable<Node>): Element[] {
		const out: Element[] = [];
		const seen = new Set<Element>();

		const push = (el: Element | null | undefined) => {
			if (!el || seen.has(el) || isInternalUI(el)) return;
			seen.add(el);
			out.push(el);
		};

		for (const node of nodes) {
			const el = node as Element | null;
			if (!el || el.nodeType !== 1) continue;
			if (isInternalUI(el)) continue;

			if (el.matches?.(selectors.ALL)) push(el);
			el.querySelectorAll?.(selectors.ALL).forEach((turn) => push(turn));
		}

		return out;
	}

	function buildTurnMutationBatch(muts: MutationRecord[]): TurnMutationBatch {
		const addedNodes: Node[] = [];
		const removedNodes: Node[] = [];

		for (const m of muts) {
			addedNodes.push(...Array.from(m.addedNodes));
			removedNodes.push(...Array.from(m.removedNodes));
		}

		return {
			added: collectTurnElements(addedNodes),
			removed: collectTurnElements(removedNodes),
		};
	}

	function flushBatch(batch: MutationRecord[]) {
		if (!batch.length) return;
		const turnBatch = buildTurnMutationBatch(batch);
		if (turnBatch.added.length || turnBatch.removed.length) {
			onTurnMutations?.(turnBatch);
		}
		onMutation(batch);
	}

	function enqueueAndMaybeFlush(batch: MutationRecord[]) {
		if (!batch.length) return;
		pendingBatch.push(...batch);
		if (rafHandle != null) return;
		rafHandle = requestAnimationFrame(() => {
			const flushed = pendingBatch.splice(0, pendingBatch.length);
			rafHandle = null;
			flushBatch(flushed);
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
					flushBatch(pendingBatch.splice(0));
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
		onReady: (container: Element) => void,
		opts: {
			skipContainer?: Element | null;
			skipTurnIds?: ReadonlySet<string> | null;
		} = {}
	) {
		const isFreshTurn = (turn: Element) => {
			const container = findMessageContainer(turn);
			if (!container) return false;
			if (container !== opts.skipContainer) return true;
			const id = getTurnIdentity(turn);
			return !!id && !opts.skipTurnIds?.has(id);
		};
		const findFreshTurn = (root: Element): Element | null => {
			if (root.matches?.(selectors.ALL) && isFreshTurn(root)) return root;
			return (
				Array.from(root.querySelectorAll<Element>(selectors.ALL)).find(
					isFreshTurn
				) ?? null
			);
		};

		const firstTurn = Array.from(
			document.querySelectorAll<Element>(selectors.ALL)
		).find(isFreshTurn);
		const firstContainer = firstTurn ? findMessageContainer(firstTurn) : null;
		if (firstContainer) {
			pendingRouteContainer = null;
			pendingRouteTurnIds = null;
			onReady(firstContainer);
			onInit();
			return;
		}

		pendingNavWaiter?.disconnect();

		const currentThread = document.querySelector(PAGE_SELECTORS.THREAD);
		const fallback = ((currentThread !== opts.skipContainer && currentThread) ||
			document.querySelector("main") ||
			document.body) as Element;
		pendingNavWaiter = new MutationObserver((muts) => {
			for (const m of muts) {
				for (let i = 0; i < m.addedNodes.length; i++) {
					const n = m.addedNodes[i] as Element;
					if (!n || n.nodeType !== 1) continue;
					if (isInternalUI(n)) continue;

					const turn = findFreshTurn(n);
					if (!turn) continue;

					const container = findMessageContainer(turn as Element);
					if (!container) continue;

					pendingNavWaiter?.disconnect();
					pendingNavWaiter = null;

					pendingRouteContainer = null;
					pendingRouteTurnIds = null;
					onReady(container);
					onInit();
					return;
				}
			}
		});
		pendingNavWaiter.observe(fallback, { childList: true, subtree: true });
	}

	// 啟動：尋找容器並附掛 observer
	function start() {
		const skipContainer = pendingRouteContainer;
		const skipTurnIds = pendingRouteTurnIds;
		stopCore();
		waitForMessageContainerOnce((container) => attach(container), {
			skipContainer,
			skipTurnIds,
		});
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
			flushBatch(pendingBatch.splice(0));
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

		if (rebindTimer != null) {
			clearTimeout(rebindTimer);
			rebindTimer = null;
		}
		currentTarget = null;
		pendingRouteContainer = null;
		pendingRouteTurnIds = null;
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
				pendingRouteContainer = currentTarget;
				pendingRouteTurnIds = captureTurnIds(currentTarget);
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
			pendingRouteContainer = currentTarget;
			pendingRouteTurnIds = captureTurnIds(currentTarget);
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
