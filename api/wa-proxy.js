// Vercel Serverless Function / Express route: /api/wa-proxy.js
// Server-side reverse proxy strictly allowlisted to official WhatsApp & Meta CDN hosts.
// Lets networks/PCs where web.whatsapp.com is blocked load & use WhatsApp Web via the app backend.

const DEFAULT_WA_URL = 'https://web.whatsapp.com/';
const UPSTREAM_TIMEOUT_MS = 20000;
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export function isAllowedWaHost(hostname) {
    const h = String(hostname || '').toLowerCase().trim().replace(/\.$/, '');
    if (!h || !h.includes('.')) return false;
    // Block IP literals, localhost, internal hostnames
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':') || h === 'localhost') return false;
    return (
        h === 'whatsapp.com' ||
        h.endsWith('.whatsapp.com') ||
        h === 'whatsapp.net' ||
        h.endsWith('.whatsapp.net') ||
        h === 'fbcdn.net' ||
        h.endsWith('.fbcdn.net') ||
        h === 'graph.facebook.com'
    );
}

export function validateWaTargetUrl(rawUrl, allowWs = false) {
    const input = String(rawUrl || DEFAULT_WA_URL).trim() || DEFAULT_WA_URL;
    let parsed;
    try {
        parsed = new URL(input);
    } catch {
        return null;
    }
    const allowedSchemes = allowWs ? ['ws:', 'wss:'] : ['http:', 'https:'];
    if (!allowedSchemes.includes(parsed.protocol)) {
        return null;
    }
    if (parsed.username || parsed.password) {
        return null;
    }
    if (!isAllowedWaHost(parsed.hostname)) {
        return null;
    }
    return parsed;
}

function toProxyHref(absUrl) {
    return `/api/wa-proxy?url=${encodeURIComponent(absUrl)}`;
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
        trimmed.startsWith('/api/wa-proxy')
    ) {
        return candidate;
    }
    try {
        const resolved = new URL(trimmed, baseUrlObj.href);
        if ((resolved.protocol === 'https:' || resolved.protocol === 'http:') && isAllowedWaHost(resolved.hostname)) {
            return toProxyHref(resolved.href);
        }
    } catch {
        return candidate;
    }
    return candidate;
}

const WORKER_PROXY_SHIM = `(function(){
  var BASE_ORIGIN='https://web.whatsapp.com';
  function isAllowedHost(h){
    h=String(h||'').toLowerCase().replace(/\\.$/,'');
    if(!h||!h.includes('.'))return false;
    if(/^\\d{1,3}(\\.\\d{1,3}){3}$/.test(h)||h.indexOf(':')!==-1||h==='localhost')return false;
    return h==='whatsapp.com'||h.endsWith('.whatsapp.com')||h==='whatsapp.net'||h.endsWith('.whatsapp.net')||h==='fbcdn.net'||h.endsWith('.fbcdn.net')||h==='graph.facebook.com';
  }
  function toProxy(u){
    if(u==null)return u;
    var s=String(u);
    if(!s||s.startsWith('#')||s.startsWith('data:')||s.startsWith('blob:')||s.indexOf('/api/wa-proxy')===0)return s;
    try{
      var resolved=new URL(s,BASE_ORIGIN);
      if(typeof self!=='undefined'&&self.location&&resolved.origin===self.location.origin&&resolved.pathname.indexOf('/api/wa-proxy')!==0){
        resolved=new URL(resolved.pathname+resolved.search,BASE_ORIGIN);
      }
      if((resolved.protocol==='https:'||resolved.protocol==='http:')&&isAllowedHost(resolved.hostname)){
        return (self.location?self.location.origin:'')+'/api/wa-proxy?url='+encodeURIComponent(resolved.href);
      }
    }catch(e){}
    return s;
  }
  function toWsProxy(u){
    if(u==null)return u;
    var s=String(u);
    if(!s||s.indexOf('/api/wa-ws')!==-1)return s;
    try{
      var resolved=new URL(s,BASE_ORIGIN);
      if(typeof self!=='undefined'&&self.location&&resolved.origin===self.location.origin){
        resolved=new URL((resolved.protocol==='wss:'||resolved.protocol==='https:'?'wss://':'ws://')+'web.whatsapp.com'+resolved.pathname+resolved.search);
      }else if(resolved.protocol==='https:'||resolved.protocol==='http:'){
        resolved=new URL((resolved.protocol==='https:'?'wss://':'ws://')+resolved.host+resolved.pathname+resolved.search);
      }
      if((resolved.protocol==='wss:'||resolved.protocol==='ws:')&&isAllowedHost(resolved.hostname)&&self.location){
        var proto=self.location.protocol==='https:'?'wss://':'ws://';
        return proto+self.location.host+'/api/wa-ws?url='+encodeURIComponent(resolved.href);
      }
    }catch(e){}
    return s;
  }
  if(typeof self!=='undefined'&&self.importScripts){
    var origImport=self.importScripts.bind(self);
    self.importScripts=function(){
      var args=[];
      for(var i=0;i<arguments.length;i++)args.push(toProxy(arguments[i]));
      return origImport.apply(self,args);
    };
  }
  if(typeof self!=='undefined'&&self.fetch){
    var origFetch=self.fetch.bind(self);
    self.fetch=function(input,init){
      try{
        if(typeof input==='string')input=toProxy(input);
        else if(input&&typeof URL!=='undefined'&&input instanceof URL)input=toProxy(input.href);
        else if(input&&typeof input.url==='string'){
          var nu=toProxy(input.url);
          if(nu!==input.url)input=new Request(nu,input);
        }
      }catch(e){}
      return origFetch(input,init);
    };
  }
  if(typeof WebSocket!=='undefined'){
    var OrigWS=WebSocket;
    var WrappedWS=function(url,protocols){
      var nextUrl=toWsProxy(url);
      return protocols!==undefined?new OrigWS(nextUrl,protocols):new OrigWS(nextUrl);
    };
    WrappedWS.prototype=OrigWS.prototype;
    WrappedWS.CONNECTING=OrigWS.CONNECTING;
    WrappedWS.OPEN=OrigWS.OPEN;
    WrappedWS.CLOSING=OrigWS.CLOSING;
    WrappedWS.CLOSED=OrigWS.CLOSED;
    self.WebSocket=WrappedWS;
  }
})();\n`;

function rewriteHtmlForProxy(html, baseUrlObj) {
    const proxyOrigin = `${baseUrlObj.protocol}//${baseUrlObj.host}`;
    const bootstrapScript = `<script>(function(){
  var BASE_ORIGIN=${JSON.stringify(proxyOrigin)};
  var BASE_HREF=${JSON.stringify(baseUrlObj.href)};
  var APP_ORIGIN=(typeof window!=='undefined'&&window.location)?window.location.origin:'';
  function isAllowedHost(h){
    h=String(h||'').toLowerCase().replace(/\\.$/,'');
    if(!h||h.indexOf('.')===-1)return false;
    if(/^\\d{1,3}(\\.\\d{1,3}){3}$/.test(h)||h.indexOf(':')!==-1||h==='localhost')return false;
    return h==='whatsapp.com'||h.endsWith('.whatsapp.com')||h==='whatsapp.net'||h.endsWith('.whatsapp.net')||h==='fbcdn.net'||h.endsWith('.fbcdn.net')||h==='graph.facebook.com';
  }
  function toProxy(u){
    if(u==null)return u;
    var s=String(u);
    if(!s||s.startsWith('#')||s.startsWith('data:')||s.startsWith('blob:')||s.startsWith('javascript:')||s.indexOf('/api/wa-proxy')!==-1)return s;
    try{
      var resolved=new URL(s, s.startsWith('/') ? BASE_ORIGIN : BASE_HREF);
      if(APP_ORIGIN&&resolved.origin===APP_ORIGIN&&resolved.pathname.indexOf('/api/wa-proxy')!==0&&resolved.pathname.indexOf('/api/wa-ws')!==0){
        resolved=new URL(resolved.pathname+resolved.search+resolved.hash, BASE_ORIGIN);
      }
      if((resolved.protocol==='https:'||resolved.protocol==='http:')&&isAllowedHost(resolved.hostname)){
        return '/api/wa-proxy?url='+encodeURIComponent(resolved.href);
      }
    }catch(e){}
    return s;
  }
  function toWsProxy(u){
    if(u==null)return u;
    var s=String(u);
    if(!s||s.indexOf('/api/wa-ws')!==-1)return s;
    try{
      var resolved=new URL(s, BASE_HREF);
      if(APP_ORIGIN&&resolved.host===window.location.host&&resolved.pathname.indexOf('/api/wa-ws')!==0){
        resolved=new URL((resolved.protocol==='wss:'||resolved.protocol==='https:'?'wss://':'ws://')+baseUrlObjHost()+resolved.pathname+resolved.search);
      }else if(resolved.protocol==='https:'||resolved.protocol==='http:'){
        resolved=new URL((resolved.protocol==='https:'?'wss://':'ws://')+resolved.host+resolved.pathname+resolved.search);
      }
      if((resolved.protocol==='wss:'||resolved.protocol==='ws:')&&isAllowedHost(resolved.hostname)){
        var proto=window.location.protocol==='https:'?'wss://':'ws://';
        return proto+window.location.host+'/api/wa-ws?url='+encodeURIComponent(resolved.href);
      }
    }catch(e){}
    return s;
  }
  function baseUrlObjHost(){return ${JSON.stringify(baseUrlObj.host)};}
  var origFetch=window.fetch;
  if(origFetch){
    window.fetch=function(input,init){
      try{
        if(typeof input==='string'){input=toProxy(input);}
        else if(input&&typeof URL!=='undefined'&&input instanceof URL){input=toProxy(input.href);}
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
  if(navigator&&typeof navigator.sendBeacon==='function'){
    var origBeacon=navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon=function(url,data){return origBeacon(toProxy(url),data);};
  }
  if(navigator&&navigator.serviceWorker){
    try{
      var mockReg={scope:'/',active:null,installing:null,waiting:null,update:function(){return Promise.resolve();},unregister:function(){return Promise.resolve(true);},addEventListener:function(){},removeEventListener:function(){}};
      navigator.serviceWorker.register=function(){return Promise.resolve(mockReg);};
      navigator.serviceWorker.getRegistration=function(){return Promise.resolve(undefined);};
      navigator.serviceWorker.getRegistrations=function(){return Promise.resolve([]);};
    }catch(e){}
  }
  if(window.history){
    var origPush=window.history.pushState;
    var origRep=window.history.replaceState;
    window.history.pushState=function(state,title,url){
      try{return origPush.call(window.history,state,title,undefined);}catch(e){}
    };
    window.history.replaceState=function(state,title,url){
      try{return origRep.call(window.history,state,title,undefined);}catch(e){}
    };
  }
  var origWinOpen=window.open;
  if(origWinOpen){
    window.open=function(url,target,features){
      return origWinOpen.call(window,toProxy(url),target,features);
    };
  }
  var OrigWS=window.WebSocket;
  if(OrigWS){
    var WrappedWS=function(url,protocols){
      var nextUrl=toWsProxy(url);
      return protocols!==undefined?new OrigWS(nextUrl,protocols):new OrigWS(nextUrl);
    };
    WrappedWS.prototype=OrigWS.prototype;
    WrappedWS.CONNECTING=OrigWS.CONNECTING;
    WrappedWS.OPEN=OrigWS.OPEN;
    WrappedWS.CLOSING=OrigWS.CLOSING;
    WrappedWS.CLOSED=OrigWS.CLOSED;
    window.WebSocket=WrappedWS;
  }
  if(window.Worker){
    var OrigWorker=window.Worker;
    var WrappedWorker=function(url,opts){
      var next=typeof url==='string'?toProxy(url):(url&&url.href?toProxy(url.href):url);
      if(typeof next==='string'&&next.indexOf('/api/wa-proxy')!==-1){
        next+=(next.indexOf('?')!==-1?'&':'?')+'__wa_worker=1';
      }
      return opts!==undefined?new OrigWorker(next,opts):new OrigWorker(next);
    };
    WrappedWorker.prototype=OrigWorker.prototype;
    window.Worker=WrappedWorker;
  }
  if(window.SharedWorker){
    var OrigSharedWorker=window.SharedWorker;
    var WrappedSharedWorker=function(url,opts){
      var next=typeof url==='string'?toProxy(url):(url&&url.href?toProxy(url.href):url);
      if(typeof next==='string'&&next.indexOf('/api/wa-proxy')!==-1){
        next+=(next.indexOf('?')!==-1?'&':'?')+'__wa_worker=1';
      }
      return opts!==undefined?new OrigSharedWorker(next,opts):new OrigSharedWorker(next);
    };
    WrappedSharedWorker.prototype=OrigSharedWorker.prototype;
    window.SharedWorker=WrappedSharedWorker;
  }
  if(window.EventSource){
    var OrigES=window.EventSource;
    var WrappedES=function(url,cfg){
      return cfg!==undefined?new OrigES(toProxy(url),cfg):new OrigES(toProxy(url));
    };
    WrappedES.prototype=OrigES.prototype;
    window.EventSource=WrappedES;
  }
  if(window.FontFace){
    var OrigFF=window.FontFace;
    window.FontFace=function(family,source,desc){
      if(typeof source==='string'){
        source=source.replace(/url\\((['"]?)([^'")]+)\\1\\)/gi,function(m,q,v){return 'url('+q+toProxy(v)+q+')';});
      }
      return new OrigFF(family,source,desc);
    };
  }
  var origSetAttr=Element.prototype.setAttribute;
  Element.prototype.setAttribute=function(name,val){
    if((name==='src'||name==='href'||name==='action'||name==='poster')&&typeof val==='string'){
      val=toProxy(val);
    }
    return origSetAttr.call(this,name,val);
  };
  [HTMLScriptElement,HTMLLinkElement,HTMLImageElement,HTMLIFrameElement,HTMLSourceElement,HTMLMediaElement].forEach(function(Ctor){
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

    let out = html
        .replace(/<meta[^>]*http-equiv=["']?(?:Content-Security-Policy|X-Frame-Options)["']?[^>]*>/gi, '')
        .replace(
            /(src|href|action|poster)=["']([^"']+)["']/gi,
            (full, attr, val) => `${attr}="${resolveAndProxyUrl(val, baseUrlObj)}"`
        )
        .replace(/url\((['"]?)([^'")]+)\1\)/gi, (full, q, val) => {
            const next = resolveAndProxyUrl(val, baseUrlObj);
            return `url(${q}${next}${q})`;
        });

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

function rewriteSetCookieForProxy(cookieStr, isHttps) {
    let rewritten = String(cookieStr || '').replace(/;\s*domain=[^;]*/gi, '');
    if (isHttps) {
        rewritten = rewritten.replace(/;\s*samesite=[^;]*/gi, '');
        if (!/;\s*secure\b/i.test(rewritten)) rewritten += '; Secure';
        rewritten += '; SameSite=None';
    } else {
        rewritten = rewritten.replace(/;\s*secure\b/gi, '').replace(/;\s*samesite=[^;]*/gi, '');
        rewritten += '; SameSite=Lax';
    }
    return rewritten;
}

const SKIP_FORWARD_HEADERS = new Set([
    'host',
    'connection',
    'content-length',
    'origin',
    'referer',
    'accept-encoding',
    'upgrade',
    'keep-alive',
    'transfer-encoding',
    'te',
    'trailer',
    'proxy-authorization',
    'proxy-connection',
    'forwarded'
]);

export default async function handler(req, res) {
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');
        return res.status(204).end();
    }

    const rawUrl = req.query?.url ? String(req.query.url) : DEFAULT_WA_URL;
    let currentUrl = validateWaTargetUrl(rawUrl, false);
    if (!currentUrl) {
        return res.status(403).json({
            error: 'Only official WhatsApp & Meta CDN URLs are permitted via /api/wa-proxy'
        });
    }

    const isWorkerReq = String(req.query?.__wa_worker || '') === '1';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    try {
        const isRootDoc = currentUrl.hostname === 'web.whatsapp.com' && (currentUrl.pathname === '/' || currentUrl.pathname === '');
        const forwardHeaders = {
            'User-Agent': BROWSER_UA,
            'Accept': isRootDoc
                ? 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
                : (req.headers?.accept || '*/*'),
            'Accept-Language': req.headers?.['accept-language'] || 'en-US,en;q=0.9',
            'Origin': 'https://web.whatsapp.com',
            'Referer': 'https://web.whatsapp.com/'
        };

        if (isRootDoc) {
            forwardHeaders['Sec-Fetch-Dest'] = 'document';
            forwardHeaders['Sec-Fetch-Mode'] = 'navigate';
            forwardHeaders['Sec-Fetch-Site'] = 'none';
            forwardHeaders['Sec-Fetch-User'] = '?1';
            forwardHeaders['Upgrade-Insecure-Requests'] = '1';
        }

        for (const [k, v] of Object.entries(req.headers || {})) {
            const lk = k.toLowerCase();
            if (
                SKIP_FORWARD_HEADERS.has(lk) ||
                lk === 'accept' ||
                lk === 'accept-language' ||
                lk === 'user-agent' ||
                lk.startsWith('sec-fetch-') ||
                lk.startsWith('sec-ch-') ||
                lk.startsWith('x-forwarded-') ||
                lk === 'x-cloud-trace-context'
            ) {
                continue;
            }
            if (typeof v === 'string') {
                forwardHeaders[k] = v;
            }
        }

        const bodyBuf = await readRequestBodyBuffer(req);

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
                const validated = validateWaTargetUrl(nextUrl.href, false);
                if (!validated) {
                    return res.status(403).json({ error: 'Blocked redirect outside WhatsApp domain' });
                }
                currentUrl = validated;
                continue;
            }
            break;
        }

        if (!upstreamRes) {
            return res.status(502).json({ error: 'No response from WhatsApp upstream' });
        }

        const contentType = String(upstreamRes.headers.get('content-type') || 'application/octet-stream');
        const lowerCt = contentType.toLowerCase();
        res.status(upstreamRes.status);
        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('X-Proxy-Host', currentUrl.hostname);

        if (lowerCt.includes('text/html') || currentUrl.hostname === 'web.whatsapp.com') {
            res.setHeader('Cache-Control', 'no-store');
        } else {
            const upstreamCc = upstreamRes.headers.get('cache-control');
            if (upstreamCc) res.setHeader('Cache-Control', upstreamCc);
        }

        const isHttps = req.headers['x-forwarded-proto'] === 'https' || Boolean(req.secure);
        const setCookies = typeof upstreamRes.headers.getSetCookie === 'function'
            ? upstreamRes.headers.getSetCookie()
            : (upstreamRes.headers.get('set-cookie') ? [upstreamRes.headers.get('set-cookie')] : []);
        if (setCookies.length > 0) {
            res.setHeader('Set-Cookie', setCookies.map(c => rewriteSetCookieForProxy(c, isHttps)));
        }

        if (lowerCt.includes('text/html')) {
            const html = await upstreamRes.text();
            const rewritten = rewriteHtmlForProxy(html, currentUrl);
            return res.send(rewritten);
        }

        if (lowerCt.includes('text/css')) {
            const css = await upstreamRes.text();
            return res.send(rewriteCssForProxy(css, currentUrl));
        }

        if (isWorkerReq && (lowerCt.includes('javascript') || lowerCt.includes('ecmascript'))) {
            const js = await upstreamRes.text();
            return res.send(WORKER_PROXY_SHIM + js);
        }

        const arrBuf = await upstreamRes.arrayBuffer();
        return res.send(Buffer.from(arrBuf));
    } catch (err) {
        const msg = err?.name === 'AbortError' ? 'WhatsApp proxy timeout' : (err?.message || 'WhatsApp proxy failed');
        if (!res.headersSent) {
            return res.status(502).json({ error: msg });
        }
    } finally {
        clearTimeout(timer);
    }
}
