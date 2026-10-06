// Зразки тканин для теми (Dawn: Variant picker → Swatch).
// Кожна тканина = метаоб'єкт shopify--color-pattern ("Колір/візерунок"): назва, фото тканини,
// базовий колір і візерунок зі стандартної таксономії Shopify. Опція товару прив'язується до метаполя
// shopify.color-pattern, а її значення — до цих метаоб'єктів.
//
// Колір/візерунок визначаються за назвою тканини; перевизначити — у config.products:
//   { "supplierUrl": "...", "swatchColors": ["Gray", "White"], "swatchPattern": "Floral" }

export const SWATCH_TYPE = 'shopify--color-pattern';
export const SWATCH_NAMESPACE = 'shopify';
export const SWATCH_KEY = 'color-pattern';

// основа слова → кольори таксономії (англійською)
const COLOR_WORDS = [
  [/сір|графіт|сіро/i, 'Gray'],
  [/беж|кремов|молочн|пісочн/i, 'Beige'],
  [/біл/i, 'White'],
  [/чорн/i, 'Black'],
  [/рожев|персик|пудров/i, 'Pink'],
  [/блакит|голуб|бірюз/i, 'Blue'],
  [/син/i, 'Blue'],
  [/зелен|олив|хвойн|евкаліпт|м['’]ятн|смарагд/i, 'Green'],
  [/жовт|гірчич|лимон/i, 'Yellow'],
  [/червон|вишнев|бордов|малинов/i, 'Red'],
  [/теракот|помаранч|оранж/i, 'Orange'],
  [/коричн|шоколад|кавов/i, 'Brown'],
  [/бузк|фіолет|лаванд|сирен|ліл/i, 'Purple'],
  [/різнокольор|веселк|райдуж/i, 'Multicolor'],
];

// основа слова → кандидати візерунка таксономії (беремо перший, що є в категорії)
const PATTERN_WORDS = [
  [/клітин|клітк|картат/i, ['Checkered', 'Plaid', 'Gingham', 'Tartan']],
  [/смуж|смуг/i, ['Striped', 'Stripes']],
  [/горох|горош|крапк/i, ['Dots', 'Polka dot']],
  [/зір|зірк/i, ['Stars', 'Star']],
  [/сердеч|серц/i, ['Hearts', 'Heart']],
  [/сніжин|різдв|ялин|санта|сніговик|олен|новоріч/i, ['Christmas', 'Holiday', 'Seasonal', 'Winter']],
  [/квіт|троянд|тюльпан|мак|букет|ромаш|лаванд/i, ['Floral', 'Flowers', 'Botanical']],
  [/гілоч|листоч|листя|лист|гінкго|пальм|евкаліпт|хвойн/i, ['Leaves', 'Botanical', 'Floral', 'Nature']],
  [/ведмед|мишк|коал|панд|динозавр|котик|кот|лис|зайч|звір|лам|єдиноріг|єдинорог|олень/i, ['Animal', 'Animals', 'Characters']],
  [/пташ|птах|пташк|сов/i, ['Birds', 'Animal']],
  [/веселк|райдуж/i, ['Rainbow']],
  [/машинк|вертоліт|ракет|літак|автомоб/i, ['Vehicle']],
  [/орнамент|геометр|ромб|трикутн/i, ['Geometric', 'Ethnic', 'Abstract']],
  [/хмаринк|кактус|лимон|вишен|фрукт/i, ['Organic', 'Abstract']],
];
const PATTERN_FALLBACK = ['Random', 'Abstract', 'Other'];

const COLOR_HEX = {
  Gray: '#9E9E9E', Beige: '#E8DCC4', White: '#FFFFFF', Black: '#222222', Pink: '#F4B6C2', Blue: '#7FB3E0',
  Navy: '#1F3A5F', Green: '#7FA77F', Yellow: '#E8C547', Red: '#C0392B', Orange: '#E07B39', Brown: '#8B5A3C',
  Purple: '#A58BC9', Multicolor: '#CCCCCC',
};

/** Значення таксономії для категорії товару: { colors: [{id,name}], patterns: [{id,name}] } */
export async function loadSwatchTaxonomy(shopify, productId) {
  const attrs = await shopify.getCategoryAttributes(productId);
  const find = (re) => attrs.find((a) => re.test(a.name))?.values || [];
  const colors = find(/^colou?r$/i);
  const patterns = find(/^pattern$/i);
  if (!colors.length || !patterns.length) {
    throw new Error(`У категорії товару немає атрибутів Color/Pattern (є: ${attrs.map((a) => a.name).join(', ') || '—'})`);
  }
  return { colors, patterns };
}

/** Колір(и) і візерунок для тканини */
export function guessSwatch(fabric, taxonomy) {
  const name = fabric.name || '';
  const byName = (list, n) => list.find((v) => v.name.toLowerCase() === String(n).toLowerCase());

  let colorNames = fabric.item?.swatchColors;
  if (!colorNames?.length) {
    colorNames = [];
    for (const [re, c] of COLOR_WORDS) if (re.test(name) && !colorNames.includes(c)) colorNames.push(c);
    if (!colorNames.length) colorNames = ['Multicolor'];
  }
  const colors = colorNames.map((n) => byName(taxonomy.colors, n)).filter(Boolean).slice(0, 3);
  if (!colors.length) colors.push(byName(taxonomy.colors, 'Multicolor') || taxonomy.colors[0]);

  let pattern = fabric.item?.swatchPattern && byName(taxonomy.patterns, fabric.item.swatchPattern);
  if (!pattern) {
    for (const [re, candidates] of PATTERN_WORDS) {
      if (!re.test(name)) continue;
      pattern = candidates.map((c) => byName(taxonomy.patterns, c)).find(Boolean);
      if (pattern) break;
    }
  }
  if (!pattern) pattern = PATTERN_FALLBACK.map((c) => byName(taxonomy.patterns, c)).find(Boolean) || taxonomy.patterns[0];

  return { colors, pattern, hex: COLOR_HEX[colors[0].name] || null };
}

export const swatchHandle = (sku) => `fabric-${String(sku).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

/**
 * Знайти або створити метаоб'єкт тканини. fabric: { sku, name (для покупця), supplierName, image, item }.
 * Повертає { id, created, guess }; у dryRun id = null для нових.
 */
export async function ensureSwatch(shopify, fabric, taxonomy, { dryRun = false } = {}) {
  const handle = swatchHandle(fabric.sku);
  const existing = await shopify.getMetaobjectByHandle(SWATCH_TYPE, handle);
  const guess = guessSwatch({ name: fabric.supplierName || fabric.name, item: fabric.item }, taxonomy);
  if (existing) return { id: existing.id, created: false, guess };
  if (dryRun) return { id: null, created: true, guess };

  const imageId = fabric.image ? await shopify.createFile(fabric.image, fabric.name).catch(() => null) : null;
  const fields = [
    { key: 'label', value: fabric.name },
    { key: 'color_taxonomy_reference', value: JSON.stringify(guess.colors.map((c) => c.id)) },
    { key: 'pattern_taxonomy_reference', value: guess.pattern.id },
    ...(guess.hex ? [{ key: 'color', value: guess.hex }] : []),
    ...(imageId ? [{ key: 'image', value: imageId }] : []),
  ];
  const created = await shopify.createMetaobject(SWATCH_TYPE, handle, fields);
  return { id: created.id, created: true, guess, imageId };
}

/** Метаоб'єкти для нових варіантів (t.metaobjectId); у dryRun лише показує вибір */
export async function attachSwatches(shopify, plan, taxonomy, { dryRun = false, log = console.log } = {}) {
  for (const t of plan) {
    const s = await ensureSwatch(shopify, t, taxonomy, { dryRun });
    t.metaobjectId = s.id;
    log(`  🎨 ${t.name} [${t.sku}] — ${s.created ? (dryRun ? 'буде створено зразок' : 'створено зразок') : 'зразок уже є'}: ${describeGuess(s.guess)}`);
  }
}

/**
 * Прив'язати існуючу звичайну опцію тканин до метаполя shopify.color-pattern:
 * для кожного значення опції — метаоб'єкт тканини (за SKU варіанта з цим значенням).
 */
export async function linkFabricOption(shopify, product, optionName, entries, taxonomy, { dryRun = false, log = console.log } = {}) {
  const option = product.options.find((o) => o.name === optionName);
  const byCode = new Map(entries.map((e) => [e.code, e]));
  const links = [];
  for (const value of option.optionValues) {
    const variant = product.variants.nodes.find((v) =>
      v.sku && v.selectedOptions.some((o) => o.name === optionName && o.value === value.name));
    const used = product.variants.nodes.some((v) => v.selectedOptions.some((o) => o.name === optionName && o.value === value.name));
    if (!variant && !used) { log(`  • ${value.name} — без варіантів, пропускаю`); continue; }
    if (!variant) throw new Error(`Значення "${value.name}" опції "${optionName}" без варіанта з SKU — видали його або додай SKU`);
    const e = byCode.get(variant.sku);
    const s = await ensureSwatch(shopify, {
      sku: variant.sku, name: value.name, supplierName: e?.name || value.name, image: bigImage(e?.image), item: e?.item,
    }, taxonomy, { dryRun });
    log(`  🎨 ${value.name} [${variant.sku}] — ${s.created ? (dryRun ? 'буде створено зразок' : 'створено зразок') : 'зразок уже є'}: ${describeGuess(s.guess)}`);
    links.push({ id: value.id, linkedMetafieldValue: s.id });
  }
  if (!dryRun) await shopify.linkOption(product.id, option.id, SWATCH_NAMESPACE, SWATCH_KEY, links);
  return links.length;
}

const bigImage = (url) => (url ? url.replace(/_w\d+_h\d+_/, '_w1280_h1280_') : null);

export const describeGuess =(g) => `колір: ${g.colors.map((c) => c.name).join(', ')}; візерунок: ${g.pattern.name}`;
