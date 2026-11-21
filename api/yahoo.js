// Vercel Serverless Function: /api/yahoo.js
// Acts as a server-side proxy for Yahoo Finance API calls and supports OHLCV timeframes:
// 1m, 3m (aggregated from 1m), 5m, 10m (aggregated from 1m), and 1d.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function aggregateCandles(rawCandles, intervalMinutes) {
    if (!intervalMinutes || intervalMinutes <= 1) return rawCandles;
    const bucketSec = intervalMinutes * 60;
    const buckets = new Map();

    for (const c of rawCandles) {
        const bKey = Math.floor(c.time / bucketSec) * bucketSec;
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

function extractCleanCandles(yahooResult, requestedInterval) {
    const ts = yahooResult?.timestamp || [];
    const quote = yahooResult?.indicators?.quote?.[0] || {};
    const opens = quote.open || [];
    const highs = quote.high || [];
    const lows = quote.low || [];
    const closes = quote.close || [];
    const vols = quote.volume || [];

    const raw = [];
    for (let i = 0; i < ts.length; i++) {
        const o = Number(opens[i]);
        const h = Number(highs[i]);
        const l = Number(lows[i]);
        const c = Number(closes[i]);
        const v = Number(vols[i] ?? 0);
        if (
            Number.isFinite(ts[i]) &&
            Number.isFinite(o) && o > 0 &&
            Number.isFinite(h) && h > 0 &&
            Number.isFinite(l) && l > 0 &&
            Number.isFinite(c) && c > 0
        ) {
            raw.push({
                time: ts[i],
                open: o,
                high: Math.max(h, o, c),
                low: Math.min(l, o, c),
                close: c,
                volume: Number.isFinite(v) && v >= 0 ? v : 0
            });
        }
    }

    if (requestedInterval === '3m') return aggregateCandles(raw, 3);
    if (requestedInterval === '10m') return aggregateCandles(raw, 10);
    return raw;
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store, max-age=0');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const { symbol, interval: rawInterval, range: rawRange } = req.query;

    if (!symbol) {
        return res.status(400).json({ error: 'Missing symbol parameter' });
    }

    const uppercaseSymbol = String(symbol).toUpperCase().trim();
    const needsSuffix = !uppercaseSymbol.includes('.') &&
                        !uppercaseSymbol.includes('=') &&
                        !uppercaseSymbol.includes('^');

    const nsSymbol = needsSuffix ? `${uppercaseSymbol}.NS` : uppercaseSymbol;

    const requestedInterval = ['1m', '3m', '5m', '10m', '15m', '1d'].includes(String(rawInterval || '').toLowerCase())
        ? String(rawInterval).toLowerCase()
        : '1d';

    // Map 3m and 10m to Yahoo 1m source bars so we can aggregate exact 3m and 10m OHLCV candles
    const upstreamInterval = (requestedInterval === '3m' || requestedInterval === '10m')
        ? '1m'
        : requestedInterval;

    const defaultRange = upstreamInterval === '1d' ? '1y' : '5d';
    const upstreamRange = rawRange ? String(rawRange).trim() : defaultRange;

    const buildYahooUrl = (host) =>
        `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(nsSymbol)}?range=${encodeURIComponent(upstreamRange)}&interval=${encodeURIComponent(upstreamInterval)}`;

    const fetchWithTimeout = async (url, options = {}, timeoutMs = 6000) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, { ...options, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    };

    try {
        let response = await fetchWithTimeout(buildYahooUrl('query1'), {
            headers: {
                'User-Agent': UA,
                'Accept': 'application/json',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://finance.yahoo.com/',
                'Origin': 'https://finance.yahoo.com',
            },
        });

        if (!response.ok) {
            response = await fetchWithTimeout(buildYahooUrl('query2'), {
                headers: {
                    'User-Agent': UA,
                    'Accept': 'application/json',
                    'Referer': 'https://finance.yahoo.com/',
                },
            });
            if (!response.ok) {
                return res.status(response.status).json({ error: `Yahoo Finance returned HTTP ${response.status}` });
            }
        }

        const data = await response.json();
        const firstResult = data?.chart?.result?.[0];
        if (firstResult) {
            data.candles = extractCleanCandles(firstResult, requestedInterval);
            data.interval = requestedInterval;
            data.resolvedSymbol = nsSymbol;
        }
        return res.status(200).json(data);
    } catch (error) {
        console.error('Yahoo Finance proxy error:', error);
        return res.status(500).json({ error: 'Failed to fetch from Yahoo Finance', details: error.message });
    }
}
