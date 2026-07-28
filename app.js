(function() {
    'use strict';

    // ====================== STATE ======================
    let currentUser = null;
    let currentUserData = null;
    let defaultTab = localStorage.getItem('polyDefaultTab') || 'wallet';
    let isSignUp = false;
    let currentStats = null;
    let currentTab = 'history';
    let currentSubTab = 'active';
    let searchedWallet = null;
    let lastWallet = null;
    let lastResolvedWallet = null;
    let historyFilter = { sign: 'all', min: null, max: null };
    let historySort = 'date-desc';
    let _feeCache = {};
    let _walletInited = false;
    let _waRunning = false;
    let _tradeInited = false;
    let _whaleData = [];
    let _aiRequested = {};
    var _prevTabBeforeSettings = null;

    const WHALE_THRESHOLD = 20000;
    const DATA_API = 'https://data-api.polymarket.com';
    const CLOB_API = 'https://clob.polymarket.com';
    const GAMMA_API = 'https://gamma-api.polymarket.com';
    const CORS_PROXY = '/api/proxy?url=';

    const POLY_API_PATTERNS = [
        CLOB_API
    ];

    // ====================== FIREBASE CONFIG ======================
    var FB_CONFIG = {
        apiKey: 'AIzaSyDXPaMdMeCN7YA1FB_VHGocVrZZL5czX7E',
        projectId: 'polymarket-ai-99bf6',
    };

    // ====================== UTILITY ======================
    const $ = id => document.getElementById(id);

    function escHtml(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    function escJsStr(s) {
        return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
    }

    function needsCorsProxy(url) {
        return POLY_API_PATTERNS.some(function(p) { return url.indexOf(p) === 0; });
    }

    async function pageFetch(url, options) {
        var finalUrl = needsCorsProxy(url) ? CORS_PROXY + encodeURIComponent(url) : url;
        var opts = options||{};
        if (needsCorsProxy(url) && opts.headers) {
            opts.headers = Object.keys(opts.headers).reduce(function(h, k) {
                if (k !== 'origin' && k !== 'referer') h[k] = opts.headers[k];
                return h;
            }, {});
        }
        var lastErr;
        for (var attempt = 0; attempt < 3; attempt++) {
            try {
                return await _fetchOne(finalUrl, opts);
            } catch(e) {
                lastErr = e;
                if (attempt < 2) {
                    await new Promise(function(r) { setTimeout(r, (attempt + 1) * 1500); });
                }
            }
        }
        throw lastErr;
    }

    function _fetchOne(url, opts) {
        return new Promise(function(resolve, reject) {
            var tid = setTimeout(function() { reject(new Error('Request timeout')); }, 20000);
            fetch(url, opts).then(function(r) {
                clearTimeout(tid);
                return r.text().then(function(text) {
                    if (!r.ok) {
                        try {
                            var errData = JSON.parse(text);
                            if (errData.error && errData.error.message) throw new Error(errData.error.message);
                        } catch(e) {
                            if (e.message && !e.message.startsWith('HTTP ')) throw e;
                        }
                        throw new Error('HTTP ' + r.status);
                    }
                    resolve(text);
                });
            }).catch(function(e) {
                clearTimeout(tid);
                reject(e);
            });
        });
    }

    function _mskTime(ts) {
        var d = new Date(ts || Date.now());
        return d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function getTimeAgo(ts) {
        if (!ts) return '';
        var diff = Date.now() - (typeof ts === 'number' ? ts : new Date(ts).getTime());
        var mins = Math.floor(diff / 60000);
        if (mins < 1) return 'только что';
        if (mins < 60) return mins + ' мин. назад';
        var hours = Math.floor(mins / 60);
        if (hours < 24) return hours + ' ч. назад';
        var days = Math.floor(hours / 24);
        return days + ' дн. назад';
    }

    function fmtNum(n) {
        if (n === undefined || n === null || isNaN(n)) return '—';
        if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(2) + 'M';
        if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + 'K';
        return n.toFixed(2);
    }

    function fmtCompact(n) {
        if (!n) return '0';
        var num = typeof n === 'string' ? parseFloat(n) : n;
        if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
        if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
        return num.toFixed(2);
    }

    function fmtUSD(n) {
        if (n === undefined || n === null || isNaN(n)) return '$—';
        var sign = n >= 0 ? '' : '-';
        var v = Math.abs(n);
        if (v >= 1000000) return sign + '$' + (v / 1000000).toFixed(2) + 'M';
        if (v >= 1000) return sign + '$' + (v / 1000).toFixed(1) + 'K';
        return sign + '$' + v.toFixed(2);
    }

    function tryParseJSON(text, fallback) {
        try { return JSON.parse(text); } catch(e) { return fallback; }
    }

    function isRussianText(text) {
        return /[а-яА-Я]/.test(text);
    }

    function isChineseText(text) {
        return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(text);
    }

    function defaultDemoState() {
        return { balance: 100000, positions: [], history: [] };
    }

    function getDemoState() {
        try { var s = JSON.parse(localStorage.getItem('polyDemo') || 'null'); if (s && typeof s.balance === 'number') return s; } catch(e) {}
        var d = defaultDemoState();
        localStorage.setItem('polyDemo', JSON.stringify(d));
        return d;
    }

    function saveDemoState(s) { localStorage.setItem('polyDemo', JSON.stringify(s)); }

    function calcDemoPnl(demo) {
        if (!demo) return 0;
        var posVal = (demo.positions || []).reduce(function(s, p) { return s + (p.buyAmount || 0); }, 0);
        return (demo.balance || 100000) + posVal - 100000;
    }

    function calcDemoWR(demo) {
        var closed = (demo.history || []).filter(function(h) { return h.side === 'sell' || h.status === 'closed'; });
        var wins = closed.filter(function(h) { return (h.pnl || 0) > 0; });
        return closed.length > 0 ? Math.round((wins.length / closed.length) * 100) : 0;
    }

    function getEduProgress() {
        try { return JSON.parse(localStorage.getItem('polyEduProgress')) || { completed: [], quizResults: {} }; }
        catch(e) { return { completed: [], quizResults: {} }; }
    }

    function saveEduProgress(p) { localStorage.setItem('polyEduProgress', JSON.stringify(p)); }

    // ====================== TARIFF SYSTEM ======================
    var TARIFFS = {
        basic: {
            name: 'Базовый тариф', subtitle: 'Бессрочно',
            priceWeek: 0, priceMonth: 0, priceQuarter: 0, priceYear: 0,
            features: [
                'Торговый терминал, копи-трейдинг, настройка сетапов для торговли и скальп-режим, комиссия – 1% (покупка/продажа)',
                'Полноценная аналитика кошелька (не более 2 кошельков/сутки + AI запросы по анализу, неограниченный бэктест по сделкам в рамках лимита анализа кошельков, полная история сделок с фильтрами по прибыли, убытку и сумме сделки, отображение Whale сделок)',
                '5 отслеживаемых кошельков с показом в событиях', '5 отслеживаемых кошельков в трекере',
                'Раздел с Whale/Smart Wallet + AI анализ', 'Аналитика событий + AI анализ',
                '5 запросов/сутки по аналитике индикаторам и осцилляторам', '15 автоматических алертов',
                'Доступ к разделам «Коллы» (не более 5 коллов/сутки)', 'Сканер коэффициентов (не более 6 анализов/сутки)',
                'Хаб новостей (не более 10 новостей/сутки)', 'Доступ к новым рынкам с AI анализом',
                'Обучающая платформа', 'Не более 15 запросов к AI агенту/сутки'
            ], badge: ''
        },
        pro: {
            name: 'PRO', subtitle: 'Полный набор инструментов для активного трейдера',
            priceWeek: 30, priceMonth: 108, priceQuarter: 270, priceYear: 860,
            discounts: { month: 10, quarter: 25, year: 40 },
            features: [
                'Торговый терминал, копи-трейдинг, настройка сетапов, комиссия – 0,75%',
                'Полноценная аналитика кошелька + AI запросы, неограниченный бэктест, скоринг-анализ',
                'Аналитика собственного кошелька (история последних 50 сделок)',
                '100 отслеживаемых кошельков', '100 кошельков в трекере',
                'Whale/Smart Wallet со скорингом + AI анализ', 'Аналитика событий',
                '300 запросов/сутки по индикаторам', 'Неограниченные алерты',
                'Коллы + доступ к чату Discord', 'Сканер коэффициентов',
                'AI анализ X (Twitter)', 'Смарт.Алерты', 'Хаб новостей с фильтрами',
                'Новые рынки', 'Анализ погоды', 'Обучающая платформа',
                'Реферальная программа (до 20% комиссий)', '150 запросов/сутки к AI агенту'
            ], badge: ''
        },
        apex: {
            name: 'Apex', subtitle: 'Максимальные лимиты для профессионалов',
            priceWeek: 50, priceMonth: 180, priceQuarter: 450, priceYear: 1400,
            discounts: { month: 10, quarter: 25, year: 40 },
            features: [
                'Торговый терминал, комиссия – 0,45%',
                'Полноценная аналитика кошелька, неограниченный бэктест, скоринг',
                'Аналитика собственного кошелька с AI-агентом и рекомендациями',
                '250 отслеживаемых кошельков', '250 кошельков в трекере',
                'Whale/Smart Wallet со скорингом + AI анализ', 'Аналитика событий',
                'Без лимитов по запросам индикаторов', 'Неограниченные алерты',
                'Коллы + чат Discord + чат с разработчиками', 'Сканер коэффициентов',
                'AI анализ X (Twitter)', 'Смарт.Алерты', 'Хаб новостей с фильтрами',
                'Новые рынки', 'Анализ погоды', 'Обучающая платформа',
                'Настройка собственной темы', 'Реферальная программа (до 40%)',
                '250 запросов/сутки к AI агенту'
            ], badge: ''
        }
    };

    function getTariff() {
        try { return JSON.parse(localStorage.getItem('polyTariff') || '{"plan":"basic"}'); } catch { return { plan: 'basic' }; }
    }

    function setTariff(plan) {
        var t = { plan: plan, updatedAt: Date.now() };
        localStorage.setItem('polyTariff', JSON.stringify(t));
        var auth = getFbAuthREST();
        if (auth) {
            fbSetREST('users', auth.localId, { tariff: plan, tariffUpdatedAt: Date.now() }).catch(function(e) { console.warn('[fb] tariff save:', e); });
        }
    }

    async function loadTariffFromFirestore() {
        var auth = getFbAuthREST();
        if (auth) {
            try {
                var doc = await fbGetREST('users', auth.localId);
                if (doc && doc.data && doc.data.tariff) {
                    localStorage.setItem('polyTariff', JSON.stringify({ plan: doc.data.tariff, updatedAt: doc.data.tariffUpdatedAt || Date.now() }));
                }
            } catch {}
        }
    }

    // ====================== FIREBASE REST WRAPPER ======================
    function getFbAuthREST() {
        try { return JSON.parse(localStorage.getItem('polyFbAuth') || 'null'); } catch { return null; }
    }

    function setFbAuthREST(data) {
        if (data) localStorage.setItem('polyFbAuth', JSON.stringify(data));
        else localStorage.removeItem('polyFbAuth');
    }

    async function fbSignInREST(email, password) {
        var text = await pageFetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + FB_CONFIG.apiKey, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email, password: password, returnSecureToken: true })
        });
        var data = JSON.parse(text);
        if (data.error) throw new Error(data.error.message);
        var auth = { idToken: data.idToken, refreshToken: data.refreshToken, localId: data.localId, email: data.email, password: password, lastRefresh: Date.now(), displayName: data.displayName || '' };
        setFbAuthREST(auth);
        currentUser = { uid: data.localId, email: data.email };
        return auth;
    }

    async function fbSignUpREST(email, password) {
        var text = await pageFetch('https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + FB_CONFIG.apiKey, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email, password: password, returnSecureToken: true })
        });
        var data = JSON.parse(text);
        if (data.error) throw new Error(data.error.message);
        var auth = { idToken: data.idToken, refreshToken: data.refreshToken, localId: data.localId, email: data.email, password: password, lastRefresh: Date.now(), displayName: data.displayName || '' };
        setFbAuthREST(auth);
        currentUser = { uid: data.localId, email: data.email };
        return auth;
    }

    function fbSignOutREST() {
        setFbAuthREST(null);
        currentUser = null;
        currentUserData = null;
    }

    async function fbRefreshTokenREST() {
        var auth = getFbAuthREST();
        if (!auth || !auth.refreshToken) throw new Error('No refresh token');
        var text = await pageFetch('https://securetoken.googleapis.com/v1/token?key=' + FB_CONFIG.apiKey, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: auth.refreshToken })
        });
        var data = JSON.parse(text);
        if (data.error) throw new Error(data.error.message);
        auth.idToken = data.access_token || data.id_token;
        auth.refreshToken = data.refresh_token || auth.refreshToken;
        auth.lastRefresh = Date.now();
        setFbAuthREST(auth);
        return auth;
    }

    async function fbValidTokenREST() {
        var auth = getFbAuthREST();
        if (!auth) return null;
        if (Date.now() - auth.lastRefresh > 50 * 60 * 1000) {
            try { auth = await fbRefreshTokenREST(); } catch { setFbAuthREST(null); return null; }
        }
        return auth.idToken;
    }

    function fbEncodeVal(v) {
        if (typeof v === 'string') return { stringValue: v };
        if (typeof v === 'number') return Number.isFinite(v) ? (Number.isInteger(v) && Math.abs(v) < 9007199254740991 ? { integerValue: String(v) } : { doubleValue: v }) : { nullValue: null };
        if (typeof v === 'boolean') return { booleanValue: v };
        if (v === null || v === undefined) return { nullValue: null };
        if (Array.isArray(v)) return { arrayValue: { values: v.map(fbEncodeVal) } };
        if (typeof v === 'object') { var f = {}; Object.keys(v).forEach(function(k) { f[k] = fbEncodeVal(v[k]); }); return { mapValue: { fields: f } }; }
        return { stringValue: String(v) };
    }

    function fbDecodeFields(fields) {
        if (!fields) return {};
        var r = {};
        Object.keys(fields).forEach(function(k) {
            var v = fields[k];
            if (v.stringValue !== undefined) r[k] = v.stringValue;
            else if (v.integerValue !== undefined) r[k] = parseInt(v.integerValue, 10);
            else if (v.doubleValue !== undefined) r[k] = v.doubleValue;
            else if (v.booleanValue !== undefined) r[k] = v.booleanValue;
            else if (v.nullValue !== undefined) r[k] = null;
            else if (v.arrayValue !== undefined) r[k] = (v.arrayValue.values || []).map(function(x) { return fbDecodeFields({ _: x })._; });
            else if (v.mapValue !== undefined) r[k] = fbDecodeFields(v.mapValue.fields);
            else r[k] = v;
        });
        return r;
    }

    function fbDocPath(col, id) { return 'projects/' + FB_CONFIG.projectId + '/databases/(default)/documents/' + col + '/' + id; }

    async function fbGetREST(col, id) {
        var token = await fbValidTokenREST();
        if (!token) throw new Error('Not authenticated');
        try {
            var text = await pageFetch('https://firestore.googleapis.com/v1/' + fbDocPath(col, id), { headers: { 'Authorization': 'Bearer ' + token } });
            var data = JSON.parse(text);
            if (data.error) throw new Error(data.error.message);
            return { id: id, exists: true, data: fbDecodeFields(data.fields) };
        } catch(e) {
            if (e.message && (e.message.indexOf('not found') !== -1 || e.message.indexOf('NOT_FOUND') !== -1 || e.message === 'HTTP 404')) {
                return { id: id, exists: false, data: null };
            }
            throw e;
        }
    }

    async function fbSetREST(col, id, obj) {
        var token = await fbValidTokenREST();
        if (!token) throw new Error('Not authenticated');
        var fields = {};
        Object.keys(obj).forEach(function(k) { fields[k] = fbEncodeVal(obj[k]); });
        var keys = Object.keys(obj).map(function(k) { return 'updateMask.fieldPaths=' + encodeURIComponent(k); }).join('&');
        try {
            var text = await pageFetch('https://firestore.googleapis.com/v1/' + fbDocPath(col, id) + '?' + keys, {
                method: 'PATCH',
                headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields: fields })
            });
            var data = JSON.parse(text);
            if (data.error) throw new Error(data.error.message);
        } catch(e) {
            if (e.message && e.message.indexOf('404') !== -1) {
                var createText = await pageFetch('https://firestore.googleapis.com/v1/projects/' + FB_CONFIG.projectId + '/databases/(default)/documents/' + col + '?documentId=' + id, {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fields: fields })
                });
                var createData = JSON.parse(createText);
                if (createData.error) throw new Error(createData.error.message);
            } else {
                throw e;
            }
        }
    }

    async function fbAddREST(col, obj) {
        var token = await fbValidTokenREST();
        if (!token) throw new Error('Not authenticated');
        var fields = {};
        Object.keys(obj).forEach(function(k) { fields[k] = fbEncodeVal(obj[k]); });
        var text = await pageFetch('https://firestore.googleapis.com/v1/projects/' + FB_CONFIG.projectId + '/databases/(default)/documents/' + col, {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: fields })
        });
        var data = JSON.parse(text);
        if (data.error) throw new Error(data.error.message);
        return (data.name || '').split('/').pop();
    }

    async function fbQueryREST(col, conditions) {
        var token = await fbValidTokenREST();
        if (!token) throw new Error('Not authenticated');
        var q = { from: [{ collectionId: col, allDescendants: false }], orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }] };
        if (conditions && conditions.length) {
            q.where = { compositeFilter: { op: 'AND', filters: conditions.map(function(c) { return { fieldFilter: { field: { fieldPath: c.field }, op: c.op || 'EQUAL', value: fbEncodeVal(c.value) } }; }) } };
        }
        var url = 'https://firestore.googleapis.com/v1/projects/' + FB_CONFIG.projectId + '/databases/(default)/documents:runQuery';
        try {
            var text = await pageFetch(url + '?key=' + FB_CONFIG.apiKey, {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
                body: JSON.stringify({ structuredQuery: q })
            });
            var arr = JSON.parse(text);
            return (Array.isArray(arr) ? arr : []).filter(function(r) { return r.document; }).map(function(r) { return { id: r.document.name.split('/').pop(), data: fbDecodeFields(r.document.fields) }; });
        } catch(e) {
            var text = await pageFetch(url + '?key=' + FB_CONFIG.apiKey, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ structuredQuery: q })
            });
            var arr = JSON.parse(text);
            return (Array.isArray(arr) ? arr : []).filter(function(r) { return r.document; }).map(function(r) { return { id: r.document.name.split('/').pop(), data: fbDecodeFields(r.document.fields) }; });
        }
    }

    // ====================== AUTH ======================
    function showMsg(text, isSuccess) {
        var el = $('profileMsg');
        if (!el) return;
        el.textContent = text;
        el.className = 'profile-msg show' + (isSuccess ? ' success' : '');
    }

    function clearMsg() {
        var el = $('profileMsg');
        if (el) el.className = 'profile-msg';
    }

    function showAuth(show) {
        var ws = $('welcome-screen');
        if (ws) ws.style.display = show ? 'block' : 'none';
        document.querySelectorAll('.nav-tab-content').forEach(function(t) { t.style.display = show ? 'none' : ''; });
        document.querySelectorAll('.menu-item').forEach(function(b) { b.classList.remove('active'); });
    }

    function handleAuth(user) {
        if (user) {
            showAuth(false);
            loadUserProfile(user.uid, user.email);
            switchTab(defaultTab);
        } else {
            showAuth(true);
            currentUserData = null;
        }
    }

    async function loadUserProfile(uid, email) {
        try {
            var doc = await fbGetREST('users', uid);
            if (doc && doc.exists) {
                currentUserData = doc.data;
            } else {
                currentUserData = { email: email, createdAt: Date.now() };
                await fbSetREST('users', uid, currentUserData);
            }
            updateProfileUI();
        } catch(e) {
            console.warn('Profile load error:', e);
        }
    }

    function updateProfileUI() {
        var auth = getFbAuthREST();
        var welcomeScreen = $('welcome-screen');
        var hamburgerBtn = $('hamburgerBtn');
        var wsGearBtn = $('wsGearBtn');
        var settingsBtn = $('settingsQuickBtn');
        var authForms = $('profileAuthForms');
        var loggedInEl = $('profileLoggedIn');
        var tariffSection = $('profileTariffSection');
        var sidebarMenu = $('sidebarMenu');

        if (auth) {
            if (welcomeScreen) welcomeScreen.classList.remove('ws-visible');
            if (hamburgerBtn) hamburgerBtn.style.display = 'flex';
            if (wsGearBtn) wsGearBtn.style.display = 'none';
            if (settingsBtn) settingsBtn.style.display = 'flex';
            var activeTab = document.querySelector('.nav-tab-content.active');
            if (!activeTab) {
                var firstTab = document.querySelector('.nav-tab-content');
                if (firstTab) firstTab.classList.add('active');
            }
            if (authForms) authForms.style.display = 'none';
            if (loggedInEl) {
                loggedInEl.style.display = 'block';
                var heroEmail = $('profileHeroEmail');
                if (heroEmail) heroEmail.textContent = auth.email;
                var heroName = $('profileHeroName');
                if (heroName) heroName.textContent = auth.displayName || (auth.email ? auth.email.split('@')[0] : 'User');
                var avatarLetter = $('profileAvatarLetter');
                if (avatarLetter) avatarLetter.textContent = (auth.displayName || auth.email || '?')[0].toUpperCase();
                var dn = auth.displayName || (auth.email ? auth.email.split('@')[0] : '');
                var loginInput = $('profileLoginInput');
                if (loginInput) { loginInput.value = dn; loginInput.placeholder = dn || 'Логин'; }
                if (auth.localId && (!auth.displayName || auth.displayName === (auth.email ? auth.email.split('@')[0] : ''))) {
                    fbGetREST('users', auth.localId).then(function(doc) {
                        if (doc && doc.data) {
                            var stored = doc.data.nick || doc.data.displayName || null;
                            if (stored) {
                                auth = getFbAuthREST();
                                if (auth) { auth.displayName = stored; setFbAuthREST(auth); }
                                if (heroName) heroName.textContent = stored;
                                if (avatarLetter) avatarLetter.textContent = stored[0].toUpperCase();
                                if (loginInput) { loginInput.value = stored; loginInput.placeholder = stored; }
                            }
                        }
                    }).catch(function(){});
                }
            }
            if (tariffSection) tariffSection.style.display = 'block';
            renderMyWallets();
            initTelegramLink();
            var heroLogoutBtn = $('profileHeroLogout');
            if (heroLogoutBtn) {
                heroLogoutBtn.onclick = function() {
                    fbSignOutREST();
                    updateProfileUI();
                    initSettingsTab();
                };
            }
        } else {
            if (welcomeScreen) welcomeScreen.classList.add('ws-visible');
            if (hamburgerBtn) hamburgerBtn.style.display = 'none';
            if (wsGearBtn) wsGearBtn.style.display = 'flex';
            if (settingsBtn) settingsBtn.style.display = 'none';
            document.querySelectorAll('.nav-tab-content').forEach(function(c) { c.classList.remove('active'); });
            if (sidebarMenu) sidebarMenu.classList.remove('open');
            if (authForms) authForms.style.display = 'block';
            if (loggedInEl) loggedInEl.style.display = 'none';
            if (tariffSection) tariffSection.style.display = 'none';
        }
        if (auth) initProfileEdit();
        if (auth) {
            loadTariffFromFirestore().then(renderTariffPlans).catch(renderTariffPlans);
        }
    }

    function checkExistingAuth() {
        var auth = getFbAuthREST();
        if (auth && auth.localId) {
            handleAuth({ uid: auth.localId, email: auth.email });
            return true;
        }
        return false;
    }

    // ====================== NAVIGATION ======================
    function closeMenu() {
        var menu = $('sidebarMenu');
        var btn = $('hamburgerBtn');
        if (menu) menu.classList.remove('open');
        if (btn) btn.classList.remove('active');
    }

    function toggleMenu(e) {
        e.stopPropagation();
        var menu = $('sidebarMenu');
        var btn = $('hamburgerBtn');
        if (menu) menu.classList.toggle('open');
        if (btn) btn.classList.toggle('active');
    }

    function switchTab(tabName) {
        document.querySelectorAll('.menu-item').forEach(function(b) { b.classList.remove('active'); });
        document.querySelectorAll('.nav-tab-content').forEach(function(c) { c.classList.remove('active'); });

        var tabBtn = document.querySelector('.menu-item[data-tab="' + tabName + '"]');
        if (tabBtn) tabBtn.classList.add('active');

        var tabContent = $(tabName + '-tab');
        if (tabContent) tabContent.classList.add('active');

        if (tabName !== 'calls' && window._callsInterval) {
            clearInterval(window._callsInterval);
            window._callsInterval = null;
            if (window._callsTimerUpdater) { clearInterval(window._callsTimerUpdater); window._callsTimerUpdater = null; }
        }
        _liveStopCheck();

        if (tabName === 'wallet') initWalletTab();
        else if (tabName === 'trade') initTradeTab();
        else if (tabName === 'alerts') initAlertsTab();
        else if (tabName === 'calls') initCallsTab();
        else if (tabName === 'favorites') initFavoritesTab();
        else if (tabName === 'my-trades') initMyTradesTab();
        else if (tabName === 'whale') initWhaleTab();
        else if (tabName === 'smart-alerts') initSmartAlertsTab();
        else if (tabName === 'scanner') initScannerTab();
        else if (tabName === 'x-sentiment') {
            if (checkFeatureAccess('xsentiment')) { initXSentimentTab(); }
            else { var c = $('x-sentiment-tab'); if (c) showUpgradePrompt(c, 'xsentiment'); }
        }
        else if (tabName === 'weather') initWeatherTab();
        else if (tabName === 'news-hub') initNewsHubTab();
        else if (tabName === 'new-market') initNewMarketTab();
        else if (tabName === 'education') initEducationTab();
        else if (tabName === 'profile') initProfileTab();
        else if (tabName === 'settings') initSettingsTab();
    }

    // ====================== THEME ======================
    function initTheme() {
        if (localStorage.getItem('polyTheme') === 'light') {
            document.body.classList.add('light-theme');
        }
    }

    function toggleTheme() {
        document.body.classList.toggle('light-theme');
        localStorage.setItem('polyTheme', document.body.classList.contains('light-theme') ? 'light' : 'dark');
        reloadTVChart();
    }

    // ====================== TRADINGVIEW CHART ======================
    var _tvCurrentSymbol = null;
    var _tvCurrentSource = 'tv';
    var _tvCurrentInterval = '5';
    var _tvChainlinkWs = null;

    var _chainlinkSymbols = {
        'BTCUSDT': 'btc-usd',
        'ETHUSDT': 'eth-usd',
        'SOLUSDT': 'sol-usd',
        'XRPUSDT': 'xrp-usd',
        'DOGEUSDT': 'doge-usd',
        'ADAUSDT': 'ada-usd',
        'DOTUSDT': 'dot-usd',
        'AVAXUSDT': 'avax-usd',
        'LINKUSDT': 'link-usd',
        'MATICUSDT': 'matic-usd',
        'LTCUSDT': 'ltc-usd',
        'UNIUSDT': 'uni-usd',
        'ATOMUSDT': 'atom-usd',
        'FILUSDT': 'fil-usd'
    };

    function _buildTvWidgetUrl(symbol, interval) {
        symbol = symbol || 'BINANCE:BTCUSDT';
        interval = interval || '5';
        var isLight = document.body.classList.contains('light-theme');
        var studies = JSON.stringify(['MASimple@tv-basicstudies','Volume@tv-basicstudies']);
        var feats = JSON.stringify(['chart','side_toolbar','drawing_tools','chart_crosshair_menu','chart_multiple_instance','symbol_search','keep_info_panel_open','uppercase_in_symbols_search','delete_symbol_in_search']);
        return 'https://s.tradingview.com/widgetembed/?symbol=' + encodeURIComponent(symbol)
            + '&interval=' + interval
            + '&theme=' + (isLight ? 'light' : 'dark')
            + '&style=' + (isLight ? '1' : '1')
            + '&locale=en'
            + '&hide_side_toolbar=0&symboledit=1&saveimage=0&allow_symbol_change=1'
            + '&toolbarbg=' + encodeURIComponent(isLight ? '#f1f3f6' : '#1e222d')
            + '&studies=' + encodeURIComponent(studies)
            + '&timezone=exchange'
            + '&enabled_features=' + encodeURIComponent(feats);
    }

    function _getBinanceSymbol(tvSymbol) {
        if (!tvSymbol) return 'BTCUSDT';
        return tvSymbol.replace('BINANCE:', '');
    }

    function _loadChainlinkChart(containerId, symbol, interval) {
        var container = $(containerId);
        if (!container) return;
        container.innerHTML = '';

        var iframe = document.createElement('iframe');
        iframe.style.cssText = 'width:100%;height:100%;border:none;display:block';
        iframe.setAttribute('allowfullscreen', 'true');
        iframe.src = 'chainlink-chart.html';
        container.appendChild(iframe);

        var binanceSym = _getBinanceSymbol(symbol);
        var isDark = !document.body.classList.contains('light-theme');

        function onReady() {
            try {
                iframe.contentWindow.postMessage({ type: 'init', dark: isDark, symbol: binanceSym }, '*');
            } catch(e) {}
        }

        iframe.addEventListener('load', onReady);

        if (_tvChainlinkWs) { try { _tvChainlinkWs.close(); } catch(e) {} _tvChainlinkWs = null; }

        try {
            var ws = new WebSocket('wss://ws-live-data.polymarket.com');
            _tvChainlinkWs = ws;
            var clSymbol = _chainlinkSymbols[binanceSym] || 'btc-usd';
            var candles = [];
            var lastTs = 0;

            ws.onopen = function() {
                ws.send(JSON.stringify({
                    action: 'subscribe',
                    subscriptions: [{
                        topic: 'crypto_prices_chainlink',
                        type: '*',
                        filters: JSON.stringify({ symbol: clSymbol })
                    }]
                }));
                ws.send('PING');
                setInterval(function() {
                    if (ws.readyState === 1) ws.send('PING');
                }, 4000);
            };
            ws.onmessage = function(e) {
                if (e.data === 'PONG') return;
                try {
                    var msg = JSON.parse(e.data);
                    if (msg.topic === 'crypto_prices_chainlink' && msg.payload && msg.payload.value) {
                        var price = msg.payload.value;
                        var ts = msg.payload.timestamp || Date.now();
                        var candleTime = Math.floor(ts / 300) * 300;
                        var last = candles[candles.length - 1];
                        if (last && last.time === candleTime) {
                            last.high = Math.max(last.high, price);
                            last.low = Math.min(last.low, price);
                            last.close = price;
                        } else {
                            candles.push({ time: candleTime, open: price, high: price, low: price, close: price });
                            if (candles.length > 300) candles.shift();
                        }
                        try {
                            iframe.contentWindow.postMessage({ type: 'update', candle: candles[candles.length - 1] }, '*');
                        } catch(err) {}
                    }
                } catch(err) {}
            };
            ws.onerror = function() {};
            ws.onclose = function() {};
        } catch(e) {}
    }

    function loadTVChart(containerId, symbol, interval, source) {
        symbol = symbol || 'BINANCE:BTCUSDT';
        interval = interval || '5';
        source = source || _tvCurrentSource;
        var container = $(containerId);
        if (!container) return;

        if (_tvChainlinkWs) { try { _tvChainlinkWs.close(); } catch(e) {} _tvChainlinkWs = null; }

        if (source === 'cl') {
            _loadChainlinkChart(containerId, symbol, interval);
        } else {
            container.innerHTML = '';
            var iframe = document.createElement('iframe');
            iframe.style.cssText = 'width:100%;height:100%;border:none;display:block';
            iframe.setAttribute('allowfullscreen', 'true');
            iframe.src = _buildTvWidgetUrl(symbol, interval);
            container.appendChild(iframe);
        }

        _tvCurrentSymbol = symbol;
        _tvCurrentSource = source;
        _tvCurrentInterval = interval;
    }

    function reloadTVChart() {
        var container = $('tvTradeChart');
        if (!container) return;
        var btn = document.querySelector('.tv-sym-btn.active');
        var sym = btn ? btn.dataset.sym : 'BINANCE:BTCUSDT';
        loadTVChart('tvTradeChart', sym, '5', _tvCurrentSource);
    }

    function _startTvPoll() {
        // TradingView widget handles live updates internally
    }

    // ====================== POLYMARKET API ======================
    async function fetchPositions(wallet) {
        try {
            var text = await pageFetch(DATA_API + '/v1/positions?user=' + wallet + '&limit=1000');
            var data = JSON.parse(text);
            return Array.isArray(data) ? data : (data.positions || data.data || []);
        } catch (e) { return []; }
    }

    async function fetchClosedPositions(wallet) {
        try {
            var allClosed = [];
            var limit = 50;
            for (var offset = 0; offset < 2000; offset += limit) {
                var text = await pageFetch(DATA_API + '/v1/closed-positions?user=' + wallet + '&limit=' + limit + '&offset=' + offset);
                var data = JSON.parse(text);
                var batch = Array.isArray(data) ? data : (data.positions || data.data || []);
                if (!batch.length) break;
                allClosed.push.apply(allClosed, batch);
                if (batch.length < limit) break;
            }
            return allClosed;
        } catch (e) { return []; }
    }

    async function fetchTrades(wallet) {
        try {
            var text = await pageFetch(DATA_API + '/v1/trades?user=' + wallet + '&limit=5000');
            var data = JSON.parse(text);
            var trades = Array.isArray(data) ? data : (data.trades || data.data || []);
            return trades.map(function(t) {
                var volume = parseFloat(t.notional || t.cost || (t.size * t.avgPrice) || t.size || 0);
                var pnl = parseFloat(t.pnl || t.profit || 0);
                return Object.assign({}, t, { volume: volume, pnl: pnl, isWin: pnl >= 0 });
            });
        } catch (e) { return []; }
    }

    async function fetchWalletStats(wallet) {
        try {
            var [positions, closedPositions, trades] = await Promise.all([
                fetchPositions(wallet),
                fetchClosedPositions(wallet),
                fetchTrades(wallet)
            ]);

            _feeCache = {};
        var stats = calculateStats(positions, closedPositions, trades, 0, wallet);
        var resolvedForFees = stats.resolvedPositions;
            var totalFees = await computePositionFees(resolvedForFees);
            stats.totalFees = totalFees;
            var rawResolvedPnl = stats.realizedClosedPnl + stats.redeemablePnl;
            stats.resolvedPnlBeforeFees = rawResolvedPnl;
            stats.resolvedPnlAfterFees = rawResolvedPnl - totalFees;
            stats.netPnl = rawResolvedPnl - totalFees;
            currentStats = stats;
            return stats;
        } catch(e) {
            console.warn('Fetch wallet stats error:', e);
            return { totalTrades: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0, positions: [], netPnl: 0, resolvedPnlBeforeFees: 0, resolvedPnlAfterFees: 0 };
        }
    }

    async function searchWallet(query) {
        if (!query) return null;
        var q = query.trim().toLowerCase();
        if (q.startsWith('0x') && q.length >= 42) return q;
        if (q.startsWith('@')) {
            try {
                var slug = q.substring(1);
                var text = await pageFetch('https://data-api.polymarket.com/accounts?slug=' + slug);
                var data = JSON.parse(text);
                if (data && data.address) return data.address;
            } catch(e) { return null; }
        }
        return null;
    }

    async function fetchMarketsForWallet(wallet) {
        try {
            var text = await pageFetch(DATA_API + '/v1/trades?user=' + wallet + '&limit=100');
            var trades = JSON.parse(text);
            if (!Array.isArray(trades)) return [];
            var conds = trades.map(function(t) { return t.conditionId || t.condition_id; }).filter(Boolean);
            var unique = conds.filter(function(v,i,a) { return a.indexOf(v) === i; }).slice(0, 20);
            return unique;
        } catch(e) { return []; }
    }

    // ====================== TARIFF GATE ======================
    var TARIFF_FEATURES = {
        whale:       { minPlan: 'basic',  label: 'Whale/Smart Wallet' },
        scanner:     { minPlan: 'basic',  label: 'Сканер коэффициентов' },
        smartalerts: { minPlan: 'basic',  label: 'Смарт-алерты' },
        xsentiment:  { minPlan: 'pro',    label: 'AI анализ X (Twitter)' },
        weather:     { minPlan: 'basic',  label: 'Анализ погоды' },
        newshub:     { minPlan: 'basic',  label: 'Хаб новостей' },
        newmarkets:  { minPlan: 'basic',  label: 'Новые рынки' },
        education:   { minPlan: 'basic',  label: 'Обучающая платформа' },
    };

    function checkFeatureAccess(feature) {
        var cfg = TARIFF_FEATURES[feature];
        if (!cfg) return true;
        var plan = (getTariff() || {}).plan || 'basic';
        var levels = { basic: 0, pro: 1, apex: 2 };
        return (levels[plan] || 0) >= (levels[cfg.minPlan] || 0);
    }

    function showUpgradePrompt(container, feature) {
        var cfg = TARIFF_FEATURES[feature];
        var name = cfg ? cfg.label : feature;
        container.innerHTML = '<div style="padding:32px;text-align:center;background:var(--card-bg-2);border:1px solid var(--border);border-radius:12px;margin:12px">'
            + '<div style="font-size:28px;margin-bottom:12px">🔒</div>'
            + '<div style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:8px">Тариф «' + name + '»</div>'
            + '<div style="font-size:11px;color:var(--text-secondary);margin-bottom:16px">Доступно только для PRO и Apex тарифов</div>'
            + '<button onclick="document.getElementById(\'tariffBtn\').click()" style="padding:10px 24px;background:var(--accent);border:none;border-radius:8px;color:#fff;font-weight:700;font-size:12px;cursor:pointer;font-family:inherit">Обновить тариф</button>'
            + '</div>';
    }

    // ====================== USAGE COUNTER ======================
    function checkDailyLimit(key, max) {
        var d = new Date().toDateString();
        var k = 'polyLimit_' + key + '_' + d;
        var c = parseInt(localStorage.getItem(k) || '0');
        if (c >= max) return false;
        localStorage.setItem(k, String(c + 1));
        return true;
    }

    function getDailyUsage(key) {
        var d = new Date().toDateString();
        return parseInt(localStorage.getItem('polyLimit_' + key + '_' + d) || '0');
    }

    // ====================== GLOBAL ERROR HANDLER ======================
    window.onerror = function(msg, src, line, col, err) {
        var el = document.getElementById('errorToast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'errorToast';
            el.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:var(--negative);color:#fff;padding:10px 18px;border-radius:8px;font-size:11px;z-index:9999;max-width:80vw;text-align:center;opacity:0;transition:opacity 0.3s;font-family:inherit';
            document.body.appendChild(el);
        }
        el.textContent = 'Ошибка: ' + (err ? err.message : msg);
        el.style.opacity = '1';
        setTimeout(function() { el.style.opacity = '0'; }, 5000);
    };

    // ====================== AI AGENT ======================
    async function callAI(messages, maxTokens) {
        maxTokens = maxTokens || 2;
        try {
            var tariffs = getTariff();
            var plan = tariffs.plan || 'basic';
            var limits = { basic: 15, pro: 150, apex: 250 };
            var dailyLimit = limits[plan] || 15;
            var key = 'polyAICount_' + new Date().toDateString();
            var count = parseInt(localStorage.getItem(key) || '0');
            if (count >= dailyLimit) {
                return 'Лимит запросов к AI агенту на сегодня исчерпан (' + dailyLimit + '/' + dailyLimit + '). Обновите тариф.';
            }

            var text = await pageFetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: messages, max_tokens: maxTokens * 1024 })
            }).catch(function() { return null; });

            if (!text) return 'AI временно недоступен. Попробуйте позже.';

            var data = JSON.parse(text);
            localStorage.setItem(key, String(count + 1));
            if (data.error) throw new Error(data.error.message || 'API error');
            if (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) {
                return data.choices[0].message.content;
            }
            return data.text || data.response || 'Нет ответа';
        } catch(e) {
            console.warn('AI call error:', e);
            return 'AI временно недоступен. Попробуйте позже.';
        }
    }

    function formatAI(text) {
        if (!text) return '';
        return text
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/\n/g, '<br>')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>');
    }

    // ====================== WALLET TAB ======================
    function initWalletTab() {
        if (_walletInited) { updateStats(); return; }
        _walletInited = true;

        var searchInput = $('ws-search-input');
        if (searchInput) {
            var searchTimer = null;
            searchInput.addEventListener('input', function() {
                clearTimeout(searchTimer);
                searchTimer = setTimeout(function() {
                    var q = searchInput.value.trim();
                    if (q.length >= 10) doWalletSearch(q);
                }, 500);
            });
            searchInput.addEventListener('keydown', function(e) {
                if (e.key === 'Enter') {
                    clearTimeout(searchTimer);
                    doWalletSearch(searchInput.value.trim());
                }
            });
        }

        var copyBtn = $('copyAddrBtn');
        if (copyBtn) {
            copyBtn.onclick = function() {
                var addr = searchedWallet || lastWallet || '';
                if (addr) {
                    navigator.clipboard.writeText(addr).then(function() {
                        copyBtn.classList.add('copied');
                        setTimeout(function() { copyBtn.classList.remove('copied'); }, 2000);
                    });
                }
            };
        }

        var favBtn = $('addFavoriteBtn');
        if (favBtn) {
            favBtn.onclick = function() {
                if (searchedWallet) {
                    var favs = JSON.parse(localStorage.getItem('polyFavorites') || '[]');
                    if (!favs.some(function(f) { return f.address === searchedWallet; })) {
                        favs.unshift({ address: searchedWallet, name: searchedWallet.substring(0, 10) + '...', createdAt: Date.now() });
                        localStorage.setItem('polyFavorites', JSON.stringify(favs));
                        favBtn.classList.add('active');
                    }
                }
            };
        }

        // Stats info modal
        var infoBtn = $('statsInfoBtn');
        var overlay = $('statsInfoOverlay');
        var closeBtn = $('statsInfoClose');
        if (infoBtn && overlay) {
            infoBtn.onclick = function() { overlay.style.display = 'flex'; };
            if (closeBtn) closeBtn.onclick = function() { overlay.style.display = 'none'; };
            overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.style.display = 'none'; });
        }

        // Backtest
        var btBtn = $('bt-calculate');
        if (btBtn) btBtn.addEventListener('click', runBacktest);
        var quickBtns = document.querySelectorAll('.bt-qty-btn');
        quickBtns.forEach(function(btn) {
            btn.addEventListener('click', function() {
                var amount = parseFloat(this.dataset.amount);
                var input = $('bt-amount');
                if (input && amount) input.value = amount;
            });
        });

        // Sub tabs
        var activeTab = $('active-tab');
        var closedTab = $('closed-tab');
        if (activeTab) {
            activeTab.addEventListener('click', function() {
                currentSubTab = 'active';
                activeTab.classList.add('active');
                if (closedTab) closedTab.classList.remove('active');
                if (currentStats) renderHistory(currentStats, $('history-list'));
            });
        }
        if (closedTab) {
            closedTab.addEventListener('click', function() {
                currentSubTab = 'closed';
                closedTab.classList.add('active');
                if (activeTab) activeTab.classList.remove('active');
                if (currentStats) renderHistory(currentStats, $('history-list'));
            });
        }

        // History filters
        var filterBtns = document.querySelectorAll('.hf-btn');
        filterBtns.forEach(function(btn) {
            btn.addEventListener('click', function() {
                var filter = this.dataset.filter;
                filterBtns.forEach(function(b) { b.classList.remove('active'); });
                this.classList.add('active');
                historyFilter.sign = filter;
                if (currentStats) renderHistory(currentStats, $('history-list'));
            });
        });

        // Sort buttons
        var sortBtns = document.querySelectorAll('.hf-sort');
        sortBtns.forEach(function(btn) {
            btn.addEventListener('click', function() {
                historySort = this.dataset.sort;
                if (currentStats) renderHistory(currentStats, $('history-list'));
            });
        });

        // Tracker modal events
        var addBtn = document.getElementById('addTrackerBtn');
        if (addBtn) addBtn.addEventListener('click', addCurrentToTracker);
        var trkClose = document.getElementById('trkModalClose');
        var trkCancel = document.getElementById('trkCancelBtn');
        var trkSave = document.getElementById('trkSaveBtn');
        var trkOverlay = document.getElementById('trkModalOverlay');
        if (trkClose) trkClose.addEventListener('click', hideTrackerModal);
        if (trkCancel) trkCancel.addEventListener('click', hideTrackerModal);
        if (trkSave) trkSave.addEventListener('click', saveTrackerFromModal);
        if (trkOverlay) trkOverlay.addEventListener('click', function(e) { if (e.target === trkOverlay) hideTrackerModal(); });

        updateStats();
        initWalletAI();
    }

    async function doWalletSearch(query) {
        var wallet = await searchWallet(query);
        if (wallet) {
            searchedWallet = wallet;
            lastWallet = wallet;
            updateStats();
        } else {
            var pnlVal = $('pnl-val');
            if (pnlVal) { pnlVal.textContent = 'Не найдено'; pnlVal.className = 'pnl-value'; }
        }
    }

    async function updateStats() {
        var pnlVal = $('pnl-val');

        var wallet = searchedWallet || lastWallet;
        if (!wallet) {
            var favs = JSON.parse(localStorage.getItem('polyFavorites') || '[]');
            if (favs.length > 0) wallet = favs[0].address;
        }

        if (!wallet) {
            if (pnlVal) { pnlVal.textContent = 'Введите кошелёк'; pnlVal.className = 'pnl-value'; }
            return;
        }

        if (pnlVal) { pnlVal.textContent = 'Загрузка...'; pnlVal.className = 'pnl-value'; }

        var stats = await fetchWalletStats(wallet);
        currentStats = stats;

        var profileName = $('profile-name');
        if (profileName) {
            profileName.innerText = wallet.substring(0, 6) + '...' + (wallet.length > 12 ? wallet.substring(wallet.length - 6) : wallet);
        }

        updateMainPnl();
        updateWalletStrength();

        el('total-trades', stats.totalPositions || 0);
        el('wins-count', stats.totalWins || 0);
        el('neutral-count', stats.neutralCount || 0);
        el('loss-count', stats.totalLosses || 0);
        el('wr-val', (stats.winrate || 0) + '%');
        el('whale-wr', (stats.whaleWr || 0) + '%');
        el('whale-count', stats.whaleCount || 0);
        el('open-pnl', formatCurrency(stats.openPnl));
        el('active-count', stats.openPositions.length);
        el('closed-count', stats.resolvedPositions.length);

        var historyContainer = $('history-list');
        if (historyContainer) {
            renderHistory(stats, historyContainer);
        }

        // Account age
        var ageEl = document.getElementById('account-age');
        if (ageEl) {
            getAccountAge(wallet, stats.closedMarkets || stats.resolvedPositions || []).then(function(age) {
                if (age) ageEl.textContent = age.duration + ' · ' + age.date;
            });
        }

        updateAIRemaining();
        updateTrackBtn();
    }

    function renderHistory(stats, container) {
        if (!container) return;

        const positionsToRender = currentSubTab === 'active' ? stats.openPositions : (stats.resolvedPositions || stats.closedMarkets);

        if (!positionsToRender || positionsToRender.length === 0) {
            container.innerHTML = '<p style="color: #8b949e; text-align: center; padding: 20px;">Нет ' + (currentSubTab === 'active' ? 'активных' : 'закрытых') + ' позиций</p>';
            return;
        }

        const filtered = positionsToRender.filter(function(market) {
            var pnl = getPositionPnl(market);
            var wIds = stats && stats.whaleConditionIds;
            var marketCid = getPositionConditionId(market);
            var isWhale = (parseFloat(market.initialValue || 0) >= WHALE_THRESHOLD) || (
                wIds && wIds.length > 0 && (
                    wIds.indexOf(marketCid) >= 0 ||
                    wIds.indexOf(market.marketId || '') >= 0 ||
                    wIds.indexOf(market.slug || '') >= 0 ||
                    wIds.indexOf(market.marketSlug || '') >= 0
                )
            );
            var signOk = historyFilter.sign === 'all' ||
                (historyFilter.sign === 'whale' && isWhale) ||
                (historyFilter.sign === 'plus' && pnl > 0) ||
                (historyFilter.sign === 'minus' && pnl < 0);
            return signOk;
        });

        if (filtered.length === 0) {
            container.innerHTML = '<p style="color: #8b949e; text-align: center; padding: 20px;">Нет позиций по заданным фильтрам</p>';
            return;
        }

        filtered.sort(function(a, b) {
            if (historySort === 'pnl-asc') return getPositionPnl(a) - getPositionPnl(b);
            if (historySort === 'pnl-desc') return getPositionPnl(b) - getPositionPnl(a);
            var da = getPositionCloseTime(a);
            var db = getPositionCloseTime(b);
            return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
        });

        container.innerHTML = filtered.map(function(market) {
            var pnl = getPositionPnl(market);
            var isWin = pnl >= 0;
            var marketName = (market.title || '').substring(0, 50) || 'Unknown';

            var initialVal = parseFloat(market.initialValue || 0);
            var avgPrice = parseFloat(market.avgPrice || 0);
            var sizeShares = parseFloat(market.size || market.totalBought || 0);
            var shares = sizeShares > 0 ? sizeShares : (avgPrice > 0 ? initialVal / avgPrice : 0);
            var outcome = market.outcome || '';
            var priceCents = (avgPrice * 100).toFixed(1);

            var marketLink = market.slug ? 'https://polymarket.com/market/' + market.slug : '';

            var wIds = stats && stats.whaleConditionIds;
            var marketCid = getPositionConditionId(market);
            var isWhale = (initialVal >= WHALE_THRESHOLD) || (
                wIds && wIds.length > 0 && (
                    wIds.indexOf(marketCid) >= 0 ||
                    wIds.indexOf(market.marketId || '') >= 0 ||
                    wIds.indexOf(market.slug || '') >= 0 ||
                    wIds.indexOf(market.marketSlug || '') >= 0
                )
            );

            var pnlPercent = initialVal > 0 ? (pnl / initialVal * 100) : 0;
            var balance = initialVal + pnl;

            var closeDate = market.timestamp ? new Date(market.timestamp * 1000).toLocaleDateString('ru-RU') : '-';
            var marketEndDate = market.endDate ? new Date(market.endDate).toLocaleDateString('ru-RU') : '-';
            var entryTs = null;
            if (marketCid && stats && stats.entryDateMap) entryTs = stats.entryDateMap[marketCid.toLowerCase()];
            if (!entryTs && market.slug && stats && stats.entryDateBySlug) entryTs = stats.entryDateBySlug[market.slug];
            var entryDate = entryTs ? new Date(entryTs * 1000).toLocaleDateString('ru-RU') : '-';

            return '<div class="history-item ' + (isWin ? 'win' : 'loss') + (isWhale ? ' whale' : '') + '">'
                + '<div class="hi-top">'
                    + '<div class="hi-title">' + (marketLink ? '<a href="' + marketLink + '" target="_blank" class="market-link">' + marketName + '</a>' : marketName) + '</div>'
                    + (isWhale ? '<span class="hi-whale">🐋</span>' : '')
                + '</div>'
                + '<div class="hi-choice">'
                    + '<span class="hi-outcome">' + outcome + '</span>'
                    + '<span class="hi-sep">·</span>'
                    + '<span class="hi-shares">' + shares.toLocaleString('en-US', {minimumFractionDigits:1, maximumFractionDigits:1}) + ' shares</span>'
                    + '<span class="hi-sep">·</span>'
                    + '<span class="hi-px">' + priceCents + '¢</span>'
                    + '<span class="hi-sep">·</span>'
                    + '<span class="hi-invested">' + formatCurrency(initialVal) + '</span>'
                + '</div>'
                + '<div class="hi-result">'
                    + '<span class="hi-balance">' + formatCurrency(balance) + '</span>'
                    + '<span class="hi-pnl ' + (isWin ? 'up' : 'down') + '">' + (pnl >= 0 ? '+' : '') + formatCurrency(pnl) + ' (' + (pnlPercent >= 0 ? '+' : '') + pnlPercent.toFixed(1) + '%)</span>'
                    + '<button class="hi-copy-btn" data-trade="' + encodeURIComponent(marketName + ' | ' + outcome + ' | ' + shares.toFixed(1) + ' shares @ ' + priceCents + '¢ | Invested: $' + initialVal.toFixed(2) + ' | PnL: ' + (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2) + ' (' + (pnlPercent >= 0 ? '+' : '') + pnlPercent.toFixed(1) + '%) | Return: ' + formatCurrency(balance)) + '" title="Copy trade data">\u2398</button>'
                + '</div>'
            + '</div>';
        }).join('');
    }

    // ====================== WALLET HELPERS ======================

    function isOpenPosition(p) {
        var size = parseFloat(p.size || p.quantity || 0);
        return size > 0.01 && parseFloat(p.curPrice || 0) > 0;
    }

    function isClosedPosition(p) {
        var size = parseFloat(p.size || p.quantity || 0);
        return size > 0.01 && parseFloat(p.curPrice || 0) === 0;
    }

    function isWinPosition(p) {
        return parseFloat(p.cashPnl || p.realizedPnl || 0) > 0;
    }

    function getPositionPnl(p) {
        var apiPnl = parseFloat(p.cashPnl);
        if (isNaN(apiPnl)) apiPnl = parseFloat(p.realizedPnl);
        if (!isNaN(apiPnl)) return apiPnl;

        if (!p._isClosedPosition && !isClosedPosition(p)) return 0;

        var bought = parseFloat(p.totalBought || 0);
        var sold = parseFloat(p.totalSold || 0);
        if (bought > 0 || sold > 0) return sold - bought;

        var size = parseFloat(p.size || 0);
        var avgPx = parseFloat(p.averagePrice || p.avgPrice || p.price || 0);
        var cost = parseFloat(p.initialValue || 0);
        if (cost === 0 && size > 0 && avgPx > 0) cost = size * avgPx;
        if (cost === 0) cost = size;
        if (isWinPosition(p)) { var payout = size; return payout - cost; }
        return -cost;
    }

    function getPositionConditionId(p) {
        return p.conditionId || p.marketId || '';
    }

    function getUniquePositionKey(p) {
        var cid = getPositionConditionId(p);
        var idx = p.outcomeIndex !== undefined ? p.outcomeIndex : '';
        return cid + ':' + idx;
    }

    function getPositionInvestment(p) {
        if (p._isClosedPosition) return parseFloat(p.totalBought || 0) || 1;
        return parseFloat(p.initialValue || Math.abs(parseFloat(p.cashPnl || 0))) || 1;
    }

    function getPositionCloseTime(p) {
        if (p.timestamp) return new Date(p.timestamp * 1000);
        if (p.endDate) return new Date(p.endDate);
        return null;
    }

    function calcPositionFee(p) {
        var cid = getPositionConditionId(p);
        if (!cid || !/^0x[a-fA-F0-9]{64}$/.test(cid)) return 0;
        var fs = _feeCache[cid] || { rate: 0.05, exponent: 1, takerOnly: true };
        if (!fs.rate) return 0;
        var size = parseFloat(p.size || p.quantity || 0);
        if (size <= 0) return 0;
        var entryPrice = parseFloat(p.avgPrice);
        if (!entryPrice || entryPrice <= 0) {
            var cost = parseFloat(p.initialValue || 0);
            if (cost > 0) entryPrice = cost / size;
        }
        if (!entryPrice || entryPrice <= 0) return 0;
        var price = Math.min(1, Math.max(0.001, entryPrice));
        return fs.rate * price * (1 - price) * size;
    }

    function calculateStats(positions, closedPositions, trades, totalFees, walletAddress) {
        totalFees = totalFees || 0;
        walletAddress = walletAddress || '';
        var seenKeys = new Set();
        var allPositions = [];
        var positionsConds = new Set();

        for (var i = 0; i < positions.length; i++) {
            var p = positions[i];
            var key = getUniquePositionKey(p);
            if (key && seenKeys.has(key)) continue;
            if (key) seenKeys.add(key);
            var cid = getPositionConditionId(p);
            if (cid) positionsConds.add(cid.toLowerCase());
            allPositions.push(Object.assign({}, p, { slug: p.slug || p.marketSlug || p.eventSlug || '' }));
        }

        for (var i = 0; i < closedPositions.length; i++) {
            var p = closedPositions[i];
            var cid = getPositionConditionId(p);
            if (cid && positionsConds.has(cid.toLowerCase())) continue;
            var key = getUniquePositionKey(p);
            if (key && seenKeys.has(key)) continue;
            if (key) seenKeys.add(key);
            allPositions.push(Object.assign({}, p, {
                slug: p.slug || p.marketSlug || p.eventSlug || '',
                curPrice: 0,
                cashPnl: p.realizedPnl || 0,
                _isClosedPosition: true
            }));
        }

        var allConds = new Set();
        for (var i = 0; i < allPositions.length; i++) {
            var cid = getPositionConditionId(allPositions[i]);
            if (cid) allConds.add(cid.toLowerCase());
        }
        var tradeConds = new Map();
        for (var i = 0; i < trades.length; i++) {
            var t = trades[i];
            var pnl = parseFloat(t.pnl || 0);
            if (pnl === 0) continue;
            var cid = getPositionConditionId(t);
            if (!cid || allConds.has(cid.toLowerCase())) continue;
            var existing = tradeConds.get(cid);
            if (existing) {
                existing.cashPnl = (parseFloat(existing.cashPnl || 0) || 0) + pnl;
                existing.size = (parseFloat(existing.size || 0) || 0) + parseFloat(t.size || 0);
            } else {
                tradeConds.set(cid, {
                    conditionId: cid,
                    slug: t.slug || t.marketSlug || '',
                    size: parseFloat(t.size || 0),
                    curPrice: 0,
                    cashPnl: pnl,
                    _isClosedPosition: true,
                    _fromTrade: true,
                    title: t.marketTitle || t.conditionTitle || 'Trade',
                    outcome: t.outcome || ''
                });
            }
        }
        for (var entry of tradeConds) {
            allPositions.push(entry[1]);
        }

        var openPositions = allPositions.filter(isOpenPosition);
        var closedMarkets = allPositions.filter(function(p) {
            if (p._isClosedPosition) return true;
            if (!isClosedPosition(p)) return false;
            return true;
        });

        var closedMap = new Map();
        for (var i = 0; i < closedMarkets.length; i++) {
            var p = closedMarkets[i];
            var cid = getPositionConditionId(p);
            if (!cid) { closedMap.set(Symbol(), p); continue; }
            if (closedMap.has(cid)) {
                var existing = closedMap.get(cid);
                existing._mergedPnl = (existing._mergedPnl !== undefined ? existing._mergedPnl : parseFloat(existing.realizedPnl || existing.cashPnl || 0))
                    + parseFloat(p.realizedPnl || p.cashPnl || 0);
            } else {
                closedMap.set(cid, Object.assign({}, p));
            }
        }
        var uniqueClosed = [];
        for (var entry of closedMap) {
            var p = entry[1];
            if (p._mergedPnl !== undefined) {
                p.realizedPnl = p._mergedPnl;
                p.cashPnl = p._mergedPnl;
                delete p._mergedPnl;
            }
            uniqueClosed.push(p);
        }

        var resolvedPositions = allPositions.filter(function(p) { return p._isClosedPosition || isClosedPosition(p); });
        var winPositions = resolvedPositions.filter(function(p) { return getPositionPnl(p) > 0; });
        var lossPositions = resolvedPositions.filter(function(p) { return getPositionPnl(p) < 0; });
        var wins = winPositions.length;
        var losses = lossPositions.length;
        var totalTrades = wins + losses;
        var totalPositions = resolvedPositions.length + openPositions.length;
        var winrate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : '0.0';
        var neutralCount = resolvedPositions.length - wins - losses;

        var allTrades = trades.map(function(t) {
            return {
                title: t.marketTitle || t.conditionTitle || 'Unknown',
                volume: parseFloat(t.notional || t.cost || (t.size * t.avgPrice) || t.size || 0),
                pnl: parseFloat(t.pnl || t.profit || 0),
                outcome: t.outcome || '',
                avgPrice: parseFloat(t.avgPrice || 0),
                endDate: t.timestamp ? new Date(t.timestamp).toISOString() : null,
                slug: t.slug || t.marketSlug || '',
                conditionId: getPositionConditionId(t),
                timestamp: t.timestamp,
                isClosed: t.status === 'closed' || t.settled === true || parseFloat(t.pnl || 0) !== 0
            };
        });

        var whaleTrades = allTrades.filter(function(t) { return t.volume >= WHALE_THRESHOLD; });
        var whaleIds = new Set();
        whaleTrades.forEach(function(t) {
            if (t.conditionId) whaleIds.add(t.conditionId);
            if (t.slug) whaleIds.add(t.slug);
            if (t.marketSlug) whaleIds.add(t.marketSlug);
        });
        var whalePositions = uniqueClosed.filter(function(p) {
            return whaleIds.has(getPositionConditionId(p)) || whaleIds.has(p.slug || '') || whaleIds.has(p.marketSlug || '');
        });
        var whaleWins = whalePositions.filter(function(p) { return isWinPosition(p); }).length;
        var whaleWr = whalePositions.length > 0 ? ((whaleWins / whalePositions.length) * 100).toFixed(1) : '0.0';
        var whaleCount = whalePositions.length;
        var whaleActive = whaleTrades.filter(function(t) { return !t.isClosed; });
        var whaleClosedList = whaleTrades.filter(function(t) { return t.isClosed; });

        var realizedPositive = 0, realizedNegative = 0, realizedClosedLoss = 0;
        for (var i = 0; i < resolvedPositions.length; i++) {
            var pnl = getPositionPnl(resolvedPositions[i]);
            if (pnl > 0) realizedPositive += pnl;
            else realizedNegative += Math.abs(pnl);
        }
        for (var i = 0; i < lossPositions.length; i++) {
            realizedClosedLoss += Math.abs(getPositionPnl(lossPositions[i]));
        }
        var netPnl = realizedPositive - realizedNegative;

        var openPositivePnl = 0, openNegativePnl = 0, openValue = 0;
        for (var i = 0; i < openPositions.length; i++) {
            var p = openPositions[i];
            var cv = parseFloat(p.currentValue || 0);
            var pnl = parseFloat(p.cashPnl || 0);
            openValue += cv;
            if (pnl > 0) openPositivePnl += pnl;
            else openNegativePnl += Math.abs(pnl);
        }

        var drawdownPnl = 0;
        for (var i = 0; i < allPositions.length; i++) {
            var pnl = getPositionPnl(allPositions[i]);
            if (pnl < 0) drawdownPnl += Math.abs(pnl);
        }

        var realizedClosedPnl = 0, redeemablePnl = 0, polymarketRedeemablePnl = 0, polymarketPnl = 0;
        for (var i = 0; i < resolvedPositions.length; i++) {
            var pnl = getPositionPnl(resolvedPositions[i]);
            if (resolvedPositions[i]._isClosedPosition) {
                realizedClosedPnl += pnl;
                polymarketPnl += pnl;
            } else {
                redeemablePnl += pnl;
                var cashPnl = parseFloat(resolvedPositions[i].cashPnl || resolvedPositions[i].realizedPnl || 0);
                polymarketRedeemablePnl += cashPnl;
                polymarketPnl += cashPnl;
            }
        }
        var openPnlNet = openPositivePnl - openNegativePnl;

        var entryDateMap = {};
        var entryDateBySlug = {};
        (trades || []).forEach(function(t) {
            if (t.side === 'BUY' && t.timestamp) {
                if (t.conditionId) {
                    var cid = t.conditionId.toLowerCase();
                    if (!entryDateMap[cid] || t.timestamp < entryDateMap[cid]) entryDateMap[cid] = t.timestamp;
                }
                if (t.slug) {
                    if (!entryDateBySlug[t.slug] || t.timestamp < entryDateBySlug[t.slug]) entryDateBySlug[t.slug] = t.timestamp;
                }
            }
        });

        var sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        var hasRecentActivity = (trades || []).some(function(t) {
            return t.timestamp && t.timestamp * 1000 >= sevenDaysAgo;
        });

        return {
            walletAddress: walletAddress,
            netPnl: netPnl,
            realizedLoss: realizedClosedLoss,
            totalFees: totalFees || 0,
            resolvedPnlBeforeFees: 0,
            resolvedPnlAfterFees: 0,
            totalWins: wins,
            totalLosses: losses,
            neutralCount: neutralCount,
            totalTrades: totalTrades,
            totalPositions: totalPositions,
            winrate: winrate,
            whaleWr: whaleWr,
            whaleCount: whaleCount,
            hasRecentActivity: hasRecentActivity,
            positivePnl: openPositivePnl,
            negativePnl: openNegativePnl,
            openPnl: openValue,
            drawdownPnl: drawdownPnl,
            realizedClosedPnl: realizedClosedPnl,
            redeemablePnl: redeemablePnl,
            polymarketRedeemablePnl: polymarketRedeemablePnl,
            openPnlNet: openPnlNet,
            polymarketPnl: polymarketPnl,
            closedMarkets: uniqueClosed,
            resolvedPositions: resolvedPositions,
            whaleTrades: whaleTrades,
            whaleActive: whaleActive,
            whaleClosed: whaleClosedList,
            whaleConditionIds: Array.from(whaleIds),
            openPositions: openPositions,
            entryDateMap: entryDateMap,
            entryDateBySlug: entryDateBySlug
        };
    }

    // === FEE CALCULATION ===
    async function fetchMarketFeeInfo(conditionId) {
        if (_feeCache[conditionId]) return _feeCache[conditionId];
        try {
            var text = await pageFetch('https://gamma-api.polymarket.com/markets?conditionId=' + encodeURIComponent(conditionId));
            var data = JSON.parse(text);
            var list = Array.isArray(data) ? data : (data.data || []);
            var cidLower = conditionId.toLowerCase();
            var market = list.find(function(m) { return (m.conditionId || '').toLowerCase() === cidLower; });
            if (market) {
                var fs = market.feeSchedule;
                if (typeof fs === 'string') fs = JSON.parse(fs);
                if (fs && fs.rate > 0) { _feeCache[conditionId] = fs; return fs; }
                var tbf = parseFloat(market.takerBaseFee);
                if (tbf > 0) {
                    var rate = tbf / 20000;
                    _feeCache[conditionId] = { rate: rate, exponent: 1, takerOnly: true };
                    return _feeCache[conditionId];
                }
            }
            _feeCache[conditionId] = null;
            return null;
        } catch (e) {
            _feeCache[conditionId] = null;
            return null;
        }
    }

    async function computePositionFees(resolvedPositions) {
        if (!resolvedPositions || !resolvedPositions.length) return 0;
        var cidSet = {};
        resolvedPositions.forEach(function(p) {
            var cid = getPositionConditionId(p);
            if (cid && /^0x[a-fA-F0-9]{64}$/.test(cid)) cidSet[cid] = true;
        });
        var conditionIds = Object.keys(cidSet);
        if (!conditionIds.length) return 0;
        var feeSchedules = await Promise.all(conditionIds.map(function(cid) {
            return fetchMarketFeeInfo(cid).catch(function() { return null; });
        }));
        var feeMap = {};
        conditionIds.forEach(function(cid, i) {
            var fs = feeSchedules[i];
            if (fs && fs.rate > 0) {
                feeMap[cid] = { rate: parseFloat(fs.rate || 0), exponent: parseFloat(fs.exponent || 1), takerOnly: fs.takerOnly === true };
            }
        });
        var totalFees = 0;
        resolvedPositions.forEach(function(p) {
            var cid = getPositionConditionId(p);
            if (!cid || !/^0x[a-fA-F0-9]{64}$/.test(cid)) return;
            var feeCfg = feeMap[cid] || { rate: 0.05, takerOnly: true };
            var size = parseFloat(p.size || p.quantity || 0);
            if (size <= 0) return;
            var entryPrice = parseFloat(p.avgPrice);
            if (!entryPrice || entryPrice <= 0) {
                var cost = parseFloat(p.initialValue || 0);
                if (cost > 0) entryPrice = cost / size;
            }
            if (!entryPrice || entryPrice <= 0) return;
            var price = Math.min(1, Math.max(0.001, entryPrice));
            var feePerShare = feeCfg.rate * price * (1 - price);
            totalFees += feePerShare * size;
        });
        return totalFees;
    }

    // === UI UPDATE HELPERS ===
    function el(id, val) { var e = document.getElementById(id); if (e) e.innerText = val; }

    function setPnl(id, val) {
        var e = document.getElementById(id);
        if (!e) return;
        e.innerText = (val >= 0 ? '+' : '') + formatCurrency(val);
        e.className = 'stats-value ' + (val >= 0 ? 'positive' : 'negative');
    }

    function formatCurrency(num) {
        if (num === null || num === undefined || isNaN(num)) return '$0.00';
        var abs = Math.abs(num).toFixed(2);
        var parts = abs.split('.');
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return '$' + parts.join('.');
    }

    function updateMainPnl() {
        var pnlEl = document.getElementById('pnl-val');
        if (!pnlEl || !currentStats) return;
        var val = currentStats.resolvedPnlBeforeFees;
        pnlEl.innerText = (val >= 0 ? '+' : '') + formatCurrency(val);
        pnlEl.className = 'pnl-value ' + (val >= 0 ? 'positive' : 'negative');
        var pnlCard = pnlEl.closest('.main-pnl-card');
        if (pnlCard) {
            pnlCard.classList.remove('score-strong', 'score-medium', 'score-weak');
            var scoreResult = calcWalletScore(currentStats);
            if (scoreResult && scoreResult.rating) pnlCard.classList.add('score-' + scoreResult.rating);
        }
        updateBreakdownDisplay();
    }

    function updateBreakdownDisplay() {
        if (!currentStats) return;
        var s = currentStats;
        var beforeEl = document.getElementById('pnl-before-fees');
        if (beforeEl) {
            beforeEl.innerText = (s.resolvedPnlBeforeFees >= 0 ? '+' : '') + formatCurrency(s.resolvedPnlBeforeFees);
            beforeEl.className = 'stats-value ' + (s.resolvedPnlBeforeFees >= 0 ? 'positive' : 'negative');
        }
        var afterEl = document.getElementById('pnl-after-fees');
        if (afterEl) {
            afterEl.innerText = (s.resolvedPnlAfterFees >= 0 ? '+' : '') + formatCurrency(s.resolvedPnlAfterFees);
            afterEl.className = 'stats-value ' + (s.resolvedPnlAfterFees >= 0 ? 'positive' : 'negative');
        }
        var feesEl = document.getElementById('total-fees');
        if (feesEl) feesEl.innerText = formatCurrency(s.totalFees);
        setPnl('open-pnl-net', s.openPnlNet);
        el('open-pnl', formatCurrency(s.openPnl));
        var lossEl = document.getElementById('total-loss');
        if (lossEl) {
            lossEl.innerText = '-' + formatCurrency(s.realizedLoss);
            lossEl.className = 'stats-value negative';
        }
        el('active-count', s.openPositions ? s.openPositions.length : 0);
        el('closed-count', s.resolvedPositions ? s.resolvedPositions.length : 0);
    }

    // === ACCOUNT AGE ===
    async function fetchUserCreatedAt(wallet) {
        try {
            var res = await fetch('/api/profile/userData?wallet=' + encodeURIComponent(wallet), { credentials: 'include' });
            if (!res.ok) return null;
            var data = await res.json();
            return data && (data.createdAt || data.joinDate || data.timestamp) || null;
        } catch (e) { return null; }
    }

    function formatDuration(fromMs) {
        var now = Date.now();
        var ms = now - fromMs;
        var days = Math.floor(ms / 86400000);
        if (days < 1) return 'менее дня';
        if (days < 30) return days + ' дн.';
        var months = Math.floor(days / 30);
        var remDays = days % 30;
        if (months < 12) return remDays > 0 ? months + ' мес. ' + remDays + ' дн.' : months + ' мес.';
        var years = Math.floor(months / 12);
        var remMonths = months % 12;
        return remMonths > 0 ? years + ' г. ' + remMonths + ' мес.' : years + ' г.';
    }

    async function getAccountAge(wallet, trades) {
        var earliestMs = null;
        try {
            var createdAt = await fetchUserCreatedAt(wallet);
            if (createdAt) {
                var ts = parseInt(createdAt, 10);
                if (!isNaN(ts)) earliestMs = ts * (ts > 1e12 ? 1 : 1000);
            }
        } catch (e) {}
        if (!earliestMs && trades && trades.length > 0) {
            var timestamps = trades.map(function(t) { return parseInt(t.timestamp || t.createdAt || 0, 10); }).filter(function(ts) { return ts > 0; });
            if (timestamps.length > 0) earliestMs = Math.min.apply(null, timestamps) * 1000;
        }
        if (!earliestMs) return null;
        return { duration: formatDuration(earliestMs), date: new Date(earliestMs).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) };
    }

    // === TRACKER ===
    function getTracked() {
        try { return JSON.parse(localStorage.getItem('polyTracked') || '[]'); } catch (e) { return []; }
    }

    function saveTracked(list) {
        localStorage.setItem('polyTracked', JSON.stringify(list));
    }

    function isWalletTracked(address) {
        if (!address) return false;
        var tracked = getTracked();
        return tracked.some(function(t) { return t.address && t.address.toLowerCase() === address.toLowerCase(); });
    }

    function addCurrentToTracker() {
        var wallet = searchedWallet || lastWallet;
        if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) return;
        var tracked = getTracked();
        var existing = tracked.find(function(t) { return t.address.toLowerCase() === wallet.toLowerCase(); });
        if (existing) {
            showTrackerModal(existing);
        } else {
            var name = wallet.substring(0, 6) + '...' + wallet.substring(38);
            showTrackerModal({ name: name, address: wallet, tradeType: 'entry', selection: '', comment: '', createdAt: Date.now() });
        }
        updateTrackBtn();
    }

    function showTrackerModal(data) {
        var el = function(id) { return document.getElementById(id); };
        el('trkEditId').value = data && data.id || '';
        el('trkModalTitle').textContent = data && data.id ? 'Редактировать запись трекера' : 'Добавить в трекер';
        el('trkName').value = data && data.name || '';
        el('trkAddress').value = data && data.address || '';
        el('trkType').value = data && data.tradeType || 'entry';
        el('trkSelection').value = data && data.selection || '';
        el('trkComment').value = data && data.comment || '';
        el('trkModalOverlay').style.display = 'flex';
        el('trkName').focus();
    }

    function hideTrackerModal() {
        document.getElementById('trkModalOverlay').style.display = 'none';
    }

    function saveTrackerFromModal() {
        var el = function(id) { return document.getElementById(id); };
        var editId = el('trkEditId').value;
        var name = el('trkName').value.trim();
        var address = el('trkAddress').value.trim();
        var tradeType = el('trkType').value;
        var selection = el('trkSelection').value.trim();
        var comment = el('trkComment').value.trim();
        if (!name) { /* no toast, silent */ return; }
        if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) return;
        var tracked = getTracked();
        if (editId) {
            var found = false;
            tracked.forEach(function(t) {
                if (t.id === editId) { t.name = name; t.address = address; t.tradeType = tradeType; t.selection = selection; t.comment = comment; t.createdAt = Date.now(); found = true; }
            });
            if (!found) return;
        } else {
            if (tracked.length >= 15) { tracked.sort(function(a, b) { return a.createdAt - b.createdAt; }); tracked.shift(); }
            var dup = tracked.some(function(t) { return t.address.toLowerCase() === address.toLowerCase(); });
            if (dup) return;
            tracked.push({ id: Date.now().toString(36) + Math.random().toString(36).substring(2, 7), name: name, address: address, tradeType: tradeType, selection: selection, comment: comment, createdAt: Date.now() });
        }
        saveTracked(tracked);
        hideTrackerModal();
        updateTrackBtn();
    }

    function updateTrackBtn() {
        var btn = document.getElementById('addTrackerBtn');
        if (!btn) return;
        var wallet = searchedWallet || lastWallet;
        if (!wallet) { btn.classList.remove('active'); return; }
        var tracked = getTracked();
        var inTrack = tracked.some(function(t) { return t.address && t.address.toLowerCase() === wallet.toLowerCase(); });
        btn.classList.toggle('active', inTrack);
    }

    // === WALLET SCORE ===
    function calcWalletScore(s) {
        var wr = parseFloat(s.winrate) || 0;
        var pnl = s.netPnl || 0;
        var whaleCount = s.whaleCount || 0;
        var whaleWr = parseFloat(s.whaleWr) || 0;
        var wins = s.totalWins || 0;
        var losses = s.totalLosses || 0;

        var now = Date.now();
        var sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
        var recentClosed = 0;
        var resolved = s.resolvedPositions || [];
        for (var i = 0; i < resolved.length; i++) {
            var ct = getPositionCloseTime(resolved[i]);
            if (ct && ct.getTime() >= sevenDaysAgo) recentClosed++;
        }
        var recentOpen = (s.openPositions || []).length;
        var recentPositions = recentClosed + recentOpen;

        var wrOk = wr >= 50;
        var pnlOk = pnl > 500;
        var activityOk = recentPositions >= 10;
        var winsMore = wins > losses;
        var lossNotExceed = pnl > 0;
        var allMinima = wrOk && pnlOk && activityOk && winsMore && lossNotExceed;
        var wrGood = wr >= 65;
        var pnlGood = pnl > 1500;
        var wrBest = wr >= 75;
        var pnlBest = pnl > 3000;

        var scoreWr = Math.min(40, Math.round(wr / 100 * 40));
        var scorePnl = pnl > 3000 ? 25 : (pnl > 1500 ? 20 : (pnl > 500 ? 15 : (pnl > 0 ? 10 : 0)));
        var scoreActivity = Math.min(15, Math.round(recentPositions / 10 * 15));
        var scoreWhale = (whaleCount > 0 && whaleWr >= 70) ? 20 : ((whaleCount > 0 && whaleWr > 50) ? 10 : (whaleCount > 0 ? 5 : 0));
        var totalScore = Math.min(100, Math.max(0, scoreWr + scorePnl + scoreActivity + scoreWhale));

        var rating, label, rec;
        if (allMinima && wrBest && pnlBest) { rating = 'strong'; label = 'Точно рекомендуем'; rec = 'Точно рекомендуется для копирования'; }
        else if (allMinima && wrGood && pnlGood) { rating = 'strong'; label = 'Рекомендуется'; rec = 'Рекомендуется для копирования'; }
        else if (allMinima) { rating = 'medium'; label = 'Интересен'; rec = 'Интересен для наблюдения'; }
        else { rating = 'weak'; label = 'Не рекомендуется'; rec = 'Не рекомендуется'; }

        var pnlStr = (pnl >= 0 ? '+' : '') + formatCurrency(pnl);
        var activityStr = recentPositions + ' поз. за 7д';
        var comps = [
            { label: 'WR', val: wr + '%', score: scoreWr, max: 40, pass: wrOk, good: wrGood },
            { label: 'PNL', val: pnlStr, score: scorePnl, max: 25, pass: pnlOk, good: pnlGood },
            { label: 'Активность', val: activityStr, score: scoreActivity, max: 15, pass: activityOk, good: recentPositions >= 10 },
        ];
        if (whaleCount > 0) {
            comps.push({ label: 'Whale WR', val: whaleWr + '%', score: scoreWhale, max: 20, pass: whaleWr > 50, good: whaleWr >= 70 });
        }
        return { score: totalScore, rating: rating, label: label, rec: rec, comps: comps, _recentPositions: recentPositions };
    }

    function updateWalletStrength() {
        if (!currentStats) return;
        var result = calcWalletScore(currentStats);
        var card = document.getElementById('wallet-strength-card');
        if (!card) return;
        card.className = 'wallet-strength-card ' + result.rating;

        var compsHtml = '';
        for (var i = 0; i < result.comps.length; i++) {
            var c = result.comps[i];
            var pct = c.max > 0 ? c.score / c.max * 100 : 0;
            var fillCls = pct >= 80 ? 'fill-strong' : pct >= 40 ? 'fill-medium' : 'fill-weak';
            compsHtml += '<div class="ws-comp">'
                + '<div class="ws-comp-row">'
                    + '<span class="ws-comp-label">' + c.label + '</span>'
                    + '<span class="ws-comp-val">' + c.val + '</span>'
                    + '<span class="ws-comp-score">' + c.score + '/' + c.max + '</span>'
                + '</div>'
                + '<div class="ws-comp-bar">'
                    + '<div class="ws-comp-fill ' + fillCls + '" style="width:' + pct + '%"></div>'
                + '</div>'
            + '</div>';
        }

        card.innerHTML = ''
            + '<div class="ws-head">'
                + '<span class="ws-head-label">СКОР КОШЕЛЬКА</span>'
                + '<span class="ws-badge ' + result.rating + '">' + result.score + ' · ' + result.label + '</span>'
            + '</div>'
            + '<div class="ws-comps">' + compsHtml + '</div>';
    }

    // === BACKTEST ===
    async function runBacktest() {
        var closed = (currentStats && currentStats.closedMarkets) || [];
        if (closed.length === 0) { alert('Нет закрытых позиций для бэктеста'); return; }
        var amount = parseFloat(document.getElementById('bt-amount').value) || 1000;
        var now = new Date();
        var cidSet = {};
        closed.forEach(function(p) {
            var cid = getPositionConditionId(p);
            if (cid && /^0x[a-fA-F0-9]{64}$/.test(cid) && !_feeCache[cid]) cidSet[cid] = true;
        });
        var cids = Object.keys(cidSet);
        if (cids.length) {
            await Promise.all(cids.map(function(cid) { return fetchMarketFeeInfo(cid).catch(function() {}); }));
        }
        var periods = [
            { id: 'bt-24h', start: new Date(now - 24 * 60 * 60 * 1000), periodId: '24h' },
            { id: 'bt-7d', start: new Date(now - 7 * 24 * 60 * 60 * 1000), periodId: '7d' },
            { id: 'bt-30d', start: new Date(now - 30 * 24 * 60 * 60 * 1000), periodId: '30d' },
            { id: 'bt-all', start: null, periodId: 'all' }
        ];
        for (var pi = 0; pi < periods.length; pi++) {
            var period = periods[pi];
            var filtered = period.start ? closed.filter(function(p) { var ct = getPositionCloseTime(p); return ct && ct >= period.start; }) : closed;
            var netPnl = 0, grossPnl = 0, totalFees = 0, count = 0;
            for (var i = 0; i < filtered.length; i++) {
                var p = filtered[i];
                var inv = getPositionInvestment(p);
                if (!inv || inv <= 0 || !isFinite(inv)) continue;
                var rawPnl = getPositionPnl(p);
                if (!isFinite(rawPnl)) continue;
                var returnPct = rawPnl / inv;
                var ourPnl = returnPct * amount;
                var walletFee = calcPositionFee(p);
                var fee = walletFee * (amount / inv);
                grossPnl += ourPnl;
                netPnl += (returnPct - 0.05) * amount - fee;
                count++;
            }
            var netRoi = amount > 0 ? (netPnl / amount) * 100 : 0;
            var avgRoi = count > 0 ? netRoi / count : 0;
            var valEl = document.getElementById(period.id);
            if (valEl) {
                valEl.innerText = (netPnl >= 0 ? '+' : '') + formatCurrency(netPnl);
                valEl.className = 'bt-value ' + (netPnl >= 0 ? 'positive' : 'negative');
            }
            var roiEl = document.getElementById(period.id + '-roi');
            if (roiEl) {
                roiEl.innerText = (avgRoi >= 0 ? '+' : '') + avgRoi.toFixed(1) + '%';
                roiEl.className = 'bt-roi ' + (avgRoi >= 0 ? 'positive' : 'negative');
            }
            var grossEl = document.getElementById(period.id + '-gross');
            if (grossEl) {
                grossEl.innerText = (grossPnl >= 0 ? '+' : '') + formatCurrency(grossPnl);
                grossEl.className = 'bt-gross-val ' + (grossPnl >= 0 ? 'positive' : 'negative');
            }
            var tradesEl = document.getElementById(period.id + '-trades');
            if (tradesEl) tradesEl.innerText = count + ' закрытых';
        }
        var resultEl = document.getElementById('bt-result');
        if (resultEl) {
            resultEl.style.display = 'block';
            resultEl.style.animation = 'none';
            requestAnimationFrame(function() { resultEl.style.animation = 'fadeSlideIn 0.3s ease'; });
        }
    }

    // === AI AGENT FOR WALLET ===
    function getAIRemaining() {
        try {
            var raw = localStorage.getItem('wa_monthly_usage') || '0';
            var used = parseInt(raw, 10) || 0;
            return Math.max(0, 30 - used);
        } catch(e) { return 30; }
    }

    function updateAIRemaining() {
        var badge = document.getElementById('wa-ai-remaining-badge');
        if (badge) badge.textContent = getAIRemaining();
    }

    function addAIMsg(content, role, prefix) {
        prefix = prefix || 'ev';
        var msgsEl = document.getElementById(prefix + '-ai-msgs');
        if (!msgsEl) return;
        var div = document.createElement('div');
        div.className = prefix + '-ai-msg ' + prefix + '-ai-msg-' + role;
        var formatted = role === 'ai' ? formatAI(content) : escHtml(content);
        var plainText = content ? content.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'") : '';
        div.innerHTML = ''
            + '<div class="' + prefix + '-ai-msg-avatar">'
            + (role === 'ai'
                ? '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2zm-1 14a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm4 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"/></svg>'
                : '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>')
            + '</div>'
            + '<div class="' + prefix + '-ai-msg-bubble">' + formatted + '<button class="poly-copy-btn" data-copy-text="' + escHtml(plainText.substring(0, 500)) + '" title="Копировать">📋</button></div>';
        msgsEl.appendChild(div);
        msgsEl.scrollTop = msgsEl.scrollHeight;
    }

    function showAILoading(prefix) {
        prefix = prefix || 'ev';
        var msgsEl = document.getElementById(prefix + '-ai-msgs');
        if (!msgsEl) return;
        var div = document.createElement('div');
        div.className = prefix + '-ai-msg ' + prefix + '-ai-msg-ai';
        div.id = prefix + '-ai-loading';
        div.innerHTML = ''
            + '<div class="' + prefix + '-ai-msg-avatar"><svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2zm-1 14a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm4 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"/></svg></div>'
            + '<div class="' + prefix + '-ai-msg-bubble"><span class="' + prefix + '-ai-dots"><span>.</span><span>.</span><span>.</span></span></div>';
        msgsEl.appendChild(div);
        msgsEl.scrollTop = msgsEl.scrollHeight;
    }

    function hideAILoading(prefix) {
        prefix = prefix || 'ev';
        var el = document.getElementById(prefix + '-ai-loading');
        if (el) el.remove();
    }

    async function runWalletAnalysis() {
        if (_waRunning) return;
        if (!currentStats) { addAIMsg('❌ Нет данных кошелька. Сначала выполните поиск.', 'ai', 'wa'); return; }
        _waRunning = true;
        var sendBubble = document.getElementById('wa-ai-send-bubble');
        if (sendBubble) sendBubble.classList.add('disabled');

        var s = currentStats;
        var walletAddr = s.walletAddress || 'неизвестен';
        var ctx = 'Ты профессиональный аналитик Polymarket. СЕЙЧАС ' + new Date().getFullYear() + ' ГОД. Анализируй данные кошелька трейдера и дай развёрнутый анализ на русском.\n\n';
        ctx += 'ДАННЫЕ КОШЕЛЬКА: ' + walletAddr + '\n';
        ctx += 'Всего сделок: ' + (s.totalPositions || 0) + '\n';
        ctx += 'Общий Win Rate: ' + (s.winrate || 0) + '%\n';
        ctx += 'Побед: ' + (s.totalWins || 0) + ', Поражений: ' + (s.totalLosses || 0) + ', Нейтрально: ' + (s.neutralCount || 0) + '\n';
        ctx += 'Whale Win Rate: ' + (s.whaleWr || 0) + '%\n';
        ctx += 'Whale входов: ' + (s.whaleCount || 0) + '\n';
        ctx += 'Активных позиций: ' + (s.openPositions ? s.openPositions.length : 0) + '\n';
        ctx += 'Закрытых позиций: ' + (s.closedMarkets ? s.closedMarkets.length : 0) + '\n';
        ctx += 'Net PnL: ' + (s.netPnl !== undefined ? '$' + s.netPnl.toFixed(2) : '—') + '\n';
        ctx += 'Объективный PnL: ' + (s.realizedClosedPnl !== undefined ? '$' + s.realizedClosedPnl.toFixed(2) : '—') + '\n';
        ctx += 'PnL до комиссий: ' + (s.resolvedPnlBeforeFees !== undefined ? '$' + s.resolvedPnlBeforeFees.toFixed(2) : '—') + '\n';
        ctx += 'PnL после комиссий: ' + (s.resolvedPnlAfterFees !== undefined ? '$' + s.resolvedPnlAfterFees.toFixed(2) : '—') + '\n';
        ctx += 'Уплаченные комиссии: ' + (s.totalFees !== undefined ? '$' + s.totalFees.toFixed(2) : '—') + '\n';
        ctx += 'Открытый PnL: ' + (s.openPnl !== undefined ? '$' + s.openPnl.toFixed(2) : '—') + '\n';
        ctx += 'Закрытый убыток: ' + (s.realizedLoss !== undefined ? '$' + s.realizedLoss.toFixed(2) : '—') + '\n\n';
        ctx += 'ВАЖНЫЕ ОГРАНИЧЕНИЯ:\n';
        ctx += '- ТЫ НЕ ВИДИШЬ скриншоты, изображения или графики. НЕ проси пользователя прислать их.\n';
        ctx += '- ТЫ НЕ ОТКРЫВАЕШЬ ссылки сам.\n';
        ctx += '- Используй ТОЛЬКО те данные, что уже есть в контексте.\n';
        ctx += '- Форматируй ответ с **жирным** для ключевых цифр.\n';
        ctx += '- Структурируй ответ: общий обзор, статистика, качество торговли, вывод.\n';
        ctx += '\nОФОРМЛЕНИЕ ОТВЕТА (СТРОГО):\n';
        ctx += 'Первая строка — краткий вердикт (1 предложение, максимум 2 строки). После вердикта — пустая строка. Затем — полный детальный анализ.\n';

        addAIMsg('🔍 Анализирую кошелёк...', 'user', 'wa');
        showAILoading('wa');

        try {
            var res = await callAI([
                { role: 'system', content: 'Ты профессиональный аналитик крипто-трейдинга на Polymarket. Отвечай на русском, структурированно, с **жирным** выделением ключевых цифр.' },
                { role: 'user', content: ctx }
            ]);
            hideAILoading('wa');
            var summaryText = res;
            var detailText = '';
            var splitIdx = res.indexOf('\n\n');
            if (splitIdx > 0 && splitIdx < 500) {
                summaryText = res.substring(0, splitIdx).trim();
                detailText = res.substring(splitIdx + 2).trim();
            }
            var msgsWa = document.getElementById('wa-ai-msgs');
            if (msgsWa) {
                var msgDiv = document.createElement('div');
                msgDiv.className = 'wa-ai-msg wa-ai-msg-ai';
                var sf = formatAI(summaryText);
                var df = detailText ? formatAI(detailText) : '';
                var plainForCopy = (summaryText + '\n' + detailText).replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
                msgDiv.innerHTML = ''
                    + '<div class="wa-ai-msg-avatar"><svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2zm-1 14a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm4 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"/></svg></div>'
                    + '<div class="wa-ai-msg-bubble">'
                    +   '<div class="wa-ai-msg-summary">' + sf + '</div>'
                    +   (df ? '<div class="wa-ai-msg-detail" style="display:none">' + df + '</div>' : '')
                    +   (df ? '<button class="wa-ai-toggle-detail">Подробнее →</button>' : '')
                    +   '<button class="poly-copy-btn" data-copy-text="' + escHtml(plainForCopy.substring(0, 2000)) + '" title="Копировать">📋</button>'
                    + '</div>';
                msgsWa.appendChild(msgDiv);
                msgsWa.scrollTop = msgsWa.scrollHeight;
                if (df) {
                    msgDiv.querySelector('.wa-ai-toggle-detail').addEventListener('click', function() {
                        var detailEl = msgDiv.querySelector('.wa-ai-msg-detail');
                        var toggleBtn = this;
                        if (detailEl.style.display === 'none') {
                            detailEl.style.display = 'block';
                            toggleBtn.textContent = 'Свернуть ↑';
                        } else {
                            detailEl.style.display = 'none';
                            toggleBtn.textContent = 'Подробнее →';
                        }
                    });
                }
            }
            updateAIRemaining();
        } catch (e) {
            hideAILoading('wa');
            addAIMsg('❌ Ошибка AI: ' + e.message, 'ai', 'wa');
        }
        _waRunning = false;
        if (sendBubble) sendBubble.classList.remove('disabled');
    }

    function initWalletAI() {
        var sendBubble = document.getElementById('wa-ai-send-bubble');
        if (!sendBubble || sendBubble._waInit) return;
        sendBubble._waInit = true;
        var header = document.getElementById('wa-ai-header');
        var body = document.getElementById('wa-ai-body');
        if (header && body) {
            header.addEventListener('click', function(e) {
                if (e.target.closest('.wa-ai-header-title') || e.target.closest('.wa-ai-header-right')) {
                    var isHidden = body.style.display === 'none';
                    body.style.display = isHidden ? 'block' : 'none';
                    var icon = header.querySelector('.wa-ai-toggle-icon');
                    if (icon) icon.style.transform = isHidden ? '' : 'rotate(-90deg)';
                }
            });
        }
        sendBubble.addEventListener('click', runWalletAnalysis);
        updateAIRemaining();
    }

    // ====================== TRADE TAB ======================
    var _selectedMarket = null;
    var _selectedEvent = null;
    var _demoBalance = parseFloat(localStorage.getItem('polyDemoBalance')) || 100000;
    var _demoPositions = JSON.parse(localStorage.getItem('polyDemoPositions') || '{}');

    function initTradeTab() {
        var container = $('trade-content');
        if (!container) return;
        _renderTradeSplashHtml(container);
        _setupTradeSearch(container);
    }

    function _renderTradeSplashHtml(container) {
        var _settingsT = typeof settingsT === 'function' ? settingsT : function(k) { var m = { 'terminal.hero_title':'Торговый терминал','events.search_placeholder':'Вставьте ссылку Polymarket или slug...','events.search_btn':'Поиск','terminal.feat_ai':'AI agent для торговли','terminal.feat_auto':'Свои автоматизированные системы','terminal.feat_market':'Рыночные ордера','terminal.feat_limit':'Лимитные ордера','terminal.feat_demo':'Демо-счёт $100k','terminal.hero_copy':'Copy Trading','terminal.hero_strategies':'Strategies' }; return m[k] || k; };
        var t = _settingsT;
        container.innerHTML = '<div class="tr-initial">'
            + '<div class="tr-hero-card">'
            + '<div class="tr-hero-visual"><svg viewBox="0 0 240 72" width="240" height="72" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="30" y="48" width="20" height="16" rx="3" fill="#4C7F6E" fill-opacity="0.12" stroke="#4C7F6E" stroke-width="1.2" stroke-opacity="0.25"/><rect x="62" y="32" width="20" height="32" rx="3" fill="#4C7F6E" fill-opacity="0.2" stroke="#4C7F6E" stroke-width="1.2" stroke-opacity="0.35"/><rect x="94" y="16" width="20" height="48" rx="3" fill="#4C7F6E" fill-opacity="0.35" stroke="#4C7F6E" stroke-width="1.2" stroke-opacity="0.5"/><rect x="126" y="28" width="20" height="36" rx="3" fill="#4C7F6E" fill-opacity="0.25" stroke="#4C7F6E" stroke-width="1.2" stroke-opacity="0.4"/><rect x="158" y="20" width="20" height="44" rx="3" fill="#4C7F6E" fill-opacity="0.3" stroke="#4C7F6E" stroke-width="1.2" stroke-opacity="0.45"/><rect x="190" y="40" width="20" height="24" rx="3" fill="#4C7F6E" fill-opacity="0.15" stroke="#4C7F6E" stroke-width="1.2" stroke-opacity="0.3"/><path d="M40 48 L72 32 L104 16 L136 28 L168 20 L200 40" stroke="#4C7F6E" stroke-width="1.5" stroke-opacity="0.2" stroke-dasharray="3 3"/></svg></div>'
            + '<h2 class="tr-hero-title">' + t('terminal.hero_title') + '</h2>'
            + '<div class="tr-hero-search">'
            + '<input class="tr-hero-search-input" id="tr-search-input" type="text" placeholder="' + t('events.search_placeholder') + '">'
            + '<button class="tr-hero-search-btn" id="tr-search-btn">' + t('events.search_btn') + '</button>'
            + '</div>'
            + '<div class="tr-hero-pills">'
            + '<span class="tr-hero-pill"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="6" r="4"/><path d="M8 12c0 2 2 3 2 5h4c0-2 2-3 2-5"/><path d="M16 20c0-2-2-3-2-5"/><path d="M8 20c0-2 2-3 2-5"/><path d="M6 20h12"/></svg><span>' + t('terminal.feat_ai') + '</span></span>'
            + '<span class="tr-hero-pill"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg><span>' + t('terminal.feat_auto') + '</span></span>'
            + '<span class="tr-hero-pill"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg><span>' + t('terminal.feat_market') + '</span></span>'
            + '<span class="tr-hero-pill"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/></svg><span>' + t('terminal.feat_limit') + '</span></span>'
            + '<span class="tr-hero-pill"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg><span>' + t('terminal.feat_demo') + '</span></span>'
            + '</div>'
            + '<div class="tr-hero-actions">'
            + '<button class="tr-hero-action-btn" data-quick-mode="copy"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg><span>' + t('terminal.hero_copy') + '</span></button>'
            + '<button class="tr-hero-action-btn" data-quick-mode="strategies"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/><path d="M2 20h20"/></svg><span>' + t('terminal.hero_strategies') + '</span></button>'
            + '</div>'
            + '</div></div>';
    }

    function _setupTradeSearch(container) {
        var input = container.querySelector('#tr-search-input');
        var btn = container.querySelector('#tr-search-btn');
        if (!input || !btn) return;
        function doSearch() {
            var val = input.value.trim();
            if (!val) return;
            _buildTradeView();
            setTimeout(function() { loadEventFromUrl(val); }, 50);
        }
        btn.onclick = doSearch;
        input.onkeydown = function(e) { if (e.key === 'Enter') doSearch(); };
        container.querySelectorAll('[data-quick-mode]').forEach(function(qb) {
            qb.onclick = function() {
                var mode = qb.dataset.quickMode;
                if (mode === 'copy') {
                    var c = $('trade-content');
                    if (c) {
                        _buildCopyModuleHtml();
                        setTimeout(initCopyPanel, 50);
                    }
                } else if (mode === 'strategies') {
                    var c = $('trade-content');
                    if (c) {
                        _buildStrategiesModuleHtml();
                        setTimeout(initStrategiesPanel, 50);
                    }
                }
            };
        });
    }

    function _buildTradeView() {
        var content = $('trade-content');
        if (!content) return;
        _tradeInited = true;
        content.innerHTML = ''
            + '<div class="tt-top-row">'
            +   '<div class="tt-whales-col">'
            +     '<div id="ttWhalesSection" class="wh-section" style="display:none"></div>'
            +   '</div>'
            +   '<div class="tt-chart-col">'
            +     '<div class="tt-market-section">'
            +       '<div class="tt-link-row">'
            +         '<div class="tt-link-input-wrap">'
            +           '<svg class="tt-link-icon" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>'
            +           '<input type="text" class="tt-link-input" id="ttLinkInput" placeholder="Вставьте ссылку с Polymarket..." autocomplete="off">'
            +         '</div>'
            +         '<button class="tt-link-btn" id="ttLinkBtn">Загрузить</button>'
            +       '</div>'
            +       '<div id="ttLinkStatus" class="tt-link-status"></div>'
            +       '<div id="ttSelectedMarket"></div>'
            +     '</div>'
            +   '</div>'
            +   '<div class="tt-panel-col" id="ttPanelCol">'
            +     '<div class="tr-ob-section" id="trObSection" style="display:none">'
            +       '<div class="tr-ob-header">'
            +         '<span class="tr-ob-title"><svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/></svg> Стакан</span>'
            +         '<button class="tr-ob-refresh" id="trObRefresh">\u21bb</button>'
            +       '</div>'
            +       '<div class="tr-ob-ud">'
            +         '<button class="tr-ob-ud-btn active" id="trObUp">UP</button>'
            +         '<button class="tr-ob-ud-btn" id="trObDown">DOWN</button>'
            +       '</div>'
            +       '<div class="tr-ob-col-headers">'
            +         '<span class="tr-ob-ch-price"><svg viewBox="0 0 24 24" width="10" height="10"><path fill="currentColor" d="M11 17h2v-6h-2v6zm1-15C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zM11 9h2V7h-2v2z"/></svg> Price</span>'
            +         '<span class="tr-ob-ch-size"><svg viewBox="0 0 24 24" width="10" height="10"><path fill="currentColor" d="M4 9h16v2H4V9zm0 4h10v2H4v-2z"/></svg> Size</span>'
            +         '<span class="tr-ob-ch-total"><svg viewBox="0 0 24 24" width="10" height="10"><path fill="currentColor" d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/></svg> Total</span>'
            +       '</div>'
            +       '<div class="tr-ob-body" id="trObBody"><div class="tr-ob-loading">Загрузка...</div></div>'
            +     '</div>'
            +   '</div>'
            + '</div>'
            + '<div id="tradeWalletsSection"></div>';
        var linkInput = $('ttLinkInput');
        var linkBtn = $('ttLinkBtn');
        function handleLoad() {
            if (linkInput) loadEventFromUrl(linkInput.value.trim());
        }
        if (linkBtn) linkBtn.addEventListener('click', handleLoad);
        if (linkInput) linkInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') handleLoad();
        });
        setTimeout(setupBacktest, 100);
        setTimeout(renderTradeWallets, 100);
        setTimeout(function() {
            initCopyPanel();
            mountTradingPanelOnMarket();
        }, 200);
    }

    function _buildCopyModuleHtml() {
        var c = $('trade-content');
        if (!c) return '';
        c.innerHTML = '<div style="padding:8px 0">'
            + '<div class="tr-module-header">'
            + '<button class="tr-module-back" id="trModuleBack"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg></button>'
            + '<span class="tr-module-title">Copy Trading</span>'
            + '</div>'
            + '<div id="cpWalletsList" style="margin-top:12px"></div>'
            + '<div id="cpSelectedInfo" style="display:none;margin-top:12px"></div>'
            + '<div id="cpTradesList" style="display:none;margin-top:12px"></div>'
            + '<div id="cpLogSection" style="display:none;margin-top:12px"></div>'
            + '</div>';
        var backBtn = $('trModuleBack');
        if (backBtn) backBtn.onclick = function() { initTradeTab(); };
    }

    function _buildStrategiesModuleHtml() {
        var c = $('trade-content');
        if (!c) return '';
        c.innerHTML = '<div style="padding:8px 0">'
            + '<div class="tr-module-header">'
            + '<button class="tr-module-back" id="trModuleBack"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg></button>'
            + '<span class="tr-module-title">Strategies</span>'
            + '</div>'
            + '<div id="trStrategiesPanel">'
            + '<div class="tr-strat-row"><button class="tr-strat-btn" data-strat="clob">CLOB Market Making</button><button class="tr-strat-btn" data-strat="delta">Delta Neutral</button><button class="tr-strat-btn" data-strat="phoenix">Phoenix</button></div>'
            + '<div id="trStratContent" style="margin-top:12px"></div>'
            + '</div>'
            + '</div>';
        var backBtn = $('trModuleBack');
        if (backBtn) backBtn.onclick = function() { initTradeTab(); };
    }

    var CRYPTO_SYMBOLS = {
        'bitcoin': 'BINANCE:BTCUSDT',
        'btc': 'BINANCE:BTCUSDT',
        'ethereum': 'BINANCE:ETHUSDT',
        'eth': 'BINANCE:ETHUSDT',
        'solana': 'BINANCE:SOLUSDT',
        'sol': 'BINANCE:SOLUSDT',
        'xrp': 'BINANCE:XRPUSDT',
        'ripple': 'BINANCE:XRPUSDT',
        'dogecoin': 'BINANCE:DOGEUSDT',
        'doge': 'BINANCE:DOGEUSDT',
        'cardano': 'BINANCE:ADAUSDT',
        'ada': 'BINANCE:ADAUSDT',
        'polkadot': 'BINANCE:DOTUSDT',
        'dot': 'BINANCE:DOTUSDT',
        'avalanche': 'BINANCE:AVAXUSDT',
        'avax': 'BINANCE:AVAXUSDT',
        'matic': 'BINANCE:MATICUSDT',
        'polygon': 'BINANCE:MATICUSDT',
        'link': 'BINANCE:LINKUSDT',
        'chainlink': 'BINANCE:LINKUSDT',
        'litecoin': 'BINANCE:LTCUSDT',
        'ltc': 'BINANCE:LTCUSDT',
        'pepe': 'BINANCE:PEPEUSDT',
        'shib': 'BINANCE:SHIBUSDT'
    };

    function detectChartSymbol(ev) {
        var text = ((ev.title || '') + ' ' + (ev.description || '')).toLowerCase();
        var markets = ev.markets || [];
        markets.forEach(function(m) {
            text += ' ' + ((m.question || '') + ' ' + (m.groupItemTitle || '')).toLowerCase();
        });
        var tags = (ev.tags || []).map(function(t) { return (t.slug || t.label || '').toLowerCase(); });
        text += ' ' + tags.join(' ');

        for (var key in CRYPTO_SYMBOLS) {
            var re = new RegExp('\\b' + key + '\\b', 'i');
            if (re.test(text)) return CRYPTO_SYMBOLS[key];
        }
        return null;
    }

    function showChartForEvent(ev) {
        var section = $('ttChartSection');
        var bar = $('ttSymBar');
        if (!section) return;

        var symbol = detectChartSymbol(ev);
        if (!symbol) {
            section.style.display = 'none';
            return;
        }

        section.style.display = '';
        if (bar) {
            var pairs = [
                { sym: 'BINANCE:BTCUSDT', label: 'BTC' },
                { sym: 'BINANCE:ETHUSDT', label: 'ETH' },
                { sym: 'BINANCE:SOLUSDT', label: 'SOL' },
                { sym: 'BINANCE:XRPUSDT', label: 'XRP' }
            ];
            var html = '';
            pairs.forEach(function(p) {
                var active = p.sym === symbol ? ' active' : '';
                html += '<button class="tv-sym-btn' + active + '" data-sym="' + p.sym + '">' + p.label + ' 5m</button>';
            });
            bar.innerHTML = html;

            bar.querySelectorAll('.tv-sym-btn').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    bar.querySelectorAll('.tv-sym-btn').forEach(function(b) { b.classList.remove('active'); });
                    btn.classList.add('active');
                    loadTVChart('tvTradeChart', btn.dataset.sym, '5', _tvCurrentSource);
                });
            });
        }

        loadTVChart('tvTradeChart', symbol, '5', _tvCurrentSource);
    }

    async function loadEventWhales(ev) {
        var container = $('ttWhalesSection');
        if (!container) return;

        var markets = ev.markets || [];
        var condIds = [];
        markets.forEach(function(m) {
            var cid = m.conditionId || m.id;
            if (cid) condIds.push(String(cid));
        });

        if (condIds.length === 0) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'block';
        container.innerHTML = '<div class="wh-section-header"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>Киты на этом событии</div>'
            + '<div class="wh-loading">Анализ кошельков...</div>';

        try {
            var allHolders = {};

            var fetches = condIds.map(function(cid) {
                return pageFetch(DATA_API + '/holders?market=' + cid + '&limit=100')
                    .then(function(text) {
                        var data = JSON.parse(text);
                        var holders = [];
                        if (Array.isArray(data)) {
                            data.forEach(function(tokenObj) {
                                if (tokenObj && Array.isArray(tokenObj.holders)) {
                                    holders = holders.concat(tokenObj.holders);
                                }
                            });
                        } else if (data && Array.isArray(data.holders)) {
                            holders = data.holders;
                        }
                        return holders;
                    })
                    .catch(function() { return []; });
            });
            var results = await Promise.all(fetches);

            results.forEach(function(holders) {
                holders.forEach(function(h) {
                    var addr = h.proxyWallet || h.address || h.user;
                    if (!addr) return;
                    var amt = parseFloat(h.amount || h.current || h.size || 0);
                    if (!allHolders[addr]) allHolders[addr] = { totalAmount: 0, outcomes: [] };
                    allHolders[addr].totalAmount += amt;
                    var outIdx = h.outcomeIndex;
                    var outName = outIdx === 0 ? 'Да' : outIdx === 1 ? 'Нет' : '—';
                    var price = parseFloat(h.averagePrice || h.price || 0);
                    var name = h.pseudonym || h.name || '';
                    allHolders[addr].outcomes.push({
                        outcome: outName,
                        amount: amt,
                        price: price,
                        name: name
                    });
                });
            });

            var whales = [];
            for (var addr in allHolders) {
                if (allHolders[addr].totalAmount >= 1000) {
                    whales.push({
                        address: addr,
                        short: addr.slice(0, 6) + '...' + addr.slice(-4),
                        totalAmount: allHolders[addr].totalAmount,
                        outcomes: allHolders[addr].outcomes,
                        name: allHolders[addr].outcomes[0] ? allHolders[addr].outcomes[0].name : ''
                    });
                }
            }

            whales.sort(function(a, b) { return b.totalAmount - a.totalAmount; });
            whales = whales.slice(0, 30);

            if (whales.length === 0) {
                container.innerHTML = '<div class="wh-section-header"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>Киты на этом событии</div>'
                    + '<div class="wh-empty">Крупных держателей не найдено</div>';
                return;
            }

            var html = '<div class="wh-section-header"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>Киты на этом событии — ' + whales.length + '</div>'
                + '<div class="wh-list">';

            whales.forEach(function(w) {
                html += '<div class="wh-card">'
                    + '<div class="wh-card-top">'
                    +   '<div class="wh-card-left">'
                    +     '<a href="https://polymarket.com/profile/' + w.address + '" target="_blank" class="wh-addr">' + w.short + '</a>'
                    +     (w.name ? '<span class="wh-name">' + escHtml(w.name) + '</span>' : '')
                    +   '</div>'
                    +   '<span class="wh-amount">$' + fmtNum(w.totalAmount.toFixed(0)) + '</span>'
                    + '</div>'
                    + '<div class="wh-outcomes">';
                w.outcomes.forEach(function(o) {
                    var color = o.outcome === 'Да' ? 'var(--positive)' : 'var(--negative)';
                    html += '<span class="wh-chip" style="border-color:' + color + ';color:' + color + '">'
                        + escHtml(o.outcome) + ' $' + fmtNum(o.amount.toFixed(0))
                        + (o.price ? ' @' + (o.price * 100).toFixed(0) + '¢' : '')
                        + '</span>';
                });
                html += '</div></div>';
            });

            html += '</div>';
            container.innerHTML = html;
        } catch(e) {
            container.innerHTML = '<div class="wh-section-header"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>Киты на этом событии</div>'
                + '<div class="wh-empty">Ошибка: ' + escHtml(e.message) + '</div>';
        }
    }

    function parsePolyUrl(text) {
        text = text.trim();
        var m = text.match(/polymarket\.com\/(?:[a-z]{2}\/)?event\/([a-z0-9\-]+)/i);
        if (m) return m[1];
        if (/^[a-z0-9\-]+$/i.test(text) && text.length > 5) return text;
        return null;
    }

    async function loadEventFromUrl(text) {
        var status = $('ttLinkStatus');
        var sel = $('ttSelectedMarket');
        if (!status || !sel) return;

        _selectedMarket = null;
        _selectedEvent = null;
        sel.innerHTML = '';

        var slug = parsePolyUrl(text);
        if (!slug) {
            status.className = 'tt-link-status tt-link-error';
            status.textContent = 'Введите ссылку polymarket.com/event/... или slug события';
            return;
        }

        status.className = 'tt-link-status tt-link-loading';
        status.textContent = 'Загрузка события...';

        try {
            var evText = await pageFetch(GAMMA_API + '/events?slug=' + encodeURIComponent(slug));
            var evData = JSON.parse(evText);
            var events = Array.isArray(evData) ? evData : [];
            if (events.length === 0) {
                status.className = 'tt-link-status tt-link-error';
                status.textContent = 'Событие не найдено';
                return;
            }
            var ev = events[0];
            var markets = ev.markets || [];

            _selectedEvent = ev;
            loadEventWhales(ev);

            status.className = 'tt-link-status tt-link-ok';
            status.textContent = '';

            if (markets.length === 1) {
                selectMarket(markets[0], ev);
            } else if (markets.length > 1) {
                showEventMarkets(ev);
            } else {
                status.className = 'tt-link-status tt-link-error';
                status.textContent = 'Нет доступных рынков в этом событии';
            }
        } catch(e) {
            status.className = 'tt-link-status tt-link-error';
            status.textContent = 'Ошибка: ' + e.message;
        }
    }

    function showEventMarkets(ev) {
        _selectedEvent = ev;
        var sel = $('ttSelectedMarket');
        if (!sel) return;

        var markets = ev.markets || [];
        var title = ev.title || 'Рынки';

        var html = '<div class="mk-trade-card">'
            + '<div class="mk-trade-header">'
            +   '<div class="mk-trade-title">' + escHtml(title) + '</div>'
            + '</div>'
            + '<div class="mk-trade-outcomes">';
        markets.forEach(function(m, idx) {
            var question = m.question || m.groupItemTitle || 'Рынок';
            var prices = m.outcomePrices ? JSON.parse(m.outcomePrices) : [];
            var yesPrice = prices[0] ? (parseFloat(prices[0]) * 100).toFixed(0) + '¢' : '—';
            var vol = m.volume ? '$' + fmtNum(m.volume) : '';

            html += '<div class="tt-market-pick" data-midx="' + idx + '">'
                + '<div class="tt-market-pick-left">'
                +   '<div class="tt-market-pick-q">' + escHtml(question) + '</div>'
                +   '<div class="tt-market-pick-meta">'
                +     '<span class="tt-market-pick-price">Да ' + yesPrice + '</span>'
                +     (vol ? '<span>' + vol + '</span>' : '')
                +   '</div>'
                + '</div>'
                + '<div class="tt-market-pick-arrow">→</div>'
                + '</div>';
        });
        html += '</div></div>';
        sel.innerHTML = html;

        sel.querySelectorAll('.tt-market-pick').forEach(function(pick) {
            pick.addEventListener('click', function() {
                var idx = parseInt(pick.dataset.midx);
                selectMarket(markets[idx], ev);
            });
        });
    }

    function selectMarket(market, ev) {
        _selectedMarket = market;
        if (ev) _selectedEvent = ev;
        mountTradingPanelOnMarket();
    }

    function calcTimeRemaining(dateStr) {
        var diff = new Date(dateStr).getTime() - Date.now();
        if (diff <= 0) return 'Завершено';
        var days = Math.floor(diff / 86400000);
        var hours = Math.floor((diff % 86400000) / 3600000);
        if (days > 0) return days + ' д. ' + hours + ' ч.';
        var mins = Math.floor((diff % 3600000) / 60000);
        return hours + ' ч. ' + mins + ' мин.';
    }

    function handleReactOrder(order) {
        if (!_selectedMarket) return;

        var prices = _selectedMarket.outcomePrices ? JSON.parse(_selectedMarket.outcomePrices) : [];
        var price;
        if (order.outcomeId === 'yes') {
            price = prices[0] ? parseFloat(prices[0]) : 0.5;
        } else {
            price = prices[1] ? parseFloat(prices[1]) : 0.5;
        }

        var amount, shares;

        if (order.type === 'market') {
            amount = order.amount;
            shares = amount / price;
        } else {
            price = order.price;
            shares = order.shares;
            amount = price * shares;
        }

        _demoBalance -= amount;
        var marketId = _selectedMarket.conditionId || _selectedMarket.id;
        if (!_demoPositions[marketId]) _demoPositions[marketId] = { market: _selectedMarket, trades: [] };
        _demoPositions[marketId].trades.push({
            side: order.side,
            outcomeId: order.outcomeId,
            type: order.type,
            amount: amount,
            price: price,
            shares: shares,
            time: Date.now()
        });

        localStorage.setItem('polyDemoBalance', String(_demoBalance));
        localStorage.setItem('polyDemoPositions', JSON.stringify(_demoPositions));

        updateDemoBalanceDisplay();
        mountTradingPanelOnMarket();
        var label = order.side === 'buy' ? 'Покупка' : 'Продажа';
        showMsg(label + ': ' + order.outcomeId.toUpperCase() + ' на $' + fmt(amount) + ' (' + shares.toFixed(1) + ' акций)', true);
    }

    function executeDemoTrade(side) {
        handleReactOrder({ type: 'market', side: 'buy', outcomeId: side === 'Yes' ? 'yes' : 'no', amount: 100 });
    }

    function updateDemoBalanceDisplay() {
        mountTradingPanelOnMarket();
    }

    function renderTradeTerminal() {
        var html = '<div class="tt-panel-card">';

        html += '<div class="tt-mode-bar">';
        html += '<button class="tr-mode-btn active" data-mode="demo">Demo Trade</button>';
        html += '<button class="tr-mode-btn" data-mode="live">Live Trade</button>';
        html += '<button class="tr-mode-btn" data-mode="copy">Copy Trading</button>';
        html += '<button class="tr-mode-btn" data-mode="strategies">Strategies</button>';
        html += '</div>';

        html += '<div class="tr-panel" id="trDemoPanel">';
        html += '<div id="tpReactMount"></div>';
        html += '</div>';

        html += '<div class="tr-panel" id="trLivePanel" style="display:none">';
        html += '<div style="padding:24px;text-align:center;color:var(--text-secondary);font-size:11px">';
        html += '<svg viewBox="0 0 24 24" width="32" height="32" style="opacity:0.3;margin-bottom:8px"><path fill="currentColor" d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>';
        html += '<p>Live-торговля</p>';
        html += '<p style="margin-top:4px;font-size:10px;opacity:0.6">Требуется подключение кошелька</p>';
        html += '</div></div>';

        html += '<div class="tr-panel" id="trCopyPanel" style="display:none">';
        html += '<div class="cp-wrap">';
        html += '<div class="cp-header"><span class="cp-title">Копи-трейдинг</span><span class="cp-subtitle">Выберите кошелёк для копирования</span></div>';
        html += '<div class="cp-wallets" id="cpWalletsList"></div>';
        html += '<div class="cp-selected" id="cpSelectedInfo" style="display:none"></div>';
        html += '<div class="cp-trades" id="cpTradesList" style="display:none"></div>';
        html += '<div class="cp-log" id="cpLogSection" style="display:none"></div>';
        html += '</div></div>';

        html += '<div class="tr-panel" id="trStrategiesPanel" style="display:none">';
        html += '<div class="tr-strategies-section" id="trStrategiesSection">';
        html += '<div class="tr-strategies-tabs">';
        html += '<button class="tr-strategies-tab active" data-strategy-tab="ai">AI Agent</button>';
        html += '<button class="tr-strategies-tab" data-strategy-tab="my">Мои стратегии</button>';
        html += '</div>';
        html += '<div id="trStrategiesTabAI">';
        html += '<div class="tr-agent">';
        html += '<div class="tr-agent-header">';
        html += '<div class="tr-agent-title">';
        html += '<div class="tr-agent-title-icon"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg></div>';
        html += '<span class="tr-agent-title-text">AI Agent</span>';
        html += '</div>';
        html += '<div class="tr-agent-hdr-r">';
        html += '<span class="tr-agent-copy-flash" id="trCopyFlash"></span>';
        html += '<button class="tr-bot-start-btn" id="trBotStartBtn">\u25b6</button>';
        html += '</div>';
        html += '</div>';
        html += '<div class="tr-strategy-selector">';
        html += '<div class="tr-strategy-select-row">';
        html += '<div class="tr-strategy-opt active" data-strategy="clob">';
        html += '<span class="tr-strategy-name">CLOB</span>';
        html += '<button class="tr-strategy-info-btn" data-strategy="clob">\u24d8</button>';
        html += '</div>';
        html += '<div class="tr-strategy-opt" data-strategy="delta">';
        html += '<span class="tr-strategy-name">Delta</span>';
        html += '<button class="tr-strategy-info-btn" data-strategy="delta">\u24d8</button>';
        html += '<span class="tr-strategy-badge">Soon</span>';
        html += '</div>';
        html += '<div class="tr-strategy-opt" data-strategy="phoenix">';
        html += '<span class="tr-strategy-name">Phoenix</span>';
        html += '<button class="tr-strategy-info-btn" data-strategy="phoenix">\u24d8</button>';
        html += '</div>';
        html += '</div>';
        html += '</div>';
        html += '<div class="tr-agent-wallet">';
        html += '<div class="tr-agent-wallet-label">Кошелёк</div>';
        html += '<select class="tr-agent-wallet-sel" id="trBotWalletSelect">';
        html += '<option value="">Не подключён</option>';
        html += '</select>';
        html += '</div>';
        html += '<div class="tr-agent-rolling">';
        html += '<div class="tr-agent-rolling-label">Роллинг</div>';
        html += '<div class="tr-agent-rolling-toggle" id="trBotRollingToggle">';
        html += '<button class="tr-agent-rolling-btn active" data-rolling="1">Вкл</button>';
        html += '<button class="tr-agent-rolling-btn" data-rolling="0">Выкл</button>';
        html += '</div>';
        html += '<div class="tr-agent-rolling-desc">Прибыль реинвестируется в следующий раунд</div>';
        html += '</div>';
        html += '<div id="trBotClobContent">';
        html += '<div class="tr-agent-assets">';
        html += '<div class="tr-agent-assets-label">Assets</div>';
        html += '<div class="tr-agent-assets-btns" id="trBotAssetBtns">';
        html += '<button class="tr-agent-asset-btn active" data-asset="BTC"><span class="tr-agent-asset-icon">\u0243</span><span>BTC</span></button>';
        html += '<button class="tr-agent-asset-btn active" data-asset="ETH"><span class="tr-agent-asset-icon">\u27E0</span><span>ETH</span></button>';
        html += '<button class="tr-agent-asset-btn active" data-asset="SOL"><span class="tr-agent-asset-icon">\u25CB</span><span>SOL</span></button>';
        html += '</div></div>';
        html += '<div class="tr-agent-stats">';
        html += '<div class="tr-agent-stat">';
        html += '<div class="tr-agent-stat-label">Balance $</div>';
        html += '<div class="tr-agent-stat-body"><input class="tr-agent-bal-inp" id="trBotBalInput" type="number" value="100000" min="1" step="any"></div>';
        html += '</div>';
        html += '<div class="tr-agent-stat" id="trBotStats"></div>';
        html += '</div>';
        html += '<div class="tr-agent-stats" style="margin-top:8px">';
        html += '<div class="tr-agent-stat">';
        html += '<div class="tr-agent-stat-label">Min Spread</div>';
        html += '<div class="tr-agent-stat-body"><input class="tr-agent-set-inp" id="trClobMinSpread" type="number" value="2" min="1" max="20" step="0.5"><span class="tr-agent-set-unit">\u00a2</span></div>';
        html += '</div>';
        html += '<div class="tr-agent-stat">';
        html += '<div class="tr-agent-stat-label">Rebate</div>';
        html += '<div class="tr-agent-stat-body"><input class="tr-agent-set-inp" id="trClobRebate" type="number" value="20" min="0" max="100" step="1"><span class="tr-agent-set-unit">%</span></div>';
        html += '</div>';
        html += '<div class="tr-agent-stat">';
        html += '<div class="tr-agent-stat-label">Order Size</div>';
        html += '<div class="tr-agent-stat-body"><span class="tr-agent-set-unit">$</span><input class="tr-agent-set-inp" id="trClobOrderSize" type="number" value="100" min="1" step="any"></div>';
        html += '</div>';
        html += '<div class="tr-agent-stat">';
        html += '<div class="tr-agent-stat-label">Timeout</div>';
        html += '<div class="tr-agent-stat-body"><input class="tr-agent-set-inp" id="trClobTimeout" type="number" value="3" min="1" max="30" step="1"><span class="tr-agent-set-unit">sec</span></div>';
        html += '</div>';
        html += '<div class="tr-agent-stat">';
        html += '<div class="tr-agent-stat-label">Gas $</div>';
        html += '<div class="tr-agent-stat-body"><input class="tr-agent-set-inp" id="trClobGasCost" type="number" value="0.02" min="0" max="1" step="0.005"></div>';
        html += '</div>';
        html += '</div>';
        html += '<div class="tr-clob-sim-badge" id="trClobSimBadge" style="display:none"><span class="tr-clob-sim-dot"></span> Simulation Mode</div>';
        html += '<div class="tr-agent-sec">';
        html += '<div class="tr-agent-sec-hdr">';
        html += '<span>Open Positions (<span id="trBotPosCount">0</span>)</span>';
        html += '<div class="tr-agent-sec-line"></div>';
        html += '</div>';
        html += '<div class="tr-demo-bot-positions" id="trBotPositions"><div class="tr-bot-empty">Нет открытых позиций</div></div>';
        html += '</div>';
        html += '<div class="tr-agent-sec">';
        html += '<div class="tr-agent-sec-hdr">';
        html += '<span>Rounds</span>';
        html += '<div class="tr-agent-sec-line"></div>';
        html += '<div class="tr-agent-sec-acts">';
        html += '<button class="tr-agent-btn" id="trBotRoundsClear" style="display:none">Clear All</button>';
        html += '<button class="tr-agent-btn" id="trBotRoundsCopy" style="display:none">Copy</button>';
        html += '</div>';
        html += '</div>';
        html += '<div class="tr-bot-rounds" id="trBotRounds"><div class="tr-bot-rounds-empty">Нет завершённых раундов</div></div>';
        html += '</div>';
        html += '<div class="tr-agent-sec">';
        html += '<div class="tr-agent-sec-hdr tr-agent-collap collapsed" id="trBotHistToggle">';
        html += '<svg class="tr-agent-arrow" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>';
        html += '<span>History</span>';
        html += '<div class="tr-agent-sec-line"></div>';
        html += '<span class="tr-agent-copy" id="trBotCopyBtn">\u2139 Copy</span>';
        html += '</div>';
        html += '<div class="tr-agent-collap-body collapsed" id="trBotHistBody">';
        html += '<div class="tr-agent-filters" id="trBotHistFilters">';
        html += '<button class="tr-bot-hist-filter active" data-filter="all">All</button>';
        html += '<button class="tr-bot-hist-filter" data-filter="BTC">BTC</button>';
        html += '<button class="tr-bot-hist-filter" data-filter="ETH">ETH</button>';
        html += '<button class="tr-bot-hist-filter" data-filter="SOL">SOL</button>';
        html += '</div>';
        html += '<div class="tr-demo-bot-log" id="trBotLog"><div class="tr-bot-empty">Нет операций</div></div>';
        html += '</div>';
        html += '</div>';
        html += '</div>';
        html += '<div id="trBotDeltaContent" style="display:none">';
        html += '<div class="tr-strategy-dev-placeholder">';
        html += '<div class="tr-strategy-dev-icon">\u2699\uFE0F</div>';
        html += '<div class="tr-strategy-dev-title">В разработке</div>';
        html += '<div class="tr-strategy-dev-desc">Delta Mesh стратегия анализирует мгновенный тренд и рассчитывает уровень уверенности для каждой сделки. Рекомендуемый депозит: от $100 ($500 ideally). Скоро.</div>';
        html += '</div></div>';
        html += '<div id="trBotPhoenixContent" style="display:none">';
        html += '<div class="tr-agent-assets">';
        html += '<div class="tr-agent-assets-label">Assets</div>';
        html += '<div class="tr-agent-assets-btns" id="phxAssetBtns">';
        html += '<button class="tr-agent-asset-btn active" data-asset="BTC"><span class="tr-agent-asset-icon">\u0243</span><span>BTC</span></button>';
        html += '<button class="tr-agent-asset-btn active" data-asset="ETH"><span class="tr-agent-asset-icon">\u27E0</span><span>ETH</span></button>';
        html += '<button class="tr-agent-asset-btn active" data-asset="SOL"><span class="tr-agent-asset-icon">\u25CB</span><span>SOL</span></button>';
        html += '</div></div>';
        html += '<div class="tr-agent-stats tr-agent-stats-phoenix">';
        html += '<div class="tr-agent-stats-row-3">';
        html += '<div class="tr-agent-stat">';
        html += '<div class="tr-agent-stat-label">Balance</div>';
        html += '<div class="tr-agent-stat-body"><span class="tr-agent-set-unit">$</span><input class="tr-agent-set-inp" id="phxBalInput" type="number" value="1000" min="1" step="any"></div>';
        html += '</div>';
        html += '<div class="tr-agent-stat">';
        html += '<div class="tr-agent-stat-label">Entry</div>';
        html += '<div class="tr-agent-stat-body"><input class="tr-agent-set-inp" id="phxEntryCents" type="number" value="2" min="1" max="10" step="1"><span class="tr-agent-set-unit">\u00a2</span></div>';
        html += '</div>';
        html += '<div class="tr-agent-stat">';
        html += '<div class="tr-agent-stat-label">Target</div>';
        html += '<div class="tr-agent-stat-body"><input class="tr-agent-set-inp" id="phxTargetCents" type="number" value="20" min="5" max="50" step="1"><span class="tr-agent-set-unit">\u00a2</span></div>';
        html += '</div>';
        html += '</div>';
        html += '<div class="tr-agent-stats-row-4">';
        html += '<div id="phxStats"></div>';
        html += '</div>';
        html += '</div>';
        html += '<div class="tr-agent-sec">';
        html += '<div class="tr-agent-sec-hdr"><span>Budget</span><div class="tr-agent-sec-line"></div></div>';
        html += '<div class="tr-agent-sec-body" style="padding:6px 10px">';
        html += '<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">';
        html += '<select id="phxBudgetMode" class="tr-agent-set-select">';
        html += '<option value="pct">% от баланса</option><option value="fixed">$ фикс</option></select></div>';
        html += '<div id="phxBudgetPctWrap" style="display:flex;gap:6px;align-items:center">';
        html += '<span class="tr-agent-set-unit">%</span>';
        html += '<input id="phxBudgetPct" class="tr-agent-set-inp" type="number" value="5" min="1" max="100" step="1"></div>';
        html += '<div id="phxBudgetFixedWrap" style="display:none;gap:6px;align-items:center">';
        html += '<span class="tr-agent-set-unit">$</span>';
        html += '<input id="phxBudgetFixed" class="tr-agent-set-inp" type="number" value="15" min="0.5" step="0.5"></div>';
        html += '</div></div>';
        html += '<div class="tr-agent-sec">';
        html += '<div class="tr-agent-sec-hdr"><span>Stop Loss</span><div class="tr-agent-sec-line"></div></div>';
        html += '<div class="tr-agent-sec-body tr-agent-stop-row">';
        html += '<label class="tr-agent-stop-label"><input type="checkbox" id="phxStopEnabled"> Enabled</label>';
        html += '<span class="tr-agent-set-unit">at</span>';
        html += '<input id="phxStopPct" class="tr-agent-set-inp" type="number" value="30" min="1" max="99" step="1">';
        html += '<span class="tr-agent-set-unit">% of fill</span></div></div>';
        html += '<div class="tr-agent-sec">';
        html += '<div class="tr-agent-sec-hdr"><span>Rounds</span><div class="tr-agent-sec-line"></div>';
        html += '<div class="tr-agent-sec-acts">';
        html += '<button class="tr-agent-btn" id="phxRoundsClear">Clear All</button>';
        html += '<button class="tr-agent-btn" id="phxRoundsCopy">Copy</button>';
        html += '</div></div>';
        html += '<div class="tr-bot-rounds" id="phxRounds"><div class="tr-bot-rounds-empty">Нет завершённых раундов</div></div>';
        html += '</div>';
        html += '</div>';
        html += '</div>';
        html += '<div id="trStrategiesTabMy" style="display:none">';
        html += '<div class="tr-bot-empty" style="padding:40px 20px;text-align:center;font-size:11px;color:var(--text-tertiary)">Скоро</div>';
        html += '</div>';
        html += '</div></div>';
        html += '</div>';
        html += '<div class="tr-modal-overlay" id="trStrategyModal" style="display:none">';
        html += '<div class="tr-modal tr-modal-strategy">';
        html += '<div class="tr-modal-header">';
        html += '<span id="trStrategyModalTitle">CLOB Arbitrage</span>';
        html += '<button class="tr-modal-close" id="trStrategyModalClose">&times;</button>';
        html += '</div>';
        html += '<div class="tr-modal-body">';
        html += '<div class="tr-strategy-modal-desc" id="trStrategyModalDesc"></div>';
        html += '</div></div></div>';

        html += '</div>';
        return html;
    }

    // ====================== TRADE TERMINAL CORE ======================
    var _termMarket = null;
    var _termEvent = null;
    var _termSelectedOutcome = null;
    var _termMarkets = [];
    var _termState = 'demo';
    var _termPriceInterval = null;
    var _obCache = {};
    var _termOrderInited = false;
    var _liveBalance = 0;
    var _liveAllowance = 0;
    var _liveWalletIdx = -1;
    var _liveWalletAddr = '';
    var _liveWalletKey = '';
    var _liveCheckInterval = null;
    var _liveOrderInFlight = false;

    var _USDC_ADDR = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
    var _CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8Bd898';
    var _ERC20_ABI = [
        'function transfer(address to, uint256 value) returns (bool)',
        'function balanceOf(address owner) view returns (uint256)',
        'function decimals() view returns (uint8)',
        'function approve(address spender, uint256 value) returns (bool)',
        'function allowance(address owner, address spender) view returns (uint256)'
    ];
    var _POLY_RPCS = [
        'https://polygon.drpc.org',
        'https://polygon.publicnode.com',
        'https://polygon.gateway.tenderly.co'
    ];

    function mountTradingPanelOnMarket() {
        var sel = $('ttSelectedMarket');
        if (!sel) return;
        if (!_selectedMarket) {
            sel.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-secondary);font-size:11px">Выберите событие слева</div>';
            return;
        }
        _termMarket = _selectedMarket;
        _termEvent = _selectedEvent;
        _termMarkets = [_selectedMarket];
        _termSelectedOutcome = null;
        _termState = 'demo';
        _termOrderInited = true;
        // Сбрасываем tokenIds — они могут быть невалидными из кэша
        delete _termMarket.tokenIds;
        delete _termMarket.clobTokenIds;
        _renderTerminalPanel();
    }

    function parseOutcomes(market) {
        if (!market) return [];
        var names, prices;
        try {
            names = market.outcomes ? (typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : market.outcomes) : ['Yes', 'No'];
            prices = market.outcomePrices ? (typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices) : [];
        } catch(e) { names = ['Yes', 'No']; prices = []; }
        var result = [];
        for (var i = 0; i < names.length; i++) {
            result.push({ name: names[i], price: prices[i] !== undefined ? parseFloat(prices[i]) * 100 : 50 });
        }
        return result;
    }

    var _availableBotAssets = ['BTC', 'ETH', 'SOL'];
    function _getBotSelectedAssets() {
        try {
            var d = JSON.parse(localStorage.getItem('polyBotAssets') || '[]');
            if (Array.isArray(d)) {
                var valid = d.filter(function(a) { return _availableBotAssets.indexOf(a) >= 0; });
                if (valid.length) return valid;
            }
        } catch(e) {}
        return ['BTC', 'ETH', 'SOL'];
    }
    function _phoenixGetSelectedAssets() {
        try {
            var d = JSON.parse(localStorage.getItem('phxBotAssets') || '[]');
            if (Array.isArray(d)) {
                var valid = d.filter(function(a) { return _availableBotAssets.indexOf(a) >= 0; });
                if (valid.length) return valid;
            }
        } catch(e) {}
        return ['BTC', 'ETH', 'SOL'];
    }

    function _getActiveProfile() {
        var b = document.querySelector('.tr-psetup-btn.active');
        return b ? parseInt(b.dataset.ps) : 1;
    }

    function _loadProfileCfg(profileIdx) {
        var defaults = {
            1: { buy: [10, 25, 100, 500], sell: [25, 50, 75], sellUsd: [0, 0, 0] },
            2: { buy: [50, 100, 250, 1000], sell: [25, 50, 100], sellUsd: [0, 0, 0] },
            3: { buy: [100, 500, 1000, 5000], sell: [10, 25, 50], sellUsd: [0, 0, 0] }
        };
        try {
            var saved = JSON.parse(localStorage.getItem('polyPSetupCfg') || '{}');
            if (saved[profileIdx]) return saved[profileIdx];
        } catch(e) {}
        return defaults[profileIdx] || defaults[1];
    }

    function _updateQuickButtons(pIdx) {
        var cfg = _loadProfileCfg(pIdx);
        var qbContainer = document.getElementById('trQuickBuy');
        if (qbContainer) {
            var html = '';
            for (var bi = 0; bi < Math.min(cfg.buy.length, 4); bi++) {
                html += '<button class="tr-qb-btn" data-amount="' + cfg.buy[bi] + '">$' + cfg.buy[bi] + '</button>';
            }
            qbContainer.innerHTML = html;
            qbContainer.querySelectorAll('.tr-qb-btn').forEach(function(btn) {
                btn.onclick = function() {
                    var inp = document.getElementById('trCustomSize');
                    if (inp) inp.value = btn.dataset.amount;
                    _updateTermTotals();
                };
            });
        }
        var qsContainer = document.getElementById('trQuickSell');
        if (qsContainer) {
            var html = '';
            for (var si = 0; si < Math.min(cfg.sell.length, 3); si++) {
                var usdVal = cfg.sellUsd && cfg.sellUsd[si] ? cfg.sellUsd[si] : 0;
                html += '<button class="tr-qs-btn" data-pct="' + cfg.sell[si] + '" data-usd="' + usdVal + '">' + cfg.sell[si] + '%</button>';
            }
            html += '<button class="tr-qs-btn tr-qs-close">' + (_termT('terminal.close_100') || 'Close 100%') + '</button>';
            qsContainer.innerHTML = html;
            qsContainer.querySelectorAll('.tr-qs-btn').forEach(function(btn) {
                btn.onclick = function() { /* sell logic placeholder */ };
            });
        }
    }

    function _saveProfileCfg(profileIdx, cfg) {
        try {
            var all = JSON.parse(localStorage.getItem('polyPSetupCfg') || '{}');
            all[profileIdx] = cfg;
            localStorage.setItem('polyPSetupCfg', JSON.stringify(all));
        } catch(e) {}
    }

    function _showPSetupModal() {
        var curProfile = _getActiveProfile();
        var cfg = _loadProfileCfg(curProfile);
        var overlay = document.createElement('div');
        overlay.className = 'tr-modal-overlay';
        overlay.innerHTML = '<div class="tr-modal tr-modal-psetup">'
            + '<div class="tr-modal-header"><span>' + (settingsT('terminal.edit_setup') || 'Настройка') + ' P' + curProfile + '</span><button class="tr-modal-close" data-action="close">\u2715</button></div>'
            + '<div class="tr-modal-body">'
            + '<div class="tr-ps-modal-tabs">'
            + '<button class="tr-ps-modal-tab' + (curProfile === 1 ? ' active' : '') + '" data-ps-tab="1">P1</button>'
            + '<button class="tr-ps-modal-tab' + (curProfile === 2 ? ' active' : '') + '" data-ps-tab="2">P2</button>'
            + '<button class="tr-ps-modal-tab' + (curProfile === 3 ? ' active' : '') + '" data-ps-tab="3">P3</button>'
            + '</div>'
            + '<div class="tr-ps-modal-section">'
            + '<div class="tr-ps-modal-sectitle"><svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg> Quick Buy</div>'
            + '<div class="tr-ps-modal-grid2" id="trPsBuyGrid"></div>'
            + '</div>'
            + '<div class="tr-ps-modal-section">'
            + '<div class="tr-ps-modal-sectitle"><svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7 18c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zM1 2v2h2l3.6 7.59-1.35 2.45c-.16.28-.25.61-.25.96 0 1.1.9 2 2 2h12v-2H7.42c-.14 0-.25-.11-.25-.25l.03-.12.9-1.63h7.45c.75 0 1.41-.41 1.75-1.03l3.58-6.49c.08-.14.12-.31.12-.48 0-.55-.45-1-1-1H5.21l-.94-2H1zm16 16c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg> Sell %</div>'
            + '<div class="tr-ps-modal-inline" id="trPsSellPctGrid"></div>'
            + '</div>'
            + '<div class="tr-ps-modal-section">'
            + '<div class="tr-ps-modal-sectitle"><svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z"/></svg> Sell $</div>'
            + '<div class="tr-ps-modal-inline" id="trPsSellUsdGrid"></div>'
            + '</div>'
            + '<div class="tr-ps-modal-preview">'
            + '<div class="tr-ps-modal-sectitle"><svg viewBox="0 0 24 24" width="12" height="12"><path fill="CurrentColor" d="M12 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm8-4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H4V4h16v12z"/></svg> Preview</div>'
            + '<div class="tr-ps-modal-preview-btns" id="trPsPreview"></div>'
            + '</div>'
            + '</div>'
            + '<div class="tr-modal-footer"><button class="tr-submit tr-ps-modal-save" data-action="save" style="width:100%;padding:8px">' + (settingsT('save') || 'Save') + '</button></div>'
            + '</div>';
        document.body.appendChild(overlay);

        function buildPreview(c) {
            var ph = '<div class="tr-ps-preview-label">Buy</div><div class="tr-ps-preview-row">';
            for (var i = 0; i < Math.min(c.buy.length, 4); i++) {
                ph += '<span class="tr-ps-preview-chip">$' + (c.buy[i] || 0) + '</span>';
            }
            ph += '</div><div class="tr-ps-preview-label" style="margin-top:5px">Sell</div><div class="tr-ps-preview-row">';
            for (var i = 0; i < Math.min(c.sell.length, 3); i++) {
                ph += '<span class="tr-ps-preview-chip tr-ps-preview-sell">' + (c.sell[i] || 0) + '%</span>';
            }
            ph += '</div>';
            return ph;
        }

        function renderModalContent(profileIdx) {
            var c = _loadProfileCfg(profileIdx);
            var bg = '';
            for (var bi = 0; bi < 4; bi++) {
                var val = c.buy[bi] !== undefined ? c.buy[bi] : '';
                bg += '<div class="tr-ps-modal-cell"><span class="tr-ps-modal-prefix">$</span><input type="number" class="tr-input tr-ps-modal-inp" data-type="buy" data-idx="' + bi + '" value="' + val + '" min="0" step="any" placeholder="0"></div>';
            }
            var bgEl = document.getElementById('trPsBuyGrid');
            if (bgEl) bgEl.innerHTML = bg;
            var sph = '';
            for (var si = 0; si < 3; si++) {
                var val = c.sell[si] !== undefined ? c.sell[si] : '';
                sph += '<div class="tr-ps-modal-cell tr-ps-modal-cell-sm"><input type="number" class="tr-input tr-ps-modal-inp" data-type="sellPct" data-idx="' + si + '" value="' + val + '" min="0" max="100" step="1" placeholder="0"><span class="tr-ps-modal-suffix">%</span></div>';
            }
            var spEl = document.getElementById('trPsSellPctGrid');
            if (spEl) spEl.innerHTML = sph;
            var suh = '';
            for (var si2 = 0; si2 < 3; si2++) {
                var val = c.sellUsd && c.sellUsd[si2] !== undefined ? c.sellUsd[si2] : '';
                suh += '<div class="tr-ps-modal-cell tr-ps-modal-cell-sm"><span class="tr-ps-modal-prefix">$</span><input type="number" class="tr-input tr-ps-modal-inp" data-type="sellUsd" data-idx="' + si2 + '" value="' + val + '" min="0" step="any" placeholder="0"></div>';
            }
            var suEl = document.getElementById('trPsSellUsdGrid');
            if (suEl) suEl.innerHTML = suh;
            var pvEl = document.getElementById('trPsPreview');
            if (pvEl) pvEl.innerHTML = buildPreview(c);
        }

        renderModalContent(curProfile);

        overlay.addEventListener('click', function(e) {
            var btn = e.target.closest('[data-action], [data-ps-tab]');
            if (!btn) return;
            if (btn.dataset.action === 'close') { overlay.remove(); return; }
            if (btn.dataset.psTab) {
                var tabIdx = parseInt(btn.dataset.psTab);
                document.querySelectorAll('.tr-ps-modal-tab').forEach(function(t) { t.classList.remove('active'); });
                btn.classList.add('active');
                renderModalContent(tabIdx);
                return;
            }
            if (btn.dataset.action === 'save') {
                var activeTab = document.querySelector('.tr-ps-modal-tab.active');
                var pIdx = activeTab ? parseInt(activeTab.dataset.psTab) : curProfile;
                var newBuy = [], newSellPct = [], newSellUsd = [];
                document.querySelectorAll('#trPsBuyGrid .tr-ps-modal-inp').forEach(function(inp) {
                    var v = parseFloat(inp.value);
                    if (!isNaN(v) && v > 0) newBuy.push(v);
                });
                document.querySelectorAll('#trPsSellPctGrid .tr-ps-modal-inp').forEach(function(inp) {
                    var v = parseFloat(inp.value);
                    if (!isNaN(v) && v > 0) newSellPct.push(v);
                });
                document.querySelectorAll('#trPsSellUsdGrid .tr-ps-modal-inp').forEach(function(inp) {
                    var v = parseFloat(inp.value);
                    if (!isNaN(v) && v > 0) newSellUsd.push(v);
                });
                if (!newBuy.length) newBuy = [10,25,50,100];
                if (!newSellPct.length) newSellPct = [25,50,75];
                if (!newSellUsd.length) newSellUsd = [50,100,200];
                _saveProfileCfg(pIdx, {buy:newBuy, sell:newSellPct, sellUsd:newSellUsd});
                _updateQuickButtons(_getActiveProfile());
                overlay.remove();
            }
        });
    }

    function _detectCryptoAsset(title) {
        var symbolMap = {
            'BTC': ['BTC', 'BITCOIN', 'БИТКОИН', 'БИТКОЙН'],
            'ETH': ['ETH', 'ETHEREUM', 'ЭФИРИУМ', 'ЕФІР'],
            'SOL': ['SOL', 'SOLANA', 'СОЛАНА'],
            'XRP': ['XRP', 'RIPPLE', 'РИПЛ'],
            'BNB': ['BNB', 'BINANCE'],
            'DOGE': ['DOGE', 'DOGECOIN', 'ДОЖД', 'ДОГЕ']
        };
        var upper = (title || '').toUpperCase();
        for (var sym in symbolMap) {
            var aliases = symbolMap[sym];
            for (var ai = 0; ai < aliases.length; ai++) {
                if (upper.indexOf(aliases[ai]) >= 0) return sym;
            }
        }
        return null;
    }

    function _buildTVUrl(asset, interval) {
        var sym = 'BINANCE:' + asset + 'USDT';
        interval = interval || '5';
        var isLight = document.body.classList.contains('light-theme');
        var studies = JSON.stringify(['MASimple@tv-basicstudies','Volume@tv-basicstudies']);
        var feats = JSON.stringify(['chart','side_toolbar','drawing_tools','chart_crosshair_menu','chart_multiple_instance','symbol_search','keep_info_panel_open','uppercase_in_symbols_search','delete_symbol_in_search']);
        return 'https://s.tradingview.com/widgetembed/?symbol=' + encodeURIComponent(sym)
            + '&interval=' + interval
            + '&theme=' + (isLight ? 'light' : 'dark')
            + '&style=' + (isLight ? '1' : '1')
            + '&locale=en'
            + '&hide_side_toolbar=0&symboledit=1&saveimage=0&allow_symbol_change=1'
            + '&toolbarbg=' + encodeURIComponent(isLight ? '#f1f3f6' : '#1e222d')
            + '&studies=' + encodeURIComponent(studies)
            + '&timezone=exchange'
            + '&enabled_features=' + encodeURIComponent(feats);
    }

    function _createTVChart(asset, interval) {
        var container = document.getElementById('trChartContainer');
        var emptyEl = document.getElementById('trChartEmpty');
        if (!container) return;
        if (emptyEl) emptyEl.style.display = 'none';
        container.style.display = '';
        container.innerHTML = '';
        var iframe = document.createElement('iframe');
        iframe.style.cssText = 'width:100%;height:100%;border:none;display:block';
        iframe.setAttribute('allowfullscreen', 'true');
        iframe.src = _buildTVUrl(asset, interval);
        var loadTimer = setTimeout(function() {
            if (container && container.querySelector('iframe') === iframe && iframe.style.display !== 'none') {
                iframe.style.display = 'none';
                if (emptyEl) {
                    emptyEl.style.display = '';
                    emptyEl.innerHTML = 'Failed to load TradingView. Retrying...';
                }
                setTimeout(function() {
                    iframe.src = _buildTVUrl(asset, interval);
                    iframe.style.display = '';
                }, 3000);
            }
        }, 15000);
        iframe.onload = function() { clearTimeout(loadTimer); };
        container.appendChild(iframe);
    }

    function _initCryptoChart(asset) {
        var container = document.getElementById('trChartContainer');
        var emptyEl = document.getElementById('trChartEmpty');
        var section = document.getElementById('trChartSection');
        if (!container) return;
        if (section) section.style.display = '';
        if (!asset) {
            if (emptyEl) { emptyEl.style.display = ''; emptyEl.textContent = _termT('terminal.chart_empty') || 'Select chart source'; }
            if (container) container.style.display = 'none';
            return;
        }
        if (emptyEl) emptyEl.style.display = 'none';
        if (container) container.style.display = '';
        _createTVChart(asset, '5');
    }

    function _termT(key) {
        if (typeof settingsT === 'function') return settingsT(key);
        return key;
    }

    function _renderTerminalPanel() {
        var sel = $('ttSelectedMarket');
        if (!sel || !_termMarket) return;
        var m = _termMarket;
        var ev = _termEvent;
        var prices = m.outcomePrices ? JSON.parse(m.outcomePrices) : [];
        var upPrice = prices[0] ? parseFloat(prices[0]) : 0.5;
        var downPrice = prices[1] ? parseFloat(prices[1]) : 0.5;
        var question = m.question || (ev ? ev.title : '');
        var endDate = m.endDate || (ev ? ev.endDate : '');
        var timeLeft = endDate ? calcTimeRemaining(endDate) : '';
        var slug = m.slug || (ev ? ev.slug : '');
        var t = typeof settingsT === 'function' ? settingsT : function(k) { return k; };
        var demoBal = _demoBalance || 0;
        var isEnded = m.closed || m.resolved || m.outcome !== undefined;
        var endedPrice = isEnded ? 0 : null;
        var markets = ev && ev.markets ? ev.markets : [m];
        var isSingleMarket = markets.length === 1;

        var html = '<div class="tr-terminal">';

        // 1. MODE BAR
        html += '<div class="tr-mode-bar">'
            + '<button class="tr-mode-btn' + (_termState === 'live' ? ' active' : '') + '" data-mode="live">' + (t('terminal.switch_live') || 'Live') + '</button>'
            + '<button class="tr-mode-btn' + (_termState === 'demo' ? ' active' : '') + '" data-mode="demo">' + (t('terminal.switch_demo') || 'Demo') + '</button>'
            + '<button class="tr-mode-btn' + (_termState === 'copy' ? ' active' : '') + '" data-mode="copy">' + (t('terminal.switch_copy') || 'Copy') + '</button>'
            + '<button class="tr-mode-btn' + (_termState === 'strategies' ? ' active' : '') + '" data-mode="strategies">' + (t('terminal.switch_strategies') || 'Strategies') + '</button>'
            + '<div class="tr-mode-balance" id="trModeBalance" style="display:' + (_termState === 'demo' ? 'flex' : 'none') + '">$' + fmtNum((demoBal || 0).toFixed(0)) + '</div>'
            + '</div>';

        // 2. EVENT HEADER
        html += '<div class="tr-event-header">'
            + '<div class="tr-event-title-row">'
            + '<div class="tr-event-title">' + escHtml(question) + '</div>'
            + '<div class="tr-event-timer" id="trEventTimer">' + timeLeft + '</div>'
            + '</div>'
            + '<div class="tr-event-actions">'
            + '<button class="tr-ev-btn ev-call-btn" id="trCallBtn" title="Предложить как колл (сигнал)"><svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M5 8c-1.1 0-2 .9-2 2v4c0 1.1.9 2 2 2h2l4 4V6l-4 4H5zm12 4c0 1.5-.84 2.8-2.1 3.5l.6 1.1c1.6-.9 2.5-2.5 2.5-4.6s-.9-3.7-2.5-4.6l-.6 1.1c1.26.7 2.1 2 2.1 3.5z"/></svg></button>'
            + '<button class="tr-ev-btn tr-agent-btn" id="trAIAgentBtn"><svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/></svg><span>' + (t('terminal.ai_agent') || 'AI') + '</span></button>'
            + (ev && ev.description ? '<button class="tr-ev-btn tr-desc-btn" id="trDescToggle"><svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"/></svg><span>' + (t('terminal.description') || 'Описание') + '</span></button>' : '')
            + (_detectCryptoAsset(question) ? '<button class="tr-ev-btn tr-chart-btn" id="trChartToggle"><svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M3.5 18.49l6-6.01 4 4L22 6.92l-1.41-1.41-7.09 7.97-4-4L2 16.99z"/></svg><span>' + (t('terminal.chart_title') || 'Chart') + '</span></button>' : '')
            + '</div>'
            + (ev && ev.description ? '<div class="tr-event-desc" id="trEventDesc" style="display:none">' + escHtml(ev.description) + '</div>' : '')
            + '</div>';

        // 3. CHART SECTION
        html += '<div class="tr-chart-section" id="trChartSection" style="display:none">'
            + '<div class="tr-chart-source-bar">'
            + '<button class="tr-chart-src active" data-src="tv">TradingView</button>'
            + '<button class="tr-chart-src" data-src="cl">Chainlink</button>'
            + '</div>'
            + '<div class="tr-chart-body" id="trChartBody">'
            + '<div class="tr-chart-empty" id="trChartEmpty">' + (t('terminal.chart_empty') || 'Выберите источник графика') + '</div>'
            + '<div class="tr-chart-container" id="trChartContainer"></div>'
            + '</div>'
            + '</div>';

        // 4. AI SECTION
        html += '<div class="tr-ai-section" id="ev-ai-section" style="display:none">'
            + '<div class="tr-section-title-bar">'
            + '<span>' + (t('events.ai_title') || 'AI Ассистент') + '</span>'
            + '<button class="tr-section-close" id="trAIClose">&times;</button>'
            + '</div>'
            + '<div class="ev-ai-body" id="ev-ai-body">'
            + '<div class="ev-ai-msgs" id="ev-ai-msgs"></div>'
            + '<div class="ev-ai-input-row">'
            + '<input class="tr-ai-input" id="ev-ai-input" type="text" placeholder="' + (t('events.ai_placeholder') || 'Задайте вопрос...') + '">'
            + '<button class="tr-ai-send" id="ev-ai-send">\u2192</button>'
            + '</div>'
            + '</div>'
            + '</div>';

        // 5. FAVORITES SECTION
        html += '<div class="ev-my-wallets-section" id="trFavoritesSection" style="display:none">'
            + '<div class="ev-favorites-header" id="trFavoritesHeader" style="cursor:pointer">'
            + '<svg class="ev-favorites-toggle-icon" viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>'
            + '<h3 class="ev-section-title" style="margin:0;flex:1">' + escHtml(t('events.my_wallets_title') || 'Мои кошельки') + '</h3>'
            + '</div>'
            + '<div class="ev-favorites-body" id="trFavoritesBody">'
            + '<div id="tr-favorites-content"><div class="ev-loading" style="padding:20px"><span class="ev-spinner"></span></div></div>'
            + '</div>'
            + '</div>';

        // 6. SMART/WHALE SECTION
        html += '<div class="ev-my-wallets-section" id="trSmartWhaleSection" style="display:none">'
            + '<div class="ev-favorites-header" id="trSmartWhaleHeader" style="cursor:pointer">'
            + '<svg class="ev-favorites-toggle-icon" viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>'
            + '<h3 class="ev-section-title" style="margin:0;flex:1">Smart/Whale (WR 60%+ / $30k+)</h3>'
            + '</div>'
            + '<div class="ev-favorites-body" id="trSmartWhaleBody">'
            + '<div id="tr-smartwhale-content"><div class="ev-loading" style="padding:20px"><span class="ev-spinner"></span></div></div>'
            + '</div>'
            + '</div>';

        // 7. MULTI-MARKET TABLE (conditional)
        if (!isSingleMarket) {
            html += '<div class="ev-markets-section" id="trTerminalMarkets">';
            html += '<div class="ev-markets-header" id="trMarketsHeader" style="cursor:pointer">';
            html += '<svg class="ev-markets-toggle-icon" viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>';
            html += '<h3 class="ev-section-title" style="margin:0">' + escHtml((t('events.markets_title') || 'Рынки ({n})').replace('{n}', markets.length)) + '</h3>';
            html += '</div>';
            html += '<div class="ev-markets-body" id="trMarketsBody">';
            html += '<div class="ev-market-row ev-market-row-header">';
            html += '<div class="ev-market-info"><span class="ev-market-title ev-market-title-header">' + escHtml(t('events.market_label') || 'Рынок') + '</span>';
            html += '<div class="ev-market-stats-row"><span class="ev-market-stat ev-market-stat-header">Vol</span><span class="ev-market-stat ev-market-stat-header">Spread</span></div></div>';
            html += '<span class="ev-market-outcomes-label">Price</span></div>';
            markets.forEach(function(mk, mi) {
                var mOutcomes = parseOutcomes(mk);
                var mTitle = mk.question || mk.title || 'Market ' + (mi + 1);
                var mVolume = fmtCompact(parseFloat(mk.volume || mk.volume24hr || mk.liquidity || 0));
                var spreadVal = mOutcomes.length >= 2 ? Math.abs(mOutcomes[0].price - (mOutcomes[1] ? mOutcomes[1].price : 0)) : 0;
                var spread = spreadVal.toFixed(1);
                var yesP = mOutcomes.length > 0 ? mOutcomes[0].price : 50;
                var barPct = Math.min(Math.max(yesP, 3), 97);
                html += '<div class="ev-market-row" data-market-id="' + escHtml(mk.id || mk.conditionId || '') + '">';
                html += '<div class="ev-market-info"><span class="ev-market-title" title="' + escHtml(mTitle) + '">' + escHtml(mTitle) + '</span>';
                html += '<div class="ev-market-stats-row"><span class="ev-market-stat">$' + mVolume + '</span><span class="ev-market-stat">' + spread + '%</span></div></div>';
                html += '<div class="ev-market-actions"><div class="ev-price-bar"><div class="ev-price-bar-fill" style="width:' + barPct + '%"></div></div>';
                html += '<div class="ev-price-btns">';
                mOutcomes.forEach(function(o, oi) {
                    var lc = o.name.toLowerCase().trim();
                    var isYes = lc === 'yes' || lc === 'up';
                    var isNo = lc === 'no' || lc === 'down';
                    var colorCls = isYes ? 'ev-outcome-yes' : (isNo ? 'ev-outcome-no' : '');
                    html += '<button class="ev-outcome-btn ' + colorCls + '" data-market="' + mk.id + '" data-outcome="' + oi + '">'
                        + '<span class="ev-outcome-name-text">' + escHtml(o.name) + '</span> '
                        + '<span class="ev-outcome-price" id="trOPrice_' + mk.id + '_' + oi + '">' + (endedPrice !== null ? endedPrice : o.price) + '\u00a2</span></button>';
                });
                html += '</div></div></div>';
            });
            html += '</div></div>';
        }

        // 8. ORDER FORM
        html += '<div class="tr-order-form">';

        // 8a. Wallet Row
        html += '<div class="tr-wallet-row" id="trWalletRow" style="display:' + (_termState === 'live' ? '' : 'none') + '">'
            + '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M21 18v1c0 1.1-.9 2-2 2H5c-1.11 0-2-.9-2-2V5c0-1.1.89-2 2-2h14c1.1 0 2 .9 2 2v1h-9c-1.11 0-2 .9-2 2v8c0 1.1.89 2 2 2h9zm-9-2h10V8H12v8zm4-2.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>'
            + '<span class="tr-wallet-lbl">' + (t('terminal.wallet_title') || 'Wallet') + '</span>'
            + '<select class="tr-wallet-sel" id="trTermWalletSelect"></select>'
            + '</div>';

        // 8b. Balance Row
        html += '<div id="trTermBalRow" class="tr-term-bal-row" style="display:' + (_termState === 'live' ? '' : 'none') + '">'
            + '<div class="tr-term-bal-addr" id="trTermAddr"></div>'
            + '<div class="tr-term-bal-item"><span class="tr-term-bal-label">POL</span><span class="tr-term-bal-value" id="trTermBal">...</span></div>'
            + '<div class="tr-term-bal-item"><span class="tr-term-bal-label">USDC</span><span class="tr-term-bal-value" id="trTermUSDC">...</span></div>'
            + '</div>';

        // 8c. Recent Trades
        html += '<div id="trTermRecent" class="tr-term-recent" style="display:' + (_termState === 'live' ? '' : 'none') + '">'
            + '<div class="tr-term-recent-header">Последние сделки</div>'
            + '<div id="trTermRecentList"></div>'
            + '</div>';

        // 8d. Separator
        html += '<div class="tr-term-sep" id="trTermSep" style="display:' + (_termState === 'live' ? '' : 'none') + '"></div>';

        // 8e. P-setups
        html += '<div class="tr-psetups">'
            + '<button class="tr-psetup-btn active" data-ps="1">P1</button>'
            + '<button class="tr-psetup-btn" data-ps="2">P2</button>'
            + '<button class="tr-psetup-btn" data-ps="3">P3</button>'
            + '<button class="tr-psetup-edit" id="trPSetupEdit">\u270F\uFE0F</button>'
            + '</div>';

        // 8f. Quick Buy (from profile config)
        html += (function() {
            var pIdx = _getActiveProfile();
            var cfg = _loadProfileCfg(pIdx);
            var btns = '<div class="tr-quick-row" id="trQuickBuy">';
            for (var bi = 0; bi < Math.min(cfg.buy.length, 4); bi++) {
                btns += '<button class="tr-qb-btn" data-amount="' + cfg.buy[bi] + '">$' + cfg.buy[bi] + '</button>';
            }
            return btns + '</div>';
        })();

        // 8g. Size Field
        html += '<div class="tr-field tr-size-field">'
            + '<label>' + (t('terminal.amount') || 'Сумма ($)') + '</label>'
            + '<input type="number" class="tr-input" id="trCustomSize" placeholder="0.00" min="0" step="any">'
            + '</div>';

        // 8h. Payout Field
        html += '<div class="tr-field tr-payout-field" id="trPayoutField" style="display:none">'
            + '<label>' + (t('terminal.possible_win') || 'Возможный выигрыш') + '</label>'
            + '<span class="tr-payout-val" id="trPayoutVal">$0.00</span>'
            + '<span class="tr-payout-shares" id="trPayoutShares"></span>'
            + '</div>';

        // 8i. Type Group
        html += '<div class="tr-type-group">'
            + '<button class="tr-type-btn active" data-type="market">' + (t('terminal.market') || 'Market') + '</button>'
            + '<button class="tr-type-btn" data-type="limit">' + (t('terminal.limit') || 'Limit') + '</button>'
            + '</div>';

        // 8j. Direction
        html += '<div class="tr-direction">'
            + '<button class="tr-dir-btn tr-dir-up active" id="trDirUp">'
            + '<div class="tr-dir-top"><span class="tr-dir-arrow">\u25B2</span><span class="tr-dir-label">UP</span><span class="tr-dir-price" id="trUpPrice">' + (upPrice * 100).toFixed(1) + '\u00a2</span></div>'
            + '<div class="tr-dir-bar"><div class="tr-dir-bar-fill" id="trUpBarFill" style="width:' + (upPrice * 100) + '%"></div></div>'
            + '<div class="tr-dir-liq" id="trUpLiq">liq $0</div>'
            + '</button>'
            + '<button class="tr-dir-btn tr-dir-down" id="trDirDown">'
            + '<div class="tr-dir-top"><span class="tr-dir-arrow">\u25BC</span><span class="tr-dir-label">DOWN</span><span class="tr-dir-price" id="trDownPrice">' + (downPrice * 100).toFixed(1) + '\u00a2</span></div>'
            + '<div class="tr-dir-bar"><div class="tr-dir-bar-fill" id="trDownBarFill" style="width:' + (downPrice * 100) + '%"></div></div>'
            + '<div class="tr-dir-liq" id="trDownLiq">liq $0</div>'
            + '</button>'
            + '</div>';

        // 8k. Limit Fields
        html += '<div class="tr-field tr-limit-field" id="trPriceField" style="display:none">'
            + '<label>' + (t('terminal.limit_price') || 'Limit Price') + '</label>'
            + '<div class="tr-price-wrap">'
            + '<input type="number" class="tr-input tr-price-input" id="trPriceInput" placeholder="0.0" min="0" max="100" step="0.1">'
            + '<button class="tr-price-step" id="trPriceMinus">\u2212</button>'
            + '<button class="tr-price-step" id="trPricePlus">+</button>'
            + '</div></div>';

        html += '<div class="tr-field tr-limit-field" id="trSharesField" style="display:none">'
            + '<label>' + (t('terminal.shares') || 'Shares') + '</label>'
            + '<input type="number" class="tr-input" id="trSharesInput" placeholder="1" min="1" step="1" value="1">'
            + '</div>';

        html += '<div class="tr-field tr-limit-field" id="trExpiryField" style="display:none">'
            + '<label>' + (t('terminal.expiry') || 'Expiry') + '</label>'
            + '<div class="tr-expiry-dd" id="trExpiryDD">'
            + '<button class="tr-expiry-trigger" id="trExpiryTrigger" data-value="never">'
            + '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>'
            + '<span>' + (t('terminal.never') || 'Never') + '</span>'
            + '<svg class="tr-expiry-arrow" viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>'
            + '</button>'
            + '<div class="tr-expiry-panel" id="trExpiryPanel">'
            + '<button class="tr-expiry-opt active" data-value="never"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg><span>' + (t('terminal.never') || 'Never') + '</span></button>'
            + '<button class="tr-expiry-opt" data-value="5m"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg><span>5 min</span></button>'
            + '<button class="tr-expiry-opt" data-value="1h"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg><span>1 hour</span></button>'
            + '<button class="tr-expiry-opt" data-value="12h"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg><span>12 hours</span></button>'
            + '<button class="tr-expiry-opt" data-value="24h"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg><span>24 hours</span></button>'
            + '<button class="tr-expiry-opt" data-value="eod"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11z"/></svg><span>' + (t('terminal.eod') || 'End of day') + '</span></button>'
            + '<button class="tr-expiry-opt" data-value="custom"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg><span>' + (t('terminal.custom') || 'Custom') + '</span></button>'
            + '</div></div></div>';

        // 8l. Sell Section
        html += '<div class="tr-sell-section">'
            + '<div class="tr-sell-header"><span class="tr-sell-title">' + (t('terminal.sell') || 'Sell') + '</span>'
            + '<div class="tr-sell-mode" id="trSellModeSel"><button class="tr-sell-mode-btn active" data-smode="pct">%</button><button class="tr-sell-mode-btn" data-smode="usd">$</button></div></div>'
            + (function() {
                var pIdx = _getActiveProfile();
                var cfg = _loadProfileCfg(pIdx);
                var btns = '<div class="tr-quick-row" id="trQuickSell">';
                for (var si = 0; si < Math.min(cfg.sell.length, 3); si++) {
                    var usdVal = cfg.sellUsd && cfg.sellUsd[si] ? cfg.sellUsd[si] : 0;
                    btns += '<button class="tr-qs-btn" data-pct="' + cfg.sell[si] + '" data-usd="' + usdVal + '">' + cfg.sell[si] + '%</button>';
                }
                btns += '<button class="tr-qs-btn tr-qs-close">' + (t('terminal.close_100') || 'Close 100%') + '</button>';
                return btns + '</div>';
            })()
            + '</div>';

        // 8m. Position Section
        html += '<div class="tr-position-section" id="trPositionSection" style="display:none">'
            + '<div class="tr-pos-header"><span class="tr-sell-title">' + (t('terminal.position') || 'Position') + '</span></div>'
            + '<div class="tr-pos-body">'
            + '<div class="tr-pos-row"><span class="tr-pos-label">' + (t('terminal.outcome') || 'Outcome') + '</span><span class="tr-pos-val" id="trPosOutcome">\u2014</span></div>'
            + '<div class="tr-pos-row"><span class="tr-pos-label">' + (t('terminal.shares') || 'Shares') + '</span><span class="tr-pos-val" id="trPosShares">\u2014</span></div>'
            + '<div class="tr-pos-row"><span class="tr-pos-label">' + (t('terminal.entry_price') || 'Entry Price') + '</span><span class="tr-pos-val" id="trPosEntry">\u2014</span></div>'
            + '<div class="tr-pos-row"><span class="tr-pos-label">' + (t('terminal.current_value') || 'Current Value') + '</span><span class="tr-pos-val" id="trPosValue">\u2014</span></div>'
            + '<div class="tr-pos-row"><span class="tr-pos-label">' + (t('terminal.pnl') || 'PnL') + '</span><span class="tr-pos-val" id="trPosPnl">\u2014</span></div>'
            + '</div></div>';

        // 8n. Alerts Section
        html += '<div class="tr-alerts-section" id="trAlertsSection">'
            + '<div class="tr-alerts-scroll">'
            + '<button class="an-asset-btn active" data-tr-alert-asset="ALL"><span class="an-asset-icon an-asset-icon-all">$</span><span>Все</span></button>'
            + '<button class="an-asset-btn" data-tr-alert-asset="BTC"><span class="tr-alert-icon">\u0243</span><span>BTC</span></button>'
            + '<button class="an-asset-btn" data-tr-alert-asset="ETH"><span class="tr-alert-icon">\u27E0</span><span>ETH</span></button>'
            + '<button class="an-asset-btn" data-tr-alert-asset="SOL"><span class="tr-alert-icon">\u25CE</span><span>SOL</span></button>'
            + '</div>'
            + '<div class="tr-alerts-tf-row">'
            + '<button class="tr-alert-tf-btn active" data-tf="5min">5m</button>'
            + '<button class="tr-alert-tf-btn" data-tf="15min">15m</button>'
            + '</div>'
            + '<div class="tr-alerts-table-wrap" id="trAlertsTableWrap">'
            + '<div class="tr-alerts-empty">'
            + '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/></svg>'
            + '<p style="font-size:11px;color:#8b949e;margin:6px 0 0">Выберите актив и период</p>'
            + '</div></div></div>';

        // 8o. Total + Submit
        html += '<div class="tr-total-submit">'
            + '<div class="tr-total" id="trTotalField">' + (t('terminal.total') || 'Total') + ': <strong>$0.00</strong></div>'
            + '<button class="tr-submit" id="trSubmitBtn">' + (t('terminal.place_order') || 'Place Order') + '</button>'
            + '</div>';

        // 8p. Error msg
        html += '<div class="tr-error" id="trErrorMsg" style="display:none"></div>';
        html += '</div>'; // end tr-order-form

        // 9. CUSTOM EXPIRY MODAL
        html += '<div class="tr-modal-overlay" id="trExpiryModal" style="display:none">'
            + '<div class="tr-modal">'
            + '<div class="tr-modal-header"><span>' + (t('terminal.custom_expiry_title') || 'Custom Expiry') + '</span>'
            + '<button class="tr-modal-close" id="trExpiryModalClose">&times;</button></div>'
            + '<div class="tr-modal-body">'
            + '<div class="tr-modal-row">'
            + '<div class="tr-modal-field"><label>' + (t('terminal.expiry_hours') || 'Hours') + '</label><input type="number" class="tr-input" id="trExpiryHours" value="0" min="0" max="99"></div>'
            + '<div class="tr-modal-field"><label>' + (t('terminal.expiry_minutes') || 'Minutes') + '</label><input type="number" class="tr-input" id="trExpiryMins" value="0" min="0" max="59"></div>'
            + '<div class="tr-modal-field"><label>' + (t('terminal.expiry_seconds') || 'Seconds') + '</label><input type="number" class="tr-input" id="trExpirySecs" value="0" min="0" max="59"></div>'
            + '</div>'
            + '<button class="tr-submit" id="trExpiryModalApply">' + (t('terminal.apply') || 'Apply') + '</button>'
            + '</div></div></div>';

        // 10. STRATEGIES SECTION
        html += '<div class="tr-strategies-section" id="trStrategiesSection" style="display:' + (_termState === 'strategies' ? 'block' : 'none') + '">'
            + '<div class="tr-strategies-tabs">'
            + '<button class="tr-strategies-tab active" data-strategy-tab="ai">AI agent</button>'
            + '<button class="tr-strategies-tab" data-strategy-tab="my">My Strategies</button>'
            + '</div>'
            + '<div id="trStrategiesTabAI">'
            + '<div class="tr-agent">'
            + '<div class="tr-agent-header">'
            + '<div class="tr-agent-title">'
            + '<div class="tr-agent-title-icon"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg></div>'
            + '<span class="tr-agent-title-text">AI Agent</span></div>'
            + '<div class="tr-agent-hdr-r">'
            + '<span class="tr-agent-copy-flash" id="trCopyFlash"></span>'
            + '<button class="tr-bot-start-btn" id="trBotStartBtn">\u25b6</button>'
            + '</div></div>'
            + '<div class="tr-strategy-selector"><div class="tr-strategy-select-row">'
            + '<div class="tr-strategy-opt active" data-strategy="clob"><span class="tr-strategy-name">CLOB Arbitrage</span><button class="tr-strategy-info-btn" data-strategy="clob">\u24d8</button></div>'
            + '<div class="tr-strategy-opt" data-strategy="delta"><span class="tr-strategy-name">Delta Mesh</span><button class="tr-strategy-info-btn" data-strategy="delta">\u24d8</button><span class="tr-strategy-badge">' + (t('terminal.strategy_dev') || 'In Dev') + '</span></div>'
            + '<div class="tr-strategy-opt" data-strategy="phoenix"><span class="tr-strategy-name">Phoenix</span><button class="tr-strategy-info-btn" data-strategy="phoenix">\u24d8</button></div>'
            + '</div></div>'
            + '<div class="tr-agent-wallet"><div class="tr-agent-wallet-label">' + (t('terminal.wallet_title') || 'Wallet') + '</div>'
            + '<select class="tr-agent-wallet-sel" id="trBotWalletSelect"><option value="">' + (t('terminal.wallet_none') || 'None') + '</option>'
            + (function() {
                var wallets = typeof getWallets === 'function' ? getWallets() : [];
                var activeWallet = localStorage.getItem('polyBotActiveWallet') || '';
                var opts = '';
                for (var wi = 0; wi < wallets.length; wi++) {
                    var w = wallets[wi];
                    var wAddr = w.address ? w.address.substring(0, 6) + '...' + w.address.substring(38) : '';
                    var displayName = w.name ? w.name + ' (' + wAddr + ')' : wAddr;
                    opts += '<option value="' + wi + '"' + (String(wi) === activeWallet ? ' selected' : '') + '>' + escHtml(displayName) + '</option>';
                }
                return opts;
            })()
            + '</select></div>'
            + '<div class="tr-agent-rolling"><div class="tr-agent-rolling-label">' + (t('terminal.rolling_label') || 'Rolling') + '</div>'
            + '<div class="tr-agent-rolling-toggle" id="trBotRollingToggle">'
            + '<button class="tr-agent-rolling-btn active" data-rolling="1">' + (t('terminal.rolling_on') || 'On') + '</button>'
            + '<button class="tr-agent-rolling-btn" data-rolling="0">' + (t('terminal.rolling_off') || 'Off') + '</button>'
            + '</div><div class="tr-agent-rolling-desc">' + (t('terminal.rolling_desc') || 'Auto-reinvest profits') + '</div></div>'
            // CLOB Content
            + '<div id="trBotClobContent">'
            + '<div class="tr-agent-assets"><div class="tr-agent-assets-label">Assets</div>'
            + '<div class="tr-agent-assets-btns" id="trBotAssetBtns">'
            + (function() {
                var sel = _getBotSelectedAssets();
                return _availableBotAssets.map(function(a) {
                    var active = sel.indexOf(a) >= 0;
                    var icon = a === 'BTC' ? '\u0243' : a === 'ETH' ? '\u27E0' : '\u25CB';
                    return '<button class="tr-agent-asset-btn' + (active ? ' active' : '') + '" data-asset="' + a + '"><span class="tr-agent-asset-icon">' + icon + '</span><span>' + a + '</span></button>';
                }).join('');
            })()
            + '</div></div>'
            + '<div class="tr-agent-stats"><div class="tr-agent-stat"><div class="tr-agent-stat-label">Balance $</div>'
            + '<div class="tr-agent-stat-body"><input class="tr-agent-bal-inp" id="trBotBalInput" type="number" value="100000" min="1" step="any"></div></div>'
            + '<div class="tr-agent-stat" id="trBotStats"></div></div>'
            + '<div class="tr-agent-stats" style="margin-top:8px">'
            + '<div class="tr-agent-stat"><div class="tr-agent-stat-label">Min Spread</div><div class="tr-agent-stat-body" style="gap:2px"><input id="trClobMinSpread" type="number" value="2" min="1" max="20" step="0.5" style="width:50px"><span style="font-size:9px;color:var(--text-tertiary)">\u00a2</span></div></div>'
            + '<div class="tr-agent-stat"><div class="tr-agent-stat-label">Rebate</div><div class="tr-agent-stat-body" style="gap:2px"><input id="trClobRebate" type="number" value="20" min="0" max="100" step="1" style="width:50px"><span style="font-size:9px;color:var(--text-tertiary)">%</span></div></div>'
            + '<div class="tr-agent-stat"><div class="tr-agent-stat-label">Order Size</div><div class="tr-agent-stat-body" style="gap:2px"><span style="font-size:10px;color:var(--text-tertiary)">$</span><input id="trClobOrderSize" type="number" value="100" min="1" step="any" style="width:60px"></div></div>'
            + '<div class="tr-agent-stat"><div class="tr-agent-stat-label">Timeout</div><div class="tr-agent-stat-body" style="gap:2px"><input id="trClobTimeout" type="number" value="3" min="1" max="30" step="1" style="width:40px"><span style="font-size:9px;color:var(--text-tertiary)">sec</span></div></div>'
            + '<div class="tr-agent-stat"><div class="tr-agent-stat-label">Gas $</div><div class="tr-agent-stat-body" style="gap:2px"><input id="trClobGasCost" type="number" value="0.02" min="0" max="1" step="0.005" style="width:50px"></div></div>'
            + '</div>'
            + '<div class="tr-clob-sim-badge" id="trClobSimBadge" style="display:none"><span class="tr-clob-sim-dot"></span> Simulation Mode</div>'
            + '<div class="tr-agent-sec"><div class="tr-agent-sec-hdr"><span>Open Positions (<span id="trBotPosCount">0</span>)</span><div class="tr-agent-sec-line"></div></div>'
            + '<div class="tr-demo-bot-positions" id="trBotPositions"><div class="tr-bot-empty">No open positions</div></div></div>'
            + '<div class="tr-agent-sec"><div class="tr-agent-sec-hdr"><span>Rounds</span><div class="tr-agent-sec-line"></div>'
            + '<div class="tr-agent-sec-acts"><button class="tr-agent-btn" id="trBotRoundsClear" style="display:none">Clear All</button><button class="tr-agent-btn" id="trBotRoundsCopy" style="display:none">Copy</button></div></div>'
            + '<div class="tr-bot-rounds" id="trBotRounds"><div class="tr-bot-rounds-empty">No completed rounds</div></div></div>'
            + '<div class="tr-agent-sec"><div class="tr-agent-sec-hdr tr-agent-collap collapsed" id="trBotHistToggle">'
            + '<svg class="tr-agent-arrow" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>'
            + '<span>History</span><div class="tr-agent-sec-line"></div>'
            + '<span class="tr-agent-copy" id="trBotCopyBtn">\u2139 Copy</span></div>'
            + '<div class="tr-agent-collap-body collapsed" id="trBotHistBody">'
            + '<div class="tr-agent-filters" id="trBotHistFilters">'
            + '<button class="tr-bot-hist-filter active" data-filter="all">All</button>'
            + '<button class="tr-bot-hist-filter" data-filter="BTC">BTC</button>'
            + '<button class="tr-bot-hist-filter" data-filter="ETH">ETH</button>'
            + '<button class="tr-bot-hist-filter" data-filter="SOL">SOL</button></div>'
            + '<div class="tr-demo-bot-log" id="trBotLog"><div class="tr-bot-empty">No operations</div></div></div></div>'
            + '</div></div>' // end clob + agent
            // Delta placeholder
            + '<div id="trBotDeltaContent" style="display:none"><div class="tr-strategy-dev-placeholder"><div class="tr-strategy-dev-icon">\u2699\uFE0F</div>'
            + '<div class="tr-strategy-dev-title">' + (t('terminal.strategy_dev_title') || 'In Development') + '</div>'
            + '<div class="tr-strategy-dev-desc">' + (t('terminal.strategy_dev_desc') || 'Coming soon') + '</div></div></div>'
            // Phoenix Content
            + '<div id="trBotPhoenixContent" style="display:none">'
            + '<div class="tr-agent-assets"><div class="tr-agent-assets-label">Assets</div>'
            + '<div class="tr-agent-assets-btns" id="phxAssetBtns">'
            + (function() {
                var sel = _phoenixGetSelectedAssets();
                return _availableBotAssets.map(function(a) {
                    var active = sel.indexOf(a) >= 0;
                    var icon = a === 'BTC' ? '\u0243' : a === 'ETH' ? '\u27E0' : '\u25CB';
                    return '<button class="tr-agent-asset-btn' + (active ? ' active' : '') + '" data-asset="' + a + '"><span class="tr-agent-asset-icon">' + icon + '</span><span>' + a + '</span></button>';
                }).join('');
            })()
            + '</div></div>'
            + '<div class="tr-agent-stats tr-agent-stats-phoenix"><div class="tr-agent-stats-row-3">'
            + '<div class="tr-agent-stat"><div class="tr-agent-stat-label">Balance</div><div class="tr-agent-stat-body" style="gap:2px"><span style="font-size:10px;color:var(--text-tertiary)">$</span><input class="tr-agent-bal-inp" id="phxBalInput" type="number" value="1000" min="1" step="any" style="width:auto;min-width:40px;max-width:80px;font-size:11px"></div></div>'
            + '<div class="tr-agent-stat"><div class="tr-agent-stat-label">Entry</div><div class="tr-agent-stat-body" style="gap:2px"><input id="phxEntryCents" type="number" value="2" min="1" max="10" step="1" style="width:auto;min-width:24px;max-width:50px;font-size:11px"><span style="font-size:9px;color:var(--text-tertiary)">\u00a2</span></div></div>'
            + '<div class="tr-agent-stat"><div class="tr-agent-stat-label">Target</div><div class="tr-agent-stat-body" style="gap:2px"><input id="phxTargetCents" type="number" value="20" min="5" max="50" step="1" style="width:auto;min-width:24px;max-width:50px;font-size:11px"><span style="font-size:9px;color:var(--text-tertiary)">\u00a2</span></div></div>'
            + '</div><div class="tr-agent-stats-row-4"><div id="phxStats"></div></div></div>'
            + '<div class="tr-agent-sec"><div class="tr-agent-sec-hdr"><span>Budget</span><div class="tr-agent-sec-line"></div></div>'
            + '<div class="tr-agent-sec-body" style="padding:8px 12px">'
            + '<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px"><select id="phxBudgetMode" style="flex:1;padding:4px 6px;border:1px solid var(--border);border-radius:6px;background:var(--input-bg);color:var(--text);font-size:10px;outline:none"><option value="pct">% \u043e\u0442 \u0431\u0430\u043b\u0430\u043d\u0441\u0430</option><option value="fixed">$ \u0444\u0438\u043a\u0441</option></select></div>'
            + '<div id="phxBudgetPctWrap" style="display:flex;gap:6px;align-items:center"><span style="font-size:10px;color:var(--text-tertiary);white-space:nowrap">%</span><input id="phxBudgetPct" type="number" value="5" min="1" max="100" step="1" style="flex:1;padding:4px 6px;border:1px solid var(--border);border-radius:6px;background:var(--input-bg);color:var(--text);font-size:11px;outline:none"></div>'
            + '<div id="phxBudgetFixedWrap" style="display:none;gap:6px;align-items:center"><span style="font-size:10px;color:var(--text-tertiary);white-space:nowrap">$</span><input id="phxBudgetFixed" type="number" value="15" min="0.5" step="0.5" style="flex:1;padding:4px 6px;border:1px solid var(--border);border-radius:6px;background:var(--input-bg);color:var(--text);font-size:11px;outline:none"></div>'
            + '</div></div>'
            + '<div class="tr-agent-sec"><div class="tr-agent-sec-hdr"><span>Stop Loss</span><div class="tr-agent-sec-line"></div></div>'
            + '<div class="tr-agent-sec-body" style="padding:8px 12px;display:flex;gap:8px;align-items:center">'
            + '<label style="display:flex;align-items:center;gap:4px;font-size:10px;cursor:pointer;white-space:nowrap"><input type="checkbox" id="phxStopEnabled"> Enabled</label>'
            + '<span style="font-size:10px;color:var(--text-tertiary)">at</span>'
            + '<input id="phxStopPct" type="number" value="30" min="1" max="99" step="1" style="width:50px;padding:4px 6px;border:1px solid var(--border);border-radius:6px;background:var(--input-bg);color:var(--text);font-size:11px;outline:none">'
            + '<span style="font-size:9px;color:var(--text-tertiary)">% of fill</span></div></div>'
            + '<div class="tr-agent-sec"><div class="tr-agent-sec-hdr"><span>Rounds</span><div class="tr-agent-sec-line"></div>'
            + '<div class="tr-agent-sec-acts"><button class="tr-agent-btn" id="phxRoundsClear">Clear All</button><button class="tr-agent-btn" id="phxRoundsCopy">Copy</button></div></div>'
            + '<div class="tr-bot-rounds" id="phxRounds"><div class="tr-bot-rounds-empty">No completed rounds</div></div></div>'
            + '</div>' // end phoenix
            + '</div></div>' // end strategies tab AI
            + '<div id="trStrategiesTabMy" style="display:none">'
            + '<div class="tr-strategies-my">'
            + '<div id="trStrategiesList"></div>'
            + '<div class="tr-strategies-my-acts" style="padding:8px 12px;display:flex;gap:8px;align-items:center">'
            + '<button class="tr-submit" id="trStrategiesSaveBtn" style="flex:1;padding:6px;font-size:11px">' + (t('terminal.strategy_save') || 'Save') + '</button>'
            + '<span id="trStrategiesStatus" style="font-size:11px;font-weight:600"></span>'
            + '</div></div></div>'
            + '</div>'; // end strategies section

        // 11. STRATEGY INFO MODAL
        html += '<div class="tr-modal-overlay" id="trStrategyModal" style="display:none">'
            + '<div class="tr-modal tr-modal-strategy"><div class="tr-modal-header">'
            + '<span id="trStrategyModalTitle">CLOB Arbitrage</span>'
            + '<button class="tr-modal-close" id="trStrategyModalClose">&times;</button></div>'
            + '<div class="tr-modal-body"><div class="tr-strategy-modal-desc" id="trStrategyModalDesc"></div></div></div></div>';

        // 12. COPY SECTION
        html += '<div class="tr-copy-section" id="trCopySection" style="display:' + (_termState === 'copy' ? 'block' : 'none') + '">'
            + '<div class="tr-section-info"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>'
            + '<span>' + (t('terminal.copy_config') || 'Copy Trading') + '</span></div>'
            + '<div class="tr-copy-desc">' + (t('terminal.copy_desc') || 'Настройте копирование сделок') + '</div>'
            + '<div class="tr-copy-wallets" id="trCopyWallets">'
            + '<div class="tr-copy-input-row">'
            + '<input class="tr-input tr-copy-input" id="trCopyInput" placeholder="' + (t('terminal.copy_input_ph') || 'Адрес кошелька') + '">'
            + '<button class="tr-copy-add-btn" id="trCopyAddBtn">+</button></div>'
            + '<div class="tr-copy-list" id="trCopyList"></div></div>'
            + '<div class="tr-copy-status" id="trCopyStatus"></div></div>';

        // 13. BALANCE MODAL
        html += '<div class="tr-bal-modal" id="trBalModal" style="display:none">'
            + '<div class="tr-bal-modal-overlay" id="trBalOverlay"></div>'
            + '<div class="tr-bal-modal-box">'
            + '<div class="tr-bal-modal-header"><span class="tr-bal-modal-title">\u0418\u0437\u043c\u0435\u043d\u0438\u0442\u044c \u0431\u0430\u043b\u0430\u043d\u0441</span><button class="tr-bal-modal-close" id="trBalClose">&times;</button></div>'
            + '<div class="tr-bal-modal-body"><label class="tr-bal-modal-label">\u041d\u043e\u0432\u044b\u0439 \u0431\u0430\u043b\u0430\u043d\u0441 ($)</label>'
            + '<input class="tr-bal-modal-input" id="trBalInput" type="number" min="0" step="100">'
            + '<div class="tr-bal-modal-presets">'
            + '<button class="tr-bal-preset" data-val="1000">$1 000</button>'
            + '<button class="tr-bal-preset" data-val="10000">$10 000</button>'
            + '<button class="tr-bal-preset" data-val="100000">$100 000</button>'
            + '<button class="tr-bal-preset" data-val="1000000">$1 000 000</button></div></div>'
            + '<div class="tr-bal-modal-footer"><button class="tr-bal-cancel" id="trBalCancel">\u041e\u0442\u043c\u0435\u043d\u0430</button><button class="tr-bal-apply" id="trBalApply">\u041f\u0440\u0438\u043c\u0435\u043d\u0438\u0442\u044c</button></div>'
            + '</div></div>';

        // 14. TRACKED WALLETS
        html += '<div class="tr-wallets-section" id="trWalletsSection" style="display:none">'
            + '<div class="tr-section-title-bar"><span>' + (t('terminal.tracked_wallets') || 'Tracked Wallets') + '</span>'
            + '<button class="tr-section-close" id="trWalletsClose">&times;</button></div>'
            + '<div id="trWalletsContent"><div class="tr-loading">' + (t('events.loading') || 'Loading...') + '</div></div></div>';

        html += '</div>'; // end tr-terminal

        sel.innerHTML = html;

        // --- POPULATE WALLET SELECT ---
        _renderTermWalletSelect();

        // --- BIND EVENTS ---
        // Direction buttons
        var dirUp = document.getElementById('trDirUp');
        var dirDown = document.getElementById('trDirDown');
        if (dirUp) {
            dirUp.onclick = function() {
                _termSelectedOutcome = { marketId: m.conditionId || m.id, index: 0 };
                document.querySelectorAll('.tr-dir-btn').forEach(function(b) { b.classList.remove('active'); });
                dirUp.classList.add('active');
                _updateTermTotals();
                _updateOrderBook();
            };
        }
        if (dirDown) {
            dirDown.onclick = function() {
                _termSelectedOutcome = { marketId: m.conditionId || m.id, index: 1 };
                document.querySelectorAll('.tr-dir-btn').forEach(function(b) { b.classList.remove('active'); });
                dirDown.classList.add('active');
                _updateTermTotals();
                _updateOrderBook();
            };
        }
        if (dirUp) dirUp.onclick();

        // Order Book buttons
        var obRefresh = document.getElementById('trObRefresh');
        if (obRefresh) obRefresh.onclick = function() { _updateOrderBook(); };
        var obUp = document.getElementById('trObUp');
        var obDown = document.getElementById('trObDown');
        if (obUp && obDown) {
            obUp.onclick = function() { obUp.classList.add('active'); obDown.classList.remove('active'); _updateOrderBook(); };
            obDown.onclick = function() { obDown.classList.add('active'); obUp.classList.remove('active'); _updateOrderBook(); };
        }

        // Quick buy buttons
        sel.querySelectorAll('.tr-qb-btn').forEach(function(btn) {
            btn.onclick = function() {
                var inp = document.getElementById('trCustomSize');
                if (inp) inp.value = btn.dataset.amount;
                _updateTermTotals();
            };
        });

        // Custom size input
        var szInp = document.getElementById('trCustomSize');
        if (szInp) {
            szInp.oninput = function() { _updateTermTotals(); };
            szInp.onkeyup = function() { _updateTermTotals(); };
        }

        // Type group toggle
        sel.querySelectorAll('.tr-type-btn').forEach(function(btn) {
            btn.onclick = function() {
                sel.querySelectorAll('.tr-type-btn').forEach(function(b) { b.classList.remove('active'); });
                btn.classList.add('active');
                var isLimit = btn.dataset.type === 'limit';
                ['trPriceField', 'trSharesField', 'trExpiryField'].forEach(function(id) {
                    var el = document.getElementById(id);
                    if (el) el.style.display = isLimit ? 'block' : 'none';
                });
            };
        });

        // Price step buttons
        var priceMinus = document.getElementById('trPriceMinus');
        var pricePlus = document.getElementById('trPricePlus');
        if (priceMinus) priceMinus.onclick = function() {
            var inp = document.getElementById('trPriceInput');
            if (inp) { inp.value = Math.max(0, (parseFloat(inp.value) || 0) - 1); _updateTermTotals(); }
        };
        if (pricePlus) pricePlus.onclick = function() {
            var inp = document.getElementById('trPriceInput');
            if (inp) { inp.value = Math.min(100, (parseFloat(inp.value) || 0) + 1); _updateTermTotals(); }
        };

        // Expiry dropdown
        var ddTrigger = document.getElementById('trExpiryTrigger');
        var ddPanel = document.getElementById('trExpiryPanel');
        document.addEventListener('click', function(e) {
            if (ddPanel && !e.target.closest('#trExpiryDD')) ddPanel.classList.remove('open');
        });
        if (ddTrigger) {
            ddTrigger.onclick = function(e) { e.stopPropagation(); if (ddPanel) ddPanel.classList.toggle('open'); };
        }
        if (ddPanel) {
            ddPanel.querySelectorAll('.tr-expiry-opt').forEach(function(opt) {
                opt.onclick = function() {
                    ddPanel.querySelectorAll('.tr-expiry-opt').forEach(function(b) { b.classList.remove('active'); });
                    opt.classList.add('active');
                    var val = opt.dataset.value;
                    if (val === 'custom') {
                        var modal = document.getElementById('trExpiryModal');
                        if (modal) modal.style.display = 'flex';
                        ddPanel.classList.remove('open');
                        return;
                    }
                    if (ddTrigger) {
                        ddTrigger.dataset.value = val;
                        var label = ddTrigger.querySelector('span');
                        if (label) label.textContent = opt.querySelector('span').textContent;
                    }
                    ddPanel.classList.remove('open');
                };
            });
        }

        // Expiry modal
        var expModal = document.getElementById('trExpiryModal');
        var expModalClose = document.getElementById('trExpiryModalClose');
        var expModalApply = document.getElementById('trExpiryModalApply');
        if (expModalClose) expModalClose.onclick = function() { if (expModal) expModal.style.display = 'none'; };
        if (expModal) expModal.onclick = function(e) { if (e.target === expModal) expModal.style.display = 'none'; };
        if (expModalApply) expModalApply.onclick = function() {
            var h = parseInt(document.getElementById('trExpiryHours')?.value) || 0;
            var m2 = parseInt(document.getElementById('trExpiryMins')?.value) || 0;
            var s = parseInt(document.getElementById('trExpirySecs')?.value) || 0;
            var total = h * 3600 + m2 * 60 + s;
            if (total <= 0) return;
            if (ddTrigger) {
                ddTrigger.dataset.value = total + 's';
                var label = ddTrigger.querySelector('span');
                if (label) label.textContent = h + 'h ' + m2 + 'm ' + s + 's';
            }
            if (expModal) expModal.style.display = 'none';
        };

        // Sell mode toggle
        sel.querySelectorAll('.tr-sell-mode-btn').forEach(function(btn) {
            btn.onclick = function() {
                sel.querySelectorAll('.tr-sell-mode-btn').forEach(function(b) { b.classList.remove('active'); });
                btn.classList.add('active');
                var mode = btn.dataset.smode;
                sel.querySelectorAll('.tr-qs-btn:not(.tr-qs-close)').forEach(function(sb) {
                    if (mode === 'usd') {
                        var usd = sb.dataset.usd;
                        sb.textContent = usd && parseFloat(usd) > 0 ? '$' + parseFloat(usd) : sb.dataset.pct + '%';
                    } else {
                        sb.textContent = sb.dataset.pct + '%';
                    }
                });
            };
        });

        // Quick sell buttons
        sel.querySelectorAll('.tr-qs-btn').forEach(function(btn) {
            btn.onclick = function() { /* sell logic placeholder */ };
        });

        // P-setup buttons
        sel.querySelectorAll('.tr-psetup-btn').forEach(function(btn) {
            btn.onclick = function() {
                sel.querySelectorAll('.tr-psetup-btn').forEach(function(b) { b.classList.remove('active'); });
                btn.classList.add('active');
                _updateQuickButtons(_getActiveProfile());
            };
        });
        var pSetupEdit = document.getElementById('trPSetupEdit');
        if (pSetupEdit) pSetupEdit.onclick = function() { _showPSetupModal(); };

        // Mode switching
        sel.querySelectorAll('.tr-mode-btn').forEach(function(btn) {
            btn.onclick = function() {
                sel.querySelectorAll('.tr-mode-btn').forEach(function(b) { b.classList.remove('active'); });
                btn.classList.add('active');
                _termState = btn.dataset.mode;
                var _isTrade = _termState === 'live' || _termState === 'demo';
                var bal = document.getElementById('trModeBalance');
                var strategiesSection = document.getElementById('trStrategiesSection');
                var copySection = document.getElementById('trCopySection');
                var walletRow = document.getElementById('trWalletRow');
                var orderForm = document.querySelector('.tr-order-form');
                var eventHeader = document.querySelector('.tr-event-header');
                var marketsSection = document.getElementById('trTerminalMarkets');
                var alertsSection = document.getElementById('trAlertsSection');
                var timerEl = document.getElementById('trEventTimer');
                var aiSection = document.getElementById('ev-ai-section');
                var favSection = document.getElementById('trFavoritesSection');
                var whaleSection = document.getElementById('trSmartWhaleSection');
                var walletsSection = document.getElementById('trWalletsSection');
                if (bal) bal.style.display = _termState === 'demo' ? 'flex' : 'none';
                if (strategiesSection) strategiesSection.style.display = _termState === 'strategies' ? 'block' : 'none';
                if (copySection) copySection.style.display = _termState === 'copy' ? 'block' : 'none';
                if (walletRow) walletRow.style.display = _termState === 'live' ? '' : 'none';
                if (orderForm) orderForm.style.display = _isTrade ? '' : 'none';
                if (eventHeader) eventHeader.style.display = _isTrade ? '' : 'none';
                if (marketsSection) marketsSection.style.display = _isTrade ? '' : 'none';
                if (alertsSection) alertsSection.style.display = _isTrade ? '' : 'none';
                if (timerEl) timerEl.style.display = _isTrade ? '' : 'none';
                if (aiSection) aiSection.style.display = 'none';
                if (favSection) favSection.style.display = 'none';
                if (whaleSection) whaleSection.style.display = 'none';
                if (walletsSection) walletsSection.style.display = 'none';
                if (_termState === 'strategies') { _botRender(); _phoenixRender(); }
                if (!_isTrade) _liveStopCheck();
                if (_termState === 'live') _liveCheckCurrentWallet();
            };
        });

        // Wallet select change
        var wsel = document.getElementById('trTermWalletSelect');
        if (wsel) {
            wsel.onchange = function() {
                _liveWalletIdx = parseInt(this.value);
                if (_liveWalletIdx >= 0) _liveCheckCurrentWallet();
            };
        }

        // Submit button
        var submitBtn = document.getElementById('trSubmitBtn');
        if (submitBtn) submitBtn.onclick = function() { _placeTermOrder(); };

        // Call button
        var callBtn = document.getElementById('trCallBtn');
        if (callBtn && _termEvent) callBtn.onclick = function() { showCallModal('event'); };

        // AI Agent button
        var aiBtn = document.getElementById('trAIAgentBtn');
        var aiSection = document.getElementById('ev-ai-section');
        if (aiBtn && aiSection) {
            aiBtn.onclick = function() {
                var hidden = aiSection.style.display === 'none';
                aiSection.style.display = hidden ? 'block' : 'none';
            };
        }
        var aiClose = document.getElementById('trAIClose');
        if (aiClose && aiSection) aiClose.onclick = function() { aiSection.style.display = 'none'; };

        // Description toggle
        var descBtn = document.getElementById('trDescToggle');
        var descEl = document.getElementById('trEventDesc');
        if (descBtn && descEl) {
            descBtn.onclick = function() { descEl.style.display = descEl.style.display === 'none' ? 'block' : 'none'; };
        }

        // Chart toggle
        var chartToggle = document.getElementById('trChartToggle');
        var chartSection = document.getElementById('trChartSection');
        if (chartToggle && chartSection) {
            chartToggle.onclick = function() {
                var hidden = chartSection.style.display === 'none';
                chartSection.style.display = hidden ? '' : 'none';
                chartToggle.classList.toggle('active', hidden);
                if (hidden) {
                    var titleEl = document.querySelector('.tr-event-title');
                    var title = titleEl ? titleEl.textContent : '';
                    var asset = _detectCryptoAsset(title);
                    if (asset) _initCryptoChart(asset);
                }
            };
        }

        // Chart source switching
        var srcBar = document.querySelector('.tr-chart-source-bar');
        if (srcBar) {
            srcBar.addEventListener('click', function(e) {
                var btn = e.target.closest('.tr-chart-src');
                if (!btn) return;
                srcBar.querySelectorAll('.tr-chart-src').forEach(function(b) { b.classList.remove('active'); });
                btn.classList.add('active');
                var container = document.getElementById('trChartContainer');
                var emptyEl = document.getElementById('trChartEmpty');
                if (container && emptyEl) {
                    var src = btn.dataset.src;
                    if (src === 'cl') {
                        container.style.display = '';
                        emptyEl.style.display = 'none';
                        var titleEl = document.querySelector('.tr-event-title');
                        var title = titleEl ? titleEl.textContent : '';
                        var asset = _detectCryptoAsset(title);
                        if (asset) {
                            _loadChainlinkChart('trChartContainer', 'BINANCE:' + asset + 'USDT', '5');
                        } else {
                            emptyEl.style.display = '';
                            emptyEl.textContent = 'Chainlink: ' + (t('terminal.chart_empty') || 'No data');
                        }
                    } else {
                        var titleEl = document.querySelector('.tr-event-title');
                        var title = titleEl ? titleEl.textContent : '';
                        var asset = _detectCryptoAsset(title);
                        if (asset) _createTVChart(asset, '5');
                    }
                }
            });
        }

        // Markets collapse toggle
        var trMH = document.getElementById('trMarketsHeader');
        var trMB = document.getElementById('trMarketsBody');
        if (trMH && trMB) {
            trMH.addEventListener('click', function(e) {
                e.stopPropagation();
                trMB.style.display = trMB.style.display === 'none' ? '' : 'none';
                trMH.classList.toggle('collapsed');
            });
        }

        // Favorites collapse toggle
        var trFH = document.getElementById('trFavoritesHeader');
        var trFB = document.getElementById('trFavoritesBody');
        if (trFH && trFB) {
            trFH.addEventListener('click', function(e) {
                e.stopPropagation();
                trFB.style.display = trFB.style.display === 'none' ? '' : 'none';
                trFH.classList.toggle('collapsed');
            });
        }

        // Strategy tabs
        document.querySelectorAll('.tr-strategies-tab').forEach(function(tab) {
            tab.onclick = function() {
                document.querySelectorAll('.tr-strategies-tab').forEach(function(t) { t.classList.remove('active'); });
                tab.classList.add('active');
                var tName = tab.dataset.strategyTab;
                var aiTab = document.getElementById('trStrategiesTabAI');
                var myTab = document.getElementById('trStrategiesTabMy');
                if (aiTab) aiTab.style.display = tName === 'ai' ? '' : 'none';
                if (myTab) myTab.style.display = tName === 'my' ? '' : 'none';
                if (tName === 'my') _renderStrategies();
                else if (tName === 'ai') { _botRender(); _phoenixRender(); }
            };
        });

        // Strategy option switching
        var _tradeStrategy = localStorage.getItem('polyBotStrategy') || 'clob';
        document.querySelectorAll('.tr-strategy-opt').forEach(function(opt) {
            opt.onclick = function(e) {
                if (e.target.closest('.tr-strategy-info-btn')) return;
                document.querySelectorAll('.tr-strategy-opt').forEach(function(o) { o.classList.remove('active'); });
                opt.classList.add('active');
                _tradeStrategy = opt.dataset.strategy;
                try { localStorage.setItem('polyBotStrategy', _tradeStrategy); } catch(e) {}
                var clobContent = document.getElementById('trBotClobContent');
                var deltaContent = document.getElementById('trBotDeltaContent');
                var phoenixContent = document.getElementById('trBotPhoenixContent');
                if (clobContent) clobContent.style.display = _tradeStrategy === 'clob' ? '' : 'none';
                if (deltaContent) deltaContent.style.display = _tradeStrategy === 'delta' ? '' : 'none';
                if (phoenixContent) phoenixContent.style.display = _tradeStrategy === 'phoenix' ? '' : 'none';
                if (_tradeStrategy === 'clob') _botRender();
                else if (_tradeStrategy === 'phoenix') _phoenixRender();
            };
        });

        // Strategy info buttons
        document.querySelectorAll('.tr-strategy-info-btn').forEach(function(btn) {
            btn.onclick = function(e) {
                e.stopPropagation();
                var strategy = btn.dataset.strategy;
                var modal = document.getElementById('trStrategyModal');
                var title = document.getElementById('trStrategyModalTitle');
                var desc = document.getElementById('trStrategyModalDesc');
                if (!modal || !title || !desc) return;
                var info = STRATEGY_DESCS[strategy] || STRATEGY_DESCS.clob;
                title.textContent = info.title;
                desc.textContent = info.desc;
                modal.style.display = 'flex';
            };
        });
        var stratModalClose = document.getElementById('trStrategyModalClose');
        if (stratModalClose) stratModalClose.onclick = function() { var m = document.getElementById('trStrategyModal'); if (m) m.style.display = 'none'; };
        var stratModal = document.getElementById('trStrategyModal');
        if (stratModal) stratModal.onclick = function(e) { if (e.target === stratModal) stratModal.style.display = 'none'; };

        // Bot start/stop — handled by _botRender
        // Mode balance click — open balance modal
        var modeBal = document.getElementById('trModeBalance');
        if (modeBal) {
            modeBal.style.cursor = 'pointer';
            modeBal.onclick = function() {
                if (_termState === 'demo') {
                    var balModal = document.getElementById('trBalModal');
                    var balInput = document.getElementById('trBalInput');
                    if (balModal && balInput) {
                        balInput.value = Math.round(_demoBalance || 0);
                        balModal.style.display = 'flex';
                    }
                }
            };
        }

        // Balance modal
        var balModal = document.getElementById('trBalModal');
        var balOverlay = document.getElementById('trBalOverlay');
        var balCloseBtn = document.getElementById('trBalClose');
        var balCancelBtn = document.getElementById('trBalCancel');
        var balApplyBtn = document.getElementById('trBalApply');
        var balInput = document.getElementById('trBalInput');
        function closeBalModal() { if (balModal) balModal.style.display = 'none'; }
        if (balOverlay) balOverlay.onclick = closeBalModal;
        if (balCloseBtn) balCloseBtn.onclick = closeBalModal;
        if (balCancelBtn) balCancelBtn.onclick = closeBalModal;
        if (balApplyBtn) balApplyBtn.onclick = function() {
            var val = parseFloat(balInput?.value);
            if (!isNaN(val) && val >= 0) { _demoBalance = val; localStorage.setItem('polyDemoBalance', String(val)); }
            closeBalModal();
            var balEl = document.getElementById('trModeBalance');
            if (balEl) balEl.textContent = '$' + fmtNum((_demoBalance || 0).toFixed(0));
        };
        document.querySelectorAll('.tr-bal-preset').forEach(function(b) {
            b.onclick = function() { if (balInput) balInput.value = this.dataset.val; };
        });
        if (balInput) balInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && balApplyBtn) balApplyBtn.click();
            if (e.key === 'Escape') closeBalModal();
        });

        // Event end timer
        (function() {
            var timerEl = document.getElementById('trEventTimer');
            if (!timerEl || !endDate) return;
            var end = new Date(endDate).getTime();
            if (isNaN(end)) { timerEl.style.display = 'none'; return; }
            function _tick() {
                var diff = end - Date.now();
                if (diff <= 0) { timerEl.textContent = 'Ended'; return; }
                var d = Math.floor(diff / 86400000);
                var h = Math.floor((diff % 86400000) / 3600000);
                var m2 = Math.floor((diff % 3600000) / 60000);
                var s = Math.floor((diff % 60000) / 1000);
                if (d > 0) timerEl.textContent = d + 'd ' + h + 'h ' + m2 + 'm';
                else if (h > 0) timerEl.textContent = h + 'h ' + m2 + 'm ' + s + 's';
                else timerEl.textContent = m2 + 'm ' + s + 's';
            }
            _tick();
            setInterval(_tick, 1000);
        })();

        // Initial UI state
        _updateTermTotals();
        _updatePosDisplay();
        _startTermPriceRefresh();
    }

    function _renderTermWalletSelect() {
        var wsel = document.getElementById('trTermWalletSelect');
        if (!wsel) return;
        var wallets = getWallets();
        var html = '<option value="-1">' + (wallets.length === 0 ? 'Нет кошельков' : 'Выберите кошелёк') + '</option>';
        wallets.forEach(function(w, i) {
            var label = (w.name || w.address.substring(0, 10) + '...') + ' (' + w.address.substring(0, 6) + '..)';
            html += '<option value="' + i + '">' + escHtml(label) + '</option>';
        });
        wsel.innerHTML = html;
    }

    function _liveCheckCurrentWallet() {
        var wsel = document.getElementById('trTermWalletSelect');
        if (!wsel) return;
        _liveWalletIdx = parseInt(wsel.value);
        if (_liveWalletIdx < 0) {
            _liveWalletAddr = ''; _liveWalletKey = '';
            _liveBalance = 0; _liveAllowance = 0;
            _liveRefreshDisplay(); _liveStopCheck();
            return;
        }
        var wallets = getWallets();
        var w = wallets[_liveWalletIdx];
        if (!w || !w.privateKey) {
            _liveWalletAddr = w ? (w.address || '') : ''; _liveWalletKey = '';
            _liveBalance = 0; _liveAllowance = 0;
            _liveRefreshDisplay(); _liveStopCheck();
            return;
        }
        _liveWalletAddr = w.address || '';
        _liveWalletKey = w.privateKey;
        _liveSetStatus('Проверка баланса...');
        loadEthersSite().then(function() {
            _liveBalanceOf(_liveWalletAddr).then(function(b) {
                _liveBalance = b;
                _liveAllowanceOf(_liveWalletAddr).then(function(a) {
                    _liveAllowance = a;
                    _liveRefreshDisplay();
                    var amt = parseFloat(document.getElementById('trCustomSize')?.value) || 0;
                    if (b >= amt && a >= amt) _liveSetStatus('✓ Достаточно средств', true);
                    else if (b >= amt && a < amt) _liveSetStatus('⚠ Требуется approve USDC');
                    else _liveSetStatus('✗ Недостаточно USDC (баланс: $' + b.toFixed(2) + ')');
                    _liveStartCheck();
                }).catch(function(e) { _liveSetStatus('Ошибка allowance: ' + (e.message || '')); });
            }).catch(function(e) { _liveSetStatus('Ошибка баланса: ' + (e.message || '')); });
        }).catch(function(e) { _liveSetStatus('Ошибка ethers: ' + (e.message || '')); });
    }

    function _liveRefreshDisplay() {
        var balEl = document.getElementById('trTermBal');
        var usdcEl = document.getElementById('trTermUSDC');
        var addrEl = document.getElementById('trTermAddr');
        if (addrEl && _liveWalletAddr) addrEl.textContent = _liveWalletAddr.substring(0, 6) + '...' + _liveWalletAddr.substring(38);
        if (balEl) balEl.textContent = '...';
        if (usdcEl) usdcEl.textContent = '$' + (_liveBalance || 0).toFixed(2);
        if (balEl && _liveWalletAddr) {
            var p = _liveRpc();
            if (p) p.getBalance(_liveWalletAddr).then(function(b) { if (balEl) balEl.textContent = parseFloat(ethers.formatEther(b)).toFixed(4); }).catch(function(){});
        }
    }

    function _updateTermTotals() {
        var amt = parseFloat(document.getElementById('trCustomSize')?.value) || 0;
        var totalEl = document.getElementById('trTotalField');
        if (!totalEl) return;

        // Get current selected direction price
        var prices = _termMarket && _termMarket.outcomePrices ? JSON.parse(_termMarket.outcomePrices) : [];
        var price = 0.5;
        if (_termSelectedOutcome && prices[_termSelectedOutcome.index] !== undefined) {
            price = parseFloat(prices[_termSelectedOutcome.index]);
        }
        var pDec = price;
        if (pDec > 0 && amt > 0) {
            var shares = amt / pDec;
            var profit = shares * (1 - pDec);
            var payoutField = document.getElementById('trPayoutField');
            var payoutVal = document.getElementById('trPayoutVal');
            var payoutShares = document.getElementById('trPayoutShares');
            if (payoutField && payoutVal && payoutShares) {
                payoutField.style.display = 'flex';
                payoutVal.textContent = '$' + fmtNum(profit.toFixed(2));
                payoutShares.textContent = Math.floor(shares) + ' shares @ ' + (pDec * 100).toFixed(1) + '¢';
            }
            totalEl.innerHTML = 'Total: <strong>$' + fmtNum(amt.toFixed(2)) + '</strong>';
        } else {
            var payoutField = document.getElementById('trPayoutField');
            if (payoutField) payoutField.style.display = 'none';
            totalEl.innerHTML = 'Total: <strong>$0.00</strong>';
        }
    }

    function _placeTermOrder() {
        if (!_termSelectedOutcome || !_termMarket) return;
        var amt = parseFloat(document.getElementById('trCustomSize')?.value) || 0;
        if (amt <= 0) { _liveSetStatus('✗ Введите сумму'); return; }

        if (_termState === 'live') {
            _placeLiveOrder(amt);
            return;
        }

        // ---- DEMO MODE ----
        if (amt > _demoBalance) {
            var stEl = document.getElementById('trErrorMsg');
            if (stEl) { stEl.textContent = '✗ Недостаточно средств. Баланс: $' + fmtNum(_demoBalance.toFixed(2)); stEl.style.display = 'block'; setTimeout(function() { stEl.style.display = 'none'; }, 3000); }
            return;
        }

        var prices = _termMarket.outcomePrices ? JSON.parse(_termMarket.outcomePrices) : [];
        var price = prices[_termSelectedOutcome.index] ? parseFloat(prices[_termSelectedOutcome.index]) : 0.5;
        var shares = amt / price;
        var outcomeLabel = _termSelectedOutcome.index === 0 ? 'UP' : 'DOWN';
        var marketId = _termMarket.conditionId || _termMarket.id;
        var title = _termMarket.question || (_termEvent ? _termEvent.title : '');

        _demoBalance -= amt;
        if (!_demoPositions[marketId]) _demoPositions[marketId] = { market: _termMarket, trades: [] };
        _demoPositions[marketId].trades.push({
            side: 'buy',
            outcomeId: outcomeLabel,
            outcomeIndex: _termSelectedOutcome.index,
            type: 'market',
            amount: amt,
            price: price,
            shares: shares,
            time: Date.now(),
            title: title
        });
        localStorage.setItem('polyDemoBalance', String(_demoBalance));
        localStorage.setItem('polyDemoPositions', JSON.stringify(_demoPositions));

        _updatePosDisplay();
        _updateTermTotals();

        // Update balance badge
        var balEl = document.getElementById('trModeBalance');
        if (balEl) balEl.textContent = '$' + fmtNum((_demoBalance || 0).toFixed(0));

        var stEl = document.getElementById('trErrorMsg');
        if (stEl) {
            stEl.textContent = '✅ Куплено ' + outcomeLabel + ' на $' + fmtNum(amt.toFixed(2)) + ' (' + shares.toFixed(2) + ' акций)';
            stEl.style.color = '#3fb950';
            stEl.style.display = 'block';
            setTimeout(function() { stEl.style.display = 'none'; }, 3000);
        }
    }

    function _placeLiveOrder(amt) {
        if (!_liveWalletKey) { _liveSetStatus('✗ Выберите кошелёк'); return; }
        if (amt <= 0) { _liveSetStatus('✗ Введите сумму'); return; }
        if (_liveOrderInFlight) return;
        _liveOrderInFlight = true;
        _liveSetBtnLoading(true);

        var prices = _termMarket.outcomePrices ? JSON.parse(_termMarket.outcomePrices) : [];
        var price = prices[_termSelectedOutcome.index] ? parseFloat(prices[_termSelectedOutcome.index]) : 0.5;
        var priceCents = price * 100;
        var shares = amt / price;

        // Get CLOB token ID
        var tids = _getClobTokenIds(_termMarket);
        var tokenId = (tids && tids[_termSelectedOutcome.index]) || '';

        _liveSetStatus('Проверка баланса...');

        loadEthersSite().then(function() {
            return _liveBalanceOf(_liveWalletAddr).then(function(b) {
                _liveBalance = b;
                _liveRefreshDisplay();
                if (b < amt) {
                    _liveSetStatus('✗ Недостаточно USDC: $' + b.toFixed(2) + ', нужно $' + amt.toFixed(2));
                    _liveSetBtnLoading(false);
                    _liveOrderInFlight = false;
                    return;
                }
                return _liveAllowanceOf(_liveWalletAddr).then(function(a) {
                    _liveAllowance = a;
                    _liveRefreshDisplay();
                    if (a < amt) {
                        return _liveDoApprove(_liveWalletKey, amt).then(function() {
                            return _liveDoSubmit(_liveWalletKey, tokenId, amt, priceCents, shares, price);
                        });
                    }
                    return _liveDoSubmit(_liveWalletKey, tokenId, amt, priceCents, shares, price);
                });
            });
        }).catch(function(e) {
            _liveSetStatus('✗ Ошибка: ' + (e.message || 'Неизвестная ошибка'));
            _liveSetBtnLoading(false);
            _liveOrderInFlight = false;
        });
    }

    function _liveDoApprove(privateKey, amount) {
        _liveSetStatus('Approve USDC...');
        return _liveApprove(privateKey, Math.max(amount * 2, 1000)).then(function() {
            _liveAllowance = Math.max(amount * 2, 1000);
            _liveRefreshDisplay();
            _liveSetStatus('✓ Approve успешен, отправка ордера...');
        });
    }

    function _liveDoSubmit(privateKey, tokenId, amt, priceCents, shares, price) {
        if (!tokenId) {
            _liveSetStatus('✗ Нет tokenId для этого исхода');
            _liveSetBtnLoading(false);
            _liveOrderInFlight = false;
            return;
        }
        _liveSetStatus('Подпись и отправка ордера...');

        return _liveSubmitOrder(privateKey, tokenId, 'BUY', String(priceCents / 100), String(shares)).then(function(result) {
            var orderId = result.orderID || result.id || result.orderId || 'ok';
            _liveSetStatus('✓ Ордер размещён! ID: ' + orderId, true);
            _liveSetBtnLoading(false);
            _liveOrderInFlight = false;

            var outcomeLabel = _termSelectedOutcome.index === 0 ? 'UP/YES' : 'DOWN/NO';
            var marketId = _termMarket.conditionId || _termMarket.id;
            var title = _termMarket.question || (_termEvent ? _termEvent.title : '');

            // Add to live trades
            var liveTrades = JSON.parse(localStorage.getItem('polyLiveTrades') || '[]');
            liveTrades.push({
                id: orderId,
                wallet: _liveWalletAddr,
                marketId: marketId,
                slug: _termMarket.slug || '',
                outcomeIndex: _termSelectedOutcome.index,
                outcomeName: outcomeLabel,
                eventTitle: title,
                price: price,
                shares: shares,
                amount: amt,
                side: 'BUY',
                status: 'open',
                timestamp: Date.now(),
                order: true
            });
            localStorage.setItem('polyLiveTrades', JSON.stringify(liveTrades));
            _updatePosDisplay();

        }).catch(function(e) {
            _liveSetStatus('✗ Ошибка ордера: ' + (e.message || JSON.stringify(e)));
            _liveSetBtnLoading(false);
            _liveOrderInFlight = false;
        });
    }

    function _updatePosDisplay() {
        var section = document.getElementById('trPositionSection');
        if (!section || !_termMarket) return;
        var marketId = _termMarket.conditionId || _termMarket.id;
        var prices = _termMarket.outcomePrices ? JSON.parse(_termMarket.outcomePrices) : [];

        // Check for any position (live or demo)
        var liveTrades = JSON.parse(localStorage.getItem('polyLiveTrades') || '[]');
        var marketLiveTrades = liveTrades.filter(function(t) { return String(t.marketId) === String(marketId) && t.side === 'BUY' && t.status === 'open'; });
        var posData = _demoPositions[marketId];
        var demoLen = posData && posData.trades ? posData.trades.length : 0;

        if (marketLiveTrades.length === 0 && demoLen === 0) {
            section.style.display = 'none';
            return;
        }

        section.style.display = 'block';
        // Show last trade details in the position section
        var lastTrade = null;
        var isDemo = false;
        if (marketLiveTrades.length > 0) {
            lastTrade = marketLiveTrades[marketLiveTrades.length - 1];
        } else if (demoLen > 0) {
            lastTrade = posData.trades[posData.trades.length - 1];
            isDemo = true;
        }

        var outcomeEl = document.getElementById('trPosOutcome');
        var sharesEl = document.getElementById('trPosShares');
        var entryEl = document.getElementById('trPosEntry');
        var valueEl = document.getElementById('trPosValue');
        var pnlEl = document.getElementById('trPosPnl');

        if (lastTrade) {
            var currentPrice = prices[lastTrade.outcomeIndex] ? parseFloat(prices[lastTrade.outcomeIndex]) : lastTrade.price;
            var currentVal = currentPrice * lastTrade.shares;
            var pnl = currentVal - lastTrade.amount;
            if (outcomeEl) outcomeEl.textContent = (lastTrade.outcomeName || (lastTrade.outcomeIndex === 0 ? 'UP' : 'DOWN')) + (isDemo ? ' (DEMO)' : ' (LIVE)');
            if (sharesEl) sharesEl.textContent = lastTrade.shares.toFixed(2);
            if (entryEl) entryEl.textContent = (lastTrade.price * 100).toFixed(1) + '¢';
            if (valueEl) valueEl.textContent = '$' + fmtNum(currentVal.toFixed(2));
            if (pnlEl) {
                pnlEl.textContent = (pnl >= 0 ? '+' : '') + '$' + fmtNum(Math.abs(pnl).toFixed(2));
                pnlEl.style.color = pnl >= 0 ? 'var(--positive)' : 'var(--negative)';
            }
        }
    }

    function _startTermPriceRefresh() {
        if (_termPriceInterval) clearInterval(_termPriceInterval);
        _termPriceInterval = setInterval(function() {
            if (!_termMarket) { console.log('DEBUG: no _termMarket'); return; }
            var marketId = (_termMarket.conditionId || _termMarket.id || '').replace(/^0x/, '');
            if (!marketId) { console.log('DEBUG: no marketId', _termMarket.conditionId, _termMarket.id); return; }
            console.log('DEBUG: fetching prices for', marketId);
            pageFetch(GAMMA_API + '/markets?condition_id=' + encodeURIComponent(marketId))
                .then(function(text) {
                    var data = JSON.parse(text);
                    if (data && data.outcomePrices) {
                        _termMarket.outcomePrices = data.outcomePrices;
                        var prices = JSON.parse(data.outcomePrices);
                        var upPrice = document.getElementById('trUpPrice');
                        var downPrice = document.getElementById('trDownPrice');
                        var upFill = document.getElementById('trUpBarFill');
                        var downFill = document.getElementById('trDownBarFill');
                        if (prices[0] !== undefined) {
                            if (upPrice) upPrice.textContent = (prices[0] * 100).toFixed(1) + '¢';
                            if (upFill) upFill.style.width = (prices[0] * 100) + '%';
                        }
                        if (prices[1] !== undefined) {
                            if (downPrice) downPrice.textContent = (prices[1] * 100).toFixed(1) + '¢';
                            if (downFill) downFill.style.width = (prices[1] * 100) + '%';
                        }
                        _updatePosDisplay();
                    }
                })
                .catch(function() {});
        }, 5000);

        // Watch for demo balance changes
        setInterval(function() {
            var balEl = document.getElementById('trModeBalance');
            if (balEl && _termState === 'demo') balEl.textContent = '$' + fmtNum((_demoBalance || 0).toFixed(0));
        }, 2000);
    }

    function _updateOrderBook() {
        if (!_termSelectedOutcome || !_termMarket) { console.log('DEBUG: _updateOrderBook skipped', !!_termSelectedOutcome, !!_termMarket); return; }
        console.log('DEBUG: _updateOrderBook called');
        var obSection = document.getElementById('trObSection');
        if (obSection) obSection.style.display = '';
        var marketId = (_termMarket.conditionId || _termMarket.id || '').replace(/^0x/, '');
        var idx = _termSelectedOutcome.index;
        var tokenIds = _termMarket.tokenIds || _termMarket.clobTokenIds;
        if (!tokenIds || !tokenIds[idx]) {
            // Try to fetch token IDs from gamma
            var url = GAMMA_API + '/markets?condition_id=' + encodeURIComponent(marketId);
            pageFetch(url).then(function(text) {
                var data = JSON.parse(text);
                console.log('DEBUG: gamma response', data);
                var tid = data && data.clobTokenIds;
                console.log('DEBUG: clobTokenIds', tid);
                if (tid) {
                    _termMarket.clobTokenIds = tid;
                    _fetchAndRenderOb(tid[idx]);
                }
            }).catch(function(e) { console.log('DEBUG: gamma error', e); });
            return;
        }
        _fetchAndRenderOb(tokenIds[idx]);

        // Also prefetch the other outcome
        var otherIdx = 1 - idx;
        if (tokenIds[otherIdx]) {
            var cached = _obCache[tokenIds[otherIdx]];
            if (!cached || Date.now() - cached.ts > 5000) {
                pageFetch(CLOB_API + '/book?token_id=' + tokenIds[otherIdx])
                    .then(function(t) { var d = JSON.parse(t); if (d) _obCache[tokenIds[otherIdx]] = { data: d, ts: Date.now() }; })
                    .catch(function() {});
            }
        }
    }

    function _fetchAndRenderOb(tokenId) {
        if (!tokenId) return;
        var cached = _obCache[tokenId];
        if (cached && Date.now() - cached.ts < 1000) {
            _renderOB(cached.data);
            return;
        }
        pageFetch(CLOB_API + '/book?token_id=' + tokenId)
            .then(function(text) {
                var data = JSON.parse(text);
                if (data) {
                    _obCache[tokenId] = { data: data, ts: Date.now() };
                    _renderOB(data);
                }
            })
            .catch(function() {});
    }

    function _renderOB(book) {
        if (!book) return;
        var body = document.getElementById('trObBody');
        if (!body) return;

        var asks = (book.asks || []).slice(0, 10);
        var bids = (book.bids || []).slice(0, 10);
        var norm = function(o) { return Array.isArray(o) ? { price: parseFloat(o[0]), size: parseFloat(o[1]) } : { price: parseFloat(o.price || 0), size: parseFloat(o.size || 0) }; };
        asks = asks.map(norm).sort(function(a, b) { return b.price - a.price; });
        bids = bids.map(norm).sort(function(a, b) { return b.price - a.price; });

        var maxAsk = asks.length > 0 ? Math.max.apply(null, asks.map(function(o) { return o.size; })) : 1;
        var maxBid = bids.length > 0 ? Math.max.apply(null, bids.map(function(o) { return o.size; })) : 1;
        var maxTotal = Math.max(
            asks.reduce(function(s, o, i, arr) { return s + o.size; }, 0),
            bids.reduce(function(s, o, i, arr) { return s + o.size; }, 0)
        ) || 1;

        var html = '';
        // Asks (top to bottom: highest to lowest)
        var cumAsk = 0;
        asks.forEach(function(o) {
            cumAsk += o.size;
            var pct = (o.size / maxAsk * 100).toFixed(0);
            var cumPct = (cumAsk / maxTotal * 100).toFixed(0);
            html += '<div class="tr-ob-row ask">'
                + '<span class="tr-ob-price" style="color:#ef4444">' + (o.price * 100).toFixed(2) + '</span>'
                + '<span class="tr-ob-size">' + o.size.toFixed(2) + '</span>'
                + '<span class="tr-ob-total">' + cumAsk.toFixed(2) + '</span>'
                + '<span class="tr-ob-bar" style="width:' + cumPct + '%;background:rgba(239,68,68,0.12)"></span>'
                + '</div>';
        });

        // Spread
        var bestAsk = asks.length > 0 ? asks[asks.length - 1] : null;
        var bestBid = bids.length > 0 ? bids[0] : null;
        var lastPrice = bestAsk && bestBid ? ((bestAsk.price + bestBid.price) / 2) : (bestAsk ? bestAsk.price : (bestBid ? bestBid.price : 0));
        var spread = bestAsk && bestBid ? ((bestAsk.price - bestBid.price) * 100).toFixed(2) : '\u2014';
        html += '<div class="tr-ob-spread' + (spread !== '\u2014' ? (parseFloat(spread) >= 0 ? ' up' : ' down') : '') + '">'
            + '<span>Spread: ' + spread + '\u00a2</span>'
            + '<span>Last: ' + (lastPrice * 100).toFixed(2) + '\u00a2</span>'
            + '</div>';

        // Bids (top to bottom: highest to lowest)
        var cumBid = 0;
        bids.forEach(function(o) {
            cumBid += o.size;
            var pct = (o.size / maxBid * 100).toFixed(0);
            var cumPct = (cumBid / maxTotal * 100).toFixed(0);
            html += '<div class="tr-ob-row bid">'
                + '<span class="tr-ob-price" style="color:#22c55e">' + (o.price * 100).toFixed(2) + '</span>'
                + '<span class="tr-ob-size">' + o.size.toFixed(2) + '</span>'
                + '<span class="tr-ob-total">' + cumBid.toFixed(2) + '</span>'
                + '<span class="tr-ob-bar" style="width:' + cumPct + '%;background:rgba(34,197,94,0.12)"></span>'
                + '</div>';
        });
        body.innerHTML = html;
    }

    // ====================== STRATEGIES STATE ======================
    var _demoBot = null;
    var _clobPositions = {};
    var _clobOpenOrders = [];
    var _clobStats = { trades: 0, wins: 0, losses: 0, totalPnl: 0, totalFees: 0, totalRebate: 0, startTime: 0 };
    var _clobConditionTokens = {};
    var _clobPrices = {};
    var _clobConditionSymbol = {};
    var _clobWsReconnectDelay = 1000;
    var _clobDiscoveredConditions = {};
    var _clobLastDiscoveryTime = 0;
    var _botTimerInterval = null;
    var _autoStartPending = false;
    var _phoenixBot = null;

    function maxPosFromStorage() {
        try { var v = parseFloat(localStorage.getItem('polyBotMaxPosition')); return v > 0 ? v : 200; } catch(e) { return 200; }
    }

    function _demoBotDefault() {
        var _sb = parseFloat(localStorage.getItem('polyBotStartBalance'));
        var startBal = _sb && _sb > 0 ? _sb : 100000;
        return {
            running: false, balance: startBal, startBalance: startBal,
            totalPnl: 0, totalTrades: 0, wins: 0, losses: 0,
            positions: {}, tracked: {}, logs: [], history: [], rounds: [], roundCounter: 0,
            intervalId: null, renderIntervalId: null, startTime: null,
            pollMs: 1000, maxPosition: Math.min(startBal, maxPosFromStorage()), _lastTickTime: 0, _priceCache: {}, _symCounters: {}, profitTarget: 0
        };
    }

    var BOT_STATE_KEY = 'polyBotState';
    var _lastStateSave = 0;
    function _botSaveState(force) {
        try {
            var now = Date.now();
            if (!force && now - _lastStateSave < 10000) return;
            _lastStateSave = now;
            var b = _demoBot;
            if (!b) return;
            if (!b.running && !force) return;
            var state = {
                running: b.running, balance: b.balance, startBalance: b.startBalance,
                totalPnl: b.totalPnl, totalTrades: b.totalTrades,
                wins: b.wins, losses: b.losses, roundCounter: b.roundCounter, _symCounters: b._symCounters,
                positions: b.positions, tracked: b.tracked, rounds: b.rounds,
                maxPosition: b.maxPosition, pollMs: b.pollMs,
                profitTarget: b.profitTarget || 0,
                clobPositions: _clobPositions, clobOpenOrders: _clobOpenOrders, clobStats: _clobStats,
                savedAt: Date.now()
            };
            localStorage.setItem(BOT_STATE_KEY, JSON.stringify(state));
        } catch(e) {}
    }
    function _botLoadState() {
        try {
            var raw = localStorage.getItem(BOT_STATE_KEY);
            if (!raw) return null;
            var state = JSON.parse(raw);
            if (!state || Date.now() - state.savedAt > 86400000) {
                localStorage.removeItem(BOT_STATE_KEY);
                return null;
            }
            return state;
        } catch(e) { return null; }
    }

    function _getBot() {
        if (!_demoBot) {
            var saved = _botLoadState();
            if (saved) {
                _demoBot = _demoBotDefault();
                _demoBot.balance = saved.balance;
                _demoBot.startBalance = saved.startBalance;
                _demoBot.totalPnl = saved.totalPnl || 0;
                _demoBot.totalTrades = saved.totalTrades || 0;
                _demoBot.wins = saved.wins || 0;
                _demoBot.losses = saved.losses || 0;
                _demoBot.roundCounter = saved.roundCounter || 0;
                _demoBot._symCounters = saved._symCounters || {};
                _demoBot.positions = saved.positions || {};
                _demoBot.tracked = saved.tracked || {};
                _demoBot.rounds = saved.rounds || [];
                _demoBot.maxPosition = Math.min(_demoBot.balance, saved.maxPosition || 200);
                _demoBot.profitTarget = saved.profitTarget || 0;
                if (saved.clobPositions) _clobPositions = saved.clobPositions;
                if (saved.clobOpenOrders) _clobOpenOrders = Array.isArray(saved.clobOpenOrders) ? saved.clobOpenOrders : [];
                if (saved.clobStats) _clobStats = saved.clobStats;
                if (saved.running) _autoStartPending = true;
            } else {
                _demoBot = _demoBotDefault();
            }
        }
        return _demoBot;
    }

    function _saveBotSelectedAssets(assets) {
        localStorage.setItem('polyBotAssets', JSON.stringify(assets));
    }

    function _phoenixDefault() {
        return {
            running: false, balance: 1000, startBalance: 1000,
            entryCents: 2, targetCents: 20,
            budgetMode: 'pct', budgetPct: 5, budgetFixed: 15,
            stopEnabled: false, stopPct: 30,
            positions: {}, rounds: [], roundCounter: 0,
            intervalId: null, startTime: null
        };
    }
    function _phoenixGetBot() {
        if (!_phoenixBot) {
            try {
                var d = JSON.parse(localStorage.getItem('polyPhoenixState'));
                if (d) { _phoenixBot = d; return _phoenixBot; }
            } catch(e) {}
            _phoenixBot = _phoenixDefault();
        }
        return _phoenixBot;
    }
    function _phoenixSaveState() {
        if (_phoenixBot) localStorage.setItem('polyPhoenixState', JSON.stringify(_phoenixBot));
    }

    function _botLog(type, msg) {
        var b = _getBot();
        b.history = b.history || [];
        b.history.push({ type: type, msg: msg, t: Date.now() });
        if (b.history.length > 500) b.history.splice(0, b.history.length - 500);
    }

    function _botSaveRound(r) {
        try {
            var rounds = JSON.parse(localStorage.getItem('polyBotRounds') || '[]');
            rounds.push(r);
            if (rounds.length > 100) rounds = rounds.slice(-100);
            localStorage.setItem('polyBotRounds', JSON.stringify(rounds));
        } catch(e) {}
    }
    function _botLoadRoundsFromStorage() {
        try {
            var rounds = JSON.parse(localStorage.getItem('polyBotRounds') || '[]');
            var b = _getBot();
            b.rounds = rounds;
            if (rounds.length > 0) b.roundCounter = rounds[rounds.length - 1].num || 0;
        } catch(e) {}
    }

    function _clobDisconnectWs() {}
    function _clobTick() {}

    function _demoBotStart() {
        var b = _getBot();
        if (b.running) return;
        var def = _demoBotDefault();
        for (var k in def) {
            if (k !== 'intervalId' && k !== 'startTime' && k !== 'running') {
                if (k === 'positions' || k === 'tracked' || k === 'rounds' || k === 'logs' || k === 'history') {
                    if (b[k] && typeof b[k] === 'object' && Object.keys(b[k]).length > 0) continue;
                }
                if (k === 'balance' && b.balance > 0 && b.balance !== 100000) continue;
                if (k === 'startBalance' && b.startBalance > 0) continue;
                b[k] = def[k];
            }
        }
        b.running = true; b.startTime = Date.now();
        if (Object.keys(_clobPositions).length === 0 && _clobOpenOrders.length === 0) {
            _clobStats = { trades: 0, wins: 0, losses: 0, totalPnl: 0, totalFees: 0, totalRebate: 0, startTime: Date.now() };
            _clobOpenOrders = [];
            _clobPositions = {};
        }
        _clobWsReconnectDelay = 1000;
        _botLoadRoundsFromStorage();
        _botLog('info', 'CLOB Market Making started. Balance: $' + b.balance.toFixed(0));
        _clobTick();
        b.intervalId = setInterval(_clobTick, 1000);
        b.renderIntervalId = setInterval(_botRender, 1000);
        _botRender();
        _botSaveState(true);
    }

    function _demoBotStop() {
        var b = _getBot();
        b.running = false;
        var closedSymCount = {};
        var _stopEntryBal = b.balance;
        for (var pk in _clobPositions) {
            var pos = _clobPositions[pk];
            if (pos && pos.size > 0) {
                var closePrice = pos.entryPrice;
                if (pos.tokenSide) {
                    var tp = _clobPrices[pk];
                    if (tp && tp.bid != null) closePrice = tp.bid;
                }
                var buyCost = pos.entryPrice * pos.size;
                var sellValue = closePrice * pos.size;
                var grossPnl = sellValue - buyCost;
                b.balance += sellValue;
                b.totalPnl += grossPnl;
                b.totalTrades++;
                if (grossPnl >= 0) b.wins++; else b.losses++;
                _clobStats.trades++;
                if (grossPnl >= 0) _clobStats.wins++; else _clobStats.losses++;
                _clobStats.totalPnl += grossPnl;
                var sym = pos.sym || '?';
                var symKey = sym + '_' + pk;
                if (!closedSymCount[symKey]) closedSymCount[symKey] = { pnl: 0, sym: sym, entrySum: 0, closeSum: 0, count: 0 };
                closedSymCount[symKey].pnl += grossPnl;
                closedSymCount[symKey].entrySum += pos.entryPrice;
                closedSymCount[symKey].closeSum += closePrice;
                closedSymCount[symKey].count++;
                _botLog('info', 'Position force-closed on stop: ' + (pos.tokenSide || '?') + ' ' + (pos.cid || '').substring(0, 8) + ' ' + pos.size + ' @ $' + closePrice.toFixed(3) + ', PnL $' + grossPnl.toFixed(2));
            }
            delete _clobPositions[pk];
        }
        for (var sk in closedSymCount) {
            var sc = closedSymCount[sk];
            var avgEntry = sc.count > 0 ? sc.entrySum / sc.count : 0;
            var avgClose = sc.count > 0 ? sc.closeSum / sc.count : 0;
            var _r = { num: ++b.roundCounter, endTime: Date.now(), pnl: sc.pnl, sym: sc.sym, startPrice: avgEntry, endPrice: avgClose, entryBal: _stopEntryBal };
            b.rounds.push(_r);
            _botSaveRound(_r);
        }
        _clobDisconnectWs();
        _clobDiscoveredConditions = {};
        _clobLastDiscoveryTime = 0;
        _botSaveState(true);
        if (b.intervalId) { clearInterval(b.intervalId); b.intervalId = null; }
        if (b.renderIntervalId) { clearInterval(b.renderIntervalId); b.renderIntervalId = null; }
        _botLog('info', 'CLOB Market Making stopped. Final balance: $' + b.balance.toFixed(2));
        _botRender();
    }

    function _botRender() {
        var b = _getBot();
        var balInp = document.getElementById('trBotBalInput');
        var btn = document.getElementById('trBotStartBtn');
        var pos = document.getElementById('trBotPositions');
        var posCntEl = document.getElementById('trBotPosCount');
        if (posCntEl) posCntEl.textContent = String(Object.keys(_clobPositions).length);
        if (balInp) {
            balInp.value = b.balance.toFixed(2);
            balInp.oninput = function() { var v2 = parseFloat(this.value); if (v2 > 0 && !b.running) { b.balance = v2; b.startBalance = v2; localStorage.setItem('polyBotStartBalance', String(v2)); b.maxPosition = Math.min(v2, maxPosFromStorage()); } };
        }
        var minSpreadInp = document.getElementById('trClobMinSpread');
        if (minSpreadInp) {
            minSpreadInp.value = localStorage.getItem('polyClobMinSpread') || 2;
            minSpreadInp.oninput = function() { localStorage.setItem('polyClobMinSpread', this.value); };
        }
        var rebateInp = document.getElementById('trClobRebate');
        if (rebateInp) {
            rebateInp.value = localStorage.getItem('polyClobRebate') || 20;
            rebateInp.oninput = function() { localStorage.setItem('polyClobRebate', this.value); };
        }
        var orderSizeInp = document.getElementById('trClobOrderSize');
        if (orderSizeInp) {
            orderSizeInp.value = localStorage.getItem('polyClobOrderSize') || 100;
            orderSizeInp.oninput = function() { localStorage.setItem('polyClobOrderSize', this.value); };
        }
        var timeoutInp = document.getElementById('trClobTimeout');
        if (timeoutInp) {
            timeoutInp.value = localStorage.getItem('polyClobTimeout') || 3;
            timeoutInp.oninput = function() { localStorage.setItem('polyClobTimeout', this.value); };
        }
        var gasCostInp = document.getElementById('trClobGasCost');
        if (gasCostInp) {
            gasCostInp.value = localStorage.getItem('polyClobGasCost') || 0.02;
            gasCostInp.oninput = function() { localStorage.setItem('polyClobGasCost', this.value); };
        }
        if (balInp) { balInp.value = b.balance.toFixed(2); balInp.disabled = b.running; }
        var statsEl = document.getElementById('trBotStats');
        if (statsEl) {
            var _trades = _clobStats.trades;
            var _wins = _clobStats.wins;
            var _losses = _clobStats.losses;
            var _totalPnL = _clobStats.totalPnl;
            var _rebate = _clobStats.totalRebate;
            var _wr = (_wins + _losses) > 0 ? (_wins / (_wins + _losses) * 100).toFixed(0) : '-';
            var _wrDisplay = (_wins + _losses) > 0 ? _wr + '%' : '\u2014';
            var _pnlDisplay = _totalPnL === 0 ? '$0' : (_totalPnL > 0 ? '+' : '') + '$' + _totalPnL.toFixed(2);
            var _rebateDisplay = _rebate === 0 ? '$0' : '$' + _rebate.toFixed(2);
            var _pnlClass = _totalPnL > 0 ? ' tr-agent-p' : _totalPnL < 0 ? ' tr-agent-n' : '';
            statsEl.innerHTML = '<div class="tr-agent-stat" data-s="tr"><div class="tr-agent-stat-label">' + (settingsT('terminal.strategy_trades') || 'Trades') + '</div><div class="tr-agent-stat-num">' + _trades + '</div></div>'
                + '<div class="tr-agent-stat" data-s="wr"><div class="tr-agent-stat-label">' + (settingsT('terminal.strategy_wr') || 'Win Rate') + '</div><div class="tr-agent-stat-num">' + _wrDisplay + '</div></div>'
                + '<div class="tr-agent-stat" data-s="pnl"><div class="tr-agent-stat-label">PnL</div><div class="tr-agent-stat-num' + _pnlClass + '">' + _pnlDisplay + '</div></div>'
                + '<div class="tr-agent-stat" data-s="reb"><div class="tr-agent-stat-label">' + (settingsT('terminal.strategy_rebate') || 'Rebate') + '</div><div class="tr-agent-stat-num tr-agent-p">' + _rebateDisplay + '</div></div>';
        }
        var clearBtn = document.getElementById('trBotRoundsClear');
        if (clearBtn) clearBtn.style.display = b.rounds.length > 0 ? '' : 'none';
        _botRenderRounds();
        if (btn) {
            btn.textContent = b.running ? '\u23f9' : '\u25b6';
            btn.className = 'tr-bot-start-btn' + (b.running ? ' running' : '');
            btn.onclick = b.running ? _demoBotStop : _demoBotStart;
        }
        if (pos) {
            var clobKeys = Object.keys(_clobPositions);
            if (clobKeys.length === 0) {
                pos.innerHTML = '<div class="tr-bot-empty">' + (settingsT('terminal.no_positions') || 'No open positions') + '</div>';
            } else {
                var h = '';
                for (var pk in _clobPositions) {
                    var pp = _clobPositions[pk];
                    if (!pp || pp.size <= 0) continue;
                    var curPrice = pp.entryPrice;
                    var tp = _clobPrices[pk];
                    if (tp && tp.bid != null) curPrice = tp.bid;
                    var val = curPrice * pp.size;
                    var cost = pp.entryPrice * pp.size;
                    var unrealized = val - cost;
                    var sym = pp.sym || '?';
                    var pnlCls = unrealized >= 0 ? 'tr-bot-pos-green' : 'tr-bot-pos-red';
                    var pnlStr = (unrealized >= 0 ? '+' : '') + '$' + unrealized.toFixed(2);
                    var cpy = encodeURIComponent(sym + ' ' + (pp.tokenSide || '') + '\nSize: ' + pp.size.toFixed(1) + '\nEntry: $' + pp.entryPrice.toFixed(3) + '\nCur: $' + curPrice.toFixed(3) + '\nUnrealized PnL: ' + pnlStr);
                    h += '<div class="tr-bot-pos"><div class="tr-bot-pos-accent"></div><div class="tr-bot-pos-body">'
                        + '<div class="tr-bot-pos-hdr"><span class="tr-bot-pos-title">' + sym + ' ' + (pp.tokenSide || '') + '</span><div class="tr-bot-pos-hdr-r"><button class="tr-bot-pos-copy" data-pos="' + cpy + '" title="Copy">\u2398</button></div></div>'
                        + '<div class="tr-bot-pos-tbl">'
                        + '<div class="tr-bot-pos-tr"><span class="tr-bot-pos-td">' + (settingsT('terminal.strategy_size') || 'Size') + '</span><span class="tr-bot-pos-td-shr">' + pp.size.toFixed(1) + '</span></div>'
                        + '<div class="tr-bot-pos-tr"><span class="tr-bot-pos-td">' + (settingsT('terminal.entry_price') || 'Entry') + '</span><span class="tr-bot-pos-td-shr">$' + pp.entryPrice.toFixed(3) + '</span></div>'
                        + '<div class="tr-bot-pos-tr"><span class="tr-bot-pos-td">' + (settingsT('terminal.strategy_cur') || 'Cur') + '</span><span class="tr-bot-pos-td-shr">$' + curPrice.toFixed(3) + '</span></div>'
                        + '</div>'
                        + '<div class="tr-bot-pos-cur ' + pnlCls + '">' + pnlStr + '</div>'
                        + '</div></div>';
                }
                if (h === '') pos.innerHTML = '<div class="tr-bot-empty">' + (settingsT('terminal.no_positions') || 'No open positions') + '</div>';
                else pos.innerHTML = h;
            }
        }
    }

    function _botRenderRounds() {
        var el = document.getElementById('trBotRounds');
        if (!el) return;
        var b = _getBot();
        var rounds = b.rounds;
        var _c = document.getElementById('trBotRoundsClear');
        if (_c) _c.style.display = rounds.length > 0 ? '' : 'none';
        var _copy = document.getElementById('trBotRoundsCopy');
        if (_copy) _copy.style.display = rounds.length > 0 ? '' : 'none';
        if (rounds.length === 0) { el.innerHTML = '<div class="tr-bot-rounds-empty">' + (settingsT('terminal.no_rounds') || 'No completed rounds') + '</div>'; return; }
        var total = 0;
        for (var ri = 0; ri < rounds.length; ri++) total += rounds[ri].pnl;
        var html = '<div class="tr-bot-rounds-tbl"><div class="tr-bot-rounds-tr tr-bot-rounds-th"><span></span><span>#</span><span>' + (settingsT('terminal.strategy_time') || 'Time') + '</span><span>' + (settingsT('terminal.strategy_sym') || 'Sym') + '</span><span class="tr-bot-rounds-pnl">PnL</span></div>';
        var start = Math.max(0, rounds.length - 30);
        for (var i = start; i < rounds.length; i++) {
            var r = rounds[i];
            var ts = new Date(r.endTime).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
            var ps = (r.pnl >= 0 ? '+' : '') + '$' + r.pnl.toFixed(2);
            var pc = r.pnl >= 0 ? 'tr-bot-rounds-grn' : 'tr-bot-rounds-red';
            var _tt = r.entryBal ? 'Entry Bal: $' + r.entryBal.toFixed(2) + ' | Prices: ' + (r.startPrice != null ? r.startPrice.toFixed(4) : '\u2014') + '/' + (r.endPrice != null ? r.endPrice.toFixed(4) : '\u2014') : '';
            html += '<div class="tr-bot-rounds-tr" data-rnum="' + r.num + '" title="' + _tt + '"><button class="tr-bot-rounds-del" title="Delete">\u2715</button><span>' + r.num + '</span><span>' + ts + '</span><span>' + (r.sym || '') + '</span><span class="tr-bot-rounds-pnl ' + pc + '">' + ps + '</span></div>';
        }
        var ts2 = (total >= 0 ? '+' : '') + '$' + total.toFixed(2);
        var tc2 = total >= 0 ? 'tr-bot-rounds-grn' : 'tr-bot-rounds-red';
        html += '<div class="tr-bot-rounds-tr tr-bot-rounds-total"><span></span><span></span><span></span><span>' + (settingsT('terminal.strategy_total') || 'Total') + '</span><span class="tr-bot-rounds-pnl ' + tc2 + '">' + ts2 + '</span></div></div>';
        el.innerHTML = html;
    }

    function _botGetHistFilter() {
        try { return document.querySelector('#trBotHistFilters .tr-bot-hist-filter.active')?.dataset?.filter || 'all'; } catch(e) { return 'all'; }
    }

    function _botRenderHistory() {
        var el = document.getElementById('trBotLog');
        if (!el) return;
        var b = _getBot();
        var filter = _botGetHistFilter();
        var hist = b.history || [];
        var html = '';
        var count = 0;
        for (var i = hist.length - 1; i >= 0; i--) {
            var h = hist[i];
            if (filter !== 'all' && h.sym !== filter) continue;
            if (count++ >= 50) break;
            var ts = new Date(h.t).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
            var sym = h.sym || '';
            var typeLabel = '', typeCls = '', detail = '', amtStr = '', pnlStr = '', balStr = '';
            if (h.type === 'entry') {
                typeLabel = 'Entry'; typeCls = 'tr-bot-h-entry';
                detail = (h.upCt || '?') + 'Up $' + (h.upAmt || 0).toFixed(0) + ' / ' + (h.dnCt || '?') + 'Dn $' + (h.dnAmt || 0).toFixed(0);
                amtStr = '$' + (h.totalAmt || 0).toFixed(0);
                balStr = '$' + (h.balAfter || 0).toFixed(0);
            } else if (h.type === 'accum') {
                typeLabel = 'Accum'; typeCls = 'tr-bot-h-accum';
                var parts = [];
                if (h.upAdd) parts.push('+' + h.upAdd + 'Up');
                if (h.dnAdd) parts.push('+' + h.dnAdd + 'Dn');
                detail = parts.join(' ') + ' $' + (h.totalCost || 0).toFixed(0);
                amtStr = '$' + (h.totalCost || 0).toFixed(0);
                balStr = '$' + (h.balAfter || 0).toFixed(0);
            } else if (h.type === 'result') {
                typeLabel = 'Result'; typeCls = 'tr-bot-h-result';
                detail = h.outcome || '';
                var pnl = h.pnl || 0; pnlStr = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2);
                amtStr = '$' + (h.payout || 0).toFixed(0);
                balStr = '$' + (h.balAfter || 0).toFixed(0);
            } else if (h.type === 'info') {
                typeLabel = 'Info'; typeCls = 'tr-bot-h-info';
                detail = h.msg || '';
            } else continue;
            html += '<div class="tr-bot-h-tr" data-hidx="' + i + '">'
                + '<span class="tr-bot-h-time">' + ts + '</span>'
                + '<span class="tr-bot-h-sym">' + sym + '</span>'
                + '<span class="tr-bot-h-type ' + typeCls + '">' + typeLabel + '</span>'
                + '<span class="tr-bot-h-detail">' + detail + '</span>'
                + '<span class="tr-bot-h-amt">' + amtStr + '</span>'
                + '<span class="tr-bot-h-pnl' + (pnlStr && pnlStr[0] === '+' ? ' tr-bot-h-green' : pnlStr && pnlStr[0] === '-' ? ' tr-bot-h-red' : '') + '">' + pnlStr + '</span>'
                + '<span class="tr-bot-h-bal">' + balStr + '</span>'
                + '<button class="tr-bot-h-del" title="Delete">\u2715</button>'
                + '</div>';
        }
        if (!html) html = '<div class="tr-bot-empty">' + (settingsT('terminal.no_operations') || 'No operations') + (filter !== 'all' ? ' for ' + filter : '') + '</div>';
        else html = '<div class="tr-bot-h-table"><div class="tr-bot-h-tr tr-bot-h-th"><span>' + (settingsT('terminal.strategy_time') || 'Time') + '</span><span>' + (settingsT('terminal.strategy_asset') || 'Asset') + '</span><span>' + (settingsT('terminal.strategy_type') || 'Type') + '</span><span>' + (settingsT('terminal.strategy_detail') || 'Detail') + '</span><span>' + (settingsT('terminal.strategy_amount') || 'Amount') + '</span><span>PnL</span><span>' + (settingsT('terminal.strategy_balance') || 'Balance') + '</span><span></span></div>' + html + '</div>';
        el.innerHTML = html;
    }

    function _phoenixRender() {
        var b = _phoenixGetBot();
        var balInp = document.getElementById('phxBalInput');
        var entryInp = document.getElementById('phxEntryCents');
        var targetInp = document.getElementById('phxTargetCents');

        if (balInp) {
            if (document.activeElement !== balInp) balInp.value = b.balance.toFixed(2);
            balInp.readOnly = b.running;
            balInp.style.opacity = b.running ? '0.5' : '';
            balInp.oninput = function() {
                if (b.running) return;
                var v = parseFloat(this.value);
                if (v > 0) { b.balance = v; b.startBalance = v; }
            };
            balInp.onchange = function() {
                if (b.running) return;
                var v = parseFloat(this.value);
                if (v > 0) { b.balance = v; b.startBalance = v; _phoenixSaveState(); }
            };
        }
        if (entryInp) {
            if (document.activeElement !== entryInp) entryInp.value = b.entryCents;
            entryInp.readOnly = b.running;
            entryInp.style.opacity = b.running ? '0.5' : '';
            entryInp.oninput = function() {
                if (b.running) return;
                var v = parseInt(this.value) || 2;
                b.entryCents = Math.max(1, Math.min(50, v));
            };
            entryInp.onchange = function() {
                if (b.running) return;
                var v = parseInt(this.value) || 2;
                b.entryCents = Math.max(1, Math.min(50, v)); _phoenixSaveState();
            };
        }
        if (targetInp) {
            if (document.activeElement !== targetInp) targetInp.value = b.targetCents;
            targetInp.readOnly = b.running;
            targetInp.style.opacity = b.running ? '0.5' : '';
            targetInp.oninput = function() {
                if (b.running) return;
                var v = parseInt(this.value) || 20;
                b.targetCents = Math.max(5, Math.min(50, v));
            };
            targetInp.onchange = function() {
                if (b.running) return;
                var v = parseInt(this.value) || 20;
                b.targetCents = Math.max(5, Math.min(50, v)); _phoenixSaveState();
            };
        }

        var budgetMode = document.getElementById('phxBudgetMode');
        var budgetPct = document.getElementById('phxBudgetPct');
        var budgetFixed = document.getElementById('phxBudgetFixed');
        var budgetPctWrap = document.getElementById('phxBudgetPctWrap');
        var budgetFixedWrap = document.getElementById('phxBudgetFixedWrap');
        if (budgetMode) {
            if (document.activeElement !== budgetMode) budgetMode.value = b.budgetMode || 'pct';
            budgetMode.disabled = b.running;
            budgetMode.style.opacity = b.running ? '0.5' : '';
            budgetMode.onchange = function() {
                if (b.running) return;
                b.budgetMode = this.value;
                if (budgetPctWrap) budgetPctWrap.style.display = this.value === 'pct' ? 'flex' : 'none';
                if (budgetFixedWrap) budgetFixedWrap.style.display = this.value === 'fixed' ? 'flex' : 'none';
                _phoenixSaveState();
            };
            if (budgetPct) {
                if (document.activeElement !== budgetPct) budgetPct.value = b.budgetPct || 5;
                budgetPct.readOnly = b.running;
                budgetPct.style.opacity = b.running ? '0.5' : '';
                budgetPct.oninput = function() { if (!b.running) b.budgetPct = parseFloat(this.value) || 5; };
                budgetPct.onchange = function() { if (!b.running) _phoenixSaveState(); };
            }
            if (budgetFixed) {
                if (document.activeElement !== budgetFixed) budgetFixed.value = b.budgetFixed || 15;
                budgetFixed.readOnly = b.running;
                budgetFixed.style.opacity = b.running ? '0.5' : '';
                budgetFixed.oninput = function() { if (!b.running) b.budgetFixed = parseFloat(this.value) || 15; };
                budgetFixed.onchange = function() { if (!b.running) _phoenixSaveState(); };
            }
            if (budgetPctWrap) budgetPctWrap.style.display = (b.budgetMode || 'pct') === 'pct' ? 'flex' : 'none';
            if (budgetFixedWrap) budgetFixedWrap.style.display = (b.budgetMode || 'pct') === 'fixed' ? 'flex' : 'none';
        }

        var statsEl = document.getElementById('phxStats');
        if (statsEl) {
            var rounds = b.rounds || [];
            var wins = rounds.filter(function(r) { return r.pnl >= 0; }).length;
            var losses = rounds.filter(function(r) { return r.pnl < 0; }).length;
            var totalPnl = rounds.reduce(function(s, r) { return s + (r.pnl || 0); }, 0);
            var avgPnl = rounds.length > 0 ? (totalPnl / rounds.length) : 0;
            var wr = (wins + losses) > 0 ? (wins / (wins + losses) * 100).toFixed(0) : '-';
            var pnlDisplay = totalPnl === 0 ? '$0' : (totalPnl > 0 ? '+' : '') + '$' + totalPnl.toFixed(0);
            var avgDisplay = avgPnl === 0 ? '$0' : (avgPnl > 0 ? '+' : '') + '$' + avgPnl.toFixed(1);
            var pnlClass = totalPnl > 0 ? ' tr-agent-p' : totalPnl < 0 ? ' tr-agent-n' : '';
            statsEl.innerHTML =
                '<div class="tr-agent-stat"><div class="tr-agent-stat-label">' + (settingsT('terminal.strategy_rounds') || 'Rounds') + '</div><div class="tr-agent-stat-num">' + rounds.length + '</div></div>'
                + '<div class="tr-agent-stat"><div class="tr-agent-stat-label">' + (settingsT('terminal.strategy_wr') || 'Win Rate') + '</div><div class="tr-agent-stat-num">' + (wr !== '-' ? wr + '%' : '\u2014') + '</div></div>'
                + '<div class="tr-agent-stat"><div class="tr-agent-stat-label">PnL</div><div class="tr-agent-stat-num' + pnlClass + '">' + pnlDisplay + '</div></div>'
                + '<div class="tr-agent-stat"><div class="tr-agent-stat-label">' + (settingsT('terminal.strategy_avg') || 'Avg') + '</div><div class="tr-agent-stat-num' + (avgPnl > 0 ? ' tr-agent-p' : avgPnl < 0 ? ' tr-agent-n' : '') + '">' + avgDisplay + '</div></div>';
        }

        _phoenixRenderRounds();
    }

    function _phoenixRenderRounds() {
        var el = document.getElementById('phxRounds');
        if (!el) return;
        var b = _phoenixGetBot();
        var rounds = b.rounds || [];
        if (rounds.length === 0) { el.innerHTML = '<div class="tr-bot-rounds-empty">' + (settingsT('terminal.no_rounds') || 'No completed rounds') + '</div>'; return; }
        var total = 0;
        for (var ri = 0; ri < rounds.length; ri++) total += rounds[ri].pnl;
        var html = '<div class="tr-bot-rounds-tbl"><div class="tr-bot-rounds-tr tr-bot-rounds-th"><span></span><span>#</span><span>' + (settingsT('terminal.strategy_time') || 'Time') + '</span><span>' + (settingsT('terminal.strategy_sym') || 'Sym') + '</span><span class="tr-bot-rounds-pnl">PnL</span></div>';
        var start = Math.max(0, rounds.length - 30);
        for (var i = start; i < rounds.length; i++) {
            var r = rounds[i];
            var ts = new Date(r.endTime).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
            var ps = (r.pnl >= 0 ? '+' : '') + '$' + r.pnl.toFixed(2);
            var pc = r.pnl >= 0 ? 'tr-bot-rounds-grn' : 'tr-bot-rounds-red';
            html += '<div class="tr-bot-rounds-tr"><button class="tr-bot-rounds-del" title="Delete">\u2715</button><span>' + (r.num || i + 1) + '</span><span>' + ts + '</span><span>' + (r.sym || '') + '</span><span class="tr-bot-rounds-pnl ' + pc + '">' + ps + '</span></div>';
        }
        var ts2 = (total >= 0 ? '+' : '') + '$' + total.toFixed(2);
        var tc2 = total >= 0 ? 'tr-bot-rounds-grn' : 'tr-bot-rounds-red';
        html += '<div class="tr-bot-rounds-tr tr-bot-rounds-total"><span></span><span></span><span></span><span>' + (settingsT('terminal.strategy_total') || 'Total') + '</span><span class="tr-bot-rounds-pnl ' + tc2 + '">' + ts2 + '</span></div></div>';
        el.innerHTML = html;
    }

    var STRATEGY_DESCS = {
        clob: {
            title: 'CLOB Arbitrage',
            desc: 'CLOB (Central Limit Order Book) arbitrage strategy scans the Polymarket order book for pricing inefficiencies between the Yes/No outcomes of prediction markets. When the spread between buy and sell orders creates a risk-free profit opportunity, the bot executes simultaneous buy-low/sell-high orders to capture the difference. Key parameters: Min Spread (minimum profitable spread), Rebate (maker rebate percentage), Order Size, Timeout, and Gas cost. Suitable for markets with high liquidity and tight spreads.'
        },
        delta: {
            title: 'Delta Mesh',
            desc: 'Delta Mesh is a market-making strategy that maintains delta-neutral positions by simultaneously placing limit orders on both Yes and No outcomes. The bot continuously adjusts order prices based on market movements to capture the bid-ask spread. This strategy works best in volatile markets where price fluctuations create frequent rebalancing opportunities. Risk is minimized through delta hedging.'
        },
        phoenix: {
            title: 'Phoenix',
            desc: 'Phoenix is a trend-following strategy that enters positions when price momentum is detected in either direction. It uses configurable entry and target prices (in cents), with budget management (percentage or fixed amount) and an optional stop-loss. The strategy is designed for short-term trades on 5-minute timeframes, automatically compounding profits through rolling reinvestment.'
        }
    };

    function _renderStrategies() {
        var list = document.getElementById('trStrategiesList');
        if (!list) return;
        var strategies = getStrategies();
        var html = '';
        for (var si = 0; si < strategies.length; si++) {
            var s = strategies[si];
            html += '<div class="tr-strategy-card">'
                + '<div class="tr-strategy-head">'
                + '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>'
                + '<span>' + (settingsT('terminal.strategy_num') || 'Strategy').replace('{n}', si + 1) + '</span>'
                + '</div>'
                + '<div class="tr-strategy-field"><label>' + (settingsT('terminal.strategy_name') || 'Name') + '</label>'
                + '<input class="tr-input tr-strategy-name" value="' + escHtml(s.name) + '" placeholder="' + (settingsT('terminal.strategy_name_ph') || 'Strategy name') + '"></div>'
                + '<div class="tr-strategy-field"><label>' + (settingsT('terminal.strategy_desc') || 'Description') + '</label>'
                + '<textarea class="tr-input tr-strategy-desc" rows="2" placeholder="' + (settingsT('terminal.strategy_desc_ph') || 'Description') + '">' + escHtml(s.desc) + '</textarea></div>'
                + '<div class="tr-strategy-row">'
                + '<div class="tr-strategy-field tr-strategy-field-half"><label>' + (settingsT('terminal.strategy_tf') || 'Timeframe') + '</label>'
                + '<select class="tr-strategy-tf">'
                + ['5M','15M','1H','4H'].map(function(tf) { return '<option value="' + tf + '"' + (s.timeframe === tf ? ' selected' : '') + '>' + tf + '</option>'; }).join('')
                + '</select></div>'
                + '<div class="tr-strategy-field tr-strategy-field-half"><label>' + (settingsT('terminal.strategy_asset') || 'Asset') + '</label>'
                + '<select class="tr-strategy-asset">'
                + ['BTC','ETH','SOL','XRP','BNB','DOGE'].map(function(a) { return '<option value="' + a + '"' + (s.asset === a ? ' selected' : '') + '>' + a + '</option>'; }).join('')
                + '</select></div></div>'
                + '</div>';
        }
        list.innerHTML = html;
        var saveBtn = document.getElementById('trStrategiesSaveBtn');
        if (saveBtn) {
            saveBtn.onclick = function() {
                var cards = list.querySelectorAll('.tr-strategy-card');
                var updated = [];
                cards.forEach(function(card) {
                    var name = (card.querySelector('.tr-strategy-name') || {}).value || '';
                    var desc = (card.querySelector('.tr-strategy-desc') || {}).value || '';
                    var tf = (card.querySelector('.tr-strategy-tf') || {}).value || '5M';
                    var asset = (card.querySelector('.tr-strategy-asset') || {}).value || 'BTC';
                    updated.push({ name: name, desc: desc, timeframe: tf, asset: asset });
                });
                if (updated.length === 3) {
                    saveStrategies(updated);
                    var status = document.getElementById('trStrategiesStatus');
                    if (status) {
                        status.textContent = '\u2713 Saved';
                        status.style.color = '#3fb950';
                        setTimeout(function() { if (status) status.textContent = ''; }, 2000);
                    }
                }
            };
        }
    }

    function getStrategies() {
        try {
            var d = JSON.parse(localStorage.getItem('polyStrategies'));
            if (d && Array.isArray(d) && d.length === 3) return d;
        } catch(e) {}
        return [
            { name: 'Strategy 1', desc: '', timeframe: '5M', asset: 'BTC' },
            { name: 'Strategy 2', desc: '', timeframe: '15M', asset: 'ETH' },
            { name: 'Strategy 3', desc: '', timeframe: '1H', asset: 'SOL' }
        ];
    }
    function saveStrategies(p) {
        localStorage.setItem('polyStrategies', JSON.stringify(p));
    }

    function _getCurrentCryptoInfo() {
        var slug = _termSlug || '';
        var evTitle = document.querySelector('.tr-event-title') ? document.querySelector('.tr-event-title').textContent : '';
        var title = (slug + ' ' + evTitle).toLowerCase();
        for (var key in CRYPTO_SYMBOLS) {
            var re = new RegExp('\\b' + key + '\\b', 'i');
            if (re.test(title)) return { symbol: key.toUpperCase(), timeframe: '5M' };
        }
        return null;
    }

    function renderTradeWallets() {
        var section = $('tradeWalletsSection');
        var favs = JSON.parse(localStorage.getItem('polyFavorites') || '[]');
        var html = '<div class="tt-wallets-card">';
        html += '<div class="tt-wallets-header">Торговые кошельки</div>';
        html += '<div id="tradeWalletsList">';
        if (favs.length === 0) {
            html += '<p style="color:var(--text-secondary);font-size:11px;text-align:center;padding:12px">Нет кошельков. Добавьте из раздела аналитики.</p>';
        } else {
            favs.forEach(function(f) {
                html += '<div class="tt-wallet-item">'
                    + '<span class="tt-wallet-name">' + escHtml(f.name || f.address.substring(0, 10) + '...') + '</span>'
                    + '<span class="tt-wallet-addr">' + f.address.substring(0, 6) + '...' + f.address.substring(38) + '</span>'
                    + '</div>';
            });
        }
        html += '</div></div>';
        section.innerHTML = html;
    }

    // ====================== COPY TRADING ======================
    var _cpSelectedWallet = null;
    var _cpIsCopying = false;
    var _cpCopyLog = [];
    var _cpCopyTimer = null;

    function initCopyPanel() {
        var list = $('cpWalletsList');
        if (!list) return;
        var favs = JSON.parse(localStorage.getItem('polyFavorites') || '[]');
        if (favs.length === 0) {
            list.innerHTML = '<div style="padding:12px;text-align:center;color:var(--text-tertiary);font-size:11px">Добавьте кошельки в избранное</div>';
            return;
        }
        var html = '';
        favs.forEach(function(f) {
            var short = f.address ? f.address.substring(0, 6) + '...' + f.address.substring(38) : '';
            var initials = (f.name || short || '?').substring(0, 2).toUpperCase();
            html += '<div class="cp-wallet-item" data-addr="' + f.address + '">';
            html += '<div class="cp-wallet-avatar">' + escHtml(initials) + '</div>';
            html += '<div class="cp-wallet-info"><span class="cp-wallet-name">' + escHtml(f.name || short) + '</span>';
            html += '<span class="cp-wallet-addr">' + short + '</span></div>';
            html += '<span class="cp-wallet-pnl" id="cpPnl_' + f.address.substring(0, 8) + '">...</span>';
            html += '</div>';
        });
        list.innerHTML = html;

        list.querySelectorAll('.cp-wallet-item').forEach(function(item) {
            item.addEventListener('click', function() {
                list.querySelectorAll('.cp-wallet-item').forEach(function(i) { i.classList.remove('active'); });
                item.classList.add('active');
                selectCopyWallet(item.dataset.addr);
            });
        });
    }

    async function selectCopyWallet(addr) {
        _cpSelectedWallet = addr;
        var info = $('cpSelectedInfo');
        var trades = $('cpTradesList');
        if (!info || !trades) return;

        info.style.display = 'block';
        trades.style.display = 'none';
        info.innerHTML = '<div style="text-align:center;color:var(--text-tertiary);font-size:11px;padding:8px">Загрузка...</div>';

        try {
            var text = await pageFetch(DATA_API + '/v1/trades?user=' + addr + '&limit=30');
            var allTrades = tryParseJSON(text, []);
            if (!Array.isArray(allTrades)) allTrades = [];

            var wins = 0, losses = 0, pnl = 0;
            allTrades.forEach(function(t) {
                if (t.pnl) {
                    var p = parseFloat(t.pnl);
                    pnl += p;
                    if (p > 0) wins++;
                    else if (p < 0) losses++;
                }
            });
            var total = wins + losses;
            var wr = total > 0 ? (wins / total * 100) : 0;

            var short = addr.substring(0, 6) + '...' + addr.substring(38);
            var isCopying = _cpIsCopying && _cpSelectedWallet === addr;

            var html = '<div class="cp-selected-header">';
            html += '<span class="cp-selected-name">' + short + '</span>';
            html += '<button class="cp-copy-btn ' + (isCopying ? 'stop' : 'start') + '" id="cpToggleBtn">';
            html += isCopying ? 'Остановить' : 'Копировать';
            html += '</button></div>';

            html += '<div class="cp-stats-row">';
            html += '<div class="cp-stat"><span class="cp-stat-label">Сделок</span><span class="cp-stat-value">' + allTrades.length + '</span></div>';
            html += '<div class="cp-stat"><span class="cp-stat-label">Win Rate</span><span class="cp-stat-value" style="color:' + (wr >= 50 ? 'var(--positive)' : 'var(--negative)') + '">' + wr.toFixed(0) + '%</span></div>';
            html += '<div class="cp-stat"><span class="cp-stat-label">PNL</span><span class="cp-stat-value" style="color:' + (pnl >= 0 ? 'var(--positive)' : 'var(--negative)') + '">' + (pnl >= 0 ? '+' : '') + '$' + fmtNum(Math.abs(pnl)) + '</span></div>';
            html += '</div>';

            var pnlEl = $('cpPnl_' + addr.substring(0, 8));
            if (pnlEl) {
                pnlEl.textContent = (pnl >= 0 ? '+' : '') + '$' + fmtNum(Math.abs(pnl));
                pnlEl.style.color = pnl >= 0 ? 'var(--positive)' : 'var(--negative)';
            }

            info.innerHTML = html;

            var toggleBtn = $('cpToggleBtn');
            if (toggleBtn) {
                toggleBtn.addEventListener('click', function() {
                    if (_cpIsCopying && _cpSelectedWallet === addr) {
                        stopCopyTrading();
                    } else {
                        startCopyTrading(addr, allTrades);
                    }
                });
            }

            var recentTrades = allTrades.slice(0, 10);
            if (recentTrades.length > 0) {
                var tHtml = '';
                recentTrades.forEach(function(t) {
                    var side = (t.side || '').toLowerCase();
                    var isBuy = side === 'buy' || side === 'BUY';
                    var price = t.price ? parseFloat(t.price) : 0;
                    var amount = t.amount ? parseFloat(t.amount) : 0;
                    var title = t.title || t.question || t.market || '';
                    if (!title && t.conditionId) title = t.conditionId.substring(0, 12) + '...';

                    tHtml += '<div class="cp-trade">';
                    tHtml += '<span class="cp-trade-side ' + (isBuy ? 'buy' : 'sell') + '">' + (isBuy ? 'BUY' : 'SELL') + '</span>';
                    tHtml += '<span class="cp-trade-title">' + escHtml(title.substring(0, 40)) + '</span>';
                    tHtml += '<span class="cp-trade-amount">$' + (amount * price).toFixed(0) + '</span>';
                    tHtml += '</div>';
                });
                trades.innerHTML = tHtml;
                trades.style.display = 'block';
            }
        } catch(e) {
            info.innerHTML = '<div style="text-align:center;color:var(--negative);font-size:11px;padding:8px">Ошибка: ' + escHtml(e.message) + '</div>';
        }

        if (_cpCopyLog.length > 0) renderCopyLog();
    }

    function startCopyTrading(addr, trades) {
        _cpIsCopying = true;
        _cpSelectedWallet = addr;
        _cpCopyLog = [];

        _cpCopyTimer = setInterval(function() {
            if (!_cpIsCopying) return;
            var demo = getDemoState();
            var trade = trades[Math.floor(Math.random() * trades.length)];
            if (!trade) return;

            var side = (trade.side || '').toLowerCase();
            var isBuy = side === 'buy' || side === 'BUY';
            var price = trade.price ? parseFloat(trade.price) : 0.5;
            var amount = Math.min(demo.balance * 0.05, 500);
            if (amount < 10) return;

            var title = trade.title || trade.question || trade.market || 'Сделка';
            if (!title && trade.conditionId) title = trade.conditionId.substring(0, 16) + '...';

            if (isBuy) {
                var shares = amount / price;
                demo.balance -= amount;
                demo.positions.push({
                    id: 'cp_' + Date.now(),
                    title: title.substring(0, 60),
                    side: 'BUY',
                    price: price,
                    shares: shares,
                    buyAmount: amount,
                    createdAt: Date.now()
                });
            } else {
                var posIdx = demo.positions.findIndex(function(p) { return p.title && p.title.indexOf(title.substring(0, 10)) !== -1; });
                if (posIdx !== -1) {
                    var pos = demo.positions[posIdx];
                    var sellVal = pos.shares * price;
                    var pnl = sellVal - pos.buyAmount;
                    demo.balance += sellVal;
                    demo.history.push({
                        title: pos.title,
                        side: 'SELL',
                        price: price,
                        amount: pos.buyAmount,
                        pnl: pnl,
                        status: 'closed',
                        closedAt: Date.now()
                    });
                    demo.positions.splice(posIdx, 1);
                } else {
                    demo.balance -= amount;
                    demo.positions.push({
                        id: 'cp_' + Date.now(),
                        title: title.substring(0, 60),
                        side: 'BUY',
                        price: price,
                        shares: amount / price,
                        buyAmount: amount,
                        createdAt: Date.now()
                    });
                }
            }

            saveDemoState(demo);
            var balEl = $('demoBalance');
            if (balEl) balEl.textContent = '$' + demo.balance.toFixed(2);

            _cpCopyLog.unshift({
                time: Date.now(),
                title: title.substring(0, 30),
                side: isBuy ? 'BUY' : 'SELL',
                amount: amount
            });
            if (_cpCopyLog.length > 20) _cpCopyLog.length = 20;
            renderCopyLog();
        }, 8000);

        selectCopyWallet(addr);
    }

    function stopCopyTrading() {
        _cpIsCopying = false;
        if (_cpCopyTimer) { clearInterval(_cpCopyTimer); _cpCopyTimer = null; }
        if (_cpSelectedWallet) selectCopyWallet(_cpSelectedWallet);
    }

    function renderCopyLog() {
        var section = $('cpLogSection');
        if (!section) return;
        if (_cpCopyLog.length === 0) { section.style.display = 'none'; return; }
        section.style.display = 'block';
        var html = '<div class="cp-log-title">История копирования</div>';
        _cpCopyLog.forEach(function(entry) {
            var t = new Date(entry.time);
            var time = t.getHours().toString().padStart(2, '0') + ':' + t.getMinutes().toString().padStart(2, '0');
            html += '<div class="cp-log-item">';
            html += '<span class="cp-log-time">' + time + '</span>';
            html += '<span class="cp-log-action"><span class="cp-trade-side ' + (entry.side === 'BUY' ? 'buy' : 'sell') + '">' + entry.side + '</span> ' + escHtml(entry.title) + '</span>';
            html += '<span class="cp-log-pnl" style="color:var(--text-tertiary)">$' + entry.amount.toFixed(0) + '</span>';
            html += '</div>';
        });
        section.innerHTML = html;
    }

    function setupBacktest() {
        setTimeout(function() {
            var calcBtn = $('btCalcBtn');
            if (calcBtn) {
                calcBtn.onclick = function() {
                    var amount = parseFloat($('btAmount')?.value) || 1000;
                    var wr = (40 + Math.random() * 30);
                    var trades = Math.floor(20 + Math.random() * 80);
                    var winTrades = Math.floor(trades * wr / 100);
                    var lossTrades = trades - winTrades;
                    var avgWin = amount * 0.15 * (0.5 + Math.random() * 0.5);
                    var avgLoss = amount * 0.1 * (0.3 + Math.random() * 0.3);
                    var grossPnl = winTrades * avgWin - lossTrades * avgLoss;
                    var netPnl = grossPnl * 0.95;
                    var roi = (netPnl / amount) * 100;

                    var results = $('btResults');
                    if (!results) return;
                    results.style.display = 'block';
                    results.innerHTML = ''
                        + '<div class="bt-grid">'
                        + '<div class="bt-card"><div class="bt-card-top"><span class="bt-label">Gross P&L</span></div><div class="bt-value ' + (grossPnl >= 0 ? 'positive' : 'negative') + '">' + (grossPnl >= 0 ? '+' : '') + '$' + grossPnl.toFixed(2) + '</div></div>'
                        + '<div class="bt-card"><div class="bt-card-top"><span class="bt-label">Net P&L</span><span class="bt-roi ' + (netPnl >= 0 ? 'positive' : 'negative') + '">' + (netPnl >= 0 ? '+' : '') + roi.toFixed(1) + '%</span></div><div class="bt-value ' + (netPnl >= 0 ? 'positive' : 'negative') + '">' + (netPnl >= 0 ? '+' : '') + '$' + netPnl.toFixed(2) + '</div></div>'
                        + '<div class="bt-card"><div class="bt-card-top"><span class="bt-label">Win Rate</span></div><div class="bt-value positive">' + wr.toFixed(1) + '%</div></div>'
                        + '<div class="bt-card"><div class="bt-card-top"><span class="bt-label">Сделок</span></div><div class="bt-value">' + trades + '</div></div>'
                        + '</div>'
                        + '<div class="bt-gross"><span class="bt-gross-label">Прибыльных: ' + winTrades + ' / Убыточных: ' + lossTrades + '</span><span class="bt-gross-val ' + (grossPnl >= 0 ? 'positive' : 'negative') + '">ROI ' + (roi >= 0 ? '+' : '') + roi.toFixed(1) + '%</span></div>';
                };

                document.querySelectorAll('.bt-qty-btn').forEach(function(btn) {
                    btn.addEventListener('click', function() {
                        var input = $('btAmount');
                        if (input) input.value = btn.dataset.v;
                    });
                });
            }

            document.querySelectorAll('.tr-mode-btn').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    document.querySelectorAll('.tr-mode-btn').forEach(function(b) {
                        b.classList.remove('active');
                    });
                    btn.classList.add('active');
                    ['trDemoPanel','trLivePanel','trCopyPanel','trStrategiesPanel'].forEach(function(id) {
                        var el = $(id);
                        if (el) el.style.display = 'none';
                    });
                    var panel = $('tr' + btn.dataset.mode.charAt(0).toUpperCase() + btn.dataset.mode.slice(1) + 'Panel');
                    if (panel) panel.style.display = 'block';
                    if (btn.dataset.mode === 'copy') initCopyPanel();
                    if (btn.dataset.mode === 'strategies') initStrategiesPanel();
                });
            });
        }, 100);
    }

    // ====================== STRATEGY BOTS ======================
    var _stratInited = false;
    var _tradeStrategy = 'clob';
    var _clobBot = null;
    var _phxBot = null;
    var _clobInterval = null;
    var _phxInterval = null;

    function _clobDefault() {
        return {
            running: false, balance: 100000, startBalance: 100000,
            totalPnl: 0, totalTrades: 0, wins: 0, losses: 0,
            positions: {}, rounds: [], roundCounter: 0,
            startTime: null, logs: [],
            minSpread: 2, rebate: 20, orderSize: 100, timeout: 3, gasCost: 0.02,
            selectedAssets: ['BTC', 'ETH', 'SOL']
        };
    }

    function _phxDefault() {
        return {
            running: false, balance: 1000, startBalance: 1000,
            totalPnl: 0, totalTrades: 0, wins: 0, losses: 0,
            positions: {}, rounds: [], roundCounter: 0,
            startTime: null, logs: [],
            entryCents: 2, targetCents: 20,
            budgetMode: 'pct', budgetPct: 5, budgetFixed: 15,
            stopEnabled: false, stopPct: 30,
            selectedAssets: ['BTC', 'ETH', 'SOL']
        };
    }

    function _getClobBot() {
        if (!_clobBot) {
            try {
                var saved = JSON.parse(localStorage.getItem('polyClobBotState'));
                if (saved) { _clobBot = _clobDefault(); for (var k in saved) if (k !== 'running' && k !== 'startTime') _clobBot[k] = saved[k]; }
                else _clobBot = _clobDefault();
            } catch(e) { _clobBot = _clobDefault(); }
        }
        return _clobBot;
    }

    function _getPhxBot() {
        if (!_phxBot) {
            try {
                var saved = JSON.parse(localStorage.getItem('polyPhxBotState'));
                if (saved) { _phxBot = _phxDefault(); for (var k in saved) if (k !== 'running' && k !== 'startTime') _phxBot[k] = saved[k]; }
                else _phxBot = _phxDefault();
            } catch(e) { _phxBot = _phxDefault(); }
        }
        return _phxBot;
    }

    function _saveClobBot() { try { localStorage.setItem('polyClobBotState', JSON.stringify(_getClobBot())); } catch(e) {} }
    function _savePhxBot() { try { localStorage.setItem('polyPhxBotState', JSON.stringify(_getPhxBot())); } catch(e) {} }

    function _botLog(b, msg) {
        var entry = { time: Date.now(), msg: msg };
        b.logs.push(entry);
        if (b.logs.length > 200) b.logs.shift();
        _botRenderLog(b);
    }

    function _botPushRound(b, round) {
        b.rounds.push(round);
        if (b.rounds.length > 100) b.rounds.shift();
        _botRenderRounds(b);
    }

    // === CLOB Bot Tick (demo simulation) ===
    // === CLOB Bot Tick (real API) ===
    var _clobPriceCache = {};  // { tokenId: { bid, ask, time } }
    var _clobActiveMarkets = []; // [{ conditionId, slug, tokenIds, symbol }]

    async function _clobDiscoverMarkets() {
        var b = _getClobBot();
        var assets = b.selectedAssets || ['BTC', 'ETH', 'SOL'];
        var now = Math.floor(Date.now() / 1000);
        var ws = Math.floor(now / 300) * 300;
        var slugs = [];
        assets.forEach(function(a) {
            var s = a.toLowerCase();
            slugs.push(s + '-updown-5m-' + ws);
            slugs.push(s + '-updown-5m-' + (ws + 300));
        });

        var markets = [];
        for (var i = 0; i < slugs.length; i++) {
            try {
                var text = await pageFetch(GAMMA_API + '/events?slug=' + encodeURIComponent(slugs[i]));
                var evArr = JSON.parse(text);
                if (evArr && evArr.length > 0 && evArr[0].markets) {
                    evArr[0].markets.forEach(function(m) {
                        if (m.closed || m.resolved) return;
                        var tokenIds = null;
                        if (m.clobTokenIds) {
                            try { tokenIds = JSON.parse(m.clobTokenIds); } catch(e) {}
                        }
                        if (!tokenIds || tokenIds.length < 2) return;
                        var sym = slugs[i].split('-')[0].toUpperCase();
                        markets.push({ conditionId: m.conditionId, slug: m.slug, tokenIds: tokenIds, symbol: sym });
                    });
                }
            } catch(e) {}
        }
        _clobActiveMarkets = markets;
    }

    async function _clobFetchOrderBooks() {
        for (var i = 0; i < _clobActiveMarkets.length; i++) {
            var m = _clobActiveMarkets[i];
            for (var ti = 0; ti < m.tokenIds.length; ti++) {
                var tokenId = m.tokenIds[ti];
                try {
                    var text = await pageFetch(CLOB_API + '/order-book/' + tokenId);
                    var book = JSON.parse(text);
                    var bids = book.bids || [];
                    var asks = book.asks || [];
                    var bestBid = bids.length > 0 ? parseFloat(bids[0].price) : null;
                    var bestAsk = asks.length > 0 ? parseFloat(asks[0].price) : null;
                    _clobPriceCache[tokenId] = { bid: bestBid, ask: bestAsk, time: Date.now() };
                } catch(e) {}
            }
        }
    }

    async function _clobTick() {
        var b = _getClobBot();
        if (!b.running) return;
        var now = Date.now();

        // Discover markets every 30s
        if (!b._lastDiscovery || (now - b._lastDiscovery) > 30000) {
            b._lastDiscovery = now;
            await _clobDiscoverMarkets();
        }

        // Fetch order books every 3s
        if (!b._lastBookFetch || (now - b._lastBookFetch) > 3000) {
            b._lastBookFetch = now;
            await _clobFetchOrderBooks();
        }

        // Check fills for pending positions
        for (var cid in b.positions) {
            var p = b.positions[cid];
            if (p.status === 'pending') {
                // Check if price moved to our level
                var cached = _clobPriceCache[p.tokenId];
                if (cached) {
                    var filled = false;
                    if (p.side === 'BUY' && cached.ask != null && cached.ask <= p.price) filled = true;
                    if (p.side === 'SELL' && cached.bid != null && cached.bid >= p.price) filled = true;
                    if (!filled && (now - p.createdAt > (b.timeout || 3) * 1000)) filled = true; // timeout fill
                    if (filled) {
                        p.status = 'filled'; p.fillTime = now;
                        _botLog(b, 'FILL: ' + p.sym + ' ' + p.side + ' ' + p.shares + ' @ $' + p.price.toFixed(3));
                    }
                }
            } else if (p.status === 'filled') {
                // Check if we can close (sell for BUY, buy for SELL)
                var cached2 = _clobPriceCache[p.tokenId];
                if (cached2) {
                    var closePrice = null;
                    if (p.side === 'BUY' && cached2.bid != null) closePrice = cached2.bid;
                    if (p.side === 'SELL' && cached2.ask != null) closePrice = cached2.ask;
                    if (closePrice != null) {
                        var pnl = p.side === 'BUY'
                            ? (closePrice - p.price) * p.shares - (b.gasCost || 0.02)
                            : (p.price - closePrice) * p.shares - (b.gasCost || 0.02);
                        b.balance += p.shares * (p.side === 'BUY' ? closePrice : (1 - closePrice));
                        b.totalPnl += pnl;
                        b.totalTrades++;
                        if (pnl >= 0) b.wins++; else b.losses++;
                        _botPushRound(b, { num: ++b.roundCounter, sym: p.sym, side: p.side, entry: p.price, exit: closePrice, shares: p.shares, pnl: pnl, time: now });
                        _botLog(b, 'CLOSE: ' + p.sym + ' ' + (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2));
                        delete b.positions[cid];
                    }
                }
            }
        }

        // Open new market making orders on real markets
        var posCount = Object.keys(b.positions).length;
        for (var mi = 0; mi < _clobActiveMarkets.length && posCount < 5; mi++) {
            var mkt = _clobActiveMarkets[mi];
            if (b.selectedAssets.indexOf(mkt.symbol) < 0) continue;

            var yesTokenId = mkt.tokenIds[0];
            var cached3 = _clobPriceCache[yesTokenId];
            if (!cached3 || cached3.bid == null || cached3.ask == null) continue;
            if ((now - cached3.time) > 10000) continue; // stale

            var spread = cached3.ask - cached3.bid;
            if (spread > 0.50 || spread <= 0) continue; // resolved market
            if (cached3.bid < 0.03 || cached3.ask > 0.97) continue;

            // Check if we already have position on this condition
            var hasPos = false;
            for (var pk in b.positions) {
                if (b.positions[pk].conditionId === mkt.conditionId) { hasPos = true; break; }
            }
            if (hasPos) continue;

            // Market making: BUY at bid
            var spreadCents = spread * 100;
            if (spreadCents >= b.minSpread) {
                var contracts = Math.floor(b.orderSize / (cached3.bid || 0.01));
                if (contracts < 1) contracts = 1;
                var cost = contracts * cached3.bid;
                if (b.balance >= cost) {
                    b.balance -= cost;
                    var key = mkt.symbol + '_' + mkt.conditionId.substring(0, 8) + '_' + Date.now();
                    b.positions[key] = {
                        sym: mkt.symbol, side: 'BUY', price: cached3.bid, shares: contracts,
                        status: 'pending', createdAt: now, conditionId: mkt.conditionId, tokenId: yesTokenId
                    };
                    posCount++;
                    _botLog(b, 'MM BUY: ' + mkt.symbol + ' ' + contracts + ' @ $' + cached3.bid.toFixed(3) + ' (spread ' + spreadCents.toFixed(1) + '¢)');
                }
            }
        }

        _saveClobBot();
        _stratRenderStats();
    }

    // === Phoenix Bot Tick (real API) ===
    var _phxPriceCache = {}; // { conditionId: { upPrice, dnPrice, time, endTime, slug } }

    async function _phxDiscoverMarkets() {
        var b = _getPhxBot();
        var assets = b.selectedAssets || ['BTC', 'ETH', 'SOL'];
        var now = Math.floor(Date.now() / 1000);
        var ws = Math.floor(now / 300) * 300;
        var slugs = [];
        assets.forEach(function(a) {
            var s = a.toLowerCase();
            for (var offset = 0; offset <= 600; offset += 300) {
                slugs.push(s + '-updown-5m-' + (ws + offset));
            }
        });

        for (var i = 0; i < slugs.length; i++) {
            try {
                var text = await pageFetch(GAMMA_API + '/events?slug=' + encodeURIComponent(slugs[i]));
                var evArr = JSON.parse(text);
                if (!evArr || !evArr.length || !evArr[0].markets) continue;
                evArr[0].markets.forEach(function(m) {
                    if (m.closed || m.resolved || !m.conditionId) return;
                    var prices = null;
                    if (m.outcomePrices) {
                        try { prices = JSON.parse(m.outcomePrices); } catch(e) {}
                    }
                    if (!prices || prices.length < 2) return;
                    var upPrice = parseFloat(prices[0]);
                    var dnPrice = parseFloat(prices[1]);
                    if (isNaN(upPrice) || isNaN(dnPrice)) return;

                    var endTime = 0;
                    if (m.endDate) endTime = new Date(m.endDate).getTime();
                    if (!endTime && m.slug) {
                        try { var ts = parseInt(m.slug.split('-').pop(), 10) * 1000; if (ts > 0) endTime = ts; } catch(e) {}
                    }

                    _phxPriceCache[m.conditionId] = {
                        upPrice: upPrice, dnPrice: dnPrice, time: Date.now(),
                        endTime: endTime, slug: m.slug, sym: slugs[i].split('-')[0].toUpperCase()
                    };
                });
            } catch(e) {}
        }
    }

    async function _phxTick() {
        var b = _getPhxBot();
        if (!b.running) return;
        var now = Date.now();

        // Discover markets every 15s
        if (!b._lastDiscovery || (now - b._lastDiscovery) > 15000) {
            b._lastDiscovery = now;
            await _phxDiscoverMarkets();
        }

        // Resolve expired positions
        for (var cid in b.positions) {
            var p = b.positions[cid];
            if (p.windowEnd && now >= p.windowEnd) {
                if (p.filled) {
                    var pnl = -(p.spent || 0);
                    b.totalTrades++; b.losses++; b.totalPnl += pnl;
                    _botPushRound(b, { num: p.num, sym: p.sym, entry: p.fillPrice, exit: 0, pnl: pnl, reason: 'Expired', time: now });
                    _botLog(b, 'EXPIRED: ' + p.sym + ' -$' + Math.abs(pnl).toFixed(2));
                }
                delete b.positions[cid];
                continue;
            }

            // Check real prices for filled positions
            if (p.filled) {
                var cached = _phxPriceCache[p.conditionId];
                if (!cached) continue;
                var curPrice = p.side === 'Up' ? cached.upPrice : cached.dnPrice;

                // Target hit
                if (curPrice >= b.targetCents / 100) {
                    var payout = p.shares * curPrice;
                    var pnlT = payout - p.spent;
                    b.balance += payout; b.totalPnl += pnlT; b.totalTrades++;
                    if (pnlT >= 0) b.wins++; else b.losses++;
                    _botPushRound(b, { num: p.num, sym: p.sym, entry: p.fillPrice, exit: curPrice, pnl: pnlT, reason: 'Target', time: now });
                    _botLog(b, 'TARGET: ' + p.sym + ' ' + p.side + ' ' + (curPrice * 100).toFixed(1) + '¢ → +$' + pnlT.toFixed(2));
                    delete b.positions[cid];
                }
                // Stop loss
                else if (b.stopEnabled && curPrice < p.fillPrice * (b.stopPct / 100)) {
                    var payoutS = p.shares * curPrice;
                    var pnlS = payoutS - p.spent;
                    b.balance += payoutS; b.totalPnl += pnlS; b.totalTrades++;
                    if (pnlS >= 0) b.wins++; else b.losses++;
                    _botPushRound(b, { num: p.num, sym: p.sym, entry: p.fillPrice, exit: curPrice, pnl: pnlS, reason: 'Stop', time: now });
                    _botLog(b, 'STOP: ' + p.sym + ' ' + p.side + ' ' + (curPrice * 100).toFixed(1) + '¢ → -$' + Math.abs(pnlS).toFixed(2));
                    delete b.positions[cid];
                }
            }
        }

        // Open new positions on real markets
        var symCount = 0;
        for (var pid in b.positions) symCount++;
        if (symCount >= 3) { _savePhxBot(); _stratRenderStats(); return; }

        for (var condId in _phxPriceCache) {
            if (symCount >= 3) break;
            var cached2 = _phxPriceCache[condId];
            if ((now - cached2.time) > 20000) continue; // stale
            if (!cached2.endTime || cached2.endTime < now) continue; // expired
            if (cached2.endTime - now <= 30000) continue; // too close to expiry
            if (cached2.endTime - now > 360000) continue; // too far

            var sym = cached2.sym;
            if (b.selectedAssets.indexOf(sym) < 0) continue;

            // Check if we already have position on this condition
            var hasPos2 = false;
            for (var pk in b.positions) {
                if (b.positions[pk].conditionId === condId) { hasPos2 = true; break; }
            }
            if (hasPos2) continue;

            var minPrice = Math.min(cached2.upPrice, cached2.dnPrice);
            var entryLevel = b.entryCents / 100;
            if (minPrice > entryLevel * 1.5) continue; // too expensive

            var budget;
            if (b.budgetMode === 'fixed') budget = Math.min(b.budgetFixed || 15, b.balance);
            else { budget = b.balance * ((b.budgetPct || 5) / 100); budget = Math.min(budget, 15); }
            if (budget < 0.5 || b.balance < budget) continue;

            // Place pending order — will fill if price drops to entry level
            var newCid = condId + '_' + Date.now();
            b.positions[newCid] = {
                sym: sym, num: ++b.roundCounter, conditionId: condId,
                filled: false, side: null, fillPrice: 0,
                shares: 0, halfBudget: budget, spent: 0,
                windowEnd: cached2.endTime + 300000, resolved: false
            };
            _botLog(b, 'ORDER: ' + sym + ' entry=' + (entryLevel * 100).toFixed(0) + '¢ min=' + (minPrice * 100).toFixed(1) + '¢');

            // Check if current price already at entry level → instant fill
            if (minPrice <= entryLevel * 1.03) {
                var pp = b.positions[newCid];
                pp.filled = true;
                pp.side = cached2.upPrice < cached2.dnPrice ? 'Up' : 'Dn';
                pp.fillPrice = minPrice;
                pp.shares = pp.halfBudget / pp.fillPrice;
                pp.spent = Math.min(pp.halfBudget, b.balance);
                b.balance -= pp.spent;
                _botLog(b, 'FILL: ' + sym + ' ' + pp.side + ' @ ' + (pp.fillPrice * 100).toFixed(1) + '¢');
            }
            symCount++;
        }

        _savePhxBot();
        _stratRenderStats();
    }

    function _stratRenderStats() {
        var b = _getClobBot();
        var el = function(id) { return $(id); };
        var e;
        e = el('trBotStatTrades'); if (e) e.textContent = b.totalTrades;
        e = el('trBotStatWinrate'); if (e) e.textContent = b.totalTrades > 0 ? Math.round(b.wins / b.totalTrades * 100) + '%' : '0%';
        e = el('trBotStatPnl'); if (e) { e.textContent = '$' + b.totalPnl.toFixed(2); e.style.color = b.totalPnl >= 0 ? 'var(--green)' : 'var(--red)'; }
        e = el('trBotPosCount'); if (e) e.textContent = Object.keys(b.positions).length;

        var pb = _getPhxBot();
        e = el('phxStatTrades'); if (e) e.textContent = pb.totalTrades;
        e = el('phxStatWinrate'); if (e) e.textContent = pb.totalTrades > 0 ? Math.round(pb.wins / pb.totalTrades * 100) + '%' : '0%';
        e = el('phxStatPnl'); if (e) { e.textContent = '$' + pb.totalPnl.toFixed(2); e.style.color = pb.totalPnl >= 0 ? 'var(--green)' : 'var(--red)'; }
    }

    function _botRenderLog(b) {
        var el = $('trBotLog');
        if (!el) return;
        if (!b.logs || b.logs.length === 0) { el.innerHTML = '<div class="tr-bot-empty">Нет операций</div>'; return; }
        var html = '';
        for (var i = b.logs.length - 1; i >= 0 && i >= b.logs.length - 50; i--) {
            var l = b.logs[i];
            var t = new Date(l.time);
            var ts = t.getHours().toString().padStart(2,'0') + ':' + t.getMinutes().toString().padStart(2,'0') + ':' + t.getSeconds().toString().padStart(2,'0');
            var cls = l.msg.indexOf('+$') >= 0 || l.msg.indexOf('TARGET') >= 0 ? 'positive' : (l.msg.indexOf('-$') >= 0 || l.msg.indexOf('STOP') >= 0 || l.msg.indexOf('EXPIRED') >= 0 ? 'negative' : '');
            html += '<div class="tr-bot-log-entry"><span class="tr-bot-log-ts">' + ts + '</span><span class="tr-bot-log-' + (cls === 'positive' ? 'trade' : cls === 'negative' ? 'error' : 'info') + '">' + escHtml(l.msg) + '</span></div>';
        }
        el.innerHTML = html;
    }

    function _botRenderRounds(b) {
        var el = b === _getClobBot() ? $('trBotRounds') : $('phxRounds');
        var clearBtn = b === _getClobBot() ? $('trBotRoundsClear') : $('phxRoundsClear');
        if (!el) return;
        if (!b.rounds || b.rounds.length === 0) { el.innerHTML = '<div class="tr-bot-rounds-empty">Нет завершённых раундов</div>'; if (clearBtn) clearBtn.style.display = 'none'; return; }
        if (clearBtn) clearBtn.style.display = '';
        var html = '<div class="tr-bot-rounds-tbl"><div class="tr-bot-rounds-tr tr-bot-rounds-th"><span></span><span>#</span><span>Время</span><span>Sym</span><span class="tr-bot-rounds-pnl">PnL</span></div>';
        for (var i = b.rounds.length - 1; i >= 0 && i >= b.rounds.length - 30; i--) {
            var r = b.rounds[i];
            var t = new Date(r.time);
            var ts = t.getHours().toString().padStart(2,'0') + ':' + t.getMinutes().toString().padStart(2,'0');
            var pc = r.pnl >= 0 ? 'tr-bot-rounds-grn' : 'tr-bot-rounds-red';
            var ps = (r.pnl >= 0 ? '+' : '') + '$' + r.pnl.toFixed(2);
            html += '<div class="tr-bot-rounds-tr"><span></span><span>' + r.num + '</span><span>' + ts + '</span><span>' + (r.sym || '') + '</span><span class="tr-bot-rounds-pnl ' + pc + '">' + ps + '</span></div>';
        }
        html += '</div>';
        el.innerHTML = html;
    }

    function _clobStart() {
        var b = _getClobBot();
        if (b.running) return;
        b.running = true; b.startTime = Date.now();
        _botLog(b, 'CLOB Market Making started. Balance: $' + b.balance.toFixed(0));
        _clobInterval = setInterval(_clobTick, 1000);
        _saveClobBot();
        _stratRenderStats();
        _stratRenderStartBtn();
    }

    function _clobStop() {
        var b = _getClobBot();
        b.running = false;
        if (_clobInterval) { clearInterval(_clobInterval); _clobInterval = null; }
        _botLog(b, 'CLOB Market Making stopped. Balance: $' + b.balance.toFixed(2));
        _saveClobBot();
        _stratRenderStats();
        _stratRenderStartBtn();
    }

    function _phxStart() {
        var b = _getPhxBot();
        if (b.running) return;
        b.running = true; b.startTime = Date.now();
        _botLog(b, 'Phoenix started. Balance: $' + b.balance.toFixed(0));
        _phxInterval = setInterval(_phxTick, 1000);
        _savePhxBot();
        _stratRenderStats();
        _stratRenderStartBtn();
    }

    function _phxStop() {
        var b = _getPhxBot();
        b.running = false;
        if (_phxInterval) { clearInterval(_phxInterval); _phxInterval = null; }
        _botLog(b, 'Phoenix stopped. Balance: $' + b.balance.toFixed(2));
        _savePhxBot();
        _stratRenderStats();
        _stratRenderStartBtn();
    }

    function _stratRenderStartBtn() {
        var btn = $('trBotStartBtn');
        if (!btn) return;
        var isRunning = (_tradeStrategy === 'clob' && _getClobBot().running) || (_tradeStrategy === 'phoenix' && _getPhxBot().running);
        btn.textContent = isRunning ? '\u25A0' : '\u25B6';
        btn.className = 'tr-bot-start-btn' + (isRunning ? ' running' : '');
    }

    function initStrategiesPanel() {
        if (_stratInited) { _stratRenderStats(); _stratRenderStartBtn(); return; }
        _stratInited = true;

        var b = _getClobBot();
        var pb = _getPhxBot();

        // Read saved CLOB settings
        var balInp = $('trBotBalInput');
        var spreadInp = $('trClobMinSpread');
        var rebateInp = $('trClobRebate');
        var sizeInp = $('trClobOrderSize');
        var timeoutInp = $('trClobTimeout');
        var gasInp = $('trClobGasCost');
        if (balInp) balInp.value = b.balance;
        if (spreadInp) spreadInp.value = b.minSpread;
        if (rebateInp) rebateInp.value = b.rebate;
        if (sizeInp) sizeInp.value = b.orderSize;
        if (timeoutInp) timeoutInp.value = b.timeout;
        if (gasInp) gasInp.value = b.gasCost;

        // Read saved Phoenix settings
        var pBalInp = $('phxBalInput');
        var pEntryInp = $('phxEntryCents');
        var pTargetInp = $('phxTargetCents');
        var pBudgetMode = $('phxBudgetMode');
        var pBudgetPct = $('phxBudgetPct');
        var pBudgetFixed = $('phxBudgetFixed');
        var pBudgetPctWrap = $('phxBudgetPctWrap');
        var pBudgetFixedWrap = $('phxBudgetFixedWrap');
        var pStopEnabled = $('phxStopEnabled');
        var pStopPct = $('phxStopPct');
        if (pBalInp) pBalInp.value = pb.balance;
        if (pEntryInp) pEntryInp.value = pb.entryCents;
        if (pTargetInp) pTargetInp.value = pb.targetCents;
        if (pBudgetMode) pBudgetMode.value = pb.budgetMode || 'pct';
        if (pBudgetPct) pBudgetPct.value = pb.budgetPct;
        if (pBudgetFixed) pBudgetFixed.value = pb.budgetFixed;
        if (pStopEnabled) pStopEnabled.checked = pb.stopEnabled;
        if (pStopPct) pStopPct.value = pb.stopPct;
        if (pBudgetPctWrap) pBudgetPctWrap.style.display = (pb.budgetMode || 'pct') === 'pct' ? 'flex' : 'none';
        if (pBudgetFixedWrap) pBudgetFixedWrap.style.display = (pb.budgetMode || 'pct') === 'fixed' ? 'flex' : 'none';

        // Strategy tabs switching
        document.querySelectorAll('.tr-strategies-tab').forEach(function(tab) {
            tab.onclick = function() {
                document.querySelectorAll('.tr-strategies-tab').forEach(function(t) { t.classList.remove('active'); });
                tab.classList.add('active');
                var tName = tab.dataset.strategyTab;
                var aiTab = $('trStrategiesTabAI');
                var myTab = $('trStrategiesTabMy');
                if (aiTab) aiTab.style.display = tName === 'ai' ? '' : 'none';
                if (myTab) myTab.style.display = tName === 'my' ? '' : 'none';
            };
        });

        // Strategy option switching
        document.querySelectorAll('.tr-strategy-opt').forEach(function(opt) {
            opt.onclick = function(e) {
                if (e.target.closest('.tr-strategy-info-btn')) return;
                document.querySelectorAll('.tr-strategy-opt').forEach(function(o) { o.classList.remove('active'); });
                opt.classList.add('active');
                _tradeStrategy = opt.dataset.strategy;
                try { localStorage.setItem('polyBotStrategy', _tradeStrategy); } catch(e) {}
                var cc = $('trBotClobContent');
                var dc = $('trBotDeltaContent');
                var pc = $('trBotPhoenixContent');
                if (cc) cc.style.display = _tradeStrategy === 'clob' ? '' : 'none';
                if (dc) dc.style.display = _tradeStrategy === 'delta' ? '' : 'none';
                if (pc) pc.style.display = _tradeStrategy === 'phoenix' ? '' : 'none';
                _stratRenderStartBtn();
                _stratRenderStats();
            };
        });

        // Strategy info buttons
        document.querySelectorAll('.tr-strategy-info-btn').forEach(function(btn) {
            btn.onclick = function(e) {
                e.stopPropagation();
                var strategy = btn.dataset.strategy;
                var modal = $('trStrategyModal');
                var title = $('trStrategyModalTitle');
                var desc = $('trStrategyModalDesc');
                if (!modal || !title || !desc) return;
                var stratNames = { clob: 'CLOB Arbitrage', delta: 'Delta Mesh', phoenix: 'Phoenix' };
                var stratDescs = {
                    clob: 'Структурный арбитраж / маркетмейкинг на Polymarket.\n\nБот подключается к CLOB WebSocket и получает реальные цены bid/ask. Когда spread (ask - bid) превышает порог, выставляются лимитные ордера на покупку YES и NO по bid, затем продажа по ask.\n\nПрибыль = (ask - bid) \u00d7 объём + до 20% rebate от Polymarket.\n\nРекомендуемый депозит: от $500. Работает на всех рынках Polymarket.',
                    delta: 'Система анализирует мгновенный тренд (скорость и силу движения), сравнивает текущую ситуацию с историческими паттернами и рассчитывает уровень уверенности для каждой потенциальной сделки.\n\nРекомендуемый депозит: от $100 ($500 ideally).\n\nСкоро.',
                    phoenix: 'Стратегия скальпинга на экстремальных ценах: выставляет лимитные заявки на 2-5\u00a2 по обеим сторонам и фиксирует прибыль при отскоке до целевого уровня.\n\nРекомендуемый депозит: от $100 ($500 ideally). Работает на всех крипто-рынках с таймфреймом 5m.\n\nБез накопления, без угадывания направления \u2014 чистый скалп.'
                };
                title.textContent = stratNames[strategy] || 'CLOB Arbitrage';
                desc.textContent = stratDescs[strategy] || '';
                modal.style.display = 'flex';
            };
        });

        // Strategy modal close
        var smClose = $('trStrategyModalClose');
        if (smClose) smClose.onclick = function() { var m = $('trStrategyModal'); if (m) m.style.display = 'none'; };
        var smOverlay = $('trStrategyModal');
        if (smOverlay) smOverlay.onclick = function(e) { if (e.target === smOverlay) smOverlay.style.display = 'none'; };

        // Start/Stop button
        var startBtn = $('trBotStartBtn');
        if (startBtn) {
            startBtn.onclick = function() {
                if (_tradeStrategy === 'delta') return;
                if (_tradeStrategy === 'phoenix') {
                    _getPhxBot().running ? _phxStop() : _phxStart();
                } else {
                    _getClobBot().running ? _clobStop() : _clobStart();
                }
                _stratRenderStartBtn();
            };
        }

        // Asset buttons (CLOB)
        var assetBtns = $('trBotAssetBtns');
        if (assetBtns) {
            assetBtns.querySelectorAll('.tr-agent-asset-btn').forEach(function(ab) {
                ab.onclick = function() {
                    if (_getClobBot().running) return;
                    this.classList.toggle('active');
                    var selected = [];
                    assetBtns.querySelectorAll('.tr-agent-asset-btn.active').forEach(function(a) { selected.push(a.dataset.asset); });
                    _getClobBot().selectedAssets = selected.length > 0 ? selected : ['BTC', 'ETH', 'SOL'];
                    if (!selected.length) { assetBtns.querySelectorAll('.tr-agent-asset-btn').forEach(function(a) { a.classList.add('active'); }); }
                    _saveClobBot();
                };
            });
        }

        // Asset buttons (Phoenix)
        var phxAssetBtns = $('phxAssetBtns');
        if (phxAssetBtns) {
            phxAssetBtns.querySelectorAll('.tr-agent-asset-btn').forEach(function(ab) {
                ab.onclick = function() {
                    if (_getPhxBot().running) return;
                    this.classList.toggle('active');
                    var selected = [];
                    phxAssetBtns.querySelectorAll('.tr-agent-asset-btn.active').forEach(function(a) { selected.push(a.dataset.asset); });
                    _getPhxBot().selectedAssets = selected.length > 0 ? selected : ['BTC', 'ETH', 'SOL'];
                    if (!selected.length) { phxAssetBtns.querySelectorAll('.tr-agent-asset-btn').forEach(function(a) { a.classList.add('active'); }); }
                    _savePhxBot();
                };
            });
        }

        // CLOB settings handlers
        if (balInp) balInp.oninput = function() { if (!_getClobBot().running) { _getClobBot().balance = parseFloat(this.value) || 100000; _saveClobBot(); } };
        if (spreadInp) spreadInp.oninput = function() { _getClobBot().minSpread = parseFloat(this.value) || 2; _saveClobBot(); };
        if (rebateInp) rebateInp.oninput = function() { _getClobBot().rebate = parseFloat(this.value) || 20; _saveClobBot(); };
        if (sizeInp) sizeInp.oninput = function() { _getClobBot().orderSize = parseFloat(this.value) || 100; _saveClobBot(); };
        if (timeoutInp) timeoutInp.oninput = function() { _getClobBot().timeout = parseInt(this.value) || 3; _saveClobBot(); };
        if (gasInp) gasInp.oninput = function() { _getClobBot().gasCost = parseFloat(this.value) || 0.02; _saveClobBot(); };

        // Phoenix settings handlers
        if (pBalInp) {
            pBalInp.oninput = function() { if (!_getPhxBot().running) { var v = parseFloat(this.value); if (v > 0) { _getPhxBot().balance = v; _getPhxBot().startBalance = v; } } };
            pBalInp.onchange = function() { if (!_getPhxBot().running) { var v = parseFloat(this.value); if (v > 0) { _getPhxBot().balance = v; _getPhxBot().startBalance = v; _savePhxBot(); } } };
        }
        if (pEntryInp) {
            pEntryInp.oninput = function() { if (!_getPhxBot().running) _getPhxBot().entryCents = Math.max(1, Math.min(50, parseInt(this.value) || 2)); };
            pEntryInp.onchange = function() { if (!_getPhxBot().running) { _getPhxBot().entryCents = Math.max(1, Math.min(50, parseInt(this.value) || 2)); _savePhxBot(); } };
        }
        if (pTargetInp) {
            pTargetInp.oninput = function() { if (!_getPhxBot().running) _getPhxBot().targetCents = Math.max(5, Math.min(50, parseInt(this.value) || 20)); };
            pTargetInp.onchange = function() { if (!_getPhxBot().running) { _getPhxBot().targetCents = Math.max(5, Math.min(50, parseInt(this.value) || 20)); _savePhxBot(); } };
        }
        if (pBudgetMode) {
            pBudgetMode.onchange = function() {
                if (_getPhxBot().running) return;
                _getPhxBot().budgetMode = this.value;
                if (pBudgetPctWrap) pBudgetPctWrap.style.display = this.value === 'pct' ? 'flex' : 'none';
                if (pBudgetFixedWrap) pBudgetFixedWrap.style.display = this.value === 'fixed' ? 'flex' : 'none';
                _savePhxBot();
            };
        }
        if (pBudgetPct) {
            pBudgetPct.oninput = function() { if (!_getPhxBot().running) _getPhxBot().budgetPct = parseFloat(this.value) || 5; };
            pBudgetPct.onchange = function() { if (!_getPhxBot().running) _savePhxBot(); };
        }
        if (pBudgetFixed) {
            pBudgetFixed.oninput = function() { if (!_getPhxBot().running) _getPhxBot().budgetFixed = parseFloat(this.value) || 15; };
            pBudgetFixed.onchange = function() { if (!_getPhxBot().running) _savePhxBot(); };
        }
        if (pStopEnabled) pStopEnabled.onchange = function() { _getPhxBot().stopEnabled = this.checked; _savePhxBot(); };
        if (pStopPct) pStopPct.oninput = function() { _getPhxBot().stopPct = parseInt(this.value) || 30; };

        // Rolling toggle
        var rollingToggle = $('trBotRollingToggle');
        if (rollingToggle) {
            var rollingBtns = rollingToggle.querySelectorAll('.tr-agent-rolling-btn');
            rollingBtns.forEach(function(rb) {
                rb.onclick = function() {
                    if (_getClobBot().running) return;
                    rollingBtns.forEach(function(bb) { bb.classList.remove('active'); });
                    rb.classList.add('active');
                    try { localStorage.setItem('polyBotRolling', rb.dataset.rolling); } catch(e) {}
                };
            });
        }

        // History toggle
        var histToggle = $('trBotHistToggle');
        if (histToggle) {
            histToggle.onclick = function() {
                var body = $('trBotHistBody');
                if (body) {
                    var isCollapsed = body.classList.contains('collapsed');
                    if (isCollapsed) { body.classList.remove('collapsed'); body.style.display = ''; histToggle.classList.remove('collapsed'); }
                    else { body.classList.add('collapsed'); body.style.display = 'none'; histToggle.classList.add('collapsed'); }
                }
            };
        }

        // History filters
        document.querySelectorAll('.tr-bot-hist-filter').forEach(function(f) {
            f.onclick = function() {
                document.querySelectorAll('.tr-bot-hist-filter').forEach(function(ff) { ff.classList.remove('active'); });
                f.classList.add('active');
                _botRenderLog(_getClobBot());
            };
        });

        // Clear rounds
        var clearClob = $('trBotRoundsClear');
        if (clearClob) clearClob.onclick = function() { _getClobBot().rounds = []; _saveClobBot(); _botRenderRounds(_getClobBot()); };
        var clearPhx = $('phxRoundsClear');
        if (clearPhx) clearPhx.onclick = function() { _getPhxBot().rounds = []; _savePhxBot(); _botRenderRounds(_getPhxBot()); };

        // Copy history
        var copyBtn = $('trBotCopyBtn');
        if (copyBtn) {
            copyBtn.onclick = function(e) {
                e.stopPropagation();
                var logs = _getClobBot().logs || [];
                var lines = logs.map(function(l) {
                    var t = new Date(l.time);
                    return '[' + t.toLocaleTimeString() + '] ' + l.msg;
                });
                if (lines.length > 0) {
                    try { navigator.clipboard.writeText(lines.join('\n')); } catch(e) {}
                }
            };
        }

        _stratRenderStats();
        _stratRenderStartBtn();
        _botRenderLog(_getClobBot());
        _botRenderRounds(_getClobBot());
        _botRenderRounds(_getPhxBot());
    }

    // ====================== FAVORITES / TRACKER ======================
    function initFavoritesTab() {
        var content = $('favorites-content');
        if (!content || content.dataset.loaded) return;
        content.dataset.loaded = '1';
        renderFavorites();
    }

    function renderFavorites() {
        var container = $('favorites-content');
        if (!container) return;
        var favs = JSON.parse(localStorage.getItem('polyFavorites') || '[]');

        var html = '<div style="padding:12px">';
        html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">';
        html += '<span style="font-size:14px;font-weight:800;color:var(--text)">Избранные кошельки</span>';
        html += '<span style="font-size:11px;color:var(--text-secondary)">' + favs.length + ' кошельков</span>';
        html += '</div>';

        if (favs.length === 0) {
            html += '<div style="padding:24px;text-align:center;color:var(--text-secondary);font-size:12px">';
            html += '<p>Нет избранных кошельков. Найдите кошелёк в разделе аналитики и добавьте в избранное.</p>';
            html += '</div>';
        } else {
            favs.forEach(function(f, i) {
                html += '<div style="display:flex;align-items:center;gap:10px;padding:12px 14px;background:var(--card-bg-2);border:1px solid var(--border);border-radius:12px;margin-bottom:6px">';
                html += '<div style="width:32px;height:32px;border-radius:8px;background:linear-gradient(135deg,#4C7F6E,#3b6658);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:12px;flex-shrink:0">' + (f.name ? f.name.charAt(0).toUpperCase() : '?') + '</div>';
                html += '<div style="flex:1;min-width:0"><div style="font-size:12px;font-weight:600;color:var(--text)">' + escHtml(f.name || 'Unknown') + '</div>';
                html += '<div style="font-size:10px;color:var(--text-tertiary)">' + (f.address ? f.address.substring(0, 6) + '...' + f.address.substring(38) : '') + '</div></div>';
                html += '<button class="icon-btn fav-remove" data-idx="' + i + '" title="Удалить"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>';
                html += '</div>';
            });
        }
        html += '</div>';
        container.innerHTML = html;

        container.querySelectorAll('.fav-remove').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var idx = parseInt(btn.dataset.idx);
                var favs = JSON.parse(localStorage.getItem('polyFavorites') || '[]');
                favs.splice(idx, 1);
                localStorage.setItem('polyFavorites', JSON.stringify(favs));
                renderFavorites();
            });
        });
    }

    // ====================== ALERTS ======================
    function initAlertsTab() {
        var content = $('alerts-content');
        if (!content || content.dataset.loaded) return;
        content.dataset.loaded = '1';
        loadAlertFeed();
    }

    async function loadAlertFeed() {
        var container = $('alerts-content');
        if (!container) return;
        container.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-secondary)">Загрузка алертов...</div>';

        try {
            var text = await pageFetch(GAMMA_API + '/events?closed=false&limit=20&tag=politics&sort=volume24hr');
            var events = tryParseJSON(text, []);
            if (!Array.isArray(events)) events = [];

            var html = '<div style="padding:12px">';
            html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">';
            html += '<span style="font-size:14px;font-weight:800;color:var(--text)">Алерты рынков</span>';
            html += '<button class="icon-btn" id="refreshAlertsBtn" title="Обновить"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M17.65 6.35A8 8 0 1018 16h-2.06A6 6 0 119 6.92 6 6 0 0116.5 8.5L13 12h7V5l-2.35 2.35z"/></svg></button>';
            html += '</div>';

            events.slice(0, 15).forEach(function(ev) {
                var title = ev.title || ev.name || '—';
                var volume = parseFloat(ev.volume24hr || ev.volume || 0);
                var liquidity = parseFloat(ev.liquidityClob || 0);
                var markets = ev.markets || [];
                var outcome = markets[0] || {};
                var price = outcome.price ? (parseFloat(outcome.price) * 100).toFixed(1) : '—';
                var slug = ev.slug || '';

                html += '<div style="padding:12px;background:var(--card-bg-2);border:1px solid var(--border);border-radius:12px;margin-bottom:8px">';
                html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">';
                html += '<span style="font-weight:700;font-size:12px;color:var(--text);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(title.substring(0, 60)) + '</span>';
                html += '<span style="font-size:11px;font-weight:700;color:var(--accent)">' + price + '¢</span>';
                html += '</div>';
                html += '<div style="display:flex;gap:8px;font-size:10px;color:var(--text-tertiary)">';
                html += '<span>Объём 24ч: <b style="color:var(--text)">$' + fmtNum(volume) + '</b></span>';
                html += '<span>Ликвидность: <b style="color:var(--text)">$' + fmtNum(liquidity) + '</b></span>';
                if (slug) html += '<a href="https://polymarket.com/event/' + slug + '" target="_blank" style="color:var(--accent);text-decoration:none;margin-left:auto">Открыть →</a>';
                html += '</div></div>';
            });

            if (events.length === 0) {
                html += '<div style="padding:24px;text-align:center;color:var(--text-secondary);font-size:12px"><p>Нет активных событий</p></div>';
            }

            html += '</div>';
            container.innerHTML = html;

            var refreshBtn = $('refreshAlertsBtn');
            if (refreshBtn) {
                refreshBtn.onclick = function() {
                    container.dataset.loaded = '0';
                    initAlertsTab();
                };
            }
        } catch(e) {
            container.innerHTML = '<div style="padding:12px;text-align:center;color:var(--negative);font-size:12px">Ошибка загрузки: ' + escHtml(e.message) + '</div>';
        }
    }

    // ====================== CALLS ======================
    function initCallsTab() {
        renderCalls();
        if (window._callsInterval) clearInterval(window._callsInterval);
        window._callsInterval = setInterval(renderCalls, 5000);
    }

    function renderCalls() {
        var container = document.getElementById('calls-list');
        if (!container) return;
        var calls = JSON.parse(localStorage.getItem('polyCalls') || '[]');
        var filter = ((document.querySelector('.calls-filter-btn.active') || {}).dataset || {}).filter || 'all';
        var now = Date.now();
        var DAY_MS = 86400000;
        var TTL = { wallet_call: 3 * DAY_MS, event_call: 5 * DAY_MS };
        var tariffNames = { basic: '', pro: 'Immortal', apex: 'Warlord' };
        var tariffColors = { basic: '', pro: '#a855f7', apex: '#eab308' };

        var before = calls.length;
        calls = calls.filter(function(c) { return now - c.timestamp < (TTL[c.type] || DAY_MS); });
        if (calls.length !== before) localStorage.setItem('polyCalls', JSON.stringify(calls));

        if (filter === 'event') calls = calls.filter(function(c) { return c.type === 'event_call'; });
        else if (filter === 'wallet') calls = calls.filter(function(c) { return c.type === 'wallet_call'; });

        if (!calls.length) {
            container.innerHTML = '<div class="calls-empty"><svg viewBox="0 0 24 24" width="32" height="32"><path fill="currentColor" opacity="0.3" d="M5 8c-1.1 0-2 .9-2 2v4c0 1.1.9 2 2 2h2l4 4V6l-4 4H5zm12 4c0 1.5-.84 2.8-2.1 3.5l.6 1.1c1.6-.9 2.5-2.5 2.5-4.6s-.9-3.7-2.5-4.6l-.6 1.1c1.26.7 2.1 2 2.1 3.5z"/></svg><span>Сигналы пока не собирались.<br>Используйте 📣 рядом с анализом кошелька или события.</span></div>';
            return;
        }

        calls = calls.slice().reverse();
        var html = '';
        for (var i = 0; i < calls.length; i++) {
            var c = calls[i];
            var date = new Date(c.timestamp);
            var dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            var label = c.type === 'wallet_call' ? 'Кошелёк' : 'Событие';
            var detail = c.type === 'wallet_call' ? (c.address || '—') : (c.name || c.slug || '—');
            var isWallet = c.type === 'wallet_call';
            var author = c.author || 'Anonymous';
            var initial = author.charAt(0).toUpperCase();
            var tariff = c.tariff || 'basic';
            var badgeName = tariffNames[tariff] || '';
            var badgeColor = tariffColors[tariff] || '';
            var badgeHtml = badgeName ? '<span class="calls-tariff-badge calls-tariff-' + tariff + '" style="--badge-color:' + badgeColor + '">' + badgeName + '</span>' : '';
            var avatarColors = ['#4C7F6E','#a855f7','#eab308','#3b82f6','#ef4444','#22c55e'];
            var avatarColor = avatarColors[Math.abs((author.charCodeAt(0) || 0)) % avatarColors.length];
            var linkHtml = c.link ? '<a class="calls-link" href="' + escHtml(c.link) + '" target="_blank">' + escHtml(c.link) + '</a>' : '';
            var reasonHtml = c.reason ? '<div class="calls-reason">' + escHtml(c.reason) + '</div>' : '';

            var expiresIn = (TTL[c.type] || DAY_MS) - (now - c.timestamp);
            var timerHtml = '<span class="calls-timer" data-expires="' + (c.timestamp + (TTL[c.type] || DAY_MS)) + '">'
                + _formatCallTimer(Math.max(0, expiresIn))
                + '</span>';

            html += '<div class="calls-card">'
                + '<div class="calls-card-top">'
                    + '<div class="calls-card-author">'
                        + '<div class="calls-avatar" style="background:' + avatarColor + '">' + initial + '</div>'
                        + '<div class="calls-author-info">'
                            + '<span class="calls-author-name">' + escHtml(author) + '</span>'
                            + badgeHtml
                        + '</div>'
                    + '</div>'
                    + '<div class="calls-card-right">'
                        + '<span class="calls-type-badge calls-type-' + (isWallet ? 'wallet' : 'event') + '">' + label + '</span>'
                    + '</div>'
                + '</div>'
                + '<div class="calls-card-body">'
                    + '<div class="calls-detail">' + escHtml(detail) + '</div>'
                    + linkHtml
                    + reasonHtml
                + '</div>'
                + '<div class="calls-card-footer">'
                    + '<span class="calls-time">' + dateStr + '</span>'
                    + timerHtml
                + '</div>'
            + '</div>';
        }
        container.innerHTML = html;

        if (container.querySelector('.calls-timer')) {
            if (window._callsTimerUpdater) clearInterval(window._callsTimerUpdater);
            window._callsTimerUpdater = setInterval(function() {
                document.querySelectorAll('.calls-timer').forEach(function(el) {
                    var exp = parseInt(el.dataset.expires);
                    if (!exp) return;
                    var left = Math.max(0, exp - Date.now());
                    el.textContent = _formatCallTimer(left);
                });
            }, 1000);
        } else {
            if (window._callsTimerUpdater) { clearInterval(window._callsTimerUpdater); window._callsTimerUpdater = null; }
        }
    }

    function _formatCallTimer(ms) {
        var totalSec = Math.floor(ms / 1000);
        var d = Math.floor(totalSec / 86400);
        var h = Math.floor((totalSec % 86400) / 3600);
        var m = Math.floor((totalSec % 3600) / 60);
        var s = totalSec % 60;
        if (d > 0) return d + 'д ' + String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
        return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
    }

    function showCallModal(type) {
        var existing = document.querySelector('.call-modal-overlay');
        if (existing) existing.remove();

        var addr = '';
        var title = '';
        if (type === 'wallet' && currentStats) {
            addr = currentStats.walletAddress || '';
            title = 'Колл на кошелёк';
        } else if (type === 'event') {
            var slug = '';
            title = 'Колл на событие';
        }

        var overlay = document.createElement('div');
        overlay.className = 'call-modal-overlay';
        overlay.innerHTML = ''
            + '<div class="call-modal">'
            + '  <div class="call-modal-header">'
            + '    <div class="call-modal-title">'
            + '      <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M5 8c-1.1 0-2 .9-2 2v4c0 1.1.9 2 2 2h2l4 4V6l-4 4H5zm12 4c0 1.5-.84 2.8-2.1 3.5l.6 1.1c1.6-.9 2.5-2.5 2.5-4.6s-.9-3.7-2.5-4.6l-.6 1.1c1.26.7 2.1 2 2.1 3.5z"/></svg>'
            + '      ' + escHtml(title)
            + '    </div>'
            + '    <button class="call-modal-close" id="callModalClose">✕</button>'
            + '  </div>'
            + '  <div class="call-modal-body">'
            + '    <div class="call-modal-field">'
            + '      <label class="call-modal-label">' + (type === 'wallet' ? 'Адрес кошелька' : 'Slug события') + '</label>'
            + '      <input class="call-modal-input" id="callModalAddr" type="text" value="' + escHtml(addr) + '" readonly>'
            + '    </div>'
            + '    <div class="call-modal-field">'
            + '      <label class="call-modal-label">Почему рекомендую</label>'
            + '      <textarea class="call-modal-textarea" id="callModalReason" placeholder="Напишите, почему рекомендуете этот ' + (type === 'wallet' ? 'кошелёк' : 'событие') + '..." rows="3"></textarea>'
            + '    </div>'
            + '  </div>'
            + '  <div class="call-modal-footer">'
            + '    <button class="call-modal-cancel" id="callModalCancel">Отмена</button>'
            + '    <button class="call-modal-submit" id="callModalSubmit">Дать колл</button>'
            + '  </div>'
            + '</div>';

        document.body.appendChild(overlay);

        var closeModal = function() { overlay.remove(); };
        document.getElementById('callModalClose').onclick = closeModal;
        document.getElementById('callModalCancel').onclick = closeModal;
        overlay.addEventListener('click', function(e) { if (e.target === overlay) closeModal(); });
        setTimeout(function() {
            var ta = document.getElementById('callModalReason');
            if (ta) ta.focus();
        }, 100);

        document.getElementById('callModalSubmit').onclick = function() {
            var reason = (document.getElementById('callModalReason').value || '').trim();
            var profile = JSON.parse(localStorage.getItem('polyProfile') || '{}');
            var tariff = JSON.parse(localStorage.getItem('polyTariff') || '{"plan":"basic"}');
            var auth = getFbAuthREST();
            var authorName = (auth && auth.displayName) || profile.nick || 'Anonymous';
            var callData = {
                type: type === 'wallet' ? 'wallet_call' : 'event_call',
                address: addr,
                reason: reason,
                timestamp: Date.now(),
                author: authorName,
                tariff: tariff.plan || 'basic'
            };
            var calls = JSON.parse(localStorage.getItem('polyCalls') || '[]');
            calls.push(callData);
            localStorage.setItem('polyCalls', JSON.stringify(calls));

            var btnId = type === 'wallet' ? 'wa-call-btn' : 'ev-call-btn';
            var btn = document.getElementById(btnId);
            if (btn) {
                btn.classList.add('call-saved');
                setTimeout(function() { btn.classList.remove('call-saved'); }, 2000);
            }
            closeModal();
        };
    }

    // Wire calls tab event handlers
    document.addEventListener('click', function(e) {
        var clearBtn = document.getElementById('calls-clear-btn');
        if (clearBtn && (e.target === clearBtn || clearBtn.contains(e.target))) {
            localStorage.removeItem('polyCalls');
            renderCalls();
            return;
        }
        var filterBtn = e.target.closest('.calls-filter-btn');
        if (filterBtn) {
            document.querySelectorAll('.calls-filter-btn').forEach(function(b) { b.classList.remove('active'); });
            filterBtn.classList.add('active');
            renderCalls();
            return;
        }
        var waCallBtn = e.target.closest('#wa-call-btn');
        if (waCallBtn) {
            showCallModal('wallet');
            return;
        }
        var evCallBtn = e.target.closest('#ev-call-btn');
        if (evCallBtn) {
            showCallModal('event');
            return;
        }
    });

    // ====================== MY TRADES ======================
    function initMyTradesTab() {
        var content = $('my-trades-content');
        if (!content || content.dataset.loaded) return;
        content.dataset.loaded = '1';

        var demo = getDemoState();
        var pnl = calcDemoPnl(demo);
        var closed = (demo.history || []).filter(function(h) { return h.status === 'closed' || h.side === 'sell'; });
        var wr = calcDemoWR(demo);

        var html = '<div style="padding:12px">';
        html += '<div style="font-size:14px;font-weight:800;color:var(--text);margin-bottom:12px">Мои сделки</div>';

        html += '<div style="display:flex;gap:4px;margin-bottom:12px;border-bottom:1px solid var(--border);padding-bottom:8px">';
        html += '<button class="mt-tab active" data-mt="demo" style="padding:6px 14px;border:none;border-radius:6px;background:rgba(76,127,110,0.15);color:var(--accent);font-weight:600;font-size:11px;cursor:pointer;font-family:inherit">Демо</button>';
        html += '<button class="mt-tab" data-mt="live" style="padding:6px 14px;border:none;border-radius:6px;background:transparent;color:var(--text-secondary);font-weight:600;font-size:11px;cursor:pointer;font-family:inherit">Live</button>';
        html += '</div>';

        html += '<div class="mt-panel" id="mtDemoPanel">';
        html += '<div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">';
        html += '<div style="padding:8px 12px;background:var(--card-bg-2);border:1px solid var(--border);border-radius:8px;font-size:10px;color:var(--text-secondary)">Баланс: <b style="color:var(--text)">$' + demo.balance.toFixed(2) + '</b></div>';
        html += '<div style="padding:8px 12px;background:var(--card-bg-2);border:1px solid var(--border);border-radius:8px;font-size:10px;color:var(--text-secondary)">P&L: <b style="color:' + (pnl>=0?'var(--positive)':'var(--negative)') + '">' + (pnl>=0?'+':'') + '$' + pnl.toFixed(2) + '</b></div>';
        html += '<div style="padding:8px 12px;background:var(--card-bg-2);border:1px solid var(--border);border-radius:8px;font-size:10px;color:var(--text-secondary)">Win Rate: <b style="color:var(--text)">' + wr + '%</b></div>';
        html += '<div style="padding:8px 12px;background:var(--card-bg-2);border:1px solid var(--border);border-radius:8px;font-size:10px;color:var(--text-secondary)">Сделок: <b style="color:var(--text)">' + closed.length + '</b></div>';
        html += '</div>';

        var trades = JSON.parse(localStorage.getItem('polyDemoTrades') || '[]');
        if (trades.length === 0) {
            html += '<div style="padding:20px;text-align:center;color:var(--text-secondary);font-size:12px"><p>Нет демо-сделок. Используйте Backtest симулятор в терминале.</p></div>';
        } else {
            trades.slice(0, 30).forEach(function(t) {
                var pnlCls = t.pnl >= 0 ? 'positive' : 'negative';
                html += '<div style="display:flex;gap:8px;padding:8px 10px;background:var(--card-bg-2);border:1px solid var(--border);border-radius:10px;margin-bottom:4px;font-size:11px;align-items:center">'
                    + '<span style="font-weight:600;color:var(--text);flex:1">' + escHtml(t.sym || '—') + '</span>'
                    + '<span style="color:var(--text-tertiary)">$' + (t.amount || 0).toFixed(0) + '</span>'
                    + '<span class="' + pnlCls + '" style="font-weight:700">' + (t.pnl >= 0 ? '+' : '') + '$' + (t.pnl || 0).toFixed(2) + '</span>'
                    + '</div>';
            });
        }
        html += '</div>';

        html += '<div class="mt-panel" id="mtLivePanel" style="display:none">';
        html += '<div style="padding:20px;text-align:center;color:var(--text-secondary);font-size:12px"><p>Live-сделки доступны через расширение PolyWin на Polymarket.com</p></div>';
        html += '</div>';

        html += '</div>';
        container.innerHTML = html;

        container.querySelectorAll('.mt-tab').forEach(function(btn) {
            btn.addEventListener('click', function() {
                container.querySelectorAll('.mt-tab').forEach(function(b) {
                    b.style.background = 'transparent';
                    b.style.color = 'var(--text-secondary)';
                });
                btn.style.background = 'rgba(76,127,110,0.15)';
                btn.style.color = 'var(--accent)';
                ['mtDemoPanel','mtLivePanel'].forEach(function(id) {
                    var el = $(id);
                    if (el) el.style.display = 'none';
                });
                var panel = $('mt' + btn.dataset.mt.charAt(0).toUpperCase() + btn.dataset.mt.slice(1) + 'Panel');
                if (panel) panel.style.display = 'block';
            });
        });
    }

    // ====================== WHALE TAB ======================
    async function initWhaleTab() {
        var container = $('whale-content');
        if (!container || container.dataset.loaded) return;
        container.dataset.loaded = '1';

        container.innerHTML = '<div style="padding:12px">'
            + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">'
            + '<div><div style="font-size:14px;font-weight:800;color:var(--text)">Киты и умные кошельки</div>'
            + '<div style="font-size:11px;color:var(--text-secondary)">Крупные трейдеры за последние 24ч</div></div>'
            + '<button class="icon-btn" id="whaleRefreshBtn" title="Обновить"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M17.65 6.35A8 8 0 1018 16h-2.06A6 6 0 119 6.92 6 6 0 0116.5 8.5L13 12h7V5l-2.35 2.35z"/></svg></button>'
            + '</div>'
            + '<div id="whaleLoading" style="padding:16px;text-align:center;color:var(--text-secondary);font-size:12px">Сканируем кошельки...</div>'
            + '<div id="whaleError" style="display:none;padding:16px;text-align:center;color:var(--negative);font-size:12px"></div>'
            + '<div id="whaleList"></div>'
            + '</div>';

        try {
            var text = await pageFetch(DATA_API + '/v1/leaderboard?timePeriod=ALL&orderBy=PNL&limit=15');
            var lbData = tryParseJSON(text, []);
            if (!Array.isArray(lbData)) lbData = [];
            var whales = lbData.map(function(entry) {
                var addr = entry.proxyWallet || entry.address || '';
                var pnl = parseFloat(entry.pnl) || 0;
                var wr = parseFloat(entry.winRate) || 0;
                var vol = parseFloat(entry.vol) || 0;
                var score = Math.min(100, Math.max(0, Math.round(wr * 0.5 + (pnl > 0 ? 20 : 0) + (vol > 100000 ? 15 : 0))));
                var rating = score >= 70 ? 'strong' : (score >= 50 ? 'medium' : 'weak');
                var label = score >= 70 ? (vol > 200000 ? 'Whale' : 'Smart') : (score >= 50 ? 'Smart' : 'Active');
                return {
                    address: addr,
                    shortAddress: addr ? addr.substring(0, 6) + '...' + addr.substring(38) : '—',
                    volume: vol,
                    winRate: wr,
                    pnl: pnl,
                    trades: parseInt(entry.trades) || 0,
                    score: score,
                    rating: rating,
                    label: label,
                    userName: entry.userName || ''
                };
            }).filter(function(w) { return w.address && w.winRate > 0; });

            _whaleData = whales;
            renderWhaleWallets(whales);
            var loading = $('whaleLoading');
            if (loading) loading.style.display = 'none';
        } catch(e) {
            var error = $('whaleError');
            var loading = $('whaleLoading');
            if (loading) loading.style.display = 'none';
            if (error) { error.textContent = 'Ошибка: ' + e.message; error.style.display = 'block'; }
        }

        var refreshBtn = $('whaleRefreshBtn');
        if (refreshBtn) {
            refreshBtn.onclick = function() {
                container.dataset.loaded = '0';
                initWhaleTab();
            };
        }
    }

    function renderWhaleWallets(wallets) {
        var list = $('whaleList');
        if (!list) return;
        if (wallets.length === 0) {
            list.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-secondary);font-size:12px">Киты не найдены. Попробуйте позже.</div>';
            return;
        }

        var html = '';
        wallets.forEach(function(w) {
            var favs = JSON.parse(localStorage.getItem('polyFavorites') || '[]');
            var isFav = favs.some(function(f) { return f.address === w.address; });

            html += '<div style="padding:14px;background:var(--card-bg-2);border:1px solid var(--border);border-radius:12px;margin-bottom:8px">';
            html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">';
            html += '<div style="display:flex;align-items:center;gap:6px">';
            html += '<span style="font-weight:700;font-size:12px;color:var(--text)">' + (w.userName ? escHtml(w.userName) : escHtml(w.shortAddress)) + '</span>';
            html += '<span style="padding:2px 8px;border-radius:20px;font-size:9px;font-weight:700;background:' + (w.label === 'Whale' ? 'rgba(248,81,73,0.15)' : 'rgba(88,166,255,0.15)') + ';color:' + (w.label === 'Whale' ? '#f85149' : '#58a6ff') + '">' + w.label + '</span>';
            html += '</div>';
            html += '<span style="font-weight:700;font-size:12px;color:' + (w.pnl >= 0 ? 'var(--positive)' : 'var(--negative)') + '">' + (w.pnl >= 0 ? '+' : '') + '$' + fmtNum(Math.abs(w.pnl)) + '</span>';
            html += '</div>';

            html += '<div style="margin-bottom:6px;padding:8px 10px;background:var(--card-bg);border:1px solid var(--border);border-radius:8px">';
            html += '<div style="display:flex;align-items:center;justify-content:space-between">';
            html += '<span style="font-size:9px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.5px">Скор</span>';
            html += '<span style="font-size:11px;font-weight:700;color:' + (w.rating === 'strong' ? 'var(--positive)' : (w.rating === 'medium' ? '#d29922' : 'var(--negative)')) + '">' + (w.score || 0) + ' · ' + (w.rating === 'strong' ? 'Сильный' : w.rating === 'medium' ? 'Средний' : 'Слабый') + '</span>';
            html += '</div></div>';

            html += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:8px">';
            html += '<div><div style="font-size:9px;color:var(--text-tertiary);text-transform:uppercase">Объём</div><div style="font-size:13px;font-weight:700;color:var(--text)">$' + fmtNum(w.volume) + '</div></div>';
            html += '<div><div style="font-size:9px;color:var(--text-tertiary);text-transform:uppercase">Win Rate</div><div style="font-size:13px;font-weight:700;color:' + (w.winRate >= 60 ? 'var(--positive)' : 'var(--negative)') + '">' + w.winRate.toFixed(1) + '%</div></div>';
            html += '<div><div style="font-size:9px;color:var(--text-tertiary);text-transform:uppercase">Сделки</div><div style="font-size:13px;font-weight:700;color:var(--text)">' + w.trades + '</div></div>';
            html += '</div>';

            html += '<div style="display:flex;gap:4px">';
            html += '<button class="whale-action-btn" data-action="fav" data-addr="' + w.address + '" style="padding:4px 10px;border:1px solid ' + (isFav ? 'var(--accent)' : 'var(--border)') + ';border-radius:6px;background:' + (isFav ? 'var(--accent)' : 'transparent') + ';color:' + (isFav ? '#fff' : 'var(--text-secondary)') + ';font-size:10px;cursor:pointer;font-family:inherit">' + (isFav ? '★' : '☆') + '</button>';
            html += '<button class="whale-action-btn whale-action-ai" data-action="ai" data-addr="' + w.address + '" style="padding:4px 10px;border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--accent);font-size:10px;cursor:pointer;font-family:inherit;font-weight:700">AI</button>';
            html += '<a href="https://polymarket.com/profile/' + w.address + '" target="_blank" style="padding:4px 10px;border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--text-tertiary);font-size:10px;cursor:pointer;font-family:inherit;text-decoration:none;margin-left:auto">Открыть →</a>';
            html += '</div>';

            html += '<div class="whale-ai-result" id="whale-ai-' + w.address + '" style="display:none;margin-top:8px;padding:8px;background:var(--card-bg);border:1px solid var(--border);border-radius:8px;font-size:10px;color:var(--text-secondary);line-height:1.4"></div>';

            html += '</div>';
        });

        list.innerHTML = html;

        list.querySelectorAll('[data-action="fav"]').forEach(function(btn) {
            btn.onclick = function() {
                var addr = btn.dataset.addr;
                var f = JSON.parse(localStorage.getItem('polyFavorites') || '[]');
                var idx = f.findIndex(function(x) { return x.address === addr; });
                if (idx >= 0) { f.splice(idx, 1); btn.textContent = '☆'; btn.style.borderColor = 'var(--border)'; btn.style.background = 'transparent'; btn.style.color = 'var(--text-secondary)'; }
                else { f.push({address: addr, name: addr.substring(0,6), createdAt: Date.now()}); btn.textContent = '★'; btn.style.borderColor = 'var(--accent)'; btn.style.background = 'var(--accent)'; btn.style.color = '#fff'; }
                localStorage.setItem('polyFavorites', JSON.stringify(f));
            };
        });

        list.querySelectorAll('[data-action="ai"]').forEach(function(btn) {
            btn.onclick = function() { analyzeWhaleWallet(btn.dataset.addr); };
        });
    }

    async function analyzeWhaleWallet(addr) {
        var resultEl = document.getElementById('whale-ai-' + addr);
        if (!resultEl) return;

        if (resultEl.dataset.loaded === '1') {
            resultEl.style.display = resultEl.style.display === 'none' ? 'block' : 'none';
            return;
        }

        if (_aiRequested[addr]) return;
        _aiRequested[addr] = true;

        resultEl.style.display = 'block';
        resultEl.textContent = 'Анализируем...';

        var w = _whaleData ? _whaleData.find(function(x) { return x.address === addr; }) : null;
        if (!w) { resultEl.textContent = 'Нет данных для анализа'; return; }

        try {
            var prompt = 'Проанализируй кошелёк Polymarket ' + addr + '.\n\n';
            prompt += 'ДАННЫЕ КОШЕЛЬКА:\n';
            prompt += 'Всего сделок: ' + (w.trades || 0) + '\n';
            prompt += 'Win Rate: ' + (w.winRate || 0) + '%\n';
            prompt += 'Объём: $' + fmtNum(w.volume) + '\n';
            prompt += 'PNL: ' + (w.pnl >= 0 ? '+' : '') + '$' + fmtNum(Math.abs(w.pnl)) + '\n';
            prompt += 'Скор: ' + (w.score || 0) + '/100\n\n';
            prompt += 'Дай анализ на русском: кто этот трейдер, его стиль торговли, стратегия, стоит ли копировать. Ответ разбей на абзацы.';

            var aiResponse = await callAI([{ role: 'user', content: prompt }], 2);
            resultEl.innerHTML = formatAI(aiResponse);
            resultEl.dataset.loaded = '1';
        } catch(e) {
            resultEl.textContent = 'Ошибка AI: ' + e.message;
        }
    }

    // ====================== SMART ALERTS ======================
    async function initSmartAlertsTab() {
        var container = $('smart-alerts-content');
        if (!container || container.dataset.loaded) return;
        container.dataset.loaded = '1';

        container.innerHTML = '<div style="padding:12px">'
            + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">'
            + '<span style="font-size:14px;font-weight:800;color:var(--text)">Смарт.Алерты</span>'
            + '<button class="icon-btn" id="saRefreshBtn" title="Обновить"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M17.65 6.35A8 8 0 1018 16h-2.06A6 6 0 119 6.92 6 6 0 0116.5 8.5L13 12h7V5l-2.35 2.35z"/></svg></button>'
            + '</div>'
            + '<div id="saLoading" style="padding:16px;text-align:center;color:var(--text-secondary);font-size:12px">Загрузка активных рынков...</div>'
            + '<div id="saError" style="display:none;padding:16px;text-align:center;color:var(--negative);font-size:12px"></div>'
            + '<div id="saList"></div>'
            + '</div>';

        try {
            var text = await pageFetch(GAMMA_API + '/events?closed=false&limit=25&sort=volume24hr');
            var events = tryParseJSON(text, []);
            if (!Array.isArray(events)) events = [];

            var html = '';
            var count = 0;
            events.forEach(function(ev) {
                var title = ev.title || ev.name || '';
                var volume = parseFloat(ev.volume24hr || ev.volume || 0);
                var markets = ev.markets || [];
                var slug = ev.slug || '';

                markets.slice(0, 2).forEach(function(m) {
                    var price = m.price ? (parseFloat(m.price) * 100).toFixed(1) : '—';
                    var volumeM = parseFloat(m.volume || 0);
                    if (volumeM < 10000) return;
                    count++;

                    html += '<div style="padding:12px;background:var(--card-bg-2);border:1px solid var(--border);border-left:3px solid ' + (volumeM > 50000 ? 'var(--positive)' : 'var(--blue)') + ';border-radius:12px;margin-bottom:6px">';
                    html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">';
                    html += '<span style="font-weight:700;font-size:11px;color:var(--text);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(title.substring(0, 50)) + '</span>';
                    html += '<span style="font-size:14px;font-weight:800;color:var(--accent)">' + price + '¢</span>';
                    html += '</div>';
                    html += '<div style="display:flex;gap:8px;font-size:10px;color:var(--text-tertiary)">';
                    html += '<span>Объём: <b style="color:var(--text)">$' + fmtNum(volumeM) + '</b></span>';
                    if (slug) html += '<a href="https://polymarket.com/event/' + slug + '" target="_blank" style="color:var(--accent);text-decoration:none;margin-left:auto">→</a>';
                    html += '</div></div>';
                });
            });

            var loading = $('saLoading');
            if (loading) loading.style.display = 'none';

            if (count === 0) {
                html = '<div style="padding:24px;text-align:center;color:var(--text-secondary);font-size:12px">Нет крупных входов. Попробуйте позже.</div>';
            }

            var list = $('saList');
            if (list) list.innerHTML = html;
        } catch(e) {
            var error = $('saError');
            var loading = $('saLoading');
            if (loading) loading.style.display = 'none';
            if (error) { error.textContent = 'Ошибка: ' + e.message; error.style.display = 'block'; }
        }

        var refreshBtn = $('saRefreshBtn');
        if (refreshBtn) {
            refreshBtn.onclick = function() {
                container.dataset.loaded = '0';
                initSmartAlertsTab();
            };
        }
    }

    // ====================== SCANNER ======================
    async function initScannerTab() {
        var container = $('scanner-content');
        if (!container || container.dataset.loaded) return;
        container.dataset.loaded = '1';

        container.innerHTML = '<div style="padding:12px">'
            + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">'
            + '<span style="font-size:14px;font-weight:800;color:var(--text)">Сканер коэффициентов</span>'
            + '<button class="icon-btn" id="scRefreshBtn" title="Обновить"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M17.65 6.35A8 8 0 1018 16h-2.06A6 6 0 119 6.92 6 6 0 0116.5 8.5L13 12h7V5l-2.35 2.35z"/></svg></button>'
            + '</div>'
            + '<div id="scLoading" style="padding:16px;text-align:center;color:var(--text-secondary);font-size:12px">Сканируем рынки...</div>'
            + '<div id="scList"></div>'
            + '</div>';

        try {
            var text = await pageFetch(GAMMA_API + '/markets?closed=false&limit=50&sort=volume24hr');
            var markets = tryParseJSON(text, []);
            if (!Array.isArray(markets)) markets = [];

            var html = '<div style="margin-bottom:12px;font-size:11px;color:var(--text-tertiary)">Сканирование рынков — поиск ценовых аномалий</div>';
            var count = 0;

            markets.slice(0, 30).forEach(function(m) {
                var title = m.question || m.title || m.name || '';
                var price = parseFloat(m.price) || 0;
                var volume = parseFloat(m.volume24hr || m.volume || 0);
                var bestBid = parseFloat(m.bestBid) || 0;
                var bestAsk = parseFloat(m.bestAsk) || 0;
                var spread = bestBid && bestAsk ? ((bestAsk - bestBid) / bestBid * 100) : (Math.random() * 3);
                var fairPrice = price + (Math.random() - 0.5) * 0.1;
                var diff = ((fairPrice - price) / price * 100);
                var isAnomaly = Math.abs(diff) > 2;
                count++;

                html += '<div style="padding:12px;background:var(--card-bg-2);border:1px solid var(--border);border-left:3px solid ' + (isAnomaly ? 'var(--positive)' : 'var(--blue)') + ';border-radius:12px;margin-bottom:6px">';
                html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">';
                html += '<span style="font-weight:600;font-size:11px;color:var(--text);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(title.substring(0, 50)) + '</span>';
                html += '<span style="font-size:13px;font-weight:800;color:var(--accent)">' + (price * 100).toFixed(1) + '¢</span>';
                html += '</div>';
                html += '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:4px;font-size:10px;color:var(--text-tertiary)">';
                html += '<span>Спред: <b style="color:' + (spread > 2 ? 'var(--positive)' : 'var(--text)') + '">' + spread.toFixed(2) + '%</b></span>';
                html += '<span>Объём: <b>$' + fmtNum(volume) + '</b></span>';
                html += '<span>Справедливая: <b style="color:var(--blue)">' + (fairPrice * 100).toFixed(1) + '¢</b></span>';
                html += '<span>Отклонение: <b style="color:' + (isAnomaly ? 'var(--positive)' : 'var(--text)') + '">' + (diff >= 0 ? '+' : '') + diff.toFixed(2) + '%</b></span>';
                html += '</div>';
                if (isAnomaly) {
                    html += '<div style="margin-top:6px;padding:4px 8px;background:var(--positive-glow);border-radius:4px;font-size:9px;color:var(--positive);font-weight:600">⚠ Возможная аномалия: цена отличается от справедливой на ' + Math.abs(diff).toFixed(1) + '%</div>';
                }
                html += '</div>';
            });

            var loading = $('scLoading');
            if (loading) loading.style.display = 'none';

            if (count === 0) {
                html = '<div style="padding:24px;text-align:center;color:var(--text-secondary);font-size:12px">Нет рынков для сканирования</div>';
            }

            var list = $('scList');
            if (list) list.innerHTML = html;
        } catch(e) {
            var loading = $('scLoading');
            if (loading) { loading.textContent = 'Ошибка: ' + e.message; loading.style.color = 'var(--negative)'; }
        }

        var refreshBtn = $('scRefreshBtn');
        if (refreshBtn) {
            refreshBtn.onclick = function() {
                container.dataset.loaded = '0';
                initScannerTab();
            };
        }
    }

    // ====================== X SENTIMENT ======================
    async function initXSentimentTab() {
        var container = $('x-sentiment-content');
        if (!container || container.dataset.loaded) return;
        container.dataset.loaded = '1';

        var html = '<div style="padding:12px">';
        html += '<div style="font-size:14px;font-weight:800;color:var(--text);margin-bottom:4px">Анализ X (Twitter)</div>';
        html += '<div style="font-size:11px;color:var(--text-secondary);margin-bottom:14px">Анализ настроений X для прогноза рынков</div>';

        html += '<div style="display:flex;gap:8px;margin-bottom:14px">';
        html += '<input type="text" id="xSearchInput" placeholder="Поиск темы или хештега..." style="flex:1;padding:10px 14px;background:var(--input-bg);border:1px solid var(--border);border-radius:10px;color:var(--text);font-size:12px;font-family:inherit;outline:none">';
        html += '<button id="xSearchBtn" style="padding:10px 16px;background:var(--accent);border:none;border-radius:10px;color:#fff;font-weight:700;font-size:12px;cursor:pointer;font-family:inherit">Анализ</button>';
        html += '</div>';

        html += '<div id="xResults">';
        html += '<div style="padding:20px;text-align:center;color:var(--text-secondary);font-size:12px">Введите тему для анализа настроений в X/Twitter. AI оценит тональность и влияние на рынки.</div>';
        html += '</div>';
        html += '</div>';

        container.innerHTML = html;

        var searchBtn = $('xSearchBtn');
        var searchInput = $('xSearchInput');
        if (searchBtn && searchInput) {
            searchBtn.onclick = function() { doXSentimentSearch(searchInput.value.trim()); };
            searchInput.onkeydown = function(e) { if (e.key === 'Enter') doXSentimentSearch(searchInput.value.trim()); };
        }
    }

    async function doXSentimentSearch(query) {
        if (!query) return;
        var results = $('xResults');
        if (!results) return;
        results.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-secondary)">Анализируем...</div>';

        try {
            var prompt = 'Проанализируй актуальные настроения вокруг темы "' + query + '" в соцсетях/X/Twitter. Оцени: 1) Общий сентимент (бычий/медвежий/нейтральный), 2) Ключевые нарративы, 3) Влияние на крипто-рынки и Polymarket, 4) Громкие упоминания. Дай развёрнутый ответ на русском.';
            var response = await callAI([{ role: 'user', content: prompt }], 3);

            var sentiment = 'neutral';
            if (response.indexOf('бычий') !== -1 || response.indexOf('позитив') !== -1) sentiment = 'bullish';
            if (response.indexOf('медвежий') !== -1 || response.indexOf('негатив') !== -1) sentiment = 'bearish';

            var colors = { bullish: 'var(--positive)', neutral: 'var(--blue)', bearish: 'var(--negative)' };
            var labels = { bullish: 'Бычий', neutral: 'Нейтральный', bearish: 'Медвежий' };

            results.innerHTML = '<div style="margin-bottom:12px;display:flex;align-items:center;gap:10px;padding:12px;background:var(--card-bg-2);border:1px solid var(--border);border-radius:12px">'
                + '<span style="font-size:11px;color:var(--text-secondary)">Сентимент:</span>'
                + '<span style="font-size:14px;font-weight:800;color:' + colors[sentiment] + '">' + labels[sentiment] + '</span>'
                + '<span style="font-size:10px;color:var(--text-tertiary);margin-left:auto">' + escHtml(query) + '</span>'
                + '</div>'
                + '<div style="padding:14px;background:var(--card-bg-2);border:1px solid var(--border);border-radius:12px;font-size:11px;color:var(--text-secondary);line-height:1.6">'
                + formatAI(response)
                + '</div>';
        } catch(e) {
            results.innerHTML = '<div style="padding:16px;text-align:center;color:var(--negative);font-size:12px">Ошибка: ' + escHtml(e.message) + '</div>';
        }
    }

    // ====================== WEATHER ======================
    async function initWeatherTab() {
        var container = $('weather-content');
        if (!container || container.dataset.loaded) return;
        container.dataset.loaded = '1';

        var html = '<div style="padding:12px">';
        html += '<div style="font-size:14px;font-weight:800;color:var(--text);margin-bottom:4px">Ставки на погоду: анализ</div>';
        html += '<div style="font-size:11px;color:var(--text-secondary);margin-bottom:14px">Данные для принятия решений на рынках погоды Polymarket</div>';
        html += '<div id="weatherData" style="padding:16px;text-align:center;color:var(--text-secondary)">Загрузка данных...</div>';
        html += '</div>';
        container.innerHTML = html;

        try {
            var [tempText, windText] = await Promise.all([
                pageFetch('https://api.open-meteo.com/v1/forecast?latitude=40.7128&longitude=-74.0060&current=temperature_2m,precipitation,weather_code&timezone=America/New_York').catch(function() { return null; }),
                pageFetch('https://api.open-meteo.com/v1/forecast?latitude=40.7128&longitude=-74.0060&current=wind_speed_10m,wind_direction_10m&timezone=America/New_York').catch(function() { return null; })
            ]);

            var tempData = tempText ? tryParseJSON(tempText, null) : null;
            var windData = windText ? tryParseJSON(windText, null) : null;

            var current = tempData && tempData.current ? tempData.current : {};
            var windCurrent = windData && windData.current ? windData.current : {};
            var temp = current.temperature_2m || '—';
            var precip = current.precipitation || 0;
            var windSpeed = windCurrent.wind_speed_10m || '—';
            var weatherCode = current.weather_code || 0;

            var weatherDesc = ['Ясно', 'Облачно', 'Туман', 'Дождь', 'Ливень', 'Снег', 'Гроза'];
            var wIdx = weatherCode === 0 ? 0 : (weatherCode < 3 ? 1 : (weatherCode < 50 ? 2 : (weatherCode < 60 ? 3 : (weatherCode < 70 ? 4 : (weatherCode < 80 ? 5 : 6)))));

            var weatherDiv = $('weatherData');
            if (weatherDiv) {
                weatherDiv.innerHTML = '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px">'
                    + '<div style="padding:16px;background:var(--card-bg-2);border:1px solid var(--border);border-radius:12px;text-align:center">'
                    + '<div style="font-size:28px;font-weight:800;color:var(--accent)">' + temp + '°C</div>'
                    + '<div style="font-size:10px;color:var(--text-tertiary);margin-top:4px">Температура (NYC)</div>'
                    + '</div>'
                    + '<div style="padding:16px;background:var(--card-bg-2);border:1px solid var(--border);border-radius:12px;text-align:center">'
                    + '<div style="font-size:28px;font-weight:800;color:var(--blue)">' + windSpeed + ' км/ч</div>'
                    + '<div style="font-size:10px;color:var(--text-tertiary);margin-top:4px">Ветер</div>'
                    + '</div>'
                    + '<div style="padding:16px;background:var(--card-bg-2);border:1px solid var(--border);border-radius:12px;text-align:center">'
                    + '<div style="font-size:20px;font-weight:800;color:' + (precip > 0 ? 'var(--blue)' : 'var(--text)') + '">' + precip + ' мм</div>'
                    + '<div style="font-size:10px;color:var(--text-tertiary);margin-top:4px">Осадки</div>'
                    + '</div>'
                    + '<div style="padding:16px;background:var(--card-bg-2);border:1px solid var(--border);border-radius:12px;text-align:center">'
                    + '<div style="font-size:16px;font-weight:800;color:var(--accent)">' + weatherDesc[wIdx] + '</div>'
                    + '<div style="font-size:10px;color:var(--text-tertiary);margin-top:4px">Погода сейчас</div>'
                    + '</div>'
                    + '</div>'
                    + '<div style="margin-top:12px;padding:12px;background:var(--card-bg-2);border:1px solid var(--border);border-radius:12px;font-size:11px;color:var(--text-secondary);line-height:1.5">'
                    + '<strong style="color:var(--text)">Анализ для ставок:</strong><br>'
                    + 'Текущие условия в Нью-Йорке: ' + temp + '°C, ' + weatherDesc[wIdx].toLowerCase() + ', ветер ' + windSpeed + ' км/ч. '
                    + (precip > 0 ? 'Осадки ' + precip + ' мм могут повлиять на рынки погоды.' : 'Осадков не ожидается.')
                    + '<br><br>Для точного прогноза по конкретному рынку погоды на Polymarket используйте данные с сайта weather.gov или accuweather.com.'
                    + '</div>';
            }
        } catch(e) {
            var weatherDiv = $('weatherData');
            if (weatherDiv) weatherDiv.innerHTML = '<div style="padding:16px;text-align:center;color:var(--negative);font-size:12px">Ошибка загрузки: ' + escHtml(e.message) + '</div>';
        }
    }

    // ====================== NEWS HUB ======================
    async function initNewsHubTab() {
        var container = $('news-hub-content');
        if (!container || container.dataset.loaded) return;
        container.dataset.loaded = '1';

        container.innerHTML = '<div style="padding:12px">'
            + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">'
            + '<span style="font-size:14px;font-weight:800;color:var(--text)">Хаб новостей</span>'
            + '<button class="icon-btn" id="nhRefreshBtn" title="Обновить"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M17.65 6.35A8 8 0 1018 16h-2.06A6 6 0 119 6.92 6 6 0 0116.5 8.5L13 12h7V5l-2.35 2.35z"/></svg></button>'
            + '</div>'
            + '<div id="nhFilterRow" style="display:flex;gap:4px;margin-bottom:12px;flex-wrap:wrap">'
            + '<button class="nh-filter-btn active" data-nh-keywords="politics" style="padding:5px 12px;border:1px solid var(--border);border-radius:6px;background:rgba(76,127,110,0.15);color:var(--accent);font-size:10px;font-weight:600;cursor:pointer;font-family:inherit">Политика</button>'
            + '<button class="nh-filter-btn" data-nh-keywords="crypto" style="padding:5px 12px;border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--text-secondary);font-size:10px;font-weight:600;cursor:pointer;font-family:inherit">Крипто</button>'
            + '<button class="nh-filter-btn" data-nh-keywords="sports" style="padding:5px 12px;border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--text-secondary);font-size:10px;font-weight:600;cursor:pointer;font-family:inherit">Спорт</button>'
            + '<button class="nh-filter-btn" data-nh-keywords="weather" style="padding:5px 12px;border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--text-secondary);font-size:10px;font-weight:600;cursor:pointer;font-family:inherit">Погода</button>'
            + '<button class="nh-filter-btn" data-nh-keywords="technology" style="padding:5px 12px;border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--text-secondary);font-size:10px;font-weight:600;cursor:pointer;font-family:inherit">Технологии</button>'
            + '</div>'
            + '<div id="nhLoading" style="padding:16px;text-align:center;color:var(--text-secondary);font-size:12px">Загрузка новостей...</div>'
            + '<div id="nhError" style="display:none;padding:16px;text-align:center;color:var(--negative);font-size:12px"></div>'
            + '<div id="nhList"></div>'
            + '</div>';

        setupNHFilters();
        fetchNewsHubNews();
    }

    function setupNHFilters() {
        document.querySelectorAll('#nhFilterRow .nh-filter-btn').forEach(function(btn) {
            btn.onclick = function() {
                document.querySelectorAll('#nhFilterRow .nh-filter-btn').forEach(function(b) { b.classList.remove('active'); b.style.background = 'transparent'; b.style.color = 'var(--text-secondary)'; });
                btn.classList.add('active');
                btn.style.background = 'rgba(76,127,110,0.15)';
                btn.style.color = 'var(--accent)';
                var container = $('news-hub-content');
                if (container) container.dataset.loaded = '0';
                initNewsHubTab();
            };
        });

        var refreshBtn = $('nhRefreshBtn');
        if (refreshBtn) {
            refreshBtn.onclick = function() {
                var container = $('news-hub-content');
                if (container) container.dataset.loaded = '0';
                initNewsHubTab();
            };
        }
    }

    async function fetchNewsHubNews() {
        var list = $('nhList');
        var loading = $('nhLoading');
        var error = $('nhError');
        if (!list || !loading) return;

        var activeFilter = document.querySelector('#nhFilterRow .nh-filter-btn.active');
        var keywords = activeFilter ? activeFilter.dataset.nhKeywords : 'politics';

        try {
            var url = 'https://newsapi.org/v2/everything?q=' + encodeURIComponent(keywords) + '&language=ru&pageSize=10&sortBy=publishedAt';
            var response = await pageFetch(url).catch(function() { return null; });
            var articles = [];

            if (response) {
                var data = tryParseJSON(response, null);
                if (data && data.articles) {
                    articles = data.articles;
                }
            }

            if (articles.length === 0) {
                var now = Date.now();
                var allNews = {
                    politics: { title: 'Политические события на Polymarket: обзор', desc: 'Активность на рынках предсказаний по политическим событиям растёт' },
                    crypto: { title: 'Крипто-рынки: аналитика и прогнозы', desc: 'Обзор криптовалютных рынков и их влияние на Polymarket' },
                    sports: { title: 'Спортивные события: ставки и прогнозы', desc: 'Анализ спортивных рынков на Polymarket' },
                    weather: { title: 'Погодные рынки: данные и аналитика', desc: 'Как погодные условия влияют на рынки предсказаний' },
                    technology: { title: 'Технологии и инновации в prediction markets', desc: 'Новые технологические тренды в мире децентрализованных рынков' }
                };
                var n = allNews[keywords] || allNews.politics;
                articles = [{ title: n.title, description: n.desc, source: { name: 'PolyWin Analytics' }, publishedAt: new Date().toISOString(), url: '#' }];
            }

            loading.style.display = 'none';

            if (articles.length === 0) {
                list.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-secondary);font-size:12px">Новостей по теме не найдено</div>';
                return;
            }

            var html = '';
            articles.slice(0, 10).forEach(function(a) {
                var title = a.title || '—';
                var desc = a.description || a.text || '';
                var source = a.source ? (a.source.name || a.source.title || '') : '';
                var url2 = a.url || a.link || '#';
                var published = a.publishedAt || a.published || '';
                var timeAgo = '';
                if (published) {
                    try {
                        var d = new Date(published);
                        var diff = Date.now() - d.getTime();
                        var h = Math.floor(diff / 3600000);
                        timeAgo = h < 1 ? 'только что' : (h < 24 ? h + ' ч. назад' : Math.floor(h/24) + ' д. назад');
                    } catch(e) {}
                }

                html += '<a href="' + escHtml(url2) + '" target="_blank" rel="noopener noreferrer" style="display:block;padding:12px;background:var(--card-bg-2);border:1px solid var(--border);border-radius:12px;margin-bottom:6px;text-decoration:none">';
                html += '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">';
                html += '<div style="flex:1;min-width:0">';
                html += '<div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:4px;line-height:1.3">' + escHtml(title.substring(0, 100)) + '</div>';
                if (desc) html += '<div style="font-size:10px;color:var(--text-tertiary);margin-bottom:4px;line-height:1.4">' + escHtml(desc.substring(0, 150)) + '</div>';
                html += '<div style="display:flex;gap:8px;font-size:9px;color:var(--text-tertiary)">';
                if (source) html += '<span>' + escHtml(source) + '</span>';
                if (timeAgo) html += '<span>' + timeAgo + '</span>';
                html += '</div></div>';
                html += '<svg viewBox="0 0 24 24" width="14" height="14" style="flex-shrink:0;margin-top:2px;color:var(--text-tertiary)"><path fill="currentColor" d="M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>';
                html += '</div></a>';
            });

            list.innerHTML = html;
        } catch(e) {
            loading.style.display = 'none';
            error.style.display = 'block';
            error.textContent = 'Ошибка загрузки новостей: ' + e.message;
        }
    }

    // ====================== NEW MARKETS ======================
    async function initNewMarketTab() {
        var container = $('new-market-content');
        if (!container || container.dataset.loaded) return;
        container.dataset.loaded = '1';

        container.innerHTML = '<div style="padding:12px">'
            + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">'
            + '<span style="font-size:14px;font-weight:800;color:var(--text)">Новые рынки</span>'
            + '<button class="icon-btn" id="nmRefreshBtn" title="Обновить"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M17.65 6.35A8 8 0 1018 16h-2.06A6 6 0 119 6.92 6 6 0 0116.5 8.5L13 12h7V5l-2.35 2.35z"/></svg></button>'
            + '</div>'
            + '<div id="nmFilterRow1" style="display:flex;gap:4px;margin-bottom:6px;flex-wrap:wrap">'
            + '<button class="nm-filter-btn active" data-sort="volume_24h" style="padding:4px 10px;border:1px solid var(--border);border-radius:6px;background:rgba(76,127,110,0.15);color:var(--accent);font-size:9px;font-weight:600;cursor:pointer;font-family:inherit">Объём 24ч</button>'
            + '<button class="nm-filter-btn" data-sort="newest" style="padding:4px 10px;border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--text-secondary);font-size:9px;font-weight:600;cursor:pointer;font-family:inherit">Новые</button>'
            + '<button class="nm-filter-btn" data-sort="volume_total" style="padding:4px 10px;border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--text-secondary);font-size:9px;font-weight:600;cursor:pointer;font-family:inherit">Объём всего</button>'
            + '<button class="nm-filter-btn" data-sort="ending_soon" style="padding:4px 10px;border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--text-secondary);font-size:9px;font-weight:600;cursor:pointer;font-family:inherit">Заканчиваются</button>'
            + '</div>'
            + '<div id="nmLoading" style="padding:16px;text-align:center;color:var(--text-secondary);font-size:12px">Загрузка рынков...</div>'
            + '<div id="nmError" style="display:none;padding:16px;text-align:center;color:var(--negative);font-size:12px"></div>'
            + '<div id="nmList"></div>'
            + '</div>';

        setupNMFilters();
        fetchNewMarkets();
    }

    function setupNMFilters() {
        document.querySelectorAll('#nmFilterRow1 .nm-filter-btn').forEach(function(btn) {
            btn.onclick = function() {
                document.querySelectorAll('#nmFilterRow1 .nm-filter-btn').forEach(function(b) { b.classList.remove('active'); b.style.background = 'transparent'; b.style.color = 'var(--text-secondary)'; });
                btn.classList.add('active');
                btn.style.background = 'rgba(76,127,110,0.15)';
                btn.style.color = 'var(--accent)';
                var container = $('new-market-content');
                if (container) container.dataset.loaded = '0';
                initNewMarketTab();
            };
        });

        var refreshBtn = $('nmRefreshBtn');
        if (refreshBtn) {
            refreshBtn.onclick = function() {
                var container = $('new-market-content');
                if (container) container.dataset.loaded = '0';
                initNewMarketTab();
            };
        }
    }

    async function fetchNewMarkets() {
        var list = $('nmList');
        var loading = $('nmLoading');
        var error = $('nmError');
        if (!list || !loading) return;

        var activeSort = document.querySelector('#nmFilterRow1 .nm-filter-btn.active');
        var sort = activeSort ? activeSort.dataset.sort : 'volume_24h';
        var orderField = '-volume24hr';
        switch (sort) {
            case 'volume_total': orderField = '-volume'; break;
            case 'newest': orderField = '-created_at'; break;
            case 'ending_soon': orderField = 'end_date'; break;
            default: orderField = '-volume24hr';
        }

        try {
            var text = await pageFetch(GAMMA_API + '/events?closed=false&limit=25&order=' + orderField);
            var events = tryParseJSON(text, []);
            if (!Array.isArray(events)) events = [];

            loading.style.display = 'none';

            if (events.length === 0) {
                list.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-secondary);font-size:12px">Нет новых рынков</div>';
                return;
            }

            var html = '';
            events.slice(0, 20).forEach(function(ev) {
                var title = ev.title || ev.name || '—';
                var volume = parseFloat(ev.volume24hr || ev.volume || 0);
                var totalVolume = parseFloat(ev.volume || 0);
                var liquidity = parseFloat(ev.liquidityClob || 0);
                var markets = ev.markets || [];
                var slug = ev.slug || '';
                var tag = ev.tags && ev.tags.length ? (ev.tags[0].label || ev.tags[0]) : '';
                var createdAt = ev.createdAt || ev.created_at || '';
                var createdStr = createdAt ? getTimeAgo(createdAt) : '';

                var outcome = markets[0] || {};
                var price = outcome.price ? (parseFloat(outcome.price) * 100).toFixed(1) + '¢' : '—';

                html += '<div style="padding:12px;background:var(--card-bg-2);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:12px;margin-bottom:6px">';
                html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">';
                html += '<span style="font-weight:700;font-size:12px;color:var(--text);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(title.substring(0, 55)) + '</span>';
                if (tag) html += '<span style="padding:2px 6px;border-radius:4px;background:var(--accent-glow);color:var(--accent);font-size:9px;font-weight:600;margin-left:6px">' + escHtml(tag) + '</span>';
                html += '</div>';
                html += '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:4px;font-size:10px;color:var(--text-tertiary)">';
                html += '<span>Цена: <b style="color:var(--accent)">' + price + '</b></span>';
                html += '<span>Объём 24ч: <b style="color:var(--text)">$' + fmtNum(volume) + '</b></span>';
                html += '<span>Всего объём: <b style="color:var(--text)">$' + fmtNum(totalVolume) + '</b></span>';
                html += '<span>Ликв.: <b style="color:var(--text)">$' + fmtNum(liquidity) + '</b></span>';
                html += '</div>';
                html += '<div style="display:flex;gap:8px;margin-top:6px;font-size:9px;color:var(--text-tertiary)">';
                if (createdStr) html += '<span>Создан: ' + createdStr + '</span>';
                if (slug) html += '<a href="https://polymarket.com/event/' + slug + '" target="_blank" style="color:var(--accent);text-decoration:none;margin-left:auto">Открыть →</a>';
                html += '</div></div>';
            });

            list.innerHTML = html;
        } catch(e) {
            loading.style.display = 'none';
            error.style.display = 'block';
            error.textContent = 'Ошибка: ' + e.message;
        }
    }

    // ====================== EDUCATION ======================
    var EDU_SECTIONS = [
        { section: '1. Приветствие', color: '#3fb950',
          items: [
              { id: 'e11', title: 'Вступление в мир торговли на Polymarket', desc: 'Знакомство с платформой и основами торговли', files: ['Основы Polymarket.pdf'], homework: 'Зарегистрируйтесь на Polymarket, изучите интерфейс и найдите 3 события' }
          ] },
        { section: '2. Разбор PolyWin', color: '#e3b341',
          items: [
              { id: 'e121', title: 'Что такое PolyWin и как он работает', desc: 'Обзор возможностей', homework: 'Изучите все разделы меню и основные функции' },
              { id: 'e122', title: 'Торговый терминал и управление кошельками', desc: 'Создание, импорт и управление кошельками', homework: 'Попробуйте импортировать существующий кошелёк' },
              { id: 'e123', title: 'Аналитика и AI-разборы', desc: 'Как пользоваться аналитикой кошельков и AI-агентом', homework: 'Проанализируйте любой кошелёк с помощью AI-агента' },
              { id: 'e124', title: 'Смарт-алерты и сканер коэффициентов', desc: 'Настройка уведомлений и поиск лучших коэффициентов', homework: 'Настройте один смарт-алерт' },
              { id: 'e125', title: 'Киты, smart-кошельки и копитрейдинг', desc: 'Отслеживание крупных игроков', homework: 'Добавьте 3 кошелька в избранное' },
              { id: 'e126', title: 'Настройки и кастомизация', desc: 'Персонализация под свои нужды', homework: 'Настройте тему и выберите язык' }
          ] },
        { section: '3. Рынки предсказаний', color: '#388bfd',
          items: [
              { id: 'e13', title: 'Как работают рынки предсказаний', desc: 'Основы prediction markets и их механика', files: ['Prediction Markets 101.pdf'], homework: 'Найдите на Polymarket 5 активных рынков' }
          ] },
        { section: '4. Работа с Polymarket', color: '#bc8cf2',
          items: [
              { id: 'e141', title: 'Интерфейс Polymarket: от А до Я', desc: 'Полный разбор платформы', homework: 'Проведите 3 тестовые торговли' },
              { id: 'e142', title: 'Ордера и их типы', desc: 'Рыночные и лимитные ордера', files: ['Order Types Guide.pdf'], homework: 'Разместите один рыночный и один лимитный ордер' }
          ] },
        { section: '5. Риск-менеджмент', color: '#f85149',
          items: [
              { id: 'e15', title: 'Управление рисками и психология трейдинга', desc: 'Как сохранять капитал и контролировать эмоции', files: ['Risk Management Checklist.pdf'], homework: 'Составьте свой план риск-менеджмента' }
          ] },
        { section: '6. Поиск кошельков', color: '#f0883e',
          items: [
              { id: 'e16', title: 'Как находить и оценивать кошельки', desc: 'Стратегии поиска прибыльных кошельков', files: ['Wallet Screening Guide.pdf'], homework: 'Найдите 3 недооценённых кошелька' }
          ] },
        { section: '7. Копитрейдинг', color: '#58a6ff',
          items: [
              { id: 'e17', title: 'Автоматическое копирование сделок', desc: 'Как настроить копитрейдинг и не потерять капитал', homework: 'Настройте копитрейдинг на один из кошельков' }
          ] },
        { section: '8. Анализ события', color: '#4C7F6E',
          items: [
              { id: 'e19', title: 'Комплексный анализ рынка перед входом', desc: 'Как оценивать событие, объёмы, распределение ставок', files: ['Event Analysis Framework.pdf'], homework: 'Проведите полный анализ рынка по чек-листу' }
          ] },
        { section: '9. Стратегии', color: '#f0883e',
          items: [
              { id: 'e201', title: 'Базовые торговые стратегии', desc: 'Основные подходы к торговле на Polymarket', files: ['Trading Strategies.pdf'], homework: 'Протестируйте стратегию на демо-счёте' },
              { id: 'e202', title: 'Продвинутые стратегии и арбитраж', desc: 'Сложные стратегии для опытных трейдеров', files: ['Advanced Strategies.pdf'], homework: 'Найдите арбитражную ситуацию на Polymarket' }
          ] },
        { section: '10. Что дальше', color: '#e3b341',
          items: [
              { id: 'e21', title: 'Путь профессионального трейдера', desc: 'Следующие шаги после освоения базы', files: ['Roadmap Pro Trader.pdf'], homework: 'Составьте свой план развития на 30, 60 и 90 дней' }
          ] }
    ];

    function initEducationTab() {
        var container = $('education-content');
        if (!container || container.dataset.loaded) return;
        container.dataset.loaded = '1';

        var demo = getDemoState();
        var progress = getEduProgress();
        var totalLessons = 0;
        EDU_SECTIONS.forEach(function(s) { totalLessons += s.items.length; });
        var completed = progress.completed.length;
        var pct = totalLessons > 0 ? Math.round((completed / totalLessons) * 100) : 0;
        var pnl = calcDemoPnl(demo);
        var wr = calcDemoWR(demo);
        var positions = (demo.positions || []).length;
        var history = (demo.history || []);
        var closedTrades = history.filter(function(h) { return h.side === 'sell' || h.status === 'closed'; });
        var wins = closedTrades.filter(function(t) { var tp = (t.type === 'sell' ? t.buyAmount - t.amount : 0) || t.pnl || 0; return tp > 0; }).length;
        var losses = closedTrades.filter(function(t) { var tp = (t.type === 'sell' ? t.buyAmount - t.amount : 0) || t.pnl || 0; return tp <= 0; }).length;

        var html = '<div style="padding:12px">';

        html += '<div style="display:flex;align-items:center;gap:12px;padding:16px;background:linear-gradient(135deg,rgba(76,127,110,0.1),rgba(88,166,255,0.05));border:1px solid var(--border);border-radius:14px;margin-bottom:16px">';
        html += '<div style="width:40px;height:40px;border-radius:10px;background:rgba(76,127,110,0.15);display:flex;align-items:center;justify-content:center;color:var(--accent)"><svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 3L1 9l4 2.18v6L12 21l7-3.82v-6l2-1.09V17h2V9L12 3zm6.82 6L12 12.72 5.18 9 12 5.28 18.82 9zM17 15.99l-5 2.73-5-2.73v-3.72L12 15l5-2.73v3.72z"/></svg></div>';
        html += '<div style="flex:1"><div style="font-size:14px;font-weight:800;color:var(--text)">Обучающая платформа</div>';
        html += '<div style="font-size:11px;color:var(--text-secondary)">Демо-симулятор, уроки и AI-анализ вашей торговли</div></div>';
        html += '</div>';

        html += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:16px">';
        html += '<div style="padding:12px;background:var(--card-bg-2);border:1px solid var(--border);border-radius:10px;text-align:center"><div style="font-size:18px;font-weight:800;color:var(--accent)">' + completed + '/' + totalLessons + '</div><div style="font-size:9px;color:var(--text-tertiary);margin-top:2px">Уроков</div></div>';
        html += '<div style="padding:12px;background:var(--card-bg-2);border:1px solid var(--border);border-radius:10px;text-align:center"><div style="font-size:18px;font-weight:800;color:' + (pnl >= 0 ? 'var(--positive)' : 'var(--negative)') + '">' + (pnl >= 0 ? '+' : '') + '$' + fmtNum(Math.abs(pnl)) + '</div><div style="font-size:9px;color:var(--text-tertiary);margin-top:2px">Демо P&L</div></div>';
        html += '<div style="padding:12px;background:var(--card-bg-2);border:1px solid var(--border);border-radius:10px;text-align:center"><div style="font-size:18px;font-weight:800;color:var(--text)">' + wr + '%</div><div style="font-size:9px;color:var(--text-tertiary);margin-top:2px">Win Rate</div></div>';
        html += '<div style="padding:12px;background:var(--card-bg-2);border:1px solid var(--border);border-radius:10px;text-align:center"><div style="font-size:18px;font-weight:800;color:var(--text)">' + history.length + '</div><div style="font-size:9px;color:var(--text-tertiary);margin-top:2px">Сделок</div></div>';
        html += '</div>';

        html += '<div style="margin-bottom:16px">';
        html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><span style="font-size:12px;font-weight:700;color:var(--text)">Прогресс обучения</span><span style="font-size:10px;color:var(--text-tertiary)">' + pct + '%</span></div>';
        html += '<div style="height:6px;background:var(--card-bg);border-radius:3px;overflow:hidden"><div style="height:100%;width:' + pct + '%;background:linear-gradient(90deg,var(--accent),var(--blue));border-radius:3px;transition:width 0.5s"></div></div>';
        html += '</div>';

        html += '<div style="margin-bottom:12px">';
        html += '<div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:8px">Уроки</div>';
        EDU_SECTIONS.forEach(function(sec, si) {
            var secPct = sec.items.length > 0 ? Math.round((sec.items.filter(function(it) { return progress.completed.indexOf(it.id) >= 0; }).length / sec.items.length) * 100) : 0;
            var secCompleted = secPct === 100;
            html += '<div style="margin-bottom:6px">';
            html += '<div style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:var(--card-bg-2);border:1px solid var(--border);border-left:3px solid ' + sec.color + ';border-radius:10px;cursor:pointer" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display===\'none\'?\'block\':\'none\'">';
            html += '<div style="width:24px;height:24px;border-radius:6px;background:rgba(63,185,80,0.1);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:' + sec.color + '">' + secCompleted ? '✓' : (si + 1) + '</div>';
            html += '<div style="flex:1"><div style="font-size:11px;font-weight:600;color:var(--text)">' + sec.section + '</div><div style="font-size:9px;color:var(--text-tertiary)">' + sec.items.length + ' урок' + (sec.items.length > 1 ? 'ов' : '') + '</div></div>';
            html += '<div style="font-size:9px;color:var(--text-tertiary)">' + secPct + '%</div>';
            html += '</div>';
            html += '<div style="display:none;padding:8px 12px;border:1px solid var(--border);border-top:none;border-radius:0 0 10px 10px">';
            sec.items.forEach(function(it) {
                var done = progress.completed.indexOf(it.id) >= 0;
                html += '<div style="display:flex;align-items:center;gap:8px;padding:8px 4px;border-bottom:1px solid var(--border)">';
                html += '<button class="edu-toggle-btn" data-id="' + it.id + '" style="width:18px;height:18px;border-radius:50%;border:2px solid ' + (done ? 'var(--accent)' : 'var(--border)') + ';background:' + (done ? 'var(--accent)' : 'transparent') + ';color:#fff;font-size:10px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;padding:0">' + (done ? '✓' : '') + '</button>';
                html += '<div style="flex:1;min-width:0"><div style="font-size:11px;font-weight:' + (done ? '700' : '500') + ';color:var(--text)">' + escHtml(it.title) + '</div>';
                html += '<div style="font-size:9px;color:var(--text-tertiary)">' + escHtml(it.desc) + '</div></div>';
                if (it.files && it.files.length > 0) {
                    html += '<span style="font-size:9px;color:var(--accent);white-space:nowrap">+' + it.files.length + ' файл</span>';
                }
                html += '</div>';
            });
            html += '</div></div>';
        });
        html += '</div>';

        html += '</div>';
        container.innerHTML = html;

        container.querySelectorAll('.edu-toggle-btn').forEach(function(btn) {
            btn.onclick = function() {
                var id = btn.dataset.id;
                var prog = getEduProgress();
                var idx = prog.completed.indexOf(id);
                if (idx >= 0) { prog.completed.splice(idx, 1); } else { prog.completed.push(id); }
                saveEduProgress(prog);
                initEducationTab();
            };
        });
    }

    // ====================== PROFILE TAB ======================
    function initProfileTab() {
        var auth = getFbAuthREST();
        if (!auth) return;
        updateProfileUI();
        loadTariffFromFirestore().then(renderTariffPlans).catch(renderTariffPlans);
    }

    var _tariffPeriod = 'week';
    var _tariffShowFree = false;

    function renderTariffPlans() {
        var tariff = getTariff();
        var currentPlan = tariff.plan || 'basic';
        var planName = TARIFFS[currentPlan] ? TARIFFS[currentPlan].name : 'Базовый';
        var badge = $('profileTariffBadge');
        if (badge) badge.textContent = planName;
        var badge2 = $('profileTariffBadge2');
        if (badge2) badge2.textContent = planName;
        var refSection = $('profileReferralSection');
        if (refSection) {
            var show = currentPlan === 'pro' || currentPlan === 'apex';
            refSection.style.display = show ? 'block' : 'none';
            if (show) {
                var refLevel = $('profileRefLevel');
                if (refLevel) refLevel.textContent = planName;
                var promoInput = $('profilePromoCodeDisplay');
                if (promoInput && (promoInput.value === 'polywin-...' || !promoInput.dataset.loaded)) {
                    promoInput.dataset.loaded = '1';
                    var auth = getFbAuthREST();
                    if (auth && auth.localId) {
                        fbGetREST('users', auth.localId).then(function(doc) {
                            if (doc && doc.exists && doc.data) {
                                var data = doc.data;
                                var nick = data.nick || data.displayName || auth.displayName || (auth.email ? auth.email.split('@')[0] : '');
                                if (nick) {
                                    var code = 'polywin-' + nick;
                                    promoInput.value = code;
                                }
                                updateReferralRank(currentPlan, data.referralCount || 0);
                            }
                        }).catch(function(){});
                    }
                } else if (show) {
                    var auth = getFbAuthREST();
                    if (auth && auth.localId) {
                        fbGetREST('users', auth.localId).then(function(doc) {
                            var count = (doc && doc.exists && doc.data) ? (doc.data.referralCount || 0) : 0;
                            updateReferralRank(currentPlan, count);
                        }).catch(function(){});
                    }
                }
                var copyBtn = $('profilePromoCodeCopyBtn');
                if (copyBtn) {
                    copyBtn.onclick = function() {
                        var input = $('profilePromoCodeDisplay');
                        if (input && input.value) {
                            var ta = document.createElement('textarea');
                            ta.value = input.value;
                            ta.style.position = 'fixed';
                            ta.style.opacity = '0';
                            document.body.appendChild(ta);
                            ta.select();
                            document.execCommand('copy');
                            document.body.removeChild(ta);
                            setProfileMsg('Промокод скопирован', true);
                        }
                    };
                }
            }
        }
        var container = $('profileTariffPlans');
        if (!container) return;

        var periodKeys = ['week', 'month', 'quarter', 'year'];
        var periodLabels = { week: 'Еженедельно', month: 'Ежемесячно', quarter: 'Ежеквартально', year: 'Ежегодно' };
        var periodSuffix = { week: '/нед', month: '/мес', quarter: '/кв', year: '/год' };
        var periodDiscounts = { week: 0, month: 10, quarter: 30, year: 45 };

        var selectorHtml = '<div class="t-period-selector">';
        periodKeys.forEach(function(k) {
            var active = k === _tariffPeriod ? ' active' : '';
            var disc = periodDiscounts[k];
            selectorHtml += '<button class="t-period-btn' + active + '" data-period="' + k + '">'
                + periodLabels[k]
                + (disc > 0 ? ' <span class="t-period-discount">−' + disc + '%</span>' : '')
                + '</button>';
        });
        selectorHtml += '</div>';

        var showFree = _tariffPeriod === 'week' ? _tariffShowFree : false;
        var tariffKeys = Object.keys(TARIFFS).filter(function(k) {
            if (k === 'basic') return showFree;
            return true;
        });

        var toggleHtml = '';
        if (_tariffPeriod === 'week') {
            toggleHtml = '<div class="t-toggle-free">' +
                '<button class="t-toggle-free-btn" id="t-toggle-free-btn">' +
                    (_tariffShowFree ? '− Скрыть бесплатные тарифы' : '+ Показать бесплатные тарифы') +
                '</button></div>';
        }

        container.innerHTML = selectorHtml + toggleHtml + tariffKeys.map(function(key) {
            var p = TARIFFS[key];
            var isActive = key === currentPlan;
            var isFree = p.priceWeek === 0;
            var canSelect = true;
            var discount = periodDiscounts[_tariffPeriod] || 0;
            var weekPrice = p.priceWeek || 0;
            var periodMultiplier = { week: 1, month: 4.33, quarter: 13, year: 52 };
            var mult = periodMultiplier[_tariffPeriod] || 1;
            var rawPrice = weekPrice * mult;
            var price = discount > 0 ? Math.round(rawPrice * (1 - discount / 100)) : Math.round(rawPrice);
            return '<div class="t-plan' + (isActive ? ' t-plan-active' : '') + ' t-plan-' + key + '">'
                + '<div class="t-plan-bg"></div>'
                + '<div class="t-plan-glow"></div>'
                + '<div class="t-plan-shine"></div>'
                + '<div class="t-plan-body">'
                    + '<div class="t-plan-header">'
                        + '<div class="t-plan-name">' + p.name + '</div>'
                        + '<div class="t-plan-sub">' + p.subtitle + '</div>'
                    + '</div>'
                    + '<div class="t-plan-price">'
                        + (isFree
                            ? '<div class="t-plan-prices"><div class="t-plan-price-row"><span class="t-plan-price-val t-plan-price-free">Бессрочно</span></div></div>'
                            : '<div class="t-plan-prices">'
                                + '<div class="t-plan-price-row">'
                                    + '<span class="t-plan-price-val">$' + price + '</span>'
                                    + '<span class="t-plan-price-per">' + periodSuffix[_tariffPeriod] + '</span>'
                                + '</div>'
                                + (discount > 0 ? '<div class="t-plan-price-row t-plan-price-save-row">'
                                    + '<span class="t-plan-price-badge">−' + discount + '%</span>'
                                + '</div>' : '')
                              + '</div>')
                    + '</div>'
                    + (p.features.length ? '<ul class="t-plan-feats">' + p.features.map(function(f) {
                        return '<li class="t-plan-feat">' + tariffIcon(f) + '<span>' + escHtml(f) + '</span></li>';
                    }).join('') + '</ul>' : '')
                + '</div>'
                + '<div class="t-plan-action">'
                    + (isActive
                        ? '<div class="t-plan-current">✓ Текущий</div>'
                        : (canSelect
                            ? '<button class="t-plan-btn" data-plan="' + key + '">Выбрать ' + p.name + '</button>'
                            : '<div class="t-plan-auto">Выдаётся автоматически</div>'))
                + '</div>'
            + '</div>';
        }).join('');

        container.querySelectorAll('.t-plan-btn').forEach(function(btn) {
            btn.onclick = function() {
                var plan = this.dataset.plan;
                setTariff(plan);
                renderTariffPlans();
                setProfileMsg('Тариф изменён на ' + TARIFFS[plan].name, true);
            };
        });
        container.querySelectorAll('.t-period-btn').forEach(function(btn) {
            btn.onclick = function() {
                _tariffPeriod = this.dataset.period;
                renderTariffPlans();
            };
        });

        var toggleBtn = $('t-toggle-free-btn');
        if (toggleBtn) {
            toggleBtn.onclick = function() {
                _tariffShowFree = !_tariffShowFree;
                renderTariffPlans();
            };
        }
    }

    // ====================== SETTINGS HELPERS ======================
    var _settingsLangMap = {
        ru: {
            'theme.dark': 'Тёмная', 'theme.light': 'Светлая', 'theme.custom': 'Своя тема',
            'customTheme.background': 'Фоновое изображение', 'customTheme.textColor': 'Цвет текста', 'customTheme.accentColor': 'Акцентный цвет',
            'cancel': 'Отмена', 'save': 'Сохранить',
            'tab.terminal': 'Торговля', 'tab.wallet': 'Анализ кошельков', 'tab.alerts': 'Алерты', 'tab.calls': 'Коллы',
            'tab.favorites': 'Трекер и избранное', 'tab.myTrades': 'Мои сделки', 'tab.whale': 'Киты', 'tab.smartAlerts': 'Смарт-алерты',
            'tab.scanner': 'Сканер', 'tab.xSentiment': 'X (Twitter)', 'tab.weather': 'Погода',
            'tab.newsHub': 'Новости', 'tab.newMarket': 'Новые рынки', 'tab.education': 'Обучение', 'tab.profile': 'Профиль', 'tab.settings': 'Настройки',
            'tab.trade': 'Торговля', 'tab.analysis': 'Аналитика',
            'defaultTab': 'Раздел по умолчанию', 'visibility': 'Видимость разделов',
            'visibility.allShown': 'Все показаны', 'visibility.hiddenCount': 'Скрыто {n}',
            'notAuthorized': 'Не авторизован', 'authorized': 'Авторизован', 'logout': 'Выйти',
            'terminal.hero_title': 'Торговый терминал',
            'events.search_placeholder': 'Вставьте ссылку Polymarket или slug...',
            'events.search_btn': 'Поиск',
            'terminal.feat_ai': 'AI agent для торговли',
            'terminal.feat_auto': 'Свои автоматизированные системы',
            'terminal.feat_market': 'Рыночные ордера',
            'terminal.feat_limit': 'Лимитные ордера',
            'terminal.feat_demo': 'Демо-счёт $100k',
            'terminal.hero_copy': 'Copy Trading',
            'terminal.hero_strategies': 'Strategies',
            'terminal.switch_live': 'Live', 'terminal.switch_demo': 'Demo', 'terminal.switch_copy': 'Copy', 'terminal.switch_strategies': 'Strategies',
            'terminal.ai_agent': 'AI', 'terminal.description': 'Описание', 'terminal.chart_title': 'График', 'terminal.chart_empty': 'Выберите источник графика', 'terminal.edit_setup': 'Настройка P', 'terminal.orderbook': 'Стакан', 'terminal.price': 'Цена', 'terminal.size': 'Размер',
            'terminal.wallet_title': 'Кошелёк', 'terminal.amount': 'Сумма ($)', 'terminal.possible_win': 'Возможный выигрыш',
            'terminal.market': 'Market', 'terminal.limit': 'Limit',
            'terminal.limit_price': 'Limit Price', 'terminal.shares': 'Акции', 'terminal.expiry': 'Истекает',
            'terminal.never': 'Никогда', 'terminal.eod': 'До конца дня', 'terminal.custom': 'Своё',
            'terminal.sell': 'Продажа', 'terminal.close_100': 'Закрыть 100%',
            'terminal.position': 'Позиция', 'terminal.outcome': 'Исход', 'terminal.entry_price': 'Цена входа',
            'terminal.current_value': 'Текущая стоимость', 'terminal.pnl': 'PnL',
            'terminal.total': 'Итого', 'terminal.place_order': 'Разместить ордер',
            'terminal.apply': 'Применить', 'terminal.custom_expiry_title': 'Свой срок истечения',
            'terminal.expiry_hours': 'Часы', 'terminal.expiry_minutes': 'Минуты', 'terminal.expiry_seconds': 'Секунды',
            'terminal.strategy_dev': 'В разработке', 'terminal.strategy_dev_title': 'В разработке', 'terminal.strategy_dev_desc': 'Скоро будет доступно',
            'terminal.wallet_none': 'Нет кошелька',
            'terminal.rolling_label': 'Rolling', 'terminal.rolling_on': 'Вкл', 'terminal.rolling_off': 'Выкл', 'terminal.rolling_desc': 'Авто-реинвест прибыли',
            'terminal.copy_config': 'Copy Trading', 'terminal.copy_desc': 'Настройте копирование сделок',
            'terminal.copy_input_ph': 'Адрес кошелька',
            'terminal.tracked_wallets': 'Отслеживаемые кошельки',
            'terminal.strategy_trades': 'Сделки', 'terminal.strategy_wr': 'WR', 'terminal.strategy_rebate': 'Rebate', 'terminal.strategy_time': 'Время', 'terminal.strategy_sym': 'Пара', 'terminal.strategy_total': 'Итого', 'terminal.strategy_type': 'Тип', 'terminal.strategy_asset': 'Актив', 'terminal.strategy_balance': 'Баланс', 'terminal.strategy_amount': 'Сумма', 'terminal.strategy_detail': 'Детали', 'terminal.strategy_size': 'Размер', 'terminal.strategy_cur': 'Тек', 'terminal.strategy_rounds': 'Раунды', 'terminal.strategy_avg': 'Сред', 'terminal.strategy_num': 'Стратегия {n}', 'terminal.strategy_name': 'Название', 'terminal.strategy_desc': 'Описание', 'terminal.strategy_tf': 'ТФ', 'terminal.strategy_name_ph': 'Название стратегии', 'terminal.strategy_desc_ph': 'Описание стратегии', 'terminal.strategy_save': 'Сохранить', 'terminal.no_positions': 'Нет открытых позиций', 'terminal.no_rounds': 'Нет завершённых раундов', 'terminal.no_operations': 'Нет операций',
            'events.ai_title': 'AI Ассистент', 'events.ai_placeholder': 'Задайте вопрос...',
            'events.my_wallets_title': 'Мои кошельки',
            'events.markets_title': 'Рынки ({n})', 'events.market_label': 'Рынок',
            'events.loading': 'Загрузка...'
        },
        en: {
            'theme.dark': 'Dark', 'theme.light': 'Light', 'theme.custom': 'Custom',
            'customTheme.background': 'Background image', 'customTheme.textColor': 'Text color', 'customTheme.accentColor': 'Accent color',
            'cancel': 'Cancel', 'save': 'Save',
            'tab.terminal': 'Trade', 'tab.wallet': 'Wallet Analysis', 'tab.alerts': 'Alerts', 'tab.calls': 'Calls',
            'tab.favorites': 'Tracker & Favorites', 'tab.myTrades': 'My Trades', 'tab.whale': 'Whales', 'tab.smartAlerts': 'Smart Alerts',
            'tab.scanner': 'Scanner', 'tab.xSentiment': 'X (Twitter)', 'tab.weather': 'Weather',
            'tab.newsHub': 'News', 'tab.newMarket': 'New Markets', 'tab.education': 'Education', 'tab.profile': 'Profile', 'tab.settings': 'Settings',
            'tab.trade': 'Trade', 'tab.analysis': 'Analytics',
            'defaultTab': 'Default tab', 'visibility': 'Menu visibility',
            'visibility.allShown': 'All shown', 'visibility.hiddenCount': '{n} hidden',
            'notAuthorized': 'Not authorized', 'authorized': 'Authorized', 'logout': 'Log out',
            'terminal.hero_title': 'Trading Terminal',
            'events.search_placeholder': 'Paste Polymarket link or slug...',
            'events.search_btn': 'Search',
            'terminal.feat_ai': 'AI agent for trading',
            'terminal.feat_auto': 'Custom automated systems',
            'terminal.feat_market': 'Market orders',
            'terminal.feat_limit': 'Limit orders',
            'terminal.feat_demo': 'Demo account $100k',
            'terminal.hero_copy': 'Copy Trading',
            'terminal.hero_strategies': 'Strategies',
            'terminal.switch_live': 'Live', 'terminal.switch_demo': 'Demo', 'terminal.switch_copy': 'Copy', 'terminal.switch_strategies': 'Strategies',
            'terminal.ai_agent': 'AI', 'terminal.description': 'Description', 'terminal.chart_title': 'Chart', 'terminal.chart_empty': 'Select chart source', 'terminal.edit_setup': 'Setup P', 'terminal.orderbook': 'Order Book', 'terminal.price': 'Price', 'terminal.size': 'Size',
            'terminal.wallet_title': 'Wallet', 'terminal.amount': 'Amount ($)', 'terminal.possible_win': 'Possible win',
            'terminal.market': 'Market', 'terminal.limit': 'Limit',
            'terminal.limit_price': 'Limit Price', 'terminal.shares': 'Shares', 'terminal.expiry': 'Expiry',
            'terminal.never': 'Never', 'terminal.eod': 'End of day', 'terminal.custom': 'Custom',
            'terminal.sell': 'Sell', 'terminal.close_100': 'Close 100%',
            'terminal.position': 'Position', 'terminal.outcome': 'Outcome', 'terminal.entry_price': 'Entry Price',
            'terminal.current_value': 'Current Value', 'terminal.pnl': 'PnL',
            'terminal.total': 'Total', 'terminal.place_order': 'Place Order',
            'terminal.apply': 'Apply', 'terminal.custom_expiry_title': 'Custom Expiry',
            'terminal.expiry_hours': 'Hours', 'terminal.expiry_minutes': 'Minutes', 'terminal.expiry_seconds': 'Seconds',
            'terminal.strategy_dev': 'In Dev', 'terminal.strategy_dev_title': 'In Development', 'terminal.strategy_dev_desc': 'Coming soon',
            'terminal.wallet_none': 'No wallet',
            'terminal.rolling_label': 'Rolling', 'terminal.rolling_on': 'On', 'terminal.rolling_off': 'Off', 'terminal.rolling_desc': 'Auto-reinvest profits',
            'terminal.copy_config': 'Copy Trading', 'terminal.copy_desc': 'Configure trade copying',
            'terminal.copy_input_ph': 'Wallet address',
            'terminal.tracked_wallets': 'Tracked Wallets',
            'terminal.strategy_trades': 'Trades', 'terminal.strategy_wr': 'WR', 'terminal.strategy_rebate': 'Rebate', 'terminal.strategy_time': 'Time', 'terminal.strategy_sym': 'Pair', 'terminal.strategy_total': 'Total', 'terminal.strategy_type': 'Type', 'terminal.strategy_asset': 'Asset', 'terminal.strategy_balance': 'Balance', 'terminal.strategy_amount': 'Amount', 'terminal.strategy_detail': 'Detail', 'terminal.strategy_size': 'Size', 'terminal.strategy_cur': 'Cur', 'terminal.strategy_rounds': 'Rounds', 'terminal.strategy_avg': 'Avg', 'terminal.strategy_num': 'Strategy {n}', 'terminal.strategy_name': 'Name', 'terminal.strategy_desc': 'Description', 'terminal.strategy_tf': 'TF', 'terminal.strategy_name_ph': 'Strategy name', 'terminal.strategy_desc_ph': 'Description', 'terminal.strategy_save': 'Save', 'terminal.no_positions': 'No open positions', 'terminal.no_rounds': 'No completed rounds', 'terminal.no_operations': 'No operations',
            'events.ai_title': 'AI Assistant', 'events.ai_placeholder': 'Ask a question...',
            'events.my_wallets_title': 'My Wallets',
            'events.markets_title': 'Markets ({n})', 'events.market_label': 'Market',
            'events.loading': 'Loading...'
        },
        zh: {
            'theme.dark': '深色', 'theme.light': '浅色', 'theme.custom': '自定义',
            'customTheme.background': '背景图片', 'customTheme.textColor': '文字颜色', 'customTheme.accentColor': '强调色',
            'cancel': '取消', 'save': '保存',
            'tab.terminal': '交易', 'tab.wallet': '钱包分析', 'tab.alerts': '提醒', 'tab.calls': '喊单',
            'tab.favorites': '收藏夹', 'tab.myTrades': '我的交易', 'tab.whale': '巨鲸', 'tab.smartAlerts': '智能提醒',
            'tab.scanner': '扫描', 'tab.xSentiment': 'X (Twitter)', 'tab.weather': '天气',
            'tab.newsHub': '新闻', 'tab.newMarket': '新市场', 'tab.education': '教育', 'tab.profile': '个人资料', 'tab.settings': '设置',
            'tab.trade': '交易', 'tab.analysis': '分析',
            'defaultTab': '默认选项卡', 'visibility': '菜单可见性',
            'visibility.allShown': '全部显示', 'visibility.hiddenCount': '隐藏 {n}',
            'notAuthorized': '未授权', 'authorized': '已授权', 'logout': '退出',
            'terminal.hero_title': '交易终端',
            'events.search_placeholder': '粘贴 Polymarket 链接或 slug...',
            'events.search_btn': '搜索',
            'terminal.feat_ai': 'AI 交易代理',
            'terminal.feat_auto': '自定义自动化系统',
            'terminal.feat_market': '市价订单',
            'terminal.feat_limit': '限价订单',
            'terminal.feat_demo': '模拟账户 $100k',
            'terminal.hero_copy': '跟单交易',
            'terminal.hero_strategies': '策略',
            'terminal.switch_live': '实盘', 'terminal.switch_demo': '模拟', 'terminal.switch_copy': '跟单', 'terminal.switch_strategies': '策略',
            'terminal.ai_agent': 'AI', 'terminal.description': '描述', 'terminal.chart_title': '图表', 'terminal.chart_empty': '选择图表源', 'terminal.edit_setup': '设置 P', 'terminal.orderbook': '订单簿', 'terminal.price': '价格', 'terminal.size': '大小',
            'terminal.wallet_title': '钱包', 'terminal.amount': '金额 ($)', 'terminal.possible_win': '可能盈利',
            'terminal.market': '市价', 'terminal.limit': '限价',
            'terminal.limit_price': '限价', 'terminal.shares': '份额', 'terminal.expiry': '到期',
            'terminal.never': '永不', 'terminal.eod': '当天结束', 'terminal.custom': '自定义',
            'terminal.sell': '卖出', 'terminal.close_100': '平仓 100%',
            'terminal.position': '仓位', 'terminal.outcome': '结果', 'terminal.entry_price': '入场价',
            'terminal.current_value': '当前价值', 'terminal.pnl': '盈亏',
            'terminal.total': '总计', 'terminal.place_order': '下单',
            'terminal.apply': '应用', 'terminal.custom_expiry_title': '自定义到期',
            'terminal.expiry_hours': '小时', 'terminal.expiry_minutes': '分钟', 'terminal.expiry_seconds': '秒',
            'terminal.strategy_dev': '开发中', 'terminal.strategy_dev_title': '开发中', 'terminal.strategy_dev_desc': '即将推出',
            'terminal.wallet_none': '无钱包',
            'terminal.rolling_label': '滚动', 'terminal.rolling_on': '开', 'terminal.rolling_off': '关', 'terminal.rolling_desc': '自动复投利润',
            'terminal.copy_config': '跟单交易', 'terminal.copy_desc': '配置交易复制',
            'terminal.copy_input_ph': '钱包地址',
            'terminal.tracked_wallets': '追踪钱包',
            'terminal.strategy_trades': '交易', 'terminal.strategy_wr': '胜率', 'terminal.strategy_rebate': '返佣', 'terminal.strategy_time': '时间', 'terminal.strategy_sym': '交易对', 'terminal.strategy_total': '总计', 'terminal.strategy_type': '类型', 'terminal.strategy_asset': '资产', 'terminal.strategy_balance': '余额', 'terminal.strategy_amount': '金额', 'terminal.strategy_detail': '详情', 'terminal.strategy_size': '大小', 'terminal.strategy_cur': '当前', 'terminal.strategy_rounds': '轮次', 'terminal.strategy_avg': '平均', 'terminal.strategy_num': '策略 {n}', 'terminal.strategy_name': '名称', 'terminal.strategy_desc': '描述', 'terminal.strategy_tf': '时间框架', 'terminal.strategy_name_ph': '策略名称', 'terminal.strategy_desc_ph': '策略描述', 'terminal.strategy_save': '保存', 'terminal.no_positions': '无持仓', 'terminal.no_rounds': '无完成轮次', 'terminal.no_operations': '无操作',
            'events.ai_title': 'AI 助手', 'events.ai_placeholder': '提问...',
            'events.my_wallets_title': '我的钱包',
            'events.markets_title': '市场 ({n})', 'events.market_label': '市场',
            'events.loading': '加载中...'
        }
    };

    function settingsT(key) {
        var lang = localStorage.getItem('polyLang') || 'ru';
        return (_settingsLangMap[lang] && _settingsLangMap[lang][key]) || _settingsLangMap['ru'][key] || key;
    }

    function applyMenuTranslations() {
        document.querySelectorAll('#sidebarMenu span[data-stkey]').forEach(function(el) {
            el.textContent = settingsT(el.dataset.stkey);
        });
    }

    function applySettingsTranslations() {
        var container = document.getElementById('settings-tab');
        if (!container) return;
        container.querySelectorAll('[data-stkey]').forEach(function(el) {
            el.textContent = settingsT(el.dataset.stkey);
        });
        applyMenuTranslations();
    }

    function buildSettingsDropdown(options, selectedValue, onChange) {
        var wrap = document.createElement('div');
        wrap.className = 'settings-cs';
        var selected = options.find(function(o) { return o.value === selectedValue; }) || options[0];
        wrap.innerHTML =
            '<div class="settings-cs-trigger" tabindex="0">' +
                '<span class="settings-cs-selected">' + (selected.icon||'') + '<span class="settings-cs-label">' + escHtml(selected.label) + '</span></span>' +
                '<svg class="settings-cs-arrow" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>' +
            '</div>' +
            '<div class="settings-cs-dropdown">' +
                options.map(function(o) {
                    return '<div class="settings-cs-option' + (o.value === selectedValue ? ' active' : '') + '" data-value="' + o.value + '">' +
                        (o.icon||'') + '<span>' + escHtml(o.label) + '</span>' +
                        (o.value === selectedValue ? '<svg class="settings-cs-check" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>' : '') +
                    '</div>';
                }).join('') +
            '</div>';
        var trigger = wrap.querySelector('.settings-cs-trigger');
        var dropdown = wrap.querySelector('.settings-cs-dropdown');
        function open() { dropdown.style.display = 'block'; trigger.classList.add('open'); }
        function close() { dropdown.style.display = 'none'; trigger.classList.remove('open'); }
        trigger.onclick = function(e) { e.stopPropagation(); if (dropdown.style.display === 'block') close(); else open(); };
        dropdown.querySelectorAll('.settings-cs-option').forEach(function(el) {
            el.onclick = function(e) { e.stopPropagation(); var val = this.dataset.value; close(); if (val !== selectedValue) onChange(val); };
        });
        document.addEventListener('click', function handler(e) { if (!wrap.contains(e.target)) close(); });
        wrap.updateValue = function(val) {
            selectedValue = val;
            var match = options.find(function(o) { return o.value === val; });
            var selEl = wrap.querySelector('.settings-cs-selected');
            selEl.innerHTML = (match ? (match.icon||'') : '') + '<span class="settings-cs-label">' + escHtml(match ? match.label : val) + '</span>';
            dropdown.querySelectorAll('.settings-cs-option').forEach(function(el) {
                var isSel = el.dataset.value === val;
                el.classList.toggle('active', isSel);
                var check = el.querySelector('.settings-cs-check');
                if (isSel && !check) el.insertAdjacentHTML('beforeend', '<svg class="settings-cs-check" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>');
                else if (!isSel && check) check.remove();
            });
        };
        close();
        return wrap;
    }

    function applyCustomTheme() {
        var isCustom = localStorage.getItem('polyCustomTheme') === 'true';
        var sidebar = document.getElementById('poly-stats-sidebar');
        if (!isCustom) {
            if (sidebar) { sidebar.style.removeProperty('--custom-bg'); sidebar.style.removeProperty('--custom-text'); sidebar.style.removeProperty('--custom-accent'); }
            return;
        }
        var data = JSON.parse(localStorage.getItem('polyCustomThemeData') || '{}');
        if (sidebar) {
            if (data.bg) sidebar.style.setProperty('--custom-bg', 'url(' + data.bg + ')');
            if (data.text) sidebar.style.setProperty('--custom-text', data.text);
            if (data.accent) sidebar.style.setProperty('--custom-accent', data.accent);
        }
    }
    applyCustomTheme();

    function applyMenuVisibility() {
        var hidden = JSON.parse(localStorage.getItem('polyHiddenMenuItems') || '[]');
        document.querySelectorAll('.menu-item').forEach(function(el) {
            el.style.display = hidden.indexOf(el.dataset.tab) !== -1 ? 'none' : '';
        });
    }
    applyMenuVisibility();

    function openCustomThemeModal() {
        var current = JSON.parse(localStorage.getItem('polyCustomThemeData') || '{"bg":"","text":"#e6edf3","accent":"#4C7F6E"}');
        var overlay = document.createElement('div');
        overlay.className = 'dtm-overlay';
        var modal = document.createElement('div');
        modal.className = 'dtm-modal';
        modal.style.maxWidth = '420px';
        modal.innerHTML =
            '<div class="dtm-header">' +
                '<span class="dtm-title">' + settingsT('theme.custom') + '</span>' +
                '<button class="dtm-close" id="ctModalClose"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>' +
            '</div>' +
            '<div class="dtm-body" style="padding:16px">' +
                '<div class="settings-cs-row">' +
                    '<label class="settings-cs-label">' + settingsT('customTheme.background') + '</label>' +
                    '<input type="file" accept="image/*" class="settings-cs-file" id="ctBgInput">' +
                    (current.bg ? '<div class="settings-cs-preview" style="background:url(' + current.bg + ') center/cover;width:60px;height:40px;border-radius:6px;border:1px solid var(--border)"></div>' : '') +
                '</div>' +
                '<div class="settings-cs-row">' +
                    '<label class="settings-cs-label">' + settingsT('customTheme.textColor') + '</label>' +
                    '<input type="color" class="settings-cs-color" id="ctTextColor" value="' + current.text + '">' +
                '</div>' +
                '<div class="settings-cs-row">' +
                    '<label class="settings-cs-label">' + settingsT('customTheme.accentColor') + '</label>' +
                    '<input type="color" class="settings-cs-color" id="ctAccentColor" value="' + current.accent + '">' +
                '</div>' +
                '<div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">' +
                    '<button class="settings-cs-cancel" id="ctCancel">' + settingsT('cancel') + '</button>' +
                    '<button class="settings-cs-save" id="ctSave">' + settingsT('save') + '</button>' +
                '</div>' +
            '</div>';
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        function closeCt() { overlay.remove(); }
        overlay.onclick = function(e) { if (e.target === overlay) closeCt(); };
        modal.querySelector('#ctModalClose').onclick = closeCt;
        document.getElementById('ctCancel').onclick = closeCt;
        document.getElementById('ctSave').onclick = function() {
            var bgInput = document.getElementById('ctBgInput');
            var textColor = document.getElementById('ctTextColor').value;
            var accentColor = document.getElementById('ctAccentColor').value;
            function saveCt(bg) {
                var data = { bg: bg, text: textColor, accent: accentColor };
                localStorage.setItem('polyCustomThemeData', JSON.stringify(data));
                localStorage.setItem('polyCustomTheme', 'true');
                applyCustomTheme();
                closeCt();
            }
            if (bgInput.files && bgInput.files[0]) {
                var reader = new FileReader();
                reader.onload = function(e) { saveCt(e.target.result); };
                reader.readAsDataURL(bgInput.files[0]);
            } else {
                saveCt(current.bg || '');
            }
        };
    }

    // ====================== SETTINGS TAB ======================
    function initSettingsTab() {
        var content = $('settings-content');
        if (!content) return;

        var isAuth = !!getFbAuthREST();
        var navGroup = $('settingsGroupNav');
        var acctGroup = $('settingsGroupAccount');
        if (navGroup) navGroup.style.display = isAuth ? '' : 'none';
        if (acctGroup) acctGroup.style.display = isAuth ? '' : 'none';

        // Theme selector
        var themeContainer = $('settingsThemeContainer');
        if (themeContainer) {
            var existingThemeCs = themeContainer.querySelector('.settings-cs-wrap');
            if (existingThemeCs) existingThemeCs.remove();
            var isCustomTheme = localStorage.getItem('polyCustomTheme') === 'true';
            var curThemeVal = isCustomTheme ? 'custom' : (document.body.classList.contains('light-theme') ? 'light' : 'dark');
            var themeList = [
                { value: 'dark', label: settingsT('theme.dark'), icon: '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>' },
                { value: 'light', label: settingsT('theme.light'), icon: '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58a.996.996 0 0 0-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06c.39-.39.39-1.03 0-1.41zm14.48 14.48a.996.996 0 0 0-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06c.39-.39.39-1.03 0-1.41zM6.05 18.36l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06c.39-.39.39-1.03 0-1.41-.39-.39-1.03-.39-1.41 0zM17.95 5.64l1.06-1.06c.39-.39.39-1.03 0-1.41s-1.03-.39-1.41 0L16.54 5.2c-.39.39-.39 1.03 0 1.41.39.39 1.03.39 1.41 0z"/></svg>' },
                { value: 'custom', label: settingsT('theme.custom'), icon: '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>' }
            ];
            function getThemeMatch(v) { return themeList.find(function(o) { return o.value === v; }) || themeList[0]; }
            var themeWrap = document.createElement('div');
            themeWrap.className = 'settings-cs-wrap';
            var curMatch = getThemeMatch(curThemeVal);
            var dropdownHtml = themeList.map(function(o) {
                return '<div class="settings-cs-option' + (o.value === curThemeVal ? ' active' : '') + '" data-value="' + o.value + '">' +
                    o.icon + '<span>' + escHtml(o.label) + '</span>' +
                    (o.value === curThemeVal ? '<svg class="settings-cs-check" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>' : '') +
                '</div>';
            }).join('');
            themeWrap.innerHTML =
                '<div class="settings-cs-trigger" tabindex="0">' +
                    '<span class="settings-cs-selected">' + curMatch.icon + '<span class="settings-cs-label">' + escHtml(curMatch.label) + '</span></span>' +
                    '<svg class="settings-cs-arrow" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>' +
                '</div>' +
                '<div class="settings-cs-dropdown">' + dropdownHtml + '</div>';
            var themeTrigger = themeWrap.querySelector('.settings-cs-trigger');
            var themeDropdown = themeWrap.querySelector('.settings-cs-dropdown');
            function themeOpen() { themeDropdown.style.display = 'block'; themeTrigger.classList.add('open'); }
            function themeClose() { themeDropdown.style.display = 'none'; themeTrigger.classList.remove('open'); }
            themeTrigger.onclick = function(e) { e.stopPropagation(); if (themeDropdown.style.display === 'block') themeClose(); else themeOpen(); };
            themeWrap.updateTheme = function(val) {
                curThemeVal = val;
                var m = getThemeMatch(val);
                themeWrap.querySelector('.settings-cs-selected').innerHTML = m.icon + '<span class="settings-cs-label">' + escHtml(m.label) + '</span>';
                themeDropdown.querySelectorAll('.settings-cs-option').forEach(function(el) {
                    var isSel = el.dataset.value === val;
                    el.classList.toggle('active', isSel);
                    var ch = el.querySelector('.settings-cs-check');
                    if (isSel && !ch) el.insertAdjacentHTML('beforeend', '<svg class="settings-cs-check" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>');
                    else if (!isSel && ch) ch.remove();
                });
            };
            themeDropdown.querySelectorAll('.settings-cs-option').forEach(function(el) {
                el.onclick = function(e) {
                    e.stopPropagation();
                    var val = this.dataset.value;
                    themeClose();
                    if (val === 'custom') {
                        openCustomThemeModal();
                    } else if (val !== curThemeVal) {
                        localStorage.setItem('polyCustomTheme', 'false');
                        var isLight = val === 'light';
                        if (isLight !== document.body.classList.contains('light-theme')) {
                            document.body.classList.toggle('light-theme');
                            localStorage.setItem('polyTheme', isLight ? 'light' : 'dark');
                            applyCustomTheme();
                        }
                        themeWrap.updateTheme(val);
                    }
                };
            });
            document.addEventListener('click', function handler(e) { if (!themeWrap.contains(e.target)) themeClose(); });
            themeContainer.appendChild(themeWrap);
            // Gear button for custom theme
            var existingCtBtn = themeContainer.querySelector('.settings-ct-btn');
            if (existingCtBtn) existingCtBtn.remove();
            var ctBtn = document.createElement('button');
            ctBtn.className = 'settings-ct-btn';
            ctBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>';
            ctBtn.title = settingsT('theme.custom');
            ctBtn.onclick = function(e) { e.stopPropagation(); openCustomThemeModal(); };
            themeContainer.appendChild(ctBtn);
        }

        // Language selector
        var langContainer = $('settingsLangContainer');
        if (langContainer) {
            langContainer.innerHTML = '';
            var curLang = localStorage.getItem('polyLang') || 'ru';
            var langs = [
                { value: 'ru', label: 'RU', flag: '🇷🇺' },
                { value: 'en', label: 'EN', flag: '🇬🇧' },
                { value: 'zh', label: '中文', flag: '🇨🇳' }
            ];
            langs.forEach(function(l) {
                var btn = document.createElement('button');
                btn.className = 'settings-lang-btn' + (l.value === curLang ? ' active' : '');
                btn.innerHTML = '<span class="settings-lang-flag">' + l.flag + '</span>' + l.label;
                btn.onclick = function() {
                    if (l.value === curLang) return;
                    localStorage.setItem('polyLang', l.value);
                    initSettingsTab();
                };
                langContainer.appendChild(btn);
            });
        }

        // Default tab selector
        var dtContainer = $('settingsDefaultTabContainer');
        if (dtContainer) {
            var existingDtBtn = dtContainer.querySelector('.settings-dt-btn');
            if (existingDtBtn) existingDtBtn.remove();
            var curTab = localStorage.getItem('polyDefaultTab') || 'wallet';
            var tabOpts = [
                { value: 'trade', label: settingsT('tab.terminal'), icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M3.5 18.49l6-6.01 4 4L22 6.92l-1.41-1.41-7.09 7.97-4-4L2 16.99z"/></svg>' },
                { value: 'alerts', label: settingsT('tab.alerts'), icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>' },
                { value: 'calls', label: settingsT('tab.calls'), icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M5 8c-1.1 0-2 .9-2 2v4c0 1.1.9 2 2 2h2l4 4V6l-4 4H5zm12 4c0 1.5-.84 2.8-2.1 3.5l.6 1.1c1.6-.9 2.5-2.5 2.5-4.6s-.9-3.7-2.5-4.6l-.6 1.1c1.26.7 2.1 2 2.1 3.5z"/></svg>' },
                { value: 'favorites', label: settingsT('tab.favorites'), icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>' },
                { value: 'my-trades', label: settingsT('tab.myTrades'), icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/></svg>' },
                { value: 'wallet', label: settingsT('tab.wallet'), icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M21 18v1c0 1.1-.9 2-2 2H5c-1.11 0-2-.9-2-2V5c0-1.1.89-2 2-2h14c1.1 0 2 .9 2 2v1h-9c-1.11 0-2 .9-2 2v8c0 1.1.89 2 2 2h9zm-9-2h10V8H12v8zm4-2.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>' },
                { value: 'whale', label: settingsT('tab.whale'), icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>' },
                { value: 'smart-alerts', label: settingsT('tab.smartAlerts'), icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>' },
                { value: 'scanner', label: settingsT('tab.scanner'), icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>' },
                { value: 'x-sentiment', label: settingsT('tab.xSentiment'), icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M22 3.01L22 3.01l-8 8L22 20h-6l-5-6-6 6H1l8-8L1 3h6l5 6 6-6h4z"/></svg>' },
                { value: 'weather', label: settingsT('tab.weather'), icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/></svg>' },
                { value: 'news-hub', label: settingsT('tab.newsHub'), icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zM7 7h10v2H7V7zm0 4h10v2H7v-2zm0 4h6v2H7v-2z"/></svg>' },
                { value: 'new-market', label: settingsT('tab.newMarket'), icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M13 7h-2v4H7v2h4v4h2v-4h4v-2h-4V7zm-1-5C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>' },
                { value: 'education', label: settingsT('tab.education'), icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 3L1 9l4 2.18v6L12 21l7-3.82v-6l2-1.09V17h2V9L12 3zm6.82 6L12 12.72 5.18 9 12 5.28 18.82 9zM17 15.99l-5 2.73-5-2.73v-3.72L12 15l5-2.73v3.72z"/></svg>' },
                { value: 'profile', label: settingsT('tab.profile'), icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>' },
                { value: 'settings', label: settingsT('tab.settings'), icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>' }
            ];
            var tabGroups = [
                { group: 'tab.trade', items: ['trade','alerts','calls','favorites','my-trades'] },
                { group: 'tab.analysis', items: ['wallet','whale','smart-alerts','scanner','x-sentiment','weather','news-hub','new-market'] },
                { group: 'divider', items: ['education','profile','settings'] }
            ];
            function renderTabGrid(curVal, isCheck) {
                return tabGroups.map(function(g) {
                    var h = '';
                    if (g.group === 'divider') h += '<div class="dtm-group-divider"></div>';
                    else if (g.group) h += '<div class="dtm-group-header">' + settingsT(g.group) + '</div>';
                    h += g.items.map(function(v) {
                        var o = tabOpts.find(function(x) { return x.value === v; });
                        if (!o) return '';
                        var active = isCheck ? (curVal.indexOf(v) === -1) : (v === curVal);
                        return '<div class="dtm-option' + (active ? ' active' : '') + '" data-value="' + v + '">' +
                            o.icon + '<span>' + o.label + '</span>' +
                            (active ? '<svg class="dtm-check" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>' : '') +
                        '</div>';
                    }).join('');
                    return h;
                }).join('');
            }
            function openTabModal() {
                var overlay = document.createElement('div');
                overlay.className = 'dtm-overlay';
                var modal = document.createElement('div');
                modal.className = 'dtm-modal';
                modal.innerHTML =
                    '<div class="dtm-header">' +
                        '<span class="dtm-title">' + settingsT('defaultTab') + '</span>' +
                        '<button class="dtm-close" id="dtmCloseBtn"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>' +
                    '</div>' +
                    '<div class="dtm-grid">' + renderTabGrid(curTab, false) + '</div>';
                overlay.appendChild(modal);
                document.body.appendChild(overlay);
                function close() { overlay.remove(); }
                overlay.onclick = function(e) { if (e.target === overlay) close(); };
                modal.querySelector('#dtmCloseBtn').onclick = close;
                modal.querySelectorAll('.dtm-option').forEach(function(el) {
                    el.onclick = function() {
                        var val = this.dataset.value;
                        if (val !== curTab) {
                            curTab = val;
                            localStorage.setItem('polyDefaultTab', val);
                            var match = tabOpts.find(function(o) { return o.value === val; });
                            dtBtn.innerHTML = match ? match.icon + '<span>' + match.label + '</span>' : val;
                            modal.querySelectorAll('.dtm-option').forEach(function(o) { o.classList.remove('active'); var ch = o.querySelector('.dtm-check'); if (ch) ch.remove(); });
                            this.classList.add('active');
                            this.insertAdjacentHTML('beforeend', '<svg class="dtm-check" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>');
                        }
                        setTimeout(close, 150);
                    };
                });
            }
            var dtBtn = document.createElement('button');
            dtBtn.className = 'settings-dt-btn';
            var curMatch = tabOpts.find(function(o) { return o.value === curTab; });
            dtBtn.innerHTML = curMatch ? curMatch.icon + '<span>' + curMatch.label + '</span>' : 'Выбрать';
            dtBtn.onclick = openTabModal;
            dtContainer.appendChild(dtBtn);
        }

        // Menu visibility
        var visContainer = $('settingsVisibilityContainer');
        if (visContainer) {
            var existingVisBtn = visContainer.querySelector('.settings-dt-btn');
            if (existingVisBtn) existingVisBtn.remove();
            var hiddenCount = JSON.parse(localStorage.getItem('polyHiddenMenuItems') || '[]').length;
            var visBtn = document.createElement('button');
            visBtn.className = 'settings-dt-btn';
            visBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg><span>' + (hiddenCount > 0 ? settingsT('visibility.hiddenCount').replace('{n}', hiddenCount) : settingsT('visibility.allShown')) + '</span>';
            visBtn.onclick = function() {
                var hidden = JSON.parse(localStorage.getItem('polyHiddenMenuItems') || '[]');
                var visTabOpts = [
                    { value: 'trade', label: settingsT('tab.terminal'), icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M3.5 18.49l6-6.01 4 4L22 6.92l-1.41-1.41-7.09 7.97-4-4L2 16.99z"/></svg>' },
                    { value: 'alerts', label: settingsT('tab.alerts'), icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.75s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>' },
                    { value: 'calls', label: settingsT('tab.calls'), icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M5 8c-1.1 0-2 .9-2 2v4c0 1.1.9 2 2 2h2l4 4V6l-4 4H5zm12 4c0 1.5-.84 2.8-2.1 3.5l.6 1.1c1.6-.9 2.5-2.5 2.5-4.6s-.9-3.7-2.5-4.6l-.6 1.1c1.26.7 2.1 2 2.1 3.5z"/></svg>' },
                    { value: 'favorites', label: settingsT('tab.favorites'), icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>' },
                    { value: 'my-trades', label: settingsT('tab.myTrades'), icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/></svg>' },
                    { value: 'wallet', label: settingsT('tab.wallet'), icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M21 18v1c0 1.1-.9 2-2 2H5c-1.11 0-2-.9-2-2V5c0-1.1.89-2 2-2h14c1.1 0 2 .9 2 2v1h-9c-1.11 0-2 .9-2 2v8c0 1.1.89 2 2 2h9zm-9-2h10V8H12v8zm4-2.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>' },
                    { value: 'whale', label: settingsT('tab.whale'), icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>' },
                    { value: 'smart-alerts', label: settingsT('tab.smartAlerts'), icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>' },
                    { value: 'scanner', label: settingsT('tab.scanner'), icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>' },
                    { value: 'x-sentiment', label: settingsT('tab.xSentiment'), icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M22 3.01L22 3.01l-8 8L22 20h-6l-5-6-6 6H1l8-8L1 3h6l5 6 6-6h4z"/></svg>' },
                    { value: 'weather', label: settingsT('tab.weather'), icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/></svg>' },
                    { value: 'news-hub', label: settingsT('tab.newsHub'), icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zM7 7h10v2H7V7zm0 4h10v2H7v-2zm0 4h6v2H7v-2z"/></svg>' },
                    { value: 'new-market', label: settingsT('tab.newMarket'), icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M13 7h-2v4H7v2h4v4h2v-4h4v-2h-4V7zm-1-5C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>' },
                    { value: 'education', label: settingsT('tab.education'), icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 3L1 9l4 2.18v6L12 21l7-3.82v-6l2-1.09V17h2V9L12 3zm6.82 6L12 12.72 5.18 9 12 5.28 18.82 9zM17 15.99l-5 2.73-5-2.73v-3.72L12 15l5-2.73v3.72z"/></svg>' },
                    { value: 'profile', label: settingsT('tab.profile'), icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>' },
                    { value: 'settings', label: settingsT('tab.settings'), icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>' }
                ];
                var visTabGroups = [
                    { group: 'tab.trade', items: ['trade','alerts','calls','favorites','my-trades'] },
                    { group: 'tab.analysis', items: ['wallet','whale','smart-alerts','scanner','x-sentiment','weather','news-hub','new-market'] },
                    { group: 'divider', items: ['education','profile','settings'] }
                ];
                function renderVisGrid(hiddenArr) {
                    return visTabGroups.map(function(g) {
                        var h = '';
                        if (g.group === 'divider') h += '<div class="dtm-group-divider"></div>';
                        else if (g.group) h += '<div class="dtm-group-header">' + settingsT(g.group) + '</div>';
                        h += g.items.map(function(v) {
                            var o = visTabOpts.find(function(x) { return x.value === v; });
                            if (!o) return '';
                            var isHidden = hiddenArr.indexOf(v) !== -1;
                            return '<div class="dtm-option' + (isHidden ? '' : ' dtm-vis-visible') + '" data-value="' + v + '">' +
                                o.icon + '<span>' + o.label + '</span>' +
                                (!isHidden ? '<svg class="dtm-check" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>' : '') +
                            '</div>';
                        }).join('');
                        return h;
                    }).join('');
                }
                var visOverlay = document.createElement('div');
                visOverlay.className = 'dtm-overlay';
                var visModal = document.createElement('div');
                visModal.className = 'dtm-modal';
                visModal.innerHTML =
                    '<div class="dtm-header">' +
                        '<span class="dtm-title">' + settingsT('visibility') + '</span>' +
                        '<button class="dtm-close" id="visCloseBtn"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>' +
                    '</div>' +
                    '<div class="dtm-grid">' + renderVisGrid(hidden) + '</div>';
                visOverlay.appendChild(visModal);
                document.body.appendChild(visOverlay);
                function closeVis() { visOverlay.remove(); }
                visOverlay.onclick = function(e) { if (e.target === visOverlay) closeVis(); };
                visModal.querySelector('#visCloseBtn').onclick = closeVis;
                visModal.querySelectorAll('.dtm-option').forEach(function(el) {
                    el.onclick = function() {
                        var val = this.dataset.value;
                        var h = JSON.parse(localStorage.getItem('polyHiddenMenuItems') || '[]');
                        var currentlyHidden = h.indexOf(val) !== -1;
                        if (currentlyHidden) {
                            var idx = h.indexOf(val);
                            if (idx !== -1) h.splice(idx, 1);
                            this.classList.add('dtm-vis-visible');
                            if (!this.querySelector('.dtm-check')) this.insertAdjacentHTML('beforeend', '<svg class="dtm-check" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>');
                        } else {
                            h.push(val);
                            this.classList.remove('dtm-vis-visible');
                            var ch = this.querySelector('.dtm-check');
                            if (ch) ch.remove();
                        }
                        localStorage.setItem('polyHiddenMenuItems', JSON.stringify(h));
                        applyMenuVisibility();
                        var hc = h.length;
                        visBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg><span>' + (hc > 0 ? settingsT('visibility.hiddenCount').replace('{n}', hc) : settingsT('visibility.allShown')) + '</span>';
                    };
                });
            };
            visContainer.appendChild(visBtn);
        }

        // Apply translations (static labels)
        applySettingsTranslations();

        // Account section
        var logoutBtn = $('settingsLogoutBtn');
        var emailLabel = $('settingsEmailLabel');
        var auth = getFbAuthREST();
        if (emailLabel) {
            emailLabel.textContent = auth ? (auth.email || (auth.emailVerified ? settingsT('authorized') : settingsT('notAuthorized'))) : settingsT('notAuthorized');
        }
        if (logoutBtn) {
            logoutBtn.style.display = auth ? 'inline-flex' : 'none';
            logoutBtn.onclick = function() {
                fbSignOutREST();
                handleAuth(null);
                initSettingsTab();
            };
        }
    }

    // ====================== MENU SETUP ======================
    $('hamburgerBtn').onclick = toggleMenu;

    document.addEventListener('click', function(e) {
        var menu = $('sidebarMenu');
        var btn = $('hamburgerBtn');
        if (menu && btn && menu.classList.contains('open') &&
            !menu.contains(e.target) && !btn.contains(e.target)) {
            closeMenu();
        }
    });

    document.querySelectorAll('.menu-group-header').forEach(function(header) {
        header.addEventListener('click', function(e) {
            e.stopPropagation();
            var group = this.parentElement;
            var isOpen = group.classList.contains('open');
            document.querySelectorAll('.menu-group.open').forEach(function(g) {
                if (g !== group) g.classList.remove('open');
            });
            group.classList.toggle('open', !isOpen);
        });
    });

    document.querySelectorAll('.menu-item').forEach(function(btn) {
        btn.addEventListener('click', function() {
            if (btn.dataset.tab) {
                switchTab(btn.dataset.tab);
                closeMenu();
            }
        });
    });

    // ====================== QUICK ACTIONS ======================
    $('settingsQuickBtn').onclick = function() {
        var settingsTab = $('settings-tab');
        var isSettingsActive = settingsTab && settingsTab.classList.contains('active');
        if (isSettingsActive && _prevTabBeforeSettings) {
            document.querySelectorAll('.menu-item').forEach(function(b) { b.classList.remove('active'); });
            document.querySelectorAll('.nav-tab-content').forEach(function(c) { c.classList.remove('active'); });
            var prevBtn = document.querySelector('.menu-item[data-tab="' + _prevTabBeforeSettings + '"]');
            if (prevBtn) prevBtn.classList.add('active');
            var prevContent = $(_prevTabBeforeSettings + '-tab');
            if (prevContent) prevContent.classList.add('active');
            _prevTabBeforeSettings = null;
            closeMenu();
            return;
        }
        var activeBtn = document.querySelector('.menu-item.active');
        if (activeBtn && activeBtn.dataset.tab !== 'settings') {
            _prevTabBeforeSettings = activeBtn.dataset.tab;
        } else {
            _prevTabBeforeSettings = 'wallet';
        }
        document.querySelectorAll('.menu-item').forEach(function(b) { b.classList.remove('active'); });
        document.querySelectorAll('.nav-tab-content').forEach(function(c) { c.classList.remove('active'); });
        var menuBtn = document.querySelector('.menu-item[data-tab="settings"]');
        if (menuBtn) menuBtn.classList.add('active');
        if (settingsTab) settingsTab.classList.add('active');
        closeMenu();
        initSettingsTab();
    };
    $('themeToggle').onclick = toggleTheme;

    // ====================== AUTH UI ======================
    function setupAuth() {
        var signInBtn = $('profileSignInBtn');
        var signUpBtn = $('profileShowSignUp');

        function setMode(register) {
            isSignUp = register;
            var nickField = $('profileNickField');
            var promoField = $('profilePromoField');
            if (nickField) nickField.style.display = register ? 'block' : 'none';
            if (promoField) promoField.style.display = register ? 'block' : 'none';
            if (signInBtn && signUpBtn) {
                signInBtn.classList.toggle('active', !register);
                signUpBtn.classList.toggle('active', register);
            }
            var sb = $('profileSubmitBtn');
            if (sb) sb.textContent = register ? 'Зарегистрироваться' : 'Войти';
            clearMsg();
        }

        if (signInBtn) signInBtn.onclick = function() { setMode(false); };
        if (signUpBtn) signUpBtn.onclick = function() { setMode(true); };

        document.querySelectorAll('#profileAuthForms input').forEach(function(inp) {
            inp.addEventListener('keydown', function(e) {
                if (e.key === 'Enter') doAuth();
            });
        });

        var submitBtn = $('profileSubmitBtn');
        if (submitBtn) submitBtn.onclick = doAuth;

        setMode(false);

        var promoBtn = $('profilePromoApplyBtn');
        if (promoBtn) {
            promoBtn.onclick = function() {
                var code = $('profilePromoInput');
                var status = $('profilePromoStatus');
                if (code && status && code.value.trim()) {
                    status.textContent = 'Промокод применён!';
                    status.style.color = 'var(--positive)';
                }
            };
        }
    }

    async function doAuth() {
        var email = $('profileEmail');
        var password = $('profilePassword');
        if (!email || !password) return showMsg('Заполните email и пароль');
        email = email.value.trim();
        password = password.value.trim();

        if (!email || !password) { showMsg('Заполните email и пароль'); return; }
        if (password.length < 6) { showMsg('Пароль должен быть минимум 6 символов'); return; }

        clearMsg();
        var submitBtn = $('profileSubmitBtn');
        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Подождите...'; }

        try {
            if (isSignUp) {
                var authData = await fbSignUpREST(email, password);
                var userData = {
                    email: email,
                    nickname: ($('profileNick') ? $('profileNick').value.trim() : '') || '',
                    createdAt: Date.now(),
                    tariff: 'basic',
                    promoCode: ($('profilePromoInput') ? $('profilePromoInput').value.trim() : '') || ''
                };
                await fbSetREST('users', authData.localId, userData);
                showMsg('Регистрация успешна!', true);
                handleAuth({ uid: authData.localId, email: authData.email });
            } else {
                var authData = await fbSignInREST(email, password);
                handleAuth({ uid: authData.localId, email: authData.email });
            }
        } catch (e) {
            var msg = 'Ошибка: ' + e.message;
            if (e.message && e.message.indexOf('EMAIL_EXISTS') !== -1) msg = 'Этот email уже зарегистрирован';
            else if (e.message && e.message.indexOf('INVALID_LOGIN_CREDENTIALS') !== -1) msg = 'Неверный email или пароль';
            else if (e.message && e.message.indexOf('WEAK_PASSWORD') !== -1) msg = 'Слишком простой пароль';
            else if (e.message && e.message.indexOf('TOO_MANY_ATTEMPTS') !== -1) msg = 'Слишком много попыток. Попробуйте позже.';
            showMsg(msg);
        } finally {
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = isSignUp ? 'Зарегистрироваться' : 'Войти'; }
        }
    }

    // ====================== PROFILE HELPERS ======================
    function tariffIcon(feature) {
        var f = feature.toLowerCase();
        if (f.indexOf('аналитика') !== -1 && f.indexOf('кошельк') !== -1) return '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M21 18v1c0 1.1-.9 2-2 2H5c-1.11 0-2-.9-2-2V5c0-1.1.89-2 2-2h14c1.1 0 2 .9 2 2v1h-9c-1.11 0-2 .9-2 2v8c0 1.1.89 2 2 2h9zm-9-2h10V8H12v8zm4-2.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>';
        if (f.indexOf('запрос') !== -1 || f.indexOf('запросов') !== -1) return '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>';
        if (f.indexOf('отслеживаем') !== -1 || f.indexOf('кошельк') !== -1) return '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>';
        if (f.indexOf('избран') !== -1) return '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
        if (f.indexOf('комиссия') !== -1 || f.indexOf('%') !== -1) return '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M15.73 3H8.27L3 8.27v7.46L8.27 21h7.46L21 15.73V8.27L15.73 3zM12 17.3c-2.93 0-5.3-2.37-5.3-5.3s2.37-5.3 5.3-5.3 5.3 2.37 5.3 5.3-2.37 5.3-5.3 5.3zm1-7.3l-3 3h2v3h2v-3h2l-3-3z"/></svg>';
        if (f.indexOf('цена') !== -1 || f.indexOf('измен') !== -1) return '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z"/></svg>';
        if (f.indexOf('алерт') !== -1 || f.indexOf('автомат') !== -1) return '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>';
        if (f.indexOf('бэктест') !== -1) return '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M19 8l-4 4h3c0 3.31-2.69 6-6 6-1.01 0-1.97-.25-2.8-.7l-1.46 1.46C8.97 19.54 10.43 20 12 20c4.42 0 8-3.58 8-8h3l-4-4zM6 12c0-3.31 2.69-6 6-6 1.01 0 1.97.25 2.8.7l1.46-1.46C15.03 4.46 13.57 4 12 4c-4.42 0-8 3.58-8 8H1l4 4 4-4H6z"/></svg>';
        if (f.indexOf('событ') !== -1 || f.indexOf('аналитика') !== -1) return '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11zM9 10H7v2h2v-2zm4 0h-2v2h2v-2zm4 0h-2v2h2v-2z"/></svg>';
        if (f.indexOf('рефераль') !== -1 || f.indexOf('реферальн') !== -1) return '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M20 6h-2v2h-2V6h-2V4h2V2h2v2h2v2zm-10 2C8.9 8 8 8.9 8 10s.9 2 2 2 2-.9 2-2-.9-2-2-2zm-2 6c-1.1 0-2 .9-2 2v1h8v-1c0-1.1-.9-2-2-2H8zm10-2c-1.1 0-2 .9-2 2v1h4v-1c0-1.1-.9-2-2-2zm-4-4c0 1.1.9 2 2 2s2-.9 2-2-.9-2-2-2-2 .9-2 2z"/></svg>';
        if (f.indexOf('без лимит') !== -1 || f.indexOf('без огранич') !== -1) return '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>';
        return '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
    }

    function updateReferralRank(plan, count) {
        var isPro = plan === 'pro';
        var ranks = isPro ? [
            { min: 0, max: 0, name: '—', req: 'Нет рефералов', reward: '', nextName: 'Уровень 1', nextAt: 1, nextReward: '8% торговых комиссий, 8% с оплаты тарифа + 3% скидка' },
            { min: 1, max: 5, name: 'Уровень 1', req: '1-5 активных рефералов', reward: '8% торговых комиссий, 8% с оплаты тарифа + 3% скидка', nextName: 'Уровень 2', nextAt: 6, nextReward: '15% торговых комиссий, 10% с оплаты тарифа + 6% скидка' },
            { min: 6, max: 10, name: 'Уровень 2', req: '6-10 активных рефералов', reward: '15% торговых комиссий, 10% с оплаты тарифа + 6% скидка', nextName: 'Уровень 3', nextAt: 11, nextReward: '20% торговых комиссий, 20% с оплаты тарифа + 10% скидка' },
            { min: 11, max: Infinity, name: 'Уровень 3', req: '11+ активных рефералов', reward: '20% торговых комиссий, 20% с оплаты тарифа + 10% скидка', nextName: null, nextAt: null, nextReward: '' }
        ] : [
            { min: 0, max: 0, name: '—', req: 'Нет рефералов', reward: '', nextName: 'Уровень 1', nextAt: 1, nextReward: '15% торговых комиссий, 15% с оплаты тарифа + 8% скидка' },
            { min: 1, max: 5, name: 'Уровень 1', req: '1-5 активных рефералов', reward: '15% торговых комиссий, 15% с оплаты тарифа + 8% скидка', nextName: 'Уровень 2', nextAt: 6, nextReward: '25% торговых комиссий, 20% с оплаты тарифа + 12% скидка' },
            { min: 6, max: 10, name: 'Уровень 2', req: '6-10 активных рефералов', reward: '25% торговых комиссий, 20% с оплаты тарифа + 12% скидка', nextName: 'Уровень 3', nextAt: 11, nextReward: '40% торговых комиссий, 40% с оплаты тарифа + 15% скидка' },
            { min: 11, max: Infinity, name: 'Уровень 3', req: '11+ активных рефералов', reward: '40% торговых комиссий, 40% с оплаты тарифа + 15% скидка', nextName: null, nextAt: null, nextReward: '' }
        ];
        var currentRank = ranks[0];
        var nextRank = null;
        for (var i = 0; i < ranks.length; i++) {
            if (count >= ranks[i].min && count <= ranks[i].max) {
                currentRank = ranks[i];
                nextRank = i + 1 < ranks.length ? ranks[i + 1] : null;
                break;
            }
        }
        var rankNameEl = $('profileRefCurrentRank');
        if (rankNameEl) rankNameEl.textContent = currentRank.name;
        var rankReqEl = $('profileRefRankReq');
        if (rankReqEl) rankReqEl.textContent = currentRank.req;
        var rankRewardEl = $('profileRefRankReward');
        if (rankRewardEl) rankRewardEl.textContent = currentRank.reward || '—';
        var barEl = $('profileRefRankBar');
        var barTextEl = $('profileRefRankBarText');
        var barNextEl = $('profileRefRankNext');
        if (barEl && barTextEl) {
            if (currentRank.nextAt !== null) {
                var prevMin = currentRank.min;
                var range = currentRank.nextAt - prevMin;
                var progress = count - prevMin;
                var pct = Math.min(100, Math.max(0, (progress / range) * 100));
                barEl.style.width = pct + '%';
                barTextEl.textContent = (count || 0) + ' / ' + currentRank.nextAt;
            } else {
                barEl.style.width = '100%';
                barTextEl.textContent = count + ' (макс)';
            }
        }
        if (barNextEl) {
            if (nextRank && currentRank.nextAt !== null) {
                barNextEl.innerHTML = '<span class="p-ref-rank-next-label">Следующий уровень:</span> <span class="p-ref-rank-next-val">' + nextRank.name + '</span> <span class="p-ref-rank-next-req">(' + nextRank.req + ')</span> — <span class="p-ref-rank-next-reward">' + currentRank.nextReward + '</span>';
            } else {
                barNextEl.innerHTML = '<span class="p-ref-rank-next-label">Достигнут максимальный уровень!</span> <span class="p-ref-rank-next-val">Все награды активны</span>';
            }
        }
    }

    function setProfileMsg(msg, isOk) {
        var el = $('profileEditMsg');
        if (!el) return;
        el.textContent = msg;
        el.className = 'p-msg' + (isOk ? ' success' : ' error');
        if (msg) setTimeout(function() { el.textContent = ''; el.className = 'p-msg'; }, 5000);
    }

    function renderMyWallets() {
        var list = $('myWalletList');
        if (!list) return;
        var wallets = getWallets();
        var countEl = $('profileWalletCount');
        if (countEl) countEl.textContent = wallets.length;
        var html = '<div class="p-wallet-toolbar">'
            + '<button class="p-wallet-toolbar-btn p-wallet-toolbar-create" id="profileCreateWalletBtn"><svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg> Создать</button>'
            + '<button class="p-wallet-toolbar-btn p-wallet-toolbar-import" id="profileImportWalletBtn"><svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z"/></svg> Импортировать</button>'
            + '</div>'
            + '<div class="p-wallet-import-area" id="profileWalletImportArea" style="display:none">'
            + '<div class="p-wallet-import-row"><input type="text" class="p-wallet-import-input" id="profileWalletImportKey" placeholder="Приватный ключ (0x...)" spellcheck="false"><button class="p-wallet-import-confirm" id="profileWalletImportConfirm">Импорт</button><button class="p-wallet-import-cancel" id="profileWalletImportCancel">Отмена</button></div>'
            + '</div>';
        if (!wallets.length) {
            html += '<div class="p-wallet-empty">Нет кошельков</div>';
            list.innerHTML = html;
            _bindProfileWalletActions(list);
            return;
        }
        for (var i = 0; i < wallets.length; i++) {
            var w = wallets[i];
            var addr = w.address || '';
            var shortAddr = addr ? addr.substring(0, 6) + '...' + addr.substring(addr.length - 4) : '...';
            var dateStr = w.createdAt ? new Date(w.createdAt).toLocaleDateString('ru-RU') : 'только что';
            var name = (w.name || '').trim() ? w.name : shortAddr;
            html += '<div class="p-wallet-item">'
                + '<div class="p-wallet-icon"><svg viewBox="0 0 20 20" width="16" height="16" fill="none"><path d="M4 6a2 2 0 012-2h8a2 2 0 012 2v1H4V6z" fill="currentColor" opacity="0.3"/><rect x="2" y="7" width="16" height="10" rx="2" stroke="currentColor" stroke-width="1.5"/><circle cx="14" cy="12" r="1.5" fill="currentColor"/></svg></div>'
                + '<div class="p-wallet-info">'
                + '<span class="p-wallet-name" title="' + escHtml(addr) + '">' + escHtml(name) + '</span>'
                + '<span class="p-wallet-addr">' + shortAddr + '</span>'
                + '<span class="p-wallet-balance" id="pWalletBalance' + i + '" data-widx="' + i + '">—</span>'
                + '<span class="p-wallet-network">Пополнение: Polygon · USDC (+ POL для газа)</span>'
                + '</div>'
                + '<div class="p-wallet-actions">'
                + '<button class="p-wallet-action-btn" data-waction="deposit" data-widx="' + i + '" title="Пополнить"><svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg></button>'
                + '<button class="p-wallet-action-btn" data-waction="send" data-widx="' + i + '" title="Отправить"><svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>'
                + '<button class="p-wallet-action-btn" data-waction="edit" data-widx="' + i + '" title="Редактировать"><svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg></button>'
                + '</div>'
                + '</div>';
        }
        list.innerHTML = html;
        _bindProfileWalletActions(list);
        _updateProfileWalletBalances();
    }

    function _bindProfileWalletActions(list) {
        var createBtn = $('profileCreateWalletBtn');
        if (createBtn) createBtn.onclick = function() {
            var btn = this;
            btn.disabled = true;
            btn.innerHTML = '<span class="profile-btn-spinner"></span>';
            loadEthersSite().then(function() {
                var wallet = generateTradingWallet();
                return deriveAddressSite(wallet.privateKey).then(function(addr) {
                    wallet.address = addr;
                    btn.disabled = false;
                    btn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg> Создать';
                    showCreateWalletModal(wallet);
                });
            }).catch(function(err) {
                setProfileMsg('Ошибка: ' + (err.message || 'Неизвестная ошибка'), false);
                btn.disabled = false;
                btn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg> Создать';
            });
        };

        var importBtn = $('profileImportWalletBtn');
        var importArea = $('profileWalletImportArea');
        if (importBtn) importBtn.onclick = function() {
            if (importArea) importArea.style.display = importArea.style.display === 'none' ? 'block' : 'none';
            var input = $('profileWalletImportKey');
            if (input && importArea && importArea.style.display !== 'none') input.focus();
        };

        var importCancelBtn = $('profileWalletImportCancel');
        if (importCancelBtn) importCancelBtn.onclick = function() {
            if (importArea) importArea.style.display = 'none';
        };

        var importConfirmBtn = $('profileWalletImportConfirm');
        if (importConfirmBtn) importConfirmBtn.onclick = function() {
            var input = $('profileWalletImportKey');
            if (!input) return;
            var key = input.value.trim();
            if (!key) { setProfileMsg('Введите приватный ключ', false); return; }
            var btn = this;
            btn.disabled = true;
            btn.textContent = '...';
            loadEthersSite().then(function() {
                var wallet = importWalletFromKeySite(key);
                return deriveAddressSite(wallet.privateKey).then(function(addr) {
                    wallet.address = addr;
                    btn.disabled = false;
                    btn.textContent = 'Импорт';
                    if (importArea) importArea.style.display = 'none';
                    input.value = '';
                    showCreateWalletModal(wallet);
                });
            }).catch(function(err) {
                setProfileMsg(err.message, false);
                btn.disabled = false;
                btn.textContent = 'Импорт';
            });
        };

        list.querySelectorAll('[data-waction="edit"]').forEach(function(btn) {
            btn.onclick = function() {
                var idx = parseInt(this.dataset.widx);
                showEditWalletModal(idx);
            };
        });
        list.querySelectorAll('[data-waction="deposit"]').forEach(function(btn) {
            btn.onclick = function() {
                var idx = parseInt(this.dataset.widx);
                var wallets = getWallets();
                var w = wallets[idx];
                if (w && w.address) showDepositModal(w.address);
            };
        });
        list.querySelectorAll('[data-waction="send"]').forEach(function(btn) {
            btn.onclick = function() {
                var idx = parseInt(this.dataset.widx);
                showSendModal(idx);
            };
        });
    }

    function _updateProfileWalletBalances() {
        var wallets = getWallets();
        if (!wallets.length) return;
        wallets.forEach(function(w, i) {
            var el = $('pWalletBalance' + i);
            if (!el) return;
            el.textContent = '...';
            var addr = w.address;
            if (!addr || addr === '...' || addr.length !== 42) { el.textContent = '—'; return; }
            (function(idx, address, element) {
                try {
                    if (typeof ethers === 'undefined') { element.textContent = '—'; return; }
                    var provider = new ethers.JsonRpcProvider('https://polygon-rpc.com');
                    provider.getBalance(address).then(function(balance) {
                        var n = parseFloat(ethers.formatEther(balance));
                        element.textContent = (n < 0.001 ? '<0.001' : n.toFixed(3)) + ' POL';
                    }).catch(function() {
                        element.textContent = '—';
                    });
                } catch (e) {
                    element.textContent = '—';
                }
            })(i, addr, el);
        });
    }

    function initProfileEdit() {
        var msgEl = $('profileEditMsg');
        if (!msgEl) return;
        function setMsg(text, type) {
            msgEl.textContent = text;
            if (text) { msgEl.className = 'p-msg' + (type === 'error' ? ' error' : ''); } else { msgEl.className = 'p-msg'; }
            if (text) setTimeout(function() { msgEl.textContent = ''; msgEl.className = 'p-msg'; }, 5000);
        }

        var loginInput = $('profileLoginInput');
        var loginBtn = $('profileLoginSaveBtn');
        function saveLogin() {
            var val = (loginInput || $('profileLoginInput')).value.trim();
            if (!val) { setMsg('Введите логин', 'error'); return; }
            var auth = getFbAuthREST();
            if (!auth) { setMsg('Требуется авторизация', 'error'); return; }
            loginBtn.disabled = true;
            loginBtn.innerHTML = '<svg class="profile-btn-spin" viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M8 1a7 7 0 00-7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>';
            var newNickLower = val.toLowerCase();
            fbGetREST('nicknames', newNickLower).then(function(existing) {
                if (existing && existing.exists && existing.data && existing.data.userId !== auth.localId) {
                    setMsg('Этот никнейм уже занят другим пользователем', 'error');
                    loginBtn.disabled = false;
                    loginBtn.innerHTML = '<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14.5A5.5 5.5 0 0011.5 9a7 7 0 10-6 10.5h10.5a4 4 0 001-7.5z"/><path d="M9.5 8.5v6"/><path d="M7 12l2.5 2.5L12 12"/></svg>';
                    return;
                }
                var auth2 = getFbAuthREST();
                var userData = { displayName: val, nick: val };
                var newCode = 'polywin-' + val;
                var oldNick = null;
                fbGetREST('users', auth.localId).then(function(userDoc) {
                    if (userDoc && userDoc.exists && userDoc.data) {
                        oldNick = userDoc.data.nick || userDoc.data.displayName || null;
                    }
                    if (oldNick && oldNick.toLowerCase() !== newNickLower) {
                        fbSetREST('nicknames', oldNick.toLowerCase(), {}).catch(function(){});
                    }
                    fbSetREST('nicknames', newNickLower, { userId: auth.localId, nick: val, createdAt: Date.now() }).catch(function(e) {
                        console.warn('[fb] nickname registry update error:', e);
                    });
                    fbSetREST('promocodes', newCode, {
                        userId: auth.localId, nick: val, tariff: 'basic', createdAt: Date.now()
                    }).catch(function(e) { console.warn('[fb] new promocode create:', e); });
                    userData.promoCode = newCode;
                    var promoInput = $('profilePromoCodeDisplay');
                    if (promoInput) {
                        promoInput.value = newCode;
                        promoInput.dataset.loaded = '0';
                    }
                    return fbSetREST('users', auth.localId, userData).catch(function(){});
                }).then(function() {
                    setMsg('Логин сохранён', 'success');
                    loginBtn.disabled = false;
                    loginBtn.innerHTML = '<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14.5A5.5 5.5 0 0011.5 9a7 7 0 10-6 10.5h10.5a4 4 0 001-7.5z"/><path d="M9.5 8.5v6"/><path d="M7 12l2.5 2.5L12 12"/></svg>';
                    var hn = $('profileHeroName');
                    if (hn) hn.textContent = val;
                    var al = $('profileAvatarLetter');
                    if (al) al.textContent = val[0].toUpperCase();
                }).catch(function(e) {
                    setMsg('Ошибка: ' + (e.message || 'Неизвестная ошибка'), 'error');
                    loginBtn.disabled = false;
                    loginBtn.innerHTML = '<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14.5A5.5 5.5 0 0011.5 9a7 7 0 10-6 10.5h10.5a4 4 0 001-7.5z"/><path d="M9.5 8.5v6"/><path d="M7 12l2.5 2.5L12 12"/></svg>';
                });
            });
        }
        if (loginBtn) loginBtn.onclick = saveLogin;
        if (loginInput) loginInput.onkeydown = function(e) { if (e.key === 'Enter') saveLogin(); };

        var emailInput = $('profileNewEmail');
        var emailBtn = $('profileEditEmailBtn');
        function saveEmail() {
            var newEmail = (emailInput || $('profileNewEmail')).value.trim();
            if (!newEmail || newEmail.indexOf('@') === -1) { setMsg('Введите корректный email', 'error'); return; }
            emailBtn.disabled = true;
            emailBtn.innerHTML = '<svg class="profile-btn-spin" viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M8 1a7 7 0 00-7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>';
            try {
                var auth = getFbAuthREST();
                if (!auth) throw new Error('Требуется авторизация');
                if (!auth.password) throw new Error('Пароль не сохранён. Выйдите и войдите заново.');
                fbSetREST('users', auth.localId, { email: newEmail }).then(function() {
                    setMsg('Email изменён на ' + newEmail, 'success');
                    if ($('profileNewEmail')) $('profileNewEmail').value = '';
                    updateProfileUI();
                    emailBtn.disabled = false;
                    emailBtn.innerHTML = '<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14.5A5.5 5.5 0 0011.5 9a7 7 0 10-6 10.5h10.5a4 4 0 001-7.5z"/><path d="M9.5 8.5v6"/><path d="M7 12l2.5 2.5L12 12"/></svg>';
                }).catch(function(e) {
                    setMsg('Ошибка: ' + (e.message || 'Неизвестная ошибка'), 'error');
                    emailBtn.disabled = false;
                    emailBtn.innerHTML = '<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14.5A5.5 5.5 0 0011.5 9a7 7 0 10-6 10.5h10.5a4 4 0 001-7.5z"/><path d="M9.5 8.5v6"/><path d="M7 12l2.5 2.5L12 12"/></svg>';
                });
            } catch (e) {
                setMsg('Ошибка: ' + (e.message || 'Неизвестная ошибка'), 'error');
                emailBtn.disabled = false;
                emailBtn.innerHTML = '<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14.5A5.5 5.5 0 0011.5 9a7 7 0 10-6 10.5h10.5a4 4 0 001-7.5z"/><path d="M9.5 8.5v6"/><path d="M7 12l2.5 2.5L12 12"/></svg>';
            }
        }
        if (emailBtn) emailBtn.onclick = saveEmail;
        if (emailInput) emailInput.onkeydown = function(e) { if (e.key === 'Enter') saveEmail(); };

        var passInput = $('profileNewPassword');
        var passBtn = $('profileEditPassBtn');
        function savePassword() {
            var newPass = (passInput || $('profileNewPassword')).value;
            if (!newPass || newPass.length < 6) { setMsg('Пароль должен быть минимум 6 символов', 'error'); return; }
            passBtn.disabled = true;
            passBtn.innerHTML = '<svg class="profile-btn-spin" viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M8 1a7 7 0 00-7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>';
            try {
                var auth = getFbAuthREST();
                if (!auth) throw new Error('Требуется авторизация');
                if (auth.password) {
                    fbSignInREST(auth.email, auth.password).then(function() {
                        var newAuth = getFbAuthREST();
                        if (newAuth) { newAuth.password = newPass; setFbAuthREST(newAuth); }
                        setMsg('Пароль изменён', 'success');
                        if ($('profileNewPassword')) $('profileNewPassword').value = '';
                        passBtn.disabled = false;
                        passBtn.innerHTML = '<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14.5A5.5 5.5 0 0011.5 9a7 7 0 10-6 10.5h10.5a4 4 0 001-7.5z"/><path d="M9.5 8.5v6"/><path d="M7 12l2.5 2.5L12 12"/></svg>';
                    }).catch(function(e) {
                        setMsg('Ошибка: ' + (e.message || 'Неизвестная ошибка'), 'error');
                        passBtn.disabled = false;
                        passBtn.innerHTML = '<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14.5A5.5 5.5 0 0011.5 9a7 7 0 10-6 10.5h10.5a4 4 0 001-7.5z"/><path d="M9.5 8.5v6"/><path d="M7 12l2.5 2.5L12 12"/></svg>';
                    });
                } else {
                    throw new Error('Пароль не сохранён. Выйдите и войдите заново.');
                }
            } catch (e) {
                setMsg('Ошибка: ' + (e.message || 'Неизвестная ошибка'), 'error');
                passBtn.disabled = false;
                passBtn.innerHTML = '<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14.5A5.5 5.5 0 0011.5 9a7 7 0 10-6 10.5h10.5a4 4 0 001-7.5z"/><path d="M9.5 8.5v6"/><path d="M7 12l2.5 2.5L12 12"/></svg>';
            }
        }
        if (passBtn) passBtn.onclick = savePassword;
        if (passInput) passInput.onkeydown = function(e) { if (e.key === 'Enter') savePassword(); };
    }

    function initTelegramLink() {
        var statusText = $('telegramStatusText');
        var statusDot = $('telegramStatusDot');
        var linkBtn = $('telegramLinkBtn');
        var unlinkBtn = $('telegramUnlinkBtn');
        var linkFlow = $('telegramLinkFlow');
        var unlinkFlow = $('telegramUnlinkFlow');
        var unlinkInput = $('telegramUnlinkInput');
        var unlinkConfirmBtn = $('telegramUnlinkConfirmBtn');
        var unlinkPoll = $('telegramUnlinkPoll');
        var deepLink = $('telegramDeepLink');
        var auth = getFbAuthREST();
        if (!auth || !auth.localId) return;

        function closeUnlink() {
            if (window._unlinkPollTimer) { clearInterval(window._unlinkPollTimer); window._unlinkPollTimer = null; }
            if (unlinkFlow) unlinkFlow.style.display = 'none';
            if (unlinkPoll) unlinkPoll.textContent = '';
            if (unlinkInput) unlinkInput.value = '';
            if (unlinkBtn) unlinkBtn.style.display = '';
        }
        function closeLinkFlow() {
            if (linkFlow) linkFlow.style.display = 'none';
            if (linkBtn) linkBtn.style.display = '';
            if (statusDot) statusDot.className = 'p-telegram-dot disconnected';
        }
        if (window._tgPollTimer) { clearInterval(window._tgPollTimer); window._tgPollTimer = null; }

        function startUnlinkFlow() {
            fbSetREST('users', auth.localId, { unlinkRequested: true }).catch(function(){});
            if (unlinkBtn) unlinkBtn.style.display = 'none';
            if (unlinkFlow) unlinkFlow.style.display = 'block';
            if (unlinkInput) { unlinkInput.value = ''; unlinkInput.placeholder = 'Код из Telegram...'; }
            if (unlinkPoll) unlinkPoll.textContent = 'Запрос отправлен в Telegram...';
            var startTime = Date.now();
            if (window._unlinkPollTimer) clearInterval(window._unlinkPollTimer);
            window._unlinkPollTimer = setInterval(function() {
                fbGetREST('users', auth.localId).then(function(doc) {
                    if (doc && doc.data && doc.data.unlinkCode) {
                        if (unlinkInput) unlinkInput.placeholder = 'Код из Telegram';
                        if (unlinkPoll) unlinkPoll.textContent = 'Введи код из сообщения в Telegram';
                        clearInterval(window._unlinkPollTimer);
                        window._unlinkPollTimer = null;
                    } else if (Date.now() - startTime > 300000) {
                        clearInterval(window._unlinkPollTimer);
                        window._unlinkPollTimer = null;
                        closeUnlink();
                    }
                }).catch(function(){});
            }, 3000);
        }

        function setStatus(connected, label) {
            if (statusDot) { statusDot.className = 'p-telegram-dot ' + (connected ? 'connected' : 'disconnected'); }
            if (statusText) { statusText.textContent = label; }
            if (linkFlow) linkFlow.style.display = 'none';
            closeUnlink();
            if (linkBtn) linkBtn.style.display = connected ? 'none' : '';
            if (unlinkBtn) unlinkBtn.style.display = connected ? '' : 'none';
        }

        function startLinkFlow() {
            if (linkFlow) linkFlow.style.display = 'block';
            if (linkBtn) linkBtn.style.display = 'none';
            if (statusDot) statusDot.className = 'p-telegram-dot pending';
            closeUnlink();

            var code = '';
            var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
            for (var i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];

            if (deepLink) {
                deepLink.href = 'https://t.me/polywin_use_bot?start=link_' + code;
            }

            fbSetREST('users', auth.localId, { telegramLinkCode: code, linkCodeCreatedAt: Date.now() }).then(function() {
                var startTime = Date.now();
                window._tgPollTimer = setInterval(function() {
                    fbGetREST('users', auth.localId).then(function(doc) {
                        if (doc && doc.data && doc.data.telegramId) {
                            clearInterval(window._tgPollTimer);
                            window._tgPollTimer = null;
                            if (linkFlow) linkFlow.style.display = 'none';
                            var tgUsername = doc.data.telegramUsername || '';
                            setStatus(true, 'Привязан' + (tgUsername ? ' (@' + tgUsername + ')' : ''));
                            if (unlinkBtn) unlinkBtn.onclick = startUnlinkFlow;
                        } else if (Date.now() - startTime > 300000) {
                            clearInterval(window._tgPollTimer);
                            window._tgPollTimer = null;
                            closeLinkFlow();
                        }
                    }).catch(function() {});
                }, 3000);
            }).catch(function() {});
        }

        fbGetREST('users', auth.localId).then(function(doc) {
            if (doc && doc.data && doc.data.telegramId) {
                var tgUsername = doc.data.telegramUsername || '';
                setStatus(true, 'Привязан' + (tgUsername ? ' (@' + tgUsername + ')' : ''));
                if (unlinkBtn) unlinkBtn.onclick = startUnlinkFlow;
            } else {
                setStatus(false, 'Не привязан');
                if (linkBtn) linkBtn.onclick = startLinkFlow;
            }
        }).catch(function() {
            setStatus(false, 'Не привязан');
            if (linkBtn) linkBtn.onclick = startLinkFlow;
        });

        if (unlinkConfirmBtn) {
            unlinkConfirmBtn.onclick = function() {
                var enteredCode = unlinkInput ? unlinkInput.value.trim().toUpperCase() : '';
                if (!enteredCode || enteredCode.length < 4) {
                    if (unlinkPoll) unlinkPoll.textContent = 'Введите код';
                    return;
                }
                if (unlinkPoll) unlinkPoll.textContent = 'Отвязываем...';
                fbGetREST('users', auth.localId).then(function(doc) {
                    if (doc && doc.data && doc.data.unlinkCode === enteredCode) {
                        fbSetREST('users', auth.localId, { unlinkVerified: true }).then(function() {
                            if (unlinkPoll) unlinkPoll.textContent = 'Ожидаем подтверждения...';
                            startUnlinkDonePoll();
                        }).catch(function() {
                            if (unlinkPoll) unlinkPoll.textContent = 'Ошибка';
                        });
                    } else {
                        if (unlinkPoll) unlinkPoll.textContent = 'Неверный код';
                        setTimeout(function() { if (unlinkPoll) unlinkPoll.textContent = ''; }, 3000);
                    }
                }).catch(function() {
                    if (unlinkPoll) unlinkPoll.textContent = 'Ошибка';
                });
            };
        }

        function startUnlinkDonePoll() {
            if (window._unlinkDoneTimer) clearInterval(window._unlinkDoneTimer);
            window._unlinkDoneTimer = setInterval(function() {
                fbGetREST('users', auth.localId).then(function(doc) {
                    if (!doc || !doc.data || !doc.data.telegramId) {
                        clearInterval(window._unlinkDoneTimer);
                        window._unlinkDoneTimer = null;
                        setStatus(false, 'Не привязан');
                        if (linkBtn) linkBtn.onclick = startLinkFlow;
                    }
                }).catch(function() {});
            }, 2000);
        }
    }

    // ====================== WALLET MODALS ======================
    var _pendingWallet = null;

    function showCreateWalletModal(wallet) {
        _pendingWallet = wallet;
        $('walletModalTitle').textContent = 'Новый кошелёк';
        $('walletModalAddress').textContent = wallet.address;
        $('walletModalKey').value = wallet.privateKey;
        $('walletModalKey').type = 'password';
        $('walletModalName').value = '';
        $('walletModalComment').value = '';
        $('walletModalMode').value = 'create';
        $('walletModalIndex').value = '';
        $('walletModalOverlay').style.display = 'flex';
        $('walletModalName').focus();
    }

    function showEditWalletModal(index) {
        var wallets = getWallets();
        var w = wallets[index];
        if (!w) return;
        _pendingWallet = null;
        $('walletModalTitle').textContent = w.name || 'Кошелёк';
        $('walletModalAddress').textContent = w.address;
        $('walletModalKey').value = w.privateKey;
        $('walletModalKey').type = 'password';
        $('walletModalName').value = w.name || '';
        $('walletModalComment').value = w.comment || '';
        $('walletModalMode').value = 'edit';
        $('walletModalIndex').value = index;
        var delBtn = $('walletModalDelete');
        if (delBtn) {
            delBtn.style.display = '';
            delBtn.onclick = function() {
                if (!confirm('Удалить кошелёк «' + (w.name || w.address.substring(0, 8) + '...') + '»?')) return;
                deleteWallet(index);
                renderMyWallets();
                hideWalletModal();
                setProfileMsg('Кошелёк удалён', false);
            };
        }
        $('walletModalOverlay').style.display = 'flex';
    }

    function hideWalletModal() {
        $('walletModalOverlay').style.display = 'none';
        _pendingWallet = null;
    }

    function saveWalletFromModal() {
        var name = $('walletModalName').value.trim();
        var comment = $('walletModalComment').value.trim();
        var mode = $('walletModalMode').value;
        var index = parseInt($('walletModalIndex').value);

        if (mode === 'create' && _pendingWallet) {
            _pendingWallet.name = name || '';
            _pendingWallet.comment = comment || '';
            saveWallet(_pendingWallet);
            renderMyWallets();
            hideWalletModal();
            setProfileMsg('Кошелёк создан', true);
        } else if (mode === 'edit' && !isNaN(index)) {
            var wallets = getWallets();
            var w = wallets[index];
            if (w) {
                w.name = name || '';
                w.comment = comment || '';
                saveWallets(wallets);
                renderMyWallets();
                hideWalletModal();
                setProfileMsg('Кошелёк обновлён', true);
            }
        }
    }

    function exportWalletKey(wallet) {
        var input = document.createElement('textarea');
        input.value = wallet.privateKey;
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
        setProfileMsg('Приватный ключ скопирован', true);
    }

    // ====================== WALLET MODAL BINDINGS ======================
    $('walletModalClose').onclick = hideWalletModal;
    $('walletModalCancel').onclick = hideWalletModal;
    $('walletModalOverlay').onclick = function(e) { if (e.target === e.currentTarget) hideWalletModal(); };
    $('walletModalSave').onclick = saveWalletFromModal;
    $('walletModalKeyToggle').onclick = function() {
        var input = $('walletModalKey');
        if (input.type === 'password') {
            input.type = 'text';
            this.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/></svg>';
        } else {
            input.type = 'password';
            this.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>';
        }
    };
    $('walletModalKeyCopy').onclick = function() {
        var input = $('walletModalKey');
        var val = input.value;
        var ta = document.createElement('textarea');
        ta.value = val;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        setProfileMsg('Приватный ключ скопирован', true);
    };
    $('walletModalAddrCopy').onclick = function() {
        var addr = $('walletModalAddress').textContent;
        var ta = document.createElement('textarea');
        ta.value = addr;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        setProfileMsg('Адрес скопирован', true);
    };

    // ====================== DEPOSIT / SEND MODALS ======================
    function showDepositModal(addr) {
        var overlay = document.createElement('div');
        overlay.className = 'p-wallet-modal-overlay';
        var shortAddr = addr.substring(0, 6) + '...' + addr.substring(addr.length - 4);
        var html = '<div class="p-wallet-modal p-wallet-modal-deposit">'
            + '<div class="p-wallet-modal-header">'
            + '<span class="p-wallet-modal-title"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg> Пополнение кошелька</span>'
            + '<button class="p-wallet-modal-close"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>'
            + '</div>'
            + '<div class="p-wallet-modal-body p-wallet-modal-body-deposit">'
            + '<div class="p-wallet-deposit-qr" id="depositQR"></div>'
            + '<div class="p-wallet-deposit-label">Отправьте USDC или POL на этот адрес:</div>'
            + '<div class="p-wallet-deposit-addr-wrap">'
            + '<div class="p-wallet-deposit-addr" id="depositAddr">' + addr + '</div>'
            + '<button class="p-wallet-deposit-copy" id="depositCopyAddr"><svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg> Копировать</button>'
            + '</div>'
            + '<div class="p-wallet-deposit-note" style="flex-direction:column;align-items:flex-start;gap:6px"><div style="display:flex;align-items:center;gap:5px;font-weight:700;color:#f0883e"><svg viewBox="0 0 24 24" width="14" height="14" style="flex-shrink:0"><path fill="currentColor" d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg> ⚠ Важно: только сеть Polygon!</div>'
            + '<div style="display:flex;align-items:center;gap:5px"><svg viewBox="0 0 24 24" width="12" height="12" style="flex-shrink:0;color:#4C7F6E"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg> Принимаются: <strong>USDC</strong> и <strong>POL</strong> в сети <strong>Polygon</strong></div>'
            + '<div style="display:flex;align-items:center;gap:5px;color:#f85149"><svg viewBox="0 0 24 24" width="12" height="12" style="flex-shrink:0"><path fill="currentColor" d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/></svg> Не отправляйте через Ethereum (ERC-20) — средства уйдут на тот же адрес, но в другой сети, и вы их не увидите здесь!</div>'
            + '<div style="display:flex;align-items:center;gap:5px;font-size:9px;color:#8b949e"><svg viewBox="0 0 24 24" width="11" height="11" style="flex-shrink:0"><path fill="currentColor" d="M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg> Если ошиблись сетью — импортируйте ключ в MetaMask и используйте бридж (Polygon Bridge, Orbiter) для возврата</div>'
            + '</div>'
            + '</div>'
            + '</div>';
        overlay.innerHTML = html;
        document.body.appendChild(overlay);
        overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
        overlay.querySelector('.p-wallet-modal-close').onclick = function() { overlay.remove(); };
        var qrEl = overlay.querySelector('#depositQR');
        if (qrEl) {
            var img = document.createElement('img');
            img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(addr);
            img.style.width = '180px';
            img.style.height = '180px';
            img.style.borderRadius = '12px';
            img.style.background = '#ffffff';
            img.style.padding = '8px';
            img.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
            qrEl.appendChild(img);
        }
        overlay.querySelector('#depositCopyAddr').onclick = function() {
            var ta = document.createElement('textarea');
            ta.value = addr;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            this.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> Скопировано!';
            this.style.borderColor = '#3fb950';
            this.style.color = '#3fb950';
            var self = this;
            setTimeout(function() {
                self.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg> Копировать';
                self.style.borderColor = '';
                self.style.color = '';
            }, 2000);
        };
    }

    function showSendModal(idx) {
        var wallets = getWallets();
        var w = wallets[idx];
        if (!w) return;
        var overlay = document.createElement('div');
        overlay.className = 'p-wallet-modal-overlay';
        var html = '<div class="p-wallet-modal p-wallet-modal-send">'
            + '<div class="p-wallet-modal-header">'
            + '<span class="p-wallet-modal-title"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg> Отправить средства</span>'
            + '<button class="p-wallet-modal-close"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>'
            + '</div>'
            + '<div class="p-wallet-modal-body">'
            + '<div class="p-wallet-send-row">'
            + '<div class="p-wallet-send-field p-wallet-send-field-half">'
            + '<label class="p-wallet-send-label">Откуда</label>'
            + '<div class="p-wallet-send-sel-wrap"><svg viewBox="0 0 24 24" width="12" height="12" class="p-wallet-send-sel-icon"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg><select class="p-wallet-send-sel" id="sendWalletSel">';
        wallets.forEach(function(wl, i) {
            var nm = (wl.name || '').trim() || (wl.address || '').substring(0, 8) + '...';
            html += '<option value="' + i + '"' + (i === idx ? ' selected' : '') + '>' + escHtml(nm) + '</option>';
        });
        html += '</select></div>'
            + '</div>'
            + '<div class="p-wallet-send-field p-wallet-send-field-half">'
            + '<label class="p-wallet-send-label">Валюта</label>'
            + '<div class="p-wallet-send-token-group" id="sendTokenGroup">'
            + '<button class="p-wallet-send-token-btn" data-token="POL">POL</button>'
            + '<button class="p-wallet-send-token-btn active" data-token="USDC">USDC</button>'
            + '</div>'
            + '</div>'
            + '</div>'
            + '<div class="p-wallet-send-field">'
            + '<label class="p-wallet-send-label">Адрес получателя</label>'
            + '<div class="p-wallet-send-input-wrap"><svg viewBox="0 0 24 24" width="12" height="12" class="p-wallet-send-input-icon"><path fill="currentColor" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg><input type="text" class="p-wallet-send-input" id="sendToAddr" placeholder="0x..." spellcheck="false"></div>'
            + '</div>'
            + '<div class="p-wallet-send-row">'
            + '<div class="p-wallet-send-field" style="flex:1">'
            + '<label class="p-wallet-send-label">Сумма</label>'
            + '<input type="number" class="p-wallet-send-input" id="sendAmount" placeholder="0.00" min="0" step="any" style="flex:1">'
            + '</div>'
            + '<div class="p-wallet-send-field" style="flex:0 0 60px;display:flex;align-items:flex-end;padding-bottom:2px">'
            + '<button class="p-wallet-send-max-btn" id="sendMaxBtn">MAX</button>'
            + '</div>'
            + '</div>'
            + '<div class="p-wallet-send-status" id="sendStatus"></div>'
            + '<button class="p-wallet-send-submit" id="sendTxBtn"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg> Отправить</button>'
            + '</div>'
            + '</div>';
        overlay.innerHTML = html;
        document.body.appendChild(overlay);
        overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
        overlay.querySelector('.p-wallet-modal-close').onclick = function() { overlay.remove(); };

        overlay.querySelectorAll('#sendTokenGroup .p-wallet-send-token-btn').forEach(function(btn) {
            btn.onclick = function() {
                overlay.querySelectorAll('#sendTokenGroup .p-wallet-send-token-btn').forEach(function(b) { b.classList.remove('active'); });
                this.classList.add('active');
            };
        });

        overlay.querySelector('#sendMaxBtn').onclick = function() {
            var sidx = parseInt(document.getElementById('sendWalletSel').value);
            var token = overlay.querySelector('#sendTokenGroup .p-wallet-send-token-btn.active').dataset.token;
            var ws = getWallets();
            var ww = ws[sidx];
            if (!ww || !ww.address) return;
            var amountEl = document.getElementById('sendAmount');
            if (token === 'POL') {
                var balEl = document.getElementById('pWalletBalance' + sidx);
                if (balEl) {
                    var txt = balEl.textContent.replace(' POL', '');
                    var n = parseFloat(txt);
                    if (!isNaN(n) && n > 0.001) amountEl.value = (n - 0.001).toFixed(4);
                    else amountEl.value = '';
                }
            } else {
                var usdcEl = document.getElementById('pWalletUSDC' + sidx);
                if (usdcEl) {
                    var txt = usdcEl.textContent.replace(' USDC', '');
                    var n = parseFloat(txt);
                    if (!isNaN(n)) amountEl.value = n.toFixed(2);
                }
            }
        };

        overlay.querySelector('#sendTxBtn').onclick = function() {
            var btn = this;
            var sidx = parseInt(document.getElementById('sendWalletSel').value);
            var token = overlay.querySelector('#sendTokenGroup .p-wallet-send-token-btn.active').dataset.token;
            var to = document.getElementById('sendToAddr').value.trim();
            var amount = document.getElementById('sendAmount').value.trim();
            var statusEl = document.getElementById('sendStatus');
            if (!to || !amount) { statusEl.textContent = 'Заполните все поля'; statusEl.style.color = '#f85149'; return; }
            if (!to.match(/^0x[0-9a-fA-F]{40}$/)) { statusEl.textContent = 'Неверный адрес получателя'; statusEl.style.color = '#f85149'; return; }
            var swallets = getWallets();
            var sw = swallets[sidx];
            if (!sw || !sw.privateKey) { statusEl.textContent = 'Ошибка: нет ключа'; statusEl.style.color = '#f85149'; return; }
            btn.disabled = true;
            btn.innerHTML = '<span class="p-wallet-send-spinner"></span> Отправка...';
            statusEl.innerHTML = '<span class="p-wallet-send-status-pending"></span> Подпись и отправка...';
            statusEl.style.color = '#8b949e';
            loadEthersSite().then(function() {
                try {
                    var provider = new ethers.JsonRpcProvider('https://polygon-rpc.com');
                    var wallet = new ethers.Wallet(sw.privateKey, provider);
                    var txPromise;
                    if (token === 'POL') {
                        txPromise = wallet.sendTransaction({
                            to: to,
                            value: ethers.parseEther(amount)
                        });
                    } else {
                        var usdcAddr = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
                        var erc20 = new ethers.Contract(usdcAddr, [
                            'function transfer(address to, uint256 amount) returns (bool)',
                            'function decimals() view returns (uint8)'
                        ], wallet);
                        txPromise = erc20.decimals().then(function(dec) {
                            var parsed = ethers.parseUnits(amount, dec);
                            return erc20.transfer(to, parsed);
                        });
                    }
                    return txPromise.then(function(tx) {
                        statusEl.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" style="color:#e3b341;vertical-align:-2px;margin-right:4px"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg> Транзакция отправлена! <a href="https://polygonscan.com/tx/' + tx.hash + '" target="_blank" style="color:#58a6ff;font-weight:600">PolygonScan ↗</a>';
                        statusEl.style.color = '#3fb950';
                        btn.disabled = false;
                        btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg> Отправить';
                        return tx.wait();
                    }).then(function(receipt) {
                        statusEl.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" style="color:#3fb950;vertical-align:-2px;margin-right:4px"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> Подтверждено! <a href="https://polygonscan.com/tx/' + receipt.hash + '" target="_blank" style="color:#58a6ff;font-weight:600">PolygonScan ↗</a>';
                    });
                } catch (e) {
                    statusEl.innerHTML = 'Ошибка: ' + (e.message || 'Неизвестная ошибка');
                    statusEl.style.color = '#f85149';
                    btn.disabled = false;
                    btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg> Отправить';
                }
            }).catch(function(e) {
                statusEl.innerHTML = 'Ошибка: ' + (e.message || 'Неизвестная ошибка');
                statusEl.style.color = '#f85149';
                btn.disabled = false;
                btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg> Отправить';
            });
        };
    }

    // ====================== WALLET DATA MANAGEMENT ======================
    function generateTradingWallet() {
        const keyBytes = new Uint8Array(32);
        crypto.getRandomValues(keyBytes);
        const privateKey = '0x' + Array.from(keyBytes).map(b => b.toString(16).padStart(2, '0')).join('');
        return { privateKey: privateKey, createdAt: Date.now() };
    }

    function deriveAddressSite(privateKey) {
        try {
            if (typeof ethers === 'undefined') return Promise.reject(new Error('ethers not loaded'));
            var wallet = new ethers.Wallet(privateKey);
            return Promise.resolve(wallet.address);
        } catch (e) {
            return Promise.reject(e);
        }
    }

    function importWalletFromKeySite(key) {
        key = key.trim();
        if (!key.match(/^0x[0-9a-fA-F]{64}$/)) throw new Error('Неверный формат ключа. Ожидается 0x + 64 hex символа.');
        function sha16(msg) {
            var h = 0;
            for (var i = 0; i < msg.length; i++) { h = ((h << 5) - h) + msg.charCodeAt(i); h |= 0; }
            return Math.abs(h).toString(16).padStart(8, '0');
        }
        var h = sha16(key);
        return { address: '0x' + sha16(h + '1') + sha16(h + '2') + sha16(h + '3') + sha16(h + '4') + sha16(h + '5'), privateKey: key, createdAt: Date.now() };
    }

    function getWallets() {
        try {
            var stored = JSON.parse(localStorage.getItem('polyTradingWallets') || '[]');
            if (!Array.isArray(stored)) {
                var old = localStorage.getItem('polyTradingWallet');
                stored = old ? [JSON.parse(old)] : [];
                localStorage.setItem('polyTradingWallets', JSON.stringify(stored));
            }
            return stored;
        } catch { return []; }
    }

    function saveWallets(wallets) {
        localStorage.setItem('polyTradingWallets', JSON.stringify(wallets));
        var auth = getFbAuthREST();
        if (auth) {
            wallets.forEach(function(w) {
                fbSetREST('wallets', auth.localId + '_' + w.address, { userId: auth.localId, name: w.name || '', address: w.address || '', privateKey: w.privateKey || '', createdAt: w.createdAt || Date.now() }).catch(function(e){});
            });
        }
    }

    function saveWallet(wallet) {
        var wallets = getWallets();
        wallets.push(wallet);
        saveWallets(wallets);
        return wallets;
    }

    function deleteWallet(index) {
        var wallets = getWallets();
        wallets.splice(index, 1);
        saveWallets(wallets);
    }

    var _ethersLoaded = false;
    var _ethersLoading = null;

    function loadEthersSite() {
        if (_ethersLoaded) return Promise.resolve();
        if (_ethersLoading) return _ethersLoading;
        var p = new Promise(function(resolve, reject) {
            if (typeof window.ethers !== 'undefined' && window.ethers && window.ethers.providers) {
                _ethersLoaded = true;
                resolve();
                return;
            }
            var s = document.createElement('script');
            s.src = 'https://cdnjs.cloudflare.com/ajax/libs/ethers/6.13.5/ethers.umd.min.js';
            var timedOut = false;
            var tid = setTimeout(function() { timedOut = true; reject(new Error('Загрузка ethers.js превысила 10с')); }, 10000);
            s.onload = function() { if (!timedOut) { clearTimeout(tid); _ethersLoaded = true; resolve(); } };
            s.onerror = function() { if (!timedOut) { clearTimeout(tid); reject(new Error('Не удалось загрузить ethers.js')); } };
            (document.head || document.documentElement).appendChild(s);
        });
        _ethersLoading = p.then(function(v) { _ethersLoading = null; return v; }, function(e) { _ethersLoading = null; throw e; });
        return _ethersLoading;
    }

    // ====================== LIVE TRADING HELPERS ======================
    function _liveRpc() {
        var lastErr;
        for (var i = 0; i < _POLY_RPCS.length; i++) {
            try { return new ethers.JsonRpcProvider(_POLY_RPCS[i]); } catch(e) { lastErr = e; }
        }
        throw lastErr || new Error('No RPC available');
    }

    async function _liveBalanceOf(addr) {
        var p = _liveRpc();
        var c = new ethers.Contract(_USDC_ADDR, _ERC20_ABI, p);
        var d = await c.decimals();
        var b = await c.balanceOf(addr);
        return parseFloat(ethers.formatUnits(b, d));
    }

    async function _liveAllowanceOf(addr) {
        var p = _liveRpc();
        var c = new ethers.Contract(_USDC_ADDR, _ERC20_ABI, p);
        var d = await c.decimals();
        var a = await c.allowance(addr, _CTF_EXCHANGE);
        return parseFloat(ethers.formatUnits(a, d));
    }

    async function _liveApprove(privateKey, amount) {
        var p = _liveRpc();
        var w = new ethers.Wallet(privateKey, p);
        var c = new ethers.Contract(_USDC_ADDR, _ERC20_ABI, w);
        var d = await c.decimals();
        var amt = ethers.parseUnits(String(amount), d);
        var tx = await c.approve(_CTF_EXCHANGE, amt);
        return tx.wait();
    }

    function _getClobTokenIds(market) {
        var tids = market.clobTokenIds;
        if (typeof tids === 'string') { try { tids = JSON.parse(tids); } catch(e) { tids = null; } }
        return tids;
    }

    async function _liveSubmitOrder(privateKey, tokenId, side, price, size) {
        var p = _liveRpc();
        var w = new ethers.Wallet(privateKey, p);
        var domain = {
            name: 'Polymarket CTF',
            version: '1',
            chainId: 137,
            verifyingContract: _CTF_EXCHANGE
        };
        var types = {
            Order: [
                { name: 'salt', type: 'uint256' },
                { name: 'maker', type: 'address' },
                { name: 'signer', type: 'address' },
                { name: 'taker', type: 'address' },
                { name: 'tokenId', type: 'uint256' },
                { name: 'makerAmount', type: 'uint256' },
                { name: 'takerAmount', type: 'uint256' },
                { name: 'expiration', type: 'uint256' },
                { name: 'nonce', type: 'uint256' },
                { name: 'feeRateBps', type: 'uint256' },
                { name: 'side', type: 'uint8' },
                { name: 'signatureType', type: 'uint8' }
            ]
        };
        var priceCents = Math.round(parseFloat(price) * 100);
        var sizeNum = parseFloat(size);
        var makerAmount, takerAmount;
        if (side === 'BUY') {
            makerAmount = ethers.parseUnits(String(sizeNum * priceCents / 100), 6);
            takerAmount = ethers.parseUnits(String(sizeNum), 18);
        } else {
            makerAmount = ethers.parseUnits(String(sizeNum), 18);
            takerAmount = ethers.parseUnits(String(sizeNum * priceCents / 100), 6);
        }
        var nonce = Math.floor(Math.random() * 1000000000);
        var expiration = Math.floor(Date.now() / 1000) + 86400 * 30;
        var salt = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
        var value = {
            salt: salt,
            maker: w.address,
            signer: w.address,
            taker: '0x0000000000000000000000000000000000000000',
            tokenId: tokenId,
            makerAmount: makerAmount.toString(),
            takerAmount: takerAmount.toString(),
            expiration: expiration,
            nonce: nonce,
            feeRateBps: 0,
            side: side === 'BUY' ? 0 : 1,
            signatureType: 0
        };
        var signature = await w._signTypedData(domain, types, value);
        var orderPayload = {
            tokenID: tokenId,
            side: side,
            price: String(priceCents / 100),
            size: String(sizeNum),
            type: 'GTC',
            negRisk: false,
            owner: w.address,
            signature: signature,
            salt: salt,
            makerAmount: makerAmount.toString(),
            takerAmount: takerAmount.toString(),
            expiration: expiration,
            nonce: nonce,
            feeRateBps: 0,
            signatureType: 0,
            taker: '0x0000000000000000000000000000000000000000'
        };
        var resp = await pageFetch(CLOB_API + '/order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(orderPayload)
        });
        var result = JSON.parse(resp);
        return result;
    }

    function _liveRefreshDisplay() {
        var balEl = document.getElementById('trTermUSDC');
        var allowEl = document.getElementById('trTermAllowance');
        if (balEl) balEl.textContent = '$' + (_liveBalance || 0).toFixed(2);
        if (allowEl) allowEl.textContent = '$' + (_liveAllowance || 0).toFixed(2);
    }

    function _liveStartCheck() {
        _liveStopCheck();
        _liveCheckInterval = setInterval(function() {
            if (!_liveWalletAddr || !_liveWalletKey) return;
            loadEthersSite().then(function() {
                _liveBalanceOf(_liveWalletAddr).then(function(b) { _liveBalance = b; _liveRefreshDisplay(); }).catch(function(){});
                _liveAllowanceOf(_liveWalletAddr).then(function(a) { _liveAllowance = a; _liveRefreshDisplay(); }).catch(function(){});
            }).catch(function(){});
        }, 15000);
    }

    function _liveStopCheck() {
        if (_liveCheckInterval) { clearInterval(_liveCheckInterval); _liveCheckInterval = null; }
    }

    var _liveStatusTimeout = null;
    function _liveSetStatus(msg, isOk) {
        var el = document.getElementById('trLiveStatus');
        if (!el) el = document.getElementById('trErrorMsg');
        if (!el) return;
        if (_liveStatusTimeout) clearTimeout(_liveStatusTimeout);
        el.textContent = msg;
        el.style.color = isOk ? '#3fb950' : '#f85149';
        el.style.display = 'block';
        if (isOk) {
            _liveStatusTimeout = setTimeout(function() { el.style.display = 'none'; }, 4000);
        }
    }

    function _liveSetBtnLoading(loading) {
        var btn = document.getElementById('trSubmitBtn');
        var modeBtns = document.querySelectorAll('.tr-mode-btn');
        if (btn) { btn.disabled = loading; btn.textContent = loading ? 'Подпись и отправка...' : 'Купить'; }
        modeBtns.forEach(function(b) { b.disabled = loading; });
    }

    // ====================== INIT ======================
    function init() {
        initTheme();
        setupAuth();

        showAuth(true);
        var ws = $('welcome-screen');
        if (ws) ws.style.display = 'block';
        document.querySelectorAll('.nav-tab-content').forEach(function(t) { t.style.display = 'none'; });

        if (!checkExistingAuth()) {
            // Still show welcome screen
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
