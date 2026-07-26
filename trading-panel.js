/**
 * TradingPanel — React компонент торговой панели для Polymarket
 * 
 * Входные данные (eventData):
 * {
 *   eventId, question, outcomes: [{id, label, price, volume}],
 *   currentUserBalance, marketType, timeRemaining, tickSize
 * }
 * 
 * Callback: onPlaceOrder({ type, side, outcomeId, amount, price, shares, expiry })
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

    // ===== Mini Components =====

    function Spinner() {
        return h('svg', { className: 'tp-spin', viewBox: '0 0 24 24', width: 16, height: 16 },
            h('circle', { cx: 12, cy: 12, r: 10, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeDasharray: '31.4 31.4', strokeLinecap: 'round' })
        );
    }

    function TabBar(props) {
        return h('div', { className: 'tp-tabs' },
            h('button', {
                className: 'tp-tab' + (props.active === 'buy' ? ' tp-tab-buy active' : ''),
                onClick: function() { props.onChange('buy'); }
            }, 'Купить'),
            h('button', {
                className: 'tp-tab' + (props.active === 'sell' ? ' tp-tab-sell active' : ''),
                onClick: function() { props.onChange('sell'); }
            }, 'Продать')
        );
    }

    function OrderTypeToggle(props) {
        return h('div', { className: 'tp-toggle' },
            h('button', {
                className: 'tp-toggle-btn' + (props.active === 'market' ? ' active' : ''),
                onClick: function() { props.onChange('market'); }
            }, 'Рынок'),
            h('button', {
                className: 'tp-toggle-btn' + (props.active === 'limit' ? ' active' : ''),
                onClick: function() { props.onChange('limit'); }
            }, 'Лимит')
        );
    }

    function OutcomeSelector(props) {
        return h('div', { className: 'tp-outcomes' },
            props.outcomes.map(function(out) {
                var selected = props.selectedId === out.id;
                var isYes = out.id === 'yes';
                return h('button', {
                    key: out.id,
                    className: 'tp-outcome-btn' + (selected ? ' selected' : '') + (isYes ? ' yes' : ' no'),
                    onClick: function() { props.onSelect(out.id); }
                },
                    h('span', { className: 'tp-outcome-label' }, out.label),
                    h('span', { className: 'tp-outcome-price' }, fmtPrice(out.price))
                );
            })
        );
    }

    function QuickAmounts(props) {
        var percents = [10, 25, 50, 100];
        return h('div', { className: 'tp-quick-row' },
            percents.map(function(pct) {
                var val = Math.floor(props.balance * pct / 100);
                return h('button', {
                    key: pct,
                    className: 'tp-quick-btn',
                    onClick: function() { props.onSelect(val); }
                }, pct + '%');
            })
        );
    }

    function LimitQuickStep(props) {
        return h('div', { className: 'tp-quick-row' },
            [-100, -10, 10, 100].map(function(step) {
                return h('button', {
                    key: step,
                    className: 'tp-quick-btn tp-step-btn',
                    onClick: function() { props.onStep(step); }
                }, (step > 0 ? '+' : '') + step);
            })
        );
    }

    function ExpiryDropdown(props) {
        var options = [
            { value: 'gtc', label: 'Никогда' },
            { value: '1d', label: '1 день' },
            { value: '1w', label: '1 неделя' },
            { value: '1m', label: '1 месяц' }
        ];
        return h('div', { className: 'tp-field' },
            h('label', { className: 'tp-label' }, 'Срок действия'),
            h('div', { className: 'tp-select-wrap' },
                h('select', {
                    className: 'tp-select',
                    value: props.value,
                    onChange: function(e) { props.onChange(e.target.value); }
                },
                    options.map(function(o) {
                        return h('option', { key: o.value, value: o.value }, o.label);
                    })
                )
            )
        );
    }

    // ===== Theme Hook =====

    function useTheme() {
        var _a = React.useState(function() {
            return document.body.classList.contains('light-theme') ? 'light' : 'dark';
        });
        var theme = _a[0]; var setTheme = _a[1];

        React.useEffect(function() {
            var observer = new MutationObserver(function() {
                setTheme(document.body.classList.contains('light-theme') ? 'light' : 'dark');
            });
            observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
            return function() { observer.disconnect(); };
        }, []);

        var isLight = theme === 'light';
        return {
            theme: theme,
            vars: {
                '--tp-bg': isLight ? '#FFFFFF' : '#0B0E14',
                '--tp-bg-card': isLight ? '#F8F9FA' : '#14181F',
                '--tp-bg-input': isLight ? '#FFFFFF' : '#1A1F2B',
                '--tp-bg-hover': isLight ? '#F0F1F3' : '#1C2030',
                '--tp-border': isLight ? '#E0E2E7' : '#23273A',
                '--tp-text': isLight ? '#1A1A2E' : '#FFFFFF',
                '--tp-text-sec': isLight ? '#6B7280' : '#737B8D',
                '--tp-text-dim': isLight ? '#9CA3AF' : '#505767',
                '--tp-buy': '#00D4AA',
                '--tp-buy-bg': isLight ? 'rgba(0,212,170,0.08)' : 'rgba(0,212,170,0.1)',
                '--tp-sell': '#FF3B6F',
                '--tp-sell-bg': isLight ? 'rgba(255,59,111,0.08)' : 'rgba(255,59,111,0.1)',
                '--tp-radius': '12px'
            }
        };
    }

    // ===== Main Component =====

    function TradingPanel(props) {
        var eventData = props.eventData || {};
        var outcomes = eventData.outcomes || [];
        var balance = eventData.currentUserBalance || 0;
        var tickSize = eventData.tickSize || 0.01;

        var themeData = useTheme();

        var _a = React.useState('buy');
        var side = _a[0]; var setSide = _a[1];
        var _b = React.useState('market');
        var orderType = _b[0]; var setOrderType = _b[1];
        var _c = React.useState(outcomes[0] ? outcomes[0].id : 'yes');
        var selectedOutcome = _c[0]; var setSelectedOutcome = _c[1];
        var _d = React.useState('');
        var amount = _d[0]; var setAmount = _d[1];
        var _e = React.useState('');
        var limitPrice = _e[0]; var setLimitPrice = _e[1];
        var _f = React.useState('');
        var shares = _f[0]; var setShares = _f[1];
        var _g = React.useState('gtc');
        var expiry = _g[0]; var setExpiry = _g[1];
        var _h = React.useState('idle');
        var status = _h[0]; var setStatus = _h[1];
        var _j = React.useState('');
        var error = _j[0]; var setError = _j[1];

        var selectedOut = null;
        for (var i = 0; i < outcomes.length; i++) {
            if (outcomes[i].id === selectedOutcome) { selectedOut = outcomes[i]; break; }
        }

        var price = selectedOut ? selectedOut.price : null;
        var amountNum = parseFloat(amount) || 0;
        var limitPriceNum = parseFloat(limitPrice) || 0;
        var sharesNum = parseInt(shares, 10) || 0;

        var total = 0;
        var potentialWin = 0;
        var commission = 0;

        if (orderType === 'market' && price && amountNum > 0) {
            total = amountNum;
            var sharesCalc = amountNum / price;
            potentialWin = sharesCalc - amountNum;
            commission = amountNum * 0.02;
        } else if (orderType === 'limit' && limitPriceNum > 0 && sharesNum > 0) {
            total = limitPriceNum * sharesNum;
            potentialWin = (1 - limitPriceNum) * sharesNum;
        }

        function validate() {
            setError('');
            if (orderType === 'market') {
                if (!amountNum || amountNum <= 0) { setError('Введите сумму'); return false; }
                if (amountNum > balance) { setError('Недостаточно средств'); return false; }
                if (!price || price <= 0) { setError('Цена недоступна'); return false; }
            } else {
                if (!limitPriceNum || limitPriceNum < 0.01 || limitPriceNum > 0.99) {
                    setError('Цена должна быть от 1¢ до 99¢'); return false;
                }
                if (!sharesNum || sharesNum <= 0) { setError('Введите количество долей'); return false; }
                if (total > balance) { setError('Недостаточно средств (итого $' + fmt(total) + ')'); return false; }
            }
            return true;
        }

        function handlePlace() {
            if (!validate()) return;
            setStatus('loading');
            setTimeout(function() {
                setStatus('success');
                if (props.onPlaceOrder) {
                    props.onPlaceOrder({
                        type: orderType,
                        side: side,
                        outcomeId: selectedOutcome,
                        amount: orderType === 'market' ? amountNum : undefined,
                        price: orderType === 'limit' ? limitPriceNum : undefined,
                        shares: orderType === 'limit' ? sharesNum : undefined,
                        expiry: expiry
                    });
                }
                setTimeout(function() {
                    setStatus('idle');
                    setAmount('');
                    setShares('');
                    setLimitPrice('');
                }, 2000);
            }, 800);
        }

        function handlePercent(pct) {
            var val = Math.floor(balance * pct / 100);
            setAmount(String(val));
        }

        function handleSharesStep(step) {
            var next = sharesNum + step;
            if (next < 0) next = 0;
            setShares(String(next));
        }

        function handleLimitStep(step) {
            var next = Math.round((limitPriceNum + step * tickSize) * 100) / 100;
            if (next < 0.01) next = 0.01;
            if (next > 0.99) next = 0.99;
            setLimitPrice(String(next.toFixed(2)));
        }

        var isBuy = side === 'buy';
        var accentClass = isBuy ? 'tp-accent-buy' : 'tp-accent-sell';

        // Success state
        if (status === 'success') {
            return h('div', { className: 'tp-panel ' + accentClass, style: themeData.vars },
                h('div', { className: 'tp-success' },
                    h('div', { className: 'tp-success-icon' }, '✓'),
                    h('div', { className: 'tp-success-title' }, isBuy ? 'Ордер размещён' : 'Продажа выполнена'),
                    h('div', { className: 'tp-success-sub' },
                        orderType === 'market'
                            ? (isBuy ? 'Куплено' : 'Продано') + ' на $' + fmt(amountNum)
                            : 'Лимитный ордер: ' + fmt(sharesNum) + ' долей по ' + fmtPrice(limitPriceNum)
                    )
                )
            );
        }

        return h('div', { className: 'tp-panel ' + accentClass, style: themeData.vars },
            // Header
            h('div', { className: 'tp-header' },
                h('div', { className: 'tp-question' }, eventData.question || '—'),
                eventData.timeRemaining
                    ? h('div', { className: 'tp-timer' }, '⏱ ' + eventData.timeRemaining)
                    : null
            ),

            // Tabs: Buy / Sell
            h(TabBar, { active: side, onChange: setSide }),

            // Balance
            h('div', { className: 'tp-balance' },
                h('span', { className: 'tp-balance-label' }, 'Баланс'),
                h('span', { className: 'tp-balance-value' }, '$' + fmt(balance))
            ),

            // Outcome selector
            outcomes.length > 0
                ? h(OutcomeSelector, {
                    outcomes: outcomes,
                    selectedId: selectedOutcome,
                    onSelect: setSelectedOutcome
                })
                : null,

            // Order type toggle
            h(OrderTypeToggle, { active: orderType, onChange: setOrderType }),

            // === MARKET MODE ===
            orderType === 'market'
                ? h('div', { className: 'tp-form' },
                    h('div', { className: 'tp-field' },
                        h('label', { className: 'tp-label' }, 'Сумма ($)'),
                        h('input', {
                            className: 'tp-input',
                            type: 'number',
                            min: 1,
                            max: balance,
                            step: 1,
                            placeholder: '0.00',
                            value: amount,
                            onChange: function(e) { setAmount(e.target.value); }
                        }),
                        h('div', { className: 'tp-hint' }, 'Макс. доступно: $' + fmt(balance))
                    ),
                    h(QuickAmounts, { balance: balance, onSelect: handlePercent }),
                    price != null
                        ? h('div', { className: 'tp-info-row' },
                            h('span', null, '≈ ' + fmt(amountNum / price) + ' акций'),
                            h('span', null, 'Прибыль: +$' + fmt(potentialWin))
                        )
                        : null,
                    h('div', { className: 'tp-info-row tp-fee' },
                        h('span', null, 'Комиссия ~2%'),
                        h('span', null, '$' + fmt(commission))
                    )
                )
                : null,

            // === LIMIT MODE ===
            orderType === 'limit'
                ? h('div', { className: 'tp-form' },
                    h('div', { className: 'tp-field' },
                        h('label', { className: 'tp-label' }, 'Лимитная цена'),
                        h('div', { className: 'tp-stepper' },
                            h('button', { className: 'tp-step-btn', onClick: function() { handleLimitStep(-1); } }, '−'),
                            h('input', {
                                className: 'tp-input tp-input-center',
                                type: 'number',
                                min: 0.01,
                                max: 0.99,
                                step: tickSize,
                                value: limitPrice,
                                onChange: function(e) { setLimitPrice(e.target.value); }
                            }),
                            h('button', { className: 'tp-step-btn', onClick: function() { handleLimitStep(1); } }, '+')
                        )
                    ),
                    h('div', { className: 'tp-field' },
                        h('label', { className: 'tp-label' }, 'Количество долей'),
                        h('div', { className: 'tp-stepper' },
                            h('button', { className: 'tp-step-btn', onClick: function() { handleSharesStep(-10); } }, '−10'),
                            h('button', { className: 'tp-step-btn', onClick: function() { handleSharesStep(-1); } }, '−'),
                            h('input', {
                                className: 'tp-input tp-input-center',
                                type: 'number',
                                min: 1,
                                step: 1,
                                value: shares,
                                onChange: function(e) { setShares(e.target.value); }
                            }),
                            h('button', { className: 'tp-step-btn', onClick: function() { handleSharesStep(1); } }, '+'),
                            h('button', { className: 'tp-step-btn', onClick: function() { handleSharesStep(10); } }, '+10')
                        )
                    ),
                    h('div', { className: 'tp-info-row' },
                        h('span', null, 'Итого'),
                        h('span', { className: 'tp-bold' }, '$' + fmt(total))
                    ),
                    h('div', { className: 'tp-info-row' },
                        h('span', null, 'Выигрыш'),
                        h('span', { className: 'tp-profit' }, '+$' + fmt(potentialWin))
                    ),
                    h(ExpiryDropdown, { value: expiry, onChange: setExpiry })
                )
                : null,

            // Error
            error
                ? h('div', { className: 'tp-error' }, error)
                : null,

            // Submit button
            h('button', {
                className: 'tp-submit ' + accentClass,
                disabled: status === 'loading',
                onClick: handlePlace
            },
                status === 'loading'
                    ? h(Spinner, null)
                    : (isBuy ? 'Купить по рынку' : (orderType === 'market' ? 'Продать по рынку' : 'Разместить лимитный ордер'))
            )
        );
    }

    // ===== Mount function =====

    function mountTradingPanel(containerId, eventData, onPlaceOrder) {
        var container = typeof containerId === 'string' ? document.getElementById(containerId) : containerId;
        if (!container) { console.error('TradingPanel: container not found'); return null; }
        var el = React.createElement(TradingPanel, { eventData: eventData, onPlaceOrder: onPlaceOrder });
        return ReactDOM.createRoot(container).render(el);
    }

    // Expose globally
    window.TradingPanel = TradingPanel;
    window.mountTradingPanel = mountTradingPanel;
})();
