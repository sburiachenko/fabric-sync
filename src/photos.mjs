// Фото варіантів через Nano Banana Pro (gemini-3-pro-image-preview).
//
//   MODE=supplier — без генерації: фото тканини з сайту постачальника → photos/<SKU>.*
//   MODE=prepare  — БЕЗКОШТОВНИЙ шлях: збирає набір для ручної генерації в Google Flow
//                   (головне фото товару + фото тканин + промпт) → архів у GitHub Actions.
//   MODE=generate — (платно, Gemini API) для кожної тканини без файлу photos/<SKU>.* генерує фото:
//                   головне фото товару + фото тканини постачальника → товар з цієї тканини.
//                   Файли зберігаються в репозиторії (папка photos/) для перевірки.
//                   Не сподобалось фото → видали файл і запусти generate знову.
//   MODE=upload   — завантажує фото з photos/ у Shopify і прив'язує до варіантів
//                   (лише нові або змінені файли).
//   ONLY=WF-110,TF-854 — обмежити список SKU (необов'язково)
//   PRODUCT=key        — товар з config/products.json (обов'язково, якщо товарів кілька)
// Фото — у photos/<key товару>/<SKU>.*; тканини — варіанти товару, знайдені в каталозі постачальників.

import { readFile, writeFile, readdir, mkdir, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createShopifyClient } from './shopify.mjs';
import { loadConfig, selectProducts } from './config.mjs';
import { createSupplierCache } from './suppliers.mjs';
import { loadCatalog, bigImage } from './catalog.mjs';

const MODE = process.env.MODE || 'generate';
const ONLY = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const MODEL = 'gemini-3-pro-image-preview';
const UPLOADED_FILE = new URL('../data/photos-uploaded.json', import.meta.url);

const config = await loadConfig();
const selected = selectProducts(config.products);
if (selected.length !== 1) {
  throw new Error(`Фото — для одного товару: вкажи product (${config.products.map((p) => p.key).join(', ')})`);
}
const P = selected[0];
const PHOTOS_DIR = new URL(`../photos/${P.key}/`, import.meta.url);
const photoCfg = {
  prompt:
    'Image 1 is a product photo. Image 2 is a fabric swatch. ' +
    'Recreate image 1 exactly, but make the product sewn from the fabric in image 2. ' +
    'Keep the same shape, cut, seams, folds, pose, camera angle, lighting, shadows and background. ' +
    'Transfer the print faithfully: same motifs, same colors, realistic pattern scale for a sewn item, ' +
    'pattern following the folds and seams naturally. Do not add text, logos or extra objects.',
  imageSize: '2K',
  aspectRatio: null,
  ...(config.photos || {}),
};

const out = [];
const log = (s = '') => { out.push(s); console.log(s); };

const shopify = await createShopifyClient({
  shop: required('SHOPIFY_SHOP'),
  clientId: required('SHOPIFY_CLIENT_ID'),
  clientSecret: required('SHOPIFY_CLIENT_SECRET'),
});
const product = await shopify.getProduct(P.shopifyProductId);
const variantsBySku = new Map(product.variants.nodes.filter((v) => v.sku).map((v) => [v.sku, v]));

await mkdir(PHOTOS_DIR, { recursive: true });
const existingFiles = await readdir(PHOTOS_DIR);
const fileFor = (sku) => existingFiles.find((f) => f.replace(/\.[^.]+$/, '') === safe(sku));

// Тканини, які вже є варіантами товару: { sku, name, fabricUrl, fallbackUrl, extra }
let items = [];
if (MODE !== 'upload') {
  const state = await readFile(new URL('../data/state.json', import.meta.url), 'utf8').then(JSON.parse).catch(() => ({}));
  const { entries, errors } = await loadCatalog(P, createSupplierCache(config.suppliers), { skuUrl: state._skuUrl });
  for (const e of errors) log(`❌ ${e}`);
  items = entries
    .filter((e) => variantsBySku.has(e.code) && (!ONLY.length || ONLY.includes(e.code)))
    .map((e) => ({
      sku: e.code,
      name: variantsBySku.get(e.code).title,
      fabricUrl: e.item?.fabricImageUrl || bigImage(e.image),
      fallbackUrl: e.image,
      extra: e.item?.photoPrompt,
    }));
}
let failures = 0;

if (MODE === 'prepare') {
  // Набір для ручної генерації (Google Flow / Gemini): базове фото + фото тканин + промпт
  const dir = new URL('../prepare/', import.meta.url);
  await mkdir(dir, { recursive: true });
  const baseUrl = photoCfg.baseImageUrl || product.featuredMedia?.preview?.image?.url;
  if (!baseUrl) throw new Error('У товару немає головного фото — додай його в Shopify або вкажи photos.baseImageUrl у конфігу');
  const base = await download(baseUrl);
  await writeFile(new URL(`00-base-product.${extOf(base.mimeType)}`, dir), base.buffer);
  log(`✓ 00-base-product — головне фото товару`);

  const todo = [];
  for (const { sku, name, fabricUrl, fallbackUrl, extra } of items) {
    if (fileFor(sku)) { log(`• ${name} [${sku}] — фото вже є в photos/${P.key}/, пропускаю`); continue; }
    if (!fabricUrl) { log(`⚠️ ${name} [${sku}] — не знайдено фото тканини`); continue; }
    try {
      const fabric = await download(fabricUrl).catch(() => download(fallbackUrl));
      await writeFile(new URL(`${safe(sku)}-fabric.${extOf(fabric.mimeType)}`, dir), fabric.buffer);
      todo.push({ sku, name, extra });
      log(`✓ ${safe(sku)}-fabric — ${name}`);
    } catch (e) { failures++; log(`❌ ${name} [${sku}]: ${e.message}`); }
  }

  const readme = [
    'ЯК ГЕНЕРУВАТИ (Google Flow / Gemini)',
    '',
    '1. Для кожної тканини завантаж 2 зображення в такому порядку:',
    '   перше — 00-base-product, друге — <SKU>-fabric.',
    '2. Встав промпт нижче (+ доповнення для тканини, якщо є).',
    `3. Найкращий результат збережи в папку photos/${P.key}/ репозиторію з назвою <SKU>.png`,
    `   (напр. photos/${P.key}/WF-110.png) — назва файлу = SKU, це важливо!`,
    '4. git add photos && git commit -m "photos" && git push',
    `5. Actions → Fabric sync → photos-upload (product: ${P.key})`,
    '',
    'ПРОМПТ:',
    photoCfg.prompt,
    '',
    'ТКАНИНИ:',
    ...todo.map((t) => `  ${t.sku}  →  photos/${P.key}/${safe(t.sku)}.png   (${t.name})${t.extra ? `\n     доповнення до промпту: ${t.extra}` : ''}`),
  ].join('\n');
  await writeFile(new URL('ІНСТРУКЦІЯ.txt', dir), readme);
  log('');
  log('Завантаж архів "photos-prepare" внизу сторінки запуску (блок Artifacts) — там фото й ІНСТРУКЦІЯ.txt з промптом.');
}

if (MODE === 'supplier') {
  // Без генерації: фото тканини з сайту постачальника → photos/<SKU>.* (для перевірки перед upload)
  for (const { sku, name, fabricUrl, fallbackUrl } of items) {
    try {
      if (fileFor(sku)) { log(`• ${name} [${sku}] — фото вже є (photos/${P.key}/${fileFor(sku)}), пропускаю`); continue; }
      if (!fabricUrl) { log(`⚠️ ${name} [${sku}] — не знайдено фото тканини, вкажи fabricImageUrl у конфігу`); failures++; continue; }
      const img = await download(fabricUrl).catch(() => download(fallbackUrl));
      const file = `${safe(sku)}.${extOf(img.mimeType)}`;
      await writeFile(new URL(file, PHOTOS_DIR), img.buffer);
      existingFiles.push(file);
      log(`✓ ${name} [${sku}] → photos/${P.key}/${file} (${Math.round(img.buffer.length / 1024)} КБ)`);
    } catch (e) {
      failures++;
      log(`❌ ${name} [${sku}]: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  log('');
  log(`Переглянь фото в папці photos/${P.key}/ репозиторію. Невдале — заміни файл своїм або видали. Усі ок — запусти photos-upload.`);
}

if (MODE === 'generate') {
  const apiKey = required('GEMINI_API_KEY');
  const baseUrl = photoCfg.baseImageUrl || product.featuredMedia?.preview?.image?.url;
  if (!baseUrl) throw new Error('У товару немає головного фото — додай його в Shopify або вкажи photos.baseImageUrl у конфігу');
  log(`Базове фото товару: ${baseUrl}`);
  const base = await download(baseUrl);

  for (const { sku, name, fabricUrl, fallbackUrl, extra } of items) {
    if (fileFor(sku)) { log(`• ${name} [${sku}] — фото вже є (photos/${P.key}/${fileFor(sku)}), пропускаю`); continue; }
    if (!fabricUrl) { log(`⚠️ ${name} [${sku}] — не знайдено фото тканини, вкажи fabricImageUrl у конфігу`); failures++; continue; }

    try {
      const fabric = await download(fabricUrl).catch(() => download(fallbackUrl));
      const prompt = [photoCfg.prompt, extra].filter(Boolean).join(' ');
      const img = await generate(apiKey, prompt, [base, fabric]);
      const ext = img.mimeType.includes('png') ? 'png' : img.mimeType.includes('webp') ? 'webp' : 'jpg';
      const file = `${safe(sku)}.${ext}`;
      await writeFile(new URL(file, PHOTOS_DIR), img.buffer);
      existingFiles.push(file);
      log(`✓ ${name} [${sku}] → photos/${P.key}/${file} (${(img.buffer.length / 1024 / 1024).toFixed(1)} МБ)`);
    } catch (e) {
      failures++;
      log(`❌ ${name} [${sku}]: ${e.message}`);
    }
  }
  log('');
  log(`Переглянь фото в папці photos/${P.key}/ репозиторію. Невдале — видали файл і запусти photos-generate знову. Усі ок — запусти photos-upload.`);
}

if (MODE === 'upload') {
  // { "<key товару>": { "<SKU>": { file, hash, mediaId, uploadedAt } } }
  const uploadedAll = await readFile(UPLOADED_FILE, 'utf8').then(JSON.parse).catch(() => ({}));
  const uploaded = (uploadedAll[P.key] ||= {});
  for (const file of existingFiles) {
    const sku = [...variantsBySku.keys()].find((s) => safe(s) === file.replace(/\.[^.]+$/, ''));
    if (!sku) { log(`⚠️ photos/${P.key}/${file} — у товарі немає варіанта з таким SKU`); continue; }
    if (ONLY.length && !ONLY.includes(sku)) continue;
    const variant = variantsBySku.get(sku);

    const buffer = await readFile(new URL(file, PHOTOS_DIR));
    const hash = createHash('sha1').update(buffer).digest('hex').slice(0, 10);
    if (uploaded[sku]?.hash === hash) { log(`• ${variant.title} [${sku}] — це фото вже в Shopify, пропускаю`); continue; }

    try {
      const ext = file.split('.').pop();
      const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      const alt = `${product.title} — ${variant.title} [${sku}-${hash}]`;
      const mediaId = await shopify.uploadVariantImage(product.id, variant, {
        buffer, filename: `${product.handle}-${safe(sku)}.${ext}`, mimeType, alt,
      });
      uploaded[sku] = { file, hash, mediaId, uploadedAt: new Date().toISOString() };
      await writeFile(UPLOADED_FILE, JSON.stringify(uploadedAll, null, 2) + '\n');
      log(`✓ ${variant.title} [${sku}] — фото завантажено й прив'язано до варіанта`);
    } catch (e) {
      failures++;
      log(`❌ ${variant.title} [${sku}]: ${e.message}`);
    }
  }
  log('');
  log('Старі фото (якщо були) лишились у медіа товару — за потреби видали їх в адмінці.');
}

if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, '```\n' + out.join('\n') + '\n```\n');
if (failures) process.exitCode = 1;

// ---------- Gemini ----------

async function generate(apiKey, prompt, images) {
  const imageConfig = { imageSize: photoCfg.imageSize };
  if (photoCfg.aspectRatio) imageConfig.aspectRatio = photoCfg.aspectRatio;
  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: prompt },
        ...images.map((i) => ({ inline_data: { mime_type: i.mimeType, data: i.buffer.toString('base64') } })),
      ],
    }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig },
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData || p.inline_data);
      const data = part?.inlineData || part?.inline_data;
      if (data) return { buffer: Buffer.from(data.data, 'base64'), mimeType: data.mimeType || data.mime_type || 'image/png' };
      const reason = json.candidates?.[0]?.finishReason || json.promptFeedback?.blockReason || 'немає зображення у відповіді';
      if (attempt === 3) throw new Error(`Gemini: ${reason}`);
    } else if (![429, 500, 503].includes(res.status) || attempt === 3) {
      throw new Error(`Gemini HTTP ${res.status}: ${json.error?.message || ''}`);
    }
    await new Promise((r) => setTimeout(r, 10000 * attempt));
  }
}

// ---------- helpers ----------

async function download(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Завантаження ${url}: HTTP ${res.status}`);
  const mimeType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
  return { buffer: Buffer.from(await res.arrayBuffer()), mimeType };
}

function extOf(mime) { return mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg'; }

function safe(s) { return String(s).replace(/[^A-Za-z0-9._-]/g, '_'); }

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Не задано змінну середовища ${name}`);
  return v;
}
