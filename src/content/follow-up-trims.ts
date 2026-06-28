// src/content/follow-up-trims.ts
// Chat Cleaner - Follow-Up Trims
// ------------------------------------------------------------
// 職責:
//   - 在 observer init / route change 後排少量延遲檢查。
//   - 處理 ChatGPT 長對話分批 render 導致的後續 turn 進場。
//
// 邊界:
//   - 不直接 trim，只呼叫 main.ts 提供的排程入口。
// ------------------------------------------------------------

import type { LogFn } from "./types";
import { FOLLOW_UP_TRIMS } from "./constants";

export interface FollowUpTrims {
	schedule(reason: string): void;
	cancel(): void;
	dispose(): void;
}

export function createFollowUpTrims(opts: {
	log: LogFn;
	runCheck: (reason: string) => void;
	delaysMs?: readonly number[];
}): FollowUpTrims {
	const { log, runCheck, delaysMs = FOLLOW_UP_TRIMS.DELAYS_MS } = opts;
	const timers = new Set<ReturnType<typeof setTimeout>>();

	function cancel() {
		for (const timer of timers) clearTimeout(timer);
		timers.clear();
	}

	function schedule(reason: string) {
		cancel();
		for (const delay of delaysMs) {
			const timer = setTimeout(() => {
				timers.delete(timer);
				log(`follow-up trim check [${reason}] after ${delay}ms`);
				runCheck(`followUp:${reason}`);
			}, delay);
			timers.add(timer);
		}
	}

	function dispose() {
		cancel();
	}

	return { schedule, cancel, dispose };
}
