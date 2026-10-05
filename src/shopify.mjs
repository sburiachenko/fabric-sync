export const toGid = (id) => (String(id).startsWith('gid://') ? String(id) : `gid://shopify/Product/${id}`);

// Клієнт Shopify Admin GraphQL API.
// Токен отримується через client credentials grant (застосунок із Dev Dashboard, діє ~24 год).

const API_VERSION = '2026-07';

export async function createShopifyClient({ shop, clientId, clientSecret }) {
  const domain = shop.replace(/^https?:\/\//, '').replace(/\/$/, '');

  const tokenRes = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Не вдалося отримати токен Shopify: HTTP ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const { access_token: token } = await tokenRes.json();

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
      const data = await gql(
        `query($id: ID!) {
          product(id: $id) {
            id title handle status
            options { id name optionValues { name } }
            variants(first: 100) {
              nodes { id title sku price inventoryPolicy inventoryItem { tracked } selectedOptions { name value } }
            }
          }
        }`,
        { id: toGid(productId) },
      );
      if (!data.product) throw new Error(`Товар ${productId} не знайдено в Shopify`);
      return data.product;
    },

    /** Додати опцію (напр. "Тканина") з першим значенням. Стандартний варіант отримає це значення. */
    async createOption(productId, name, firstValue) {
      const data = await gql(
        `mutation($productId: ID!, $options: [OptionCreateInput!]!) {
          productOptionsCreate(productId: $productId, options: $options, variantStrategy: LEAVE_AS_IS) {
            product { id }
            userErrors { field message }
          }
        }`,
        { productId: toGid(productId), options: [{ name, values: [{ name: firstValue }] }] },
      );
      return check(data.productOptionsCreate);
    },

    /** Створити варіанти пачкою */
    async createVariants(productId, variants) {
      const data = await gql(
        `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkCreate(productId: $productId, variants: $variants) {
            productVariants { id title sku }
            userErrors { field message }
          }
        }`,
        { productId: toGid(productId), variants },
      );
      return check(data.productVariantsBulkCreate).productVariants;
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

    /** Знайти варіант за SKU */
    async findVariantBySku(sku) {
      const data = await gql(
        `query($q: String!) {
          productVariants(first: 5, query: $q) {
            nodes {
              id sku price inventoryPolicy
              inventoryItem { tracked }
              product { id title handle status }
            }
          }
        }`,
        { q: `sku:${JSON.stringify(sku)}` },
      );
      return data.productVariants.nodes.find((v) => v.sku === sku) || null;
    },

    /** Оновити ціну та/або політику наявності варіанта */
    async updateVariant(productId, variantId, { price, inventoryPolicy }) {
      const input = { id: variantId };
      if (price != null) input.price = String(price);
      if (inventoryPolicy) input.inventoryPolicy = inventoryPolicy;
      const data = await gql(
        `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants { id price inventoryPolicy }
            userErrors { field message }
          }
        }`,
        { productId, variants: [input] },
      );
      const errs = data.productVariantsBulkUpdate.userErrors;
      if (errs.length) throw new Error(`Shopify userErrors: ${JSON.stringify(errs)}`);
      return data.productVariantsBulkUpdate.productVariants[0];
    },
  };
}
