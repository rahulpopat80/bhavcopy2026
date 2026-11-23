// Vercel Serverless Function: /api/mmi.js
// Fetches live Market Mood Index (MMI) from tickertape.in/market-mood-index

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Short-lived cache (800ms) so 1-second polling stays snappy without hammering upstream
let cachedMmi = null;
let cachedAt = 0;

async function fetchWithTimeout(url, options = {}, timeoutMs = 4500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

function classifyMmiZone(val) {
    if (val < 30) {
        return { zone: 'Extreme Fear', zoneGu: 'અત્યંત ભય (Extreme Fear)', color: '#16a34a', key: 'ef' };
    }
    if (val < 50) {
        return { zone: 'Fear', zoneGu: 'ભય (Fear)', color: '#f59e0b', key: 'f' };
    }
    if (val < 70) {
        return { zone: 'Greed', zoneGu: 'લાલચ (Greed)', color: '#f97316', key: 'g' };
    }
    return { zone: 'Extreme Greed', zoneGu: 'અત્યંત લાલચ (Extreme Greed)', color: '#dc2626', key: 'eg' };
}

function formatMmiPayload(rawData, source) {
    const currentValue = Number(rawData.currentValue ?? rawData.indicator);
    if (!Number.isFinite(currentValue)) {
        throw new Error('Invalid MMI value');
    }

    const prevDay = rawData.lastDay?.indicator !== undefined ? Number(rawData.lastDay.indicator) : null;
    const lastWeek = rawData.lastWeek?.indicator !== undefined ? Number(rawData.lastWeek.indicator) : null;
    const lastMonth = rawData.lastMonth?.indicator !== undefined ? Number(rawData.lastMonth.indicator) : null;
    const lastYear = rawData.lastYear?.indicator !== undefined ? Number(rawData.lastYear.indicator) : null;
    const changeFromPrevDay = prevDay !== null && Number.isFinite(prevDay)
        ? Number((currentValue - prevDay).toFixed(2))
        : null;

    const zoneInfo = classifyMmiZone(currentValue);

    return {
        value: Number(currentValue.toFixed(2)),
        zone: zoneInfo.zone,
        zoneGu: zoneInfo.zoneGu,
        color: zoneInfo.color,
        changeFromPrevDay,
        prevDay: prevDay !== null ? Number(prevDay.toFixed(2)) : null,
        lastWeek: lastWeek !== null ? Number(lastWeek.toFixed(2)) : null,
        lastMonth: lastMonth !== null ? Number(lastMonth.toFixed(2)) : null,
        lastYear: lastYear !== null ? Number(lastYear.toFixed(2)) : null,
        nifty: rawData.nifty !== undefined ? Number(rawData.nifty) : null,
        vix: rawData.vix !== undefined ? Number(rawData.vix) : null,
        date: rawData.date || new Date().toISOString(),
        source,
        sourceUrl: 'https://www.tickertape.in/market-mood-index',
        updatedAt: new Date().toISOString()
    };
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store, max-age=0');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (cachedMmi && (Date.now() - cachedAt) < 800) {
        return res.status(200).json(cachedMmi);
    }

    // 1. Primary: Tickertape official MMI JSON endpoint backing tickertape.in/market-mood-index
    try {
        const apiRes = await fetchWithTimeout('https://api.tickertape.in/mmi/now', {
            headers: {
                'User-Agent': UA,
                'Accept': 'application/json',
                'Origin': 'https://www.tickertape.in',
                'Referer': 'https://www.tickertape.in/market-mood-index'
            }
        });
        if (apiRes.ok) {
            const json = await apiRes.json();
            if (json?.success && json?.data) {
                const payload = formatMmiPayload(json.data, 'tickertape.in/market-mood-index');
                cachedMmi = payload;
                cachedAt = Date.now();
                return res.status(200).json(payload);
            }
        }
    } catch (err) {
        console.warn('[API /mmi] Primary Tickertape API failed:', err.message);
    }

    // 2. Fallback: Parse __NEXT_DATA__ directly from https://www.tickertape.in/market-mood-index
    try {
        const pageRes = await fetchWithTimeout('https://www.tickertape.in/market-mood-index', {
            headers: {
                'User-Agent': UA,
                'Accept': 'text/html,application/xhtml+xml'
            }
        }, 5500);

        if (pageRes.ok) {
            const html = await pageRes.text();
            const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
            if (match && match[1]) {
                const nextData = JSON.parse(match[1]);
                const nowData = nextData?.props?.pageProps?.nowData;
                if (nowData) {
                    const payload = formatMmiPayload(nowData, 'tickertape.in/market-mood-index (SSR)');
                    cachedMmi = payload;
                    cachedAt = Date.now();
                    return res.status(200).json(payload);
                }
            }
        }
    } catch (err) {
        console.warn('[API /mmi] Page SSR fallback failed:', err.message);
    }

    if (cachedMmi) {
        return res.status(200).json({ ...cachedMmi, stale: true });
    }

    return res.status(502).json({ error: 'Unable to fetch Market Mood Index from tickertape.in' });
}
