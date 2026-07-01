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
    isinColIndex: -1
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
                showPriceChart(symbol);
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
                showPriceChart(symbol);
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
function handleMultipleFiles(filesList, type) {
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
        const csvFiles = files.filter(f => f.name.split('.').pop().toLowerCase() === 'csv');
        if (csvFiles.length === 0) {
            showNotification('Please upload CSV files only (.csv).', 'error');
            return;
        }
        
        state.csvFiles = csvFiles;
        state.csvFile = csvFiles[0]; // Set as first sample file
        
        if (csvFiles.length === 1) {
            csvFilename.textContent = csvFiles[0].name;
            csvFilesize.textContent = formatBytes(csvFiles[0].size);
        } else {
            csvFilename.textContent = `Selected ${csvFiles.length} CSV files`;
            const totalSize = csvFiles.reduce((sum, f) => sum + f.size, 0);
            csvFilesize.textContent = `Total Size: ${formatBytes(totalSize)}`;
        }
        
        csvDropzone.classList.add('hidden');
        csvStatus.classList.remove('hidden');
        
        log(`${csvFiles.length} CSV files uploaded.`, 'info');
        csvFiles.forEach(f => log(`- ${f.name} (${formatBytes(f.size)})`, 'info'));
        
        // Parse and show preview of the first file as a sample
        parseCSVFile(csvFiles[0]);
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
        if (hStr === 'SERIES') state.seriesColIndex = idx;
        if (hStr === 'HIGH') state.highColIndex = idx;
        if (hStr === 'DIFF') state.diffColIndex = idx;
        if (hStr === 'ISIN') state.isinColIndex = idx;
    });
    
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
    } else if (type === 'csv') {
        state.csvFile = null;
        state.csvWorkbook = null;
        state.csvData = null;
        state.csvFiles = null;
        csvFile.value = '';
        csvStatus.classList.add('hidden');
        csvDropzone.classList.remove('hidden');
        csvPreviewContainer.classList.add('hidden');
    }
    state.processedWorkbook = null;
    state.processedMasterData = null;
    processBtn.disabled = true;
    downloadBtn.disabled = true;
    processLogContainer.classList.add('hidden');
    researchSection.classList.add('hidden');
    logConsole.innerHTML = '';
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
                const seriesKey = keys.find(k => k.toUpperCase().trim() === 'SERIES');
                
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
                const seriesKey = csvKeys.find(k => k.toUpperCase().trim() === 'SERIES');
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
            
            const symbolCandidates = ['SYMBOL', 'SC_NAME', 'SC_CODE', 'NAME', 'COMPANY_NAME', 'COMPANY'];
            for (let candidate of symbolCandidates) {
                const found = csvKeys.find(k => k.toUpperCase().trim() === candidate);
                if (found) {
                    symbolKey = found;
                    break;
                }
            }
            if (!symbolKey) symbolKey = csvKeys[0];
            
            const priceCandidates = ['CLOSE', 'LAST', 'RATE', 'PRICE', 'CLOSE_PRICE', 'LAST_PRICE'];
            for (let candidate of priceCandidates) {
                const found = csvKeys.find(k => k.toUpperCase().trim() === candidate);
                if (found) {
                    closePriceKey = found;
                    break;
                }
            }
            if (!closePriceKey) closePriceKey = csvKeys[csvKeys.length - 1];
            
            const prevCandidates = ['PREVCLOSE', 'PREV_CLOSE', 'PREVCLOSEPRICE', 'PREV_CLOSE_PRICE', 'PREV_CLOSE_RATE'];
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
        
        researchSection.classList.remove('hidden');
        downloadBtn.disabled = false;
        
        renderPreview(state.masterData, masterTable, masterRowCount, masterPreviewContainer);
        showNotification('Calculations updated and saved successfully!', 'success');
        
    } catch (err) {
        console.error(err);
        log(`Error occurred: ${err.message}`, 'error');
        showNotification('Processing failed.', 'error');
    }
}

// Analytical Section: Top 5 Days Gainers (Latest Close - 5 Days Ago Close)
function renderGainersAnalysis() {
    const data = state.processedMasterData;
    if (!data || data.length < 2) return;
    
    const insertIdx = state.latestDateColIndex;
    const gainersRows = [];
    
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
        
        // Collect prices from last 5 date columns going forward (since newest date is inserted next to HIGH)
        const prices = [];
        const limit = Math.min(row.length, insertIdx + 5);
        for (let colIdx = insertIdx; colIdx < limit; colIdx++) {
            const pVal = parseFloat(row[colIdx]);
            if (!isNaN(pVal)) {
                prices.push(pVal);
            }
        }
        
        // Need today's price (prices[0]) and at least one older price to compute gain
        if (prices.length >= 2) {
            const todayPrice = prices[0];
            const oldestPrice = prices[prices.length - 1]; // oldest available date in the last 5 days
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
        
        topPerformerCard.classList.remove('hidden');
    } else {
        topPerformerCard.classList.add('hidden');
    }
    
    // Select top 10
    const topGainers = gainersRows.slice(0, 10);
    
    // Render to table
    let html = '';
    if (topGainers.length === 0) {
        html = '<tr><td colspan="5" style="text-align:center;">No data available</td></tr>';
    } else {
        topGainers.forEach(item => {
            const sign = item.gain > 0 ? '+' : '';
            const color = item.gain > 0 ? 'var(--success-color)' : item.gain < 0 ? 'var(--danger-color)' : 'var(--text-primary)';
            
            html += `
                <tr class="clickable-row" title="Click to view price history chart">
                    <td>${item.symbol}</td>
                    <td>₹${item.old.toFixed(2)}</td>
                    <td>₹${item.today.toFixed(2)}</td>
                    <td style="color:${color}; font-weight:600;">${sign}₹${item.gain.toFixed(2)}</td>
                    <td><span class="volatility-pct" style="color:${color};">${sign}${item.pct}%</span></td>
                </tr>
            `;
        });
    }
    movementTable.querySelector('tbody').innerHTML = html;
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
    document.getElementById('modal-high-price').textContent = highIndex !== -1 && row[highIndex] ? `₹${parseFloat(row[highIndex]).toFixed(2)}` : 'N/A';
    document.getElementById('modal-latest-price').textContent = `₹${prices[prices.length - 1].toFixed(2)}`; // Newest price (last index after reverse)
    document.getElementById('modal-old-price').textContent = `₹${prices[0].toFixed(2)}`; // Oldest price (first index after reverse)
    
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
    
    // Show Modal overlay
    document.getElementById('chart-modal').classList.remove('hidden');
}

// Run on load
document.addEventListener('DOMContentLoaded', initEvents);
