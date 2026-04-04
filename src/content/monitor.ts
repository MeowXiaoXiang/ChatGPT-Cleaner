// src/content/monitor.ts
// Chat Cleaner - Lightweight Monitor Panel
// ------------------------------------------------------------
// 設計目標：
//   - 以低負擔顯示即時狀態，而非提供完整分析圖表
//   - 保留最小介面契約：show / hide / destroy
//   - 僅顯示三個核心數值與兩個狀態膠囊
// ------------------------------------------------------------

import { MONITOR } from "./constants";

export type MonitorApi = {
	getMetrics: () => {
		debounceDelay: number;
		trimAvgMs: number;
		longTaskRateEMA: number;
		longTaskAvgMsEMA: number;
		ltThresholds: {
			enterRate: number;
			exitRate: number;
			enterAvg: number;
			exitAvg: number;
			minSuspendMs: number;
		};
		suspended: boolean;
		maxKeep: number;
		mode: "hide" | "delete";
		stats: { domRemoved: number; hiddenNow: number; removedNow: number };
	};
};

export type MonitorController = {
	showPanel: () => void;
	hidePanel: () => void;
	destroy: () => void;
};

const REFRESH_MS = MONITOR.REFRESH_MS;

const COLOR = {
	bgGlass: "rgba(17, 17, 20, 0.2)",
	stroke: "rgba(255, 255, 255, 0.18)",
	text: "#ffffff",
	sub: "#d4d4d8",
	ok: "#10b981",
	warn: "#f59e0b",
	bad: "#ef4444",
	info: "#38bdf8",
	cardBg: "rgba(255,255,255,0.07)",
	chipBg: "rgba(255,255,255,0.08)",
} as const;

type MetricLevel = "ok" | "warn" | "bad";

type RenderSnapshot = {
	ltAvgText: string;
	ltAvgLevel: MetricLevel;
	ltRateText: string;
	ltRateLevel: MetricLevel;
	trimAvgText: string;
	trimAvgLevel: MetricLevel;
	countLabel: string;
	countValue: string;
	suspended: boolean;
	statusText: string;
};

function classifyMetric(
	value: number,
	goodMax: number,
	warnMax: number,
): "ok" | "warn" | "bad" {
	if (value <= goodMax) return "ok";
	if (value <= warnMax) return "warn";
	return "bad";
}

export function mountMonitor(api: MonitorApi): MonitorController {
	document.getElementById("ccx-monitor")?.remove();
	document.getElementById("ccx-monitor-style")?.remove();

	let root: HTMLDivElement | null = null;
	let styleEl: HTMLStyleElement | null = null;
	let timer: number | null = null;
	let lastRendered: RenderSnapshot | null = null;

	let dragging = false;
	let dragOffX = 0;
	let dragOffY = 0;

	const styleText = `
	#ccx-monitor{
		position:fixed;
		z-index:900;
		left:16px;
		top:72px;
	}
	#ccx-monitor .card{
		width:auto;
		max-width:min(560px, calc(100vw - 24px));
		display:flex;
		flex-direction:column;
		gap:8px;
		padding:8px;
		border-radius:14px;
		border:1px solid ${COLOR.stroke};
		background:${COLOR.bgGlass};
		backdrop-filter:saturate(1.05) blur(3px);
		box-shadow:0 10px 28px rgba(0,0,0,0.32);
		color:${COLOR.text};
		text-shadow:0 1px 2px rgba(0,0,0,0.26);
	}
	#ccx-monitor .head{
		display:flex;
		align-items:center;
		gap:8px;
		cursor:move;
		user-select:none;
	}
	#ccx-monitor .title{
		font:600 12px/1.2 ui-sans-serif,system-ui;
		letter-spacing:.02em;
		margin-right:8px;
	}
	#ccx-monitor .grow{flex:1}
	#ccx-monitor .head-chips{
		display:flex;
		align-items:center;
		gap:6px;
	}
	#ccx-monitor .btn{
		appearance:none;
		border:1px solid ${COLOR.stroke};
		background:transparent;
		color:${COLOR.text};
		border-radius:10px;
		padding:5px 7px;
		cursor:pointer;
		font-size:12px;
	}
	#ccx-monitor .btn:hover{border-color:rgba(255,255,255,0.3)}
	#ccx-monitor .metrics{
		display:grid;
		grid-template-columns:repeat(3, minmax(0, 1fr));
		gap:6px;
	}
	#ccx-monitor .metric{
		min-width:0;
		padding:7px 9px;
		border-radius:11px;
		border:1px solid rgba(255,255,255,0.14);
		background:${COLOR.cardBg};
		display:flex;
		flex-direction:column;
		gap:2px;
	}
	#ccx-monitor .metric .label{
		font:600 10px/1.15 ui-sans-serif,system-ui;
		color:${COLOR.sub};
	}
	#ccx-monitor .metric .value{
		font:700 14px/1.05 ui-sans-serif,system-ui;
		font-variant-numeric:tabular-nums;
		white-space:nowrap;
		overflow:hidden;
		text-overflow:ellipsis;
	}
	#ccx-monitor .metric.ok .value{color:${COLOR.ok}}
	#ccx-monitor .metric.warn .value{color:${COLOR.warn}}
	#ccx-monitor .metric.bad .value{color:${COLOR.bad}}
	#ccx-monitor .chip{
		display:flex;
		align-items:center;
		justify-content:space-between;
		gap:8px;
		min-height:34px;
		padding:0 10px;
		border-radius:999px;
		border:1px solid rgba(255,255,255,0.16);
		background:${COLOR.chipBg};
		font:600 11px/1 ui-sans-serif,system-ui;
		color:${COLOR.text};
		white-space:nowrap;
		width:auto;
		max-width:100%;
	}
	#ccx-monitor .chip .chip-label{
		font:600 10px/1 ui-sans-serif,system-ui;
		color:${COLOR.sub};
	}
	#ccx-monitor .chip .chip-value{
		font:700 12px/1 ui-sans-serif,system-ui;
		font-variant-numeric:tabular-nums;
	}
	#ccx-monitor .chip.status.ok{
		color:${COLOR.ok};
		border-color:${COLOR.ok}55;
		background:${COLOR.ok}1f;
	}
	#ccx-monitor .chip.status.bad{
		color:${COLOR.bad};
		border-color:${COLOR.bad}55;
		background:${COLOR.bad}1f;
	}
	@media (max-width: 720px){
		#ccx-monitor{
			top:56px;
			left:12px;
			right:12px;
			transform:none;
		}
		#ccx-monitor .card{
			width:auto;
		}
		#ccx-monitor .head{
			flex-wrap:wrap;
		}
		#ccx-monitor .head-chips{
			order:3;
			width:100%;
			justify-content:flex-start;
			flex-wrap:wrap;
		}
		#ccx-monitor .metrics{
			grid-template-columns:1fr;
		}
	}`;

	function injectStyle() {
		if (styleEl) return;
		styleEl = document.createElement("style");
		styleEl.id = "ccx-monitor-style";
		styleEl.textContent = styleText;
		document.head.appendChild(styleEl);
	}

	function removeStyle() {
		styleEl?.remove();
		styleEl = null;
	}

	root = document.createElement("div");
	root.id = "ccx-monitor";
	root.innerHTML = `
		<div class="card" role="dialog" aria-label="Monitor Panel">
			<div class="head" id="ccx-drag-handle">
				<div class="title">Chat Cleaner Monitor</div>
				<div class="grow"></div>
				<div class="head-chips">
					<div class="chip count" id="ccx-chip-count">
						<span class="chip-label">Removed</span>
						<span class="chip-value">0</span>
					</div>
					<div class="chip status ok" id="ccx-chip-status">
						<span class="chip-value">✨ Running</span>
					</div>
				</div>
				<button class="btn" id="ccx-close" aria-label="Close">✕</button>
			</div>
			<div class="metrics">
				<div class="metric" data-metric="ltAvg">
					<div class="label">LongTask Avg</div>
					<div class="value">0.0 ms</div>
				</div>
				<div class="metric" data-metric="ltRate">
					<div class="label">LongTask Rate</div>
					<div class="value">0.00 /s</div>
				</div>
				<div class="metric" data-metric="trimAvg">
					<div class="label">Trim Avg</div>
					<div class="value">0.0 ms</div>
				</div>
			</div>
		</div>`;

	const get = <T extends HTMLElement>(sel: string) =>
		root!.querySelector(sel) as T;
	const cardEl = () => get<HTMLDivElement>(".card");
	const closeBtn = () => get<HTMLButtonElement>("#ccx-close");
	const dragHandleEl = () => get<HTMLDivElement>("#ccx-drag-handle");
	const countChipEl = () => get<HTMLDivElement>("#ccx-chip-count");
	const statusChipEl = () => get<HTMLDivElement>("#ccx-chip-status");

	function updateText(el: Element | null, next: string) {
		if (!el || el.textContent === next) return;
		el.textContent = next;
	}

	function setMetric(
		key: "ltAvg" | "ltRate" | "trimAvg",
		text: string,
		level: MetricLevel,
	) {
		const el = root!.querySelector(
			`[data-metric="${key}"]`,
		) as HTMLDivElement | null;
		if (!el) return;
		const nextClass = `metric ${level}`;
		if (el.className !== nextClass) {
			el.className = nextClass;
		}
		const valueEl = el.querySelector(".value");
		updateText(valueEl, text);
	}

	function updateCountChip(labelText: string, valueText: string) {
		const label = countChipEl().querySelector(".chip-label");
		const value = countChipEl().querySelector(".chip-value");
		if (!label || !value) return;
		updateText(label, labelText);
		updateText(value, valueText);
	}

	function updateStatusChip(suspended: boolean, statusText: string) {
		const chip = statusChipEl();
		const value = chip.querySelector(".chip-value");
		const nextClass = `chip status ${suspended ? "bad" : "ok"}`;
		if (chip.className !== nextClass) {
			chip.className = nextClass;
		}
		updateText(value, statusText);
	}

	function refresh() {
		const m = api.getMetrics();
		const ltAvgText = `${Number(m.longTaskAvgMsEMA ?? 0).toFixed(1)} ms`;
		const ltAvgLevel = classifyMetric(
			Number(m.longTaskAvgMsEMA ?? 0),
			m.ltThresholds.exitAvg,
			m.ltThresholds.enterAvg,
		);
		const ltRateText = `${Number(m.longTaskRateEMA ?? 0).toFixed(2)} /s`;
		const ltRateLevel = classifyMetric(
			Number(m.longTaskRateEMA ?? 0),
			m.ltThresholds.exitRate,
			m.ltThresholds.enterRate,
		);
		const trimAvgText = `${Number(m.trimAvgMs ?? 0).toFixed(1)} ms`;
		const trimAvgLevel = classifyMetric(Number(m.trimAvgMs ?? 0), 8, 16);
		const countLabel = m.mode === "hide" ? "Hidden" : "Removed";
		const countValue = String(
			m.mode === "hide" ? (m.stats?.hiddenNow ?? 0) : (m.stats?.removedNow ?? 0),
		);
		const suspended = !!m.suspended;
		const statusText = suspended ? "⚡ Suspend" : "✨ Running";
		const nextSnapshot: RenderSnapshot = {
			ltAvgText,
			ltAvgLevel,
			ltRateText,
			ltRateLevel,
			trimAvgText,
			trimAvgLevel,
			countLabel,
			countValue,
			suspended,
			statusText,
		};

		if (
			!lastRendered ||
			lastRendered.ltAvgText !== nextSnapshot.ltAvgText ||
			lastRendered.ltAvgLevel !== nextSnapshot.ltAvgLevel
		) {
			setMetric("ltAvg", nextSnapshot.ltAvgText, nextSnapshot.ltAvgLevel);
		}

		if (
			!lastRendered ||
			lastRendered.ltRateText !== nextSnapshot.ltRateText ||
			lastRendered.ltRateLevel !== nextSnapshot.ltRateLevel
		) {
			setMetric("ltRate", nextSnapshot.ltRateText, nextSnapshot.ltRateLevel);
		}

		if (
			!lastRendered ||
			lastRendered.trimAvgText !== nextSnapshot.trimAvgText ||
			lastRendered.trimAvgLevel !== nextSnapshot.trimAvgLevel
		) {
			setMetric("trimAvg", nextSnapshot.trimAvgText, nextSnapshot.trimAvgLevel);
		}

		if (
			!lastRendered ||
			lastRendered.countLabel !== nextSnapshot.countLabel ||
			lastRendered.countValue !== nextSnapshot.countValue
		) {
			updateCountChip(nextSnapshot.countLabel, nextSnapshot.countValue);
		}

		if (
			!lastRendered ||
			lastRendered.suspended !== nextSnapshot.suspended ||
			lastRendered.statusText !== nextSnapshot.statusText
		) {
			updateStatusChip(nextSnapshot.suspended, nextSnapshot.statusText);
		}

		lastRendered = nextSnapshot;
	}

	function startTimer() {
		if (timer != null) return;
		refresh();
		timer = window.setInterval(refresh, REFRESH_MS) as any;
	}

	function stopTimer() {
		if (timer != null) {
			clearInterval(timer);
			timer = null;
		}
	}

	function onVisibilityChange() {
		if (!root?.isConnected) return;
		if (document.visibilityState === "hidden") {
			stopTimer();
		} else {
			startTimer();
		}
	}

	function clampIntoViewport(x: number, y: number) {
		const margin = 8;
		const rect = cardEl().getBoundingClientRect();
		const maxX = Math.max(margin, window.innerWidth - rect.width - margin);
		const maxY = Math.max(
			margin,
			window.innerHeight - rect.height - margin,
		);
		return {
			x: Math.min(Math.max(margin, x), maxX),
			y: Math.min(Math.max(margin, y), maxY),
		};
	}

	function centerPanel() {
		const rect = cardEl().getBoundingClientRect();
		const x = Math.max(8, Math.floor((window.innerWidth - rect.width) / 2));
		const y = Math.max(
			8,
			Math.min(72, window.innerHeight - rect.height - 8),
		);
		root!.style.left = `${x}px`;
		root!.style.top = `${y}px`;
		root!.style.right = "auto";
		root!.style.transform = "";
	}

	function onWindowResize() {
		if (!root?.isConnected) return;
		const rect = root.getBoundingClientRect();
		const p = clampIntoViewport(rect.left, rect.top);
		root.style.left = `${p.x}px`;
		root.style.top = `${p.y}px`;
		root.style.right = "auto";
		root.style.transform = "";
	}

	function beginDrag(x: number, y: number) {
		const rect = root!.getBoundingClientRect();
		dragging = true;
		dragOffX = x - rect.left;
		dragOffY = y - rect.top;
		document.body.style.userSelect = "none";
		document.addEventListener("mousemove", onDrag);
		document.addEventListener("mouseup", onDrop);
	}

	function onDrag(e: MouseEvent) {
		if (!dragging || !root) return;
		e.preventDefault();
		const p = clampIntoViewport(e.clientX - dragOffX, e.clientY - dragOffY);
		root.style.left = `${p.x}px`;
		root.style.top = `${p.y}px`;
		root.style.right = "auto";
		root.style.transform = "";
	}

	function onDrop() {
		if (!dragging) return;
		dragging = false;
		document.body.style.userSelect = "";
		document.removeEventListener("mousemove", onDrag);
		document.removeEventListener("mouseup", onDrop);
	}

	function showPanel() {
		if (!root || root.isConnected) return;
		injectStyle();
		document.body.appendChild(root);
		centerPanel();
		requestAnimationFrame(() => centerPanel());
		startTimer();
		window.addEventListener("resize", onWindowResize, { passive: true });
		document.addEventListener("visibilitychange", onVisibilityChange);
	}

	function hidePanel() {
		stopTimer();
		onDrop();
		lastRendered = null;
		window.removeEventListener("resize", onWindowResize as any);
		document.removeEventListener(
			"visibilitychange",
			onVisibilityChange as any,
		);
		root?.remove();
		removeStyle();
	}

	function destroy() {
		hidePanel();
		root = null;
	}

	closeBtn().addEventListener("click", hidePanel);
	dragHandleEl().addEventListener("mousedown", (e) => {
		const target = e.target as HTMLElement;
		if (target.closest("#ccx-close")) return;
		e.preventDefault();
		beginDrag(e.clientX, e.clientY);
	});

	return { showPanel, hidePanel, destroy };
}
