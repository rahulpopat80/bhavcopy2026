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

    // 1. Fetch BSE SENSEX from official BSE API
    try {
        const bseRes = await fetch('https://api.bseindia.com/RealTimeBseIndiaAPI/api/GetSensexData/w', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'application/json',
                'Referer': 'https://www.bseindia.com/',
                'Origin': 'https://www.bseindia.com'
            }
        });
        if (bseRes.ok) {
            const bseData = await bseRes.json();
            // Expected shape: [{"indxnm":"SenSexValue","ltp":"78,082.96","chg":"+580.84","perchg":"+0.75",...}]
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

    // 2. Fetch NSE Nifty 50 from official NSE API
    try {
        const nseRes = await fetch('https://www.nseindia.com/api/allIndices', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'application/json',
                'Referer': 'https://www.nseindia.com/market-data/live-market-indices'
            }
        });
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
                            price: price,
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

    // If either official call failed, we return what we got (the frontend will query Yahoo as fallback)
    return res.status(200).json(result);
}
