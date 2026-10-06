export const toGid = (id) => (String(id).startsWith('gid://') ? String(id) : `gid://shopify/Product/${id}`);

// Клієнт Shopify Admin GraphQL API.
// Токен отримується через client credentials grant (застосунок із Dev Dashboard, діє ~24 год).

const API_VERSION = '2026-07';

// Приймає "назва", "назва.myshopify.com", "https://назва.myshopify.com/", "admin.shopify.com/store/назва"
function normalizeShop(shop) {
  const s = shop.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const admin = s.match(/^admin\.shopify\.com\/store\/([^/]+)/);
  if (admin) return `${admin[1]}.myshopify.com`;
  const host = s.split('/')[0];
  return host.includes('.') ? host : `${host}.myshopify.com`;
}

export async function createShopifyClient({ shop, clientId, clientSecret }) {
  const domain = normalizeShop(shop);

  const tokenRes = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId.trim(),
      client_secret: clientSecret.trim(),
    }),
    redirect: 'manual',
  });
  const tokenBody = await tokenRes.text();
  let token = null;
  try { token = JSON.parse(tokenBody).access_token; } catch { /* не JSON */ }
  if (!tokenRes.ok || !token) {
    const hint = tokenRes.status >= 300 && tokenRes.status < 400
      ? `редірект на ${tokenRes.headers.get('location')} — SHOPIFY_SHOP має бути адресою виду назва.myshopify.com`
      : tokenRes.status === 400 || tokenRes.status === 401
        ? 'перевір SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET і що застосунок встановлено в магазин'
        : 'перевір SHOPIFY_SHOP (назва.myshopify.com)';
    throw new Error(`Не вдалося отримати токен Shopify (${domain}): HTTP ${tokenRes.status} — ${hint}. ` +
      `Відповідь: ${tokenBody.replace(/\s+/g, ' ').slice(0, 200)}`);
  }

  async function gql(query, variables = {}) {
    const res = await fetch(`https://${domain}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (!res.ok || json.errors) {
      throw new Error(`Shopify GraphQL помилка: ${JSON.stringify(json.errors || json)}`);
    }
    return json.data;
  }

  const check = (payload) => {
    if (payload.userErrors?.length) throw new Error(`Shopify userErrors: ${JSON.stringify(payload.userErrors)}`);
    return payload;
  };

  return {
    /** Товар з опціями та варіантами */
    async getProduct(productId) {
      const variantFields = `
        pageInfo { hasNextPage endCursor }
        nodes {
          id title sku price inventoryPolicy inventoryItem { tracked } selectedOptions { name value }
          media(first: 3) { nodes { id } }
        }`;
      const data = await gql(
        `query($id: ID!) {
          product(id: $id) {
            id title handle status
            options { id name position linkedMetafield { namespace key } optionValues { name } }
            featuredMedia { preview { image { url } } }
            variants(first: 100) { ${variantFields} }
          }
        }`,
        { id: toGid(productId) },
      );
      if (!data.product) throw new Error(`Товар ${productId} не знайдено в Shopify`);
      const product = data.product;
      // решта варіантів — посторінково
      let page = product.variants;
      const nodes = [...page.nodes];
      while (page.pageInfo.hasNextPage) {
        const next = await gql(
          `query($id: ID!, $after: String) {
            product(id: $id) { variants(first: 100, after: $after) { ${variantFields} } }
          }`,
          { id: product.id, after: page.pageInfo.endCursor },
        );
        page = next.product.variants;
        nodes.push(...page.nodes);
      }
      product.variants = { nodes };
      return product;
    },

    /** Додати опцію (напр. "Тканина") з першим значенням. Стандартний варіант отримає це значення. */
    async createOption(productId, name, firstValue, position) {
      const option = { name, values: [{ name: firstValue }], ...(position ? { position } : {}) };
      const data = await gql(
        `mutation($productId: ID!, $options: [OptionCreateInput!]!) {
          productOptionsCreate(productId: $productId, options: $options, variantStrategy: LEAVE_AS_IS) {
            product { id }
            userErrors { field message }
          }
        }`,
        { productId: toGid(productId), options: [option] },
      );
      return check(data.productOptionsCreate);
    },

    /** Видалити опції (лише з одним значенням — варіанти не зникають) */
    async deleteOptions(productId, optionIds) {
      const data = await gql(
        `mutation($productId: ID!, $options: [ID!]!) {
          productOptionsDelete(productId: $productId, options: $options) {
            deletedOptionsIds
            userErrors { field message }
          }
        }`,
        { productId: toGid(productId), options: optionIds },
      );
      return check(data.productOptionsDelete);
    },

    /** Створити варіанти пачкою; media — нові зображення товару (варіант посилається через mediaSrc) */
    async createVariants(productId, variants, media = []) {
      const data = await gql(
        `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $media: [CreateMediaInput!]) {
          productVariantsBulkCreate(productId: $productId, variants: $variants, media: $media) {
            productVariants { id title sku }
            userErrors { field message }
          }
        }`,
        { productId: toGid(productId), variants, media: media.length ? media : null },
      );
      return check(data.productVariantsBulkCreate).productVariants;
    },

    /** Видалити варіанти */
    async deleteVariants(productId, variantIds) {
      const data = await gql(
        `mutation($productId: ID!, $variantsIds: [ID!]!) {
          productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
            product { id }
            userErrors { field message }
          }
        }`,
        { productId: toGid(productId), variantsIds: variantIds },
      );
      return check(data.productVariantsBulkDelete);
    },

    /** Довільне оновлення варіантів пачкою */
    async updateVariants(productId, variants) {
      const data = await gql(
        `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants { id title sku }
            userErrors { field message }
          }
        }`,
        { productId: toGid(productId), variants },
      );
      return check(data.productVariantsBulkUpdate).productVariants;
    },

    /**
     * Завантажити зображення в товар і прив'язати до варіанта.
     * buffer — вміст файлу, alt — підпис (має бути унікальним у товарі).
     */
    async uploadVariantImage(productId, variant, { buffer, filename, mimeType, alt }) {
      productId = toGid(productId);

      // 1) тимчасове місце для завантаження
      const st = await gql(
        `mutation($input: [StagedUploadInput!]!) {
          stagedUploadsCreate(input: $input) {
            stagedTargets { url resourceUrl parameters { name value } }
            userErrors { field message }
          }
        }`,
        { input: [{ resource: 'IMAGE', filename, mimeType, httpMethod: 'POST', fileSize: String(buffer.length) }] },
      );
      const target = check(st.stagedUploadsCreate).stagedTargets[0];
      const form = new FormData();
      for (const p of target.parameters) form.append(p.name, p.value);
      form.append('file', new Blob([buffer], { type: mimeType }), filename);
      const up = await fetch(target.url, { method: 'POST', body: form });
      if (!up.ok) throw new Error(`Завантаження файлу: HTTP ${up.status} ${await up.text()}`);

      // 2) додати як медіа товару
      const pu = await gql(
        `mutation($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
          productUpdate(product: $product, media: $media) {
            product { id }
            userErrors { field message }
          }
        }`,
        { product: { id: productId }, media: [{ originalSource: target.resourceUrl, alt, mediaContentType: 'IMAGE' }] },
      );
      check(pu.productUpdate);

      // 3) дочекатися обробки
      let media = null;
      for (let i = 0; i < 30; i++) {
        const d = await gql(
          `query($id: ID!) { product(id: $id) { media(last: 50) { nodes { id alt status } } } }`,
          { id: productId },
        );
        media = d.product.media.nodes.filter((m) => m.alt === alt).pop();
        if (media?.status === 'READY') break;
        if (media?.status === 'FAILED') throw new Error('Shopify не зміг обробити зображення');
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (media?.status !== 'READY') throw new Error('Зображення не оброблено за 60 с');

      // 4) відв'язати старе фото варіанта (якщо було) і прив'язати нове
      const old = variant.media?.nodes?.map((m) => m.id) || [];
      if (old.length) {
        const dt = await gql(
          `mutation($productId: ID!, $vm: [ProductVariantDetachMediaInput!]!) {
            productVariantDetachMedia(productId: $productId, variantMedia: $vm) { userErrors { field message } }
          }`,
          { productId, vm: [{ variantId: variant.id, mediaIds: old }] },
        );
        check(dt.productVariantDetachMedia);
      }
      const ap = await gql(
        `mutation($productId: ID!, $vm: [ProductVariantAppendMediaInput!]!) {
          productVariantAppendMedia(productId: $productId, variantMedia: $vm) { userErrors { field message } }
        }`,
        { productId, vm: [{ variantId: variant.id, mediaIds: [media.id] }] },
      );
      check(ap.productVariantAppendMedia);
      return media.id;
    },
  };
}
