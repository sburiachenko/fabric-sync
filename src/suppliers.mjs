// Адаптери сайтів постачальників. Кожен тип сайту реалізує:
//   fetchCategory(url, { pauseMs }) → [{ url, name, code, price, status, available, image, checkedAt }]
//   fetchProduct(url)               → { url, name, code, price, status, available, image, checkedAt }
// Новий тип сайту = новий адаптер тут + "type" у config/suppliers.json.

import { fetchSupplierCategory, fetchSupplierProduct } from './supplier.mjs';

const ADAPTERS = {
  prom: {
    fetchCategory: (url, { pauseMs } = {}) => fetchSupplierCategory(url, { pause: pauseMs ?? 2000 }),
    fetchProduct: (url) => fetchSupplierProduct(url),
  },
};

/**
 * Доступ до постачальників з кешем на час запуску: категорія чи сторінка читається один раз,
 * навіть якщо її тканини використовують кілька товарів.
 */
export function createSupplierCache(suppliers) {
  const cache = new Map();
  const adapterFor = (id) => {
    const s = suppliers[id];
    if (!s) throw new Error(`Невідомий постачальник "${id}"`);
    const a = ADAPTERS[s.type];
    if (!a) throw new Error(`Постачальник "${id}": невідомий тип сайту "${s.type}" (є: ${Object.keys(ADAPTERS).join(', ')})`);
    return { s, a };
  };
  const memo = (key, fn) => {
    if (!cache.has(key)) cache.set(key, fn());
    return cache.get(key);
  };
  return {
    supplier: (id) => suppliers[id],
    category: (id, url) => memo(`c|${id}|${url}`, () => {
      const { s, a } = adapterFor(id);
      return a.fetchCategory(url, { pauseMs: s.pauseMs });
    }),
    product: (id, url) => memo(`p|${id}|${url}`, () => adapterFor(id).a.fetchProduct(url)),
  };
}
