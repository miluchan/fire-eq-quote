const test = require('node:test');
const assert = require('node:assert');
const R = require('../src/refdata');
const P = require('../src/premium');

delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
let ref;
test.before(async () => { ref = P.buildRef(await require('../src/db').loadRefData()); });

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

// ── 居家綜合保險：對照參考系統截圖（臺北市中正區、7 層、40 坪、RC、特二） ──
const base = { zip: '100', totalFloors: 7, areaPing: 40, structureCode: '02', roofCode: '01', periodMonths: 12 };
const ALL = { PA: { on: true, value: '100/400' }, LEQ: { on: true, value: '5' }, PET: { on: true, value: '1' },
  RFL: { on: true, value: '100' }, CON: { on: true, value: '1/10' }, HSK: { on: true, value: '0.2' }, GRN: { on: true } };
const prem = (c, code) => c.lines.find((l) => l.code === code).premium;

test('A式 500 萬全附加險 = 2,035（已投保地震）', () => {
  const c = P.calcAny(ref, { ...base, planCode: 'HA', propSumWan: 500, eqAlready: true, coverages: ALL });
  assert.deepStrictEqual([prem(c, 'PROP'), prem(c, 'PA'), prem(c, 'PET'), prem(c, 'GRN')], [1195, 283, 31, 135]);
  assert.strictEqual(c.totalPremium, 2035);
  assert.strictEqual(c.eqPremium, 0);
});

test('B式 500 萬全附加險 = 2,703', () => {
  const c = P.calcAny(ref, { ...base, planCode: 'HB', propSumWan: 500, eqAlready: true, coverages: ALL });
  assert.deepStrictEqual([prem(c, 'PROP'), prem(c, 'PA'), prem(c, 'PET'), prem(c, 'GRN')], [1874, 311, 47, 80]);
  assert.strictEqual(c.totalPremium, 2703);
});

test('C式 500 萬全附加險 = 4,281', () => {
  const c = P.calcAny(ref, { ...base, planCode: 'HC', propSumWan: 500, eqAlready: true, coverages: ALL });
  assert.deepStrictEqual([prem(c, 'PROP'), prem(c, 'PET'), prem(c, 'RFL'), prem(c, 'CON'), prem(c, 'HSK')], [3368, 76, 315, 1, 41]);
  assert.strictEqual(c.totalPremium, 4281);
});

test('B式 300 萬＋傷害/輕損/寵物＋基本地震 = 3,398（第一張截圖）', () => {
  const c = P.calcAny(ref, { ...base, planCode: 'HB', propSumWan: 300, eqAlready: false,
    coverages: { PA: { on: true, value: '100/400' }, LEQ: { on: true, value: '5' }, PET: { on: true, value: '1' } } });
  assert.strictEqual(prem(c, 'PROP'), 1656);
  assert.strictEqual(c.eqPremium, 1350);
  assert.strictEqual(c.homePremium, 2048);
  assert.strictEqual(c.totalPremium, 3398);
});

test('綠能升級保額跟財損保額、第三人責任必含', () => {
  const c = P.calcAny(ref, { ...base, planCode: 'HA', propSumWan: 400, eqAlready: true, coverages: { GRN: { on: true, value: '999' } } });
  assert.strictEqual(c.lines.find((l) => l.code === 'GRN').sumText, '400 萬元');
  assert.strictEqual(prem(c, 'GRN'), 108); // 4,000,000 × 0.027‰
  assert.strictEqual(c.lines.find((l) => l.code === 'TPL').includedText, '含於財物損害保險內');
});

test('住火方案 calcAny 回傳三列', () => {
  const c = P.calcAny(ref, { ...base, planCode: 'HF', gradeCode: '1', buildingSumWan: 398 });
  assert.deepStrictEqual(c.lines.map((l) => l.code), ['FIRE', 'GLASS', 'EQ']);
  assert.strictEqual(c.homePremium, 0);
  assert.strictEqual(c.totalPremium, c.firePremium + c.eqPremium);
});
