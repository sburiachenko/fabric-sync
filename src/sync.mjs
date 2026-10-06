// Щоденна синхронізація: каталог постачальника → варіанти товару в Shopify.
// Ціну виробу задаєш ти вручну — скрипт її НЕ змінює.
//   • тканина є → варіант можна купити; тканини немає → варіант недоступний
//   • тканина зникла з категорії постачальника → варіант недоступний
//   • нова тканина в наявності (autoAddInStock) → новий варіант з фото постачальника
//   • зміни ціни/коду в постачальника — лише у звіті
//
// Режими:
//   DRY_RUN=1       — показати, що змінилося б (без змін у Shopify)
//   SUPPLIER_ONLY=1 — лише перевірити сайт постачальника (ключі Shopify не потрібні)

import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { createShopifyClient } from './shopify.mjs';
import {
  loadCatalog, snapshot, variantContext, newFabrics, planVariants, createVariantsWithImages, cleanName,
} from './catalog.mjs';
import { loadSwatchTaxonomy, attachSwatches } from './swatches.mjs';

const DRY_RUN = ['1', 'true'].includes(process.env.DRY_RUN);
const SUPPLIER_ONLY = ['1', 'true'].includes(process.env.SUPPLIER_ONLY);
const STATE_FILE = new URL('../data/state.json', import.meta.url);
const CONFIG_FILE = new URL('../config/products.json', import.meta.url);

const config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
const OPTION = config.optionName || 'Тканина';
const SWATCHES = config.swatches === true;
const prevState = await readFile(STATE_FILE, 'utf8').then(JSON.parse).catch(() => ({}));
const newState = { ...prevState };
const report = [];
const alerts = [];
let failed = false;
let changed = false;

const label = (e) => e.item?.variantName || cleanName(e.name) || e.code || e.url;
const line = (e) => `${label(e)} [${e.code ?? '?'}]: ${e.price ?? '?'} ₴/м, ${e.available ? 'є' : e.available === false ? 'НЕМАЄ' : '?'}`;

// ---------- 1. Каталог постачальника ----------
const { entries, complete, errors: catalogErrors } = await loadCatalog(config);
for (const e of catalogErrors) alerts.push(`❌ ${e}`);
if (!entries.length) failed = true;

// ---------- 2. Товар у Shopify ----------
let shopify = null;
let product = null;
let variantsBySku = new Map();
if (!SUPPLIER_ONLY) {
  shopify = await createShopifyClient({
    shop: required('SHOPIFY_SHOP'),
    clientId: required('SHOPIFY_CLIENT_ID'),
    clientSecret: required('SHOPIFY_CLIENT_SECRET'),
  });
  product = await shopify.getProduct(config.shopifyProductId);
  variantsBySku = new Map(product.variants.nodes.filter((v) => v.sku).map((v) => [v.sku, v]));
}

// ---------- 3. Зміни в постачальника (лише для тканин, які відстежуємо) ----------
const watched = (e) => e.manual || (SUPPLIER_ONLY ? e.available : variantsBySku.has(e.code));
for (const e of entries) {
  const prev = prevState[e.url];
  newState[e.url] = snapshot(e);
  if (!watched(e)) continue;
  if (e.available == null) alerts.push(`⚠️ ${label(e)}: не вдалося прочитати наявність — перевір сторінку`);
  if (prev && prev.price != null && e.price != null && prev.price !== e.price) {
    const pct = ((e.price - prev.price) / prev.price * 100).toFixed(0);
    alerts.push(`💰 ${label(e)}: ціна тканини ${prev.price} → ${e.price} ₴/м (${pct > 0 ? '+' : ''}${pct}%) — перевір свою ціну`);
    changed = true;
  }
  if (prev && prev.code && e.code && prev.code !== e.code && !e.item?.shopifySku) {
    alerts.push(`🔁 ${label(e)}: код у постачальника змінився ${prev.code} → ${e.code}`);
    changed = true;
  }
}

const inStock = entries.filter((e) => e.available).length;
const summary = [`Каталог постачальника: ${entries.length} тканин, у наявності ${inStock}.`];

if (SUPPLIER_ONLY) {
  for (const e of entries.filter(watched)) report.push(`• ${line(e)}`);
} else {
  try {
    await syncShopify();
  } catch (e) {
    failed = true;
    alerts.push(`❌ Shopify: ${e.message}`);
  }
}

async function syncShopify() {
  // 4. Наявність існуючих варіантів
  const updates = [];
  const seen = new Set();
  let unchanged = 0;
  for (const e of entries) {
    const v = variantsBySku.get(e.code);
    if (!v) continue;
    seen.add(e.code);
    if (e.available == null) continue;
    const policy = e.available ? 'CONTINUE' : 'DENY';
    if (v.inventoryPolicy === policy) { unchanged++; continue; }
    updates.push({ id: v.id, inventoryPolicy: policy });
    report.push(`• ${line(e)} — ${DRY_RUN ? '[ПРОБНО] ' : ''}${e.available ? '✅ знову в продажу' : '⛔ знято з продажу'}`);
    changed = true;
    if (!v.inventoryItem?.tracked) {
      alerts.push(`⚠️ ${label(e)}: у варіанті вимкнено облік кількості — "немає в наявності" не спрацює. Увімкни "Відстежувати кількість" і постав 0`);
    }
  }

  // 5. Варіанти, тканин яких більше немає в каталозі
  const missing = product.variants.nodes.filter((v) => v.sku && !seen.has(v.sku));
  if (missing.length && !complete) {
    alerts.push(`⚠️ Каталог прочитано не повністю — ${missing.length} варіант(ів) без даних не змінювались`);
  } else {
    for (const v of missing) {
      if (v.inventoryPolicy === 'DENY') { unchanged++; continue; }
      updates.push({ id: v.id, inventoryPolicy: 'DENY' });
      report.push(`• ${v.title} [${v.sku}] — ${DRY_RUN ? '[ПРОБНО] ' : ''}⛔ тканини немає в каталозі постачальника, знято з продажу`);
      changed = true;
    }
  }

  // 6. Нові тканини
  let plan = [];
  let ctx = null;
  try { ctx = variantContext(product, OPTION, { swatches: SWATCHES }); } catch (e) { alerts.push(`⚠️ Нові тканини не додано: ${e.message}`); }
  const fresh = ctx ? newFabrics(entries, ctx) : [];
  if (fresh.length && !ctx.fabricOption) {
    alerts.push(`⚠️ У товарі немає опції "${OPTION}" — нові тканини (${fresh.length}) не додано, запусти create-variants`);
  } else if (fresh.length && !config.autoAddInStock) {
    alerts.push(`🆕 Нових тканин: ${fresh.length} (${fresh.map((e) => e.code).join(', ')}) — запусти create-variants`);
  } else if (fresh.length && SWATCHES && !ctx.linked) {
    alerts.push(`⚠️ Опція "${OPTION}" ще не прив'язана до зразків — нові тканини (${fresh.length}) не додано, запусти create-variants`);
  } else if (fresh.length) {
    plan = planVariants(fresh, ctx);
    for (const t of plan) {
      report.push(`• ${t.name} [${t.sku}]: ${t.supplierPrice ?? '?'} ₴/м — ${DRY_RUN ? '[ПРОБНО] ' : ''}➕ новий варіант${t.available ? '' : ' (немає в наявності)'}`);
    }
    changed = true;
  }

  summary.push(`Варіантів тканин у товарі: ${variantsBySku.size}. Без змін: ${unchanged}.`);

  if (DRY_RUN) return;
  for (let i = 0; i < updates.length; i += 100) {
    await shopify.updateVariants(product.id, updates.slice(i, i + 100));
  }
  if (plan.length) {
    if (SWATCHES) {
      const taxonomy = await loadSwatchTaxonomy(shopify, product.id);
      await attachSwatches(shopify, plan, taxonomy, { log: (s) => report.push(s) });
    }
    const created = await createVariantsWithImages(shopify, product.id, plan, ctx, (s) => alerts.push(s));
    summary.push(`Створено варіантів: ${created}.`);
  }
}

if (!DRY_RUN) {
  await writeFile(STATE_FILE, JSON.stringify(newState, null, 2) + '\n');
}

// ---------- Звіт ----------
const mode = SUPPLIER_ONLY ? 'перевірка постачальника' : DRY_RUN ? 'пробний запуск' : 'синхронізація';
const text = [
  `🧵 Fabric sync — ${mode} (${new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })})`,
  ...summary,
  '',
  ...(report.length ? report : ['Змін немає.']),
  ...(alerts.length ? ['', 'Потребує уваги:', ...alerts] : []),
].join('\n');

console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, '```\n' + text + '\n```\n');
}
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID && (changed || alerts.length)) {
  const msg = text.length > 4000 ? text.slice(0, 3950) + '\n…(повний звіт — у GitHub Actions Summary)' : text;
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: msg }),
  }).catch((e) => console.error('Telegram:', e.message));
}

if (failed) process.exit(1);

// ---------- helpers ----------

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Не задано змінну середовища ${name}`);
  return v;
}
