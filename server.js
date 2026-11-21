import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

import ibjaHandler from './api/ibja.js';
import indicesHandler from './api/indices.js';
import yahooHandler from './api/yahoo.js';
import corporateHandler from './api/corporate.js';
import mmiHandler from './api/mmi.js';
import optionChainHandler from './api/option-chain.js';
import liveMarketHandler from './api/live-market.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

// Mount Vercel-style API routes
app.all('/api/ibja', async (req, res) => {
  try {
    await ibjaHandler(req, res);
  } catch (err) {
    console.error('Error in /api/ibja:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

app.all('/api/indices', async (req, res) => {
  try {
    await indicesHandler(req, res);
  } catch (err) {
    console.error('Error in /api/indices:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

app.all('/api/yahoo', async (req, res) => {
  try {
    await yahooHandler(req, res);
  } catch (err) {
    console.error('Error in /api/yahoo:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// FIX: Mount /api/corporate endpoint for real upcoming results & dividend data
app.all('/api/corporate', async (req, res) => {
  try {
    await corporateHandler(req, res);
  } catch (err) {
    console.error('Error in /api/corporate:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

app.all('/api/mmi', async (req, res) => {
  try {
    await mmiHandler(req, res);
  } catch (err) {
    console.error('Error in /api/mmi:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

app.all('/api/option-chain', async (req, res) => {
  try {
    await optionChainHandler(req, res);
  } catch (err) {
    console.error('Error in /api/option-chain:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

app.all('/api/live-market', async (req, res) => {
  try {
    await liveMarketHandler(req, res);
  } catch (err) {
    console.error('Error in /api/live-market:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// Serve static frontend files
app.use(express.static(__dirname, {
  index: 'index.html',
}));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Rahul Finance server listening on http://0.0.0.0:${PORT}`);
});
