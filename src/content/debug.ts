// src/content/debug.ts
// Chat Cleaner - Debug Panel
// ------------------------------------------------------------
// 功能職責 (Responsibilities):
//   - 提供即時監控面板：顯示 LongTask 與 Trim 的指標
//   - 提供 KPI 卡片、雙軸圖表、門檻資訊與設定狀態
//   - 支援互動：拖曳、調整寬度、hover 提示、開關圖例
//
// 主要職能 (Key Functions):
//   - mountDebug(api): 掛載並管理 Debug 面板
//   - showPanel / hidePanel / destroy
//   - draw(): Canvas 雙 Y 軸繪圖（Trim Avg / LongTask Avg / LongTask Rate）
//   - rebuildLegend(): 動態生成圖例，支援開關曲線
//   - layout(): 自適應尺寸與 HiDPI 支援
//
// 設計要點 (Design Notes):
//   - 圖表背景門檻線可離屏繪製 (offscreen buffer)，降低更新成本
//   - RWD：窄螢幕自動緊湊模式（KPI 卡片不換行）
//   - 拖曳與 resize 含邊界夾束，避免面板超出視窗
//   - Chip 狀態顯示 Running / Suspend，連動 stormGate 狀態
// ------------------------------------------------------------

export type DebugApi = {
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
		stats: { domRemoved: number };
	};
	forceTrim: () => void;
	forceTrimNow: () => void;
};

export type DebugController = {
	showPanel: () => void;
	hidePanel: () => void;
	destroy: () => void;
};

// ===== 常數 =====
const REFRESH_MS = 1000;
const MAX_POINTS = 240;

// 調色盤：暗色主題 + 低彩度
const COLOR = {
	bgGlass: "rgba(24,24,27,0.72)",
	stroke: "rgba(250,250,250,0.12)",
	text: "#fafafa",
	sub: "#a1a1aa",
	ok: "#10b981",
	warn: "#f59e0b",
	susp: "#ef4444",
	info: "#38bdf8",
	trim: "#60a5fa", // TrimAvg (ms) - 左軸
	ltAvg: "#f59e0b", // LongTask Avg (ms) - 左軸
	ltRate: "#34d399", // LongTask Rate (/s) - 右軸
	thrRateEnter: "#22d3ee", // 右軸 enter rate
	thrRateExit: "#a78bfa", // 右軸 exit rate
	thrAvgEnter: "#fb7185", // 左軸 enter avg
	thrAvgExit: "#fbbf24", // 左軸 exit avg
};

// RWD 參數
const CH_MIN = 96;
const CH_MAX = 240;

// 是否啟用離屏緩衝（提升繪圖效能）
const USE_BUFFER_BG = true;

// ===== 工具：循環佇列 =====
function makeQueue(cap = MAX_POINTS) {
	const buf: number[] = [];
	return {
		push(v: number) {
			buf.push(v);
			while (buf.length > cap) buf.shift();
		},
		values() {
			return buf.slice();
		},
		clear() {
			buf.length = 0;
		},
		last() {
			return buf.length ? buf[buf.length - 1] : 0;
		},
	};
}

// ===== 內部狀態類型 =====
interface State {
	visible: boolean;
	hovering: boolean;
	hoverX: number | null; // 滑鼠像素 x（相對 canvas 左上，CSS px）
	show: { trim: boolean; ltAvg: boolean; ltRate: boolean };
	dragging: boolean;
	dragOffX: number;
	dragOffY: number;
}

// ===== 主掛載函式：建立 Debug 面板 =====
export function mountDebug(api: DebugApi): DebugController {
	// 若重複安裝，先卸載舊 DOM 與樣式
	document.getElementById("ccx-debug")?.remove();
	document.getElementById("ccx-debug-style")?.remove();

	// 佇列
	const qTrim = makeQueue(); // ms（左軸）
	const qLtAvg = makeQueue(); // ms（左軸）
	const qLtRate = makeQueue(); // /s（右軸）

	// DOM
	let root: HTMLDivElement | null = null;
	let canvas: HTMLCanvasElement | null = null;
	let legend: HTMLDivElement | null = null;
	let tooltip: HTMLDivElement | null = null;
	let timer: number | null = null;
	let ro: ResizeObserver | null = null;
	let hoverRaf: number | null = null;

	// 樣式（延遲注入）：未顯示面板時不注入 CSS
	let styleEl: HTMLStyleElement | null = null;

	// Buffer（效能強化）
	let bgBuffer: HTMLCanvasElement | null = null;
	let bgBufferDirty = true; // 尺寸或門檻改變時需要重繪

	// 狀態
	const state: State = {
		visible: false,
		hovering: false,
		hoverX: null,
		show: { trim: true, ltAvg: true, ltRate: true },
		dragging: false,
		dragOffX: 0,
		dragOffY: 0,
	};

	// 延遲注入 CSS（只有開面板時才加入）
	const styleText = `
	#ccx-debug{position:fixed;z-index:900;}
	#ccx-debug .card{
    position:relative;
		width:var(--ccx-w, clamp(380px, 72vw, 520px));
		min-width: 300px;
		max-height:min(90vh, 720px);
		overflow-y:auto; /* 僅垂直滾動 */
		overflow-x:hidden; /* 避免水平滾動條 */
		display:flex;flex-direction:column;gap:10px;
		background:${COLOR.bgGlass};
		backdrop-filter:saturate(1.2) blur(8px);
		border:1px solid ${COLOR.stroke};
		border-radius:16px;padding:12px;
		box-shadow:0 10px 30px rgba(0,0,0,0.35);color:${COLOR.text};
		scrollbar-gutter: stable both-edges;
	}
	
	/* 右下角寬度調整把手（僅橫向） */
	#ccx-debug .resize{position:absolute;right:6px;bottom:6px;width:14px;height:14px;border-right:2px solid #fff5;border-bottom:2px solid #fff5;cursor:ew-resize;opacity:.8}
	/* 去除縮放把手與相關狀態，穩定小面板 */
	#ccx-debug .card.resizing{user-select:none}
	#ccx-debug .head{display:flex;align-items:center;gap:8px;cursor:move;user-select:none;}
	#ccx-debug .title{font:600 13px/1.2 ui-sans-serif,system-ui;opacity:.95;}
	#ccx-debug .grow{flex:1}
	#ccx-debug .chip{font:600 11px/1 ui-sans-serif;padding:6px 10px;border-radius:999px;}
	#ccx-debug .chip.run{background:${COLOR.ok}22;color:${COLOR.ok};border:1px solid ${COLOR.ok}55}
	#ccx-debug .chip.susp{background:${COLOR.susp}22;color:${COLOR.susp};border:1px solid ${COLOR.susp}55}
	#ccx-debug .btn{appearance:none;border:1px solid ${COLOR.stroke};background:transparent;color:${COLOR.text};border-radius:10px;padding:6px 8px;cursor:pointer}
	#ccx-debug .btn:hover{border-color:#fff3}

	/* === KPI 小卡（放在 head 下、chart 上） === */
		#ccx-debug .kpis-top{
		display:grid; min-width:0;
		grid-auto-flow: row dense;
		/* 三張固定等寬，但允許在容器窄時縮小不溢出 */
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap:8px; margin:2px 0 2px;
	}

	#ccx-debug .kpi{
		/* 取消 max-width 以便三張能共存於狹窄寬度；允許縮小 */
		min-width:0; min-height:50px;
		padding:8px 10px; border-radius:12px;
		background:rgba(255,255,255,.04); border:1px solid rgba(250,250,250,.12);
		display:flex; flex-direction:column; justify-content:center; gap:4px;
	}
	#ccx-debug .kpi .label{font:600 11px ui-sans-serif;color:${COLOR.sub}; min-width:0}
	#ccx-debug .kpi .value{font:700 15px/1.05 ui-sans-serif;white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
	#ccx-debug .kpi.ok .value{color:${COLOR.ok}}
	#ccx-debug .kpi.warn .value{color:${COLOR.warn}}
	#ccx-debug .kpi.bad .value{color:${COLOR.susp}}

  /* 圖表區 */
	#ccx-debug .chart-wrap{position:relative}
	#ccx-debug canvas{
		width:100%;
		height:190px; /* JS 會 RWD 調整 */
		border-radius:12px;
		background:rgba(255,255,255,0.03);
		border:1px solid ${COLOR.stroke}
	}
	#ccx-debug .legend{position:absolute;right:10px;top:10px;display:flex;gap:8px;flex-wrap:wrap}
	#ccx-debug .legend .item{display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:999px;background:rgba(0,0,0,.2);border:1px solid ${COLOR.stroke};font:600 11px ui-sans-serif;cursor:pointer;opacity:.9}
	#ccx-debug .legend .swatch{width:10px;height:10px;border-radius:3px}
	#ccx-debug .legend .off{opacity:.38;filter:grayscale(0.8)}
	#ccx-debug .tooltip{position:absolute;pointer-events:none;min-width:190px;max-width:min(60vw, 320px);padding:8px 10px;border-radius:12px;background:rgba(17,17,20,.72);backdrop-filter:blur(6px) saturate(1.1);border:1px solid ${COLOR.stroke};font:12px ui-sans-serif;color:${COLOR.text}}

	/* === 底部外層：兩大分區（Gate / Settings） === */
	#ccx-stats-wrap{
		display:grid; gap:12px; min-width:0;
		/* 兩大區改為單欄直排，節省寬度 */
		grid-template-columns: 1fr;
	}

	/* 內層：每區的 key-value 小卡清單 */
	#ccx-debug .sec{min-width:0; display:flex; flex-direction:column; gap:8px}
	#ccx-debug .sec .sec-title{font:700 12px/1 ui-sans-serif;color:${COLOR.sub};margin-top:2px}
	#ccx-debug .kvgrid{
		display:grid; grid-auto-flow: row dense; min-width:0; gap:8px;
			/* 降低最小寬，提升容納度，避免重疊與外溢 */
			grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
	}
		@media (max-width: 719px){ #ccx-debug .kvgrid{ grid-template-columns: repeat(2, minmax(120px,1fr)); } }
	@media (max-width: 380px){ #ccx-debug .kvgrid{ grid-template-columns: 1fr; } }

	#ccx-debug .stat{
		min-width:0; display:flex; justify-content:space-between; align-items:center;
		padding:8px 10px; border-radius:10px;
		background:rgba(255,255,255,.03); border:1px solid ${COLOR.stroke};
		font:12px ui-sans-serif; color:${COLOR.sub}
	}
	#ccx-debug .stat span{min-width:0; overflow:hidden; text-overflow:ellipsis; overflow-wrap:anywhere}
	#ccx-debug .stat b{font:600 12px ui-sans-serif; color:${COLOR.text}; white-space:nowrap; font-variant-numeric: tabular-nums}

	/* Compact：矮視窗或直立 → 更緊湊 */
	#ccx-debug .card.compact { gap:10px; }
	#ccx-debug .card.compact canvas{ height:128px; }
	#ccx-debug .card.compact .stat { padding:7px 8px; font-size:11px; }
	#ccx-debug .card.compact .sec .sec-title { font-size:11px; }

	/* 進一步因應極矮視窗（<=600px 高） */
	@media (max-height: 600px){
		#ccx-debug .card { gap:10px; }
		#ccx-debug canvas{ height:120px; }
	}`;

	function injectStyle() {
		if (styleEl) return;
		styleEl = document.createElement("style");
		styleEl.id = "ccx-debug-style";
		styleEl.textContent = styleText;
		document.head.appendChild(styleEl);
	}
	function removeStyle() {
		if (styleEl) {
			styleEl.remove();
			styleEl = null;
		}
	}

	// ---- DOM ----
	root = document.createElement("div");
	root.id = "ccx-debug";
	root.innerHTML = `
    <div class="card" role="dialog" aria-label="Debug Panel">
		<div class="head" id="ccx-drag-handle">
			<div class="title">Chat Cleaner • Debug</div>
			<div class="grow"></div>
			<span class="chip run" id="ccx-chip">✨ Running</span>
			<button class="btn" id="ccx-close" aria-label="Close">✕</button>
		</div>
		<div class="kpis-top" id="ccx-kpis-top"></div>
		<div class="chart-wrap">
			<canvas id="ccx-c"></canvas>
			<div class="legend" id="ccx-legend"></div>
			<div class="tooltip" id="ccx-tt" style="display:none"></div>
		</div>
		<div id="ccx-stats-wrap"></div>
		<div class="resize" id="ccx-resize" title="Resize width"></div>
    </div>`;

	// 快速選取器
	const get = <T extends HTMLElement>(sel: string) =>
		root!.querySelector(sel) as T;
	const cardEl = () => get<HTMLDivElement>(".card");
	const chartWrapEl = () => get<HTMLDivElement>(".chart-wrap");
	const statsWrapEl = () => get<HTMLDivElement>("#ccx-stats-wrap");
	const chipEl = () => get<HTMLSpanElement>("#ccx-chip");
	const dragHandleEl = () => get<HTMLDivElement>("#ccx-drag-handle");

	const ctx = () => get<HTMLCanvasElement>("#ccx-c").getContext("2d")!;
	const canvasEl = () => get<HTMLCanvasElement>("#ccx-c");
	const cLegend = () => get<HTMLDivElement>("#ccx-legend");
	const cTooltip = () => get<HTMLDivElement>("#ccx-tt");
	const kpisTopEl = () => get<HTMLDivElement>("#ccx-kpis-top");
	canvas = canvasEl();
	legend = cLegend();
	tooltip = cTooltip();

	// 計時器：定期刷新 tick（隱藏頁面時自動暫停）
	function startTimer() {
		if (timer) return;
		tick();
		timer = window.setInterval(tick, REFRESH_MS) as any;
	}
	function stopTimer() {
		if (timer) clearInterval(timer);
		timer = null;
	}
	function onVisibilityChange() {
		if (!state.visible) return;
		if (document.visibilityState === "hidden") {
			stopTimer();
		} else {
			startTimer();
		}
	}

	// 尺寸 / RWD：調整 canvas 與 buffer 尺寸，確保 HiDPI 正確繪製
	function ensureBgBufferSize() {
		if (!USE_BUFFER_BG) return;
		if (!bgBuffer) bgBuffer = document.createElement("canvas");
		const dpr = Math.max(1, Math.floor(devicePixelRatio || 1));
		const bw = canvas!.clientWidth;
		const bh = canvas!.clientHeight;
		const wantW = Math.max(1, Math.floor(bw * dpr));
		const wantH = Math.max(1, Math.floor(bh * dpr));
		if (bgBuffer.width !== wantW || bgBuffer.height !== wantH) {
			bgBuffer.width = wantW;
			bgBuffer.height = wantH;
			bgBufferDirty = true;
		}
	}

	function layout() {
		const rect = cardEl().getBoundingClientRect();
		const w = rect.width,
			h = rect.height;

		// 依方向與視窗高度自適應
		const isPortrait =
			window.matchMedia?.("(orientation: portrait)")?.matches ?? h >= w;

		// 進入 Compact（高度太矮或寬度太窄）
		const isCompact = isPortrait || window.innerHeight < 700 || w < 460;
		cardEl().classList.toggle("compact", isCompact);

		// 圖表高度：半固定策略（小面板）
		let ch = 160;
		if (isCompact) ch = 120;
		if (window.innerHeight < 600) ch = Math.min(ch, 110);
		canvas!.style.height = `${Math.max(CH_MIN, Math.min(CH_MAX, ch))}px`;

		// HiDPI 尺寸同步（實體像素 → CSS px 座標）
		const dpr = Math.max(1, Math.floor(devicePixelRatio || 1));
		const bw = canvas!.clientWidth,
			bh = canvas!.clientHeight;
		const wantW = Math.max(1, Math.floor(bw * dpr));
		const wantH = Math.max(1, Math.floor(bh * dpr));
		if (canvas!.width !== wantW || canvas!.height !== wantH) {
			canvas!.width = wantW;
			canvas!.height = wantH;
		}
		const c = ctx();
		c.setTransform(1, 0, 0, 1, 0, 0);
		c.scale(dpr, dpr);

		// Buffer 尺寸同步
		ensureBgBufferSize();
	}

	// 雙 Y 軸繪圖：左軸(ms)=Trim/LongTask Avg，右軸(/s)=LongTask Rate
	function draw(
		xs: number[],
		series: {
			key: keyof State["show"];
			ys: number[];
			color: string;
			axis: "left" | "right";
		}[],
		th: {
			enterRate: number;
			exitRate: number;
			enterAvg: number;
			exitAvg: number;
		}
	) {
		const c = ctx();
		const w = canvas!.clientWidth;
		const h = canvas!.clientHeight;
		const pad = 12;

		// 清空畫布（實體像素）
		c.save();
		c.setTransform(1, 0, 0, 1, 0, 0);
		c.clearRect(0, 0, canvas!.width, canvas!.height);
		c.restore();

		// 拆分兩組（左/右）
		const leftS = series.filter(
			(s) => s.axis === "left" && state.show[s.key]
		);
		const rightS = series.filter(
			(s) => s.axis === "right" && state.show[s.key]
		);
		const leftVals = leftS.flatMap((s) => s.ys);
		const rightVals = rightS.flatMap((s) => s.ys);

		const lMin = Math.min(0, ...leftVals);
		const lMax = Math.max(1, ...leftVals, th.enterAvg, th.exitAvg);
		const rMin = Math.min(0, ...rightVals);
		const rMax = Math.max(1, ...rightVals, th.enterRate, th.exitRate);

		const sx = (i: number) =>
			pad + (w - pad * 2) * (i / Math.max(1, xs.length - 1));
		const syL = (v: number) =>
			h - pad - ((h - pad * 2) * (v - lMin)) / (lMax - lMin || 1);
		const syR = (v: number) =>
			h - pad - ((h - pad * 2) * (v - rMin)) / (rMax - rMin || 1);

		// ==== 背景（門檻線）====
		if (USE_BUFFER_BG && bgBuffer) {
			const dpr = Math.max(1, Math.floor(devicePixelRatio || 1));
			const drawBg = () => {
				const bctx = bgBuffer!.getContext("2d")!;
				bctx.setTransform(1, 0, 0, 1, 0, 0);
				bctx.clearRect(0, 0, bgBuffer!.width, bgBuffer!.height);
				bctx.scale(dpr, dpr);
				const drawH = (
					val: number,
					color: string,
					side: "left" | "right"
				) => {
					const y = side === "left" ? syL(val) : syR(val);
					bctx.save();
					bctx.strokeStyle = color;
					bctx.setLineDash([4, 4]);
					bctx.lineWidth = 1;
					bctx.beginPath();
					bctx.moveTo(pad, y);
					bctx.lineTo(w - pad, y);
					bctx.stroke();
					bctx.restore();
				};
				drawH(th.enterAvg, COLOR.thrAvgEnter, "left");
				drawH(th.exitAvg, COLOR.thrAvgExit, "left");
				drawH(th.enterRate, COLOR.thrRateEnter, "right");
				drawH(th.exitRate, COLOR.thrRateExit, "right");
			};
			if (bgBufferDirty) {
				drawBg();
				bgBufferDirty = false;
			}
			c.save();
			c.setTransform(1, 0, 0, 1, 0, 0);
			c.drawImage(
				bgBuffer,
				0,
				0,
				bgBuffer.width,
				bgBuffer.height,
				0,
				0,
				w,
				h
			);
			c.restore();
		} else {
			const drawH = (
				val: number,
				color: string,
				side: "left" | "right"
			) => {
				const y = side === "left" ? syL(val) : syR(val);
				c.save();
				c.strokeStyle = color;
				c.setLineDash([4, 4]);
				c.lineWidth = 1;
				c.beginPath();
				c.moveTo(pad, y);
				c.lineTo(w - pad, y);
				c.stroke();
				c.restore();
			};
			drawH(th.enterAvg, COLOR.thrAvgEnter, "left");
			drawH(th.exitAvg, COLOR.thrAvgExit, "left");
			drawH(th.enterRate, COLOR.thrRateEnter, "right");
			drawH(th.exitRate, COLOR.thrRateExit, "right");
		}

		// ==== 曲線 ====
		c.lineWidth = 1.6;
		c.setLineDash([]);
		const paint = (arr: typeof series) => {
			for (const s of arr) {
				const ys = s.ys;
				const sy = s.axis === "left" ? syL : syR;
				c.strokeStyle = s.color + "CC";
				c.beginPath();
				ys.forEach((v, i) => {
					const x = sx(i),
						y = sy(v);
					i ? c.lineTo(x, y) : c.moveTo(x, y);
				});
				c.stroke();
			}
		};
		paint(leftS);
		paint(rightS);

		// Hover 指示：滑鼠垂直線 + 節點標記 + Tooltip
		if (state.hovering && state.hoverX != null) {
			const px = Math.max(pad, Math.min(w - pad, state.hoverX));
			// 垂直虛線
			c.save();
			c.strokeStyle = "rgba(250,250,250,0.35)";
			c.setLineDash([4, 4]);
			c.lineWidth = 1;
			c.beginPath();
			c.moveTo(px, pad);
			c.lineTo(px, h - pad);
			c.stroke();
			c.restore();

			// 對應索引
			const inner = Math.max(1, w - pad * 2);
			const t = (px - pad) / inner;
			const i = Math.max(
				0,
				Math.min(
					xs.length - 1,
					Math.round(t * Math.max(1, xs.length - 1))
				)
			);

			// 節點
			const mark = (v: number, axis: "left" | "right", col: string) => {
				const y = axis === "left" ? syL(v) : syR(v);
				c.save();
				c.fillStyle = col;
				c.globalAlpha = 0.9;
				c.beginPath();
				c.arc(px, y, 2.2, 0, Math.PI * 2);
				c.fill();
				c.globalAlpha = 0.35;
				c.beginPath();
				c.arc(px, y, 6, 0, Math.PI * 2);
				c.fill();
				c.restore();
			};
			if (state.show.ltAvg)
				mark(qLtAvg.values()[i] ?? 0, "left", COLOR.ltAvg);
			if (state.show.trim)
				mark(qTrim.values()[i] ?? 0, "left", COLOR.trim);
			if (state.show.ltRate)
				mark(qLtRate.values()[i] ?? 0, "right", COLOR.ltRate);

			// Tooltip
			const tt = tooltip!;
			tt.style.display = "block";
			const row = (
				label: string,
				val: string | number,
				unit: string,
				color: string
			) =>
				`<div class="row" style="display:flex;justify-content:space-between;gap:12px;margin-top:4px">
				<span style="color:${COLOR.sub}"><span style="color:${color};opacity:.85">${label}</span></span>
				<b style="color:${color};opacity:.9">${val}${unit}</b>
			</div>`;
			const vTrim = qTrim.values()[i] ?? 0;
			const vAvg = qLtAvg.values()[i] ?? 0;
			const vRate = qLtRate.values()[i] ?? 0;
			tt.innerHTML =
				row(
					"LongTask Rate",
					(vRate as any).toFixed?.(2) ?? vRate,
					" /s",
					COLOR.ltRate
				) +
				row(
					"LongTask Avg",
					(vAvg as any).toFixed?.(1) ?? vAvg,
					" ms",
					COLOR.ltAvg
				) +
				row(
					"Trim Avg",
					(vTrim as any).toFixed?.(1) ?? vTrim,
					" ms",
					COLOR.trim
				);

			const wrap = chartWrapEl().getBoundingClientRect();
			let tx = px + 12;
			let ty = 12;
			const tr = tt.getBoundingClientRect();
			if (tx + tr.width > wrap.width - 8) tx = px - tr.width - 12;
			if (ty + tr.height > wrap.height - 8)
				ty = wrap.height - tr.height - 8;
			tt.style.left = `${tx}px`;
			tt.style.top = `${ty}px`;
		} else {
			tooltip!.style.display = "none";
		}
	}

	// 每秒 tick：收集 metrics → 更新佇列 → 更新 KPI / 門檻資訊 → 繪圖
	function tick() {
		const m = api.getMetrics();
		const suspended = !!m.suspended;

		const ltRate = Number(m.longTaskRateEMA ?? 0);
		const ltAvg = Number(m.longTaskAvgMsEMA ?? 0);
		const trimAvg = Number(m.trimAvgMs ?? 0);
		const th = m.ltThresholds;
		bgBufferDirty = true;
		qLtRate.push(ltRate);
		qLtAvg.push(ltAvg);
		qTrim.push(trimAvg);

		// Chip
		const chip = chipEl();
		chip.className = suspended ? "chip susp" : "chip run";
		chip.textContent = suspended ? "⚡ Suspend" : "✨ Running";

		// KPI 顏色級別
		const colorTrimClass = (ms: number) =>
			ms <= 8 ? "ok" : ms <= 16 ? "warn" : "bad";
		const colorLtAvgClass = (ms: number) =>
			ms < th.exitAvg ? "ok" : ms < th.enterAvg ? "warn" : "bad";
		const colorLtRateClass = (v: number) =>
			v < th.exitRate ? "ok" : v < th.enterRate ? "warn" : "bad";

		// ── KPI 小卡（圖表上方）──
		const kpisTop = kpisTopEl();
		kpisTop.innerHTML = `
		<div class="kpi ${colorTrimClass(trimAvg)}">
			<div class="label">Trim Avg</div>
			<div class="value">${trimAvg.toFixed(1)} ms</div>
		</div>
		<div class="kpi ${colorLtAvgClass(ltAvg)}">
			<div class="label">LongTask Avg</div>
			<div class="value">${ltAvg.toFixed(1)} ms</div>
		</div>
		<div class="kpi ${colorLtRateClass(ltRate)}">
			<div class="label">LongTask Rate</div>
			<div class="value">${ltRate.toFixed(2)} /s</div>
		</div>`;

		// ====== Gate 門檻 ======
		const gateHtml = `
		<div class="sec" aria-labelledby="sec-gate">
			<div class="sec-title" id="sec-gate">Storm Gate Thresholds</div>
			<div class="kvgrid">
				<div class="stat"><span>Enter Rate</span><b>${th.enterRate.toFixed(
					2
				)} /s</b></div>
				<div class="stat"><span>Exit Rate</span><b>${th.exitRate.toFixed(
					2
				)} /s</b></div>
				<div class="stat"><span>Enter Avg</span><b>${th.enterAvg.toFixed(
					1
				)} ms</b></div>
				<div class="stat"><span>Exit Avg</span><b>${th.exitAvg.toFixed(1)} ms</b></div>
				<div class="stat"><span>Min Suspend</span><b>${th.minSuspendMs} ms</b></div>
				<div class="stat"><span>Debounce Delay</span><b>${m.debounceDelay} ms</b></div>
			</div>
		</div>`;

		// ====== 設定 / 累積 ======
		const settingsHtml = `
		<div class="sec" aria-labelledby="sec-settings">
			<div class="sec-title" id="sec-settings">Settings &amp; Stats</div>
			<div class="kvgrid">
				<div class="stat"><span>Mode</span><b>${String(m.mode).toUpperCase()}</b></div>
				<div class="stat"><span>Max Keep</span><b>${m.maxKeep}</b></div>
				<div class="stat"><span>Removed (DOM)</span><b>${
					m.stats?.domRemoved ?? 0
				}</b></div>
			</div>
		</div>`;

		// 寫入面板（外層 2 欄容器）
		statsWrapEl().innerHTML = gateHtml + settingsHtml;

		const xs = qTrim.values().map((_, i) => i);
		draw(
			xs,
			[
				{
					key: "ltAvg",
					ys: qLtAvg.values(),
					color: COLOR.ltAvg,
					axis: "left",
				},
				{
					key: "trim",
					ys: qTrim.values(),
					color: COLOR.trim,
					axis: "left",
				},
				{
					key: "ltRate",
					ys: qLtRate.values(),
					color: COLOR.ltRate,
					axis: "right",
				},
			],
			{
				enterRate: th.enterRate,
				exitRate: th.exitRate,
				enterAvg: th.enterAvg,
				exitAvg: th.exitAvg,
			}
		);
	}

	// Hover loop：滑鼠停在圖表時，持續以 rAF 更新 hover 線與 tooltip
	function startHoverLoop() {
		if (hoverRaf != null) return;
		const loop = () => {
			if (!state.hovering) {
				hoverRaf = null;
				return;
			}
			redraw();
			hoverRaf = requestAnimationFrame(loop);
		};
		hoverRaf = requestAnimationFrame(loop);
	}
	function stopHoverLoop() {
		if (hoverRaf != null) {
			cancelAnimationFrame(hoverRaf);
			hoverRaf = null;
		}
	}
	function redraw() {
		const xs = qTrim.values().map((_, i) => i);
		const m = api.getMetrics();
		draw(
			xs,
			[
				{
					key: "ltAvg",
					ys: qLtAvg.values(),
					color: COLOR.ltAvg,
					axis: "left",
				},
				{
					key: "trim",
					ys: qTrim.values(),
					color: COLOR.trim,
					axis: "left",
				},
				{
					key: "ltRate",
					ys: qLtRate.values(),
					color: COLOR.ltRate,
					axis: "right",
				},
			],
			{
				enterRate: m.ltThresholds.enterRate,
				exitRate: m.ltThresholds.exitRate,
				enterAvg: m.ltThresholds.enterAvg,
				exitAvg: m.ltThresholds.exitAvg,
			}
		);
	}

	// 圖例控制：點擊切換線條顯示/隱藏
	function rebuildLegend() {
		legend!.innerHTML = "";
		const mk = (key: keyof State["show"], label: string, color: string) => {
			const el = document.createElement("div");
			el.className = "item" + (state.show[key] ? "" : " off");
			el.innerHTML = `<span class="swatch" style="background:${color}"></span><span>${label}</span>`;
			el.onclick = () => {
				state.show[key] = !state.show[key];
				el.classList.toggle("off", !state.show[key]);
				redraw();
			};
			legend!.appendChild(el);
		};
		mk("ltAvg", "LongTask Avg (ms)", COLOR.ltAvg);
		mk("trim", "Trim Avg (ms)", COLOR.trim);
		mk("ltRate", "LongTask Rate (/s)", COLOR.ltRate);
	}

	// 面板生命週期：show / hide / destroy
	function showPanel() {
		if (state.visible) return;
		state.visible = true;
		injectStyle();
		document.body.appendChild(root!);
		// 初始寬度（不持久化）
		cardEl().style.setProperty("--ccx-w", "445px");
		// 初次顯示置中（像素計算），避免 transform 造成視覺偏差
		layout();
		centerPanelNow();
		rebuildLegend();
		startTimer();
		// 內容填入後高度會上升（KPI / Gate / Settings），下一幀再量測一次並重新置中
		requestAnimationFrame(() => {
			layout();
			centerPanelNow();
		});
		ro = new ResizeObserver(() => {
			layout();
			bgBufferDirty = true;
			redraw();
			clampToViewportNow();
		});
		ro.observe(cardEl());
		// 視窗縮放或 DPR 變動時同步
		window.addEventListener("resize", onWindowResize, { passive: true });
		document.addEventListener("visibilitychange", onVisibilityChange);
	}

	function hidePanel() {
		if (!state.visible) return;
		state.visible = false;
		stopTimer();
		ro?.disconnect();
		ro = null;
		stopHoverLoop();
		root?.remove();
		window.removeEventListener("resize", onWindowResize as any);
		document.removeEventListener(
			"visibilitychange",
			onVisibilityChange as any
		);
		removeStyle();
	}

	function destroy() {
		hidePanel();
		removeStyle();

		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		if (ro) {
			ro.disconnect();
			ro = null;
		}
		if (hoverRaf != null) {
			cancelAnimationFrame(hoverRaf);
			hoverRaf = null;
		}

		root = null;
		canvas = null;
		legend = null;
		tooltip = null;
		bgBuffer = null;
		styleEl = null;

		delete (window as any).__ccxDebug;
		delete (globalThis as any).__ccxDebug;
	}

	function onWindowResize() {
		layout();
		bgBufferDirty = true;
		redraw();
		clampToViewportNow();
	}

	// 安全置中：根據當前卡片尺寸與視窗計算
	function centerPanelNow() {
		const r = cardEl().getBoundingClientRect();
		const cx = Math.max(8, Math.floor((window.innerWidth - r.width) / 2));
		const cy = Math.max(8, Math.floor((window.innerHeight - r.height) / 2));
		root!.style.left = cx + "px";
		root!.style.top = cy + "px";
		root!.style.right = "auto";
		root!.style.bottom = "auto";
	}

	// ---- 事件 ----
	(root.querySelector("#ccx-close") as HTMLButtonElement).onclick = () =>
		hidePanel();

	// 邊界夾束：拖曳/resize 後，限制面板保持在可見範圍
	function clampIntoViewport(x: number, y: number) {
		const margin = 8;
		const card = cardEl();
		const rect = card.getBoundingClientRect();
		const w = rect.width,
			h = rect.height;
		const maxX = window.innerWidth - w - margin;
		const maxY = window.innerHeight - h - margin;
		const clampedX = Math.min(Math.max(margin, x), Math.max(margin, maxX));
		const clampedY = Math.min(Math.max(margin, y), Math.max(margin, maxY));
		return { x: clampedX, y: clampedY };
	}
	function clampToViewportNow() {
		const r = root!.getBoundingClientRect();
		const p = clampIntoViewport(r.left, r.top);
		root!.style.left = p.x + "px";
		root!.style.top = p.y + "px";
		root!.style.right = "auto";
		root!.style.bottom = "auto";
		root!.style.transform = ""; // 一旦校正到視窗內，就移除置中 transform
	}

	// 拖拽：由 head 觸發，計算偏移量並限制邊界
	function beginDrag(x: number, y: number) {
		state.dragging = true;
		const r = root!.getBoundingClientRect();
		state.dragOffX = x - r.left;
		state.dragOffY = y - r.top;
		(document.body as any).style.userSelect = "none";
		document.addEventListener("mousemove", onDrag);
		document.addEventListener("mouseup", onDrop);
	}
	dragHandleEl().addEventListener("mousedown", (e) => {
		const target = e.target as HTMLElement;
		if (target.closest("#ccx-close")) return;
		e.preventDefault();
		beginDrag(e.clientX, e.clientY);
	});
	function onDrag(e: MouseEvent) {
		if (!state.dragging) return;
		e.preventDefault();
		let x = e.clientX - state.dragOffX;
		let y = e.clientY - state.dragOffY;
		const p = clampIntoViewport(x, y);
		root!.style.left = p.x + "px";
		root!.style.top = p.y + "px";
		root!.style.right = "auto";
		root!.style.bottom = "auto";
		root!.style.transform = ""; // 拖曳後取消置中
	}
	function onDrop(_e: MouseEvent) {
		if (!state.dragging) return;
		state.dragging = false;
		document.removeEventListener("mousemove", onDrag);
		document.removeEventListener("mouseup", onDrop);
		(document.body as any).style.userSelect = "";
		// 放手時再夾一次
		clampToViewportNow();
	}

	// Hover（以像素 x 黏滑鼠；離開時停 rAF）
	function clientXToLocalX(clientX: number) {
		const rect = canvas!.getBoundingClientRect();
		return Math.max(0, Math.min(rect.width, clientX - rect.left));
	}
	canvas!.addEventListener("mouseenter", () => {
		state.hovering = true;
		startHoverLoop();
	});
	canvas!.addEventListener("mouseleave", () => {
		state.hovering = false;
		state.hoverX = null;
		stopHoverLoop();
		redraw();
	});
	canvas!.addEventListener("mousemove", (e) => {
		state.hoverX = clientXToLocalX(e.clientX);
	});

	// 寬度調整（僅橫向）：透過 CSS 變數 --ccx-w 控制，避免過小或超出視窗
	const resizer = root.querySelector<HTMLDivElement>("#ccx-resize");
	if (resizer) {
		function beginResizeWidth(startX: number) {
			cardEl().classList.add("resizing");
			(document.body as any).style.userSelect = "none";
			const startW = cardEl().getBoundingClientRect().width;
			const onMove = (e: MouseEvent) => {
				const w = startW + (e.clientX - startX);
				const maxW = Math.floor(window.innerWidth * 0.9);
				const newW = Math.max(320, Math.min(w, maxW));
				cardEl().style.setProperty("--ccx-w", newW + "px");
				layout();
				bgBufferDirty = true;
				redraw();
				clampToViewportNow();
			};
			const onUp = () => {
				cardEl().classList.remove("resizing");
				(document.body as any).style.userSelect = "";
				document.removeEventListener("mousemove", onMove);
				document.removeEventListener("mouseup", onUp);
				clampToViewportNow();
			};
			document.addEventListener("mousemove", onMove);
			document.addEventListener("mouseup", onUp);
		}
		resizer.addEventListener("mousedown", (e) => {
			e.preventDefault();
			beginResizeWidth(e.clientX);
		});
	}

	// 對外 API：DebugController + 全域 __ccxDebug
	const controller: DebugController = { showPanel, hidePanel, destroy };
	(window as any).__ccxDebug = {
		showPanel,
		hidePanel,
		getMetrics: api.getMetrics,
		forceTrim: api.forceTrim,
		forceTrimNow: api.forceTrimNow,
	};
	(globalThis as any).__ccxDebug = (window as any).__ccxDebug;
	return controller;
}
