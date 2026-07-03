// Global Error Logger for UI Debugging
window.onerror = function(message, source, lineno, colno, error) {
    console.error(error);
    const logConsole = document.getElementById('log-console');
    const processLogContainer = document.getElementById('process-log-container');
    if (processLogContainer) processLogContainer.classList.remove('hidden');
    if (logConsole) {
        const entry = document.createElement('div');
        entry.className = 'log-entry log-error';
        entry.textContent = `[Error] ${message} at line ${lineno}:${colno}`;
        logConsole.appendChild(entry);
    }
    alert(`સિસ્ટમમાં ભૂલ આવી છે: ${message} (લાઈન: ${lineno})`);
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
    
    // Gainers Window Active Selection (5 or 30)
    gainersWindow: 5,
    portfolioLivePrices: new Map(),
    gainersLivePrices: new Map(),
    researchChartInstance: null
};

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
function initEvents() {
    // Login Screen Check
    const sessionLoggedIn = sessionStorage.getItem('isLoggedIn');
    const loginOverlay = document.getElementById('login-screen');
    const mainApp = document.getElementById('main-app');
    
    if (sessionLoggedIn === 'true') {
        loginOverlay.classList.add('hidden');
        mainApp.classList.remove('hidden');
    } else {
        const loginForm = document.getElementById('login-form');
        const loginError = document.getElementById('login-error');
        
        loginForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const usernameInput = document.getElementById('username').value.trim();
            const passwordInput = document.getElementById('password').value.trim();
            
            if (usernameInput === 'RAHUL' && passwordInput === '22780') {
                sessionStorage.setItem('isLoggedIn', 'true');
                loginOverlay.classList.add('hidden');
                mainApp.classList.remove('hidden');
                showNotification('Login successful!', 'success');
            } else {
                loginError.classList.remove('hidden');
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

    // Filters
    searchCompany.addEventListener('input', applyFilters);
    priceMin.addEventListener('input', applyFilters);
    priceMax.addEventListener('input', applyFilters);
    diffMin.addEventListener('input', applyFilters);
    diffMax.addEventListener('input', applyFilters);
    resetFiltersBtn.addEventListener('click', resetFilters);

    // Load Master File from Cloud (falls back to local storage cache)
    loadMasterOnStartup();

    // Fetch live market indices (Sensex & Nifty) immediately and keep updated
    fetchMarketIndices();
    setInterval(fetchMarketIndices, 30000);

    // Check if XLSX library loaded
    if (typeof XLSX === 'undefined') {
        processLogContainer.classList.remove('hidden');
        log('Error: Excel reading library (SheetJS) not loaded. Please check your internet connection.', 'error');
        alert('Error: Excel reading library (SheetJS) not loaded. Check your internet connection.');
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
    const researchTabContent      = document.getElementById('research-tab-content');
    const portfolioTabContent     = document.getElementById('portfolio-tab-content');
    const resultsTabContent       = document.getElementById('results-tab-content');
    const watchlistTabContent     = document.getElementById('watchlist-tab-content');
    const morningPicksTabContent  = document.getElementById('morning-picks-tab-content');
    const adviceTabContent        = document.getElementById('investor-advice-tab-content');

    const hideAllTabs = () => {
        [researchTabContent, portfolioTabContent, resultsTabContent, watchlistTabContent, morningPicksTabContent, adviceTabContent]
            .forEach(el => el && el.classList.add('hidden'));
        [tabResearch, tabPortfolio, tabResults, tabWatchlist, tabMorning, tabAdvice]
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
            renderResultsAndDividendsTable();
        });
    }


    // Portfolio Form Initializations
    setupPortfolioFormCalculations();
    setupPortfolioFormSubmit();

    // Gainers range toggles
    const toggle3 = document.getElementById('gainer-toggle-3');
    const toggle5 = document.getElementById('gainer-toggle-5');
    const toggle30 = document.getElementById('gainer-toggle-30');
    
    if (toggle3 && toggle5 && toggle30) {
        toggle3.addEventListener('click', () => {
            toggle3.classList.add('active');
            toggle5.classList.remove('active');
            toggle30.classList.remove('active');
            state.gainersWindow = 3;
            renderGainersAnalysis();
        });

        toggle5.addEventListener('click', () => {
            toggle5.classList.add('active');
            toggle3.classList.remove('active');
            toggle30.classList.remove('active');
            state.gainersWindow = 5;
            renderGainersAnalysis();
        });

        toggle30.addEventListener('click', () => {
            toggle30.classList.add('active');
            toggle3.classList.remove('active');
            toggle5.classList.remove('active');
            state.gainersWindow = 30;
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
    // Register Service Worker
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./sw.js')
                .then(reg => console.log('Service Worker Registered Successfully!', reg.scope))
                .catch(err => console.error('Service Worker Registration Failed:', err));
        });
    }

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
    
    headers.forEach((h, idx) => {
        const hStr = String(h || '').toUpperCase().trim();
        if (hStr === 'SYMBOL' || hStr === 'COMPANY_SYMBOL' || hStr === 'COMPANY') state.symbolColIndex = idx;
        const seriesCandidates = ['SERIES', 'SER', 'GROUP', 'TYPE', 'EQ_SERIES', 'SERIES_NAME', 'SCTYSRS'];
        if (seriesCandidates.includes(hStr) || hStr.includes('SERIES')) state.seriesColIndex = idx;
        if (hStr === 'HIGH') state.highColIndex = idx;
        if (hStr === 'DIFF') state.diffColIndex = idx;
        if (hStr === 'ISIN') state.isinColIndex = idx;
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
            totalRows: totalRows
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
        showNotification(`Cloud sync failed: ${err.message}`, 'error');
        alert(`Cloud sync failed: ${err.message}\nCheck Firebase Console/Rules!`);
    }
}

// Load Master Excel Data from Firestore by assembling chunks
async function loadMasterFromCloud() {
    if (!db) {
        console.error("Firestore not initialized");
        updateCloudSyncUI('error', 'Firebase Offline');
        showNotification('Firebase SDK failed to initialize. Check connection or blockers!', 'error');
        return false;
    }

    updateCloudSyncUI('connecting', 'Loading from Cloud...');
    log('Checking Firebase Cloud for saved Master data...', 'info');

    try {
        const metaDoc = await db.collection('metadata').doc('master').get();
        if (!metaDoc.exists) {
            updateCloudSyncUI('error', 'No Cloud Data');
            log('No Master data found in Cloud. Please upload a Master Excel file.', 'warning');
            return false;
        }

        const metaData = metaDoc.data();
        const chunkCount = metaData.chunkCount;
        const filename = metaData.filename || 'Master_Cloud.xlsx';
        const filesize = metaData.filesize || 'Cloud Stored';

        log(`Found cloud master database: ${filename} (Total Chunks: ${chunkCount})`, 'info');

        let assembledRows = [];
        for (let i = 0; i < chunkCount; i++) {
            const chunkDoc = await db.collection('chunks').doc(`chunk_${i}`).get();
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
            log(`- Loaded chunk ${i + 1} of ${chunkCount} (${chunkRows.length} rows)`, 'info');
        }

        if (assembledRows.length === 0) {
            throw new Error('Loaded empty dataset from cloud');
        }

        // Update application state
        state.masterData = filterMasterForEQOnly(assembledRows);
        state.masterSheetName = 'Sheet1';
        
        // Save to local storage as backup/cache
        saveMasterToLocalStorage();

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
        
        renderPreview(state.masterData, masterTable, masterRowCount, masterPreviewContainer);
        checkReadyState();
        autoRenderIfProcessed();
        populateCompanyDatalist();
        
        updateCloudSyncUI('success', 'Cloud Synced');
        return true;
    } catch (err) {
        console.error('Error loading from Firestore:', err);
        updateCloudSyncUI('error', 'Load Failed');
        const logContainer = document.getElementById('process-log-container');
        if (logContainer) logContainer.classList.remove('hidden');
        log(`Cloud load failed: ${err.message}`, 'error');
        showNotification(`Cloud load failed: ${err.message}`, 'error');
        return false;
    }
}

// Load master data on startup (cloud first, local storage cache second)
async function loadMasterOnStartup() {
    updateCloudSyncUI('connecting', 'Connecting...');
    const loadedFromCloud = await loadMasterFromCloud();
    if (!loadedFromCloud) {
        log('Trying to load from local storage cache...', 'info');
        loadMasterFromLocalStorage();
    }
}

// Delete Master Excel Data from Firestore
async function deleteMasterFromCloud() {
    if (!db) return;
    try {
        updateCloudSyncUI('connecting', 'Deleting Cloud Data...');
        await db.collection('metadata').doc('master').delete();
        
        // Delete up to 50 chunk documents
        for (let i = 0; i < 50; i++) {
            await db.collection('chunks').doc(`chunk_${i}`).delete();
        }
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
            
            // Build processed workbook for download
            const wb = state.masterWorkbook || XLSX.utils.book_new();
            const wsName = state.masterSheetName || 'Sheet1';
            const newSheet = XLSX.utils.aoa_to_sheet(state.masterData);
            if (!state.masterWorkbook) {
                XLSX.utils.book_append_sheet(wb, newSheet, wsName);
                state.masterWorkbook = wb;
            } else {
                wb.Sheets[wsName] = newSheet;
            }
            state.processedWorkbook = wb;

            // Render components
            renderFilteredResults();
            renderGainersAnalysis();
            renderMorningPicks();
            renderInvestorAdvice();
            
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

// Fetch live prices for active portfolio holdings and re-render
async function fetchPortfolioLivePrices() {
    if (portfolioItems.length === 0) return;
    
    // Find unique active symbols
    const activeSymbols = [...new Set(portfolioItems.filter(item => !(item.sellRate && item.sellDate)).map(item => item.companySymbol))];
    if (activeSymbols.length === 0) return;
    
    console.log("Fetching live prices for active portfolio holdings:", activeSymbols);
    
    // Process each symbol concurrently and update the UI instantly as each successful fetch completes
    activeSymbols.forEach(async (symbol) => {
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
                // Re-render the portfolio table immediately for responsive user feedback
                renderPortfolioTable();
            }
        } catch (e) {
            console.warn(`Failed to fetch live price for active portfolio item ${symbol}:`, e.message);
        }
    });
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

    let html = '';
    let totalInvested = 0;
    let totalProfit = 0;
    let totalSellAmount = 0;
    let totalQty = 0;
    let activeCount = 0;
    let soldCount = 0;
    let totalDaysSold = 0;

    portfolioItems.forEach(item => {
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
                livePriceStr = '<span style="font-size:0.75rem;color:var(--text-secondary);">Loading...</span>';
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
        
        const sortedSymbols = Array.from(symbols).sort();
        sortedSymbols.forEach(sym => {
            const option = document.createElement('option');
            option.value = sym;
            datalist.appendChild(option);
        });
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

// Extract and normalize Date from CSV / Filename
function extractDateFromBhavcopy(csvData, csvKeys, filename) {
    const dateKeys = ['TIMESTAMP', 'DATE', 'TRADING_DATE', 'RECORD_DATE', 'TRADEDATE'];
    for (let dk of dateKeys) {
        const found = csvKeys.find(k => k.toUpperCase().trim() === dk);
        if (found && csvData.length > 0) {
            const val = String(csvData[0][found]).trim();
            if (val) {
                return normalizeDateString(val);
            }
        }
    }
    
    const matchNSE = filename.match(/cm(\d{2})([A-Z]{3})(\d{4})/i);
    if (matchNSE) {
        const day = matchNSE[1];
        const monthStr = matchNSE[2].toUpperCase();
        const year = matchNSE[3];
        const months = {
            JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
            JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12'
        };
        const month = months[monthStr] || '01';
        return `${day}-${month}-${year}`;
    }
    
    const matchBSE = filename.match(/EQ(\d{2})(\d{2})(\d{2})/i);
    if (matchBSE) {
        const day = matchBSE[1];
        const month = matchBSE[2];
        const year = '20' + matchBSE[3];
        return `${day}-${month}-${year}`;
    }
    
    const d = new Date();
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
}

// Normalize various date formats to DD-MM-YYYY
function normalizeDateString(str) {
    const parts = str.split('-');
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
    
    const matchISO = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (matchISO) {
        return `${matchISO[3]}-${matchISO[2]}-${matchISO[1]}`;
    }
    
    const partsSlash = str.split('/');
    if (partsSlash.length === 3) {
        let day = partsSlash[0].padStart(2, '0');
        let month = partsSlash[1].padStart(2, '0');
        let year = partsSlash[2];
        if (year.length === 2) year = '20' + year;
        return `${day}-${month}-${year}`;
    }
    
    return str;
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
        
        // Deep copy master data at the beginning of the batch
        let updatedMaster = JSON.parse(JSON.stringify(master));
        let lastInsertIndex = -1;
        let lastDiffColIndex = -1;
        let lastHighColIndex = -1;
        let lastSymbolColIndex = -1;
        let lastSeriesColIndex = -1;
        
        for (let fIdx = 0; fIdx < filesToProcess.length; fIdx++) {
            const file = filesToProcess[fIdx];
            log(`[${fIdx + 1}/${filesToProcess.length}] Processing file: ${file.name}...`, 'info');
            
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
            
            // Extract column name as the CSV filename without extension
            const dateStr = file.name.replace(/\.[^/.]+$/, "");
            
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
                if (existingDateColIndex >= seriesInsertIdx) { existingDateColIndex++; }
                if (insertIndex >= seriesInsertIdx) { insertIndex++; }
                
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
        
        // Render results & analysis
        renderFilteredResults();
        renderGainersAnalysis();
        renderMorningPicks();
        renderInvestorAdvice();
        
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
        
        // Collect prices from last windowDays date columns going forward
        const prices = [];
        const limit = Math.min(row.length, insertIdx + windowDays);
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
        if (performerHeader) performerHeader.textContent = `${windowDays}-Day Leader`;
        
        const oldPriceLabel = document.getElementById('performer-old-price').parentNode;
        if (oldPriceLabel) {
            oldPriceLabel.childNodes[0].textContent = `Old Price (${windowDays}d): `;
        }
        
        topPerformerCard.classList.remove('hidden');
    } else {
        topPerformerCard.classList.add('hidden');
    }
    
    // Update card title and descriptions
    const cardTitle = document.getElementById('gainer-card-title');
    const sliceLimit = windowDays === 30 ? 50 : 10;
    if (cardTitle) cardTitle.textContent = `Top ${sliceLimit} Gainers (${windowDays} Days)`;
    
    const cardDesc = document.getElementById('gainer-card-desc');
    if (cardDesc) cardDesc.textContent = `Companies showing the highest net positive close-to-close change over the last ${windowDays} active trading days.`;
    
    const tableHeaderOld = document.getElementById('gainer-table-old-price-header');
    if (tableHeaderOld) tableHeaderOld.textContent = `Price (${windowDays}d)`;
    
    // Select top 10 or 50 based on window
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
            const livePriceVal = state.gainersLivePrices.get(item.symbol);
            const livePriceHtml = livePriceVal 
                ? `₹${livePriceVal.toFixed(2)} <span class="live-pulse" style="width:6px;height:6px;box-shadow:0 0 0 0 rgba(16,185,129,0.7);animation:pulse 1.5s infinite;margin-left:0.2rem;display:inline-block;border-radius:50%;background:#10b981;"></span>`
                : `₹${item.today.toFixed(2)} <span style="font-size:0.7rem;color:var(--text-secondary);">(EOD)</span>`;

            // Check if already in watchlist
            const inWatchlist = watchlistItems.some(w => w.symbol === item.symbol);
            const starBtn = inWatchlist
                ? `<button onclick="removeFromWatchlist('${item.symbol}'); event.stopPropagation();" title="Watchlistä¸­થી કાઢો" style="background:rgba(245,158,11,0.18); border:1px solid #f59e0b; color:#f59e0b; border-radius:5px; padding:0.25rem 0.55rem; cursor:pointer; font-size:0.85rem;"><i class='fa-solid fa-star'></i></button>`
                : `<button onclick="addToWatchlist('${item.symbol}', ${item.today}); event.stopPropagation();" title="Watchlistä¸­ઉમેરો" style="background:none; border:1px solid rgba(255,255,255,0.15); color:var(--text-secondary); border-radius:5px; padding:0.25rem 0.55rem; cursor:pointer; font-size:0.85rem;"><i class='fa-regular fa-star'></i></button>`;

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
    
    // Fetch live prices for top gainers asynchronously in the background
    if (topGainers.length > 0) {
        fetchGainersLivePrices(topGainers.map(t => t.symbol));
    }
}

// Render filtered results on screen (ALL ROWS)
function renderFilteredResults() {
    const data = state.processedMasterData;
    if (!data || data.length === 0) return;
    
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
    
    let filteredCount = 0;
    let bodyHtml = '';
    
    // Render all rows (no limit, so they can scroll all)
    for (let i = 1; i < data.length; i++) {
        const row = data[i];
        const symbol = String(row[symbolIndex] || '').trim().toUpperCase();
        
        if (!symbol) continue;
        
        // Search by symbol
        if (searchVal && !symbol.includes(searchVal)) {
            continue;
        }
        
        // Latest day price filter
        const latestPrice = parseFloat(row[latestIndex]);
        if (!isNaN(minP) && (isNaN(latestPrice) || latestPrice < minP)) continue;
        if (!isNaN(maxP) && (isNaN(latestPrice) || latestPrice > maxP)) continue;
        
        // Diff filter
        if (diffIndex !== -1) {
            const diffVal = parseFloat(row[diffIndex]);
            if (!isNaN(minD) && (isNaN(diffVal) || diffVal < minD)) continue;
            if (!isNaN(maxD) && (isNaN(diffVal) || diffVal > maxD)) continue;
        }
        
        filteredCount++;
        
        bodyHtml += '<tr class="clickable-row" title="Click to view price history chart">';
        headers.forEach((_, colIndex) => {
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
        });
        bodyHtml += '</tr>';
    }
    
    if (filteredCount === 0) {
        bodyHtml = `<tr><td colspan="${headers.length}" style="text-align:center; padding: 2rem; color:var(--text-secondary);">No matching stocks found.</td></tr>`;
    }
    
    resultsTable.querySelector('tbody').innerHTML = bodyHtml;
    resultsCount.textContent = `Found Stocks: ${filteredCount} / ${data.length - 1}`;
}

// Filter change handler
function applyFilters() {
    renderFilteredResults();
}

// Reset filters
function resetFilters() {
    searchCompany.value = '';
    priceMin.value = '';
    priceMax.value = '';
    diffMin.value = '';
    diffMax.value = '';
    renderFilteredResults();
    showNotification('All filters have been reset.', 'info');
}

// Download updated master file
function downloadUpdatedFile() {
    if (!state.processedWorkbook) {
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
        XLSX.writeFile(state.processedWorkbook, newFilename);
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
    
    // Destroy previous Chart instance
    if (state.chartInstance) {
        state.chartInstance.destroy();
    }
    
    // Draw new Chart
    const ctx = document.getElementById('price-chart').getContext('2d');
    state.chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: dateLabels,
            datasets: [{
                label: `${symbol} Close Price (₹)`,
                data: prices,
                borderColor: '#06b6d4',
                backgroundColor: 'rgba(6, 182, 212, 0.1)',
                borderWidth: 2,
                tension: 0.3,
                fill: true,
                pointBackgroundColor: '#06b6d4',
                pointRadius: 4,
                pointHoverRadius: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    mode: 'index',
                    intersect: false,
                    backgroundColor: 'rgba(17, 24, 39, 0.95)',
                    titleColor: '#ffffff',
                    bodyColor: '#e5e7eb',
                    borderColor: 'rgba(6, 182, 212, 0.3)',
                    borderWidth: 1
                }
            },
            scales: {
                x: {
                    grid: {
                        color: 'rgba(255, 255, 255, 0.05)'
                    },
                    ticks: {
                        color: '#9ca3af',
                        font: {
                            family: 'Outfit',
                            size: 11
                        }
                    }
                },
                y: {
                    grid: {
                        color: 'rgba(255, 255, 255, 0.05)'
                    },
                    ticks: {
                        color: '#9ca3af',
                        font: {
                            family: 'Outfit',
                            size: 11
                        },
                        callback: function(value) {
                            return '₹' + value;
                        }
                    }
                }
            }
        }
    });
    
    // Fetch Live Price from Yahoo Finance
    const livePriceEl = document.getElementById('modal-live-price');
    if (livePriceEl) {
        livePriceEl.textContent = 'Fetching...';
        livePriceEl.style.color = '#ffffff';
        
        // Yahoo Finance symbol format is [symbol].NS for NSE stocks
        const rawSym = symbol.trim().toUpperCase();
        const yahooSymbol = rawSym.endsWith('.NS') ? rawSym : rawSym + '.NS';

        // Helper: render price from meta
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
                livePriceEl.textContent = 'N/A';
            }
        };

        // Ordered list of URLs to try
        const liveUrls = [
            `/api/yahoo?symbol=${encodeURIComponent(yahooSymbol)}`,
            `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`,
            `https://api.allorigins.win/raw?url=${encodeURIComponent('https://query1.finance.yahoo.com/v8/finance/chart/' + yahooSymbol)}`,
            `https://thingproxy.freeboard.io/fetch/https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`,
        ];

        (async () => {
            for (const url of liveUrls) {
                try {
                    const res = await fetch(url);
                    if (!res.ok) continue;
                    const data = await res.json();
                    if (data && data.chart && data.chart.result && data.chart.result[0]) {
                        renderLivePrice(data.chart.result[0].meta);
                        return;
                    }
                } catch (e) {
                    console.warn('Live price fetch failed for URL:', url, e);
                }
            }
            // All sources failed
            livePriceEl.textContent = 'N/A';
        })();
    }
    
    // Show Modal overlay
    document.getElementById('chart-modal').classList.remove('hidden');
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
    
    // Destroy previous Chart instance
    if (state.researchChartInstance) {
        state.researchChartInstance.destroy();
        state.researchChartInstance = null;
    }
    
    if (drawChart) {
        const ctx = document.getElementById('research-price-chart').getContext('2d');
        state.researchChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: dateLabels,
                datasets: [{
                    label: `${symbol} Close Price (₹)`,
                    data: prices,
                    borderColor: '#06b6d4',
                    backgroundColor: 'rgba(6, 182, 212, 0.1)',
                    borderWidth: 2,
                    tension: 0.3,
                    fill: true,
                    pointBackgroundColor: '#06b6d4',
                    pointRadius: 4,
                    pointHoverRadius: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        mode: 'index',
                        intersect: false,
                        backgroundColor: 'rgba(17, 24, 39, 0.95)',
                        titleColor: '#ffffff',
                        bodyColor: '#e5e7eb',
                        borderColor: 'rgba(6, 182, 212, 0.3)',
                        borderWidth: 1
                    }
                },
                scales: {
                    x: {
                        grid: {
                            color: 'rgba(255, 255, 255, 0.05)'
                        },
                        ticks: {
                            color: '#9ca3af',
                            font: {
                                family: 'Outfit',
                                size: 11
                            }
                        }
                    },
                    y: {
                        grid: {
                            color: 'rgba(255, 255, 255, 0.05)'
                        },
                        ticks: {
                            color: '#9ca3af',
                            font: {
                                family: 'Outfit',
                                size: 11
                            },
                            callback: function(value) {
                                return '₹' + value;
                            }
                        }
                    }
                }
            }
        });
    }
    
    // Show Modal immediately
    document.getElementById('research-modal').classList.remove('hidden');
    
    // 1. Fetch Company Summary from DuckDuckGo Instant Answers API
    const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(symbol)}+company&format=json`;
    fetch(ddgUrl)
        .then(res => res.json())
        .then(data => {
            const rawDescription = data.AbstractText || data.Definition || `${symbol} is an Indian company engaged in commercial and business activities, listed on the National Stock Exchange (NSE).`;
            
            // Translate to Gujarati using Google Translate's free API
            const translateUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=gu&dt=t&q=${encodeURIComponent(rawDescription)}`;
            fetch(translateUrl)
                .then(res => res.json())
                .then(transData => {
                    // Google translate single API returns array of sentences in transData[0]
                    const sentences = transData[0].map(s => s[0]).join('');
                    descEl.textContent = sentences || rawDescription;
                })
                .catch(transErr => {
                    console.warn("Translation failed, displaying English description:", transErr);
                    descEl.textContent = rawDescription;
                });
        })
        .catch(err => {
            console.error("DuckDuckGo fetch failed:", err);
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

    // Multiple URL sources in priority order — /api/yahoo (Vercel) is server-side, no CORS
    const researchUrls = [

        `/api/yahoo?symbol=${encodeURIComponent(yahooNsSymbol)}`,
        `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooNsSymbol)}?range=1y&interval=1d`,
        `https://api.allorigins.win/raw?url=${encodeURIComponent('https://query1.finance.yahoo.com/v8/finance/chart/' + yahooNsSymbol + '?range=1y&interval=1d')}`,
        `https://thingproxy.freeboard.io/fetch/https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooNsSymbol)}?range=1y&interval=1d`,
    ];

    (async () => {
        let success = false;
        for (const url of researchUrls) {
            try {
                const res = await fetch(url);
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
            console.error('All Yahoo Finance sources exhausted for symbol:', symbol);
            highEl.textContent = 'N/A';
            lowEl.textContent = 'N/A';
            badgeEl.textContent = 'Hold';
            badgeEl.style.background = '#eab308';
            badgeEl.style.color = '#fff';
            adviceEl.textContent = 'Yahoo Finance ડેટા હાલ ઉપલબ્ધ નથી. Screener.in અથવા Tickertape.in ની મુલાકાત લો.';
            const liveEl2 = document.getElementById('chart-live-price');
            if (liveEl2) liveEl2.textContent = 'N/A';
        }
    })();
};

// ============================================================================
// NEW FUNCTIONALITY: LIVE PRICES, INDICES, RESULTS & DIVIDENDS
// ============================================================================

// Helper to fetch Yahoo Finance quotes with sequential CORS proxy fallbacks
async function fetchYahooFinanceData(ticker) {
    const tickerEncoded = encodeURIComponent(ticker.trim().toUpperCase());
    
    // Use clean Yahoo Finance API endpoints (without range/interval limits that fail outside market hours)
    const q1Url = `https://query1.finance.yahoo.com/v8/finance/chart/${tickerEncoded}`;
    const q2Url = `https://query2.finance.yahoo.com/v8/finance/chart/${tickerEncoded}`;
    
    const cacheBuster = Date.now();
    // Cache bust the proxy requests, keeping the inner Yahoo Finance requests clean
    const urls = [
        `/api/yahoo?symbol=${tickerEncoded}&_t=${cacheBuster}`,
        `https://api.allorigins.win/raw?url=${encodeURIComponent(q1Url)}&_t=${cacheBuster}`,
        `https://api.allorigins.win/raw?url=${encodeURIComponent(q2Url)}&_t=${cacheBuster}`,
        `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(q1Url)}&_t=${cacheBuster}`,
        `https://corsproxy.io/?url=${encodeURIComponent(q1Url)}&_t=${cacheBuster}`,
        `https://corsproxy.io/?url=${encodeURIComponent(q2Url)}&_t=${cacheBuster}`,
        `https://api.allorigins.win/get?url=${encodeURIComponent(q1Url)}&_t=${cacheBuster}`, // JSON wrapper fallback
        `https://thingproxy.freeboard.io/fetch/${q1Url}`,
        `https://thingproxy.freeboard.io/fetch/${q2Url}`,
        q1Url, // direct fetch
        q2Url  // direct fetch
    ];

    let lastError = null;
    for (const url of urls) {
        try {
            console.log(`[Yahoo API] Fetching ${ticker} via: ${url.split('?')[0]}`);
            const res = await fetch(url);
            if (!res.ok) {
                console.warn(`Yahoo URL returned HTTP ${res.status}: ${url}`);
                continue;
            }
            
            let data;
            if (url.includes('allorigins.win/get')) {
                // allorigins.win/get returns a JSON wrapper: { contents: "stringified json" }
                const wrapper = await res.json();
                if (wrapper && wrapper.contents) {
                    data = JSON.parse(wrapper.contents);
                } else {
                    continue;
                }
            } else {
                data = await res.json();
            }

            if (data && data.chart && data.chart.result && data.chart.result[0]) {
                return data;
            }
        } catch (e) {
            console.warn(`Yahoo fetch failed for: ${url.split('?')[0]}`, e.message);
            lastError = e;
        }
    }
    throw new Error(`All sources exhausted for ticker ${ticker}. Last error: ${lastError ? lastError.message : 'Unknown'}`);
}

// Fetch live prices for top gainers asynchronously in the background
async function fetchGainersLivePrices(symbols) {
    if (!symbols || symbols.length === 0) return;
    
    // De-duplicate symbols
    const uniqueSymbols = [...new Set(symbols)];
    
    await Promise.all(uniqueSymbols.map(async (symbol) => {
        try {
            let data;
            const isNumeric = symbol.match(/^\d+$/);
            const prefSuffix = isNumeric ? '.BO' : '.NS';
            const fallbackSuffix = isNumeric ? '.NS' : '.BO';
            
            try {
                // Try preferred exchange first
                data = await fetchYahooFinanceData(symbol.trim().toUpperCase() + prefSuffix);
            } catch (e) {
                // Fallback to secondary exchange
                data = await fetchYahooFinanceData(symbol.trim().toUpperCase() + fallbackSuffix);
            }
            
            const price = data.chart.result[0].meta.regularMarketPrice;
            if (price !== undefined) {
                state.gainersLivePrices.set(symbol, price);
                
                // Update live cell in the DOM dynamically
                const cells = document.querySelectorAll(`.live-price-cell[data-symbol="${symbol}"]`);
                cells.forEach(cell => {
                    cell.innerHTML = `₹${price.toFixed(2)} <span class="live-pulse" style="width:6px;height:6px;box-shadow:0 0 0 0 rgba(16,185,129,0.7);animation:pulse 1.5s infinite;margin-left:0.2rem;display:inline-block;border-radius:50%;background:#10b981;"></span>`;
                });
            }
        } catch (e) {
            console.warn(`Failed to fetch live price for gainer ${symbol}:`, e.message);
        }
    }));
}

// Fetch SENSEX, NIFTY 50, Gold and Silver live prices
async function fetchMarketIndices() {
    // --- Nifty & Sensex (Primary: Official NSE/BSE APIs, Fallback: Yahoo Finance) ---
    let officialNiftySuccess = false;
    let officialSensexSuccess = false;

    try {
        console.log("[Market Indices] Fetching Nifty & Sensex from official APIs...");
        const res = await fetch('/api/indices');
        if (res.ok) {
            const data = await res.json();
            
            // 1. Process Sensex
            if (data && data.sensex) {
                const sData = data.sensex;
                const valEl = document.getElementById('sensex-val');
                const chgEl = document.getElementById('sensex-chg');
                if (valEl && chgEl) {
                    valEl.textContent = sData.price.toLocaleString('en-IN', { 
                        minimumFractionDigits: 0, 
                        maximumFractionDigits: 0 
                    });
                    const sign = sData.change >= 0 ? '+' : '';
                    const color = sData.change >= 0 ? 'var(--success-color)' : 'var(--danger-color)';
                    chgEl.textContent = `${sign}${sData.change.toFixed(2)} (${sign}${sData.changePercent.toFixed(2)}%)`;
                    chgEl.style.color = color;
                    officialSensexSuccess = true;
                }
            }

            // 2. Process Nifty
            if (data && data.nifty) {
                const nData = data.nifty;
                const valEl = document.getElementById('nifty-val');
                const chgEl = document.getElementById('nifty-chg');
                if (valEl && chgEl) {
                    valEl.textContent = nData.price.toLocaleString('en-IN', { 
                        minimumFractionDigits: 2, 
                        maximumFractionDigits: 2 
                    });
                    const sign = nData.change >= 0 ? '+' : '';
                    const color = nData.change >= 0 ? 'var(--success-color)' : 'var(--danger-color)';
                    chgEl.textContent = `${sign}${nData.change.toFixed(2)} (${sign}${nData.changePercent.toFixed(2)}%)`;
                    chgEl.style.color = color;
                    officialNiftySuccess = true;
                }
            }
        }
    } catch (e) {
        console.warn('[Market Indices] Official indices API failed, using Yahoo Finance fallbacks:', e.message);
    }

    // Fallbacks
    const indices = [
        { id: 'nifty',  ticker: '^NSEI',  name: 'NIFTY 50', success: officialNiftySuccess },
        { id: 'sensex', ticker: '^BSESN', name: 'SENSEX',   success: officialSensexSuccess }
    ];

    for (const item of indices) {
        if (item.success) continue; // skip if already successfully fetched from official API
        try {
            console.log(`[Market Indices] Fetching ${item.name} fallback from Yahoo...`);
            const data = await fetchYahooFinanceData(item.ticker);
            const meta = data.chart.result[0].meta;
            const currentPrice = meta.regularMarketPrice;
            const prevClose    = meta.previousClose;

            if (currentPrice !== undefined && prevClose !== undefined) {
                const change    = currentPrice - prevClose;
                const changePct = (change / prevClose) * 100;
                const valEl = document.getElementById(`${item.id}-val`);
                const chgEl = document.getElementById(`${item.id}-chg`);
                if (valEl && chgEl) {
                    const decimals = item.id === 'sensex' ? 0 : 2;
                    valEl.textContent = currentPrice.toLocaleString('en-IN', {
                        minimumFractionDigits: decimals,
                        maximumFractionDigits: decimals
                    });
                    const sign  = change >= 0 ? '+' : '';
                    const color = change >= 0 ? 'var(--success-color)' : 'var(--danger-color)';
                    chgEl.textContent = `${sign}${change.toFixed(2)} (${sign}${changePct.toFixed(2)}%)`;
                    chgEl.style.color = color;
                }
            }
        } catch (e) {
            console.error(`Failed to fetch fallback index ${item.name}:`, e.message);
        }
    }

    // --- Gold & Silver (Primary: IBJA Scraper, Fallback: COMEX GC=F / SI=F) ---
    try {
        let ibjaSuccess = false;
        try {
            console.log("[Market Indices] Fetching official IBJA rates from proxy...");
            const ibjaRes = await fetch('/api/ibja');
            if (ibjaRes.ok) {
                const ibjaData = await ibjaRes.json();
                if (ibjaData && ibjaData.gold && ibjaData.silver) {
                    const goldPrice = ibjaData.gold;
                    const silverPrice = ibjaData.silver;
                    
                    // Daily changes compared to previous day
                    const prevGold = ibjaData.prevGold || goldPrice;
                    const prevSilver = ibjaData.prevSilver || silverPrice;
                    
                    const goldChange = goldPrice - prevGold;
                    const goldChangePct = prevGold > 0 ? (goldChange / prevGold) * 100 : 0;
                    
                    const silverChange = silverPrice - prevSilver;
                    const silverChangePct = prevSilver > 0 ? (silverChange / prevSilver) * 100 : 0;

                    // Update Gold DOM
                    const goldValEl = document.getElementById('gold-val');
                    const goldChgEl = document.getElementById('gold-chg');
                    if (goldValEl && goldChgEl) {
                        goldValEl.textContent = `\u20b9${goldPrice.toLocaleString('en-IN')}`;
                        const sign = goldChange >= 0 ? '+' : '';
                        const color = goldChange >= 0 ? 'var(--success-color)' : 'var(--danger-color)';
                        goldChgEl.textContent = `${sign}${goldChange.toLocaleString('en-IN')} (${sign}${goldChangePct.toFixed(2)}%)`;
                        goldChgEl.style.color = color;
                    }

                    // Update Silver DOM
                    const silverValEl = document.getElementById('silver-val');
                    const silverChgEl = document.getElementById('silver-chg');
                    if (silverValEl && silverChgEl) {
                        silverValEl.textContent = `\u20b9${silverPrice.toLocaleString('en-IN')}`;
                        const sign = silverChange >= 0 ? '+' : '';
                        const color = silverChange >= 0 ? 'var(--success-color)' : 'var(--danger-color)';
                        silverChgEl.textContent = `${sign}${silverChange.toLocaleString('en-IN')} (${sign}${silverChangePct.toFixed(2)}%)`;
                        silverChgEl.style.color = color;
                    }
                    
                    ibjaSuccess = true;
                    console.log("[Market Indices] Successfully loaded gold & silver from IBJA.");
                }
            }
        } catch (ibjaErr) {
            console.warn("[Market Indices] IBJA fetch failed, falling back to COMEX:", ibjaErr.message);
        }

        if (!ibjaSuccess) {
            // Fallback: COMEX GC=F / SI=F converted to INR
            // First get USD/INR exchange rate
            let usdInr = 84.5; // fallback
            try {
                const fxData = await fetchYahooFinanceData('INR=X');
                const fxPrice = fxData?.chart?.result?.[0]?.meta?.regularMarketPrice;
                if (fxPrice) usdInr = fxPrice;
            } catch (_) { /* use fallback */ }

            // Gold: COMEX GC=F is USD/troy oz → convert to ₹/10g
            // 1 troy oz = 31.1035 g → price per gram = price/31.1035 → per 10g = price * 10 / 31.1035
            const commodities = [
                { id: 'gold',   ticker: 'GC=F',  name: 'Gold',   unit: '/10g',  factor: 10 / 31.1035 },
                { id: 'silver', ticker: 'SI=F',   name: 'Silver', unit: '/kg',   factor: 1000 / 31.1035 },
            ];

            for (const com of commodities) {
                try {
                    const data = await fetchYahooFinanceData(com.ticker);
                    const meta = data?.chart?.result?.[0]?.meta;
                    if (!meta) continue;

                    const usdPrice  = meta.regularMarketPrice;
                    const prevClose = meta.previousClose || meta.chartPreviousClose;
                    if (!usdPrice) continue;

                    // Convert to INR
                    const inrPrice    = usdPrice * usdInr * com.factor;
                    const inrPrev     = prevClose ? prevClose * usdInr * com.factor : inrPrice;
                    const change      = inrPrice - inrPrev;
                    const changePct   = inrPrev > 0 ? (change / inrPrev) * 100 : 0;

                    const valEl = document.getElementById(`${com.id}-val`);
                    const chgEl = document.getElementById(`${com.id}-chg`);
                    if (valEl && chgEl) {
                        valEl.textContent = `\u20b9${inrPrice.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
                        const sign  = change >= 0 ? '+' : '';
                        const color = change >= 0 ? 'var(--success-color)' : 'var(--danger-color)';
                        chgEl.textContent = `${sign}${change.toLocaleString('en-IN', { maximumFractionDigits: 0 })} (${sign}${changePct.toFixed(2)}%)`;
                        chgEl.style.color = color;
                    }
                } catch (e) {
                    console.warn(`Failed to fetch fallback ${com.name}:`, e.message);
                    const valEl = document.getElementById(`${com.id}-val`);
                    if (valEl) valEl.textContent = 'N/A';
                }
            }
        }
    } catch (e) {
        console.warn('Gold/Silver fetch error:', e.message);
    }
}


// Top 20 Companies Dataset (Upcoming results and 5-yr dividend history)
const resultsAndDividendsData = [
    { symbol: 'TCS', date: '12-07-2026', profit: '12,434', growth: '+8.4%', status: 'Excellent Growth', divPayer: 'Yes', count: '18 times', yield: '3.8%' },
    { symbol: 'RELIANCE', date: '18-07-2026', profit: '18,951', growth: '+5.2%', status: 'Stable', divPayer: 'Yes', count: '5 times', yield: '1.2%' },
    { symbol: 'INFY', date: '15-07-2026', profit: '7,975', growth: '+12.1%', status: 'Excellent Growth', divPayer: 'Yes', count: '10 times', yield: '3.1%' },
    { symbol: 'HDFCBANK', date: '17-07-2026', profit: '16,512', growth: '+9.7%', status: 'Strong Growth', divPayer: 'Yes', count: '5 times', yield: '1.8%' },
    { symbol: 'ITC', date: '22-07-2026', profit: '5,087', growth: '+6.8%', status: 'Strong Growth', divPayer: 'Yes', count: '7 times', yield: '4.2%' },
    { symbol: 'COALINDIA', date: '29-07-2026', profit: '8,640', growth: '+14.5%', status: 'Excellent Growth', divPayer: 'Yes', count: '12 times', yield: '6.8%' },
    { symbol: 'VEDL', date: '30-07-2026', profit: '2,420', growth: '+18.2%', status: 'Excellent Growth', divPayer: 'Yes', count: '24 times', yield: '9.5%' },
    { symbol: 'HINDUNILVR', date: '20-07-2026', profit: '2,561', growth: '+3.9%', status: 'Stable', divPayer: 'Yes', count: '10 times', yield: '2.1%' },
    { symbol: 'TATAMOTORS', date: '25-07-2026', profit: '5,408', growth: '+22.4%', status: 'Outstanding Turnaround', divPayer: 'Yes', count: '3 times', yield: '1.5%' },
    { symbol: 'LT', date: '24-07-2026', profit: '4,396', growth: '+11.3%', status: 'Strong Growth', divPayer: 'Yes', count: '6 times', yield: '1.6%' },
    { symbol: 'SBIN', date: '28-07-2026', profit: '19,780', growth: '+15.8%', status: 'Excellent Growth', divPayer: 'Yes', count: '5 times', yield: '1.9%' },
    { symbol: 'ICICIBANK', date: '19-07-2026', profit: '10,707', growth: '+13.6%', status: 'Excellent Growth', divPayer: 'Yes', count: '5 times', yield: '1.3%' },
    { symbol: 'HCLTECH', date: '16-07-2026', profit: '3,962', growth: '+7.5%', status: 'Strong Growth', divPayer: 'Yes', count: '20 times', yield: '3.9%' },
    { symbol: 'POWERGRID', date: '03-08-2026', profit: '4,128', growth: '+6.1%', status: 'Stable', divPayer: 'Yes', count: '15 times', yield: '4.8%' },
    { symbol: 'NTPC', date: '05-08-2026', profit: '6,490', growth: '+9.4%', status: 'Strong Growth', divPayer: 'Yes', count: '10 times', yield: '3.5%' },
    { symbol: 'ONGC', date: '10-08-2026', profit: '11,530', growth: '+8.9%', status: 'Strong Growth', divPayer: 'Yes', count: '10 times', yield: '5.2%' },
    { symbol: 'BPCL', date: '08-08-2026', profit: '4,224', growth: '+11.8%', status: 'Strong Growth', divPayer: 'Yes', count: '9 times', yield: '6.1%' },
    { symbol: 'IOC', date: '07-08-2026', profit: '4,830', growth: '+10.2%', status: 'Strong Growth', divPayer: 'Yes', count: '9 times', yield: '6.5%' },
    { symbol: 'WIPRO', date: '14-07-2026', profit: '2,835', growth: '+4.2%', status: 'Stable', divPayer: 'Yes', count: '6 times', yield: '1.8%' },
    { symbol: 'TECHM', date: '21-07-2026', profit: '1,125', growth: '+16.4%', status: 'Excellent Recovery', divPayer: 'Yes', count: '8 times', yield: '3.4%' }
];

// Render Tab 3 Content (Results & Dividends Table)
function renderResultsAndDividendsTable() {
    const tbody = document.querySelector('#upcoming-results-table tbody');
    if (!tbody) return;

    let html = '';
    resultsAndDividendsData.forEach(item => {
        // Fetch last known price from uploaded Bhavcopy file
        const bhavcopyRateVal = getLastKnownPrice(item.symbol);
        const bhavcopyRateHtml = bhavcopyRateVal ? `₹${bhavcopyRateVal.toFixed(2)}` : '<span style="font-size:0.75rem;color:var(--text-secondary);">No Data</span>';

        const livePriceVal = state.gainersLivePrices.get(item.symbol);
        const livePriceHtml = livePriceVal 
            ? `₹${livePriceVal.toFixed(2)} <span class="live-pulse" style="width:6px;height:6px;box-shadow:0 0 0 0 rgba(16,185,129,0.7);animation:pulse 1.5s infinite;margin-left:0.2rem;display:inline-block;border-radius:50%;background:#10b981;"></span>`
            : '<span style="font-size:0.75rem;color:var(--text-secondary);">Loading...</span>';

        html += `
            <tr>
                <td><strong>${item.symbol}</strong></td>
                <td>${bhavcopyRateHtml}</td>
                <td class="live-price-cell-results" data-symbol="${item.symbol}">${livePriceHtml}</td>
                <td><i class="fa-regular fa-calendar"></i> ${item.date}</td>
                <td style="font-weight:600;">₹${item.profit} Cr</td>
                <td style="color:var(--success-color); font-weight:600;"><i class="fa-solid fa-arrow-trend-up"></i> ${item.growth}</td>
                <td><span style="background:rgba(6,182,212,0.12); color:var(--accent-color); padding:0.15rem 0.4rem; border-radius:4px; font-size:0.75rem; font-weight:600;">${item.status}</span></td>
                <td><span class="badge-dividend">YES</span></td>
                <td style="font-weight:500;">${item.count}</td>
                <td style="color:#f59e0b; font-weight:700;">${item.yield}</td>
                <td style="text-align:center;">
                    <button class="btn btn-secondary" onclick="showResearchModal('${item.symbol}')" style="font-size:0.75rem; padding:0.25rem 0.5rem; display:inline-flex; align-items:center; gap:0.25rem; background:rgba(6,182,212,0.12); color:var(--accent-color); border-color:rgba(6,182,212,0.25);">
                        <i class="fa-solid fa-robot"></i> Research
                    </button>
                </td>
            </tr>
        `;
    });
    tbody.innerHTML = html;

    // Fetch and display live prices for results companies
    fetchResultsLivePrices(resultsAndDividendsData.map(d => d.symbol));
}

// Fetch live prices for results tab
async function fetchResultsLivePrices(symbols) {
    if (!symbols || symbols.length === 0) return;
    
    const uniqueSymbols = [...new Set(symbols)];
    
    await Promise.all(uniqueSymbols.map(async (symbol) => {
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
            
            const price = data.chart.result[0].meta.regularMarketPrice;
            if (price !== undefined) {
                state.gainersLivePrices.set(symbol, price);
                
                // Update both Gainers table and Results table cells
                const cells = document.querySelectorAll(`.live-price-cell-results[data-symbol="${symbol}"], .live-price-cell[data-symbol="${symbol}"]`);
                cells.forEach(cell => {
                    cell.innerHTML = `₹${price.toFixed(2)} <span class="live-pulse" style="width:6px;height:6px;box-shadow:0 0 0 0 rgba(16,185,129,0.7);animation:pulse 1.5s infinite;margin-left:0.2rem;display:inline-block;border-radius:50%;background:#10b981;"></span>`;
                });
            }
        } catch (e) {
            console.warn(`Failed to fetch live price for results item ${symbol}:`, e.message);
        }
    }));
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
    renderGainersAnalysis();
};

// Remove a stock
window.removeFromWatchlist = function(symbol) {
    watchlistItems = watchlistItems.filter(w => w.symbol !== symbol);
    saveWatchlistToStorage();
    deleteWatchlistItem(symbol); // Firebase (async)
    showNotification(`${symbol} Watchlist માંથી કાઢ્યું.`, 'info');
    renderGainersAnalysis();
    renderWatchlist();
};

// Clear all
window.clearWatchlist = function() {
    if (watchlistItems.length === 0) return;
    if (!confirm('શું તમે સમગ્ર Watchlist ખાલી કરવા માંગો છો?')) return;
    watchlistItems = [];
    saveWatchlistToStorage();
    clearWatchlistInCloud(); // Firebase (async)
    renderWatchlist();
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

    let html = '';
    watchlistItems.forEach((item, idx) => {
        const livePrice = state.gainersLivePrices.get(item.symbol);
        let livePriceHtml = '<span style="font-size:0.75rem;color:var(--text-secondary);">Loading...</span>';
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
            <tr class="clickable-row" onclick="showResearchModal('${item.symbol}')" title="\u0a9a\u0abe\u0ab0\u0acd\u0a9f \u0a85\u0aa8\u0ac7 \u0ab5\u0abf\u0a97\u0aa4 \u0a9c\u0ac1\u0abe\u0acb">
                <td style="color:var(--text-secondary);font-size:0.8rem;">${idx + 1}</td>
                <td>
                    <strong style="color:var(--accent-color);">${item.symbol}</strong><br>
                    <span style="font-size:0.7rem;color:var(--text-secondary);">Added: ${addedDate}</span>
                </td>
                <td>${addedPriceStr}</td>
                <td class="watchlist-live-cell" data-symbol="${item.symbol}">${livePriceHtml}</td>
                <td>${changeHtml}</td>
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

    // Fetch live prices for symbols not yet cached
    const missing = watchlistItems.map(w => w.symbol).filter(s => !state.gainersLivePrices.has(s));
    if (missing.length > 0) fetchWatchlistLivePrices(missing);
};

// Fetch live prices for watchlist symbols
async function fetchWatchlistLivePrices(symbols) {
    await Promise.all(symbols.map(async (symbol) => {
        try {
            const nsSymbol = symbol.trim().toUpperCase() + '.NS';
            const urls = [
                `/api/yahoo?symbol=${encodeURIComponent(nsSymbol)}`,
                `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(nsSymbol)}`,
            ];
            for (const url of urls) {
                try {
                    const res  = await fetch(url);
                    if (!res.ok) continue;
                    const data = await res.json();
                    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
                    if (price) {
                        state.gainersLivePrices.set(symbol, price);
                        // Update live cells in watchlist table
                        document.querySelectorAll(`.watchlist-live-cell[data-symbol="${symbol}"]`).forEach(cell => {
                            cell.innerHTML = `\u20b9${price.toFixed(2)} <span class="live-pulse" style="width:6px;height:6px;background:#22c55e;border-radius:50%;display:inline-block;margin-left:3px;animation:pulse 1.5s infinite;"></span>`;
                        });
                        renderWatchlist(); // re-render for change %
                        break;
                    }
                } catch (_) { /* try next */ }
            }
        } catch (e) {
            console.warn(`Watchlist live price failed for ${symbol}:`, e.message);
        }
    }));
}

// Load watchlist on startup
loadWatchlistFromStorage();

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

    results.sort((a, b) => b.score - a.score);
    const top25 = results.slice(0, 25);

    if (top25.length === 0) {
        if (emptyState)   emptyState.style.display  = '';
        if (tableWrapper) tableWrapper.style.display = 'none';
        return;
    }

    if (emptyState)   emptyState.style.display  = 'none';
    if (tableWrapper) tableWrapper.style.display = '';
    if (badge) badge.textContent = `${top25.length} Scripts`;

    const scoreBarColor = (s) => s >= 65 ? 'var(--success-color)' : s >= 50 ? '#f59e0b' : 'var(--text-secondary)';

    tbody.innerHTML = top25.map((item, idx) => {
        const sign3  = item.mom3 >= 0 ? '+' : '';
        const sign5  = item.mom5 >= 0 ? '+' : '';
        const col3   = item.mom3 >= 0 ? 'var(--success-color)' : 'var(--danger-color)';
        const col5   = item.mom5 >= 0 ? 'var(--success-color)' : 'var(--danger-color)';
        const rankBg = idx === 0 ? '#f59e0b' : idx === 1 ? '#94a3b8' : idx === 2 ? '#b87333' : 'transparent';
        const rankColor = idx < 3 ? '#000' : 'var(--text-secondary)';
        return `
            <tr class="clickable-row" onclick="showResearchModal('${item.symbol}')" title="Chart \u0a85\u0aa8\u0ac7 \u0ab5\u0abf\u0a97\u0aa4">
                <td style="text-align:center;"><span style="background:${rankBg};color:${rankColor};font-weight:700;padding:0.15rem 0.5rem;border-radius:4px;font-size:0.82rem;">${idx+1}</span></td>
                <td><strong style="color:var(--accent-color);">${item.symbol}</strong></td>
                <td>\u20b9${item.latestPrice.toFixed(2)}</td>
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
                <td style="text-align:center;">
                    <button onclick="showResearchModal('${item.symbol}');event.stopPropagation();"
                        style="background:rgba(59,130,246,0.12);border:1px solid var(--accent-color);color:var(--accent-color);border-radius:5px;padding:0.22rem 0.5rem;cursor:pointer;font-size:0.8rem;">
                        <i class="fa-solid fa-chart-area"></i>
                    </button>
                </td>
            </tr>`;
    }).join('');
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

// Fetch live prices specifically for visible symbols on the advice page
async function fetchAdviceLivePrices(symbols) {
    if (!symbols || symbols.length === 0) return;
    console.log("[Advice Live Prices] Fetching live prices for visible stocks:", symbols);
    
    symbols.forEach(async (symbol) => {
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
                state.gainersLivePrices.set(symbol, price);
                // Trigger re-render to recalculate the scorecards and decision immediately using the live price
                renderInvestorAdvice();
            }
        } catch (e) {
            console.warn(`[Advice Live Prices] Failed to fetch live price for ${symbol}:`, e.message);
        }
    });
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

    // Fetch live prices for the top 30 visible symbols in the table (if not already fetched/fetching)
    const symbolsToFetch = results.slice(0, 30)
        .map(item => item.symbol)
        .filter(sym => !state.gainersLivePrices.has(sym) && !state.portfolioLivePrices.has(sym) && !requestedAdviceSymbols.has(sym));
        
    if (symbolsToFetch.length > 0) {
        symbolsToFetch.forEach(sym => requestedAdviceSymbols.add(sym));
        fetchAdviceLivePrices(symbolsToFetch);
    }

    tbody.innerHTML = results.map(item => {
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

// Run on load
document.addEventListener('DOMContentLoaded', initEvents);

