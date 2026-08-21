const http = require("http");
const { URL } = require("url");

const PORT = process.env.PORT || 10000;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

function send(res, status, data) {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": typeof data === "string"
      ? "text/plain; charset=utf-8"
      : "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 100000) {
        req.destroy();
        reject(new Error("Request too large"));
      }
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error("Nieprawidłowy JSON")); }
    });
    req.on("error", reject);
  });
}

const clean = s => String(s || "").replace(/\s+/g, " ").trim();

function hostname(url) {
  try { return new URL(url).hostname.toLowerCase(); }
  catch { return ""; }
}

function buildQueries({ type, location, area, tolerance }) {
  const min = Math.round(area * (1 - tolerance / 100));
  const max = Math.round(area * (1 + tolerance / 100));
  const a = Math.round(area);

  // v0.3 deliberately targets individual-offer URL patterns.
  // The goal is not to collect category/listing pages.
  return [
    `"${type}" "${location}" "mieszkanie na sprzedaż" "${a} m²" "zł" "oferta"`,
    `"${type}" "${location}" "mieszkanie na sprzedaż" "${min} m²" "zł"`,
    `"${type}" "${location}" "mieszkanie na sprzedaż" "${max} m²" "zł"`,
    `site:otodom.pl/pl/oferty/sprzedaz/mieszkanie "${location}" "${a}" "zł"`,
    `site:morizon.pl/oferta/sprzedaz-mieszkanie "${location}" "${a}m2"`,
    `site:nieruchomosci-online.pl/oferta "${location}" mieszkanie "${a}"`,
    `site:gratka.pl/nieruchomosci "${location}" mieszkanie "${a}" "zł"`,
    `site:domiporta.pl/nieruchomosci/sprzedam "${location}" mieszkanie "${a}" "zł"`,
    `site:treehouse-nieruchomosci.pl "${location}" mieszkanie "${a}" "zł"`
  ];
}

async function tavilySearch(query) {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${TAVILY_API_KEY}`
    },
    body: JSON.stringify({
      query,
      topic: "general",
      search_depth: "basic",
      max_results: 8,
      include_answer: false,
      include_raw_content: true,
      country: "poland"
    })
  });

  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text }; }

  if (!response.ok) {
    const e = new Error(data?.detail || data?.error || `Tavily HTTP ${response.status}`);
    e.status = response.status;
    throw e;
  }
  return data;
}

async function fetchPage(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);

    const r = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AnalizatorCenOfertowych/0.3)"
      }
    });

    clearTimeout(timer);

    if (!r.ok) return { ok: false, status: r.status, html: "" };
    const html = await r.text();
    return { ok: true, status: r.status, html: html.slice(0, 1800000) };
  } catch {
    return { ok: false, status: 0, html: "" };
  }
}

function decodeHtml(s) {
  return String(s || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripTags(html) {
  return decodeHtml(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim();
}

function parseJsonLd(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (Array.isArray(parsed)) out.push(...parsed);
      else out.push(parsed);
    } catch {}
  }
  return out;
}

function flattenJsonLd(items) {
  const out = [];
  const walk = x => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) return x.forEach(walk);
    if (x["@graph"]) walk(x["@graph"]);
    out.push(x);
  };
  items.forEach(walk);
  return out;
}

function findJsonLdOffer(html) {
  const objects = flattenJsonLd(parseJsonLd(html));
  let price = NaN, area = NaN, location = "";

  for (const o of objects) {
    if (o.offers) {
      const offers = Array.isArray(o.offers) ? o.offers : [o.offers];
      for (const offer of offers) {
        const p = Number(String(offer?.price ?? "").replace(/[^\d.,-]/g, "").replace(",", "."));
        if (Number.isFinite(p) && p >= 20000 && p <= 100000000) {
          price = p; break;
        }
      }
    }

    const p = Number(String(o.price ?? "").replace(/[^\d.,-]/g, "").replace(",", "."));
    if (!Number.isFinite(price) && Number.isFinite(p) && p >= 20000 && p <= 100000000) price = p;

    const ar = o.floorSize?.value ?? o.floorSize ?? o.size ?? o.area;
    const av = Number(String(ar ?? "").replace(/[^\d.,-]/g, "").replace(",", "."));
    if (!Number.isFinite(area) && av > 10 && av < 500) area = av;

    const addr = o.address;
    if (!location && addr) {
      if (typeof addr === "string") location = clean(addr);
      else location = clean([
        addr.streetAddress,
        addr.addressLocality,
        addr.addressRegion
      ].filter(Boolean).join(", "));
    }
  }

  return { price, area, location };
}

function firstPrice(text) {
  const patterns = [
    /(?:cena(?:\s+ofertowa)?|cena\s+sprzedaży|cena\s+sprzedazy|cena\s+nieruchomości|cena\s+nieruchomosci)\s*[:\-]?\s*([0-9][0-9\s.]*)\s*(?:zł|PLN)\b/i,
    /(?:^|\s)([1-9][0-9]{4,7})\s*(?:zł|PLN)\b/i
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const x = Number(m[1].replace(/[ .\s]/g, ""));
    if (x >= 20000 && x <= 100000000) return x;
  }
  return NaN;
}

function firstArea(text) {
  const patterns = [
    /(?:powierzchnia(?:\s+użytkowa|\s+uzytkowa)?|metraż|metraz|pow\.\s*(?:użytkowa|uzytkowa)?)\s*[:\-]?\s*([0-9]{1,4}(?:[,.][0-9]{1,2})?)\s*(?:m²|m2|m kw\.?|mkw)\b/i,
    /([0-9]{1,4}(?:[,.][0-9]{1,2})?)\s*(?:m²|m2|m kw\.?|mkw)\b/i
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const x = Number(m[1].replace(",", "."));
    if (x > 10 && x < 500) return x;
  }
  return NaN;
}

function firstLocation(text, requestedLocation) {
  const patterns = [
    /(?:lokalizacja|adres|miejsce)\s*[:\-]\s*([^|.;]{3,120})/i,
    /(?:ul\.|aleja|al\.)\s*[^,.;]{2,70}(?:,\s*)?[^,.;]{2,70}/i
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return clean(m[1] || m[0]);
  }
  return requestedLocation;
}

const LISTING_PATTERNS = [
  /\/oferty\/sprzedaz\/mieszkanie\/[^/]+$/i,
  /\/mieszkania[\/,]sprzedaz(?:[/?#]|$)/i,
  /\/sprzedaz\/mieszkania(?:[/?#]|$)/i,
  /\/mieszkania-na-sprzedaz(?:[\/?#]|-|$)/i,
  /\/mieszkania\/olsztyn(?:[/?#]|$)/i,
  /\/sprzedaz(?:[/?#]|$)/i,
  /\/ogloszenia(?:[/?#]|$)/i,
  /\/mieszkania(?:[/?#]|$)/i
];

function isListingPage(url, title = "") {
  const u = String(url || "").toLowerCase();
  const t = String(title || "").toLowerCase();

  // Explicit known listing paths.
  if (LISTING_PATTERNS.some(re => re.test(u))) {
    // Exception: a URL containing a clear offer marker is a candidate offer.
    if (/\/oferta\/|\/property\/|\/ogloszenie\/|[?&](?:id|offer|listing)=/i.test(u)) return false;
    return true;
  }

  const genericListingWords = [
    "mieszkania na sprzedaż",
    "mieszkania na sprzedaz",
    "nieruchomości na sprzedaż",
    "nieruchomosci na sprzedaz",
    "ogłoszenia nieruchomości",
    "ogloszenia nieruchomosci"
  ];

  if (genericListingWords.some(x => t.includes(x)) &&
      !/\/oferta\/|\/property\/|\/ogloszenie\/|[?&](?:id|offer|listing)=/i.test(u)) {
    return true;
  }

  return false;
}

function isLikelyDirectOffer(url, title = "") {
  const u = String(url || "").toLowerCase();

  if (/\/oferta\/|\/property\/|\/ogloszenie\/|[?&](?:id|offer|listing)=/i.test(u)) return true;

  if (/morizon\.pl\/oferta\//i.test(u)) return true;
  if (/otodom\.pl\/pl\/oferta\//i.test(u)) return true;
  if (/nieruchomosci-online\.(pl|com)\/oferta\//i.test(u)) return true;
  if (/gratka\.pl\/nieruchomosci\/[^/]+\/[^/]+/i.test(u) && !/\/mieszkania$/i.test(u)) return true;

  // Generic fallback: a specific-looking title plus a non-generic URL.
  const specificTitle = /(mieszkanie|lokal|dom).{0,80}(sprzedaż|sprzedaz)/i.test(title);
  const genericPath = /\/(mieszkania|sprzedaz|nieruchomosci|ogloszenia)(?:[/?#]|$)/i.test(u);
  return specificTitle && !genericPath;
}

function parseOfferCandidate(candidate, requested, html, fallbackText) {
  const text = stripTags(html || "") || clean(fallbackText || "");
  const json = findJsonLdOffer(html || "");

  let price = json.price;
  let area = json.area;
  let location = json.location;

  if (!Number.isFinite(price)) price = firstPrice(text);
  if (!Number.isFinite(area)) area = firstArea(text);
  if (!location) location = firstLocation(text, requested.location);

  if (!Number.isFinite(price)) {
    return { status: "NO_PRICE", source: hostname(candidate.url), url: candidate.url, title: candidate.title };
  }
  if (!Number.isFinite(area)) {
    return { status: "NO_AREA", source: hostname(candidate.url), url: candidate.url, title: candidate.title };
  }

  const unit = price / area;
  if (unit < 500 || unit > 50000) {
    return {
      status: "INVALID_DATA",
      source: hostname(candidate.url),
      url: candidate.url,
      title: candidate.title,
      reason: `Podejrzana cena jednostkowa: ${Math.round(unit)} zł/m²`
    };
  }

  return {
    status: "VALID",
    type: requested.type,
    location: clean(location || requested.location),
    url: candidate.url,
    price,
    area,
    title: candidate.title,
    source: hostname(candidate.url)
  };
}

function dedupe(items) {
  const map = new Map();
  for (const item of items) {
    // Primary duplicate key: normalized URL. Secondary key catches the same
    // offer copied to multiple portals when price/area/location match.
    const urlKey = String(item.url || "").toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
    const dataKey = [
      clean(item.location).toLowerCase().replace(/\s+/g, " "),
      Math.round(item.area * 100) / 100,
      Math.round(item.price)
    ].join("|");

    if (!map.has(urlKey)) map.set(urlKey, item);
    else continue;

    // Store a secondary marker without replacing the first record.
    map.set(`data:${dataKey}`, item);
  }

  const result = [];
  const seenData = new Set();
  for (const item of map.values()) {
    const key = [
      clean(item.location).toLowerCase().replace(/\s+/g, " "),
      Math.round(item.area * 100) / 100,
      Math.round(item.price)
    ].join("|");
    if (seenData.has(key)) continue;
    seenData.add(key);
    result.push(item);
  }
  return result;
}

async function handleSearch(body) {
  if (!TAVILY_API_KEY) {
    const e = new Error("Brak TAVILY_API_KEY na Renderze.");
    e.status = 500; throw e;
  }

  const requested = {
    type: clean(body.type),
    location: clean(body.location),
    unit: clean(body.unit),
    radius: Number(body.radius || 0),
    area: Number(body.area),
    tolerance: Number(body.tolerance || 10)
  };

  if (!requested.type || !requested.location || !(requested.area > 0)) {
    const e = new Error("Brak wymaganych parametrów.");
    e.status = 400; throw e;
  }

  const queries = buildQueries(requested);
  const candidates = [];
  const seenUrls = new Set();
  const queryDiagnostics = [];

  for (const query of queries) {
    try {
      const data = await tavilySearch(query);
      let count = 0;

      for (const r of data.results || []) {
        if (!r.url || seenUrls.has(r.url)) continue;
        seenUrls.add(r.url);
        candidates.push({
          url: r.url,
          title: clean(r.title),
          content: clean(r.content),
          raw_content: r.raw_content || "",
          query
        });
        count++;
      }

      queryDiagnostics.push({ query, resultsAdded: count });
    } catch (e) {
      queryDiagnostics.push({ query, error: e.message });
    }
  }

  const diagnostics = [];
  const parsed = [];

  // More candidates in v0.3 because targeted queries should produce more direct offers.
  for (const candidate of candidates.slice(0, 50)) {
    if (isListingPage(candidate.url, candidate.title)) {
      diagnostics.push({
        status: "LISTING_PAGE",
        url: candidate.url,
        title: candidate.title,
        source: hostname(candidate.url)
      });
      continue;
    }

    if (!isLikelyDirectOffer(candidate.url, candidate.title)) {
      diagnostics.push({
        status: "NOT_DIRECT_OFFER",
        url: candidate.url,
        title: candidate.title,
        source: hostname(candidate.url)
      });
      continue;
    }

    const page = await fetchPage(candidate.url);

    // If the portal blocks Render with 403/other HTTP error, use Tavily's
    // crawled content as a fallback. This is important for portals such as
    // Morizon/other sites that expose data to search crawlers but block generic fetches.
    let item;
    if (page.ok) {
      item = parseOfferCandidate(candidate, requested, page.html, "");
      item.fetchMode = "direct";
    } else if (candidate.raw_content || candidate.content) {
      item = parseOfferCandidate(candidate, requested, "", candidate.raw_content || candidate.content);
      item.fetchMode = "tavily";
      item.fetchHttp = page.status;
    } else {
      diagnostics.push({
        status: "FETCH_FAILED",
        url: candidate.url,
        title: candidate.title,
        source: hostname(candidate.url),
        http: page.status
      });
      continue;
    }

    diagnostics.push({
      status: item.status,
      url: item.url,
      title: item.title,
      source: item.source,
      reason: item.reason || "",
      fetchMode: item.fetchMode || ""
    });

    if (item.status === "VALID") parsed.push(item);
  }

  const min = requested.area * (1 - requested.tolerance / 100);
  const max = requested.area * (1 + requested.tolerance / 100);
  const filtered = parsed.filter(x => x.area >= min && x.area <= max);
  const unique = dedupe(filtered);

  return {
    version: "0.3",
    parameters: {
      ...requested,
      minArea: min,
      maxArea: max
    },
    queriesUsed: queries.length,
    found: candidates.length,
    pagesChecked: Math.min(candidates.length, 50),
    valid: parsed.length,
    filtered: filtered.length,
    unique: unique.length,
    results: unique,
    queryDiagnostics,
    diagnostics
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, "");

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, {
      ok: true,
      service: "analizator-cen-ofertowych",
      version: "0.3",
      tavilyConfigured: Boolean(TAVILY_API_KEY)
    });
  }

  if (req.method === "POST" && url.pathname === "/api/search-offers") {
    try {
      const body = await parseBody(req);
      const result = await handleSearch(body);
      return send(res, 200, result);
    } catch (err) {
      return send(res, err.status || 500, { error: err.message || "Błąd serwera" });
    }
  }

  return send(res, 404, { error: "Nie znaleziono endpointu." });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Analizator backend v0.3 listening on 0.0.0.0:${PORT}`);
});
