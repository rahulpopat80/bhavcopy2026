// Vercel Serverless Function: /api/yahoo.js
// Acts as a server-side proxy for Yahoo Finance API calls
// No CORS issues since this runs on the server

export default async function handler(req, res) {
    // Allow CORS from any origin (our own frontend)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const { symbol } = req.query;

    if (!symbol) {
        return res.status(400).json({ error: 'Missing symbol parameter' });
    }

    const uppercaseSymbol = symbol.toUpperCase().trim();
    // Only append .NS if the symbol is a plain stock code (e.g., "TCS", "RELIANCE")
    // Do NOT append if it already has a suffix/special characters (.NS, .BO, =, ^, etc.)
    const needsSuffix = !uppercaseSymbol.includes('.') && 
                        !uppercaseSymbol.includes('=') && 
                        !uppercaseSymbol.includes('^');
    
    const nsSymbol = needsSuffix ? `${uppercaseSymbol}.NS` : uppercaseSymbol;
    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(nsSymbol)}?range=1y&interval=1d`;

    try {
        const response = await fetch(yahooUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'application/json',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://finance.yahoo.com/',
                'Origin': 'https://finance.yahoo.com',
            },
        });

        if (!response.ok) {
            // Try query2 as fallback
            const fallbackUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(nsSymbol)}?range=1y&interval=1d`;
            const fallbackRes = await fetch(fallbackUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Accept': 'application/json',
                    'Referer': 'https://finance.yahoo.com/',
                },
            });
            if (!fallbackRes.ok) {
                return res.status(fallbackRes.status).json({ error: `Yahoo Finance returned HTTP ${fallbackRes.status}` });
            }
            const fallbackData = await fallbackRes.json();
            return res.status(200).json(fallbackData);
        }

        const data = await response.json();
        return res.status(200).json(data);

    } catch (error) {
        console.error('Yahoo Finance proxy error:', error);
        return res.status(500).json({ error: 'Failed to fetch from Yahoo Finance', details: error.message });
    }
}
