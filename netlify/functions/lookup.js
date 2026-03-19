// CrazyMoe Scanner – server-side product lookup
// Sources: UPCitemDB, Open*Facts family, eBay RSS, Google HTML, optional BarcodeLookup API

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
    const query = String(body.query || '').trim();
    if (!query) return respond({ results: [], message: 'Empty query', checked: [] });

    const checked = [];
    const isUPC = /^\d{8,14}$/.test(query);
    const all = [];

    if (isUPC) {
      // Parallel exact UPC lookups
      const exactResults = await Promise.allSettled([
        upcItemDbLookup(query, checked),
        barcodeLookupApi(query, checked),
        openFactsLookup(query, 'food', checked),
        openFactsLookup(query, 'product', checked),
        openFactsLookup(query, 'beauty', checked),
        openFactsLookup(query, 'petfood', checked),
      ]);
      exactResults.forEach(r => r.status === 'fulfilled' && r.value && all.push(...r.value));
    }

    // Search-based fallbacks (UPC or keyword)
    const searchResults = await Promise.allSettled([
      upcItemDbSearch(query, checked),
      ebayRssSearch(query, checked),
    ]);
    searchResults.forEach(r => r.status === 'fulfilled' && r.value && all.push(...r.value));

    // Google HTML as last resort
    try { const g = await googleHtmlSearch(query, checked); all.push(...g); } catch (_) {}

    const ranked = rankAndDedupe(all, query, isUPC).slice(0, 8);
    return respond({
      checked: [...new Set(checked)],
      results: ranked,
      message: ranked.length ? `Found ${ranked.length} match${ranked.length === 1 ? '' : 'es'}` : 'No matches found'
    });
  } catch (e) {
    return respond({ results: [], checked: [], message: e.message || 'Lookup error' }, 500);
  }
};

function respond(obj, status = 200) {
  return { statusCode: status, headers: CORS, body: JSON.stringify(obj) };
}

function normTitle(s = '') {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function rankAndDedupe(items, query, upcMode) {
  const seen = new Map();
  for (const item of items) {
    if (!item || !item.title) continue;
    const key = [item.upc || '', normTitle(item.title).slice(0, 80)].join('|');
    const scored = scoreItem({ ...item }, query, upcMode);
    const prev = seen.get(key);
    if (!prev || scored.confidence > prev.confidence) seen.set(key, scored);
  }
  return [...seen.values()].sort((a, b) => b.confidence - a.confidence);
}

function scoreItem(item, query, upcMode) {
  let s = Number(item.confidence || 0.3);
  const q = String(query).toLowerCase();
  const title = String(item.title || '').toLowerCase();
  if (upcMode && item.upc && String(item.upc).includes(query)) s += 0.45;
  if (title.includes(q)) s += 0.22;
  if (item.source?.includes('upcitemdb')) s += 0.20;
  if (item.source?.includes('barcodelookup')) s += 0.18;
  if (item.source?.includes('open')) s += 0.12;
  if (item.source?.includes('ebay')) s += 0.08;
  if (item.thumbnail) s += 0.05;
  item.confidence = Math.min(0.99, Math.max(0, s));
  return item;
}

async function safeFetch(url, init = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CrazyMoeScanner/2.0)',
        ...(init.headers || {})
      }
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return res;
  } catch (_) {
    clearTimeout(timer);
    return null;
  }
}

function makeItem(source, data = {}) {
  return {
    source,
    title: data.title || '',
    brand: data.brand || '',
    model: data.model || '',
    upc: data.upc || '',
    price: data.price || '',
    thumbnail: data.thumbnail || '',
    description: data.description || '',
    chips: (data.chips || []).filter(Boolean),
    url: data.url || '',
    confidence: data.confidence || 0.3
  };
}

async function upcItemDbLookup(upc, checked) {
  checked.push('upcitemdb');
  const res = await safeFetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(upc)}`);
  if (!res) return [];
  const data = await res.json().catch(() => ({}));
  return (data.items || []).map(item => makeItem('upcitemdb', {
    title: item.title || item.product_name || '',
    brand: item.brand || '',
    model: item.model || '',
    upc,
    price: item.lowest_recorded_price || '',
    thumbnail: item.images?.[0] || '',
    description: item.description || '',
    chips: [
      item.brand && `Brand: ${item.brand}`,
      item.model && `Model: ${item.model}`,
      `UPC: ${upc}`
    ],
    url: item.offers?.[0]?.link || ''
  }));
}

async function upcItemDbSearch(query, checked) {
  checked.push('upcitemdb-search');
  const res = await safeFetch(`https://api.upcitemdb.com/prod/trial/search?s=${encodeURIComponent(query)}&type=product`);
  if (!res) return [];
  const data = await res.json().catch(() => ({}));
  return (data.items || []).map(item => makeItem('upcitemdb-search', {
    title: item.title || item.product_name || '',
    brand: item.brand || '',
    model: item.model || '',
    upc: item.upc || '',
    price: item.lowest_recorded_price || '',
    thumbnail: item.images?.[0] || '',
    description: item.description || '',
    chips: [
      item.brand && `Brand: ${item.brand}`,
      item.model && `Model: ${item.model}`,
      item.upc && `UPC: ${item.upc}`
    ],
    url: item.offers?.[0]?.link || ''
  }));
}

async function barcodeLookupApi(upc, checked) {
  const key = process.env.BARCODE_LOOKUP_KEY;
  if (!key) return [];
  checked.push('barcodelookup');
  const res = await safeFetch(`https://api.barcodelookup.com/v3/products?barcode=${encodeURIComponent(upc)}&formatted=y&key=${key}`);
  if (!res) return [];
  const data = await res.json().catch(() => ({}));
  return (data.products || []).map(p => makeItem('barcodelookup', {
    title: p.title || p.product_name || '',
    brand: p.brand || '',
    model: p.model || '',
    upc: p.barcode_number || upc,
    price: p.stores?.[0]?.price || '',
    thumbnail: p.images?.[0] || '',
    description: p.description || '',
    chips: [
      p.brand && `Brand: ${p.brand}`,
      p.model && `Model: ${p.model}`,
      p.category && `Category: ${p.category}`,
      `UPC: ${upc}`
    ],
    url: p.stores?.[0]?.store_url || '',
    confidence: 0.75
  }));
}

async function openFactsLookup(code, kind, checked) {
  const map = {
    food: { host: 'https://world.openfoodfacts.org', tag: 'openfoodfacts' },
    product: { host: 'https://world.openproductsfacts.org', tag: 'openproductsfacts' },
    beauty: { host: 'https://world.openbeautyfacts.org', tag: 'openbeautyfacts' },
    petfood: { host: 'https://world.openpetfoodfacts.org', tag: 'openpetfoodfacts' }
  };
  const info = map[kind];
  if (!info) return [];
  checked.push(info.tag);
  const res = await safeFetch(`${info.host}/api/v2/product/${encodeURIComponent(code)}.json`);
  if (!res) return [];
  const data = await res.json().catch(() => ({}));
  if (data.status !== 1 || !data.product) return [];
  const p = data.product;
  const title = p.product_name || p.abbreviated_product_name || p.generic_name || '';
  if (!title) return [];
  return [makeItem(info.tag, {
    title,
    brand: p.brands || '',
    upc: code,
    thumbnail: p.image_front_small_url || p.image_front_url || '',
    description: [p.quantity, p.categories, p.generic_name].filter(Boolean).join(' • '),
    chips: [
      p.brands && `Brand: ${p.brands}`,
      `UPC: ${code}`,
      p.quantity && p.quantity
    ],
    url: `${info.host}/product/${encodeURIComponent(code)}`
  })];
}

async function ebayRssSearch(query, checked) {
  checked.push('ebay-rss');
  const queries = [
    query,
    query.replace(/[-_]/g, ' ').trim(),
  ].filter((v, i, a) => a.indexOf(v) === i);

  for (const q of queries) {
    const res = await safeFetch(`https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}&_rss=1&_ipg=6`);
    if (!res) continue;
    const xml = await res.text();
    const blocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 6).map(m => m[1]);
    if (!blocks.length) continue;
    return blocks.map(block => {
      const title = extractTag(block, 'title');
      const link = extractTag(block, 'link');
      const desc = extractTag(block, 'description');
      const thumb = (desc.match(/<img[^>]+src="([^"]+)"/i) || [])[1] || '';
      const priceMatch = title.match(/\$([0-9,.]+)/);
      const price = priceMatch ? priceMatch[1].replace(/,/g, '') : '';
      const cleanTitle = title.replace(/\s*\$[0-9,.]+.*$/, '').trim();
      return makeItem('ebay-rss', {
        title: cleanTitle,
        price,
        thumbnail: thumb,
        description: stripHtml(desc).slice(0, 200),
        chips: [price && `$${price}`],
        url: link
      });
    }).filter(x => x.title);
  }
  return [];
}

async function googleHtmlSearch(query, checked) {
  checked.push('google-html');
  const res = await safeFetch(
    `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&num=5`,
    { headers: { Accept: 'text/html' } }
  );
  if (!res) return [];
  const html = await res.text();
  const matches = [...html.matchAll(/<a href="\/url\?q=([^"&]+)[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/g)].slice(0, 5);
  return matches.map(m => makeItem('google-html', {
    title: stripHtml(m[2]),
    url: decodeURIComponent(m[1]),
    confidence: 0.2
  })).filter(x => x.title);
}

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? stripHtml(m[1]).trim() : '';
}

function stripHtml(s = '') {
  return s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
