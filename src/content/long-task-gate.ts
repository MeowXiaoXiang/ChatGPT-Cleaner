// src/content/long-task-gate.ts
// Chat Cleaner - Long Task Gate
// ------------------------------------------------------------
// 職責:
//   - 監測 Long Task 壓力並以 hysteresis 管理 suspended 狀態。
//   - 提供狀態快照與 transition 訂閱，讓排程器決定如何暫停/恢復。
//
// 邊界:
//   - 不直接操作 trim scheduler、DOM 或 UI。
// ------------------------------------------------------------

import { LONG_TASK } from "./constants";
import type { LogFn } from "./types";

export interface LongTaskGateSnapshot {
	supported: boolean;
	suspended: boolean;
	rateEMA: number;
	avgDurationEMA: number;
	thresholds: {
		enterRate: number;
		exitRate: number;
		enterAvg: number;
		exitAvg: number;
	};
}

export interface LongTaskGate {
	readonly suspended: boolean;
	getSnapshot(): LongTaskGateSnapshot;
	subscribe(listener: (snapshot: LongTaskGateSnapshot) => void): () => void;
	dispose(): void;
}

function ema(previous: number, current: number, alpha: number) {
	return previous * (1 - alpha) + current * alpha;
}

export function createLongTaskGate(opts: { log: LogFn }): LongTaskGate {
	const { log } = opts;
	const supported =
		"PerformanceObserver" in window &&
		((PerformanceObserver as typeof PerformanceObserver & {
			supportedEntryTypes?: readonly string[];
		}).supportedEntryTypes ?? []
		).includes("longtask");

	let countWindow = 0;
	let durationWindow = 0;
	let rateEMA = 0;
	let avgDurationEMA = 0;
	let suspended = false;
	let enteredAt = 0;
	let observer: PerformanceObserver | null = null;
	let bucketTimer: ReturnType<typeof setInterval> | null = null;
	const listeners = new Set<(snapshot: LongTaskGateSnapshot) => void>();

	function getSnapshot(): LongTaskGateSnapshot {
		return {
			supported,
			suspended,
			rateEMA,
			avgDurationEMA,
			thresholds: {
				enterRate: LONG_TASK.ENTER_RATE,
				exitRate: LONG_TASK.EXIT_RATE,
				enterAvg: LONG_TASK.ENTER_AVG,
				exitAvg: LONG_TASK.EXIT_AVG,
			},
		};
	}

	function publish() {
		const snapshot = getSnapshot();
		for (const listener of listeners) {
			try {
				listener(snapshot);
			} catch (error) {
				log("long-task transition listener failed", error);
			}
		}
	}

	function flushBucket() {
		if (document.visibilityState !== "visible") {
			countWindow = 0;
			durationWindow = 0;
			return;
		}

		const count = countWindow;
		const average = count ? durationWindow / count : 0;
		countWindow = 0;
		durationWindow = 0;

		rateEMA = ema(rateEMA, count, LONG_TASK.ALPHA_RATE);
		avgDurationEMA = ema(
			avgDurationEMA,
			average,
			LONG_TASK.ALPHA_DUR
		);

		if (count === 0) {
			rateEMA *= LONG_TASK.DECAY;
			avgDurationEMA *= LONG_TASK.DECAY;
		}

		const shouldEnter =
			supported &&
			!suspended &&
			(rateEMA >= LONG_TASK.ENTER_RATE ||
				avgDurationEMA >= LONG_TASK.ENTER_AVG);
		const shouldExit =
			suspended &&
			Date.now() - enteredAt >= LONG_TASK.MIN_SUSPEND_MS &&
			rateEMA < LONG_TASK.EXIT_RATE &&
			avgDurationEMA < LONG_TASK.EXIT_AVG;

		if (shouldEnter) {
			suspended = true;
			enteredAt = Date.now();
			log(
				`storm/suspend ON | longTask rateEMA=${rateEMA.toFixed(
					2
				)}/s avg=${avgDurationEMA.toFixed(1)}ms`
			);
			publish();
		} else if (shouldExit) {
			suspended = false;
			log(
				`storm/suspend OFF | longTask rateEMA=${rateEMA.toFixed(
					2
				)}/s avg=${avgDurationEMA.toFixed(1)}ms`
			);
			publish();
		}
	}

	if (supported) {
		observer = new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				countWindow++;
				durationWindow += entry.duration || 0;
			}
		});
		try {
			observer.observe({ type: "longtask", buffered: true } as PerformanceObserverInit);
		} catch {
			observer.observe({ entryTypes: ["longtask"] });
		}
	} else {
		log("Long Task not supported; gate will never suspend.");
	}

	bucketTimer = setInterval(flushBucket, LONG_TASK.BUCKET_MS);

	return {
		get suspended() {
			return suspended;
		},
		getSnapshot,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		dispose() {
			if (bucketTimer != null) {
				clearInterval(bucketTimer);
				bucketTimer = null;
			}
			observer?.disconnect();
			observer = null;
			listeners.clear();
		},
	};
}
