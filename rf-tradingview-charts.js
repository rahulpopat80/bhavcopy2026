// =========================================================================
// Rahul Finance — TradingView Lightweight Charts v5 + Apache ECharts Engine
// =========================================================================
(function () {
    'use strict';

    const tvChartInstances = new Map();   // containerId -> { chart, seriesMap, panes, options, resizeObserver, lastKey, priceLines }
    const echartsInstances = new Map();   // containerId -> { instance, resizeObserver, lastKind, lastPayload }

    function isLightTheme() {
        return document.documentElement.getAttribute('data-theme') === 'light';
    }

    function getThemePalette() {
        const light = isLightTheme();
        return {
            light,
            bg: light ? '#ffffff' : '#090f1d',
            surface: light ? '#f8fafc' : '#0d1526',
            text: light ? '#0f172a' : '#e2e8f0',
            textMuted: light ? '#64748b' : '#94a3b8',
            grid: light ? 'rgba(15, 23, 42, 0.06)' : 'rgba(148, 163, 184, 0.08)',
            border: light ? 'rgba(15, 23, 42, 0.12)' : 'rgba(148, 163, 184, 0.18)',
            crosshair: light ? '#2563eb' : '#38bdf8',
            up: '#16a34a',
            upFill: '#22c55e',
            down: '#dc2626',
            downFill: '#ef4444'
        };
    }

    function sanitizeCandlesForTv(rawCandles) {
        if (!Array.isArray(rawCandles) || rawCandles.length === 0) return [];
        const byTime = new Map();
        for (let i = 0; i < rawCandles.length; i++) {
            const c = rawCandles[i];
            if (!c) continue;
            const t = Math.floor(Number(c.time));
            const o = Number(c.open);
            const h = Number(c.high);
            const l = Number(c.low);
            const cl = Number(c.close);
            const v = Number(c.volume || 0);
            if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(cl)) {
                continue;
            }
            byTime.set(t, {
                time: t,
                open: o,
                high: Math.max(h, o, cl),
                low: Math.min(l, o, cl),
                close: cl,
                volume: Number.isFinite(v) && v >= 0 ? v : 0,
                label: c.label || ''
            });
        }
        return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
    }

    function computeChartAnalysisAndSeries(candles, options = {}) {
        const closes = candles.map(c => c.close);
        const bb = typeof window.computeBollingerBands === 'function'
            ? window.computeBollingerBands(candles, 20, 2)
            : fallbackBB(candles, 20, 2);
        const ema9 = typeof window.computeEMAValues === 'function' ? window.computeEMAValues(closes, 9) : [];
        const ema21 = typeof window.computeEMAValues === 'function' ? window.computeEMAValues(closes, 21) : [];
        const sma50 = typeof window.computeSMAValues === 'function' ? window.computeSMAValues(closes, 50) : [];
        const vwap = typeof window.computeSessionVWAP === 'function' ? window.computeSessionVWAP(candles) : [];
        const rsi = typeof window.computeRSIValues === 'function' ? window.computeRSIValues(candles, 14) : [];
        const macd = typeof window.computeMACDValues === 'function' ? window.computeMACDValues(candles, 12, 26, 9) : { macd: [], signal: [], hist: [] };
        const volAvg = typeof window.computeVolumeSma === 'function' ? window.computeVolumeSma(candles, 20) : [];

        let patternAnalysis = null;
        if (typeof window.detectCandlestickPatterns === 'function') {
            patternAnalysis = window.detectCandlestickPatterns(candles, bb, volAvg);
        }
        let tradeSignal = null;
        if (typeof window.computeTechnicalTradeSignal === 'function') {
            tradeSignal = window.computeTechnicalTradeSignal(candles, bb, ema9, ema21, sma50, vwap, rsi, macd, volAvg, patternAnalysis);
        }

        const lastIdx = candles.length - 1;
        const hasRealVolume = candles.some(c => Number(c.volume) > 0);

        const analysis = {
            ...(patternAnalysis || {}),
            tradeSignal,
            indicators: {
                ema9: ema9[lastIdx] ?? null,
                ema21: ema21[lastIdx] ?? null,
                sma50: sma50[lastIdx] ?? null,
                rsi: rsi[lastIdx] ?? null,
                macd: macd.macd?.[lastIdx] ?? null,
                macdSignal: macd.signal?.[lastIdx] ?? null,
                macdHist: macd.hist?.[lastIdx] ?? null,
                vwap: vwap[lastIdx] ?? null,
                hasRealVolume
            }
        };

        return { bb, ema9, ema21, sma50, vwap, rsi, macd, volAvg, patternAnalysis, tradeSignal, analysis };
    }

    function fallbackBB(candles, period = 20, mult = 2) {
        const upper = new Array(candles.length).fill(null);
        const middle = new Array(candles.length).fill(null);
        const lower = new Array(candles.length).fill(null);
        for (let i = period - 1; i < candles.length; i++) {
            let sum = 0;
            for (let j = i - period + 1; j <= i; j++) sum += candles[j].close;
            const mean = sum / period;
            let sq = 0;
            for (let j = i - period + 1; j <= i; j++) {
                const d = candles[j].close - mean;
                sq += d * d;
            }
            const std = Math.sqrt(sq / period);
            middle[i] = mean;
            upper[i] = mean + mult * std;
            lower[i] = mean - mult * std;
        }
        return { upper, middle, lower };
    }

    function toLinePoints(candles, values) {
        const out = [];
        for (let i = 0; i < candles.length; i++) {
            const val = values[i];
            if (val !== null && val !== undefined && Number.isFinite(Number(val))) {
                out.push({ time: candles[i].time, value: Number(val) });
            }
        }
        return out;
    }

    function destroyTvChart(containerId) {
        const entry = tvChartInstances.get(containerId);
        if (!entry) return;
        try { entry.resizeObserver?.disconnect(); } catch (_) {}
        try { entry.chart?.remove(); } catch (_) {}
        tvChartInstances.delete(containerId);
    }

    function getPrecisionForSymbol(symbol) {
        const s = String(symbol || '').toUpperCase();
        if (s === 'SI=F' || s === 'INR=X') return { precision: 3, minMove: 0.001 };
        if (s === 'GOLD_INR' || s === 'SILVER_INR') return { precision: 0, minMove: 1 };
        return { precision: 2, minMove: 0.01 };
    }

    function formatReadoutPrice(val, symbol) {
        if (typeof window.fmtCandlePrice === 'function') {
            return window.fmtCandlePrice(val, symbol);
        }
        const n = Number(val);
        if (!Number.isFinite(n)) return '--';
        return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function createTvChartInstance(container, candles, options, computed) {
        const LWC = window.LightweightCharts;
        if (!LWC || !container) return null;

        const pal = getThemePalette();
        const width = Math.max(320, container.clientWidth || 720);
        const height = Math.max(380, container.clientHeight || 560);
        const ind = options.indicators || {
            ma: true,
            rsi: true,
            macd: true,
            bb: options.showBB !== false,
            vol: true,
            vwap: true
        };
        const showBB = options.showBB !== false && ind.bb !== false;
        const hasRealVolume = candles.some(c => Number(c.volume) > 0);
        const showVol = Boolean(ind.vol) && hasRealVolume;
        const showRsi = Boolean(ind.rsi);
        const showMacd = Boolean(ind.macd);

        container.innerHTML = '';

        const chart = LWC.createChart(container, {
            width,
            height,
            layout: {
                background: { type: LWC.ColorType.Solid, color: pal.bg },
                textColor: pal.textMuted,
                fontFamily: "'JetBrains Mono', 'Plus Jakarta Sans', monospace",
                fontSize: 12,
                panes: {
                    separatorColor: pal.border,
                    separatorHoverColor: pal.crosshair,
                    enableResize: true
                }
            },
            grid: {
                vertLines: { color: pal.grid },
                horzLines: { color: pal.grid }
            },
            crosshair: {
                mode: LWC.CrosshairMode.Normal,
                vertLine: { color: pal.crosshair, width: 1, style: LWC.LineStyle.Dashed, labelBackgroundColor: pal.crosshair },
                horzLine: { color: pal.crosshair, width: 1, style: LWC.LineStyle.Dashed, labelBackgroundColor: pal.crosshair }
            },
            rightPriceScale: {
                borderColor: pal.border,
                scaleMargins: { top: 0.08, bottom: 0.08 }
            },
            timeScale: {
                borderColor: pal.border,
                timeVisible: true,
                secondsVisible: false,
                rightOffset: 6,
                barSpacing: 8,
                minBarSpacing: 2.5
            },
            localization: {
                timeFormatter: (unixSec) => {
                    const d = new Date(unixSec * 1000);
                    const tf = options.interval || '10m';
                    if (tf === '1y' || tf === '5y') {
                        return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
                    }
                    return `${d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })} ${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
                }
            }
        });

        const priceFmt = getPrecisionForSymbol(options.symbol);
        const seriesMap = {};

        // Pane 0: Main Candlesticks
        const candleSeries = chart.addSeries(LWC.CandlestickSeries, {
            upColor: pal.upFill,
            downColor: pal.downFill,
            wickUpColor: pal.up,
            wickDownColor: pal.down,
            borderVisible: false,
            priceFormat: { type: 'price', precision: priceFmt.precision, minMove: priceFmt.minMove }
        }, 0);
        candleSeries.setData(candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
        seriesMap.candles = candleSeries;

        // Markers for recognized Candlestick Patterns
        try {
            if (typeof LWC.createSeriesMarkers === 'function' && computed.patternAnalysis?.markers) {
                const markerList = [];
                computed.patternAnalysis.markers.forEach((m, idx) => {
                    if (!m || !candles[idx]) return;
                    markerList.push({
                        time: candles[idx].time,
                        position: m.direction === 'BEARISH' ? 'aboveBar' : 'belowBar',
                        color: m.direction === 'BEARISH' ? '#ef4444' : (m.direction === 'BULLISH' ? '#22c55e' : '#f59e0b'),
                        shape: m.direction === 'BEARISH' ? 'arrowDown' : (m.direction === 'BULLISH' ? 'arrowUp' : 'circle'),
                        text: m.tag || ''
                    });
                });
                if (markerList.length > 0) {
                    LWC.createSeriesMarkers(candleSeries, markerList.slice(-18));
                }
            }
        } catch (_) {}

        // Bollinger Bands
        if (showBB) {
            seriesMap.bbUpper = chart.addSeries(LWC.LineSeries, { color: '#38bdf8', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, 0);
            seriesMap.bbMid = chart.addSeries(LWC.LineSeries, { color: '#f59e0b', lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false }, 0);
            seriesMap.bbLower = chart.addSeries(LWC.LineSeries, { color: '#38bdf8', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, 0);
            seriesMap.bbUpper.setData(toLinePoints(candles, computed.bb.upper));
            seriesMap.bbMid.setData(toLinePoints(candles, computed.bb.middle));
            seriesMap.bbLower.setData(toLinePoints(candles, computed.bb.lower));
        }

        // Moving Averages
        if (ind.ma) {
            seriesMap.ema9 = chart.addSeries(LWC.LineSeries, { color: '#f472b6', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false }, 0);
            seriesMap.ema21 = chart.addSeries(LWC.LineSeries, { color: '#2dd4bf', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false }, 0);
            seriesMap.sma50 = chart.addSeries(LWC.LineSeries, { color: '#a78bfa', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false }, 0);
            seriesMap.ema9.setData(toLinePoints(candles, computed.ema9));
            seriesMap.ema21.setData(toLinePoints(candles, computed.ema21));
            seriesMap.sma50.setData(toLinePoints(candles, computed.sma50));
        }

        // VWAP
        if (ind.vwap) {
            seriesMap.vwap = chart.addSeries(LWC.LineSeries, { color: '#facc15', lineWidth: 1.5, lineStyle: LWC.LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false }, 0);
            seriesMap.vwap.setData(toLinePoints(candles, computed.vwap));
        }

        // Target & Stop Loss Price Lines
        const priceLines = [];
        const applyTradePriceLines = (ts) => {
            while (priceLines.length) {
                const pl = priceLines.pop();
                try { candleSeries.removePriceLine(pl); } catch (_) {}
            }
            if (!ts) return;
            if (Number.isFinite(ts.target1) && ts.target1 > 0) {
                priceLines.push(candleSeries.createPriceLine({
                    price: ts.target1,
                    color: '#22c55e',
                    lineWidth: 1.5,
                    lineStyle: LWC.LineStyle.Dashed,
                    axisLabelVisible: true,
                    title: 'T1 Target'
                }));
            }
            if (Number.isFinite(ts.stopLoss) && ts.stopLoss > 0) {
                priceLines.push(candleSeries.createPriceLine({
                    price: ts.stopLoss,
                    color: '#ef4444',
                    lineWidth: 1.5,
                    lineStyle: LWC.LineStyle.Dashed,
                    axisLabelVisible: true,
                    title: 'SL'
                }));
            }
        };
        applyTradePriceLines(computed.tradeSignal);

        // Sub-pane 1: Volume Histogram
        if (showVol) {
            const volPane = chart.addPane();
            try { volPane.setHeight(Math.max(68, Math.round(height * 0.14))); } catch (_) {}
            seriesMap.volume = volPane.addSeries(LWC.HistogramSeries, {
                priceFormat: { type: 'volume' },
                priceLineVisible: false,
                lastValueVisible: false
            });
            seriesMap.volume.setData(candles.map(c => ({
                time: c.time,
                value: c.volume,
                color: c.close >= c.open ? 'rgba(34, 197, 94, 0.55)' : 'rgba(239, 68, 68, 0.55)'
            })));
        }

        // Sub-pane 2: RSI(14)
        if (showRsi) {
            const rsiPane = chart.addPane();
            try { rsiPane.setHeight(Math.max(76, Math.round(height * 0.16))); } catch (_) {}
            seriesMap.rsi = rsiPane.addSeries(LWC.LineSeries, {
                color: '#c084fc',
                lineWidth: 1.8,
                priceLineVisible: false
            });
            seriesMap.rsi.setData(toLinePoints(candles, computed.rsi));
            try {
                seriesMap.rsi.createPriceLine({ price: 70, color: 'rgba(239,68,68,0.55)', lineWidth: 1, lineStyle: LWC.LineStyle.Dotted, axisLabelVisible: false, title: '70' });
                seriesMap.rsi.createPriceLine({ price: 30, color: 'rgba(34,197,94,0.55)', lineWidth: 1, lineStyle: LWC.LineStyle.Dotted, axisLabelVisible: false, title: '30' });
            } catch (_) {}
        }

        // Sub-pane 3: MACD(12,26,9)
        if (showMacd) {
            const macdPane = chart.addPane();
            try { macdPane.setHeight(Math.max(82, Math.round(height * 0.17))); } catch (_) {}
            seriesMap.macdHist = macdPane.addSeries(LWC.HistogramSeries, { priceLineVisible: false, lastValueVisible: false });
            seriesMap.macdLine = macdPane.addSeries(LWC.LineSeries, { color: '#38bdf8', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });
            seriesMap.macdSig = macdPane.addSeries(LWC.LineSeries, { color: '#f97316', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });

            const histPts = [];
            for (let i = 0; i < candles.length; i++) {
                const h = computed.macd.hist?.[i];
                if (h !== null && h !== undefined && Number.isFinite(h)) {
                    histPts.push({ time: candles[i].time, value: h, color: h >= 0 ? 'rgba(34,197,94,0.55)' : 'rgba(239,68,68,0.55)' });
                }
            }
            seriesMap.macdHist.setData(histPts);
            seriesMap.macdLine.setData(toLinePoints(candles, computed.macd.macd || []));
            seriesMap.macdSig.setData(toLinePoints(candles, computed.macd.signal || []));
        }

        // Fit initial visible range
        if (options.visibleStartTime && candles.length > 5) {
            const fromTs = Number(options.visibleStartTime);
            const toTs = candles[candles.length - 1].time;
            if (Number.isFinite(fromTs) && fromTs < toTs) {
                try { chart.timeScale().setVisibleRange({ from: fromTs, to: toTs }); } catch (_) { chart.timeScale().fitContent(); }
            } else {
                chart.timeScale().fitContent();
            }
        } else {
            const maxBars = options.maxBars || 85;
            if (candles.length > maxBars) {
                try {
                    chart.timeScale().setVisibleRange({
                        from: candles[candles.length - maxBars].time,
                        to: candles[candles.length - 1].time
                    });
                } catch (_) {
                    chart.timeScale().fitContent();
                }
            } else {
                chart.timeScale().fitContent();
            }
        }

        // Crosshair hover OHLCV readout
        let hovering = false;
        const readoutEl = options.readoutId ? document.getElementById(options.readoutId) : null;
        chart.subscribeCrosshairMove((param) => {
            if (!readoutEl) return;
            if (!param || !param.time || !param.seriesData) {
                hovering = false;
                return;
            }
            const bar = param.seriesData.get(candleSeries);
            if (!bar) {
                hovering = false;
                return;
            }
            hovering = true;
            const d = new Date(Number(param.time) * 1000);
            const tStr = `${d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })} ${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
            const rsiPoint = seriesMap.rsi ? param.seriesData.get(seriesMap.rsi) : null;
            const rsiStr = rsiPoint && Number.isFinite(rsiPoint.value) ? ` · RSI ${rsiPoint.value.toFixed(1)}` : '';
            readoutEl.textContent = `${tStr} · O ${formatReadoutPrice(bar.open, options.symbol)} · H ${formatReadoutPrice(bar.high, options.symbol)} · L ${formatReadoutPrice(bar.low, options.symbol)} · C ${formatReadoutPrice(bar.close, options.symbol)}${rsiStr}`;
        });

        // Double click opens fullscreen tab
        if (!container.dataset.tvDblWired) {
            container.dataset.tvDblWired = '1';
            container.addEventListener('dblclick', (e) => {
                e.preventDefault();
                if (typeof window.openCandleChartFullscreenTab === 'function' && window.candleTabState) {
                    window.openCandleChartFullscreenTab(
                        window.candleTabState.symbol,
                        window.candleTabState.interval,
                        window.candleTabState.indicators
                    );
                }
            });
        }

        const resizeObserver = new ResizeObserver((entries) => {
            for (const ent of entries) {
                const w = Math.floor(ent.contentRect.width);
                const h = Math.floor(ent.contentRect.height);
                if (w > 100 && h > 160) {
                    try { chart.applyOptions({ width: w, height: h }); } catch (_) {}
                }
            }
        });
        resizeObserver.observe(container);

        const structureKey = `${options.symbol}|${options.interval}|${ind.ma}|${showRsi}|${showMacd}|${showBB}|${showVol}|${ind.vwap}|${pal.light}`;
        const stateObj = {
            chart,
            seriesMap,
            candles,
            options,
            resizeObserver,
            structureKey,
            applyTradePriceLines,
            isHovering: () => hovering
        };
        tvChartInstances.set(container.id, stateObj);
        return stateObj;
    }

    function renderOrUpdateMainChart(containerId, rawCandles, options = {}) {
        const container = document.getElementById(containerId);
        if (!container || typeof window.LightweightCharts === 'undefined') return null;

        const candles = sanitizeCandlesForTv(rawCandles);
        if (candles.length === 0) return null;

        const computed = computeChartAnalysisAndSeries(candles, options);
        const ind = options.indicators || {
            ma: true, rsi: true, macd: true, bb: options.showBB !== false, vol: true, vwap: true
        };
        const showBB = options.showBB !== false && ind.bb !== false;
        const hasRealVolume = candles.some(c => Number(c.volume) > 0);
        const showVol = Boolean(ind.vol) && hasRealVolume;
        const structureKey = `${options.symbol}|${options.interval}|${ind.ma}|${Boolean(ind.rsi)}|${Boolean(ind.macd)}|${showBB}|${showVol}|${Boolean(ind.vwap)}|${isLightTheme()}`;

        const existing = tvChartInstances.get(containerId);
        if (!existing || existing.structureKey !== structureKey || Math.abs(candles.length - existing.candles.length) > 3) {
            destroyTvChart(containerId);
            createTvChartInstance(container, candles, options, computed);
        } else {
            // Fast incremental update without wiping zoom/pan
            const last = candles[candles.length - 1];
            const prevLen = existing.candles.length;
            if (candles.length === prevLen && last) {
                existing.seriesMap.candles.update({ time: last.time, open: last.open, high: last.high, low: last.low, close: last.close });
                const li = candles.length - 1;
                if (existing.seriesMap.ema9 && Number.isFinite(computed.ema9[li])) existing.seriesMap.ema9.update({ time: last.time, value: computed.ema9[li] });
                if (existing.seriesMap.ema21 && Number.isFinite(computed.ema21[li])) existing.seriesMap.ema21.update({ time: last.time, value: computed.ema21[li] });
                if (existing.seriesMap.sma50 && Number.isFinite(computed.sma50[li])) existing.seriesMap.sma50.update({ time: last.time, value: computed.sma50[li] });
                if (existing.seriesMap.vwap && Number.isFinite(computed.vwap[li])) existing.seriesMap.vwap.update({ time: last.time, value: computed.vwap[li] });
                if (existing.seriesMap.bbUpper && Number.isFinite(computed.bb.upper[li])) existing.seriesMap.bbUpper.update({ time: last.time, value: computed.bb.upper[li] });
                if (existing.seriesMap.bbMid && Number.isFinite(computed.bb.middle[li])) existing.seriesMap.bbMid.update({ time: last.time, value: computed.bb.middle[li] });
                if (existing.seriesMap.bbLower && Number.isFinite(computed.bb.lower[li])) existing.seriesMap.bbLower.update({ time: last.time, value: computed.bb.lower[li] });
                if (existing.seriesMap.volume) existing.seriesMap.volume.update({ time: last.time, value: last.volume, color: last.close >= last.open ? 'rgba(34,197,94,0.55)' : 'rgba(239,68,68,0.55)' });
                if (existing.seriesMap.rsi && Number.isFinite(computed.rsi[li])) existing.seriesMap.rsi.update({ time: last.time, value: computed.rsi[li] });
                if (existing.seriesMap.macdHist && Number.isFinite(computed.macd.hist?.[li])) {
                    const h = computed.macd.hist[li];
                    existing.seriesMap.macdHist.update({ time: last.time, value: h, color: h >= 0 ? 'rgba(34,197,94,0.55)' : 'rgba(239,68,68,0.55)' });
                }
                if (existing.seriesMap.macdLine && Number.isFinite(computed.macd.macd?.[li])) existing.seriesMap.macdLine.update({ time: last.time, value: computed.macd.macd[li] });
                if (existing.seriesMap.macdSig && Number.isFinite(computed.macd.signal?.[li])) existing.seriesMap.macdSig.update({ time: last.time, value: computed.macd.signal[li] });
            } else {
                existing.seriesMap.candles.setData(candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
                if (existing.seriesMap.ema9) existing.seriesMap.ema9.setData(toLinePoints(candles, computed.ema9));
                if (existing.seriesMap.ema21) existing.seriesMap.ema21.setData(toLinePoints(candles, computed.ema21));
                if (existing.seriesMap.sma50) existing.seriesMap.sma50.setData(toLinePoints(candles, computed.sma50));
                if (existing.seriesMap.vwap) existing.seriesMap.vwap.setData(toLinePoints(candles, computed.vwap));
                if (existing.seriesMap.bbUpper) existing.seriesMap.bbUpper.setData(toLinePoints(candles, computed.bb.upper));
                if (existing.seriesMap.bbMid) existing.seriesMap.bbMid.setData(toLinePoints(candles, computed.bb.middle));
                if (existing.seriesMap.bbLower) existing.seriesMap.bbLower.setData(toLinePoints(candles, computed.bb.lower));
                if (existing.seriesMap.volume) existing.seriesMap.volume.setData(candles.map(c => ({ time: c.time, value: c.volume, color: c.close >= c.open ? 'rgba(34,197,94,0.55)' : 'rgba(239,68,68,0.55)' })));
                if (existing.seriesMap.rsi) existing.seriesMap.rsi.setData(toLinePoints(candles, computed.rsi));
                if (existing.seriesMap.macdHist) {
                    const hp = [];
                    for (let i = 0; i < candles.length; i++) {
                        const h = computed.macd.hist?.[i];
                        if (h !== null && h !== undefined && Number.isFinite(h)) hp.push({ time: candles[i].time, value: h, color: h >= 0 ? 'rgba(34,197,94,0.55)' : 'rgba(239,68,68,0.55)' });
                    }
                    existing.seriesMap.macdHist.setData(hp);
                }
                if (existing.seriesMap.macdLine) existing.seriesMap.macdLine.setData(toLinePoints(candles, computed.macd.macd || []));
                if (existing.seriesMap.macdSig) existing.seriesMap.macdSig.setData(toLinePoints(candles, computed.macd.signal || []));
            }
            existing.candles = candles;
            existing.options = options;
            existing.applyTradePriceLines(computed.tradeSignal);
        }

        return computed.analysis;
    }

    function zoomChart(containerId, action) {
        const entry = tvChartInstances.get(containerId);
        if (!entry) return;
        const ts = entry.chart.timeScale();
        if (action === 'reset') {
            ts.fitContent();
            return;
        }
        const range = ts.getVisibleLogicalRange();
        if (!range) return;
        const span = Math.max(8, range.to - range.from);
        if (action === 'zoom-in') {
            const shrink = span * 0.18;
            ts.setVisibleLogicalRange({ from: range.from + shrink, to: range.to });
        } else if (action === 'zoom-out') {
            const grow = span * 0.22;
            ts.setVisibleLogicalRange({ from: range.from - grow, to: range.to });
        } else if (action === 'pan-left') {
            const step = span * 0.25;
            ts.setVisibleLogicalRange({ from: range.from - step, to: range.to - step });
        } else if (action === 'pan-right') {
            const step = span * 0.25;
            ts.setVisibleLogicalRange({ from: range.from + step, to: range.to + step });
        }
    }

    function isChartHovering(containerId) {
        const entry = tvChartInstances.get(containerId);
        return entry ? entry.isHovering() : false;
    }

    // =====================================================================
    // APACHE ECHARTS v6 — Market Mood Index Gauge & Portfolio Analytics
    // =====================================================================
    function getOrCreateEChart(containerId) {
        const el = document.getElementById(containerId);
        if (!el || typeof window.echarts === 'undefined') return null;
        let rec = echartsInstances.get(containerId);
        if (!rec || rec.el !== el) {
            if (rec) {
                try { rec.resizeObserver?.disconnect(); } catch (_) {}
                try { rec.instance?.dispose(); } catch (_) {}
            }
            const instance = window.echarts.init(el, null, { renderer: 'canvas' });
            const ro = new ResizeObserver(() => {
                try { instance.resize(); } catch (_) {}
            });
            ro.observe(el);
            rec = { el, instance, resizeObserver: ro, lastKind: null, lastPayload: null };
            echartsInstances.set(containerId, rec);
        }
        return rec;
    }

    function renderEChartsMmiGauge(containerId, mmi) {
        if (!mmi || !Number.isFinite(Number(mmi.value))) return;
        const rec = getOrCreateEChart(containerId);
        if (!rec) return;

        const val = Math.max(0, Math.min(100, Number(mmi.value)));
        const light = isLightTheme();
        const zoneLabel = val < 30 ? 'EXTREME FEAR' : (val < 50 ? 'FEAR' : (val < 70 ? 'GREED' : 'EXTREME GREED'));
        const zoneColor = val < 30 ? '#16a34a' : (val < 50 ? '#f59e0b' : (val < 70 ? '#f97316' : '#dc2626'));

        rec.lastKind = 'mmi';
        rec.lastPayload = mmi;

        rec.instance.setOption({
            backgroundColor: 'transparent',
            series: [{
                type: 'gauge',
                startAngle: 215,
                endAngle: -35,
                min: 0,
                max: 100,
                splitNumber: 4,
                radius: '92%',
                center: ['50%', '58%'],
                axisLine: {
                    lineStyle: {
                        width: 14,
                        color: [
                            [0.3, '#16a34a'],
                            [0.5, '#f59e0b'],
                            [0.7, '#f97316'],
                            [1.0, '#dc2626']
                        ]
                    }
                },
                pointer: {
                    icon: 'path://M12.8,0.7l12,40.1H0.7L12.8,0.7z',
                    length: '56%',
                    width: 8,
                    offsetCenter: [0, '-10%'],
                    itemStyle: { color: light ? '#0f172a' : '#f8fafc' }
                },
                axisTick: { length: 6, lineStyle: { color: 'auto', width: 1.5 } },
                splitLine: { length: 12, lineStyle: { color: 'auto', width: 2 } },
                axisLabel: {
                    color: light ? '#475569' : '#94a3b8',
                    fontSize: 10,
                    distance: 18,
                    formatter: (v) => (v === 0 || v === 50 || v === 100 ? String(v) : '')
                },
                title: {
                    offsetCenter: [0, '36%'],
                    fontSize: 11,
                    fontWeight: 700,
                    color: zoneColor
                },
                detail: {
                    valueAnimation: true,
                    fontSize: 28,
                    fontWeight: 800,
                    fontFamily: "'JetBrains Mono', monospace",
                    offsetCenter: [0, '14%'],
                    color: zoneColor,
                    formatter: (v) => v.toFixed(1)
                },
                data: [{ value: val, name: zoneLabel }]
            }]
        }, true);
    }

    function renderPortfolioAnalyticsCharts(portfolioItems, livePricesMap) {
        const allocEl = document.getElementById('port-echarts-allocation');
        const pnlEl = document.getElementById('port-echarts-pnl');
        if (!allocEl && !pnlEl) return;

        const light = isLightTheme();
        const textMuted = light ? '#64748b' : '#94a3b8';
        const textMain = light ? '#0f172a' : '#f8fafc';
        const gridColor = light ? 'rgba(15,23,42,0.08)' : 'rgba(148,163,184,0.12)';

        const bySymbol = new Map();
        (portfolioItems || []).forEach(item => {
            const sym = String(item.companySymbol || '').trim().toUpperCase();
            if (!sym) return;
            const qty = parseInt(item.quantity, 10) || 0;
            const buyRate = parseFloat(item.buyRate) || 0;
            const buyAmt = qty * buyRate;
            const hasSold = Boolean(item.sellRate && item.sellDate);
            const livePrice = livePricesMap && typeof livePricesMap.get === 'function' ? livePricesMap.get(item.companySymbol) : null;
            const refPrice = hasSold ? parseFloat(item.sellRate) : (Number.isFinite(livePrice) ? livePrice : buyRate);
            const pnl = (qty * refPrice) - buyAmt;
            const prev = bySymbol.get(sym) || { sym, invested: 0, pnl: 0, activeAmt: 0 };
            prev.invested += buyAmt;
            if (!hasSold) prev.activeAmt += buyAmt;
            prev.pnl += pnl;
            bySymbol.set(sym, prev);
        });

        const entries = Array.from(bySymbol.values());
        const allocList = entries
            .filter(e => e.activeAmt > 0 || e.invested > 0)
            .sort((a, b) => (b.activeAmt || b.invested) - (a.activeAmt || a.invested))
            .slice(0, 8);

        if (allocEl) {
            const rec = getOrCreateEChart('port-echarts-allocation');
            if (rec) {
                rec.lastKind = 'port-alloc';
                rec.lastPayload = { portfolioItems, livePricesMap };
                if (allocList.length === 0) {
                    rec.instance.setOption({
                        backgroundColor: 'transparent',
                        title: { text: 'No Holdings Yet', left: 'center', top: 'center', textStyle: { color: textMuted, fontSize: 13, fontWeight: 500 } },
                        series: []
                    }, true);
                } else {
                    rec.instance.setOption({
                        backgroundColor: 'transparent',
                        tooltip: { trigger: 'item', formatter: '{b}: ₹{c} ({d}%)' },
                        legend: { orient: 'vertical', right: 8, top: 'center', textStyle: { color: textMuted, fontSize: 11 } },
                        series: [{
                            type: 'pie',
                            radius: ['52%', '78%'],
                            center: ['36%', '50%'],
                            avoidLabelOverlap: true,
                            itemStyle: { borderRadius: 5, borderColor: light ? '#ffffff' : '#0d1526', borderWidth: 2 },
                            label: { show: false },
                            data: allocList.map(x => ({
                                name: x.sym,
                                value: Math.round(x.activeAmt > 0 ? x.activeAmt : x.invested)
                            }))
                        }]
                    }, true);
                }
            }
        }

        if (pnlEl) {
            const rec = getOrCreateEChart('port-echarts-pnl');
            if (rec) {
                rec.lastKind = 'port-pnl';
                rec.lastPayload = { portfolioItems, livePricesMap };
                const pnlTop = [...entries].sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl)).slice(0, 8);
                if (pnlTop.length === 0) {
                    rec.instance.setOption({
                        backgroundColor: 'transparent',
                        title: { text: 'No P&L Data Yet', left: 'center', top: 'center', textStyle: { color: textMuted, fontSize: 13, fontWeight: 500 } },
                        series: []
                    }, true);
                } else {
                    rec.instance.setOption({
                        backgroundColor: 'transparent',
                        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
                        grid: { left: 82, right: 24, top: 14, bottom: 26 },
                        xAxis: {
                            type: 'value',
                            axisLabel: { color: textMuted, fontSize: 10, formatter: (v) => (v >= 1000 || v <= -1000 ? `${(v / 1000).toFixed(1)}k` : v) },
                            splitLine: { lineStyle: { color: gridColor } }
                        },
                        yAxis: {
                            type: 'category',
                            data: pnlTop.map(x => x.sym).reverse(),
                            axisLabel: { color: textMain, fontSize: 11, fontWeight: 600 },
                            axisLine: { lineStyle: { color: gridColor } }
                        },
                        series: [{
                            type: 'bar',
                            barMaxWidth: 18,
                            data: pnlTop.map(x => ({
                                value: Number(x.pnl.toFixed(2)),
                                itemStyle: { color: x.pnl >= 0 ? '#22c55e' : '#ef4444', borderRadius: x.pnl >= 0 ? [0, 4, 4, 0] : [4, 0, 0, 4] }
                            })).reverse()
                        }]
                    }, true);
                }
            }
        }
    }

    function refreshThemes() {
        // Re-render active TV charts with updated light/dark palette
        tvChartInstances.forEach((entry, containerId) => {
            if (entry.candles && entry.candles.length > 0) {
                renderOrUpdateMainChart(containerId, entry.candles, entry.options);
            }
        });
        // Re-render active ECharts instances
        echartsInstances.forEach((rec, containerId) => {
            if (rec.lastKind === 'mmi' && rec.lastPayload) {
                renderEChartsMmiGauge(containerId, rec.lastPayload);
            } else if (rec.lastKind === 'port-alloc' && rec.lastPayload) {
                renderPortfolioAnalyticsCharts(rec.lastPayload.portfolioItems, rec.lastPayload.livePricesMap);
            }
        });
    }

    window.RfTvCharts = {
        renderOrUpdateMainChart,
        zoomChart,
        isChartHovering,
        destroyTvChart,
        renderEChartsMmiGauge,
        renderPortfolioAnalyticsCharts,
        refreshThemes
    };
})();
