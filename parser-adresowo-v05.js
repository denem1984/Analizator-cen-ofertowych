const http = require("http");
const { URL } = require("url");

const TARGET_URL = "https://adresowo.pl/mieszkania/olsztyn/";
const PORT = Number(process.env.PORT) || 10000;

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pl-PL,pl;q=0.9,en;q=0.8"
      }
    });
    return { status: response.status, ok: response.ok, finalUrl: response.url, html: await response.text() };
  } finally { clearTimeout(timer); }
}

function number(value) {
  if (value == null) return null;
  const s = String(value).replace(/\u00a0/g, " ").replace(/\s/g, "");
  const cleaned = s.replace(/zł|PLN/gi, "").replace(/[^0-9,.-]/g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function absUrl(value) {
  try {
    const u = new URL(String(value), TARGET_URL);
    u.hash = "";
    return u.href.replace(/\/$/, "").toLowerCase();
  } catch (_) { return ""; }
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCards(html) {
  const rows = [];
  const seenUrls = new Set();

  const urlPatterns = [
    /(?:href|data-href|data-url)=["']([^"']*\/o\/[^"'#?]*(?:\?[^"']*)?)["']/gi,
    /https?:\\?\/\\?\/adresowo\.pl\\?\/o\\?\/[^"'\\s<>]+/gi,
    /(?:https?:\/\/)?adresowo\.pl\/o\/[A-Za-z0-9._~:/?#\[\]@!$&()*+,;=%-]+/gi
  ];

  const candidates = [];
  for (const re of urlPatterns) {
    let m;
    while ((m = re.exec(html))) candidates.push({ raw: m[1] || m[0], index: m.index, end: re.lastIndex });
  }

  for (const candidate of candidates) {
    const raw = String(candidate.raw).replace(/\\\//g, "/");
    const url = absUrl(raw);
    if (!url || !/adresowo\.pl\/o\//i.test(url) || seenUrls.has(url)) continue;
    seenUrls.add(url);

    const start = Math.max(0, candidate.index - 5000);
    const end = Math.min(html.length, candidate.end + 3500);
    const contextHtml = html.slice(start, end);
    const context = stripHtml(contextHtml);

    const priceMatches = [...context.matchAll(/([0-9][0-9 .\u00a0]{2,})\s*(?:zł|PLN)\b/gi)];
    const areaMatches = [...context.matchAll(/([0-9]+(?:[,.][0-9]+)?)\s*m(?:²|2)\b/gi)];
    if (!priceMatches.length || !areaMatches.length) continue;

    let best = null;
    for (const pm of priceMatches) {
      const price = number(pm[1]);
      if (!price || price < 10000) continue;
      for (const am of areaMatches) {
        const area = number(am[1]);
        if (!area || area < 10 || area > 1000) continue;
        const distance = Math.abs(pm.index - am.index);
        if (!best || distance < best.distance) best = { price, area, distance };
      }
    }
    if (!best) continue;

    rows.push({
      source: "Adresowo",
      type: "mieszkanie",
      locality: "Olsztyn",
      street: "",
      title: "",
      price: best.price,
      area: best.area,
      priceM2: best.price / best.area,
      url
    });
  }

  return rows;
}

function diagnostic(html) {
  const lower = html.toLowerCase();
  const count = (re) => (html.match(re) || []).length;
  const snippets = [];
  for (const term of ["/o/", "adresowo.pl/o", "zł", "m²", "m2", "mieszkanie", "olsztyn"]) {
    let pos = lower.indexOf(term.toLowerCase());
    if (pos >= 0) snippets.push(`${term}: ${stripHtml(html.slice(Math.max(0,pos-180), Math.min(html.length,pos+420)))}`);
  }
  return {
    slashO: count(/\/o\//gi),
    adresowoO: count(/adresowo\.pl\/o/gi),
    href: count(/href=/gi),
    dataHref: count(/data-href=/gi),
    dataUrl: count(/data-url=/gi),
    zloty: count(/zł/gi),
    m2: count(/m(?:²|2)/gi),
    mieszkanie: count(/mieszkanie/gi),
    olsztyn: count(/olsztyn/gi),
    start: stripHtml(html.slice(0, 1200)),
    snippets
  };
}

function dedupe(rows) {
  const urls = new Set();
  const keys = new Set();
  const unique = [];
  const duplicates = [];
  for (const r of rows) {
    const u = r.url;
    const k = `${r.price}|${r.area}`;
    if ((u && urls.has(u)) || keys.has(k)) { duplicates.push(r); continue; }
    if (u) urls.add(u);
    keys.add(k);
    unique.push(r);
  }
  return { unique, duplicates };
}

async function searchAdresowo({ areaTarget = 62, tolerance = 10 } = {}) {
  const response = await fetchHtml(TARGET_URL);
  const parsed = parseCards(response.html);
  const seen = new Set();
  const recognizedRows = parsed.filter(o => {
    const key = `${o.url}|${o.price}|${o.area}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const complete = recognizedRows.filter(o => o.locality && Number.isFinite(o.price) && Number.isFinite(o.area) && o.url);
  const minArea = areaTarget * (1 - tolerance / 100);
  const maxArea = areaTarget * (1 + tolerance / 100);
  const filtered = complete.filter(o => o.area >= minArea && o.area <= maxArea);
  const d = dedupe(filtered);

  return {
    portal: "Adresowo",
    sourceUrl: TARGET_URL,
    httpStatus: response.status,
    fetched: response.ok,
    htmlLength: response.html.length,
    recognized: recognizedRows.length,
    complete: complete.length,
    filtered: filtered.length,
    unique: d.unique.length,
    duplicates: d.duplicates.length,
    offers: d.unique,
    diagnostic: diagnostic(response.html)
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (u.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: true, portal: "Adresowo" }));
    }
    if (u.pathname === "/api/adresowo") {
      const areaTarget = Number(u.searchParams.get("area") || 62);
      const tolerance = Number(u.searchParams.get("tolerance") || 10);
      const result = await searchAdresowo({ areaTarget, tolerance });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify(result));
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ service: "Adresowo parser v0.5", status: "ok", endpoints: ["/health", "/api/adresowo?area=62&tolerance=10"] }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`ADRESOWO_SERVER_LISTENING port=${PORT}`);
  searchAdresowo({ areaTarget: 62, tolerance: 10 })
    .then(r => console.log("ADRESOWO_SELFTEST " + JSON.stringify({ httpStatus: r.httpStatus, fetched: r.fetched, htmlLength: r.htmlLength, recognized: r.recognized, complete: r.complete, filtered: r.filtered, unique: r.unique, duplicates: r.duplicates, diagnostic: r.diagnostic })))
    .catch(e => console.error("ADRESOWO_SELFTEST_ERROR " + e.message));
});
