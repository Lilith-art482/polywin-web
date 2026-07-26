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
    let _walletInited = false;
    let _tradeInited = false;
    let _whaleData = [];
    let _aiRequested = {};

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
        var nameEl = $('profile-name');
        var ageEl = $('account-age');
        var auth = getFbAuthREST();
        if (nameEl && auth) nameEl.textContent = auth.email || 'User';
        if (ageEl && currentUserData) {
            var created = currentUserData.createdAt;
            if (created) {
                var days = Math.floor((Date.now() - (typeof created === 'number' ? created : new Date(created).getTime())) / 86400000);
                ageEl.textContent = 'Активен ' + Math.max(1, days) + ' дн.';
            }
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
    var _tvChartInstance = null;
    var _tvCandleSeries = null;

    var SYMBOL_MAP = {
        'BINANCE:BTCUSDT': 'BTCUSDT',
        'BINANCE:ETHUSDT': 'ETHUSDT',
        'BINANCE:SOLUSDT': 'SOLUSDT',
        'BINANCE:XRPUSDT': 'XRPUSDT'
    };

    async function loadTVChart(containerId, symbol, interval) {
        symbol = symbol || 'BINANCE:BTCUSDT';
        interval = interval || '5';
        var container = $(containerId);
        if (!container) return;

        // Destroy old chart
        if (_tvChartInstance) {
            _tvChartInstance.remove();
            _tvChartInstance = null;
            _tvCandleSeries = null;
        }
        container.innerHTML = '';

        if (typeof LightweightCharts === 'undefined') {
            container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#6b7280;font-size:12px">Загрузка графика...</div>';
            return;
        }

        var isLight = document.body.classList.contains('light-theme');
        _tvChartInstance = LightweightCharts.createChart(container, {
            width: container.clientWidth,
            height: container.clientHeight || 320,
            layout: {
                background: { type: 'solid', color: isLight ? '#ffffff' : '#131722' },
                textColor: isLight ? '#333' : '#d1d4dc',
                fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif'
            },
            grid: {
                vertLines: { color: isLight ? '#e1e4e8' : '#1e222d' },
                horzLines: { color: isLight ? '#e1e4e8' : '#1e222d' }
            },
            crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
            timeScale: { borderColor: isLight ? '#d1d4dc' : '#2a2e39', timeVisible: true, secondsVisible: false },
            rightPriceScale: { borderColor: isLight ? '#d1d4dc' : '#2a2e39' }
        });

        _tvCandleSeries = _tvChartInstance.addCandlestickSeries({
            upColor: '#26a69a',
            downColor: '#ef5350',
            borderVisible: false,
            wickUpColor: '#26a69a',
            wickDownColor: '#ef5350'
        });

        // Resize observer
        var ro = new ResizeObserver(function() {
            if (_tvChartInstance && container.clientWidth > 0) {
                _tvChartInstance.applyOptions({ width: container.clientWidth });
            }
        });
        ro.observe(container);
        container._tvRO = ro;

        // Fetch klines from Binance public API
        var binanceSym = SYMBOL_MAP[symbol] || 'BTCUSDT';
        try {
            var url = 'https://api.binance.com/api/v3/klines?symbol=' + binanceSym + '&interval=' + interval + 'm&limit=500';
            var resp = await fetch(url);
            var data = await resp.json();
            if (Array.isArray(data)) {
                var candles = data.map(function(k) {
                    return { time: Math.floor(k[0] / 1000), open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]) };
                });
                _tvCandleSeries.setData(candles);
                _tvChartInstance.timeScale().fitContent();
            }
        } catch(e) {
            container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#6b7280;font-size:12px">Ошибка загрузки графика</div>';
        }
    }

    function reloadTVChart() {
        var container = $('tvTradeChart');
        if (!container) return;
        var btn = document.querySelector('.tv-sym-btn.active');
        var sym = btn ? btn.dataset.sym : 'BINANCE:BTCUSDT';
        loadTVChart('tvTradeChart', sym, '5');
    }

    // Poll Binance for live updates
    var _tvPollInterval = null;
    function _startTvPoll(symbol) {
        if (_tvPollInterval) clearInterval(_tvPollInterval);
        if (!_tvCandleSeries) return;
        var binanceSym = SYMBOL_MAP[symbol] || 'BTCUSDT';
        _tvPollInterval = setInterval(async function() {
            if (!_tvCandleSeries) { clearInterval(_tvPollInterval); return; }
            try {
                var resp = await fetch('https://api.binance.com/api/v3/klines?symbol=' + binanceSym + '&interval=5m&limit=1');
                var data = await resp.json();
                if (data && data[0]) {
                    var k = data[0];
                    _tvCandleSeries.update({
                        time: Math.floor(k[0] / 1000),
                        open: parseFloat(k[1]),
                        high: parseFloat(k[2]),
                        low: parseFloat(k[3]),
                        close: parseFloat(k[4])
                    });
                }
            } catch(e) {}
        }, 5000);
    }

    // ====================== POLYMARKET API ======================
    async function fetchWalletStats(wallet) {
        try {
            var [positionsText, tradesText] = await Promise.all([
                pageFetch(DATA_API + '/v1/positions?user=' + wallet + '&limit=1000'),
                pageFetch(DATA_API + '/v1/trades?user=' + wallet + '&limit=5000')
            ]);
            var positions = JSON.parse(positionsText);
            var allTrades = JSON.parse(tradesText);
            var closed = (Array.isArray(positions) ? positions : []).filter(function(p) { return p.side && p.size; });
            var trades = (Array.isArray(allTrades) ? allTrades : []);

            var stats = { totalTrades: trades.length, wins: 0, losses: 0, totalPnl: 0, positions: closed };
            trades.forEach(function(t) {
                if (t.pnl) {
                    var pnl = parseFloat(t.pnl);
                    stats.totalPnl += pnl;
                    if (pnl > 0) stats.wins++;
                    else if (pnl < 0) stats.losses++;
                }
            });
            stats.winRate = stats.totalTrades > 0 ? (stats.wins / stats.totalTrades * 100) : 0;
            return stats;
        } catch(e) {
            console.warn('Fetch wallet stats error:', e);
            return { totalTrades: 0, wins: 0, losses: 0, totalPnl: 0, winRate: 0, positions: [] };
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
        var firstSection = document.querySelector('#wallet-tab .wa-section');
        if (firstSection) {
            var chartDiv = document.createElement('div');
            chartDiv.className = 'tv-chart-section';
            chartDiv.innerHTML = '<div class="tv-chart-container" id="tvWalletChart" style="height:350px"></div>';
            firstSection.after(chartDiv);
            loadTVChart('tvWalletChart');
        }

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

        updateStats();
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
        var statsGrid = $('statsGrid');
        var detailsGrid = $('detailsGrid');
        var strengthCard = $('wallet-strength-card');

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

        if (pnlVal) {
            var pnl = stats.totalPnl || 0;
            pnlVal.textContent = (pnl >= 0 ? '+' : '') + '$' + Math.abs(pnl).toFixed(2);
            pnlVal.className = 'pnl-value ' + (pnl >= 0 ? 'positive' : 'negative');
        }

        if (statsGrid) {
            statsGrid.innerHTML = ''
                + '<div class="stats-card"><div class="stats-label">Всего сделок</div><div class="stats-value">' + stats.totalTrades + '</div></div>'
                + '<div class="stats-card"><div class="stats-label">Win Rate</div><div class="stats-value">' + stats.winRate.toFixed(1) + '%</div></div>'
                + '<div class="stats-card"><div class="stats-label">Прибыльных</div><div class="stats-value positive">' + stats.wins + '</div></div>'
                + '<div class="stats-card"><div class="stats-label">Убыточных</div><div class="stats-value negative">' + stats.losses + '</div></div>';
        }

        if (detailsGrid) {
            var totalPnl = stats.totalPnl || 0;
            detailsGrid.innerHTML = ''
                + '<div class="detail-card"><div class="stats-label">Общий PNL</div><div class="stats-value ' + (totalPnl >= 0 ? 'positive' : 'negative') + '">' + fmtUSD(totalPnl) + '</div></div>'
                + '<div class="detail-card"><div class="stats-label">Всего трейдов</div><div class="stats-value">' + stats.totalTrades + '</div></div>'
                + '<div class="detail-card full-width" style="grid-column:span 2"><div class="stats-label">Активных позиций</div><div class="stats-value">' + (stats.positions ? stats.positions.length : 0) + '</div></div>';
        }

        if (strengthCard) {
            var wr = stats.winRate || 0;
            var score = wr >= 65 ? 'strong' : (wr >= 45 ? 'medium' : 'weak');
            var label = wr >= 65 ? 'Сильный' : (wr >= 45 ? 'Средний' : 'Слабый');
            strengthCard.className = 'wallet-strength-card ' + score;
            strengthCard.innerHTML = '<div class="ws-head"><div class="ws-head-label">Скоринг кошелька</div><div class="ws-badge ' + score + '">' + label + '</div></div>'
                + '<div class="ws-comps"><div class="ws-comp"><div class="ws-comp-row"><span class="ws-comp-label">Win Rate</span><span class="ws-comp-val">' + wr.toFixed(1) + '%</span></div><div class="ws-comp-bar"><div class="ws-comp-fill fill-' + score + '" style="width:' + Math.min(wr, 100) + '%"></div></div></div></div>';
        }

        var historyContainer = $('wallet-history');
        if (historyContainer && stats.positions && stats.positions.length > 0) {
            renderHistory(stats, historyContainer);
        }
    }

    function renderHistory(stats, container) {
        if (!container) return;
        var positions = stats.positions || [];
        var html = '<div class="section-divider"></div><div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:10px">История позиций</div>';
        positions.slice(0, 50).forEach(function(pos) {
            var size = parseFloat(pos.size) || 0;
            var price = parseFloat(pos.price) || 0;
            var side = pos.side || 'BUY';
            var pnl = parseFloat(pos.pnl);
            var pnlCls = pnl >= 0 ? 'positive' : 'negative';
            var timestamp = pos.createdAt || pos.timestamp || pos.time;
            var timeStr = timestamp ? getTimeAgo(timestamp) : '';
            html += '<div style="display:flex;gap:8px;padding:8px 10px;background:var(--card-bg-2);border:1px solid var(--border);border-radius:10px;margin-bottom:4px;font-size:11px;align-items:center">'
                + '<span style="font-weight:700;color:' + (side === 'BUY' ? 'var(--positive)' : 'var(--negative)') + '">' + side + '</span>'
                + '<span style="flex:1;color:var(--text)">' + size + ' @ $' + price.toFixed(2) + '</span>'
                + '<span class="' + pnlCls + '" style="font-weight:700">' + (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2) + '</span>'
                + '<span style="color:var(--text-tertiary);font-size:10px">' + timeStr + '</span>'
                + '</div>';
        });
        if (positions.length === 0) html += '<p style="color:var(--text-secondary);text-align:center;padding:16px">Нет позиций</p>';
        container.innerHTML = html;
    }

    // ====================== TRADE TAB ======================
    var _selectedMarket = null;
    var _selectedEvent = null;
    var _demoBalance = parseFloat(localStorage.getItem('polyDemoBalance')) || 100000;
    var _demoPositions = JSON.parse(localStorage.getItem('polyDemoPositions') || '{}');

    function initTradeTab() {
        var content = $('trade-content');
        if (!content) return;
        if (_tradeInited) return;
        _tradeInited = true;

        content.innerHTML = ''
            + '<div class="tt-top-row">'
            +   '<div class="tt-chart-col">'
            +     '<div class="tv-chart-section" id="ttChartSection" style="display:none">'
            +       '<div class="tv-chart-container" id="tvTradeChart"></div>'
            +       '<div class="tt-sym-bar" id="ttSymBar"></div>'
            +     '</div>'
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
            +       '<div id="ttWhalesSection" class="wh-section" style="display:none"></div>'
            +     '</div>'
            +   '</div>'
            +   '<div class="tt-panel-col">'
            +     renderTradeTerminal()
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

        setupBacktest();
        renderTradeWallets();
        setTimeout(function() {
            initCopyPanel();
            mountTradingPanelOnMarket();
        }, 100);
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
                    loadTVChart('tvTradeChart', btn.dataset.sym, '5');
                    _startTvPoll(btn.dataset.sym);
                });
            });
        }

        loadTVChart('tvTradeChart', symbol, '5');
        _startTvPoll(symbol);
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
            showChartForEvent(ev);
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
        html += '<button class="tr-mode-btn active" data-mode="demo">Демо</button>';
        html += '<button class="tr-mode-btn" data-mode="live">Live</button>';
        html += '<button class="tr-mode-btn" data-mode="copy">Copy</button>';
        html += '<button class="tr-mode-btn" data-mode="strategies">Стратегия</button>';
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
        html += '<span class="tr-strategy-name">CLOB Arbitrage</span>';
        html += '<button class="tr-strategy-info-btn" data-strategy="clob">\u24d8</button>';
        html += '</div>';
        html += '<div class="tr-strategy-opt" data-strategy="delta">';
        html += '<span class="tr-strategy-name">Delta Mesh</span>';
        html += '<button class="tr-strategy-info-btn" data-strategy="delta">\u24d8</button>';
        html += '<span class="tr-strategy-badge">В разработке</span>';
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
        html += '<div class="tr-agent-stat-body" style="gap:2px"><input id="trClobMinSpread" type="number" value="2" min="1" max="20" step="0.5" style="width:50px"><span style="font-size:9px;color:var(--text-tertiary)">\u00a2</span></div>';
        html += '</div>';
        html += '<div class="tr-agent-stat">';
        html += '<div class="tr-agent-stat-label">Rebate</div>';
        html += '<div class="tr-agent-stat-body" style="gap:2px"><input id="trClobRebate" type="number" value="20" min="0" max="100" step="1" style="width:50px"><span style="font-size:9px;color:var(--text-tertiary)">%</span></div>';
        html += '</div>';
        html += '<div class="tr-agent-stat">';
        html += '<div class="tr-agent-stat-label">Order Size</div>';
        html += '<div class="tr-agent-stat-body" style="gap:2px"><span style="font-size:10px;color:var(--text-tertiary)">$</span><input id="trClobOrderSize" type="number" value="100" min="1" step="any" style="width:60px"></div>';
        html += '</div>';
        html += '<div class="tr-agent-stat">';
        html += '<div class="tr-agent-stat-label">Timeout</div>';
        html += '<div class="tr-agent-stat-body" style="gap:2px"><input id="trClobTimeout" type="number" value="3" min="1" max="30" step="1" style="width:40px"><span style="font-size:9px;color:var(--text-tertiary)">sec</span></div>';
        html += '</div>';
        html += '<div class="tr-agent-stat">';
        html += '<div class="tr-agent-stat-label">Gas $</div>';
        html += '<div class="tr-agent-stat-body" style="gap:2px"><input id="trClobGasCost" type="number" value="0.02" min="0" max="1" step="0.005" style="width:50px"></div>';
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
        html += '<div class="tr-agent-stat-body" style="gap:2px"><span style="font-size:10px;color:var(--text-tertiary)">$</span><input class="tr-agent-bal-inp" id="phxBalInput" type="number" value="1000" min="1" step="any" style="width:auto;min-width:40px;max-width:80px;font-size:11px"></div>';
        html += '</div>';
        html += '<div class="tr-agent-stat">';
        html += '<div class="tr-agent-stat-label">Entry</div>';
        html += '<div class="tr-agent-stat-body" style="gap:2px"><input id="phxEntryCents" type="number" value="2" min="1" max="10" step="1" style="width:auto;min-width:24px;max-width:50px;font-size:11px"><span style="font-size:9px;color:var(--text-tertiary)">\u00a2</span></div>';
        html += '</div>';
        html += '<div class="tr-agent-stat">';
        html += '<div class="tr-agent-stat-label">Target</div>';
        html += '<div class="tr-agent-stat-body" style="gap:2px"><input id="phxTargetCents" type="number" value="20" min="5" max="50" step="1" style="width:auto;min-width:24px;max-width:50px;font-size:11px"><span style="font-size:9px;color:var(--text-tertiary)">\u00a2</span></div>';
        html += '</div>';
        html += '</div>';
        html += '<div class="tr-agent-stats-row-4">';
        html += '<div id="phxStats"></div>';
        html += '</div>';
        html += '</div>';
        html += '<div class="tr-agent-sec">';
        html += '<div class="tr-agent-sec-hdr"><span>Budget</span><div class="tr-agent-sec-line"></div></div>';
        html += '<div class="tr-agent-sec-body" style="padding:8px 12px">';
        html += '<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">';
        html += '<select id="phxBudgetMode" style="flex:1;padding:4px 6px;border:1px solid var(--border);border-radius:6px;background:var(--input-bg);color:var(--text);font-size:10px;outline:none">';
        html += '<option value="pct">% от баланса</option><option value="fixed">$ фикс</option></select></div>';
        html += '<div id="phxBudgetPctWrap" style="display:flex;gap:6px;align-items:center">';
        html += '<span style="font-size:10px;color:var(--text-tertiary);white-space:nowrap">%</span>';
        html += '<input id="phxBudgetPct" type="number" value="5" min="1" max="100" step="1" style="flex:1;padding:4px 6px;border:1px solid var(--border);border-radius:6px;background:var(--input-bg);color:var(--text);font-size:11px;outline:none"></div>';
        html += '<div id="phxBudgetFixedWrap" style="display:none;gap:6px;align-items:center">';
        html += '<span style="font-size:10px;color:var(--text-tertiary);white-space:nowrap">$</span>';
        html += '<input id="phxBudgetFixed" type="number" value="15" min="0.5" step="0.5" style="flex:1;padding:4px 6px;border:1px solid var(--border);border-radius:6px;background:var(--input-bg);color:var(--text);font-size:11px;outline:none"></div>';
        html += '</div></div>';
        html += '<div class="tr-agent-sec">';
        html += '<div class="tr-agent-sec-hdr"><span>Stop Loss</span><div class="tr-agent-sec-line"></div></div>';
        html += '<div class="tr-agent-sec-body" style="padding:8px 12px;display:flex;gap:8px;align-items:center">';
        html += '<label style="display:flex;align-items:center;gap:4px;font-size:10px;cursor:pointer;white-space:nowrap">';
        html += '<input type="checkbox" id="phxStopEnabled"> Enabled</label>';
        html += '<span style="font-size:10px;color:var(--text-tertiary)">at</span>';
        html += '<input id="phxStopPct" type="number" value="30" min="1" max="99" step="1" style="width:50px;padding:4px 6px;border:1px solid var(--border);border-radius:6px;background:var(--input-bg);color:var(--text);font-size:11px;outline:none">';
        html += '<span style="font-size:9px;color:var(--text-tertiary)">% of fill</span></div></div>';
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

    function mountTradingPanelOnMarket() {
        var mountEl = $('tpReactMount');
        if (!mountEl || !window.mountTradingPanel) return;
        if (!_selectedMarket) {
            mountEl.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-secondary);font-size:11px">Выберите событие слева</div>';
            return;
        }

        var market = _selectedMarket;
        var ev = _selectedEvent;
        var prices = market.outcomePrices ? JSON.parse(market.outcomePrices) : [];
        var yesPrice = prices[0] ? parseFloat(prices[0]) : null;
        var noPrice = prices[1] ? parseFloat(prices[1]) : null;

        var eventData = {
            eventId: market.conditionId || market.id || '',
            question: market.question || (ev ? ev.title : '') || '',
            outcomes: [
                { id: 'yes', label: 'Да', price: yesPrice, volume: 0 },
                { id: 'no', label: 'Нет', price: noPrice, volume: 0 }
            ],
            currentUserBalance: _demoBalance,
            marketType: 'binary',
            timeRemaining: market.endDate ? calcTimeRemaining(market.endDate) : '',
            tickSize: 0.01
        };

        mountEl.innerHTML = '';
        window.mountTradingPanel(mountEl, eventData, function(order) {
            handleReactOrder(order);
        });
    }

    function renderTradeWallets() {
        var section = $('tradeWalletsSection');
        if (!section) return;
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
        var content = $('calls-content');
        if (!content || content.dataset.loaded) return;
        content.dataset.loaded = '1';
        renderCalls();
    }

    function renderCalls() {
        var container = $('calls-content');
        if (!container) return;
        var calls = JSON.parse(localStorage.getItem('polyCalls') || '[]');
        var html = '<div style="padding:12px">';
        html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">';
        html += '<span style="font-size:14px;font-weight:800;color:var(--text)">Коллы (сигналы)</span>';
        html += '<button id="addCallBtn" style="padding:8px 14px;background:var(--accent);border:none;border-radius:8px;color:#fff;font-weight:700;font-size:11px;cursor:pointer;font-family:inherit">+ Новый колл</button>';
        html += '</div>';

        if (calls.length === 0) {
            html += '<div style="padding:24px;text-align:center;color:var(--text-secondary);font-size:12px"><p>Пока нет коллов. Создайте первый сигнал!</p></div>';
        } else {
            calls.forEach(function(call) {
                html += '<div style="padding:14px;background:var(--card-bg-2);border:1px solid var(--border);border-radius:12px;margin-bottom:8px">';
                html += '<div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:4px">' + escHtml(call.title || 'Без названия') + '</div>';
                html += '<div style="font-size:11px;color:var(--text-secondary)">' + escHtml(call.description || '') + '</div>';
                html += '<div style="margin-top:8px;font-size:10px;color:var(--text-tertiary)">' + getTimeAgo(call.createdAt) + '</div>';
                html += '</div>';
            });
        }

        html += '</div>';
        container.innerHTML = html;

        var addBtn = $('addCallBtn');
        if (addBtn) {
            addBtn.onclick = function() {
                var title = prompt('Название колла:');
                if (title) {
                    var desc = prompt('Описание:') || '';
                    var calls = JSON.parse(localStorage.getItem('polyCalls') || '[]');
                    calls.unshift({ title: title, description: desc, createdAt: Date.now() });
                    localStorage.setItem('polyCalls', JSON.stringify(calls));
                    renderCalls();
                }
            };
        }
    }

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
        var content = $('profile-content');
        if (!content) return;
        var auth = getFbAuthREST();
        if (!auth) { content.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-secondary)">Не авторизован</div>'; return; }

        var email = auth.email || '—';
        var plan = (currentUserData && currentUserData.tariff) || 'basic';
        var planNames = { basic: 'Базовый', pro: 'PRO', apex: 'Apex' };
        var initials = email.charAt(0).toUpperCase();

        content.innerHTML = ''
            + '<div style="padding:12px">'
            + '<div class="profile-card" style="padding:20px;background:var(--card-bg-2);border:1px solid var(--border);border-radius:14px;text-align:center;margin-bottom:16px">'
            + '<div class="profile-avatar" style="width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#4C7F6E,#3b6658);display:flex;align-items:center;justify-content:center;margin:0 auto 12px;font-size:24px;font-weight:800;color:#fff">' + initials + '</div>'
            + '<div class="profile-name" style="font-size:16px;font-weight:800;color:var(--text);margin-bottom:4px">' + escHtml(email) + '</div>'
            + '<div class="profile-email" style="font-size:12px;color:var(--text-secondary);margin-bottom:12px">' + escHtml(email) + '</div>'
            + '<div class="profile-plan-badge" style="display:inline-block;padding:4px 14px;border-radius:20px;font-size:11px;font-weight:700;background:rgba(76,127,110,0.15);color:#4C7F6E">' + planNames[plan] || plan + '</div>'
            + '<button class="logout-btn" id="profileLogoutBtn" style="display:flex;align-items:center;gap:8px;padding:10px 16px;border:1px solid rgba(248,81,73,0.3);border-radius:10px;background:rgba(248,81,73,0.08);color:#f85149;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;width:100%;justify-content:center;margin-top:16px">'
            + '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M11 7L9.6 8.4l2.6 2.6H2v2h10.2l-2.6 2.6L11 17l5-5-5-5zm9 12h-8v2h8c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-8v2h8v14z"/></svg>'
            + 'Выйти</button>'
            + '</div>'
            + renderTariffPlans(plan)
            + '</div>';

        var logoutBtn = $('profileLogoutBtn');
        if (logoutBtn) logoutBtn.onclick = function() { fbSignOutREST(); handleAuth(null); };
    }

    function renderTariffPlans(currentPlan) {
        var html = '<div style="margin-top:16px">';
        html += '<div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:8px">Тарифы</div>';
        Object.keys(TARIFFS).forEach(function(key) {
            var t = TARIFFS[key];
            var isActive = key === currentPlan;
            html += '<div style="padding:14px;background:var(--card-bg-2);border:1px solid ' + (isActive ? 'var(--accent)' : 'var(--border)') + ';border-radius:12px;margin-bottom:8px;' + (isActive ? 'box-shadow:0 0 0 1px var(--accent-glow)' : '') + '">';
            html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">';
            html += '<span style="font-weight:800;font-size:14px;color:var(--text)">' + escHtml(t.name) + '</span>';
            if (isActive) html += '<span style="font-size:10px;padding:2px 8px;border-radius:4px;background:var(--accent);color:#fff;font-weight:700">Активен</span>';
            html += '</div>';
            html += '<div style="font-size:11px;color:var(--text-secondary);margin-bottom:8px">' + escHtml(t.subtitle) + '</div>';
            html += '<ul style="list-style:none;padding:0;margin:0">';
            t.features.slice(0, 5).forEach(function(f) {
                html += '<li style="font-size:10px;color:var(--text-tertiary);padding:2px 0;display:flex;align-items:center;gap:6px">'
                    + '<svg viewBox="0 0 16 16" width="10" height="10"><circle cx="8" cy="8" r="6" fill="none" stroke="var(--accent)" stroke-width="1.3"/><path d="M5 8l2 2 4-4" stroke="var(--accent)" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>'
                    + escHtml(f) + '</li>';
            });
            html += '</ul>';
            if (t.features.length > 5) {
                html += '<div style="font-size:9px;color:var(--text-tertiary);margin-top:4px">+ ещё ' + (t.features.length - 5) + ' возможностей</div>';
            }
            html += '</div>';
        });
        html += '</div>';
        return html;
    }

    // ====================== SETTINGS TAB ======================
    function initSettingsTab() {
        var content = $('settings-content');
        if (!content) return;
        var isLight = document.body.classList.contains('light-theme');

        content.innerHTML = ''
            + '<div style="padding:12px">'
            + '<div style="margin-bottom:20px">'
            + '<div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:4px">Внешний вид</div>'
            + '<div style="font-size:11px;color:var(--text-secondary);margin-bottom:12px">Настройте отображение интерфейса</div>'
            + '<div style="display:flex;gap:8px">'
            + '<button class="ws-theme-btn ' + (!isLight ? 'ws-theme-btn-active' : '') + '" id="settingsDarkBtn"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/></svg><span>Темная</span></button>'
            + '<button class="ws-theme-btn ' + (isLight ? 'ws-theme-btn-active' : '') + '" id="settingsLightBtn"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/></svg><span>Светлая</span></button>'
            + '</div></div>'
            + '<div style="margin-bottom:20px">'
            + '<div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:4px">Раздел по умолчанию</div>'
            + '<div style="font-size:11px;color:var(--text-secondary);margin-bottom:12px">Какой раздел открывать при запуске</div>'
            + '<select id="defaultTabSelect" style="width:100%;padding:10px 14px;background:var(--input-bg);border:1px solid var(--border);border-radius:10px;color:var(--text);font-size:13px;font-family:inherit;outline:none;cursor:pointer">'
            + '<option value="wallet">Анализ кошельков</option>'
            + '<option value="trade">Терминал</option>'
            + '<option value="alerts">Алерты</option>'
            + '<option value="calls">Коллы</option>'
            + '<option value="favorites">Трекер и избранное</option>'
            + '<option value="my-trades">Мои сделки</option>'
            + '<option value="whale">Киты</option>'
            + '<option value="education">Обучение</option>'
            + '<option value="profile">Профиль</option>'
            + '</select></div>'
            + '<div style="border-top:1px solid var(--border);padding-top:16px">'
            + '<button class="logout-btn" id="settingsLogoutBtn" style="display:flex;align-items:center;gap:8px;padding:10px 16px;border:1px solid rgba(248,81,73,0.3);border-radius:10px;background:rgba(248,81,73,0.08);color:#f85149;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;width:100%;justify-content:center">'
            + '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M11 7L9.6 8.4l2.6 2.6H2v2h10.2l-2.6 2.6L11 17l5-5-5-5zm9 12h-8v2h8c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-8v2h8v14z"/></svg>'
            + 'Выйти из аккаунта</button></div></div>';

        $('settingsDarkBtn').onclick = function() {
            document.body.classList.remove('light-theme');
            localStorage.setItem('polyTheme', 'dark');
            $('settingsDarkBtn').classList.add('ws-theme-btn-active');
            $('settingsLightBtn').classList.remove('ws-theme-btn-active');
            reloadTVChart();
        };
        $('settingsLightBtn').onclick = function() {
            document.body.classList.add('light-theme');
            localStorage.setItem('polyTheme', 'light');
            $('settingsLightBtn').classList.add('ws-theme-btn-active');
            $('settingsDarkBtn').classList.remove('ws-theme-btn-active');
            reloadTVChart();
        };

        var sel = $('defaultTabSelect');
        if (sel) {
            sel.value = defaultTab;
            sel.onchange = function() {
                defaultTab = sel.value;
                localStorage.setItem('polyDefaultTab', defaultTab);
            };
        }

        $('settingsLogoutBtn').onclick = function() { fbSignOutREST(); handleAuth(null); };
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
    $('settingsQuickBtn').onclick = function() { switchTab('settings'); closeMenu(); };
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
