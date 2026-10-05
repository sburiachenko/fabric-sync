// Щоденна синхронізація: постачальник → Shopify.
// Режими:
//   DRY_RUN=1  — лише читає й показує, що змінилося б (без змін у Shopify)
//   SUPPLIER_ONLY=1 — перевірити лише парсинг сайту постачальника (ключі Shopify не потрібні)

import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { fetchSupplierProduct } from './supplier.mjs';
import { createShopifyClient } from './shopify.mjs';

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const SUPPLIER_ONLY = process.env.SUPPLIER_ONLY === '1' || process.env.SUPPLIER_ONLY === 'true';
const STATE_FILE = new URL('../data/state.json', import.meta.url);
const CONFIG_FILE = new URL('../config/products.json', import.meta.url);

const config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
const prevState = await readFile(STATE_FILE, 'utf8').then(JSON.parse).catch(() => ({}));
const newState = { ...prevState };
const report = [];   // рядки звіту
const alerts = [];   // що потребує ручного рішення
let errors = 0;

const shopify = SUPPLIER_ONLY
  ? null
  : await createShopifyClient({
      shop: required('SHOPIFY_SHOP'),
      clientId: required('SHOPIFY_CLIENT_ID'),
      clientSecret: required('SHOPIFY_CLIENT_SECRET'),
    });

for (const item of config.products.filter((p) => p.enabled !== false)) {
  const label = item.name;
  try {
    const s = await fetchSupplierProduct(item.supplierUrl);
    const prev = prevState[item.supplierUrl];
    newState[item.supplierUrl] = s;

    if (s.price == null || s.available == null) {
      alerts.push(`⚠️ ${label}: не вдалося прочитати ${s.price == null ? 'ціну' : 'наявність'} — перевір сторінку`);
    }

    const supplierChanges = [];
    if (prev && prev.price !== s.price) supplierChanges.push(`ціна тканини ${prev.price} → ${s.price} ₴`);
    if (prev && prev.available !== s.available) supplierChanges.push(`наявність: ${s.status}`);
    if (prev && prev.code !== s.code) supplierChanges.push(`код ${prev.code} → ${s.code}`);

    const line = `${label} [${s.code ?? '?'}]: ${s.price ?? '?'} ₴/м, ${s.status ?? '?'}`;

    if (SUPPLIER_ONLY) {
      report.push(`• ${line}${supplierChanges.length ? ' — ЗМІНИ: ' + supplierChanges.join('; ') : ''}`);
      continue;
    }

    const sku = item.shopifySku || s.code;
    if (!sku) { alerts.push(`⚠️ ${label}: немає SKU для пошуку в Shopify`); continue; }
    const variant = await shopify.findVariantBySku(sku);
    if (!variant) {
      report.push(`• ${line} — у Shopify немає варіанта з SKU "${sku}", пропускаю`);
      continue;
    }

    const update = {};
    const actions = [];

    // --- Ціна
    if (s.price != null) {
      const target = calcPrice(s.price, { ...config.pricing, ...(item.pricing || {}) });
      const current = parseFloat(variant.price);
      if (target !== current) {
        const diffPct = current ? Math.abs(target - current) / current * 100 : 100;
        const limit = item.pricing?.maxAutoChangePercent ?? config.pricing.maxAutoChangePercent;
        if (diffPct > limit) {
          alerts.push(`💰 ${label}: розрахункова ціна ${current} → ${target} ₴ (${diffPct.toFixed(0)}%) — більше ліміту ${limit}%, НЕ змінено автоматично`);
        } else {
          update.price = target;
          actions.push(`ціна ${current} → ${target} ₴`);
        }
      }
    }

    // --- Наявність: є тканина → можна продавати під замовлення; немає → "немає в наявності"
    if (s.available != null) {
      const policy = s.available ? 'CONTINUE' : 'DENY';
      if (variant.inventoryPolicy !== policy) {
        update.inventoryPolicy = policy;
        actions.push(s.available ? 'знову в продажу' : 'знято з продажу (немає тканини)');
        if (!variant.inventoryItem?.tracked) {
          alerts.push(`⚠️ ${label}: у варіанті вимкнено відстеження кількості — статус "немає" не спрацює. Увімкни "Відстежувати кількість" і постав 0`);
        }
      }
    }

    if (actions.length) {
      if (!DRY_RUN) await shopify.updateVariant(variant.product.id, variant.id, update);
      report.push(`• ${line} — ${DRY_RUN ? '[ПРОБНО] ' : ''}${actions.join('; ')}`);
    } else {
      report.push(`• ${line} — без змін`);
    }
  } catch (e) {
    errors++;
    alerts.push(`❌ ${label}: ${e.message}`);
  }
  await sleep(1500); // ввічлива пауза між запитами до сайту постачальника
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
const somethingChanged = report.some((r) => !r.endsWith('без змін')) || alerts.length;
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID && somethingChanged) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text }),
  }).catch((e) => console.error('Telegram:', e.message));
}

if (errors === config.products.length) process.exit(1);

// ---------- helpers ----------

export function calcPrice(fabricPrice, p) {
  const cost = fabricPrice * p.meters + p.sewingCost + p.extraCost;
  const raw = cost * (1 + p.marginPercent / 100);
  return Math.ceil((raw + 1) / 10) * 10 - 1; // округлення вгору до ...9
}

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Не задано змінну середовища ${name}`);
  return v;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
