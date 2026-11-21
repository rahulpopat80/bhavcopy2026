// Vercel Serverless Function: /api/indices.js
// Fetches Nifty 50 and Sensex directly from the official NSE and BSE endpoints with sequential error handling

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const result = {
        sensex: null,
        nifty: null,
        sources: {}
    };

    // FIX: Enforce 6s AbortController timeout on upstream BSE/NSE fetches
    const fetchWithTimeout = async (url, options = {}, timeoutMs = 6000) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, { ...options, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    };

    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

    // 1. Fetch BSE SENSEX (Primary: Groww live BSE feed; Fallback: Official BSE API & Moneycontrol)
    try {
        const growwSensex = await fetchWithTimeout('https://groww.in/v1/api/stocks_data/v1/tr_live_indices/exchange/BSE/segment/CASH/1/latest', {
            headers: { 'User-Agent': UA, 'Accept': 'application/json' }
        }, 3500);
        if (growwSensex.ok) {
            const gData = await growwSensex.json();
            const price = parseFloat(gData?.value ?? gData?.indexIndicativePrice);
            if (!isNaN(price) && price > 0) {
                result.sensex = {
                    price,
                    change: isNaN(parseFloat(gData.dayChange)) ? 0 : parseFloat(gData.dayChange),
                    changePercent: isNaN(parseFloat(gData.dayChangePerc)) ? 0 : parseFloat(gData.dayChangePerc)
                };
                result.sources.sensex = 'BSE Live';
            }
        }
    } catch (e) {
        console.warn('Groww SENSEX failed:', e.message);
    }

    if (!result.sensex) {
        try {
            const bseRes = await fetchWithTimeout('https://api.bseindia.com/RealTimeBseIndiaAPI/api/GetSensexData/w', {
                headers: {
                    'User-Agent': UA,
                    'Accept': 'application/json',
                    'Referer': 'https://www.bseindia.com/',
                    'Origin': 'https://www.bseindia.com'
                }
            }, 3500);
            if (bseRes.ok) {
                const bseData = await bseRes.json();
                if (Array.isArray(bseData) && bseData[0]) {
                    const item = bseData[0];
                    const ltp = parseFloat(String(item.ltp).replace(/,/g, ''));
                    const chg = parseFloat(String(item.chg).replace(/,/g, ''));
                    const perchg = parseFloat(String(item.perchg).replace(/,/g, ''));
                    if (!isNaN(ltp)) {
                        result.sensex = {
                            price: ltp,
                            change: isNaN(chg) ? 0 : chg,
                            changePercent: isNaN(perchg) ? 0 : perchg
                        };
                        result.sources.sensex = 'BSE';
                    }
                }
            }
        } catch (e) {
            console.warn('Failed to fetch SENSEX from official BSE API:', e.message);
        }
    }

    // 2. Fetch NSE Nifty 50 (Primary: Groww NSE live feed; Fallback: Official NSE allIndices)
    try {
        const growwNifty = await fetchWithTimeout('https://groww.in/v1/api/stocks_data/v1/tr_live_indices/exchange/NSE/segment/CASH/NIFTY/latest', {
            headers: { 'User-Agent': UA, 'Accept': 'application/json' }
        }, 3500);
        if (growwNifty.ok) {
            const gData = await growwNifty.json();
            const price = parseFloat(gData?.value ?? gData?.indexIndicativePrice);
            if (!isNaN(price) && price > 0) {
                result.nifty = {
                    price,
                    change: isNaN(parseFloat(gData.dayChange)) ? 0 : parseFloat(gData.dayChange),
                    changePercent: isNaN(parseFloat(gData.dayChangePerc)) ? 0 : parseFloat(gData.dayChangePerc)
                };
                result.sources.nifty = 'NSE Live';
            }
        }
    } catch (e) {
        console.warn('Groww NIFTY failed:', e.message);
    }

    if (!result.nifty) {
        try {
            const nseRes = await fetchWithTimeout('https://www.nseindia.com/api/allIndices', {
                headers: {
                    'User-Agent': UA,
                    'Accept': 'application/json',
                    'Referer': 'https://www.nseindia.com/market-data/live-market-indices'
                }
            }, 3500);
            if (nseRes.ok) {
                const nseData = await nseRes.json();
                if (nseData && Array.isArray(nseData.data)) {
                    const niftyItem = nseData.data.find(idx => idx.index === 'NIFTY 50');
                    if (niftyItem) {
                        const price = parseFloat(niftyItem.last);
                        const change = parseFloat(niftyItem.variation);
                        const percent = parseFloat(niftyItem.percentChange);
                        if (!isNaN(price)) {
                            result.nifty = {
                                price,
                                change: isNaN(change) ? 0 : change,
                                changePercent: isNaN(percent) ? 0 : percent
                            };
                            result.sources.nifty = 'NSE';
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('Failed to fetch NIFTY 50 from official NSE API:', e.message);
        }
    }

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json(result);
}
