const { URL } = require('url');

const PORTAL = 'Nieruchomości-online';
const TIMEOUT = 25000;
const MAX_PAGES = 20;

function num(v) {
  if (v == null || v === '') return null;
  const s = String(v).replace(/\u00a0/g, ' ').replace(/\s/g, '').replace(/[^0-9,.-]/g, '');
  if (!s) return null;
  const normalized = s.includes(',') && s.includes('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(',', '.');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}
function strip(v) { return String(v || '').replace(/&nbsp;|&#160;/gi, ' ').replace(/&sup2;|&#178;|&#xB2;/gi, '²').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function abs(v, b) { try { const u = new URL(String(v).replace(/&amp;/gi, '&'), b); u.hash = ''; return u.href; } catch { return ''; } }
async function get(url) { const c = new AbortController(); const t = setTimeout(() => c.abort(), TIMEOUT); try { const r = await fetch(url, { redirect:'follow', signal:c.signal, headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36','Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8','Accept-Language':'pl-PL,pl;q=0.9,en;q=0.8'}}); return { status:r.status, finalUrl:r.url, html:await r.text() }; } finally { clearTimeout(t); } }

// Aktualne oferty są przed granicą pie_archive. Po niej pomijamy archiwum.
function activeOnlyHtml(html) {
  const source = String(html || '');
  const markers = [/class=["'][^"']*\bpie_archive\b[^"']*["']/i,/id=["']pie_archive["']/i,/\bpie_archive\b/i];
  for (const re of markers) { const m = re.exec(source); if (m && Number.isFinite(m.index)) return { html:source.slice(0,m.index), archiveMarkerFound:true, archiveMarker:'pie_archive' }; }
  const visible = /Ogłoszenia\s+archiwalne/i.exec(source);
  if (visible && Number.isFinite(visible.index)) return { html:source.slice(0,visible.index), archiveMarkerFound:true, archiveMarker:'Ogłoszenia archiwalne' };
  return { html:source, archiveMarkerFound:false, archiveMarker:null };
}
function isOfferUrl(url) { return /nieruchomosci-online\.pl\//i.test(url) && /(?:lokal-uzytkowy|budynek-uzytkowy|lokal-handlowy|lokal-uslugowy|biuro|magazyn|hala)[^?#]*,na-sprzedaz\//i.test(url); }
function offerLinks(html, baseUrl) { const out=[]; const seen=new Set(); for(const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){const url=abs(m[1],baseUrl);if(!url||seen.has(url)||!isOfferUrl(url))continue;seen.add(url);out.push({url,label:strip(m[2]),index:m.index});} return out; }

// Zachowujemy ekstrakcję z wersji referencyjnej 113, ale poprawiamy wyłącznie błąd regexu m²:
// po znaku ² nie stosujemy \b, ponieważ superscript ² nie jest znakiem słowa w JavaScript.
function parseNO(html, baseUrl, location, minArea, maxArea, category) {
  const rows = [];
  for (const link of offerLinks(html, baseUrl)) {
    const text = strip(html.slice(Math.max(0, link.index - 1500), Math.min(html.length, link.index + 3000)));
    const price = (text.match(/([0-9][0-9\s.,]{2,})\s*(?:zł|PLN)\b/i) || [])[1];
    const am = text.match(/([0-9]+(?:[.,][0-9]+)?)\s*m\s*(?:²|2)(?![A-Za-z0-9])/i);
    const p = num(price);
    const a = am ? num(am[1]) : null;
    if (!Number.isFinite(p) || !Number.isFinite(a) || a < minArea || a > maxArea) continue;
    const title = category === 'budynek-uzytkowy' ? 'Budynek użytkowy' : 'Lokal użytkowy';
    rows.push({source:PORTAL,type:title,locality:location,street:'',price:p,area:a,priceM2:p/a,url:link.url,title});
  }
  return rows;
}
function unique(rows) { const u=new Set(),out=[]; for(const r of rows){const key=String(r.url||'').toLowerCase();if(!key||u.has(key))continue;u.add(key);out.push(r);} return out; }
function pageUrl(base,page){if(page===1)return base;const u=new URL(base);u.searchParams.set('p',String(page));return u.href;}
async function searchNieruchomosciOnline(location,minArea,maxArea){
  if(String(location).toLowerCase()!=='olsztyn')return{portal:PORTAL,httpStatus:0,fetched:false,htmlLength:0,recognized:0,complete:0,offers:[],pagesFetched:0,pages:[],categories:['lokal-uzytkowy','budynek-uzytkowy'],error:'Brak identyfikatora lokalizacji dla tej miejscowości.'};
  const categories=['lokal-uzytkowy','budynek-uzytkowy'],rows=[],pages=[];
  for(const category of categories){
    const base=`https://www.nieruchomosci-online.pl/szukaj.html?3,${category},sprzedaz,,Olsztyn:18670,,,,,${Math.floor(minArea)}-${Math.ceil(maxArea)}&q=`;
    for(let page=1;page<=MAX_PAGES;page++){
      const url=pageUrl(base,page);let r;
      try{r=await get(url);}catch(e){pages.push({category,page,url,httpStatus:0,htmlLength:0,archiveMarkerFound:false,recognized:0,newOffers:0,error:String(e.message||e)});break;}
      const finalUrl=r.finalUrl||url;
      if(r.status<200||r.status>=400){pages.push({category,page,url:finalUrl,httpStatus:r.status,htmlLength:r.html.length,recognized:0,newOffers:0});break;}
      const boundary=activeOnlyHtml(r.html);
      const parsed=parseNO(boundary.html,finalUrl,location,minArea,maxArea,category);
      const existing=new Set(rows.map(x=>String(x.url||'').toLowerCase()));let newOffers=0;
      for(const row of parsed){const key=String(row.url||'').toLowerCase();if(key&&!existing.has(key)){existing.add(key);rows.push(row);newOffers++;}}
      pages.push({category,page,url:finalUrl,httpStatus:r.status,htmlLength:r.html.length,activeHtmlLength:boundary.html.length,archiveMarkerFound:boundary.archiveMarkerFound,archiveMarker:boundary.archiveMarker,offerLinks:offerLinks(boundary.html,finalUrl).length,recognized:parsed.length,newOffers});
      if(boundary.archiveMarkerFound)break;
      if(newOffers===0)break;
    }
  }
  const offers=unique(rows);
  return{portal:PORTAL,httpStatus:pages[0]?.httpStatus||0,fetched:pages.some(p=>p.httpStatus>=200&&p.httpStatus<400),htmlLength:pages.reduce((n,p)=>n+p.htmlLength,0),recognized:rows.length,complete:offers.length,offers,pagesFetched:pages.length,pages,categories,requestedRadius:0,appliedRadius:0,radiusSupported:false};
}
module.exports={searchNieruchomosciOnline};