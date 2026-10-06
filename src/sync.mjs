// Щоденна синхронізація: каталоги постачальників → варіанти товарів у Shopify (усі товари з config/products.json).
// Ціну виробу задаєш ти вручну — скрипт її НЕ змінює.
//   • тканина є → варіант можна купити; тканини немає → варіант недоступний
//   • тканина зникла з категорії постачальника → варіант недоступний
//   • нова тканина в наявності (autoAddInStock) → новий варіант з фото постачальника
//   • зміни ціни/коду в постачальника — лише у звіті
//
// Режими:
//   DRY_RUN=1       — показати, що змінилося б (без змін у Shopify)
//   SUPPLIER_ONLY=1 — лише перевірити сайти постачальників (ключі Shopify не потрібні)
//   PRODUCT=key     — лише один товар (key або shopifyProductId)

import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { createShopifyClient } from './shopify.mjs';
import { loadConfig, selectProducts } from './config.mjs';
import { createSupplierCache } from './suppliers.mjs';
import {
  loadCatalog, snapshot, skuUrlMap, variantContext, newFabrics, planVariants, createVariantsWithImages, cleanName,
} from './catalog.mjs';
import { loadSwatchTaxonomy, attachSwatches } from './swatches.mjs';

const DRY_RUN = ['1', 'true'].includes(process.env.DRY_RUN);
const SUPPLIER_ONLY = ['1', 'true'].includes(process.env.SUPPLIER_ONLY);
const STATE_FILE = new URL('../data/state.json', import.meta.url);

const config = await loadConfig();
const products = selectProducts(config.products);
const suppliers = createSupplierCache(config.suppliers);
const prevState = await readFile(STATE_FILE, 'utf8').then(JSON.parse).catch(() => ({}));
const newState = { ...prevState, _skuUrl: { ...prevState._skuUrl } };
const sections = [];
const alertedUrls = new Set();
let failed = false;
let changed = false;

const label = (e) => e.item?.variantName || cleanName(e.name) || e.code || e.url;
const line = (e) => `${label(e)} [${e.code ?? '?'}]: ${e.price ?? '?'} ₴/м, ${e.available ? 'є' : e.available === false ? 'НЕМАЄ' : '?'}`;

let shopify = null;
if (!SUPPLIER_ONLY) {
  shopify = await createShopifyClient({
    shop: required('SHOPIFY_SHOP'),
    clientId: required('SHOPIFY_CLIENT_ID'),
    clientSecret: required('SHOPIFY_CLIENT_SECRET'),
  });
}

for (const p of products) {
  const sec = { title: p.name, summary: [], report: [], alerts: [] };
  sections.push(sec);
  try {
    await syncProduct(p, sec);
  } catch (e) {
    failed = true;
    sec.alerts.push(`❌ ${e.message}`);
  }
}

async function syncProduct(p, sec) {
  // 1. Каталог постачальників
  const { entries, complete, errors } = await loadCatalog(p, suppliers, { skuUrl: prevState._skuUrl });
  for (const e of errors) sec.alerts.push(`❌ ${e}`);
  if (!entries.length) failed = true;
  Object.assign(newState._skuUrl, skuUrlMap(entries));
  sec.summary.push(`Каталог: ${entries.length} тканин, у наявності ${entries.filter((e) => e.available).length}.`);

  // 2. Товар у Shopify
  const product = SUPPLIER_ONLY ? null : await shopify.getProduct(p.shopifyProductId);
  const variantsBySku = new Map((product?.variants.nodes || []).filter((v) => v.sku).map((v) => [v.sku, v]));

  // 3. Зміни в постачальника (лише для тканин, які відстежуємо; кожна тканина — один раз на звіт)
  const watched = (e) => e.manual || (SUPPLIER_ONLY ? e.available : variantsBySku.has(e.code));
  for (const e of entries) {
    const prev = prevState[e.url];
    newState[e.url] = snapshot(e);
    if (!watched(e) || alertedUrls.has(e.url)) continue;
    alertedUrls.add(e.url);
    if (e.available == null) sec.alerts.push(`⚠️ ${label(e)}: не вдалося прочитати наявність — перевір сторінку`);
    if (prev && prev.price != null && e.price != null && prev.price !== e.price) {
      const pct = ((e.price - prev.price) / prev.price * 100).toFixed(0);
      sec.alerts.push(`💰 ${label(e)}: ціна тканини ${prev.price} → ${e.price} ₴/м (${pct > 0 ? '+' : ''}${pct}%) — перевір свою ціну`);
      changed = true;
    }
    if (prev && prev.code && e.code && prev.code !== e.code && !e.item?.shopifySku) {
      sec.alerts.push(`🔁 ${label(e)}: код у постачальника змінився ${prev.code} → ${e.code}`);
      changed = true;
    }
  }

  if (SUPPLIER_ONLY) {
    for (const e of entries.filter(watched)) sec.report.push(`• ${line(e)}`);
    return;
  }

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
    sec.report.push(`• ${line(e)} — ${DRY_RUN ? '[ПРОБНО] ' : ''}${e.available ? '✅ знову в продажу' : '⛔ знято з продажу'}`);
    changed = true;
    if (!v.inventoryItem?.tracked) {
      sec.alerts.push(`⚠️ ${label(e)}: у варіанті вимкнено облік кількості — "немає в наявності" не спрацює. Увімкни "Відстежувати кількість" і постав 0`);
    }
  }

  // 5. Варіанти, тканин яких більше немає в каталозі
  const missing = product.variants.nodes.filter((v) => v.sku && !seen.has(v.sku));
  if (missing.length && !complete) {
    sec.alerts.push(`⚠️ Каталог прочитано не повністю — ${missing.length} варіант(ів) без даних не змінювались`);
  } else {
    for (const v of missing) {
      if (v.inventoryPolicy === 'DENY') { unchanged++; continue; }
      updates.push({ id: v.id, inventoryPolicy: 'DENY' });
      sec.report.push(`• ${v.title} [${v.sku}] — ${DRY_RUN ? '[ПРОБНО] ' : ''}⛔ тканини немає в каталозі постачальника, знято з продажу`);
      changed = true;
    }
  }

  // 6. Нові тканини
  let plan = [];
  let ctx = null;
  try { ctx = variantContext(product, p.optionName, { swatches: p.swatches }); } catch (e) { sec.alerts.push(`⚠️ Нові тканини не додано: ${e.message}`); }
  const fresh = ctx ? newFabrics(entries, ctx) : [];
  if (fresh.length && !ctx.fabricOption) {
    sec.alerts.push(`⚠️ У товарі немає опції "${p.optionName}" — нові тканини (${fresh.length}) не додано, запусти create-variants`);
  } else if (fresh.length && !p.autoAddInStock) {
    sec.alerts.push(`🆕 Нових тканин: ${fresh.length} (${fresh.map((e) => e.code).join(', ')}) — запусти create-variants`);
  } else if (fresh.length && p.swatches && !ctx.linked) {
    sec.alerts.push(`⚠️ Опція "${p.optionName}" ще не прив'язана до зразків — нові тканини (${fresh.length}) не додано, запусти create-variants`);
  } else if (fresh.length) {
    plan = planVariants(fresh, ctx);
    for (const t of plan) {
      sec.report.push(`• ${t.name} [${t.sku}]: ${t.supplierPrice ?? '?'} ₴/м — ${DRY_RUN ? '[ПРОБНО] ' : ''}➕ новий варіант${t.available ? '' : ' (немає в наявності)'}`);
    }
    changed = true;
  }

  sec.summary.push(`Варіантів тканин у товарі: ${variantsBySku.size}. Без змін: ${unchanged}.`);

  if (DRY_RUN) return;
  for (let i = 0; i < updates.length; i += 100) {
    await shopify.updateVariants(product.id, updates.slice(i, i + 100));
  }
  if (plan.length) {
    if (p.swatches) {
      const taxonomy = await loadSwatchTaxonomy(shopify, product.id);
      await attachSwatches(shopify, plan, taxonomy, { log: (s) => sec.report.push(s) });
    }
    const created = await createVariantsWithImages(shopify, product.id, plan, ctx, (s) => sec.alerts.push(s));
    sec.summary.push(`Створено варіантів: ${created}.`);
  }
}

if (!DRY_RUN) {
  await writeFile(STATE_FILE, JSON.stringify(newState, null, 2) + '\n');
}

// ---------- Звіт ----------
const mode = SUPPLIER_ONLY ? 'перевірка постачальників' : DRY_RUN ? 'пробний запуск' : 'синхронізація';
const text = [
  `🧵 Fabric sync — ${mode} (${new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })})`,
  ...sections.flatMap((s) => [
    '',
    `📦 ${s.title}`,
    ...s.summary,
    ...(s.report.length ? s.report : ['Змін немає.']),
    ...(s.alerts.length ? ['Потребує уваги:', ...s.alerts] : []),
  ]),
].join('\n');

console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, '```\n' + text + '\n```\n');
}
const hasAlerts = sections.some((s) => s.alerts.length);
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID && (changed || hasAlerts)) {
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
