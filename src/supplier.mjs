// Парсер сторінки товару постачальника (cottonville.com.ua, платформа Prom.ua).
// Пробує кілька джерел даних по черзі: JSON-LD → мета-теги → текст сторінки.

const IN_STOCK = ['готово до відправки', 'в наявності', 'є в наявності', 'закінчується'];
const OUT_OF_STOCK = ['немає в наявності', 'нет в наличии', 'під замовлення', 'под заказ', 'очікується', 'не доступний'];

export async function fetchSupplierProduct(url) {
  return parseSupplierHtml(await fetchHtml(url), url);
}

export function parseSupplierHtml(html, url = '') {
  const text = htmlToText(html);
  const ld = findJsonLdProduct(html);

  // --- Код товару
  const code =
    ld?.sku ||
    ld?.mpn ||
    matchText(text, /Код:\s*([A-Za-z0-9][A-Za-z0-9._\-\/]{1,30})/) ||
    null;

  // --- Ціна
  let price = null;
  const offer = Array.isArray(ld?.offers) ? ld.offers[0] : ld?.offers;
  const qaPrice = html.match(/data-qaid=["']product_price["'][^>]*data-qaprice=["']([\d.,\s]+)["']/i)
    || html.match(/data-qaprice=["']([\d.,\s]+)["'][^>]*data-qaid=["']product_price["']/i);
  if (qaPrice) price = toNumber(qaPrice[1]);
  if (price == null && offer?.price) price = toNumber(offer.price);
  if (price == null) price = toNumber(metaContent(html, 'product:price:amount'));
  if (price == null) price = toNumber(matchText(text, /([\d\s]+(?:[.,]\d{1,2})?)\s*₴\s*\/?\s*пог/));

  // --- Наявність
  // 1) блок наявності основного товару (Prom.ua: data-qaid="product_presence")
  // 2) schema.org availability
  // 3) найперша згадка статусу в тексті (основний товар стоїть вище за "схожі товари")
  let status = null;
  const presence = html.match(/data-qaid=["']product_presence["'][^>]*>([\s\S]{0,300}?)<\/(?:span|div|p)>/i);
  if (presence) status = findStatus(htmlToText(presence[1]).toLowerCase()).status;
  let available = status ? IN_STOCK.includes(status) : null;
  if (available == null && offer?.availability) {
    available = /InStock|LimitedAvailability/i.test(offer.availability);
    status = offer.availability.split('/').pop();
  }
  if (available == null) {
    status = findStatus(text.toLowerCase()).status;
    available = status ? IN_STOCK.includes(status) : null;
  }

  const name = ld?.name || metaContent(html, 'og:title') || null;
  const ldImage = [].concat(ld?.image || [])[0];
  const image = (typeof ldImage === 'object' ? ldImage?.url : ldImage) || metaContent(html, 'og:image') || null;

  return { url, name, code, price, status, available, image, checkedAt: new Date().toISOString() };
}

// ---------- Категорія (список товарів з усіма сторінками) ----------

export async function fetchSupplierCategory(url, { maxPages = 50, pause = 2000 } = {}) {
  const base = url.replace(/\/page_\d+\/?$/, '').replace(/\/$/, '');
  const all = new Map();
  for (let page = 1; page <= maxPages; page++) {
    const pageUrl = page === 1 ? base : `${base}/page_${page}`;
    const html = await fetchHtml(pageUrl);
    const tiles = parseCategoryHtml(html, pageUrl);
    for (const t of tiles) if (!all.has(t.url)) all.set(t.url, t);
    if (!tiles.length || !html.includes(`/page_${page + 1}`)) break;
    await new Promise((r) => setTimeout(r, pause));
  }
  if (!all.size) throw new Error(`У категорії ${url} не знайдено жодного товару — можливо, змінилась верстка сайту`);
  return [...all.values()];
}

export function parseCategoryHtml(html, pageUrl = 'https://cottonville.com.ua/') {
  const checkedAt = new Date().toISOString();
  return html.split('data-qaid="product-block"').slice(1).map((block) => {
    const href = block.match(/class="b-product-gallery__title"[^>]*href="([^"]+)"/)?.[1];
    if (!href) return null;
    const name = decodeEntities(block.match(/class="b-product-gallery__title"[^>]*>([^<]+)</)?.[1]?.trim() || '') || null;
    const code = block.match(/b-product-gallery__sku"[^>]*>\s*<span[^>]*>([^<]+)</)?.[1]?.trim() || null;
    const price = toNumber(block.match(/b-product-gallery__current-price"[^>]*>([^<]+)</)?.[1]?.replace(/[^\d.,\s]/g, ''));
    const presence = block.match(/data-qaid="presence_data"[^>]*>([^<]+)</)?.[1]?.trim().toLowerCase() || '';
    const status = findStatus(presence).status;
    const image = block.match(/class="b-product-gallery__image"[^>]*src="([^"]+)"/)?.[1] || null;
    return {
      url: new URL(href, pageUrl).href,
      name, code, price, status,
      available: status ? IN_STOCK.includes(status) : null,
      image, checkedAt,
    };
  }).filter(Boolean);
}

// Сайт обмежує частоту запитів (HTTP 429) — чекаємо й повторюємо
const RETRY_DELAYS = [10, 30, 60, 120];

async function fetchHtml(url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36',
        'Accept-Language': 'uk-UA,uk;q=0.9',
      },
    });
    if (res.ok) return res.text();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= RETRY_DELAYS.length) throw new Error(`HTTP ${res.status} для ${url}`);
    const retryAfter = Number(res.headers.get('retry-after'));
    const wait = Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : RETRY_DELAYS[attempt], 180);
    console.error(`HTTP ${res.status} для ${url} — повтор через ${wait} с`);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}

// ---------- helpers ----------

function decodeEntities(s) {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function findStatus(lower) {
  let best = { status: null, pos: Infinity };
  for (const s of [...OUT_OF_STOCK, ...IN_STOCK]) {
    const pos = lower.indexOf(s);
    if (pos !== -1 && pos < best.pos) best = { status: s, pos };
  }
  return best;
}

function findJsonLdProduct(html) {
  const re = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const data = JSON.parse(m[1].trim());
      const items = Array.isArray(data) ? data : data['@graph'] || [data];
      const p = items.find((i) => [].concat(i['@type']).includes('Product'));
      if (p) return p;
    } catch { /* ignore broken JSON-LD */ }
  }
  return null;
}

function metaContent(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop.replace(/[:.]/g, '\\$&')}["'][^>]*content=["']([^"']+)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop.replace(/[:.]/g, '\\$&')}["']`, 'i');
  return (html.match(re) || html.match(re2) || [])[1] || null;
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

function matchText(text, re) {
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

function toNumber(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
