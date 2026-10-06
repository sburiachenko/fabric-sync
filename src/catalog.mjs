// Каталог тканин одного товару: категорії постачальників (sources) + ручні записи (fabrics).
// fabrics — тканина поза категорією, своя назва/SKU, або enabled: false — виключити.
// SKU = префікс постачальника (skuPrefix) + код постачальника; shopifySku у fabrics — точне значення.

/**
 * product — запис з config (loadConfig), suppliers — createSupplierCache(...).
 * Повертає { entries, complete, errors, duplicates }.
 * entries: [{ url, name, code, supplierCode, supplier, price, status, available, image, manual, item }]
 * complete — усі джерела прочитано без помилок (можна вважати, що тканини, яких немає, зникли з каталогу).
 */
export async function loadCatalog(product, suppliers, { skuUrl = {} } = {}) {
  const errors = [];
  const byUrl = new Map();
  let complete = true;
  const withCode = (t, supplier, item = null) => ({
    ...t,
    supplier,
    supplierCode: t.code,
    code: item?.shopifySku || (t.code ? `${suppliers.supplier(supplier)?.skuPrefix || ''}${t.code}` : null),
    manual: !!item,
    item,
  });

  for (const src of product.sources) {
    try {
      for (const t of await suppliers.category(src.supplier, src.category)) byUrl.set(t.url, withCode(t, src.supplier));
    } catch (e) {
      complete = false;
      errors.push(`${src.supplier}: категорія ${src.category}: ${e.message}`);
    }
  }

  for (const item of product.fabrics) {
    const known = byUrl.get(item.supplierUrl);
    if (item.enabled === false) { byUrl.delete(item.supplierUrl); continue; }
    try {
      const s = known || await suppliers.product(item.supplier, item.supplierUrl);
      byUrl.set(item.supplierUrl, withCode(s, item.supplier, item));
    } catch (e) {
      complete = false;
      errors.push(`${item.variantName || item.shopifySku || item.supplierUrl}: ${e.message}`);
    }
  }

  // Один код — одна тканина. У постачальника буває однаковий код на різних тканинах
  // (напр. TF-204: "Пандочки блакитні" і "Пандочки рожеві") — інакше наявність однієї керувала б варіантом іншої.
  // Пріоритет: сторінка, до якої код уже прив'язаний (skuUrl) → ручний запис → у наявності → перша.
  const all = [...byUrl.values()];
  const rank = (e) => (skuUrl[e.code] === e.url ? 0 : e.manual ? 1 : e.available ? 2 : 3);
  const byCode = new Map();
  const duplicates = [];
  for (const e of all) {
    if (!e.code) continue;
    const prev = byCode.get(e.code);
    if (!prev) { byCode.set(e.code, e); continue; }
    const [keep, drop] = rank(e) < rank(prev) ? [e, prev] : [prev, e];
    byCode.set(e.code, keep);
    duplicates.push({ code: e.code, kept: keep, dropped: drop });
  }
  const entries = [...byCode.values(), ...all.filter((e) => !e.code)];
  return { entries, complete, errors, duplicates };
}

/** Прив'язка код → сторінка для наступних запусків (зберігається в data/state.json як _skuUrl) */
export const skuUrlMap = (entries) => Object.fromEntries(entries.filter((e) => e.code).map((e) => [e.code, e.url]));

/** Знімок для data/state.json */
export const snapshot = ({ url, supplier, name, code, price, status, available, image, checkedAt }) =>
  ({ url, supplier, name, code, price, status, available, image, checkedAt });

/**
 * Структура товару для створення варіантів: опція тканини + інші опції з одним значенням.
 * Кидає помилку, якщо є опції з кількома значеннями.
 */
export function variantContext(product, optionName, { swatches = false } = {}) {
  const fabricOption = product.options.find((o) => o.name === optionName);
  const lm = fabricOption?.linkedMetafield;
  const linkedToSwatches = swatches && lm?.namespace === 'shopify' && lm?.key === 'color-pattern';
  if (lm && !linkedToSwatches) {
    throw new Error(`Опція "${optionName}" прив'язана до метаполя категорії ` +
      `(${fabricOption.linkedMetafield.namespace}.${fabricOption.linkedMetafield.key}) — назви тканин у неї не записати, запусти create-variants`);
  }
  const otherOptions = product.options.filter((o) => o.name !== optionName && o.name !== 'Title');
  const multi = otherOptions.filter((o) => o.optionValues.length !== 1);
  if (multi.length) {
    throw new Error(`Опції з кількома значеннями (${multi.map((o) => o.name).join(', ')}) — ` +
      `автоматично створювати комбінації не буду, напиши, як мають поєднуватися тканини з цими опціями.`);
  }
  return {
    optionName,
    fabricOption,
    linked: linkedToSwatches,
    fixedOptionValues: otherOptions.map((o) => ({ optionName: o.name, name: o.optionValues[0].name })),
    existingSkus: new Set(product.variants.nodes.map((v) => v.sku).filter(Boolean)),
    existingNames: new Set(fabricOption?.optionValues.map((v) => v.name) || []),
    basePrice: product.variants.nodes[0]?.price ?? '0',
  };
}

/** Тканини, для яких треба створити варіант: ручні — завжди, з категорії — лише в наявності */
export function newFabrics(entries, ctx) {
  return entries.filter((e) => e.code && !ctx.existingSkus.has(e.code) && (e.manual || e.available));
}

/** План нових варіантів з унікальними назвами */
export function planVariants(fabrics, ctx) {
  const names = new Set(ctx.existingNames);
  return fabrics.map((e) => {
    let name = e.item?.variantName || cleanName(e.name) || e.code;
    if (names.has(name)) name = `${name} (${e.code})`;
    names.add(name);
    return {
      name, sku: e.code, available: e.available !== false, supplierPrice: e.price, image: bigImage(e.image),
      supplierName: e.name, item: e.item,
    };
  });
}

/** Вхідні дані для productVariantsBulkCreate (+ медіа з фото постачальника) */
export function variantInputs(plan, ctx, { withImages = true } = {}) {
  const variants = plan.map((t) => ({
    optionValues: [
      t.metaobjectId
        ? { optionName: ctx.optionName, linkedMetafieldValue: t.metaobjectId }
        : { optionName: ctx.optionName, name: t.name },
      ...ctx.fixedOptionValues,
    ],
    price: ctx.basePrice,
    inventoryPolicy: t.available ? 'CONTINUE' : 'DENY',
    inventoryItem: { sku: t.sku, tracked: true },
    ...(withImages && t.image ? { mediaSrc: [t.image] } : {}),
  }));
  const media = withImages
    ? plan.filter((t) => t.image).map((t) => ({ originalSource: t.image, alt: t.name, mediaContentType: 'IMAGE' }))
    : [];
  return { variants, media };
}

/** Створити варіанти пачками; якщо Shopify не прийме фото — створює без них */
export async function createVariantsWithImages(shopify, productId, plan, ctx, log) {
  let created = 0;
  for (let i = 0; i < plan.length; i += 25) {
    const chunk = plan.slice(i, i + 25);
    try {
      const { variants, media } = variantInputs(chunk, ctx);
      created += (await shopify.createVariants(productId, variants, media)).length;
    } catch (e) {
      log(`⚠️ Не вдалося створити з фото (${e.message.slice(0, 200)}) — створюю без фото`);
      const { variants } = variantInputs(chunk, ctx, { withImages: false });
      created += (await shopify.createVariants(productId, variants)).length;
    }
  }
  return created;
}

export function cleanName(name) {
  if (!name) return null;
  return name
    .replace(/\s*[,—|–-]\s*(ціна|купити|цена|prom).*$/i, '')
    .replace(/^\s*фланель\s+/i, '')
    .replace(/\s*\(\s*залишок[^)]*\)/gi, '')
    .replace(/,?\s*(ширина\s*)?\d{3}\s*см\.?\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

// Prom.ua віддає картинки у різних розмірах: ..._w272_h200_... → беремо найбільший
export function bigImage(url) {
  return url ? url.replace(/_w\d+_h\d+_/, '_w1280_h1280_') : null;
}
