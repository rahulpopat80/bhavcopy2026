import http from 'http';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';

import ibjaHandler from './api/ibja.js';
import indicesHandler from './api/indices.js';
import yahooHandler from './api/yahoo.js';
import corporateHandler from './api/corporate.js';
import mmiHandler from './api/mmi.js';
import optionChainHandler from './api/option-chain.js';
import liveMarketHandler from './api/live-market.js';
import samcoProxyHandler, { validateTargetUrl as validateSamcoUrl } from './api/samco-proxy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Mount /api/samco-proxy BEFORE express.json() so encrypted JSON string literals
// (e.g. "U2FsdGVk...") from web.samco.in GraphQL calls pass through untouched.
app.all('/api/samco-proxy', async (req, res) => {
  try {
    await samcoProxyHandler(req, res);
  } catch (err) {
    console.error('Error in /api/samco-proxy:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

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

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  let reqUrl;
  try {
    reqUrl = new URL(req.url || '/', 'http://localhost');
  } catch {
    socket.destroy();
    return;
  }

  if (reqUrl.pathname !== '/api/samco-ws') {
    socket.destroy();
    return;
  }

  const targetUrl = validateSamcoUrl(reqUrl.searchParams.get('url'), true);
  if (!targetUrl) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  const subProtocols = req.headers['sec-websocket-protocol']
    ? String(req.headers['sec-websocket-protocol']).split(',').map(p => p.trim()).filter(Boolean)
    : undefined;

  wss.handleUpgrade(req, socket, head, (clientWs) => {
    const upstreamWs = new WebSocket(targetUrl.href, subProtocols, {
      headers: {
        Origin: 'https://web.samco.in',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    });

    const pendingMessages = [];

    upstreamWs.on('open', () => {
      while (pendingMessages.length > 0) {
        const msg = pendingMessages.shift();
        if (upstreamWs.readyState === WebSocket.OPEN) {
          upstreamWs.send(msg.data, { binary: msg.isBinary });
        }
      }
    });

    upstreamWs.on('message', (data, isBinary) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data, { binary: isBinary });
      }
    });

    clientWs.on('message', (data, isBinary) => {
      if (upstreamWs.readyState === WebSocket.OPEN) {
        upstreamWs.send(data, { binary: isBinary });
      } else if (upstreamWs.readyState === WebSocket.CONNECTING) {
        pendingMessages.push({ data, isBinary });
      }
    });

    const closeBoth = () => {
      try { if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) clientWs.close(); } catch (_) {}
      try { if (upstreamWs.readyState === WebSocket.OPEN || upstreamWs.readyState === WebSocket.CONNECTING) upstreamWs.close(); } catch (_) {}
    };

    upstreamWs.on('close', closeBoth);
    upstreamWs.on('error', closeBoth);
    clientWs.on('close', closeBoth);
    clientWs.on('error', closeBoth);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Rahul Finance server listening on http://0.0.0.0:${PORT}`);
});
