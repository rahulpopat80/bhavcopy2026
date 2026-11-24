// Vercel Serverless Function: /api/live-market.js
// Unified ultra-fast live feed (800ms micro-cache) for 1-second polling:
// - NIFTY 50, SENSEX
// - GOLD / 10g, SILVER / 1kg (MCX live futures with IBJA / COMEX fallbacks)
// - NASDAQ (^IXIC), HANG SENG (^HSI)
// - Market Advance & Decline from nseindia.com/market-data/decline + SENSEX 30 Advance/Decline

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let cachedPayload = null;
let cachedAt = 0;
let cachedSecondary = { nasdaq: null, hangseng: null, nseMarket: null, nifty50Breadth: null, nifty50Index: null, ts: 0 };
const metalPrevCache = {
    'GC=F': { prevClose: null, ts: 0 },
    'SI=F': { prevClose: null, ts: 0 }
};

// Cache discovered active MCX Gold/Silver expiries for 6 hours
const mcxExpiryCache = {
    GOLD: { expiry: '2026-12-04', ts: 0 },
    SILVER: { expiry: '2026-12-04', ts: 0 }
};

async function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
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

function getMcxCandidateExpiries(preferred) {
    const candidates = [];
    if (preferred) candidates.push(preferred);
    const now = new Date();
    // Probe 4th, 5th, 3rd, 6th of current and next 3 months
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
        const r = await fetchWithTimeout(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } }, 3500);
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
                prevClose: Number.isFinite(prev) ? prev : price,
                change: chg,
                changePercent: pct,
                expiry: j.data.EXPIRY || exp,
                updatedTime: j.data.lastupdTime || '',
                source: 'MCX Live'
            };
        }
        return null;
    };

    // Fast path using cached active expiry
    if (cachedExp?.expiry) {
        const hit = await tryExpiry(cachedExp.expiry);
        if (hit) return hit;
    }

    // Auto-discover next active expiry in small parallel batches
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
    }, 3500);
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

async function fetchSwissquoteMetal(instrument, yahooSym) {
    const [sqRes, prevRes] = await Promise.allSettled([
        fetchWithTimeout(`https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/${instrument}`, {
            headers: { 'User-Agent': UA, Accept: 'application/json' }
        }, 1200),
        (metalPrevCache[yahooSym]?.prevClose && (Date.now() - metalPrevCache[yahooSym].ts) < 60000)
            ? Promise.resolve({ prevClose: metalPrevCache[yahooSym].prevClose })
            : fetchYahooChart(yahooSym).catch(() => null)
    ]);

    if (sqRes.status === 'fulfilled' && sqRes.value.ok) {
        const arr = await sqRes.value.json();
        const prices = arr?.[0]?.spreadProfilePrices?.[0];
        const bid = Number(prices?.bid);
        const ask = Number(prices?.ask);
        if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
            const price = (bid + ask) / 2;
            const prevClose = prevRes.status === 'fulfilled' && prevRes.value?.prevClose
                ? Number(prevRes.value.prevClose)
                : (metalPrevCache[yahooSym]?.prevClose || price);
            const change = price - prevClose;
            const changePercent = prevClose > 0 ? (change / prevClose) * 100 : 0;
            return { price, prevClose, change, changePercent, currency: 'USD', symbol: yahooSym, unit: '/oz', source: 'Spot Live' };
        }
    }
    if (prevRes.status === 'fulfilled' && prevRes.value?.price) {
        return { ...prevRes.value, currency: 'USD', symbol: yahooSym, unit: '/oz', source: 'COMEX USD' };
    }
    return null;
}

async function fetchGrowwIndex(exchange, segment, symbol) {
    const url = `https://groww.in/v1/api/stocks_data/v1/tr_live_indices/exchange/${exchange}/segment/${segment}/${encodeURIComponent(symbol)}/latest`;
    const r = await fetchWithTimeout(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' }
    }, 3500);
    if (!r.ok) throw new Error(`Groww index HTTP ${r.status}`);
    const d = await r.json();
    const price = toNum(d.value ?? d.indexIndicativePrice ?? d.close);
    if (!Number.isFinite(price) || price <= 0) throw new Error(`Invalid Groww price for ${symbol}`);
    const change = Number.isFinite(toNum(d.dayChange)) ? toNum(d.dayChange) : 0;
    const changePercent = Number.isFinite(toNum(d.dayChangePerc)) ? toNum(d.dayChangePerc) : 0;
    return {
        price,
        change,
        changePercent,
        prevClose: toNum(d.close),
        source: exchange === 'BSE' ? 'BSE Live' : 'NSE Live'
    };
}

async function fetchMcSensex() {
    const r = await fetchWithTimeout('https://priceapi.moneycontrol.com/pricefeed/notapplicable/inidicesindia/in%3BSEN', {
        headers: { 'User-Agent': UA, Accept: 'application/json' }
    }, 3500);
    if (!r.ok) throw new Error(`MC Sensex HTTP ${r.status}`);
    const j = await r.json();
    const d = j?.data;
    if (!d) throw new Error('Empty MC Sensex data');
    const price = toNum(d.pricecurrent);
    const change = toNum(d.pricechange);
    const changePercent = toNum(d.pricepercentchange);
    const advances = Number.isFinite(toNum(d.adv)) ? Math.round(toNum(d.adv)) : null;
    const declines = Number.isFinite(toNum(d.decl)) ? Math.round(toNum(d.decl)) : null;
    return {
        index: Number.isFinite(price) ? {
            price,
            change: Number.isFinite(change) ? change : 0,
            changePercent: Number.isFinite(changePercent) ? changePercent : 0,
            prevClose: toNum(d.priceprevclose),
            source: 'BSE Live'
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

async function fetchNseDeclineAndIndices() {
    const headers = {
        'User-Agent': UA,
        Accept: 'application/json',
        Referer: 'https://www.nseindia.com/market-data/decline'
    };
    const [decRes, idxRes] = await Promise.allSettled([
        fetchWithTimeout('https://www.nseindia.com/api/live-analysis-decline', { headers }, 3500),
        fetchWithTimeout('https://www.nseindia.com/api/allIndices', { headers }, 3500)
    ]);

    let nseMarket = null;
    let nifty50Breadth = null;
    let nifty50Index = null;

    if (decRes.status === 'fulfilled' && decRes.value.ok) {
        const decJson = await decRes.value.json();
        const cnt = decJson?.decline?.count || decJson?.advance?.count;
        if (cnt) {
            nseMarket = {
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
                nifty50Index = {
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
                nifty50Breadth = {
                    advances: adv,
                    declines: dec,
                    unchanged: Number.isFinite(unc) ? unc : 0,
                    total: adv + dec + (Number.isFinite(unc) ? unc : 0),
                    source: 'NSE NIFTY 50'
                };
            }
        }
    }

    return { nseMarket, nifty50Breadth, nifty50Index };
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store, max-age=0');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (cachedPayload && (Date.now() - cachedAt) < 200) {
        return res.status(200).json(cachedPayload);
    }

    const needSecondary = !cachedSecondary.ts || (Date.now() - cachedSecondary.ts) >= 450;

    const corePromises = [
        fetchGrowwIndex('NSE', 'CASH', 'NIFTY'),
        fetchGrowwIndex('BSE', 'CASH', '1'),
        fetchMcSensex(),
        fetchMcxCommodity('GOLD'),
        fetchMcxCommodity('SILVER'),
        fetchSwissquoteMetal('XAU/USD', 'GC=F').catch(() => null),
        fetchSwissquoteMetal('XAG/USD', 'SI=F').catch(() => null)
    ];

    const secondaryPromises = needSecondary
        ? [
            fetchNseDeclineAndIndices(),
            fetchYahooChart('^IXIC'),
            fetchYahooChart('^HSI')
        ]
        : [];

    const [
        growwNiftyRes,
        growwSensexRes,
        mcSensexRes,
        mcxGoldRes,
        mcxSilverRes,
        comexGoldRes,
        comexSilverRes
    ] = await Promise.allSettled(corePromises);

    if (needSecondary) {
        const [nseRes, nasdaqRes, hangsengRes] = await Promise.allSettled(secondaryPromises);
        const nseData = nseRes.status === 'fulfilled' ? nseRes.value : {};
        cachedSecondary = {
            nseMarket: nseData.nseMarket || cachedSecondary.nseMarket,
            nifty50Breadth: nseData.nifty50Breadth || cachedSecondary.nifty50Breadth,
            nifty50Index: nseData.nifty50Index || cachedSecondary.nifty50Index,
            nasdaq: nasdaqRes.status === 'fulfilled' ? { ...nasdaqRes.value, source: 'Yahoo Finance' } : cachedSecondary.nasdaq,
            hangseng: hangsengRes.status === 'fulfilled' ? { ...hangsengRes.value, source: 'Yahoo Finance' } : cachedSecondary.hangseng,
            ts: Date.now()
        };
    }

    const mcSensexData = mcSensexRes.status === 'fulfilled' ? mcSensexRes.value : {};

    let nifty = growwNiftyRes.status === 'fulfilled' ? growwNiftyRes.value : (cachedSecondary.nifty50Index || null);
    let sensex = growwSensexRes.status === 'fulfilled' ? growwSensexRes.value : (mcSensexData.index || null);
    let gold = mcxGoldRes.status === 'fulfilled' ? mcxGoldRes.value : null;
    let silver = mcxSilverRes.status === 'fulfilled' ? mcxSilverRes.value : null;
    const goldUsd = comexGoldRes.status === 'fulfilled' && comexGoldRes.value ? comexGoldRes.value : null;
    const silverUsd = comexSilverRes.status === 'fulfilled' && comexSilverRes.value ? comexSilverRes.value : null;
    const rawGoldUsd = goldUsd;
    const rawSilverUsd = silverUsd;
    const nasdaq = cachedSecondary.nasdaq;
    const hangseng = cachedSecondary.hangseng;

    // Last-resort Yahoo fallbacks only for any missing feed
    const fallbacks = [];
    if (!nifty) {
        fallbacks.push(fetchYahooChart('^NSEI').then(d => { nifty = { ...d, source: 'Yahoo' }; }).catch(() => {}));
    }
    if (!sensex) {
        fallbacks.push(fetchYahooChart('^BSESN').then(d => { sensex = { ...d, source: 'Yahoo' }; }).catch(() => {}));
    }
    if (!gold || !silver) {
        fallbacks.push((async () => {
            try {
                const [fx, gc, si] = await Promise.all([
                    fetchYahooChart('INR=X'),
                    rawGoldUsd ? Promise.resolve(rawGoldUsd) : fetchYahooChart('GC=F'),
                    rawSilverUsd ? Promise.resolve(rawSilverUsd) : fetchYahooChart('SI=F')
                ]);
                const usdInr = fx.price || 85;
                if (!gold && gc.price) {
                    const f = 10 / 31.1035;
                    const price = gc.price * usdInr * f;
                    const prev = gc.prevClose * usdInr * f;
                    gold = { price, prevClose: prev, change: price - prev, changePercent: prev > 0 ? ((price - prev) / prev) * 100 : 0, source: 'COMEX Parity' };
                }
                if (!silver && si.price) {
                    const f = 1000 / 31.1035;
                    const price = si.price * usdInr * f;
                    const prev = si.prevClose * usdInr * f;
                    silver = { price, prevClose: prev, change: price - prev, changePercent: prev > 0 ? ((price - prev) / prev) * 100 : 0, source: 'COMEX Parity' };
                }
            } catch (_) {}
        })());
    }
    if (fallbacks.length > 0) {
        await Promise.allSettled(fallbacks);
    }

    if (gold && goldUsd) gold = { ...gold, usd: goldUsd };
    if (silver && silverUsd) silver = { ...silver, usd: silverUsd };

    const payload = {
        nifty,
        sensex,
        gold,
        silver,
        goldUsd,
        silverUsd,
        nasdaq,
        hangseng,
        breadth: {
            nseMarket: cachedSecondary.nseMarket || null,
            sensex30: mcSensexData.breadth || null,
            nifty50: cachedSecondary.nifty50Breadth || null
        },
        updatedAt: new Date().toISOString()
    };

    cachedPayload = payload;
    cachedAt = Date.now();
    return res.status(200).json(payload);
}
