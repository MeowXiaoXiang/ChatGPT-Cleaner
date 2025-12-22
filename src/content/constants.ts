// src/content/constants.ts
// Chat Cleaner - Centralized Constants
// ------------------------------------------------------------
// 所有可調整的參數集中於此，方便維護與調整
// All tunable parameters are centralized here for easy maintenance
// ------------------------------------------------------------

/* ============================================================
    DEFAULT SETTINGS (用戶預設值)
   ============================================================ */

/** 預設保留訊息數量 (default: 25) */
export const DEFAULT_MAX_KEEP = 25;

/** 預設運作模式 ('hide' | 'delete') */
export const DEFAULT_MODE = "hide" as const;

/* ============================================================
    DEBOUNCE & THROTTLE (防抖與節流)
   ============================================================ */

/**
 * Trim 操作防抖延遲 (ms)
 * - delay: 初始延遲，會根據 trim 耗時動態調整
 * - min/max: 延遲的上下限
 * - emaAlpha: 平滑係數，越大越快適應變化
 */
export const DEBOUNCE = {
	/** 初始延遲 (ms) - 較低值提升響應性 */
	DELAY_INIT: 150,
	/** 最小延遲 (ms) - 允許的最快響應速度 */
	DELAY_MIN: 80,
	/** 最大延遲 (ms) - 避免過度等待 */
	DELAY_MAX: 600,
	/** EMA 平滑係數 (0-1) - 越大越快適應 trim 耗時變化 */
	EMA_ALPHA: 0.25,
} as const;

/**
 * Trim 耗時閾值 (ms) - 用於動態調整防抖延遲
 * - SLOW: trim 平均耗時超過此值視為「慢」
 * - STEP_UP: 超過此值會增加延遲 (約2幀@60fps)
 * - STEP_DOWN: 低於此值會減少延遲
 */
export const TRIM_THRESHOLD = {
	/** 慢速閾值 (ms) - 超過此值視為效能警告 (~1幀@60fps) */
	SLOW_MS: 16,
	/** 增加延遲閾值 (ms) - 超過此值會放慢節奏 (~2幀@60fps) */
	STEP_UP_MS: 32,
	/** 減少延遲閾值 (ms) - 低於此值可加快節奏 */
	STEP_DOWN_MS: 8,
} as const;

/** Mutation 最小處理間隔 (ms) - 防止滾動載入時過度觸發 */
export const MIN_TRIM_INTERVAL_MS = 300;

/* ============================================================
    LONG TASK GATE (長任務守門)
   ============================================================ */

/**
 * Long Task 監測參數
 * 用於偵測系統繁忙程度，決定是否暫停刪除操作
 */
export const LONG_TASK = {
	/** 心跳頻率 (ms) - 每秒結算一次 */
	BUCKET_MS: 1000,

	/* EMA 平滑係數 */
	/** Rate EMA 平滑係數 - 稍低使數值更穩定 */
	ALPHA_RATE: 0.3,
	/** Duration EMA 平滑係數 - 稍高使更快適應 */
	ALPHA_DUR: 0.25,
	/** 無 long task 時的衰減係數 - 更快恢復 */
	DECAY: 0.5,

	/* 進入/退出暫停的閾值 (Hysteresis) */
	/** 進入暫停：rate >= 此值 (/s) */
	ENTER_RATE: 0.6,
	/** 恢復繼續：rate < 此值 (/s) */
	EXIT_RATE: 0.2,
	/** 進入暫停：平均耗時 >= 此值 (ms) */
	ENTER_AVG: 60,
	/** 恢復繼續：平均耗時 < 此值 (ms) */
	EXIT_AVG: 25,

	/** 最小暫停時間 (ms) - 防止頻繁切換 */
	MIN_SUSPEND_MS: 2000,
} as const;

/* ============================================================
    BATCH DELETE (批次刪除)
   ============================================================ */

/**
 * 批次刪除自適應參數
 * 在 delete 模式下，大量刪除會分批處理以避免卡頓
 */
export const BATCH = {
	/** 最小批量 - 降低以提高響應性 */
	CHUNK_MIN: 5,
	/** 最大批量 - 降低以避免長時間阻塞 */
	CHUNK_MAX: 100,
	/** 初始批量 - 起始值 */
	CHUNK_INIT: 30,
	/** 單批上限耗時 (ms) - 超過則減少批量 (~1.2幀@60fps) */
	SLICE_UPPER_MS: 20,
	/** 單批下限耗時 (ms) - 低於則增加批量 */
	SLICE_LOWER_MS: 6,
	/** 觸發批次刪除的門檻 - 超過此數量才用批次 */
	BULK_THRESHOLD: 20,
};

/* ============================================================
    TOAST NOTIFICATIONS (通知)
   ============================================================ */

export const TOAST = {
	/** 同時顯示的最大數量 */
	MAX_VISIBLE: 4,
	/** 單則顯示時間 (ms) */
	LIFETIME_MS: 1600,
	/** 動畫保底移除時間 (ms) - 避免 transitionend 錯失 */
	FALLBACK_REMOVE_MS: 900,
} as const;

/* ============================================================
    SHOW MORE BUTTON (顯示更多按鈕)
   ============================================================ */

export const SHOW_MORE = {
	/** 更新節流間隔 (ms) - 避免頻繁 DOM 操作 */
	UPDATE_THROTTLE_MS: 200,
} as const;

/* ============================================================
    WAKE / VISIBILITY (喚醒與可見性)
   ============================================================ */

export const WAKE = {
	/** 頁面回前景後的冷卻時間 (ms) - 延遲 trim 避免突變抖動 */
	COOLDOWN_MS: 8000,
	/** 回前景後忽略 mutation 的時間 (ms) */
	RESUME_MUTE_MS: 1500,
} as const;

/* ============================================================
    MONITOR PANEL (監控面板)
   ============================================================ */

export const MONITOR = {
	/** 刷新頻率 (ms) */
	REFRESH_MS: 1000,
	/** 圖表最大資料點數 */
	MAX_POINTS: 240,
	/** 圖表最小高度 (px) */
	CHART_HEIGHT_MIN: 96,
	/** 圖表最大高度 (px) */
	CHART_HEIGHT_MAX: 240,
} as const;

/* ============================================================
    DOM SELECTORS (DOM 選擇器)
   ============================================================ */

/**
 * ChatGPT 對話訊息選擇器
 * 備用選擇器使用 UUID-based data-turn-id
 */
export const SELECTORS = {
	/** 主選擇器：依 data-testid */
	PRIMARY: '[data-testid^="conversation-turn-"]',
	/** 備用選擇器：依 data-turn-id (2025 新增的 UUID) */
	FALLBACK: "article[data-turn-id][data-turn]",
} as const;

/** 合併選擇器（用於 querySelectorAll） */
export const SELECTOR_ALL = `${SELECTORS.PRIMARY}, ${SELECTORS.FALLBACK}`;

/* ============================================================
    CSS CLASSES & IDS (CSS 類別與 ID)
   ============================================================ */

export const UI_SELECTORS = {
	/** 內部 UI 選擇器 - Observer 會忽略這些元素的 mutation */
	INTERNAL: [
		".ccx-ui",
		".ccx-toast-container",
		".ccx-showmore-wrap",
		"#ccx-monitor",
		"#ccx-monitor *",
	],
} as const;
