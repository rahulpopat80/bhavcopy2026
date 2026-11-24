// Vercel Serverless Function: /api/yahoo.js
// Server-side proxy for Yahoo Finance OHLCV candles & sub-second live ticks:
// - 1m, 3m, 5m, 10m, 1d (1 Day), 5d (5 Days), 1w (1 Week), 1mo (1 Month), 1y (1 Year)
// - Plus ?tick=1 fast quote/tail endpoint (200ms micro-cache) & ?symbols=...&tick=1 batch quotes
// - Supports GOLD_INR (MCX ₹/10g), SILVER_INR (MCX ₹/1kg), GC=F ($), SI=F ($), ^NSEI, ^BSESN, ^NSEBANK, & NSE/BSE stocks

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const tickMicroCache = new Map();
const mcxExpiryCache = {
    GOLD: { expiry: '2026-12-04', ts: 0 },
    SILVER: { expiry: '2026-12-04', ts: 0 }
};

function toNum(val) {
    if (val === null || val === undefined || val === '') return NaN;
    return parseFloat(String(val).replace(/,/g, '').trim());
}

function normalizeUpstreamSymbol(rawSym) {
    const s = String(rawSym || '').toUpperCase().trim();
    if (s === 'NIFTY' || s === 'NIFTY 50' || s === 'NIFTY50') return '^NSEI';
    if (s === 'SENSEX' || s === 'BSE SENSEX' || s === 'BSESN') return '^BSESN';
    if (s === 'BANKNIFTY' || s === 'BANK NIFTY' || s === 'NIFTY BANK') return '^NSEBANK';
    if (s === '^CRSMID' || s === 'NIFTY MIDCAP 100' || s === 'NIFTY MID 100') return 'NIFTY_MIDCAP_100.NS';
    if (s === 'GOLD_INR' || s === 'GOLD INR' || s === 'MCX GOLD' || s === 'GOLD /10G' || s === 'GOLD / 10G' || s === 'GOLD (₹)') return 'GOLD_INR';
    if (s === 'SILVER_INR' || s === 'SILVER INR' || s === 'MCX SILVER' || s === 'SILVER /KG' || s === 'SILVER / 1KG' || s === 'SILVER (₹)') return 'SILVER_INR';
    if (s === 'GOLD' || s === 'GOLD ($)' || s === 'XAU' || s === 'XAUUSD' || s === 'COMEX GOLD') return 'GC=F';
    if (s === 'SILVER' || s === 'SILVER ($)' || s === 'XAG' || s === 'XAGUSD' || s === 'COMEX SILVER') return 'SI=F';
    if (s === 'NASDAQ' || s === 'IXIC') return '^IXIC';
    if (s === 'HANG SENG' || s === 'HANGSENG' || s === 'HSI') return '^HSI';
    const needsSuffix = !s.includes('.') && !s.includes('=') && !s.includes('^');
    return needsSuffix ? `${s}.NS` : s;
}

function getIstDayAndMin(unixSec) {
    const istSec = unixSec + 19800;
    const dayStartIst = Math.floor(istSec / 86400) * 86400;
    const minOfDay = Math.floor((istSec - dayStartIst) / 60);
    return { dayStartUnix: dayStartIst - 19800, minOfDay };
}

function isIndianMarketSymbol(sym) {
    const s = String(sym || '').toUpperCase();
    return s.endsWith('.NS') || s.endsWith('.BO') || s === '^NSEI' || s === '^BSESN' || s.startsWith('^NSE') || s.startsWith('^CNX');
}

function aggregateCandles(rawCandles, intervalMinutes, anchorMarketOpen = true) {
    if (!intervalMinutes || intervalMinutes <= 1) return rawCandles;
    const bucketSec = intervalMinutes * 60;
    const buckets = new Map();

    for (const c of rawCandles) {
        let bKey;
        if (anchorMarketOpen) {
            const { dayStartUnix } = getIstDayAndMin(c.time);
            const openUnix = dayStartUnix + 555 * 60;
            const offset = Math.max(0, c.time - openUnix);
            bKey = openUnix + Math.floor(offset / bucketSec) * bucketSec;
        } else {
            bKey = Math.floor(c.time / bucketSec) * bucketSec;
        }

        const existing = buckets.get(bKey);
        if (!existing) {
            buckets.set(bKey, {
                time: bKey,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                volume: c.volume
            });
        } else {
            existing.high = Math.max(existing.high, c.high);
            existing.low = Math.min(existing.low, c.low);
            existing.close = c.close;
            existing.volume += c.volume;
        }
    }
    return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}

function extractCleanCandles(yahooResult, requestedInterval, nsSymbol = '') {
    const ts = yahooResult?.timestamp || [];
    const quote = yahooResult?.indicators?.quote?.[0] || {};
    const opens = quote.open || [];
    const highs = quote.high || [];
    const lows = quote.low || [];
    const closes = quote.close || [];
    const vols = quote.volume || [];
    const indianIntraday = isIndianMarketSymbol(nsSymbol) && requestedInterval !== '1y';

    const raw = [];
    for (let i = 0; i < ts.length; i++) {
        const t = ts[i];
        const o = Number(opens[i]);
        const h = Number(highs[i]);
        const l = Number(lows[i]);
        const c = Number(closes[i]);
        const v = Number(vols[i] ?? 0);
        if (
            Number.isFinite(t) &&
            Number.isFinite(o) && o > 0 &&
            Number.isFinite(h) && h > 0 &&
            Number.isFinite(l) && l > 0 &&
            Number.isFinite(c) && c > 0
        ) {
            if (indianIntraday) {
                const { minOfDay } = getIstDayAndMin(t);
                if (minOfDay < 555 || minOfDay > 930) continue;
            }
            raw.push({
                time: t,
                open: o,
                high: Math.max(h, o, c),
                low: Math.min(l, o, c),
                close: c,
                volume: Number.isFinite(v) && v >= 0 ? v : 0
            });
        }
    }

    if (requestedInterval === '3m') return aggregateCandles(raw, 3, indianIntraday);
    if (requestedInterval === '10m') return aggregateCandles(raw, 10, indianIntraday);
    return raw;
}

function getIstDateKey(unixSec) {
    const istMs = (unixSec + 19800) * 1000;
    const d = new Date(istMs);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function computeVisibleStartTime(candles, tf) {
    if (!candles || candles.length === 0) return null;
    const lastTime = candles[candles.length - 1].time;

    if (tf === '1d') {
        const lastKey = getIstDateKey(lastTime);
        const found = candles.find(c => getIstDateKey(c.time) === lastKey);
        return found ? found.time : null;
    }
    if (tf === '5d' || tf === '1w') {
        const targetDays = tf === '5d' ? 5 : 7;
        const distinctDays = [];
        for (let i = candles.length - 1; i >= 0; i--) {
            const k = getIstDateKey(candles[i].time);
            if (!distinctDays.includes(k)) {
                distinctDays.push(k);
                if (distinctDays.length >= targetDays) {
                    const oldestKey = distinctDays[distinctDays.length - 1];
                    const first = candles.find(c => getIstDateKey(c.time) === oldestKey);
                    return first ? first.time : null;
                }
            }
        }
        return candles[0].time;
    }
    if (tf === '1mo') {
        return lastTime - 30 * 86400;
    }
    if (tf === '1y') {
        return lastTime - 365 * 86400;
    }
    return null;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 4500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function fetchYahooFromHosts(targetSym, rangeStr, intervalStr, timeoutMs = 4500) {
    const buildYahooUrl = (host) =>
        `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(targetSym)}?range=${encodeURIComponent(rangeStr)}&interval=${encodeURIComponent(intervalStr)}&includePrePost=false`;

    let response = await fetchWithTimeout(buildYahooUrl('query1'), {
        headers: {
            'User-Agent': UA,
            'Accept': 'application/json',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://finance.yahoo.com/',
            'Origin': 'https://finance.yahoo.com',
        },
    }, timeoutMs);

    if (!response.ok) {
        response = await fetchWithTimeout(buildYahooUrl('query2'), {
            headers: {
                'User-Agent': UA,
                'Accept': 'application/json',
                'Referer': 'https://finance.yahoo.com/',
            },
        }, timeoutMs);
    }
    return response;
}

async function fetchMcxCommodityPrice(commodity) {
    const cachedExp = mcxExpiryCache[commodity]?.expiry || '2026-12-04';
    const tryExpiry = async (exp) => {
        const r = await fetchWithTimeout(
            `https://priceapi.moneycontrol.com/pricefeed/mcx/commodityfutures/${commodity}?expiry=${encodeURIComponent(exp)}`,
            { headers: { 'User-Agent': UA, Accept: 'application/json' } },
            1800
        );
        if (!r.ok) return null;
        const j = await r.json();
        const price = toNum(j?.data?.lastPrice);
        if (j?.code === '200' && Number.isFinite(price) && price > 0) {
            mcxExpiryCache[commodity] = { expiry: exp, ts: Date.now() };
            const prev = toNum(j.data.prevClose);
            return { price, prevClose: Number.isFinite(prev) && prev > 0 ? prev : price };
        }
        return null;
    };

    const hit = await tryExpiry(cachedExp);
    if (hit) return hit;

    const now = new Date();
    const candidates = [];
    for (let mOffset = 0; mOffset <= 3; mOffset++) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + mOffset, 1));
        const yr = d.getUTCFullYear();
        const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
        for (const day of ['04', '05', '03', '06']) {
            const iso = `${yr}-${mo}-${day}`;
            if (iso !== cachedExp) candidates.push(iso);
        }
    }
    for (let i = 0; i < Math.min(candidates.length, 8); i += 4) {
        const resArr = await Promise.allSettled(candidates.slice(i, i + 4).map(e => tryExpiry(e)));
        const ok = resArr.find(x => x.status === 'fulfilled' && x.value);
        if (ok) return ok.value;
    }
    return null;
}

async function fetchSwissquoteSpot(instrument) {
    try {
        const r = await fetchWithTimeout(
            `https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/${instrument}`,
            { headers: { 'User-Agent': UA, Accept: 'application/json' } },
            1100
        );
        if (!r.ok) return null;
        const arr = await r.json();
        const p = arr?.[0]?.spreadProfilePrices?.[0];
        const bid = Number(p?.bid);
        const ask = Number(p?.ask);
        if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
            return (bid + ask) / 2;
        }
    } catch (_) {}
    return null;
}

function buildTickResponse(nsSymbol, companyName, livePrice, prevClose, liveTime, liveVolume, latestBar, recentBars = []) {
    return {
        tick: true,
        resolvedSymbol: nsSymbol,
        companyName,
        livePrice,
        prevClose,
        liveTime,
        liveVolume,
        latestBar,
        recentBars,
        chart: {
            result: [{
                meta: {
                    symbol: nsSymbol,
                    longName: companyName,
                    regularMarketPrice: livePrice,
                    previousClose: prevClose || livePrice,
                    regularMarketTime: liveTime,
                    regularMarketVolume: liveVolume || 0
                }
            }]
        }
    };
}

async function fetchFastTickForSymbol(nsSymbol) {
    const cachedTick = tickMicroCache.get(nsSymbol);
    if (cachedTick && (Date.now() - cachedTick.ts) < 200) {
        return cachedTick.payload;
    }

    // 1. MCX Gold / Silver INR fast path
    if (nsSymbol === 'GOLD_INR' || nsSymbol === 'SILVER_INR') {
        const isGold = nsSymbol === 'GOLD_INR';
        const mcx = await fetchMcxCommodityPrice(isGold ? 'GOLD' : 'SILVER').catch(() => null);
        if (mcx && mcx.price > 0) {
            const nowSec = Math.floor(Date.now() / 1000);
            const payload = buildTickResponse(
                nsSymbol,
                isGold ? 'GOLD MCX / 10g (INR ₹)' : 'SILVER MCX / 1kg (INR ₹)',
                mcx.price,
                mcx.prevClose,
                nowSec,
                0,
                { time: nowSec, open: mcx.price, high: mcx.price, low: mcx.price, close: mcx.price, volume: 0 }
            );
            tickMicroCache.set(nsSymbol, { ts: Date.now(), payload });
            return payload;
        }
    }

    // 2. Swissquote sub-second USD Gold & Silver spot fast path (with Yahoo prevClose fallback)
    if (nsSymbol === 'GC=F' || nsSymbol === 'SI=F') {
        const inst = nsSymbol === 'GC=F' ? 'XAU/USD' : 'XAG/USD';
        const spotPrice = await fetchSwissquoteSpot(inst);
        if (spotPrice && spotPrice > 0) {
            const prevCached = cachedTick?.payload?.prevClose || null;
            const nowSec = Math.floor(Date.now() / 1000);
            const payload = buildTickResponse(
                nsSymbol,
                nsSymbol === 'GC=F' ? 'GOLD COMEX (USD/oz)' : 'SILVER COMEX (USD/oz)',
                spotPrice,
                prevCached || spotPrice,
                nowSec,
                0,
                { time: nowSec, open: spotPrice, high: spotPrice, low: spotPrice, close: spotPrice, volume: 0 }
            );
            tickMicroCache.set(nsSymbol, { ts: Date.now(), payload });
            return payload;
        }
    }

    // 3. Groww live indices fast path
    const growwMap = {
        '^NSEI': { ex: 'NSE', seg: 'CASH', sym: 'NIFTY', name: 'NIFTY 50' },
        '^BSESN': { ex: 'BSE', seg: 'CASH', sym: '1', name: 'SENSEX' },
        '^NSEBANK': { ex: 'NSE', seg: 'CASH', sym: 'BANKNIFTY', name: 'BANK NIFTY' },
        '^CNX100': { ex: 'NSE', seg: 'CASH', sym: 'NIFTY100', name: 'NIFTY 100' }
    };
    const growwCfg = growwMap[nsSymbol];
    if (growwCfg) {
        try {
            const gRes = await fetchWithTimeout(
                `https://groww.in/v1/api/stocks_data/v1/tr_live_indices/exchange/${growwCfg.ex}/segment/${growwCfg.seg}/${encodeURIComponent(growwCfg.sym)}/latest`,
                { headers: { 'User-Agent': UA, Accept: 'application/json' } },
                1400
            );
            if (gRes.ok) {
                const gd = await gRes.json();
                const gp = Number(gd.value ?? gd.indexIndicativePrice);
                if (Number.isFinite(gp) && gp > 0) {
                    const gPrev = Number(gd.close);
                    const gTs = gd.tsInMillis ? Math.floor(Number(gd.tsInMillis) > 1e12 ? Number(gd.tsInMillis) / 1000 : Number(gd.tsInMillis)) : Math.floor(Date.now() / 1000);
                    const fastPayload = buildTickResponse(
                        nsSymbol,
                        growwCfg.name,
                        gp,
                        Number.isFinite(gPrev) && gPrev > 0 ? gPrev : null,
                        gTs,
                        0,
                        { time: gTs, open: gp, high: gp, low: gp, close: gp, volume: 0 }
                    );
                    tickMicroCache.set(nsSymbol, { ts: Date.now(), payload: fastPayload });
                    return fastPayload;
                }
            }
        } catch (_) {}
    }

    // 4. Groww live NSE/BSE cash equity fast path (RELIANCE.NS, 500325.BO, etc.)
    if (nsSymbol.endsWith('.NS') || nsSymbol.endsWith('.BO')) {
        const isBse = nsSymbol.endsWith('.BO');
        const ex = isBse ? 'BSE' : 'NSE';
        const baseSym = nsSymbol.replace(/\.(NS|BO)$/i, '');
        try {
            const geRes = await fetchWithTimeout(
                `https://groww.in/v1/api/stocks_data/v1/accord_points/exchange/${ex}/segment/CASH/latest_prices_ohlc/${encodeURIComponent(baseSym)}`,
                { headers: { 'User-Agent': UA, Accept: 'application/json' } },
                1200
            );
            if (geRes.ok) {
                const ge = await geRes.json();
                const gp = Number(ge.ltp || ge.indicativePrice || ge.close);
                if (Number.isFinite(gp) && gp > 0) {
                    const gPrev = Number(ge.close);
                    const gVol = Number(ge.volume || 0);
                    const gTs = Number(ge.lastTradeTime) || Math.floor(Date.now() / 1000);
                    const eqPayload = buildTickResponse(
                        nsSymbol,
                        baseSym,
                        gp,
                        Number.isFinite(gPrev) && gPrev > 0 ? gPrev : gp,
                        gTs,
                        Number.isFinite(gVol) ? gVol : 0,
                        { time: gTs, open: Number(ge.open) || gp, high: Number(ge.high) || gp, low: Number(ge.low) || gp, close: gp, volume: gVol || 0 }
                    );
                    tickMicroCache.set(nsSymbol, { ts: Date.now(), payload: eqPayload });
                    return eqPayload;
                }
            }
        } catch (_) {}
    }

    // 5. Yahoo Finance 1m fallback (with 5d/1d daily retry on 404/422)
    const upstreamTarget = nsSymbol === 'GOLD_INR' ? 'GC=F' : (nsSymbol === 'SILVER_INR' ? 'SI=F' : nsSymbol);
    let response = await fetchYahooFromHosts(upstreamTarget, '1d', '1m', 2800);
    if (!response.ok && (response.status === 404 || response.status === 422)) {
        response = await fetchYahooFromHosts(upstreamTarget, '5d', '1d', 2800);
    }
    if (!response.ok) {
        const err = new Error(`Yahoo tick HTTP ${response.status}`);
        err.statusCode = response.status;
        throw err;
    }
    const data = await response.json();
    const firstResult = data?.chart?.result?.[0];
    const meta = firstResult?.meta || {};
    const cleanBars = firstResult ? extractCleanCandles(firstResult, '1m', upstreamTarget) : [];
    const livePrice = Number(meta.regularMarketPrice);
    const prevClose = Number(meta.previousClose !== undefined ? meta.previousClose : meta.chartPreviousClose);
    const liveTime = Number(meta.regularMarketTime) || (cleanBars.length > 0 ? cleanBars[cleanBars.length - 1].time : Math.floor(Date.now() / 1000));
    const liveVolume = Number(meta.regularMarketVolume || 0);
    const finalPrice = Number.isFinite(livePrice) && livePrice > 0 ? livePrice : (cleanBars.length > 0 ? cleanBars[cleanBars.length - 1].close : null);

    const tickPayload = buildTickResponse(
        nsSymbol,
        String(meta.longName || meta.shortName || '').trim(),
        finalPrice,
        Number.isFinite(prevClose) && prevClose > 0 ? prevClose : null,
        liveTime,
        liveVolume,
        cleanBars.length > 0 ? cleanBars[cleanBars.length - 1] : null,
        cleanBars.slice(-15)
    );
    tickMicroCache.set(nsSymbol, { ts: Date.now(), payload: tickPayload });
    return tickPayload;
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store, max-age=0');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const { symbol, symbols, interval: rawInterval, range: rawRange, tick } = req.query;

    // Batch multi-symbol fast tick mode (?symbols=RELIANCE.NS,TCS.NS,...&tick=1)
    if (symbols && tick === '1') {
        const list = String(symbols)
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
            .slice(0, 30);

        const quotes = {};
        await Promise.allSettled(list.map(async (raw) => {
            const ns = normalizeUpstreamSymbol(raw);
            try {
                const q = await fetchFastTickForSymbol(ns);
                quotes[raw.toUpperCase()] = q;
                quotes[ns] = q;
            } catch (_) {}
        }));
        return res.status(200).json({ tick: true, quotes });
    }

    if (!symbol) {
        return res.status(400).json({ error: 'Missing symbol parameter' });
    }

    const nsSymbol = normalizeUpstreamSymbol(symbol);
    const validTimeframes = ['1m', '3m', '5m', '10m', '15m', '1d', '5d', '1w', '1mo', '1y'];
    const requestedInterval = validTimeframes.includes(String(rawInterval || '').toLowerCase())
        ? String(rawInterval).toLowerCase()
        : '5m';

    try {
        if (tick === '1') {
            const tickPayload = await fetchFastTickForSymbol(nsSymbol);
            return res.status(200).json(tickPayload);
        }

        // Full timeframe chart mode
        let upstreamInterval = requestedInterval;
        let defaultRange = '5d';

        switch (requestedInterval) {
            case '1m': upstreamInterval = '1m'; defaultRange = '2d'; break;
            case '3m': upstreamInterval = '1m'; defaultRange = '2d'; break;
            case '5m': upstreamInterval = '5m'; defaultRange = '5d'; break;
            case '10m': upstreamInterval = '1m'; defaultRange = '5d'; break;
            case '15m': upstreamInterval = '15m'; defaultRange = '5d'; break;
            case '1d': upstreamInterval = '5m'; defaultRange = '5d'; break;
            case '5d': upstreamInterval = '15m'; defaultRange = '1mo'; break;
            case '1w': upstreamInterval = '30m'; defaultRange = '1mo'; break;
            case '1mo': upstreamInterval = '1h'; defaultRange = '3mo'; break;
            case '1y': upstreamInterval = '1d'; defaultRange = '2y'; break;
            default: upstreamInterval = '5m'; defaultRange = '5d';
        }

        const isInrMetal = nsSymbol === 'GOLD_INR' || nsSymbol === 'SILVER_INR';
        const upstreamTarget = nsSymbol === 'GOLD_INR' ? 'GC=F' : (nsSymbol === 'SILVER_INR' ? 'SI=F' : nsSymbol);
        const upstreamRange = rawRange ? String(rawRange).trim() : defaultRange;

        const [response, mcxRes] = await Promise.all([
            fetchYahooFromHosts(upstreamTarget, upstreamRange, upstreamInterval, 6000),
            isInrMetal ? fetchMcxCommodityPrice(nsSymbol === 'GOLD_INR' ? 'GOLD' : 'SILVER').catch(() => null) : Promise.resolve(null)
        ]);

        if (!response.ok) {
            return res.status(response.status).json({ error: `Yahoo Finance returned HTTP ${response.status}` });
        }

        const data = await response.json();
        const firstResult = data?.chart?.result?.[0];
        if (firstResult) {
            let candles = extractCleanCandles(firstResult, requestedInterval, upstreamTarget);
            const meta = firstResult.meta || {};
            let livePrice = Number.isFinite(Number(meta.regularMarketPrice))
                ? Number(meta.regularMarketPrice)
                : (candles.length > 0 ? candles[candles.length - 1].close : null);

            if (isInrMetal && candles.length > 0) {
                const comexRef = livePrice || candles[candles.length - 1].close;
                let scaleFactor = nsSymbol === 'GOLD_INR' ? (85 * 10 / 31.1035) : (85 * 1000 / 31.1035);
                if (mcxRes && mcxRes.price > 0 && comexRef > 0) {
                    scaleFactor = mcxRes.price / comexRef;
                    livePrice = mcxRes.price;
                } else if (comexRef > 0) {
                    livePrice = comexRef * scaleFactor;
                }
                candles = candles.map(c => ({
                    ...c,
                    open: c.open * scaleFactor,
                    high: c.high * scaleFactor,
                    low: c.low * scaleFactor,
                    close: c.close * scaleFactor
                }));
            }

            data.candles = candles;
            data.interval = requestedInterval;
            data.resolvedSymbol = nsSymbol;
            data.companyName = isInrMetal
                ? (nsSymbol === 'GOLD_INR' ? 'GOLD MCX / 10g (INR ₹)' : 'SILVER MCX / 1kg (INR ₹)')
                : String(meta.longName || meta.shortName || '').trim();
            data.visibleStartTime = computeVisibleStartTime(candles, requestedInterval);
            data.livePrice = livePrice;
            data.liveTime = Number(meta.regularMarketTime) || (candles.length > 0 ? candles[candles.length - 1].time : null);
        }
        return res.status(200).json(data);
    } catch (error) {
        const status = Number(error?.statusCode);
        if (status >= 400 && status < 500) {
            return res.status(status).json({ error: error.message, symbol: nsSymbol });
        }
        console.error('Yahoo Finance proxy error:', error);
        return res.status(500).json({ error: 'Failed to fetch from Yahoo Finance', details: error.message });
    }
}

