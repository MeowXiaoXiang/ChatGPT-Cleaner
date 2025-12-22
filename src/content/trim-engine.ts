// src/content/trim-engine.ts
// Chat Cleaner - Trim Engine
// ------------------------------------------------------------
// 功能職責 (Responsibilities):
//   - 根據 StormGate 狀態決定是否暫停刪除
//   - 提供 hide / restore / delete 基本操作
//   - Idle 分段批次刪除（batchDelete，具動態 CHUNK 調整）
//   - Trimmer：組合修剪流程，統一對外提供 trim / showMore API
//
// 主要職能 (Key Functions):
//   - createDeleter：安全刪除並更新統計
//   - hideMsg / restoreMsg：隱藏或還原訊息
//   - batchDelete：大批量刪除，避免一次操作造成卡頓
//   - createTrimmer：整合修剪邏輯，維持訊息數量上限
//
// 設計要點 (Design Notes):
//   - StormGate.suspended 為唯一刪除暫停依據
//   - 批次刪除具動態 chunk size，目標維持 8~30ms 執行時間
//   - trimMessages 在批次與單筆刪除後，皆會統一呼叫 showResult
// ------------------------------------------------------------

import {
	CLS,
	isMarkedHidden,
	markHidden,
	unmarkHidden,
	getVisibleBySelector,
	getHiddenBySelector,
	shortSelector,
} from "./dom-utils";
import { requestIdle } from "./idle-utils";
import type {
	CreateTrimmerDeps,
	Mode,
	Stats,
	TrimResult,
	Trimmer,
	LogFn,
} from "./types";
import { BATCH } from "./constants";

/* ----------------------------- */
/* 批次刪除參數 (從 constants.ts 導入) */
/* ----------------------------- */
const CHUNK_MIN = BATCH.CHUNK_MIN;
const CHUNK_MAX = BATCH.CHUNK_MAX;
const CHUNK_INIT = BATCH.CHUNK_INIT;
const SLICE_UPPER_MS = BATCH.SLICE_UPPER_MS;
const SLICE_LOWER_MS = BATCH.SLICE_LOWER_MS;

/* ------------------------------------------ */
/* Basic Operations (delete / hide / restore) */
/* ------------------------------------------ */

/** 直接從 DOM 刪除訊息節點，並更新統計數據 */
export function createDeleter(log: LogFn, stats: Stats) {
	return function deleteMsg(el: Element) {
		const html = el as HTMLElement;
		if (!html || !html.isConnected) return;

		const sig = shortSelector(html);

		// 標記為不可互動（保險）
		if (!html.hasAttribute("inert")) html.setAttribute("inert", "");
		if (!html.hasAttribute("aria-hidden"))
			html.setAttribute("aria-hidden", "true");
		if (!html.classList.contains(CLS.HIDDEN))
			html.classList.add(CLS.HIDDEN);
		if (!html.classList.contains(CLS.INERT)) html.classList.add(CLS.INERT);

		html.remove();
		stats.domRemoved++;
		log("deleteMsg -> DOM removed", sig);
	};
}

// 根據 mode 決定隱藏或刪除
export function hideMsg(
	el: Element,
	mode: Mode,
	deleter: (el: Element) => void
) {
	if (mode === "delete") {
		deleter(el);
		return;
	}
	if (!isMarkedHidden(el)) markHidden(el);
}

// hide 模式才允許還原
export function restoreMsg(el: Element, mode: Mode) {
	if (mode === "delete") return;
	if (isMarkedHidden(el)) unmarkHidden(el);
}

/* -------------- */
/* 批次刪除（Idle） */
/* -------------- */

/**
 * Idle 分段刪除，依耗時自動調整批量大小：
 * - 單批耗時 >30ms : 減少批量
 * - 單批耗時 <8ms  : 增加批量
 * - timeRemaining() 缺失時，預設 12ms
 * - onBatch：每批回報
 * - onDone：完成回報
 */
export function batchDelete(
	nodes: Iterable<Element> | NodeListOf<Element>,
	deleteMsg: (el: Element) => void,
	log: LogFn,
	onBatch?: (count: number, ms: number) => void,
	onDone?: () => void
) {
	// 去重 + 僅保留仍連接於 DOM 的元素
	const unique: Element[] = [];
	const seen = new WeakSet<Element>();
	for (const n of Array.from(nodes as any)) {
		const el = n as Element;
		if (!el || typeof el !== "object") continue;
		if (seen.has(el)) continue;
		seen.add(el);
		if (el.isConnected) unique.push(el);
	}
	if (!unique.length) {
		onDone?.();
		return;
	}

	let i = 0;
	let chunkSize = CHUNK_INIT; // 起始批量
	log(`batchDelete: start (${unique.length} nodes)`);

	function runSlice(deadline?: IdleDeadline) {
		const sliceStart = performance.now();

		const hasTR = typeof deadline?.timeRemaining === "function";
		const tr = hasTR ? (deadline as IdleDeadline).timeRemaining() : 12;

		// 根據剩餘數量微調單 slice 的時間上限：大量時稍微放寬，但仍保守
		const remain = unique.length - i;
		// 基本上限 20ms；>1000 擴到 26ms；>5000 擴到 32ms
		let maxBudget = 20;
		if (remain > 5000) maxBudget = 32;
		else if (remain > 1000) maxBudget = 26;

		const budgetMs = Math.max(6, Math.min(maxBudget, tr || 12));

		let processed = 0;

		while (i < unique.length && performance.now() - sliceStart < budgetMs) {
			const endIndex = Math.min(i + chunkSize, unique.length);
			for (; i < endIndex; i++) {
				const el = unique[i];
				if (!el || !el.isConnected) continue;
				deleteMsg(el);
				processed++;
			}
		}

		if (processed > 0) {
			const took = performance.now() - sliceStart;
			log(
				`batchDelete: slice → ${processed} removed in ${took.toFixed(
					2
				)}ms (chunk=${chunkSize})`
			);
			onBatch?.(processed, took);

			// ---- 動態調整 chunk ----
			if (took > SLICE_UPPER_MS && chunkSize > CHUNK_MIN) {
				chunkSize = Math.max(CHUNK_MIN, Math.floor(chunkSize * 0.8));
			} else if (took < SLICE_LOWER_MS && chunkSize < CHUNK_MAX) {
				chunkSize = Math.min(CHUNK_MAX, Math.ceil(chunkSize * 1.2));
			}
		}

		if (i < unique.length) {
			requestIdle(runSlice as any, { timeout: 24 });
		} else {
			log(`batchDelete: all done (${unique.length} total removed)`);
			onDone?.();
		}
	}

	requestIdle(runSlice as any, { timeout: 24 });
}

/* ---------------------- */
/* Trimmer：高階流程組裝   */
/* ---------------------- */
export function createTrimmer(deps: CreateTrimmerDeps): Trimmer {
	const {
		selectors,
		modeRef,
		maxKeepRef,
		notifyRef,
		stormGate,
		deleteMsg,
		showResult,
		log,
	} = deps;

	const ALL = selectors.ALL;

	// 動態決定批次刪除門檻（依 maxKeep 調整）
	function getBulkDeleteThreshold(): number {
		return Math.max(10, Math.floor(maxKeepRef() / 2));
	}

	// 若 StormGate 暫停，無論模式一律改為 hide，避免刪除造成額外壓力
	function safeDeleteOrHide(el: Element): "del" | "hide" {
		if (stormGate.suspended) {
			hideMsg(el, "hide", deleteMsg);
			return "hide";
		}
		if (modeRef() === "delete") {
			deleteMsg(el);
			return "del";
		}
		hideMsg(el, "hide", deleteMsg);
		return "hide";
	}

	function trimMessages(): TrimResult {
		let hidden = 0;
		let restored = 0;
		let deleted = 0;

		let pendingBatches = 0;
		let finalized = false;

		const finalizeIfReady = () => {
			if (pendingBatches === 0 && !finalized) {
				finalized = true;
				log(
					`trim {h:${hidden}, r:${restored}, d:${deleted}} | mode=${modeRef()} keep=${maxKeepRef()}`
				);

				if (notifyRef() && (hidden || restored || deleted)) {
					showResult({ hidden, restored, deleted }, true);
				}
			}
		};

		// delete 模式：清理既有「已隱藏」節點（不用 excess 判斷）
		if (modeRef() === "delete" && !stormGate.suspended) {
			const hiddenNodes = getHiddenBySelector(ALL);
			if (hiddenNodes.length) {
				pendingBatches++;
				batchDelete(
					hiddenNodes,
					deleteMsg,
					log,
					(count) => {
						deleted += count;
						if (notifyRef()) {
							showResult(
								{ hidden: 0, restored: 0, deleted: count },
								true
							);
						}
					},
					() => {
						pendingBatches--;
						finalizeIfReady();
					}
				);
			}
		}

		// 控制可見數量
		let visible = getVisibleBySelector(ALL);
		const excess = Math.max(0, visible.length - maxKeepRef());

		if (excess > 0) {
			if (
				modeRef() === "delete" &&
				excess > getBulkDeleteThreshold() &&
				!stormGate.suspended
			) {
				const victims = visible.slice(0, excess);
				pendingBatches++;
				batchDelete(
					victims,
					deleteMsg,
					log,
					(count) => {
						deleted += count;
						if (notifyRef()) {
							showResult(
								{ hidden: 0, restored: 0, deleted: count },
								true
							);
						}
					},
					() => {
						pendingBatches--;
						finalizeIfReady();
					}
				);
			} else {
				for (let i = 0; i < excess; i++) {
					const act = safeDeleteOrHide(visible[i]);
					if (act === "del") deleted++;
					else hidden++;
				}
			}
		}

		// ----------------------------------------------------------------
		// hide 模式：只有在使用者明確請求時才還原
		// 移除自動還原邏輯，避免滾動觸發 mutation 時意外還原
		// ----------------------------------------------------------------
		// 原始邏輯（已移除）：
		// if (modeRef() === "hide") {
		//     visible = getVisibleBySelector(ALL);
		//     let deficit = Math.max(0, maxKeepRef() - visible.length);
		//     if (deficit > 0) { ... restoreMsg ... }
		// }

		finalizeIfReady();
		return { hidden, restored, deleted };
	}

	function showMoreMessages(): void {
		if (modeRef() !== "hide") return;

		const hid = getHiddenBySelector(ALL);
		let toRestore = Math.min(maxKeepRef(), hid.length);

		let restored = 0;
		for (
			let i = hid.length - 1;
			i >= 0 && toRestore > 0;
			i--, toRestore--
		) {
			restoreMsg(hid[i], "hide");
			restored++;
		}
		if (restored > 0) {
			log(
				`showMore → restored ${restored} messages (keep=${maxKeepRef()})`
			);
		}
	}

	return { trimMessages, showMoreMessages };
}

// 輔助查詢：直接取可見/隱藏訊息
export function getVisible(ALL_SELECTOR: string): Element[] {
	return getVisibleBySelector(ALL_SELECTOR);
}
export function getHidden(ALL_SELECTOR: string): Element[] {
	return getHiddenBySelector(ALL_SELECTOR);
}
