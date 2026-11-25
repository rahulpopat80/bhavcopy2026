// Vercel Serverless Function: /api/live-market.js
// Unified ultra-fast live feed (150ms micro-cache) for 2x/second (500ms) polling:
// - NIFTY 50, SENSEX (Groww + TradingView + Moneycontrol)
// - GOLD / 10g (INR) & SILVER / 1kg (INR) (MCX Live + real-time FX/Bullion parity delta between MCX ticks)
// - GOLD ($ USD) & SILVER ($ USD) (Swissquote BBO + TradingView TVC/OANDA Spot)
// - DOLLAR ($ - ₹ USD/INR) (TradingView PEPPERSTONE:USDINR + Yahoo fallback)
// - NASDAQ (^IXIC) & HANG SENG (^HSI) + full Global Indices (TradingView global/scan)
// - Market Advance & Decline (NSE breadth runs strictly in non-blocking background every 15s)

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let cachedPayload = null;
let cachedAt = 0;

let cachedBreadth = { nseMarket: null, nifty50Breadth: null, nifty50Index: null, ts: 0, inFlight: null };
let cachedExtraGlobal = {
    twii: null, sse3: null, nasdaq: null, hangseng: null, banknifty: null,
    dji: null, gspc: null, gdaxi: null, n225: null, sse1: null, ks11: null,
    ts: 0, inFlight: null
};
const tvScannerCache = new Map(); // market -> { map, ts, backoffUntil }

const metalPrevCache = {
    'GC=F': { prevClose: null, ts: 0 },
    'SI=F': { prevClose: null, ts: 0 }
};

// Track last official MCX snapshot + concurrent (spotUsd * usdInr) parity for seamless 2x/s real ticks
const mcxParityState = {
    GOLD: { basePrice: null, prevClose: null, lastUpd: '', baseFactor: null, updatedAt: 0 },
    SILVER: { basePrice: null, prevClose: null, lastUpd: '', baseFactor: null, updatedAt: 0 }
};

const mcxExpiryCache = {
    GOLD: { expiry: '2026-12-04', ts: 0 },
    SILVER: { expiry: '2026-12-04', ts: 0 }
};

async function fetchWithTimeout(url, options = {}, timeoutMs = 2500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

function toNum(val) {
    if (val === null || val === undefined || val === '') return NaN;
    return parseFloat(String(val).replace(/,/g, '').trim());
}

function round2(n) {
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : n;
}

function getTzClock(timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).formatToParts(new Date());
    const map = {};
    for (const p of parts) map[p.type] = p.value;
    const wd = map.weekday;
    const isWeekend = wd === 'Sat' || wd === 'Sun';
    const hour = Number(map.hour === '24' ? 0 : map.hour);
    const minute = Number(map.minute);
    const mins = hour * 60 + minute;
    return { wd, isWeekend, mins };
}

function isUsDstActive() {
    try {
        const tzPart = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            timeZoneName: 'short'
        }).formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value || '';
        return tzPart.includes('EDT');
    } catch {
        return true;
    }
}

export function getExchangeScheduleState(exchangeCode) {
    const code = String(exchangeCode || '').toUpperCase();
    if (code === 'FX_SPOT' || code === 'COMEX' || code === 'FX') {
        const et = getTzClock('America/New_York');
        if (et.wd === 'Sat') return 'CLOSED';
        if (et.wd === 'Fri' && et.mins >= 17 * 60) return 'CLOSED';
        if (et.wd === 'Sun' && et.mins < 17 * 60) return 'CLOSED';
        return 'OPEN';
    }
    if (code === 'NSE' || code === 'BSE') {
        const ist = getTzClock('Asia/Kolkata');
        if (ist.isWeekend) return 'CLOSED';
        if (ist.mins >= 9 * 60 && ist.mins < 9 * 60 + 15) return 'PRE';
        if (ist.mins >= 9 * 60 + 15 && ist.mins <= 15 * 60 + 30) return 'OPEN';
        return 'CLOSED';
    }
    if (code === 'MCX') {
        const ist = getTzClock('Asia/Kolkata');
        if (ist.isWeekend) return 'CLOSED';
        const mcxCloseMins = isUsDstActive() ? (23 * 60 + 30) : (23 * 60 + 55);
        if (ist.mins >= 9 * 60 && ist.mins <= mcxCloseMins) return 'OPEN';
        return 'CLOSED';
    }
    if (code === 'NASDAQ' || code === 'US') {
        const et = getTzClock('America/New_York');
        if (et.isWeekend) return 'CLOSED';
        if (et.mins >= 4 * 60 && et.mins < 9 * 60 + 30) return 'PRE';
        if (et.mins >= 9 * 60 + 30 && et.mins <= 16 * 60) return 'OPEN';
        if (et.mins > 16 * 60 && et.mins <= 20 * 60) return 'POST';
        return 'CLOSED';
    }
    if (code === 'HKEX') {
        const hk = getTzClock('Asia/Hong_Kong');
        if (hk.isWeekend) return 'CLOSED';
        if ((hk.mins >= 9 * 60 + 30 && hk.mins <= 12 * 60) || (hk.mins >= 13 * 60 && hk.mins <= 16 * 60)) return 'OPEN';
        if (hk.mins > 12 * 60 && hk.mins < 13 * 60) return 'BREAK';
        return 'CLOSED';
    }
    if (code === 'XETRA') {
        const de = getTzClock('Europe/Berlin');
        if (de.isWeekend) return 'CLOSED';
        return (de.mins >= 9 * 60 && de.mins <= 17 * 60 + 30) ? 'OPEN' : 'CLOSED';
    }
    if (code === 'TSE') {
        const jp = getTzClock('Asia/Tokyo');
        if (jp.isWeekend) return 'CLOSED';
        return ((jp.mins >= 9 * 60 && jp.mins <= 11 * 60 + 30) || (jp.mins >= 12 * 60 + 30 && jp.mins <= 15 * 60 + 30)) ? 'OPEN' : 'CLOSED';
    }
    if (code === 'SSE') {
        const cn = getTzClock('Asia/Shanghai');
        if (cn.isWeekend) return 'CLOSED';
        return ((cn.mins >= 9 * 60 + 30 && cn.mins <= 11 * 60 + 30) || (cn.mins >= 13 * 60 && cn.mins <= 15 * 60)) ? 'OPEN' : 'CLOSED';
    }
    if (code === 'TWSE') {
        const tw = getTzClock('Asia/Taipei');
        if (tw.isWeekend) return 'CLOSED';
        return (tw.mins >= 9 * 60 && tw.mins <= 13 * 60 + 30) ? 'OPEN' : 'CLOSED';
    }
    if (code === 'KRX') {
        const kr = getTzClock('Asia/Seoul');
        if (kr.isWeekend) return 'CLOSED';
        return (kr.mins >= 9 * 60 && kr.mins <= 15 * 60 + 30) ? 'OPEN' : 'CLOSED';
    }
    return 'CLOSED';
}

function getMcxCandidateExpiries(preferred) {
    const candidates = [];
    if (preferred) candidates.push(preferred);
    const now = new Date();
    for (let mOffset = 0; mOffset <= 3; mOffset++) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + mOffset, 1));
        const yr = d.getUTCFullYear();
        const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
        for (const day of ['05', '04', '03', '06', '15', '20', '28']) {
            const iso = `${yr}-${mo}-${day}`;
            if (!candidates.includes(iso)) candidates.push(iso);
        }
    }
    return candidates;
}

async function fetchMcxCommodity(symbol) {
    const cachedExp = mcxExpiryCache[symbol];
    const now = Date.now();
    const tryExpiry = async (exp) => {
        const url = `https://priceapi.moneycontrol.com/pricefeed/mcx/commodityfutures/${symbol}?expiry=${encodeURIComponent(exp)}`;
        const r = await fetchWithTimeout(url, {
            headers: { 'User-Agent': UA, Accept: 'application/json', 'Cache-Control': 'no-cache' }
        }, 1800);
        if (!r.ok) return null;
        const j = await r.json();
        if (j?.code === '200' && j?.data && toNum(j.data.lastPrice) > 0) {
            const price = toNum(j.data.lastPrice);
            const prev = toNum(j.data.prevClose);
            const chg = Number.isFinite(toNum(j.data.change)) ? toNum(j.data.change) : (Number.isFinite(prev) ? price - prev : 0);
            const pct = Number.isFinite(toNum(j.data.perChange)) ? toNum(j.data.perChange) : (prev > 0 ? (chg / prev) * 100 : 0);
            mcxExpiryCache[symbol] = { expiry: exp, ts: now };
            return {
                price,
                prevClose: Number.isFinite(prev) && prev > 0 ? prev : price,
                change: chg,
                changePercent: pct,
                expiry: j.data.EXPIRY || exp,
                updatedTime: j.data.lastupdTime || '',
                lastUpdRaw: String(j.data.lastupd || j.data.lastupdEpoch || ''),
                source: 'MCX Live'
            };
        }
        return null;
    };

    if (cachedExp?.expiry) {
        const hit = await tryExpiry(cachedExp.expiry);
        if (hit) return hit;
    }

    const candidates = getMcxCandidateExpiries(cachedExp?.expiry).slice(0, 12);
    for (let i = 0; i < candidates.length; i += 4) {
        const batch = candidates.slice(i, i + 4);
        const results = await Promise.allSettled(batch.map(exp => tryExpiry(exp)));
        const found = results.find(r => r.status === 'fulfilled' && r.value);
        if (found) return found.value;
    }
    return null;
}

async function fetchYahooChart(symbol) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`;
    const r = await fetchWithTimeout(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' }
    }, 2500);
    if (!r.ok) throw new Error(`Yahoo HTTP ${r.status}`);
    const j = await r.json();
    const meta = j?.chart?.result?.[0]?.meta;
    if (!meta || !Number.isFinite(Number(meta.regularMarketPrice))) {
        throw new Error(`No Yahoo meta for ${symbol}`);
    }
    const price = Number(meta.regularMarketPrice);
    const prev = Number(meta.previousClose !== undefined ? meta.previousClose : meta.chartPreviousClose);
    const validPrev = Number.isFinite(prev) && prev > 0 ? prev : price;
    if (metalPrevCache[symbol]) {
        metalPrevCache[symbol] = { prevClose: validPrev, ts: Date.now() };
    }
    const change = price - validPrev;
    const changePercent = validPrev > 0 ? (change / validPrev) * 100 : 0;
    return { price, prevClose: validPrev, change, changePercent };
}

async function fetchTradingViewScanner(market, tickers, columns = ['close', 'change', 'change_abs', 'Bid', 'Ask']) {
    const cacheKey = `${market}:${tickers.length}`;
    const entry = tvScannerCache.get(cacheKey) || { map: new Map(), ts: 0, backoffUntil: 0 };
    const now = Date.now();
    const minIntervalMs = market === 'global' ? 3000 : 1200;
    if (now < entry.backoffUntil) {
        return entry.map;
    }
    if (entry.map.size > 0 && (now - entry.ts) < minIntervalMs) {
        return entry.map;
    }

    const r = await fetchWithTimeout(`https://scanner.tradingview.com/${market}/scan`, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
            symbols: { tickers, query: { types: [] } },
            columns
        })
    }, 1500);
    if (r.status === 429) {
        entry.backoffUntil = now + 20000;
        tvScannerCache.set(cacheKey, entry);
        return entry.map;
    }
    if (!r.ok) throw new Error(`TV ${market} HTTP ${r.status}`);
    const j = await r.json();
    const map = new Map();
    for (const row of (j?.data || [])) {
        const d = row?.d;
        if (!Array.isArray(d)) continue;
        const close = Number(d[0]);
        const pct = Number(d[1]);
        const chgAbs = Number(d[2]);
        const bid = Number(d[3]);
        const ask = Number(d[4]);
        const price = (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0)
            ? (bid + ask) / 2
            : close;
        if (!Number.isFinite(price) || price <= 0) continue;
        const prevClose = Number.isFinite(close - chgAbs) && (close - chgAbs) > 0 ? (close - chgAbs) : null;
        const change = Number.isFinite(chgAbs) ? (prevClose ? price - prevClose : chgAbs) : (prevClose ? price - prevClose : null);
        const finalPct = (prevClose && change !== null) ? (change / prevClose) * 100 : (Number.isFinite(pct) ? pct : null);
        map.set(row.s, {
            price,
            prevClose,
            change,
            changePercent: finalPct
        });
    }
    if (map.size > 0) {
        tvScannerCache.set(cacheKey, { map, ts: now, backoffUntil: 0 });
        return map;
    }
    return entry.map;
}

async function fetchSwissquoteBbo(instrument) {
    const r = await fetchWithTimeout(`https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/${instrument}`, {
        headers: { 'User-Agent': UA, Accept: 'application/json', 'Cache-Control': 'no-cache' }
    }, 600);
    if (!r.ok) return null;
    const arr = await r.json();
    const prices = arr?.[0]?.spreadProfilePrices?.[0];
    const bid = Number(prices?.bid);
    const ask = Number(prices?.ask);
    if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
        return (bid + ask) / 2;
    }
    return null;
}

async function fetchGrowwIndex(exchange, segment, symbol) {
    const url = `https://groww.in/v1/api/stocks_data/v1/tr_live_indices/exchange/${exchange}/segment/${segment}/${encodeURIComponent(symbol)}/latest`;
    const r = await fetchWithTimeout(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' }
    }, 1800);
    if (!r.ok) throw new Error(`Groww index HTTP ${r.status}`);
    const d = await r.json();
    const price = toNum(d.value ?? d.indexIndicativePrice ?? d.close);
    if (!Number.isFinite(price) || price <= 0) throw new Error(`Invalid Groww price for ${symbol}`);
    const prevClose = Number.isFinite(toNum(d.close)) && toNum(d.close) > 0 ? toNum(d.close) : null;
    const change = Number.isFinite(toNum(d.dayChange)) ? toNum(d.dayChange) : (prevClose ? price - prevClose : null);
    const changePercent = Number.isFinite(toNum(d.dayChangePerc)) ? toNum(d.dayChangePerc) : (prevClose && change !== null ? (change / prevClose) * 100 : null);
    return {
        price,
        change,
        changePercent,
        prevClose,
        exchange,
        marketState: getExchangeScheduleState(exchange),
        source: exchange === 'BSE' ? 'BSE Feed' : 'NSE Feed'
    };
}

async function fetchMcSensex() {
    const r = await fetchWithTimeout('https://priceapi.moneycontrol.com/pricefeed/notapplicable/inidicesindia/in%3BSEN', {
        headers: { 'User-Agent': UA, Accept: 'application/json' }
    }, 1800);
    if (!r.ok) throw new Error(`MC Sensex HTTP ${r.status}`);
    const j = await r.json();
    const d = j?.data;
    if (!d) throw new Error('Empty MC Sensex data');
    const price = toNum(d.pricecurrent);
    const prevClose = Number.isFinite(toNum(d.priceprevclose)) && toNum(d.priceprevclose) > 0 ? toNum(d.priceprevclose) : null;
    const change = Number.isFinite(toNum(d.pricechange)) ? toNum(d.pricechange) : (prevClose && Number.isFinite(price) ? price - prevClose : null);
    const changePercent = Number.isFinite(toNum(d.pricepercentchange)) ? toNum(d.pricepercentchange) : (prevClose && change !== null ? (change / prevClose) * 100 : null);
    const advances = Number.isFinite(toNum(d.adv)) ? Math.round(toNum(d.adv)) : null;
    const declines = Number.isFinite(toNum(d.decl)) ? Math.round(toNum(d.decl)) : null;
    return {
        index: Number.isFinite(price) && price > 0 ? {
            price,
            change,
            changePercent,
            prevClose,
            exchange: 'BSE',
            marketState: getExchangeScheduleState('BSE'),
            source: 'BSE Feed'
        } : null,
        breadth: (advances !== null && declines !== null) ? {
            advances,
            declines,
            unchanged: Math.max(0, 30 - advances - declines),
            total: 30,
            source: 'BSE SENSEX 30'
        } : null
    };
}

// Non-blocking background fetcher for NSE Advance/Decline (never stalls 500ms live stream)
function triggerBackgroundNseBreadth() {
    const now = Date.now();
    if (cachedBreadth.inFlight || (now - cachedBreadth.ts) < 15000) return;

    cachedBreadth.inFlight = (async () => {
        try {
            const headers = {
                'User-Agent': UA,
                Accept: 'application/json',
                Referer: 'https://www.nseindia.com/market-data/decline'
            };
            const [decRes, idxRes] = await Promise.allSettled([
                fetchWithTimeout('https://www.nseindia.com/api/live-analysis-decline', { headers }, 3500),
                fetchWithTimeout('https://www.nseindia.com/api/allIndices', { headers }, 3500)
            ]);

            if (decRes.status === 'fulfilled' && decRes.value.ok) {
                const decJson = await decRes.value.json();
                const cnt = decJson?.decline?.count || decJson?.advance?.count;
                if (cnt) {
                    cachedBreadth.nseMarket = {
                        advances: Number(cnt.Advances ?? cnt.advances ?? 0),
                        declines: Number(cnt.Declines ?? cnt.declines ?? 0),
                        unchanged: Number(cnt.Unchange ?? cnt.unchanged ?? 0),
                        total: Number(cnt.Total ?? cnt.total ?? 0),
                        timestamp: decJson.timestamp || '',
                        source: 'nseindia.com/market-data/decline'
                    };
                }
            }
            if (idxRes.status === 'fulfilled' && idxRes.value.ok) {
                const idxJson = await idxRes.value.json();
                const nItem = Array.isArray(idxJson?.data) ? idxJson.data.find(x => x.index === 'NIFTY 50') : null;
                if (nItem) {
                    const p = toNum(nItem.last);
                    if (Number.isFinite(p)) {
                        cachedBreadth.nifty50Index = {
                            price: p,
                            change: toNum(nItem.variation) || 0,
                            changePercent: toNum(nItem.percentChange) || 0,
                            prevClose: toNum(nItem.previousClose),
                            source: 'NSE Live'
                        };
                    }
                    const adv = toNum(nItem.advances);
                    const dec = toNum(nItem.declines);
                    const unc = toNum(nItem.unchanged);
                    if (Number.isFinite(adv) && Number.isFinite(dec)) {
                        cachedBreadth.nifty50Breadth = {
                            advances: adv,
                            declines: dec,
                            unchanged: Number.isFinite(unc) ? unc : 0,
                            total: adv + dec + (Number.isFinite(unc) ? unc : 0),
                            source: 'NSE NIFTY 50'
                        };
                    }
                }
            }
        } catch {
            // keep last cached values
        } finally {
            cachedBreadth.ts = Date.now();
            cachedBreadth.inFlight = null;
        }
    })();
}

// Background fetcher for Global Indices (covers Yahoo fallback when TradingView global/scan rate-limits)
function triggerBackgroundExtraGlobal() {
    const now = Date.now();
    if (cachedExtraGlobal.inFlight || (now - cachedExtraGlobal.ts) < 3500) return;

    cachedExtraGlobal.inFlight = (async () => {
        try {
            const pairs = [
                ['twii', '^TWII'],
                ['sse3', '000003.SS'],
                ['nasdaq', '^IXIC'],
                ['hangseng', '^HSI'],
                ['banknifty', '^NSEBANK'],
                ['dji', '^DJI'],
                ['gspc', '^GSPC'],
                ['gdaxi', '^GDAXI'],
                ['n225', '^N225'],
                ['sse1', '000001.SS'],
                ['ks11', '^KS11']
            ];
            const settled = await Promise.allSettled(pairs.map(([, sym]) => fetchYahooChart(sym)));
            settled.forEach((res, idx) => {
                if (res.status === 'fulfilled' && res.value) {
                    const key = pairs[idx][0];
                    cachedExtraGlobal[key] = { ...res.value, source: 'Yahoo Finance' };
                }
            });
        } catch {
            // ignore
        } finally {
            cachedExtraGlobal.ts = Date.now();
            cachedExtraGlobal.inFlight = null;
        }
    })();
}

function applyMcxLiveParity(symKey, mcxItem, spotUsdItem, usdInrItem) {
    const mcxState = getExchangeScheduleState('MCX');
    const fxState = getExchangeScheduleState('FX_SPOT');
    const unit = symKey === 'GOLD' ? '₹/10g' : '₹/kg';
    const currentFactor = (spotUsdItem?.price > 0 && usdInrItem?.price > 0)
        ? (spotUsdItem.price * usdInrItem.price)
        : null;
    const state = mcxParityState[symKey];

    if (mcxItem && Number.isFinite(mcxItem.price) && mcxItem.price > 0) {
        const mcxChanged = !state.basePrice
            || Math.abs(mcxItem.price - state.basePrice) >= 0.01
            || (mcxItem.lastUpdRaw && mcxItem.lastUpdRaw !== state.lastUpd);

        if (mcxChanged) {
            state.basePrice = mcxItem.price;
            state.prevClose = mcxItem.prevClose;
            state.lastUpd = mcxItem.lastUpdRaw || '';
            state.baseFactor = currentFactor;
            state.updatedAt = Date.now();
        }

        // Only adjust between MCX ticks using live Spot*FX when MCX OR Spot FX is actively open;
        // label transparently whether MCX itself is OPEN or CLOSED (indicative COMEX parity).
        if (mcxState === 'OPEN') {
            if (!mcxChanged && currentFactor && state.baseFactor && state.basePrice) {
                const ratio = currentFactor / state.baseFactor;
                if (Number.isFinite(ratio) && Math.abs(ratio - 1) < 0.05) {
                    const livePrice = round2(state.basePrice * ratio);
                    const prevClose = round2(state.prevClose || state.basePrice);
                    const change = round2(livePrice - prevClose);
                    const changePercent = prevClose > 0 ? round2((change / prevClose) * 100) : null;
                    return {
                        price: livePrice,
                        prevClose,
                        change,
                        changePercent,
                        expiry: mcxItem.expiry,
                        updatedTime: mcxItem.updatedTime,
                        unit,
                        exchange: 'MCX',
                        marketState: 'OPEN',
                        source: 'MCX + Spot FX Live'
                    };
                }
            }
            return {
                price: round2(mcxItem.price),
                prevClose: round2(mcxItem.prevClose),
                change: round2(mcxItem.change),
                changePercent: round2(mcxItem.changePercent),
                expiry: mcxItem.expiry,
                updatedTime: mcxItem.updatedTime,
                unit,
                exchange: 'MCX',
                marketState: 'OPEN',
                source: 'MCX Live'
            };
        }

        // MCX is closed: if global Spot Bullion + FX is still open, show indicative COMEX/Spot parity clearly labeled
        if (fxState === 'OPEN' && currentFactor && state.baseFactor && state.basePrice) {
            const ratio = currentFactor / state.baseFactor;
            if (Number.isFinite(ratio) && Math.abs(ratio - 1) < 0.06) {
                const livePrice = round2(state.basePrice * ratio);
                const prevClose = round2(state.prevClose || state.basePrice);
                const change = round2(livePrice - prevClose);
                const changePercent = prevClose > 0 ? round2((change / prevClose) * 100) : null;
                return {
                    price: livePrice,
                    prevClose,
                    change,
                    changePercent,
                    expiry: mcxItem.expiry,
                    updatedTime: mcxItem.updatedTime,
                    mcxClose: round2(mcxItem.price),
                    unit,
                    exchange: 'MCX (Closed) · COMEX Parity',
                    marketState: 'PARITY',
                    source: 'COMEX Spot Parity'
                };
            }
        }

        return {
            price: round2(mcxItem.price),
            prevClose: round2(mcxItem.prevClose),
            change: round2(mcxItem.change),
            changePercent: round2(mcxItem.changePercent),
            expiry: mcxItem.expiry,
            updatedTime: mcxItem.updatedTime,
            unit,
            exchange: 'MCX',
            marketState: 'CLOSED',
            source: 'MCX Closed (Last Traded)'
        };
    }

    // Fallback when MCX endpoint itself is unreachable
    if (spotUsdItem?.price > 0 && usdInrItem?.price > 0) {
        const gramsFactor = symKey === 'GOLD' ? (10 / 31.1034768) : (1000 / 31.1034768);
        const price = round2(spotUsdItem.price * usdInrItem.price * gramsFactor);
        const prev = round2((spotUsdItem.prevClose || spotUsdItem.price) * (usdInrItem.prevClose || usdInrItem.price) * gramsFactor);
        const change = round2(price - prev);
        const changePercent = prev > 0 ? round2((change / prev) * 100) : null;
        return {
            price,
            prevClose: prev,
            change,
            changePercent,
            unit,
            exchange: 'COMEX/FX Spot',
            marketState: fxState,
            source: 'COMEX Spot Parity'
        };
    }

    return null;
}

function decorateWithExchange(item, exchangeCode, fallbackSource = '') {
    if (!item || !Number.isFinite(Number(item.price)) || Number(item.price) <= 0) return null;
    return {
        ...item,
        exchange: item.exchange || exchangeCode,
        marketState: item.marketState || getExchangeScheduleState(exchangeCode),
        source: item.source || fallbackSource
    };
}

export async function getLiveMarketSnapshot() {
    if (cachedPayload && (Date.now() - cachedAt) < 120) {
        return cachedPayload;
    }

    triggerBackgroundNseBreadth();
    triggerBackgroundExtraGlobal();

    const [
        growwNiftyRes,
        growwSensexRes,
        mcSensexRes,
        mcxGoldRes,
        mcxSilverRes,
        tvForexRes,
        tvCfdRes,
        tvGlobalRes,
        sqGoldRes,
        sqSilverRes
    ] = await Promise.allSettled([
        fetchGrowwIndex('NSE', 'CASH', 'NIFTY'),
        fetchGrowwIndex('BSE', 'CASH', '1'),
        fetchMcSensex(),
        fetchMcxCommodity('GOLD'),
        fetchMcxCommodity('SILVER'),
        fetchTradingViewScanner('forex', ['PEPPERSTONE:USDINR']),
        fetchTradingViewScanner('cfd', ['TVC:GOLD', 'TVC:SILVER', 'OANDA:XAUUSD', 'OANDA:XAGUSD']),
        fetchTradingViewScanner('global', [
            'NSE:NIFTY', 'BSE:SENSEX', 'NSE:BANKNIFTY',
            'NASDAQ:IXIC', 'DJ:DJI', 'SP:SPX', 'XETR:DAX',
            'TVC:NI225', 'HSI:HSI', 'SSE:000001', 'KRX:KOSPI'
        ], ['close', 'change', 'change_abs']),
        fetchSwissquoteBbo('XAU/USD'),
        fetchSwissquoteBbo('XAG/USD')
    ]);

    const tvForex = tvForexRes.status === 'fulfilled' ? tvForexRes.value : new Map();
    const tvCfd = tvCfdRes.status === 'fulfilled' ? tvCfdRes.value : new Map();
    const tvGlobal = tvGlobalRes.status === 'fulfilled' ? tvGlobalRes.value : new Map();
    const mcSensexData = mcSensexRes.status === 'fulfilled' ? mcSensexRes.value : {};
    const fxMarketState = getExchangeScheduleState('FX_SPOT');

    // 1. USD / INR (DOLLAR)
    let usdInr = tvForex.get('PEPPERSTONE:USDINR')
        ? { ...tvForex.get('PEPPERSTONE:USDINR'), symbol: 'INR=X', currency: 'INR', exchange: 'FX', marketState: fxMarketState, source: 'FX Interbank' }
        : (cachedPayload?.usdInr || null);

    // 2. GOLD ($ USD) & SILVER ($ USD) — sub-second TradingView Spot + Swissquote BBO
    const tvGoldSpot = tvCfd.get('TVC:GOLD') || tvCfd.get('OANDA:XAUUSD') || null;
    const tvSilverSpot = tvCfd.get('TVC:SILVER') || tvCfd.get('OANDA:XAGUSD') || null;
    const sqGoldMid = sqGoldRes.status === 'fulfilled' ? sqGoldRes.value : null;
    const sqSilverMid = sqSilverRes.status === 'fulfilled' ? sqSilverRes.value : null;

    let goldUsd = null;
    if (sqGoldMid && tvGoldSpot?.prevClose) {
        const change = sqGoldMid - tvGoldSpot.prevClose;
        goldUsd = {
            price: sqGoldMid,
            prevClose: tvGoldSpot.prevClose,
            change,
            changePercent: (change / tvGoldSpot.prevClose) * 100,
            currency: 'USD',
            symbol: 'GC=F',
            unit: '$/oz',
            exchange: 'SPOT',
            marketState: fxMarketState,
            source: 'Swissquote BBO'
        };
    } else if (tvGoldSpot) {
        goldUsd = { ...tvGoldSpot, currency: 'USD', symbol: 'GC=F', unit: '$/oz', exchange: 'SPOT', marketState: fxMarketState, source: 'TradingView Spot' };
    } else if (cachedPayload?.goldUsd) {
        goldUsd = cachedPayload.goldUsd;
    }

    let silverUsd = null;
    if (sqSilverMid && tvSilverSpot?.prevClose) {
        const change = sqSilverMid - tvSilverSpot.prevClose;
        silverUsd = {
            price: sqSilverMid,
            prevClose: tvSilverSpot.prevClose,
            change,
            changePercent: (change / tvSilverSpot.prevClose) * 100,
            currency: 'USD',
            symbol: 'SI=F',
            unit: '$/oz',
            exchange: 'SPOT',
            marketState: fxMarketState,
            source: 'Swissquote BBO'
        };
    } else if (tvSilverSpot) {
        silverUsd = { ...tvSilverSpot, currency: 'USD', symbol: 'SI=F', unit: '$/oz', exchange: 'SPOT', marketState: fxMarketState, source: 'TradingView Spot' };
    } else if (cachedPayload?.silverUsd) {
        silverUsd = cachedPayload.silverUsd;
    }

    // 3. NIFTY 50 & SENSEX
    let nifty = growwNiftyRes.status === 'fulfilled'
        ? growwNiftyRes.value
        : (tvGlobal.get('NSE:NIFTY')
            ? decorateWithExchange(tvGlobal.get('NSE:NIFTY'), 'NSE', 'TradingView NSE')
            : (cachedBreadth.nifty50Index ? decorateWithExchange(cachedBreadth.nifty50Index, 'NSE', 'NSE Feed') : null));

    let sensex = growwSensexRes.status === 'fulfilled'
        ? growwSensexRes.value
        : (mcSensexData.index || (tvGlobal.get('BSE:SENSEX') ? decorateWithExchange(tvGlobal.get('BSE:SENSEX'), 'BSE', 'TradingView BSE') : null));

    // 4. NASDAQ, HANG SENG & BANK NIFTY (TradingView primary + Yahoo background/cold-start fallback)
    let nasdaq = tvGlobal.get('NASDAQ:IXIC')
        ? decorateWithExchange(tvGlobal.get('NASDAQ:IXIC'), 'NASDAQ', 'NASDAQ Feed')
        : (cachedExtraGlobal.nasdaq
            ? decorateWithExchange(cachedExtraGlobal.nasdaq, 'NASDAQ', 'Yahoo NASDAQ')
            : (cachedPayload?.nasdaq || null));
    let hangseng = tvGlobal.get('HSI:HSI')
        ? decorateWithExchange(tvGlobal.get('HSI:HSI'), 'HKEX', 'HKEX Feed')
        : (cachedExtraGlobal.hangseng
            ? decorateWithExchange(cachedExtraGlobal.hangseng, 'HKEX', 'Yahoo HKEX')
            : (cachedPayload?.hangseng || null));
    let banknifty = tvGlobal.get('NSE:BANKNIFTY')
        ? decorateWithExchange(tvGlobal.get('NSE:BANKNIFTY'), 'NSE', 'NSE Feed')
        : (cachedExtraGlobal.banknifty
            ? decorateWithExchange(cachedExtraGlobal.banknifty, 'NSE', 'Yahoo NSE')
            : (cachedPayload?.globalIndices?.['^NSEBANK'] || null));

    // Last-resort Yahoo fallbacks ONLY on cold start if primary sources failed
    const fallbacks = [];
    if (!usdInr) {
        fallbacks.push(fetchYahooChart('INR=X').then(d => { usdInr = { ...d, symbol: 'INR=X', currency: 'INR', exchange: 'FX', marketState: fxMarketState, source: 'Yahoo FX' }; }).catch(() => {}));
    }
    if (!goldUsd) {
        fallbacks.push(fetchYahooChart('GC=F').then(d => { goldUsd = { ...d, currency: 'USD', symbol: 'GC=F', unit: '$/oz', exchange: 'COMEX', marketState: fxMarketState, source: 'COMEX Yahoo' }; }).catch(() => {}));
    }
    if (!silverUsd) {
        fallbacks.push(fetchYahooChart('SI=F').then(d => { silverUsd = { ...d, currency: 'USD', symbol: 'SI=F', unit: '$/oz', exchange: 'COMEX', marketState: fxMarketState, source: 'COMEX Yahoo' }; }).catch(() => {}));
    }
    if (!nifty) {
        fallbacks.push(fetchYahooChart('^NSEI').then(d => { nifty = decorateWithExchange(d, 'NSE', 'Yahoo NSE'); }).catch(() => {}));
    }
    if (!sensex) {
        fallbacks.push(fetchYahooChart('^BSESN').then(d => { sensex = decorateWithExchange(d, 'BSE', 'Yahoo BSE'); }).catch(() => {}));
    }
    if (!nasdaq) {
        fallbacks.push(fetchYahooChart('^IXIC').then(d => {
            cachedExtraGlobal.nasdaq = d;
            nasdaq = decorateWithExchange(d, 'NASDAQ', 'Yahoo NASDAQ');
        }).catch(() => {}));
    }
    if (!hangseng) {
        fallbacks.push(fetchYahooChart('^HSI').then(d => {
            cachedExtraGlobal.hangseng = d;
            hangseng = decorateWithExchange(d, 'HKEX', 'Yahoo HKEX');
        }).catch(() => {}));
    }
    if (!banknifty) {
        fallbacks.push(fetchYahooChart('^NSEBANK').then(d => {
            cachedExtraGlobal.banknifty = d;
            banknifty = decorateWithExchange(d, 'NSE', 'Yahoo NSE');
        }).catch(() => {}));
    }
    if (fallbacks.length > 0) {
        await Promise.allSettled(fallbacks);
    }

    // 5. GOLD /10g (INR) & SILVER /1kg (INR)
    const mcxGold = mcxGoldRes.status === 'fulfilled' ? mcxGoldRes.value : null;
    const mcxSilver = mcxSilverRes.status === 'fulfilled' ? mcxSilverRes.value : null;

    let gold = applyMcxLiveParity('GOLD', mcxGold, goldUsd, usdInr);
    let silver = applyMcxLiveParity('SILVER', mcxSilver, silverUsd, usdInr);

    if (gold && goldUsd) gold = { ...gold, usd: goldUsd };
    if (silver && silverUsd) silver = { ...silver, usd: silverUsd };

    // 6. All Global Indices Live Map
    const globalIndices = {
        '^NSEBANK': banknifty,
        '^DJI': decorateWithExchange(tvGlobal.get('DJ:DJI') || cachedExtraGlobal.dji, 'US', 'NYSE/US Feed'),
        '^GSPC': decorateWithExchange(tvGlobal.get('SP:SPX') || cachedExtraGlobal.gspc, 'US', 'US Feed'),
        '^IXIC': nasdaq,
        '^GDAXI': decorateWithExchange(tvGlobal.get('XETR:DAX') || cachedExtraGlobal.gdaxi, 'XETRA', 'XETRA Feed'),
        '^N225': decorateWithExchange(tvGlobal.get('TVC:NI225') || cachedExtraGlobal.n225, 'TSE', 'TSE Feed'),
        '^HSI': hangseng,
        '000001.SS': decorateWithExchange(tvGlobal.get('SSE:000001') || cachedExtraGlobal.sse1, 'SSE', 'SSE Feed'),
        '000003.SS': decorateWithExchange(cachedExtraGlobal.sse3, 'SSE', 'Yahoo SSE'),
        '^TWII': decorateWithExchange(cachedExtraGlobal.twii, 'TWSE', 'Yahoo TWSE'),
        '^KS11': decorateWithExchange(tvGlobal.get('KRX:KOSPI') || cachedExtraGlobal.ks11, 'KRX', 'KRX Feed')
    };

    const payload = {
        nifty,
        sensex,
        gold,
        silver,
        goldUsd,
        silverUsd,
        usdInr,
        nasdaq,
        hangseng,
        globalIndices,
        exchangeStates: {
            NSE: getExchangeScheduleState('NSE'),
            BSE: getExchangeScheduleState('BSE'),
            MCX: getExchangeScheduleState('MCX'),
            FX: fxMarketState,
            NASDAQ: getExchangeScheduleState('NASDAQ'),
            HKEX: getExchangeScheduleState('HKEX')
        },
        breadth: {
            nseMarket: cachedBreadth.nseMarket || null,
            sensex30: mcSensexData.breadth || cachedPayload?.breadth?.sensex30 || null,
            nifty50: cachedBreadth.nifty50Breadth || null
        },
        updatedAt: new Date().toISOString()
    };

    cachedPayload = payload;
    cachedAt = Date.now();
    return payload;
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store, max-age=0');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const payload = await getLiveMarketSnapshot();
    return res.status(200).json(payload);
}
