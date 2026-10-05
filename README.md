# fabric-sync

Щоденна синхронізація тканин постачальника (cottonville.com.ua) з магазином Shopify:
ціна тканини → ціна виробу за формулою, наявність тканини → можна/не можна купити виріб.

## Як працює

Щодня о 07:00 (Київ) GitHub Actions:
1. відкриває сторінки тканин із `config/products.json` і бере **код, ціну, статус**;
2. знаходить у Shopify варіант за **SKU**;
3. оновлює ціну (якщо зміна ≤ `maxAutoChangePercent`, інакше — лише попередження);
4. тканина є → `Продовжувати продаж, коли немає в наявності`; тканини немає → товар стає «Немає в наявності»;
5. зберігає знімок у `data/state.json` і пише звіт (вкладка Summary запуску + Telegram, якщо налаштовано).

## Налаштування

### 1. Shopify
- Застосунок у Dev Dashboard зі scopes: `read_products, write_products, read_inventory, write_inventory, read_locations`, встановлений у магазин.
- У кожному товарі: **SKU варіанта** = значення `shopifySku` з конфігу (або код постачальника, напр. `WF-110`).
- У кожному варіанті: увімкнено **«Відстежувати кількість»**, кількість **0** (виріб шиється під замовлення).

### 2. GitHub Secrets
Repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Значення |
|---|---|
| `SHOPIFY_SHOP` | `твій-магазин.myshopify.com` |
| `SHOPIFY_CLIENT_ID` | Client ID з Dev Dashboard |
| `SHOPIFY_CLIENT_SECRET` | Client Secret з Dev Dashboard |
| `TELEGRAM_BOT_TOKEN` | *(необов'язково)* токен бота від @BotFather |
| `TELEGRAM_CHAT_ID` | *(необов'язково)* твій chat id |

### 3. Конфіг `config/products.json`
- `pricing` — загальна формула: `(meters × ціна тканини + sewingCost + extraCost) × (1 + marginPercent/100)`, округлено до …9 ₴.
- `products[]` — по одному запису на тканину/товар; `pricing` всередині товару перевизначає загальні значення.

## Перший запуск (рекомендований порядок)

Actions → **Fabric sync** → **Run workflow** → режим:
1. `supplier-only` — перевірити, що сайт постачальника читається правильно (Shopify не чіпає);
2. `dry-run` — побачити, що змінилося б у Shopify;
3. `live` — реальне оновлення. Далі працює саме за розкладом.

## Локально (необов'язково)

```bash
npm run check                         # лише постачальник
SHOPIFY_SHOP=... SHOPIFY_CLIENT_ID=... SHOPIFY_CLIENT_SECRET=... npm run dry
```
