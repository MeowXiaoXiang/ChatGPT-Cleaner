// src/content/types.ts
// Chat Cleaner - Type Definitions
// ------------------------------------------------------------
// 功能職責 (Responsibilities):
//   - 集中管理所有跨模組共享的型別定義
//   - 降低 trim-engine / observer / ui / main 之間的耦合度
//   - 僅提供型別、常數與函式型別宣告，不含 DOM 操作或業務邏輯
//
// 主要職能 (Key Functions):
//   - 定義 Settings / Stats / DebounceState 等核心資料結構
//   - 提供 ObserverHandles / Trimmer / CreateTrimmerDeps 等介面
//   - 建立統一的 LogFn、I18nFn、ShowResultFn 型別
//
// 設計要點 (Design Notes):
//   - 僅作為型別中心，禁止出現任何副作用或邏輯運算
//   - 由 main.ts 統一管理 localStorage，避免型別與狀態混雜
// ------------------------------------------------------------

/**
 * 運作模式：
 * - "hide"   ：把訊息節點隱藏（可還原）
 * - "delete" ：從 DOM 直接移除（不可還原）
 */
export type Mode = "hide" | "delete";

/**
 * 內容腳本的全域設定。
 * 建議由 main.ts 統一讀寫 localStorage 並同步這份資料。
 */
export interface Settings {
	/** 目前最多保留的可見訊息數量（>=1） */
	maxKeep: number;
	/** 是否顯示通知（toast） */
	notify: boolean;
	/** 運作模式（隱藏 / 刪除） */
	mode: Mode;
	/** 是否啟用（對應 ccx_enabled） */
	enabled: boolean;
	/** 除錯開關（對應 ccx_debug） */
	debug: boolean;
}

/**
 * 統計數據：目前追蹤實際從 DOM 移除的節點數量。
 * 可視需求擴充（例如隱藏/還原次數、批次刪除耗時等）。
 */
export interface Stats {
	/** 自啟動以來，累計被 remove() 的節點數 */
	domRemoved: number;
}

/**
 * Trim 調度/節流相關狀態。
 * - delay：目前動態決定的 debounce 時間
 * - min/max：delay 的上下界
 * - emaAlpha：EMA 平滑係數
 * - trimAvgMs：最近平均單次 trim 成本（毫秒）
 */
export interface DebounceState {
	delay: number;
	min: number;
	max: number;
	emaAlpha: number;
	trimAvgMs: number;
}

/**
 * 一次 trim 執行後的結果摘要，供 UI 顯示用。
 */
export interface TrimResult {
	/** 本次新增隱藏的訊息數 */
	hidden?: number;
	/** 本次還原的訊息數 */
	restored?: number;
	/** 本次刪除的訊息數 */
	deleted?: number;
}

/**
 * 頁面上的選擇器集合。
 * - LIST：理想的單一 selector（例如主要 turn 節點）
 * - ALL ：實際用於匹配訊息的綜合 selector（可能含 fallback）
 */
export interface Selectors {
	LIST: string;
	ALL: string;
}

/**
 * 簡易的 i18n 函式：
 * - key：messages.json 的條目
 * - fallback：若取不到則使用此字串
 */
export type I18nFn = (key: string, fallback?: string) => string;

/**
 * UI 「套用」動作的資料載體。
 * 由 UI 模組在使用者按下 Apply 時回傳給 main.ts。
 */
export interface ApplyPayload {
	maxKeep: number;
	mode: Mode;
	notify: boolean;
}

/** UI Toast 類型（對應樣式用途） */
export type ToastKind = "hide" | "delete" | "ok" | "err";

/** 公用紀錄函式型別（避免各模組用 any） */
export type LogFn = (...args: unknown[]) => void;

/**
 * StormGate（風暴斷路器）對外介面（LongTask 版）。
 * Trimmer 只需要知道 suspended 來決定刪除/隱藏策略。
 */
export interface StormGateAPI {
	/** LongTask 壓力高時為 true；Trimmer 只需要讀這個旗標 */
	readonly suspended: boolean;
}

/**
 * DOM 觀察器相關的統一操作介面：
 * - attach()：明確附掛到某個容器（通常由 start() 內部自動尋找並呼叫）
 * - start()：啟動流程（尋找訊息容器並 attach observer）
 * - stop()：停止主 observer 與一次性 waiter；若需完全停止，呼叫端同時解除路由監看
 * - setupRouteWatchers()：啟用路由偵測（popstate/hashchange/DOM URL 變動）
 */
export interface ObserverHandles {
	attach(container: Element): void;
	start(): void;
	stop(): void;
	setupRouteWatchers(): void;
}

/**
 * Trimmer 對外可用的操作。
 * - trimMessages()：執行一次清理並回傳結果
 * - showMoreMessages()：在 hide 模式下，還原更多訊息（與「顯示更多」按鈕互動）
 */
export interface Trimmer {
	trimMessages(): TrimResult;
	showMoreMessages(): void;
}

/**
 * UI 顯示 trim 結果的函式型別。
 * - res：trim 結果
 * - mode：目前模式（決定 toast 樣式與文字）
 * - auto：是否為自動觸發（影響前綴字樣）
 */
export type ShowResultFn = (
	res: TrimResult,
	mode: Mode,
	auto?: boolean
) => void;

/**
 * 小工具：某些模組需要傳入的「只讀引用函式」形態。
 * 例如：modeRef() 由 main.ts 提供，使 trim-engine 獲得即時的 mode。
 */
export type Ref<T> = () => T;

/**
 * createTrimmer 所需的依賴集合。
 * - selectors / modeRef / maxKeepRef / notifyRef：修剪策略所需環境
 * - stormGate：暫停策略（LongTask 斷路器）狀態
 * - deleteMsg：實際刪除節點的動作
 * - showResult：回傳結果給 UI（auto 由呼叫端決定）
 * - log：統一的紀錄介面
 */
export interface CreateTrimmerDeps {
	selectors: Selectors;
	modeRef: Ref<Mode>;
	maxKeepRef: Ref<number>;
	notifyRef: Ref<boolean>;
	stormGate: StormGateAPI;
	deleteMsg: (el: Element) => void;
	showResult: (res: TrimResult, auto: boolean) => void;
	log: LogFn;
}

/**
 * createObserverHandles 所需的依賴集合。
 * - selectors：訊息節點的選擇器
 * - CreateObserverDeps
 * - onMutation：把過濾後的 MutationRecord 批次回傳給呼叫端
 * - onInit：觀察器就緒時的回呼（通常觸發首次排程）
 */
export interface CreateObserverDeps {
	selectors: Selectors;
	log: LogFn;
	onMutation: (muts: MutationRecord[]) => void;
	onInit: () => void;
	onRouteChange?: () => void;
}
