// =========================================================================
// Rahul Finance Pro — Firebase Google Sign-In, RBAC & /admin Control Center
// =========================================================================
(function () {
    'use strict';

    const SEED_ADMIN_EMAILS = [
        'rahuljcombank@gmail.com',
        'akshatpopat9311@gmail.com',
        'tilakpopat2007@gmail.com',
        'support.obsidian@gmail.com',
        'poojapopat84@gmail.com',
        'work.tilakpopatfilms@gmail.com',
        'tilakpopatfilms@gmail.com',
        'enquiry.akshatpopat@gmail.com'
    ];

    const VALID_ROLES = ['admin', 'trader', 'user', 'viewer'];
    const ROLE_LABELS = {
        admin: 'Admin',
        trader: 'Trader',
        user: 'User',
        viewer: 'Viewer'
    };

    const STORAGE_KEYS = {
        session: 'rf_auth_session_v2',
        isLoggedIn: 'isLoggedIn',
        accessControl: 'rf_access_control_cache_v1',
        software: 'rf_software_config_cache_v1',
        appPassword: 'appPassword',
        appUsername: 'rf_app_username'
    };

    const DEFAULT_SOFTWARE_CONFIG = {
        brandName: 'Rahul Finance',
        brandSubtitle: 'Trading Terminal',
        allowPasswordLogin: true,
        defaultTheme: 'dark',
        defaultTimeframe: '10m',
        announcementBanner: ''
    };

    let accessControlMap = buildSeedAccessMap();
    let softwareConfig = { ...DEFAULT_SOFTWARE_CONFIG };
    let authCredentials = { username: 'RAHUL', password: null };
    let currentSession = null;
    let isBootstrapped = false;

    function normalizeEmail(email) {
        return String(email || '').trim().toLowerCase();
    }

    function isValidEmailFormat(email) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
    }

    function escapeHtml(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function buildSeedAccessMap() {
        const map = {};
        SEED_ADMIN_EMAILS.forEach((email) => {
            map[email] = {
                email,
                role: 'admin',
                label: email.split('@')[0],
                active: true,
                isSeed: true,
                addedBy: 'system',
                updatedAt: ''
            };
        });
        return map;
    }

    function mergeAccessMaps(remoteUsers) {
        const merged = buildSeedAccessMap();
        if (remoteUsers && typeof remoteUsers === 'object') {
            Object.keys(remoteUsers).forEach((rawKey) => {
                const entry = remoteUsers[rawKey];
                if (!entry || typeof entry !== 'object') return;
                const email = normalizeEmail(entry.email || rawKey);
                if (!isValidEmailFormat(email)) return;
                const isSeed = SEED_ADMIN_EMAILS.includes(email);
                const role = VALID_ROLES.includes(entry.role) ? entry.role : (isSeed ? 'admin' : 'user');
                merged[email] = {
                    email,
                    role,
                    label: String(entry.label || email.split('@')[0]).slice(0, 80),
                    active: entry.active !== false,
                    isSeed,
                    addedBy: String(entry.addedBy || 'admin').slice(0, 160),
                    updatedAt: String(entry.updatedAt || '')
                };
            });
        }
        return merged;
    }

    function getFirebaseServices() {
        const rf = window.rfFirebase || {};
        let auth = rf.auth || null;
        let db = rf.db || null;
        if (!auth && window.firebase && typeof window.firebase.auth === 'function') {
            try {
                auth = window.firebase.auth();
            } catch (_) {}
        }
        if (!db && window.firebase && typeof window.firebase.firestore === 'function') {
            try {
                db = window.firebase.firestore();
            } catch (_) {}
        }
        return { db, auth };
    }

    function notify(message, type) {
        if (typeof window.showNotification === 'function') {
            window.showNotification(message, type);
        }
    }

    function loadCachedState() {
        try {
            const rawAc = localStorage.getItem(STORAGE_KEYS.accessControl);
            if (rawAc) {
                accessControlMap = mergeAccessMaps(JSON.parse(rawAc));
            }
        } catch (_) {}

        try {
            const rawSw = localStorage.getItem(STORAGE_KEYS.software);
            if (rawSw) {
                softwareConfig = { ...DEFAULT_SOFTWARE_CONFIG, ...JSON.parse(rawSw) };
            }
        } catch (_) {}

        try {
            const savedUser = localStorage.getItem(STORAGE_KEYS.appUsername);
            const savedPass = localStorage.getItem(STORAGE_KEYS.appPassword);
            if (savedUser) authCredentials.username = String(savedUser).trim();
            if (savedPass) authCredentials.password = String(savedPass);
        } catch (_) {}

        try {
            const rawSess = sessionStorage.getItem(STORAGE_KEYS.session);
            if (rawSess) {
                const parsed = JSON.parse(rawSess);
                if (parsed && parsed.loggedIn) {
                    currentSession = parsed;
                }
            } else if (sessionStorage.getItem(STORAGE_KEYS.isLoggedIn) === 'true') {
                currentSession = {
                    loggedIn: true,
                    authMode: 'password',
                    email: '',
                    displayName: authCredentials.username || 'RAHUL',
                    role: 'user',
                    photoURL: ''
                };
            }
        } catch (_) {}
    }

    function persistSession(session) {
        currentSession = session;
        try {
            if (session && session.loggedIn) {
                sessionStorage.setItem(STORAGE_KEYS.isLoggedIn, 'true');
                sessionStorage.setItem(STORAGE_KEYS.session, JSON.stringify(session));
            } else {
                sessionStorage.removeItem(STORAGE_KEYS.isLoggedIn);
                sessionStorage.removeItem(STORAGE_KEYS.session);
            }
        } catch (_) {}
    }

    async function syncFromFirestore(timeoutMs = 5000) {
        const { db } = getFirebaseServices();
        if (!db) return;

        const withTimeout = (promise) => Promise.race([
            promise,
            new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))
        ]);

        try {
            const [authDoc, acDoc, swDoc] = await Promise.all([
                withTimeout(db.collection('metadata').doc('auth').get()).catch(() => null),
                withTimeout(db.collection('metadata').doc('access_control').get()).catch(() => null),
                withTimeout(db.collection('metadata').doc('software').get()).catch(() => null)
            ]);

            if (authDoc && authDoc.exists) {
                const data = authDoc.data() || {};
                if (data.username) {
                    authCredentials.username = String(data.username).trim();
                    try { localStorage.setItem(STORAGE_KEYS.appUsername, authCredentials.username); } catch (_) {}
                }
                if (data.password) {
                    authCredentials.password = String(data.password);
                    try { localStorage.setItem(STORAGE_KEYS.appPassword, authCredentials.password); } catch (_) {}
                }
            }

            if (acDoc && acDoc.exists) {
                const data = acDoc.data() || {};
                if (data.users && typeof data.users === 'object') {
                    accessControlMap = mergeAccessMaps(data.users);
                    try { localStorage.setItem(STORAGE_KEYS.accessControl, JSON.stringify(accessControlMap)); } catch (_) {}
                }
            }

            if (swDoc && swDoc.exists) {
                const data = swDoc.data() || {};
                softwareConfig = {
                    ...DEFAULT_SOFTWARE_CONFIG,
                    brandName: data.brandName ? String(data.brandName).slice(0, 80) : DEFAULT_SOFTWARE_CONFIG.brandName,
                    brandSubtitle: data.brandSubtitle !== undefined ? String(data.brandSubtitle).slice(0, 120) : DEFAULT_SOFTWARE_CONFIG.brandSubtitle,
                    allowPasswordLogin: data.allowPasswordLogin !== false,
                    defaultTheme: data.defaultTheme === 'light' ? 'light' : 'dark',
                    defaultTimeframe: data.defaultTimeframe || '10m',
                    announcementBanner: data.announcementBanner ? String(data.announcementBanner).slice(0, 240) : ''
                };
                try { localStorage.setItem(STORAGE_KEYS.software, JSON.stringify(softwareConfig)); } catch (_) {}
            }
        } catch (err) {
            console.warn('[RfAuthAdmin] Firestore sync warning:', err?.message || err);
        }

        applySoftwareConfigToUI();
        refreshLoginMethodAvailability();
    }

    function applySoftwareConfigToUI() {
        const brandName = softwareConfig.brandName || 'Rahul Finance';
        const brandSubtitle = softwareConfig.brandSubtitle || 'Trading Terminal';

        document.querySelectorAll('.logo-text, .topbar-brand-kicker, .login-brand-name').forEach((el) => {
            el.textContent = brandName;
        });
        document.querySelectorAll('.logo-sub, .login-brand-sub').forEach((el) => {
            el.textContent = brandSubtitle;
        });

        const bannerEl = document.getElementById('rf-software-announcement');
        const bannerTextEl = document.getElementById('rf-software-announcement-text');
        const notice = String(softwareConfig.announcementBanner || '').trim();
        if (bannerEl && bannerTextEl) {
            if (notice) {
                bannerTextEl.textContent = notice;
                bannerEl.classList.remove('hidden');
            } else {
                bannerEl.classList.add('hidden');
            }
        }

        try {
            if (!localStorage.getItem('rf_theme') && softwareConfig.defaultTheme) {
                if (softwareConfig.defaultTheme === 'light') {
                    document.documentElement.setAttribute('data-theme', 'light');
                } else {
                    document.documentElement.removeAttribute('data-theme');
                }
            }
        } catch (_) {}
    }

    function refreshLoginMethodAvailability() {
        const loginForm = document.getElementById('login-form');
        const disabledNote = document.getElementById('login-password-disabled-note');
        const allowPass = softwareConfig.allowPasswordLogin !== false;
        if (loginForm) {
            loginForm.classList.toggle('hidden', !allowPass);
        }
        if (disabledNote) {
            disabledNote.classList.toggle('hidden', allowPass);
        }
    }

    function isCurrentUserAdmin() {
        if (!currentSession || !currentSession.loggedIn) return false;
        if (currentSession.authMode !== 'google') return false;
        const email = normalizeEmail(currentSession.email);
        const entry = accessControlMap[email];
        return Boolean(entry && entry.active !== false && entry.role === 'admin');
    }

    function getCurrentRole() {
        if (!currentSession || !currentSession.loggedIn) return 'guest';
        if (currentSession.authMode === 'google') {
            const entry = accessControlMap[normalizeEmail(currentSession.email)];
            if (entry && entry.active !== false && VALID_ROLES.includes(entry.role)) {
                return entry.role;
            }
            return 'viewer';
        }
        return 'user';
    }

    function setLoginError(message) {
        const loginError = document.getElementById('login-error');
        if (!loginError) return;
        if (!message) {
            loginError.classList.add('hidden');
            return;
        }
        loginError.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> <span>${escapeHtml(message)}</span>`;
        loginError.classList.remove('hidden');
    }

    function updateAccountUI() {
        const isAdmin = isCurrentUserAdmin();
        const role = getCurrentRole();
        const roleLabel = ROLE_LABELS[role] || 'User';

        // Sidebar / Topbar Admin Console triggers (strictly Admins only)
        const tabAdmin = document.getElementById('tab-admin');
        const adminNavGroup = document.getElementById('nav-group-admin');
        const topbarAdminBtn = document.getElementById('topbar-admin-btn');
        if (tabAdmin) tabAdmin.classList.toggle('hidden', !isAdmin);
        if (adminNavGroup) adminNavGroup.classList.toggle('hidden', !isAdmin);
        if (topbarAdminBtn) topbarAdminBtn.classList.toggle('hidden', !isAdmin);

        // Password change buttons strictly Admin-only (routed to /admin)
        const changePwdBtn = document.getElementById('change-password-btn');
        const settingsPwdBtn = document.getElementById('settings-open-password-btn');
        if (changePwdBtn) changePwdBtn.classList.toggle('hidden', !isAdmin);
        if (settingsPwdBtn) settingsPwdBtn.classList.toggle('hidden', !isAdmin);

        // User identity card in sidebar & topbar
        const nameEl = document.getElementById('rf-account-name');
        const metaEl = document.getElementById('rf-account-meta');
        const avatarEl = document.getElementById('rf-account-avatar');
        const topbarUserEl = document.getElementById('topbar-user-label');

        const displayName = currentSession
            ? (currentSession.displayName || currentSession.email || authCredentials.username || 'User')
            : 'Guest';
        const displaySub = currentSession && currentSession.email
            ? `${roleLabel} · ${currentSession.email}`
            : `${roleLabel} · Credentials`;

        if (nameEl) nameEl.textContent = displayName;
        if (metaEl) metaEl.textContent = displaySub;
        if (topbarUserEl) topbarUserEl.textContent = `${displayName.split(' ')[0]} · ${roleLabel}`;

        if (avatarEl) {
            if (currentSession && currentSession.photoURL) {
                avatarEl.innerHTML = `<img src="${escapeHtml(currentSession.photoURL)}" alt="${escapeHtml(displayName)}" referrerpolicy="no-referrer">`;
            } else {
                const initials = String(displayName || 'RF').trim().slice(0, 2).toUpperCase();
                avatarEl.textContent = initials;
            }
        }
    }

    function unlockTerminal(options = {}) {
        const loginOverlay = document.getElementById('login-screen');
        const mainApp = document.getElementById('main-app');
        if (loginOverlay) loginOverlay.classList.add('hidden');
        if (mainApp) mainApp.classList.remove('hidden');

        updateAccountUI();
        applySoftwareConfigToUI();

        if (typeof window.startDashboardAfterLogin === 'function') {
            setTimeout(window.startDashboardAfterLogin, 0);
        }

        const wantAdminRoute = options.openAdminIfRequested !== false && window.location.pathname === '/admin';
        if (wantAdminRoute) {
            openAdminRoute(false);
        }
    }

    function openAdminRoute(pushUrl = true) {
        if (pushUrl && window.location.pathname !== '/admin') {
            try {
                history.pushState({ rfRoute: 'admin' }, '', '/admin');
            } catch (_) {}
        }

        if (typeof window.__rfHideAllTabs === 'function') {
            window.__rfHideAllTabs(false);
        }

        const adminPane = document.getElementById('admin-tab-content');
        const tabAdmin = document.getElementById('tab-admin');
        if (adminPane) adminPane.classList.remove('hidden');
        if (tabAdmin) tabAdmin.classList.add('active');

        const titleEl = document.getElementById('topbar-active-title');
        if (titleEl) titleEl.textContent = 'Admin Control Center';

        renderAdminConsole();
    }

    function leaveAdminUrlIfActive() {
        if (window.location.pathname === '/admin') {
            try {
                history.replaceState({ rfRoute: 'terminal' }, '', '/');
            } catch (_) {}
        }
    }

    async function handleGoogleSignIn(e) {
        if (e) e.preventDefault();
        setLoginError('');

        const btn = document.getElementById('google-login-btn');
        const adminVerifyBtn = document.getElementById('admin-verify-google-btn');
        const activeBtn = (e && e.currentTarget) || btn || adminVerifyBtn;
        const originalHtml = activeBtn ? activeBtn.innerHTML : '';
        if (activeBtn) {
            activeBtn.disabled = true;
            activeBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Signing in with Google...</span>';
        }

        try {
            const { auth } = getFirebaseServices();
            if (!auth || !window.firebase || !window.firebase.auth || !window.firebase.auth.GoogleAuthProvider) {
                throw new Error('Firebase Auth SDK is not available. Please refresh the page.');
            }

            const provider = new window.firebase.auth.GoogleAuthProvider();
            provider.setCustomParameters({ prompt: 'select_account' });
            const result = await auth.signInWithPopup(provider);
            const user = result && result.user;
            if (!user || !user.email) {
                throw new Error('Google sign-in did not return an email address.');
            }

            // Refresh latest allowlist from Firestore before authorization decision
            await syncFromFirestore(5000);

            const email = normalizeEmail(user.email);
            const entry = accessControlMap[email];

            if (!entry || entry.active === false) {
                await auth.signOut().catch(() => {});
                persistSession(null);
                const msg = !entry
                    ? `Access Denied: ${email} is not authorized. Ask an Admin to add this Gmail ID in /admin.`
                    : `Access Suspended: ${email} has been disabled by an Admin.`;
                setLoginError(msg);
                notify(msg, 'error');
                return;
            }

            persistSession({
                loggedIn: true,
                authMode: 'google',
                uid: user.uid,
                email,
                displayName: user.displayName || entry.label || email.split('@')[0],
                photoURL: user.photoURL || '',
                role: entry.role
            });

            notify(`Signed in as ${email} (${ROLE_LABELS[entry.role] || entry.role})`, 'success');
            unlockTerminal({ openAdminIfRequested: true });
            if (window.location.pathname === '/admin') {
                renderAdminConsole();
            }
        } catch (err) {
            console.error('[Google Sign-In]', err);
            const code = err && err.code ? String(err.code) : '';
            let friendly = err && err.message ? err.message : 'Google sign-in failed.';
            if (code === 'auth/popup-closed-by-user') {
                friendly = 'Google sign-in popup was closed before completing.';
            } else if (code === 'auth/popup-blocked') {
                friendly = 'Popup blocked by browser. Please allow popups for this site and try again.';
            } else if (code === 'auth/unauthorized-domain') {
                friendly = `Domain "${window.location.hostname}" is not yet authorized in Firebase Console (bhavcopy-e4acc → Authentication → Settings → Authorized domains).`;
            } else if (code === 'auth/operation-not-allowed') {
                friendly = 'Google Sign-In provider is not enabled yet in Firebase Console (bhavcopy-e4acc → Authentication → Sign-in method → Google).';
            }
            setLoginError(friendly);
            notify(friendly, 'error');
        } finally {
            if (activeBtn) {
                activeBtn.disabled = false;
                activeBtn.innerHTML = originalHtml;
            }
        }
    }

    async function handlePasswordLoginSubmit(e) {
        e.preventDefault();
        setLoginError('');

        await syncFromFirestore(3500);

        if (softwareConfig.allowPasswordLogin === false) {
            const msg = 'Username & Password login is disabled by Admin. Please use Google Sign-In.';
            setLoginError(msg);
            notify(msg, 'error');
            return;
        }

        const usernameEl = document.getElementById('username');
        const passwordEl = document.getElementById('password');
        const usernameInput = usernameEl ? usernameEl.value.trim() : '';
        const passwordInput = passwordEl ? passwordEl.value.trim() : '';

        const expectedUsername = String(authCredentials.username || 'RAHUL').trim();
        const expectedPassword = authCredentials.password || localStorage.getItem(STORAGE_KEYS.appPassword);

        if (!expectedPassword) {
            const msg = 'Credentials password is not configured in cloud yet. Sign in with an Admin Google account or contact Admin.';
            setLoginError(msg);
            notify(msg, 'error');
            return;
        }

        if (usernameInput.toUpperCase() === expectedUsername.toUpperCase() && passwordInput === expectedPassword) {
            persistSession({
                loggedIn: true,
                authMode: 'password',
                uid: '',
                email: '',
                displayName: expectedUsername,
                photoURL: '',
                role: 'user'
            });
            notify('Signed in successfully!', 'success');
            unlockTerminal({ openAdminIfRequested: true });
        } else {
            const msg = 'Invalid username or password!';
            setLoginError(msg);
            notify('Login failed! Invalid username or password.', 'error');
        }
    }

    async function signOutUser() {
        const { auth } = getFirebaseServices();
        if (auth) {
            try { await auth.signOut(); } catch (_) {}
        }
        persistSession(null);
        leaveAdminUrlIfActive();
        const mainApp = document.getElementById('main-app');
        const loginOverlay = document.getElementById('login-screen');
        if (mainApp) mainApp.classList.add('hidden');
        if (loginOverlay) loginOverlay.classList.remove('hidden');
        setLoginError('');
        notify('Signed out cleanly.', 'info');
    }

    // ---------------------------------------------------------------------
    // /admin Console Rendering & Admin-Only Mutations
    // ---------------------------------------------------------------------
    function renderAdminConsole() {
        const deniedPanel = document.getElementById('admin-access-denied');
        const consolePanel = document.getElementById('admin-console-panel');
        const isAdmin = isCurrentUserAdmin();

        if (!isAdmin) {
            if (deniedPanel) deniedPanel.classList.remove('hidden');
            if (consolePanel) consolePanel.classList.add('hidden');
            return;
        }

        if (deniedPanel) deniedPanel.classList.add('hidden');
        if (consolePanel) consolePanel.classList.remove('hidden');

        // KPI counts
        const users = Object.values(accessControlMap);
        const totalCount = users.length;
        const adminCount = users.filter((u) => u.active !== false && u.role === 'admin').length;
        const standardCount = users.filter((u) => u.active !== false && u.role !== 'admin').length;

        const elTotal = document.getElementById('admin-stat-total');
        const elAdmins = document.getElementById('admin-stat-admins');
        const elUsers = document.getElementById('admin-stat-users');
        const elLoginPolicy = document.getElementById('admin-stat-policy');
        if (elTotal) elTotal.textContent = String(totalCount);
        if (elAdmins) elAdmins.textContent = String(adminCount);
        if (elUsers) elUsers.textContent = String(standardCount);
        if (elLoginPolicy) {
            elLoginPolicy.textContent = softwareConfig.allowPasswordLogin !== false ? 'Google + Credentials' : 'Google Only';
        }

        // Fill Credentials form
        const credUsername = document.getElementById('admin-cred-username');
        const credPassword = document.getElementById('admin-cred-password');
        const credConfirm = document.getElementById('admin-cred-confirm');
        if (credUsername) credUsername.value = authCredentials.username || 'RAHUL';
        if (credPassword) credPassword.value = '';
        if (credConfirm) credConfirm.value = '';

        // Fill Software Config form
        const swBrand = document.getElementById('admin-sw-brand');
        const swSub = document.getElementById('admin-sw-subtitle');
        const swAllowPwd = document.getElementById('admin-sw-allow-password');
        const swTheme = document.getElementById('admin-sw-theme');
        const swTf = document.getElementById('admin-sw-timeframe');
        const swBanner = document.getElementById('admin-sw-banner');
        if (swBrand) swBrand.value = softwareConfig.brandName || 'Rahul Finance';
        if (swSub) swSub.value = softwareConfig.brandSubtitle || 'Trading Terminal';
        if (swAllowPwd) swAllowPwd.checked = softwareConfig.allowPasswordLogin !== false;
        if (swTheme) swTheme.value = softwareConfig.defaultTheme || 'dark';
        if (swTf) swTf.value = softwareConfig.defaultTimeframe || '10m';
        if (swBanner) swBanner.value = softwareConfig.announcementBanner || '';

        renderAdminUsersTable();
    }

    function renderAdminUsersTable() {
        const tbody = document.getElementById('admin-users-tbody');
        if (!tbody) return;

        const searchEl = document.getElementById('admin-users-search');
        const roleFilterEl = document.getElementById('admin-users-role-filter');
        const q = searchEl ? searchEl.value.trim().toLowerCase() : '';
        const roleFilter = roleFilterEl ? roleFilterEl.value : 'all';

        const list = Object.values(accessControlMap)
            .filter((entry) => {
                if (roleFilter !== 'all' && entry.role !== roleFilter) return false;
                if (q && !entry.email.includes(q) && !String(entry.label || '').toLowerCase().includes(q)) return false;
                return true;
            })
            .sort((a, b) => {
                if (a.role === 'admin' && b.role !== 'admin') return -1;
                if (a.role !== 'admin' && b.role === 'admin') return 1;
                return a.email.localeCompare(b.email);
            });

        if (list.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:1.5rem; color:var(--text-secondary);">No matching Gmail accounts found.</td></tr>';
            return;
        }

        const currentEmail = normalizeEmail(currentSession && currentSession.email);

        tbody.innerHTML = list.map((entry) => {
            const isSelf = entry.email === currentEmail;
            const statusText = entry.active !== false ? 'Active' : 'Suspended';
            const statusClass = entry.active !== false ? 'rf-status-active' : 'rf-status-suspended';
            const roleOptions = VALID_ROLES.map((r) => `<option value="${r}" ${entry.role === r ? 'selected' : ''}>${ROLE_LABELS[r]}</option>`).join('');

            return `
                <tr data-email="${escapeHtml(entry.email)}">
                    <td>
                        <div class="admin-user-cell">
                            <strong>${escapeHtml(entry.email)}</strong>
                            <span class="admin-user-sub">${escapeHtml(entry.label || entry.email.split('@')[0])}${isSelf ? ' · You' : ''}${entry.isSeed ? ' · Core' : ''}</span>
                        </div>
                    </td>
                    <td>
                        <select class="admin-role-select" data-action="role" data-email="${escapeHtml(entry.email)}" aria-label="Role for ${escapeHtml(entry.email)}">
                            ${roleOptions}
                        </select>
                    </td>
                    <td>
                        <button type="button" class="admin-status-btn ${statusClass}" data-action="toggle-active" data-email="${escapeHtml(entry.email)}">
                            ${statusText}
                        </button>
                    </td>
                    <td class="admin-meta-cell">${escapeHtml(entry.addedBy || 'system')}</td>
                    <td style="text-align:right;">
                        <button type="button" class="admin-remove-btn" data-action="remove" data-email="${escapeHtml(entry.email)}" ${isSelf ? 'disabled title="You cannot remove your own active session"' : 'title="Remove Gmail access"'}>
                            <i class="fa-solid fa-trash-can"></i>
                        </button>
                    </td>
                </tr>
            `;
        }).join('');
    }

    async function persistAccessControlToFirestore() {
        try {
            localStorage.setItem(STORAGE_KEYS.accessControl, JSON.stringify(accessControlMap));
        } catch (_) {}

        const { db } = getFirebaseServices();
        if (!db) {
            notify('Saved locally (Firestore unavailable).', 'warning');
            return;
        }
        try {
            await db.collection('metadata').doc('access_control').set({
                users: accessControlMap,
                updatedBy: normalizeEmail(currentSession && currentSession.email),
                updatedAt: window.firebase && window.firebase.firestore
                    ? window.firebase.firestore.FieldValue.serverTimestamp()
                    : new Date().toISOString()
            });
            notify('Authorized Gmail accounts synced to Firebase!', 'success');
        } catch (err) {
            console.error('[Admin Access Control Save]', err);
            notify(`Saved locally; Firebase sync failed: ${err?.message || err}`, 'warning');
        }
    }

    async function handleAddUserSubmit(e) {
        e.preventDefault();
        if (!isCurrentUserAdmin()) {
            notify('Only Admins can add Gmail accounts.', 'error');
            return;
        }

        const emailEl = document.getElementById('admin-new-email');
        const labelEl = document.getElementById('admin-new-label');
        const roleEl = document.getElementById('admin-new-role');

        const email = normalizeEmail(emailEl ? emailEl.value : '');
        const label = String(labelEl ? labelEl.value : '').trim().slice(0, 80);
        const role = VALID_ROLES.includes(roleEl ? roleEl.value : '') ? roleEl.value : 'user';

        if (!isValidEmailFormat(email)) {
            notify('Please enter a valid Gmail / email address.', 'error');
            return;
        }

        accessControlMap[email] = {
            email,
            role,
            label: label || email.split('@')[0],
            active: true,
            isSeed: SEED_ADMIN_EMAILS.includes(email),
            addedBy: normalizeEmail(currentSession && currentSession.email) || 'admin',
            updatedAt: new Date().toISOString()
        };

        if (emailEl) emailEl.value = '';
        if (labelEl) labelEl.value = '';
        renderAdminConsole();
        await persistAccessControlToFirestore();
    }

    async function handleAdminTableAction(target) {
        if (!isCurrentUserAdmin()) return;
        const actionEl = target.closest('[data-action]');
        if (!actionEl) return;
        const action = actionEl.dataset.action;
        const email = normalizeEmail(actionEl.dataset.email);
        const entry = accessControlMap[email];
        if (!entry) return;

        const currentEmail = normalizeEmail(currentSession && currentSession.email);
        const activeAdmins = Object.values(accessControlMap).filter((u) => u.active !== false && u.role === 'admin');

        if (action === 'role') {
            const newRole = actionEl.value;
            if (!VALID_ROLES.includes(newRole)) return;
            if (entry.role === 'admin' && newRole !== 'admin' && activeAdmins.length <= 1) {
                notify('Cannot demote the last active Admin.', 'error');
                actionEl.value = 'admin';
                return;
            }
            if (email === currentEmail && newRole !== 'admin') {
                notify('You cannot demote your own active Admin session.', 'error');
                actionEl.value = 'admin';
                return;
            }
            entry.role = newRole;
            entry.updatedAt = new Date().toISOString();
            renderAdminConsole();
            await persistAccessControlToFirestore();
        } else if (action === 'toggle-active') {
            const nextActive = entry.active === false;
            if (!nextActive && entry.role === 'admin' && activeAdmins.length <= 1) {
                notify('Cannot suspend the last active Admin.', 'error');
                return;
            }
            if (!nextActive && email === currentEmail) {
                notify('You cannot suspend your own active session.', 'error');
                return;
            }
            entry.active = nextActive;
            entry.updatedAt = new Date().toISOString();
            renderAdminConsole();
            await persistAccessControlToFirestore();
        } else if (action === 'remove') {
            if (email === currentEmail) {
                notify('You cannot remove your own active session.', 'error');
                return;
            }
            if (entry.role === 'admin' && entry.active !== false && activeAdmins.length <= 1) {
                notify('Cannot remove the last active Admin.', 'error');
                return;
            }
            delete accessControlMap[email];
            renderAdminConsole();
            await persistAccessControlToFirestore();
        }
    }

    async function handleCredentialsSaveSubmit(e) {
        e.preventDefault();
        if (!isCurrentUserAdmin()) {
            notify('Only Admins can change software username or password.', 'error');
            return;
        }

        const userEl = document.getElementById('admin-cred-username');
        const passEl = document.getElementById('admin-cred-password');
        const confirmEl = document.getElementById('admin-cred-confirm');

        const newUsername = String(userEl ? userEl.value : '').trim();
        const newPassword = String(passEl ? passEl.value : '').trim();
        const confirmPassword = String(confirmEl ? confirmEl.value : '').trim();

        if (newUsername.length < 3 || newUsername.length > 64) {
            notify('Username must be between 3 and 64 characters.', 'error');
            return;
        }

        const effectivePassword = newPassword || authCredentials.password || localStorage.getItem(STORAGE_KEYS.appPassword);
        if (!effectivePassword || effectivePassword.length < 4) {
            notify('Password must be at least 4 characters.', 'error');
            return;
        }
        if (newPassword && newPassword !== confirmPassword) {
            notify('New password and confirmation do not match.', 'error');
            return;
        }

        authCredentials.username = newUsername;
        authCredentials.password = effectivePassword;

        try {
            localStorage.setItem(STORAGE_KEYS.appUsername, newUsername);
            localStorage.setItem(STORAGE_KEYS.appPassword, effectivePassword);
        } catch (_) {}

        const { db } = getFirebaseServices();
        if (db) {
            try {
                await db.collection('metadata').doc('auth').set({
                    username: newUsername,
                    password: effectivePassword,
                    updatedBy: normalizeEmail(currentSession && currentSession.email),
                    updatedAt: window.firebase && window.firebase.firestore
                        ? window.firebase.firestore.FieldValue.serverTimestamp()
                        : new Date().toISOString()
                });
                notify('Software username & password updated in Firebase!', 'success');
            } catch (err) {
                console.error('[Admin Credentials Save]', err);
                notify(`Updated locally; Firebase sync failed: ${err?.message || err}`, 'warning');
            }
        } else {
            notify('Software credentials updated locally.', 'success');
        }

        if (passEl) passEl.value = '';
        if (confirmEl) confirmEl.value = '';
    }

    async function handleSoftwareConfigSubmit(e) {
        e.preventDefault();
        if (!isCurrentUserAdmin()) {
            notify('Only Admins can modify software settings.', 'error');
            return;
        }

        const brand = String(document.getElementById('admin-sw-brand')?.value || '').trim() || 'Rahul Finance';
        const subtitle = String(document.getElementById('admin-sw-subtitle')?.value || '').trim() || 'Trading Terminal';
        const allowPwd = Boolean(document.getElementById('admin-sw-allow-password')?.checked);
        const theme = document.getElementById('admin-sw-theme')?.value === 'light' ? 'light' : 'dark';
        const tf = document.getElementById('admin-sw-timeframe')?.value || '10m';
        const banner = String(document.getElementById('admin-sw-banner')?.value || '').trim().slice(0, 240);

        softwareConfig = {
            brandName: brand.slice(0, 80),
            brandSubtitle: subtitle.slice(0, 120),
            allowPasswordLogin: allowPwd,
            defaultTheme: theme,
            defaultTimeframe: tf,
            announcementBanner: banner
        };

        try {
            localStorage.setItem(STORAGE_KEYS.software, JSON.stringify(softwareConfig));
        } catch (_) {}

        applySoftwareConfigToUI();
        refreshLoginMethodAvailability();
        renderAdminConsole();

        const { db } = getFirebaseServices();
        if (db) {
            try {
                await db.collection('metadata').doc('software').set({
                    ...softwareConfig,
                    updatedBy: normalizeEmail(currentSession && currentSession.email),
                    updatedAt: window.firebase && window.firebase.firestore
                        ? window.firebase.firestore.FieldValue.serverTimestamp()
                        : new Date().toISOString()
                });
                notify('Software settings updated and synced to Firebase!', 'success');
            } catch (err) {
                console.error('[Admin Software Save]', err);
                notify(`Updated locally; Firebase sync failed: ${err?.message || err}`, 'warning');
            }
        } else {
            notify('Software settings updated locally.', 'success');
        }
    }

    function wireDOMEvents() {
        const googleBtn = document.getElementById('google-login-btn');
        if (googleBtn && !googleBtn.dataset.wired) {
            googleBtn.dataset.wired = '1';
            googleBtn.addEventListener('click', handleGoogleSignIn);
        }

        const adminVerifyGoogleBtn = document.getElementById('admin-verify-google-btn');
        if (adminVerifyGoogleBtn && !adminVerifyGoogleBtn.dataset.wired) {
            adminVerifyGoogleBtn.dataset.wired = '1';
            adminVerifyGoogleBtn.addEventListener('click', handleGoogleSignIn);
        }

        const adminReturnBtn = document.getElementById('admin-return-terminal-btn');
        if (adminReturnBtn && !adminReturnBtn.dataset.wired) {
            adminReturnBtn.dataset.wired = '1';
            adminReturnBtn.addEventListener('click', () => {
                leaveAdminUrlIfActive();
                const overviewBtn = document.getElementById('tab-overview');
                if (overviewBtn) overviewBtn.click();
            });
        }

        const loginForm = document.getElementById('login-form');
        if (loginForm && !loginForm.dataset.wired) {
            loginForm.dataset.wired = '1';
            loginForm.addEventListener('submit', handlePasswordLoginSubmit);
        }

        const togglePassBtn = document.getElementById('login-toggle-password');
        const passwordInput = document.getElementById('password');
        if (togglePassBtn && passwordInput && !togglePassBtn.dataset.wired) {
            togglePassBtn.dataset.wired = '1';
            togglePassBtn.addEventListener('click', () => {
                const isPwd = passwordInput.type === 'password';
                passwordInput.type = isPwd ? 'text' : 'password';
                togglePassBtn.innerHTML = isPwd
                    ? '<i class="fa-regular fa-eye-slash"></i>'
                    : '<i class="fa-regular fa-eye"></i>';
            });
        }

        const tabAdmin = document.getElementById('tab-admin');
        if (tabAdmin && !tabAdmin.dataset.wired) {
            tabAdmin.dataset.wired = '1';
            tabAdmin.addEventListener('click', () => openAdminRoute(true));
        }

        const topbarAdminBtn = document.getElementById('topbar-admin-btn');
        if (topbarAdminBtn && !topbarAdminBtn.dataset.wired) {
            topbarAdminBtn.dataset.wired = '1';
            topbarAdminBtn.addEventListener('click', () => openAdminRoute(true));
        }

        const signOutBtn = document.getElementById('rf-signout-btn');
        if (signOutBtn && !signOutBtn.dataset.wired) {
            signOutBtn.dataset.wired = '1';
            signOutBtn.addEventListener('click', signOutUser);
        }

        const changePwdBtn = document.getElementById('change-password-btn');
        if (changePwdBtn && !changePwdBtn.dataset.wired) {
            changePwdBtn.dataset.wired = '1';
            changePwdBtn.addEventListener('click', () => {
                if (isCurrentUserAdmin()) {
                    openAdminRoute(true);
                    const credEl = document.getElementById('admin-cred-username');
                    if (credEl) setTimeout(() => credEl.focus(), 60);
                } else {
                    notify('Only Admins can change credentials in /admin.', 'error');
                }
            });
        }

        const settingsPwdBtn = document.getElementById('settings-open-password-btn');
        if (settingsPwdBtn && !settingsPwdBtn.dataset.wired) {
            settingsPwdBtn.dataset.wired = '1';
            settingsPwdBtn.addEventListener('click', () => {
                const sm = document.getElementById('settings-modal');
                if (sm) sm.classList.add('hidden');
                if (isCurrentUserAdmin()) {
                    openAdminRoute(true);
                } else {
                    notify('Only Admins can change credentials in /admin.', 'error');
                }
            });
        }

        // Admin forms & filters
        const addUserForm = document.getElementById('admin-add-user-form');
        if (addUserForm && !addUserForm.dataset.wired) {
            addUserForm.dataset.wired = '1';
            addUserForm.addEventListener('submit', handleAddUserSubmit);
        }

        const credForm = document.getElementById('admin-credentials-form');
        if (credForm && !credForm.dataset.wired) {
            credForm.dataset.wired = '1';
            credForm.addEventListener('submit', handleCredentialsSaveSubmit);
        }

        const swForm = document.getElementById('admin-software-form');
        if (swForm && !swForm.dataset.wired) {
            swForm.dataset.wired = '1';
            swForm.addEventListener('submit', handleSoftwareConfigSubmit);
        }

        const usersTbody = document.getElementById('admin-users-tbody');
        if (usersTbody && !usersTbody.dataset.wired) {
            usersTbody.dataset.wired = '1';
            usersTbody.addEventListener('change', (e) => {
                if (e.target.matches('select[data-action="role"]')) {
                    handleAdminTableAction(e.target);
                }
            });
            usersTbody.addEventListener('click', (e) => {
                if (e.target.closest('button[data-action]')) {
                    handleAdminTableAction(e.target);
                }
            });
        }

        const searchEl = document.getElementById('admin-users-search');
        const roleFilterEl = document.getElementById('admin-users-role-filter');
        if (searchEl && !searchEl.dataset.wired) {
            searchEl.dataset.wired = '1';
            searchEl.addEventListener('input', renderAdminUsersTable);
        }
        if (roleFilterEl && !roleFilterEl.dataset.wired) {
            roleFilterEl.dataset.wired = '1';
            roleFilterEl.addEventListener('change', renderAdminUsersTable);
        }

        window.addEventListener('popstate', () => {
            if (!currentSession || !currentSession.loggedIn) return;
            if (window.location.pathname === '/admin') {
                openAdminRoute(false);
            } else {
                const overviewBtn = document.getElementById('tab-overview');
                if (overviewBtn) overviewBtn.click();
            }
        });
    }

    function initAuthAndAdmin() {
        if (isBootstrapped) return;
        isBootstrapped = true;

        loadCachedState();
        applySoftwareConfigToUI();
        refreshLoginMethodAvailability();
        wireDOMEvents();

        const urlParams = new URLSearchParams(window.location.search);
        const isFullscreenChart = urlParams.get('fullscreenChart') === '1';

        if (window.location.pathname === '/admin') {
            const adminBanner = document.getElementById('login-admin-notice');
            if (adminBanner) adminBanner.classList.remove('hidden');
        }

        if (!isFullscreenChart && currentSession && currentSession.loggedIn) {
            unlockTerminal({ openAdminIfRequested: true });
        }

        // Background sync with Firestore & Firebase Auth state verification
        syncFromFirestore(5000).then(() => {
            if (currentSession && currentSession.loggedIn && currentSession.authMode === 'google') {
                const email = normalizeEmail(currentSession.email);
                const entry = accessControlMap[email];
                if (!entry || entry.active === false) {
                    signOutUser();
                } else {
                    currentSession.role = entry.role;
                    persistSession(currentSession);
                    updateAccountUI();
                    if (window.location.pathname === '/admin') {
                        renderAdminConsole();
                    }
                }
            }
        });

        const { auth } = getFirebaseServices();
        if (auth && typeof auth.onAuthStateChanged === 'function') {
            auth.onAuthStateChanged((fbUser) => {
                if (fbUser && fbUser.email && currentSession && currentSession.authMode === 'google') {
                    const email = normalizeEmail(fbUser.email);
                    const entry = accessControlMap[email];
                    if (entry && entry.active !== false) {
                        currentSession.email = email;
                        currentSession.role = entry.role;
                        currentSession.displayName = fbUser.displayName || currentSession.displayName;
                        currentSession.photoURL = fbUser.photoURL || currentSession.photoURL;
                        persistSession(currentSession);
                        updateAccountUI();
                    }
                }
            });
        }
    }

    window.RfAuthAdmin = {
        init: initAuthAndAdmin,
        isAdmin: isCurrentUserAdmin,
        getRole: getCurrentRole,
        canMutateCloud: () => getCurrentRole() !== 'viewer',
        openAdminRoute,
        leaveAdminUrlIfActive,
        signOut: signOutUser,
        getSeedAdmins: () => [...SEED_ADMIN_EMAILS]
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initAuthAndAdmin);
    } else {
        setTimeout(initAuthAndAdmin, 0);
    }
})();
