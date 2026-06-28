// src/content/runtime-diagnostics.ts
// Chat Cleaner - Runtime Diagnostics
// ------------------------------------------------------------
// 職責:
//   - 建立 selector、composer activity 與 native virtualization 診斷報告。
//   - 集中 debug-only DOM probes，避免 main.ts 了解探針細節。
//
// 邊界:
//   - 唯讀查詢 DOM，不排程 trim、不改設定、不建立頁面 UI。
// ------------------------------------------------------------

import {
	DEBUG_RUNTIME,
	PAGE_SELECTORS,
	UI_SELECTORS,
} from "./constants";
import { isMarkedHidden } from "./dom-utils";
import {
	sampleElements,
	type ActivityDebugReport,
	type SelectorDebugReport,
} from "./debug";
import type { ActivityGuardSnapshot } from "./activity-guard";
import type { LoadReadinessSnapshot } from "./load-readiness";
import type { Selectors } from "./types";

export function createRuntimeDiagnostics(opts: {
	selectors: Selectors;
	fallbackSelector: string;
	getActivitySnapshot: () => ActivityGuardSnapshot;
	getReadinessSnapshot: () => LoadReadinessSnapshot;
}) {
	const {
		selectors,
		fallbackSelector,
		getActivitySnapshot,
		getReadinessSnapshot,
	} = opts;
	const internalUiSelector = UI_SELECTORS.INTERNAL.join(",");

	function getTurnAuthor(el: Element): "user" | "assistant" | "other" {
		const role =
			el.getAttribute("data-turn") ||
			el.getAttribute("data-message-author-role") ||
			el.querySelector("[data-message-author-role]")?.getAttribute(
				"data-message-author-role"
			) ||
			"";

		if (role === "user" || role === "assistant") return role;
		return "other";
	}

	function hasContentVisibilitySignal(el: Element): boolean {
		const nodes = [el, ...Array.from(el.querySelectorAll("[class], [style]"))];
		return nodes.some((node) => {
			const html = node as HTMLElement;
			const className =
				typeof html.className === "string" ? html.className : "";
			return (
				html.style.contentVisibility === "auto" ||
				className.includes("content-visibility:auto")
			);
		});
	}

	function isComposerElement(el: Element | null): boolean {
		return !!(
			el &&
			!el.closest?.(internalUiSelector) &&
			(el.matches?.(PAGE_SELECTORS.COMPOSER) ||
				el.closest?.(PAGE_SELECTORS.COMPOSER))
		);
	}

	function sampleElement(label: string, el: Element | null) {
		if (!el) return null;
		return sampleElements([{ label, el }])[0] ?? null;
	}

	function getSelectorProbeCounts() {
		const readiness = getReadinessSnapshot();
		return {
			mainCount: document.querySelectorAll("main").length,
			threadCount: document.querySelectorAll(PAGE_SELECTORS.THREAD).length,
			turnIdCount: document.querySelectorAll("[data-turn-id]").length,
			turnAttrCount: document.querySelectorAll("[data-turn]").length,
			messageRoleCount: document.querySelectorAll("[data-message-author-role]")
				.length,
			conversationTestIdCount: document.querySelectorAll(
				'[data-testid*="conversation"]'
			).length,
			turnTestIdCount: document.querySelectorAll(
				'[data-testid^="conversation-turn-"]'
			).length,
			sectionTurnIdCount: document.querySelectorAll("section[data-turn-id]")
				.length,
			composerCandidateCount: document.querySelectorAll(
				PAGE_SELECTORS.COMPOSER
			).length,
			wrapperCount: readiness.wrapperCount,
			intersectingWrapperCount: readiness.intersectingWrapperCount,
			placeholderWrapperCount: readiness.placeholderWrapperCount,
		};
	}

	function getCandidateSamples() {
		const items: Array<{ label: string; el: Element }> = [];
		const addSamples = (label: string, selector: string, limit: number) => {
			items.push(
				...Array.from(document.querySelectorAll<Element>(selector))
					.slice(0, limit)
					.map((el) => ({ label, el }))
			);
		};

		addSamples(
			"turn-id",
			"[data-turn-id]",
			DEBUG_RUNTIME.CANDIDATE_GROUP_LIMIT
		);
		addSamples(
			"message-role",
			"[data-message-author-role]",
			DEBUG_RUNTIME.CANDIDATE_GROUP_LIMIT
		);
		addSamples(
			"conversation-testid",
			'[data-testid*="conversation"]',
			DEBUG_RUNTIME.CANDIDATE_GROUP_LIMIT
		);
		addSamples(
			"thread-main",
			`${PAGE_SELECTORS.THREAD}, main`,
			DEBUG_RUNTIME.SURFACE_SAMPLE_LIMIT
		);
		addSamples(
			"composer",
			PAGE_SELECTORS.COMPOSER,
			DEBUG_RUNTIME.SURFACE_SAMPLE_LIMIT
		);
		return sampleElements(items);
	}

	function explainActivity(): ActivityDebugReport {
		const snapshot = getActivitySnapshot();
		const activeElement =
			document.activeElement instanceof Element ? document.activeElement : null;

		return {
			active: snapshot.active,
			composing: snapshot.composing,
			activeUntil: snapshot.activeUntil,
			remainingMs: snapshot.remainingMs,
			composerSelector: PAGE_SELECTORS.COMPOSER,
			composerCandidateCount: document.querySelectorAll(
				PAGE_SELECTORS.COMPOSER
			).length,
			activeElementIsComposer: isComposerElement(activeElement),
			activeElement: sampleElement("activeElement", activeElement),
		};
	}

	function explainSelectors(): SelectorDebugReport {
		const readiness = getReadinessSnapshot();
		const primary = Array.from(
			document.querySelectorAll<Element>(selectors.LIST)
		);
		const fallback = Array.from(
			document.querySelectorAll<Element>(fallbackSelector)
		);
		const combined = Array.from(
			document.querySelectorAll<Element>(selectors.ALL)
		);
		const hiddenMarkedCount = combined.reduce(
			(count, el) => count + (isMarkedHidden(el) ? 1 : 0),
			0
		);
		const authorCounts = combined.reduce(
			(counts, el) => {
				counts[getTurnAuthor(el)]++;
				return counts;
			},
			{ user: 0, assistant: 0, other: 0 }
		);
		const contentVisibilityCount = combined.reduce(
			(count, el) => count + (hasContentVisibilitySignal(el) ? 1 : 0),
			0
		);

		return {
			primarySelector: selectors.LIST,
			fallbackSelector,
			combinedSelector: selectors.ALL,
			page: {
				href: location.href,
				readyState: document.readyState,
				title: document.title,
				bodyChildCount: document.body?.childElementCount ?? 0,
			},
			primaryCount: primary.length,
			fallbackCount: fallback.length,
			combinedCount: combined.length,
			probeCounts: getSelectorProbeCounts(),
			hiddenMarkedCount,
			visibleCount: combined.length - hiddenMarkedCount,
			authorCounts,
			contentVisibilityCount,
			virtualizationDetected: readiness.virtualizationDetected,
			loadReadiness: readiness,
			samples: sampleElements([
				...primary
					.slice(0, DEBUG_RUNTIME.CANDIDATE_GROUP_LIMIT)
					.map((el) => ({ label: "primary", el })),
				...fallback
					.slice(0, DEBUG_RUNTIME.CANDIDATE_GROUP_LIMIT)
					.map((el) => ({ label: "fallback", el })),
				...combined
					.slice(0, DEBUG_RUNTIME.CANDIDATE_GROUP_LIMIT)
					.map((el) => ({ label: "combined", el })),
			]),
			candidateSamples: getCandidateSamples(),
		};
	}

	return { explainActivity, explainSelectors };
}
