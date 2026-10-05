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

  return {
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
