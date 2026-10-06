# fabric-sync

Щоденна синхронізація тканин постачальників з магазином Shopify:
наявність тканини → можна/не можна купити виріб; нові тканини → нові варіанти з фото і зразком.

## Як працює

Кожен товар у Shopify (пелюшки, плед, …) — запис у `config/products.json`; кожна тканина — його **варіант**
(опція `optionName`, напр. «Колір»; SKU = префікс постачальника + код постачальника).
**Ціну виробу задаєш ти** — скрипт її не змінює.

Щодня о 07:00 (Київ) GitHub Actions для кожного товару:
1. читає категорії постачальників із `sources` (усі сторінки; спільна категорія читається один раз на всі товари) — **код, ціну, наявність, фото**;
2. тканина є → варіант можна купити; тканини немає (або вона зникла з категорії) → «Немає в наявності»;
3. нова тканина в наявності → створює варіант з фото й зразком (`autoAddInStock: true`);
4. якщо постачальник змінив ціну чи код — пише про це у звіті (Summary + Telegram);
5. зберігає знімок у `data/state.json` (там же `_skuUrl` — до якої сторінки прив'язаний кожен SKU, бо в постачальника бувають однакові коди на різних тканинах).

## Режими (Actions → Fabric sync → Run workflow)

Поле `product` — key товару (порожньо = усі), `only` — лише ці SKU.

| Режим | Що робить |
|---|---|
| `supplier-only` | лише читає сайти постачальників |
| `inspect` | показує товари: опції, варіанти, SKU, ціни, фото |
| `create-variants-dry-run` | показує, які варіанти і зразки буде створено |
| `create-variants` | створює варіанти для тканин у наявності, яких ще немає (з фото і зразком; повторно не дублює); з `removeVariantsWithoutSku` — видаляє варіанти без SKU |
| `dry-run` | синхронізація наявності — пробно |
| `live` | синхронізація наявності — реально (за розкладом працює саме цей) |
| `photos-supplier` | бере фото тканин із сайту постачальника → `photos/<key>/<SKU>.jpg` (у Shopify нічого не змінює) |
| `photos-upload` | завантажує фото з `photos/<key>/` у Shopify і прив'язує до варіантів |

Нові тканини з категорій додаються самі. Тканина поза категорією: запис у `fabrics` товару → push → `create-variants`.
Замінити фото варіанта своїм: поклади `photos/<key>/<SKU>.jpg` → push → `photos-upload`.

### Зразки тканин (тема Dawn)
З `swatches: true` кожна тканина — метаоб'єкт «Колір/візерунок» (`shopify--color-pattern`) з фото тканини,
базовим кольором і візерунком (визначаються за назвою; перевизначити — `swatchColors` / `swatchPattern` у `fabrics`).
Опція тканин прив'язана до метаполя `shopify.color-pattern`. У Dawn: Customize → сторінка товару → Variant picker → Swatch.
Один метаоб'єкт на тканину — спільний для всіх товарів.

### Фото (Nano Banana Pro) — поки вимкнено в меню workflow
Режими `photos-prepare` / `photos-generate` є в `src/photos.mjs`; щоб увімкнути — додай їх в `options` у `.github/workflows/sync.yml`.
Промпт і розмір — у блоці `photos` конфігу; потрібен секрет `GEMINI_API_KEY`.

## Налаштування

### 1. Shopify
Застосунок у Dev Dashboard, встановлений у магазин, зі scopes:
`read_products, write_products, read_inventory, write_inventory, read_locations, read_metaobjects, write_metaobjects, read_metaobject_definitions, write_files`.

### 2. GitHub Secrets
Repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Значення |
|---|---|
| `SHOPIFY_SHOP` | `твій-магазин.myshopify.com` |
| `SHOPIFY_CLIENT_ID` | Client ID з Dev Dashboard |
| `SHOPIFY_CLIENT_SECRET` | Client Secret з Dev Dashboard |
| `GEMINI_API_KEY` | *(для генерації фото)* ключ Google AI Studio |
| `TELEGRAM_BOT_TOKEN` | *(необов'язково)* токен бота від @BotFather |
| `TELEGRAM_CHAT_ID` | *(необов'язково)* твій chat id |

### 3. Постачальники — `config/suppliers.json`
```json
"cottonville": { "type": "prom", "skuPrefix": "", "pauseMs": 2000 }
```
- `type` — тип сайту (адаптер у `src/suppliers.mjs`): `prom` — будь-який магазин на Prom.ua.
- `skuPrefix` — префікс SKU, щоб коди різних постачальників не збігались (напр. `"S2-"`).

### 4. Товари — `config/products.json`
```json
{
  "key": "pelyushky", "name": "Фланелеві пелюшки", "shopifyProductId": "15400212365621",
  "optionName": "Колір", "swatches": true, "autoAddInStock": true,
  "sources": [{ "supplier": "cottonville", "category": "https://…/g122415650-flanel-printami-shirina" }],
  "fabrics": [{ "supplierUrl": "https://…", "variantName": "", "shopifySku": "", "enabled": false }]
}
```
- `shopifyProductId` — ID товару (з адреси в адмінці: `/products/<ID>`).
- `optionName` — опція, значення якої = тканини; інші опції (напр. «Розмір») мають мати одне значення.
- `fabrics` — ручні записи (необов'язково): тканина поза категорією, своя назва/SKU, `enabled: false` — виключити.

Новий товар: створи його в Shopify (з опціями, напр. «Колір» з одним значенням і «Розмір»), додай запис → push →
`create-variants-dry-run` (product: key) → `create-variants`.

## Локально (необов'язково)

```bash
SUPPLIER_ONLY=1 DRY_RUN=1 node src/sync.mjs                 # лише постачальники
SHOPIFY_SHOP=... SHOPIFY_CLIENT_ID=... SHOPIFY_CLIENT_SECRET=... DRY_RUN=1 node src/sync.mjs
```
