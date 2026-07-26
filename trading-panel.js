/**
 * TradingPanel — React компонент торговой панели для Polymarket
 * Дизайн полностью соответствует расширению.
 */
(function() {
    'use strict';

    var fmt = function(n) {
        if (n == null || isNaN(n)) return '—';
        return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
    };
    var fmtPrice = function(n) {
        if (n == null || isNaN(n)) return '—';
        return (n * 100).toFixed(1) + '¢';
    };
    var h = React.createElement;

    /* ===== Profile presets ===== */
    var PROFILES = [
        { buy: [10, 25, 50, 100], sell: [25, 50, 75], sellUsd: [0, 0, 0] },
        { buy: [25, 50, 100, 250], sell: [25, 50, 75], sellUsd: [0, 0, 0] },
        { buy: [50, 100, 250, 500], sell: [25, 50, 75], sellUsd: [0, 0, 0] }
    ];

    /* ===== Theme hook ===== */
    function useTheme() {
        var _a = React.useState(function() {
            return document.body.classList.contains('light-theme') ? 'light' : 'dark';
        });
        var theme = _a[0]; var setTheme = _a[1];
        React.useEffect(function() {
            var obs = new MutationObserver(function() {
                setTheme(document.body.classList.contains('light-theme') ? 'light' : 'dark');
            });
            obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
            return function() { obs.disconnect(); };
        }, []);
        return theme;
    }

    /* ===== Main Component ===== */
    function TradingPanel(props) {
        var ev = props.eventData || {};
        var outcomes = ev.outcomes || [];
        var balance = ev.currentUserBalance || 0;
        var tickSize = ev.tickSize || 0.01;

        var theme = useTheme();
        var isLight = theme === 'light';

        var vs = {
            '--tp-bg': isLight ? '#FFFFFF' : '#0d1117',
            '--tp-card': isLight ? '#F8F9FA' : '#161b22',
            '--tp-input': isLight ? '#FFFFFF' : '#0d1117',
            '--tp-border': isLight ? '#dce0e8' : '#21262d',
            '--tp-text': isLight ? '#1a1a2e' : '#e6edf3',
            '--tp-text2': isLight ? '#656d76' : '#8b949e',
            '--tp-text3': isLight ? '#8b949e' : '#484f58',
            '--tp-buy': '#22c55e',
            '--tp-buy-bg': isLight ? 'rgba(34,197,94,0.08)' : 'rgba(34,197,94,0.1)',
            '--tp-sell': '#ef4444',
            '--tp-sell-bg': isLight ? 'rgba(239,68,68,0.08)' : 'rgba(239,68,68,0.1)',
            '--tp-accent': '#4C7F6E'
        };

        var _side = React.useState('buy');
        var side = _side[0]; var setSide = _side[1];
        var _otype = React.useState('market');
        var otype = _otype[0]; var setOtype = _otype[1];
        var _sel = React.useState(outcomes[0] ? outcomes[0].id : 'yes');
        var sel = _sel[0]; var setSel = _sel[1];
        var _amt = React.useState('');
        var amt = _amt[0]; var setAmt = _amt[1];
        var _lprice = React.useState('');
        var lprice = _lprice[0]; var setLprice = _lprice[1];
        var _lshares = React.useState('1');
        var lshares = _lshares[0]; var setLshares = _lshares[1];
        var _expiry = React.useState('never');
        var expiry = _expiry[0]; var setExpiry = _expiry[1];
        var _pidx = React.useState(0);
        var pidx = _pidx[0]; var setPidx = _pidx[1];
        var _sellmode = React.useState('pct');
        var sellmode = _sellmode[0]; var setSellmode = _sellmode[1];
        var _status = React.useState('idle');
        var status = _status[0]; var setStatus = _status[1];
        var _err = React.useState('');
        var err = _err[0]; var setErr = _err[1];

        var profile = PROFILES[pidx] || PROFILES[0];
        var amtNum = parseFloat(amt) || 0;
        var lpNum = parseFloat(lprice) || 0;
        var lsNum = parseInt(lshares, 10) || 0;

        /* Find selected outcome */
        var selOut = null;
        for (var i = 0; i < outcomes.length; i++) {
            if (outcomes[i].id === sel) { selOut = outcomes[i]; break; }
        }
        var price = selOut ? selOut.price : null;
        var isUp = sel === (outcomes[0] ? outcomes[0].id : 'yes');
        var isDown = !isUp;

        /* Other outcome for display */
        var otherOut = null;
        for (var j = 0; j < outcomes.length; j++) {
            if (outcomes[j].id !== sel) { otherOut = outcomes[j]; break; }
        }

        /* Computation */
        var total = 0;
        var payout = 0;
        if (otype === 'market' && price && amtNum > 0) {
            total = amtNum;
            payout = (amtNum / price) - amtNum;
        } else if (otype === 'limit' && lpNum > 0 && lsNum > 0) {
            total = (lpNum / 100) * lsNum;
            payout = (1 - lpNum / 100) * lsNum;
        }

        function handlePlace() {
            setErr('');
            if (otype === 'market') {
                if (!amtNum || amtNum <= 0) { setErr('Введите сумму'); return; }
                if (amtNum > balance) { setErr('Недостаточно средств'); return; }
                if (!price || price <= 0) { setErr('Цена недоступна'); return; }
            }
            setStatus('loading');
            setTimeout(function() {
                setStatus('success');
                if (props.onPlaceOrder) {
                    props.onPlaceOrder({
                        type: otype,
                        side: side,
                        outcomeId: sel,
                        amount: otype === 'market' ? amtNum : undefined,
                        price: otype === 'limit' ? lpNum / 100 : undefined,
                        shares: otype === 'limit' ? lsNum : undefined,
                        expiry: expiry
                    });
                }
                setTimeout(function() {
                    setStatus('idle');
                    setAmt(''); setLprice(''); setLshares('1');
                }, 2000);
            }, 600);
        }

        function handleQuickBuy(val) { setAmt(String(val)); }
        function handleQuickSell(pct) {
            if (!selOut) return;
            var sharesHeld = 100;
            var sellShares = Math.round(sharesHeld * pct / 100);
            setAmt(String(sellShares));
            setSide('sell');
        }

        var isBuy = side === 'buy';

        /* === SUCCESS === */
        if (status === 'success') {
            return h('div', { className: 'tr-panel', style: vs },
                h('div', { style: { padding: '40px 20px', textAlign: 'center' } },
                    h('div', { style: { fontSize: '28px', marginBottom: '8px' } }, '\u2713'),
                    h('div', { style: { fontSize: '14px', fontWeight: 700, color: 'var(--tp-text)', marginBottom: '4px' } },
                        isBuy ? 'Ордер размещён' : 'Продажа выполнена'),
                    h('div', { style: { fontSize: '12px', color: 'var(--tp-text2)' } },
                        isBuy ? 'Куплено на $' + fmt(amtNum) : 'Продано на $' + fmt(amtNum))
                )
            );
        }

        return h('div', { className: 'tr-panel', style: vs },

            /* === Wallet selector (demo mode) === */
            h('div', { className: 'tr-wallet-row' },
                h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, style: { flexShrink: 0, color: 'var(--tp-text3)' } },
                    h('path', { fill: 'currentColor', d: 'M21 18v1c0 1.1-.9 2-2 2H5c-1.11 0-2-.9-2-2V5c0-1.1.89-2 2-2h14c1.1 0 2 .9 2 2v1h-9c-1.11 0-2 .9-2 2v8c0 1.1.89 2 2 2h9zm-9-2h10V8H12v8zm4-2.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z' })),
                h('span', { className: 'tr-wallet-lbl' }, '\u0414\u0435\u043c\u043e \u0431\u0430\u043b\u0430\u043d\u0441:'),
                h('span', { style: { marginLeft: 'auto', fontSize: '12px', fontWeight: 700, color: 'var(--tp-text)', fontFamily: 'var(--font-mono)' } },
                    '$' + fmt(balance))
            ),

            /* === Profile presets P1/P2/P3 === */
            h('div', { className: 'tr-psetups' },
                [0, 1, 2].map(function(idx) {
                    return h('button', {
                        key: idx,
                        className: 'tr-psetup-btn' + (pidx === idx ? ' active' : ''),
                        onClick: function() { setPidx(idx); }
                    }, 'P' + (idx + 1));
                })
            ),

            /* === Quick buy amounts === */
            h('div', { className: 'tr-quick-row' },
                profile.buy.map(function(val) {
                    return h('button', {
                        key: val,
                        className: 'tr-qb-btn' + (amtNum === val ? ' active' : ''),
                        onClick: function() { handleQuickBuy(val); }
                    }, '$' + val);
                })
            ),

            /* === Amount input === */
            h('div', { className: 'tr-field' },
                h('label', { className: 'tr-field-label' }, '\u0421\u0443\u043c\u043c\u0430'),
                h('input', {
                    className: 'tr-input',
                    type: 'number',
                    min: 0,
                    step: 'any',
                    placeholder: '0.00',
                    value: amt,
                    onChange: function(e) { setAmt(e.target.value); }
                })
            ),

            /* === Order type === */
            h('div', { className: 'tr-type-group' },
                h('button', {
                    className: 'tr-type-btn' + (otype === 'market' ? ' active' : ''),
                    onClick: function() { setOtype('market'); }
                }, '\u0420\u044b\u043d\u043e\u043a'),
                h('button', {
                    className: 'tr-type-btn' + (otype === 'limit' ? ' active' : ''),
                    onClick: function() { setOtype('limit'); }
                }, '\u041b\u0438\u043c\u0438\u0442\u043d\u044b\u0439')
            ),

            /* === Outcome cards (UP / DOWN) === */
            outcomes.length >= 2
                ? h('div', { className: 'tr-direction' },
                    /* UP / first outcome */
                    h('button', {
                        className: 'tr-dir-btn tr-dir-up' + (isUp ? ' active' : ''),
                        onClick: function() { setSel(outcomes[0].id); }
                    },
                        h('div', { className: 'tr-dir-top' },
                            h('span', { className: 'tr-dir-arrow' }, '\u25B2'),
                            h('span', { className: 'tr-dir-label' }, outcomes[0].label.toUpperCase()),
                            h('span', { className: 'tr-dir-price' }, fmtPrice(outcomes[0].price))
                        ),
                        h('div', { className: 'tr-dir-bar' },
                            h('div', { className: 'tr-dir-bar-fill up', style: { width: ((outcomes[0].price || 0) * 100) + '%' } })
                        ),
                        h('div', { className: 'tr-dir-liq' }, 'liq $' + fmt(outcomes[0].volume || 0))
                    ),
                    /* DOWN / second outcome */
                    h('button', {
                        className: 'tr-dir-btn tr-dir-down' + (isDown ? ' active' : ''),
                        onClick: function() { setSel(outcomes[1].id); }
                    },
                        h('div', { className: 'tr-dir-top' },
                            h('span', { className: 'tr-dir-arrow' }, '\u25BC'),
                            h('span', { className: 'tr-dir-label' }, outcomes[1].label.toUpperCase()),
                            h('span', { className: 'tr-dir-price' }, fmtPrice(outcomes[1].price))
                        ),
                        h('div', { className: 'tr-dir-bar' },
                            h('div', { className: 'tr-dir-bar-fill down', style: { width: ((outcomes[1].price || 0) * 100) + '%' } })
                        ),
                        h('div', { className: 'tr-dir-liq' }, 'liq $' + fmt(outcomes[1].volume || 0))
                    )
                )
                : null,

            /* === Limit fields === */
            otype === 'limit'
                ? h('div', { className: 'tr-limit-fields' },
                    h('div', { className: 'tr-field' },
                        h('label', { className: 'tr-field-label' }, '\u0426\u0435\u043d\u0430 (\u0446\u0435\u043d\u0442\u044b)'),
                        h('div', { className: 'tr-stepper' },
                            h('button', { className: 'tr-step-btn', onClick: function() { var n = Math.max(1, lpNum - 1); setLprice(String(n)); } }, '\u2212'),
                            h('input', {
                                className: 'tr-input tr-input-center', type: 'number',
                                min: 1, max: 99, step: 1, placeholder: '0',
                                value: lprice,
                                onChange: function(e) { setLprice(e.target.value); }
                            }),
                            h('button', { className: 'tr-step-btn', onClick: function() { var n = Math.min(99, lpNum + 1); setLprice(String(n)); } }, '+')
                        )
                    ),
                    h('div', { className: 'tr-field' },
                        h('label', { className: 'tr-field-label' }, '\u041a\u043e\u043b-\u0432\u043e \u0434\u043e\u043b\u0435\u0439'),
                        h('input', {
                            className: 'tr-input', type: 'number',
                            min: 1, step: 1, placeholder: '1',
                            value: lshares,
                            onChange: function(e) { setLshares(e.target.value); }
                        })
                    ),
                    h('div', { className: 'tr-field' },
                        h('label', { className: 'tr-field-label' }, '\u0421\u0440\u043e\u043a \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u044f'),
                        h('div', { className: 'tr-expiry-row' },
                            ['never', '5m', '1h', '24h'].map(function(v) {
                                var labels = { never: '\u0411\u0435\u0441\u0441\u0440\u043e\u0447\u043d\u043e', '5m': '5 \u043c\u0438\u043d', '1h': '1 \u0447\u0430\u0441', '24h': '24 \u0447\u0430\u0441\u0430' };
                                return h('button', {
                                    key: v,
                                    className: 'tr-expiry-btn' + (expiry === v ? ' active' : ''),
                                    onClick: function() { setExpiry(v); }
                                }, labels[v] || v);
                            })
                        )
                    )
                )
                : null,

            /* === Sell section === */
            h('div', { className: 'tr-sell-section' },
                h('div', { className: 'tr-sell-header' },
                    h('span', { className: 'tr-sell-title' }, isBuy ? '' : '\u041f\u0420\u041e\u0414\u0410\u0422\u042c'),
                    h('div', { className: 'tr-sell-mode' },
                        h('button', {
                            className: 'tr-sell-mode-btn' + (sellmode === 'pct' ? ' active' : ''),
                            onClick: function() { setSellmode('pct'); }
                        }, '%'),
                        h('button', {
                            className: 'tr-sell-mode-btn' + (sellmode === 'usd' ? ' active' : ''),
                            onClick: function() { setSellmode('usd'); }
                        }, '$')
                    )
                ),
                h('div', { className: 'tr-quick-row' },
                    profile.sell.map(function(pct) {
                        return h('button', {
                            key: pct,
                            className: 'tr-qs-btn',
                            onClick: function() { handleQuickSell(pct); }
                        }, pct + '%');
                    }),
                    h('button', {
                        className: 'tr-qs-btn tr-qs-close',
                        onClick: function() { handleQuickSell(100); }
                    }, 'CLOSE 100%')
                )
            ),

            /* === Error === */
            err
                ? h('div', { className: 'tr-error' }, err)
                : null,

            /* === Submit === */
            h('button', {
                className: 'tr-submit ' + (isBuy ? 'tr-submit-buy' : 'tr-submit-sell'),
                disabled: status === 'loading',
                onClick: handlePlace
            }, status === 'loading' ? '...' : (isBuy ? '\u041a\u0443\u043f\u0438\u0442\u044c \u043f\u043e \u0440\u044b\u043d\u043a\u0443' : '\u041f\u0440\u043e\u0434\u0430\u0442\u044c'))
        );
    }

    /* ===== Mount ===== */
    function mountTradingPanel(containerId, eventData, onPlaceOrder) {
        var container = typeof containerId === 'string' ? document.getElementById(containerId) : containerId;
        if (!container) return null;
        return ReactDOM.createRoot(container).render(
            h(TradingPanel, { eventData: eventData, onPlaceOrder: onPlaceOrder })
        );
    }

    window.TradingPanel = TradingPanel;
    window.mountTradingPanel = mountTradingPanel;
})();
