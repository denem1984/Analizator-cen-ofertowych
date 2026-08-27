// Production wrapper: public UI + compatibility proxy.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { resolveLocation } = require('./location-resolver');

const upstreamPort = 10001;
const publicPort = Number(process.env.PORT) || 10000;
process.env.PORT = String(upstreamPort);
require('./compat-server.js');

const indexPath = path.join(__dirname, 'index.html');

async function suggestLocations(query) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];

  const url = new URL('https://geo.stat.gov.pl/api/fts/ref/qq');
  url.searchParams.set('f', 'geojson');
  url.searchParams.set('q', q);
  url.searchParams.set('cnt', '12');
  url.searchParams.set('idx', 'jpa');
  url.searchParams.set('top', 'or');

  const response = await fetch(url, {
    headers: { 'Accept': 'application/json' }
  });
  if (!response.ok) throw new Error(`GUS TERYT HTTP ${response.status}`);

  const data = await response.json();
  const features = Array.isArray(data?.features) ? data.features : [];
  const result = [];
  const seen = new Set();

  for (const feature of features) {
    const p = feature?.properties || feature?.record?.properties || {};
    const name = String(p.gm_nazwa || p.jpa_nazwa || feature?.name || '').trim();
    if (!name) continue;
    const key = name.toLocaleLowerCase('pl-PL');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      name,
      teryt: String(p.gm_idteryt || p.teryt || ''),
      powiat: String(p.pow_nazwa || '').trim(),
      wojewodztwo: String(p.woj_nazwa || '').trim()
    });
  }

  return result;
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

const proxy = http.createServer(async (req, res) => {
  const pathname = (req.url || '').split('?')[0];

  if (pathname === '/' || pathname === '/index.html') {
    try {
      const html = fs.readFileSync(indexPath, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      return res.end(html);
    } catch (e) {
      res.writeHead(500, {'Content-Type': 'text/plain; charset=utf-8'});
      return res.end('Nie można wczytać aplikacji: ' + e.message);
    }
  }

  if (pathname === '/api/location-suggestions' && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      return sendJson(res, 200, await suggestLocations(url.searchParams.get('q') || ''));
    } catch (e) {
      return sendJson(res, 200, []);
    }
  }

  if (pathname === '/api/resolve-location' && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      return sendJson(res, 200, await resolveLocation(url.searchParams.get('location') || ''));
    } catch (e) {
      return sendJson(res, 400, { error: e.message || 'Nie udało się rozpoznać lokalizacji.' });
    }
  }

  const options = {
    hostname: '127.0.0.1',
    port: upstreamPort,
    path: req.url,
    method: req.method,
    headers: req.headers
  };

  const p = http.request(options, r => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });

  p.on('error', e => {
    res.writeHead(502, {'Content-Type':'text/plain; charset=utf-8'});
    res.end('Proxy error: ' + e.message);
  });

  req.pipe(p);
});

proxy.listen(publicPort, '0.0.0.0', () => {
  console.log('PUBLIC WRAPPER listening on ' + publicPort);
});
