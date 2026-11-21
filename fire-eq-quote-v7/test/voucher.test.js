const test = require('node:test');
const assert = require('node:assert');
const V = require('../src/voucher');

const gl = V.DEFAULT_GL;
const row = (id, ipolicy1, amt, day, paid) => ({ id, ipolicy1, nassured: '王小明', mprem: amt, mprem_nt: amt, dplyend: day, dpay: paid ? day : null, frcvpay: paid ? 'P' : 'N' });

test('營業稅內含：保費 × 5% ÷ 1.05', () => {
  assert.deepStrictEqual(V.splitTax(27345, 0.05), { tax: 1302, net: 26043 });
  assert.deepStrictEqual(V.splitTax(1448, 0), { tax: 0, net: 1448 });
});

test('出單立帳＋收費沖銷：每天各一張、借貸平衡、強制險不列營業稅', () => {
  const rows = [row(1, 'PF11511160001', 4053, '2026-11-16', false), row(2, 'CC11511190001', 1448, '2026-11-19', true), row(3, 'AC11511190001', 27345, '2026-11-19', true)];
  const r = V.buildVouchers(rows, rows.filter((x) => x.frcvpay === 'P'), gl);
  assert.strictEqual(r.skipped.length, 0);
  assert.deepStrictEqual(r.vouchers.map((v) => [v.vdate, v.vtype, v.totalDr]),
    [['2026-11-16', 'ISSUE', 4053], ['2026-11-19', 'ISSUE', 28793], ['2026-11-19', 'RECEIPT', 28793]]);
  for (const v of r.vouchers) assert.strictEqual(v.totalDr, v.totalCr);
  const iss = r.vouchers[1].lines;
  assert.strictEqual(iss.find((l) => l.account_code === '4121').cr, 1448);
  assert.strictEqual(iss.find((l) => l.account_code === '4122').cr, 26043);
  assert.strictEqual(iss.find((l) => l.account_code === '2131').cr, 1302);
  assert.strictEqual(r.vouchers[2].lines[0].account_code, '1113');
});

test('未設定字軌的帳款略過並列出原因', () => {
  const r = V.buildVouchers([row(9, 'XX11511190001', 100, '2026-11-19')], [], gl);
  assert.strictEqual(r.vouchers.length, 0);
  assert.match(r.skipped[0].reason, /XX/);
});
