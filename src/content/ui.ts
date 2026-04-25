// src/content/ui.ts
// Chat Cleaner - UI Module
// ------------------------------------------------------------
// 功能職責 (Responsibilities):
//   - 提供純 UI 元件與互動，避免業務邏輯耦合
//   - i18n、Toast、Tooltip 與控制面板掛載
//
// 主要職能 (Key Functions):
//   - createI18n：薄封裝 chrome.i18n
//   - createToast：Toast 合併/累加，支援刪除/隱藏/成功/錯誤樣式
//   - mountUI：懸浮球 + 控制面板，透過 onApply 回拋設定
//   - initTooltips：具現 .ccx-hint[data-tip]
//   - mountShowMore：插入「顯示更多」按鈕
//
// 設計要點 (Design Notes):
import { TOAST, SHOW_MORE } from "./constants";
//   - Toast：最多顯示 4 條，重複訊息會累加數字與次數
//   - Tooltip：僅生成一次，避免重複插入
//   - UI 掛載有 guard（MutationObserver），防止被 DOM 移除
// ------------------------------------------------------------

import { CLS, getHiddenBySelector, getVisibleBySelector } from "./dom-utils";
import type {
	I18nFn,
	Mode,
	ApplyPayload,
	TrimResult,
	ToastKind,
	Trimmer,
	Ref,
} from "./types";

/* --------------------------------- */
/* i18n 薄封裝（取不到則 fallback）   */
/* --------------------------------- */
export function createI18n(): I18nFn {
	return (key, fallback = "") => {
		try {
			const s = (globalThis as any)?.chrome?.i18n?.getMessage?.(key);
			return s || fallback || key;
		} catch {
			return fallback || key;
		}
	};
}

/* --------------------------------- */
/* Toast：合併/累加 + 自動關閉（可堆疊） */
/* --------------------------------- */
export function createToast(T: I18nFn) {
	let toastContainer = document.querySelector<HTMLDivElement>(
		`.${CLS.TOAST_CONTAINER}`
	);
	if (!toastContainer) {
		toastContainer = document.createElement("div");
		toastContainer.className = CLS.TOAST_CONTAINER;
		// 輔助技術：一般訊息用 status/polite；重要型可個別改 alert/assertive
		toastContainer.setAttribute("role", "status");
		toastContainer.setAttribute("aria-live", "polite");
		toastContainer.setAttribute("aria-atomic", "true");
		document.body.appendChild(toastContainer);
	}

	type Rec = {
		el: HTMLDivElement;
		count: number; // 同類訊息出現次數（xN）
		sum: number; // 數字總和（只處理單一數字）
		hasNum: boolean;
		template: string; // 把數字位置換成 {n} 的模板
		timer: ReturnType<typeof setTimeout> | null;
		type: ToastKind;
	};

	// 關鍵設定（從 constants.ts 導入）
	const MAX_VISIBLE = TOAST.MAX_VISIBLE;
	const LIFETIME = TOAST.LIFETIME_MS;
	const FALLBACK_REMOVE_MS = TOAST.FALLBACK_REMOVE_MS;

	// key → 累加記錄；key 為「type + 文字(數字標準化)」
	const toastMap = new Map<string, Rec>();

	// 僅處理單一數字：取訊息中第一個連續數字（不處理小數/千分位/全形）
	const NUM_RE = /\d+/;

	function normalizeKey(msg: string, type: ToastKind) {
		return `${type}|${msg.replace(/\d+/g, "#").trim()}`;
	}
	function extractFirstNumber(msg: string): number | null {
		const m = msg.match(NUM_RE);
		if (!m) return null;
		const n = parseInt(m[0], 10);
		return Number.isFinite(n) ? n : null;
	}
	function buildText(rec: {
		count: number;
		sum: number;
		hasNum: boolean;
		template: string;
	}) {
		let text = rec.hasNum
			? rec.template.replace("{n}", String(rec.sum))
			: rec.template;
		if (rec.count > 1) text += ` (x${rec.count})`;
		return text;
	}

	// 關閉並移除（含保底）
	function scheduleClose(key: string, rec: Rec, ms = LIFETIME) {
		if (rec.timer) clearTimeout(rec.timer);
		rec.timer = setTimeout(() => {
			rec.el.classList.remove("show"); // 觸發淡出
			let removed = false;
			const remove = () => {
				if (removed) return;
				removed = true;
				rec.el.removeEventListener("transitionend", remove);
				rec.el.remove();
				toastMap.delete(key);
			};
			rec.el.addEventListener("transitionend", remove);
			setTimeout(remove, FALLBACK_REMOVE_MS); // 保底
		}, ms);
	}

	// 畫面上最多 N 條 → 超出就移除最舊的 toast（避免畫面塞滿）
	function clampVisible(limit = MAX_VISIBLE) {
		const items = Array.from(
			toastContainer!.querySelectorAll<HTMLElement>(`.${CLS.TOAST}`)
		);
		if (items.length <= limit) return;
		const extra = items.length - limit;
		for (let i = 0; i < extra; i++) {
			const el = items[i];
			// 從映射中找到對應 key，移除計時器與 entry
			for (const [k, rec] of toastMap) {
				if (rec.el === el) {
					try {
						if (rec.timer) clearTimeout(rec.timer);
					} catch {}
					el.classList.remove("show");
					setTimeout(() => el.remove(), FALLBACK_REMOVE_MS);
					toastMap.delete(k);
					break;
				}
			}
		}
	}

	function showToast(msg: string, type: ToastKind = "hide") {
		const key = normalizeKey(msg, type);
		const firstNum = extractFirstNumber(msg);
		const hasNum = firstNum != null;

		let rec = toastMap.get(key);
		if (!rec) {
			// 新開一條
			const el = document.createElement("div");
			el.className = `${CLS.TOAST} ${type}`;

			// 重要型可以切到 alert/assertive（選用）
			if (type === "err" || type === "delete") {
				el.setAttribute("role", "alert");
				el.setAttribute("aria-live", "assertive");
			}

			(toastContainer as Element).appendChild(el);

			const template = hasNum ? msg.replace(NUM_RE, "{n}") : msg;
			rec = {
				el,
				count: 1,
				sum: hasNum ? (firstNum as number) : 0,
				hasNum,
				template,
				timer: null,
				type,
			};
			toastMap.set(key, rec);

			el.textContent = buildText(rec);
			requestAnimationFrame(() => el.classList.add("show"));
			scheduleClose(key, rec, LIFETIME);
			clampVisible(MAX_VISIBLE); // 保持最多可見數
		} else {
			// 同一類型 → 疊加
			rec.count += 1;
			if (rec.hasNum && hasNum) {
				rec.sum += firstNum as number;
			}
			rec.el.textContent = buildText(rec);

			// 重新排閉合時間：每次累加都延長顯示時間，讓使用者看得見
			scheduleClose(key, rec, LIFETIME);
		}
	}

	// 由外部呼叫：把批次結果（hidden/restored/deleted）轉成一條 toast
	function showResult(res: TrimResult, mode: Mode, auto = false) {
		const { hidden = 0, restored = 0, deleted = 0 } = res || {};
		if (!hidden && !restored && !deleted) return;

		const parts: string[] = [];
		let kind: ToastKind = "hide";

		if (mode === "delete") {
			if (deleted > 0)
				parts.push(`${deleted} ${T("toastDeleted", "deleted")}`);
			kind = "delete";
		} else {
			if (hidden > 0)
				parts.push(`${hidden} ${T("toastHidden", "hidden")}`);
			if (restored > 0)
				parts.push(`${restored} ${T("toastRestored", "restored")}`);
		}
		if (!parts.length) return;

		const prefix = auto
			? T("toastAutoPrefix", "Auto:")
			: T("toastManualPrefix", "Manual:");
		showToast(`${prefix} ${parts.join(", ")}`, kind);
	}

	// 提供 content script 卸載時清空
	function destroy() {
		for (const [k, rec] of toastMap) {
			if (rec.timer) clearTimeout(rec.timer);
			rec.el.remove();
			toastMap.delete(k);
		}
		toastContainer?.remove();
	}

	return { showToast, showResult, destroy };
}

/* --------------------------------- */
/* Tooltip：將 .ccx-hint[data-tip] 具現 */
/* --------------------------------- */
export function initTooltips(root: ParentNode | Document = document) {
	root.querySelectorAll<HTMLElement>(".ccx-hint").forEach((el) => {
		// 已有 tooltip 不重建
		if (el.querySelector(".ccx-tooltip")) return;

		const raw = el.getAttribute("data-tip");
		const text = raw ? decodeURIComponent(raw) : "";
		if (!text) return;

		const tip = document.createElement("div");
		tip.className = "ccx-tooltip";
		tip.textContent = text; // 換行交由 CSS 控制
		el.appendChild(tip);
	});
}

/* --------------------------------- */
/* UI 掛載：懸浮球 + 面板 + Apply      */
/* --------------------------------- */
export function mountUI(opts: {
	T: I18nFn;
	initial: { maxKeep: number; mode: Mode; notify: boolean };
	onApply: (next: ApplyPayload) => void;
}) {
	const { T, initial, onApply } = opts;

	const root = document.createElement("div");
	root.className = CLS.UI_ROOT;

	// 提示內容（優先使用 i18n，否則 fallback）
	const tipHideMain = T("tipHideMain", "Hide old messages (restorable).");
	const tipHideEffect = T(
		"tipHideEffect",
		"Reduces DOM pressure while keeping a way to bring messages back."
	);
	const tipHideDetail = T(
		"tipHideDetail",
		"Hidden messages are kept in DOM with visibility off; you can restore them later."
	);

	const tipDeleteMain = T(
		"tipDeleteMain",
		"Delete old messages (permanent)."
	);
	const tipDeleteEffect = T(
		"tipDeleteEffect",
		"Minimizes DOM usage but you cannot restore deleted nodes."
	);
	const tipDeleteDetail = T(
		"tipDeleteDetail",
		"Deletion removes nodes from DOM entirely. Prefer this when you don’t need history."
	);

	function tipBlock(
		label: string,
		main: string,
		effect: string,
		detail: string
	) {
		const encoded = encodeURIComponent(detail);
		return `
		<div class="ccx-tip-item">
			<span class="ccx-hint" data-tip="${encoded}" aria-label="info" role="img">ℹ️</span>
			<strong>${label}</strong>:<br>${main}<br>${effect}
		</div>
    `;
	}

	const iconURL =
		(globalThis as any)?.chrome?.runtime?.getURL?.("icons/chat-mono.svg") ??
		"";

	root.innerHTML = `
	<div class="ccx-ball" role="button" aria-label="${T(
		"openPanel",
		"Open cleaner panel"
	)}" tabindex="0">
	${
		iconURL
			? `<img src="${iconURL}" alt="" draggable="false" style="user-select:none;pointer-events:none;">`
			: `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 4h16v12H7l-3 3z"/></svg>`
	}
	</div>

	<div class="ccx-panel" role="dialog" aria-modal="true" aria-label="${T(
		"title",
		"Chat Cleaner"
	)}" tabindex="-1">
		<div class="ccx-header">
			<span>${T("title", "Chat Cleaner")}</span>
			<div class="ccx-actions">
				<button class="ccx-close" aria-label="${T("close", "Close")}">✖</button>
			</div>
		</div>

		<div class="ccx-body">
			<label for="ccx-keep">${T("keepLabel", "Keep up to")}</label>
			<input id="ccx-keep" type="number" inputmode="numeric" step="1" min="1" value="${
				initial.maxKeep
			}">
			<label for="ccx-mode">${T("modeLabel", "Mode")}</label>
			<select id="ccx-mode">
				<option value="hide"${initial.mode === "hide" ? " selected" : ""}>
					${T("modeHide", "Hide (restorable)")}
				</option>
				<option value="delete"${initial.mode === "delete" ? " selected" : ""}>
					${T("modeDelete", "Delete (permanent)")}
				</option>
			</select>

			<label class="ccx-row">
				<input id="ccx-notify" type="checkbox" ${initial.notify ? "checked" : ""}>
				${T("notifyLabel", "Show notifications")}
			</label>

			<button id="ccx-apply">${T("apply", "Apply")}</button>

			<div class="ccx-tip">
				${tipBlock(
					T("modeHide", "Hide (restorable)"),
					tipHideMain,
					tipHideEffect,
					tipHideDetail
				)}
				<hr>
				${tipBlock(
					T("modeDelete", "Delete (permanent)"),
					tipDeleteMain,
					tipDeleteEffect,
					tipDeleteDetail
				)}
				<hr>
				<div class="ccx-tip-item">
					<em>${T("noteLabel", "Note")}:</em>
					${T("tipReload", "Changing mode? Reload the page for best results.")}
				</div>
			</div>
		</div>
	</div>`;

	document.body.appendChild(root);
	initTooltips(root);

	// ---- 交互元件 ----
	const ball = root.querySelector(".ccx-ball") as HTMLDivElement;
	const panel = root.querySelector(".ccx-panel") as HTMLDivElement;
	const keepI = root.querySelector("#ccx-keep") as HTMLInputElement;
	const modeSel = root.querySelector("#ccx-mode") as HTMLSelectElement;
	const notifyI = root.querySelector("#ccx-notify") as HTMLInputElement;
	const closeBtn = root.querySelector(".ccx-close") as HTMLButtonElement;
	const applyBtn = root.querySelector("#ccx-apply") as HTMLButtonElement;

	// 防止拖曳出現幽靈圖像
	ball.setAttribute("draggable", "false");

	let panelOpen = false;
	let lastBallFocus: HTMLElement | null = null;

	function positionPanel() {
		const br = ball.getBoundingClientRect();
		const pr = panel.getBoundingClientRect();

		let left = br.left + br.width / 2 - pr.width / 2;
		left = Math.max(8, Math.min(window.innerWidth - pr.width - 8, left));

		const top =
			br.top - pr.height - 10 >= 8
				? br.top - pr.height - 10
				: br.bottom + 10;
		panel.style.left = left + "px";
		panel.style.top = top + "px";
	}
	function openPanel() {
		positionPanel();
		panel.classList.add("show");
		panelOpen = true;

		// 焦點管理
		lastBallFocus = (document.activeElement as HTMLElement) || ball;
		panel.focus();
		keepI?.focus();

		// 面板內提示元素具現
		initTooltips(panel);
	}
	function closePanel() {
		panel.classList.remove("show");
		panelOpen = false;
		(lastBallFocus || ball).focus();
	}

	// ---- 懸浮球拖曳（Pointer Capture） ----
	let dragging = false,
		moved = false,
		startX = 0,
		startY = 0,
		ox = 0,
		oy = 0;

	function onPointerMove(e: PointerEvent) {
		if (!dragging) return;
		const dx = Math.abs(e.clientX - startX);
		const dy = Math.abs(e.clientY - startY);
		if (!moved && (dx > 6 || dy > 6)) moved = true;
		if (!moved) return;

		const x = Math.max(
			0,
			Math.min(window.innerWidth - ball.offsetWidth, e.clientX - ox)
		);
		const y = Math.max(
			0,
			Math.min(window.innerHeight - ball.offsetHeight, e.clientY - oy)
		);
		ball.style.left = x + "px";
		ball.style.top = y + "px";
		ball.style.right = "auto";
		ball.style.bottom = "auto";
		if (panelOpen) positionPanel();
	}
	function onPointerUp(e: PointerEvent) {
		if (!dragging) return;
		dragging = false;
		ball.classList.remove("dragging");
		try {
			ball.releasePointerCapture(e.pointerId);
		} catch {}
		if (!moved) {
			panelOpen ? closePanel() : openPanel();
		}
	}

	const onBallPointerDown = (e: PointerEvent) => {
		dragging = true;
		moved = false;
		const r = ball.getBoundingClientRect();
		startX = e.clientX;
		startY = e.clientY;
		ox = startX - r.left;
		oy = startY - r.top;
		ball.classList.add("dragging");
		try {
			ball.setPointerCapture(e.pointerId);
		} catch {}
	};

	ball.addEventListener("pointerdown", onBallPointerDown);
	ball.addEventListener("pointermove", onPointerMove);
	ball.addEventListener("pointerup", onPointerUp);

	// ---- 鍵盤操作：Enter/Space 開關、Esc 關閉 ----
	ball.addEventListener("keydown", (e) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			panelOpen ? closePanel() : openPanel();
		}
	});
	panel.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			e.preventDefault();
			closePanel();
		}
		if (
			e.key === "Enter" &&
			(e.target === applyBtn ||
				(e.target as HTMLElement)?.closest?.("#ccx-apply"))
		) {
			e.preventDefault();
			applyBtn.click();
		}
	});

	// ---- 視窗變動時的邊界保護（避免球/面板跑出畫面） ----
	function clampBallIntoViewport() {
		// 僅在使用者拖曳後（left/top 已存在）才需要鉗制
		const hasCustomPos =
			ball.style.left &&
			ball.style.top &&
			(ball.style.right === "auto" || ball.style.bottom === "auto");
		if (!hasCustomPos) return;

		const br = ball.getBoundingClientRect();
		const margin = 6;
		const maxLeft = Math.max(0, window.innerWidth - br.width - margin);
		const maxTop = Math.max(0, window.innerHeight - br.height - margin);
		const nextLeft = Math.min(Math.max(br.left, margin), maxLeft);
		const nextTop = Math.min(Math.max(br.top, margin), maxTop);
		ball.style.left = `${nextLeft}px`;
		ball.style.top = `${nextTop}px`;
	}

	function clampPanelIntoViewport() {
		if (!panel.classList.contains("show")) return;
		positionPanel();
	}

	const onViewportChange = () => {
		clampBallIntoViewport();
		clampPanelIntoViewport();
	};
	window.addEventListener("resize", onViewportChange, { passive: true });
	window.addEventListener("orientationchange", onViewportChange);

	// ---- 關閉面板、點擊外部關閉 ----
	const onDocClickCapture = (e: MouseEvent) => {
		if (
			panelOpen &&
			!panel.contains(e.target as Node) &&
			!ball.contains(e.target as Node)
		) {
			closePanel();
		}
	};

	closeBtn.addEventListener("click", closePanel);
	document.addEventListener("click", onDocClickCapture, true);

	// ---- Apply：將設定回拋，由上層決定後續行為 ----
	const onApplyClick = () => {
		try {
			// 空值或非法值回退為 1
			const parsed = parseInt(keepI.value, 10);
			const maxKeep = Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;

			const next: ApplyPayload = {
				maxKeep,
				mode: modeSel.value as Mode,
				notify: !!notifyI.checked,
			};
			onApply(next);

			// 簡單回饋
			const oldText = applyBtn.textContent || "Applied";
			applyBtn.textContent = T("toastApplied", "Applied");
			applyBtn.disabled = true;
			setTimeout(() => {
				applyBtn.textContent = oldText;
				applyBtn.disabled = false;
			}, 1200);
		} catch {
			// 錯誤處理交由上層決定是否以 Toast 呈現
		}
	};
	applyBtn.addEventListener("click", onApplyClick);

	// ---- 錨點守護：確保 UI 節點存在於 body 中（防止被外部程式移除） ----
	let guardTimer: ReturnType<typeof setTimeout> | null = null;
	const guard = new MutationObserver(() => {
		if (guardTimer) return;
		guardTimer = setTimeout(() => {
			guardTimer = null;
			if (!document.body.contains(root)) {
				document.body.appendChild(root);
			}
		}, 200);
	});
	guard.observe(document.body, { childList: true, subtree: false });

	// ---- 對外：更新輸入值 ----
	function updateInputs(next: Partial<ApplyPayload>) {
		if (typeof next.maxKeep === "number" && Number.isFinite(next.maxKeep)) {
			keepI.value = String(Math.max(1, next.maxKeep));
		}
		if (next.mode) {
			modeSel.value = next.mode;
		}
		if (typeof next.notify === "boolean") {
			notifyI.checked = next.notify;
		}
		if (panelOpen) initTooltips(panel);
	}

	// ---- 對外：銷毀 ----
	function destroy() {
		try {
			guard.disconnect();

			// 解除事件監聽
			ball.removeEventListener("pointerdown", onBallPointerDown);
			ball.removeEventListener("pointermove", onPointerMove);
			ball.removeEventListener("pointerup", onPointerUp);

			window.removeEventListener("resize", onViewportChange);
			window.removeEventListener("orientationchange", onViewportChange);

			closeBtn.removeEventListener("click", closePanel);
			document.removeEventListener("click", onDocClickCapture, true);
			applyBtn.removeEventListener("click", onApplyClick);
		} catch {}
		root.remove();
	}

	return { root, closePanel, updateInputs, destroy };
}

/* --------------------------------- */
/* UI 掛載：顯示更多（Show More）按鈕   */
/* --------------------------------- */
export function mountShowMore(opts: {
	T: I18nFn;
	selectorAll: string; // 例如 SELECTORS.ALL
	trimmer: Trimmer;
	modeRef: Ref<Mode>; // ()=>state.mode
	maxKeepRef: Ref<number>; // ()=>state.maxKeep
}) {
	const { T, selectorAll, trimmer, modeRef, maxKeepRef } = opts;
	let wrapper: HTMLDivElement | null = null;
	let prevHiddenCount = -1;
	
	// 節流控制：避免頻繁更新 DOM
	let updateTimer: ReturnType<typeof setTimeout> | null = null;
	// 節流控制（從 constants.ts 導入）
	const UPDATE_THROTTLE_MS = SHOW_MORE.UPDATE_THROTTLE_MS;

	function removeIfAny() {
		wrapper?.remove();
		wrapper = null;
		prevHiddenCount = -1;
	}

	function insert() {
		// 僅在 hide 模式顯示
		if (modeRef() !== "hide") return removeIfAny();

		const hidden = getHiddenBySelector(selectorAll);
		
		// 無隱藏訊息時移除按鈕
		if (!hidden.length) return removeIfAny();
		
		// hidden 數量未變更且已有 wrapper → 直接早退
		if (wrapper && hidden.length === prevHiddenCount) return;
		prevHiddenCount = hidden.length;

		// 先清掉舊的
		removeIfAny();
		prevHiddenCount = hidden.length;

		wrapper = document.createElement("div");
		wrapper.className = CLS.SHOW_MORE_WRAP;
		wrapper.style.textAlign = "center";
		wrapper.style.margin = "12px 0";

		const btn = document.createElement("button");
		const toShowNow = Math.min(maxKeepRef(), hidden.length);
		// 使用向上箭頭符號，表示「展開更多」
		btn.textContent = `\u25B2 ${T(
			"showMoreBtn",
			"Show previous"
		)} ${toShowNow} ${T("messagesLabel", "messages")} (${hidden.length} ${T(
			"hiddenLabel",
			"hidden"
		)})`;
		btn.onclick = () => {
			trimmer.showMoreMessages();
			// 使用節流的 update，避免閃爍
			if (updateTimer) clearTimeout(updateTimer);
			updateTimer = setTimeout(() => {
				updateTimer = null;
				update();
			}, 50);
		};
		wrapper.appendChild(btn);

		const firstVisible = getVisibleBySelector(selectorAll)[0];
		if (!firstVisible) {
			// 沒有可見訊息：避免插入造成位置漂移
			removeIfAny();
			return;
		}

		const parent =
			(firstVisible.parentNode as Element | null) || document.body;
		parent.insertBefore(wrapper, firstVisible || parent.firstChild);
	}

	function update() {
		// 節流：避免短時間內多次更新
		if (updateTimer) return;
		
		updateTimer = setTimeout(() => {
			updateTimer = null;
			insert();
		}, UPDATE_THROTTLE_MS);
	}
	
	// 立即更新（跳過節流）
	function forceUpdate() {
		if (updateTimer) {
			clearTimeout(updateTimer);
			updateTimer = null;
		}
		insert();
	}

	function destroy() {
		if (updateTimer) {
			clearTimeout(updateTimer);
			updateTimer = null;
		}
		removeIfAny();
	}

	return { update, forceUpdate, destroy };
}
