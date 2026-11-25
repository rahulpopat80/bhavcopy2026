// =========================================================================
// Rahul Finance — Terminal Shell, WebSocket Market Stream, Theme, Overview & Order Ticket
// =========================================================================
(function () {
    'use strict';

    const DEFAULT_QUICK_ASSETS = [
        { sym: '^NSEI', label: 'NIFTY 50', group: 'Index' },
        { sym: '^BSESN', label: 'SENSEX', group: 'Index' },
        { sym: '^NSEBANK', label: 'BANK NIFTY', group: 'Index' },
        { sym: 'GOLD_INR', label: 'GOLD /10g (INR ₹)', group: 'Commodity' },
        { sym: 'SILVER_INR', label: 'SILVER /kg (INR ₹)', group: 'Commodity' },
        { sym: 'GC=F', label: 'GOLD ($ USD)', group: 'Commodity' },
        { sym: 'SI=F', label: 'SILVER ($ USD)', group: 'Commodity' },
        { sym: 'INR=X', label: 'USD / INR', group: 'FX' },
        { sym: '^IXIC', label: 'NASDAQ Composite', group: 'Global' },
        { sym: '^HSI', label: 'HANG SENG Index', group: 'Global' },
        { sym: 'RELIANCE', label: 'Reliance Industries', group: 'NSE Equity' },
        { sym: 'TCS', label: 'Tata Consultancy Services', group: 'NSE Equity' },
        { sym: 'HDFCBANK', label: 'HDFC Bank', group: 'NSE Equity' },
        { sym: 'ICICIBANK', label: 'ICICI Bank', group: 'NSE Equity' },
        { sym: 'SBIN', label: 'State Bank of India', group: 'NSE Equity' },
        { sym: 'INFY', label: 'Infosys', group: 'NSE Equity' },
        { sym: 'ITC', label: 'ITC Limited', group: 'NSE Equity' },
        { sym: 'BHARTIARTL', label: 'Bharti Airtel', group: 'NSE Equity' }
    ];

    let wsConn = null;
    let wsConnected = false;
    let wsReconnectTimer = null;
    let wsDisabledByUser = false;
    let orderSide = 'BUY';
    let lastLiveSnapshot = null;
    let ovTipsFetchAt = 0;

    // ---------------------------------------------------------------------
    // 1. Theme & Settings Management
    // ---------------------------------------------------------------------
    function getSavedTheme() {
        try {
            return localStorage.getItem('rf_theme') === 'light' ? 'light' : 'dark';
        } catch (_) {
            return 'dark';
        }
    }

    function applyTheme(theme) {
        const isLight = theme === 'light';
        if (isLight) {
            document.documentElement.setAttribute('data-theme', 'light');
        } else {
            document.documentElement.removeAttribute('data-theme');
        }
        try {
            localStorage.setItem('rf_theme', isLight ? 'light' : 'dark');
        } catch (_) {}

        const toggleBtn = document.getElementById('theme-toggle-btn');
        if (toggleBtn) {
            toggleBtn.title = isLight ? 'Switch to Dark Terminal' : 'Switch to Light Apple Theme';
            toggleBtn.innerHTML = isLight
                ? '<i data-lucide="moon" class="rf-icon"></i><span>Dark</span>'
                : '<i data-lucide="sun" class="rf-icon"></i><span>Light</span>';
        }
        const settingsSelect = document.getElementById('settings-theme-select');
        if (settingsSelect) settingsSelect.value = isLight ? 'light' : 'dark';

        if (window.RfTvCharts) {
            window.RfTvCharts.refreshThemes();
        }
        refreshLucideIcons();
    }

    function refreshLucideIcons() {
        try {
            if (window.lucide && typeof window.lucide.createIcons === 'function') {
                window.lucide.createIcons();
            }
        } catch (_) {}
    }

    // ---------------------------------------------------------------------
    // 2. Sidebar Collapse & Mobile Drawer
    // ---------------------------------------------------------------------
    function initSidebarNavigation() {
        const collapseBtn = document.getElementById('sidebar-collapse-btn');
        const mobileBtn = document.getElementById('mobile-sidebar-toggle');
        const backdrop = document.getElementById('sidebar-backdrop');
        const sidebar = document.getElementById('app-sidebar');

        try {
            if (localStorage.getItem('rf_sidebar_collapsed') === '1' && window.innerWidth >= 1024) {
                document.body.classList.add('sidebar-collapsed');
            }
        } catch (_) {}

        if (collapseBtn) {
            collapseBtn.addEventListener('click', () => {
                document.body.classList.toggle('sidebar-collapsed');
                try {
                    localStorage.setItem('rf_sidebar_collapsed', document.body.classList.contains('sidebar-collapsed') ? '1' : '0');
                } catch (_) {}
            });
        }

        const closeMobileDrawer = () => {
            document.body.classList.remove('sidebar-mobile-open');
        };

        if (mobileBtn) {
            mobileBtn.addEventListener('click', () => {
                document.body.classList.toggle('sidebar-mobile-open');
            });
        }
        if (backdrop) {
            backdrop.addEventListener('click', closeMobileDrawer);
        }
        if (sidebar) {
            sidebar.addEventListener('click', (e) => {
                if (e.target.closest('.nav-btn')) {
                    closeMobileDrawer();
                    updateActiveWorkspaceTitle();
                }
            });
        }
    }

    function updateActiveWorkspaceTitle() {
        const activeBtn = document.querySelector('.nav-btn.active');
        const titleEl = document.getElementById('topbar-active-title');
        if (activeBtn && titleEl) {
            const label = activeBtn.dataset.workspaceTitle || activeBtn.textContent.trim();
            titleEl.textContent = label;
        }
    }

    // ---------------------------------------------------------------------
    // 3. Real-Time WebSocket Stream (/api/market-stream) + HTTP Fallback
    // ---------------------------------------------------------------------
    function setStreamStatusUi(modeText, isWs) {
        const badge = document.getElementById('rf-stream-badge');
        const text = document.getElementById('rf-stream-text');
        if (badge) {
            badge.classList.toggle('is-ws', Boolean(isWs));
        }
        if (text) {
            text.textContent = modeText;
        }
    }

    function connectMarketStream() {
        try {
            const pref = localStorage.getItem('rf_stream_pref');
            wsDisabledByUser = pref === 'http';
        } catch (_) {}

        if (wsDisabledByUser) {
            setStreamStatusUi('HTTP Live · 2x/s', false);
            return;
        }
        if (wsConn && (wsConn.readyState === WebSocket.OPEN || wsConn.readyState === WebSocket.CONNECTING)) {
            return;
        }

        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${proto}//${location.host}/api/market-stream`;
        try {
            wsConn = new WebSocket(wsUrl);
        } catch (_) {
            setStreamStatusUi('HTTP Live · 2x/s', false);
            return;
        }

        wsConn.onopen = () => {
            wsConnected = true;
            setStreamStatusUi('WS Stream · 2x/s', true);
        };

        wsConn.onmessage = (evt) => {
            try {
                const msg = JSON.parse(evt.data);
                if (msg && msg.type === 'market_tick' && msg.data) {
                    lastLiveSnapshot = msg.data;
                    if (typeof window.applyLiveMarketPayload === 'function') {
                        window.applyLiveMarketPayload(msg.data);
                    }
                    syncOrderTicketWithLiveData(msg.data);
                }
            } catch (_) {}
        };

        wsConn.onerror = () => {
            wsConnected = false;
            setStreamStatusUi('HTTPS Live · 2x/s', false);
        };

        wsConn.onclose = () => {
            wsConnected = false;
            setStreamStatusUi('HTTPS Live · 2x/s', false);
            if (!wsDisabledByUser && !wsReconnectTimer) {
                wsReconnectTimer = setTimeout(() => {
                    wsReconnectTimer = null;
                    connectMarketStream();
                }, 4000);
            }
        };
    }

    function isMarketStreamWsActive() {
        return wsConnected && wsConn && wsConn.readyState === WebSocket.OPEN;
    }

    // ---------------------------------------------------------------------
    // 4. Market Overview Workspace Renderer
    // ---------------------------------------------------------------------
    function formatStateTag(state) {
        if (!state) return '';
        const up = String(state).toUpperCase();
        if (up === 'OPEN') return 'OPEN';
        if (up === 'PARITY') return 'SPOT PARITY';
        if (up === 'CLOSED') return 'CLOSED';
        return up;
    }

    function updateOverviewBenchmark(idPrefix, item, opts = {}) {
        if (!item || !Number.isFinite(Number(item.price))) return;
        const valEl = document.getElementById(`ov-${idPrefix}-val`);
        const chgEl = document.getElementById(`ov-${idPrefix}-chg`);
        const stateEl = document.getElementById(`ov-${idPrefix}-state`);

        const decimals = opts.decimals !== undefined ? opts.decimals : 2;
        const prefix = opts.prefix || '';
        const price = Number(item.price);
        const change = Number(item.change || 0);
        const pct = Number(item.changePercent || 0);

        if (valEl) {
            valEl.textContent = `${prefix}${price.toLocaleString('en-IN', {
                minimumFractionDigits: decimals,
                maximumFractionDigits: decimals
            })}`;
        }
        if (chgEl) {
            const sign = change >= 0 ? '+' : '';
            chgEl.textContent = `${sign}${change.toLocaleString('en-IN', {
                minimumFractionDigits: decimals,
                maximumFractionDigits: decimals
            })} (${sign}${pct.toFixed(2)}%)`;
            chgEl.className = `ov-bench-chg ${change >= 0 ? 'is-up' : 'is-down'}`;
        }
        if (stateEl) {
            const st = item.marketState || '';
            const label = item.source && st === 'PARITY'
                ? 'SPOT PARITY'
                : (formatStateTag(st) || (item.source ? item.source : ''));
            stateEl.textContent = label;
            stateEl.className = `ov-bench-state ${st === 'OPEN' ? 'st-open' : (st === 'PARITY' ? 'st-parity' : 'st-closed')}`;
        }
    }

    function renderMarketOverview(d) {
        if (!d) return;
        lastLiveSnapshot = d;
        const gUsd = d.goldUsd || d.gold?.usd;
        const sUsd = d.silverUsd || d.silver?.usd;
        const bankNifty = d.globalIndices ? d.globalIndices['^NSEBANK'] : null;

        updateOverviewBenchmark('nifty', d.nifty, { decimals: 2 });
        updateOverviewBenchmark('sensex', d.sensex, { decimals: 2 });
        updateOverviewBenchmark('gold', d.gold, { decimals: 2, prefix: '₹' });
        updateOverviewBenchmark('silver', d.silver, { decimals: 2, prefix: '₹' });
        updateOverviewBenchmark('usdinr', d.usdInr, { decimals: 3, prefix: '₹' });
        updateOverviewBenchmark('nasdaq', d.nasdaq, { decimals: 2 });
        updateOverviewBenchmark('hangseng', d.hangseng, { decimals: 2 });
        if (bankNifty) {
            updateOverviewBenchmark('banknifty', bankNifty, { decimals: 2 });
        }

        // Update USD secondary lines on Gold & Silver Overview cards
        const goldSub = document.getElementById('ov-gold-sub');
        if (goldSub && gUsd && Number.isFinite(Number(gUsd.price))) {
            goldSub.textContent = `COMEX $${Number(gUsd.price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/oz`;
        }
        const silverSub = document.getElementById('ov-silver-sub');
        if (silverSub && sUsd && Number.isFinite(Number(sUsd.price))) {
            silverSub.textContent = `COMEX $${Number(sUsd.price).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 })}/oz`;
        }

        // Market Breadth on Overview
        const nMarket = d.breadth?.nseMarket;
        if (nMarket) {
            const total = (Number(nMarket.advances) + Number(nMarket.declines)) || 1;
            const advPct = (Number(nMarket.advances) / total) * 100;
            const barEl = document.getElementById('ov-nse-breadth-bar');
            const advEl = document.getElementById('ov-nse-adv');
            const decEl = document.getElementById('ov-nse-dec');
            if (barEl) barEl.style.width = `${advPct.toFixed(1)}%`;
            if (advEl) advEl.textContent = `${Number(nMarket.advances).toLocaleString('en-IN')} Adv (${advPct.toFixed(0)}%)`;
            if (decEl) decEl.textContent = `${Number(nMarket.declines).toLocaleString('en-IN')} Dec`;
        }
        const sBreadth = d.breadth?.sensex30;
        if (sBreadth) {
            const total = (Number(sBreadth.advances) + Number(sBreadth.declines)) || 30;
            const advPct = (Number(sBreadth.advances) / total) * 100;
            const barEl = document.getElementById('ov-sensex-breadth-bar');
            const advEl = document.getElementById('ov-sensex-adv');
            const decEl = document.getElementById('ov-sensex-dec');
            if (barEl) barEl.style.width = `${advPct.toFixed(1)}%`;
            if (advEl) advEl.textContent = `${sBreadth.advances} Adv`;
            if (decEl) decEl.textContent = `${sBreadth.declines} Dec`;
        }

        // Sync overview time label
        const tsEl = document.getElementById('ov-live-timestamp');
        if (tsEl) {
            tsEl.textContent = new Date().toLocaleTimeString('en-IN', { hour12: false });
        }

        // Refresh Overview secondary widgets lazily every 8s when Overview tab is visible
        const ovPane = document.getElementById('overview-tab-content');
        if (ovPane && !ovPane.classList.contains('hidden')) {
            if (Date.now() - ovTipsFetchAt > 8000) {
                ovTipsFetchAt = Date.now();
                refreshOverviewWidgets();
            }
        }
    }

    async function refreshOverviewWidgets() {
        // 1. MMI Gauge via ECharts
        try {
            const res = await fetch('/api/mmi', { cache: 'no-store' });
            if (res.ok) {
                const mmi = await res.json();
                if (window.RfTvCharts) {
                    window.RfTvCharts.renderEChartsMmiGauge('ov-mmi-echarts', mmi);
                }
                const sub = document.getElementById('ov-mmi-sub');
                if (sub && Number.isFinite(Number(mmi.value))) {
                    sub.textContent = `Prev Day: ${mmi.prevDay ?? '--'} · Week: ${mmi.lastWeek ?? '--'}`;
                }
            }
        } catch (_) {}

        // 2. Latest 6 Option Tips signals
        try {
            const res = await fetch('/api/option-tips?segment=ALL&limit=6', { cache: 'no-store' });
            if (res.ok) {
                const json = await res.json();
                const listEl = document.getElementById('ov-top-tips-list');
                const tips = Array.isArray(json.tips) ? json.tips.slice(0, 6) : [];
                if (listEl && tips.length > 0) {
                    listEl.innerHTML = tips.map(t => {
                        const action = t.action === 'EXIT' ? 'EXIT' : (t.action === 'SELL' ? 'SELL' : 'BUY');
                        const cls = action === 'EXIT' ? 'is-exit' : (action === 'SELL' ? 'is-sell' : 'is-buy');
                        const prefix = t.currency === 'USD' ? '$' : '₹';
                        const sym = String(t.chartSymbol || t.scriptName || '').replace(/"/g, '&quot;');
                        return `
                            <div class="ov-tip-row live-chart-trigger" data-chart-symbol="${sym}">
                                <div class="ov-tip-left">
                                    <strong>${escapeSimple(t.scriptName)}</strong>
                                    <span>${escapeSimple(t.broker)} · ${escapeSimple(t.publishedAt || '')}</span>
                                </div>
                                <div class="ov-tip-right">
                                    <span class="ov-tip-side ${cls}">${action}</span>
                                    <span class="ov-tip-nums">CMP ${prefix}${Number(t.cmp || t.entry || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })} · T ${prefix}${Number(t.target || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
                                </div>
                            </div>
                        `;
                    }).join('');
                }
            }
        } catch (_) {}

        // 3. Portfolio Summary preview from in-memory state if loaded
        syncOverviewPortfolioPreview();
    }

    function syncOverviewPortfolioPreview() {
        const invEl = document.getElementById('ov-port-invested');
        const pnlEl = document.getElementById('ov-port-pnl');
        const cntEl = document.getElementById('ov-port-count');
        const srcInv = document.getElementById('portfolio-total-invested')?.textContent;
        const srcPnl = document.getElementById('portfolio-total-profit')?.textContent;
        const srcAct = document.getElementById('portfolio-active-holdings')?.textContent;
        if (invEl && srcInv) invEl.textContent = srcInv;
        if (pnlEl && srcPnl) {
            pnlEl.textContent = srcPnl;
            pnlEl.style.color = srcPnl.trim().startsWith('-') ? 'var(--danger-color)' : 'var(--success-color)';
        }
        if (cntEl && srcAct) cntEl.textContent = `${srcAct} Active`;
    }

    function escapeSimple(str) {
        return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // ---------------------------------------------------------------------
    // 5. TradingView-Style Live Order Ticket & Option Strikes Mini-Book
    // ---------------------------------------------------------------------
    function getLiveCmpForCandleSymbol(symbol) {
        const clean = String(symbol || '').trim().toUpperCase();
        if (window.candleTabState && Array.isArray(window.candleTabState.candles) && window.candleTabState.candles.length > 0) {
            const last = window.candleTabState.candles[window.candleTabState.candles.length - 1];
            if (last && Number.isFinite(Number(last.close))) return Number(last.close);
        }
        if (lastLiveSnapshot) {
            if (clean === '^NSEI') return Number(lastLiveSnapshot.nifty?.price);
            if (clean === '^BSESN') return Number(lastLiveSnapshot.sensex?.price);
            if (clean === 'GOLD_INR') return Number(lastLiveSnapshot.gold?.price);
            if (clean === 'SILVER_INR') return Number(lastLiveSnapshot.silver?.price);
            if (clean === 'GC=F') return Number(lastLiveSnapshot.goldUsd?.price || lastLiveSnapshot.gold?.usd?.price);
            if (clean === 'SI=F') return Number(lastLiveSnapshot.silverUsd?.price || lastLiveSnapshot.silver?.usd?.price);
            if (clean === 'INR=X') return Number(lastLiveSnapshot.usdInr?.price);
        }
        return null;
    }

    function syncOrderTicketWithLiveData(snapshot) {
        const ccPane = document.getElementById('candle-chart-tab-content');
        if (!ccPane || ccPane.classList.contains('hidden')) return;
        const sym = window.candleTabState?.symbol || '^NSEI';
        const price = getLiveCmpForCandleSymbol(sym);
        const cmpEl = document.getElementById('cc-ticket-cmp');
        if (cmpEl && Number.isFinite(price) && price > 0) {
            cmpEl.textContent = typeof window.fmtCandlePrice === 'function' ? window.fmtCandlePrice(price, sym) : `₹${price.toFixed(2)}`;
        }
        recalcOrderTicketValue();
    }

    function recalcOrderTicketValue() {
        const sym = window.candleTabState?.symbol || '^NSEI';
        const qtyInput = document.getElementById('cc-ticket-qty');
        const typeSelect = document.getElementById('cc-ticket-type');
        const limitInput = document.getElementById('cc-ticket-limit-price');
        const totalEl = document.getElementById('cc-ticket-total');
        if (!qtyInput || !totalEl) return;

        const qty = Math.max(1, parseInt(qtyInput.value, 10) || 1);
        const isLimit = typeSelect && typeSelect.value === 'LIMIT';
        let unitPrice = isLimit && limitInput && Number(limitInput.value) > 0
            ? Number(limitInput.value)
            : getLiveCmpForCandleSymbol(sym);

        if (Number.isFinite(unitPrice) && unitPrice > 0) {
            const total = qty * unitPrice;
            totalEl.textContent = typeof window.fmtCandlePrice === 'function'
                ? window.fmtCandlePrice(total, sym)
                : `₹${total.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        } else {
            totalEl.textContent = '--';
        }
    }

    function updateOrderTicketSymbolContext(symbol, candles, analysis) {
        const symBadge = document.getElementById('cc-ticket-symbol');
        const limitInput = document.getElementById('cc-ticket-limit-price');
        const cmpEl = document.getElementById('cc-ticket-cmp');
        const bookEl = document.getElementById('cc-mini-book-body');
        if (!symBadge) return;

        symBadge.textContent = symbol || '^NSEI';
        const last = Array.isArray(candles) && candles.length > 0 ? candles[candles.length - 1] : null;
        if (last && Number.isFinite(Number(last.close))) {
            if (cmpEl) cmpEl.textContent = typeof window.fmtCandlePrice === 'function' ? window.fmtCandlePrice(last.close, symbol) : last.close.toFixed(2);
            if (limitInput && !limitInput.matches(':focus') && !limitInput.value) {
                limitInput.placeholder = Number(last.close).toFixed(2);
            }
        }
        recalcOrderTicketValue();

        // Populate Mini Stats / Levels Book
        if (bookEl && last) {
            const ts = analysis?.tradeSignal;
            const fmt = (v) => (typeof window.fmtCandlePrice === 'function' ? window.fmtCandlePrice(v, symbol) : Number(v).toFixed(2));
            bookEl.innerHTML = `
                <div class="cc-book-row"><span>Open / Close</span><strong>${fmt(last.open)} / ${fmt(last.close)}</strong></div>
                <div class="cc-book-row"><span>Bar High / Low</span><strong>${fmt(last.high)} / ${fmt(last.low)}</strong></div>
                ${ts ? `
                    <div class="cc-book-row"><span>Tech Signal</span><strong class="${ts.biasSide === 'SELL' ? 'loss-text' : 'profit-text'}">${escapeSimple(ts.action)}</strong></div>
                    <div class="cc-book-row"><span>Target 1 / SL</span><strong>${fmt(ts.target1)} / ${fmt(ts.stopLoss)}</strong></div>
                ` : ''}
            `;
        }
    }

    function initOrderTicket() {
        const buyBtn = document.getElementById('cc-ticket-side-buy');
        const sellBtn = document.getElementById('cc-ticket-side-sell');
        const submitBtn = document.getElementById('cc-ticket-submit');
        const typeSelect = document.getElementById('cc-ticket-type');
        const limitWrap = document.getElementById('cc-ticket-limit-wrap');
        const limitInput = document.getElementById('cc-ticket-limit-price');
        const qtyInput = document.getElementById('cc-ticket-qty');
        const samcoBtn = document.getElementById('cc-ticket-samco-btn');

        const syncSide = (side) => {
            orderSide = side === 'SELL' ? 'SELL' : 'BUY';
            if (buyBtn) buyBtn.classList.toggle('active', orderSide === 'BUY');
            if (sellBtn) sellBtn.classList.toggle('active', orderSide === 'SELL');
            if (submitBtn) {
                submitBtn.className = `cc-ticket-submit ${orderSide === 'BUY' ? 'is-buy' : 'is-sell'}`;
                submitBtn.textContent = orderSide === 'BUY' ? 'Log BUY to Portfolio' : 'Log SELL Exit to Portfolio';
            }
        };

        if (buyBtn) buyBtn.addEventListener('click', () => syncSide('BUY'));
        if (sellBtn) sellBtn.addEventListener('click', () => syncSide('SELL'));

        if (typeSelect) {
            typeSelect.addEventListener('change', () => {
                if (limitWrap) limitWrap.classList.toggle('hidden', typeSelect.value !== 'LIMIT');
                recalcOrderTicketValue();
            });
        }
        if (qtyInput) qtyInput.addEventListener('input', recalcOrderTicketValue);
        if (limitInput) limitInput.addEventListener('input', recalcOrderTicketValue);

        document.querySelectorAll('.cc-qty-chip').forEach(btn => {
            btn.addEventListener('click', () => {
                if (!qtyInput) return;
                const add = parseInt(btn.dataset.add || '0', 10);
                qtyInput.value = String(Math.max(1, (parseInt(qtyInput.value, 10) || 0) + add));
                recalcOrderTicketValue();
            });
        });

        if (samcoBtn) {
            samcoBtn.addEventListener('click', () => {
                document.getElementById('tab-samco-web')?.click();
            });
        }

        if (submitBtn) {
            submitBtn.addEventListener('click', async () => {
                const sym = (window.candleTabState?.symbol || '^NSEI').replace(/^\^/, '');
                const qty = Math.max(1, parseInt(qtyInput?.value || '1', 10) || 1);
                const isLimit = typeSelect && typeSelect.value === 'LIMIT';
                const price = isLimit && limitInput && Number(limitInput.value) > 0
                    ? Number(limitInput.value)
                    : getLiveCmpForCandleSymbol(window.candleTabState?.symbol || '^NSEI');

                if (!Number.isFinite(price) || price <= 0) {
                    window.showNotification?.('Live price not available yet for order logging.', 'error');
                    return;
                }

                const todayIso = new Date().toISOString().slice(0, 10);
                const payload = {
                    companySymbol: sym,
                    buyDate: todayIso,
                    quantity: qty,
                    buyRate: Number(price.toFixed(2)),
                    sellDate: orderSide === 'SELL' ? todayIso : '',
                    sellRate: orderSide === 'SELL' ? Number(price.toFixed(2)) : null
                };

                if (typeof window.savePortfolioItem === 'function') {
                    await window.savePortfolioItem(payload);
                }

                const recentList = document.getElementById('cc-recent-orders-list');
                if (recentList) {
                    const row = document.createElement('div');
                    row.className = 'cc-recent-order-item';
                    row.innerHTML = `
                        <span class="cc-ro-side ${orderSide === 'BUY' ? 'profit-text' : 'loss-text'}">${orderSide}</span>
                        <strong>${escapeSimple(sym)}</strong>
                        <span>${qty} @ ${Number(price).toFixed(2)}</span>
                    `;
                    recentList.prepend(row);
                    while (recentList.children.length > 5) {
                        recentList.lastElementChild?.remove();
                    }
                }
            });
        }

        syncSide('BUY');
    }

    // ---------------------------------------------------------------------
    // 6. Command Palette (Cmd/Ctrl + K) & Settings Modal
    // ---------------------------------------------------------------------
    function getCommandAssets() {
        const list = [...DEFAULT_QUICK_ASSETS];
        const seen = new Set(list.map(x => x.sym));
        const st = window.state;
        if (st && Array.isArray(st.processedMasterData) && st.symbolColIndex !== -1) {
            for (let i = 1; i < Math.min(st.processedMasterData.length, 600); i++) {
                const sym = String(st.processedMasterData[i][st.symbolColIndex] || '').trim().toUpperCase();
                if (sym && !seen.has(sym)) {
                    seen.add(sym);
                    list.push({ sym, label: sym, group: 'Master Excel' });
                }
            }
        }
        return list;
    }

    function openCommandPalette() {
        const modal = document.getElementById('command-palette-modal');
        const input = document.getElementById('cmd-palette-input');
        if (!modal) return;
        modal.classList.remove('hidden');
        renderCommandResults('');
        setTimeout(() => input?.focus(), 20);
    }

    function closeCommandPalette() {
        document.getElementById('command-palette-modal')?.classList.add('hidden');
    }

    function renderCommandResults(query) {
        const resultsEl = document.getElementById('cmd-palette-results');
        if (!resultsEl) return;
        const q = String(query || '').trim().toUpperCase();
        const assets = getCommandAssets();
        const matched = q
            ? assets.filter(a => a.sym.toUpperCase().includes(q) || a.label.toUpperCase().includes(q)).slice(0, 14)
            : assets.slice(0, 12);

        if (matched.length === 0 && q) {
            resultsEl.innerHTML = `
                <button type="button" class="cmd-item" data-cmd-sym="${escapeSimple(q)}">
                    <div><strong>${escapeSimple(q)}</strong><span>Open custom symbol in Candle Chart</span></div>
                    <kbd>Enter</kbd>
                </button>
            `;
            return;
        }

        resultsEl.innerHTML = matched.map(a => `
            <button type="button" class="cmd-item" data-cmd-sym="${escapeSimple(a.sym)}">
                <div><strong>${escapeSimple(a.sym)}</strong><span>${escapeSimple(a.label)}</span></div>
                <span class="cmd-group-tag">${escapeSimple(a.group)}</span>
            </button>
        `).join('');
    }

    function initCommandPaletteAndSettings() {
        const trigger = document.getElementById('topbar-cmd-trigger');
        const modal = document.getElementById('command-palette-modal');
        const input = document.getElementById('cmd-palette-input');
        const resultsEl = document.getElementById('cmd-palette-results');
        const closeBtn = document.getElementById('cmd-palette-close');

        if (trigger) trigger.addEventListener('click', openCommandPalette);
        if (closeBtn) closeBtn.addEventListener('click', closeCommandPalette);
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) closeCommandPalette();
            });
        }
        if (input) {
            input.addEventListener('input', () => renderCommandResults(input.value));
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const first = resultsEl?.querySelector('.cmd-item[data-cmd-sym]');
                    const sym = first?.dataset.cmdSym || input.value.trim().toUpperCase();
                    if (sym && typeof window.openSymbolInCandleChart === 'function') {
                        closeCommandPalette();
                        window.openSymbolInCandleChart(sym);
                    }
                } else if (e.key === 'Escape') {
                    closeCommandPalette();
                }
            });
        }
        if (resultsEl) {
            resultsEl.addEventListener('click', (e) => {
                const item = e.target.closest('.cmd-item[data-cmd-sym]');
                if (!item) return;
                const sym = item.dataset.cmdSym;
                closeCommandPalette();
                if (sym && typeof window.openSymbolInCandleChart === 'function') {
                    window.openSymbolInCandleChart(sym);
                }
            });
        }

        document.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                openCommandPalette();
            } else if (e.key === 'Escape') {
                closeCommandPalette();
                document.getElementById('settings-modal')?.classList.add('hidden');
            }
        });

        // Settings modal & Theme toggle
        const themeBtn = document.getElementById('theme-toggle-btn');
        if (themeBtn) {
            themeBtn.addEventListener('click', () => {
                const next = getSavedTheme() === 'light' ? 'dark' : 'light';
                applyTheme(next);
            });
        }

        const settingsBtn = document.getElementById('open-settings-btn');
        const settingsModal = document.getElementById('settings-modal');
        const settingsClose = document.getElementById('settings-modal-close');
        const settingsSave = document.getElementById('settings-save-btn');
        const settingsPwdBtn = document.getElementById('settings-open-password-btn');

        if (settingsBtn && settingsModal) {
            settingsBtn.addEventListener('click', () => {
                const tfSel = document.getElementById('settings-tf-select');
                const themeSel = document.getElementById('settings-theme-select');
                const streamSel = document.getElementById('settings-stream-select');
                if (tfSel) tfSel.value = localStorage.getItem('rf_default_tf') || '10m';
                if (themeSel) themeSel.value = getSavedTheme();
                if (streamSel) streamSel.value = localStorage.getItem('rf_stream_pref') || 'ws';
                settingsModal.classList.remove('hidden');
            });
        }
        if (settingsClose && settingsModal) {
            settingsClose.addEventListener('click', () => settingsModal.classList.add('hidden'));
            settingsModal.addEventListener('click', (e) => {
                if (e.target === settingsModal) settingsModal.classList.add('hidden');
            });
        }
        if (settingsSave) {
            settingsSave.addEventListener('click', () => {
                const tfSel = document.getElementById('settings-tf-select');
                const themeSel = document.getElementById('settings-theme-select');
                const streamSel = document.getElementById('settings-stream-select');
                if (tfSel) {
                    localStorage.setItem('rf_default_tf', tfSel.value);
                    if (window.candleTabState) window.candleTabState.interval = tfSel.value;
                }
                if (themeSel) applyTheme(themeSel.value);
                if (streamSel) {
                    localStorage.setItem('rf_stream_pref', streamSel.value);
                    wsDisabledByUser = streamSel.value === 'http';
                    if (wsDisabledByUser && wsConn) {
                        try { wsConn.close(); } catch (_) {}
                    } else if (!wsDisabledByUser) {
                        connectMarketStream();
                    }
                }
                settingsModal?.classList.add('hidden');
                window.showNotification?.('Terminal preferences updated.', 'success');
            });
        }
        if (settingsPwdBtn) {
            settingsPwdBtn.addEventListener('click', () => {
                settingsModal?.classList.add('hidden');
                document.getElementById('change-password-btn')?.click();
            });
        }

        // Quick action buttons on Overview
        document.getElementById('ov-go-chart-btn')?.addEventListener('click', () => document.getElementById('tab-candle-chart')?.click());
        document.getElementById('ov-go-tips-btn')?.addEventListener('click', () => document.getElementById('tab-option-tips')?.click());
        document.getElementById('ov-go-portfolio-btn')?.addEventListener('click', () => document.getElementById('tab-portfolio')?.click());
        document.getElementById('ov-go-samco-btn')?.addEventListener('click', () => document.getElementById('tab-samco-web')?.click());
    }

    document.addEventListener('DOMContentLoaded', () => {
        applyTheme(getSavedTheme());
        initSidebarNavigation();
        initOrderTicket();
        initCommandPaletteAndSettings();
        updateActiveWorkspaceTitle();
        refreshLucideIcons();
    });

    window.RfTerminalUI = {
        connectMarketStream,
        isMarketStreamWsActive,
        renderMarketOverview,
        refreshOverviewWidgets,
        updateOrderTicketSymbolContext,
        updateActiveWorkspaceTitle,
        refreshLucideIcons,
        applyTheme
    };
})();
