// Vercel Serverless Function: /api/option-tips.js
// Aggregates:
// 1. Real-time NSE/BSE Option Chain (NIFTY, BANKNIFTY, SENSEX, FINNIFTY) CE/PE & Spot signals (800ms cache for 1s live updates)
// 2. Real public brokerage calls & research tips from 5paisa, Moneycontrol, Economic Times & Google News RSS
//    covering the 12 Indian brokerages/advisories requested, enriched every 1s with live Yahoo Finance CMP.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export const BROKER_DIRECTORY = [
    {
        id: '5paisa',
        name: '5paisa Capital Limited',
        shortName: '5paisa',
        sebiReg: 'SEBI Reg: INH000025188',
        researchUrl: 'https://www.5paisa.com/share-market-today/stocks-to-buy-or-sell-today',
        aliases: ['5paisa', '5 paisa']
    },
    {
        id: 'motilal-oswal',
        name: 'Motilal Oswal Financial Services',
        shortName: 'Motilal Oswal',
        sebiReg: 'SEBI Registered Research',
        researchUrl: 'https://www.motilaloswal.com/research-reports',
        aliases: ['motilal oswal', 'motilal', 'chandan taparia']
    },
    {
        id: 'icici-direct',
        name: 'ICICI Direct',
        shortName: 'ICICI Direct',
        sebiReg: 'SEBI Registered Research',
        researchUrl: 'https://www.icicidirect.com/research/equity/investing-ideas',
        aliases: ['icici direct', 'icicidirect', 'icici securities']
    },
    {
        id: 'kotak-neo',
        name: 'Kotak Securities (Kotak Neo)',
        shortName: 'Kotak Neo',
        sebiReg: 'SEBI Registered Research',
        researchUrl: 'https://www.kotaksecurities.com/investing-guide/',
        aliases: ['kotak securities', 'kotak neo', 'kotak institutional', 'shrikant chouhan']
    },
    {
        id: 'angel-one',
        name: 'Angel One',
        shortName: 'Angel One',
        sebiReg: 'SEBI Registered Research',
        researchUrl: 'https://www.angelone.in/knowledge-center/share-market',
        aliases: ['angel one', 'angel broking', 'osho krishan', 'sneha seth', 'rajesh bhosale']
    },
    {
        id: 'hdfc-sec',
        name: 'HDFC Securities',
        shortName: 'HDFC Securities',
        sebiReg: 'SEBI Registered Research',
        researchUrl: 'https://www.hdfcsec.com/',
        aliases: ['hdfc securities', 'hdfc sec', 'nagaraj shetti', 'devarsh vakil', 'vinay rajani']
    },
    {
        id: 'axis-sec',
        name: 'Axis Securities',
        shortName: 'Axis Securities',
        sebiReg: 'SEBI Registered Research',
        researchUrl: 'https://www.axisdirect.in/research/',
        aliases: ['axis securities', 'axis direct', 'rajesh palviya']
    },
    {
        id: 'sharekhan',
        name: 'Sharekhan',
        shortName: 'Sharekhan',
        sebiReg: 'SEBI Registered Research',
        researchUrl: 'https://www.sharekhan.com/research',
        aliases: ['sharekhan', 'mirae asset sharekhan', 'jatin gedia', 'somil mehta', 'kunal shah']
    },
    {
        id: 'stockboxtech',
        name: 'StockBoxTech',
        shortName: 'StockBoxTech',
        sebiReg: 'SEBI Registered RA',
        researchUrl: 'https://stockboxtech.com/',
        aliases: ['stockboxtech', 'stockbox', 'siddharth rai mangala']
    },
    {
        id: 'mangal-keshav',
        name: 'Mangal Keshav Financial Services',
        shortName: 'Mangal Keshav',
        sebiReg: 'SEBI Registered Research',
        researchUrl: 'https://www.mangalkeshav.com/',
        aliases: ['mangal keshav']
    },
    {
        id: 'finkuber',
        name: 'FinKuber Capital',
        shortName: 'FinKuber Capital',
        sebiReg: 'Advisory Desk',
        researchUrl: 'https://finkubercapital.com/',
        aliases: ['finkuber', 'finkuber capital']
    },
    {
        id: 'abj-finstocks',
        name: 'ABJ Finstocks',
        shortName: 'ABJ Finstocks',
        sebiReg: 'Advisory Desk',
        researchUrl: 'https://abjfinstocks.com/',
        aliases: ['abj finstocks', 'abj finstock']
    }
];

const BROKER_FEEDS_TTL_MS = 3 * 60 * 1000;
const LIVE_TIPS_TTL_MS = 800;
const SPOT_CANDLES_TTL_MS = 12 * 1000;
const QUOTE_TTL_MS = 850;
const ANCHOR_TTL_MS = 4 * 60 * 60 * 1000;

let brokerFeedCache = { ts: 0, tips: [], inFlight: null };
let livePayloadCache = { ts: 0, data: null };
const spotTechCache = new Map();
const symbolResolveCache = new Map();
const liveQuoteCache = new Map();
const optionAnchorCache = new Map();

function toNum(val) {
    if (val === null || val === undefined || val === '') return NaN;
    const n = parseFloat(String(val).replace(/[₹,\s]/g, ''));
    return Number.isFinite(n) ? n : NaN;
}

function roundTick(val, decimals = 2) {
    if (!Number.isFinite(val)) return null;
    const factor = Math.pow(10, decimals);
    return Math.round(val * factor) / factor;
}

function roundOptionTick(val) {
    if (!Number.isFinite(val) || val <= 0) return null;
    return Math.round(val * 20) / 20;
}

function decodeEntities(str) {
    return String(str || '')
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&#x20B9;|&#8377;/gi, '₹')
        .replace(/&nbsp;/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function sanitizeSafeUrl(rawUrl, fallback = '') {
    try {
        const parsed = new URL(String(rawUrl || '').trim());
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
            return parsed.href;
        }
    } catch {
        // ignore invalid url
    }
    return fallback;
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

function matchBrokerInfo(text) {
    const lower = String(text || '').toLowerCase();
    for (const b of BROKER_DIRECTORY) {
        if (b.aliases.some(alias => lower.includes(alias))) {
            return b;
        }
    }
    return null;
}

function mapKnownScriptToYahoo(scriptName) {
    const upper = String(scriptName || '').toUpperCase().trim();
    if (!upper) return null;
    if (upper.includes('BANK NIFTY') || upper.includes('BANKNIFTY') || upper.includes('NIFTY BANK')) return '^NSEBANK';
    if (upper.includes('FINNIFTY') || upper.includes('FIN NIFTY')) return '^CNXFIN';
    if (upper.includes('SENSEX')) return '^BSESN';
    if (upper.includes('NIFTY')) return '^NSEI';
    if (upper.includes('GOLD')) return 'GC=F';
    if (upper.includes('SILVER')) return 'SI=F';
    return null;
}

async function resolveYahooSymbol(scriptName) {
    const direct = mapKnownScriptToYahoo(scriptName);
    if (direct) return direct;

    const clean = String(scriptName || '')
        .replace(/\b(Ltd\.?|Limited|India|Shares|Stock|CE|PE)\b/gi, '')
        .replace(/[^A-Za-z0-9 &\-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!clean || clean.length < 2) return null;
    const cacheKey = clean.toUpperCase();
    if (symbolResolveCache.has(cacheKey)) {
        return symbolResolveCache.get(cacheKey);
    }

    try {
        const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(clean)}&quotesCount=5&newsCount=0`;
        const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } }, 3000);
        if (!res.ok) {
            symbolResolveCache.set(cacheKey, null);
            return null;
        }
        const json = await res.json();
        const quotes = Array.isArray(json?.quotes) ? json.quotes : [];
        const match = quotes.find(q => q?.symbol && String(q.symbol).endsWith('.NS'))
            || quotes.find(q => q?.symbol && String(q.symbol).endsWith('.BO'));
        const resolved = match ? String(match.symbol) : null;
        if (symbolResolveCache.size > 400) symbolResolveCache.clear();
        symbolResolveCache.set(cacheKey, resolved);
        return resolved;
    } catch {
        return null;
    }
}

async function fetchLiveYahooQuote(symbol) {
    if (!symbol) return null;
    const cached = liveQuoteCache.get(symbol);
    if (cached && (Date.now() - cached.ts) < QUOTE_TTL_MS) {
        return cached.data;
    }
    try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`;
        const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } }, 3000);
        if (!res.ok) return cached ? cached.data : null;
        const json = await res.json();
        const meta = json?.chart?.result?.[0]?.meta;
        const price = Number(meta?.regularMarketPrice);
        if (!Number.isFinite(price) || price <= 0) return cached ? cached.data : null;
        const prev = Number(meta?.previousClose ?? meta?.chartPreviousClose ?? price);
        const chg = price - (Number.isFinite(prev) && prev > 0 ? prev : price);
        const pct = prev > 0 ? (chg / prev) * 100 : 0;
        const payload = { price: roundTick(price), prevClose: roundTick(prev), change: roundTick(chg), changePct: roundTick(pct) };
        if (liveQuoteCache.size > 200) liveQuoteCache.clear();
        liveQuoteCache.set(symbol, { ts: Date.now(), data: payload });
        return payload;
    } catch {
        return cached ? cached.data : null;
    }
}

// =========================================================================
// Layer A: Real Brokerage Feeds (5paisa, Moneycontrol, ET Recos, Google News)
// =========================================================================
async function fetch5paisaTips() {
    const tips = [];
    try {
        const res = await fetchWithTimeout('https://www.5paisa.com/share-market-today/stocks-to-buy-or-sell-today', {
            headers: { 'User-Agent': UA, Accept: 'text/html' }
        }, 4500);
        if (!res.ok) return tips;
        const html = await res.text();
        const rows = [...html.matchAll(/<tr[\s\S]*?<\/tr>/gi)];
        for (const r of rows) {
            const cells = [...r[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => decodeEntities(c[1]));
            if (cells.length < 6) continue;
            const scriptRaw = cells[0];
            if (!scriptRaw || /^stock$/i.test(scriptRaw)) continue;
            const cmp = toNum(cells[1]);
            const entry = toNum(cells[2]);
            const stoploss = toNum(cells[3]);
            const target = toNum(cells[4]);
            const actionRaw = cells[cells.length - 1] || '';
            const action = /sell/i.test(actionRaw) ? 'SELL' : (/buy/i.test(actionRaw) ? 'BUY' : null);
            if (!action || !Number.isFinite(target)) continue;

            tips.push({
                id: `5paisa-${scriptRaw.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
                scriptName: scriptRaw.replace(/\s+Ltd\.?$/i, '').trim(),
                segment: 'EQUITY',
                action,
                entry: Number.isFinite(entry) ? entry : (Number.isFinite(cmp) ? cmp : null),
                cmp: Number.isFinite(cmp) ? cmp : null,
                target,
                stoploss: Number.isFinite(stoploss) ? stoploss : null,
                stoplossEstimated: !Number.isFinite(stoploss),
                brokerId: '5paisa',
                broker: '5paisa Capital (INH000025188)',
                sourceUrl: 'https://www.5paisa.com/share-market-today/stocks-to-buy-or-sell-today',
                publishedAt: 'Daily Desk',
                chartSymbolHint: scriptRaw
            });
        }
    } catch (err) {
        console.warn('[OptionTips] 5paisa fetch warning:', err.message);
    }
    return tips;
}

async function fetchMoneycontrolBrokerCalls() {
    const tips = [];
    try {
        const res = await fetchWithTimeout('https://www.moneycontrol.com/news/tags/recommendations.html', {
            headers: { 'User-Agent': UA, Accept: 'text/html' }
        }, 4500);
        if (!res.ok) return tips;
        const html = await res.text();
        const anchorRegex = /<a[^>]+href="(https:\/\/www\.moneycontrol\.com\/news\/business\/stocks\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        const seen = new Set();
        let match;
        while ((match = anchorRegex.exec(html)) !== null) {
            const href = sanitizeSafeUrl(match[1], 'https://www.moneycontrol.com/news/tags/recommendations.html');
            const text = decodeEntities(match[2]);
            const parsed = text.match(/^(Buy|Sell|Accumulate|Reduce)\s+([^;]{2,60});\s*target\s+of\s+Rs\s*([\d,.]+)\s*:\s*([^<]{2,45})$/i);
            if (!parsed) continue;

            const verb = parsed[1].toUpperCase();
            const action = (verb === 'SELL' || verb === 'REDUCE') ? 'SELL' : 'BUY';
            const scriptName = parsed[2].trim();
            const target = toNum(parsed[3]);
            const brokerRaw = parsed[4].trim();
            if (!Number.isFinite(target) || target <= 0) continue;

            const key = `${scriptName.toLowerCase()}-${brokerRaw.toLowerCase()}-${target}`;
            if (seen.has(key)) continue;
            seen.add(key);

            const matchedBroker = matchBrokerInfo(brokerRaw);
            tips.push({
                id: `mc-${key.replace(/[^a-z0-9]+/g, '-')}`,
                scriptName,
                segment: 'EQUITY',
                action,
                entry: null,
                cmp: null,
                target,
                stoploss: null,
                stoplossEstimated: true,
                brokerId: matchedBroker ? matchedBroker.id : 'sebi-broker',
                broker: matchedBroker ? matchedBroker.shortName : brokerRaw,
                sourceUrl: href,
                publishedAt: 'Research Call',
                chartSymbolHint: scriptName
            });
            if (tips.length >= 24) break;
        }
    } catch (err) {
        console.warn('[OptionTips] Moneycontrol fetch warning:', err.message);
    }
    return tips;
}

function parseHeadlineTip(title, link, pubDate) {
    const clean = decodeEntities(title);
    const matchedBroker = matchBrokerInfo(clean);
    if (!matchedBroker) return null;

    // Extract Buy/Sell action
    const hasSell = /\b(sell|bearish|short|reduce|underweight)\b/i.test(clean);
    const hasBuy = /\b(buy|bullish|long|accumulate|outperform|upside|top picks?)\b/i.test(clean);
    if (!hasBuy && !hasSell) return null;
    const action = hasSell && !hasBuy ? 'SELL' : 'BUY';

    // Extract target and stop loss numbers if present in headline
    const targetMatch = clean.match(/target(?:\s+price)?(?:\s+of|\s+at)?\s*(?:Rs\.?|₹)?\s*([\d,]+(?:\.\d+)?)/i);
    const slMatch = clean.match(/(?:stop\s*loss|stoploss|sl)\s*(?:of|at|:)?\s*(?:Rs\.?|₹)?\s*([\d,]+(?:\.\d+)?)/i);
    const target = targetMatch ? toNum(targetMatch[1]) : null;
    const stoploss = slMatch ? toNum(slMatch[1]) : null;

    // Determine script name (Index or Company)
    let scriptName = '';
    if (/\bbank\s*nifty\b/i.test(clean)) scriptName = 'BANK NIFTY';
    else if (/\bnifty(?:\s*50)?\b/i.test(clean)) scriptName = 'NIFTY 50';
    else if (/\bsensex\b/i.test(clean)) scriptName = 'SENSEX';
    else {
        const mcStyle = clean.match(/\b(?:Buy|Sell|Accumulate|Reduce)\s+([A-Z][A-Za-z0-9 &.\-]{2,40}?)(?:;|,|:|\s+shares|\s+stock|\s+target)/i);
        const targetStyle = clean.match(/^([A-Z][A-Za-z0-9 &.\-]{2,35}?)\s+(?:Share Price\s+)?Target(?:\s+at|\s+of)?\s+(?:Rs|₹)/i);
        scriptName = (mcStyle?.[1] || targetStyle?.[1] || '').trim();
    }

    if (!scriptName || (!Number.isFinite(target) && !/(NIFTY|SENSEX)/i.test(scriptName))) {
        return null;
    }

    const isIndex = /^(NIFTY 50|BANK NIFTY|SENSEX)$/i.test(scriptName);
    return {
        id: `rss-${matchedBroker.id}-${scriptName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        scriptName,
        segment: isIndex ? 'INDEX' : 'EQUITY',
        action,
        entry: null,
        cmp: null,
        target: Number.isFinite(target) ? target : null,
        stoploss: Number.isFinite(stoploss) ? stoploss : null,
        stoplossEstimated: !Number.isFinite(stoploss),
        brokerId: matchedBroker.id,
        broker: matchedBroker.shortName,
        sourceUrl: sanitizeSafeUrl(link, matchedBroker.researchUrl),
        publishedAt: pubDate ? String(pubDate).replace(/\s*\+\d{4}$/, '').slice(0, 16) : 'Advisory Feed',
        headline: clean,
        chartSymbolHint: scriptName
    };
}

async function fetchBrokerageNewsTips() {
    const tips = [];
    const queries = [
        '("Motilal Oswal" OR "ICICI Direct" OR "Kotak Securities" OR "Angel One") ("target" OR "stop loss" OR "Buy" OR "Sell") (Nifty OR "Bank Nifty" OR Sensex OR Rs) when:10d',
        '("HDFC Securities" OR "Axis Securities" OR "Sharekhan" OR "5paisa" OR "StockBox" OR "Mangal Keshav" OR "FinKuber" OR "ABJ Finstocks") ("target" OR "stop loss" OR "Buy" OR "Sell") (Nifty OR "Bank Nifty" OR Sensex OR Rs) when:14d'
    ];
    const rssUrls = [
        'https://economictimes.indiatimes.com/markets/stocks/recos/rssfeeds/3053611.cms',
        ...queries.map(q => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-IN&gl=IN&ceid=IN:en`)
    ];

    const responses = await Promise.allSettled(
        rssUrls.map(u => fetchWithTimeout(u, { headers: { 'User-Agent': UA, Accept: 'application/xml,text/xml' } }, 4500))
    );

    const seen = new Set();
    for (const r of responses) {
        if (r.status !== 'fulfilled' || !r.value.ok) continue;
        const xml = await r.value.text();
        const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 25);
        for (const item of items) {
            const rawTitle = (item[1].match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '';
            const rawLink = (item[1].match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || '';
            const rawPub = (item[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1] || '';
            const parsed = parseHeadlineTip(rawTitle, decodeEntities(rawLink), decodeEntities(rawPub));
            if (!parsed) continue;
            const key = `${parsed.brokerId}-${parsed.scriptName.toUpperCase()}`;
            if (seen.has(key)) continue;
            seen.add(key);
            tips.push(parsed);
        }
    }
    return tips;
}

async function refreshBrokerFeedCache(force = false) {
    const now = Date.now();
    if (!force && brokerFeedCache.tips.length > 0 && (now - brokerFeedCache.ts) < BROKER_FEEDS_TTL_MS) {
        return brokerFeedCache.tips;
    }
    if (brokerFeedCache.inFlight) {
        return brokerFeedCache.tips.length > 0 ? brokerFeedCache.tips : brokerFeedCache.inFlight;
    }

    const work = (async () => {
        const [p5, mc, rss] = await Promise.allSettled([
            fetch5paisaTips(),
            fetchMoneycontrolBrokerCalls(),
            fetchBrokerageNewsTips()
        ]);

        const combined = [];
        const dedup = new Set();
        for (const res of [p5, mc, rss]) {
            if (res.status !== 'fulfilled' || !Array.isArray(res.value)) continue;
            for (const item of res.value) {
                const k = `${item.brokerId}:${item.scriptName.toUpperCase()}`;
                if (dedup.has(k)) continue;
                dedup.add(k);
                combined.push(item);
            }
        }

        // Resolve Yahoo symbols in parallel (bounded)
        await Promise.allSettled(
            combined.slice(0, 35).map(async (item) => {
                item.yahooSymbol = await resolveYahooSymbol(item.chartSymbolHint || item.scriptName);
            })
        );

        brokerFeedCache = { ts: Date.now(), tips: combined, inFlight: null };
        return combined;
    })();

    brokerFeedCache.inFlight = work;
    // Wait on cold start; return stale while refreshing on subsequent 1s ticks
    if (brokerFeedCache.tips.length === 0) {
        return await work;
    }
    work.catch(() => { brokerFeedCache.inFlight = null; });
    return brokerFeedCache.tips;
}

// =========================================================================
// Layer B: Live 1-Second Option Chain (NIFTY, BANKNIFTY, SENSEX, FINNIFTY)
// =========================================================================
const INDEX_OPT_CONFIG = [
    { symbol: 'NIFTY', display: 'NIFTY', chartSymbol: '^NSEI', slug: 'nifty', spotYahoo: '^NSEI', spotSegment: 'NSE' },
    { symbol: 'BANKNIFTY', display: 'BANKNIFTY', chartSymbol: '^NSEBANK', slug: 'nifty-bank', spotYahoo: '^NSEBANK', spotSegment: 'NSE' },
    { symbol: 'SENSEX', display: 'SENSEX', chartSymbol: '^BSESN', slug: 'sp-bse-sensex', spotYahoo: '^BSESN', spotSegment: 'BSE' },
    { symbol: 'FINNIFTY', display: 'FINNIFTY', chartSymbol: '^CNXFIN', slug: 'nifty-financial-services', spotYahoo: '^CNXFIN', spotSegment: 'NSE' }
];

function computeEma(vals, period) {
    if (!vals || vals.length === 0) return null;
    const k = 2 / (period + 1);
    let ema = vals[0];
    for (let i = 1; i < vals.length; i++) {
        ema = vals[i] * k + ema * (1 - k);
    }
    return ema;
}

function computeRsi(vals, period = 14) {
    if (!vals || vals.length <= period) return 50;
    let gains = 0;
    let losses = 0;
    for (let i = vals.length - period; i < vals.length; i++) {
        const diff = vals[i] - vals[i - 1];
        if (diff >= 0) gains += diff;
        else losses += Math.abs(diff);
    }
    if (losses === 0) return 75;
    const rs = (gains / period) / (losses / period);
    return 100 - (100 / (1 + rs));
}

async function fetchIndexTechnicalBias(yahooSymbol) {
    const cached = spotTechCache.get(yahooSymbol);
    if (cached && (Date.now() - cached.ts) < SPOT_CANDLES_TTL_MS) {
        return cached.data;
    }
    try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=5m&range=2d`;
        const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } }, 3500);
        if (!res.ok) return cached ? cached.data : null;
        const json = await res.json();
        const result = json?.chart?.result?.[0];
        const quote = result?.indicators?.quote?.[0] || {};
        const closes = (quote.close || []).map(Number).filter(n => Number.isFinite(n) && n > 0);
        const highs = (quote.high || []).map(Number).filter(n => Number.isFinite(n) && n > 0);
        const lows = (quote.low || []).map(Number).filter(n => Number.isFinite(n) && n > 0);
        const vols = (quote.volume || []).map(Number);

        const lastClose = closes[closes.length - 1] || Number(result?.meta?.regularMarketPrice) || 0;
        const ema9 = computeEma(closes.slice(-30), 9) || lastClose;
        const ema21 = computeEma(closes.slice(-45), 21) || lastClose;
        const rsi = computeRsi(closes, 14);

        let atrSum = 0;
        let atrCnt = 0;
        const len = Math.min(highs.length, lows.length, closes.length);
        for (let i = Math.max(1, len - 14); i < len; i++) {
            const tr = Math.max(
                highs[i] - lows[i],
                Math.abs(highs[i] - closes[i - 1]),
                Math.abs(lows[i] - closes[i - 1])
            );
            if (Number.isFinite(tr) && tr > 0) {
                atrSum += tr;
                atrCnt++;
            }
        }
        const atr = atrCnt > 0 ? atrSum / atrCnt : lastClose * 0.004;

        // Session VWAP estimate across trailing 25 bars
        let pv = 0;
        let vv = 0;
        for (let i = Math.max(0, closes.length - 25); i < closes.length; i++) {
            const v = Number.isFinite(vols[i]) && vols[i] > 0 ? vols[i] : 1;
            pv += closes[i] * v;
            vv += v;
        }
        const vwap = vv > 0 ? pv / vv : lastClose;

        const data = {
            price: roundTick(lastClose),
            ema9: roundTick(ema9),
            ema21: roundTick(ema21),
            vwap: roundTick(vwap),
            rsi: roundTick(rsi, 1),
            atr: roundTick(atr)
        };
        spotTechCache.set(yahooSymbol, { ts: Date.now(), data });
        return data;
    } catch {
        return cached ? cached.data : null;
    }
}

function getLockedAnchor(key, currentPrice) {
    const now = Date.now();
    const hit = optionAnchorCache.get(key);
    if (hit && (now - hit.ts) < ANCHOR_TTL_MS && hit.entry > 0) {
        return hit.entry;
    }
    const anchored = roundOptionTick(currentPrice);
    if (optionAnchorCache.size > 300) optionAnchorCache.clear();
    optionAnchorCache.set(key, { entry: anchored, ts: now });
    return anchored;
}

async function fetchIndexOptionTips(cfg) {
    const tips = [];
    const ocUrl = `https://groww.in/v1/api/option_chain_service/v1/option_chain/${cfg.slug}`;
    const spotUrl = cfg.symbol === 'SENSEX'
        ? 'https://groww.in/v1/api/stocks_data/v1/tr_live_indices/exchange/BSE/segment/CASH/1/latest'
        : `https://groww.in/v1/api/stocks_data/v1/tr_live_indices/exchange/NSE/segment/CASH/${cfg.symbol}/latest`;

    const headers = { 'User-Agent': UA, Accept: 'application/json' };
    const [ocRes, spotRes, techRes] = await Promise.allSettled([
        fetchWithTimeout(ocUrl, { headers }, 3500),
        fetchWithTimeout(spotUrl, { headers }, 3500),
        fetchIndexTechnicalBias(cfg.spotYahoo)
    ]);

    let spotPrice = NaN;
    if (spotRes.status === 'fulfilled' && spotRes.value.ok) {
        const sj = await spotRes.value.json();
        spotPrice = toNum(sj.value ?? sj.indexIndicativePrice ?? sj.close);
    }

    const tech = techRes.status === 'fulfilled' ? techRes.value : null;
    if (!Number.isFinite(spotPrice) && tech?.price) {
        spotPrice = tech.price;
    }

    let ocRows = [];
    let expiry = '';
    if (ocRes.status === 'fulfilled' && ocRes.value.ok) {
        const ocJson = await ocRes.value.json();
        const rawList = ocJson?.optionChain?.optionChains || [];
        expiry = ocJson?.optionChain?.expiryDetailsDto?.currentExpiry || '';
        const strikeMap = new Map();
        for (const item of rawList) {
            const strike = Number((toNum(item.strikePrice) / 100).toFixed(2));
            if (!strike) continue;
            const ce = item.callOption || {};
            const pe = item.putOption || {};
            strikeMap.set(strike, {
                strike,
                ceLtp: toNum(ce.ltp) || 0,
                ceVol: toNum(ce.volume) || 0,
                ceOi: toNum(ce.openInterest) || 0,
                peLtp: toNum(pe.ltp) || 0,
                peVol: toNum(pe.volume) || 0,
                peOi: toNum(pe.openInterest) || 0
            });
        }
        ocRows = Array.from(strikeMap.values()).sort((a, b) => a.strike - b.strike);
    }

    // Fallback to BSE Sensex option chain if Groww returned empty for SENSEX
    if (cfg.symbol === 'SENSEX' && ocRows.length === 0) {
        try {
            const bseRes = await fetchWithTimeout('https://api.bseindia.com/BseIndiaAPI/api/DerivOptionChain_New/w?Expiry=&scrip_cd=1&strprice=0', {
                headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://www.bseindia.com/' }
            }, 3500);
            if (bseRes.ok) {
                const bj = await bseRes.json();
                const tbl = Array.isArray(bj?.Table) ? bj.Table : [];
                const exps = Array.from(new Set(tbl.map(r => String(r.End_TimeStamp || '').trim()).filter(Boolean))).sort((a, b) => Date.parse(a) - Date.parse(b));
                expiry = exps[0] || '';
                const map = new Map();
                for (const r of tbl) {
                    if (expiry && String(r.End_TimeStamp || '').trim() !== expiry) continue;
                    const strike = toNum(r.Strike_Price1 || r.Strike_Price);
                    if (!strike) continue;
                    if (!Number.isFinite(spotPrice)) {
                        const ula = toNum(r.UlaValue);
                        if (ula > 0) spotPrice = ula;
                    }
                    map.set(strike, {
                        strike,
                        ceLtp: toNum(r.C_Last_Trd_Price) || 0,
                        ceVol: toNum(r.C_Vol_Traded) || 0,
                        ceOi: toNum(r.C_Open_Interest) || 0,
                        peLtp: toNum(r.Last_Trd_Price) || 0,
                        peVol: toNum(r.Vol_Traded) || 0,
                        peOi: toNum(r.Open_Interest) || 0
                    });
                }
                ocRows = Array.from(map.values()).sort((a, b) => a.strike - b.strike);
            }
        } catch {
            // ignore fallback failure
        }
    }

    // Determine live trend bias from Spot EMA9/EMA21/VWAP + Option Chain Volume/OI
    let bullScore = 0;
    if (tech && Number.isFinite(spotPrice)) {
        if (spotPrice >= tech.ema9) bullScore += 1;
        else bullScore -= 1;
        if (tech.ema9 >= tech.ema21) bullScore += 1;
        else bullScore -= 1;
        if (spotPrice >= tech.vwap) bullScore += 1;
        else bullScore -= 1;
    }

    if (ocRows.length > 0) {
        let atmIdx = 0;
        let bestDiff = Infinity;
        for (let i = 0; i < ocRows.length; i++) {
            const d = Number.isFinite(spotPrice)
                ? Math.abs(ocRows[i].strike - spotPrice)
                : Math.abs(ocRows[i].ceLtp - ocRows[i].peLtp);
            if (d < bestDiff) {
                bestDiff = d;
                atmIdx = i;
            }
        }

        const windowRows = ocRows.slice(Math.max(0, atmIdx - 3), atmIdx + 4);
        const totalCeOi = windowRows.reduce((s, r) => s + r.ceOi, 0);
        const totalPeOi = windowRows.reduce((s, r) => s + r.peOi, 0);
        const totalCeVol = windowRows.reduce((s, r) => s + r.ceVol, 0);
        const totalPeVol = windowRows.reduce((s, r) => s + r.peVol, 0);
        const pcr = totalCeOi > 0 ? totalPeOi / totalCeOi : 1;
        if (pcr >= 1.05) bullScore += 1;
        else if (pcr <= 0.9) bullScore -= 1;

        const isBullish = bullScore >= 0;
        const atmRow = ocRows[atmIdx];
        const nextBullRow = ocRows[Math.min(ocRows.length - 1, atmIdx + 1)] || atmRow;
        const nextBearRow = ocRows[Math.max(0, atmIdx - 1)] || atmRow;

        // Tip 1: Primary ATM Direction Option Call/Put (BUY)
        const optType = isBullish ? 'CE' : 'PE';
        const cmpOpt = isBullish ? atmRow.ceLtp : atmRow.peLtp;
        if (cmpOpt > 0) {
            const anchorKey = `${cfg.symbol}:${atmRow.strike}:${optType}:BUY`;
            const entry = getLockedAnchor(anchorKey, cmpOpt);
            const target = roundOptionTick(entry * 1.22);
            const stoploss = roundOptionTick(entry * 0.88);
            tips.push({
                id: `opt-${cfg.symbol.toLowerCase()}-${atmRow.strike}-${optType.toLowerCase()}`,
                scriptName: `${cfg.display} ${atmRow.strike} ${optType}`,
                segment: 'OPTION',
                optionType: optType,
                action: 'BUY',
                entry,
                cmp: roundTick(cmpOpt),
                target,
                stoploss,
                stoplossEstimated: false,
                brokerId: 'live-option-chain',
                broker: 'Live Option Chain (PCR ' + pcr.toFixed(2) + ')',
                sourceUrl: '',
                publishedAt: expiry || '1s Live',
                chartSymbol: cfg.chartSymbol,
                underlyingSpot: roundTick(spotPrice),
                oi: isBullish ? atmRow.ceOi : atmRow.peOi,
                volume: isBullish ? atmRow.ceVol : atmRow.peVol
            });
        }

        // Tip 2: Secondary OTM Breakout Call/Put (BUY)
        const secRow = isBullish ? nextBullRow : nextBearRow;
        const secType = isBullish ? 'CE' : 'PE';
        const secCmp = isBullish ? secRow.ceLtp : secRow.peLtp;
        if (secCmp > 0 && secRow.strike !== atmRow.strike) {
            const anchorKey = `${cfg.symbol}:${secRow.strike}:${secType}:OTM`;
            const entry = getLockedAnchor(anchorKey, secCmp);
            tips.push({
                id: `opt-otm-${cfg.symbol.toLowerCase()}-${secRow.strike}-${secType.toLowerCase()}`,
                scriptName: `${cfg.display} ${secRow.strike} ${secType}`,
                segment: 'OPTION',
                optionType: secType,
                action: 'BUY',
                entry,
                cmp: roundTick(secCmp),
                target: roundOptionTick(entry * 1.28),
                stoploss: roundOptionTick(entry * 0.86),
                stoplossEstimated: false,
                brokerId: 'live-option-chain',
                broker: `Live Option Chain (${totalCeVol >= totalPeVol ? 'CE Vol High' : 'PE Vol High'})`,
                sourceUrl: '',
                publishedAt: expiry || '1s Live',
                chartSymbol: cfg.chartSymbol,
                underlyingSpot: roundTick(spotPrice),
                oi: isBullish ? secRow.ceOi : secRow.peOi,
                volume: isBullish ? secRow.ceVol : secRow.peVol
            });
        }
    }

    // Tip 3: Index Spot Technical Level (NIFTY 50 / BANK NIFTY / SENSEX)
    if (Number.isFinite(spotPrice) && spotPrice > 0) {
        const isBullish = bullScore >= 0;
        const rawEma9 = tech?.ema9;
        const emaDiverges = !Number.isFinite(rawEma9) || (Math.abs(rawEma9 - spotPrice) / spotPrice) > 0.025;
        const entry = roundTick(emaDiverges ? spotPrice : rawEma9);
        const rawAtr = tech?.atr;
        const atr = (Number.isFinite(rawAtr) && rawAtr > 0 && rawAtr < spotPrice * 0.03)
            ? rawAtr
            : spotPrice * 0.004;
        const target = roundTick(isBullish ? entry + atr * 1.6 : entry - atr * 1.6);
        const stoploss = roundTick(isBullish ? entry - atr * 0.95 : entry + atr * 0.95);
        tips.push({
            id: `idx-${cfg.symbol.toLowerCase()}`,
            scriptName: cfg.symbol === 'NIFTY' ? 'NIFTY 50' : (cfg.symbol === 'BANKNIFTY' ? 'BANK NIFTY' : cfg.display),
            segment: 'INDEX',
            action: isBullish ? 'BUY' : 'SELL',
            entry,
            cmp: roundTick(spotPrice),
            target,
            stoploss,
            stoplossEstimated: false,
            brokerId: 'live-option-chain',
            broker: `Index Tech (RSI ${tech?.rsi ?? '--'})`,
            sourceUrl: '',
            publishedAt: '1s Live Spot',
            chartSymbol: cfg.chartSymbol
        });
    }

    return tips;
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store, max-age=0');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const forceRefresh = String(req.query?.force || '') === '1';
    const now = Date.now();

    if (!forceRefresh && livePayloadCache.data && (now - livePayloadCache.ts) < LIVE_TIPS_TTL_MS) {
        return res.status(200).json(livePayloadCache.data);
    }

    try {
        const [brokerTipsRaw, ...indexGroups] = await Promise.all([
            refreshBrokerFeedCache(forceRefresh),
            ...INDEX_OPT_CONFIG.map(cfg => fetchIndexOptionTips(cfg).catch(() => []))
        ]);

        // Enrich up to 20 brokerage tips with real-time Yahoo Finance CMP
        const brokerTips = (brokerTipsRaw || []).map(t => ({ ...t }));
        const symbolsToQuote = Array.from(new Set(brokerTips.map(t => t.yahooSymbol).filter(Boolean))).slice(0, 20);
        const quotePairs = await Promise.allSettled(
            symbolsToQuote.map(async sym => [sym, await fetchLiveYahooQuote(sym)])
        );
        const quoteMap = new Map();
        for (const q of quotePairs) {
            if (q.status === 'fulfilled' && q.value[1]) {
                quoteMap.set(q.value[0], q.value[1]);
            }
        }

        for (const t of brokerTips) {
            const q = t.yahooSymbol ? quoteMap.get(t.yahooSymbol) : null;
            if (q && Number.isFinite(q.price)) {
                t.cmp = q.price;
                if (!Number.isFinite(t.entry)) {
                    t.entry = q.price;
                }
            }
            if (Number.isFinite(t.entry) && !Number.isFinite(t.stoploss) && Number.isFinite(t.target)) {
                // Provide transparent 4% technical reference SL when headline omitted SL
                t.stoploss = t.action === 'SELL' ? roundTick(t.entry * 1.04) : roundTick(t.entry * 0.96);
                t.stoplossEstimated = true;
            }
            t.chartSymbol = t.yahooSymbol || t.scriptName;
        }

        const optionAndIndexTips = indexGroups.flat();
        const allTips = [...optionAndIndexTips, ...brokerTips];

        // Compute broker counts across all 12 firms
        const brokerStats = BROKER_DIRECTORY.map(b => ({
            id: b.id,
            name: b.name,
            shortName: b.shortName,
            sebiReg: b.sebiReg,
            researchUrl: b.researchUrl,
            count: allTips.filter(t => t.brokerId === b.id).length
        }));

        const payload = {
            updatedAt: new Date().toISOString(),
            totalTips: allTips.length,
            optionTipsCount: optionAndIndexTips.length,
            brokerTipsCount: brokerTips.length,
            brokers: brokerStats,
            tips: allTips
        };

        livePayloadCache = { ts: Date.now(), data: payload };
        return res.status(200).json(payload);
    } catch (err) {
        console.warn('[API /option-tips] Error:', err.message);
        if (livePayloadCache.data) {
            return res.status(200).json({ ...livePayloadCache.data, stale: true });
        }
        return res.status(502).json({ error: err.message || 'Option tips unavailable' });
    }
}
