// Парсер сторінки товару постачальника (cottonville.com.ua, платформа Prom.ua).
// Пробує кілька джерел даних по черзі: JSON-LD → мета-теги → текст сторінки.

const IN_STOCK = ['готово до відправки', 'в наявності', 'є в наявності', 'закінчується'];
const OUT_OF_STOCK = ['немає в наявності', 'нет в наличии', 'під замовлення', 'под заказ', 'очікується', 'не доступний'];

export async function fetchSupplierProduct(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36',
      'Accept-Language': 'uk-UA,uk;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} для ${url}`);
  const html = await res.text();
  return parseSupplierHtml(html, url);
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

  return { url, name, code, price, status, available, checkedAt: new Date().toISOString() };
}

// ---------- helpers ----------

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
