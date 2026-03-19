// CrazyMoe Scanner – product URL scraper
// Extracts product data from any URL via JSON-LD, Open Graph, and HTML fallbacks

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store'
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return respond({ error: 'POST only' }, 405);

  try {
    const body = JSON.parse(event.body || '{}');
    const rawUrl = String(body.url || '').trim();
    if (!rawUrl) return respond({ error: 'URL is required' }, 400);

    // Normalize URL
    let url;
    try {
      url = new URL(rawUrl.startsWith('http') ? rawUrl : 'https://' + rawUrl);
    } catch (_) {
      return respond({ error: 'Invalid URL' }, 400);
    }

    const html = await fetchPage(url.toString());
    if (!html) return respond({ error: 'Could not fetch that page. It may block bots or require login.' }, 422);

    const product = extractProduct(html, url.toString());
    return respond({ product, url: url.toString() });
  } catch (e) {
    return respond({ error: e.message || 'Scrape failed' }, 500);
  }
};

function respond(obj, status = 200) {
  return { statusCode: status, headers: CORS, body: JSON.stringify(obj) };
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache'
      }
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('html')) return null;
    return await res.text();
  } catch (_) {
    clearTimeout(timer);
    return null;
  }
}

function extractProduct(html, url) {
  const result = {
    title: '',
    price: '',
    thumbnail: '',
    description: '',
    brand: '',
    model: '',
    upc: '',
    url,
    source: 'url-scrape',
    chips: [],
    confidence: 0.7
  };

  // ── 1. JSON-LD Product schema (most reliable) ──────────────────
  const jsonLdMatches = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of jsonLdMatches) {
    try {
      const data = JSON.parse(m[1]);
      const products = [];
      collectProducts(data, products);
      if (products.length) {
        const p = products[0];
        if (p.name) result.title = cleanText(p.name);
        if (p.description) result.description = cleanText(p.description).slice(0, 400);
        if (p.brand?.name) result.brand = cleanText(p.brand.name);
        else if (typeof p.brand === 'string') result.brand = cleanText(p.brand);
        if (p.model) result.model = cleanText(p.model);
        if (p.mpn) result.model = result.model || cleanText(p.mpn);
        // gtin / upc
        const gtinKeys = ['gtin13','gtin12','gtin8','gtin','isbn'];
        for (const k of gtinKeys) {
          if (p[k]) { result.upc = String(p[k]).trim(); break; }
        }
        // Price from offers
        const offer = Array.isArray(p.offers) ? p.offers[0] : p.offers;
        if (offer?.price) result.price = String(offer.price);
        else if (offer?.lowPrice) result.price = String(offer.lowPrice);
        // Image
        if (Array.isArray(p.image)) result.thumbnail = String(p.image[0]);
        else if (typeof p.image === 'string') result.thumbnail = p.image;
        else if (p.image?.url) result.thumbnail = p.image.url;
        result.confidence = 0.88;
        break;
      }
    } catch (_) {}
  }

  // ── 2. Open Graph tags ─────────────────────────────────────────
  const og = extractOG(html);
  if (!result.title && og['og:title']) result.title = og['og:title'];
  if (!result.description && og['og:description']) result.description = og['og:description'].slice(0, 400);
  if (!result.thumbnail && og['og:image']) result.thumbnail = og['og:image'];
  if (!result.price && og['product:price:amount']) result.price = og['product:price:amount'];
  if (!result.price && og['og:price:amount']) result.price = og['og:price:amount'];

  // ── 3. Twitter card ────────────────────────────────────────────
  if (!result.title) {
    const tc = extractMeta(html, 'twitter:title') || extractMeta(html, 'twitter:text:title');
    if (tc) result.title = tc;
  }
  if (!result.thumbnail) {
    const ti = extractMeta(html, 'twitter:image') || extractMeta(html, 'twitter:image:src');
    if (ti) result.thumbnail = ti;
  }

  // ── 4. HTML fallbacks ──────────────────────────────────────────
  if (!result.title) {
    // Try h1 first, then <title>
    const h1 = (html.match(/<h1[^>]*>([^<]{3,200})<\/h1>/i) || [])[1];
    const titleTag = (html.match(/<title[^>]*>([^<]{3,200})<\/title>/i) || [])[1];
    result.title = cleanText(h1 || titleTag || '');
  }
  if (!result.description) {
    const metaDesc = extractMeta(html, 'description');
    if (metaDesc) result.description = metaDesc.slice(0, 400);
  }

  // ── 5. Resolve relative thumbnail URL ─────────────────────────
  if (result.thumbnail && !result.thumbnail.startsWith('http')) {
    try {
      const base = new URL(url);
      result.thumbnail = new URL(result.thumbnail, base).toString();
    } catch (_) {}
  }

  // ── 6. Build chips ─────────────────────────────────────────────
  const hostname = (() => { try { return new URL(url).hostname.replace('www.',''); } catch(_) { return ''; } })();
  result.chips = [
    result.brand && `Brand: ${result.brand}`,
    result.model && `Model: ${result.model}`,
    result.upc && `UPC: ${result.upc}`,
    result.price && `Price: $${result.price}`,
    hostname && `Source: ${hostname}`
  ].filter(Boolean);

  // Mark as url-scrape source so UI can show the domain
  result.source = hostname ? `url-scrape (${hostname})` : 'url-scrape';

  return result;
}

function collectProducts(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(n => collectProducts(n, out)); return; }
  const t = node['@type'];
  if (t === 'Product' || t === 'IndividualProduct' ||
      (Array.isArray(t) && t.includes('Product'))) {
    out.push(node);
  }
  for (const val of Object.values(node)) {
    if (typeof val === 'object') collectProducts(val, out);
  }
}

function extractOG(html) {
  const result = {};
  const matches = html.matchAll(/<meta[^>]+(?:property|name)=["']([^"']+)["'][^>]+content=["']([^"']*?)["'][^>]*>/gi);
  for (const m of matches) result[m[1].toLowerCase()] = cleanText(m[2]);
  // Also try reversed attribute order: content first
  const matches2 = html.matchAll(/<meta[^>]+content=["']([^"']*?)["'][^>]+(?:property|name)=["']([^"']+)["'][^>]*>/gi);
  for (const m of matches2) { const k = m[2].toLowerCase(); if (!result[k]) result[k] = cleanText(m[1]); }
  return result;
}

function extractMeta(html, name) {
  const r = html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'))
    || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${name}["']`, 'i'));
  return r ? cleanText(r[1]) : '';
}

function cleanText(s = '') {
  return String(s).replace(/\s+/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&quot;/g, '"').trim();
}
