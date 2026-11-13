const test = require('node:test');
const assert = require('node:assert');
const R = require('../src/refdata');
const P = require('../src/premium');

const ref = P.buildRef({
  zips: R.ZIPS,
  costs: R.BUILDING_COSTS.flatMap(([min, max, ...p]) => p.map((v, i) => ({ version: R.BUILDING_COST_VERSION, floor_min: min, floor_max: max, cost_region: i + 1, price_per_ping: v }))),
  structures: R.STRUCTURES,
  roofs: R.ROOFS,
  grades: R.GRADES,
  shortRates: Object.entries(R.SHORT_RATES).flatMap(([product, l]) => l.map(([months, pct]) => ({ product, months, pct }))),
  settings: R.SETTINGS,
});

test('台北市中正區 12 層 RC 30 坪 建議保額', () => {
  const r = P.suggest(ref, { zip: '100', totalFloors: 12, areaPing: 30, structureCode: '02', roofCode: '01', decorationPerPing: 0 });
  assert.strictEqual(r.unitPrice, 113000);
  assert.strictEqual(r.bodyCost, 3390000);
  assert.strictEqual(r.suggestedBuildingWan, 339);
  assert.strictEqual(r.suggestedGrade, '1');
});

test('鋼骨加 16%、磚造固定單價', () => {
  assert.strictEqual(P.suggest(ref, { zip: '100', totalFloors: 12, areaPing: 10, structureCode: '01', roofCode: '01' }).unitPrice, 131080);
  assert.strictEqual(P.suggest(ref, { zip: '970', totalFloors: 2, areaPing: 10, structureCode: '05', roofCode: '03' }).unitPrice, 34000);
});

test('外島比照新北市（第2區）', () => {
  assert.strictEqual(P.suggest(ref, { zip: '880', totalFloors: 3, areaPing: 1, structureCode: '02' }).unitPrice, 75200);
});

test('保費計算：339 萬、特一、一年', () => {
  const c = P.calculate(ref, { zip: '100', totalFloors: 12, areaPing: 30, structureCode: '02', roofCode: '01', gradeCode: '1', buildingSumWan: 339, periodMonths: 12 });
  assert.strictEqual(c.firePremium, Math.round(3390000 * 0.43 / 1000)); // 1458
  assert.strictEqual(c.eqSum, 1500000);
  assert.strictEqual(c.eqPremium, 1350);
  assert.strictEqual(c.movableAutoSum, 800000);
  assert.strictEqual(c.totalPremium, 1458 + 1350);
});

test('地震保額不足 150 萬按比例', () => {
  const c = P.calculate(ref, { zip: '970', totalFloors: 1, areaPing: 20, structureCode: '02', roofCode: '01', gradeCode: '1', buildingSumWan: 124, periodMonths: 12 });
  // 本體造價 61,800 × 20 = 1,236,000 → 124 萬
  assert.strictEqual(c.eqSum, 1240000);
  assert.strictEqual(c.eqPremium, Math.round(1350 * 1240000 / 1500000)); // 1116
});

test('短期費率：6 個月', () => {
  const c = P.calculate(ref, { gradeCode: '1', buildingSumWan: 150, periodMonths: 6 });
  assert.strictEqual(c.detail.fireShortPct, 65);
  assert.strictEqual(c.detail.eqShortPct, 56);
});

test('保險月數計算', () => {
  assert.strictEqual(P.monthsBetween('2026-11-13', '2027-11-13'), 12);
  assert.strictEqual(P.monthsBetween('2026-11-13', '2027-05-13'), 6);
  assert.strictEqual(P.monthsBetween('2026-11-13', '2027-05-14'), 7);
  assert.strictEqual(P.monthsBetween('2026-11-13', '2026-11-20'), 1);
});
