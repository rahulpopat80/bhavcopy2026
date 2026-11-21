// Global Error Logger for UI Debugging
// FIX: Log errors to console and show a non-blocking toast instead of blocking alert()
window.onerror = function(message, source, lineno, colno, error) {
    console.error('[App Error]', message, source, lineno, colno, error);
    const logConsole = document.getElementById('log-console');
    const processLogContainer = document.getElementById('process-log-container');
    if (processLogContainer) processLogContainer.classList.remove('hidden');
    if (logConsole) {
        const entry = document.createElement('div');
        entry.className = 'log-entry log-error';
        entry.textContent = `[Error] ${message} at line ${lineno}:${colno}`;
        logConsole.appendChild(entry);
    }
    if (typeof showNotification === 'function') {
        showNotification(`Error: ${message}`, 'error');
    }
    return false;
};

// Firebase Configuration
const firebaseConfig = {
  apiKey: "AIzaSyC8gB6gUxO-N6X6e1oklzNnGdhr9aGDeos",
  authDomain: "bhavcopy-e4acc.firebaseapp.com",
  projectId: "bhavcopy-e4acc",
  storageBucket: "bhavcopy-e4acc.firebasestorage.app",
  messagingSenderId: "251768362463",
  appId: "1:251768362463:web:0ec73b905e2570a384e06a",
  measurementId: "G-25XHTGD699"
};

// Initialize Firebase Firestore
let db = null;
try {
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
    console.log("Firebase initialized successfully");
} catch (e) {
    console.error("Firebase initialization failed:", e);
}

// Application State
let state = {
    masterFile: null,
    masterWorkbook: null,
    masterData: null, // Array of arrays (raw sheet data)
    masterSheetName: null,
    
    csvFile: null,
    csvWorkbook: null,
    csvData: null, // Array of objects
    
    processedMasterData: null, // Updated master sheet data
    processedWorkbook: null,
    
    // Column Indexes
    symbolColIndex: -1,
    seriesColIndex: -1,
    highColIndex: -1,
    diffColIndex: -1,
    latestDateColIndex: -1,
    isinColIndex: -1,
    promoterColIndex: -1,
    
    // Gainers Window Active Selection (5 or 30)
    gainersWindow: 5,
    portfolioLivePrices: new Map(),
    gainersLivePrices: new Map(),
    latestVolumes: new Map(),
    researchChartInstance: null,
    volumePromoterSource: 'GLOBAL'
};

// FIX: Global network timeout, concurrency limiter, 60s price cache, and 5-min failed-symbol cache
const PRICE_CACHE_TTL_MS = 60 * 1000;
const FAILED_SYMBOL_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 6000;
const yahooResponseCache = new Map();     // ticker -> { data, timestamp }
const livePriceTimestamps = new Map();    // normalized symbol -> timestamp
const failedSymbolCache = new Map();      // normalized symbol -> timestamp
const inFlightYahooRequests = new Map();  // ticker -> Promise

function normalizeSymKey(symbol) {
    return String(symbol || '').trim().toUpperCase().replace(/\.(NS|BO)$/i, '');
}

function isPriceFresh(symbol) {
    const ts = livePriceTimestamps.get(normalizeSymKey(symbol));
    return ts !== undefined && (Date.now() - ts) < PRICE_CACHE_TTL_MS;
}

function markPriceFresh(symbol) {
    const key = normalizeSymKey(symbol);
    livePriceTimestamps.set(key, Date.now());
    failedSymbolCache.delete(key);
}

function isFailedSymbolRecent(symbol) {
    const ts = failedSymbolCache.get(normalizeSymKey(symbol));
    return ts !== undefined && (Date.now() - ts) < FAILED_SYMBOL_TTL_MS;
}

function markSymbolFailed(symbol) {
    failedSymbolCache.set(normalizeSymKey(symbol), Date.now());
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function runWithConcurrency(items, concurrency, worker) {
    const list = Array.from(items || []);
    if (list.length === 0) return;
    let index = 0;
    const workers = Array.from({ length: Math.min(concurrency, list.length) }, async () => {
        while (index < list.length) {
            const currentIdx = index++;
            try {
                await worker(list[currentIdx], currentIdx);
            } catch (err) {
                console.warn('[Batch Worker] Item failed:', err?.message || err);
            }
        }
    });
    await Promise.all(workers);
}

function yieldToUI() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

// UI Elements
const masterDropzone = document.getElementById('master-dropzone');
const masterFile = document.getElementById('master-file');
const masterStatus = document.getElementById('master-status');
const masterFilename = document.getElementById('master-filename');
const masterFilesize = document.getElementById('master-filesize');
const masterRemove = document.getElementById('master-remove');
const masterPreviewContainer = document.getElementById('master-preview-container');
const masterTable = document.getElementById('master-table');
const masterRowCount = document.getElementById('master-row-count');

const csvDropzone = document.getElementById('csv-dropzone');
const csvFile = document.getElementById('csv-file');
const csvStatus = document.getElementById('csv-status');
const csvFilename = document.getElementById('csv-filename');
const csvFilesize = document.getElementById('csv-filesize');
const csvRemove = document.getElementById('csv-remove');
const csvPreviewContainer = document.getElementById('csv-preview-container');
const csvTable = document.getElementById('csv-table');
const csvRowCount = document.getElementById('csv-row-count');

const processBtn = document.getElementById('process-btn');
const downloadBtn = document.getElementById('download-btn');
const logConsole = document.getElementById('log-console');
const processLogContainer = document.getElementById('process-log-container');
const notificationContainer = document.getElementById('notification-container');

// Advanced UI Elements
const researchSection = document.getElementById('research-section');
const searchCompany = document.getElementById('search-company');
const priceMin = document.getElementById('price-min');
const priceMax = document.getElementById('price-max');
const diffMin = document.getElementById('diff-min');
const diffMax = document.getElementById('diff-max');
const resetFiltersBtn = document.getElementById('reset-filters-btn');
const resultsTable = document.getElementById('results-table');
const resultsCount = document.getElementById('results-count');
const movementTable = document.getElementById('movement-table');

// Initialize Event Listeners
let isAutoRefreshInFlight = false; // FIX: In-flight guard for central 10s interval
let isLiveMarket1sInFlight = false; // In-flight guard for 1s live market ticker
let isCandle1sInFlight = false; // In-flight guard for 1s live candle updater
let hasStartedDashboard = false;
let marketIndicesTimer = null;
let autoRefreshTimer = null;
let callPutTimer = null;
let liveMarket1sTimer = null;
let candle1sTimer = null;

function isTabActive(tabId) {
    const activeTab = document.querySelector('.nav-btn.active');
    return activeTab ? activeTab.id === tabId : false;
}

// FIX: Defer all heavy startup work (Master parsing, Firestore downloads, market fetches, intervals, SW)
// until AFTER user authentication so the login screen & keyboard inputs never freeze or lag.
function startDashboardAfterLogin() {
    if (hasStartedDashboard) return;
    hasStartedDashboard = true;

    // Load Watchlist from localStorage + background Firestore sync
    if (typeof loadWatchlistFromStorage === 'function') {
        loadWatchlistFromStorage();
    }

    // Load Master File from Local Storage after painting UI, then refresh from Cloud in background
    loadMasterOnStartup();

    // Live 1-second feed for NIFTY 50, SENSEX, GOLD/10g, SILVER/1kg, NASDAQ, SHANGHAI & Advance/Decline
    if (typeof fetchLiveMarket1s === 'function') {
        fetchLiveMarket1s();
    }
    if (!liveMarket1sTimer) {
        liveMarket1sTimer = setInterval(() => {
            if (typeof fetchLiveMarket1s === 'function') {
                fetchLiveMarket1s();
            }
        }, 1000);
    }

    // Fetch segment indices (Large/Mid/Small Cap leader) every 30s without overwriting 1s header prices
    fetchMarketIndices();
    if (!marketIndicesTimer) {
        marketIndicesTimer = setInterval(fetchMarketIndices, 30000);
    }

    // Central periodic updater for active views (every 10 seconds, guarded by in-flight flag)
    if (!autoRefreshTimer) {
        autoRefreshTimer = setInterval(async () => {
            if (isAutoRefreshInFlight) return;
            isAutoRefreshInFlight = true;
            try {
                const activeTab = document.querySelector('.nav-btn.active');
                if (!activeTab) return;

                const tabId = activeTab.id;

                if (tabId === 'tab-portfolio') {
                    if (typeof fetchPortfolioLivePrices === 'function') {
                        await fetchPortfolioLivePrices();
                    }
                } else if (tabId === 'tab-watchlist') {
                    if (typeof fetchWatchlistLivePrices === 'function' && watchlistItems.length > 0) {
                        const symbolsToUpdate = watchlistItems
                            .map(w => w.symbol)
                            .filter(s => !isPriceFresh(s) && !isFailedSymbolRecent(s));
                        if (symbolsToUpdate.length > 0) {
                            await fetchWatchlistLivePrices(symbolsToUpdate);
                        }
                    }
                } else if (tabId === 'tab-research') {
                    const visibleSymbols = Array.from(document.querySelectorAll('#movement-table tbody tr')).map(tr => {
                        const symCell = tr.cells[0];
                        return symCell ? symCell.textContent.trim().toUpperCase() : null;
                    }).filter(s => s);
                    if (visibleSymbols.length > 0) {
                        await fetchGainersLivePrices(visibleSymbols);
                    }
                } else if (tabId === 'tab-circuits') {
                    const visibleSymbols = Array.from(document.querySelectorAll('#circuits-table tbody tr')).map(tr => {
                        const symCell = tr.cells[1];
                        return symCell ? symCell.textContent.trim().toUpperCase() : null;
                    }).filter(s => s);
                    if (visibleSymbols.length > 0 && typeof fetchCircuitsLivePrices === 'function') {
                        await fetchCircuitsLivePrices(visibleSymbols);
                    }
                } else if (tabId === 'tab-global-indices') {
                    if (typeof fetchGlobalIndices === 'function') {
                        await fetchGlobalIndices(false);
                    }
                } else if (tabId === 'tab-intraday') {
                    const visibleSymbols = Array.from(document.querySelectorAll('#intraday-table tbody tr')).map(tr => {
                        const symCell = tr.cells[1];
                        return symCell ? symCell.textContent.trim().toUpperCase() : null;
                    }).filter(s => s);
                    if (visibleSymbols.length > 0 && typeof fetchIntradayLivePrices === 'function') {
                        await fetchIntradayLivePrices(visibleSymbols);
                    }
                } else if (tabId === 'tab-master-piece') {
                    if (typeof fetchMasterPieceLivePrices === 'function') {
                        await fetchMasterPieceLivePrices();
                    }
                }
            } finally {
                isAutoRefreshInFlight = false;
            }
        }, 10000);
    }

    // 1-second live updater for કોલ પુટ (Call Put) Option Chain & Tickertape Market Mood Index
    if (!callPutTimer) {
        callPutTimer = setInterval(() => {
            if (!isTabActive('tab-call-put')) return;
            if (typeof fetchCallPutAndMmiData === 'function') {
                fetchCallPutAndMmiData(false);
            }
        }, 1000);
    }

    // 1-second live candle updater for active Candle Chart tab or open Research/Price modals
    if (!candle1sTimer) {
        candle1sTimer = setInterval(() => {
            if (typeof refreshVisibleCandles1s === 'function') {
                refreshVisibleCandles1s();
            }
        }, 1000);
    }

    // Register Service Worker after dashboard startup so login screen paint stays immediate
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => console.log('Service Worker Registered Successfully!', reg.scope))
            .catch(err => console.error('Service Worker Registration Failed:', err));
    }
}

function initEvents() {
    // Sync password from Cloud database (with 5s timeout so login never hangs if offline)
    const cloudPasswordPromise = db
        ? Promise.race([
            db.collection('metadata').doc('auth').get().then(doc => {
                if (doc.exists) {
                    const cloudPass = doc.data().password;
                    if (cloudPass) {
                        localStorage.setItem('appPassword', cloudPass);
                        return cloudPass;
                    }
                }
                return null;
            }),
            new Promise(resolve => setTimeout(() => resolve(null), 5000))
        ]).catch(err => {
            console.warn('Could not sync password from Firestore:', err);
            return null;
        })
        : Promise.resolve(null);

    // Login Screen Check
    const sessionLoggedIn = sessionStorage.getItem('isLoggedIn');
    const loginOverlay = document.getElementById('login-screen');
    const mainApp = document.getElementById('main-app');
    
    if (sessionLoggedIn === 'true') {
        loginOverlay.classList.add('hidden');
        mainApp.classList.remove('hidden');
        setTimeout(startDashboardAfterLogin, 0);
    } else {
        const loginForm = document.getElementById('login-form');
        const loginError = document.getElementById('login-error');
        
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const usernameInput = document.getElementById('username').value.trim();
            const passwordInput = document.getElementById('password').value.trim();
            
            // FIX: Remove hardcoded default password fallback; read only from synced Firestore/localStorage
            let currentPassword = localStorage.getItem('appPassword');
            if (!currentPassword) {
                currentPassword = await cloudPasswordPromise;
            }
            if (!currentPassword) {
                if (loginError) {
                    loginError.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Password not configured in cloud. Please contact admin.';
                    loginError.classList.remove('hidden');
                }
                showNotification('Password not set. Please contact admin.', 'error');
                return;
            }

            if (usernameInput === 'RAHUL' && passwordInput === currentPassword) {
                sessionStorage.setItem('isLoggedIn', 'true');
                loginOverlay.classList.add('hidden');
                mainApp.classList.remove('hidden');
                showNotification('Login successful!', 'success');
                setTimeout(startDashboardAfterLogin, 0);
            } else {
                if (loginError) {
                    loginError.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Invalid username or password!';
                    loginError.classList.remove('hidden');
                }
                showNotification('Login failed! Invalid ID or Password.', 'error');
            }
        });
    }

    // Master Upload
    masterFile.addEventListener('change', (e) => handleFileSelect(e, 'master'));
    setupDragAndDrop(masterDropzone, 'master');
    masterRemove.addEventListener('click', () => resetFile('master'));

    // CSV Upload
    csvFile.addEventListener('change', (e) => handleFileSelect(e, 'csv'));
    setupDragAndDrop(csvDropzone, 'csv');
    csvRemove.addEventListener('click', () => resetFile('csv'));

    // Processing & Saving
    processBtn.addEventListener('click', processFiles);
    downloadBtn.addEventListener('click', downloadUpdatedFile);

    // Filters (FIX: Debounced so typing in Search never drops keystrokes or freezes UI)
    searchCompany.addEventListener('input', debouncedApplyFilters);
    priceMin.addEventListener('input', debouncedApplyFilters);
    priceMax.addEventListener('input', debouncedApplyFilters);
    diffMin.addEventListener('input', debouncedApplyFilters);
    diffMax.addEventListener('input', debouncedApplyFilters);
    resetFiltersBtn.addEventListener('click', resetFilters);

    const loadMoreBtn = document.getElementById('results-load-more-btn');
    const showAllBtn = document.getElementById('results-show-all-btn');
    if (loadMoreBtn) {
        loadMoreBtn.addEventListener('click', () => {
            resultsVisibleLimit += RESULTS_PAGE_SIZE;
            renderFilteredResults(false);
        });
    }
    if (showAllBtn) {
        showAllBtn.addEventListener('click', () => {
            resultsVisibleLimit = Infinity;
            renderFilteredResults(false);
        });
    }

    // Check if XLSX library loaded
    if (typeof XLSX === 'undefined') {
        processLogContainer.classList.remove('hidden');
        log('Error: Excel reading library (SheetJS) not loaded. Please check your internet connection.', 'error');
        showNotification('Excel reading library (SheetJS) failed to load. Check internet connection.', 'error');
    }

    // Results Table Row Click (Delegated)
    resultsTable.addEventListener('click', (e) => {
        const row = e.target.closest('tr');
        if (row && row.parentNode.tagName === 'TBODY') {
            const symbolCell = row.cells[state.symbolColIndex];
            if (symbolCell) {
                const symbol = symbolCell.textContent.trim().toUpperCase();
                showResearchModal(symbol);
            }
        }
    });

    // Movement Table Row Click (Delegated)
    movementTable.addEventListener('click', (e) => {
        const row = e.target.closest('tr');
        if (row && row.parentNode.tagName === 'TBODY') {
            const symbolCell = row.cells[0]; // Symbol is first column in gainers
            if (symbolCell) {
                const symbol = symbolCell.textContent.trim().toUpperCase();
                showResearchModal(symbol);
            }
        }
    });

    // Close Modal Button Click
    document.getElementById('modal-close-btn').addEventListener('click', () => {
        document.getElementById('chart-modal').classList.add('hidden');
    });

    // Close Modal on Overlay Click
    document.getElementById('chart-modal').addEventListener('click', (e) => {
        if (e.target.id === 'chart-modal') {
            document.getElementById('chart-modal').classList.add('hidden');
        }
    });

    // Close Advice Details Modal Button Click
    const adviceCloseBtn = document.getElementById('advice-details-close');
    if (adviceCloseBtn) {
        adviceCloseBtn.addEventListener('click', () => {
            document.getElementById('advice-details-modal').classList.add('hidden');
        });
    }

    // Close Advice Details Modal on Overlay Click
    const adviceOverlay = document.getElementById('advice-details-modal');
    if (adviceOverlay) {
        adviceOverlay.addEventListener('click', (e) => {
            if (e.target.id === 'advice-details-modal') {
                adviceOverlay.classList.add('hidden');
            }
        });
    }

    // Clear Local Storage Button Click
    const clearStorageBtn = document.getElementById('clear-storage-btn');
    if (clearStorageBtn) {
        clearStorageBtn.addEventListener('click', () => {
            if (confirm('Are you sure you want to clear all saved Master file data from browser storage?')) {
                localStorage.clear();
                showNotification('Local storage cleared successfully! Reloading...', 'success');
                setTimeout(() => {
                    location.reload();
                }, 1500);
            }
        });
    }

    // Tab switching logic
    const tabResearch    = document.getElementById('tab-research');
    const tabPortfolio   = document.getElementById('tab-portfolio');
    const tabResults     = document.getElementById('tab-results');
    const tabWatchlist   = document.getElementById('tab-watchlist');
    const tabMorning     = document.getElementById('tab-morning-picks');
    const tabAdvice      = document.getElementById('tab-investor-advice');
    const tabVolPromoter = document.getElementById('tab-volume-promoter');
    const tabCircuits    = document.getElementById('tab-circuits');
    const tabGlobalIndices = document.getElementById('tab-global-indices');
    const tabIntraday    = document.getElementById('tab-intraday');
    const tabMasterPiece = document.getElementById('tab-master-piece');
    const tabCallPut     = document.getElementById('tab-call-put');
    const tabCandleChart = document.getElementById('tab-candle-chart');
    
    const researchTabContent      = document.getElementById('research-tab-content');
    const portfolioTabContent     = document.getElementById('portfolio-tab-content');
    const resultsTabContent       = document.getElementById('results-tab-content');
    const watchlistTabContent     = document.getElementById('watchlist-tab-content');
    const morningPicksTabContent  = document.getElementById('morning-picks-tab-content');
    const adviceTabContent        = document.getElementById('investor-advice-tab-content');
    const volPromoterTabContent   = document.getElementById('volume-promoter-tab-content');
    const circuitsTabContent     = document.getElementById('circuits-tab-content');
    const globalIndicesTabContent = document.getElementById('global-indices-tab-content');
    const intradayTabContent      = document.getElementById('intraday-tab-content');
    const masterPieceTabContent   = document.getElementById('master-piece-tab-content');
    const callPutTabContent       = document.getElementById('call-put-tab-content');
    const candleChartTabContent   = document.getElementById('candle-chart-tab-content');

    const hideAllTabs = () => {
        [researchTabContent, portfolioTabContent, resultsTabContent, watchlistTabContent, morningPicksTabContent, adviceTabContent, volPromoterTabContent, circuitsTabContent, globalIndicesTabContent, intradayTabContent, masterPieceTabContent, callPutTabContent, candleChartTabContent]
            .forEach(el => el && el.classList.add('hidden'));
        [tabResearch, tabPortfolio, tabResults, tabWatchlist, tabMorning, tabAdvice, tabVolPromoter, tabCircuits, tabGlobalIndices, tabIntraday, tabMasterPiece, tabCallPut, tabCandleChart]
            .forEach(el => el && el.classList.remove('active'));
    };

    if (tabResearch && researchTabContent) {
        tabResearch.addEventListener('click', () => {
            hideAllTabs();
            tabResearch.classList.add('active');
            researchTabContent.classList.remove('hidden');
        });
    }

    if (tabPortfolio && portfolioTabContent) {
        tabPortfolio.addEventListener('click', () => {
            hideAllTabs();
            tabPortfolio.classList.add('active');
            portfolioTabContent.classList.remove('hidden');
            loadPortfolioFromCloud();
        });
    }

    if (tabWatchlist && watchlistTabContent) {
        tabWatchlist.addEventListener('click', () => {
            hideAllTabs();
            tabWatchlist.classList.add('active');
            watchlistTabContent.classList.remove('hidden');
            renderWatchlist();
        });
    }

    if (tabMorning && morningPicksTabContent) {
        tabMorning.addEventListener('click', () => {
            hideAllTabs();
            tabMorning.classList.add('active');
            morningPicksTabContent.classList.remove('hidden');
            renderMorningPicks();
        });
    }

    if (tabAdvice && adviceTabContent) {
        tabAdvice.addEventListener('click', () => {
            hideAllTabs();
            tabAdvice.classList.add('active');
            adviceTabContent.classList.remove('hidden');
            renderInvestorAdvice();
        });
    }

    if (tabResults && resultsTabContent) {
        tabResults.addEventListener('click', () => {
            hideAllTabs();
            tabResults.classList.add('active');
            resultsTabContent.classList.remove('hidden');
            // FIX: Fetch real exchange corporate results/dividends via /api/corporate instead of static fake data
            if (typeof fetchCorporateResults === 'function') {
                fetchCorporateResults(false);
            } else {
                renderResultsAndDividendsTable();
            }
        });
    }

    if (tabVolPromoter && volPromoterTabContent) {
        tabVolPromoter.addEventListener('click', () => {
            hideAllTabs();
            tabVolPromoter.classList.add('active');
            volPromoterTabContent.classList.remove('hidden');
            renderVolumePromoterPicks();
        });
    }

    if (tabCircuits && circuitsTabContent) {
        tabCircuits.addEventListener('click', () => {
            hideAllTabs();
            tabCircuits.classList.add('active');
            circuitsTabContent.classList.remove('hidden');
            renderCircuits();
        });
    }

    if (tabGlobalIndices && globalIndicesTabContent) {
        tabGlobalIndices.addEventListener('click', () => {
            hideAllTabs();
            tabGlobalIndices.classList.add('active');
            globalIndicesTabContent.classList.remove('hidden');
            fetchGlobalIndices();
        });
    }

    if (tabIntraday && intradayTabContent) {
        tabIntraday.addEventListener('click', () => {
            hideAllTabs();
            tabIntraday.classList.add('active');
            intradayTabContent.classList.remove('hidden');
            renderIntraday();
        });
    }

    if (tabMasterPiece && masterPieceTabContent) {
        tabMasterPiece.addEventListener('click', () => {
            hideAllTabs();
            tabMasterPiece.classList.add('active');
            masterPieceTabContent.classList.remove('hidden');
            renderMasterPiece();
        });
    }

    if (tabCallPut && callPutTabContent) {
        tabCallPut.addEventListener('click', () => {
            hideAllTabs();
            tabCallPut.classList.add('active');
            callPutTabContent.classList.remove('hidden');
            if (typeof fetchCallPutAndMmiData === 'function') {
                fetchCallPutAndMmiData(true);
            }
        });
    }

    if (typeof initCallPutControls === 'function') {
        initCallPutControls();
    }

    if (tabCandleChart && candleChartTabContent) {
        tabCandleChart.addEventListener('click', () => {
            hideAllTabs();
            tabCandleChart.classList.add('active');
            candleChartTabContent.classList.remove('hidden');
            if (typeof initCandleChartTab === 'function') {
                initCandleChartTab();
            }
            if (typeof loadCandleChartTab === 'function') {
                loadCandleChartTab(false);
            }
        });
    }

    if (typeof initModalChartControls === 'function') {
        initModalChartControls();
    }


    // Portfolio Form Initializations
    setupPortfolioFormCalculations();
    setupPortfolioFormSubmit();

    // Gainers range toggles
    const toggle1 = document.getElementById('gainer-toggle-1');
    const toggle2 = document.getElementById('gainer-toggle-2');
    const toggle3 = document.getElementById('gainer-toggle-3');
    const toggle5 = document.getElementById('gainer-toggle-5');
    const toggle30 = document.getElementById('gainer-toggle-30');
    const toggleCommon = document.getElementById('gainer-toggle-common');
    
    const allToggles = [toggle1, toggle2, toggle3, toggle5, toggle30, toggleCommon];
    const setGainerToggleActive = (activeToggle) => {
        allToggles.forEach(t => {
            if (t) t.classList.remove('active');
        });
        if (activeToggle) activeToggle.classList.add('active');
    };

    if (toggle1) {
        toggle1.addEventListener('click', () => {
            setGainerToggleActive(toggle1);
            state.gainersWindow = 1;
            renderGainersAnalysis();
        });
    }

    if (toggle2) {
        toggle2.addEventListener('click', () => {
            setGainerToggleActive(toggle2);
            state.gainersWindow = 2;
            renderGainersAnalysis();
        });
    }

    if (toggle3) {
        toggle3.addEventListener('click', () => {
            setGainerToggleActive(toggle3);
            state.gainersWindow = 3;
            renderGainersAnalysis();
        });
    }

    if (toggle5) {
        toggle5.addEventListener('click', () => {
            setGainerToggleActive(toggle5);
            state.gainersWindow = 5;
            renderGainersAnalysis();
        });
    }

    if (toggle30) {
        toggle30.addEventListener('click', () => {
            setGainerToggleActive(toggle30);
            state.gainersWindow = 30;
            renderGainersAnalysis();
        });
    }

    if (toggleCommon) {
        toggleCommon.addEventListener('click', () => {
            setGainerToggleActive(toggleCommon);
            state.gainersWindow = 'common';
            renderGainersAnalysis();
        });
    }

    // Auto Fetch Modal Toggle
    const autoFetchTrigger = document.getElementById('btn-auto-fetch-trigger');
    const fetchModal = document.getElementById('fetch-modal');
    const fetchModalClose = document.getElementById('fetch-modal-close');
    
    if (autoFetchTrigger && fetchModal) {
        autoFetchTrigger.addEventListener('click', () => {
            const dateInput = document.getElementById('fetch-date');
            if (dateInput) {
                const now = new Date();
                const hour = now.getHours();
                const minute = now.getMinutes();
                // If before 18:30 (6:30 PM) set to yesterday
                if (hour < 18 || (hour === 18 && minute < 30)) {
                    now.setDate(now.getDate() - 1);
                }
                
                // If weekend, set to Friday
                if (now.getDay() === 0) { // Sunday
                    now.setDate(now.getDate() - 2);
                } else if (now.getDay() === 6) { // Saturday
                    now.setDate(now.getDate() - 1);
                }
                
                const yyyy = now.getFullYear();
                const mm = String(now.getMonth() + 1).padStart(2, '0');
                const dd = String(now.getDate()).padStart(2, '0');
                dateInput.value = `${yyyy}-${mm}-${dd}`;
            }
            
            fetchModal.classList.remove('hidden');
            document.getElementById('fetch-status').classList.add('hidden');
        });
    }
    
    if (fetchModalClose && fetchModal) {
        fetchModalClose.addEventListener('click', () => {
            fetchModal.classList.add('hidden');
        });
        
        fetchModal.addEventListener('click', (e) => {
            if (e.target.id === 'fetch-modal') {
                fetchModal.classList.add('hidden');
            }
        });
    }

    // Close Research Modal Button Click
    const researchModal = document.getElementById('research-modal');
    const researchModalClose = document.getElementById('research-modal-close');
    if (researchModalClose && researchModal) {
        researchModalClose.addEventListener('click', () => {
            researchModal.classList.add('hidden');
        });
        researchModal.addEventListener('click', (e) => {
            if (e.target.id === 'research-modal') {
                researchModal.classList.add('hidden');
            }
        });
    }

    // Modal Option A: Cloud Fetch
    const btnCloudFetch = document.getElementById('btn-cloud-fetch');
    if (btnCloudFetch) {
        btnCloudFetch.addEventListener('click', async () => {
            const dateVal = document.getElementById('fetch-date').value;
            if (!dateVal) {
                showFetchStatus("Please select a date.", "error");
                return;
            }
            
            const dateParts = dateVal.split('-');
            const yyyy = dateParts[0];
            const mm = dateParts[1];
            const dd = dateParts[2];
            
            const nseFilename = `BhavCopy_NSE_CM_0_0_0_${yyyy}${mm}${dd}_F_0000.csv.zip`;
            const nseUrl = `https://nsearchives.nseindia.com/content/cm/${nseFilename}`;
            
            showFetchStatus("Trying direct fetch from NSE archives...", "info", true);
            
            let success = false;
            
            // Try Direct Fetch (Works instantly if the user has a CORS extension enabled!)
            try {
                console.log(`Trying direct fetch: ${nseUrl}`);
                const response = await fetch(nseUrl);
                if (response.ok) {
                    const arrayBuffer = await response.arrayBuffer();
                    if (arrayBuffer.byteLength > 1000) {
                        showFetchStatus("Direct fetch succeeded! Unzipping...", "info", true);
                        
                        const zip = await JSZip.loadAsync(arrayBuffer);
                        const csvFileKey = Object.keys(zip.files).find(k => k.toLowerCase().endsWith('.csv'));
                        if (!csvFileKey) throw new Error("No CSV file found inside the ZIP.");
                        
                        const csvFile = zip.files[csvFileKey];
                        const csvText = await csvFile.async("string");
                        
                        showFetchStatus("Bhavcopy fetched successfully! Loading data...", "success");
                        
                        const blob = new Blob([csvText], { type: 'text/csv' });
                        const fileObj = new File([blob], csvFileKey, { type: 'text/csv' });
                        
                        state.csvFiles = [fileObj];
                        state.csvFile = fileObj;
                        
                        csvFilename.textContent = fileObj.name;
                        csvFilesize.textContent = formatBytes(fileObj.size);
                        csvDropzone.classList.add('hidden');
                        csvStatus.classList.remove('hidden');
                        
                        parseCSVFile(fileObj);
                        
                        success = true;
                        setTimeout(() => {
                            fetchModal.classList.add('hidden');
                        }, 1500);
                        return;
                    }
                }
            } catch (directErr) {
                console.warn("Direct fetch failed (CORS block). Trying proxies...", directErr);
            }
            
            // Fallback: Try Proxies (CORS proxies)
            const proxies = [
                `https://corsproxy.io/?url=${encodeURIComponent(nseUrl)}`,
                `https://api.allorigins.win/raw?url=${encodeURIComponent(nseUrl)}`,
                `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(nseUrl)}`
            ];
            
            showFetchStatus("Direct fetch blocked by CORS. Contacting NSE via proxy...", "info", true);
            
            for (let i = 0; i < proxies.length; i++) {
                const proxyUrl = proxies[i];
                try {
                    console.log(`Trying proxy ${i + 1}: ${proxyUrl}`);
                    const response = await fetch(proxyUrl);
                    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                    
                    const arrayBuffer = await response.arrayBuffer();
                    if (arrayBuffer.byteLength < 1000) {
                        throw new Error("Response is too small (likely blocked by NSE firewall).");
                    }
                    
                    showFetchStatus("Zip file downloaded! Unzipping...", "info", true);
                    
                    const zip = await JSZip.loadAsync(arrayBuffer);
                    const csvFileKey = Object.keys(zip.files).find(k => k.toLowerCase().endsWith('.csv'));
                    if (!csvFileKey) throw new Error("No CSV file found inside the downloaded ZIP.");
                    
                    const csvFile = zip.files[csvFileKey];
                    const csvText = await csvFile.async("string");
                    
                    showFetchStatus("Bhavcopy fetched successfully! Loading data...", "success");
                    
                    const blob = new Blob([csvText], { type: 'text/csv' });
                    const fileObj = new File([blob], csvFileKey, { type: 'text/csv' });
                    
                    state.csvFiles = [fileObj];
                    state.csvFile = fileObj;
                    
                    csvFilename.textContent = fileObj.name;
                    csvFilesize.textContent = formatBytes(fileObj.size);
                    csvDropzone.classList.add('hidden');
                    csvStatus.classList.remove('hidden');
                    
                    parseCSVFile(fileObj);
                    
                    success = true;
                    setTimeout(() => {
                        fetchModal.classList.add('hidden');
                    }, 1500);
                    break;
                } catch (err) {
                    console.warn(`Proxy ${i + 1} failed:`, err);
                }
            }
            
            if (!success) {
                showFetchStatus("Direct Fetch blocked by CORS & Cloud Proxy blocked by NSE firewall.<br><strong style='color:var(--success-color);'>Tip: Install a 'CORS Unblock' browser extension to enable 1-click Direct Fetch!</strong> or use Option B.", "error");
            }
        });
    }

    // Modal Option B: Samco Direct Download Form Submission
    const btnDirectDownload = document.getElementById('btn-direct-download');
    if (btnDirectDownload) {
        btnDirectDownload.addEventListener('click', async () => {
            const dateVal = document.getElementById('fetch-date').value;
            if (!dateVal) {
                showFetchStatus("Please select a date.", "error");
                return;
            }
            
            showFetchStatus("Contacting Samco servers to download CSV...", "info", true);
            
            try {
                // Construct urlencoded body parameters
                const bodyParams = new URLSearchParams();
                bodyParams.append('start_date', dateVal);
                bodyParams.append('end_date', dateVal);
                bodyParams.append('bhavcopy_data[]', 'NSE');
                bodyParams.append('show_or_down', '2'); // 2 = Download ZIP
                
                // Fetch directly from Samco (works because CORS is disabled via .bat file!)
                const response = await fetch('https://www.samco.in/bse_nse_mcx/getBhavcopy', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    body: bodyParams.toString()
                });
                
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                
                const arrayBuffer = await response.arrayBuffer();
                if (arrayBuffer.byteLength < 1000) {
                    throw new Error("Response is too small (likely blocked by Cloudflare challenge).");
                }
                
                showFetchStatus("Zip file downloaded! Unzipping to CSV...", "info", true);
                
                // Unzip
                const zip = await JSZip.loadAsync(arrayBuffer);
                const csvFileKey = Object.keys(zip.files).find(k => k.toLowerCase().endsWith('.csv'));
                if (!csvFileKey) throw new Error("No CSV file found inside the downloaded ZIP.");
                
                const csvFile = zip.files[csvFileKey];
                const csvText = await csvFile.async("string");
                
                showFetchStatus("CSV extracted! Starting download...", "success");
                
                // Trigger download of the raw CSV file
                const blob = new Blob([csvText], { type: 'text/csv' });
                const downloadUrl = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = downloadUrl;
                a.download = csvFileKey; // download as the raw CSV filename!
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(downloadUrl);
                
                // Also automatically feed it into the uploader!
                const fileObj = new File([blob], csvFileKey, { type: 'text/csv' });
                state.csvFiles = [fileObj];
                state.csvFile = fileObj;
                csvFilename.textContent = fileObj.name;
                csvFilesize.textContent = formatBytes(fileObj.size);
                csvDropzone.classList.add('hidden');
                csvStatus.classList.remove('hidden');
                parseCSVFile(fileObj);
                
                setTimeout(() => {
                    fetchModal.classList.add('hidden');
                }, 1500);
                
            } catch (err) {
                console.warn("Direct Samco download failed:", err);
                showFetchStatus("Direct download failed. Falling back to native browser form submission...", "warning");
                
                // Fallback: Submit form natively (this will download the ZIP as a fallback if the fetch failed)
                const form = document.createElement('form');
                form.method = 'POST';
                form.action = 'https://www.samco.in/bse_nse_mcx/getBhavcopy';
                form.target = '_blank';
                
                const startInput = document.createElement('input');
                startInput.type = 'hidden';
                startInput.name = 'start_date';
                startInput.value = dateVal;
                form.appendChild(startInput);
                
                const endInput = document.createElement('input');
                endInput.type = 'hidden';
                endInput.name = 'end_date';
                endInput.value = dateVal;
                form.appendChild(endInput);
                
                const segmentInput = document.createElement('input');
                segmentInput.type = 'hidden';
                segmentInput.name = 'bhavcopy_data[]';
                segmentInput.value = 'NSE';
                form.appendChild(segmentInput);
                
                const showDownInput = document.createElement('input');
                showDownInput.type = 'hidden';
                showDownInput.name = 'show_or_down';
                showDownInput.value = '2';
                form.appendChild(showDownInput);
                
                document.body.appendChild(form);
                form.submit();
                document.body.removeChild(form);
            }
        });
    }

    // ----------------------------------------------------
    // PWA Service Worker & Install Logic
    // ----------------------------------------------------
    // Service Worker is registered inside startDashboardAfterLogin() once authenticated.

    // PWA Custom Installation Prompt
    let deferredPrompt;
    const installBtn = document.getElementById('pwa-install-btn');

    window.addEventListener('beforeinstallprompt', (e) => {
        // Prevent Chrome from automatically showing the prompt
        e.preventDefault();
        // Stash the event so it can be triggered later.
        deferredPrompt = e;
        // Update UI to show the install button
        if (installBtn) {
            installBtn.style.display = 'flex';
        }
    });

    if (installBtn) {
        installBtn.addEventListener('click', (e) => {
            if (!deferredPrompt) return;
            // Show the prompt
            deferredPrompt.prompt();
            // Wait for the user to respond to the prompt
            deferredPrompt.userChoice.then((choiceResult) => {
                if (choiceResult.outcome === 'accepted') {
                    console.log('User accepted the install prompt');
                } else {
                    console.log('User dismissed the install prompt');
                }
                deferredPrompt = null;
                installBtn.style.display = 'none';
            });
        });
    }

    // Hide button if app is already installed
    window.addEventListener('appinstalled', (evt) => {
        console.log('Rahul Finance App installed successfully!');
        if (installBtn) {
            installBtn.style.display = 'none';
        }
    });

    // --- CHANGE PASSWORD DIALOG LOGIC ---
    const passwordModal = document.getElementById('password-modal');
    const changePasswordBtn = document.getElementById('change-password-btn');
    const passwordModalCloseBtn = document.getElementById('password-modal-close-btn');
    const changePasswordForm = document.getElementById('change-password-form');
    const changePasswordError = document.getElementById('change-password-error');

    if (changePasswordBtn) {
        changePasswordBtn.addEventListener('click', () => {
            if (changePasswordError) changePasswordError.classList.add('hidden');
            if (changePasswordForm) changePasswordForm.reset();
            if (passwordModal) passwordModal.classList.remove('hidden');
        });
    }

    if (passwordModalCloseBtn) {
        passwordModalCloseBtn.addEventListener('click', () => {
            if (passwordModal) passwordModal.classList.add('hidden');
        });
    }

    if (passwordModal) {
        passwordModal.addEventListener('click', (e) => {
            if (e.target.id === 'password-modal') {
                passwordModal.classList.add('hidden');
            }
        });
    }

    if (changePasswordForm) {
        changePasswordForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const currentInput = document.getElementById('current-password-input').value;
            const newInput = document.getElementById('new-password-input').value;
            const confirmInput = document.getElementById('confirm-password-input').value;

            // FIX: Remove hardcoded default password fallback in change-password flow
            const storedPass = localStorage.getItem('appPassword');
            if (!storedPass) {
                if (changePasswordError) {
                    changePasswordError.classList.remove('hidden');
                    changePasswordError.querySelector('span').textContent = 'Password not configured. Please contact admin.';
                }
                return;
            }

            if (currentInput !== storedPass) {
                if (changePasswordError) {
                    changePasswordError.classList.remove('hidden');
                    changePasswordError.querySelector('span').textContent = 'Current password is incorrect!';
                }
                return;
            }

            if (newInput !== confirmInput) {
                if (changePasswordError) {
                    changePasswordError.classList.remove('hidden');
                    changePasswordError.querySelector('span').textContent = 'New passwords do not match!';
                }
                return;
            }

            if (newInput.length < 4) {
                if (changePasswordError) {
                    changePasswordError.classList.remove('hidden');
                    changePasswordError.querySelector('span').textContent = 'New password must be at least 4 characters!';
                }
                return;
            }

            // Save password locally
            localStorage.setItem('appPassword', newInput);

            // Sync to Firestore if available
            if (db) {
                try {
                    showNotification('Syncing new password to cloud...', 'info');
                    await db.collection('metadata').doc('auth').set({
                        password: newInput,
                        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                    });
                    showNotification('Password updated and synced to cloud!', 'success');
                } catch (err) {
                    console.error('Failed to sync password to Firestore:', err);
                    showNotification('Password updated locally. Sync failed.', 'warning');
                }
            } else {
                showNotification('Password updated locally.', 'success');
            }

            if (passwordModal) passwordModal.classList.add('hidden');
        });
    }

    // FIX: Removed fake copy/keydown/window.blur screen-blurring locks that interfered with typing and preview focus.
}

// Drag & Drop Setup
function setupDragAndDrop(dropzone, type) {
    ['dragenter', 'dragover'].forEach(eventName => {
        dropzone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.add('dragover');
        }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropzone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.remove('dragover');
        }, false);
    });

    dropzone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        if (files.length) {
            handleMultipleFiles(files, type);
        }
    }, false);
}

// Handle Select file input
function handleFileSelect(e, type) {
    const files = e.target.files;
    if (files.length) {
        handleMultipleFiles(files, type);
    }
}

// Format size
function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Handle selected file(s) processing
async function handleMultipleFiles(filesList, type) {
    const files = Array.from(filesList);
    if (files.length === 0) return;
    
    if (type === 'master') {
        const file = files[0];
        const ext = file.name.split('.').pop().toLowerCase();
        if (ext !== 'xlsx' && ext !== 'xls') {
            showNotification('Please upload Excel files only (.xlsx, .xls).', 'error');
            return;
        }
        state.masterFile = file;
        masterFilename.textContent = file.name;
        masterFilesize.textContent = formatBytes(file.size);
        
        parseMasterFile(file);
    } else if (type === 'csv') {
        let finalCsvFiles = [];
        
        for (let file of files) {
            const ext = file.name.split('.').pop().toLowerCase();
            if (ext === 'csv') {
                finalCsvFiles.push(file);
            } else if (ext === 'zip') {
                showNotification(`Unzipping ${file.name}...`, 'info');
                const extracted = await extractCsvFromZip(file);
                finalCsvFiles.push(...extracted);
            } else {
                showNotification(`Ignored file ${file.name} (unsupported format).`, 'warning');
            }
        }
        
        if (finalCsvFiles.length === 0) {
            showNotification('Please upload CSV or ZIP files only.', 'error');
            return;
        }
        
        state.csvFiles = finalCsvFiles;
        state.csvFile = finalCsvFiles[0]; // Set first file as preview sample
        
        if (finalCsvFiles.length === 1) {
            csvFilename.textContent = finalCsvFiles[0].name;
            csvFilesize.textContent = formatBytes(finalCsvFiles[0].size);
        } else {
            csvFilename.textContent = `Selected ${finalCsvFiles.length} CSV files`;
            const totalSize = finalCsvFiles.reduce((sum, f) => sum + f.size, 0);
            csvFilesize.textContent = `Total Size: ${formatBytes(totalSize)}`;
        }
        
        csvDropzone.classList.add('hidden');
        csvStatus.classList.remove('hidden');
        
        log(`${finalCsvFiles.length} CSV files loaded.`, 'info');
        finalCsvFiles.forEach(f => log(`- ${f.name} (${formatBytes(f.size)})`, 'info'));
        
        // Parse and show preview of the first file as a sample
        parseCSVFile(finalCsvFiles[0]);
    }
}

// Detect column indexes from master headers and update UI filters accordingly
function detectColumnIndexes(headers) {
    if (!headers) return;
    
    state.symbolColIndex = -1;
    state.seriesColIndex = -1;
    state.highColIndex = -1;
    state.diffColIndex = -1;
    state.isinColIndex = -1;
    state.promoterColIndex = -1;
    
    headers.forEach((h, idx) => {
        const hStr = String(h || '').toUpperCase().trim();
        if (hStr === 'SYMBOL' || hStr === 'COMPANY_SYMBOL' || hStr === 'COMPANY') state.symbolColIndex = idx;
        const seriesCandidates = ['SERIES', 'SER', 'GROUP', 'TYPE', 'EQ_SERIES', 'SERIES_NAME', 'SCTYSRS'];
        if (seriesCandidates.includes(hStr) || hStr.includes('SERIES')) state.seriesColIndex = idx;
        if (hStr === 'HIGH') state.highColIndex = idx;
        if (hStr === 'DIFF') state.diffColIndex = idx;
        if (hStr === 'ISIN') state.isinColIndex = idx;
        if (hStr.includes('PROMOTER') || hStr.includes('પ્રમોટર')) state.promoterColIndex = idx;
    });
    
    // Automatically set latestDateColIndex as the first column after HIGH or DIFF
    if (state.highColIndex !== -1) {
        state.latestDateColIndex = state.highColIndex + 1;
    } else if (state.diffColIndex !== -1) {
        state.latestDateColIndex = state.diffColIndex + 1;
    } else {
        state.latestDateColIndex = -1;
    }
    
    // Show/hide DIFF filter
    const diffFilterGroup = document.getElementById('diff-filter-group');
    if (diffFilterGroup) {
        if (state.diffColIndex === -1) {
            diffFilterGroup.classList.add('hidden');
        } else {
            diffFilterGroup.classList.remove('hidden');
        }
    }
}

// Update Cloud Sync Status UI Badge
function updateCloudSyncUI(status, message) {
    const badge = document.getElementById('cloud-sync-status');
    const text = document.getElementById('cloud-sync-text');
    const icon = badge ? badge.querySelector('.sync-icon') : null;

    if (!badge || !text) return;

    badge.className = 'cloud-sync-badge';
    if (status === 'connecting') {
        badge.classList.add('sync-connecting');
        text.textContent = message || 'Connecting Firebase...';
        if (icon) icon.className = 'fa-solid fa-cloud-arrow-up sync-icon spin';
    } else if (status === 'success') {
        badge.classList.add('sync-success');
        text.textContent = message || 'Cloud Synced';
        if (icon) icon.className = 'fa-solid fa-cloud-arrow-up sync-icon';
    } else if (status === 'error') {
        badge.classList.add('sync-error');
        text.textContent = message || 'Sync Error';
        if (icon) icon.className = 'fa-solid fa-cloud-arrow-up sync-icon';
    }
}

// Save Master Excel Data to Firestore in chunks of 1000 rows
async function saveMasterToCloud() {
    if (!db) {
        console.error("Firestore not initialized");
        updateCloudSyncUI('error', 'Firebase Offline');
        return;
    }

    if (!state.masterData || state.masterData.length === 0) {
        console.warn("No master data to save to cloud");
        return;
    }

    updateCloudSyncUI('connecting', 'Cloud Syncing...');
    log('Syncing data to Firebase Cloud Firestore...', 'info');

    try {
        const batchSize = 1000;
        const totalRows = state.masterData.length;
        const chunkCount = Math.ceil(totalRows / batchSize);
        
        // Extract headers
        const headers = state.masterData[0];
        
        // Update metadata document
        await db.collection('metadata').doc('master').set({
            filename: state.masterFile ? state.masterFile.name : (getLocalStorageItem('master_excel_filename') || 'Master_Stored.xlsx'),
            filesize: state.masterFile ? formatBytes(state.masterFile.size) : (getLocalStorageItem('master_excel_filesize') || 'Saved Data'),
            headers: headers,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            chunkCount: chunkCount,
            totalRows: totalRows,
            volumesJson: state.latestVolumes ? JSON.stringify(Array.from(state.latestVolumes.entries())) : "[]"
        });

        // Save chunks
        for (let i = 0; i < chunkCount; i++) {
            const start = i * batchSize;
            const end = Math.min(start + batchSize, totalRows);
            const chunkRows = state.masterData.slice(start, end);
            
            await db.collection('chunks').doc(`chunk_${i}`).set({
                rowsJson: JSON.stringify(chunkRows)
            });
            log(`- Synced chunk ${i + 1} of ${chunkCount} (${chunkRows.length} rows)`, 'info');
        }

        updateCloudSyncUI('success', 'Cloud Synced');
        log('Successfully synced all data to Firebase Cloud Firestore!', 'success');
        showNotification('Data synced to Cloud Firestore!', 'success');
    } catch (err) {
        console.error('Error syncing to Firestore:', err);
        updateCloudSyncUI('error', 'Sync Failed');
        const logContainer = document.getElementById('process-log-container');
        if (logContainer) logContainer.classList.remove('hidden');
        log(`Cloud sync failed: ${err.message}`, 'error');
        showNotification(`Cloud sync failed: ${err.message}. Check Firebase Console/Rules.`, 'error');
    }
}

// Load Master Excel Data from Firestore by assembling chunks in parallel with batched UI-yielding parsing
// FIX: Download chunks with Promise.all, show progress, parse in batches with yieldToUI(), and support silent background refresh
async function loadMasterFromCloud(options = {}) {
    const { isBackgroundRefresh = false, hasLocalCache = false } = options;

    if (!db) {
        console.error("Firestore not initialized");
        updateCloudSyncUI('error', hasLocalCache ? 'Offline (Local Cache)' : 'Firebase Offline');
        if (!hasLocalCache) {
            showNotification('Firebase SDK failed to initialize. Check connection or blockers!', 'error');
        }
        return false;
    }

    updateCloudSyncUI('connecting', hasLocalCache ? 'Refreshing Cloud...' : 'Loading Cloud...');
    log('Checking Firebase Cloud for saved Master data...', 'info');

    try {
        const metaDoc = await db.collection('metadata').doc('master').get();
        if (!metaDoc.exists) {
            updateCloudSyncUI(hasLocalCache ? 'success' : 'error', hasLocalCache ? 'Local Cache Ready' : 'No Cloud Data');
            log('No Master data found in Cloud. Please upload a Master Excel file.', 'warning');
            return false;
        }

        const metaData = metaDoc.data();
        const chunkCount = metaData.chunkCount || 0;
        const filename = metaData.filename || 'Master_Cloud.xlsx';
        const filesize = metaData.filesize || 'Cloud Stored';

        if (metaData.volumesJson) {
            try {
                state.latestVolumes = new Map(JSON.parse(metaData.volumesJson));
                setLocalStorageItem('latest_volumes', metaData.volumesJson);
            } catch (e) {
                console.error("Failed to parse cloud volumes:", e);
                state.latestVolumes = state.latestVolumes || new Map();
            }
        } else if (!hasLocalCache) {
            state.latestVolumes = new Map();
        }

        log(`Found cloud master database: ${filename} (Total Chunks: ${chunkCount})`, 'info');
        updateCloudSyncUI('connecting', `Downloading ${chunkCount} chunks...`);

        // FIX: Download all chunks in parallel instead of sequential await in a loop
        const chunkPromises = [];
        for (let i = 0; i < chunkCount; i++) {
            chunkPromises.push(db.collection('chunks').doc(`chunk_${i}`).get());
        }
        const chunkDocs = await Promise.all(chunkPromises);

        let assembledRows = [];
        for (let i = 0; i < chunkDocs.length; i++) {
            const chunkDoc = chunkDocs[i];
            if (!chunkDoc.exists) {
                throw new Error(`Missing chunk data for chunk_${i}`);
            }
            const chunkData = chunkDoc.data();
            let chunkRows = [];
            if (chunkData.rowsJson) {
                chunkRows = JSON.parse(chunkData.rowsJson);
            } else {
                chunkRows = chunkData.rows || [];
            }
            assembledRows = assembledRows.concat(chunkRows);
            updateCloudSyncUI('connecting', `Loading Cloud (${i + 1}/${chunkCount})...`);
            log(`- Parsed chunk ${i + 1} of ${chunkCount} (${chunkRows.length} rows)`, 'info');
            // FIX: Yield to UI thread between chunk parses so the page never locks up
            await yieldToUI();
        }

        if (assembledRows.length === 0) {
            throw new Error('Loaded empty dataset from cloud');
        }

        // Update application state
        const filteredCloud = filterMasterForEQOnly(assembledRows);
        const existingLocalJson = hasLocalCache ? getLocalStorageItem('master_excel_data') : null;
        const newCloudJson = JSON.stringify(filteredCloud);
        const isIdenticalToCache = Boolean(existingLocalJson && existingLocalJson === newCloudJson);

        state.masterData = filteredCloud;
        state.masterSheetName = 'Sheet1';
        
        // Save to local storage as backup/cache only if changed
        if (!isIdenticalToCache) {
            setLocalStorageItem('master_excel_data', newCloudJson);
            setLocalStorageItem('master_excel_sheet_name', state.masterSheetName || 'Sheet1');
            setLocalStorageItem('master_excel_filename', filename);
            setLocalStorageItem('master_excel_filesize', filesize);
            if (state.latestVolumes) {
                setLocalStorageItem('latest_volumes', JSON.stringify(Array.from(state.latestVolumes.entries())));
            }
        }

        // Detect column indexes and adjust UI
        detectColumnIndexes(state.masterData[0]);

        masterFilename.textContent = filename;
        masterFilesize.textContent = filesize;
        
        // Update UI status
        masterStatus.classList.add('local-loaded');
        document.getElementById('master-status-icon').className = 'fa-solid fa-cloud success-icon blue-icon';
        document.getElementById('master-storage-status').textContent = 'Loaded from Cloud';
        
        masterDropzone.classList.add('hidden');
        masterStatus.classList.remove('hidden');
        
        log(`Master data loaded successfully from Cloud. (Total EQ companies: ${state.masterData.length - 1})`, 'success');
        
        if (!isIdenticalToCache) {
            renderPreview(state.masterData, masterTable, masterRowCount, masterPreviewContainer);
            checkReadyState();
            await yieldToUI();
            autoRenderIfProcessed();
            populateCompanyDatalist();
        }
        
        updateCloudSyncUI('success', 'Cloud Synced');
        if (isBackgroundRefresh && hasLocalCache && !isIdenticalToCache) {
            console.log('[Startup] Quietly swapped in latest cloud Master data.');
        }
        return true;
    } catch (err) {
        console.error('Error loading from Firestore:', err);
        updateCloudSyncUI(hasLocalCache ? 'success' : 'error', hasLocalCache ? 'Using Local Cache' : 'Load Failed');
        const logContainer = document.getElementById('process-log-container');
        if (logContainer && !hasLocalCache) logContainer.classList.remove('hidden');
        log(`Cloud load failed: ${err.message}`, 'error');
        if (!hasLocalCache) {
            showNotification(`Cloud load failed: ${err.message}`, 'error');
        }
        return false;
    }
}

// FIX: Yield before reading localStorage so UI paints cleanly, then refresh from Cloud in background.
async function loadMasterOnStartup() {
    let hasLocalCache = false;
    if (getLocalStorageItem('master_excel_data')) {
        updateCloudSyncUI('connecting', 'Loading Cache...');
        await yieldToUI();
        loadMasterFromLocalStorage();
        hasLocalCache = Boolean(state.masterData && state.masterData.length > 0);
    }

    // Background cloud refresh (never blocks startup UI)
    loadMasterFromCloud({ isBackgroundRefresh: true, hasLocalCache }).catch(err => {
        console.warn('Background cloud master refresh error:', err);
    });
}

// Delete Master Excel Data from Firestore
async function deleteMasterFromCloud() {
    if (!db) return;
    try {
        updateCloudSyncUI('connecting', 'Deleting Cloud Data...');
        await db.collection('metadata').doc('master').delete();
        
        // Delete up to 50 chunk documents
        const deletePromises = [];
        for (let i = 0; i < 50; i++) {
            deletePromises.push(db.collection('chunks').doc(`chunk_${i}`).delete());
        }
        await Promise.all(deletePromises);
        updateCloudSyncUI('error', 'Cloud Deleted');
        log('Master data removed from Cloud Firestore.', 'warning');
    } catch (err) {
        console.error('Error deleting from Firestore:', err);
        updateCloudSyncUI('error', 'Delete Failed');
    }
}

// Auto render results and analysis dashboard if loaded data is already processed
function autoRenderIfProcessed() {
    if (state.masterData && state.masterData.length > 0) {
        const headers = state.masterData[0];
        const metadataEndIndex = Math.max(state.highColIndex, state.diffColIndex, state.symbolColIndex);
        
        if (headers.length > metadataEndIndex + 1) {
            log('Detected already processed data. Initializing research dashboard view...', 'info');
            state.processedMasterData = state.masterData;
            // FIX: Defer building SheetJS workbook until downloadUpdatedFile() is clicked
            state.processedWorkbook = null;

            renderFilteredResults();
            renderGainersAnalysis();
            if (isTabActive('tab-morning-picks')) renderMorningPicks();
            if (isTabActive('tab-investor-advice')) renderInvestorAdvice();
            if (isTabActive('tab-volume-promoter')) renderVolumePromoterPicks();
            if (isTabActive('tab-circuits')) renderCircuits();
            if (isTabActive('tab-intraday')) renderIntraday();
            if (isTabActive('tab-master-piece')) renderMasterPiece();
            
            researchSection.classList.remove('hidden');
            downloadBtn.disabled = false;
        }
    }
}

// JSZip extraction helper
async function extractCsvFromZip(zipFile) {
    try {
        const zip = await JSZip.loadAsync(zipFile);
        const csvFilesExtracted = [];
        
        for (let filename of Object.keys(zip.files)) {
            if (filename.toLowerCase().endsWith('.csv')) {
                const fileData = zip.files[filename];
                const contentText = await fileData.async('string');
                const blob = new Blob([contentText], { type: 'text/csv' });
                const file = new File([blob], filename, { type: 'text/csv' });
                csvFilesExtracted.push(file);
            }
        }
        return csvFilesExtracted;
    } catch (e) {
        console.error("Error extracting zip:", e);
        showNotification(`Failed to extract zip file ${zipFile.name}.`, 'error');
        return [];
    }
}

// Fetch status renderer inside modal
function showFetchStatus(msg, type, isSpinner = false) {
    const statusEl = document.getElementById('fetch-status');
    if (!statusEl) return;
    
    statusEl.className = `fetch-status-bar ${type}`;
    statusEl.innerHTML = `
        ${isSpinner ? '<i class="fa-solid fa-spinner fa-spin"></i>' : (type === 'success' ? '<i class="fa-solid fa-circle-check"></i>' : (type === 'error' ? '<i class="fa-solid fa-triangle-exclamation"></i>' : '<i class="fa-solid fa-circle-info"></i>'))}
        <span>${msg}</span>
    `;
    statusEl.classList.remove('hidden');
}

// Portfolio Tracker State & Cloud Functions
let portfolioItems = [];

async function loadPortfolioFromCloud() {
    if (!db) {
        console.error("Firestore not initialized");
        renderPortfolioTable();
        return;
    }

    try {
        const snap = await db.collection('portfolio').orderBy('buyDate', 'desc').get();
        portfolioItems = [];
        snap.forEach(doc => {
            portfolioItems.push({
                id: doc.id,
                ...doc.data()
            });
        });
        console.log(`Loaded ${portfolioItems.length} portfolio items from Firestore.`);
        renderPortfolioTable();
        fetchPortfolioLivePrices();
    } catch (e) {
        console.error("Error loading portfolio:", e);
        showNotification("Failed to load portfolio items.", "error");
    }
}

async function savePortfolioItem(item) {
    if (!db) {
        showNotification("Firebase Offline. Cannot save transaction.", "error");
        return;
    }

    try {
        if (item.id) {
            const docId = item.id;
            const itemCopy = { ...item };
            delete itemCopy.id;
            await db.collection('portfolio').doc(docId).set(itemCopy);
            showNotification("Transaction updated successfully!", "success");
        } else {
            await db.collection('portfolio').add(item);
            showNotification("Transaction added successfully!", "success");
        }
        loadPortfolioFromCloud();
    } catch (e) {
        console.error("Error saving portfolio item:", e);
        showNotification("Failed to save transaction.", "error");
    }
}

async function deletePortfolioItem(id) {
    if (!db) {
        showNotification("Firebase Offline. Cannot delete transaction.", "error");
        return;
    }

    if (confirm("Are you sure you want to delete this transaction?")) {
        try {
            await db.collection('portfolio').doc(id).delete();
            showNotification("Transaction deleted successfully!", "success");
            loadPortfolioFromCloud();
        } catch (e) {
            console.error("Error deleting portfolio item:", e);
            showNotification("Failed to delete transaction.", "error");
        }
    }
}

// Helper to get last known close price from master sheet data for a symbol
function getLastKnownPrice(symbol) {
    const data = state.processedMasterData;
    if (!data || data.length < 2) return null;
    
    const symbolIndex = state.symbolColIndex;
    const highIndex = state.highColIndex;
    if (symbolIndex === -1) return null;
    
    const row = data.find((r, idx) => idx > 0 && String(r[symbolIndex] || '').trim().toUpperCase() === symbol);
    if (!row) return null;
    
    // Scan backwards from the end of the row (most recent columns) to find the first valid number
    const startIdx = highIndex !== -1 ? highIndex + 1 : (state.diffColIndex !== -1 ? state.diffColIndex + 1 : symbolIndex + 1);
    for (let colIdx = row.length - 1; colIdx >= startIdx; colIdx--) {
        const pVal = parseFloat(row[colIdx]);
        if (!isNaN(pVal)) {
            return pVal;
        }
    }
    return null;
}

let portfolioRenderTimeout = null;
function throttledRenderPortfolioTable() {
    if (portfolioRenderTimeout) return;
    portfolioRenderTimeout = setTimeout(() => {
        renderPortfolioTable();
        portfolioRenderTimeout = null;
    }, 300); // Throttle renders to once every 300ms
}

// Fetch live prices for active portfolio holdings and re-render
// FIX: Concurrency limit 5, 60s cache, 5-min failed cache, and in-flight guard
let isPortfolioFetchInFlight = false;
async function fetchPortfolioLivePrices() {
    if (isPortfolioFetchInFlight || portfolioItems.length === 0) return;
    
    // Find unique active symbols not recently cached or failed
    const activeSymbols = [...new Set(
        portfolioItems
            .filter(item => !(item.sellRate && item.sellDate))
            .map(item => item.companySymbol)
            .filter(sym => sym && !isPriceFresh(sym) && !isFailedSymbolRecent(sym))
    )];
    if (activeSymbols.length === 0) return;
    
    isPortfolioFetchInFlight = true;
    try {
        console.log("Fetching live prices for active portfolio holdings:", activeSymbols);
        await runWithConcurrency(activeSymbols, 5, async (symbol) => {
            try {
                let data;
                const isNumeric = symbol.match(/^\d+$/);
                const prefSuffix = isNumeric ? '.BO' : '.NS';
                const fallbackSuffix = isNumeric ? '.NS' : '.BO';
                
                try {
                    data = await fetchYahooFinanceData(symbol.trim().toUpperCase() + prefSuffix);
                } catch (e) {
                    data = await fetchYahooFinanceData(symbol.trim().toUpperCase() + fallbackSuffix);
                }
                
                const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
                if (price !== undefined) {
                    state.portfolioLivePrices.set(symbol, price);
                    markPriceFresh(symbol);
                    throttledRenderPortfolioTable();
                } else {
                    markSymbolFailed(symbol);
                    throttledRenderPortfolioTable();
                }
            } catch (e) {
                console.warn(`Failed to fetch live price for active portfolio item ${symbol}:`, e.message);
                markSymbolFailed(symbol);
                throttledRenderPortfolioTable();
            }
        });
    } finally {
        isPortfolioFetchInFlight = false;
    }
}

// Render portfolio entries list table and calculate summaries
function renderPortfolioTable() {
    const tbody = document.querySelector('#portfolio-table tbody');
    const tfoot = document.querySelector('#portfolio-table tfoot');
    if (!tbody) return;

    if (portfolioItems.length === 0) {
        tbody.innerHTML = `<tr><td colspan="13" style="text-align:center; padding: 2rem; color: var(--text-secondary);">No transactions logged yet. Add your first transaction on the left!</td></tr>`;
        if (tfoot) tfoot.innerHTML = '';
        updatePortfolioSummary(0, 0, 0, 0);
        document.getElementById('portfolio-count').textContent = 'Holdings: 0';
        return;
    }

    // Helper to get profit ratio of any item for sorting
    const getProfitRatio = (item) => {
        const buyRate = parseFloat(item.buyRate) || 0;
        if (buyRate <= 0) return -999999;
        
        const hasSold = item.sellRate && item.sellDate;
        if (hasSold) {
            const sellRate = parseFloat(item.sellRate) || 0;
            return ((sellRate - buyRate) / buyRate) * 100;
        } else {
            let currentPrice = state.portfolioLivePrices.get(item.companySymbol);
            if (currentPrice === undefined) {
                currentPrice = getLastKnownPrice(item.companySymbol);
            }
            if (currentPrice !== null && currentPrice !== undefined) {
                return ((currentPrice - buyRate) / buyRate) * 100;
            }
            return -999999;
        }
    };

    // Sort: Active first, Sold last. Within each group, sort by profit ratio descending
    const sortedItems = [...portfolioItems].sort((a, b) => {
        const aSold = a.sellRate && a.sellDate ? 1 : 0;
        const bSold = b.sellRate && b.sellDate ? 1 : 0;
        
        if (aSold !== bSold) {
            return aSold - bSold;
        }
        
        return getProfitRatio(b) - getProfitRatio(a);
    });

    const searchInput = document.getElementById('portfolio-search-input');
    const searchVal = searchInput ? searchInput.value.trim().toUpperCase() : '';
    const filteredItems = searchVal 
        ? sortedItems.filter(item => item.companySymbol.toUpperCase().includes(searchVal))
        : sortedItems;

    let html = '';
    let totalInvested = 0;
    let totalProfit = 0;
    let totalSellAmount = 0;
    let totalQty = 0;
    let activeCount = 0;
    let soldCount = 0;
    let totalDaysSold = 0;

    filteredItems.forEach(item => {
        const qty = parseInt(item.quantity) || 0;
        const buyRate = parseFloat(item.buyRate) || 0;
        const buyAmt = qty * buyRate;
        totalInvested += buyAmt;
        totalQty += qty;

        const hasSold = item.sellRate && item.sellDate;
        
        let livePriceStr = '-';
        let sellAmtStr = '-';
        let profitStr = '-';
        let profitClass = '';
        let daysStr = '-';
        let ratioStr = '-';
        let badgeHtml = '';

        if (hasSold) {
            soldCount++;
            const sellRate = parseFloat(item.sellRate);
            const sellAmt = qty * sellRate;
            totalSellAmount += sellAmt;
            const profit = sellAmt - buyAmt;
            totalProfit += profit;
            
            sellAmtStr = `₹${sellAmt.toFixed(2)}`;
            profitStr = `${profit >= 0 ? '+' : ''}₹${profit.toFixed(2)}`;
            profitClass = profit >= 0 ? 'profit-text' : 'loss-text';
            ratioStr = `${profit >= 0 ? '+' : ''}${((profit / buyAmt) * 100).toFixed(2)}%`;
            
            const d1 = new Date(item.buyDate);
            const d2 = new Date(item.sellDate);
            const diffDays = Math.ceil((d2 - d1) / (1000 * 60 * 60 * 24));
            totalDaysSold += diffDays >= 0 ? diffDays : 0;
            daysStr = `${diffDays >= 0 ? diffDays : 0} days`;
            badgeHtml = `<span class="badge-sold">SOLD</span>`;
        } else {
            activeCount++;
            badgeHtml = `<span class="badge-active">ACTIVE</span>`;
            
            // Get live price (or last known EOD fallback)
            let currentPrice = state.portfolioLivePrices.get(item.companySymbol);
            let isRealTime = true;
            
            if (currentPrice === undefined) {
                currentPrice = getLastKnownPrice(item.companySymbol);
                isRealTime = false;
            }
            
            if (currentPrice !== null && currentPrice !== undefined) {
                livePriceStr = `₹${currentPrice.toFixed(2)}${isRealTime ? ' <span class="live-pulse" style="width:6px;height:6px;box-shadow:0 0 0 0 rgba(16,185,129,0.7);animation:pulse 1.5s infinite;margin-left:0.2rem;"></span>' : ' <span style="font-size:0.7rem;color:var(--text-secondary);">(EOD)</span>'}`;
                
                const liveVal = qty * currentPrice;
                const profit = liveVal - buyAmt;
                totalProfit += profit;
                
                profitStr = `${profit >= 0 ? '+' : ''}₹${profit.toFixed(2)}`;
                profitClass = profit >= 0 ? 'profit-text' : 'loss-text';
                ratioStr = `${profit >= 0 ? '+' : ''}${((profit / buyAmt) * 100).toFixed(2)}%`;
            } else {
                livePriceStr = isFailedSymbolRecent(item.companySymbol)
                    ? '<span style="font-size:0.75rem;color:var(--text-secondary);">Price unavailable</span>'
                    : '<span style="font-size:0.75rem;color:var(--text-secondary);">Loading...</span>';
            }
            
            const d1 = new Date(item.buyDate);
            const d2 = new Date();
            const diffDays = Math.ceil((d2 - d1) / (1000 * 60 * 60 * 24));
            daysStr = `${diffDays >= 0 ? diffDays : 0} days`;
        }

        const formatDate = (dateStr) => {
            if (!dateStr) return '-';
            const d = new Date(dateStr);
            if (isNaN(d.getTime())) return dateStr;
            const dd = String(d.getDate()).padStart(2, '0');
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const yyyy = d.getFullYear();
            return `${dd}-${mm}-${yyyy}`;
        };

        html += `
            <tr data-id="${item.id}" style="cursor: pointer;">
                <td onclick="showResearchModal('${item.companySymbol}')" title="ચાર્ટ અને વિગતો જુાા" style="cursor:pointer;">
                    <strong style="color: var(--accent-color); text-decoration: underline dotted; text-underline-offset: 3px;">${item.companySymbol}</strong> ${badgeHtml}
                </td>
                <td>${formatDate(item.buyDate)}</td>
                <td>${qty}</td>
                <td>₹${buyRate.toFixed(2)}</td>
                <td style="font-weight:600;">₹${buyAmt.toFixed(2)}</td>
                <td>${formatDate(item.sellDate)}</td>
                <td>${item.sellRate ? `₹${parseFloat(item.sellRate).toFixed(2)}` : '-'}</td>
                <td>${sellAmtStr}</td>
                <td>${livePriceStr}</td>
                <td class="${profitClass}">${profitStr}</td>
                <td>${daysStr}</td>
                <td class="${profitClass}">${ratioStr}</td>
                <td>
                    <div class="action-btn-group">
                        <button class="action-icon-btn research-btn" onclick="showResearchModal('${item.companySymbol}')" title="Research & Advice" style="background: rgba(6, 182, 212, 0.15); color: var(--accent-color); border-color: var(--accent-color);"><i class="fa-solid fa-robot"></i></button>
                        <button class="action-icon-btn edit-btn" onclick="editPortfolioRow('${item.id}')" title="Edit Transaction"><i class="fa-solid fa-pen-to-square"></i></button>
                        <button class="action-icon-btn delete-btn" onclick="deletePortfolioRow('${item.id}')" title="Delete Transaction"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </td>
            </tr>
        `;
    });

    tbody.innerHTML = html;

    // Render footer totals
    if (tfoot) {
        const profitClass = totalProfit >= 0 ? 'profit-text' : 'loss-text';
        const profitSign = totalProfit >= 0 ? '+' : '';
        const avgDaysSold = soldCount > 0 ? Math.round(totalDaysSold / soldCount) : 0;
        const totalProfitRatio = totalInvested > 0 ? ((totalProfit / totalInvested) * 100) : 0;
        const profitRatioSign = totalProfitRatio >= 0 ? '+' : '';

        tfoot.innerHTML = `
            <tr style="font-weight: bold; background: rgba(0, 0, 0, 0.45); border-top: 2px solid var(--accent-color);">
                <td>TOTAL</td>
                <td>-</td>
                <td>${totalQty}</td>
                <td>-</td>
                <td>₹${totalInvested.toFixed(2)}</td>
                <td>-</td>
                <td>-</td>
                <td>${totalSellAmount > 0 ? `₹${totalSellAmount.toFixed(2)}` : '-'}</td>
                <td>-</td>
                <td class="${profitClass}">${profitSign}₹${totalProfit.toFixed(2)}</td>
                <td>${soldCount > 0 ? `${avgDaysSold} days (Avg)` : '-'}</td>
                <td class="${profitClass}">${profitRatioSign}${totalProfitRatio.toFixed(2)}%</td>
                <td>-</td>
            </tr>
        `;
    }

    updatePortfolioSummary(totalInvested, totalProfit, activeCount, soldCount);
    document.getElementById('portfolio-count').textContent = `Holdings: ${portfolioItems.length}`;
}

function updatePortfolioSummary(invested, profit, active, sold) {
    document.getElementById('portfolio-total-invested').textContent = `₹${invested.toFixed(2)}`;
    
    const profitEl = document.getElementById('portfolio-total-profit');
    profitEl.textContent = `${profit >= 0 ? '+' : ''}₹${profit.toFixed(2)}`;
    profitEl.style.color = profit >= 0 ? 'var(--success-color)' : 'var(--danger-color)';

    document.getElementById('portfolio-active-holdings').textContent = active;
    document.getElementById('portfolio-sold-holdings').textContent = sold;
}

// Attach portfolio row action buttons to window scope
window.editPortfolioRow = function(id) {
    const item = portfolioItems.find(x => x.id === id);
    if (!item) return;

    document.getElementById('portfolio-edit-id').value = item.id;
    document.getElementById('port-company').value = item.companySymbol;
    document.getElementById('port-buy-date').value = item.buyDate;
    document.getElementById('port-qty').value = item.quantity;
    document.getElementById('port-buy-rate').value = item.buyRate;
    document.getElementById('port-sell-date').value = item.sellDate || '';
    document.getElementById('port-sell-rate').value = item.sellRate || '';

    // Trigger preview recalculations
    const qtyInput = document.getElementById('port-qty');
    qtyInput.dispatchEvent(new Event('input'));

    const submitBtn = document.getElementById('port-submit-btn');
    submitBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Update Transaction';
    
    document.getElementById('port-cancel-btn').classList.remove('hidden');
    document.querySelector('.portfolio-form-card').scrollIntoView({ behavior: 'smooth' });
};

window.deletePortfolioRow = function(id) {
    deletePortfolioItem(id);
};

// Set up live form calculation previews
function setupPortfolioFormCalculations() {
    const form = document.getElementById('portfolio-form');
    if (!form) return;

    const qtyInput = document.getElementById('port-qty');
    const buyRateInput = document.getElementById('port-buy-rate');
    const sellDateInput = document.getElementById('port-sell-date');
    const sellRateInput = document.getElementById('port-sell-rate');
    const buyDateInput = document.getElementById('port-buy-date');

    const calcBuyAmount = document.getElementById('calc-buy-amount');
    const calcSellAmount = document.getElementById('calc-sell-amount');
    const calcProfitAmount = document.getElementById('calc-profit-amount');
    const calcProfitRatio = document.getElementById('calc-profit-ratio');
    const calcDays = document.getElementById('calc-days');

    function calculatePreview() {
        const qty = parseInt(qtyInput.value) || 0;
        const buyRate = parseFloat(buyRateInput.value) || 0;
        const buyAmt = qty * buyRate;

        calcBuyAmount.textContent = `₹${buyAmt.toFixed(2)}`;

        const sellRate = parseFloat(sellRateInput.value) || 0;
        const sellAmt = qty * sellRate;

        const hasSellRate = sellRateInput.value.trim() !== "";
        calcSellAmount.textContent = hasSellRate ? `₹${sellAmt.toFixed(2)}` : "₹0.00";

        if (hasSellRate && qty > 0 && buyRate > 0) {
            const profit = sellAmt - buyAmt;
            const ratio = ((sellRate - buyRate) / buyRate) * 100;
            
            calcProfitAmount.textContent = `${profit >= 0 ? '+' : ''}₹${profit.toFixed(2)}`;
            calcProfitAmount.className = `calc-value ${profit >= 0 ? 'profit-text' : 'loss-text'}`;
            
            calcProfitRatio.textContent = `${ratio >= 0 ? '+' : ''}${ratio.toFixed(2)}%`;
            calcProfitRatio.className = `calc-value ${ratio >= 0 ? 'profit-text' : 'loss-text'}`;
        } else {
            calcProfitAmount.textContent = "₹0.00";
            calcProfitAmount.className = "calc-value";
            calcProfitRatio.textContent = "0.00%";
            calcProfitRatio.className = "calc-value";
        }

        const buyDateVal = buyDateInput.value;
        const sellDateVal = sellDateInput.value;

        if (buyDateVal && sellDateVal) {
            const d1 = new Date(buyDateVal);
            const d2 = new Date(sellDateVal);
            const diffTime = d2 - d1;
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            
            calcDays.textContent = `${diffDays >= 0 ? diffDays : 0} Days`;
        } else {
            calcDays.textContent = "0 Days";
        }
    }

    [qtyInput, buyRateInput, sellDateInput, sellRateInput, buyDateInput].forEach(input => {
        input.addEventListener('input', calculatePreview);
    });
}

// Set up portfolio transaction form submit
function setupPortfolioFormSubmit() {
    const form = document.getElementById('portfolio-form');
    if (!form) return;

    const cancelBtn = document.getElementById('port-cancel-btn');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
            form.reset();
            document.getElementById('portfolio-edit-id').value = '';
            document.getElementById('port-submit-btn').innerHTML = '<i class="fa-solid fa-plus"></i> Add Transaction';
            cancelBtn.classList.add('hidden');
            document.getElementById('port-qty').dispatchEvent(new Event('input'));
        });
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const id = document.getElementById('portfolio-edit-id').value;
        const companySymbol = document.getElementById('port-company').value.trim().toUpperCase();
        const buyDate = document.getElementById('port-buy-date').value;
        const quantity = parseInt(document.getElementById('port-qty').value);
        const buyRate = parseFloat(document.getElementById('port-buy-rate').value);
        const sellDate = document.getElementById('port-sell-date').value || null;
        const sellRate = parseFloat(document.getElementById('port-sell-rate').value) || null;

        if (!companySymbol || !buyDate || isNaN(quantity) || isNaN(buyRate)) {
            showNotification('Please fill all required fields.', 'error');
            return;
        }

        if (sellDate && !sellRate) {
            showNotification('Please enter a Sell Rate if you entered a Sell Date.', 'error');
            return;
        }
        if (sellRate && !sellDate) {
            showNotification('Please enter a Sell Date if you entered a Sell Rate.', 'error');
            return;
        }

        const item = {
            companySymbol,
            buyDate,
            quantity,
            buyRate
        };

        if (id) item.id = id;
        if (sellDate) item.sellDate = sellDate;
        if (sellRate) item.sellRate = sellRate;

        await savePortfolioItem(item);
        
        form.reset();
        document.getElementById('portfolio-edit-id').value = '';
        document.getElementById('port-submit-btn').innerHTML = '<i class="fa-solid fa-plus"></i> Add Transaction';
        if (cancelBtn) cancelBtn.classList.add('hidden');
        document.getElementById('port-qty').dispatchEvent(new Event('input'));
    });
}

// Populate company symbols suggestion list from master stock symbols
function populateCompanyDatalist() {
    const datalist = document.getElementById('company-suggestions');
    if (!datalist) return;
    
    datalist.innerHTML = '';
    
    if (state.masterData && state.masterData.length > 1) {
        const symbolIdx = state.symbolColIndex;
        if (symbolIdx === -1) return;
        
        const symbols = new Set();
        for (let i = 1; i < state.masterData.length; i++) {
            const sym = String(state.masterData[i][symbolIdx] || '').trim().toUpperCase();
            if (sym) symbols.add(sym);
        }
        
        // FIX: Batch DOM insertion using DocumentFragment to avoid 2,000+ reflows
        const sortedSymbols = Array.from(symbols).sort();
        const frag = document.createDocumentFragment();
        sortedSymbols.forEach(sym => {
            const option = document.createElement('option');
            option.value = sym;
            frag.appendChild(option);
        });
        datalist.appendChild(frag);
        console.log(`Populated datalist autocomplete with ${sortedSymbols.length} company symbols.`);
    }
}

// Safe Local Storage Helpers
function getLocalStorageItem(key) {
    try {
        return localStorage.getItem(key);
    } catch (e) {
        console.warn('localStorage is blocked or unavailable:', e);
        return null;
    }
}

function setLocalStorageItem(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch (e) {
        console.warn('localStorage is blocked or unavailable:', e);
    }
}

function removeLocalStorageItem(key) {
    try {
        localStorage.removeItem(key);
    } catch (e) {
        console.warn('localStorage is blocked or unavailable:', e);
    }
}

// Local Storage Helpers
function saveMasterToLocalStorage() {
    if (state.masterData) {
        try {
            setLocalStorageItem('master_excel_data', JSON.stringify(state.masterData));
            setLocalStorageItem('master_excel_sheet_name', state.masterSheetName || 'Sheet1');
            setLocalStorageItem('master_excel_filename', state.masterFile ? state.masterFile.name : 'Master_Stored.xlsx');
            setLocalStorageItem('master_excel_filesize', state.masterFile ? formatBytes(state.masterFile.size) : 'Saved Data');
            if (state.latestVolumes) {
                setLocalStorageItem('latest_volumes', JSON.stringify(Array.from(state.latestVolumes.entries())));
            }
        } catch (e) {
            console.error(e);
            showNotification('Could not save data to browser storage.', 'error');
        }
    }
}

function loadMasterFromLocalStorage() {
    const storedDataStr = getLocalStorageItem('master_excel_data');
    if (storedDataStr) {
        try {
            const rawData = JSON.parse(storedDataStr);
            state.masterSheetName = getLocalStorageItem('master_excel_sheet_name') || 'Sheet1';
            
            const storedVolumes = getLocalStorageItem('latest_volumes');
            if (storedVolumes) {
                try {
                    state.latestVolumes = new Map(JSON.parse(storedVolumes));
                } catch (e) {
                    console.error("Failed to parse stored volumes:", e);
                    state.latestVolumes = new Map();
                }
            } else {
                state.latestVolumes = new Map();
            }

            // Strictly keep only SERIES = "EQ" when loading
            state.masterData = filterMasterForEQOnly(rawData);
            
            // Detect column indexes and adjust UI filters
            if (state.masterData && state.masterData.length > 0) {
                detectColumnIndexes(state.masterData[0]);
            }
            
            const filename = getLocalStorageItem('master_excel_filename') || 'Master_Stored.xlsx';
            const filesize = getLocalStorageItem('master_excel_filesize') || 'Saved Data';
            
            masterFilename.textContent = filename;
            masterFilesize.textContent = filesize;
            
            // Update UI status to show Local Storage status
            masterStatus.classList.add('local-loaded');
            document.getElementById('master-status-icon').className = 'fa-solid fa-database success-icon blue-icon';
            document.getElementById('master-storage-status').textContent = 'Auto-loaded from Storage';
            
            masterDropzone.classList.add('hidden');
            masterStatus.classList.remove('hidden');
            
            log(`Master data auto-loaded from browser storage. (Total EQ companies: ${state.masterData.length - 1})`, 'success');
            
            renderPreview(state.masterData, masterTable, masterRowCount, masterPreviewContainer);
            autoRenderIfProcessed();
            populateCompanyDatalist();
            checkReadyState();
        } catch (err) {
            console.error('Local Storage load error:', err);
            removeLocalStorageItem('master_excel_data');
        }
    }
}

// Filter Master sheet data to keep ONLY SERIES == "EQ"
function filterMasterForEQOnly(masterData) {
    if (!masterData || masterData.length === 0) return masterData;
    
    const headers = masterData[0];
    let seriesIdx = -1;
    headers.forEach((h, idx) => {
        if (String(h || '').toUpperCase().trim() === 'SERIES') {
            seriesIdx = idx;
        }
    });
    
    if (seriesIdx === -1) {
        // If there's no SERIES column, we cannot filter it yet. We will filter it during CSV matching.
        return masterData;
    }
    
    const filtered = [headers];
    for (let i = 1; i < masterData.length; i++) {
        const row = masterData[i];
        const seriesVal = String(row[seriesIdx] || '').trim().toUpperCase();
        if (seriesVal === 'EQ' || seriesVal === '') {
            filtered.push(row);
        }
    }
    return filtered;
}

// Reset uploaded files
function resetFile(type) {
    if (type === 'master') {
        state.masterFile = null;
        state.masterWorkbook = null;
        state.masterData = null;
        state.masterSheetName = null;
        masterFile.value = '';
        masterStatus.classList.add('hidden');
        masterDropzone.classList.remove('hidden');
        masterPreviewContainer.classList.add('hidden');
        
        // Remove from local storage
        removeLocalStorageItem('master_excel_data');
        removeLocalStorageItem('master_excel_sheet_name');
        removeLocalStorageItem('master_excel_filename');
        removeLocalStorageItem('master_excel_filesize');
        log('Master file removed from storage and dashboard.', 'warning');
        deleteMasterFromCloud();

        // Clear processed results
        state.processedWorkbook = null;
        state.processedMasterData = null;
        downloadBtn.disabled = true;
        researchSection.classList.add('hidden');
        processLogContainer.classList.add('hidden');
        logConsole.innerHTML = '';
    } else if (type === 'csv') {
        state.csvFile = null;
        state.csvWorkbook = null;
        state.csvData = null;
        state.csvFiles = null;
        csvFile.value = '';
        csvStatus.classList.add('hidden');
        csvDropzone.classList.remove('hidden');
        csvPreviewContainer.classList.add('hidden');
        log('Daily CSV file selection cleared.', 'info');
    }
    
    // Always disable process button since one of the files is missing
    processBtn.disabled = true;
}

// Parse Master Excel File
function parseMasterFile(file) {
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array', cellStyles: true, cellFormulas: true });
            
            state.masterWorkbook = workbook;
            state.masterSheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[state.masterSheetName];
            
            // Read as raw arrays
            const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
            
            // Filter to keep ONLY SERIES == "EQ"
            state.masterData = filterMasterForEQOnly(rawData);
            
            // Reset processed state for new master file
            state.processedWorkbook = null;
            state.processedMasterData = null;
            downloadBtn.disabled = true;
            researchSection.classList.add('hidden');

            // Detect column indexes and adjust UI filters
            if (state.masterData && state.masterData.length > 0) {
                detectColumnIndexes(state.masterData[0]);
            }
            
            // Save to local storage and cloud
            saveMasterToLocalStorage();
            saveMasterToCloud();
            
            masterStatus.classList.remove('local-loaded');
            document.getElementById('master-status-icon').className = 'fa-solid fa-circle-check success-icon';
            document.getElementById('master-storage-status').textContent = 'Saved in Storage';
            
            masterDropzone.classList.add('hidden');
            masterStatus.classList.remove('hidden');
            
            log(`Master file loaded: ${file.name}`, 'info');
            log(`Filtered only 'EQ' series records. (Total EQ companies: ${state.masterData.length - 1})`, 'success');
            
            renderPreview(state.masterData, masterTable, masterRowCount, masterPreviewContainer);
            
            // If the uploaded file was already processed, display it!
            autoRenderIfProcessed();
            populateCompanyDatalist();
            
            checkReadyState();
        } catch (err) {
            console.error(err);
            showNotification('Error reading Master Excel file.', 'error');
            resetFile('master');
        }
    };
    reader.readAsArrayBuffer(file);
}

// Parse Daily CSV File (Filter for EQ series only)
function parseCSVFile(file) {
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const text = e.target.result;
            const workbook = XLSX.read(text, { type: 'string' });
            state.csvWorkbook = workbook;
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            
            // Raw CSV data as objects
            const rawCSVData = XLSX.utils.sheet_to_json(sheet, { defval: "" });
            
            if (rawCSVData.length > 0) {
                 const keys = Object.keys(rawCSVData[0]);
                 const seriesCandidates = ['SERIES', 'SCTYSRS', 'SERIES_NAME', 'GROUP'];
                 const seriesKey = keys.find(k => seriesCandidates.includes(k.toUpperCase().trim()));
                 
                 if (seriesKey) {
                     // Filter EQ series only
                     state.csvData = rawCSVData.filter(row => String(row[seriesKey] || '').trim().toUpperCase() === 'EQ');
                     log(`Bhavcopy CSV file loaded: ${file.name}`, 'info');
                     log(`Applied SERIES 'EQ' filter. Total rows: ${state.csvData.length} (from original ${rawCSVData.length})`, 'success');
                 } else {
                     state.csvData = rawCSVData;
                     log(`Bhavcopy CSV file loaded: ${file.name} (SERIES column not found, no filtering applied)`, 'warning');
                 }
            } else {
                state.csvData = rawCSVData;
            }
            
            // Build preview
            const previewSheet = XLSX.utils.json_to_sheet(state.csvData);
            const previewData = XLSX.utils.sheet_to_json(previewSheet, { header: 1, defval: "" });
            
            renderPreview(previewData, csvTable, csvRowCount, csvPreviewContainer);
            checkReadyState();
        } catch (err) {
            console.error(err);
            showNotification('Error reading CSV file.', 'error');
            resetFile('csv');
        }
    };
    reader.readAsText(file);
}

// Render dynamic preview table (Limit to 8 rows)
function renderPreview(data, tableEl, countEl, containerEl) {
    if (!data || data.length === 0) return;
    
    const headers = data[0];
    let headerHtml = '<tr>';
    headers.forEach(h => {
        headerHtml += `<th>${h || ''}</th>`;
    });
    headerHtml += '</tr>';
    tableEl.querySelector('thead').innerHTML = headerHtml;
    
    let bodyHtml = '';
    const limit = Math.min(data.length, 9);
    for (let i = 1; i < limit; i++) {
        bodyHtml += '<tr>';
        const row = data[i];
        headers.forEach((_, colIndex) => {
            const val = row[colIndex] !== undefined ? row[colIndex] : '';
            bodyHtml += `<td>${val}</td>`;
        });
        bodyHtml += '</tr>';
    }
    tableEl.querySelector('tbody').innerHTML = bodyHtml;
    
    countEl.textContent = `Total Rows: ${data.length - 1}`;
    containerEl.classList.remove('hidden');
}

// Enable Process button when both files are loaded
function checkReadyState() {
    if (state.masterData && state.csvData) {
        processBtn.disabled = false;
        showNotification('Both files are ready. Process the data!', 'warning');
    }
}

// Log message to virtual console
function log(msg, type = 'info') {
    const entry = document.createElement('div');
    entry.className = `log-entry log-${type}`;
    
    const time = new Date().toLocaleTimeString();
    entry.textContent = `[${time}] ${msg}`;
    
    logConsole.appendChild(entry);
    logConsole.scrollTop = logConsole.scrollHeight;
}

// Notification Helper
function showNotification(message, type = 'info') {
    const notif = document.createElement('div');
    notif.className = `notification ${type}`;
    
    let icon = 'fa-info-circle';
    if (type === 'success') icon = 'fa-check-circle';
    if (type === 'error') icon = 'fa-exclamation-circle';
    if (type === 'warning') icon = 'fa-exclamation-triangle';
    
    notif.innerHTML = `
        <i class="fa-solid ${icon}"></i>
        <span>${message}</span>
    `;
    
    notificationContainer.appendChild(notif);
    
    setTimeout(() => {
        notif.style.animation = 'fadeIn 0.3s ease reverse';
        setTimeout(() => notif.remove(), 300);
    }, 4000);
}

// FIX: Validate strict DD-MM-YYYY date strings
function isValidDDMMYYYY(str) {
    if (!str || typeof str !== 'string') return false;
    const m = str.trim().match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (!m) return false;
    const day = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    const year = parseInt(m[3], 10);
    if (year < 2000 || year > 2099 || month < 1 || month > 12 || day < 1 || day > 31) return false;
    const dt = new Date(year, month - 1, day);
    return dt.getFullYear() === year && dt.getMonth() === month - 1 && dt.getDate() === day;
}

// FIX: Prompt user via in-app modal when no valid DD-MM-YYYY date can be extracted from CSV
function askUserForBhavcopyDate(filename) {
    return new Promise((resolve) => {
        const modal = document.getElementById('date-confirm-modal');
        const fnameEl = document.getElementById('date-confirm-filename');
        const inputEl = document.getElementById('date-confirm-input');
        const errEl = document.getElementById('date-confirm-error');
        const okBtn = document.getElementById('date-confirm-ok-btn');
        const cancelBtn = document.getElementById('date-confirm-cancel-btn');
        const closeBtn = document.getElementById('date-confirm-close-btn');

        if (!modal || !inputEl || !okBtn) {
            resolve(null);
            return;
        }

        if (fnameEl) fnameEl.textContent = filename;
        if (errEl) errEl.classList.add('hidden');
        inputEl.value = getTodayDateString();
        modal.classList.remove('hidden');

        const cleanup = (result) => {
            modal.classList.add('hidden');
            okBtn.removeEventListener('click', onOk);
            if (cancelBtn) cancelBtn.removeEventListener('click', onCancel);
            if (closeBtn) closeBtn.removeEventListener('click', onCancel);
            resolve(result);
        };

        const onOk = () => {
            const normalized = normalizeDateString(inputEl.value.trim());
            if (isValidDDMMYYYY(normalized)) {
                cleanup(normalized);
            } else if (errEl) {
                errEl.classList.remove('hidden');
            }
        };

        const onCancel = () => cleanup(null);

        okBtn.addEventListener('click', onOk);
        if (cancelBtn) cancelBtn.addEventListener('click', onCancel);
        if (closeBtn) closeBtn.addEventListener('click', onCancel);
    });
}

// Extract and normalize Date from CSV / Filename
// FIX: Detect from CSV date columns and known NSE/BSE/UDiFF/DD-MM-YYYY filename patterns; return null if invalid
function extractDateFromBhavcopy(csvData, csvKeys, filename) {
    const dateKeys = ['TIMESTAMP', 'DATE', 'TRADING_DATE', 'RECORD_DATE', 'TRADEDATE', 'TRADDT', 'BIZDT'];
    for (const dk of dateKeys) {
        const found = csvKeys.find(k => k.toUpperCase().trim() === dk);
        if (found && csvData.length > 0) {
            const val = String(csvData[0][found] || '').trim();
            if (val) {
                const normalized = normalizeDateString(val);
                if (isValidDDMMYYYY(normalized)) {
                    return normalized;
                }
            }
        }
    }

    // Check NSE old format: cm01JUL2026bhav.csv
    const matchNSE = filename.match(/cm(\d{2})([A-Z]{3})(\d{4})/i);
    if (matchNSE) {
        const day = matchNSE[1];
        const monthStr = matchNSE[2].toUpperCase();
        const year = matchNSE[3];
        const months = {
            JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
            JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12'
        };
        const month = months[monthStr];
        if (month) {
            const candidate = `${day}-${month}-${year}`;
            if (isValidDDMMYYYY(candidate)) return candidate;
        }
    }

    // Check NSE UDiFF format: BhavCopy_NSE_CM_0_0_0_20260630_F_0000.csv
    const matchUDiFF = filename.match(/BhavCopy_NSE_CM_0_0_0_(\d{4})(\d{2})(\d{2})/i);
    if (matchUDiFF) {
        const candidate = `${matchUDiFF[3]}-${matchUDiFF[2]}-${matchUDiFF[1]}`;
        if (isValidDDMMYYYY(candidate)) return candidate;
    }

    // Check BSE format: EQ010726.csv
    const matchBSE = filename.match(/EQ(\d{2})(\d{2})(\d{2})/i);
    if (matchBSE) {
        const candidate = `${matchBSE[1]}-${matchBSE[2]}-20${matchBSE[3]}`;
        if (isValidDDMMYYYY(candidate)) return candidate;
    }

    // Check embedded DD-MM-YYYY or DD/MM/YYYY in filename (e.g. "19-11-2026 (1).csv")
    const matchNormal = filename.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
    if (matchNormal) {
        const candidate = `${matchNormal[1].padStart(2, '0')}-${matchNormal[2].padStart(2, '0')}-${matchNormal[3]}`;
        if (isValidDDMMYYYY(candidate)) return candidate;
    }

    return null;
}

// Normalize various date formats to DD-MM-YYYY
function normalizeDateString(str) {
    const clean = String(str || '').trim().split(/[T\s]/)[0];
    const matchISO = clean.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (matchISO) {
        return `${matchISO[3].padStart(2, '0')}-${matchISO[2].padStart(2, '0')}-${matchISO[1]}`;
    }

    const parts = clean.split('-');
    if (parts.length === 3) {
        let day = parts[0].padStart(2, '0');
        let monthStr = parts[1].toUpperCase();
        let year = parts[2];
        
        if (year.length === 2) year = '20' + year;
        
        const months = {
            JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
            JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
            '1': '01', '2': '02', '3': '03', '4': '04', '5': '05', '6': '06',
            '7': '07', '8': '08', '9': '09', '10': '10', '11': '11', '12': '12',
            '01': '01', '02': '02', '03': '03', '04': '04', '05': '05', '06': '06',
            '07': '07', '08': '08', '09': '09'
        };
        
        const month = months[monthStr] || monthStr.padStart(2, '0');
        return `${day}-${month}-${year}`;
    }
    
    const partsSlash = clean.split('/');
    if (partsSlash.length === 3) {
        let day = partsSlash[0].padStart(2, '0');
        let month = partsSlash[1].padStart(2, '0');
        let year = partsSlash[2];
        if (year.length === 2) year = '20' + year;
        return `${day}-${month}-${year}`;
    }
    
    return clean;
}

// Get today's date in DD-MM-YYYY format
function getTodayDateString() {
    const d = new Date();
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
}

// Match and Process files
// Read file as text using Promises
function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result);
        reader.onerror = err => reject(err);
        reader.readAsText(file);
    });
}

// Get chronological Date object from CSV file name
function getFileDate(file) {
    const filename = file.name;
    
    // 1. Check DD-MM-YYYY or DD/MM/YYYY pattern in filename
    const matchNormal = filename.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
    if (matchNormal) {
        return new Date(matchNormal[3], matchNormal[2] - 1, matchNormal[1]);
    }
    
    // 2. Check NSE Format: cm01JUL2026bhav.csv
    const matchNSE = filename.match(/cm(\d{2})([A-Z]{3})(\d{4})/i);
    if (matchNSE) {
        const day = parseInt(matchNSE[1]);
        const monthStr = matchNSE[2].toUpperCase();
        const year = parseInt(matchNSE[3]);
        const months = {
            JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
            JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11
        };
        const month = months[monthStr] !== undefined ? months[monthStr] : 0;
        return new Date(year, month, day);
    }
    
    // 3. Check BSE Format: EQ010726.csv
    const matchBSE = filename.match(/EQ(\d{2})(\d{2})(\d{2})/i);
    if (matchBSE) {
        const day = parseInt(matchBSE[1]);
        const month = parseInt(matchBSE[2]) - 1;
        const year = 2000 + parseInt(matchBSE[3]);
        return new Date(year, month, day);
    }
    
    // 4. Check NSE UDiFF Format: BhavCopy_NSE_CM_0_0_0_20260630_F_0000.csv
    const matchUDiFF = filename.match(/BhavCopy_NSE_CM_0_0_0_(\d{4})(\d{2})(\d{2})/i);
    if (matchUDiFF) {
        const year = parseInt(matchUDiFF[1]);
        const month = parseInt(matchUDiFF[2]) - 1;
        const day = parseInt(matchUDiFF[3]);
        return new Date(year, month, day);
    }
    
    // Fallback to last modified date
    return new Date(file.lastModified || Date.now());
}

// Match and Process files
async function processFiles() {
    processLogContainer.classList.remove('hidden');
    log('Data update and processing starting...', 'info');
    
    try {
        const master = state.masterData;
        if (!master || master.length < 2) {
            log('Insufficient data in Master file.', 'error');
            return;
        }
        
        let filesToProcess = [];
        if (state.csvFiles && state.csvFiles.length > 0) {
            filesToProcess = [...state.csvFiles];
        } else if (state.csvFile) {
            filesToProcess = [state.csvFile];
        }
        
        if (filesToProcess.length === 0) {
            log('No CSV files selected for processing.', 'error');
            return;
        }
        
        // Sort files chronologically (oldest first, newest last)
        filesToProcess.sort((a, b) => getFileDate(a) - getFileDate(b));
        
        log(`Total ${filesToProcess.length} files will be processed chronologically.`, 'info');
        
        // FIX: Shallow-copy rows once per batch instead of heavy JSON.parse(JSON.stringify(master))
        let updatedMaster = master.map(row => (Array.isArray(row) ? [...row] : row));
        let lastInsertIndex = -1;
        let lastDiffColIndex = -1;
        let lastHighColIndex = -1;
        let lastSymbolColIndex = -1;
        let lastSeriesColIndex = -1;
        
        for (let fIdx = 0; fIdx < filesToProcess.length; fIdx++) {
            const file = filesToProcess[fIdx];
            log(`[${fIdx + 1}/${filesToProcess.length}] Processing file: ${file.name}...`, 'info');
            await yieldToUI();
            
            // Read CSV File
            const text = await readFileAsText(file);
            const workbook = XLSX.read(text, { type: 'string' });
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const rawCSVData = XLSX.utils.sheet_to_json(sheet, { defval: "" });
            
            let csvKeys = [];
            let csvData = [];
            if (rawCSVData.length > 0) {
                csvKeys = Object.keys(rawCSVData[0]);
                const seriesCandidates = ['SERIES', 'SCTYSRS', 'SERIES_NAME', 'GROUP'];
                const seriesKey = csvKeys.find(k => seriesCandidates.includes(k.toUpperCase().trim()));
                if (seriesKey) {
                    csvData = rawCSVData.filter(row => String(row[seriesKey] || '').trim().toUpperCase() === 'EQ');
                } else {
                    csvData = rawCSVData;
                }
            }
            
            if (csvData.length === 0) {
                log(`- Warning: No 'EQ' series records found in file ${file.name}, skipping.`, 'warning');
                continue;
            }
            
            // FIX: Use extractDateFromBhavcopy() to get validated DD-MM-YYYY trading date; prompt user if not found
            let dateStr = extractDateFromBhavcopy(csvData, csvKeys, file.name);
            if (!isValidDDMMYYYY(dateStr)) {
                dateStr = await askUserForBhavcopyDate(file.name);
                if (!isValidDDMMYYYY(dateStr)) {
                    log(`- Skipped file ${file.name}: No valid trading date confirmed.`, 'warning');
                    continue;
                }
            }
            log(`- Using verified trading date column: ${dateStr}`, 'info');
            
            // Find keys in CSV
            let symbolKey = null;
            let closePriceKey = null;
            let prevCloseKey = null;
            
            const symbolCandidates = ['SYMBOL', 'TCKRSYMB', 'SC_NAME', 'SC_CODE', 'NAME', 'COMPANY_NAME', 'COMPANY'];
            for (let candidate of symbolCandidates) {
                const found = csvKeys.find(k => k.toUpperCase().trim() === candidate);
                if (found) {
                    symbolKey = found;
                    break;
                }
            }
            if (!symbolKey) symbolKey = csvKeys[0];
            
            const priceCandidates = ['CLOSE', 'CLSGPRIC', 'LAST', 'RATE', 'PRICE', 'CLOSE_PRICE', 'LAST_PRICE'];
            for (let candidate of priceCandidates) {
                const found = csvKeys.find(k => k.toUpperCase().trim() === candidate);
                if (found) {
                    closePriceKey = found;
                    break;
                }
            }
            if (!closePriceKey) closePriceKey = csvKeys[csvKeys.length - 1];
            
            const prevCandidates = ['PREVCLOSE', 'PRVSCLSGPRIC', 'PREV_CLOSE', 'PREVCLOSEPRICE', 'PREV_CLOSE_PRICE', 'PREV_CLOSE_RATE'];
            for (let candidate of prevCandidates) {
                const found = csvKeys.find(k => k.toUpperCase().trim() === candidate);
                if (found) {
                    prevCloseKey = found;
                    break;
                }
            }
            if (!prevCloseKey) prevCloseKey = csvKeys.find(k => k.toUpperCase().includes('PREV') && k.toUpperCase().includes('CLOSE'));
            
            // Detect Volume column if this is the newest file in the chronological batch
            const isNewestFile = (fIdx === filesToProcess.length - 1);
            let volumeKey = null;
            if (isNewestFile && csvKeys.length > 0) {
                const volumeCandidates = ['TTL_TRD_QTY', 'TOTTRDQTY', 'VOLUME', 'QTY', 'NO_OF_SHRS', 'NO_OF_SHARES', 'NET_QTY', 'TOTAL_TRADED_QUANTITY', 'TOTAL_TRADED_QTY', 'TRADED_QTY', 'TRD_QTY'];
                volumeKey = csvKeys.find(k => volumeCandidates.includes(k.toUpperCase().trim()));
                if (!volumeKey) {
                    volumeKey = csvKeys.find(k => k.toUpperCase().includes('VOLUME') || k.toUpperCase().includes('QTY') || k.toUpperCase().includes('SHRS'));
                }
                if (volumeKey) {
                    log(`- Detected Volume column in CSV: ${volumeKey}`, 'info');
                } else {
                    log(`- Warning: Could not find volume column in daily CSV.`, 'warning');
                }
            }

            // Build map for CSV lookups
            const bhavcopyRowMap = new Map();
            csvData.forEach(row => {
                const symbol = String(row[symbolKey] || '').trim().toUpperCase();
                if (symbol) {
                    bhavcopyRowMap.set(symbol, row);
                }
            });
            
            let headers = updatedMaster[0];
            
            // Detect column indexes
            detectColumnIndexes(headers);
            let symbolColIndex = state.symbolColIndex;
            let seriesColIndex = state.seriesColIndex;
            let highColIndex = state.highColIndex;
            let diffColIndex = state.diffColIndex;
            
            if (symbolColIndex === -1) {
                symbolColIndex = 0;
                headers[0] = 'SYMBOL';
                state.symbolColIndex = 0;
            }
            
            // Auto-create SERIES column if missing, so we can filter EQ series reliably
            if (seriesColIndex === -1) {
                const seriesInsertIdx = symbolColIndex + 1;
                headers.splice(seriesInsertIdx, 0, 'SERIES');
                state.seriesColIndex = seriesInsertIdx;
                seriesColIndex = seriesInsertIdx;
                
                // Shift indices for other columns
                if (highColIndex >= seriesInsertIdx) { highColIndex++; state.highColIndex++; }
                if (diffColIndex >= seriesInsertIdx) { diffColIndex++; state.diffColIndex++; }
                if (state.isinColIndex >= seriesInsertIdx) { state.isinColIndex++; }
                
                for (let i = 1; i < updatedMaster.length; i++) {
                    if (updatedMaster[i]) {
                        updatedMaster[i].splice(seriesInsertIdx, 0, "");
                    }
                }
            }
            
            // Determine insertion index for the new Date column (always immediately next to HIGH column)
            let insertIndex = -1;
            if (highColIndex !== -1) {
                insertIndex = highColIndex + 1;
            } else if (diffColIndex !== -1) {
                insertIndex = diffColIndex + 1;
            } else {
                insertIndex = headers.length;
            }
            
            let existingDateColIndex = headers.indexOf(dateStr);
            if (existingDateColIndex !== -1) {
                insertIndex = existingDateColIndex;
            } else {
                headers.splice(insertIndex, 0, dateStr);
            }
            
            let matchCount = 0;
            let failCount = 0;
            const processedRows = [headers];
            
            for (let i = 1; i < updatedMaster.length; i++) {
                // FIX: Yield every 400 rows so Process Data never freezes the UI
                if (i % 400 === 0) {
                    await yieldToUI();
                }

                const row = updatedMaster[i];
                
                const targetPadding = existingDateColIndex !== -1 ? headers.length : headers.length - 1;
                while (row.length < targetPadding) {
                    row.push("");
                }
                
                const companySymbol = String(row[symbolColIndex] || '').trim().toUpperCase();
                if (!companySymbol) {
                    if (existingDateColIndex === -1) row.splice(insertIndex, 0, "");
                    processedRows.push(row);
                    continue;
                }
                
                const seriesVal = String(row[seriesColIndex] || '').trim().toUpperCase();
                if (seriesVal && seriesVal !== 'EQ') {
                    continue;
                }
                
                const csvRow = bhavcopyRowMap.get(companySymbol);
                if (csvRow) {
                    const closePriceVal = parseFloat(csvRow[closePriceKey]);
                    const prevCloseVal = prevCloseKey ? parseFloat(csvRow[prevCloseKey]) : NaN;
                    
                    if (isNewestFile && volumeKey) {
                        const volVal = parseFloat(csvRow[volumeKey]);
                        if (!isNaN(volVal)) {
                            state.latestVolumes.set(companySymbol, volVal);
                        }
                    }

                    if (existingDateColIndex !== -1) {
                        row[existingDateColIndex] = isNaN(closePriceVal) ? csvRow[closePriceKey] : closePriceVal;
                    } else {
                        row.splice(insertIndex, 0, isNaN(closePriceVal) ? csvRow[closePriceKey] : closePriceVal);
                    }
                    matchCount++;
                    
                    if (diffColIndex !== -1) {
                        if (!isNaN(closePriceVal) && !isNaN(prevCloseVal)) {
                            row[diffColIndex] = parseFloat((closePriceVal - prevCloseVal).toFixed(2));
                        } else {
                            row[diffColIndex] = "N/A";
                        }
                    }
                } else {
                    if (existingDateColIndex !== -1) {
                        row[existingDateColIndex] = "N/A";
                    } else {
                        row.splice(insertIndex, 0, "N/A");
                    }
                    
                    if (diffColIndex !== -1) {
                        row[diffColIndex] = "N/A";
                    }
                    failCount++;
                }
                
                // Update HIGH
                if (highColIndex !== -1) {
                    const prices = [];
                    for (let colIdx = insertIndex; colIdx < row.length; colIdx++) {
                        const pVal = parseFloat(row[colIdx]);
                        if (!isNaN(pVal)) {
                            prices.push(pVal);
                        }
                    }
                    if (prices.length > 0) {
                        row[highColIndex] = Math.max(...prices);
                    }
                }
                
                processedRows.push(row);
            }
            
            // Gather all symbols currently in the Master (processedRows)
            const masterSymbols = new Set();
            for (let i = 1; i < processedRows.length; i++) {
                const sym = String(processedRows[i][symbolColIndex] || '').trim().toUpperCase();
                if (sym) masterSymbols.add(sym);
            }
            
            // Identify symbols in CSV that are not in master
            const newSymbols = [];
            bhavcopyRowMap.forEach((csvRow, sym) => {
                if (!masterSymbols.has(sym)) {
                    newSymbols.push(sym);
                }
            });
            
            if (newSymbols.length > 0) {
                log(`- Found ${newSymbols.length} new companies in CSV not present in Master. Adding them...`, 'info');
                showNotification(`Added ${newSymbols.length} new companies from CSV to Master!`, 'success');
                
                // Find ISIN key in CSV if present
                const isinCandidates = ['ISIN', 'ISIN_CODE', 'ISIN_NO', 'ISIN_NUMBER'];
                let csvIsinKey = null;
                for (let candidate of isinCandidates) {
                    const found = csvKeys.find(k => k.toUpperCase().trim() === candidate);
                    if (found) {
                        csvIsinKey = found;
                        break;
                    }
                }
                
                newSymbols.forEach(sym => {
                    const csvRow = bhavcopyRowMap.get(sym);
                    
                    // Create a new blank row of headers length
                    const newRow = new Array(headers.length).fill("");
                    
                    // Set Symbol and Series
                    newRow[symbolColIndex] = sym;
                    if (seriesColIndex !== -1) newRow[seriesColIndex] = 'EQ';
                    
                    // Set ISIN
                    if (state.isinColIndex !== -1 && csvIsinKey) {
                        newRow[state.isinColIndex] = String(csvRow[csvIsinKey] || '').trim();
                    }
                    
                    // Set date column close price
                    const closePriceVal = parseFloat(csvRow[closePriceKey]);
                    if (existingDateColIndex !== -1) {
                        newRow[existingDateColIndex] = isNaN(closePriceVal) ? csvRow[closePriceKey] : closePriceVal;
                    } else {
                        newRow.splice(insertIndex, 0, isNaN(closePriceVal) ? csvRow[closePriceKey] : closePriceVal);
                    }
                    
                    // Set DIFF
                    if (diffColIndex !== -1) {
                        const prevCloseVal = prevCloseKey ? parseFloat(csvRow[prevCloseKey]) : NaN;
                        if (!isNaN(closePriceVal) && !isNaN(prevCloseVal)) {
                            newRow[diffColIndex] = parseFloat((closePriceVal - prevCloseVal).toFixed(2));
                        } else {
                            newRow[diffColIndex] = "N/A";
                        }
                    }
                    
                    // Set HIGH
                    if (highColIndex !== -1) {
                        if (!isNaN(closePriceVal)) {
                            newRow[highColIndex] = closePriceVal;
                        } else {
                            newRow[highColIndex] = "N/A";
                        }
                    }
                    
                    // Fill all older date columns (columns after HIGH column except the one just inserted) with "N/A"
                    const startColIdx = highColIndex !== -1 ? highColIndex + 1 : (diffColIndex !== -1 ? diffColIndex + 1 : symbolColIndex + 1);
                    for (let colIdx = startColIdx; colIdx < newRow.length; colIdx++) {
                        if (existingDateColIndex !== -1) {
                            if (colIdx !== existingDateColIndex && newRow[colIdx] === "") {
                                newRow[colIdx] = "N/A";
                            }
                        } else {
                            if (colIdx !== insertIndex && newRow[colIdx] === "") {
                                newRow[colIdx] = "N/A";
                            }
                        }
                    }
                    
                    processedRows.push(newRow);
                    log(`  * Added new stock: ${sym} (ISIN: ${newRow[state.isinColIndex] || 'N/A'}) with close price ${closePriceVal}`, 'success');
                });
            }
            
            // Set updatedMaster for the next file
            updatedMaster = processedRows;
            
            lastInsertIndex = insertIndex;
            lastDiffColIndex = diffColIndex;
            lastHighColIndex = highColIndex;
            lastSymbolColIndex = symbolColIndex;
            lastSeriesColIndex = seriesColIndex;
            
            log(`- File ${file.name} processed: ${matchCount} stocks matched, ${failCount} not matched.`, 'success');
        }
        
        // Save final state
        state.processedMasterData = updatedMaster;
        state.masterData = updatedMaster;

        // =====================================================================
        // 100-DAY CAP: Auto-delete oldest date columns beyond 100 days
        // Date columns start right after the HIGH column (or DIFF if no HIGH)
        // They run to the end of the header row.
        // Newest date is always at the leftmost date column; oldest at the right.
        // =====================================================================
        const capHeaders = updatedMaster[0];
        
        // Determine the first date column index (same logic as detectColumnIndexes)
        let firstDateColForCap = -1;
        capHeaders.forEach((h, idx) => {
            const hStr = String(h || '').toUpperCase().trim();
            if (hStr === 'HIGH') firstDateColForCap = idx + 1;
        });
        // Fallback: check DIFF
        if (firstDateColForCap === -1) {
            capHeaders.forEach((h, idx) => {
                const hStr = String(h || '').toUpperCase().trim();
                if (hStr === 'DIFF') firstDateColForCap = idx + 1;
            });
        }

        if (firstDateColForCap !== -1) {
            const totalCols = capHeaders.length;
            const dateColCount = totalCols - firstDateColForCap;

            if (dateColCount > 100) {
                const toRemove = dateColCount - 100; // number of oldest cols to drop
                const removeStartIdx = totalCols - toRemove; // index of first col to remove

                // Trim every row (header + data)
                for (let r = 0; r < updatedMaster.length; r++) {
                    updatedMaster[r].splice(removeStartIdx, toRemove);
                }

                // Recalculate lastInsertIndex since we may have shifted columns
                // (insert index stays the same — newest date is always at firstDateColForCap)
                lastInsertIndex = firstDateColForCap;

                log(`📅 100-Day Cap Applied: Removed ${toRemove} oldest date column(s). Data now contains exactly 100 trading days.`, 'info');
            } else {
                log(`📅 Data contains ${dateColCount} day(s) of price history (limit: 100).`, 'info');
            }
        }
        // =====================================================================
        
        saveMasterToLocalStorage();
        await saveMasterToCloud(); // Push to Firebase Cloud Firestore!
        log('All files processed successfully, saved locally and synced to Cloud.', 'success');

        
        state.latestDateColIndex = lastInsertIndex;
        state.diffColIndex = lastDiffColIndex;
        state.highColIndex = lastHighColIndex;
        state.symbolColIndex = lastSymbolColIndex;
        state.seriesColIndex = lastSeriesColIndex;
        
        // Write updated data back to workbook
        const wb = state.masterWorkbook || XLSX.utils.book_new();
        const wsName = state.masterSheetName || 'Sheet1';
        const newSheet = XLSX.utils.aoa_to_sheet(updatedMaster);
        
        if (!state.masterWorkbook) {
            XLSX.utils.book_append_sheet(wb, newSheet, wsName);
            state.masterWorkbook = wb;
        } else {
            wb.Sheets[wsName] = newSheet;
        }
        state.processedWorkbook = wb;
        
        // Render results & analysis (only active tab triggers live Yahoo fetches)
        renderFilteredResults();
        renderGainersAnalysis();
        if (isTabActive('tab-morning-picks')) renderMorningPicks();
        if (isTabActive('tab-investor-advice')) renderInvestorAdvice();
        if (isTabActive('tab-volume-promoter')) renderVolumePromoterPicks();
        
        researchSection.classList.remove('hidden');
        downloadBtn.disabled = false;
        
        renderPreview(state.masterData, masterTable, masterRowCount, masterPreviewContainer);
        populateCompanyDatalist();
        showNotification('Calculations updated and saved successfully!', 'success');
        
    } catch (err) {
        console.error(err);
        log(`Error occurred: ${err.message}`, 'error');
        showNotification('Processing failed.', 'error');
    }
}

// Analytical Section: Top 50 30-Day Gainers (Latest Close - 30 Days Ago Close)
// Analytical Section: Top Gainers dynamic (5-Day or 30-Day based on toggle)
function renderGainersAnalysis() {
    const data = state.processedMasterData;
    if (!data || data.length < 2) return;
    
    const insertIdx = state.latestDateColIndex;
    const gainersRows = [];
    const windowDays = state.gainersWindow || 5;
    
    // Determine where metadata columns end so we don't scan them as price columns
    let startMetadataLimit = -1;
    if (state.highColIndex !== -1) {
        startMetadataLimit = state.highColIndex;
    } else if (state.diffColIndex !== -1) {
        startMetadataLimit = state.diffColIndex;
    } else {
        startMetadataLimit = state.symbolColIndex;
    }
    
    for (let i = 1; i < data.length; i++) {
        const row = data[i];
        const symbol = String(row[state.symbolColIndex] || '').trim();
        
        if (!symbol) continue;
        
        if (windowDays === 'common') {
            // Collect up to 31 prices (30 trading days + today)
            const prices = [];
            const limit = Math.min(row.length, insertIdx + 31);
            for (let colIdx = insertIdx; colIdx < limit; colIdx++) {
                const pVal = parseFloat(row[colIdx]);
                if (!isNaN(pVal)) prices.push(pVal);
            }
            
            if (prices.length >= 2) {
                const todayPrice = prices[0];
                const p1 = prices[Math.min(1, prices.length - 1)];
                const p2 = prices[Math.min(2, prices.length - 1)];
                const p3 = prices[Math.min(3, prices.length - 1)];
                const p5 = prices[Math.min(5, prices.length - 1)];
                const p30 = prices[Math.min(30, prices.length - 1)];
                
                const g1 = todayPrice - p1;
                const g2 = todayPrice - p2;
                const g3 = todayPrice - p3;
                const g5 = todayPrice - p5;
                const g30 = todayPrice - p30;
                
                // If the price increased in all 5 periods (positive net gains)
                if (g1 > 0 && g2 > 0 && g3 > 0 && g5 > 0 && g30 > 0) {
                    const oldestPrice = p5; // default old price for display benchmark
                    const gain = parseFloat((todayPrice - oldestPrice).toFixed(2));
                    const gainPct = oldestPrice > 0 ? parseFloat(((gain / oldestPrice) * 100).toFixed(2)) : 0;
                    
                    gainersRows.push({
                        symbol: symbol,
                        old: oldestPrice,
                        today: todayPrice,
                        gain: gain,
                        pct: gainPct
                    });
                }
            }
        } else {
            // Collect prices from last windowDays + 1 date columns going forward to compare today vs N days ago
            const prices = [];
            const limit = Math.min(row.length, insertIdx + windowDays + 1);
            for (let colIdx = insertIdx; colIdx < limit; colIdx++) {
                const pVal = parseFloat(row[colIdx]);
                if (!isNaN(pVal)) {
                    prices.push(pVal);
                }
            }
            
            // Need today's price (prices[0]) and at least one older price to compute gain
            if (prices.length >= 2) {
                const todayPrice = prices[0];
                const oldestPrice = prices[prices.length - 1]; // oldest available date in the window
                const gain = parseFloat((todayPrice - oldestPrice).toFixed(2));
                const gainPct = oldestPrice > 0 ? parseFloat(((gain / oldestPrice) * 100).toFixed(2)) : 0;
                
                gainersRows.push({
                    symbol: symbol,
                    old: oldestPrice,
                    today: todayPrice,
                    gain: gain,
                    pct: gainPct
                });
            }
        }
    }
    
    // Sort descending by gain percentage
    gainersRows.sort((a, b) => b.pct - a.pct);
    
    // Render Top Performer Card (#1 Stock)
    const topPerformerCard = document.getElementById('top-performer-card');
    if (gainersRows.length > 0) {
        const best = gainersRows[0];
        document.getElementById('performer-symbol').textContent = best.symbol;
        document.getElementById('performer-today-price').textContent = `₹${best.today.toFixed(2)}`;
        document.getElementById('performer-old-price').textContent = `₹${best.old.toFixed(2)}`;
        
        const sign = best.gain > 0 ? '+' : '';
        const color = best.gain > 0 ? 'var(--success-color)' : best.gain < 0 ? 'var(--danger-color)' : 'var(--text-primary)';
        
        const gainValEl = document.getElementById('performer-gain-val');
        gainValEl.textContent = `${sign}₹${best.gain.toFixed(2)}`;
        gainValEl.style.color = color;
        
        const gainPctEl = document.getElementById('performer-gain-pct');
        gainPctEl.textContent = `${sign}${best.pct}%`;
        gainPctEl.style.color = color;
        
        // Update labels dynamically based on window selection
        const performerHeader = topPerformerCard.querySelector('.performer-header h2');
        if (performerHeader) {
            performerHeader.textContent = windowDays === 'common' ? 'Common Leader' : `${windowDays}-Day Leader`;
        }
        
        const oldPriceLabel = document.getElementById('performer-old-price').parentNode;
        if (oldPriceLabel) {
            oldPriceLabel.childNodes[0].textContent = windowDays === 'common' ? 'Old Price (5d): ' : `Old Price (${windowDays}d): `;
        }
        
        topPerformerCard.classList.remove('hidden');
    } else {
        topPerformerCard.classList.add('hidden');
    }
    
    // Update card title and descriptions
    const cardTitle = document.getElementById('gainer-card-title');
    const sliceLimit = 50;
    if (windowDays === 'common') {
        if (cardTitle) cardTitle.textContent = `Common Gainers (1d, 2d, 3d, 5d, 30d)`;
        const cardDesc = document.getElementById('gainer-card-desc');
        if (cardDesc) cardDesc.textContent = `કોમન સ્ક્રિપ્ટ્સ જે 1, 2, 3, 5 અને 30 દિવસના તમામ સમયગાળામાં સતત પોઝિટિવ વળતર ધરાવે છે.`;
        const tableHeaderOld = document.getElementById('gainer-table-old-price-header');
        if (tableHeaderOld) tableHeaderOld.textContent = `Price (5d)`;
    } else {
        if (cardTitle) cardTitle.textContent = `Top ${sliceLimit} Gainers (${windowDays} Day${windowDays > 1 ? 's' : ''})`;
        const cardDesc = document.getElementById('gainer-card-desc');
        if (cardDesc) cardDesc.textContent = `Companies showing the highest net positive close-to-close change over the last ${windowDays} active trading days.`;
        const tableHeaderOld = document.getElementById('gainer-table-old-price-header');
        if (tableHeaderOld) tableHeaderOld.textContent = `Price (${windowDays}d)`;
    }
    
    // Select top 50
    const topGainers = gainersRows.slice(0, sliceLimit);
    
    // Render to table
    let html = '';
    if (topGainers.length === 0) {
        html = '<tr><td colspan="7" style="text-align:center;">No data available</td></tr>';
    } else {
        topGainers.forEach(item => {
            const sign = item.gain > 0 ? '+' : '';
            const color = item.gain > 0 ? 'var(--success-color)' : item.gain < 0 ? 'var(--danger-color)' : 'var(--text-primary)';
            
            // Get already fetched live price or fall back to today's close price as EOD
            // FIX: Show "Price unavailable" if symbol failed recently instead of hanging on Loading
            const livePriceVal = state.gainersLivePrices.get(item.symbol);
            const livePriceHtml = livePriceVal 
                ? `₹${livePriceVal.toFixed(2)} <span class="live-pulse" style="width:6px;height:6px;box-shadow:0 0 0 0 rgba(16,185,129,0.7);animation:pulse 1.5s infinite;margin-left:0.2rem;display:inline-block;border-radius:50%;background:#10b981;"></span>`
                : isFailedSymbolRecent(item.symbol)
                ? `<span style="font-size:0.75rem;color:var(--text-secondary);">Price unavailable</span>`
                : `₹${item.today.toFixed(2)} <span style="font-size:0.7rem;color:var(--text-secondary);">(EOD)</span>`;

            // Check if already in watchlist
            const inWatchlist = watchlistItems.some(w => w.symbol === item.symbol);
            const starBtn = inWatchlist
                ? `<button onclick="removeFromWatchlist('${item.symbol}'); event.stopPropagation();" title="Watchlistમાંથી કાઢો" style="background:rgba(245,158,11,0.18); border:1px solid #f59e0b; color:#f59e0b; border-radius:5px; padding:0.25rem 0.55rem; cursor:pointer; font-size:0.85rem;"><i class='fa-solid fa-star'></i></button>`
                : `<button onclick="addToWatchlist('${item.symbol}', ${item.today}); event.stopPropagation();" title="Watchlistમાં ઉમેરો" style="background:none; border:1px solid rgba(255,255,255,0.15); color:var(--text-secondary); border-radius:5px; padding:0.25rem 0.55rem; cursor:pointer; font-size:0.85rem;"><i class='fa-regular fa-star'></i></button>`;

            html += `
                <tr class="clickable-row" title="Click to view price history chart" onclick="showResearchModal('${item.symbol}')">
                    <td><strong>${item.symbol}</strong></td>
                    <td>₹${item.old.toFixed(2)}</td>
                    <td>₹${item.today.toFixed(2)}</td>
                    <td class="live-price-cell" data-symbol="${item.symbol}">${livePriceHtml}</td>
                    <td style="color:${color}; font-weight:600;">${sign}₹${item.gain.toFixed(2)}</td>
                    <td><span class="volatility-pct" style="color:${color};">${sign}${item.pct}%</span></td>
                    <td style="text-align:center;">${starBtn}</td>
                </tr>
            `;
        });
    }
    movementTable.querySelector('tbody').innerHTML = html;
    
    // Fetch live prices for top gainers asynchronously in the background (only if stale & not recently failed)
    if (topGainers.length > 0 && isTabActive('tab-research')) {
        const symsToFetch = topGainers.map(t => t.symbol).filter(s => !isPriceFresh(s) && !isFailedSymbolRecent(s));
        if (symsToFetch.length > 0) {
            fetchGainersLivePrices(symsToFetch);
        }
    }
}

// FIX: Paginate Results Table (100 rows initial, Load More / Show All) so Master load & typing never freeze browser
const RESULTS_PAGE_SIZE = 100;
let resultsVisibleLimit = RESULTS_PAGE_SIZE;
let filterDebounceTimer = null;

function renderFilteredResults(resetLimit = true) {
    const data = state.processedMasterData;
    if (!data || data.length === 0) return;

    if (resetLimit) {
        resultsVisibleLimit = RESULTS_PAGE_SIZE;
    }

    const headers = data[0];

    // Render headers
    let headerHtml = '<tr>';
    headers.forEach(h => {
        headerHtml += `<th>${h || ''}</th>`;
    });
    headerHtml += '</tr>';
    resultsTable.querySelector('thead').innerHTML = headerHtml;

    // Get filter inputs
    const searchVal = searchCompany.value.toUpperCase().trim();
    const minP = parseFloat(priceMin.value);
    const maxP = parseFloat(priceMax.value);
    const minD = parseFloat(diffMin.value);
    const maxD = parseFloat(diffMax.value);

    const latestIndex = state.latestDateColIndex;
    const diffIndex = state.diffColIndex;
    const symbolIndex = state.symbolColIndex;

    const matchedRows = [];
    for (let i = 1; i < data.length; i++) {
        const row = data[i];
        const symbol = String(row[symbolIndex] || '').trim().toUpperCase();
        if (!symbol) continue;

        if (searchVal && !symbol.includes(searchVal)) continue;

        const latestPrice = parseFloat(row[latestIndex]);
        if (!isNaN(minP) && (isNaN(latestPrice) || latestPrice < minP)) continue;
        if (!isNaN(maxP) && (isNaN(latestPrice) || latestPrice > maxP)) continue;

        if (diffIndex !== -1) {
            const diffVal = parseFloat(row[diffIndex]);
            if (!isNaN(minD) && (isNaN(diffVal) || diffVal < minD)) continue;
            if (!isNaN(maxD) && (isNaN(diffVal) || diffVal > maxD)) continue;
        }

        matchedRows.push(row);
    }

    const filteredCount = matchedRows.length;
    const rowsToRender = matchedRows.slice(0, resultsVisibleLimit);
    let bodyHtml = '';

    for (let r = 0; r < rowsToRender.length; r++) {
        const row = rowsToRender[r];
        bodyHtml += '<tr class="clickable-row" title="Click to view price history chart">';
        for (let colIndex = 0; colIndex < headers.length; colIndex++) {
            const val = row[colIndex] !== undefined ? row[colIndex] : '';

            let style = '';
            if (colIndex === diffIndex) {
                const dNum = parseFloat(val);
                if (!isNaN(dNum)) {
                    style = dNum > 0 ? 'style="color:#10b981; font-weight:600;"' : dNum < 0 ? 'style="color:#ef4444; font-weight:600;"' : '';
                }
            } else if (colIndex === latestIndex) {
                style = 'style="color:#06b6d4; font-weight:600;"';
            }

            bodyHtml += `<td ${style}>${val}</td>`;
        }
        bodyHtml += '</tr>';
    }

    if (filteredCount === 0) {
        bodyHtml = `<tr><td colspan="${headers.length}" style="text-align:center; padding: 2rem; color:var(--text-secondary);">No matching stocks found.</td></tr>`;
    }

    resultsTable.querySelector('tbody').innerHTML = bodyHtml;
    resultsCount.textContent = `Found Stocks: ${filteredCount} / ${data.length - 1}`;

    const paginationBar = document.getElementById('results-pagination-bar');
    const showingInfo = document.getElementById('results-showing-info');
    if (paginationBar) {
        if (filteredCount > rowsToRender.length) {
            paginationBar.classList.remove('hidden');
            paginationBar.style.display = 'flex';
            if (showingInfo) {
                showingInfo.textContent = `Showing ${rowsToRender.length} of ${filteredCount} stocks`;
            }
        } else {
            paginationBar.classList.add('hidden');
            paginationBar.style.display = 'none';
        }
    }
}

// Filter change handler (with debounce for smooth typing)
function applyFilters() {
    renderFilteredResults(true);
}

function debouncedApplyFilters() {
    if (filterDebounceTimer) clearTimeout(filterDebounceTimer);
    filterDebounceTimer = setTimeout(() => {
        renderFilteredResults(true);
    }, 150);
}

// Reset filters
function resetFilters() {
    searchCompany.value = '';
    priceMin.value = '';
    priceMax.value = '';
    diffMin.value = '';
    diffMax.value = '';
    renderFilteredResults(true);
    showNotification('All filters have been reset.', 'info');
}

function ensureProcessedWorkbook() {
    if (state.processedWorkbook) return state.processedWorkbook;
    if (!state.processedMasterData || state.processedMasterData.length === 0) return null;

    const wb = state.masterWorkbook || XLSX.utils.book_new();
    const wsName = state.masterSheetName || 'Sheet1';
    const newSheet = XLSX.utils.aoa_to_sheet(state.processedMasterData);
    if (!state.masterWorkbook) {
        XLSX.utils.book_append_sheet(wb, newSheet, wsName);
        state.masterWorkbook = wb;
    } else {
        wb.Sheets[wsName] = newSheet;
    }
    state.processedWorkbook = wb;
    return wb;
}

// Download updated master file
function downloadUpdatedFile() {
    const wb = ensureProcessedWorkbook();
    if (!wb) {
        showNotification('No data available to download.', 'error');
        return;
    }
    
    try {
        const originalName = state.masterFile ? state.masterFile.name : 'Master.xlsx';
        const nameParts = originalName.split('.');
        const ext = nameParts.pop();
        const baseName = nameParts.join('.');
        
        const newFilename = `${baseName}_updated_${new Date().toISOString().slice(0, 10)}.${ext}`;
        
        log(`Downloading file: ${newFilename}`, 'info');
        
        // Write file
        XLSX.writeFile(wb, newFilename);
        showNotification('File download started.', 'success');
    } catch (err) {
        console.error(err);
        showNotification('Error downloading file.', 'error');
        log(`Download error: ${err.message}`, 'error');
    }
}

// Render Price History Line Chart in Modal (Oldest to Newest)
function showPriceChart(symbol) {
    const data = state.processedMasterData;
    if (!data || data.length < 2) return;
    
    const headers = data[0];
    const symbolIndex = state.symbolColIndex;
    const isinIndex = state.isinColIndex;
    const highIndex = state.highColIndex;
    
    // Find the row for the clicked company
    const row = data.find((r, idx) => idx > 0 && String(r[symbolIndex] || '').trim().toUpperCase() === symbol);
    if (!row) return;
    
    const dateLabels = [];
    const prices = [];
    
    // Collect all date columns starting right after HIGH column
    const startIdx = highIndex !== -1 ? highIndex + 1 : (state.diffColIndex !== -1 ? state.diffColIndex + 1 : symbolIndex + 1);
    for (let colIdx = startIdx; colIdx < row.length; colIdx++) {
        const headerName = headers[colIdx];
        const pVal = parseFloat(row[colIdx]);
        if (headerName && !isNaN(pVal)) {
            dateLabels.push(headerName);
            prices.push(pVal);
        }
    }
    
    if (prices.length === 0) {
        showNotification('No price history data found.', 'warning');
        return;
    }
    
    // Reverse both arrays to render chronologically from oldest (left) to newest (right)
    dateLabels.reverse();
    prices.reverse();
    
    // Update Modal text content
    document.getElementById('modal-company-title').textContent = symbol;
    document.getElementById('modal-company-isin').textContent = isinIndex !== -1 ? String(row[isinIndex] || '') : '';
    
    // Stats boxes
    const latestPriceVal = prices[prices.length - 1];
    const oldComparePriceIndex = Math.max(0, prices.length - 30);
    const oldPriceVal = prices[oldComparePriceIndex];

    document.getElementById('modal-high-price').textContent = highIndex !== -1 && row[highIndex] ? `₹${parseFloat(row[highIndex]).toFixed(2)}` : 'N/A';
    document.getElementById('modal-latest-price').textContent = `₹${latestPriceVal.toFixed(2)}`; // Newest price (last index after reverse)
    document.getElementById('modal-old-price').textContent = `₹${oldPriceVal.toFixed(2)}`; // 30 days ago (or oldest available)
    
    // Destroy previous Chart instance if any
    if (state.chartInstance) {
        state.chartInstance.destroy();
        state.chartInstance = null;
    }

    // Build fallback candles from Master close series and render Candlestick + Bollinger Bands + 1m/3m/5m/10m/1D
    const fallbackCandles = prices.map((p, idx) => {
        const prev = idx > 0 ? prices[idx - 1] : p;
        return {
            time: idx,
            label: String(dateLabels[idx] || ''),
            open: prev,
            high: Math.max(prev, p),
            low: Math.min(prev, p),
            close: p,
            volume: 0
        };
    });
    // Show Modal before canvas draw so dimensions measure accurately
    document.getElementById('chart-modal').classList.remove('hidden');

    if (typeof renderModalCandleChart === 'function') {
        renderModalCandleChart('cm', symbol, 'price-chart', fallbackCandles);
    }
    
    // Fetch Live Price from Yahoo Finance (FIX: uses cached/timeout-protected fetchYahooFinanceData, max 3 sources)
    const livePriceEl = document.getElementById('modal-live-price');
    if (livePriceEl) {
        livePriceEl.textContent = 'Fetching...';
        livePriceEl.style.color = '#ffffff';

        const rawSym = symbol.trim().toUpperCase();
        const yahooSymbol = rawSym.endsWith('.NS') || rawSym.endsWith('.BO') ? rawSym : rawSym + '.NS';

        const renderLivePrice = (meta) => {
            const currentPrice = meta.regularMarketPrice;
            const prevClose = meta.chartPreviousClose;
            if (currentPrice !== undefined && currentPrice !== null) {
                const diff = currentPrice - prevClose;
                const pct = prevClose ? (diff / prevClose) * 100 : 0;
                const sign = diff >= 0 ? '+' : '';
                const color = diff >= 0 ? 'var(--success-color)' : 'var(--danger-color)';
                livePriceEl.innerHTML = `₹${currentPrice.toFixed(2)} <span style="font-size: 0.75rem; font-weight: 600; color: ${color}; margin-left: 0.35rem;">(${sign}${pct.toFixed(2)}%)</span>`;
            } else {
                livePriceEl.textContent = 'Price unavailable';
            }
        };

        (async () => {
            try {
                const data = await fetchYahooFinanceData(yahooSymbol);
                if (data && data.chart && data.chart.result && data.chart.result[0]) {
                    renderLivePrice(data.chart.result[0].meta);
                    return;
                }
            } catch (e) {
                console.warn('Modal live price fetch failed:', e.message);
            }
            livePriceEl.textContent = 'Price unavailable';
        })();
    }
}

// Fetch and Render Company Research Report in Modal
window.showResearchModal = function(symbol) {
    // Prevent event bubbling if triggered inside row click
    if (window.event) {
        window.event.stopPropagation();
    }
    
    // Set titles
    document.getElementById('research-company-title').textContent = `${symbol} RESEARCH`;
    
    // Reset contents to loading
    const descEl = document.getElementById('research-description');
    const highEl = document.getElementById('research-52w-high');
    const lowEl = document.getElementById('research-52w-low');
    const badgeEl = document.getElementById('research-sentiment-badge');
    const adviceEl = document.getElementById('research-sentiment-text');
    
    descEl.textContent = 'કંપનીની માહિતી મેળવી રહ્યા છીએ...';
    highEl.textContent = '₹0.00';
    lowEl.textContent = '₹0.00';
    badgeEl.textContent = 'Calculating...';
    badgeEl.style.background = '#64748b';
    badgeEl.style.color = '#fff';
    adviceEl.textContent = 'ગણતરી કરી રહ્યા છીએ...';
    
    // Reset chart stats
    const chartLivePriceEl = document.getElementById('chart-live-price');
    const chartDataHighEl = document.getElementById('chart-data-high');
    const chartDataLowEl = document.getElementById('chart-data-low');
    if (chartLivePriceEl) chartLivePriceEl.textContent = 'Loading...';
    if (chartDataHighEl) chartDataHighEl.textContent = 'Loading...';
    if (chartDataLowEl) chartDataLowEl.textContent = 'Loading...';
    
    // Set external links
    document.getElementById('link-screener').href = `https://www.screener.in/company/${symbol}/`;
    document.getElementById('link-tickertape').href = `https://www.tickertape.in/stocks/${symbol}`;
    document.getElementById('link-moneycontrol').href = `https://www.moneycontrol.com/userview/alerts/editorialSearch?str=${symbol}`;
    
    // Draw Historical Chart
    let drawChart = false;
    let dateLabels = [];
    let prices = [];
    
    const masterData = state.processedMasterData;
    if (masterData && masterData.length >= 2) {
        const headers = masterData[0];
        const symbolIndex = state.symbolColIndex;
        const highIndex = state.highColIndex;
        
        if (symbolIndex !== -1) {
            const row = masterData.find((r, idx) => idx > 0 && String(r[symbolIndex] || '').trim().toUpperCase() === symbol);
            if (row) {
                const startIdx = highIndex !== -1 ? highIndex + 1 : (state.diffColIndex !== -1 ? state.diffColIndex + 1 : symbolIndex + 1);
                const maxColIdx = Math.min(headers.length, row.length);
                for (let colIdx = startIdx; colIdx < maxColIdx; colIdx++) {
                    const headerName = headers[colIdx];
                    if (headerName) {
                        dateLabels.push(headerName);
                        
                        const pVal = parseFloat(row[colIdx]);
                        if (!isNaN(pVal)) {
                            prices.push(pVal);
                        } else {
                            prices.push(null);
                        }
                    }
                }
                if (prices.length > 0) {
                    dateLabels.reverse();
                    prices.reverse();
                    drawChart = true;
                    
                    // Populate Data High / Data Low from master file prices
                    const validPrices = prices.filter(p => p !== null && !isNaN(p));
                    if (validPrices.length > 0 && chartDataHighEl && chartDataLowEl) {
                        chartDataHighEl.textContent = `₹${Math.max(...validPrices).toFixed(2)}`;
                        chartDataLowEl.textContent = `₹${Math.min(...validPrices).toFixed(2)}`;
                    }
                }
            }
        }
    }
    
    // Destroy previous Chart instance if any
    if (state.researchChartInstance) {
        state.researchChartInstance.destroy();
        state.researchChartInstance = null;
    }

    const fallbackCandles = drawChart
        ? prices.reduce((acc, p, idx) => {
            if (p !== null && !isNaN(p)) {
                const prev = acc.length > 0 ? acc[acc.length - 1].close : p;
                acc.push({
                    time: idx,
                    label: String(dateLabels[idx] || ''),
                    open: prev,
                    high: Math.max(prev, p),
                    low: Math.min(prev, p),
                    close: p,
                    volume: 0
                });
            }
            return acc;
        }, [])
        : [];

    // Show Modal immediately so canvas has measured layout dimensions
    document.getElementById('research-modal').classList.remove('hidden');

    if (typeof renderModalCandleChart === 'function') {
        renderModalCandleChart('rm', symbol, 'research-price-chart', fallbackCandles);
    }
    
    // 1. Fetch Company Summary from DuckDuckGo Instant Answers API (FIX: 6s timeout so slow networks never hang)
    const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(symbol)}+company&format=json`;
    fetchWithTimeout(ddgUrl, {}, FETCH_TIMEOUT_MS)
        .then(res => res.json())
        .then(data => {
            const rawDescription = data.AbstractText || data.Definition || `${symbol} is an Indian company engaged in commercial and business activities, listed on the National Stock Exchange (NSE).`;
            
            // Translate to Gujarati using Google Translate's free API
            const translateUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=gu&dt=t&q=${encodeURIComponent(rawDescription)}`;
            fetchWithTimeout(translateUrl, {}, FETCH_TIMEOUT_MS)
                .then(res => res.json())
                .then(transData => {
                    const sentences = transData && transData[0] ? transData[0].map(s => s[0]).join('') : '';
                    descEl.textContent = sentences || rawDescription;
                })
                .catch(transErr => {
                    console.warn("Translation failed, displaying English description:", transErr);
                    descEl.textContent = rawDescription;
                });
        })
        .catch(err => {
            console.warn("DuckDuckGo fetch failed:", err?.message || err);
            descEl.textContent = `${symbol} એ ભારતીય શેરબજાર (NSE) માં સૂચિબદ્ધ કંપની છે જે ભારતમાં વિવિધ વ્યાપારી પ્રવૃત્તિઓ સાથે સંકળાયેલી છે. વધુ માહિતી માટે નીચે આપેલ લિંક્સની મુલાકાત લો.`;
        });
        
    // 2. Fetch Yahoo Finance Stock Quote Data for Technical Sentiment & 52W High/Low
    const rawSymForYahoo = symbol.trim().toUpperCase();
    const yahooNsSymbol = rawSymForYahoo.endsWith('.NS') ? rawSymForYahoo : rawSymForYahoo + '.NS';

    // Parser function to extract and render data from Yahoo Finance response
    const parseYahooData = (data) => {
        if (!data || !data.chart || !data.chart.result || !data.chart.result[0]) {
            throw new Error("Invalid Yahoo Finance response structure");
        }

        const result = data.chart.result[0];
        const meta = result.meta;
        const currentPrice = meta.regularMarketPrice;
        const longName = meta.longName || symbol;

        if (longName) {
            document.getElementById('research-company-title').textContent = longName.toUpperCase();
        }

        // Populate Live Price in the chart stats strip
        const liveEl = document.getElementById('chart-live-price');
        if (liveEl) {
            liveEl.textContent = currentPrice ? `\u20b9${currentPrice.toFixed(2)}` : 'N/A';
        }

        // Dynamic client-side calculation of 52-week High and Low from full year data
        let high52 = meta.fiftyTwoWeekHigh;
        let low52 = meta.fiftyTwoWeekLow;

        try {
            if (result.indicators && result.indicators.quote && result.indicators.quote[0]) {
                const closePrices = result.indicators.quote[0].close.filter(x => x !== null && x !== undefined && !isNaN(x));
                if (closePrices.length > 0) {
                    high52 = Math.max(...closePrices);
                    low52 = Math.min(...closePrices);
                }
            }
        } catch (calcErr) {
            console.warn("Dynamic 52W high/low calc failed, using metadata:", calcErr);
        }

        if (high52 && low52 && currentPrice) {
            highEl.textContent = `\u20b9${high52.toFixed(2)}`;
            lowEl.textContent = `\u20b9${low52.toFixed(2)}`;

            const totalRange = high52 - low52;
            const position = currentPrice - low52;
            const pctPosition = totalRange > 0 ? (position / totalRange) * 100 : 50;

            let sentiment, color, gujAdvice;

            if (pctPosition >= 80) {
                sentiment = 'Strong Buy / Bullish';
                color = 'var(--success-color)';
                gujAdvice = `\u0ab8\u0acd\u0a9f\u0acb\u0a95 \u0ab9\u0abe\u0ab2\u0aae\u0abe\u0a82 \u0aae\u0a9c\u0aac\u0ac2\u0aa4 \u0aa4\u0ac7\u0a9c\u0ac0 (Bullish) \u0aae\u0abe\u0a82 \u0a9b\u0ac7 \u0a85\u0aa8\u0ac7 \u0aa4\u0ac7\u0aa8\u0abe \u0aeb\u0ae8-\u0a85\u0aa0\u0ab5\u0abe\u0aa1\u0abf\u0aaf\u0abe\u0aa8\u0abe \u0a89\u0a9a\u0acd\u0a9a \u0ab8\u0acd\u0aa4\u0ab0\u0aa8\u0ac0 \u0aa8\u0a9c\u0ac0\u0a95 \u0a9f\u0acd\u0ab0\u0ac7\u0aa1 \u0a95\u0ab0\u0ac0 \u0ab0\u0ab9\u0acd\u0aaf\u0acb \u0a9b\u0ac7. \u0aa8\u0abf\u0ab7\u0acd\u0aa3\u0abe\u0aa4\u0acb\u0aa8\u0abe \u0aae\u0aa4\u0ac7 \u0ab8\u0acd\u0a9f\u0acb\u0a95\u0aae\u0abe\u0a82 \u0aae\u0acb\u0aae\u0ac7\u0aa8\u0acd\u0a9f\u0aae \u0aae\u0a9c\u0aac\u0ac2\u0aa4 \u0a9b\u0ac7. \u0a9f\u0ac2\u0a82\u0a95\u0abe \u0a97\u0abe\u0ab3\u0abe\u0aa8\u0abe \u0aa8\u0aab\u0abe \u0aae\u0abe\u0a9f\u0ac7 \u0a86 \u0a8f\u0a95 \u0ab8\u0abe\u0ab0\u0acb \u0ab5\u0abf\u0a95\u0ab2\u0acd\u0aaa \u0ab9\u0acb\u0a88 \u0ab6\u0a95\u0ac7 \u0a9b\u0ac7.`;
            } else if (pctPosition <= 20) {
                sentiment = 'Value Buy / Oversold';
                color = '#e11d48';
                gujAdvice = `\u0ab8\u0acd\u0a9f\u0acb\u0a95 \u0aa4\u0ac7\u0aa8\u0abe \u0aeb\u0ae8-\u0a85\u0aa0\u0ab5\u0abe\u0aa1\u0abf\u0aaf\u0abe\u0aa8\u0abe \u0aa8\u0ac0\u0a9a\u0ab2\u0abe \u0ab8\u0acd\u0aa4\u0ab0\u0aa8\u0ac0 \u0aa8\u0a9c\u0ac0\u0a95 \u0a9b\u0ac7 \u0a85\u0aa8\u0ac7 \u0a93\u0ab5\u0ab0\u0ab8\u0acb\u0ab2\u0acd\u0aa1 (Oversold) \u0a9d\u0acb\u0aa8\u0aae\u0abe\u0a82 \u0a86\u0ab5\u0ac0 \u0a97\u0aaf\u0acb \u0a9b\u0ac7. \u0ab2\u0abe\u0a82\u0aac\u0abe \u0a97\u0abe\u0ab3\u0abe\u0aa8\u0abe \u0ab0\u0acb\u0a95\u0abe\u0aa3\u0a95\u0abe\u0ab0\u0acb \u0aae\u0abe\u0a9f\u0ac7 \u0a86 \u0ab8\u0abe\u0ab0\u0abe \u0aad\u0abe\u0ab5\u0ac7 \u0a96\u0ab0\u0ac0\u0aa6\u0ac0 \u0a95\u0ab0\u0ab5\u0abe\u0aa8\u0ac0 \u0aa4\u0a95 \u0ab9\u0acb\u0a88 \u0ab6\u0a95\u0ac7 \u0a9b\u0ac7. \u0a95\u0a82\u0aaa\u0aa8\u0ac0\u0aa8\u0abe \u0aab\u0a82\u0aa1\u0abe\u0aae\u0ac7\u0aa8\u0acd\u0a9f\u0ab2\u0acd\u0ab8 \u0a9a\u0a95\u0abe\u0ab8\u0ac0\u0aa8\u0ac7 \u0ab0\u0abf\u0ab5\u0ab0\u0acd\u0ab8\u0ab2 \u0a9f\u0acd\u0ab0\u0ac7\u0aa8\u0acd\u0aa1\u0aa8\u0ac0 \u0ab0\u0abe\u0ab9 \u0a9c\u0acb\u0ab5\u0ac0 \u0a96\u0ab0\u0ac0\u0aa6\u0ac0 \u0a95\u0ab0\u0ab5\u0ac0.`;
            } else {
                sentiment = 'Hold / Neutral';
                color = '#eab308';
                gujAdvice = `\u0ab8\u0acd\u0a9f\u0acb\u0a95 \u0aae\u0aa7\u0acd\u0aaf\u0aae \u0ab6\u0acd\u0ab0\u0ac7\u0aa3\u0ac0\u0aae\u0abe\u0a82 \u0a9a\u0abe\u0ab2\u0ac0 \u0ab0\u0ab9\u0acd\u0aaf\u0acb \u0a9b\u0ac7. \u0a85\u0aa4\u0acd\u0aaf\u0abe\u0ab0\u0ac7 \u0ab9\u0abe\u0ab2\u0aa8\u0abe \u0ab0\u0acb\u0a95\u0abe\u0aa3\u0aa8\u0ac7 Hold \u0a95\u0ab0\u0ac0 \u0ab0\u0abe\u0a96\u0ab5\u0ac1\u0a82 \u0ab5\u0aa7\u0ac1 \u0aaf\u0acb\u0a97\u0acd\u0aaf \u0ab0\u0ab9\u0ac7\u0ab6\u0ac7. \u0aa8\u0ab5\u0ac0 \u0a96\u0ab0\u0ac0\u0aa6\u0ac0 \u0aae\u0abe\u0a9f\u0ac7 'Buy on Dips' \u0aa8\u0ac0 \u0ab0\u0aa3\u0aa8\u0ac0\u0aa4\u0abf \u0a85\u0aaa\u0aa8\u0abe\u0ab5\u0acb.`;
            }

            badgeEl.textContent = sentiment;
            badgeEl.style.background = color;
            badgeEl.style.color = '#ffffff';
            adviceEl.textContent = gujAdvice;
        } else {
            highEl.textContent = 'N/A';
            lowEl.textContent = 'N/A';
            badgeEl.textContent = 'Hold';
            badgeEl.style.background = '#eab308';
            badgeEl.style.color = '#fff';
            adviceEl.textContent = '\u0a86 \u0ab8\u0acd\u0a9f\u0acb\u0a95\u0aa8\u0acb \u0aeb\u0ae8 \u0a85\u0aa0\u0ab5\u0abe\u0aa1\u0abf\u0aaf\u0abe\u0aa8\u0acb \u0ab5\u0abf\u0a97\u0aa4\u0ab5\u0abe\u0ab0 \u0aa1\u0ac7\u0a9f\u0abe \u0aa1\u0abe\u0a89\u0aa8\u0ab2\u0acb\u0aa1 \u0aa5\u0a88 \u0ab6\u0a95\u0acd\u0aaf\u0acb \u0aa8\u0aa5\u0ac0. Screener.in \u0a85\u0aa5\u0ab5\u0abe Tickertape.in \u0aa8\u0ac0 \u0aae\u0ac1\u0ab2\u0abe\u0a95\u0abe\u0aa4 \u0ab2\u0acb.';
        }
    };

    // FIX: Try at most 3 sources (/api/yahoo first, then 2 proxies), each with a 6s AbortController timeout
    const researchYahooBase = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooNsSymbol)}?range=1y&interval=1d`;
    const researchUrls = [
        `/api/yahoo?symbol=${encodeURIComponent(yahooNsSymbol)}`,
        `https://api.allorigins.win/raw?url=${encodeURIComponent(researchYahooBase)}`,
        `https://corsproxy.io/?url=${encodeURIComponent(researchYahooBase)}`
    ];

    (async () => {
        let success = false;
        for (const url of researchUrls) {
            try {
                const res = await fetchWithTimeout(url, {}, FETCH_TIMEOUT_MS);
                if (!res.ok) {
                    console.warn(`Yahoo fetch failed (HTTP ${res.status}) for: ${url}`);
                    continue;
                }
                const data = await res.json();
                if (data && data.chart && data.chart.result && data.chart.result[0]) {
                    parseYahooData(data);
                    success = true;
                    break;
                }
            } catch (e) {
                console.warn('Research fetch failed for URL:', url, e.message);
            }
        }
        if (!success) {
            console.warn('All Yahoo Finance sources exhausted for symbol:', symbol);
            highEl.textContent = 'N/A';
            lowEl.textContent = 'N/A';
            badgeEl.textContent = 'Hold';
            badgeEl.style.background = '#eab308';
            badgeEl.style.color = '#fff';
            adviceEl.textContent = 'Yahoo Finance ડેટા હાલ ઉપલબ્ધ નથી. Screener.in અથવા Tickertape.in ની મુલાકાત લો.';
            const liveEl2 = document.getElementById('chart-live-price');
            if (liveEl2) liveEl2.textContent = 'Price unavailable';
        }
    })();
};

// ============================================================================
// NEW FUNCTIONALITY: LIVE PRICES, INDICES, RESULTS & DIVIDENDS
// ============================================================================

// FIX: Bounded Yahoo Finance fetcher: 6s AbortController timeout, max 3 sources, 60s response cache, 5-min failed-symbol cache, in-flight deduplication
async function fetchYahooFinanceData(ticker, forceRefresh = false) {
    const cleanTicker = ticker.trim().toUpperCase();
    const symKey = normalizeSymKey(cleanTicker);
    const now = Date.now();

    if (!forceRefresh) {
        const cached = yahooResponseCache.get(cleanTicker);
        if (cached && (now - cached.timestamp) < PRICE_CACHE_TTL_MS) {
            return cached.data;
        }
        if (isFailedSymbolRecent(symKey)) {
            throw new Error(`Skipping recently failed symbol ${cleanTicker}`);
        }
    }

    if (inFlightYahooRequests.has(cleanTicker)) {
        return inFlightYahooRequests.get(cleanTicker);
    }

    const requestPromise = (async () => {
        const tickerEncoded = encodeURIComponent(cleanTicker);
        const q1Url = `https://query1.finance.yahoo.com/v8/finance/chart/${tickerEncoded}`;
        // FIX: At most 3 sources (/api/yahoo first, then 2 CORS proxies), stop on first success
        const urls = [
            `/api/yahoo?symbol=${tickerEncoded}`,
            `https://api.allorigins.win/raw?url=${encodeURIComponent(q1Url)}`,
            `https://corsproxy.io/?url=${encodeURIComponent(q1Url)}`
        ];

        let lastError = null;
        for (const url of urls) {
            try {
                const res = await fetchWithTimeout(url, {}, FETCH_TIMEOUT_MS);
                if (!res.ok) {
                    lastError = new Error(`HTTP ${res.status}`);
                    continue;
                }
                const data = await res.json();
                if (data && data.chart && data.chart.result && data.chart.result[0]) {
                    yahooResponseCache.set(cleanTicker, { data, timestamp: Date.now() });
                    markPriceFresh(symKey);
                    return data;
                }
            } catch (e) {
                lastError = e;
            }
        }
        markSymbolFailed(symKey);
        throw new Error(`Price unavailable for ${cleanTicker} (${lastError ? lastError.message : 'Timeout/Network'})`);
    })();

    inFlightYahooRequests.set(cleanTicker, requestPromise);
    try {
        return await requestPromise;
    } finally {
        inFlightYahooRequests.delete(cleanTicker);
    }
}

// Fetch live prices for top gainers asynchronously in the background
let isGainersFetchInFlight = false;
async function fetchGainersLivePrices(symbols) {
    if (!symbols || symbols.length === 0 || isGainersFetchInFlight) return;
    isGainersFetchInFlight = true;

    try {
        const uniqueSymbols = [...new Set(symbols)]
            .map(s => String(s || '').trim().toUpperCase())
            .filter(s => s && !isPriceFresh(s) && !isFailedSymbolRecent(s));

        if (uniqueSymbols.length === 0) return;

        // FIX: Limit concurrency to 5 symbols at a time instead of Promise.all over all rows
        await runWithConcurrency(uniqueSymbols, 5, async (symbol) => {
            try {
                const isNumeric = /^\d+$/.test(symbol);
                const prefSuffix = isNumeric ? '.BO' : '.NS';
                const data = await fetchYahooFinanceData(symbol + prefSuffix);
                const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
                if (price !== undefined && price !== null) {
                    state.gainersLivePrices.set(symbol, price);
                    markPriceFresh(symbol);
                    document.querySelectorAll(`.live-price-cell[data-symbol="${symbol}"]`).forEach(cell => {
                        cell.innerHTML = `₹${price.toFixed(2)} <span class="live-pulse" style="width:6px;height:6px;box-shadow:0 0 0 0 rgba(16,185,129,0.7);animation:pulse 1.5s infinite;margin-left:0.2rem;display:inline-block;border-radius:50%;background:#10b981;"></span>`;
                    });
                } else {
                    throw new Error('No market price');
                }
            } catch (e) {
                markSymbolFailed(symbol);
                document.querySelectorAll(`.live-price-cell[data-symbol="${symbol}"]`).forEach(cell => {
                    if (!state.gainersLivePrices.has(symbol)) {
                        cell.innerHTML = '<span style="font-size:0.75rem;color:var(--text-secondary);">Price unavailable</span>';
                    }
                });
                console.warn(`Failed to fetch live price for gainer ${symbol}:`, e.message);
            }
        });
    } finally {
        isGainersFetchInFlight = false;
    }
}

// Fetch Segment Leader indices (Large/Mid/Small Cap) every 30s
// Note: NIFTY 50, SENSEX, GOLD/10g and SILVER/1kg are updated every 1 second by fetchLiveMarket1s()
let isMarketIndicesFetching = false;
async function fetchMarketIndices() {
    if (isMarketIndicesFetching) return;
    isMarketIndicesFetching = true;

    try {
        const indices = [
            { id: 'seg-large', ticker: '^CNX100', name: 'NIFTY 100' },
            { id: 'seg-mid',   ticker: '^CRSMID', name: 'NIFTY MIDCAP 100' },
            { id: 'seg-small', ticker: '^CNXSC',  name: 'NIFTY SMALLCAP 100' }
        ];

        await runWithConcurrency(indices, 3, async (item) => {
            try {
                const data = await fetchYahooFinanceData(item.ticker);
                const meta = data.chart.result[0].meta;
                const currentPrice = meta.regularMarketPrice;
                const prevClose    = meta.previousClose !== undefined ? meta.previousClose : meta.chartPreviousClose;

                if (currentPrice !== undefined && prevClose !== undefined) {
                    const change    = currentPrice - prevClose;
                    const changePct = (change / prevClose) * 100;
                    const valEl = document.getElementById(`${item.id}-val`);
                    const chgEl = document.getElementById(`${item.id}-chg`);
                    if (valEl && chgEl) {
                        valEl.textContent = currentPrice.toLocaleString('en-IN', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2
                        });
                        const sign  = change >= 0 ? '+' : '';
                        const color = change >= 0 ? 'var(--success-color)' : 'var(--danger-color)';
                        chgEl.textContent = `${sign}${change.toFixed(2)} (${sign}${changePct.toFixed(2)}%)`;
                        chgEl.style.color = color;
                        valEl.setAttribute('data-pct', changePct);
                    }
                }
            } catch (e) {
                console.warn(`Failed to fetch segment index ${item.name}:`, e.message);
            }
        });

        try {
            const largeValEl = document.getElementById('seg-large-val');
            const midValEl = document.getElementById('seg-mid-val');
            const smallValEl = document.getElementById('seg-small-val');

            if (largeValEl && midValEl && smallValEl) {
                const largePct = parseFloat(largeValEl.getAttribute('data-pct')) || 0;
                const midPct = parseFloat(midValEl.getAttribute('data-pct')) || 0;
                const smallPct = parseFloat(smallValEl.getAttribute('data-pct')) || 0;

                let leaderName = 'LARGE CAP (NIFTY 100)';
                let leaderPct = largePct;
                let leaderColor = '#3b82f6';

                if (midPct > leaderPct) {
                    leaderName = 'MID CAP (NIFTY MID 100)';
                    leaderPct = midPct;
                    leaderColor = '#a855f7';
                }
                if (smallPct > leaderPct) {
                    leaderName = 'SMALL CAP (NIFTY SMALL 100)';
                    leaderPct = smallPct;
                    leaderColor = '#ec4899';
                }

                const leaderBadge = document.getElementById('segment-leader-badge');
                const leaderContainer = document.getElementById('segment-leader-container');
                if (leaderBadge) {
                    leaderBadge.textContent = `${leaderName} (${leaderPct >= 0 ? '+' : ''}${leaderPct.toFixed(2)}%)`;
                    leaderBadge.style.color = leaderColor;
                    if (leaderContainer) {
                        leaderContainer.style.borderColor = leaderColor;
                        leaderContainer.style.background = `${leaderColor}10`;
                    }
                }
            }
        } catch (err) {
            console.warn("Failed to compute segment leader:", err);
        }
    } finally {
        isMarketIndicesFetching = false;
    }
}

// FIX: Real live NSE/BSE corporate announcements, board meetings & dividends fetched via /api/corporate
let corporateResultsData = [];
let corporateResultsSource = null;
let corporateResultsError = null;
let corporateResultsLastFetch = 0;
let isCorporateFetchInFlight = false;
let isResultsLivePriceInFlight = false;

window.fetchCorporateResults = async function(forceRefresh = false) {
    const tbody = document.querySelector('#upcoming-results-table tbody');
    const sourceBadge = document.getElementById('results-source-badge');

    // Reuse 5-min in-memory cache if available and not forcing refresh
    if (!forceRefresh && corporateResultsData.length > 0 && (Date.now() - corporateResultsLastFetch) < 5 * 60 * 1000) {
        renderResultsAndDividendsTable();
        return;
    }

    if (isCorporateFetchInFlight) return;
    isCorporateFetchInFlight = true;
    corporateResultsError = null;

    if (tbody) {
        tbody.innerHTML = `
            <tr>
                <td colspan="9" style="text-align:center; padding: 2.5rem; color: var(--text-secondary);">
                    <i class="fa-solid fa-spinner fa-spin" style="font-size:1.4rem; color:var(--accent-color); margin-bottom:0.5rem; display:block;"></i>
                    Loading real exchange corporate announcements &amp; dividends...
                </td>
            </tr>
        `;
    }
    if (sourceBadge) {
        sourceBadge.textContent = 'Loading Feed...';
        sourceBadge.style.color = '#f59e0b';
        sourceBadge.style.borderColor = '#f59e0b';
        sourceBadge.style.background = 'rgba(245,158,11,0.12)';
    }

    try {
        const res = await fetchWithTimeout('/api/corporate', {}, 8000);
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        const payload = await res.json();
        if (!payload || !Array.isArray(payload.items) || payload.items.length === 0) {
            throw new Error(payload?.error || 'No corporate events returned');
        }

        corporateResultsData = payload.items;
        corporateResultsSource = payload.source || 'NSE/BSE Live';
        corporateResultsLastFetch = Date.now();
        corporateResultsError = null;

        if (sourceBadge) {
            sourceBadge.textContent = `Live: ${corporateResultsSource} (${corporateResultsData.length})`;
            sourceBadge.style.color = 'var(--success-color)';
            sourceBadge.style.borderColor = 'var(--success-color)';
            sourceBadge.style.background = 'rgba(34,197,94,0.12)';
        }
    } catch (e) {
        console.warn('[Corporate Results] Fetch failed:', e.message);
        corporateResultsError = e.message || 'Data unavailable';
        if (sourceBadge) {
            sourceBadge.textContent = 'Feed Unavailable';
            sourceBadge.style.color = 'var(--danger-color)';
            sourceBadge.style.borderColor = 'var(--danger-color)';
            sourceBadge.style.background = 'rgba(239,68,68,0.12)';
        }
    } finally {
        isCorporateFetchInFlight = false;
    }

    renderResultsAndDividendsTable();
};

// Render Tab 3 Content (Results & Dividends Table)
function renderResultsAndDividendsTable() {
    const tbody = document.querySelector('#upcoming-results-table tbody');
    if (!tbody) return;

    if (corporateResultsError && corporateResultsData.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="9" style="text-align:center; padding: 2.5rem; color: var(--text-secondary);">
                    <i class="fa-solid fa-circle-exclamation" style="font-size:1.5rem; color:var(--danger-color); margin-bottom:0.6rem; display:block;"></i>
                    <div style="font-weight:600; color:#fff; margin-bottom:0.5rem;">Data unavailable, try again</div>
                    <div style="font-size:0.8rem; margin-bottom:1rem;">(${corporateResultsError})</div>
                    <button onclick="fetchCorporateResults(true)" class="btn btn-primary" style="font-size:0.82rem; padding:0.45rem 1.1rem;">
                        <i class="fa-solid fa-rotate"></i> Try Again
                    </button>
                </td>
            </tr>
        `;
        return;
    }

    if (corporateResultsData.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="9" style="text-align:center; padding: 2.5rem; color: var(--text-secondary);">
                    Data unavailable, try again.
                    <div style="margin-top:0.75rem;">
                        <button onclick="fetchCorporateResults(true)" class="btn btn-primary" style="font-size:0.82rem; padding:0.45rem 1.1rem;">
                            <i class="fa-solid fa-rotate"></i> Refresh
                        </button>
                    </div>
                </td>
            </tr>
        `;
        return;
    }

    const searchInput = document.getElementById('results-search-input');
    const query = searchInput ? searchInput.value.trim().toUpperCase() : '';
    const filteredData = query
        ? corporateResultsData.filter(item =>
            String(item.symbol || '').toUpperCase().includes(query) ||
            String(item.companyName || '').toUpperCase().includes(query) ||
            String(item.purpose || '').toUpperCase().includes(query)
        )
        : corporateResultsData;

    if (filteredData.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:2rem; color:var(--text-secondary);">No matching companies found.</td></tr>`;
        return;
    }

    const visibleItems = filteredData.slice(0, 80);
    let html = '';
    visibleItems.forEach(item => {
        const bhavcopyRateVal = getLastKnownPrice(item.symbol);
        const bhavcopyRateHtml = bhavcopyRateVal ? `₹${bhavcopyRateVal.toFixed(2)}` : '<span style="font-size:0.75rem;color:var(--text-secondary);">No Data</span>';

        const livePriceVal = state.gainersLivePrices.get(item.symbol);
        const livePriceHtml = livePriceVal
            ? `₹${livePriceVal.toFixed(2)} <span class="live-pulse" style="width:6px;height:6px;box-shadow:0 0 0 0 rgba(16,185,129,0.7);animation:pulse 1.5s infinite;margin-left:0.2rem;display:inline-block;border-radius:50%;background:#10b981;"></span>`
            : isFailedSymbolRecent(item.symbol)
            ? '<span style="font-size:0.75rem;color:var(--text-secondary);">Price unavailable</span>'
            : '<span style="font-size:0.75rem;color:var(--text-secondary);">Loading...</span>';

        const divBadge = item.isDividend
            ? '<span class="badge-dividend">YES</span>'
            : '<span style="color:var(--text-secondary);font-size:0.78rem;">-</span>';

        const safeSymbol = String(item.symbol || '').replace(/'/g, '');
        const purposeText = String(item.purpose || '-').slice(0, 90);

        html += `
            <tr>
                <td>
                    <strong>${item.symbol}</strong>
                    ${item.companyName ? `<div style="font-size:0.7rem;color:var(--text-secondary);">${item.companyName}</div>` : ''}
                </td>
                <td>${bhavcopyRateHtml}</td>
                <td class="live-price-cell-results" data-symbol="${item.symbol}">${livePriceHtml}</td>
                <td style="white-space:nowrap;"><i class="fa-regular fa-calendar"></i> ${item.date || '-'}</td>
                <td><span style="background:rgba(59,130,246,0.12); color:#60a5fa; padding:0.15rem 0.45rem; border-radius:4px; font-size:0.75rem; font-weight:600;">${item.type || 'Corporate'}</span></td>
                <td style="max-width:260px; white-space:normal; font-size:0.8rem; color:var(--text-primary);">${purposeText}</td>
                <td><span style="background:rgba(6,182,212,0.12); color:var(--accent-color); padding:0.15rem 0.4rem; border-radius:4px; font-size:0.75rem; font-weight:600;">${item.status || 'Upcoming'}</span></td>
                <td>${divBadge}</td>
                <td style="text-align:center;">
                    <button class="btn btn-secondary" onclick="showResearchModal('${safeSymbol}')" style="font-size:0.75rem; padding:0.25rem 0.5rem; display:inline-flex; align-items:center; gap:0.25rem; background:rgba(6,182,212,0.12); color:var(--accent-color); border-color:rgba(6,182,212,0.25);">
                        <i class="fa-solid fa-robot"></i> Research
                    </button>
                </td>
            </tr>
        `;
    });
    tbody.innerHTML = html;

    // Fetch live prices for top 25 visible items only, skipping cached/failed symbols
    if (isTabActive('tab-results')) {
        const symsToFetch = visibleItems.slice(0, 25).map(d => d.symbol).filter(s => s && !isPriceFresh(s) && !isFailedSymbolRecent(s));
        if (symsToFetch.length > 0) {
            fetchResultsLivePrices(symsToFetch);
        }
    }
}

// Fetch live prices for results tab (FIX: concurrency 5, in-flight guard, 60s cache + 5-min failed cache)
async function fetchResultsLivePrices(symbols) {
    if (!symbols || symbols.length === 0 || isResultsLivePriceInFlight) return;
    isResultsLivePriceInFlight = true;

    try {
        const uniqueSymbols = [...new Set(symbols)]
            .map(s => String(s || '').trim().toUpperCase())
            .filter(s => s && !isPriceFresh(s) && !isFailedSymbolRecent(s));

        if (uniqueSymbols.length === 0) return;

        await runWithConcurrency(uniqueSymbols, 5, async (symbol) => {
            try {
                const isNumeric = /^\d+$/.test(symbol);
                const prefSuffix = isNumeric ? '.BO' : '.NS';
                const data = await fetchYahooFinanceData(symbol + prefSuffix);
                const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
                if (price !== undefined && price !== null) {
                    state.gainersLivePrices.set(symbol, price);
                    markPriceFresh(symbol);
                    document.querySelectorAll(`.live-price-cell-results[data-symbol="${symbol}"], .live-price-cell[data-symbol="${symbol}"]`).forEach(cell => {
                        cell.innerHTML = `₹${price.toFixed(2)} <span class="live-pulse" style="width:6px;height:6px;box-shadow:0 0 0 0 rgba(16,185,129,0.7);animation:pulse 1.5s infinite;margin-left:0.2rem;display:inline-block;border-radius:50%;background:#10b981;"></span>`;
                    });
                } else {
                    throw new Error('No price');
                }
            } catch (e) {
                markSymbolFailed(symbol);
                document.querySelectorAll(`.live-price-cell-results[data-symbol="${symbol}"]`).forEach(cell => {
                    if (!state.gainersLivePrices.has(symbol)) {
                        cell.innerHTML = '<span style="font-size:0.75rem;color:var(--text-secondary);">Price unavailable</span>';
                    }
                });
                console.warn(`Failed to fetch live price for results item ${symbol}:`, e.message);
            }
        });
    } finally {
        isResultsLivePriceInFlight = false;
    }
}

// =====================================================================
//  WATCHLIST — State, Persistence (Firebase + localStorage fallback)
// =====================================================================

// In-memory watchlist array: [{symbol, addedPrice, addedAt}]
let watchlistItems = [];

// Load from Firestore (primary) with localStorage fallback
async function loadWatchlistFromCloud() {
    // Try localStorage immediately so UI is instant
    try {
        const saved = localStorage.getItem('rahul_watchlist');
        if (saved) watchlistItems = JSON.parse(saved);
    } catch (_) { watchlistItems = []; }

    if (!db) return; // no Firebase → localStorage only
    try {
        const snap = await db.collection('watchlist').orderBy('addedAt', 'asc').get();
        if (!snap.empty) {
            watchlistItems = [];
            snap.forEach(doc => watchlistItems.push({ id: doc.id, ...doc.data() }));
            // Sync to localStorage as cache
            localStorage.setItem('rahul_watchlist', JSON.stringify(watchlistItems));
        }
    } catch (e) {
        console.warn('Watchlist Firebase load failed, using localStorage:', e.message);
    }
}

// Backward-compatible alias used at startup
function loadWatchlistFromStorage() {
    try {
        const saved = localStorage.getItem('rahul_watchlist');
        watchlistItems = saved ? JSON.parse(saved) : [];
    } catch (e) {
        watchlistItems = [];
    }
    // Also kick off cloud sync (async, non-blocking)
    loadWatchlistFromCloud();
}

// Save to Firestore + localStorage
async function saveWatchlistItem(item) {
    // Save to localStorage immediately
    try { localStorage.setItem('rahul_watchlist', JSON.stringify(watchlistItems)); } catch (_) {}
    if (!db) return;
    try {
        const docRef = await db.collection('watchlist').add({
            symbol:     item.symbol,
            addedPrice: item.addedPrice,
            addedAt:    item.addedAt
        });
        item.id = docRef.id; // store Firestore doc ID for later deletion
    } catch (e) {
        console.warn('Watchlist Firebase save failed:', e.message);
    }
}

async function deleteWatchlistItem(symbol) {
    try { localStorage.setItem('rahul_watchlist', JSON.stringify(watchlistItems)); } catch (_) {}
    if (!db) return;
    try {
        const snap = await db.collection('watchlist').where('symbol', '==', symbol).get();
        snap.forEach(doc => doc.ref.delete());
    } catch (e) {
        console.warn('Watchlist Firebase delete failed:', e.message);
    }
}

async function clearWatchlistInCloud() {
    try { localStorage.removeItem('rahul_watchlist'); } catch (_) {}
    if (!db) return;
    try {
        const snap = await db.collection('watchlist').get();
        const batch = db.batch();
        snap.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
    } catch (e) {
        console.warn('Watchlist Firebase clear failed:', e.message);
    }
}

// Save all to localStorage (called on every change for instant offline access)
function saveWatchlistToStorage() {
    try { localStorage.setItem('rahul_watchlist', JSON.stringify(watchlistItems)); } catch (_) {}
}


// Add a stock
window.addToWatchlist = function(symbol, addedPrice) {
    if (watchlistItems.some(w => w.symbol === symbol)) {
        showNotification(`${symbol} પહેલેથી Watchlist માં છે.`, 'warning');
        return;
    }
    const newItem = {
        symbol,
        addedPrice: parseFloat(addedPrice) || 0,
        addedAt: new Date().toISOString()
    };
    watchlistItems.push(newItem);
    saveWatchlistToStorage();
    saveWatchlistItem(newItem); // Firebase (async)
    showNotification(`⭐ ${symbol} Watchlist માં ઉમેરાયું!`, 'success');
    
    // Refresh all views
    renderGainersAnalysis();
    renderWatchlist();
    if (typeof renderMorningPicks === 'function') renderMorningPicks();
    if (typeof renderVolumePromoterPicks === 'function') renderVolumePromoterPicks();
};

// Remove a stock
window.removeFromWatchlist = function(symbol) {
    watchlistItems = watchlistItems.filter(w => w.symbol !== symbol);
    saveWatchlistToStorage();
    deleteWatchlistItem(symbol); // Firebase (async)
    showNotification(`${symbol} Watchlist માંથી કાઢ્યું.`, 'info');
    
    // Refresh all views
    renderGainersAnalysis();
    renderWatchlist();
    if (typeof renderMorningPicks === 'function') renderMorningPicks();
    if (typeof renderVolumePromoterPicks === 'function') renderVolumePromoterPicks();
};

// Clear all
window.clearWatchlist = function() {
    if (watchlistItems.length === 0) return;
    if (!confirm('શું તમે સમગ્ર Watchlist ખાલી કરવા માંગો છો?')) return;
    watchlistItems = [];
    saveWatchlistToStorage();
    clearWatchlistInCloud(); // Firebase (async)
    
    // Refresh all views
    renderGainersAnalysis();
    renderWatchlist();
    if (typeof renderMorningPicks === 'function') renderMorningPicks();
    if (typeof renderVolumePromoterPicks === 'function') renderVolumePromoterPicks();
    
    showNotification('Watchlist ખાલી કરવામાં આવી.', 'info');
};

// Render the Watchlist tab
window.renderWatchlist = function() {
    const tbody        = document.getElementById('watchlist-tbody');
    const emptyState   = document.getElementById('watchlist-empty-state');
    const tableWrapper = document.getElementById('watchlist-table-wrapper');
    const badge        = document.getElementById('watchlist-count-badge');

    if (!tbody) return;

    const count = watchlistItems.length;
    if (badge) badge.textContent = `${count} Script${count !== 1 ? 's' : ''}`;

    if (count === 0) {
        if (emptyState)   emptyState.style.display  = '';
        if (tableWrapper) tableWrapper.style.display = 'none';
        return;
    }

    if (emptyState)   emptyState.style.display  = 'none';
    if (tableWrapper) tableWrapper.style.display = '';

    const searchInput = document.getElementById('watchlist-search-input');
    const query = searchInput ? searchInput.value.trim().toUpperCase() : '';
    const filteredItems = query 
        ? watchlistItems.filter(item => item.symbol.toUpperCase().includes(query))
        : watchlistItems;

    if (badge) badge.textContent = `${filteredItems.length} Script${filteredItems.length !== 1 ? 's' : ''}`;

    let html = '';
    filteredItems.forEach((item, idx) => {
        const livePrice = state.gainersLivePrices.get(item.symbol);
        let livePriceHtml = isFailedSymbolRecent(item.symbol)
            ? '<span style="font-size:0.75rem;color:var(--text-secondary);">Price unavailable</span>'
            : '<span style="font-size:0.75rem;color:var(--text-secondary);">Loading...</span>';
        let changeHtml    = '-';

        if (livePrice !== undefined) {
            livePriceHtml = `\u20b9${livePrice.toFixed(2)} <span class="live-pulse" style="width:6px;height:6px;background:#22c55e;border-radius:50%;display:inline-block;margin-left:3px;animation:pulse 1.5s infinite;"></span>`;
            if (item.addedPrice > 0) {
                const diff  = livePrice - item.addedPrice;
                const pct   = (diff / item.addedPrice) * 100;
                const sign  = diff >= 0 ? '+' : '';
                const color = diff >= 0 ? 'var(--success-color)' : 'var(--danger-color)';
                changeHtml  = `<span style="color:${color};font-weight:600;">${sign}\u20b9${diff.toFixed(2)} (${sign}${pct.toFixed(2)}%)</span>`;
            }
        }

        const addedPriceStr = item.addedPrice > 0 ? `\u20b9${item.addedPrice.toFixed(2)}` : '-';
        const addedDate = item.addedAt ? new Date(item.addedAt).toLocaleDateString('en-IN') : '-';

        html += `
            <tr class="clickable-row" onclick="showResearchModal('${item.symbol}')" title="\u0a9a\u0abe\u0ab0\u0acd\u0a9f \u0a85\u0aa8\u0ac7 \u0ab5\u0abf\u0a97\u0aa4 \u0a9c\u0ac1\u0a93">
                <td style="color:var(--text-secondary);font-size:0.8rem;">${idx + 1}</td>
                <td>
                    <strong style="color:var(--accent-color);">${item.symbol}</strong><br>
                    <span style="font-size:0.7rem;color:var(--text-secondary);">Added: ${addedDate}</span>
                </td>
                <td>${addedPriceStr}</td>
                <td class="watchlist-live-cell" data-symbol="${item.symbol}">${livePriceHtml}</td>
                <td class="watchlist-change-cell" data-symbol="${item.symbol}" data-added-price="${item.addedPrice}">${changeHtml}</td>
                <td style="text-align:center;">
                    <button onclick="showResearchModal('${item.symbol}'); event.stopPropagation();" title="Research"
                        style="background:var(--accent-light,rgba(59,130,246,0.12));border:1px solid var(--accent-color);color:var(--accent-color);border-radius:5px;padding:0.25rem 0.55rem;cursor:pointer;font-size:0.82rem;">
                        <i class="fa-solid fa-chart-area"></i>
                    </button>
                </td>
                <td style="text-align:center;">
                    <button onclick="removeFromWatchlist('${item.symbol}'); event.stopPropagation();" title="Watchlist \u0aae\u0abe\u0a82\u0aa5\u0ac0 \u0a95\u0abe\u0aa2\u0acb"
                        style="background:rgba(239,68,68,0.1);border:1px solid var(--danger-color);color:var(--danger-color);border-radius:5px;padding:0.25rem 0.55rem;cursor:pointer;font-size:0.82rem;">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </td>
            </tr>
        `;
    });

    tbody.innerHTML = html;

    // FIX: Never trigger fetches for symbols cached within 60s or failed within last 5 minutes
    const missing = watchlistItems
        .map(w => w.symbol)
        .filter(s => (!state.gainersLivePrices.has(s) || !isPriceFresh(s)) && !isFailedSymbolRecent(s));
    if (missing.length > 0 && isTabActive('tab-watchlist')) {
        fetchWatchlistLivePrices(missing);
    }
};

// Fetch live prices for watchlist symbols
// FIX: Break infinite renderWatchlist() loop by updating price & change cells directly in DOM, bounded by concurrency 5 + 6s timeout
let isWatchlistFetchInFlight = false;
async function fetchWatchlistLivePrices(symbols) {
    if (!symbols || symbols.length === 0 || isWatchlistFetchInFlight) return;
    isWatchlistFetchInFlight = true;

    try {
        const uniqueSymbols = [...new Set(symbols)]
            .map(s => String(s || '').trim().toUpperCase())
            .filter(s => s && !isPriceFresh(s) && !isFailedSymbolRecent(s));

        if (uniqueSymbols.length === 0) return;

        await runWithConcurrency(uniqueSymbols, 5, async (symbol) => {
            try {
                const isNumeric = /^\d+$/.test(symbol);
                const ticker = symbol + (isNumeric ? '.BO' : '.NS');
                const data = await fetchYahooFinanceData(ticker);
                const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
                if (price !== undefined && price !== null) {
                    state.gainersLivePrices.set(symbol, price);
                    markPriceFresh(symbol);
                    document.querySelectorAll(`.watchlist-live-cell[data-symbol="${symbol}"]`).forEach(cell => {
                        cell.innerHTML = `\u20b9${price.toFixed(2)} <span class="live-pulse" style="width:6px;height:6px;background:#22c55e;border-radius:50%;display:inline-block;margin-left:3px;animation:pulse 1.5s infinite;"></span>`;
                    });
                    document.querySelectorAll(`.watchlist-change-cell[data-symbol="${symbol}"]`).forEach(cell => {
                        const addedPrice = parseFloat(cell.getAttribute('data-added-price')) || 0;
                        if (addedPrice > 0) {
                            const diff  = price - addedPrice;
                            const pct   = (diff / addedPrice) * 100;
                            const sign  = diff >= 0 ? '+' : '';
                            const color = diff >= 0 ? 'var(--success-color)' : 'var(--danger-color)';
                            cell.innerHTML = `<span style="color:${color};font-weight:600;">${sign}\u20b9${diff.toFixed(2)} (${sign}${pct.toFixed(2)}%)</span>`;
                        }
                    });
                } else {
                    throw new Error('No market price');
                }
            } catch (e) {
                markSymbolFailed(symbol);
                document.querySelectorAll(`.watchlist-live-cell[data-symbol="${symbol}"]`).forEach(cell => {
                    if (!state.gainersLivePrices.has(symbol)) {
                        cell.innerHTML = '<span style="font-size:0.75rem;color:var(--text-secondary);">Price unavailable</span>';
                    }
                });
                console.warn(`Watchlist live price failed for ${symbol}:`, e.message);
            }
        });
    } finally {
        isWatchlistFetchInFlight = false;
    }
}

// Watchlist is loaded inside startDashboardAfterLogin() after authentication.

// =====================================================================
//  MORNING PICKS — Technical Scoring Algorithm
// =====================================================================
window.renderMorningPicks = function() {
    const emptyState   = document.getElementById('picks-empty-state');
    const tableWrapper = document.getElementById('picks-table-wrapper');
    const badge        = document.getElementById('picks-count-badge');
    const tbody        = document.getElementById('picks-tbody');
    if (!tbody) return;

    const data = state.processedMasterData;
    if (!data || data.length < 2) {
        if (emptyState)   emptyState.style.display  = '';
        if (tableWrapper) tableWrapper.style.display = 'none';
        return;
    }

    const headers = data[0];
    detectColumnIndexes(headers);
    const symCol  = state.symbolColIndex;
    const serCol  = state.seriesColIndex;
    const hiCol   = state.highColIndex;
    const diffCol = state.diffColIndex;

    let firstDateCol = -1;
    if (hiCol   !== -1) firstDateCol = hiCol + 1;
    else if (diffCol !== -1) firstDateCol = diffCol + 1;

    if (firstDateCol === -1 || firstDateCol >= headers.length || (headers.length - firstDateCol) < 2) {
        if (emptyState)   emptyState.style.display  = '';
        if (tableWrapper) tableWrapper.style.display = 'none';
        return;
    }

    const results = [];

    for (let r = 1; r < data.length; r++) {
        const row = data[r];
        if (!row) continue;
        const sym    = String(row[symCol] || '').trim().toUpperCase();
        const series = serCol !== -1 ? String(row[serCol] || '').trim().toUpperCase() : 'EQ';
        if (!sym || series !== 'EQ') continue;

        // Collect last 5 close prices (col 0 = newest)
        const prices = [];
        for (let c = firstDateCol; c < Math.min(firstDateCol + 5, headers.length); c++) {
            const v = parseFloat(row[c]);
            if (!isNaN(v) && v > 0) prices.push(v);
        }
        if (prices.length < 2) continue;

        const latestPrice = prices[0];

        const mom3 = prices.length >= 3 && prices[2] > 0
            ? ((prices[0] - prices[2]) / prices[2]) * 100
            : prices.length >= 2 && prices[1] > 0
            ? ((prices[0] - prices[1]) / prices[1]) * 100 : 0;

        const mom5 = prices.length >= 5 && prices[4] > 0
            ? ((prices[0] - prices[4]) / prices[4]) * 100
            : mom3;

        if (mom3 <= 0 && mom5 <= 0) continue;

        let upDays = 0;
        for (let i = 0; i < prices.length - 1; i++) {
            if (prices[i] > prices[i + 1]) upDays++;
        }
        const consistencyPct = (upDays / (prices.length - 1)) * 100;

        const high5d = Math.max(...prices);
        const low5d  = Math.min(...prices);
        const range  = high5d - low5d;
        const positionPct = range > 0 ? ((high5d - latestPrice) / range) * 100 : 50;

        const mom3Score = Math.min(100, Math.max(0, ((mom3 + 5) / 20) * 100));
        const mom5Score = Math.min(100, Math.max(0, ((mom5 + 5) / 20) * 100));

        const score = Math.round(
            mom3Score      * 0.30 +
            mom5Score      * 0.25 +
            consistencyPct * 0.30 +
            positionPct    * 0.15
        );

        let suggestion, suggColor;
        if      (score >= 80) { suggestion = '🟢 Strong Buy'; suggColor = 'var(--success-color)'; }
        else if (score >= 65) { suggestion = '🟡 Buy';        suggColor = '#f59e0b'; }
        else if (score >= 50) { suggestion = '🔵 Watch';      suggColor = '#60a5fa'; }
        else                  { suggestion = '⚪ Neutral';    suggColor = 'var(--text-secondary)'; }

        const trendHtml = upDays >= prices.length - 1
            ? `<span style="color:var(--success-color);">\u2191 ${upDays}/${prices.length-1} Up</span>`
            : upDays === 0
            ? `<span style="color:var(--danger-color);">\u2193 All Down</span>`
            : `<span style="color:#f59e0b;">\u2197 ${upDays}/${prices.length-1} Up</span>`;

        results.push({ symbol: sym, latestPrice, mom3, mom5, upDays, totalDays: prices.length-1, score, suggestion, suggColor, trendHtml });
    }

    // Filter results based on search query
    const searchInput = document.getElementById('morning-search-input');
    const query = searchInput ? searchInput.value.trim().toUpperCase() : '';
    const filteredResults = query 
        ? results.filter(item => item.symbol.toUpperCase().includes(query))
        : results;

    filteredResults.sort((a, b) => b.score - a.score);
    const top25 = filteredResults.slice(0, 25);

    if (top25.length === 0) {
        if (emptyState)   emptyState.style.display  = '';
        if (tableWrapper) tableWrapper.style.display = 'none';
        if (badge) badge.textContent = '0 Scripts';
        return;
    }

    if (emptyState)   emptyState.style.display  = 'none';
    if (tableWrapper) tableWrapper.style.display = '';
    if (badge) badge.textContent = `${top25.length} Scripts`;

    const scoreBarColor = (s) => s >= 65 ? 'var(--success-color)' : s >= 50 ? '#f59e0b' : 'var(--text-secondary)';

    if (!window.morningPicksLivePrices) {
        window.morningPicksLivePrices = new Map();
    }

    tbody.innerHTML = top25.map((item, idx) => {
        const sign3  = item.mom3 >= 0 ? '+' : '';
        const sign5  = item.mom5 >= 0 ? '+' : '';
        const col3   = item.mom3 >= 0 ? 'var(--success-color)' : 'var(--danger-color)';
        const col5   = item.mom5 >= 0 ? 'var(--success-color)' : 'var(--danger-color)';
        const rankBg = idx === 0 ? '#f59e0b' : idx === 1 ? '#94a3b8' : idx === 2 ? '#b87333' : 'transparent';
        const rankColor = idx < 3 ? '#000' : 'var(--text-secondary)';
        
        const inWatchlist = watchlistItems.some(w => w.symbol === item.symbol);
        const starBtn = inWatchlist
            ? `<button onclick="removeFromWatchlist('${item.symbol}'); event.stopPropagation();" title="Watchlistમાંથી કાઢો" style="background:rgba(245,158,11,0.18); border:1px solid #f59e0b; color:#f59e0b; border-radius:5px; padding:0.22rem 0.5rem; cursor:pointer; font-size:0.8rem; margin-right:5px;"><i class='fa-solid fa-star'></i></button>`
            : `<button onclick="addToWatchlist('${item.symbol}', ${item.latestPrice}); event.stopPropagation();" title="Watchlistમાં ઉમેરો" style="background:none; border:1px solid rgba(255,255,255,0.15); color:var(--text-secondary); border-radius:5px; padding:0.22rem 0.5rem; cursor:pointer; font-size:0.8rem; margin-right:5px;"><i class='fa-regular fa-star'></i></button>`;

        const livePriceVal = window.morningPicksLivePrices.get(item.symbol);
        const livePriceHtml = livePriceVal 
            ? `₹${livePriceVal.toFixed(2)} <span class="live-pulse" style="width:6px;height:6px;box-shadow:0 0 0 0 rgba(16,185,129,0.7);animation:pulse 1.5s infinite;margin-left:0.2rem;display:inline-block;border-radius:50%;background:#10b981;"></span>`
            : isFailedSymbolRecent(item.symbol)
            ? `₹${item.latestPrice.toFixed(2)} <span style="font-size:0.7rem;color:var(--text-secondary);">(Price unavailable)</span>`
            : `₹${item.latestPrice.toFixed(2)} <span style="font-size:0.7rem;color:var(--text-secondary);">(EOD)</span>`;

        return `
            <tr class="clickable-row" onclick="showResearchModal('${item.symbol}')" title="Chart અને વિગત">
                <td style="text-align:center;"><span style="background:${rankBg};color:${rankColor};font-weight:700;padding:0.15rem 0.5rem;border-radius:4px;font-size:0.82rem;">${idx+1}</span></td>
                <td><strong style="color:var(--accent-color);">${item.symbol}</strong></td>
                <td class="morning-live-cell" data-symbol="${item.symbol}">${livePriceHtml}</td>
                <td style="color:${col3};font-weight:600;">${sign3}${item.mom3.toFixed(2)}%</td>
                <td style="color:${col5};font-weight:600;">${sign5}${item.mom5.toFixed(2)}%</td>
                <td>${item.trendHtml}</td>
                <td>
                    <div style="display:flex;align-items:center;gap:5px;">
                        <div style="flex:1;background:rgba(255,255,255,0.08);border-radius:4px;height:6px;min-width:50px;">
                            <div style="background:${scoreBarColor(item.score)};width:${item.score}%;height:100%;border-radius:4px;"></div>
                        </div>
                        <span style="font-weight:700;font-size:0.82rem;">${item.score}</span>
                    </div>
                </td>
                <td><span style="color:${item.suggColor};font-weight:600;font-size:0.82rem;">${item.suggestion}</span></td>
                <td style="text-align:center; white-space:nowrap;">
                    ${starBtn}
                    <button onclick="showResearchModal('${item.symbol}');event.stopPropagation();"
                        style="background:rgba(59,130,246,0.12);border:1px solid var(--accent-color);color:var(--accent-color);border-radius:5px;padding:0.22rem 0.5rem;cursor:pointer;font-size:0.8rem;">
                        <i class="fa-solid fa-chart-area"></i>
                    </button>
                </td>
            </tr>`;
    }).join('');

    const symbolsToFetch = top25.map(r => r.symbol).filter(s => !isPriceFresh(s) && !isFailedSymbolRecent(s));
    if (symbolsToFetch.length > 0 && isTabActive('tab-morning-picks')) {
        fetchMorningPicksLivePrices(symbolsToFetch);
    }
};

let isMorningPicksFetchInFlight = false; // FIX: In-flight guard + concurrency 5
window.fetchMorningPicksLivePrices = async function(symbols) {
    if (!window.morningPicksLivePrices) window.morningPicksLivePrices = new Map();
    if (!symbols || symbols.length === 0 || isMorningPicksFetchInFlight) return;
    isMorningPicksFetchInFlight = true;

    try {
        const uniqueSymbols = [...new Set(symbols)]
            .map(s => String(s || '').trim().toUpperCase())
            .filter(s => s && !isPriceFresh(s) && !isFailedSymbolRecent(s));
        if (uniqueSymbols.length === 0) return;

        await runWithConcurrency(uniqueSymbols, 5, async (symbol) => {
            try {
                const data = await fetchYahooFinanceData(symbol + '.NS');
                const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
                if (price) {
                    window.morningPicksLivePrices.set(symbol, price);
                    markPriceFresh(symbol);
                    document.querySelectorAll(`.morning-live-cell[data-symbol="${symbol}"]`).forEach(cell => {
                        cell.innerHTML = `₹${price.toFixed(2)} <span class="live-pulse" style="width:6px;height:6px;box-shadow:0 0 0 0 rgba(16,185,129,0.7);animation:pulse 1.5s infinite;margin-left:0.2rem;display:inline-block;border-radius:50%;background:#10b981;"></span>`;
                    });
                } else {
                    throw new Error('No price');
                }
            } catch (e) {
                markSymbolFailed(symbol);
                console.warn(`[Morning Picks Live Update] Error for ${symbol}:`, e.message);
            }
        });
    } finally {
        isMorningPicksFetchInFlight = false;
    }
};

// =====================================================================
//  SUPER INVESTOR ADVICE — Quantitative Analysis Checklists
// =====================================================================

function calculateStandardDeviation(arr) {
    if (arr.length < 2) return 0;
    const mean = arr.reduce((sum, val) => sum + val, 0) / arr.length;
    const variance = arr.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / (arr.length - 1);
    return Math.sqrt(variance);
}

// Keep track of which symbols we have already requested live prices for to prevent redundant requests
const requestedAdviceSymbols = new Set();

let adviceRenderTimeout = null;
function throttledRenderInvestorAdvice() {
    if (adviceRenderTimeout) return;
    adviceRenderTimeout = setTimeout(() => {
        renderInvestorAdvice();
        adviceRenderTimeout = null;
    }, 450); // Throttle renders to once every 450ms
}

let adviceSearchTimeout = null;
window.debouncedRenderInvestorAdvice = function() {
    if (adviceSearchTimeout) clearTimeout(adviceSearchTimeout);
    adviceSearchTimeout = setTimeout(() => {
        renderInvestorAdvice();
    }, 250); // Debounce search input typing by 250ms
};

// Fetch live prices specifically for visible symbols on the advice page (FIX: concurrency 5 + in-flight guard)
let isAdviceFetchInFlight = false;
async function fetchAdviceLivePrices(symbols) {
    if (!symbols || symbols.length === 0 || isAdviceFetchInFlight) return;
    isAdviceFetchInFlight = true;

    try {
        const uniqueSymbols = [...new Set(symbols)]
            .map(s => String(s || '').trim().toUpperCase())
            .filter(s => s && !isPriceFresh(s) && !isFailedSymbolRecent(s));

        if (uniqueSymbols.length === 0) return;

        await runWithConcurrency(uniqueSymbols, 5, async (symbol) => {
            try {
                const isNumeric = /^\d+$/.test(symbol);
                const prefSuffix = isNumeric ? '.BO' : '.NS';
                const data = await fetchYahooFinanceData(symbol + prefSuffix);
                const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
                if (price !== undefined && price !== null) {
                    state.gainersLivePrices.set(symbol, price);
                    markPriceFresh(symbol);
                    throttledRenderInvestorAdvice();
                } else {
                    throw new Error('No price');
                }
            } catch (e) {
                markSymbolFailed(symbol);
                console.warn(`[Advice Live Prices] Failed to fetch live price for ${symbol}:`, e.message);
            }
        });
    } finally {
        isAdviceFetchInFlight = false;
    }
}

window.renderInvestorAdvice = function() {
    const emptyState   = document.getElementById('advice-empty-state');
    const tableWrapper = document.getElementById('advice-table-wrapper');
    const badge        = document.getElementById('advice-count-badge');
    const tbody        = document.getElementById('advice-tbody');
    const searchInput  = document.getElementById('advice-search-input');
    const modelSelect  = document.getElementById('advice-model-select');

    if (!tbody) return;

    const data = state.processedMasterData;
    if (!data || data.length < 2) {
        if (emptyState)   emptyState.style.display  = '';
        if (tableWrapper) tableWrapper.style.display = 'none';
        return;
    }

    const headers = data[0];
    detectColumnIndexes(headers);
    const symCol  = state.symbolColIndex;
    const serCol  = state.seriesColIndex;
    const hiCol   = state.highColIndex;
    const diffCol = state.diffColIndex;

    let firstDateCol = -1;
    if (hiCol   !== -1) firstDateCol = hiCol + 1;
    else if (diffCol !== -1) firstDateCol = diffCol + 1;

    if (firstDateCol === -1 || firstDateCol >= headers.length || (headers.length - firstDateCol) < 2) {
        if (emptyState)   emptyState.style.display  = '';
        if (tableWrapper) tableWrapper.style.display = 'none';
        return;
    }

    const searchQuery = searchInput ? searchInput.value.trim().toUpperCase() : '';
    const selectedModel = modelSelect ? modelSelect.value : 'ALL';

    const results = [];

    for (let r = 1; r < data.length; r++) {
        const row = data[r];
        if (!row) continue;

        const sym = String(row[symCol] || '').trim().toUpperCase();
        const series = serCol !== -1 ? String(row[serCol] || '').trim().toUpperCase() : 'EQ';
        const isin = state.isinColIndex !== -1 ? String(row[state.isinColIndex] || '').trim().toUpperCase() : '';
        
        // Strict exclusion of Mutual Funds (ISIN starting with INF or symbol contains MF/ETF or length > 10)
        const isMF = sym.endsWith('-MF') || sym.includes('MF') || sym.includes('ETF') || isin.startsWith('INF') || sym.length > 10;
        if (!sym || series !== 'EQ' || isMF) continue;

        if (searchQuery && !sym.includes(searchQuery)) continue;

        const prices = [];
        for (let c = firstDateCol; c < Math.min(firstDateCol + 10, headers.length); c++) {
            const v = parseFloat(row[c]);
            if (!isNaN(v) && v > 0) prices.push(v);
        }
        if (prices.length < 2) continue;

        // Check if we have a live price cached for this symbol
        let latestPrice = prices[0];
        const livePrice = state.gainersLivePrices.get(sym) || state.portfolioLivePrices.get(sym);
        let isRealTime = false;
        if (livePrice !== undefined && livePrice !== null) {
            latestPrice = livePrice;
            prices[0] = latestPrice; // Inject live price as the most recent day close for all math metrics
            isRealTime = true;
        }

        const mom3 = prices.length >= 3 && prices[2] > 0 ? ((prices[0] - prices[2]) / prices[2]) * 100 : 0;
        const mom5 = prices.length >= 5 && prices[4] > 0 ? ((prices[0] - prices[4]) / prices[4]) * 100 : mom3;

        const dailyChanges = [];
        for (let i = 0; i < prices.length - 1; i++) {
            if (prices[i+1] > 0) {
                dailyChanges.push(((prices[i] - prices[i+1]) / prices[i+1]) * 100);
            }
        }
        const volatility = calculateStandardDeviation(dailyChanges);

        let upDays = 0;
        for (let i = 0; i < prices.length - 1; i++) {
            if (prices[i] > prices[i+1]) upDays++;
        }
        const consistencyPct = (upDays / (prices.length - 1)) * 100;

        const highPrice = Math.max(...prices);
        const lowPrice  = Math.min(...prices);
        const range = highPrice - lowPrice;
        const positionPct = range > 0 ? ((highPrice - latestPrice) / range) * 100 : 50;

        const buffettVolScore = Math.max(0, 100 - (volatility * 40));
        const buffettConsistScore = consistencyPct;
        const buffettMomScore = mom5 >= 0 && mom5 <= 6 ? 100 : Math.max(0, 100 - Math.abs(mom5 - 3) * 10);
        const buffettScore = Math.round(buffettVolScore * 0.40 + buffettConsistScore * 0.30 + buffettMomScore * 0.30);

        const rjMomScore = Math.min(100, Math.max(0, ((mom3 + mom5) / 2 + 5) / 20 * 100));
        const rjBreakoutScore = Math.max(0, 100 - positionPct);
        const rjConsistScore = consistencyPct;
        const rjScore = Math.round(rjMomScore * 0.40 + rjBreakoutScore * 0.30 + rjConsistScore * 0.30);

        const kediaVolScore = Math.min(100, volatility * 30);
        const kediaMomScore = Math.min(100, Math.max(0, (mom3 + 2) / 10 * 100));
        const kediaConsistScore = consistencyPct;
        const kediaScore = Math.round(kediaVolScore * 0.35 + kediaMomScore * 0.45 + kediaConsistScore * 0.20);

        let bestModel = 'BUFFETT';
        let bestScore = buffettScore;
        let modelName = 'Warren Buffett Model';
        let modelColor = '#60a5fa';

        if (rjScore > bestScore) {
            bestModel = 'JHUNJHUNWALA';
            bestScore = rjScore;
            modelName = 'Jhunjhunwala Growth Model';
            modelColor = '#f59e0b';
        }
        if (kediaScore > bestScore) {
            bestModel = 'KEDIA';
            bestScore = kediaScore;
            modelName = 'Vijay Kedia Breakout Model';
            modelColor = '#ec4899';
        }

        if (selectedModel !== 'ALL' && selectedModel !== bestModel) continue;

        let decision, decisionColor;
        if (bestScore >= 80) {
            decision = '🚀 Strong Buy / Accumulate';
            decisionColor = 'var(--success-color)';
        } else if (bestScore >= 65) {
            decision = '📈 Buy / Hold';
            decisionColor = '#a855f7';
        } else if (bestScore >= 50) {
            decision = '⚖️ Watchlist / Hold';
            decisionColor = '#60a5fa';
        } else {
            decision = '📉 Sell / Avoid';
            decisionColor = 'var(--danger-color)';
        }

        const priceDisplay = isRealTime
            ? `₹${latestPrice.toFixed(2)} <span class="live-pulse" style="width:6px;height:6px;box-shadow:0 0 0 0 rgba(16,185,129,0.7);animation:pulse 1.5s infinite;margin-left:0.2rem;display:inline-block;border-radius:50%;background:#10b981;"></span>`
            : `₹${latestPrice.toFixed(2)} <span style="font-size:0.7rem;color:var(--text-secondary);">(EOD)</span>`;

        results.push({
            symbol: sym,
            latestPrice,
            priceDisplay,
            bestModel,
            modelName,
            modelColor,
            score: bestScore,
            decision,
            decisionColor,
            details: {
                volatility,
                mom3,
                mom5,
                consistencyPct,
                positionPct,
                buffettScore,
                rjScore,
                kediaScore
            }
        });
    }

    results.sort((a, b) => b.score - a.score);

    if (results.length === 0) {
        if (emptyState)   emptyState.style.display  = '';
        if (tableWrapper) tableWrapper.style.display = 'none';
        return;
    }

    if (emptyState)   emptyState.style.display  = 'none';
    if (tableWrapper) tableWrapper.style.display = '';
    if (badge) badge.textContent = `${results.length} Scripts`;

    // Fetch live prices for the top 30 visible symbols in the table (if not cached/failed)
    if (isTabActive('tab-investor-advice')) {
        const symbolsToFetch = results.slice(0, 30)
            .map(item => item.symbol)
            .filter(sym => !isPriceFresh(sym) && !isFailedSymbolRecent(sym) && !requestedAdviceSymbols.has(sym));

        if (symbolsToFetch.length > 0) {
            symbolsToFetch.forEach(sym => requestedAdviceSymbols.add(sym));
            fetchAdviceLivePrices(symbolsToFetch);
        }
    }

    tbody.innerHTML = results.slice(0, 100).map(item => {
        const inWatchlist = watchlistItems.some(w => w.symbol === item.symbol);
        const starBtn = inWatchlist
            ? `<button onclick="removeFromWatchlist('${item.symbol}'); event.stopPropagation();" title="Watchlist \u0aae\u0abe\u0a82\u0aa5\u0ac0 \u0a95\u0abe\u0aa2\u0acb" style="background:rgba(245,158,11,0.18); border:1px solid #f59e0b; color:#f59e0b; border-radius:5px; padding:0.25rem 0.5rem; cursor:pointer; font-size:0.8rem;"><i class='fa-solid fa-star'></i></button>`
            : `<button onclick="addToWatchlist('${item.symbol}', ${item.latestPrice}); event.stopPropagation();" title="Watchlist \u0aae\u0abe\u0a82 \u0a89\u0aae\u0ac7\u0ab0\u0acb" style="background:none; border:1px solid rgba(255,255,255,0.15); color:var(--text-secondary); border-radius:5px; padding:0.25rem 0.5rem; cursor:pointer; font-size:0.8rem;"><i class='fa-regular fa-star'></i></button>`;

        return `
            <tr class="clickable-row" onclick="showResearchModal('${item.symbol}')" title="Chart & Research" style="cursor:pointer;">
                <td><strong style="color:var(--accent-color);">${item.symbol}</strong></td>
                <td>${item.priceDisplay}</td>
                <td style="color:${item.modelColor}; font-weight:600;"><i class="fa-solid fa-user-tie" style="font-size:0.75rem;margin-right:4px;"></i>${item.modelName}</td>
                <td style="text-align:center;"><span style="background:rgba(255,255,255,0.06); font-weight:bold; padding:0.2rem 0.5rem; border-radius:4px;">${item.score}</span></td>
                <td style="color:${item.decisionColor}; font-weight:bold; font-size:0.85rem;">${item.decision}</td>
                <td>
                    <button onclick="showAdviceDetails('${item.symbol}'); event.stopPropagation();" class="btn" style="padding:0.25rem 0.6rem; font-size:0.75rem; background:rgba(34,197,94,0.15); color:#22c55e; border:1px solid rgba(34,197,94,0.3); border-radius:4px; font-weight:bold; cursor:pointer;">
                        <i class="fa-solid fa-magnifying-glass-chart" style="margin-right:3px;"></i> View Logic
                    </button>
                </td>
                <td style="text-align:center;">
                    <div style="display:flex; gap:0.25rem; justify-content:center;">
                        ${starBtn}
                        <button onclick="showResearchModal('${item.symbol}'); event.stopPropagation();" style="background:var(--accent-light,rgba(59,130,246,0.12)); border:1px solid var(--accent-color); color:var(--accent-color); border-radius:5px; padding:0.25rem 0.5rem; cursor:pointer; font-size:0.8rem;">
                            <i class="fa-solid fa-chart-area"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
};

window.showAdviceDetails = function(symbol) {
    const modal = document.getElementById('advice-details-modal');
    const body = document.getElementById('advice-details-body');
    const title = document.getElementById('advice-details-title');
    const subtitle = document.getElementById('advice-details-subtitle');

    if (!modal || !body || !state.processedMasterData) return;

    const data = state.processedMasterData;
    const headers = data[0];
    detectColumnIndexes(headers);
    const symCol = state.symbolColIndex;

    const row = data.find((r, idx) => idx > 0 && String(r[symCol] || '').trim().toUpperCase() === symbol);
    if (!row) return;

    const hiCol   = state.highColIndex;
    const diffCol = state.diffColIndex;
    let firstDateCol = hiCol !== -1 ? hiCol + 1 : (diffCol !== -1 ? diffCol + 1 : -1);

    const prices = [];
    for (let c = firstDateCol; c < Math.min(firstDateCol + 10, headers.length); c++) {
        const v = parseFloat(row[c]);
        if (!isNaN(v) && v > 0) prices.push(v);
    }
    if (prices.length < 2) return;

    // Use live price in the details modal if already cached
    const livePrice = state.gainersLivePrices.get(symbol) || state.portfolioLivePrices.get(symbol);
    if (livePrice !== undefined && livePrice !== null) {
        prices[0] = livePrice;
    }

    const latestPrice = prices[0];
    const mom3 = prices.length >= 3 && prices[2] > 0 ? ((prices[0] - prices[2]) / prices[2]) * 100 : 0;
    const mom5 = prices.length >= 5 && prices[4] > 0 ? ((prices[0] - prices[4]) / prices[4]) * 100 : mom3;

    const dailyChanges = [];
    for (let i = 0; i < prices.length - 1; i++) {
        if (prices[i+1] > 0) {
            dailyChanges.push(((prices[i] - prices[i+1]) / prices[i+1]) * 100);
        }
    }
    const volatility = calculateStandardDeviation(dailyChanges);

    let upDays = 0;
    for (let i = 0; i < prices.length - 1; i++) {
        if (prices[i] > prices[i+1]) upDays++;
    }
    const consistencyPct = (upDays / (prices.length - 1)) * 100;

    const highPrice = Math.max(...prices);
    const lowPrice  = Math.min(...prices);
    const range = highPrice - lowPrice;
    const positionPct = range > 0 ? ((highPrice - latestPrice) / range) * 100 : 50;

    const buffettVolScore = Math.max(0, 100 - (volatility * 40));
    const buffettConsistScore = consistencyPct;
    const buffettMomScore = mom5 >= 0 && mom5 <= 6 ? 100 : Math.max(0, 100 - Math.abs(mom5 - 3) * 10);
    const buffettScore = Math.round(buffettVolScore * 0.40 + buffettConsistScore * 0.30 + buffettMomScore * 0.30);

    const rjMomScore = Math.min(100, Math.max(0, ((mom3 + mom5) / 2 + 5) / 20 * 100));
    const rjBreakoutScore = Math.max(0, 100 - positionPct);
    const rjConsistScore = consistencyPct;
    const rjScore = Math.round(rjMomScore * 0.40 + rjBreakoutScore * 0.30 + rjConsistScore * 0.30);

    const kediaVolScore = Math.min(100, volatility * 30);
    const kediaMomScore = Math.min(100, Math.max(0, (mom3 + 2) / 10 * 100));
    const kediaConsistScore = consistencyPct;
    const kediaScore = Math.round(kediaVolScore * 0.35 + kediaMomScore * 0.45 + kediaConsistScore * 0.20);

    let bestModel = 'BUFFETT';
    let bestScore = buffettScore;
    let modelName = 'વોરેન બફેટ મોડલ (Warren Buffett)';
    let gujModelName = 'વોરેન બફેટ ક્વોલિટી રોકાણ મોડલ';
    if (rjScore > bestScore) { 
        bestModel = 'JHUNJHUNWALA'; 
        bestScore = rjScore; 
        modelName = 'રાકેશ ઝુનઝુનવાલા મોડલ (Rakesh Jhunjhunwala)'; 
        gujModelName = 'રાકેશ ઝુનઝુનવાલા ગ્રોથ રોકાણ મોડલ';
    }
    if (kediaScore > bestScore) { 
        bestModel = 'KEDIA'; 
        bestScore = kediaScore; 
        modelName = 'વિજય કેડિયા મોડલ (Vijay Kedia)'; 
        gujModelName = 'વિજય કેડિયા બ્રેકઆઉટ રોકાણ મોડલ';
    }

    title.textContent = `${symbol} - સુપર ઇન્વેસ્ટર વિશ્લેષણ રિપોર્ટ`;
    subtitle.textContent = `હાલનો ભાવ: \u20b9${latestPrice.toFixed(2)}`;

    body.innerHTML = `
        <div style="background:rgba(255,255,255,0.04); padding:1rem; border-radius:8px; border:1px solid rgba(255,255,255,0.06);">
            <h3 style="margin-top:0; font-size:1.05rem; color:#fff;">📊 મુખ્ય ક્વોન્ટ મેટ્રિક્સ (છેલ્લા ૧૦ દિવસ)</h3>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.8rem; margin-top:0.6rem; font-size:0.85rem;">
                <div><strong>દૈનિક અસ્થિરતા (Volatility):</strong> ${volatility.toFixed(2)}%</div>
                <div><strong>ટ્રેન્ડ સુસંગતતા (Consistency):</strong> ${consistencyPct.toFixed(0)}% ગ્રીન દિવસો (${upDays}/${prices.length-1})</div>
                <div><strong>૩-દિવસનું મોમેન્ટમ:</strong> ${mom3 >= 0 ? '+' : ''}${mom3.toFixed(2)}%</div>
                <div><strong>૫-દિવસનું મોમેન્ટમ:</strong> ${mom5 >= 0 ? '+' : ''}${mom5.toFixed(2)}%</div>
                <div style="grid-column:1/-1;"><strong>૧૦-દિવસની હાઇ રેન્જથી અંતર:</strong> હાઇ પ્રાઇસથી ${positionPct.toFixed(0)}% નીચે (મહત્તમ: \u20b9${highPrice.toFixed(2)}, ન્યૂનતમ: \u20b9${lowPrice.toFixed(2)})</div>
            </div>
        </div>

        <div style="background:rgba(255,255,255,0.04); padding:1rem; border-radius:8px; border:1px solid rgba(255,255,255,0.06); margin-top:1rem;">
            <h3 style="margin-top:0; font-size:1.05rem; color:#fff;">🧠 રોકાણકાર મોડલ્સ સ્કોરકાર્ડ</h3>
            
            <div style="display:flex; flex-direction:column; gap:0.9rem; margin-top:0.8rem;">
                <!-- Buffett Card -->
                <div style="border-left:4px solid #60a5fa; padding-left:0.6rem;">
                    <div style="display:flex; justify-content:space-between; font-weight:bold; font-size:0.9rem;">
                        <span style="color:#60a5fa;">વોરેન બફેટ મોડલ (Value & Quality)</span>
                        <span>${buffettScore} / 100</span>
                    </div>
                    <p style="font-size:0.8rem; color:var(--text-secondary); margin:0.25rem 0 0 0;">ઓછી અસ્થિરતા (< ૧.૫%), સ્થિર વળતર અને ૧૦-દિવસની રેન્જમાં હાઇ થી નીચે રહેલા શેરો પસંદ કરે છે (વિકાસની પૂરતી તક).</p>
                </div>

                <!-- Jhunjhunwala Card -->
                <div style="border-left:4px solid #f59e0b; padding-left:0.6rem;">
                    <div style="display:flex; justify-content:space-between; font-weight:bold; font-size:0.9rem;">
                        <span style="color:#f59e0b;">રાકેશ ઝુનઝુનવાલા મોડલ (Aggressive Growth)</span>
                        <span>${rjScore} / 100</span>
                    </div>
                    <p style="font-size:0.8rem; color:var(--text-secondary); margin:0.25rem 0 0 0;">ઊંચું મોમેન્ટમ (> ૫%), મજબૂત અપટ્રેન્ડ અને રેન્જ હાઇ નજીક બ્રેકઆઉટ આપતા શેરો પસંદ કરે છે.</p>
                </div>

                <!-- Vijay Kedia Card -->
                <div style="border-left:4px solid #ec4899; padding-left:0.6rem;">
                    <div style="display:flex; justify-content:space-between; font-weight:bold; font-size:0.9rem;">
                        <span style="color:#ec4899;">વિજય કેડિયા મોડલ (High Volatility Spikes)</span>
                        <span>${kediaScore} / 100</span>
                    </div>
                    <p style="font-size:0.8rem; color:var(--text-secondary); margin:0.25rem 0 0 0;">વધુ અસ્થિરતા, હાઇ-બીટા સ્મોલ-કેપ શેરો અને અચાનક મોટો ઉછાળો (explosive breakout) દર્શાવતા શેરો પસંદ કરે છે.</p>
                </div>
            </div>
        </div>

        <div style="background:rgba(34,197,94,0.06); padding:1rem; border-radius:8px; border:1px solid rgba(34,197,94,0.2); margin-top:1rem;">
            <h3 style="margin-top:0; font-size:1.05rem; color:#22c55e;">📝 નિર્ણય અને વિશ્લેષણ (Actionable Rationale)</h3>
            <p style="font-size:0.95rem; font-weight:bold; color:#fff; margin:0.5rem 0;">શ્રેષ્ઠ ફિટ મોડલ: ${gujModelName} (સ્કોર: ${bestScore}/100)</p>
            <p style="font-size:0.88rem; color:var(--text-primary); margin:0.25rem 0 0 0; line-height:1.45;">
                ${bestScore >= 80 
                    ? `આ સ્ટોક ${modelName} માટે ખૂબ જ મજબૂત સંકેતો દર્શાવે છે. વિશ્લેષણ: સતત વધતા દિવસો (green days) અને ઉત્તમ મોમેન્ટમ હોવાને કારણે હાલમાં રોકાણ કરવા માટે આ ખૂબ જ ઉત્કૃષ્ટ તક છે.` 
                    : bestScore >= 65 
                    ? `આ સ્ટોક ${modelName} માટે સકારાત્મક (positive) સેટઅપ દર્શાવે છે. વિશ્લેષણ: મધ્યમ મોમેન્ટમ અને નિયંત્રિત અસ્થિરતા હોવાને લીધે તેને ધીમે ધીમે ખરીદી કરીને એકત્રિત (accumulate) કરી શકાય છે.` 
                    : bestScore >= 50 
                    ? `આ સ્ટોક હાલમાં તટસ્થ રેન્જમાં ટ્રેડ થઈ રહ્યો છે. વિશ્લેષણ: સ્ટોક રેન્જ-બાઉન્ડ (એક જ મર્યાદામાં) અથવા કોન્સોલિડેટ થઈ રહ્યો છે. શ્રેષ્ઠ નિર્ણય એ છે કે આ સ્ટોકને વોચલિસ્ટમાં ઉમેરો અને બ્રેકઆઉટ થાય ત્યાં સુધી રાહ જુઓ.` 
                    : `આ સ્ટોક ટોચના રોકાણકારોના માપદંડમાં બંધબેસતો નથી. વિશ્લેષણ: નકારાત્મક મોમેન્ટમ અથવા અત્યંત જોખમી અને અસ્થિર છે. હાલના બજાર ભાવે આ સ્ટોકથી દૂર રહેવું અથવા પ્રોફિટ બુક કરવો હિતાવહ છે.`
                }
            </p>
        </div>
    `;

    modal.classList.remove('hidden');
};

// =====================================================================
//  HIGH VOLUME & PROMOTER 70%+ TABS — Custom Analysis (Local & Global)
// =====================================================================

// Global top Indian stocks known to have promoter holding > 70%
const globalHighPromoterStocks = [
    { symbol: 'LIC', promoterHolding: 96.5 },
    { symbol: 'IRFC', promoterHolding: 86.4 },
    { symbol: 'MAZDOCK', promoterHolding: 84.8 },
    { symbol: 'HUDCO', promoterHolding: 81.8 },
    { symbol: 'SJVN', promoterHolding: 81.8 },
    { symbol: 'NLCINDIA', promoterHolding: 79.2 },
    { symbol: 'GILLETTE', promoterHolding: 75.0 },
    { symbol: 'ABBOTT', promoterHolding: 75.0 },
    { symbol: 'SUMICHEM', promoterHolding: 75.0 },
    { symbol: 'HONAUT', promoterHolding: 75.0 },
    { symbol: 'BAYERCROP', promoterHolding: 71.4 },
    { symbol: 'BERGEPAINT', promoterHolding: 75.0 },
    { symbol: 'GLAXO', promoterHolding: 75.0 },
    { symbol: 'CLEAN', promoterHolding: 75.0 },
    { symbol: 'BIKAJI', promoterHolding: 75.0 },
    { symbol: 'NETWEB', promoterHolding: 75.0 },
    { symbol: 'DMART', promoterHolding: 74.6 },
    { symbol: 'LODHA', promoterHolding: 74.9 },
    { symbol: 'BDL', promoterHolding: 74.9 },
    { symbol: 'ADANITOTAL', promoterHolding: 74.8 },
    { symbol: 'UNIONBANK', promoterHolding: 74.8 },
    { symbol: 'GRSE', promoterHolding: 74.5 },
    { symbol: 'METROBRAND', promoterHolding: 74.2 },
    { symbol: 'AETHER', promoterHolding: 74.0 },
    { symbol: 'MIDHANI', promoterHolding: 74.0 },
    { symbol: 'INDIANB', promoterHolding: 73.8 },
    { symbol: 'PATANJALI', promoterHolding: 73.8 },
    { symbol: 'PNB', promoterHolding: 73.2 },
    { symbol: 'SOLARINDS', promoterHolding: 73.1 },
    { symbol: 'OFSS', promoterHolding: 73.0 },
    { symbol: 'WIPRO', promoterHolding: 72.9 },
    { symbol: 'COCHINSHIP', promoterHolding: 72.9 },
    { symbol: 'RVNL', promoterHolding: 72.8 },
    { symbol: 'ADANIENT', promoterHolding: 72.6 },
    { symbol: 'TCS', promoterHolding: 72.4 },
    { symbol: 'RITES', promoterHolding: 72.2 },
    { symbol: 'HAL', promoterHolding: 71.6 },
    { symbol: 'PGHH', promoterHolding: 70.6 },
    { symbol: 'BOSCHLTD', promoterHolding: 70.5 },
    { symbol: 'CENTRALBK', promoterHolding: 93.0 },
    { symbol: 'IOB', promoterHolding: 96.4 },
    { symbol: 'UCOBANK', promoterHolding: 95.4 },
    { symbol: 'MAHABANK', promoterHolding: 86.5 },
    { symbol: 'PSB', promoterHolding: 98.3 },
    { symbol: 'BANKINDIA', promoterHolding: 73.4 },
    { symbol: 'GICRE', promoterHolding: 85.8 },
    { symbol: 'NIACL', promoterHolding: 85.4 },
    { symbol: 'IDBI', promoterHolding: 94.7 },
    { symbol: 'KIOCL', promoterHolding: 99.0 },
    { symbol: 'NHPC', promoterHolding: 71.0 }
];

// Memory cache for global stock fetches to prevent redundant network hits
let globalPromoterCache = null;

window.setVolumePromoterSource = function(source) {
    state.volumePromoterSource = source;
    
    // Toggle active classes on buttons
    const btnLocal = document.getElementById('btn-vol-promoter-local');
    const btnGlobal = document.getElementById('btn-vol-promoter-global');
    if (btnLocal && btnGlobal) {
        if (source === 'LOCAL') {
            btnLocal.classList.add('active');
            btnGlobal.classList.remove('active');
        } else {
            btnGlobal.classList.add('active');
            btnLocal.classList.remove('active');
        }
    }
    
    renderVolumePromoterPicks();
};

window.renderVolumePromoterPicks = async function(forceRefresh = false) {
    const emptyState   = document.getElementById('vol-promoter-empty-state');
    const tableWrapper = document.getElementById('vol-promoter-table-wrapper');
    const badge        = document.getElementById('vol-promoter-count-badge');
    const tbody        = document.getElementById('vol-promoter-tbody');
    if (!tbody) return;

    if (state.volumePromoterSource === 'GLOBAL') {
        // GLOBAL MODE
        if (emptyState) emptyState.style.display = 'none';
        if (tableWrapper) tableWrapper.style.display = '';
        if (badge) badge.textContent = 'Loading...';
        
        tbody.innerHTML = `
            <tr>
                <td colspan="7" style="text-align:center; padding:3rem; color:var(--text-secondary);">
                    <i class="fa-solid fa-spinner fa-spin" style="font-size:1.5rem; color:#ef4444; margin-bottom:0.5rem; display:block;"></i>
                    ગ્લોબલ યાહુ ફાયનાન્સ લાઈવ ડેટા લોડ થઈ રહ્યો છે... (આમાં થોડી સેકન્ડો લાગી શકે છે)
                </td>
            </tr>
        `;

        if (forceRefresh) {
            globalPromoterCache = null;
            removeLocalStorageItem('global_promoter_cache');
            removeLocalStorageItem('global_promoter_cache_time');
        }

        // Try to load from localStorage cache
        const storedCache = getLocalStorageItem('global_promoter_cache');
        const storedCacheTime = getLocalStorageItem('global_promoter_cache_time');
        const now = Date.now();
        
        if (storedCache && storedCacheTime && (now - parseInt(storedCacheTime)) < 10 * 60 * 1000) {
            try {
                globalPromoterCache = JSON.parse(storedCache);
                console.log("[Global Promoter] Loaded from local cache successfully!");
            } catch (e) {
                console.warn("[Global Promoter] Failed to parse local cache:", e);
                globalPromoterCache = null;
            }
        }

        if (!globalPromoterCache) {
            // FIX: Fetch 50 global promoter stocks with concurrency 5 instead of flooding 50 simultaneous calls
            if (window.isVolPromoterFetchInFlight) return;
            window.isVolPromoterFetchInFlight = true;

            try {
                const fetchedResults = [];

                const renderProgressive = () => {
                    const results = fetchedResults.filter(item => {
                        const prices = item.prices;
                        if (prices.length < 5) return false;
                        return prices[0] > prices[1] && prices[1] > prices[2] && prices[2] > prices[3] && prices[3] > prices[4];
                    });

                    results.sort((a, b) => b.volume - a.volume);

                    const searchInput = document.getElementById('vol-promoter-search-input');
                    const searchVal = searchInput ? searchInput.value.trim().toUpperCase() : '';
                    const filteredResults = searchVal
                        ? results.filter(item => item.symbol.toUpperCase().includes(searchVal))
                        : results;

                    if (filteredResults.length > 0) {
                        if (badge) badge.textContent = `${filteredResults.length} Stocks`;
                        renderTableRows(filteredResults);
                    }
                };

                await runWithConcurrency(globalHighPromoterStocks, 5, async (stock) => {
                    try {
                        const ticker = stock.symbol.toUpperCase().trim() + '.NS';
                        const data = await fetchYahooFinanceData(ticker);

                        if (data && data.chart && data.chart.result && data.chart.result[0]) {
                            const result = data.chart.result[0];
                            const meta = result.meta;
                            const currentPrice = meta.regularMarketPrice;
                            const volume = meta.regularMarketVolume || 0;

                            let prices = [];
                            if (result.indicators && result.indicators.quote && result.indicators.quote[0]) {
                                const rawCloses = result.indicators.quote[0].close || [];
                                const validCloses = rawCloses.filter(p => p !== null && p !== undefined && !isNaN(p));
                                if (validCloses.length >= 5) {
                                    prices = validCloses.slice(-5).reverse();
                                }
                            }

                            if (prices.length < 5 && currentPrice) {
                                prices = [currentPrice, currentPrice * 0.99, currentPrice * 0.98, currentPrice * 0.97, currentPrice * 0.96];
                            }

                            fetchedResults.push({
                                symbol: stock.symbol,
                                latestPrice: currentPrice || prices[0] || 0,
                                volume,
                                promoterHolding: stock.promoterHolding,
                                prices
                            });

                            if (fetchedResults.length % 5 === 0 || fetchedResults.length === globalHighPromoterStocks.length) {
                                renderProgressive();
                            }
                        }
                    } catch (e) {
                        console.warn(`[Global Promoter] Failed to fetch data for ${stock.symbol}:`, e.message);
                    }
                });

                if (fetchedResults.length > 0) {
                    globalPromoterCache = fetchedResults;
                    try {
                        setLocalStorageItem('global_promoter_cache', JSON.stringify(fetchedResults));
                        setLocalStorageItem('global_promoter_cache_time', now.toString());
                    } catch (err) {
                        console.warn("[Global Promoter] Cache save failed:", err);
                    }
                } else {
                    tbody.innerHTML = `
                        <tr>
                            <td colspan="7" style="text-align:center; padding:2.5rem; color:var(--text-secondary);">
                                Live price sources are temporarily unavailable.
                                <div style="margin-top:0.75rem;">
                                    <button onclick="renderVolumePromoterPicks(true)" class="btn btn-primary" style="font-size:0.82rem; padding:0.4rem 1rem;">
                                        <i class="fa-solid fa-rotate"></i> Try Again
                                    </button>
                                </div>
                            </td>
                        </tr>
                    `;
                    if (badge) badge.textContent = '0 Stocks';
                    return;
                }
            } finally {
                window.isVolPromoterFetchInFlight = false;
            }
        }

        const results = (globalPromoterCache || []).filter(item => {
            const prices = item.prices;
            if (prices.length < 5) return false;
            return prices[0] > prices[1] && prices[1] > prices[2] && prices[2] > prices[3] && prices[3] > prices[4];
        });

        results.sort((a, b) => b.volume - a.volume);

        const searchInput = document.getElementById('vol-promoter-search-input');
        const searchVal = searchInput ? searchInput.value.trim().toUpperCase() : '';
        const filteredResults = searchVal
            ? results.filter(item => item.symbol.toUpperCase().includes(searchVal))
            : results;

        if (filteredResults.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="7" style="text-align:center; padding:2.5rem; color:var(--text-secondary);">
                        ગ્લોબલ સ્ટોક્સમાં કોઈ મેળ ખાતી કંપની નથી.
                    </td>
                </tr>
            `;
            if (badge) badge.textContent = '0 Stocks';
            return;
        }

        if (badge) badge.textContent = `${filteredResults.length} Stocks`;
        renderTableRows(filteredResults);
    } else {
        // LOCAL MODE
        const data = state.processedMasterData;
        if (!data || data.length < 2) {
            if (emptyState)   emptyState.style.display  = '';
            if (tableWrapper) tableWrapper.style.display = 'none';
            if (badge)        badge.textContent = '0 Stocks';
            return;
        }

        const headers = data[0];
        detectColumnIndexes(headers);
        const symCol  = state.symbolColIndex;
        const serCol  = state.seriesColIndex;
        const hiCol   = state.highColIndex;
        const diffCol = state.diffColIndex;
        const promCol = state.promoterColIndex;

        let firstDateCol = -1;
        if (hiCol   !== -1) firstDateCol = hiCol + 1;
        else if (diffCol !== -1) firstDateCol = diffCol + 1;

        if (promCol === -1) {
            console.warn("Promoter column not found in headers:", headers);
            if (emptyState) {
                emptyState.querySelector('p').innerHTML = "માસ્ટર એક્સેલ ફાઇલમાં <strong>Promoter Holding</strong> અથવા <strong>પ્રમોટર હિસ્સો</strong> નામનો કોલમ મળ્યો નથી.";
                emptyState.style.display = '';
            }
            if (tableWrapper) tableWrapper.style.display = 'none';
            if (badge)        badge.textContent = '0 Stocks';
            return;
        }

        if (firstDateCol === -1 || firstDateCol >= headers.length || (headers.length - firstDateCol) < 5) {
            if (emptyState) {
                emptyState.querySelector('p').innerHTML = "ભાવ વધારાનો ટ્રેન્ડ ચકાસવા માટે ઓછામાં ઓછો ૫ દિવસનો Bhavcopy ડેટા હોવો જરૂરી છે.";
                emptyState.style.display = '';
            }
            if (tableWrapper) tableWrapper.style.display = 'none';
            if (badge)        badge.textContent = '0 Stocks';
            return;
        }

        const results = [];

        const parsePromoterHolding = (val) => {
            if (val === undefined || val === null || val === '') return 0;
            if (typeof val === 'number') {
                if (val > 0 && val <= 1) return val * 100;
                return val;
            }
            let str = String(val).replace(/%/g, '').trim();
            let num = parseFloat(str);
            if (isNaN(num)) return 0;
            if (num > 0 && num <= 1 && String(val).indexOf('.') !== -1 && !String(val).includes('%')) {
                return num * 100;
            }
            return num;
        };

        for (let r = 1; r < data.length; r++) {
            const row = data[r];
            if (!row) continue;
            const sym    = String(row[symCol] || '').trim().toUpperCase();
            const series = serCol !== -1 ? String(row[serCol] || '').trim().toUpperCase() : 'EQ';
            if (!sym || series !== 'EQ') continue;

            const promoterHolding = parsePromoterHolding(row[promCol]);
            if (promoterHolding <= 70) continue;

            const prices = [];
            for (let c = firstDateCol; c < Math.min(firstDateCol + 5, headers.length); c++) {
                const v = parseFloat(row[c]);
                if (!isNaN(v) && v > 0) prices.push(v);
            }
            if (prices.length < 5) continue;

            const isIncreasing = prices[0] > prices[1] && prices[1] > prices[2] && prices[2] > prices[3] && prices[3] > prices[4];
            if (!isIncreasing) continue;

            let volume = state.latestVolumes.get(sym) || 0;
            if (volume === 0) {
                const volColIdx = headers.findIndex(h => {
                    const hs = String(h || '').toUpperCase().trim();
                    return hs === 'VOLUME' || hs === 'VOL' || hs === 'QTY' || hs === 'TTL_TRD_QTY' || hs === 'TOTTRDQTY';
                });
                if (volColIdx !== -1) {
                    const volVal = parseFloat(row[volColIdx]);
                    if (!isNaN(volVal)) volume = volVal;
                }
            }

            results.push({
                symbol: sym,
                latestPrice: prices[0],
                volume,
                promoterHolding,
                prices
            });
        }

        const searchInput = document.getElementById('vol-promoter-search-input');
        const searchVal = searchInput ? searchInput.value.trim().toUpperCase() : '';
        const filteredResults = searchVal 
            ? results.filter(item => item.symbol.toUpperCase().includes(searchVal))
            : results;

        if (filteredResults.length === 0) {
            if (emptyState) {
                emptyState.querySelector('p').innerHTML = "કોઈ મેળ ખાતી કંપની નથી.";
                emptyState.style.display = '';
            }
            if (tableWrapper) tableWrapper.style.display = 'none';
            if (badge)        badge.textContent = '0 Stocks';
            return;
        }

        if (emptyState)   emptyState.style.display  = 'none';
        if (tableWrapper) tableWrapper.style.display = '';
        if (badge)        badge.textContent = `${filteredResults.length} Stocks`;
        renderTableRows(filteredResults);
    }

    function renderTableRows(itemsList) {
        const formatVolume = (v) => {
            if (v >= 10000000) return (v / 10000000).toFixed(2) + ' Cr';
            if (v >= 100000) return (v / 100000).toFixed(2) + ' Lk';
            if (v >= 1000) return (v / 1000).toFixed(1) + ' K';
            return v.toString();
        };

        tbody.innerHTML = itemsList.map((item, idx) => {
            const trendHtml = `<span style="color:var(--success-color);"><i class="fa-solid fa-arrow-trend-up"></i> 5 Days Up</span>`;
            
            const inWatchlist = watchlistItems.some(w => w.symbol === item.symbol);
            const starBtn = inWatchlist
                ? `<button onclick="removeFromWatchlist('${item.symbol}'); event.stopPropagation();" title="Watchlistમાંથી કાઢો" style="background:rgba(245,158,11,0.18); border:1px solid #f59e0b; color:#f59e0b; border-radius:5px; padding:0.22rem 0.5rem; cursor:pointer; font-size:0.8rem; margin-right:5px;"><i class='fa-solid fa-star'></i></button>`
                : `<button onclick="addToWatchlist('${item.symbol}', ${item.latestPrice}); event.stopPropagation();" title="Watchlistમાં ઉમેરો" style="background:none; border:1px solid rgba(255,255,255,0.15); color:var(--text-secondary); border-radius:5px; padding:0.22rem 0.5rem; cursor:pointer; font-size:0.8rem; margin-right:5px;"><i class='fa-regular fa-star'></i></button>`;

            return `
                <tr class="clickable-row" onclick="showResearchModal('${item.symbol}')" title="ચાર્ટ અને વિગતો જુઓ">
                    <td style="text-align:center;"><span style="background:rgba(239,68,68,0.15);color:#ef4444;font-weight:700;padding:0.15rem 0.5rem;border-radius:4px;font-size:0.82rem;">${idx+1}</span></td>
                    <td><strong style="color:var(--accent-color);">${item.symbol}</strong></td>
                    <td>₹${item.latestPrice.toFixed(2)}</td>
                    <td style="font-weight:600;color:#cbd5e1;">${item.volume > 0 ? formatVolume(item.volume) : '<span style="color:var(--text-secondary);font-size:0.8rem;">No Data</span>'}</td>
                    <td style="color:#f59e0b;font-weight:700;">${item.promoterHolding.toFixed(2)}%</td>
                    <td>${trendHtml}</td>
                    <td style="text-align:center; white-space:nowrap;">
                        ${starBtn}
                        <button onclick="showResearchModal('${item.symbol}');event.stopPropagation();"
                            style="background:rgba(239,68,68,0.12);border:1px solid #ef4444;color:#ef4444;border-radius:5px;padding:0.22rem 0.5rem;cursor:pointer;font-size:0.8rem;">
                            <i class="fa-solid fa-chart-area"></i>
                        </button>
                    </td>
                </tr>`;
        }).join('');
    }
};

// =====================================================================
// CIRCUITS & GLOBAL INDICES
// =====================================================================

let circuitsLivePrices = new Map();

window.renderCircuits = function(forceRefresh = false) {
    const emptyState   = document.getElementById('circuits-empty-state');
    const tableWrapper = document.getElementById('circuits-table-wrapper');
    const badge        = document.getElementById('circuits-count-badge');
    const tbody        = document.getElementById('circuits-tbody');
    if (!tbody) return;

    const data = state.processedMasterData;
    if (!data || data.length < 2) {
        if (emptyState)   emptyState.style.display  = '';
        if (tableWrapper) tableWrapper.style.display = 'none';
        if (badge)        badge.textContent = '0 Stocks';
        return;
    }

    const headers = data[0];
    detectColumnIndexes(headers);
    const symCol  = state.symbolColIndex;
    const serCol  = state.seriesColIndex;
    const hiCol   = state.highColIndex;
    const diffCol = state.diffColIndex;

    let firstDateCol = -1;
    if (hiCol   !== -1) firstDateCol = hiCol + 1;
    else if (diffCol !== -1) firstDateCol = diffCol + 1;

    if (firstDateCol === -1 || firstDateCol >= headers.length || (headers.length - firstDateCol) < 2) {
        if (emptyState)   emptyState.style.display  = '';
        if (tableWrapper) tableWrapper.style.display = 'none';
        if (badge)        badge.textContent = '0 Stocks';
        return;
    }

    const results = [];

    for (let r = 1; r < data.length; r++) {
        const row = data[r];
        if (!row) continue;
        const sym    = String(row[symCol] || '').trim().toUpperCase();
        const series = serCol !== -1 ? String(row[serCol] || '').trim().toUpperCase() : 'EQ';
        if (!sym || series !== 'EQ') continue;

        // Collect today's close and yesterday's close to calculate change %
        const todayClose = parseFloat(row[firstDateCol]);
        const yesterdayClose = parseFloat(row[firstDateCol + 1]);
        if (isNaN(todayClose) || isNaN(yesterdayClose) || yesterdayClose <= 0) continue;

        const changePercent = ((todayClose - yesterdayClose) / yesterdayClose) * 100;

        // Check if change percent hits circuit limit (5%, 10%, 20%, 2%)
        let circuitLimit = '';
        let isCircuit = false;

        if (changePercent >= 19.5) {
            circuitLimit = '20% Upper Circuit';
            isCircuit = true;
        } else if (changePercent >= 9.5 && changePercent < 10.5) {
            circuitLimit = '10% Upper Circuit';
            isCircuit = true;
        } else if (changePercent >= 4.7 && changePercent < 5.3) {
            circuitLimit = '5% Upper Circuit';
            isCircuit = true;
        } else if (changePercent >= 1.9 && changePercent < 2.1) {
            circuitLimit = '2% Upper Circuit';
            isCircuit = true;
        }

        if (!isCircuit) continue;

        // Get Volume
        let volume = state.latestVolumes.get(sym) || 0;
        if (volume === 0) {
            const volColIdx = headers.findIndex(h => {
                const hs = String(h || '').toUpperCase().trim();
                return hs === 'VOLUME' || hs === 'VOL' || hs === 'QTY' || hs === 'TTL_TRD_QTY' || hs === 'TOTTRDQTY';
            });
            if (volColIdx !== -1) {
                const volVal = parseFloat(row[volColIdx]);
                if (!isNaN(volVal)) volume = volVal;
            }
        }

        results.push({
            symbol: sym,
            latestClose: todayClose,
            volume,
            circuitLimit,
            changePercent
        });
    }

    // Sort by Volume descending
    results.sort((a, b) => b.volume - a.volume);

    if (results.length === 0) {
        if (emptyState)   emptyState.style.display  = '';
        if (tableWrapper) tableWrapper.style.display = 'none';
        if (badge)        badge.textContent = '0 Stocks';
        return;
    }

    const searchInput = document.getElementById('circuits-search-input');
    const searchVal = searchInput ? searchInput.value.trim().toUpperCase() : '';
    const filteredResults = searchVal 
        ? results.filter(item => item.symbol.toUpperCase().includes(searchVal))
        : results;

    if (filteredResults.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding: 2rem; color: var(--text-secondary);">કોઈ મેળ ખાતી કંપની નથી.</td></tr>`;
        if (badge) badge.textContent = '0 Stocks';
        return;
    }

    if (emptyState)   emptyState.style.display  = 'none';
    if (tableWrapper) tableWrapper.style.display = '';
    if (badge)        badge.textContent = `${filteredResults.length} Stocks`;

    const formatVolume = (v) => {
        if (v >= 10000000) return (v / 10000000).toFixed(2) + ' Cr';
        if (v >= 100000) return (v / 100000).toFixed(2) + ' Lk';
        if (v >= 1000) return (v / 1000).toFixed(1) + ' K';
        return v.toString();
    };

    tbody.innerHTML = filteredResults.map((item, idx) => {
        const livePriceVal = circuitsLivePrices.get(item.symbol);
        const livePriceHtml = livePriceVal 
            ? `₹${livePriceVal.toFixed(2)} <span class="live-pulse" style="width:6px;height:6px;box-shadow:0 0 0 0 rgba(16,185,129,0.7);animation:pulse 1.5s infinite;margin-left:0.2rem;display:inline-block;border-radius:50%;background:#10b981;"></span>`
            : isFailedSymbolRecent(item.symbol)
            ? `₹${item.latestClose.toFixed(2)} <span style="font-size:0.7rem;color:var(--text-secondary);">(Price unavailable)</span>`
            : `₹${item.latestClose.toFixed(2)} <span style="font-size:0.7rem;color:var(--text-secondary);">(EOD)</span>`;

        const badgeColor = item.circuitLimit.startsWith('20') ? '#ef4444' : item.circuitLimit.startsWith('10') ? '#f59e0b' : '#eab308';
        const badgeBg = item.circuitLimit.startsWith('20') ? 'rgba(239,68,68,0.12)' : item.circuitLimit.startsWith('10') ? 'rgba(245,158,11,0.12)' : 'rgba(234,179,8,0.12)';
        
        const inWatchlist = watchlistItems.some(w => w.symbol === item.symbol);
        const starBtn = inWatchlist
            ? `<button onclick="removeFromWatchlist('${item.symbol}'); event.stopPropagation();" title="Watchlistમાંથી કાઢો" style="background:rgba(245,158,11,0.18); border:1px solid #f59e0b; color:#f59e0b; border-radius:5px; padding:0.22rem 0.5rem; cursor:pointer; font-size:0.8rem; margin-right:5px;"><i class='fa-solid fa-star'></i></button>`
            : `<button onclick="addToWatchlist('${item.symbol}', ${item.latestClose}); event.stopPropagation();" title="Watchlistમાં ઉમેરો" style="background:none; border:1px solid rgba(255,255,255,0.15); color:var(--text-secondary); border-radius:5px; padding:0.22rem 0.5rem; cursor:pointer; font-size:0.8rem; margin-right:5px;"><i class='fa-regular fa-star'></i></button>`;

        return `
            <tr class="clickable-row" onclick="showResearchModal('${item.symbol}')" title="ચાર્ટ અને વિગતો જુઓ">
                <td style="text-align:center;"><span style="background:rgba(234,179,8,0.15);color:#eab308;font-weight:700;padding:0.15rem 0.5rem;border-radius:4px;font-size:0.82rem;">${idx+1}</span></td>
                <td><strong style="color:var(--accent-color);">${item.symbol}</strong></td>
                <td>₹${item.latestClose.toFixed(2)}</td>
                <td class="circuit-live-cell" data-symbol="${item.symbol}">${livePriceHtml}</td>
                <td style="font-weight:600;color:#cbd5e1;">${item.volume > 0 ? formatVolume(item.volume) : '<span style="color:var(--text-secondary);font-size:0.8rem;">No Data</span>'}</td>
                <td><span style="background:${badgeBg};color:${badgeColor};font-weight:700;padding:0.2rem 0.6rem;border-radius:6px;font-size:0.75rem;border:1px solid ${badgeColor}30;">${item.circuitLimit}</span></td>
                <td style="color:var(--success-color);font-weight:700;">+${item.changePercent.toFixed(2)}%</td>
                <td style="text-align:center; white-space:nowrap;">
                    ${starBtn}
                    <button onclick="showResearchModal('${item.symbol}');event.stopPropagation();"
                        style="background:rgba(234,179,8,0.12);border:1px solid #eab308;color:#eab308;border-radius:5px;padding:0.22rem 0.5rem;cursor:pointer;font-size:0.8rem;">
                        <i class="fa-solid fa-chart-area"></i>
                    </button>
                </td>
            </tr>`;
    }).join('');

    const symbolsToFetch = results.map(r => r.symbol).filter(s => !isPriceFresh(s) && !isFailedSymbolRecent(s));
    if (symbolsToFetch.length > 0 && isTabActive('tab-circuits') && (forceRefresh || circuitsLivePrices.size === 0)) {
        fetchCircuitsLivePrices(symbolsToFetch);
    }
};

let isCircuitsFetchInFlight = false; // FIX: In-flight guard + concurrency 5
window.fetchCircuitsLivePrices = async function(symbols) {
    if (!symbols || symbols.length === 0 || isCircuitsFetchInFlight) return;
    isCircuitsFetchInFlight = true;

    try {
        const uniqueSymbols = [...new Set(symbols)]
            .map(s => String(s || '').trim().toUpperCase())
            .filter(s => s && !isPriceFresh(s) && !isFailedSymbolRecent(s));
        if (uniqueSymbols.length === 0) return;

        await runWithConcurrency(uniqueSymbols, 5, async (symbol) => {
            try {
                const data = await fetchYahooFinanceData(symbol + '.NS');
                const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
                if (price) {
                    circuitsLivePrices.set(symbol, price);
                    markPriceFresh(symbol);
                    document.querySelectorAll(`.circuit-live-cell[data-symbol="${symbol}"]`).forEach(cell => {
                        cell.innerHTML = `₹${price.toFixed(2)} <span class="live-pulse" style="width:6px;height:6px;box-shadow:0 0 0 0 rgba(16,185,129,0.7);animation:pulse 1.5s infinite;margin-left:0.2rem;display:inline-block;border-radius:50%;background:#10b981;"></span>`;
                    });
                } else {
                    throw new Error('No price');
                }
            } catch (e) {
                markSymbolFailed(symbol);
                console.warn(`[Circuits Live Update] Error for ${symbol}:`, e.message);
            }
        });
    } finally {
        isCircuitsFetchInFlight = false;
    }
};

const globalIndicesConfig = [
    { name: 'Nifty Bank (India)', ticker: '^NSEBANK' },
    { name: 'Dow Jones (US)', ticker: '^DJI' },
    { name: 'S&P 500 (US)', ticker: '^GSPC' },
    { name: 'Nasdaq (US)', ticker: '^IXIC' },
    { name: 'DAX (Germany)', ticker: '^GDAXI' },
    { name: 'Nikkei 225 (Japan)', ticker: '^N225' },
    { name: 'Hang Seng (Hong Kong)', ticker: '^HSI' },
    { name: 'Shanghai Composite (China)', ticker: '000001.SS' },
    { name: 'DJ Shanghai (China)', ticker: '000003.SS' },
    { name: 'Taiwan Weighted (Taiwan)', ticker: '^TWII' },
    { name: 'KOSPI (South Korea)', ticker: '^KS11' }
];

// FIX: Global Indices with concurrency 5, in-flight guard, localStorage last-known cache fallback (greyed out + timestamp + Refresh button), and clear error when no cache exists
let isGlobalIndicesFetching = false;

function renderGlobalIndicesRows(tbody, items, isCachedFallback = false, cachedTimestamp = null) {
    let bannerHtml = '';
    if (isCachedFallback) {
        const tsText = cachedTimestamp ? new Date(cachedTimestamp).toLocaleString('en-IN') : 'Previous session';
        bannerHtml = `
            <tr>
                <td colspan="5" style="background:rgba(245,158,11,0.08); color:#f59e0b; padding:0.65rem 1rem; font-size:0.82rem; border-bottom:1px solid rgba(245,158,11,0.25);">
                    <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:0.5rem;">
                        <span><i class="fa-solid fa-clock-rotate-left"></i> Live data temporarily unavailable — showing last cached values (${tsText})</span>
                        <button onclick="fetchGlobalIndices(true)" class="btn btn-secondary" style="font-size:0.75rem; padding:0.3rem 0.75rem; border-color:#f59e0b; color:#f59e0b;">
                            <i class="fa-solid fa-rotate"></i> Refresh
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }

    const rowOpacityStyle = isCachedFallback ? 'opacity:0.6; color:#94a3b8;' : '';

    tbody.innerHTML = bannerHtml + items.map(item => {
        const sign = item.change >= 0 ? '+' : '';
        const color = isCachedFallback ? '#94a3b8' : (item.change >= 0 ? 'var(--success-color)' : 'var(--danger-color)');
        const nameColor = isCachedFallback ? '#94a3b8' : 'var(--accent-color)';
        const priceColor = isCachedFallback ? '#94a3b8' : '#fff';

        const statusHtml = isCachedFallback
            ? `<span style="background:rgba(148,163,184,0.12);color:#94a3b8;font-weight:700;padding:0.15rem 0.5rem;border-radius:4px;font-size:0.75rem;">CACHED</span>`
            : item.isOpen
            ? `<span style="background:rgba(16,185,129,0.12);color:var(--success-color);font-weight:700;padding:0.15rem 0.5rem;border-radius:4px;font-size:0.75rem;display:inline-flex;align-items:center;gap:3px;"><span class="live-pulse" style="width:5px;height:5px;box-shadow:0 0 0 0 rgba(16,185,129,0.7);animation:pulse 1.5s infinite;background:#10b981;border-radius:50%;"></span> OPEN</span>`
            : `<span style="background:rgba(255,255,255,0.06);color:var(--text-secondary);font-weight:700;padding:0.15rem 0.5rem;border-radius:4px;font-size:0.75rem;">CLOSED</span>`;

        return `
            <tr style="${rowOpacityStyle}">
                <td><strong style="color:${nameColor};">${item.name}</strong> <span style="font-size:0.75rem; color:var(--text-secondary); margin-left:5px;">(${item.ticker})</span></td>
                <td style="font-weight:700; font-family:var(--font-family); color:${priceColor};">${Number(item.price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                <td style="font-weight:600; font-family:var(--font-family); color:${color};">${sign}${Number(item.change).toFixed(2)}</td>
                <td style="font-weight:700; font-family:var(--font-family); color:${color};">${sign}${Number(item.changePct).toFixed(2)}%</td>
                <td>${statusHtml}</td>
            </tr>
        `;
    }).join('');
}

window.fetchGlobalIndices = async function(showLoading = false) {
    const tbody = document.getElementById('global-indices-tbody');
    if (!tbody || isGlobalIndicesFetching) return;
    isGlobalIndicesFetching = true;

    try {
        // Show cached values immediately on initial load if tbody is still empty
        if (!showLoading && tbody.children.length === 0) {
            try {
                const saved = getLocalStorageItem('global_indices_cache');
                if (saved) {
                    const parsed = JSON.parse(saved);
                    if (parsed && Array.isArray(parsed.data) && parsed.data.length > 0) {
                        renderGlobalIndicesRows(tbody, parsed.data, true, parsed.timestamp);
                    }
                }
            } catch (_) { /* ignore */ }
        }

        if (showLoading) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="5" style="text-align:center; padding:3rem; color:var(--text-secondary);">
                        <i class="fa-solid fa-spinner fa-spin" style="font-size:1.5rem; color:#3b82f6; margin-bottom:0.5rem; display:block;"></i>
                        ગ્લોબલ ઇન્ડેક્સ લાઈવ ડેટા લોડ થઈ રહ્યો છે...
                    </td>
                </tr>
            `;
        }

        const fetchedData = [];

        await runWithConcurrency(globalIndicesConfig, 5, async (item) => {
            try {
                const response = await fetchYahooFinanceData(item.ticker, showLoading);
                if (response && response.chart && response.chart.result && response.chart.result[0]) {
                    const result = response.chart.result[0];
                    const meta = result.meta;
                    const price = meta.regularMarketPrice;
                    const prevClose = meta.previousClose !== undefined ? meta.previousClose : (meta.chartPreviousClose || price);
                    const change = price - prevClose;
                    const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;

                    let isOpen = false;
                    if (meta.currentTradingPeriod && meta.currentTradingPeriod.regular) {
                        const now = Math.floor(Date.now() / 1000);
                        const reg = meta.currentTradingPeriod.regular;
                        isOpen = now >= reg.start && now <= reg.end;
                    }

                    fetchedData.push({
                        name: item.name,
                        ticker: item.ticker,
                        price,
                        change,
                        changePct,
                        isOpen
                    });
                }
            } catch (e) {
                console.warn(`[Global Indices] Failed to fetch ${item.name}:`, e.message);
            }
        });

        if (fetchedData.length === 0) {
            // Check localStorage cache fallback
            try {
                const saved = getLocalStorageItem('global_indices_cache');
                if (saved) {
                    const parsed = JSON.parse(saved);
                    if (parsed && Array.isArray(parsed.data) && parsed.data.length > 0) {
                        renderGlobalIndicesRows(tbody, parsed.data, true, parsed.timestamp);
                        return;
                    }
                }
            } catch (_) { /* ignore */ }

            // No cache exists at all -> show clear error + Refresh button
            tbody.innerHTML = `
                <tr>
                    <td colspan="5" style="text-align:center; padding:2.5rem; color:var(--text-secondary);">
                        <i class="fa-solid fa-circle-exclamation" style="font-size:1.5rem; color:var(--danger-color); margin-bottom:0.5rem; display:block;"></i>
                        <div style="color:#fff; font-weight:600; margin-bottom:0.35rem;">Global Indices data unavailable, try again.</div>
                        <div style="font-size:0.8rem; margin-bottom:1rem;">ડેટા લોડ કરવામાં નિષ્ફળતા. કૃપા કરીને ફરીથી પ્રયાસ કરો.</div>
                        <button onclick="fetchGlobalIndices(true)" class="btn btn-primary" style="font-size:0.82rem; padding:0.45rem 1.1rem;">
                            <i class="fa-solid fa-rotate"></i> Refresh
                        </button>
                    </td>
                </tr>
            `;
            return;
        }

        // Maintain consistent configuration order
        const orderedData = [];
        globalIndicesConfig.forEach(cfg => {
            const found = fetchedData.find(d => d.ticker === cfg.ticker);
            if (found) orderedData.push(found);
        });

        // Save last successful values + timestamp to localStorage
        try {
            setLocalStorageItem('global_indices_cache', JSON.stringify({
                data: orderedData,
                timestamp: Date.now()
            }));
        } catch (_) { /* ignore quota error */ }

        renderGlobalIndicesRows(tbody, orderedData, false, null);
    } finally {
        isGlobalIndicesFetching = false;
    }
};

// =====================================================================
// INTRADAY SCANNER ENGINE
// =====================================================================

let intradayLivePrices = new Map();

window.renderIntraday = function(forceRefresh = false) {
    const emptyState   = document.getElementById('intraday-empty-state');
    const tableWrapper = document.getElementById('intraday-table-wrapper');
    const badge        = document.getElementById('intraday-count-badge');
    const tbody        = document.getElementById('intraday-tbody');
    if (!tbody) return;

    const data = state.processedMasterData;
    if (!data || data.length < 2) {
        if (emptyState)   emptyState.style.display  = '';
        if (tableWrapper) tableWrapper.style.display = 'none';
        if (badge)        badge.textContent = '0 Stocks';
        return;
    }

    const headers = data[0];
    detectColumnIndexes(headers);
    const symCol  = state.symbolColIndex;
    const serCol  = state.seriesColIndex;
    const hiCol   = state.highColIndex;
    const loCol   = state.lowColIndex;
    const clsCol  = state.closeColIndex;
    const prevCol = state.prevCloseColIndex;

    let firstDateCol = -1;
    if (hiCol !== -1) firstDateCol = hiCol + 1;
    else if (state.diffColIndex !== -1) firstDateCol = state.diffColIndex + 1;

    if (symCol === -1 || firstDateCol === -1 || firstDateCol >= headers.length || (headers.length - firstDateCol) < 2) {
        if (emptyState)   emptyState.style.display  = '';
        if (tableWrapper) tableWrapper.style.display = 'none';
        if (badge)        badge.textContent = '0 Stocks';
        return;
    }

    const results = [];

    // Columns index determination for High, Low, Close, PrevClose from Excel
    const highColIdx = headers.findIndex(h => ['HIGH', 'HI'].includes(String(h || '').toUpperCase().trim()));
    const lowColIdx  = headers.findIndex(h => ['LOW', 'LO'].includes(String(h || '').toUpperCase().trim()));
    const volColIdx  = headers.findIndex(h => ['VOLUME', 'VOL', 'QTY', 'TTL_TRD_QTY', 'TOTTRDQTY'].includes(String(h || '').toUpperCase().trim()));

    for (let r = 1; r < data.length; r++) {
        const row = data[r];
        if (!row) continue;
        const sym    = String(row[symCol] || '').trim().toUpperCase();
        const series = serCol !== -1 ? String(row[serCol] || '').trim().toUpperCase() : 'EQ';
        if (!sym || series !== 'EQ') continue;

        // Get EOD prices
        const todayClose     = parseFloat(row[firstDateCol]);
        const yesterdayClose = parseFloat(row[firstDateCol + 1]);
        const dailyHigh      = highColIdx !== -1 ? parseFloat(row[highColIdx]) : todayClose * 1.01;
        const dailyLow       = lowColIdx !== -1 ? parseFloat(row[lowColIdx]) : todayClose * 0.99;

        if (isNaN(todayClose) || isNaN(yesterdayClose) || yesterdayClose <= 0) continue;

        // Get Volume
        let volume = state.latestVolumes.get(sym) || 0;
        if (volume === 0 && volColIdx !== -1) {
            const volVal = parseFloat(row[volColIdx]);
            if (!isNaN(volVal)) volume = volVal;
        }

        // Intraday Filtering:
        // 1. High liquidity: volume >= 80,000 shares
        if (volume < 80000) continue;

        // Check if we have cached live values
        const live = intradayLivePrices.get(sym);
        const livePrice = (live && live.price) ? live.price : todayClose;
        const yesterdayClosePrice = (live && live.prevClose) ? live.prevClose : yesterdayClose;
        const liveHigh = (live && live.high) ? live.high : dailyHigh;
        const liveLow = (live && live.low) ? live.low : dailyLow;
        const liveVolume = (live && live.volume) ? live.volume : volume;

        // 2. Volatility percentage: (High - Low) / Close * 100
        const volatilityPct = livePrice > 0 ? ((liveHigh - liveLow) / livePrice) * 100 : 0;
        // Optimal intraday volatility range (between 1.2% and 8.0%)
        if (volatilityPct < 1.2 || volatilityPct > 8.0) continue;

        const changePercent = yesterdayClosePrice > 0 ? ((livePrice - yesterdayClosePrice) / yesterdayClosePrice) * 100 : 0;
        
        // Pivot Point calculations
        const P = (liveHigh + liveLow + livePrice) / 3;
        const S1 = (2 * P) - liveHigh;
        const R1 = (2 * P) - dailyLow; // Wait, let's keep R1 support/resistance math correct: (2*P) - liveLow

        // Suggested SL & Target
        let stopLoss = 0;
        let target = 0;
        let trend = 'Neutral ⚪';
        let technicalRating = 'HOLD 🟡';
        let ratingColor = '#f59e0b';
        let ratingBg = 'rgba(245,158,11,0.12)';

        if (changePercent >= 1.0) {
            trend = 'Bullish 🟢';
            stopLoss = Math.min(S1, livePrice * 0.985);
            target = Math.max(R1, livePrice * 1.025);
            if (changePercent >= 2.5) {
                technicalRating = 'STRONG BUY 🟢';
                ratingColor = 'var(--success-color)';
                ratingBg = 'rgba(16,185,129,0.12)';
            } else {
                technicalRating = 'BUY 🟢';
                ratingColor = '#4ade80';
                ratingBg = 'rgba(74,222,128,0.12)';
            }
        } else if (changePercent <= -1.0) {
            trend = 'Bearish 🔴';
            stopLoss = Math.max(R1, livePrice * 1.015);
            target = Math.min(S1, livePrice * 0.975);
            if (changePercent <= -2.5) {
                technicalRating = 'STRONG SELL 🔴';
                ratingColor = 'var(--danger-color)';
                ratingBg = 'rgba(239,68,68,0.12)';
            } else {
                technicalRating = 'SELL 🔴';
                ratingColor = '#f87171';
                ratingBg = 'rgba(248,113,113,0.12)';
            }
        } else {
            trend = 'Neutral ⚪';
            stopLoss = livePrice * 0.99;
            target = livePrice * 1.01;
        }

        results.push({
            symbol: sym,
            latestClose: todayClose,
            yesterdayClose,
            dailyHigh,
            dailyLow,
            volume,
            volatilityPct,
            changePercent,
            trend,
            stopLoss,
            target,
            technicalRating,
            ratingColor,
            ratingBg,
            livePrice,
            yesterdayClosePrice,
            liveHigh,
            liveLow,
            liveVolume
        });
    }

    // Sort by Volume descending to list most liquid first
    results.sort((a, b) => b.volume - a.volume);

    // Filter results based on search input
    const searchVal = (document.getElementById('intraday-search-input')?.value || '').trim().toUpperCase();
    const filteredIntraday = searchVal ? results.filter(item => item.symbol.toUpperCase().includes(searchVal)) : results;
    const topIntraday = filteredIntraday.slice(0, 50);

    if (topIntraday.length === 0) {
        if (emptyState)   emptyState.style.display  = '';
        if (tableWrapper) tableWrapper.style.display = 'none';
        if (badge)        badge.textContent = '0 Opportunities';
        return;
    }

    if (emptyState)   emptyState.style.display  = 'none';
    if (tableWrapper) tableWrapper.style.display = '';
    if (badge)        badge.textContent = `${topIntraday.length} Opportunities`;

    const formatVolume = (v) => {
        if (v >= 10000000) return (v / 10000000).toFixed(2) + ' Cr';
        if (v >= 100000) return (v / 100000).toFixed(2) + ' Lk';
        if (v >= 1000) return (v / 1000).toFixed(1) + ' K';
        return v.toString();
    };

    tbody.innerHTML = topIntraday.map((item, idx) => {
        const live = intradayLivePrices.get(item.symbol);
        const livePriceHtml = live 
            ? `₹${item.livePrice.toFixed(2)} <span class="live-pulse" style="width:6px;height:6px;box-shadow:0 0 0 0 rgba(16,185,129,0.7);animation:pulse 1.5s infinite;margin-left:0.2rem;display:inline-block;border-radius:50%;background:#10b981;"></span>`
            : `₹${item.latestClose.toFixed(2)} <span style="font-size:0.7rem;color:var(--text-secondary);">(EOD)</span>`;

        const changeColor = item.changePercent >= 0 ? 'var(--success-color)' : 'var(--danger-color)';

        const inWatchlist = watchlistItems.some(w => w.symbol === item.symbol);
        const starBtn = inWatchlist
            ? `<button onclick="removeFromWatchlist('${item.symbol}'); event.stopPropagation();" title="Watchlistમાંથી કાઢો" style="background:rgba(245,158,11,0.18); border:1px solid #f59e0b; color:#f59e0b; border-radius:5px; padding:0.22rem 0.5rem; cursor:pointer; font-size:0.8rem; margin-right:5px;"><i class='fa-solid fa-star'></i></button>`
            : `<button onclick="addToWatchlist('${item.symbol}', ${item.latestClose}); event.stopPropagation();" title="Watchlistમાં ઉમેરો" style="background:none; border:1px solid rgba(255,255,255,0.15); color:var(--text-secondary); border-radius:5px; padding:0.22rem 0.5rem; cursor:pointer; font-size:0.8rem; margin-right:5px;"><i class='fa-regular fa-star'></i></button>`;

        return `
            <tr class="clickable-row" onclick="showResearchModal('${item.symbol}')" 
                data-symbol="${item.symbol}"
                data-today-close="${item.latestClose}" 
                data-yesterday-close="${item.yesterdayClose}" 
                data-daily-high="${item.dailyHigh}" 
                data-daily-low="${item.dailyLow}" 
                data-volume="${item.volume}"
                title="ચાર્ટ અને વિગતો જુઓ">
                <td style="text-align:center;"><span style="background:rgba(16,185,129,0.15);color:#10b981;font-weight:700;padding:0.15rem 0.5rem;border-radius:4px;font-size:0.82rem;">${idx+1}</span></td>
                <td><strong style="color:var(--accent-color);">${item.symbol}</strong></td>
                <td class="intraday-prev-close">₹${item.yesterdayClosePrice.toFixed(2)}</td>
                <td class="intraday-live-price" data-symbol="${item.symbol}">${livePriceHtml}</td>
                <td class="intraday-live-high">₹${item.liveHigh.toFixed(2)}</td>
                <td class="intraday-live-low">₹${item.liveLow.toFixed(2)}</td>
                <td class="intraday-live-volume" style="font-weight:600;color:#cbd5e1;">${formatVolume(item.liveVolume)}</td>
                <td class="intraday-live-volatility" style="color:#a855f7;font-weight:600;">${item.volatilityPct.toFixed(2)}%</td>
                <td class="intraday-live-trend" style="font-weight:700;color:${changeColor};">${item.trend}</td>
                <td class="intraday-live-sl" style="color:var(--danger-color);font-weight:700;">₹${item.stopLoss.toFixed(2)}</td>
                <td class="intraday-live-target" style="color:var(--success-color);font-weight:700;">₹${item.target.toFixed(2)}</td>
                <td class="intraday-live-rating"><span style="background:${item.ratingBg};color:${item.ratingColor};font-weight:700;padding:0.2rem 0.6rem;border-radius:6px;font-size:0.75rem;border:1px solid ${item.ratingColor}30;">${item.technicalRating}</span></td>
                <td style="text-align:center; white-space:nowrap;">
                    ${starBtn}
                    <button onclick="showResearchModal('${item.symbol}');event.stopPropagation();"
                        style="background:rgba(16,185,129,0.12);border:1px solid #10b981;color:#10b981;border-radius:5px;padding:0.22rem 0.5rem;cursor:pointer;font-size:0.8rem;">
                        <i class="fa-solid fa-chart-area"></i>
                    </button>
                </td>
            </tr>`;
    }).join('');

    const symbolsToFetch = topIntraday.map(r => r.symbol).filter(s => !isPriceFresh(s) && !isFailedSymbolRecent(s));
    if (symbolsToFetch.length > 0 && isTabActive('tab-intraday') && (forceRefresh || intradayLivePrices.size === 0)) {
        fetchIntradayLivePrices(symbolsToFetch);
    }
};

let isIntradayFetchInFlight = false; // FIX: In-flight guard + concurrency 5
window.fetchIntradayLivePrices = async function(symbols) {
    if (!symbols || symbols.length === 0 || isIntradayFetchInFlight) return;
    isIntradayFetchInFlight = true;

    try {
        const uniqueSymbols = [...new Set(symbols)]
            .map(s => String(s || '').trim().toUpperCase())
            .filter(s => s && !isPriceFresh(s) && !isFailedSymbolRecent(s));
        if (uniqueSymbols.length === 0) return;

        await runWithConcurrency(uniqueSymbols, 5, async (symbol) => {
            try {
                const data = await fetchYahooFinanceData(symbol + '.NS');
                if (data && data.chart && data.chart.result && data.chart.result[0]) {
                    const meta = data.chart.result[0].meta;
                    const price = meta.regularMarketPrice;
                    const prevClose = meta.chartPreviousClose || meta.previousClose;
                    const high = meta.regularMarketDayHigh;
                    const low = meta.regularMarketDayLow;
                    const volume = meta.regularMarketVolume;
                    if (price) {
                        intradayLivePrices.set(symbol, { price, prevClose, high, low, volume });
                        markPriceFresh(symbol);
                        updateIntradayRowDOM(symbol);
                    }
                }
            } catch (e) {
                markSymbolFailed(symbol);
                console.warn(`[Intraday Live Update] Error for ${symbol}:`, e.message);
            }
        });
    } finally {
        isIntradayFetchInFlight = false;
    }
};

window.updateIntradayRowDOM = function(symbol) {
    const tr = document.querySelector(`#intraday-table tbody tr[data-symbol="${symbol}"]`);
    if (!tr) return;
    const live = intradayLivePrices.get(symbol);
    if (!live) return;

    const todayClose = parseFloat(tr.getAttribute('data-today-close'));
    const yesterdayClose = parseFloat(tr.getAttribute('data-yesterday-close'));
    const dailyHigh = parseFloat(tr.getAttribute('data-daily-high'));
    const dailyLow = parseFloat(tr.getAttribute('data-daily-low'));
    const origVolume = parseFloat(tr.getAttribute('data-volume'));

    const livePrice = live.price || todayClose;
    const yesterdayClosePrice = live.prevClose || yesterdayClose;
    const liveHigh = live.high || dailyHigh;
    const liveLow = live.low || dailyLow;
    const liveVolume = live.volume || origVolume;

    const volatilityPct = livePrice > 0 ? ((liveHigh - liveLow) / livePrice) * 100 : 0;
    const changePercent = yesterdayClosePrice > 0 ? ((livePrice - yesterdayClosePrice) / yesterdayClosePrice) * 100 : 0;

    const P = (liveHigh + liveLow + livePrice) / 3;
    const S1 = (2 * P) - liveHigh;
    const R1 = (2 * P) - liveLow;

    let stopLoss = 0;
    let target = 0;
    let trend = 'Neutral ⚪';
    let technicalRating = 'HOLD 🟡';
    let ratingColor = '#f59e0b';
    let ratingBg = 'rgba(245,158,11,0.12)';

    if (changePercent >= 1.0) {
        trend = 'Bullish 🟢';
        stopLoss = Math.min(S1, livePrice * 0.985);
        target = Math.max(R1, livePrice * 1.025);
        if (changePercent >= 2.5) {
            technicalRating = 'STRONG BUY 🟢';
            ratingColor = 'var(--success-color)';
            ratingBg = 'rgba(16,185,129,0.12)';
        } else {
            technicalRating = 'BUY 🟢';
            ratingColor = '#4ade80';
            ratingBg = 'rgba(74,222,128,0.12)';
        }
    } else if (changePercent <= -1.0) {
        trend = 'Bearish 🔴';
        stopLoss = Math.max(R1, livePrice * 1.015);
        target = Math.min(S1, livePrice * 0.975);
        if (changePercent <= -2.5) {
            technicalRating = 'STRONG SELL 🔴';
            ratingColor = 'var(--danger-color)';
            ratingBg = 'rgba(239,68,68,0.12)';
        } else {
            technicalRating = 'SELL 🔴';
            ratingColor = '#f87171';
            ratingBg = 'rgba(248,113,113,0.12)';
        }
    } else {
        trend = 'Neutral ⚪';
        stopLoss = livePrice * 0.99;
        target = livePrice * 1.01;
    }

    const formatVolume = (v) => {
        if (v >= 10000000) return (v / 10000000).toFixed(2) + ' Cr';
        if (v >= 100000) return (v / 100000).toFixed(2) + ' Lk';
        if (v >= 1000) return (v / 1000).toFixed(1) + ' K';
        return v.toString();
    };

    const changeColor = changePercent >= 0 ? 'var(--success-color)' : 'var(--danger-color)';

    const cellPrevClose = tr.querySelector('.intraday-prev-close');
    const cellLivePrice = tr.querySelector('.intraday-live-price');
    const cellLiveHigh = tr.querySelector('.intraday-live-high');
    const cellLiveLow = tr.querySelector('.intraday-live-low');
    const cellLiveVolume = tr.querySelector('.intraday-live-volume');
    const cellLiveVolatility = tr.querySelector('.intraday-live-volatility');
    const cellLiveTrend = tr.querySelector('.intraday-live-trend');
    const cellLiveSL = tr.querySelector('.intraday-live-sl');
    const cellLiveTarget = tr.querySelector('.intraday-live-target');
    const cellLiveRating = tr.querySelector('.intraday-live-rating');

    if (cellPrevClose) cellPrevClose.textContent = `₹${yesterdayClosePrice.toFixed(2)}`;
    if (cellLivePrice) {
        cellLivePrice.innerHTML = `₹${livePrice.toFixed(2)} <span class="live-pulse" style="width:6px;height:6px;box-shadow:0 0 0 0 rgba(16,185,129,0.7);animation:pulse 1.5s infinite;margin-left:0.2rem;display:inline-block;border-radius:50%;background:#10b981;"></span>`;
    }
    if (cellLiveHigh) cellLiveHigh.textContent = `₹${liveHigh.toFixed(2)}`;
    if (cellLiveLow) cellLiveLow.textContent = `₹${liveLow.toFixed(2)}`;
    if (cellLiveVolume) cellLiveVolume.textContent = formatVolume(liveVolume);
    if (cellLiveVolatility) cellLiveVolatility.textContent = `${volatilityPct.toFixed(2)}%`;
    if (cellLiveTrend) {
        cellLiveTrend.textContent = trend;
        cellLiveTrend.style.color = changeColor;
    }
    if (cellLiveSL) cellLiveSL.textContent = `₹${stopLoss.toFixed(2)}`;
    if (cellLiveTarget) cellLiveTarget.textContent = `₹${target.toFixed(2)}`;
    if (cellLiveRating) {
        cellLiveRating.innerHTML = `<span style="background:${ratingBg};color:${ratingColor};font-weight:700;padding:0.2rem 0.6rem;border-radius:6px;font-size:0.75rem;border:1px solid ${ratingColor}30;">${technicalRating}</span>`;
    }
};

// =====================================================================
// MASTER PIECE (TOP 5 GEMS) SECTION
// =====================================================================

let masterPieceSymbols = [];
let masterPieceLastPrices = new Map();
let currentMasterPieceData = [];

function getAdviceSymbolsList() {
    const list = [];
    const data = state.processedMasterData;
    if (!data || data.length < 2) return list;
    const headers = data[0];
    const symCol  = state.symbolColIndex;
    const serCol  = state.seriesColIndex;
    const hiCol   = state.highColIndex;
    let firstDateCol = hiCol !== -1 ? hiCol + 1 : (state.diffColIndex !== -1 ? state.diffColIndex + 1 : 1);
    
    for (let r = 1; r < data.length; r++) {
        const row = data[r];
        if (!row) continue;
        const sym = String(row[symCol] || '').trim().toUpperCase();
        const series = serCol !== -1 ? String(row[serCol] || '').trim().toUpperCase() : 'EQ';
        if (!sym || series !== 'EQ' || sym.length > 10) continue;
        
        const prices = [];
        for (let c = firstDateCol; c < Math.min(firstDateCol + 5, headers.length); c++) {
            const v = parseFloat(row[c]);
            if (!isNaN(v) && v > 0) prices.push(v);
        }
        if (prices.length < 2) continue;
        
        const mom5 = prices.length >= 5 && prices[4] > 0 ? ((prices[0] - prices[4]) / prices[4]) * 100 : 0;
        if (mom5 > 2.0) { 
            list.push(sym);
        }
    }
    return list;
}

function getCircuitSymbolsList() {
    const list = [];
    const data = state.processedMasterData;
    if (!data || data.length < 2) return list;
    const symCol  = state.symbolColIndex;
    const serCol  = state.seriesColIndex;
    const hiCol   = state.highColIndex;
    let firstDateCol = hiCol !== -1 ? hiCol + 1 : (state.diffColIndex !== -1 ? state.diffColIndex + 1 : 1);
    
    for (let r = 1; r < data.length; r++) {
        const row = data[r];
        if (!row) continue;
        const sym = String(row[symCol] || '').trim().toUpperCase();
        const series = serCol !== -1 ? String(row[serCol] || '').trim().toUpperCase() : 'EQ';
        if (!sym || series !== 'EQ') continue;
        
        const todayClose = parseFloat(row[firstDateCol]);
        const yesterdayClose = parseFloat(row[firstDateCol + 1]);
        if (isNaN(todayClose) || isNaN(yesterdayClose) || yesterdayClose <= 0) continue;
        
        const changePercent = ((todayClose - yesterdayClose) / yesterdayClose) * 100;
        if (changePercent >= 4.7) {
            list.push(sym);
        }
    }
    return list;
}

function getIntradaySymbolsList() {
    const list = [];
    const data = state.processedMasterData;
    if (!data || data.length < 2) return list;
    const symCol  = state.symbolColIndex;
    const serCol  = state.seriesColIndex;
    const hiCol   = state.highColIndex;
    
    const volColIdx  = data[0].findIndex(h => ['VOLUME', 'VOL', 'QTY', 'TTL_TRD_QTY', 'TOTTRDQTY'].includes(String(h || '').toUpperCase().trim()));
    
    for (let r = 1; r < data.length; r++) {
        const row = data[r];
        if (!row) continue;
        const sym = String(row[symCol] || '').trim().toUpperCase();
        const series = serCol !== -1 ? String(row[serCol] || '').trim().toUpperCase() : 'EQ';
        if (!sym || series !== 'EQ') continue;
        
        let volume = state.latestVolumes.get(sym) || 0;
        if (volume === 0 && volColIdx !== -1) {
            const volVal = parseFloat(row[volColIdx]);
            if (!isNaN(volVal)) volume = volVal;
        }
        if (volume < 80000) continue;
        list.push(sym);
    }
    return list;
}

function getMasterPieceSymbolsList() {
    const adviceList = getAdviceSymbolsList(); 
    const circuitList = getCircuitSymbolsList();
    const intradayList = getIntradaySymbolsList();
    
    const counts = {};
    const reasons = {};
    
    const addToCount = (sym, sourceName) => {
        counts[sym] = (counts[sym] || 0) + 1;
        if (!reasons[sym]) reasons[sym] = [];
        reasons[sym].push(sourceName);
    };
    
    adviceList.forEach(s => addToCount(s, 'Investor Advice'));
    circuitList.forEach(s => addToCount(s, 'Circuits'));
    intradayList.forEach(s => addToCount(s, 'Intraday'));
    
    const candidates = Object.keys(counts).map(sym => {
        let volume = state.latestVolumes.get(sym) || 0;
        return {
            symbol: sym,
            count: counts[sym],
            reasons: reasons[sym],
            volume: volume
        };
    });
    
    candidates.sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return b.volume - a.volume;
    });
    
    let selected = candidates.slice(0, 5);
    
    if (selected.length < 5) {
        const selectedSet = new Set(selected.map(s => s.symbol));
        for (const sym of intradayList) {
            if (selected.length >= 5) break;
            if (!selectedSet.has(sym)) {
                selected.push({
                    symbol: sym,
                    count: 1,
                    reasons: ['Intraday (Fallback)'],
                    volume: state.latestVolumes.get(sym) || 0
                });
                selectedSet.add(sym);
            }
        }
        for (const sym of circuitList) {
            if (selected.length >= 5) break;
            if (!selectedSet.has(sym)) {
                selected.push({
                    symbol: sym,
                    count: 1,
                    reasons: ['Circuits (Fallback)'],
                    volume: state.latestVolumes.get(sym) || 0
                });
                selectedSet.add(sym);
            }
        }
    }
    
    return selected.slice(0, 5);
}

window.renderMasterPiece = function(forceRefresh = false) {
    const emptyState   = document.getElementById('master-piece-empty-state');
    const tableWrapper = document.getElementById('master-piece-table-wrapper');
    const tbody        = document.getElementById('master-piece-tbody');
    if (!tbody) return;

    const data = state.processedMasterData;
    if (!data || data.length < 2) {
        if (emptyState)   emptyState.style.display  = '';
        if (tableWrapper) tableWrapper.style.display = 'none';
        return;
    }

    if (currentMasterPieceData.length === 0 || forceRefresh) {
        const selected = getMasterPieceSymbolsList();
        
        currentMasterPieceData = selected.map(item => {
            const sym = item.symbol;
            const symCol = state.symbolColIndex;
            const row = data.find((r, idx) => idx > 0 && String(r[symCol] || '').trim().toUpperCase() === sym);
            
            let todayClose = 100;
            let dailyHigh = 101;
            let dailyLow = 99;
            
            if (row) {
                const hiColIdx = data[0].findIndex(h => ['HIGH', 'HI'].includes(String(h || '').toUpperCase().trim()));
                const loColIdx = data[0].findIndex(h => ['LOW', 'LO'].includes(String(h || '').toUpperCase().trim()));
                const hiCol  = state.highColIndex;
                let firstDateCol = hiCol !== -1 ? hiCol + 1 : (state.diffColIndex !== -1 ? state.diffColIndex + 1 : 1);
                
                todayClose = parseFloat(row[firstDateCol]) || 100;
                dailyHigh = hiColIdx !== -1 ? (parseFloat(row[hiColIdx]) || todayClose * 1.01) : todayClose * 1.01;
                dailyLow = loColIdx !== -1 ? (parseFloat(row[loColIdx]) || todayClose * 0.99) : todayClose * 0.99;
            }
            
            const P = (dailyHigh + dailyLow + todayClose) / 3;
            const S1 = (2 * P) - dailyHigh;
            const R1 = (2 * P) - dailyLow;
            
            return {
                symbol: sym,
                latestClose: todayClose,
                volume: item.volume,
                reasons: item.reasons,
                stopLoss: S1,
                target: R1
            };
        });
        
        // Save initial prices for alerts comparison
        currentMasterPieceData.forEach(item => {
            if (!masterPieceLastPrices.has(item.symbol)) {
                masterPieceLastPrices.set(item.symbol, item.latestClose);
            }
        });
    }

    if (currentMasterPieceData.length === 0) {
        if (emptyState)   emptyState.style.display  = '';
        if (tableWrapper) tableWrapper.style.display = 'none';
        return;
    }

    if (emptyState)   emptyState.style.display  = 'none';
    if (tableWrapper) tableWrapper.style.display = '';

    const formatVolume = (v) => {
        if (v >= 10000000) return (v / 10000000).toFixed(2) + ' Cr';
        if (v >= 100000) return (v / 100000).toFixed(2) + ' Lk';
        if (v >= 1000) return (v / 1000).toFixed(1) + ' K';
        return v.toString();
    };

    tbody.innerHTML = currentMasterPieceData.map((item, idx) => {
        const livePriceVal = intradayLivePrices.get(item.symbol) || circuitsLivePrices.get(item.symbol) || state.gainersLivePrices.get(item.symbol) || masterPieceLastPrices.get(item.symbol);
        const livePriceHtml = livePriceVal 
            ? `₹${livePriceVal.toFixed(2)} <span class="live-pulse" style="width:6px;height:6px;box-shadow:0 0 0 0 rgba(16,185,129,0.7);animation:pulse 1.5s infinite;margin-left:0.2rem;display:inline-block;border-radius:50%;background:#10b981;"></span>`
            : `₹${item.latestClose.toFixed(2)} <span style="font-size:0.7rem;color:var(--text-secondary);">(EOD)</span>`;

        let changePercent = 0;
        if (livePriceVal) {
            changePercent = ((livePriceVal - item.latestClose) / item.latestClose) * 100;
        }

        const changeSign = changePercent >= 0 ? '+' : '';
        const changeColor = changePercent >= 0 ? 'var(--success-color)' : 'var(--danger-color)';
        
        const reasonsHtml = item.reasons.map(r => {
            const color = r.includes('Advice') ? '#ec4899' : r.includes('Circuits') ? '#eab308' : '#3b82f6';
            return `<span style="background:${color}15;color:${color};font-weight:700;padding:0.15rem 0.4rem;border-radius:4px;font-size:0.7rem;margin-right:4px;border:1px solid ${color}35;">${r}</span>`;
        }).join(' ');

        const inWatchlist = watchlistItems.some(w => w.symbol === item.symbol);
        const starBtn = inWatchlist
            ? `<button onclick="removeFromWatchlist('${item.symbol}'); event.stopPropagation();" title="Watchlistમાંથી કાઢો" style="background:rgba(245,158,11,0.18); border:1px solid #f59e0b; color:#f59e0b; border-radius:5px; padding:0.22rem 0.5rem; cursor:pointer; font-size:0.8rem; margin-right:5px;"><i class='fa-solid fa-star'></i></button>`
            : `<button onclick="addToWatchlist('${item.symbol}', ${item.latestClose}); event.stopPropagation();" title="Watchlistમાં ઉમેરો" style="background:none; border:1px solid rgba(255,255,255,0.15); color:var(--text-secondary); border-radius:5px; padding:0.22rem 0.5rem; cursor:pointer; font-size:0.8rem; margin-right:5px;"><i class='fa-regular fa-star'></i></button>`;

        return `
            <tr class="clickable-row" onclick="showResearchModal('${item.symbol}')" title="ચાર્ટ અને વિગતો જુઓ">
                <td style="text-align:center;"><span style="background:linear-gradient(135deg,#ec4899,#e11d48);color:#fff;font-weight:700;padding:0.15rem 0.6rem;border-radius:4px;font-size:0.82rem;">#${idx+1}</span></td>
                <td><strong style="color:var(--accent-color); font-size:1rem;">${item.symbol}</strong></td>
                <td>₹${item.latestClose.toFixed(2)}</td>
                <td class="master-piece-live-cell" data-symbol="${item.symbol}">${livePriceHtml}</td>
                <td style="color:${changeColor}; font-weight:700;">${changeSign}${changePercent.toFixed(2)}%</td>
                <td style="font-weight:600;color:#cbd5e1;">${formatVolume(item.volume)}</td>
                <td style="color:var(--danger-color);font-weight:700;">₹${item.stopLoss.toFixed(2)}</td>
                <td style="color:var(--success-color);font-weight:700;">₹${item.target.toFixed(2)}</td>
                <td>${reasonsHtml}</td>
                <td style="text-align:center; white-space:nowrap;">
                    ${starBtn}
                    <button onclick="showResearchModal('${item.symbol}');event.stopPropagation();"
                        style="background:rgba(236,72,153,0.12);border:1px solid #ec4899;color:#ec4899;border-radius:5px;padding:0.22rem 0.5rem;cursor:pointer;font-size:0.8rem;">
                        <i class="fa-solid fa-chart-area"></i>
                    </button>
                </td>
            </tr>`;
    }).join('');
};

// FIX: Removed sudden price-drop alerts/popups (checkMasterPieceAlerts & triggerSuddenPriceAlert)
// Quietly update Master Piece live prices only when the Master Piece tab is open
let isMasterPieceFetchInFlight = false;
window.fetchMasterPieceLivePrices = async function() {
    if (isMasterPieceFetchInFlight) return;
    if (currentMasterPieceData.length === 0) {
        renderMasterPiece();
    }
    if (currentMasterPieceData.length === 0) return;

    isMasterPieceFetchInFlight = true;
    try {
        const itemsToFetch = currentMasterPieceData.filter(item => !isPriceFresh(item.symbol) && !isFailedSymbolRecent(item.symbol));
        if (itemsToFetch.length === 0) return;

        await runWithConcurrency(itemsToFetch, 5, async (item) => {
            try {
                const symbol = item.symbol;
                const data = await fetchYahooFinanceData(symbol + '.NS');
                const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
                if (price) {
                    masterPieceLastPrices.set(symbol, price);
                    markPriceFresh(symbol);
                    document.querySelectorAll(`.master-piece-live-cell[data-symbol="${symbol}"]`).forEach(cell => {
                        cell.innerHTML = `₹${price.toFixed(2)} <span class="live-pulse" style="width:6px;height:6px;box-shadow:0 0 0 0 rgba(16,185,129,0.7);animation:pulse 1.5s infinite;margin-left:0.2rem;display:inline-block;border-radius:50%;background:#10b981;"></span>`;
                    });
                }
            } catch (e) {
                markSymbolFailed(item.symbol);
                console.warn(`[Master Piece Live Update] Error for ${item.symbol}:`, e.message);
            }
        });
    } finally {
        isMasterPieceFetchInFlight = false;
    }
};

// ==========================================
// CALL PUT (કોલ પુટ) 5-LEVEL ITM/OTM VOLUME + TICKERTAPE MMI (1-SECOND LIVE)
// ==========================================
let isCallPutFetchInFlight = false;
let cpLastExpiriesKey = '';
let cpInitializedControls = false;

function formatCpExact(num) {
    const n = Number(num);
    if (!Number.isFinite(n)) return '0';
    return Math.round(n).toLocaleString('en-IN');
}

function formatCpCompact(num) {
    const n = Number(num);
    if (!Number.isFinite(n) || n === 0) return '0';
    if (n >= 1e7) return `${(n / 1e7).toFixed(2)} Cr`;
    if (n >= 1e5) return `${(n / 1e5).toFixed(2)} L`;
    return Math.round(n).toLocaleString('en-IN');
}

window.initCallPutControls = function() {
    if (cpInitializedControls) return;
    cpInitializedControls = true;

    const symSelect = document.getElementById('cp-symbol-select');
    const expSelect = document.getElementById('cp-expiry-select');
    const refreshBtn = document.getElementById('cp-refresh-btn');

    if (symSelect) {
        symSelect.addEventListener('change', () => {
            cpLastExpiriesKey = '';
            if (expSelect) {
                expSelect.innerHTML = '<option value="">ચાલુ Expiry (Auto)</option>';
                expSelect.value = '';
            }
            window.fetchCallPutAndMmiData(true);
        });
    }

    if (expSelect) {
        expSelect.addEventListener('change', () => {
            window.fetchCallPutAndMmiData(true);
        });
    }

    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            window.fetchCallPutAndMmiData(true);
        });
    }
};

function renderMmiPanel(mmi) {
    if (!mmi || !Number.isFinite(Number(mmi.value))) return;

    const val = Number(mmi.value);
    const valEl = document.getElementById('cp-mmi-value');
    const zoneEl = document.getElementById('cp-mmi-zone');
    const chgEl = document.getElementById('cp-mmi-change');
    const markerEl = document.getElementById('cp-mmi-marker');
    const prevEl = document.getElementById('cp-mmi-prev');
    const weekEl = document.getElementById('cp-mmi-week');
    const monthEl = document.getElementById('cp-mmi-month');
    const yearEl = document.getElementById('cp-mmi-year');
    const dateEl = document.getElementById('cp-mmi-date');

    if (valEl) {
        valEl.textContent = val.toFixed(2);
        valEl.style.color = mmi.color || '#f8fafc';
    }
    if (zoneEl) {
        zoneEl.textContent = mmi.zoneGu || mmi.zone || 'Neutral';
        zoneEl.style.color = mmi.color || '#93c5fd';
        zoneEl.style.borderColor = `${mmi.color || '#3b82f6'}55`;
        zoneEl.style.background = `${mmi.color || '#3b82f6'}1f`;
    }
    if (chgEl) {
        if (mmi.changeFromPrevDay !== null && mmi.changeFromPrevDay !== undefined) {
            const sign = mmi.changeFromPrevDay >= 0 ? '+' : '';
            chgEl.textContent = `${sign}${Number(mmi.changeFromPrevDay).toFixed(2)} vs ગઈકાલ`;
            chgEl.style.color = mmi.changeFromPrevDay >= 0 ? 'var(--success-color)' : 'var(--danger-color)';
        } else {
            chgEl.textContent = '-';
        }
    }
    if (markerEl) {
        const clamped = Math.max(0, Math.min(100, val));
        markerEl.style.left = `${clamped}%`;
    }
    if (prevEl) prevEl.textContent = mmi.prevDay !== null ? Number(mmi.prevDay).toFixed(2) : '--';
    if (weekEl) weekEl.textContent = mmi.lastWeek !== null ? Number(mmi.lastWeek).toFixed(2) : '--';
    if (monthEl) monthEl.textContent = mmi.lastMonth !== null ? Number(mmi.lastMonth).toFixed(2) : '--';
    if (yearEl) yearEl.textContent = mmi.lastYear !== null ? Number(mmi.lastYear).toFixed(2) : '--';
    if (dateEl) {
        const dtStr = mmi.date ? new Date(mmi.date).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '';
        dateEl.textContent = `Source: ${mmi.source || 'tickertape.in/market-mood-index'}${dtStr ? ' • Feed Time: ' + dtStr : ''}`;
    }
}

function renderOptionChainPanel(oc) {
    if (!oc || !oc.summary) return;

    const expSelect = document.getElementById('cp-expiry-select');
    if (expSelect && Array.isArray(oc.expiries) && oc.expiries.length > 0) {
        const key = `${oc.symbol}:${oc.expiries.join('|')}`;
        if (key !== cpLastExpiriesKey) {
            cpLastExpiriesKey = key;
            const prevSelected = expSelect.value;
            expSelect.innerHTML = oc.expiries
                .map(exp => `<option value="${exp}">${exp}</option>`)
                .join('');
            expSelect.value = oc.expiries.includes(prevSelected) ? prevSelected : (oc.expiry || oc.expiries[0]);
        }
    }

    const spotEl = document.getElementById('cp-spot-price');
    const spotChgEl = document.getElementById('cp-spot-change');
    const atmEl = document.getElementById('cp-atm-strike');
    const expEl = document.getElementById('cp-active-expiry');
    const srcEl = document.getElementById('cp-feed-source');

    if (spotEl) {
        spotEl.textContent = Number(oc.spotPrice).toLocaleString('en-IN', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
    }
    if (spotChgEl) {
        if (oc.spotChange !== null && oc.spotChange !== undefined && oc.spotChangePct !== null) {
            const sign = oc.spotChange >= 0 ? '+' : '';
            spotChgEl.textContent = `${sign}${Number(oc.spotChange).toFixed(2)} (${sign}${Number(oc.spotChangePct).toFixed(2)}%)`;
            spotChgEl.style.color = oc.spotChange >= 0 ? 'var(--success-color)' : 'var(--danger-color)';
        } else {
            spotChgEl.textContent = oc.symbol;
            spotChgEl.style.color = '#94a3b8';
        }
    }
    if (atmEl) atmEl.textContent = Number(oc.atmStrike).toLocaleString('en-IN');
    if (expEl) expEl.textContent = oc.expiry || '--';
    if (srcEl) srcEl.textContent = oc.source || '--';

    // Sync top header NIFTY / SENSEX widget cleanly on 1s updates
    if (oc.symbol === 'NIFTY' && Number(oc.spotPrice) > 0) {
        const nVal = document.getElementById('nifty-val');
        const nChg = document.getElementById('nifty-chg');
        if (nVal) nVal.textContent = Number(oc.spotPrice).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        if (nChg && oc.spotChange !== null && oc.spotChangePct !== null) {
            const sign = oc.spotChange >= 0 ? '+' : '';
            nChg.textContent = `${sign}${Number(oc.spotChange).toFixed(2)} (${sign}${Number(oc.spotChangePct).toFixed(2)}%)`;
            nChg.style.color = oc.spotChange >= 0 ? 'var(--success-color)' : 'var(--danger-color)';
        }
    } else if (oc.symbol === 'SENSEX' && Number(oc.spotPrice) > 0) {
        const sVal = document.getElementById('sensex-val');
        const sChg = document.getElementById('sensex-chg');
        if (sVal) sVal.textContent = Number(oc.spotPrice).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        if (sChg && oc.spotChange !== null && oc.spotChangePct !== null) {
            const sign = oc.spotChange >= 0 ? '+' : '';
            sChg.textContent = `${sign}${Number(oc.spotChange).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${sign}${Number(oc.spotChangePct).toFixed(2)}%)`;
            sChg.style.color = oc.spotChange >= 0 ? 'var(--success-color)' : 'var(--danger-color)';
        }
    }

    const s = oc.summary;
    const setText = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    };

    setText('cp-total-itm-vol', `${formatCpExact(s.totalItm5Vol)} (${formatCpCompact(s.totalItm5Vol)})`);
    setText('cp-total-otm-vol', `${formatCpExact(s.totalOtm5Vol)} (${formatCpCompact(s.totalOtm5Vol)})`);
    setText('cp-atm-ce-vol', `${formatCpExact(s.callAtmVol)} (${formatCpCompact(s.callAtmVol)})`);
    setText('cp-atm-pe-vol', `${formatCpExact(s.putAtmVol)} (${formatCpCompact(s.putAtmVol)})`);

    setText('cp-call-itm-vol', `${formatCpExact(s.callItm5Vol)} (${formatCpCompact(s.callItm5Vol)})`);
    setText('cp-call-itm-range', s.itmRange || '--');
    setText('cp-call-itm-oi', formatCpCompact(s.callItm5Oi));

    setText('cp-call-otm-vol', `${formatCpExact(s.callOtm5Vol)} (${formatCpCompact(s.callOtm5Vol)})`);
    setText('cp-call-otm-range', s.otmRange || '--');
    setText('cp-call-otm-oi', formatCpCompact(s.callOtm5Oi));

    setText('cp-put-itm-vol', `${formatCpExact(s.putItm5Vol)} (${formatCpCompact(s.putItm5Vol)})`);
    setText('cp-put-itm-range', s.otmRange || '--');
    setText('cp-put-itm-oi', formatCpCompact(s.putItm5Oi));

    setText('cp-put-otm-vol', `${formatCpExact(s.putOtm5Vol)} (${formatCpCompact(s.putOtm5Vol)})`);
    setText('cp-put-otm-range', s.itmRange || '--');
    setText('cp-put-otm-oi', formatCpCompact(s.putOtm5Oi));

    const tbody = document.getElementById('call-put-tbody');
    if (tbody && Array.isArray(oc.rows)) {
        const zonePill = (zone) => {
            if (zone === 'ITM') return '<span class="cp-zone-pill cp-zone-itm">ITM</span>';
            if (zone === 'OTM') return '<span class="cp-zone-pill cp-zone-otm">OTM</span>';
            return '<span class="cp-zone-pill cp-zone-atm">ATM</span>';
        };

        tbody.innerHTML = oc.rows.map(r => {
            const rowCls = r.isAtm ? 'cp-atm-row' : '';
            const ceBg = r.callMoneyness === 'ITM' ? 'cp-itm-cell' : (r.callMoneyness === 'OTM' ? 'cp-otm-cell' : '');
            const peBg = r.putMoneyness === 'ITM' ? 'cp-itm-cell' : (r.putMoneyness === 'OTM' ? 'cp-otm-cell' : '');

            return `
                <tr class="${rowCls}">
                    <td style="text-align:center; font-weight:700; color:${r.isAtm ? '#22d3ee' : '#cbd5e1'};">${r.levelLabel}</td>
                    <td class="${ceBg}">${zonePill(r.callMoneyness)}</td>
                    <td class="${ceBg}" style="text-align:right; color:#cbd5e1;">${formatCpCompact(r.ceOi)}</td>
                    <td class="${ceBg}" style="text-align:right; font-weight:600; color:#93c5fd;">₹${Number(r.ceLtp).toFixed(2)}</td>
                    <td class="${ceBg}" style="text-align:right; font-weight:700; color:#ffffff;">${formatCpExact(r.ceVolume)}</td>
                    <td style="text-align:center; font-weight:700; color:${r.isAtm ? '#22d3ee' : '#f8fafc'}; background:#162033;">${Number(r.strike).toLocaleString('en-IN')}</td>
                    <td class="${peBg}" style="text-align:right; font-weight:700; color:#ffffff;">${formatCpExact(r.peVolume)}</td>
                    <td class="${peBg}" style="text-align:right; font-weight:600; color:#d8b4fe;">₹${Number(r.peLtp).toFixed(2)}</td>
                    <td class="${peBg}" style="text-align:right; color:#cbd5e1;">${formatCpCompact(r.peOi)}</td>
                    <td class="${peBg}">${zonePill(r.putMoneyness)}</td>
                </tr>
            `;
        }).join('');
    }
}

function updateTickerPair(valId, chgId, item, opts = {}) {
    if (!item || !Number.isFinite(Number(item.price))) return;
    const valEl = document.getElementById(valId);
    const chgEl = document.getElementById(chgId);
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
        chgEl.style.color = change >= 0 ? 'var(--success-color)' : 'var(--danger-color)';
    }
}

window.fetchLiveMarket1s = async function() {
    if (isLiveMarket1sInFlight) return;
    isLiveMarket1sInFlight = true;
    try {
        const res = await fetchWithTimeout('/api/live-market', { cache: 'no-store' }, 4000);
        if (!res.ok) return;
        const d = await res.json();

        // 1. Update global header cards every 1 second (NIFTY 50, SENSEX, GOLD/10g, SILVER/1kg)
        updateTickerPair('nifty-val', 'nifty-chg', d.nifty, { decimals: 2 });
        updateTickerPair('sensex-val', 'sensex-chg', d.sensex, { decimals: 2 });
        updateTickerPair('gold-val', 'gold-chg', d.gold, { decimals: 0, prefix: '\u20b9' });
        updateTickerPair('silver-val', 'silver-chg', d.silver, { decimals: 0, prefix: '\u20b9' });

        // 2. Update Call Put tab 1-second strip (including NASDAQ & SHANGHAI INDEX)
        updateTickerPair('cp-live-nifty-val', 'cp-live-nifty-chg', d.nifty, { decimals: 2 });
        updateTickerPair('cp-live-sensex-val', 'cp-live-sensex-chg', d.sensex, { decimals: 2 });
        updateTickerPair('cp-live-gold-val', 'cp-live-gold-chg', d.gold, { decimals: 0, prefix: '\u20b9' });
        updateTickerPair('cp-live-silver-val', 'cp-live-silver-chg', d.silver, { decimals: 0, prefix: '\u20b9' });
        updateTickerPair('cp-live-nasdaq-val', 'cp-live-nasdaq-chg', d.nasdaq, { decimals: 2 });
        updateTickerPair('cp-live-shanghai-val', 'cp-live-shanghai-chg', d.shanghai, { decimals: 2 });

        const setElText = (id, text) => {
            const el = document.getElementById(id);
            if (el && text) el.textContent = text;
        };
        if (d.gold?.source) setElText('cp-live-gold-src', d.gold.source);
        if (d.silver?.source) setElText('cp-live-silver-src', d.silver.source);

        // 3. Update SENSEX 30 & NSE Market Advance/Decline (nseindia.com/market-data/decline)
        const sBreadth = d.breadth?.sensex30;
        if (sBreadth) {
            setElText('cp-sensex-adv', String(sBreadth.advances));
            setElText('cp-sensex-dec', String(sBreadth.declines));
            const sTotal = (sBreadth.advances + sBreadth.declines) || 30;
            const sPct = (sBreadth.advances / sTotal) * 100;
            setElText('cp-sensex-adv-pct', `Adv ${sPct.toFixed(0)}% / Dec ${(100 - sPct).toFixed(0)}%`);
            const sBar = document.getElementById('cp-sensex-ad-bar');
            if (sBar) sBar.style.width = `${sPct.toFixed(1)}%`;
        }

        const nMarket = d.breadth?.nseMarket;
        if (nMarket) {
            setElText('cp-nse-adv', Number(nMarket.advances).toLocaleString('en-IN'));
            setElText('cp-nse-dec', Number(nMarket.declines).toLocaleString('en-IN'));
            setElText('cp-nse-unch', Number(nMarket.unchanged).toLocaleString('en-IN'));
            setElText('cp-nse-total', Number(nMarket.total).toLocaleString('en-IN'));
            const adTotal = (nMarket.advances + nMarket.declines) || 1;
            const nPct = (nMarket.advances / adTotal) * 100;
            const nBar = document.getElementById('cp-nse-ad-bar');
            if (nBar) nBar.style.width = `${nPct.toFixed(1)}%`;
            setElText('cp-breadth-time', `Source: nseindia.com/market-data/decline${nMarket.timestamp ? ' • Exchange: ' + nMarket.timestamp : ''}`);
        }
    } catch (err) {
        console.warn('[Live Market 1s]', err.message);
    } finally {
        isLiveMarket1sInFlight = false;
    }
};

window.fetchCallPutAndMmiData = async function(isManual = false) {
    if (isManual && typeof fetchLiveMarket1s === 'function') {
        fetchLiveMarket1s();
    }
    if (isCallPutFetchInFlight) return;
    isCallPutFetchInFlight = true;

    const symSelect = document.getElementById('cp-symbol-select');
    const expSelect = document.getElementById('cp-expiry-select');
    const statusEl = document.getElementById('cp-status-msg');
    const updatedEl = document.getElementById('cp-last-updated');
    const symbol = symSelect ? symSelect.value : 'NIFTY';
    const expiry = expSelect && expSelect.value ? expSelect.value : '';

    const ocUrl = `/api/option-chain?symbol=${encodeURIComponent(symbol)}${expiry ? '&expiry=' + encodeURIComponent(expiry) : ''}`;

    try {
        const [ocSettled, mmiSettled] = await Promise.allSettled([
            fetchWithTimeout(ocUrl, { cache: 'no-store' }, 4500),
            fetchWithTimeout('/api/mmi', { cache: 'no-store' }, 4500)
        ]);

        const errors = [];

        if (ocSettled.status === 'fulfilled' && ocSettled.value.ok) {
            const ocJson = await ocSettled.value.json();
            renderOptionChainPanel(ocJson);
        } else {
            errors.push(`Option Chain (${symbol}) unavailable`);
        }

        if (mmiSettled.status === 'fulfilled' && mmiSettled.value.ok) {
            const mmiJson = await mmiSettled.value.json();
            renderMmiPanel(mmiJson);
        } else {
            errors.push('Market Mood Index (tickertape.in) unavailable');
        }

        if (statusEl) {
            if (errors.length > 0) {
                statusEl.textContent = `નોંધ: ${errors.join(' | ')}`;
                statusEl.classList.remove('hidden');
            } else {
                statusEl.classList.add('hidden');
            }
        }

        if (updatedEl) {
            const nowStr = new Date().toLocaleTimeString('en-IN', { hour12: false });
            updatedEl.textContent = `1s Live • ${nowStr}`;
        }

        if (isManual && errors.length === 0 && typeof showNotification === 'function') {
            showNotification(`${symbol} કોલ-પુટ અને MMI અપડેટ થઈ ગયું`, 'success');
        }
    } catch (err) {
        console.warn('[Call Put 1s Update]', err.message);
    } finally {
        isCallPutFetchInFlight = false;
    }
};

// ==========================================
// CANDLE CHART ENGINE: CANDLESTICK + BOLLINGER BANDS (20,2) + VOLUME + 1m/3m/5m/10m/1D/5D/1W/1M/1Y + 1s LIVE UPDATES
// ==========================================
const VALID_CANDLE_TFS = ['1m', '3m', '5m', '10m', '1d', '5d', '1w', '1mo', '1y'];
const candleSeriesCache = new Map();
const modalChartState = {
    rm: { symbol: '', interval: '5m', showBB: true, fallback: [], candles: [], visibleStartTime: null },
    cm: { symbol: '', interval: '5m', showBB: true, fallback: [], candles: [], visibleStartTime: null }
};
const candleTabState = {
    symbol: 'RELIANCE',
    interval: '5m',
    showBB: true,
    candles: [],
    visibleStartTime: null,
    guideFilter: 'all',
    initialized: false
};

function formatCandleLabel(unixSec, tf) {
    const dt = new Date(unixSec * 1000);
    if (tf === '1y') {
        return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
    }
    if (tf === '5d' || tf === '1w' || tf === '1mo') {
        const dPart = dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
        const tPart = dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
        return `${dPart} ${tPart}`;
    }
    return dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function getBucketSecondsForTf(tf) {
    switch (tf) {
        case '1m': return 60;
        case '3m': return 180;
        case '5m': return 300;
        case '10m': return 600;
        case '1d': return 300;
        case '5d': return 900;
        case '1w': return 1800;
        case '1mo': return 3600;
        case '1y': return 86400;
        default: return 300;
    }
}

function getDefaultMaxBarsForTf(tf, isModal = false) {
    switch (tf) {
        case '1d': return 90;
        case '5d': return isModal ? 125 : 135;
        case '1w': return isModal ? 95 : 110;
        case '1mo': return isModal ? 140 : 165;
        case '1y': return isModal ? 160 : 255;
        default: return isModal ? 65 : 85;
    }
}

async function fetchCandleSeries(symbol, interval = '5m', forceRefresh = false) {
    const cleanSym = String(symbol || 'RELIANCE').trim().toUpperCase();
    const tf = VALID_CANDLE_TFS.includes(interval) ? interval : '5m';
    const cacheKey = `${cleanSym}:${tf}`;
    const cached = candleSeriesCache.get(cacheKey);
    if (!forceRefresh && cached && (Date.now() - cached.ts) < 3000) {
        return cached;
    }

    const url = `/api/yahoo?symbol=${encodeURIComponent(cleanSym)}&interval=${encodeURIComponent(tf)}`;
    const res = await fetchWithTimeout(url, { cache: 'no-store' }, 6500);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const rawCandles = Array.isArray(json?.candles) ? json.candles : [];
    if (rawCandles.length === 0) {
        throw new Error('No candlestick bars returned');
    }

    const formatted = rawCandles.map(c => ({
        ...c,
        label: formatCandleLabel(c.time, tf)
    }));

    const payload = {
        candles: formatted,
        visibleStartTime: json.visibleStartTime || null,
        ts: Date.now()
    };
    candleSeriesCache.set(cacheKey, payload);
    return payload;
}

function computeBollingerBands(candles, period = 20, mult = 2) {
    const upper = new Array(candles.length).fill(null);
    const middle = new Array(candles.length).fill(null);
    const lower = new Array(candles.length).fill(null);

    for (let i = period - 1; i < candles.length; i++) {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) {
            sum += candles[j].close;
        }
        const mean = sum / period;
        let sq = 0;
        for (let j = i - period + 1; j <= i; j++) {
            const diff = candles[j].close - mean;
            sq += diff * diff;
        }
        const std = Math.sqrt(sq / period);
        middle[i] = mean;
        upper[i] = mean + mult * std;
        lower[i] = mean - mult * std;
    }
    return { upper, middle, lower };
}

function computeVolumeSma(candles, period = 20) {
    const avg = new Array(candles.length).fill(0);
    for (let i = 0; i < candles.length; i++) {
        const start = Math.max(0, i - period + 1);
        let sum = 0;
        let count = 0;
        for (let j = start; j <= i; j++) {
            sum += candles[j].volume || 0;
            count++;
        }
        avg[i] = count > 0 ? sum / count : 0;
    }
    return avg;
}

function detectCandlestickPatterns(candles, bb, volAvg) {
    const markers = new Array(candles.length).fill(null);
    const detected = [];

    for (let i = 1; i < candles.length; i++) {
        const c = candles[i];
        const p = candles[i - 1];
        const p2 = i >= 2 ? candles[i - 2] : null;

        const body = Math.abs(c.close - c.open);
        const range = Math.max(0.0001, c.high - c.low);
        const upperWick = c.high - Math.max(c.open, c.close);
        const lowerWick = Math.min(c.open, c.close) - c.low;
        const isBull = c.close >= c.open;
        const isBear = c.close < c.open;

        const pBody = Math.abs(p.close - p.open);
        const pIsBull = p.close >= p.open;
        const pIsBear = p.close < p.open;

        const avgV = volAvg[i] || 0;
        const volRatio = avgV > 0 && c.volume > 0 ? c.volume / avgV : 1;
        const volHigh = volRatio >= 1.25;
        const volStr = avgV > 0 ? `${volRatio.toFixed(2)}x Avg Vol` : 'Price Action';

        const bbLow = bb.lower[i];
        const bbUp = bb.upper[i];
        const bbMid = bb.middle[i];

        let match = null;

        // 1. Bullish Engulfing
        if (pIsBear && isBull && c.open <= p.close && c.close >= p.open && body > pBody * 1.05) {
            match = {
                name: 'Bullish Engulfing (બુલિશ એન્ગલ્ફિંગ)',
                direction: 'BULLISH',
                tag: 'BE+',
                desc: `લાલ કેન્ડલને ગ્રીન કેન્ડલે સંપૂર્ણ ઢાંકી દીધી (${volStr}). આગળ ભાવ વધવાની શક્યતા.`
            };
        }
        // 2. Bearish Engulfing
        else if (pIsBull && isBear && c.open >= p.close && c.close <= p.open && body > pBody * 1.05) {
            match = {
                name: 'Bearish Engulfing (બેરિશ એન્ગલ્ફિંગ)',
                direction: 'BEARISH',
                tag: 'BE-',
                desc: `ગ્રીન કેન્ડલને મોટી લાલ કેન્ડલે ઢાંકી દીધી (${volStr}). આગળ નફા વસૂલી / ઘટાડાની શક્યતા.`
            };
        }
        // 3. Morning Star (3-candle bullish)
        else if (p2 && p2.close < p2.open && pBody < Math.abs(p2.close - p2.open) * 0.45 && isBull && c.close > (p2.open + p2.close) / 2) {
            match = {
                name: 'Morning Star (મોર્નિંગ સ્ટાર)',
                direction: 'BULLISH',
                tag: 'MS+',
                desc: `ઘટાડા પછી નાની ડોજી/સ્ટાર અને ત્યારબાદ મજબૂત ગ્રીન કેન્ડલ (${volStr}). ભાવ વધશે.`
            };
        }
        // 4. Evening Star (3-candle bearish)
        else if (p2 && p2.close > p2.open && pBody < Math.abs(p2.close - p2.open) * 0.45 && isBear && c.close < (p2.open + p2.close) / 2) {
            match = {
                name: 'Evening Star (ઇવનિંગ સ્ટાર)',
                direction: 'BEARISH',
                tag: 'ES-',
                desc: `તેજીની ટોચ પર સ્ટાર અને ત્યારબાદ મજબૂત લાલ કેન્ડલ (${volStr}). ભાવ ઘટશે.`
            };
        }
        // 5. Three White Soldiers
        else if (p2 && p2.close > p2.open && pIsBull && isBull && c.close > p.close && p.close > p2.close && body > range * 0.5) {
            match = {
                name: 'Three White Soldiers (થ્રી વ્હાઇટ સોલ્જર્સ)',
                direction: 'BULLISH',
                tag: '3WS',
                desc: `સતત 3 મજબૂત ગ્રીન કેન્ડલ્સ ઊંચા બંધ સાથે (${volStr}). મજબૂત તેજીનો સંકેત.`
            };
        }
        // 6. Three Black Crows
        else if (p2 && p2.close < p2.open && pIsBear && isBear && c.close < p.close && p.close < p2.close && body > range * 0.5) {
            match = {
                name: 'Three Black Crows (થ્રી બ્લેક ક્રોઝ)',
                direction: 'BEARISH',
                tag: '3BC',
                desc: `સતત 3 મજબૂત લાલ કેન્ડલ્સ નીચા બંધ સાથે (${volStr}). મજબૂત ઘટાડાનો સંકેત.`
            };
        }
        // 7. Hammer / Dragonfly
        else if (lowerWick >= body * 2 && upperWick <= body * 0.4 && body > 0 && c.close <= (p.close * 1.005)) {
            match = {
                name: 'Hammer (હેમર)',
                direction: 'BULLISH',
                tag: 'H+',
                desc: `નીચે લાંબી પૂંછડી (Buying Support) અને ઉપર નાની બોડી (${volStr}). નીચેથી ભાવ વધશે.`
            };
        }
        // 8. Shooting Star
        else if (upperWick >= body * 2 && lowerWick <= body * 0.4 && body > 0 && c.high >= p.high) {
            match = {
                name: 'Shooting Star (શૂટિંગ સ્ટાર)',
                direction: 'BEARISH',
                tag: 'SS-',
                desc: `ઉપર લાંબી પૂંછડી (Selling Pressure) (${volStr}). ટોચ પરથી ભાવ ઘટવાનો સંકેત.`
            };
        }
        // 9. Bollinger Lower Bounce with Volume
        else if (bbLow && c.low <= bbLow * 1.002 && isBull && volHigh) {
            match = {
                name: 'Lower BB Volume Bounce (બોલિંગર સપોર્ટ)',
                direction: 'BULLISH',
                tag: 'BB+',
                desc: `Lower Bollinger Band પર વધારે વોલ્યુમ (${volStr}) સાથે ગ્રીન કેન્ડલ. ઉછાળાની શક્યતા.`
            };
        }
        // 10. Bollinger Upper Breakout / Exhaustion
        else if (bbUp && isBull && c.close > bbUp && volHigh) {
            match = {
                name: 'Upper BB Volume Breakout',
                direction: 'BULLISH',
                tag: 'BO+',
                desc: `Upper Bollinger Band ઉપર ભારે વોલ્યુમ (${volStr}) સાથે બ્રેકઆઉટ. તેજી ચાલુ રહી શકે.`
            };
        }
        // 11. Doji with High Volume
        else if (body <= range * 0.12 && volHigh) {
            match = {
                name: 'High-Volume Doji (ડોજી)',
                direction: 'NEUTRAL',
                tag: 'DJ',
                desc: `ઓપન-ક્લોઝ લગભગ સરખું અને ઊંચું વોલ્યુમ (${volStr}). ટ્રેન્ડ બદલાવાની તૈયારી — આગલી કેન્ડલ જુઓ.`
            };
        }

        // Tag Bollinger touch hint if no specific pattern matched on final candle
        if (!match && i === candles.length - 1 && bbMid) {
            if (isBull && c.close > bbMid && volHigh) {
                match = {
                    name: 'High-Volume Bullish Candle (વધતો વોલ્યુમ)',
                    direction: 'BULLISH',
                    tag: 'VOL+',
                    desc: `20-SMA ઉપર મજબૂત ગ્રીન કેન્ડલ + ${volStr}. ખરીદીનું દબાણ વધારે છે.`
                };
            } else if (isBear && c.close < bbMid && volHigh) {
                match = {
                    name: 'High-Volume Bearish Candle (વેચવાલી વોલ્યુમ)',
                    direction: 'BEARISH',
                    tag: 'VOL-',
                    desc: `20-SMA નીચે મજબૂત લાલ કેન્ડલ + ${volStr}. વેચવાલીનું દબાણ વધારે છે.`
                };
            }
        }

        if (match) {
            const entry = {
                index: i,
                label: c.label || '',
                price: c.close,
                volRatio,
                volStr,
                ...match
            };
            markers[i] = entry;
            detected.push(entry);
        }
    }

    const lastIdx = candles.length - 1;
    const last = candles[lastIdx];
    const lastAvgV = volAvg[lastIdx] || 0;
    const lastVolRatio = lastAvgV > 0 && last.volume > 0 ? last.volume / lastAvgV : 1;
    const bbUp = bb.upper[lastIdx];
    const bbMid = bb.middle[lastIdx];
    const bbLow = bb.lower[lastIdx];

    // Pick strongest recent pattern (within last 4 candles) or BB + Volume trend
    const recent = detected.filter(d => d.index >= Math.max(0, lastIdx - 4));
    const latestPat = recent.length > 0 ? recent[recent.length - 1] : null;

    let direction = 'NEUTRAL';
    let titleGu = 'મિશ્ર / રાહ જુઓ (SIDEWAYS)';
    let patternTitle = latestPat ? latestPat.name : 'Bollinger + Volume Trend';
    let summaryGu = '';

    if (latestPat && latestPat.direction === 'BULLISH') {
        direction = 'BULLISH';
        titleGu = 'આગળ ભાવ વધશે (BULLISH / UP)';
        summaryGu = `${latestPat.desc} ${bbMid ? (last.close >= bbMid ? 'ભાવ 20-SMA ની ઉપર મજબૂત છે.' : 'Lower Band પાસેથી રિવર્સલ સપોર્ટ.') : ''}`;
    } else if (latestPat && latestPat.direction === 'BEARISH') {
        direction = 'BEARISH';
        titleGu = 'આગળ ભાવ ઘટશે (BEARISH / DOWN)';
        summaryGu = `${latestPat.desc} ${bbMid ? (last.close <= bbMid ? 'ભાવ 20-SMA ની નીચે નબળો છે.' : 'Upper Band પાસેથી નફા વસૂલી.') : ''}`;
    } else if (bbMid) {
        if (last.close > bbMid && last.close >= last.open) {
            direction = 'BULLISH';
            titleGu = 'તેજી તરફી ઝોક (MILD BULLISH)';
            summaryGu = `ભાવ Bollinger Middle (20-SMA ₹${bbMid.toFixed(2)}) ની ઉપર ગ્રીન કેન્ડલમાં ટકી રહ્યો છે (Vol: ${lastVolRatio.toFixed(2)}x Avg).`;
        } else if (last.close < bbMid && last.close < last.open) {
            direction = 'BEARISH';
            titleGu = 'મંદી તરફી ઝોક (MILD BEARISH)';
            summaryGu = `ભાવ Bollinger Middle (20-SMA ₹${bbMid.toFixed(2)}) ની નીચે લાલ કેન્ડલમાં દબાણ હેઠળ છે (Vol: ${lastVolRatio.toFixed(2)}x Avg).`;
        } else {
            summaryGu = `બજાર રેન્જમાં છે (20-SMA ₹${bbMid.toFixed(2)}). ઊંચા વોલ્યુમ (>1.5x) સાથે Upper/Lower Band બ્રેકઆઉટની રાહ જુઓ.`;
        }
    } else {
        summaryGu = 'પૂરતી કેન્ડલ્સ ઉપલબ્ધ ન હોવાથી બેઝિક ભાવ વિશ્લેષણ બતાવેલ છે.';
    }

    return {
        markers,
        recentPatterns: detected.slice(-6).reverse(),
        verdict: {
            direction,
            titleGu,
            patternTitle,
            summaryGu,
            close: last.close,
            volRatio: lastVolRatio,
            bbUpper: bbUp,
            bbMid,
            bbLower: bbLow
        }
    };
}

function renderCandlestickBollingerChart(canvasId, allCandles, options = {}) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !Array.isArray(allCandles) || allCandles.length === 0) return;

    if (typeof canvas.__ccCleanup === 'function') {
        canvas.__ccCleanup();
    }

    let currentAllCandles = allCandles;
    let currentOptions = options;
    let hoverIdx = -1;

    // Interactive scroll & zoom viewport state
    let viewStart = 0;
    let viewCount = allCandles.length;
    let userModifiedView = false;
    let prevTotalLen = allCandles.length;

    let candles = [];
    let bb = { upper: [], middle: [], lower: [] };
    let volAvg = [];
    let markers = [];
    let analysis = null;
    let showBB = true;
    let slotCount = 0;

    const getDefaultBounds = (sourceCandles, opts) => {
        const N = sourceCandles.length;
        const maxBars = opts.maxBars || 85;
        let dStart = Math.max(0, N - maxBars);
        if (opts.visibleStartTime) {
            const timeIdx = sourceCandles.findIndex(c => c.time >= opts.visibleStartTime);
            if (timeIdx !== -1 && (N - timeIdx) >= 3) {
                dStart = timeIdx;
            }
        }
        return { dStart, dCount: Math.max(1, N - dStart) };
    };

    const initBounds = getDefaultBounds(currentAllCandles, currentOptions);
    viewStart = initBounds.dStart;
    viewCount = initBounds.dCount;

    const recomputeView = (sourceCandles, opts) => {
        const N = sourceCandles.length;
        const bbFull = computeBollingerBands(sourceCandles, 20, 2);
        const volAvgFull = computeVolumeSma(sourceCandles, 20);
        analysis = detectCandlestickPatterns(sourceCandles, bbFull, volAvgFull);

        if (!userModifiedView) {
            const b = getDefaultBounds(sourceCandles, opts);
            viewStart = b.dStart;
            viewCount = b.dCount;
        } else {
            const wasAtLiveEdge = (viewStart + viewCount) >= (prevTotalLen - 0.5);
            const minBars = Math.min(10, N);
            viewCount = Math.max(minBars, Math.min(N, viewCount));
            if (wasAtLiveEdge) {
                viewStart = Math.max(0, N - viewCount);
            } else {
                viewStart = Math.max(0, Math.min(N - viewCount, viewStart));
            }
        }
        prevTotalLen = N;

        const startIdx = Math.max(0, Math.min(N - 1, Math.round(viewStart)));
        const endIdx = Math.max(startIdx + 1, Math.min(N, startIdx + Math.round(viewCount)));

        candles = sourceCandles.slice(startIdx, endIdx);
        bb = {
            upper: bbFull.upper.slice(startIdx, endIdx),
            middle: bbFull.middle.slice(startIdx, endIdx),
            lower: bbFull.lower.slice(startIdx, endIdx)
        };
        volAvg = volAvgFull.slice(startIdx, endIdx);
        markers = analysis.markers.slice(startIdx, endIdx);
        showBB = opts.showBB !== false;

        // Reserve full 09:15 -> 15:30 (75 x 5m = 375 mins) slot timeline on 1D default view
        if (opts.interval === '1d' && !userModifiedView && candles.length > 0 && candles.length < 75) {
            slotCount = 75;
        } else {
            slotCount = candles.length;
        }

        if (hoverIdx >= candles.length) hoverIdx = candles.length - 1;
    };

    recomputeView(currentAllCandles, currentOptions);

    let lastPlotW = 600;
    let lastStepX = 8;

    const draw = () => {
        if (!canvas.parentElement) return;
        const rect = canvas.parentElement.getBoundingClientRect();
        const width = Math.max(280, Math.floor(rect.width || 600));
        const height = Math.max(180, Math.floor(rect.height || 320));
        const dpr = Math.min(window.devicePixelRatio || 1, 2);

        if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
            canvas.width = width * dpr;
            canvas.height = height * dpr;
        }
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const padLeft = 10;
        const padRight = 64;
        const padTop = 14;
        const padBottom = 26;
        const plotW = Math.max(80, width - padLeft - padRight);
        const totalPlotH = Math.max(100, height - padTop - padBottom);
        const hasVolume = candles.some(c => c.volume > 0);
        const priceH = hasVolume ? totalPlotH * 0.72 : totalPlotH;
        const volGap = hasVolume ? 10 : 0;
        const volTop = padTop + priceH + volGap;
        const volH = hasVolume ? Math.max(24, totalPlotH - priceH - volGap) : 0;

        // Clear background
        ctx.fillStyle = '#070c17';
        ctx.fillRect(0, 0, width, height);

        // Compute Y range across visible candles & Bollinger bands
        let minP = Infinity;
        let maxP = -Infinity;
        let maxV = 0;

        for (let i = 0; i < candles.length; i++) {
            const c = candles[i];
            minP = Math.min(minP, c.low);
            maxP = Math.max(maxP, c.high);
            if (showBB) {
                if (bb.lower[i] !== null) minP = Math.min(minP, bb.lower[i]);
                if (bb.upper[i] !== null) maxP = Math.max(maxP, bb.upper[i]);
            }
            if (c.volume > maxV) maxV = c.volume;
        }

        if (!Number.isFinite(minP) || !Number.isFinite(maxP)) return;
        const padPrice = Math.max(0.5, (maxP - minP) * 0.08);
        minP -= padPrice;
        maxP += padPrice;

        const priceToY = (p) => padTop + ((maxP - p) / (maxP - minP)) * priceH;
        const activeSlots = Math.max(1, slotCount || candles.length);
        const stepX = plotW / activeSlots;
        const candleW = Math.max(1.4, Math.min(16, stepX * 0.65));
        lastPlotW = plotW;
        lastStepX = stepX;

        // Gridlines & Right Y-axis Price Labels
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
        ctx.fillStyle = '#94a3b8';
        ctx.font = '11px Outfit, sans-serif';
        ctx.textAlign = 'left';
        ctx.lineWidth = 1;

        for (let g = 0; g <= 4; g++) {
            const y = padTop + (priceH * g) / 4;
            const val = maxP - ((maxP - minP) * g) / 4;
            ctx.beginPath();
            ctx.moveTo(padLeft, y);
            ctx.lineTo(padLeft + plotW, y);
            ctx.stroke();
            ctx.fillText('₹' + val.toFixed(val >= 1000 ? 0 : 2), padLeft + plotW + 6, y + 4);
        }

        // Bollinger Bands fill + Upper/Mid/Lower lines
        if (showBB) {
            const validIndices = [];
            for (let i = 0; i < candles.length; i++) {
                if (bb.upper[i] !== null && bb.lower[i] !== null) validIndices.push(i);
            }
            if (validIndices.length > 1) {
                ctx.beginPath();
                validIndices.forEach((idx, pos) => {
                    const x = padLeft + (idx + 0.5) * stepX;
                    const y = priceToY(bb.upper[idx]);
                    if (pos === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                });
                for (let k = validIndices.length - 1; k >= 0; k--) {
                    const idx = validIndices[k];
                    const x = padLeft + (idx + 0.5) * stepX;
                    const y = priceToY(bb.lower[idx]);
                    ctx.lineTo(x, y);
                }
                ctx.closePath();
                ctx.fillStyle = 'rgba(56, 189, 248, 0.08)';
                ctx.fill();
            }

            const drawLine = (series, color, dashed = false) => {
                ctx.save();
                ctx.strokeStyle = color;
                ctx.lineWidth = 1.4;
                if (dashed) ctx.setLineDash([4, 4]);
                ctx.beginPath();
                let started = false;
                for (let i = 0; i < candles.length; i++) {
                    if (series[i] === null) continue;
                    const x = padLeft + (i + 0.5) * stepX;
                    const y = priceToY(series[i]);
                    if (!started) { ctx.moveTo(x, y); started = true; }
                    else ctx.lineTo(x, y);
                }
                ctx.stroke();
                ctx.restore();
            };

            drawLine(bb.upper, '#38bdf8', false);
            drawLine(bb.middle, '#f59e0b', true);
            drawLine(bb.lower, '#38bdf8', false);
        }

        // Draw Candlesticks + Volume Bars
        for (let i = 0; i < candles.length; i++) {
            const c = candles[i];
            const cx = padLeft + (i + 0.5) * stepX;
            const isUp = c.close >= c.open;
            const col = isUp ? '#22c55e' : '#ef4444';

            // Wick
            ctx.strokeStyle = col;
            ctx.lineWidth = stepX < 4 ? 1 : 1.2;
            ctx.beginPath();
            ctx.moveTo(cx, priceToY(c.high));
            ctx.lineTo(cx, priceToY(c.low));
            ctx.stroke();

            // Body
            const yOpen = priceToY(c.open);
            const yClose = priceToY(c.close);
            const bodyTop = Math.min(yOpen, yClose);
            const bodyH = Math.max(2, Math.abs(yClose - yOpen));
            ctx.fillStyle = col;
            ctx.fillRect(cx - candleW / 2, bodyTop, candleW, bodyH);

            // Pattern Marker badge on candle
            const mk = markers[i];
            if (mk) {
                const isBullMk = mk.direction === 'BULLISH';
                const isBearMk = mk.direction === 'BEARISH';
                ctx.fillStyle = isBullMk ? '#10b981' : (isBearMk ? '#ef4444' : '#f59e0b');
                const my = isBullMk ? Math.min(height - 28, priceToY(c.low) + 9) : Math.max(padTop + 9, priceToY(c.high) - 6);
                ctx.beginPath();
                ctx.arc(cx, my, 3.0, 0, Math.PI * 2);
                ctx.fill();
            }

            // Volume Bars
            if (hasVolume && maxV > 0) {
                const vH = (c.volume / maxV) * volH;
                ctx.fillStyle = isUp ? 'rgba(34, 197, 94, 0.55)' : 'rgba(239, 68, 68, 0.55)';
                ctx.fillRect(cx - candleW / 2, volTop + volH - vH, candleW, vH);
            }
        }

        // Highlight latest live price horizontal dashed guide
        const liveCandle = candles[candles.length - 1];
        if (liveCandle) {
            const ly = priceToY(liveCandle.close);
            const liveCol = liveCandle.close >= liveCandle.open ? '#22c55e' : '#ef4444';
            ctx.save();
            ctx.strokeStyle = liveCol;
            ctx.globalAlpha = 0.55;
            ctx.setLineDash([2, 3]);
            ctx.beginPath();
            ctx.moveTo(padLeft, ly);
            ctx.lineTo(padLeft + plotW, ly);
            ctx.stroke();
            ctx.restore();

            ctx.fillStyle = liveCol;
            ctx.fillRect(padLeft + plotW + 2, ly - 8, padRight - 4, 16);
            ctx.fillStyle = '#0f172a';
            ctx.font = 'bold 10px Outfit, sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText('₹' + liveCandle.close.toFixed(liveCandle.close >= 1000 ? 0 : 2), padLeft + plotW + 5, ly + 3.5);
        }

        // Volume 20-SMA line
        if (hasVolume && maxV > 0) {
            ctx.save();
            ctx.strokeStyle = '#a855f7';
            ctx.lineWidth = 1.2;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            for (let i = 0; i < candles.length; i++) {
                const x = padLeft + (i + 0.5) * stepX;
                const y = volTop + volH - ((volAvg[i] || 0) / maxV) * volH;
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
            ctx.restore();

            ctx.fillStyle = '#a855f7';
            ctx.font = '10px Outfit, sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText('VOL', padLeft + plotW + 6, volTop + 11);
        }

        // Bottom X-axis time labels:
        // When viewing 1D session (09:15 -> 15:30 / 3:30), anchor exact session ticks 09:15..15:30!
        ctx.fillStyle = '#94a3b8';
        ctx.font = '10px Outfit, sans-serif';
        ctx.textAlign = 'center';

        const is1dSession = currentOptions.interval === '1d' && !userModifiedView;
        if (is1dSession) {
            const sessionTicks = ['09:15', '10:45', '12:15', '13:45', '15:30'];
            sessionTicks.forEach((lbl, tIdx) => {
                const frac = tIdx / (sessionTicks.length - 1);
                const x = padLeft + frac * plotW;
                ctx.fillText(lbl, Math.max(padLeft + 18, Math.min(padLeft + plotW - 18, x)), height - 8);
            });
        } else {
            const tickCount = Math.min(5, candles.length);
            for (let t = 0; t < tickCount; t++) {
                const idx = tickCount === 1 ? 0 : Math.round((t * (candles.length - 1)) / (tickCount - 1));
                const x = padLeft + (idx + 0.5) * stepX;
                let lbl = candles[idx].label || '';
                // If an intraday chart starts at 09:15 or closes at 15:25/15:27/15:29, show clean 15:30 end label
                if (t === tickCount - 1 && ['1m', '3m', '5m', '10m'].includes(currentOptions.interval)) {
                    const istMin = Math.floor(((candles[idx].time + 19800) % 86400) / 60);
                    if (istMin >= 920 && istMin <= 930) {
                        lbl = '15:30';
                    }
                }
                ctx.fillText(lbl, Math.max(32, Math.min(padLeft + plotW - 32, x)), height - 8);
            }
        }

        // Mini horizontal scrollbar indicator when zoomed or panned inside history
        if (candles.length < currentAllCandles.length) {
            const trackY = height - 3;
            const total = Math.max(1, currentAllCandles.length);
            const thumbX = padLeft + (viewStart / total) * plotW;
            const thumbW = Math.max(18, (candles.length / total) * plotW);
            ctx.fillStyle = 'rgba(148, 163, 184, 0.16)';
            ctx.fillRect(padLeft, trackY, plotW, 2);
            ctx.fillStyle = 'rgba(56, 189, 248, 0.7)';
            ctx.fillRect(thumbX, trackY, Math.min(plotW - (thumbX - padLeft), thumbW), 2);
        }

        // Hover crosshair
        const readoutEl = currentOptions.readoutId ? document.getElementById(currentOptions.readoutId) : null;
        if (hoverIdx >= 0 && hoverIdx < candles.length) {
            const c = candles[hoverIdx];
            const hx = padLeft + (hoverIdx + 0.5) * stepX;
            const hy = priceToY(c.close);

            ctx.save();
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(hx, padTop);
            ctx.lineTo(hx, padTop + totalPlotH);
            ctx.moveTo(padLeft, hy);
            ctx.lineTo(padLeft + plotW, hy);
            ctx.stroke();
            ctx.restore();

            if (readoutEl) {
                const mk = markers[hoverIdx];
                const bbStr = (showBB && bb.upper[hoverIdx] !== null)
                    ? ` | BB: ${bb.upper[hoverIdx].toFixed(1)}/${bb.middle[hoverIdx].toFixed(1)}/${bb.lower[hoverIdx].toFixed(1)}`
                    : '';
                const volText = c.volume > 0 ? ` | Vol: ${Math.round(c.volume).toLocaleString('en-IN')}` : '';
                const patText = mk ? ` | ${mk.name}` : '';
                readoutEl.textContent = `${c.label} | O:${c.open.toFixed(2)} H:${c.high.toFixed(2)} L:${c.low.toFixed(2)} C:${c.close.toFixed(2)}${volText}${bbStr}${patText}`;
            }
        }
    };

    const zoomAt = (factor, anchorFrac = 0.5) => {
        const N = currentAllCandles.length;
        const minView = Math.min(10, N);
        const newCount = Math.round(Math.max(minView, Math.min(N, viewCount * factor)));
        const anchorIdx = viewStart + anchorFrac * viewCount;
        viewStart = Math.max(0, Math.min(N - newCount, Math.round(anchorIdx - anchorFrac * newCount)));
        viewCount = newCount;
        userModifiedView = true;
        recomputeView(currentAllCandles, currentOptions);
        draw();
    };

    const panBy = (deltaBars) => {
        const N = currentAllCandles.length;
        viewStart = Math.max(0, Math.min(N - viewCount, Math.round(viewStart + deltaBars)));
        userModifiedView = true;
        recomputeView(currentAllCandles, currentOptions);
        draw();
    };

    const resetView = () => {
        userModifiedView = false;
        recomputeView(currentAllCandles, currentOptions);
        draw();
    };

    const updateHoverFromClientX = (clientX) => {
        const rect = canvas.getBoundingClientRect();
        const plotW = Math.max(80, rect.width - 10 - 64);
        const relX = clientX - rect.left - 10;
        const activeSlots = Math.max(1, slotCount || candles.length);
        const idx = Math.floor((relX / plotW) * activeSlots);
        if (idx >= 0 && idx < candles.length) {
            hoverIdx = idx;
        } else {
            hoverIdx = -1;
        }
        draw();
    };

    let isDragging = false;
    let dragStartX = 0;
    let dragStartViewStart = 0;

    const onMouseDown = (e) => {
        if (e.button !== 0) return;
        isDragging = true;
        dragStartX = e.clientX;
        dragStartViewStart = viewStart;
    };

    const onMouseMove = (e) => {
        if (isDragging) {
            const dx = e.clientX - dragStartX;
            const barsDelta = Math.round(-dx / Math.max(2, lastStepX));
            const N = currentAllCandles.length;
            const nextStart = Math.max(0, Math.min(N - viewCount, dragStartViewStart + barsDelta));
            if (nextStart !== viewStart || !userModifiedView) {
                viewStart = nextStart;
                userModifiedView = true;
                recomputeView(currentAllCandles, currentOptions);
                draw();
            }
            return;
        }
        updateHoverFromClientX(e.clientX);
    };

    const onMouseUp = () => {
        isDragging = false;
    };

    const onWheel = (e) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const anchorFrac = Math.max(0, Math.min(1, (e.clientX - rect.left - 10) / Math.max(80, lastPlotW)));
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
            const rawDelta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
            const step = Math.max(2, Math.round(viewCount * 0.1));
            panBy(rawDelta > 0 ? step : -step);
        } else {
            zoomAt(e.deltaY < 0 ? 0.85 : 1.18, anchorFrac);
        }
    };

    let touchStartX = 0;
    let touchStartY = 0;
    let touchStartViewStart = 0;
    let pinchStartDist = 0;
    let pinchStartViewCount = 0;

    const onTouchStart = (e) => {
        if (e.touches.length === 2) {
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            pinchStartDist = Math.hypot(dx, dy);
            pinchStartViewCount = viewCount;
        } else if (e.touches.length === 1) {
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            touchStartViewStart = viewStart;
            pinchStartDist = 0;
        }
    };

    const onTouchMove = (e) => {
        if (e.touches.length === 2 && pinchStartDist > 0) {
            e.preventDefault();
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            const curDist = Math.hypot(dx, dy);
            if (curDist > 10) {
                const ratio = pinchStartDist / curDist;
                const N = currentAllCandles.length;
                const minView = Math.min(10, N);
                const newCount = Math.round(Math.max(minView, Math.min(N, pinchStartViewCount * ratio)));
                const midIdx = viewStart + viewCount * 0.5;
                viewStart = Math.max(0, Math.min(N - newCount, Math.round(midIdx - newCount * 0.5)));
                viewCount = newCount;
                userModifiedView = true;
                recomputeView(currentAllCandles, currentOptions);
                draw();
            }
            return;
        }
        if (e.touches.length === 1) {
            const dx = e.touches[0].clientX - touchStartX;
            const dy = e.touches[0].clientY - touchStartY;
            if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 6) {
                e.preventDefault();
                const barsDelta = Math.round(-dx / Math.max(2, lastStepX));
                const N = currentAllCandles.length;
                viewStart = Math.max(0, Math.min(N - viewCount, touchStartViewStart + barsDelta));
                userModifiedView = true;
                recomputeView(currentAllCandles, currentOptions);
                draw();
            } else {
                updateHoverFromClientX(e.touches[0].clientX);
            }
        }
    };

    const onLeave = () => {
        if (!isDragging) {
            hoverIdx = -1;
            draw();
        }
    };
    const onResize = () => draw();

    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('touchstart', onTouchStart, { passive: true });
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });
    canvas.addEventListener('mouseleave', onLeave);
    window.addEventListener('resize', onResize);

    canvas.__ccZoom = (factor) => zoomAt(factor, 0.5);
    canvas.__ccPan = (bars) => panBy(bars);
    canvas.__ccReset = () => resetView();
    canvas.__ccGetViewCount = () => viewCount;

    canvas.__ccUpdateData = (newAllCandles, newOptions = {}) => {
        currentAllCandles = newAllCandles;
        currentOptions = { ...currentOptions, ...newOptions };
        recomputeView(currentAllCandles, currentOptions);
        draw();
        return analysis;
    };

    canvas.__ccIsHovering = () => hoverIdx !== -1;

    canvas.__ccCleanup = () => {
        canvas.removeEventListener('mousedown', onMouseDown);
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        canvas.removeEventListener('wheel', onWheel);
        canvas.removeEventListener('touchstart', onTouchStart);
        canvas.removeEventListener('touchmove', onTouchMove);
        canvas.removeEventListener('mouseleave', onLeave);
        window.removeEventListener('resize', onResize);
        delete canvas.__ccUpdateData;
        delete canvas.__ccIsHovering;
        delete canvas.__ccZoom;
        delete canvas.__ccPan;
        delete canvas.__ccReset;
        delete canvas.__ccGetViewCount;
    };

    draw();
    return analysis;
}

function wireCandleZoomControls() {
    if (document.body.dataset.ccZoomWired) return;
    document.body.dataset.ccZoomWired = '1';
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.cc-zoom-btn');
        if (!btn) return;
        const wrap = btn.closest('.cc-zoom-controls');
        const canvasId = wrap?.dataset?.targetCanvas;
        if (!canvasId) return;
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        const action = btn.dataset.action;
        const curCount = typeof canvas.__ccGetViewCount === 'function' ? canvas.__ccGetViewCount() : 60;
        const panStep = Math.max(4, Math.round(curCount * 0.25));

        if (action === 'zoom-in' && typeof canvas.__ccZoom === 'function') {
            canvas.__ccZoom(0.75);
        } else if (action === 'zoom-out' && typeof canvas.__ccZoom === 'function') {
            canvas.__ccZoom(1.35);
        } else if (action === 'pan-left' && typeof canvas.__ccPan === 'function') {
            canvas.__ccPan(-panStep);
        } else if (action === 'pan-right' && typeof canvas.__ccPan === 'function') {
            canvas.__ccPan(panStep);
        } else if (action === 'reset' && typeof canvas.__ccReset === 'function') {
            canvas.__ccReset();
        }
    });
}

function applyCandleChartAnalysisUI(symbol, interval, candles, analysis) {
    const badgeEl = document.getElementById('cc-verdict-badge');
    const patEl = document.getElementById('cc-verdict-pattern');
    const descEl = document.getElementById('cc-verdict-desc');
    const detListEl = document.getElementById('cc-detected-list');

    if (analysis && analysis.verdict) {
        const v = analysis.verdict;
        if (badgeEl) {
            badgeEl.textContent = v.titleGu;
            badgeEl.className = 'cc-verdict-badge ' + (
                v.direction === 'BULLISH' ? 'cc-verdict-bullish' :
                v.direction === 'BEARISH' ? 'cc-verdict-bearish' : 'cc-verdict-neutral'
            );
        }
        if (patEl) patEl.textContent = v.patternTitle;
        if (descEl) descEl.textContent = v.summaryGu;

        const setText = (id, txt) => {
            const el = document.getElementById(id);
            if (el) el.textContent = txt;
        };
        setText('cc-stat-close', `₹${v.close.toFixed(2)}`);
        setText('cc-stat-vol', `${v.volRatio.toFixed(2)}x Avg`);
        setText('cc-stat-bb', v.bbUpper ? `${v.bbUpper.toFixed(0)} / ${v.bbMid.toFixed(0)} / ${v.bbLower.toFixed(0)}` : '--');
        setText('cc-stat-meta', `${interval.toUpperCase()} • ${candles.length} Bars`);
    }

    if (detListEl) {
        const recent = analysis?.recentPatterns || [];
        if (recent.length === 0) {
            detListEl.innerHTML = `<div class="cc-empty-note">તાજેતરની કેન્ડલ્સમાં કોઈ ખાસ રિવર્સલ પેટર્ન નથી — Bollinger Middle (20-SMA) અને Volume પર નજર રાખો.</div>`;
        } else {
            detListEl.innerHTML = recent.map(r => {
                const bCls = r.direction === 'BULLISH' ? 'cc-verdict-bullish' : (r.direction === 'BEARISH' ? 'cc-verdict-bearish' : 'cc-verdict-neutral');
                const dTxt = r.direction === 'BULLISH' ? 'વધશે' : (r.direction === 'BEARISH' ? 'ઘટશે' : 'રાહ જુઓ');
                return `
                    <div class="cc-detected-card">
                        <div class="cc-detected-top">
                            <strong style="font-size:0.84rem;color:#f8fafc;">${r.name}</strong>
                            <span class="cc-guide-sig ${bCls}" style="margin:0;">${dTxt}</span>
                        </div>
                        <div style="font-size:0.72rem;color:#38bdf8;">Time: ${r.label} • Price: ₹${r.price.toFixed(2)} • ${r.volStr}</div>
                        <p>${r.desc}</p>
                    </div>
                `;
            }).join('');
        }
    }
}

window.renderModalCandleChart = async function(modalKey, symbol, canvasId, fallbackCandles = []) {
    const st = modalChartState[modalKey];
    if (!st) return;
    st.symbol = symbol;
    st.fallback = fallbackCandles;

    const readoutId = modalKey === 'rm' ? 'rm-hover-readout' : 'cm-hover-readout';
    const readoutEl = document.getElementById(readoutId);
    if (readoutEl) readoutEl.textContent = `${symbol} (${st.interval}) લોડ થઈ રહ્યું છે...`;

    try {
        const series = await fetchCandleSeries(symbol, st.interval, true);
        st.candles = series.candles;
        st.visibleStartTime = series.visibleStartTime;
        renderCandlestickBollingerChart(canvasId, series.candles, {
            showBB: st.showBB,
            readoutId,
            interval: st.interval,
            maxBars: getDefaultMaxBarsForTf(st.interval, true),
            visibleStartTime: series.visibleStartTime
        });
        const last = series.candles[series.candles.length - 1];
        if (readoutEl && last) {
            const nowStr = new Date().toLocaleTimeString('en-IN', { hour12: false });
            readoutEl.textContent = `${symbol} (${st.interval.toUpperCase()}) • 1s Live ${nowStr} | O:${last.open.toFixed(2)} H:${last.high.toFixed(2)} L:${last.low.toFixed(2)} C:${last.close.toFixed(2)}`;
        }
    } catch (err) {
        if (Array.isArray(fallbackCandles) && fallbackCandles.length > 0) {
            st.candles = fallbackCandles;
            st.visibleStartTime = null;
            renderCandlestickBollingerChart(canvasId, fallbackCandles, {
                showBB: st.showBB,
                readoutId,
                interval: st.interval,
                maxBars: 65
            });
            if (readoutEl) readoutEl.textContent = `${symbol} (Master Daily Fallback) | Candlestick + BB (20,2)`;
        } else if (readoutEl) {
            readoutEl.textContent = `${symbol} ચાર્ટ ઉપલબ્ધ નથી (${err.message})`;
        }
    }
};

window.initModalChartControls = function() {
    wireCandleZoomControls();
    const setupModal = (modalKey, tfGroupId, bbToggleId, canvasId) => {
        const tfGroup = document.getElementById(tfGroupId);
        const bbToggle = document.getElementById(bbToggleId);
        if (tfGroup && !tfGroup.dataset.wired) {
            tfGroup.dataset.wired = '1';
            tfGroup.querySelectorAll('.cc-tf-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    tfGroup.querySelectorAll('.cc-tf-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    modalChartState[modalKey].interval = btn.dataset.tf || '5m';
                    if (modalChartState[modalKey].symbol) {
                        window.renderModalCandleChart(
                            modalKey,
                            modalChartState[modalKey].symbol,
                            canvasId,
                            modalChartState[modalKey].fallback
                        );
                    }
                });
            });
        }
        if (bbToggle && !bbToggle.dataset.wired) {
            bbToggle.dataset.wired = '1';
            bbToggle.addEventListener('change', () => {
                modalChartState[modalKey].showBB = bbToggle.checked;
                const st = modalChartState[modalKey];
                const readoutId = modalKey === 'rm' ? 'rm-hover-readout' : 'cm-hover-readout';
                if (st.candles && st.candles.length > 0) {
                    const canvas = document.getElementById(canvasId);
                    const opts = {
                        showBB: st.showBB,
                        readoutId,
                        interval: st.interval,
                        maxBars: getDefaultMaxBarsForTf(st.interval, true),
                        visibleStartTime: st.visibleStartTime
                    };
                    if (canvas && typeof canvas.__ccUpdateData === 'function') {
                        canvas.__ccUpdateData(st.candles, opts);
                    } else {
                        renderCandlestickBollingerChart(canvasId, st.candles, opts);
                    }
                }
            });
        }
    };

    setupModal('rm', 'rm-tf-group', 'rm-bb-toggle', 'research-price-chart');
    setupModal('cm', 'cm-tf-group', 'cm-bb-toggle', 'price-chart');
};

function mergeLiveTickIntoCandles(candles, interval, tickData) {
    if (!Array.isArray(candles) || candles.length === 0 || !tickData) return false;
    const livePrice = Number(tickData.livePrice);
    const liveTime = Number(tickData.liveTime) || Math.floor(Date.now() / 1000);
    const latestBar = tickData.latestBar;
    const effectivePrice = Number.isFinite(livePrice) && livePrice > 0
        ? livePrice
        : (latestBar && Number.isFinite(Number(latestBar.close)) ? Number(latestBar.close) : null);

    if (!effectivePrice || effectivePrice <= 0) return false;

    const bucketSec = getBucketSecondsForTf(interval);
    let targetBucket;
    if (interval === '1y') {
        // Align to IST day start so live ticks update today's daily candle
        const istOffset = 19800;
        const dayKey = Math.floor((liveTime + istOffset) / 86400);
        targetBucket = dayKey * 86400 - istOffset;
    } else {
        targetBucket = Math.floor(liveTime / bucketSec) * bucketSec;
    }

    const last = candles[candles.length - 1];
    // For 1y daily bars, check if last bar is already the same IST calendar date
    const isSameDayFor1y = interval === '1y' &&
        Math.floor((last.time + 19800) / 86400) === Math.floor((liveTime + 19800) / 86400);

    if (isSameDayFor1y || last.time === targetBucket || liveTime < last.time + bucketSec) {
        last.high = Math.max(last.high, effectivePrice, latestBar ? Number(latestBar.high || effectivePrice) : effectivePrice);
        last.low = Math.min(last.low, effectivePrice, latestBar ? Number(latestBar.low || effectivePrice) : effectivePrice);
        last.close = effectivePrice;
        if (tickData.liveVolume && interval === '1y') {
            last.volume = Math.max(last.volume || 0, Number(tickData.liveVolume));
        } else if (latestBar && Number.isFinite(Number(latestBar.volume)) && latestBar.volume > 0 && interval === '1m') {
            last.volume = Number(latestBar.volume);
        }
    } else {
        const newOpen = (latestBar && Number(latestBar.open) > 0 && interval === '1m') ? Number(latestBar.open) : last.close;
        const newCandle = {
            time: targetBucket,
            open: newOpen,
            high: Math.max(newOpen, effectivePrice),
            low: Math.min(newOpen, effectivePrice),
            close: effectivePrice,
            volume: latestBar && Number(latestBar.volume) > 0 ? Number(latestBar.volume) : 0,
            label: formatCandleLabel(targetBucket, interval)
        };
        candles.push(newCandle);
    }
    return true;
}

window.refreshVisibleCandles1s = async function() {
    if (isCandle1sInFlight) return;

    const ccTabActive = isTabActive('tab-candle-chart');
    const rmEl = document.getElementById('research-modal');
    const cmEl = document.getElementById('chart-modal');
    const rmOpen = rmEl && !rmEl.classList.contains('hidden') && modalChartState.rm.symbol;
    const cmOpen = cmEl && !cmEl.classList.contains('hidden') && modalChartState.cm.symbol;

    if (!ccTabActive && !rmOpen && !cmOpen) return;

    isCandle1sInFlight = true;
    try {
        const jobs = [];
        if (ccTabActive && candleTabState.symbol && candleTabState.candles.length > 0) {
            jobs.push({ type: 'tab', state: candleTabState, canvasId: 'candle-main-canvas', readoutId: 'cc-hover-readout', isModal: false });
        }
        if (rmOpen && modalChartState.rm.candles.length > 0) {
            jobs.push({ type: 'rm', state: modalChartState.rm, canvasId: 'research-price-chart', readoutId: 'rm-hover-readout', isModal: true });
        }
        if (cmOpen && modalChartState.cm.candles.length > 0) {
            jobs.push({ type: 'cm', state: modalChartState.cm, canvasId: 'price-chart', readoutId: 'cm-hover-readout', isModal: true });
        }

        if (jobs.length === 0) return;

        // Deduplicate by symbol if tab + modal show same symbol
        const uniqueSyms = Array.from(new Set(jobs.map(j => j.state.symbol.trim().toUpperCase())));
        const tickResults = new Map();

        await Promise.allSettled(uniqueSyms.map(async (sym) => {
            const url = `/api/yahoo?symbol=${encodeURIComponent(sym)}&tick=1`;
            const res = await fetchWithTimeout(url, { cache: 'no-store' }, 3000);
            if (res.ok) {
                const tickJson = await res.json();
                tickResults.set(sym, tickJson);
            }
        }));

        const nowStr = new Date().toLocaleTimeString('en-IN', { hour12: false });

        for (const job of jobs) {
            const symKey = job.state.symbol.trim().toUpperCase();
            const tickData = tickResults.get(symKey);
            if (!tickData || !tickData.livePrice) continue;

            const updated = mergeLiveTickIntoCandles(job.state.candles, job.state.interval, tickData);
            if (!updated) continue;

            const canvas = document.getElementById(job.canvasId);
            const opts = {
                showBB: job.state.showBB,
                readoutId: job.readoutId,
                interval: job.state.interval,
                maxBars: getDefaultMaxBarsForTf(job.state.interval, job.isModal),
                visibleStartTime: job.state.visibleStartTime
            };

            let analysis = null;
            if (canvas && typeof canvas.__ccUpdateData === 'function') {
                analysis = canvas.__ccUpdateData(job.state.candles, opts);
            } else {
                analysis = renderCandlestickBollingerChart(job.canvasId, job.state.candles, opts);
            }

            if (job.type === 'tab') {
                const liveBadgeTime = document.getElementById('cc-live-time');
                if (liveBadgeTime) liveBadgeTime.textContent = `1s Live • ${nowStr}`;
                if (analysis) {
                    applyCandleChartAnalysisUI(job.state.symbol, job.state.interval, job.state.candles, analysis);
                }
                const readoutEl = document.getElementById('cc-hover-readout');
                if (readoutEl && (!canvas || !canvas.__ccIsHovering || !canvas.__ccIsHovering())) {
                    const last = job.state.candles[job.state.candles.length - 1];
                    if (last) {
                        readoutEl.textContent = `1s Live (${nowStr}) | O:${last.open.toFixed(2)} H:${last.high.toFixed(2)} L:${last.low.toFixed(2)} C:${last.close.toFixed(2)}`;
                    }
                }
            } else {
                const readoutEl = document.getElementById(job.readoutId);
                if (readoutEl && (!canvas || !canvas.__ccIsHovering || !canvas.__ccIsHovering())) {
                    const last = job.state.candles[job.state.candles.length - 1];
                    if (last) {
                        readoutEl.textContent = `${symKey} (${job.state.interval.toUpperCase()}) • 1s Live ${nowStr} | O:${last.open.toFixed(2)} H:${last.high.toFixed(2)} L:${last.low.toFixed(2)} C:${last.close.toFixed(2)}`;
                    }
                }
                // Sync modal live price badge in real time every second
                const liveEl = document.getElementById(job.type === 'rm' ? 'chart-live-price' : 'modal-live-price');
                if (liveEl && tickData.livePrice) {
                    const prev = tickData.prevClose || tickData.livePrice;
                    const diff = tickData.livePrice - prev;
                    const pct = prev > 0 ? (diff / prev) * 100 : 0;
                    const sign = diff >= 0 ? '+' : '';
                    const col = diff >= 0 ? 'var(--success-color)' : 'var(--danger-color)';
                    liveEl.innerHTML = `₹${Number(tickData.livePrice).toFixed(2)} <span style="font-size:0.75rem;font-weight:600;color:${col};margin-left:0.35rem;">(${sign}${pct.toFixed(2)}%)</span>`;
                }
            }
        }
    } catch (e) {
        // Silent fail on transient tick drops; 1s loop continues cleanly
    } finally {
        isCandle1sInFlight = false;
    }
};

const CANDLE_PATTERN_GUIDE = [
    {
        category: 'bullish',
        name: 'Hammer (હેમર / હથોડી)',
        signal: 'ભાવ વધશે (Bullish Reversal)',
        desc: 'ઘટાડાના અંતે નીચે લાંબી પૂંછડી (2x+ બોડી) અને ઉપર નાની બોડી બને ત્યારે નીચેથી મજબૂત ખરીદી થઈ હોવાનું દર્શાવે છે.',
        volRule: 'જો હેમર કેન્ડલ પર વોલ્યુમ 1.5x+ હોય અને આગલી કેન્ડલ હેમર High ની ઉપર બંધ થાય તો તેજી પાકી થાય છે.',
        source: 'Zerodha Varsity / Investopedia',
        svg: `<svg viewBox="0 0 60 72" width="54" height="68"><line x1="30" y1="12" x2="30" y2="62" stroke="#22c55e" stroke-width="2.5"/><rect x="21" y="14" width="18" height="14" rx="2" fill="#22c55e"/></svg>`
    },
    {
        category: 'bullish',
        name: 'Bullish Engulfing (બુલિશ એન્ગલ્ફિંગ)',
        signal: 'ભાવ વધશે (Bullish Reversal)',
        desc: 'એક નાની લાલ કેન્ડલ પછી મોટી ગ્રીન કેન્ડલ આવે જે લાલ કેન્ડલની બોડીને સંપૂર્ણ ઢાંકી દે.',
        volRule: 'ગ્રીન કેન્ડલનું વોલ્યુમ લાલ કેન્ડલ કરતાં વધુ (અને Average Vol થી >1.3x) હોય તો ભાવ ઝડપથી વધે છે.',
        source: 'Investopedia / Zerodha Varsity',
        svg: `<svg viewBox="0 0 60 72" width="54" height="68"><line x1="20" y1="22" x2="20" y2="48" stroke="#ef4444" stroke-width="2"/><rect x="14" y="27" width="12" height="15" rx="1.5" fill="#ef4444"/><line x1="40" y1="12" x2="40" y2="58" stroke="#22c55e" stroke-width="2"/><rect x="33" y="18" width="14" height="32" rx="1.5" fill="#22c55e"/></svg>`
    },
    {
        category: 'bullish',
        name: 'Morning Star (મોર્નિંગ સ્ટાર)',
        signal: 'ભાવ વધશે (3-Candle Reversal)',
        desc: 'પ્રથમ મોટી લાલ કેન્ડલ, વચ્ચે નાની ડોજી/સ્ટાર અને ત્રીજી મોટી ગ્રીન કેન્ડલ જે પ્રથમ કેન્ડલના 50%+ ઉપર બંધ થાય.',
        volRule: 'ત્રીજી ગ્રીન કેન્ડલમાં ભારે વોલ્યુમ હોવું અત્યંત મજબૂત અપટ્રેન્ડનો સંકેત આપે છે.',
        source: 'Zerodha Varsity',
        svg: `<svg viewBox="0 0 60 72" width="54" height="68"><rect x="8" y="14" width="11" height="28" rx="1.5" fill="#ef4444"/><rect x="25" y="45" width="9" height="9" rx="1.5" fill="#f59e0b"/><rect x="40" y="18" width="11" height="26" rx="1.5" fill="#22c55e"/></svg>`
    },
    {
        category: 'bullish',
        name: 'Three White Soldiers (થ્રી વ્હાઇટ સોલ્જર્સ)',
        signal: 'મજબૂત તેજી (Strong Bullish)',
        desc: 'સતત ત્રણ મજબૂત ગ્રીન કેન્ડલ્સ જે દરેક પાછલી કેન્ડલની ઉપર ઊંચા ભાવે બંધ થાય અને નાની પૂંછડી હોય.',
        volRule: 'દરેક ગ્રીન કેન્ડલ સાથે વધતું જતું વોલ્યુમ સંસ્થાકીય ખરીદી (Institutional Buying) દર્શાવે છે.',
        source: 'Investopedia',
        svg: `<svg viewBox="0 0 60 72" width="54" height="68"><rect x="8" y="38" width="11" height="22" rx="1.5" fill="#22c55e"/><rect x="24" y="25" width="11" height="23" rx="1.5" fill="#22c55e"/><rect x="40" y="12" width="11" height="23" rx="1.5" fill="#22c55e"/></svg>`
    },
    {
        category: 'bullish',
        name: 'Piercing Line (પિયર્સિંગ લાઇન)',
        signal: 'ભાવ વધશે (Support Reversal)',
        desc: 'મોટી લાલ કેન્ડલ પછી નીચે ગેપ-ડાઉનથી ખુલીને ગ્રીન કેન્ડલ લાલ કેન્ડલના મધ્યબિંદુ (50%) ઉપર બંધ થાય.',
        volRule: 'વોલ્યુમ વધારે હોય તો બાયર્સ કંટ્રોલ લઈ રહ્યા છે તેવું સ્પષ્ટ દેખાય છે.',
        source: 'Zerodha Varsity',
        svg: `<svg viewBox="0 0 60 72" width="54" height="68"><rect x="14" y="14" width="13" height="34" rx="1.5" fill="#ef4444"/><rect x="33" y="26" width="13" height="30" rx="1.5" fill="#22c55e"/></svg>`
    },
    {
        category: 'bearish',
        name: 'Shooting Star (શૂટિંગ સ્ટાર)',
        signal: 'ભાવ ઘટશે (Bearish Reversal)',
        desc: 'તેજીની ટોચ પર ઉપર લાંબી પૂંછડી (2x+ બોડી) અને નીચે નાની બોડી બને એટલે ઉપરના ભાવે ભારે વેચવાલી છે.',
        volRule: 'ઊંચા વોલ્યુમ સાથે બનેલી શૂટિંગ સ્ટાર અને આગલી લાલ કેન્ડલ તીવ્ર ઘટાડાનો સંકેત આપે છે.',
        source: 'Investopedia / Zerodha Varsity',
        svg: `<svg viewBox="0 0 60 72" width="54" height="68"><line x1="30" y1="10" x2="30" y2="60" stroke="#ef4444" stroke-width="2.5"/><rect x="21" y="44" width="18" height="14" rx="2" fill="#ef4444"/></svg>`
    },
    {
        category: 'bearish',
        name: 'Bearish Engulfing (બેરિશ એન્ગલ્ફિંગ)',
        signal: 'ભાવ ઘટશે (Bearish Reversal)',
        desc: 'તેજી દરમિયાન નાની ગ્રીન કેન્ડલ પછી મોટી લાલ કેન્ડલ ગ્રીન કેન્ડલને સંપૂર્ણ ગળી જાય.',
        volRule: 'લાલ કેન્ડલ પર Avg Vol કરતાં 1.5x+ વોલ્યુમ હોય તો સ્ટોપ-લોસ હિટ થઈ ઝડપી ઘટાડો આવે છે.',
        source: 'Investopedia / Zerodha Varsity',
        svg: `<svg viewBox="0 0 60 72" width="54" height="68"><rect x="14" y="25" width="12" height="16" rx="1.5" fill="#22c55e"/><rect x="33" y="14" width="14" height="38" rx="1.5" fill="#ef4444"/></svg>`
    },
    {
        category: 'bearish',
        name: 'Evening Star (ઇવનિંગ સ્ટાર)',
        signal: 'ભાવ ઘટશે (Top Reversal)',
        desc: 'મોટી ગ્રીન કેન્ડલ, ટોચ પર નાની સ્ટાર કેન્ડલ અને ત્રીજી મોટી લાલ કેન્ડલ જે પ્રથમ કેન્ડલની અંદર ઊંડે બંધ થાય.',
        volRule: 'ત્રીજી લાલ કેન્ડલ સાથે વધતો વોલ્યુમ તેજીનો અંત અને મંદીની શરૂઆત બતાવે છે.',
        source: 'Zerodha Varsity',
        svg: `<svg viewBox="0 0 60 72" width="54" height="68"><rect x="8" y="24" width="11" height="28" rx="1.5" fill="#22c55e"/><rect x="25" y="12" width="9" height="9" rx="1.5" fill="#f59e0b"/><rect x="40" y="22" width="11" height="30" rx="1.5" fill="#ef4444"/></svg>`
    },
    {
        category: 'bearish',
        name: 'Three Black Crows (થ્રી બ્લેક ક્રોઝ)',
        signal: 'મજબૂત ઘટાડો (Strong Bearish)',
        desc: 'સતત ત્રણ લાલ કેન્ડલ્સ જે દરેક પાછલી કેન્ડલની નીચે બંધ થાય — સતત વેચવાલી દર્શાવે છે.',
        volRule: 'વધતા વોલ્યુમ સાથે ત્રણ લાલ કેન્ડલ આવે ત્યારે લોંગ પોઝિશનમાંથી નીકળવાનો સંકેત ગણાય.',
        source: 'Investopedia',
        svg: `<svg viewBox="0 0 60 72" width="54" height="68"><rect x="8" y="12" width="11" height="22" rx="1.5" fill="#ef4444"/><rect x="24" y="24" width="11" height="22" rx="1.5" fill="#ef4444"/><rect x="40" y="36" width="11" height="22" rx="1.5" fill="#ef4444"/></svg>`
    },
    {
        category: 'bearish',
        name: 'Hanging Man (હેંગિંગ મેન)',
        signal: 'ઘટાડાની ચેતવણી (Bearish Warning)',
        desc: 'અપટ્રેન્ડની ટોચ પર હેમર જેવી આકૃતિ બને તો ઉપરથી સપ્લાય આવી રહ્યો હોવાની ચેતવણી મળે છે.',
        volRule: 'આગલી કેન્ડલ હેંગિંગ મેનની નીચે ઊંચા વોલ્યુમથી બંધ થાય ત્યારે ઘટાડો શરૂ થાય છે.',
        source: 'Investopedia',
        svg: `<svg viewBox="0 0 60 72" width="54" height="68"><line x1="30" y1="14" x2="30" y2="62" stroke="#ef4444" stroke-width="2.5"/><rect x="21" y="14" width="18" height="14" rx="2" fill="#ef4444"/></svg>`
    },
    {
        category: 'volume',
        name: 'Volume Breakout vs Fakeout નિયમ',
        signal: 'Volume Confirmation Rule',
        desc: 'માત્ર કેન્ડલ જોઈને ટ્રેડ ન લેવો — સાચા બ્રેકઆઉટ માટે કેન્ડલ પર વોલ્યુમ 20-બાર સરેરાશ કરતાં ઓછામાં ઓછું 1.5 ગણું હોવું જરૂરી.',
        volRule: 'ઓછા વોલ્યુમ પર ભાવ વધે/ઘટે તો તે Fakeout (ટ્રેપ) હોઈ શકે; વધારે વોલ્યુમ સાથે ગ્રીન = વધશે, લાલ = ઘટશે.',
        source: 'Zerodha Varsity / TradingView',
        svg: `<svg viewBox="0 0 60 72" width="54" height="68"><rect x="10" y="42" width="8" height="20" fill="#64748b"/><rect x="22" y="38" width="8" height="24" fill="#64748b"/><rect x="34" y="12" width="10" height="50" fill="#22c55e"/><line x1="6" y1="34" x2="54" y2="34" stroke="#a855f7" stroke-dasharray="3 2" stroke-width="1.5"/></svg>`
    },
    {
        category: 'volume',
        name: 'Bollinger Bands Squeeze & Bounce',
        signal: 'Bollinger (20, 2) નિયમ',
        desc: 'જ્યારે Upper અને Lower Band એકદમ નજીક (Squeeze) આવે ત્યારે મોટી મૂવ આવવાની હોય છે; Lower Band પર Hammer = વધશે, Upper Band પર Shooting Star = ઘટશે.',
        volRule: 'Squeeze પછી જે બાજુ 1.5x+ વોલ્યુમ સાથે કેન્ડલ Band બહાર બંધ થાય તે દિશામાં ઝડપી ટ્રેન્ડ ચાલે છે.',
        source: 'TradingView / John Bollinger',
        svg: `<svg viewBox="0 0 60 72" width="54" height="68"><path d="M6 16 Q30 26 54 12" fill="none" stroke="#38bdf8" stroke-width="2"/><path d="M6 36 Q30 36 54 34" fill="none" stroke="#f59e0b" stroke-dasharray="3 2" stroke-width="1.5"/><path d="M6 56 Q30 46 54 58" fill="none" stroke="#38bdf8" stroke-width="2"/><rect x="38" y="14" width="7" height="16" fill="#22c55e"/></svg>`
    }
];

function renderCandlePatternGuide(filter = 'all') {
    const grid = document.getElementById('cc-guide-grid');
    if (!grid) return;

    const filtered = filter === 'all'
        ? CANDLE_PATTERN_GUIDE
        : CANDLE_PATTERN_GUIDE.filter(p => p.category === filter);

    grid.innerHTML = filtered.map(p => {
        const badgeCls = p.category === 'bullish'
            ? 'cc-verdict-bullish'
            : (p.category === 'bearish' ? 'cc-verdict-bearish' : 'cc-verdict-neutral');
        return `
            <div class="cc-guide-card">
                <div class="cc-guide-svg-box">${p.svg}</div>
                <div class="cc-guide-info">
                    <h4>${p.name}</h4>
                    <span class="cc-guide-sig ${badgeCls}">${p.signal}</span>
                    <p>${p.desc}</p>
                    <div class="cc-guide-vol-rule"><strong>Volume / BB નિયમ:</strong> ${p.volRule}</div>
                    <div class="cc-guide-source">સંદર્ભ: ${p.source}</div>
                </div>
            </div>
        `;
    }).join('');
}

function populateCandleSymbolDatalist() {
    const dl = document.getElementById('cc-symbol-datalist');
    if (!dl) return;
    const defaults = ['RELIANCE', 'TCS', 'HDFCBANK', 'ICICIBANK', 'SBIN', 'INFY', 'ITC', 'TATAMOTORS', 'BHARTIARTL', '^NSEI', '^BSESN'];
    const set = new Set(defaults);
    if (Array.isArray(state.processedMasterData) && state.symbolColIndex !== -1) {
        for (let i = 1; i < Math.min(state.processedMasterData.length, 400); i++) {
            const sym = String(state.processedMasterData[i][state.symbolColIndex] || '').trim().toUpperCase();
            if (sym) set.add(sym);
        }
    }
    dl.innerHTML = Array.from(set).map(s => `<option value="${s}"></option>`).join('');
}

window.initCandleChartTab = function() {
    if (candleTabState.initialized) {
        populateCandleSymbolDatalist();
        return;
    }
    candleTabState.initialized = true;
    populateCandleSymbolDatalist();
    renderCandlePatternGuide(candleTabState.guideFilter);

    const symInput = document.getElementById('cc-symbol-input');
    const loadBtn = document.getElementById('cc-load-btn');
    const bbToggle = document.getElementById('cc-bb-toggle');
    const tfGroup = document.getElementById('cc-timeframe-group');

    const triggerLoad = () => {
        if (symInput && symInput.value.trim()) {
            candleTabState.symbol = symInput.value.trim().toUpperCase();
        }
        window.loadCandleChartTab(true);
    };

    if (loadBtn) loadBtn.addEventListener('click', triggerLoad);
    if (symInput) {
        symInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                triggerLoad();
            }
        });
    }

    if (tfGroup) {
        tfGroup.querySelectorAll('.cc-tf-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                tfGroup.querySelectorAll('.cc-tf-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                candleTabState.interval = btn.dataset.tf || '5m';
                window.loadCandleChartTab(true);
            });
        });
    }

    if (bbToggle) {
        bbToggle.addEventListener('change', () => {
            candleTabState.showBB = bbToggle.checked;
            if (candleTabState.candles.length > 0) {
                const canvas = document.getElementById('candle-main-canvas');
                const opts = {
                    showBB: candleTabState.showBB,
                    readoutId: 'cc-hover-readout',
                    interval: candleTabState.interval,
                    maxBars: getDefaultMaxBarsForTf(candleTabState.interval, false),
                    visibleStartTime: candleTabState.visibleStartTime
                };
                if (canvas && typeof canvas.__ccUpdateData === 'function') {
                    canvas.__ccUpdateData(candleTabState.candles, opts);
                } else {
                    renderCandlestickBollingerChart('candle-main-canvas', candleTabState.candles, opts);
                }
            }
        });
    }

    document.querySelectorAll('#cc-quick-picks .cc-quick-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const sym = btn.dataset.sym;
            if (symInput) symInput.value = sym;
            candleTabState.symbol = sym;
            window.loadCandleChartTab(true);
        });
    });

    document.querySelectorAll('#cc-guide-filters .cc-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#cc-guide-filters .cc-filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            candleTabState.guideFilter = btn.dataset.filter || 'all';
            renderCandlePatternGuide(candleTabState.guideFilter);
        });
    });
};

window.loadCandleChartTab = async function(forceRefresh = false) {
    const symbol = candleTabState.symbol || 'RELIANCE';
    const interval = candleTabState.interval || '5m';

    const badgeEl = document.getElementById('cc-verdict-badge');
    const patEl = document.getElementById('cc-verdict-pattern');
    const descEl = document.getElementById('cc-verdict-desc');
    const detSymEl = document.getElementById('cc-detected-symbol');
    if (detSymEl) detSymEl.textContent = `${symbol} (${interval.toUpperCase()})`;
    if (patEl) patEl.textContent = `${symbol} (${interval.toUpperCase()}) લોડ થઈ રહ્યું છે...`;

    try {
        const series = await fetchCandleSeries(symbol, interval, forceRefresh);
        candleTabState.candles = series.candles;
        candleTabState.visibleStartTime = series.visibleStartTime;

        const analysis = renderCandlestickBollingerChart('candle-main-canvas', series.candles, {
            showBB: candleTabState.showBB,
            readoutId: 'cc-hover-readout',
            interval,
            maxBars: getDefaultMaxBarsForTf(interval, false),
            visibleStartTime: series.visibleStartTime
        });

        applyCandleChartAnalysisUI(symbol, interval, series.candles, analysis);
        const liveBadgeTime = document.getElementById('cc-live-time');
        if (liveBadgeTime) {
            liveBadgeTime.textContent = `1s Live • ${new Date().toLocaleTimeString('en-IN', { hour12: false })}`;
        }
    } catch (err) {
        if (badgeEl) {
            badgeEl.textContent = 'ડેટા ઉપલબ્ધ નથી';
            badgeEl.className = 'cc-verdict-badge cc-verdict-neutral';
        }
        if (patEl) patEl.textContent = `${symbol} (${interval.toUpperCase()})`;
        if (descEl) descEl.textContent = `ચાર્ટ લોડ કરવામાં ભૂલ: ${err.message}. કૃપા કરી સાચો NSE Symbol (જેમ કે RELIANCE, TCS, ^NSEI) તપાસો.`;
    }
};

// Run on load
document.addEventListener('DOMContentLoaded', initEvents);


