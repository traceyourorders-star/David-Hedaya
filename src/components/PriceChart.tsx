"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries, ColorType, createChart, HistogramSeries, LineSeries, LineStyle, type IChartApi, type UTCTimestamp,
} from "lightweight-charts";
import type { Bar } from "@/lib/types";
import type { KeyLevel, TradePlan } from "@/lib/quant/technical";
import { bollinger, sessionVwap, sma } from "@/lib/quant/indicators";

const TFS = ["1m", "5m", "15m", "1h", "1D", "1W", "1M"] as const;

/** Offset (seconds) to display UTC instants as New York wall-clock time on the chart's UTC axis. */
function etOffsetSec(ms: number) {
  const s = new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
  const asUtc = Date.parse(`${s} UTC`);
  return Math.round((asUtc - ms) / 1000);
}

export default function PriceChart({ chart, levels, plan }: { chart: Record<string, Bar[]>; levels: { supports: KeyLevel[]; resistances: KeyLevel[] }; plan: TradePlan | null }) {
  const [tf, setTf] = useState<(typeof TFS)[number]>("1D");
  const box = useRef<HTMLDivElement>(null);
  const bars = useMemo(() => chart[tf] ?? [], [chart, tf]);
  const intraday = ["1m", "5m", "15m", "1h"].includes(tf);

  useEffect(() => {
    if (!box.current || !bars.length) return;
    const c: IChartApi = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "#131417" }, textColor: "#c3c2b7", fontFamily: "ui-monospace, Menlo, monospace" },
      grid: { vertLines: { color: "#1d1e22" }, horzLines: { color: "#1d1e22" } },
      rightPriceScale: { borderColor: "#34353b" },
      timeScale: { borderColor: "#34353b", timeVisible: intraday, secondsVisible: false },
      crosshair: { mode: 0 },
    });
    const time = (b: Bar) => (intraday ? ((b.t / 1000 + etOffsetSec(b.t)) as UTCTimestamp) : ((b.t / 1000) as UTCTimestamp));
    const candles = c.addSeries(CandlestickSeries, {
      upColor: "#0ca30c", downColor: "#d03b3b", borderUpColor: "#0ca30c", borderDownColor: "#d03b3b", wickUpColor: "#4cc94c", wickDownColor: "#f07070",
    });
    candles.setData(bars.map((b) => ({ time: time(b), open: b.o, high: b.h, low: b.l, close: b.c })));
    const vol = c.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, color: "#2b3a52" });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    vol.setData(bars.map((b) => ({ time: time(b), value: b.v, color: b.c >= b.o ? "#1d4a2a" : "#4a1d1d" })));
    const closes = bars.map((b) => b.c);
    const line = (vals: number[], color: string, title: string, style = LineStyle.Solid) => {
      const s = c.addSeries(LineSeries, { color, lineWidth: 2, lineStyle: style, title, priceLineVisible: false, lastValueVisible: false });
      s.setData(bars.map((b, i) => ({ time: time(b), value: vals[i] })).filter((p) => Number.isFinite(p.value)));
    };
    if (intraday) {
      line(sessionVwap(bars), "#9085e9", "VWAP");
    } else {
      line(sma(closes, 20), "#3987e5", "SMA20");
      line(sma(closes, 50), "#d95926", "SMA50");
      if (tf === "1D") {
        line(sma(closes, 100), "#199e70", "SMA100");
        line(sma(closes, 200), "#c98500", "SMA200");
        const bb = bollinger(closes);
        line(bb.upper, "#5a5a55", "BB+", LineStyle.Dotted);
        line(bb.lower, "#5a5a55", "BB-", LineStyle.Dotted);
      }
    }
    if (tf === "1D" || intraday) {
      for (const l of levels.supports.slice(0, 3)) candles.createPriceLine({ price: l.price, color: "#2f6b3a", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "S" });
      for (const l of levels.resistances.slice(0, 3)) candles.createPriceLine({ price: l.price, color: "#7a3434", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "R" });
      if (plan?.confirmation) candles.createPriceLine({ price: plan.confirmation.price, color: "#ff9f1a", lineWidth: 2, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: "Confirm" });
      if (plan?.invalidation) candles.createPriceLine({ price: plan.invalidation.price, color: "#f07070", lineWidth: 2, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: "Invalidate" });
    }
    if (tf === "1D" && bars.length > 180) c.timeScale().setVisibleLogicalRange({ from: bars.length - 180, to: bars.length + 3 });
    else c.timeScale().fitContent();
    return () => c.remove();
  }, [bars, tf, intraday, levels, plan]);

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <div className="tabs" role="tablist">
          {TFS.map((k) => (
            <button key={k} className={`tab ${tf === k ? "active" : ""}`} onClick={() => setTf(k)} disabled={!chart[k]?.length} title={chart[k]?.length ? `${chart[k].length} bars` : "No data"}>
              {k}
            </button>
          ))}
        </div>
        <div className="tiny muted row" style={{ gap: 10 }}>
          {intraday ? <span><span style={{ color: "#9085e9" }}>━</span> VWAP</span> : <>
            <span><span style={{ color: "#3987e5" }}>━</span> SMA20</span><span><span style={{ color: "#d95926" }}>━</span> SMA50</span>
            {tf === "1D" && <><span><span style={{ color: "#199e70" }}>━</span> SMA100</span><span><span style={{ color: "#c98500" }}>━</span> SMA200</span><span>┈ Bollinger</span></>}
          </>}
          <span><span style={{ color: "#ff9f1a" }}>━</span> Confirm</span><span><span style={{ color: "#f07070" }}>━</span> Invalidate</span>
          {intraday && <span>Times in ET</span>}
        </div>
      </div>
      {bars.length ? <div ref={box} className="chart-box" /> : <div className="empty">No {tf} bars available from the connected provider.</div>}
    </div>
  );
}
