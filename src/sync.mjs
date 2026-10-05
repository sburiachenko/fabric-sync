// Щоденна синхронізація: постачальник → варіанти товару в Shopify.
// Ціну виробу задаєш ти вручну — скрипт її НЕ змінює.
// Скрипт: тканина є → варіант можна купити; тканини немає → варіант недоступний.
// Зміни ціни/коду в постачальника — лише у звіті.
//
// Режими:
//   DRY_RUN=1       — показати, що змінилося б (без змін у Shopify)
//   SUPPLIER_ONLY=1 — лише перевірити сайт постачальника (ключі Shopify не потрібні)

import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { fetchSupplierProduct } from './supplier.mjs';
import { createShopifyClient } from './shopify.mjs';

const DRY_RUN = ['1', 'true'].includes(process.env.DRY_RUN);
const SUPPLIER_ONLY = ['1', 'true'].includes(process.env.SUPPLIER_ONLY);
const STATE_FILE = new URL('../data/state.json', import.meta.url);
const CONFIG_FILE = new URL('../config/products.json', import.meta.url);

const config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
const prevState = await readFile(STATE_FILE, 'utf8').then(JSON.parse).catch(() => ({}));
const newState = { ...prevState };
const report = [];
const alerts = [];
let errors = 0;
let changed = false;

let shopify = null;
let variantsBySku = new Map();
let productId = null;
if (!SUPPLIER_ONLY) {
  shopify = await createShopifyClient({
    shop: required('SHOPIFY_SHOP'),
    clientId: required('SHOPIFY_CLIENT_ID'),
    clientSecret: required('SHOPIFY_CLIENT_SECRET'),
  });
  const product = await shopify.getProduct(config.shopifyProductId);
  productId = product.id;
  variantsBySku = new Map(product.variants.nodes.filter((v) => v.sku).map((v) => [v.sku, v]));
}

const items = config.products.filter((p) => p.enabled !== false);
const updates = [];

for (const item of items) {
  let label = item.variantName || item.shopifySku || item.supplierUrl;
  try {
    const s = await fetchSupplierProduct(item.supplierUrl);
    label = item.variantName || s.name || label;
    const prev = prevState[item.supplierUrl];
    newState[item.supplierUrl] = s;

    if (s.price == null || s.available == null) {
      alerts.push(`⚠️ ${label}: не вдалося прочитати ${s.price == null ? 'ціну' : 'наявність'} — перевір сторінку`);
    }
    if (prev && prev.price != null && s.price != null && prev.price !== s.price) {
      const pct = ((s.price - prev.price) / prev.price * 100).toFixed(0);
      alerts.push(`💰 ${label}: ціна тканини ${prev.price} → ${s.price} ₴/м (${pct > 0 ? '+' : ''}${pct}%) — перевір свою ціну`);
      changed = true;
    }
    if (prev && prev.code && s.code && prev.code !== s.code) {
      alerts.push(`🔁 ${label}: код у постачальника змінився ${prev.code} → ${s.code}`);
      changed = true;
    }

    const line = `${label} [${s.code ?? '?'}]: ${s.price ?? '?'} ₴/м, ${s.available ? 'є' : s.available === false ? 'НЕМАЄ' : '?'}`;

    if (SUPPLIER_ONLY) { report.push(`• ${line}`); continue; }

    const sku = item.shopifySku || s.code;
    const variant = sku && variantsBySku.get(sku);
    if (!variant) {
      report.push(`• ${line} — у товарі немає варіанта з SKU "${sku}" (запусти create-variants)`);
      continue;
    }

    if (s.available != null) {
      const policy = s.available ? 'CONTINUE' : 'DENY';
      if (variant.inventoryPolicy !== policy) {
        updates.push({ id: variant.id, inventoryPolicy: policy });
        report.push(`• ${line} — ${DRY_RUN ? '[ПРОБНО] ' : ''}${s.available ? '✅ знову в продажу' : '⛔ знято з продажу'}`);
        changed = true;
        if (!variant.inventoryItem?.tracked) {
          alerts.push(`⚠️ ${label}: у варіанті вимкнено облік кількості — "немає в наявності" не спрацює. Увімкни "Відстежувати кількість" і постав 0`);
        }
        continue;
      }
    }
    report.push(`• ${line} — без змін`);
  } catch (e) {
    errors++;
    alerts.push(`❌ ${label}: ${e.message}`);
  }
  await sleep(1500); // ввічлива пауза між запитами до сайту постачальника
}

if (updates.length && !DRY_RUN) {
  await shopify.updateVariants(productId, updates);
}
if (!DRY_RUN) {
  await writeFile(STATE_FILE, JSON.stringify(newState, null, 2) + '\n');
}

// ---------- Звіт ----------
const mode = SUPPLIER_ONLY ? 'перевірка постачальника' : DRY_RUN ? 'пробний запуск' : 'синхронізація';
const text = [
  `🧵 Fabric sync — ${mode} (${new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })})`,
  '',
  ...report,
  ...(alerts.length ? ['', 'Потребує уваги:', ...alerts] : []),
].join('\n');

console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, '```\n' + text + '\n```\n');
}
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID && (changed || alerts.length)) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text }),
  }).catch((e) => console.error('Telegram:', e.message));
}

if (items.length && errors === items.length) process.exit(1);

// ---------- helpers ----------

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Не задано змінну середовища ${name}`);
  return v;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
