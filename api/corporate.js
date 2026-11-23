// Vercel Serverless Function: /api/corporate.js
// Fetches real upcoming Results Calendar, Dividends, Board Meetings, Splits & Bonus
// directly from Moneycontrol SSR feeds + resolves official NSE/BSE trading symbols,
// with NSE/BSE official APIs retained as secondary fallbacks.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// In-memory micro-cache for corporate items (3 mins) & resolved scId -> NSE/BSE symbols (12 hours)
let cachedCorpPayload = null;
let cachedCorpAt = 0;
const scIdSymbolCache = new Map();

async function fetchWithTimeout(url, options = {}, timeoutMs = 5500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

function toNum(val) {
    if (val === null || val === undefined || val === '' || val === '-') return null;
    const n = parseFloat(String(val).replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : null;
}

function formatYyyyMmDd(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}${m}${d}`;
}

function normalizeDisplayDate(raw) {
    if (!raw) return '-';
    const s = String(raw).trim();
    // Handle DD/MM/YYYY
    const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (slash) return `${slash[1].padStart(2, '0')}-${slash[2].padStart(2, '0')}-${slash[3]}`;
    // Handle ISO YYYY-MM-DD
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[3]}-${iso[2]}-${iso[1]}`;
    // Handle DD-MMM-YYYY or "23 Nov, 2026" or "23 Nov"
    const months = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
    const dmyComma = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3})[,\s-]+(\d{4})?/);
    if (dmyComma) {
        const mm = months[dmyComma[2].toUpperCase()] || '01';
        const yr = dmyComma[3] || String(new Date().getFullYear());
        return `${dmyComma[1].padStart(2, '0')}-${mm}-${yr}`;
    }
    return s;
}

async function fetchMcNextData(url) {
    const res = await fetchWithTimeout(url, {
        headers: {
            'User-Agent': UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9'
        }
    }, 5500);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const html = await res.text();
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m || !m[1]) throw new Error(`No __NEXT_DATA__ in ${url}`);
    return JSON.parse(m[1]);
}

async function resolveMoneycontrolScId(scId, exchangeHint = 'N') {
    const key = String(scId || '').trim();
    if (!key) return null;
    const cached = scIdSymbolCache.get(key);
    if (cached && (Date.now() - cached.ts) < 12 * 60 * 60 * 1000) {
        return cached.val;
    }

    const order = exchangeHint === 'B' ? ['bse', 'nse'] : ['nse', 'bse'];
    let resolved = null;
    for (const ex of order) {
        try {
            const r = await fetchWithTimeout(`https://priceapi.moneycontrol.com/pricefeed/${ex}/equitycash/${encodeURIComponent(key)}`, {
                headers: { 'User-Agent': UA, 'Accept': 'application/json' }
            }, 2500);
            if (!r.ok) continue;
            const j = await r.json();
            const d = j?.data;
            if (d && (d.NSEID || d.BSEID || d.SC_FULLNM)) {
                const sym = String(d.NSEID || d.BSEID || '').trim().toUpperCase();
                if (sym) {
                    resolved = {
                        symbol: sym,
                        companyName: String(d.SC_FULLNM || '').trim(),
                        price: toNum(d.pricecurrent)
                    };
                    break;
                }
            }
        } catch (_) {}
    }

    scIdSymbolCache.set(key, { val: resolved, ts: Date.now() });
    return resolved;
}

async function runPool(items, concurrency, fn) {
    const executing = [];
    for (const item of items) {
        const p = Promise.resolve().then(() => fn(item));
        executing.push(p);
        if (executing.length >= concurrency) {
            await Promise.race(executing).catch(() => {});
        }
        p.finally(() => {
            const idx = executing.indexOf(p);
            if (idx !== -1) executing.splice(idx, 1);
        });
    }
    await Promise.allSettled(executing);
}

async function tryFetchFromMoneycontrol() {
    const [resCalSettled, divSettled, bmSettled, splitSettled, bonusSettled] = await Promise.allSettled([
        fetchMcNextData('https://www.moneycontrol.com/markets/earnings/results-calendar/'),
        fetchMcNextData('https://www.moneycontrol.com/markets/corporate-action/dividends_declared/'),
        fetchMcNextData('https://www.moneycontrol.com/markets/corporate-action/board-meetings/'),
        fetchMcNextData('https://www.moneycontrol.com/markets/corporate-action/splits/'),
        fetchMcNextData('https://www.moneycontrol.com/markets/corporate-action/bonus/')
    ]);

    const rawItems = [];

    // 1. Upcoming Dividends
    if (divSettled.status === 'fulfilled') {
        const list = divSettled.value?.props?.pageProps?.data?.filteredList || [];
        for (const row of list) {
            const divAmt = row.dividend && row.dividend !== '-' ? `₹${row.dividend}/sh` : '';
            rawItems.push({
                scId: row.scId || row.scDid || '',
                ex: row.ex || 'N',
                fallbackSym: String(row.stockName || row.scId || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, ''),
                companyName: String(row.stockName || '').trim(),
                date: normalizeDisplayDate(row.exDate || row.announcementDate),
                type: row.eventType || 'Dividend',
                purpose: `${row.eventType || 'Dividend'}${divAmt ? ` • ${divAmt}` : ''}`,
                status: 'Ex-Date Upcoming',
                isDividend: true,
                livePrice: toNum(row.lastValue),
                changePct: toNum(row.perChange),
                priority: 1
            });
        }
    }

    // 2. Upcoming Results Calendar
    if (resCalSettled.status === 'fulfilled') {
        const list = resCalSettled.value?.props?.pageProps?.resultCalendarData?.tableData?.list || [];
        for (const row of list) {
            rawItems.push({
                scId: row.scId || '',
                ex: row.exchange || 'N',
                fallbackSym: String(row.scId || row.stockShortName || '').trim().toUpperCase(),
                companyName: String(row.stockName || row.stockShortName || '').trim(),
                date: normalizeDisplayDate(row.date),
                type: 'Financial Results',
                purpose: `${row.resultType || 'Quarterly Results'} Earnings Announcement`,
                status: 'Results Upcoming',
                isDividend: false,
                livePrice: toNum(row.ltp),
                changePct: toNum(row.change),
                priority: 1
            });
        }
    }

    // 3. Splits & Bonus
    for (const [settled, defaultType] of [[splitSettled, 'Stock Split'], [bonusSettled, 'Bonus Issue']]) {
        if (settled.status === 'fulfilled') {
            const list = settled.value?.props?.pageProps?.data?.filteredList || [];
            for (const row of list) {
                rawItems.push({
                    scId: row.scId || row.scDid || '',
                    ex: row.ex || 'N',
                    fallbackSym: String(row.scId || '').trim().toUpperCase(),
                    companyName: String(row.stockName || '').trim(),
                    date: normalizeDisplayDate(row.exDate || row.announcementDate),
                    type: row.eventType || defaultType,
                    purpose: `${row.eventType || defaultType}${row.ratio && row.ratio !== '-' ? ` (Ratio ${row.ratio})` : ''}`,
                    status: 'Ex-Date Upcoming',
                    isDividend: false,
                    livePrice: toNum(row.lastValue),
                    changePct: toNum(row.perChange),
                    priority: 2
                });
            }
        }
    }

    // 4. Board Meetings (Results, Dividends, Buybacks, etc.)
    if (bmSettled.status === 'fulfilled') {
        const list = bmSettled.value?.props?.pageProps?.data?.filteredList || [];
        for (const row of list.slice(0, 35)) {
            const remark = String(row.remark || 'Board Meeting').trim();
            const isDiv = /dividend/i.test(remark);
            const isRes = /result|financial|unaudited|audited|quarter/i.test(remark);
            rawItems.push({
                scId: row.scId || row.scDid || '',
                ex: row.ex || 'N',
                fallbackSym: String(row.scId || '').trim().toUpperCase(),
                companyName: String(row.companyName || row.stockName || '').trim(),
                date: normalizeDisplayDate(row.date),
                type: isRes ? 'Results Board Meeting' : (isDiv ? 'Dividend Meeting' : 'Board Meeting'),
                purpose: remark,
                status: 'Scheduled',
                isDividend: isDiv,
                livePrice: toNum(row.lastValue),
                changePct: toNum(row.perChange),
                priority: isRes || isDiv ? 2 : 3
            });
        }
    }

    if (rawItems.length === 0) {
        throw new Error('Moneycontrol returned zero corporate events');
    }

    // Resolve official NSE/BSE trading symbols for top 45 unique Moneycontrol scIds in parallel
    const uniqueScIds = [];
    const seenSc = new Set();
    for (const item of rawItems) {
        if (item.scId && !seenSc.has(item.scId)) {
            seenSc.add(item.scId);
            uniqueScIds.push({ scId: item.scId, ex: item.ex });
            if (uniqueScIds.length >= 45) break;
        }
    }

    await runPool(uniqueScIds, 8, async ({ scId, ex }) => {
        await resolveMoneycontrolScId(scId, ex);
    });

    // Deduplicate & build clean final list
    const seenRows = new Set();
    const items = [];
    for (const raw of rawItems) {
        const resolved = raw.scId ? scIdSymbolCache.get(raw.scId)?.val : null;
        const symbol = (resolved?.symbol || raw.fallbackSym || raw.scId || '').trim().toUpperCase();
        if (!symbol) continue;
        const companyName = resolved?.companyName || raw.companyName || symbol;
        const dedupKey = `${symbol}|${raw.date}|${raw.type}`;
        if (seenRows.has(dedupKey)) continue;
        seenRows.add(dedupKey);

        items.push({
            symbol,
            companyName,
            date: raw.date,
            type: raw.type,
            purpose: raw.purpose,
            status: raw.status,
            isDividend: raw.isDividend,
            livePrice: raw.livePrice ?? resolved?.price ?? null,
            changePct: raw.changePct ?? null
        });
    }

    return { source: 'Moneycontrol / Exchange Live', items };
}

async function tryFetchFromNSE() {
    const homeRes = await fetchWithTimeout('https://www.nseindia.com/', {
        headers: {
            'User-Agent': UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9'
        }
    }, 3500);

    if (!homeRes.ok) {
        throw new Error(`NSE home returned HTTP ${homeRes.status}`);
    }

    const setCookies = typeof homeRes.headers.getSetCookie === 'function'
        ? homeRes.headers.getSetCookie()
        : [];
    const cookieHeader = setCookies.map(c => c.split(';')[0]).join('; ');

    const commonHeaders = {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.nseindia.com/companies-listing/corporate-filings-actions',
        'Cookie': cookieHeader
    };

    const [bmRes, caRes] = await Promise.allSettled([
        fetchWithTimeout('https://www.nseindia.com/api/corporate-board-meetings?index=equities', { headers: commonHeaders }, 4000),
        fetchWithTimeout('https://www.nseindia.com/api/corporates-corporateActions?index=equities', { headers: commonHeaders }, 4000)
    ]);

    const items = [];

    if (caRes.status === 'fulfilled' && caRes.value.ok) {
        const caData = await caRes.value.json();
        if (Array.isArray(caData)) {
            for (const row of caData.slice(0, 40)) {
                const symbol = String(row.symbol || '').trim().toUpperCase();
                if (!symbol) continue;
                const subject = String(row.subject || row.purpose || 'Corporate Action').trim();
                const isDividend = /dividend/i.test(subject);
                items.push({
                    symbol,
                    companyName: String(row.comp || row.companyName || symbol).trim(),
                    date: normalizeDisplayDate(row.exDate || row.recDate || row.bcStartDate),
                    type: isDividend ? 'Dividend' : 'Corporate Action',
                    purpose: subject,
                    status: 'Upcoming',
                    isDividend
                });
            }
        }
    }

    if (bmRes.status === 'fulfilled' && bmRes.value.ok) {
        const bmData = await bmRes.value.json();
        if (Array.isArray(bmData)) {
            for (const row of bmData.slice(0, 40)) {
                const symbol = String(row.bm_symbol || row.symbol || '').trim().toUpperCase();
                if (!symbol) continue;
                const purpose = String(row.bm_purpose || row.bm_desc || 'Board Meeting').trim();
                const isDividend = /dividend/i.test(purpose);
                const isResult = /result|financial/i.test(purpose);
                items.push({
                    symbol,
                    companyName: String(row.sm_name || row.companyName || symbol).trim(),
                    date: normalizeDisplayDate(row.bm_date || row.date),
                    type: isResult ? 'Financial Results' : (isDividend ? 'Dividend Meeting' : 'Board Meeting'),
                    purpose,
                    status: 'Scheduled',
                    isDividend
                });
            }
        }
    }

    if (items.length === 0) {
        throw new Error('NSE returned no corporate records');
    }

    return { source: 'NSE', items };
}

async function tryFetchFromBSE() {
    const bseHeaders = {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.bseindia.com/',
        'Origin': 'https://www.bseindia.com'
    };

    const today = new Date();
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const prevDateStr = formatYyyyMmDd(weekAgo);
    const toDateStr = formatYyyyMmDd(today);

    const corpActionUrl = 'https://api.bseindia.com/BseIndiaAPI/api/CorpAction/w?ddlcategorys=E&ddlindustrys=&segment=0&strSearch=S&Purpose=&fromdate=&todate=';
    const boardMeetingUrl = `https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w?pageno=1&strCat=Board+Meeting&strPrevDate=${prevDateStr}&strScrip=&strSearch=P&strToDate=${toDateStr}&strType=C&subcategory=-1`;

    const [caRes, bmRes] = await Promise.allSettled([
        fetchWithTimeout(corpActionUrl, { headers: bseHeaders }, 3500),
        fetchWithTimeout(boardMeetingUrl, { headers: bseHeaders }, 3500)
    ]);

    const items = [];

    if (caRes.status === 'fulfilled' && caRes.value.ok) {
        const caData = await caRes.value.json();
        if (Array.isArray(caData)) {
            for (const row of caData.slice(0, 40)) {
                const symbol = String(row.Security || row.Code || '').trim().toUpperCase();
                if (!symbol) continue;
                const purpose = String(row.Purpose || 'Corporate Action').trim();
                const isDividend = /dividend/i.test(purpose);
                items.push({
                    symbol,
                    companyName: symbol,
                    date: normalizeDisplayDate(row.ExDate || row.BCPeriod),
                    type: isDividend ? 'Dividend' : 'Corporate Action',
                    purpose,
                    status: 'Ex-Date Upcoming',
                    isDividend
                });
            }
        }
    }

    if (bmRes.status === 'fulfilled' && bmRes.value.ok) {
        const bmData = await bmRes.value.json();
        const table = bmData && Array.isArray(bmData.Table) ? bmData.Table : [];
        for (const row of table.slice(0, 30)) {
            const newsSub = String(row.NEWSSUB || '').trim();
            const parts = newsSub.split(' - ');
            const companyName = parts[0] ? parts[0].trim() : `BSE:${row.SCRIP_CD}`;
            const symbol = row.SCRIP_CD ? String(row.SCRIP_CD).trim() : companyName.toUpperCase();
            const isResult = /result|financial|unaudited|audited/i.test(newsSub);
            const isDividend = /dividend/i.test(newsSub);
            items.push({
                symbol,
                companyName,
                date: normalizeDisplayDate(row.NEWS_DT || row.DT_TM),
                type: isResult ? 'Results / Board Meeting' : 'Board Meeting',
                purpose: newsSub || 'Board Meeting Intimation',
                status: 'Announced',
                isDividend
            });
        }
    }

    if (items.length === 0) {
        throw new Error('BSE returned no corporate records');
    }

    return { source: 'BSE', items };
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store, max-age=0');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (cachedCorpPayload && (Date.now() - cachedCorpAt) < 180000) {
        return res.status(200).json(cachedCorpPayload);
    }

    try {
        try {
            const mcResult = await tryFetchFromMoneycontrol();
            const payload = {
                ...mcResult,
                fetchedAt: new Date().toISOString()
            };
            cachedCorpPayload = payload;
            cachedCorpAt = Date.now();
            return res.status(200).json(payload);
        } catch (mcErr) {
            console.warn('[/api/corporate] Moneycontrol feed failed, trying NSE/BSE:', mcErr.message);
        }

        try {
            const nseResult = await tryFetchFromNSE();
            const payload = { ...nseResult, fetchedAt: new Date().toISOString() };
            cachedCorpPayload = payload;
            cachedCorpAt = Date.now();
            return res.status(200).json(payload);
        } catch (nseErr) {
            console.warn('[/api/corporate] NSE fallback failed, trying BSE:', nseErr.message);
        }

        const bseResult = await tryFetchFromBSE();
        const payload = { ...bseResult, fetchedAt: new Date().toISOString() };
        cachedCorpPayload = payload;
        cachedCorpAt = Date.now();
        return res.status(200).json(payload);
    } catch (error) {
        console.error('[/api/corporate] All corporate data sources failed:', error.message);
        if (cachedCorpPayload) {
            return res.status(200).json({ ...cachedCorpPayload, stale: true });
        }
        return res.status(502).json({
            error: 'Data unavailable from corporate feeds',
            details: error.message
        });
    }
}
