// Робота з варіантами товару.
//   MODE=inspect — показати товар: опції, варіанти, SKU, ціни (нічого не змінює)
//   MODE=create  — створити варіанти для тканин з config/products.json, яких ще немає
//                  (опція "Тканина", SKU = код постачальника, ціна = поточна ціна товару)
//   DRY_RUN=1    — для create: лише показати, що буде створено

import { readFile, appendFile } from 'node:fs/promises';
import { fetchSupplierProduct } from './supplier.mjs';
import { createShopifyClient } from './shopify.mjs';

const MODE = process.env.MODE || 'inspect';
const DRY_RUN = ['1', 'true'].includes(process.env.DRY_RUN);
const config = JSON.parse(await readFile(new URL('../config/products.json', import.meta.url), 'utf8'));
const OPTION = config.optionName || 'Тканина';
const out = [];
const log = (s = '') => { out.push(s); };

const shopify = await createShopifyClient({
  shop: required('SHOPIFY_SHOP'),
  clientId: required('SHOPIFY_CLIENT_ID'),
  clientSecret: required('SHOPIFY_CLIENT_SECRET'),
});

let product = await shopify.getProduct(config.shopifyProductId);
printProduct(product);

if (MODE === 'create') {
  log('');
  log(`=== Створення варіантів${DRY_RUN ? ' (ПРОБНО, без змін)' : ''} ===`);

  const existingSkus = new Set(product.variants.nodes.map((v) => v.sku).filter(Boolean));
  const fabricOption = product.options.find((o) => o.name === OPTION);
  const existingNames = new Set(fabricOption?.optionValues.map((v) => v.name) || []);
  // Інші опції (напр. "Розмір") допускаються лише з одним значенням — його отримає кожен новий варіант
  const otherOptions = product.options.filter((o) => o.name !== OPTION && o.name !== 'Title');
  const multi = otherOptions.filter((o) => o.optionValues.length !== 1);
  if (multi.length) {
    throw new Error(`Опції з кількома значеннями (${multi.map((o) => o.name).join(', ')}) — ` +
      `автоматично створювати комбінації не буду, напиши, як мають поєднуватися тканини з цими опціями.`);
  }
  const fixedOptionValues = otherOptions.map((o) => ({ optionName: o.name, name: o.optionValues[0].name }));
  // Варіанти без SKU — не з постачальника; з removeVariantsWithoutSku: true їх буде видалено
  const unmanaged = config.removeVariantsWithoutSku ? product.variants.nodes.filter((v) => !v.sku) : [];

  // 1. Зібрати дані з сайту постачальника
  const todo = [];
  for (const item of config.products.filter((p) => p.enabled !== false)) {
    const s = await fetchSupplierProduct(item.supplierUrl);
    const sku = item.shopifySku || s.code;
    const name = item.variantName || cleanName(s.name) || sku;
    if (!sku) { log(`⚠️ ${item.supplierUrl}: не знайдено код — пропускаю`); continue; }
    if (existingSkus.has(sku)) { log(`• ${name} [${sku}] — вже є, пропускаю`); continue; }
    if (existingNames.has(name)) { log(`⚠️ ${name}: варіант з такою назвою вже є (інший SKU) — пропускаю`); continue; }
    todo.push({ name, sku, available: s.available !== false, supplierPrice: s.price });
    existingNames.add(name);
    await sleep(1000);
  }

  for (const v of unmanaged) log(`- ${v.title} (без SKU) — буде видалено`);

  if (!todo.length) {
    log('Нових варіантів немає.');
  } else {
    const basePrice = product.variants.nodes[0]?.price ?? '0';
    for (const t of todo) {
      log(`+ ${t.name} [${t.sku}] — ціна ${basePrice}, тканина ${t.supplierPrice} ₴/м, ${t.available ? 'в продажу' : 'НЕМАЄ тканини → недоступний'}`);
    }

    if (!DRY_RUN) {
      const toInput = (t) => ({
        inventoryPolicy: t.available ? 'CONTINUE' : 'DENY',
        inventoryItem: { sku: t.sku, tracked: true },
      });

      // 2. Якщо в товара ще немає опції "Тканина" — створюємо її;
      //    стандартний варіант ("Default Title") стає першою тканиною.
      if (!fabricOption) {
        const isDefaultOnly = product.variants.nodes.length === 1 && product.options.every((o) => o.name === 'Title');
        if (!isDefaultOnly) throw new Error('Неочікувана структура товару — надішли звіт inspect');
        const first = todo.shift();
        await shopify.createOption(product.id, OPTION, first.name);
        const defaultVariant = product.variants.nodes[0];
        await shopify.updateVariants(product.id, [{ id: defaultVariant.id, ...toInput(first) }]);
        log(`✓ Створено опцію "${OPTION}", перший варіант: ${first.name}`);
      }

      // 3. Решта — пачкою
      if (todo.length) {
        const created = await shopify.createVariants(
          product.id,
          todo.map((t) => ({
            optionValues: [{ optionName: OPTION, name: t.name }, ...fixedOptionValues],
            price: basePrice,
            ...toInput(t),
          })),
        );
        log(`✓ Створено варіантів: ${created.length}`);
      }
    }
  }

  // 4. Видалити варіанти без SKU — лише якщо в товарі лишаються варіанти тканин
  if (unmanaged.length && !DRY_RUN) {
    const fresh = await shopify.getProduct(config.shopifyProductId);
    if (fresh.variants.nodes.some((v) => v.sku)) {
      await shopify.deleteVariants(product.id, unmanaged.map((v) => v.id));
      log(`✓ Видалено варіантів без SKU: ${unmanaged.map((v) => v.title).join(', ')}`);
    } else {
      log('⚠️ Варіанти без SKU не видалено — у товарі ще немає варіантів тканин');
    }
  }

  if (!DRY_RUN && (todo.length || unmanaged.length)) {
    product = await shopify.getProduct(config.shopifyProductId);
    log('');
    printProduct(product);
  }
}

const text = out.join('\n');
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, '```\n' + text + '\n```\n');

// ---------- helpers ----------

function printProduct(p) {
  log(`Товар: ${p.title} (${p.status}) — /products/${p.handle}`);
  log(`Опції: ${p.options.map((o) => `${o.name} [${o.optionValues.map((v) => v.name).join(', ')}]`).join('; ')}`);
  log(`Варіанти (${p.variants.nodes.length}):`);
  for (const v of p.variants.nodes) {
    log(`  - ${v.title} | SKU: ${v.sku || '—'} | ${v.price} | продаж без залишку: ${v.inventoryPolicy === 'CONTINUE' ? 'так' : 'ні'} | облік: ${v.inventoryItem?.tracked ? 'так' : 'ні'}`);
  }
}

export function cleanName(name) {
  if (!name) return null;
  return name
    .replace(/\s*[,—|–-]\s*(ціна|купити|цена|prom).*$/i, '')
    .replace(/^\s*фланель\s+/i, '')
    .replace(/,?\s*(ширина\s*)?\d{3}\s*см\.?\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Не задано змінну середовища ${name}`);
  return v;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
