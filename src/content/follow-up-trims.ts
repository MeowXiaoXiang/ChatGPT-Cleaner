import type { LogFn } from "./types";

const DEFAULT_DELAYS_MS = [800, 1800, 3500, 6000] as const;

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
	const { log, runCheck, delaysMs = DEFAULT_DELAYS_MS } = opts;
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
