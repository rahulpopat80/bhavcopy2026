// Vercel Serverless Function: /api/corporate.js
// FIX: Fetches real upcoming board meetings (results) and corporate actions (dividends)
// from NSE India with session cookies, falling back to official BSE India APIs.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function fetchWithTimeout(url, options = {}, timeoutMs = 6000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
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
    // Handle DD-MMM-YYYY (e.g. 19-Nov-2026)
    const dmy = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
    if (dmy) {
        const months = { JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12' };
        const mm = months[dmy[2].toUpperCase()] || '01';
        return `${dmy[1].padStart(2, '0')}-${mm}-${dmy[3]}`;
    }
    return s;
}

async function tryFetchFromNSE() {
    const homeRes = await fetchWithTimeout('https://www.nseindia.com/', {
        headers: {
            'User-Agent': UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9'
        }
    }, 5000);

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
        fetchWithTimeout('https://www.nseindia.com/api/corporate-board-meetings?index=equities', { headers: commonHeaders }, 6000),
        fetchWithTimeout('https://www.nseindia.com/api/corporates-corporateActions?index=equities', { headers: commonHeaders }, 6000)
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
        fetchWithTimeout(corpActionUrl, { headers: bseHeaders }, 6000),
        fetchWithTimeout(boardMeetingUrl, { headers: bseHeaders }, 6000)
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

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        // Try NSE first; if NSE blocks/fails, fall back to BSE official API
        try {
            const nseResult = await tryFetchFromNSE();
            return res.status(200).json({
                ...nseResult,
                fetchedAt: new Date().toISOString()
            });
        } catch (nseErr) {
            console.warn('[/api/corporate] NSE failed, trying BSE fallback:', nseErr.message);
        }

        const bseResult = await tryFetchFromBSE();
        return res.status(200).json({
            ...bseResult,
            fetchedAt: new Date().toISOString()
        });
    } catch (error) {
        console.error('[/api/corporate] All corporate data sources failed:', error.message);
        return res.status(502).json({
            error: 'Data unavailable from NSE/BSE corporate feeds',
            details: error.message
        });
    }
}
