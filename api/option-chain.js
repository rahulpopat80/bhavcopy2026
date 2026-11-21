// Vercel Serverless Function: /api/option-chain.js
// Fetches live Index Option Chain + Spot Price (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX)
// Computes 5-level ITM and OTM volumes separately for Calls (CE) and Puts (PE) around the current ATM strike.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const GROWW_SLUGS = {
    NIFTY: 'nifty',
    BANKNIFTY: 'nifty-bank',
    FINNIFTY: 'nifty-financial-services',
    MIDCPNIFTY: 'nifty-midcap-select'
};

// Short-lived per-symbol/expiry micro-cache (800ms) for 1-second UI polling
const chainCache = new Map();

async function fetchWithTimeout(url, options = {}, timeoutMs = 4500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

function toNum(val) {
    if (val === null || val === undefined || val === '') return 0;
    const n = parseFloat(String(val).replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
}

function buildOptionSummaryAndWindow(sortedRows, spotPrice) {
    if (!sortedRows || sortedRows.length === 0) {
        throw new Error('Empty option chain rows');
    }

    // Determine ATM strike: nearest strike to live spotPrice (fallback: strike where |CE LTP - PE LTP| is minimal)
    let atmIdx = 0;
    if (Number.isFinite(spotPrice) && spotPrice > 0) {
        let bestDiff = Infinity;
        for (let i = 0; i < sortedRows.length; i++) {
            const diff = Math.abs(sortedRows[i].strike - spotPrice);
            if (diff < bestDiff) {
                bestDiff = diff;
                atmIdx = i;
            }
        }
    } else {
        let bestDiff = Infinity;
        for (let i = 0; i < sortedRows.length; i++) {
            const row = sortedRows[i];
            if (row.ceLtp > 0 && row.peLtp > 0) {
                const diff = Math.abs(row.ceLtp - row.peLtp);
                if (diff < bestDiff) {
                    bestDiff = diff;
                    atmIdx = i;
                }
            }
        }
    }

    const atmRow = sortedRows[atmIdx];
    const belowAtm = sortedRows.slice(Math.max(0, atmIdx - 5), atmIdx); // 5 strikes < ATM: Call ITM, Put OTM
    const aboveAtm = sortedRows.slice(atmIdx + 1, atmIdx + 6);          // 5 strikes > ATM: Call OTM, Put ITM

    const callItm5Vol = belowAtm.reduce((sum, r) => sum + r.ceVolume, 0);
    const callOtm5Vol = aboveAtm.reduce((sum, r) => sum + r.ceVolume, 0);
    const putItm5Vol = aboveAtm.reduce((sum, r) => sum + r.peVolume, 0);
    const putOtm5Vol = belowAtm.reduce((sum, r) => sum + r.peVolume, 0);

    const callItm5Oi = belowAtm.reduce((sum, r) => sum + r.ceOi, 0);
    const callOtm5Oi = aboveAtm.reduce((sum, r) => sum + r.ceOi, 0);
    const putItm5Oi = aboveAtm.reduce((sum, r) => sum + r.peOi, 0);
    const putOtm5Oi = belowAtm.reduce((sum, r) => sum + r.peOi, 0);

    const windowRows = [
        ...belowAtm.map((r, i) => ({
            ...r,
            levelLabel: `-${belowAtm.length - i}`,
            callMoneyness: 'ITM',
            putMoneyness: 'OTM',
            isAtm: false
        })),
        {
            ...atmRow,
            levelLabel: 'ATM',
            callMoneyness: 'ATM',
            putMoneyness: 'ATM',
            isAtm: true
        },
        ...aboveAtm.map((r, i) => ({
            ...r,
            levelLabel: `+${i + 1}`,
            callMoneyness: 'OTM',
            putMoneyness: 'ITM',
            isAtm: false
        }))
    ];

    const callWindowTotalVol = callItm5Vol + atmRow.ceVolume + callOtm5Vol;
    const putWindowTotalVol = putOtm5Vol + atmRow.peVolume + putItm5Vol;

    return {
        atmStrike: atmRow.strike,
        summary: {
            callItm5Vol,
            callOtm5Vol,
            callAtmVol: atmRow.ceVolume,
            putItm5Vol,
            putOtm5Vol,
            putAtmVol: atmRow.peVolume,
            totalItm5Vol: callItm5Vol + putItm5Vol,
            totalOtm5Vol: callOtm5Vol + putOtm5Vol,
            callItm5Oi,
            callOtm5Oi,
            putItm5Oi,
            putOtm5Oi,
            callWindowTotalVol,
            putWindowTotalVol,
            itmRange: belowAtm.length ? `${belowAtm[0].strike} – ${belowAtm[belowAtm.length - 1].strike}` : '-',
            otmRange: aboveAtm.length ? `${aboveAtm[0].strike} – ${aboveAtm[aboveAtm.length - 1].strike}` : '-',
            belowCount: belowAtm.length,
            aboveCount: aboveAtm.length
        },
        rows: windowRows
    };
}

async function fetchGrowwOptionChain(symbol, requestedExpiry) {
    const slug = GROWW_SLUGS[symbol];
    const expiryQuery = requestedExpiry ? `?expiry=${encodeURIComponent(requestedExpiry)}` : '';
    const ocUrl = `https://groww.in/v1/api/option_chain_service/v1/option_chain/${slug}${expiryQuery}`;
    const spotUrl = `https://groww.in/v1/api/stocks_data/v1/tr_live_indices/exchange/NSE/segment/CASH/${symbol}/latest`;

    const headers = { 'User-Agent': UA, 'Accept': 'application/json' };
    const [ocRes, spotRes] = await Promise.allSettled([
        fetchWithTimeout(ocUrl, { headers }),
        fetchWithTimeout(spotUrl, { headers })
    ]);

    if (ocRes.status !== 'fulfilled' || !ocRes.value.ok) {
        throw new Error(`Option chain fetch failed for ${symbol}`);
    }

    const ocJson = await ocRes.value.json();
    const optionChain = ocJson?.optionChain;
    const rawList = optionChain?.optionChains || [];
    if (rawList.length === 0) {
        throw new Error(`No option chain strikes returned for ${symbol}`);
    }

    let spotPrice = null;
    let spotChange = null;
    let spotChangePct = null;
    if (spotRes.status === 'fulfilled' && spotRes.value.ok) {
        const spotJson = await spotRes.value.json();
        spotPrice = toNum(spotJson.value ?? spotJson.indexIndicativePrice ?? spotJson.close);
        spotChange = spotJson.dayChange !== undefined ? Number(spotJson.dayChange) : null;
        spotChangePct = spotJson.dayChangePerc !== undefined ? Number(spotJson.dayChangePerc) : null;
    }

    const strikeMap = new Map();
    for (const item of rawList) {
        const strike = Number((toNum(item.strikePrice) / 100).toFixed(2));
        if (!strike) continue;
        const ce = item.callOption || {};
        const pe = item.putOption || {};
        strikeMap.set(strike, {
            strike,
            ceVolume: toNum(ce.volume),
            ceOi: toNum(ce.openInterest),
            ceLtp: toNum(ce.ltp),
            ceChange: toNum(ce.dayChange),
            peVolume: toNum(pe.volume),
            peOi: toNum(pe.openInterest),
            peLtp: toNum(pe.ltp),
            peChange: toNum(pe.dayChange)
        });
    }

    const sortedRows = Array.from(strikeMap.values()).sort((a, b) => a.strike - b.strike);
    const { atmStrike, summary, rows } = buildOptionSummaryAndWindow(sortedRows, spotPrice);

    const expiries = optionChain?.expiryDetailsDto?.expiryDates || [];
    const activeExpiry = optionChain?.expiryDetailsDto?.currentExpiry || requestedExpiry || expiries[0] || '-';

    return {
        symbol,
        source: 'NSE Option Chain Feed',
        spotPrice: spotPrice || atmStrike,
        spotChange,
        spotChangePct,
        atmStrike,
        expiry: activeExpiry,
        expiries,
        summary,
        rows,
        updatedAt: new Date().toISOString()
    };
}

async function fetchBseSensexOptionChain(requestedExpiry) {
    const bseUrl = 'https://api.bseindia.com/BseIndiaAPI/api/DerivOptionChain_New/w?Expiry=&scrip_cd=1&strprice=0';
    const res = await fetchWithTimeout(bseUrl, {
        headers: {
            'User-Agent': UA,
            'Accept': 'application/json',
            'Referer': 'https://www.bseindia.com/',
            'Origin': 'https://www.bseindia.com'
        }
    });
    if (!res.ok) {
        throw new Error(`BSE Option Chain returned HTTP ${res.status}`);
    }

    const json = await res.json();
    const table = Array.isArray(json?.Table) ? json.Table : [];
    if (table.length === 0) {
        throw new Error('BSE Option Chain returned empty table');
    }

    const uniqueExpiries = Array.from(new Set(table.map(r => String(r.End_TimeStamp || '').trim()).filter(Boolean)));
    uniqueExpiries.sort((a, b) => Date.parse(a) - Date.parse(b));

    const activeExpiry = requestedExpiry && uniqueExpiries.includes(requestedExpiry)
        ? requestedExpiry
        : uniqueExpiries[0];

    const filtered = table.filter(r => String(r.End_TimeStamp || '').trim() === activeExpiry);
    let spotPrice = null;

    const strikeMap = new Map();
    for (const r of filtered) {
        const strike = toNum(r.Strike_Price1 || r.Strike_Price);
        if (!strike) continue;
        if (!spotPrice) {
            const ula = toNum(r.UlaValue);
            if (ula > 0) spotPrice = ula;
        }
        strikeMap.set(strike, {
            strike,
            ceVolume: toNum(r.C_Vol_Traded),
            ceOi: toNum(r.C_Open_Interest),
            ceLtp: toNum(r.C_Last_Trd_Price),
            ceChange: toNum(r.C_NetChange),
            peVolume: toNum(r.Vol_Traded),
            peOi: toNum(r.Open_Interest),
            peLtp: toNum(r.Last_Trd_Price),
            peChange: toNum(r.NetChange)
        });
    }

    const sortedRows = Array.from(strikeMap.values()).sort((a, b) => a.strike - b.strike);
    const { atmStrike, summary, rows } = buildOptionSummaryAndWindow(sortedRows, spotPrice);

    return {
        symbol: 'SENSEX',
        source: 'BSE Live Option Chain',
        spotPrice: spotPrice || atmStrike,
        spotChange: null,
        spotChangePct: null,
        atmStrike,
        expiry: activeExpiry || '-',
        expiries: uniqueExpiries,
        summary,
        rows,
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

    const rawSymbol = String(req.query?.symbol || 'NIFTY').trim().toUpperCase();
    const symbol = (rawSymbol === 'SENSEX' || GROWW_SLUGS[rawSymbol]) ? rawSymbol : 'NIFTY';
    const expiry = req.query?.expiry ? String(req.query.expiry).trim() : '';
    const cacheKey = `${symbol}:${expiry}`;

    const cached = chainCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < 800) {
        return res.status(200).json(cached.data);
    }

    try {
        const data = symbol === 'SENSEX'
            ? await fetchBseSensexOptionChain(expiry)
            : await fetchGrowwOptionChain(symbol, expiry);

        chainCache.set(cacheKey, { data, ts: Date.now() });
        return res.status(200).json(data);
    } catch (err) {
        console.warn(`[API /option-chain] Error for ${symbol}:`, err.message);
        if (cached) {
            return res.status(200).json({ ...cached.data, stale: true });
        }
        return res.status(502).json({ error: err.message || 'Option chain unavailable' });
    }
}
