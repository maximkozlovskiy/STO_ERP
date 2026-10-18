'use strict';
/**
 * Спільний каталог фейків: ті самі артикули є в кількох постачальників із різними цінами,
 * залишками й термінами — щоб автопідбір мав із чого обирати. `analogOf` — крос для пошуку з
 * аналогами (BM, Tehnomir).
 */
const CATALOG = [
  { key: 'oc90', article: 'OC 90', brand: 'MAHLE', name: 'Фільтр оливи', basePrice: 127.89 },
  {
    key: 'w712',
    article: 'W 712/75',
    brand: 'MANN-FILTER',
    name: 'Фільтр оливи',
    basePrice: 115.5,
    analogOf: 'oc90',
  },
  {
    key: 'gdb1330',
    article: 'GDB1330',
    brand: 'TRW',
    name: 'Колодки гальмівні передні',
    basePrice: 980,
  },
  { key: 'k015', article: 'K015578XS', brand: 'GATES', name: 'Комплект ГРМ', basePrice: 3150 },
];

const norm = s =>
  String(s || '')
    .toUpperCase()
    .replace(/[^0-9A-ZА-ЯІЇЄҐ]/g, '');

function findByArticle(article) {
  const a = norm(article);
  return CATALOG.filter(i => norm(i.article) === a);
}

function analogsOf(item) {
  return CATALOG.filter(i => i.analogOf === item.key || item.analogOf === i.key);
}

module.exports = { CATALOG, norm, findByArticle, analogsOf };
