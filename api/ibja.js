// Vercel Serverless Function: /api/ibja.js
// Scrapes the daily Gold 999 and Silver 999 rates from ibjarates.com (official IBJA rates source)
// Returns JSON with live rates, previous rates, and AM/PM breakdown

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        const response = await fetch('https://ibjarates.com/', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html',
                'Cache-Control': 'no-cache'
            }
        });

        if (!response.ok) {
            return res.status(response.status).json({ error: `IBJA rates returned HTTP ${response.status}` });
        }

        const html = await response.text();

        // Extract Gold 999 AM & PM (Today's live rates)
        const goldAMMatch = html.match(/id="lblGold999_AM"\s*>\s*([\d]+)\s*<\/span>/i);
        const goldPMMatch = html.match(/id="lblGold999_PM"\s*>\s*([\d]+)\s*<\/span>/i);

        // Extract Silver 999 AM & PM (Today's live rates)
        const silverAMMatch = html.match(/id="lblSilver999_AM"\s*>\s*([\d]+)\s*<\/span>/i);
        const silverPMMatch = html.match(/id="lblSilver999_PM"\s*>\s*([\d]+)\s*<\/span>/i);

        const goldAM = goldAMMatch && goldAMMatch[1] ? parseFloat(goldAMMatch[1].trim()) : null;
        const goldPM = goldPMMatch && goldPMMatch[1] ? parseFloat(goldPMMatch[1].trim()) : null;
        const silverAM = silverAMMatch && silverAMMatch[1] ? parseFloat(silverAMMatch[1].trim()) : null;
        const silverPM = silverPMMatch && silverPMMatch[1] ? parseFloat(silverPMMatch[1].trim()) : null;

        // Use PM rate if available, otherwise fallback to AM rate
        let gold = goldPM || goldAM;
        let silver = silverPM || silverAM;

        // Extract previous date rates for daily change baseline
        const prevGoldMatch = html.match(/data-label="Gold 999"\s*>\s*([\d]+)\s*<\/td>/i);
        const prevSilverMatch = html.match(/data-label="Silver 999"\s*>\s*([\d]+)\s*<\/td>/i);
        
        const prevGold = prevGoldMatch ? parseFloat(prevGoldMatch[1].trim()) : null;
        const prevSilver = prevSilverMatch ? parseFloat(prevSilverMatch[1].trim()) : null;

        // If today's rates are not posted yet (e.g. early morning), parse the previous dates table AM/PM
        if (!gold && prevGold) gold = prevGold;
        if (!silver && prevSilver) silver = prevSilver;

        return res.status(200).json({
            gold: gold,
            silver: silver,
            prevGold: prevGold,
            prevSilver: prevSilver,
            source: 'IBJA',
            details: {
                goldAM,
                goldPM,
                silverAM,
                silverPM
            }
        });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to fetch from IBJA', details: error.message });
    }
}
