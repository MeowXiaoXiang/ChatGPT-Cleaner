// src/content/settings-store.ts
// Chat Cleaner - Settings Store
// ------------------------------------------------------------
// 職責:
//   - 集中讀寫 ccx_* localStorage 設定。
//   - 正規化設定值，讓 main.ts 使用穩定的 Settings 物件。
//
// 邊界:
//   - 不觸碰 UI，也不執行 trim。
// ------------------------------------------------------------

import { DEFAULT_MAX_KEEP, DEFAULT_MODE } from "./constants";
import type { ApplyPayload, Mode, Settings } from "./types";

function readBooleanFlag(key: string, offValue = "0"): boolean {
	return localStorage.getItem(key) !== offValue;
}

function readDebugFlag(): boolean {
	return localStorage.getItem("ccx_debug") === "1";
}

function readMaxKeep(): number {
	const raw = localStorage.getItem("ccx_max_keep") || String(DEFAULT_MAX_KEEP);
	const parsed = parseInt(raw, 10);
	return Math.max(1, Number.isFinite(parsed) ? parsed : DEFAULT_MAX_KEEP);
}

function readMode(): Mode {
	const mode = localStorage.getItem("ccx_mode");
	return mode === "delete" || mode === "hide" ? mode : DEFAULT_MODE;
}

function readNotify(): boolean {
	return localStorage.getItem("ccx_notify") !== "0";
}

export function readRuntimeFlags(): Pick<Settings, "enabled" | "debug"> {
	return {
		enabled: readBooleanFlag("ccx_enabled"),
		debug: readDebugFlag(),
	};
}

export function readSettings(): Settings {
	const flags = readRuntimeFlags();
	return {
		maxKeep: readMaxKeep(),
		notify: readNotify(),
		mode: readMode(),
		enabled: flags.enabled,
		debug: flags.debug,
	};
}

export function persistSettings(next: ApplyPayload): Settings {
	const maxKeep = Math.max(1, Math.floor(next.maxKeep));
	const mode: Mode = next.mode === "delete" ? "delete" : "hide";
	const notify = !!next.notify;

	localStorage.setItem("ccx_max_keep", String(maxKeep));
	localStorage.setItem("ccx_mode", mode);
	localStorage.setItem("ccx_notify", notify ? "1" : "0");

	return {
		maxKeep,
		mode,
		notify,
		...readRuntimeFlags(),
	};
}
