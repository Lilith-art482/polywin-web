var chart = null;
var series = null;
var candleSeries = null;

function initChart(dark) {
  var container = document.getElementById('chart');
  if (chart) { chart.remove(); chart = null; }
  chart = LightweightCharts.createChart(container, {
    width: container.clientWidth,
    height: container.clientHeight,
    layout: {
      background: { type: 'solid', color: dark ? '#131722' : '#ffffff' },
      textColor: dark ? '#d1d4dc' : '#333',
    },
    grid: {
      vertLines: { color: dark ? 'rgba(42,46,57,0.6)' : 'rgba(0,0,0,0.06)' },
      horzLines: { color: dark ? 'rgba(42,46,57,0.6)' : 'rgba(0,0,0,0.06)' },
    },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: dark ? '#2a2e39' : '#e0e0e0' },
    timeScale: {
      borderColor: dark ? '#2a2e39' : '#e0e0e0',
      timeVisible: true,
      secondsVisible: false,
    },
  });
  candleSeries = chart.addCandlestickSeries({
    upColor: '#26a69a',
    downColor: '#ef5350',
    borderUpColor: '#26a69a',
    borderDownColor: '#ef5350',
    wickUpColor: '#26a69a',
    wickDownColor: '#ef5350',
  });
  series = chart.addLineSeries({
    color: '#2962ff',
    lineWidth: 2,
  });
  window.addEventListener('resize', function() {
    if (chart) {
      chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
    }
  });
}

function setData(data) {
  if (!data || !data.length) return;
  var candles = data.map(function(d) {
    return { time: d.time, open: d.open, high: d.high, low: d.low, close: d.close };
  });
  var line = data.map(function(d) {
    return { time: d.time, value: d.close };
  });
  candleSeries.setData(candles);
  series.setData(line);
  var last = data[data.length - 1];
  var prev = data.length > 1 ? data[data.length - 2] : null;
  document.getElementById('price').textContent = '$' + last.close.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
  if (prev) {
    var ch = ((last.close - prev.close) / prev.close * 100);
    var el = document.getElementById('change');
    el.textContent = (ch >= 0 ? '+' : '') + ch.toFixed(2) + '%';
    el.className = 'change ' + (ch >= 0 ? 'up' : 'down');
  }
  chart.timeScale().fitContent();
}

function updateLast(candle) {
  if (candleSeries) candleSeries.update(candle);
  if (series) series.update({ time: candle.time, value: candle.close });
  document.getElementById('price').textContent = '$' + candle.close.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
}

window.addEventListener('message', function(e) {
  var msg = e.data;
  if (!msg || !msg.type) return;
  if (msg.type === 'init') {
    initChart(msg.dark !== false);
    if (msg.symbol) {
      loadFromBinance(msg.symbol);
    }
  }
  if (msg.type === 'data' && msg.candles) {
    setData(msg.candles);
  }
  if (msg.type === 'update' && msg.candle) {
    updateLast(msg.candle);
  }
  if (msg.type === 'symbol') {
    loadFromBinance(msg.symbol);
  }
});

function loadFromBinance(symbol) {
  symbol = symbol || 'BTCUSDT';
  var binanceUrl = 'https://api.binance.com/api/v3/klines?symbol=' + symbol + '&interval=5m&limit=500';
  fetch(binanceUrl)
    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(data) {
      if (!Array.isArray(data) || !data.length) throw new Error('empty');
      var candles = data.map(function(k) {
        return { time: Math.floor(k[0] / 1000), open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]) };
      });
      setData(candles);
    })
    .catch(function() {});
}

initChart(true);
