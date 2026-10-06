// Робота з варіантами товарів (усі товари з config/products.json або PRODUCT=key).
//   MODE=inspect — показати товар: опції, варіанти, SKU, ціни (нічого не змінює)
//   MODE=create  — створити варіанти для тканин, яких ще немає в товарі:
//                  ручні записи (fabrics) — завжди, з категорій (sources) — лише в наявності
//                  (опція optionName, SKU = префікс + код постачальника, ціна = поточна ціна товару, фото — з сайту постачальника)
//   DRY_RUN=1    — для create: лише показати, що буде зроблено

import { readFile, appendFile } from 'node:fs/promises';
import { createShopifyClient } from './shopify.mjs';
import { loadConfig, selectProducts } from './config.mjs';
import { createSupplierCache } from './suppliers.mjs';
import { loadCatalog, variantContext, newFabrics, planVariants, createVariantsWithImages } from './catalog.mjs';
import { loadSwatchTaxonomy, linkFabricOption, attachSwatches, SWATCH_NAMESPACE, SWATCH_KEY } from './swatches.mjs';

const MODE = process.env.MODE || 'inspect';
const DRY_RUN = ['1', 'true'].includes(process.env.DRY_RUN);
const config = await loadConfig();
const products = selectProducts(config.products);
const suppliers = createSupplierCache(config.suppliers);
const state = await readFile(new URL('../data/state.json', import.meta.url), 'utf8').then(JSON.parse).catch(() => ({}));
const out = [];
const log = (s = '') => { out.push(s); console.log(s); };
let failed = false;

const shopify = await createShopifyClient({
  shop: required('SHOPIFY_SHOP'),
  clientId: required('SHOPIFY_CLIENT_ID'),
  clientSecret: required('SHOPIFY_CLIENT_SECRET'),
});

for (const p of products) {
  log(`📦 ${p.name} [${p.key}]`);
  try {
    const product = await shopify.getProduct(p.shopifyProductId);
    printProduct(product);
    if (MODE === 'create') await createVariants(p, product);
  } catch (e) {
    failed = true;
    log(`❌ ${e.message}`);
  }
  log('');
}

if (MODE === 'inspect') await inspectSwatches();

if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, '```\n' + out.join('\n') + '\n```\n');
if (failed) process.exitCode = 1;

// ---------- create ----------

async function createVariants(p, product) {
  const OPTION = p.optionName;
  log('');
  log(`=== Створення варіантів${DRY_RUN ? ' (ПРОБНО, без змін)' : ''} ===`);

  // Опція, прив'язана до метаполя категорії (напр. стандартний "Колір"), приймає лише значення зі списку Shopify.
  // Замінюємо її звичайною опцією з тією ж назвою і тим самим значенням — існуючі варіанти не змінюються.
  // (зі swatches: true прив'язка до shopify.color-pattern — це якраз потрібний стан, її не чіпаємо)
  const linked = product.options.find((o) => o.name === OPTION && o.linkedMetafield &&
    !(p.swatches && o.linkedMetafield.namespace === SWATCH_NAMESPACE && o.linkedMetafield.key === SWATCH_KEY));
  if (linked) {
    if (linked.optionValues.length !== 1) {
      throw new Error(`Опція "${OPTION}" прив'язана до метаполя категорії і має кілька значень — ` +
        `заміни її вручну в адмінці на звичайну опцію (без прив'язки) і запусти знову.`);
    }
    const value = linked.optionValues[0].name;
    log(`~ Опція "${OPTION}" прив'язана до метаполя категорії — ${DRY_RUN ? 'буде замінена' : 'замінюю'} звичайною опцією "${OPTION}" [${value}]`);
    if (DRY_RUN) {
      product = { ...product, options: product.options.map((o) => (o === linked ? { ...o, linkedMetafield: null } : o)) };
    } else {
      await shopify.deleteOptions(product.id, [linked.id]);
      await shopify.createOption(product.id, OPTION, value, linked.position);
      product = await shopify.getProduct(p.shopifyProductId);
      log(`✓ Опцію "${OPTION}" замінено: ${product.options.map((o) => `${o.name} [${o.optionValues.map((v) => v.name).join(', ')}]`).join('; ')}`);
    }
  }

  let ctx = variantContext(product, OPTION, { swatches: p.swatches });
  // Варіанти без SKU — не з постачальника; з removeVariantsWithoutSku: true їх буде видалено
  const unmanaged = p.removeVariantsWithoutSku ? product.variants.nodes.filter((v) => !v.sku) : [];

  // 1. Каталог постачальників
  const { entries, errors, duplicates } = await loadCatalog(p, suppliers, { skuUrl: state._skuUrl });
  for (const e of errors) log(`❌ ${e}`);
  for (const d of duplicates) {
    log(`⚠️ Код ${d.code} у постачальника на двох тканинах — беру "${d.kept.name}"${d.kept.available ? '' : ' (немає)'}, ` +
      `пропускаю "${d.dropped.name}"${d.dropped.available ? '' : ' (немає)'}`);
  }
  log(`Каталог: ${entries.length} тканин, у наявності ${entries.filter((e) => e.available).length}, ` +
    `уже в товарі ${entries.filter((e) => ctx.existingSkus.has(e.code)).length}`);
  if (errors.length) {
    // неповний каталог → зразки без фото, пропущені тканини; краще нічого не змінювати
    throw new Error('Каталог постачальника прочитано з помилками — нічого не змінюю, запусти пізніше');
  }

  // 2. Зразки: прив'язати існуючу опцію тканин до метаоб'єктів "Колір/візерунок"
  let taxonomy = null;
  if (p.swatches) {
    if (!ctx.fabricOption) throw new Error(`Для зразків у товарі вже має бути опція "${OPTION}"`);
    taxonomy = await loadSwatchTaxonomy(shopify, product.id);
    if (DRY_RUN) {
      log(`Таксономія: кольори — ${taxonomy.colors.map((v) => v.name).join(', ')}`);
      log(`Таксономія: візерунки — ${taxonomy.patterns.map((v) => v.name).join(', ')}`);
    }
    if (!ctx.linked) {
      log(`~ Прив'язка опції "${OPTION}" до зразків (метаполе shopify.color-pattern)${DRY_RUN ? ' — ПРОБНО' : ''}:`);
      const n = await linkFabricOption(shopify, product, OPTION, entries, taxonomy, { dryRun: DRY_RUN, log });
      if (!DRY_RUN) {
        product = await shopify.getProduct(p.shopifyProductId);
        ctx = variantContext(product, OPTION, { swatches: p.swatches });
        log(`✓ Опцію прив'язано, значень: ${n}`);
      }
    }
  }

  const plan = planVariants(newFabrics(entries, ctx), ctx);
  for (const v of unmanaged) log(`- ${v.title} (без SKU) — буде видалено`);
  if (!plan.length) log('Нових варіантів немає.');
  for (const t of plan) {
    log(`+ ${t.name} [${t.sku}] — ціна ${ctx.basePrice}, тканина ${t.supplierPrice ?? '?'} ₴/м, ` +
      `${t.available ? 'в продажу' : 'НЕМАЄ тканини → недоступний'}${t.image ? ', з фото' : ''}`);
  }
  if (p.swatches && plan.length) await attachSwatches(shopify, plan, taxonomy, { dryRun: DRY_RUN, log });

  if (!DRY_RUN && plan.length) {
    // 3. Якщо в товара ще немає опції — створюємо її; стандартний варіант ("Default Title") стає першою тканиною.
    if (!ctx.fabricOption) {
      const isDefaultOnly = product.variants.nodes.length === 1 && product.options.every((o) => o.name === 'Title');
      if (!isDefaultOnly) throw new Error('Неочікувана структура товару — надішли звіт inspect');
      const first = plan.shift();
      await shopify.createOption(product.id, OPTION, first.name);
      await shopify.updateVariants(product.id, [{
        id: product.variants.nodes[0].id,
        inventoryPolicy: first.available ? 'CONTINUE' : 'DENY',
        inventoryItem: { sku: first.sku, tracked: true },
      }]);
      log(`✓ Створено опцію "${OPTION}", перший варіант: ${first.name}`);
    }

    // 4. Решта — пачками, разом із фото
    if (plan.length) {
      const created = await createVariantsWithImages(shopify, product.id, plan, ctx, log);
      log(`✓ Створено варіантів: ${created}`);
    }
  }

  // 5. Видалити варіанти без SKU — лише якщо в товарі лишаються варіанти тканин
  if (unmanaged.length && !DRY_RUN) {
    const fresh = await shopify.getProduct(p.shopifyProductId);
    if (fresh.variants.nodes.some((v) => v.sku)) {
      await shopify.deleteVariants(product.id, unmanaged.map((v) => v.id));
      log(`✓ Видалено варіантів без SKU: ${unmanaged.map((v) => v.title).join(', ')}`);
    } else {
      log('⚠️ Варіанти без SKU не видалено — у товарі ще немає варіантів тканин');
    }
  }

  if (!DRY_RUN) {
    log('');
    printProduct(await shopify.getProduct(p.shopifyProductId));
  }
}

// ---------- inspect ----------

async function inspectSwatches() {
  // Метаоб'єкти "Колір/візерунок" — для зразків тканин у темі
  try {
    const def = await shopify.getMetaobjectDefinition('shopify--color-pattern');
    if (!def) {
      log('Метаоб\'єкт shopify--color-pattern: не знайдено (категорія товару без атрибута "Колір/візерунок"?)');
      return;
    }
    log(`Метаоб'єкт ${def.type} "${def.name}": записів ${def.metaobjectsCount}`);
    for (const f of def.fieldDefinitions) log(`  поле ${f.key} (${f.type.name})${f.required ? ' — обов\'язкове' : ''} — ${f.name}`);
    for (const m of def.metaobjects.nodes) {
      log(`  приклад: ${m.displayName} | ${m.fields.map((f) => `${f.key}=${(f.value || '').slice(0, 60)}`).join('; ')}`);
    }
  } catch (e) {
    log(`Метаоб'єкти недоступні: ${e.message.slice(0, 300)}`);
    log('→ додай застосунку scopes read_metaobjects, write_metaobjects, read_metaobject_definitions, write_files і перевстанови');
  }
}

// ---------- helpers ----------

function printProduct(p) {
  log(`Товар: ${p.title} (${p.status}) — /products/${p.handle}${p.category ? ` — категорія: ${p.category.fullName}` : ''}`);
  log(`Опції: ${p.options.map((o) => `${o.name} [${o.optionValues.map((v) => v.name).join(', ')}]`).join('; ')}`);
  log(`Варіанти (${p.variants.nodes.length}):`);
  for (const v of p.variants.nodes) {
    log(`  - ${v.title} | SKU: ${v.sku || '—'} | ${v.price} | продаж без залишку: ${v.inventoryPolicy === 'CONTINUE' ? 'так' : 'ні'} | облік: ${v.inventoryItem?.tracked ? 'так' : 'ні'} | фото: ${v.media?.nodes?.length ? 'є' : '—'}`);
  }
}

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Не задано змінну середовища ${name}`);
  return v;
}
