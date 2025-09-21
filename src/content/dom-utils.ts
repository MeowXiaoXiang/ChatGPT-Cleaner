// src/content/dom-utils.ts
// Chat Cleaner - DOM Utilities
// ------------------------------------------------------------
// 功能職責 (Responsibilities):
//   - 提供零依賴的 DOM 輔助 API
//   - 統一處理標記、查詢與樣式注入
//
// 主要職能 (Key Functions):
//   - $ / $$：簡化 querySelector / querySelectorAll
//   - CLS：統一樣式 class 常數
//   - shortSelector：輸出簡短元素定位字串（除錯用）
//   - injectRuntimeStyle：注入運行時樣式（隱藏 / inert / cv）
//   - markHidden / unmarkHidden：隱藏或還原節點
//   - markInert / unmarkInert：封鎖或還原互動
//   - getVisibleBySelector / getHiddenBySelector：查詢可見 / 已隱藏節點
//
// 設計要點 (Design Notes):
//   - 標記狀態皆記錄於 dataset，可安全還原
//   - 隱藏狀態同時加 aria-hidden / inert，確保可及性與效能
//   - 僅操作屬性與 class，不涉及業務邏輯
// ------------------------------------------------------------

/* ----------------------------- */
/* Class 常數 (CLS)              */
/* ----------------------------- */
export const CLS = {
	HIDDEN: "ccx-hidden",     // 完全隱藏（不佔版面）
	INERT: "ccx-inert",       // 去互動（仍佔版面）
	CV: "ccx-cv",             // content-visibility 降載
	UI_ROOT: "ccx-ui",        // 插件根節點
	TOAST_CONTAINER: "ccx-toast-container",
	TOAST: "ccx-toast",
	SHOW_MORE_WRAP: "ccx-showmore-wrap", // Show More wrapper
} as const;

/* ----------------------------- */
/* 簡化選擇器 API                 */
/* ----------------------------- */
export const $ = <T extends Element = Element>(
	sel: string,
	root: ParentNode | Document = document
) => root.querySelector<T>(sel);

export const $$ = <T extends Element = Element>(
	sel: string,
	root: ParentNode | Document = document
) => Array.from(root.querySelectorAll<T>(sel));

/* ----------------------------- */
/* 除錯輔助                       */
/* ----------------------------- */
// 產生簡短元素定位字串：tag[#id][.c1.c2][childCount]
export function shortSelector(el: Element | null | undefined): string {
	if (!el) return "(null)";
	const tag = (el.tagName || "").toLowerCase();
	let s = tag || "node";

	const html = el as HTMLElement;
	if (html.id) {
		s += "#" + html.id;
	} else {
		const cn = el.getAttribute?.("class");
		if (typeof cn === "string" && cn.length) {
			const cls = cn.split(/\s+/).filter(Boolean).slice(0, 2).join(".");
			if (cls) s += "." + cls;
		}
	}
	if (html.childElementCount) s += `[${html.childElementCount}]`;
	return s.length > 60 ? s.slice(0, 60) + "…" : s;
}

/* ----------------------------- */
/* Runtime 樣式注入               */
/* ----------------------------- */
// 確保隱藏 / inert / cv 的樣式存在
export function injectRuntimeStyle(): HTMLStyleElement {
	const ID = "ccx-runtime-style";
	const existed = document.getElementById(ID) as HTMLStyleElement | null;
	if (existed) return existed;

	const styleTag = document.createElement("style");
	styleTag.id = ID;
	styleTag.textContent = `
    .${CLS.HIDDEN} { display: none !important; }
    .${CLS.INERT}  { pointer-events: none !important; user-select: none !important; }
    .${CLS.CV}     { content-visibility: auto; contain-intrinsic-size: 1200px 600px; }`;
	(document.head || document.documentElement).appendChild(styleTag);
	return styleTag;
}

/* ----------------------------- */
/* Hidden 標記 API                */
/* ----------------------------- */
// 判斷元素是否已被標記為隱藏
export function isMarkedHidden(el: Element): boolean {
	return (el as HTMLElement).dataset.ccxHidden === "1";
}

// 標記元素為隱藏（不可見、不可互動）
export function markHidden(el: Element): void {
	const html = el as HTMLElement;
	if (html.dataset.ccxHidden === "1") return;

	const hadAriaHidden = html.getAttribute("aria-hidden") != null;
	const hadInert = html.hasAttribute("inert");

	if (hadAriaHidden) html.dataset.ccxWasAriaHidden = "1";
	if (hadInert) html.dataset.ccxWasInert = "1";

	html.dataset.ccxHidden = "1";
	html.setAttribute("aria-hidden", "true");
	html.setAttribute("inert", "");
	html.classList.add(CLS.HIDDEN, CLS.INERT);
}

// 還原隱藏狀態（恢復可見與互動）
export function unmarkHidden(el: Element): void {
	const html = el as HTMLElement;
	if (html.dataset.ccxHidden !== "1") return;

	delete html.dataset.ccxHidden;

	if (!html.dataset.ccxWasAriaHidden) html.removeAttribute("aria-hidden");
	if (!html.dataset.ccxWasInert) html.removeAttribute("inert");

	delete html.dataset.ccxWasAriaHidden;
	delete html.dataset.ccxWasInert;

	html.classList.remove(CLS.HIDDEN, CLS.INERT);
}

/* ----------------------------- */
/* Inert 標記 API                 */
/* ----------------------------- */
// 標記元素為「去互動」（仍可見，但不可互動）
export function markInert(el: Element): void {
	const html = el as HTMLElement;
	if (html.dataset.ccxInert === "1") return;

	if (html.hasAttribute("inert")) html.dataset.ccxWasInert = "1";

	html.dataset.ccxInert = "1";
	html.setAttribute("inert", "");
	html.classList.add(CLS.INERT);
}

// 還原去互動狀態
export function unmarkInert(el: Element): void {
	const html = el as HTMLElement;
	if (html.dataset.ccxInert !== "1") return;

	delete html.dataset.ccxInert;
	if (!html.dataset.ccxWasInert) html.removeAttribute("inert");
	delete html.dataset.ccxWasInert;

	html.classList.remove(CLS.INERT);
}

/* ----------------------------- */
/* 查詢 API                       */
/* ----------------------------- */
// 回傳目前所有「可見」元素
export function getVisibleBySelector(allSelector: string): Element[] {
	return $$(allSelector).filter((el) => !isMarkedHidden(el));
}

// 回傳目前所有「已隱藏」元素
export function getHiddenBySelector(allSelector: string): Element[] {
	return $$(allSelector).filter((el) => isMarkedHidden(el));
}
