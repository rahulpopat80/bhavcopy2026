// Vercel Serverless Function: /api/option-tips.js
// Aggregates:
// 1. Real-time NSE/BSE Option Chain (NIFTY, BANKNIFTY, SENSEX, FINNIFTY) CE/PE & Spot signals
// 2. Real-time GOLD & SILVER tips in both INR (MCX /10g & /1kg) and USD (Spot $/oz)
// 3. All active NSE Listed Scripts (3,000+ equities) live technical BUY/SELL/Target/SL via TradingView India Scanner
// 4. Real public brokerage calls from 5paisa, Moneycontrol, Economic Times & Google News RSS
//    covering the 12 Indian brokerages/advisories requested, enriched with live CMP.

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
const NSE_ALL_TTL_MS = 1800;
const CORE_LIVE_TTL_MS = 450;
const SPOT_CANDLES_TTL_MS = 10 * 1000;
const QUOTE_TTL_MS = 850;
const ANCHOR_TTL_MS = 4 * 60 * 60 * 1000;
const EXIT_RETENTION_MS = 6 * 60 * 60 * 1000;
const MAX_RECENT_EXITS = 30;

let brokerFeedCache = { ts: 0, tips: [], inFlight: null };
let nseAllCache = { ts: 0, tips: [], inFlight: null };
let coreCache = { ts: 0, optionTips: [], commodityTips: [], brokerTips: [], nseAllTips: [] };
let nseInitialBootDone = false;
const nseBootTs = Date.now();
const spotTechCache = new Map();
const symbolResolveCache = new Map();
const liveQuoteCache = new Map();
const optionAnchorCache = new Map();
const signalTimelineMap = new Map();
const exitHistoryMap = new Map();
const recentExitsMap = new Map();
const nseSignalStateMap = new Map();
const mcxExpiryCache = {
    GOLD: { expiry: '2026-12-04' },
    SILVER: { expiry: '2026-12-04' }
};
const mcxParityState = {
    GOLD: { basePrice: null, lastUpd: '', baseFactor: null },
    SILVER: { basePrice: null, lastUpd: '', baseFactor: null }
};

function formatIstDateTime(ms) {
    const ts = Number(ms);
    if (!Number.isFinite(ts) || ts <= 0) {
        return { dateStr: '--', timeStr: '--', iso: '' };
    }
    const d = new Date(ts);
    const dateStr = new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: 'short',
        year: 'numeric'
    }).format(d);
    const timeStr = new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    }).format(d).toUpperCase();
    return { dateStr, timeStr, iso: d.toISOString() };
}

function parseIstDateTimeString(raw) {
    const clean = String(raw || '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    const m = clean.match(/^([A-Za-z]+)\s+(\d{1,2})\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\s*(?:IST)?$/i);
    if (!m) return NaN;
    const months = {
        jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
        apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
        aug: 7, august: 7, sep: 8, sept: 8, september: 8,
        oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11
    };
    const monthIdx = months[m[1].toLowerCase()];
    if (monthIdx === undefined) return NaN;
    const day = parseInt(m[2], 10);
    const year = parseInt(m[3], 10);
    let hour = parseInt(m[4], 10);
    const minute = parseInt(m[5], 10);
    const second = m[6] ? parseInt(m[6], 10) : 0;
    const ampm = (m[7] || '').toUpperCase();
    if (ampm === 'PM' && hour < 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
    // IST is UTC +05:30 (330 minutes)
    return Date.UTC(year, monthIdx, day, hour, minute, second) - (330 * 60 * 1000);
}

function parsePubDateMs(rawPub) {
    if (!rawPub) return NaN;
    const istParsed = parseIstDateTimeString(rawPub);
    if (Number.isFinite(istParsed)) return istParsed;
    const ms = Date.parse(String(rawPub).trim());
    return Number.isFinite(ms) ? ms : NaN;
}

function formatPriceForMsg(val, currency = 'INR') {
    const n = Number(val);
    if (!Number.isFinite(n) || n <= 0) return '--';
    const isUsd = String(currency).toUpperCase() === 'USD';
    const dec = isUsd && n < 150 ? 3 : 2;
    return (isUsd ? '$' : '₹') + n.toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

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

function roundNseTick(val) {
    if (!Number.isFinite(val) || val <= 0) return null;
    return Math.round(val * 20) / 20;
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
        const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } }, 2800);
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

function registerObservedTipTime(sigKey, tipSnapshot, now) {
    const prev = signalTimelineMap.get(sigKey);
    if (!prev) {
        if (signalTimelineMap.size > 1500) signalTimelineMap.clear();
        signalTimelineMap.set(sigKey, {
            issuedAtMs: now,
            action: tipSnapshot.action,
            signature: `${tipSnapshot.action}:${tipSnapshot.entry || ''}:${tipSnapshot.target || ''}:${tipSnapshot.stoploss || ''}`,
            snapshot: tipSnapshot
        });
        return now;
    }

    const nextSignature = `${tipSnapshot.action}:${tipSnapshot.entry || ''}:${tipSnapshot.target || ''}:${tipSnapshot.stoploss || ''}`;
    if (prev.action !== tipSnapshot.action) {
        // Record previous active call into recentExitsMap as a real signal reversal EXIT message
        const old = prev.snapshot;
        if (old && old.scriptName) {
            const exitId = `exit-rev-${sigKey}-${now}`;
            const curCmp = tipSnapshot.cmp || old.cmp;
            recentExitsMap.set(exitId, {
                ...old,
                id: exitId,
                cmp: curCmp,
                exitFlag: true,
                exitType: 'REVERSAL_EXIT',
                exitMessage: `EXIT (${old.action} CLOSED): Signal reversed to ${tipSnapshot.action} @ ${formatPriceForMsg(curCmp, old.currency)}`,
                issuedAtMs: prev.issuedAtMs,
                exitAtMs: now,
                lastEventMs: now
            });
            while (recentExitsMap.size > MAX_RECENT_EXITS) {
                const firstKey = recentExitsMap.keys().next().value;
                recentExitsMap.delete(firstKey);
            }
        }
        signalTimelineMap.set(sigKey, {
            issuedAtMs: now,
            action: tipSnapshot.action,
            signature: nextSignature,
            snapshot: tipSnapshot
        });
        return now;
    }

    if (prev.signature !== nextSignature && prev.snapshot?.brokerId === '5paisa') {
        signalTimelineMap.set(sigKey, {
            issuedAtMs: now,
            action: tipSnapshot.action,
            signature: nextSignature,
            snapshot: tipSnapshot
        });
        return now;
    }

    prev.snapshot = tipSnapshot;
    return prev.issuedAtMs;
}

async function fetch5paisaTips() {
    const tips = [];
    try {
        const res = await fetchWithTimeout('https://www.5paisa.com/share-market-today/stocks-to-buy-or-sell-today', {
            headers: { 'User-Agent': UA, Accept: 'text/html' }
        }, 4500);
        if (!res.ok) return tips;
        const html = await res.text();
        const rows = [...html.matchAll(/<tr[\s\S]*?<\/tr>/gi)];
        const now = Date.now();
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

            const id = `5paisa-${scriptRaw.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
            const tipObj = {
                id,
                scriptName: scriptRaw.replace(/\s+Ltd\.?$/i, '').trim(),
                segment: 'EQUITY',
                currency: 'INR',
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
            };
            tipObj.issuedAtMs = registerObservedTipTime(id, tipObj, now);
            tips.push(tipObj);
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
        const listItems = [...html.matchAll(/<li class="clearfix"[^>]*>([\s\S]*?)<\/li>/gi)];
        const seen = new Set();

        for (const li of listItems) {
            const block = li[1];
            const linkMatch = block.match(/<a[^>]+href="(https:\/\/www\.moneycontrol\.com\/news\/business\/stocks\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
            if (!linkMatch) continue;
            const href = sanitizeSafeUrl(linkMatch[1], 'https://www.moneycontrol.com/news/tags/recommendations.html');
            const spanDate = decodeEntities((block.match(/<span[^>]*>([\s\S]*?IST)<\/span>/i) || [])[1] || '');
            let text = decodeEntities(linkMatch[2]).replace(/^[A-Za-z]+\s+\d{1,2},\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)\s*IST\s*-->\s*/i, '').trim();

            const parsed = text.match(/^(Buy|Sell|Accumulate|Reduce|Hold|Exit|Book Profit)\s+([^;]{2,60});\s*target\s+of\s+Rs\s*([\d,.]+)\s*:\s*([^<]{2,45})$/i);
            if (!parsed) continue;

            const verb = parsed[1].toUpperCase();
            const isBrokerExit = verb === 'EXIT' || verb === 'BOOK PROFIT';
            const action = isBrokerExit ? 'EXIT' : ((verb === 'SELL' || verb === 'REDUCE') ? 'SELL' : 'BUY');
            const scriptName = parsed[2].trim();
            const target = toNum(parsed[3]);
            const brokerRaw = parsed[4].trim();
            if (!Number.isFinite(target) || target <= 0) continue;

            const key = `${scriptName.toLowerCase()}-${brokerRaw.toLowerCase()}-${target}`;
            if (seen.has(key)) continue;
            seen.add(key);

            const matchedBroker = matchBrokerInfo(brokerRaw);
            const parsedMs = parsePubDateMs(spanDate);
            const issuedAtMs = Number.isFinite(parsedMs) ? parsedMs : Date.now();

            tips.push({
                id: `mc-${key.replace(/[^a-z0-9]+/g, '-')}`,
                scriptName,
                segment: 'EQUITY',
                currency: 'INR',
                action,
                entry: null,
                cmp: null,
                target,
                stoploss: null,
                stoplossEstimated: true,
                brokerId: matchedBroker ? matchedBroker.id : 'sebi-broker',
                broker: matchedBroker ? matchedBroker.shortName : brokerRaw,
                sourceUrl: href,
                publishedAt: spanDate || 'Research Call',
                issuedAtMs,
                exitFlag: isBrokerExit,
                exitType: isBrokerExit ? 'BROKER_EXIT' : null,
                exitMessage: isBrokerExit ? `EXIT — ${verb} @ ${formatPriceForMsg(target, 'INR')}` : '',
                exitAtMs: isBrokerExit ? issuedAtMs : null,
                chartSymbolHint: scriptName
            });
            if (tips.length >= 28) break;
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

    const isCorporateNonCall = /\b(ceo|md|chief|marketing head|president|director|iref|alts|fund|resigns|quits|steps down)\b/i.test(clean);
    const hasExitPhrase = !isCorporateNonCall && /\b(book\s*(?:partial\s*)?profit|target\s*(?:achieved|hit|met)|stop\s*loss\s*(?:hit|triggered)|sl\s*(?:hit|triggered)|square\s*off|close\s*(?:the\s*)?call|exit\s+(?:call|position|trade|stock|long|short))\b/i.test(clean);
    const hasSell = /\b(sell|bearish|short|reduce|underweight)\b/i.test(clean);
    const hasBuy = /\b(buy|bullish|long|accumulate|outperform|upside|top picks?)\b/i.test(clean);
    if (!hasBuy && !hasSell && !hasExitPhrase) return null;
    const action = hasExitPhrase ? 'EXIT' : (hasSell && !hasBuy ? 'SELL' : 'BUY');

    const targetMatch = clean.match(/target(?:\s+price)?(?:\s+of|\s+at)?\s*(?:Rs\.?|₹)?\s*([\d,]+(?:\.\d+)?)/i);
    const slMatch = clean.match(/(?:stop\s*loss|stoploss|sl)\s*(?:of|at|:)?\s*(?:Rs\.?|₹)?\s*([\d,]+(?:\.\d+)?)/i);
    const target = targetMatch ? toNum(targetMatch[1]) : null;
    const stoploss = slMatch ? toNum(slMatch[1]) : null;

    let scriptName = '';
    if (/\bbank\s*nifty\b/i.test(clean)) scriptName = 'BANK NIFTY';
    else if (/\bnifty(?:\s*50)?\b/i.test(clean)) scriptName = 'NIFTY 50';
    else if (/\bsensex\b/i.test(clean)) scriptName = 'SENSEX';
    else {
        const mcStyle = clean.match(/\b(?:Buy|Sell|Accumulate|Reduce|Exit|Book Profit)\s+([A-Z][A-Za-z0-9 &.\-]{2,42}?)(?:;|,|:|\s+Ltd\s+For|\s+shares|\s+stock|\s+target)/i);
        const targetStyle = clean.match(/^([A-Z][A-Za-z0-9 &.\-]{2,35}?)\s+(?:Share Price\s+)?Target(?:\s+at|\s+of)?\s+(?:Rs|₹)/i);
        scriptName = (mcStyle?.[1] || targetStyle?.[1] || '').replace(/\s+Ltd\.?\s+For$/i, '').replace(/\s+For$/i, '').trim();
    }

    if (!scriptName || (!Number.isFinite(target) && !hasExitPhrase && !/(NIFTY|SENSEX)/i.test(scriptName))) {
        return null;
    }

    const parsedMs = parsePubDateMs(pubDate);
    const issuedAtMs = Number.isFinite(parsedMs) ? parsedMs : (Date.now() - 3600 * 1000);
    const isIndex = /^(NIFTY 50|BANK NIFTY|SENSEX)$/i.test(scriptName);

    let exitMessage = '';
    if (hasExitPhrase) {
        if (/book\s*(?:partial\s*)?profit/i.test(clean)) exitMessage = 'EXIT — Brokerage Book Profit Alert';
        else if (/target\s*(?:achieved|hit|met)/i.test(clean)) exitMessage = 'EXIT — Target Achieved (Brokerage Call)';
        else if (/(?:stop\s*loss|sl)\s*(?:hit|triggered)/i.test(clean)) exitMessage = 'EXIT — Stoploss Hit (Brokerage Alert)';
        else exitMessage = 'EXIT — Brokerage Exit / Square Off';
    }

    return {
        id: `rss-${matchedBroker.id}-${scriptName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        scriptName,
        segment: isIndex ? 'INDEX' : 'EQUITY',
        currency: 'INR',
        action,
        entry: null,
        cmp: null,
        target: Number.isFinite(target) ? target : null,
        stoploss: Number.isFinite(stoploss) ? stoploss : null,
        stoplossEstimated: !Number.isFinite(stoploss),
        brokerId: matchedBroker.id,
        broker: matchedBroker.shortName,
        sourceUrl: sanitizeSafeUrl(link, matchedBroker.researchUrl),
        publishedAt: pubDate ? String(pubDate).trim() : 'Advisory Feed',
        issuedAtMs,
        exitFlag: hasExitPhrase,
        exitType: hasExitPhrase ? 'BROKER_EXIT' : null,
        exitMessage,
        exitAtMs: hasExitPhrase ? issuedAtMs : null,
        headline: clean,
        chartSymbolHint: scriptName
    };
}

async function fetchBrokerageNewsTips() {
    const tips = [];
    const queries = [
        '("Motilal Oswal" OR "ICICI Direct" OR "Kotak Securities" OR "Angel One") ("target" OR "stop loss" OR "Buy" OR "Sell" OR "Book Profit") (Nifty OR "Bank Nifty" OR Sensex OR Gold OR Silver OR Rs) when:10d',
        '("HDFC Securities" OR "Axis Securities" OR "Sharekhan" OR "5paisa" OR "StockBox" OR "Mangal Keshav" OR "FinKuber" OR "ABJ Finstocks") ("target" OR "stop loss" OR "Buy" OR "Sell" OR "Book Profit") (Nifty OR "Bank Nifty" OR Sensex OR Gold OR Silver OR Rs) when:14d'
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

        await Promise.allSettled(
            combined.slice(0, 35).map(async (item) => {
                item.yahooSymbol = await resolveYahooSymbol(item.chartSymbolHint || item.scriptName);
            })
        );

        brokerFeedCache = { ts: Date.now(), tips: combined, inFlight: null };
        return combined;
    })();

    brokerFeedCache.inFlight = work;
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

async function fetchTechnicalBias5m(yahooSymbol) {
    const cached = spotTechCache.get(yahooSymbol);
    if (cached && (Date.now() - cached.ts) < SPOT_CANDLES_TTL_MS) {
        return cached.data;
    }
    try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=5m&range=2d`;
        const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } }, 3000);
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

function getLockedAnchor(key, currentPrice, decimals = 2) {
    const now = Date.now();
    const hit = optionAnchorCache.get(key);
    if (hit && (now - hit.ts) < ANCHOR_TTL_MS && hit.entry > 0) {
        return hit.entry;
    }
    const anchored = decimals === 3 ? roundTick(currentPrice, 3) : roundOptionTick(currentPrice);
    if (optionAnchorCache.size > 600) optionAnchorCache.clear();
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
        fetchWithTimeout(ocUrl, { headers }, 3000),
        fetchWithTimeout(spotUrl, { headers }, 3000),
        fetchTechnicalBias5m(cfg.spotYahoo)
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

    if (cfg.symbol === 'SENSEX' && ocRows.length === 0) {
        try {
            const bseRes = await fetchWithTimeout('https://api.bseindia.com/BseIndiaAPI/api/DerivOptionChain_New/w?Expiry=&scrip_cd=1&strprice=0', {
                headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://www.bseindia.com/' }
            }, 3000);
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

    let bullScore = 0;
    if (tech && Number.isFinite(spotPrice)) {
        if (spotPrice >= tech.ema9) bullScore += 1;
        else bullScore -= 1;
        if (tech.ema9 >= tech.ema21) bullScore += 1;
        else bullScore -= 1;
        if (spotPrice >= tech.vwap) bullScore += 1;
        else bullScore -= 1;
    }

    const now = Date.now();
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

        const optType = isBullish ? 'CE' : 'PE';
        const cmpOpt = isBullish ? atmRow.ceLtp : atmRow.peLtp;
        if (cmpOpt > 0) {
            const anchorKey = `${cfg.symbol}:${atmRow.strike}:${optType}:BUY`;
            const entry = getLockedAnchor(anchorKey, cmpOpt);
            const tipObj = {
                id: `opt-${cfg.symbol.toLowerCase()}-${atmRow.strike}-${optType.toLowerCase()}`,
                scriptName: `${cfg.display} ${atmRow.strike} ${optType}`,
                segment: 'OPTION',
                currency: 'INR',
                optionType: optType,
                action: 'BUY',
                entry,
                cmp: roundTick(cmpOpt),
                target: roundOptionTick(entry * 1.22),
                stoploss: roundOptionTick(entry * 0.88),
                stoplossEstimated: false,
                brokerId: 'live-option-chain',
                broker: `Live Option Chain (PCR ${pcr.toFixed(2)})`,
                sourceUrl: '',
                publishedAt: expiry || '1s Live',
                chartSymbol: cfg.chartSymbol
            };
            const slotKey = `opt-atm-${cfg.symbol}`;
            const prevSlot = signalTimelineMap.get(slotKey);
            if (prevSlot && prevSlot.snapshot && prevSlot.snapshot.scriptName !== tipObj.scriptName && (now - prevSlot.issuedAtMs) >= 5000) {
                const old = prevSlot.snapshot;
                const exitId = `exit-opt-${cfg.symbol.toLowerCase()}-${now}`;
                recentExitsMap.set(exitId, {
                    ...old,
                    id: exitId,
                    exitFlag: true,
                    exitType: 'REVERSAL_EXIT',
                    exitMessage: `EXIT (${old.scriptName}): Strike/Bias shifted to ${tipObj.scriptName}`,
                    issuedAtMs: prevSlot.issuedAtMs,
                    exitAtMs: now,
                    lastEventMs: now
                });
                while (recentExitsMap.size > MAX_RECENT_EXITS) {
                    recentExitsMap.delete(recentExitsMap.keys().next().value);
                }
                signalTimelineMap.set(slotKey, {
                    issuedAtMs: now,
                    action: tipObj.action,
                    signature: tipObj.scriptName,
                    snapshot: tipObj
                });
                tipObj.issuedAtMs = now;
            } else {
                tipObj.issuedAtMs = registerObservedTipTime(slotKey, tipObj, now);
            }
            tips.push(tipObj);
        }

        const secRow = isBullish ? nextBullRow : nextBearRow;
        const secType = isBullish ? 'CE' : 'PE';
        const secCmp = isBullish ? secRow.ceLtp : secRow.peLtp;
        if (secCmp > 0 && secRow.strike !== atmRow.strike) {
            const anchorKey = `${cfg.symbol}:${secRow.strike}:${secType}:OTM`;
            const entry = getLockedAnchor(anchorKey, secCmp);
            const tipObj = {
                id: `opt-otm-${cfg.symbol.toLowerCase()}-${secRow.strike}-${secType.toLowerCase()}`,
                scriptName: `${cfg.display} ${secRow.strike} ${secType}`,
                segment: 'OPTION',
                currency: 'INR',
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
                chartSymbol: cfg.chartSymbol
            };
            tipObj.issuedAtMs = registerObservedTipTime(`opt-otm-${cfg.symbol}`, tipObj, now);
            tips.push(tipObj);
        }
    }

    if (Number.isFinite(spotPrice) && spotPrice > 0) {
        const isBullish = bullScore >= 0;
        const rawEma9 = tech?.ema9;
        const emaDiverges = !Number.isFinite(rawEma9) || (Math.abs(rawEma9 - spotPrice) / spotPrice) > 0.025;
        const entry = roundTick(emaDiverges ? spotPrice : rawEma9);
        const rawAtr = tech?.atr;
        const atr = (Number.isFinite(rawAtr) && rawAtr > 0 && rawAtr < spotPrice * 0.03)
            ? rawAtr
            : spotPrice * 0.004;
        const tipObj = {
            id: `idx-${cfg.symbol.toLowerCase()}`,
            scriptName: cfg.symbol === 'NIFTY' ? 'NIFTY 50' : (cfg.symbol === 'BANKNIFTY' ? 'BANK NIFTY' : cfg.display),
            segment: 'INDEX',
            currency: 'INR',
            action: isBullish ? 'BUY' : 'SELL',
            entry,
            cmp: roundTick(spotPrice),
            target: roundTick(isBullish ? entry + atr * 1.6 : entry - atr * 1.6),
            stoploss: roundTick(isBullish ? entry - atr * 0.95 : entry + atr * 0.95),
            stoplossEstimated: false,
            brokerId: 'live-option-chain',
            broker: `Index Tech (RSI ${tech?.rsi ?? '--'})`,
            sourceUrl: '',
            publishedAt: '1s Live Spot',
            chartSymbol: cfg.chartSymbol
        };
        tipObj.issuedAtMs = registerObservedTipTime(tipObj.id, tipObj, now);
        tips.push(tipObj);
    }

    return tips;
}

// =========================================================================
// Layer C: Live GOLD & SILVER Tips (INR MCX /10g & /1kg + USD Spot /oz)
// =========================================================================
async function fetchMcxSpotQuote(symbol) {
    const exp = mcxExpiryCache[symbol]?.expiry || '2026-12-04';
    try {
        const res = await fetchWithTimeout(`https://priceapi.moneycontrol.com/pricefeed/mcx/commodityfutures/${symbol}?expiry=${encodeURIComponent(exp)}`, {
            headers: { 'User-Agent': UA, Accept: 'application/json', 'Cache-Control': 'no-cache' }
        }, 1600);
        if (!res.ok) return null;
        const j = await res.json();
        const price = toNum(j?.data?.lastPrice);
        if (!Number.isFinite(price) || price <= 0) return null;
        return {
            price,
            lastUpd: String(j?.data?.lastupd || j?.data?.lastupdEpoch || ''),
            expiry: j?.data?.EXPIRY || exp
        };
    } catch {
        return null;
    }
}

async function fetchCommodityGoldSilverTips() {
    const tips = [];
    const [tvCfdRes, tvFxRes, mcxGoldRes, mcxSilverRes, goldTechRes, silverTechRes] = await Promise.allSettled([
        fetchWithTimeout('https://scanner.tradingview.com/cfd/scan', {
            method: 'POST',
            headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ symbols: { tickers: ['TVC:GOLD', 'TVC:SILVER', 'OANDA:XAUUSD', 'OANDA:XAGUSD'], query: { types: [] } }, columns: ['close', 'change', 'change_abs'] })
        }, 1500),
        fetchWithTimeout('https://scanner.tradingview.com/forex/scan', {
            method: 'POST',
            headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ symbols: { tickers: ['PEPPERSTONE:USDINR'], query: { types: [] } }, columns: ['close', 'Bid', 'Ask'] })
        }, 1500),
        fetchMcxSpotQuote('GOLD'),
        fetchMcxSpotQuote('SILVER'),
        fetchTechnicalBias5m('GC=F'),
        fetchTechnicalBias5m('SI=F')
    ]);

    const cfdMap = new Map();
    if (tvCfdRes.status === 'fulfilled' && tvCfdRes.value.ok) {
        const j = await tvCfdRes.value.json();
        for (const r of (j?.data || [])) {
            const c = Number(r?.d?.[0]);
            if (Number.isFinite(c) && c > 0) cfdMap.set(r.s, c);
        }
    }
    let usdInr = NaN;
    if (tvFxRes.status === 'fulfilled' && tvFxRes.value.ok) {
        const j = await tvFxRes.value.json();
        usdInr = Number(j?.data?.[0]?.d?.[0]);
    }

    const goldTech = goldTechRes.status === 'fulfilled' ? goldTechRes.value : null;
    const silverTech = silverTechRes.status === 'fulfilled' ? silverTechRes.value : null;

    const spotGoldUsd = cfdMap.get('TVC:GOLD') || cfdMap.get('OANDA:XAUUSD') || goldTech?.price;
    const spotSilverUsd = cfdMap.get('TVC:SILVER') || cfdMap.get('OANDA:XAGUSD') || silverTech?.price;

    const now = Date.now();
    const buildMetalPair = (symKey, labelInr, labelUsd, mcxRaw, spotUsd, tech, chartInr, chartUsd, decUsd) => {
        if (!Number.isFinite(spotUsd) || spotUsd <= 0) return;

        let score = 0;
        if (tech) {
            if (spotUsd >= tech.ema9) score += 1; else score -= 1;
            if (tech.ema9 >= tech.ema21) score += 1; else score -= 1;
            if (spotUsd >= tech.vwap) score += 1; else score -= 1;
            if (tech.rsi >= 50) score += 1; else score -= 1;
        }
        const action = score >= 0 ? 'BUY' : 'SELL';
        const atrPct = (tech?.atr > 0 && tech?.price > 0) ? Math.min(0.015, Math.max(0.0025, tech.atr / tech.price)) : 0.0045;

        // 1. USD Tip
        const usdEntry = getLockedAnchor(`COM:${symKey}:USD:${action}`, spotUsd, decUsd);
        const usdTip = {
            id: `com-${symKey.toLowerCase()}-usd`,
            scriptName: labelUsd,
            segment: 'COMMODITY',
            currency: 'USD',
            action,
            entry: usdEntry,
            cmp: roundTick(spotUsd, decUsd),
            target: roundTick(action === 'BUY' ? usdEntry * (1 + atrPct * 1.8) : usdEntry * (1 - atrPct * 1.8), decUsd),
            stoploss: roundTick(action === 'BUY' ? usdEntry * (1 - atrPct * 1.0) : usdEntry * (1 + atrPct * 1.0), decUsd),
            stoplossEstimated: false,
            brokerId: 'live-commodity',
            broker: `Spot Tech (RSI ${tech?.rsi ?? '--'})`,
            sourceUrl: '',
            publishedAt: '1s Live USD',
            chartSymbol: chartUsd
        };
        usdTip.issuedAtMs = registerObservedTipTime(usdTip.id, usdTip, now);
        tips.push(usdTip);

        // 2. INR MCX Tip (with FX*Spot continuity between MCX edge ticks)
        let inrPrice = mcxRaw?.price || NaN;
        const factor = (Number.isFinite(usdInr) && usdInr > 0) ? (spotUsd * usdInr) : null;
        const pState = mcxParityState[symKey];

        if (mcxRaw?.price > 0) {
            const changed = !pState.basePrice || Math.abs(mcxRaw.price - pState.basePrice) >= 0.01 || (mcxRaw.lastUpd && mcxRaw.lastUpd !== pState.lastUpd);
            if (changed) {
                pState.basePrice = mcxRaw.price;
                pState.lastUpd = mcxRaw.lastUpd || '';
                pState.baseFactor = factor;
            } else if (factor && pState.baseFactor) {
                const ratio = factor / pState.baseFactor;
                if (Number.isFinite(ratio) && Math.abs(ratio - 1) < 0.05) {
                    inrPrice = roundTick(pState.basePrice * ratio, 2);
                }
            }
        } else if (factor) {
            const gramsRatio = symKey === 'GOLD' ? (10 / 31.1034768) : (1000 / 31.1034768);
            inrPrice = roundTick(factor * gramsRatio, 2);
        }

        if (Number.isFinite(inrPrice) && inrPrice > 0) {
            const inrEntry = getLockedAnchor(`COM:${symKey}:INR:${action}`, inrPrice, 2);
            const inrTip = {
                id: `com-${symKey.toLowerCase()}-inr`,
                scriptName: labelInr,
                segment: 'COMMODITY',
                currency: 'INR',
                action,
                entry: inrEntry,
                cmp: roundTick(inrPrice, 2),
                target: roundTick(action === 'BUY' ? inrEntry * (1 + atrPct * 1.8) : inrEntry * (1 - atrPct * 1.8), 2),
                stoploss: roundTick(action === 'BUY' ? inrEntry * (1 - atrPct * 1.0) : inrEntry * (1 + atrPct * 1.0), 2),
                stoplossEstimated: false,
                brokerId: 'live-commodity',
                broker: `MCX Live + Spot FX (RSI ${tech?.rsi ?? '--'})`,
                sourceUrl: '',
                publishedAt: mcxRaw?.expiry ? `MCX ${mcxRaw.expiry}` : '1s Live INR',
                chartSymbol: chartInr
            };
            inrTip.issuedAtMs = registerObservedTipTime(inrTip.id, inrTip, now);
            tips.push(inrTip);
        }
    };

    buildMetalPair(
        'GOLD',
        'GOLD /10g (MCX ₹)',
        'GOLD ($ USD)',
        mcxGoldRes.status === 'fulfilled' ? mcxGoldRes.value : null,
        spotGoldUsd,
        goldTech,
        'GOLD_INR',
        'GC=F',
        2
    );

    buildMetalPair(
        'SILVER',
        'SILVER /1kg (MCX ₹)',
        'SILVER ($ USD)',
        mcxSilverRes.status === 'fulfilled' ? mcxSilverRes.value : null,
        spotSilverUsd,
        silverTech,
        'SILVER_INR',
        'SI=F',
        3
    );

    return tips;
}

// =========================================================================
// Layer D: ALL NSE Listed Scripts Live Technical Tips (3,000+ NSE Equities)
// =========================================================================
async function fetchNseAllScanSlice(start, end) {
    const res = await fetchWithTimeout('https://scanner.tradingview.com/india/scan', {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
            filter: [
                { left: 'exchange', operation: 'equal', right: 'NSE' },
                { left: 'type', operation: 'equal', right: 'stock' },
                { left: 'close', operation: 'greater', right: 0 }
            ],
            columns: ['name', 'close', 'change', 'change_abs', 'EMA9', 'EMA20', 'RSI', 'MACD.macd', 'MACD.signal', 'VWAP', 'ATR', 'volume'],
            sort: { sortBy: 'Value.Traded', sortOrder: 'desc' },
            range: [start, end]
        })
    }, 3500);
    if (!res.ok) throw new Error(`TV India scan ${res.status}`);
    const j = await res.json();
    return Array.isArray(j?.data) ? j.data : [];
}

async function fetchAllNseScriptsTips(force = false) {
    const now = Date.now();
    if (!force && nseAllCache.tips.length > 0 && (now - nseAllCache.ts) < NSE_ALL_TTL_MS) {
        return nseAllCache.tips;
    }
    if (nseAllCache.inFlight) {
        return nseAllCache.tips.length > 0 ? nseAllCache.tips : nseAllCache.inFlight;
    }

    const work = (async () => {
        try {
            const [s1, s2] = await Promise.allSettled([
                fetchNseAllScanSlice(0, 1750),
                fetchNseAllScanSlice(1750, 3500)
            ]);
            const rows = [
                ...(s1.status === 'fulfilled' ? s1.value : []),
                ...(s2.status === 'fulfilled' ? s2.value : [])
            ];

            const seen = new Set();
            const parsed = [];
            const scanNow = Date.now();
            const baselineTs = nseBootTs - 120000;
            for (const row of rows) {
                const d = row?.d;
                if (!Array.isArray(d)) continue;
                const sym = String(d[0] || '').trim().toUpperCase();
                if (!sym || seen.has(sym)) continue;
                const close = Number(d[1]);
                if (!Number.isFinite(close) || close <= 0) continue;
                seen.add(sym);

                const ema9 = Number(d[4]);
                const ema20 = Number(d[5]);
                const rsi = Number(d[6]);
                const macd = Number(d[7]);
                const macdSig = Number(d[8]);
                const vwap = Number(d[9]);
                const atrRaw = Number(d[10]);

                let score = 0;
                if (Number.isFinite(ema9)) score += close >= ema9 ? 1 : -1;
                if (Number.isFinite(ema9) && Number.isFinite(ema20)) score += ema9 >= ema20 ? 1 : -1;
                if (Number.isFinite(vwap)) score += close >= vwap ? 1 : -1;
                if (Number.isFinite(macd) && Number.isFinite(macdSig)) score += macd >= macdSig ? 1 : -1;
                if (Number.isFinite(rsi)) score += rsi >= 50 ? 1 : -1;

                const action = score >= 0 ? 'BUY' : 'SELL';
                const entryBase = (Number.isFinite(ema9) && Math.abs(ema9 - close) / close <= 0.025) ? ema9 : close;
                const entry = roundNseTick(entryBase);
                const atr = (Number.isFinite(atrRaw) && atrRaw > 0 && atrRaw < close * 0.12) ? atrRaw : close * 0.015;
                let target = roundNseTick(action === 'BUY' ? entry + atr * 1.7 : Math.max(0.05, entry - atr * 1.7));
                let stoploss = roundNseTick(action === 'BUY' ? Math.max(0.05, entry - atr * 0.95) : entry + atr * 0.95);
                if (action === 'BUY') {
                    if (target <= entry) target = roundNseTick(entry + Math.max(0.05, entry * 0.02));
                    if (stoploss >= entry) stoploss = roundNseTick(Math.max(0.05, entry - Math.max(0.05, entry * 0.015)));
                } else {
                    if (target >= entry) target = roundNseTick(Math.max(0.05, entry - Math.max(0.05, entry * 0.02)));
                    if (stoploss <= entry) stoploss = roundNseTick(entry + Math.max(0.05, entry * 0.015));
                }
                const rsiStr = Number.isFinite(rsi) ? rsi.toFixed(1) : '--';

                const prevNse = nseSignalStateMap.get(sym);
                let issuedAtMs;
                if (!prevNse) {
                    issuedAtMs = nseInitialBootDone ? scanNow : baselineTs;
                    nseSignalStateMap.set(sym, { action, issuedAtMs, entry, cmp: roundTick(close, 2), target, stoploss });
                } else if (prevNse.action !== action) {
                    // Record previous NSE call exit upon signal flip
                    const exitId = `exit-nse-${sym.toLowerCase()}-${scanNow}`;
                    recentExitsMap.set(exitId, {
                        id: exitId,
                        scriptName: sym,
                        segment: 'NSE_ALL',
                        currency: 'INR',
                        action: prevNse.action,
                        entry: prevNse.entry,
                        cmp: roundTick(close, 2),
                        target: prevNse.target,
                        stoploss: prevNse.stoploss,
                        stoplossEstimated: false,
                        brokerId: 'nse-all-live',
                        broker: `NSE Live Tech (RSI ${rsiStr})`,
                        sourceUrl: '',
                        publishedAt: 'NSE Live',
                        chartSymbol: `${sym}.NS`,
                        exitFlag: true,
                        exitType: 'REVERSAL_EXIT',
                        exitMessage: `EXIT (${prevNse.action} CLOSED): Trend flipped to ${action} @ ${formatPriceForMsg(close, 'INR')}`,
                        issuedAtMs: prevNse.issuedAtMs,
                        exitAtMs: scanNow,
                        lastEventMs: scanNow
                    });
                    while (recentExitsMap.size > MAX_RECENT_EXITS) {
                        recentExitsMap.delete(recentExitsMap.keys().next().value);
                    }
                    issuedAtMs = scanNow;
                    nseSignalStateMap.set(sym, { action, issuedAtMs, entry, cmp: roundTick(close, 2), target, stoploss });
                } else {
                    issuedAtMs = prevNse.issuedAtMs;
                    prevNse.cmp = roundTick(close, 2);
                }

                parsed.push({
                    id: `nse-${sym.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
                    scriptName: sym,
                    segment: 'NSE_ALL',
                    currency: 'INR',
                    action,
                    entry,
                    cmp: roundTick(close, 2),
                    target,
                    stoploss,
                    stoplossEstimated: false,
                    brokerId: 'nse-all-live',
                    broker: `NSE Live Tech (RSI ${rsiStr})`,
                    sourceUrl: '',
                    publishedAt: 'NSE Live',
                    issuedAtMs,
                    chartSymbol: `${sym}.NS`
                });
            }

            if (parsed.length > 0) {
                nseInitialBootDone = true;
                nseAllCache = { ts: Date.now(), tips: parsed, inFlight: null };
                return parsed;
            }
        } catch (err) {
            console.warn('[OptionTips] NSE all scan warning:', err.message);
        } finally {
            nseAllCache.inFlight = null;
        }
        return nseAllCache.tips;
    })();

    nseAllCache.inFlight = work;
    if (nseAllCache.tips.length === 0) {
        return await work;
    }
    work.catch(() => { nseAllCache.inFlight = null; });
    return nseAllCache.tips;
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
    const segFilter = String(req.query?.seg || 'all').trim();
    const brokerFilter = String(req.query?.broker || 'all').trim();
    const searchQuery = String(req.query?.q || '').trim().toLowerCase();
    const reqLimit = Math.min(1200, Math.max(20, parseInt(req.query?.limit, 10) || 120));

    const now = Date.now();

    try {
        let optionTips = coreCache.optionTips;
        let commodityTips = coreCache.commodityTips;
        let brokerTips = coreCache.brokerTips;
        let nseAllTips = coreCache.nseAllTips;

        if (forceRefresh || coreCache.ts === 0 || (now - coreCache.ts) >= CORE_LIVE_TTL_MS) {
            const [brokerTipsRaw, commodityRes, nseAllRes, ...indexGroups] = await Promise.all([
                refreshBrokerFeedCache(forceRefresh),
                fetchCommodityGoldSilverTips().catch(() => []),
                fetchAllNseScriptsTips(forceRefresh).catch(() => []),
                ...INDEX_OPT_CONFIG.map(cfg => fetchIndexOptionTips(cfg).catch(() => []))
            ]);

            // Build quick CMP lookup from live NSE scanner so brokerage tips also get instant live CMP without extra Yahoo latency
            const nseCmpMap = new Map();
            for (const item of nseAllRes) {
                nseCmpMap.set(item.scriptName, item.cmp);
            }

            const enrichedBrokerTips = (brokerTipsRaw || []).map(t => ({ ...t }));
            const missingQuoteSymbols = [];
            for (const t of enrichedBrokerTips) {
                const baseSym = String(t.yahooSymbol || t.chartSymbolHint || '').replace(/\.(NS|BO)$/i, '').toUpperCase();
                const fastCmp = nseCmpMap.get(baseSym);
                if (Number.isFinite(fastCmp) && fastCmp > 0) {
                    t.cmp = fastCmp;
                    if (!Number.isFinite(t.entry)) t.entry = fastCmp;
                } else if (t.yahooSymbol) {
                    missingQuoteSymbols.push(t.yahooSymbol);
                }
            }

            const uniqueMissing = Array.from(new Set(missingQuoteSymbols)).slice(0, 12);
            if (uniqueMissing.length > 0) {
                const quotePairs = await Promise.allSettled(
                    uniqueMissing.map(async sym => [sym, await fetchLiveYahooQuote(sym)])
                );
                const qMap = new Map();
                for (const q of quotePairs) {
                    if (q.status === 'fulfilled' && q.value[1]) {
                        qMap.set(q.value[0], q.value[1]);
                    }
                }
                for (const t of enrichedBrokerTips) {
                    if (!Number.isFinite(t.cmp) && t.yahooSymbol) {
                        const q = qMap.get(t.yahooSymbol);
                        if (q && Number.isFinite(q.price)) {
                            t.cmp = q.price;
                            if (!Number.isFinite(t.entry)) t.entry = q.price;
                        }
                    }
                }
            }

            for (const t of enrichedBrokerTips) {
                if (Number.isFinite(t.entry) && !Number.isFinite(t.stoploss) && Number.isFinite(t.target)) {
                    t.stoploss = t.action === 'SELL' ? roundTick(t.entry * 1.04) : roundTick(t.entry * 0.96);
                    t.stoplossEstimated = true;
                }
                t.chartSymbol = t.yahooSymbol || t.scriptName;
            }

            optionTips = indexGroups.flat();
            commodityTips = commodityRes;
            brokerTips = enrichedBrokerTips;
            nseAllTips = nseAllRes;
            coreCache = { ts: Date.now(), optionTips, commodityTips, brokerTips, nseAllTips };
        }

        const SEG_PRIORITY = { OPTION: 5, COMMODITY: 4, INDEX: 3, EQUITY: 2, NSE_ALL: 1 };
        const evalNow = Date.now();

        function finalizeTip(rawTip) {
            const t = { ...rawTip };
            const curr = t.currency || 'INR';
            const cmp = Number(t.cmp);
            const entry = Number(t.entry);
            const target = Number(t.target);
            const sl = Number(t.stoploss);
            const isSell = t.action === 'SELL';
            const issuedAtMs = Number(t.issuedAtMs) || evalNow;
            const validTarget = Number.isFinite(target) && target > 0 && (t.segment !== 'NSE_ALL' || !Number.isFinite(entry) || (isSell ? target < entry : target > entry));
            const validSl = Number.isFinite(sl) && sl > 0 && (t.segment !== 'NSE_ALL' || !Number.isFinite(entry) || (isSell ? sl > entry : sl < entry));

            if (!t.exitFlag && Number.isFinite(cmp) && cmp > 0) {
                if (validTarget && ((!isSell && cmp >= target) || (isSell && cmp <= target))) {
                    const exKey = `${t.id}:${t.action}:TG:${target}`;
                    const recordedAt = exitHistoryMap.get(exKey) || evalNow;
                    if (!exitHistoryMap.has(exKey)) {
                        if (exitHistoryMap.size > 1200) exitHistoryMap.clear();
                        exitHistoryMap.set(exKey, recordedAt);
                    }
                    t.exitFlag = true;
                    t.exitType = 'TARGET_HIT';
                    t.exitAtMs = recordedAt;
                    t.exitMessage = `EXIT — Target ${formatPriceForMsg(target, curr)} Hit (Book Profit)`;
                } else if (validSl && ((!isSell && cmp <= sl) || (isSell && cmp >= sl))) {
                    const exKey = `${t.id}:${t.action}:SL:${sl}`;
                    const recordedAt = exitHistoryMap.get(exKey) || evalNow;
                    if (!exitHistoryMap.has(exKey)) {
                        if (exitHistoryMap.size > 1200) exitHistoryMap.clear();
                        exitHistoryMap.set(exKey, recordedAt);
                    }
                    t.exitFlag = true;
                    t.exitType = 'SL_HIT';
                    t.exitAtMs = recordedAt;
                    t.exitMessage = `EXIT — Stoploss ${formatPriceForMsg(sl, curr)} Hit (Close Position)`;
                }
            }

            const lastEventMs = Math.max(issuedAtMs, Number(t.exitAtMs) || 0);
            const issuedFmt = formatIstDateTime(issuedAtMs);
            const eventFmt = formatIstDateTime(lastEventMs);

            t.issuedAtMs = issuedAtMs;
            t.lastEventMs = lastEventMs;
            t.issuedDateStr = issuedFmt.dateStr;
            t.issuedTimeStr = issuedFmt.timeStr;
            t.eventDateStr = eventFmt.dateStr;
            t.eventTimeStr = eventFmt.timeStr;
            if (t.exitAtMs) {
                const exFmt = formatIstDateTime(t.exitAtMs);
                t.exitDateStr = exFmt.dateStr;
                t.exitTimeStr = exFmt.timeStr;
            }
            return t;
        }

        // Prune stale recent reversal exits older than 6 hours
        for (const [k, v] of recentExitsMap.entries()) {
            if ((evalNow - (v.exitAtMs || v.lastEventMs || 0)) > EXIT_RETENTION_MS) {
                recentExitsMap.delete(k);
            }
        }

        const recentExits = Array.from(recentExitsMap.values());
        const combinedRaw = [...optionTips, ...commodityTips, ...brokerTips, ...nseAllTips, ...recentExits];
        const allTips = combinedRaw.map(finalizeTip);

        // Sort strictly newest-first (most recently issued tip or latest Exit alert at top)
        allTips.sort((a, b) => {
            const diff = (b.lastEventMs || 0) - (a.lastEventMs || 0);
            if (diff !== 0) return diff;
            if (Boolean(b.exitFlag) !== Boolean(a.exitFlag)) return b.exitFlag ? 1 : -1;
            return (SEG_PRIORITY[b.segment] || 0) - (SEG_PRIORITY[a.segment] || 0);
        });

        const exitTipsAll = allTips.filter(t => Boolean(t.exitFlag));

        // Server-side filter so even 3,200+ NSE scripts load & search at 500ms with tiny payload
        const filtered = allTips.filter(t => {
            if (segFilter === 'EXIT') {
                if (!t.exitFlag) return false;
            } else if (segFilter !== 'all') {
                if (segFilter === 'EQUITY') {
                    if (t.brokerId === 'live-option-chain' || t.brokerId === 'live-commodity' || t.brokerId === 'nse-all-live') {
                        return false;
                    }
                } else if (t.segment !== segFilter) {
                    return false;
                }
            }
            if (brokerFilter !== 'all' && t.brokerId !== brokerFilter) return false;
            if (searchQuery) {
                const hay = `${t.scriptName || ''} ${t.broker || ''} ${t.segment || ''} ${t.action || ''} ${t.exitMessage || ''}`.toLowerCase();
                if (!hay.includes(searchQuery)) return false;
            }
            return true;
        });

        const limitedTips = filtered.slice(0, reqLimit);
        const brokerStats = BROKER_DIRECTORY.map(b => ({
            id: b.id,
            name: b.name,
            shortName: b.shortName,
            sebiReg: b.sebiReg,
            researchUrl: b.researchUrl,
            count: brokerTips.filter(t => t.brokerId === b.id).length
        }));

        return res.status(200).json({
            updatedAt: new Date().toISOString(),
            totalTips: allTips.length,
            optionTipsCount: optionTips.length,
            commodityTipsCount: commodityTips.length,
            brokerTipsCount: brokerTips.length,
            nseAllCount: nseAllTips.length,
            exitCount: exitTipsAll.length,
            latestExits: exitTipsAll.slice(0, 4),
            matchedCount: filtered.length,
            hasMore: filtered.length > limitedTips.length,
            brokers: brokerStats,
            tips: limitedTips
        });
    } catch (err) {
        console.warn('[API /option-tips] Error:', err.message);
        return res.status(502).json({ error: err.message || 'Option tips unavailable' });
    }
}
