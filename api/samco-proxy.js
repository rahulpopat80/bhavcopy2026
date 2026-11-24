// Vercel Serverless Function / Express route: /api/samco-proxy.js
// Server-side reverse proxy strictly allowlisted to *.samco.in and *.samco.app
// Allows computers where web.samco.in is network-blocked to load SAMCO Web through the app backend.

const DEFAULT_SAMCO_URL = 'https://web.samco.in/';
const UPSTREAM_TIMEOUT_MS = 12000;

function isAllowedSamcoHost(hostname) {
    const h = String(hostname || '').toLowerCase().trim().replace(/\.$/, '');
    if (!h) return false;
    // Block IP literals, localhost, internal hostnames
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':') || h === 'localhost') return false;
    return h === 'samco.in' || h.endsWith('.samco.in') || h === 'samco.app' || h.endsWith('.samco.app');
}

function validateTargetUrl(rawUrl) {
    const input = String(rawUrl || DEFAULT_SAMCO_URL).trim() || DEFAULT_SAMCO_URL;
    let parsed;
    try {
        parsed = new URL(input);
    } catch {
        return null;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return null;
    }
    if (parsed.username || parsed.password) {
        return null;
    }
    if (!isAllowedSamcoHost(parsed.hostname)) {
        return null;
    }
    return parsed;
}

function toProxyHref(absUrl) {
    return `/api/samco-proxy?url=${encodeURIComponent(absUrl)}`;
}

function resolveAndProxyUrl(candidate, baseUrlObj) {
    if (!candidate) return candidate;
    const trimmed = String(candidate).trim();
    if (
        !trimmed ||
        trimmed.startsWith('#') ||
        trimmed.startsWith('data:') ||
        trimmed.startsWith('blob:') ||
        trimmed.startsWith('javascript:') ||
        trimmed.startsWith('/api/samco-proxy')
    ) {
        return candidate;
    }
    try {
        const resolved = new URL(trimmed, baseUrlObj.href);
        if ((resolved.protocol === 'https:' || resolved.protocol === 'http:') && isAllowedSamcoHost(resolved.hostname)) {
            return toProxyHref(resolved.href);
        }
    } catch {
        return candidate;
    }
    return candidate;
}

function rewriteHtmlForProxy(html, baseUrlObj) {
    const proxyOrigin = `${baseUrlObj.protocol}//${baseUrlObj.host}`;
    const bootstrapScript = `<script>(function(){
  var BASE_ORIGIN=${JSON.stringify(proxyOrigin)};
  var BASE_HREF=${JSON.stringify(baseUrlObj.href)};
  function isAllowedHost(h){h=String(h||'').toLowerCase();return h==='samco.in'||h.endsWith('.samco.in')||h==='samco.app'||h.endsWith('.samco.app');}
  function toProxy(u){
    if(u==null)return u;
    var s=String(u);
    if(!s||s.startsWith('#')||s.startsWith('data:')||s.startsWith('blob:')||s.startsWith('javascript:')||s.indexOf('/api/samco-proxy')===0)return s;
    try{
      var resolved=new URL(s, s.startsWith('/') ? BASE_ORIGIN : BASE_HREF);
      if((resolved.protocol==='https:'||resolved.protocol==='http:')&&isAllowedHost(resolved.hostname)){
        return '/api/samco-proxy?url='+encodeURIComponent(resolved.href);
      }
    }catch(e){}
    return s;
  }
  var origFetch=window.fetch;
  if(origFetch){
    window.fetch=function(input,init){
      try{
        if(typeof input==='string'){input=toProxy(input);}
        else if(input&&typeof input.url==='string'){
          var nu=toProxy(input.url);
          if(nu!==input.url){input=new Request(nu,input);}
        }
      }catch(e){}
      return origFetch.call(this,input,init);
    };
  }
  var origXhrOpen=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(method,url){
    var args=Array.prototype.slice.call(arguments);
    try{if(typeof url==='string'){args[1]=toProxy(url);}}catch(e){}
    return origXhrOpen.apply(this,args);
  };
  var origSetAttr=Element.prototype.setAttribute;
  Element.prototype.setAttribute=function(name,val){
    if((name==='src'||name==='href'||name==='action')&&typeof val==='string'){
      val=toProxy(val);
    }
    return origSetAttr.call(this,name,val);
  };
  [HTMLScriptElement,HTMLLinkElement,HTMLImageElement,HTMLIFrameElement].forEach(function(Ctor){
    if(!Ctor||!Ctor.prototype)return;
    var prop=Ctor===HTMLLinkElement?'href':'src';
    var desc=Object.getOwnPropertyDescriptor(Ctor.prototype,prop);
    if(desc&&desc.set&&desc.get){
      Object.defineProperty(Ctor.prototype,prop,{
        configurable:true,
        enumerable:desc.enumerable,
        get:function(){return desc.get.call(this);},
        set:function(v){return desc.set.call(this,toProxy(v));}
      });
    }
  });
})();</script>`;

    let out = html.replace(
        /(src|href|action)=["']([^"']+)["']/gi,
        (full, attr, val) => `${attr}="${resolveAndProxyUrl(val, baseUrlObj)}"`
    );

    if (/<head[^>]*>/i.test(out)) {
        out = out.replace(/<head([^>]*)>/i, `<head$1>${bootstrapScript}`);
    } else {
        out = bootstrapScript + out;
    }
    return out;
}

function rewriteCssForProxy(css, baseUrlObj) {
    return css.replace(/url\((['"]?)([^'")]+)\1\)/gi, (full, q, val) => {
        const next = resolveAndProxyUrl(val, baseUrlObj);
        return `url(${q}${next}${q})`;
    });
}

async function readRequestBodyBuffer(req) {
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return undefined;
    if (Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
        return Buffer.from(JSON.stringify(req.body), 'utf8');
    }
    if (req.readableEnded) return undefined;
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

export default async function handler(req, res) {
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
        return res.status(204).end();
    }

    const rawUrl = req.query?.url ? String(req.query.url) : DEFAULT_SAMCO_URL;
    let currentUrl = validateTargetUrl(rawUrl);
    if (!currentUrl) {
        return res.status(403).json({
            error: 'Only *.samco.in and *.samco.app URLs are permitted via /api/samco-proxy'
        });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    try {
        const forwardHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Origin': 'https://web.samco.in',
            'Referer': 'https://web.samco.in/'
        };

        for (const [k, v] of Object.entries(req.headers || {})) {
            const lk = k.toLowerCase();
            if (
                lk === 'accept' ||
                lk === 'accept-language' ||
                lk === 'content-type' ||
                lk === 'authorization' ||
                lk === 'x-requested-with' ||
                lk === 'cookie' ||
                lk.startsWith('x-samco') ||
                lk.startsWith('x-api')
            ) {
                if (typeof v === 'string') forwardHeaders[k] = v;
            }
        }

        const bodyBuf = await readRequestBodyBuffer(req);

        // Manually follow up to 4 redirects, enforcing the Samco host allowlist on every hop
        let upstreamRes = null;
        for (let hop = 0; hop < 4; hop++) {
            upstreamRes = await fetch(currentUrl.href, {
                method: req.method || 'GET',
                headers: forwardHeaders,
                body: bodyBuf,
                redirect: 'manual',
                signal: controller.signal
            });

            if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
                const loc = upstreamRes.headers.get('location');
                if (!loc) break;
                let nextUrl;
                try {
                    nextUrl = new URL(loc, currentUrl.href);
                } catch {
                    return res.status(403).json({ error: 'Invalid redirect URL' });
                }
                const validated = validateTargetUrl(nextUrl.href);
                if (!validated) {
                    return res.status(403).json({ error: 'Blocked redirect outside Samco domain' });
                }
                currentUrl = validated;
                continue;
            }
            break;
        }

        if (!upstreamRes) {
            return res.status(502).json({ error: 'No response from SAMCO upstream' });
        }

        const contentType = String(upstreamRes.headers.get('content-type') || 'application/octet-stream');
        res.status(upstreamRes.status);
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Proxy-Host', currentUrl.hostname);

        if (contentType.toLowerCase().includes('text/html')) {
            const html = await upstreamRes.text();
            const rewritten = rewriteHtmlForProxy(html, currentUrl);
            return res.send(rewritten);
        }

        if (contentType.toLowerCase().includes('text/css')) {
            const css = await upstreamRes.text();
            return res.send(rewriteCssForProxy(css, currentUrl));
        }

        const arrBuf = await upstreamRes.arrayBuffer();
        return res.send(Buffer.from(arrBuf));
    } catch (err) {
        const msg = err?.name === 'AbortError' ? 'SAMCO proxy timeout' : (err?.message || 'SAMCO proxy failed');
        if (!res.headersSent) {
            return res.status(502).json({ error: msg });
        }
    } finally {
        clearTimeout(timer);
    }
}
