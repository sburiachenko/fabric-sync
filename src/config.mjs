// Конфіг: config/suppliers.json (постачальники) + config/products.json (товари Shopify).

import { readFile } from 'node:fs/promises';

const read = async (name) => JSON.parse(await readFile(new URL(`../config/${name}`, import.meta.url), 'utf8'));

export async function loadConfig() {
  const suppliers = Object.fromEntries(Object.entries(await read('suppliers.json')).filter(([k]) => !k.startsWith('_')));
  const raw = await read('products.json');

  const products = (raw.products || []).map((p, i) => {
    const key = p.key || String(p.shopifyProductId || i);
    const sources = p.sources || [];
    const defaultSupplier = sources[0]?.supplier || Object.keys(suppliers)[0];
    for (const s of [...sources, ...(p.fabrics || [])]) {
      const id = s.supplier || defaultSupplier;
      if (!suppliers[id]) throw new Error(`Товар "${key}": невідомий постачальник "${id}" — додай його в config/suppliers.json`);
    }
    return {
      key,
      name: p.name || key,
      shopifyProductId: p.shopifyProductId,
      optionName: p.optionName || 'Тканина',
      swatches: p.swatches === true,
      autoAddInStock: p.autoAddInStock === true,
      removeVariantsWithoutSku: p.removeVariantsWithoutSku === true,
      sources,
      fabrics: (p.fabrics || []).map((f) => ({ ...f, supplier: f.supplier || defaultSupplier })),
    };
  });

  return { suppliers, products, photos: raw.photos || {} };
}

/** Товари для запуску: PRODUCT=key або shopifyProductId (порожньо — усі) */
export function selectProducts(products, filter = process.env.PRODUCT) {
  const f = (filter || '').trim();
  if (!f) return products;
  const picked = products.filter((p) => p.key === f || String(p.shopifyProductId) === f);
  if (!picked.length) throw new Error(`Товар "${f}" не знайдено в config/products.json (є: ${products.map((p) => p.key).join(', ')})`);
  return picked;
}
