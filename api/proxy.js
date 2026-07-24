const https = require('https');
const http = require('http');
const url = require('url');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const target = req.query.url;
  if (!target) {
    res.status(400).json({ error: 'Missing ?url parameter' });
    return;
  }

  const parsed = url.parse(target);
  const mod = parsed.protocol === 'https:' ? https : http;

  var body = null;
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    body = await new Promise(function(resolve) {
      var chunks = [];
      req.on('data', function(c) { chunks.push(c); });
      req.on('end', function() { resolve(Buffer.concat(chunks)); });
    });
  }

  const opts = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.path || '/',
    method: req.method,
    headers: Object.assign({}, req.headers, { host: parsed.hostname }),
  };

  delete opts.headers['x-forwarded-for'];
  delete opts.headers['x-real-ip'];
  delete opts.headers['origin'];
  delete opts.headers['referer'];

  if (body && body.length > 0) {
    opts.headers['content-length'] = body.length;
  } else {
    delete opts.headers['content-length'];
  }

  return new Promise(function(resolve) {
    var proxyReq = mod.request(opts, function(proxyRes) {
      var headers = {};
      for (var k in proxyRes.headers) {
        if (k !== 'access-control-allow-origin' &&
            k !== 'access-control-allow-methods' &&
            k !== 'access-control-allow-headers' &&
            k !== 'content-security-policy' &&
            k !== 'x-frame-options') {
          headers[k] = proxyRes.headers[k];
        }
      }
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
      resolve();
    });
    proxyReq.on('error', function(e) {
      res.status(502).json({ error: e.message });
      resolve();
    });
    if (body && body.length > 0) proxyReq.write(body);
    proxyReq.end();
  });
};
