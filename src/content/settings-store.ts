// src/content/settings-store.ts
// Chat Cleaner - Settings Store
// ------------------------------------------------------------
// 職責:
//   - 集中讀寫 extension 專用的 chrome.storage.local 設定。
//   - 正規化設定值，讓 main.ts 使用穩定的 Settings 物件。
//
// 邊界:
//   - 不觸碰 UI，也不執行 trim。
// ------------------------------------------------------------

import { DEFAULT_MAX_KEEP, DEFAULT_MODE } from "./constants";
import type { ApplyPayload, Mode, Settings } from "./types";

interface StoredSettings {
	maxKeep: number;
	mode: Mode;
	notify: boolean;
	enabled: boolean;
	debug: boolean;
}

const DEFAULT_STORED_SETTINGS: StoredSettings = {
	maxKeep: DEFAULT_MAX_KEEP,
	mode: DEFAULT_MODE,
	notify: true,
	enabled: true,
	debug: false,
};

function getStorageArea(): chrome.storage.StorageArea | null {
	return chrome?.storage?.local ?? null;
}

function storageGet<T extends object>(defaults: T): Promise<T> {
	const storage = getStorageArea();
	if (!storage) return Promise.resolve(defaults);

	return new Promise((resolve) => {
		storage.get(defaults, (items) => {
			if (chrome.runtime.lastError) {
				console.warn(
					"[chat-cleaner] storage read failed",
					chrome.runtime.lastError.message
				);
				resolve(defaults);
				return;
			}
			resolve(items as T);
		});
	});
}

function storageSet(items: Partial<StoredSettings>): Promise<void> {
	const storage = getStorageArea();
	if (!storage) return Promise.resolve();

	return new Promise((resolve, reject) => {
		storage.set(items, () => {
			if (chrome.runtime.lastError) {
				reject(new Error(chrome.runtime.lastError.message));
				return;
			}
			resolve();
		});
	});
}

function normalizeMaxKeep(value: unknown): number {
	const parsed =
		typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
	return Math.max(1, Number.isFinite(parsed) ? Math.floor(parsed) : DEFAULT_MAX_KEEP);
}

function normalizeMode(value: unknown): Mode {
	return value === "delete" || value === "hide" ? value : DEFAULT_MODE;
}

function normalizeStoredSettings(input: Partial<StoredSettings>): StoredSettings {
	return {
		maxKeep: normalizeMaxKeep(input.maxKeep),
		mode: normalizeMode(input.mode),
		notify: typeof input.notify === "boolean" ? input.notify : true,
		enabled: typeof input.enabled === "boolean" ? input.enabled : true,
		debug: typeof input.debug === "boolean" ? input.debug : false,
	};
}

async function readStoredSettings(): Promise<StoredSettings> {
	const stored = await storageGet(DEFAULT_STORED_SETTINGS);
	return normalizeStoredSettings(stored);
}

export async function readRuntimeFlags(): Promise<Pick<Settings, "enabled" | "debug">> {
	const stored = await readStoredSettings();
	return {
		enabled: stored.enabled,
		debug: stored.debug,
	};
}

export async function readSettings(): Promise<Settings> {
	const stored = await readStoredSettings();
	return {
		maxKeep: stored.maxKeep,
		notify: stored.notify,
		mode: stored.mode,
		enabled: stored.enabled,
		debug: stored.debug,
	};
}

export async function setCleanerEnabled(enabled: boolean): Promise<void> {
	await storageSet({ enabled });
}

export async function setDebugEnabled(debug: boolean): Promise<void> {
	await storageSet({ debug });
}

export async function persistSettings(next: ApplyPayload): Promise<Settings> {
	const maxKeep = normalizeMaxKeep(next.maxKeep);
	const mode: Mode = next.mode === "delete" ? "delete" : "hide";
	const notify = !!next.notify;

	await storageSet({ maxKeep, mode, notify });

	return {
		maxKeep,
		mode,
		notify,
		...(await readRuntimeFlags()),
	};
}
