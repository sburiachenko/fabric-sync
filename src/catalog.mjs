// Каталог тканин: категорії постачальника (supplierCategories) + окремі товари з config.products.
// config.products — ручні записи: тканина поза категорією, своя назва/SKU, або enabled: false — виключити.

import { fetchSupplierCategory, fetchSupplierProduct } from './supplier.mjs';

/**
 * Повертає { entries, complete, errors }.
 * entries: [{ url, name, code, price, status, available, image, manual, item }]
 * complete — усі категорії прочитано без помилок (можна вважати, що тканини, яких немає, зникли з каталогу).
 */
export async function loadCatalog(config) {
  const errors = [];
  const byUrl = new Map();
  let complete = true;

  for (const cat of config.supplierCategories || []) {
    try {
      for (const t of await fetchSupplierCategory(cat)) byUrl.set(t.url, { ...t, manual: false, item: null });
    } catch (e) {
      complete = false;
      errors.push(`категорія ${cat}: ${e.message}`);
    }
  }

  for (const item of config.products || []) {
    const known = byUrl.get(item.supplierUrl);
    if (item.enabled === false) { byUrl.delete(item.supplierUrl); continue; }
    if (known) { byUrl.set(item.supplierUrl, { ...known, manual: true, item }); continue; }
    try {
      const s = await fetchSupplierProduct(item.supplierUrl);
      byUrl.set(item.supplierUrl, { ...s, manual: true, item });
      await sleep(1000);
    } catch (e) {
      complete = false;
      errors.push(`${item.variantName || item.shopifySku || item.supplierUrl}: ${e.message}`);
    }
  }

  const entries = [...byUrl.values()].map((e) => ({ ...e, code: e.item?.shopifySku || e.code }));
  return { entries, complete, errors };
}

/** Знімок для data/state.json */
export const snapshot = ({ url, name, code, price, status, available, image, checkedAt }) =>
  ({ url, name, code, price, status, available, image, checkedAt });

/**
 * Структура товару для створення варіантів: опція тканини + інші опції з одним значенням.
 * Кидає помилку, якщо є опції з кількома значеннями.
 */
export function variantContext(product, optionName) {
  const fabricOption = product.options.find((o) => o.name === optionName);
  if (fabricOption?.linkedMetafield) {
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
    return { name, sku: e.code, available: e.available !== false, supplierPrice: e.price, image: bigImage(e.image) };
  });
}

/** Вхідні дані для productVariantsBulkCreate (+ медіа з фото постачальника) */
export function variantInputs(plan, ctx, { withImages = true } = {}) {
  const variants = plan.map((t) => ({
    optionValues: [{ optionName: ctx.optionName, name: t.name }, ...ctx.fixedOptionValues],
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

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
