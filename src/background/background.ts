// background.ts — Stable, minimal, reliable (ISOLATED-only)
// ------------------------------------------------------------
// - 點擊工具列切換 ccx_enabled；ON 時 reload 注入 content script
// - 分頁載入完成 / 切換分頁 / 安裝或啟動時，同步徽章
// - 僅處理 ChatGPT 網域；其它頁面清空徽章
// - 一律在 ISOLATED world 操作：可讀寫 localStorage、可呼叫 __ccxChatCleanerStop()
// ------------------------------------------------------------

const CHAT_URL_RE = /^https:\/\/(chatgpt\.com|chat\.openai\.com)(\/|$)/;

const BADGE_ON = { text: "ON", color: "#4caf50" };
const BADGE_OFF = { text: "OFF", color: "#777" };

function isChatPage(url?: string | null): boolean {
	return !!url && CHAT_URL_RE.test(url);
}

async function setBadge(tabId: number, enabled: boolean) {
	const look = enabled ? BADGE_ON : BADGE_OFF;
	await chrome.action.setBadgeText({ tabId, text: look.text });
	await chrome.action.setBadgeBackgroundColor({ tabId, color: look.color });
	// 可選：部分瀏覽器支援文字色
	try {
		await chrome.action.setBadgeTextColor?.({ tabId, color: "#fff" });
	} catch {}
}

async function clearBadge(tabId: number) {
	await chrome.action.setBadgeText({ tabId, text: "" });
}

/**
 * 讀取：頁面 localStorage（無值時回傳 true，與 content 行為一致）
 * 一律在 ISOLATED world，以確保能與 content script 同世界互動。
 */
async function readEnabledFromTab(tabId: number): Promise<boolean> {
	try {
		const [res] = await chrome.scripting.executeScript({
			target: { tabId },
			world: "ISOLATED",
			func: () => {
				try {
					const v = localStorage.getItem("ccx_enabled");
					return v == null ? true : v !== "0";
				} catch {
					return true; // 保守：讀失敗時當作啟用，避免把啟用頁誤標 OFF
				}
			},
		});
		return !!res?.result;
	} catch {
		// 分頁切換/關閉期間可能失敗；保守回傳 true（不顯示 OFF 造成誤導）
		return true;
	}
}

/**
 * 寫入：頁面 localStorage；關閉時若存在停止器就叫一下。
 * 一律在 ISOLATED world，因為 __ccxChatCleanerStop 掛在 content script（隔離世界）。
 */
async function writeEnabledToTab(tabId: number, nextEnabled: boolean) {
	try {
		await chrome.scripting.executeScript({
			target: { tabId },
			world: "ISOLATED",
			func: (willEnable: boolean) => {
				try {
					localStorage.setItem("ccx_enabled", willEnable ? "1" : "0");
					// 關閉時同步呼叫 content script 暴露的停止器，立即把 UI/觀察器收掉
					if (!willEnable && (window as any).__ccxChatCleanerStop) {
						(window as any).__ccxChatCleanerStop();
					}
				} catch (e) {
					console.error("[background] toggle error", e);
				}
			},
			args: [nextEnabled],
		});
	} catch {
		// 分頁不存在/無權限等情況下寫入可能失敗；忽略即可
	}
}

/** 同步單一分頁的徽章（以頁面狀態為準；非 ChatGPT 頁面清徽章） */
async function syncBadgeForTab(tab: chrome.tabs.Tab) {
	if (!tab.id) return;
	if (!isChatPage(tab.url)) {
		await clearBadge(tab.id);
		return;
	}
	try {
		const enabled = await readEnabledFromTab(tab.id);
		await setBadge(tab.id, enabled);
	} catch {
		// 讀不到狀態就清空徽章，避免殘留舊值
		await clearBadge(tab.id);
	}
}

/** 點擊工具列：切換並更新徽章；ON 時 reload 注入 content script */
chrome.action.onClicked.addListener(async (tab) => {
	if (!tab?.id || !isChatPage(tab.url)) return;

	const current = await readEnabledFromTab(tab.id);
	const next = !current;

	await writeEnabledToTab(tab.id, next);
	await setBadge(tab.id, next);

	if (next) {
		try {
			await chrome.tabs.reload(tab.id);
		} catch {}
	}
});

/** 分頁載入完成 → 刷徽章（僅 ChatGPT 網域才做；離開時清徽章） */
chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
	if (changeInfo.status !== "complete" || !tab?.id) return;
	if (isChatPage(tab.url)) {
		await syncBadgeForTab(tab);
	} else {
		await clearBadge(tab.id);
	}
});

/** 切換作用中分頁 → 刷徽章 */
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
	try {
		const tab = await chrome.tabs.get(tabId);
		await syncBadgeForTab(tab);
	} catch {}
});

/** 安裝 / 啟動 → 對所有現有分頁刷徽章 */
async function initBadges() {
	try {
		const tabs = await chrome.tabs.query({});
		for (const t of tabs) await syncBadgeForTab(t);
	} catch {}
}
chrome.runtime.onInstalled.addListener(initBadges);
chrome.runtime.onStartup?.addListener(initBadges);
