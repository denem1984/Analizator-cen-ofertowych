// Production wrapper: keep compat-server.js intact, but provide the correct
// apartment diagnostic UI at /diagnostic-no.html.
const http = require('http');
const upstreamPort = 10001;
const publicPort = Number(process.env.PORT) || 10000;
process.env.PORT = String(upstreamPort);
require('./compat-server.js');

const tester = `<!doctype html><meta charset="utf-8"><title>Diagnostyka mieszkań – Combined API</title><style>body{font:16px Arial;max-width:1000px;margin:40px auto;padding:20px}button{font-size:18px;padding:12px 20px}pre{white-space:pre-wrap;background:#f4f4f4;padding:15px;border-radius:8px}</style><h1>Diagnostyka mieszkań – Combined API</h1><p>Olsztyn · <b>mieszkanie</b> · <b>62 m²</b> · zakres <b>60–65 m²</b> · promień 0 km</p><p>Test obejmuje Nieruchomości-online, Morizon, Domiporta, Gratka i Adresowo oraz deduplikację.</p><button onclick="run()">URUCHOM TEST MIESZKAŃ</button><pre id="out">Gotowe.</pre><script>async function run(){const o=document.getElementById('out');o.textContent='Uruchamiam pełny test mieszkań…';try{const r=await fetch('/api/live/combined?location=Olsztyn&area=62&tolerance=4.0322580645&radius=0&propertyType=mieszkanie',{cache:'no-store'});const t=await r.text();o.textContent='HTTP '+r.status+'\\n\\n'+t}catch(e){o.textContent='BŁĄD: '+e.message}}</script>`;

const proxy = http.createServer((req, res) => {
  if ((req.url || '').split('?')[0] === '/diagnostic-no.html' || (req.url || '').split('?')[0] === '/diagnostic-no') {
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    return res.end(tester);
  }
  const options = {hostname:'127.0.0.1', port:upstreamPort, path:req.url, method:req.method, headers:req.headers};
  const p = http.request(options, r => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  p.on('error', e => {res.writeHead(502, {'Content-Type':'text/plain'});res.end('Proxy error: '+e.message);});
  req.pipe(p);
});
proxy.listen(publicPort, '0.0.0.0', () => console.log('PUBLIC WRAPPER listening on '+publicPort));
