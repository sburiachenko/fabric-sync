# fabric-sync

Щоденна синхронізація тканин постачальника (cottonville.com.ua) з магазином Shopify:
ціна тканини → ціна виробу за формулою, наявність тканини → можна/не можна купити виріб.

## Як працює

Один товар у Shopify (`shopifyProductId`), кожна тканина — його **варіант** (опція «Тканина», SKU = код постачальника).
**Ціну виробу задаєш ти** — скрипт її не змінює.

Щодня о 07:00 (Київ) GitHub Actions:
1. відкриває сторінки тканин із `config/products.json` і бере **код, ціну, наявність**;
2. тканина є → варіант можна купити; тканини немає → варіант «Немає в наявності»;
3. якщо постачальник змінив ціну чи код — пише про це у звіті (Summary + Telegram);
4. зберігає знімок у `data/state.json`.

## Режими (Actions → Fabric sync → Run workflow)

| Режим | Що робить |
|---|---|
| `supplier-only` | лише читає сайт постачальника |
| `inspect` | показує товар: опції, варіанти, SKU, ціни |
| `create-variants-dry-run` | показує, які варіанти буде створено |
| `create-variants` | створює варіанти для нових тканин з конфігу (повторно не дублює) |
| `dry-run` | синхронізація наявності — пробно |
| `live` | синхронізація наявності — реально (за розкладом працює саме цей) |
| `photos-supplier` | бере фото тканин із сайту постачальника → папка `photos/<SKU>.jpg` (у Shopify нічого не змінює) |
| `photos-upload` | завантажує фото з `photos/` у Shopify і прив'язує до варіантів |

Нова тканина: додай запис у `products` → push → `create-variants` → `photos-supplier` → переглянь `photos/` → `photos-upload`.

### Фото (Nano Banana Pro) — поки вимкнено в меню workflow
Режими `photos-prepare` / `photos-generate` є в `src/photos.mjs`; щоб увімкнути — додай їх в `options` у `.github/workflows/sync.yml`.
- Вхід: головне фото товару в Shopify + фото тканини з сайту постачальника.
- Результат: `photos/<SKU>.png` у репозиторії — переглянь на GitHub.
- Не сподобалось → видали файл (`git rm photos/WF-110.png`, push) → `photos-generate` з полем `only: WF-110`.
- Промпт і розмір — у блоці `photos` конфігу; для окремої тканини можна додати `photoPrompt`.
- Потрібен секрет `GEMINI_API_KEY` (Google AI Studio, платний тариф).

## Налаштування

### 1. Shopify
- Застосунок у Dev Dashboard зі scopes: `read_products, write_products, read_inventory, write_inventory, read_locations`, встановлений у магазин.
- Варіанти створює режим `create-variants` (SKU, облік кількості, наявність — автоматично).

### 2. GitHub Secrets
Repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Значення |
|---|---|
| `SHOPIFY_SHOP` | `твій-магазин.myshopify.com` |
| `SHOPIFY_CLIENT_ID` | Client ID з Dev Dashboard |
| `SHOPIFY_CLIENT_SECRET` | Client Secret з Dev Dashboard |
| `GEMINI_API_KEY` | ключ Google AI Studio (для фото) |
| `TELEGRAM_BOT_TOKEN` | *(необов'язково)* токен бота від @BotFather |
| `TELEGRAM_CHAT_ID` | *(необов'язково)* твій chat id |

### 3. Конфіг `config/products.json`
- `shopifyProductId` — ID товару (з адреси в адмінці: `/products/<ID>`).
- `products[]` — по запису на тканину: `supplierUrl`, `variantName` (назва для покупця; порожньо — з назви постачальника), `shopifySku` (порожньо — код постачальника).

## Перший запуск (рекомендований порядок)

Actions → **Fabric sync** → **Run workflow** → режим:
1. `inspect` → 2. `create-variants-dry-run` → 3. `create-variants` → 4. `dry-run` → далі працює за розкладом.

## Локально (необов'язково)

```bash
npm run check                         # лише постачальник
SHOPIFY_SHOP=... SHOPIFY_CLIENT_ID=... SHOPIFY_CLIENT_SECRET=... npm run dry
```
