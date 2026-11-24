// Vercel Serverless Function: /api/yahoo.js
// Server-side proxy for Yahoo Finance OHLCV candles across intraday & multi-period ranges:
// 1m, 3m, 5m, 10m, 1d (1 Day), 5d (5 Days), 1w (1 Week), 1mo (1 Month), 1y (1 Year)
// Plus ?tick=1 fast quote/tail endpoint for 1-second live candle updates.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const tickMicroCache = new Map();

function normalizeUpstreamSymbol(rawSym) {
    const s = String(rawSym || '').toUpperCase().trim();
    if (s === 'NIFTY' || s === 'NIFTY 50' || s === 'NIFTY50') return '^NSEI';
    if (s === 'SENSEX' || s === 'BSE SENSEX' || s === 'BSESN') return '^BSESN';
    if (s === 'BANKNIFTY' || s === 'BANK NIFTY' || s === 'NIFTY BANK') return '^NSEBANK';
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
            const openUnix = dayStartUnix + 555 * 60; // 09:15 IST
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
                // Keep bars strictly inside NSE/BSE session: 09:15 (555) through 15:29/15:30 (930)
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

// Helper to get IST YYYY-MM-DD key from unix seconds
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
                    // Find first candle belonging to the oldest included day
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

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store, max-age=0');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const { symbol, interval: rawInterval, range: rawRange, tick } = req.query;

    if (!symbol) {
        return res.status(400).json({ error: 'Missing symbol parameter' });
    }

    const nsSymbol = normalizeUpstreamSymbol(symbol);

    const validTimeframes = ['1m', '3m', '5m', '10m', '15m', '1d', '5d', '1w', '1mo', '1y'];
    const requestedInterval = validTimeframes.includes(String(rawInterval || '').toLowerCase())
        ? String(rawInterval).toLowerCase()
        : '5m';

    const fetchWithTimeout = async (url, options = {}, timeoutMs = 5500) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, { ...options, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    };

    const fetchYahooFromHosts = async (rangeStr, intervalStr, timeoutMs = 5500) => {
        const buildYahooUrl = (host) =>
            `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(nsSymbol)}?range=${encodeURIComponent(rangeStr)}&interval=${encodeURIComponent(intervalStr)}&includePrePost=false`;

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
    };

    try {
        // Fast sub-second live tick mode (250ms cache + Groww live index acceleration for NIFTY/SENSEX/BANKNIFTY)
        if (tick === '1') {
            const cachedTick = tickMicroCache.get(nsSymbol);
            if (cachedTick && (Date.now() - cachedTick.ts) < 250) {
                return res.status(200).json(cachedTick.payload);
            }

            const growwMap = {
                '^NSEI': { ex: 'NSE', seg: 'CASH', sym: 'NIFTY', name: 'NIFTY 50' },
                '^BSESN': { ex: 'BSE', seg: 'CASH', sym: '1', name: 'SENSEX' },
                '^NSEBANK': { ex: 'NSE', seg: 'CASH', sym: 'BANKNIFTY', name: 'BANK NIFTY' }
            };

            const growwCfg = growwMap[nsSymbol];
            if (growwCfg) {
                try {
                    const gRes = await fetchWithTimeout(
                        `https://groww.in/v1/api/stocks_data/v1/tr_live_indices/exchange/${growwCfg.ex}/segment/${growwCfg.seg}/${encodeURIComponent(growwCfg.sym)}/latest`,
                        { headers: { 'User-Agent': UA, Accept: 'application/json' } },
                        1800
                    );
                    if (gRes.ok) {
                        const gd = await gRes.json();
                        const gp = Number(gd.value ?? gd.indexIndicativePrice);
                        if (Number.isFinite(gp) && gp > 0) {
                            const gPrev = Number(gd.close);
                            const gTs = gd.tsInMillis ? Math.floor(Number(gd.tsInMillis) > 1e12 ? Number(gd.tsInMillis) / 1000 : Number(gd.tsInMillis)) : Math.floor(Date.now() / 1000);
                            const fastPayload = {
                                tick: true,
                                resolvedSymbol: nsSymbol,
                                companyName: growwCfg.name,
                                livePrice: gp,
                                prevClose: Number.isFinite(gPrev) && gPrev > 0 ? gPrev : null,
                                liveTime: gTs,
                                liveVolume: 0,
                                latestBar: { time: gTs, open: gp, high: gp, low: gp, close: gp, volume: 0 },
                                recentBars: []
                            };
                            tickMicroCache.set(nsSymbol, { ts: Date.now(), payload: fastPayload });
                            return res.status(200).json(fastPayload);
                        }
                    }
                } catch (_) {}
            }

            const response = await fetchYahooFromHosts('1d', '1m', 3000);
            if (!response.ok) {
                return res.status(response.status).json({ error: `Yahoo tick HTTP ${response.status}` });
            }
            const data = await response.json();
            const firstResult = data?.chart?.result?.[0];
            const meta = firstResult?.meta || {};
            const cleanBars = firstResult ? extractCleanCandles(firstResult, '1m', nsSymbol) : [];
            const livePrice = Number(meta.regularMarketPrice);
            const prevClose = Number(meta.previousClose !== undefined ? meta.previousClose : meta.chartPreviousClose);
            const liveTime = Number(meta.regularMarketTime) || (cleanBars.length > 0 ? cleanBars[cleanBars.length - 1].time : Math.floor(Date.now() / 1000));
            const liveVolume = Number(meta.regularMarketVolume || 0);

            const tickPayload = {
                tick: true,
                resolvedSymbol: nsSymbol,
                companyName: String(meta.longName || meta.shortName || '').trim(),
                livePrice: Number.isFinite(livePrice) && livePrice > 0 ? livePrice : (cleanBars.length > 0 ? cleanBars[cleanBars.length - 1].close : null),
                prevClose: Number.isFinite(prevClose) && prevClose > 0 ? prevClose : null,
                liveTime,
                liveVolume,
                latestBar: cleanBars.length > 0 ? cleanBars[cleanBars.length - 1] : null,
                recentBars: cleanBars.slice(-15)
            };
            tickMicroCache.set(nsSymbol, { ts: Date.now(), payload: tickPayload });
            return res.status(200).json(tickPayload);
        }

        // Full timeframe chart mode
        let upstreamInterval = requestedInterval;
        let defaultRange = '5d';

        switch (requestedInterval) {
            case '1m':
                upstreamInterval = '1m';
                defaultRange = '2d';
                break;
            case '3m':
                upstreamInterval = '1m';
                defaultRange = '2d';
                break;
            case '5m':
                upstreamInterval = '5m';
                defaultRange = '5d';
                break;
            case '10m':
                upstreamInterval = '1m';
                defaultRange = '5d';
                break;
            case '15m':
                upstreamInterval = '15m';
                defaultRange = '5d';
                break;
            case '1d': // 1 Day period (5m candles for today + prior days to warm BB)
                upstreamInterval = '5m';
                defaultRange = '5d';
                break;
            case '5d': // 5 Days period (15m candles across 5 days + prior days to warm BB)
                upstreamInterval = '15m';
                defaultRange = '1mo';
                break;
            case '1w': // 1 Week period (30m candles across 7 trading days + prior days to warm BB)
                upstreamInterval = '30m';
                defaultRange = '1mo';
                break;
            case '1mo': // 1 Month period (1h candles across 1 month + prior months to warm BB)
                upstreamInterval = '1h';
                defaultRange = '3mo';
                break;
            case '1y': // 1 Year period (1d candles across 1 year + prior year to warm BB)
                upstreamInterval = '1d';
                defaultRange = '2y';
                break;
            default:
                upstreamInterval = '5m';
                defaultRange = '5d';
        }

        const upstreamRange = rawRange ? String(rawRange).trim() : defaultRange;
        const response = await fetchYahooFromHosts(upstreamRange, upstreamInterval, 6000);

        if (!response.ok) {
            return res.status(response.status).json({ error: `Yahoo Finance returned HTTP ${response.status}` });
        }

        const data = await response.json();
        const firstResult = data?.chart?.result?.[0];
        if (firstResult) {
            const candles = extractCleanCandles(firstResult, requestedInterval, nsSymbol);
            const meta = firstResult.meta || {};
            data.candles = candles;
            data.interval = requestedInterval;
            data.resolvedSymbol = nsSymbol;
            data.companyName = String(meta.longName || meta.shortName || '').trim();
            data.visibleStartTime = computeVisibleStartTime(candles, requestedInterval);
            data.livePrice = Number.isFinite(Number(meta.regularMarketPrice)) ? Number(meta.regularMarketPrice) : (candles.length > 0 ? candles[candles.length - 1].close : null);
            data.liveTime = Number(meta.regularMarketTime) || (candles.length > 0 ? candles[candles.length - 1].time : null);
        }
        return res.status(200).json(data);
    } catch (error) {
        console.error('Yahoo Finance proxy error:', error);
        return res.status(500).json({ error: 'Failed to fetch from Yahoo Finance', details: error.message });
    }
}
