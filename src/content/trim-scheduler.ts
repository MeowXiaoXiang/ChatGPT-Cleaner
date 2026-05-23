// src/content/trim-scheduler.ts
// Chat Cleaner - Trim Scheduler
// ------------------------------------------------------------
// 職責:
//   - 管理 trim 的 idle 排程、取消、resume pending 與 debounce 調速。
//   - 量測單次 trim 成本並更新 trim average。
//
// 邊界:
//   - 不決定 trim 策略，也不操作 DOM；實際 trim 由 main.ts callback 執行。
// ------------------------------------------------------------

import { DEBOUNCE, TRIM_THRESHOLD } from "./constants";
import { cancelIdle, IdleHandle, requestIdle } from "./idle-utils";
import type { LogFn } from "./types";

export interface TrimScheduleOptions {
	manual?: boolean;
	observedCount?: number;
}

export interface TrimSchedulerSnapshot {
	scheduled: boolean;
	manual: boolean;
	trimAvgMs: number;
	delay: number;
}

export interface PendingTrim {
	pending: boolean;
	manual: boolean;
}

export interface TrimScheduler {
	schedule(reason?: string, opts?: TrimScheduleOptions): void;
	cancel(): void;
	queueAfterResume(opts?: { manual?: boolean }): void;
	consumePendingAfterResume(): PendingTrim;
	getSnapshot(): TrimSchedulerSnapshot;
	dispose(): void;
}

function ema(previous: number | null | undefined, current: number, alpha: number) {
	return previous == null ? current : previous * (1 - alpha) + current * alpha;
}

export function createTrimScheduler(opts: {
	runTrim: (reason: string, opts: TrimScheduleOptions) => void;
	isSuspended: () => boolean;
	isWakeCoolingDown: () => boolean;
	log: LogFn;
}): TrimScheduler {
	const { runTrim, isSuspended, isWakeCoolingDown, log } = opts;
	const debounce: {
		delay: number;
		min: number;
		max: number;
		emaAlpha: number;
		trimAvgMs: number;
	} = {
		delay: DEBOUNCE.DELAY_INIT,
		min: DEBOUNCE.DELAY_MIN,
		max: DEBOUNCE.DELAY_MAX,
		emaAlpha: DEBOUNCE.EMA_ALPHA,
		trimAvgMs: 0,
	};

	let scheduled = false;
	let scheduledTrimManual = false;
	let idleId: IdleHandle | null = null;
	let timerId: ReturnType<typeof setTimeout> | null = null;
	let pendingTrimAfterResume = false;
	let pendingTrimManual = false;

	function autoTuneDebounce(reason: string) {
		const prev = debounce.delay;

		if (debounce.trimAvgMs > TRIM_THRESHOLD.SLOW_MS) {
			debounce.delay = Math.min(
				debounce.max,
				Math.round(debounce.delay + TRIM_THRESHOLD.STEP_UP_MS)
			);
		} else if (debounce.trimAvgMs < TRIM_THRESHOLD.SLOW_MS * (2 / 3)) {
			debounce.delay = Math.max(
				debounce.min,
				Math.round(debounce.delay - TRIM_THRESHOLD.STEP_DOWN_MS)
			);
		}

		if (debounce.delay !== prev) {
			log(
				`debounce=${
					debounce.delay
				}ms [${reason}] | trim=${debounce.trimAvgMs.toFixed(2)}ms`
			);
		}
	}

	function cancel() {
		if (idleId != null) {
			cancelIdle(idleId);
			idleId = null;
		}
		if (timerId != null) {
			clearTimeout(timerId);
			timerId = null;
		}
		scheduled = false;
		scheduledTrimManual = false;
	}

	function queueAfterResume(options: { manual?: boolean } = {}) {
		pendingTrimAfterResume = true;
		pendingTrimManual = pendingTrimManual || !!options.manual;
	}

	function consumePendingAfterResume(): PendingTrim {
		const pending = pendingTrimAfterResume;
		const manual = pendingTrimManual;
		pendingTrimAfterResume = false;
		pendingTrimManual = false;
		return { pending, manual };
	}

	function schedule(
		reason = "mutation",
		options: TrimScheduleOptions = {}
	) {
		if (scheduled) return;
		if (isSuspended()) {
			queueAfterResume({ manual: options.manual });
			log(`skip schedule [${reason}] (suspended)`);
			return;
		}
		if (isWakeCoolingDown()) {
			log(`skip schedule [${reason}] (wakeCooldown)`);
			return;
		}

		scheduled = true;
		scheduledTrimManual = !!options.manual;
		log(`scheduleTrim [${reason}] delay=${debounce.delay}ms`);

		const run = () => {
			cancel();

			const t0 = performance.now();
			runTrim(reason, options);
			const t1 = performance.now();

			debounce.trimAvgMs = ema(
				debounce.trimAvgMs,
				t1 - t0,
				debounce.emaAlpha
			);
			autoTuneDebounce("afterTrim");
		};

		idleId = requestIdle(run, { timeout: debounce.delay });
		timerId = setTimeout(() => {
			if (scheduled) {
				cancelIdle(idleId);
				idleId = null;
				run();
			}
		}, debounce.max);
	}

	function getSnapshot(): TrimSchedulerSnapshot {
		return {
			scheduled,
			manual: scheduledTrimManual,
			trimAvgMs: debounce.trimAvgMs,
			delay: debounce.delay,
		};
	}

	function dispose() {
		cancel();
		pendingTrimAfterResume = false;
		pendingTrimManual = false;
	}

	return {
		schedule,
		cancel,
		queueAfterResume,
		consumePendingAfterResume,
		getSnapshot,
		dispose,
	};
}
