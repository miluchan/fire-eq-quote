/**
 * 住宅火災及地震基本保險 — 保費計算引擎（純函式，不碰資料庫）
 *
 * 計算邏輯
 * 1. 建築物本體造價 = 每坪單價 × 權狀面積(坪，含公設)
 *      每坪單價 = 造價表(地區別, 總樓層數) × 構造乘數（鋼骨 +16%）
 *               或 固定單價（磚、木、石、金屬構造 34,000 元/坪）
 * 2. 裝潢總價 = 每坪裝潢單價 × 面積
 * 3. 重置成本（建議不動產保額）= 本體造價 + 裝潢總價（無條件進位至萬元）
 * 4. 自動附加動產 = min(不動產保額 × 30%, 80 萬)（免費附加，不計保費）
 * 5. 住宅火險保費 = (不動產保額 + 加保動產) × 費率(‰,依建築等級) × 公司費率係數 ÷ 1000 × 短期費率%
 * 6. 基本地震保額 = min(建築物本體造價, 150 萬)；未填面積時以不動產保額代替
 *    基本地震保費 = 1,350 × 地震保額 ÷ 150 萬 × 地震短期費率%
 */

const WAN = 10000;

function round(n) {
  return Math.round(n + Number.EPSILON);
}

/** 建立查詢索引（refdata 或資料庫查詢結果皆可） */
function buildRef(raw) {
  const settings = {};
  for (const [k, v] of Object.entries(raw.settings)) {
    const n = Number(v);
    settings[k] = Number.isFinite(n) && String(v).trim() !== '' && !String(v).includes(',') ? n : v;
  }
  return {
    zips: new Map(raw.zips.map((z) => [z.zip, z])),
    costs: raw.costs, // [{floor_min, floor_max, cost_region, price_per_ping, version}]
    structures: new Map(raw.structures.map((s) => [s.code, s])),
    roofs: new Map(raw.roofs.map((r) => [r.code, r])),
    grades: new Map(raw.grades.map((g) => [g.code, g])),
    shortRates: raw.shortRates, // [{product, months, pct}]
    settings,
  };
}

/** 民國/西元日期間的保險月數（不滿一個月以一個月計，最多 12） */
function monthsBetween(start, end) {
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e <= s) return 0;
  let months = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth());
  if (e.getDate() > s.getDate()) months += 1;
  return Math.max(1, Math.min(12, months));
}

function shortPct(ref, product, months) {
  if (!months || months >= 12) return 100;
  const list = ref.shortRates
    .filter((r) => r.product === product)
    .sort((a, b) => a.months - b.months);
  const hit = list.find((r) => months <= Number(r.months));
  return hit ? Number(hit.pct) : 100;
}

/** 建議建築等級：外牆建議等級 + 屋頂調降級數（最多到三等） */
function suggestGrade(ref, structureCode, roofCode) {
  const s = ref.structures.get(structureCode);
  if (!s) return null;
  const shift = Number(ref.roofs.get(roofCode)?.grade_shift || 0);
  return String(Math.min(5, Number(s.default_grade) + shift));
}

function unitPricePerPing(ref, { zip, totalFloors, structureCode }) {
  const s = ref.structures.get(structureCode);
  if (!s) throw new Error('建築物結構代碼不存在');
  if (s.flat_price) return { unit: Number(s.flat_price), basis: `${s.name}構造固定單價`, version: null };

  const z = ref.zips.get(zip);
  if (!z) throw new Error('標的物所在地郵遞區號不存在');
  const floors = Number(totalFloors);
  if (!floors || floors < 1) throw new Error('請輸入總樓層數');
  const row = ref.costs.find(
    (c) => Number(c.cost_region) === Number(z.cost_region) && floors >= Number(c.floor_min) && floors <= Number(c.floor_max),
  );
  if (!row) throw new Error('造價表查無對應樓層');
  const factor = Number(s.cost_factor || 1);
  return {
    unit: round(Number(row.price_per_ping) * factor),
    basis: `造價表第${z.cost_region}區 ${row.floor_min}${row.floor_max !== row.floor_min ? '~' + (row.floor_max >= 999 ? '' : row.floor_max) : ''}層 ${Number(row.price_per_ping).toLocaleString()}元/坪${factor !== 1 ? ` ×${factor}` : ''}`,
    version: row.version,
  };
}

/** 建議保額（重置成本） */
function suggest(ref, input) {
  const area = Number(input.areaPing);
  if (!area || area <= 0) throw new Error('請輸入權狀面積（坪）');
  const { unit, basis, version } = unitPricePerPing(ref, input);
  const bodyCost = round(unit * area);
  const decoration = round(Number(input.decorationPerPing || 0) * area);
  const replacement = bodyCost + decoration;
  return {
    unitPrice: unit,
    basis,
    costVersion: version,
    bodyCost,
    decoration,
    replacement,
    suggestedBuildingWan: Math.ceil(replacement / WAN),
    suggestedGrade: suggestGrade(ref, input.structureCode, input.roofCode),
  };
}

/** 保費計算 */
function calculate(ref, input) {
  const st = ref.settings;
  const building = round(Number(input.buildingSumWan || 0) * WAN);
  const movableAdd = round(Number(input.movableAddWan || 0) * WAN);
  if (building <= 0 && movableAdd <= 0) throw new Error('請輸入不動產保額或按「建議保額」');

  const grade = ref.grades.get(String(input.gradeCode));
  if (!grade) throw new Error('請選擇建築等級');

  const months = Number(input.periodMonths) || 12;
  const fireShort = shortPct(ref, 'FIRE', months);
  const eqShort = shortPct(ref, 'EQ', months);

  // 自動附加動產（不計保費）
  const movableAuto = Math.min(round(building * Number(st.movable_auto_pct)), Number(st.movable_auto_max));

  // 住宅火災保險
  const fireRate = Number(grade.fire_rate) * Number(st.fire_rate_factor || 1);
  const fireAnnual = ((building + movableAdd) * fireRate) / 1000;
  const firePremium = round((fireAnnual * fireShort) / 100);

  // 基本地震保險（只保建築物，不含動產）
  let eqBase = building;
  let eqBasis = '不動產保額';
  if (Number(input.areaPing) > 0 && input.structureCode && input.zip) {
    try {
      eqBase = suggest(ref, input).bodyCost;
      eqBasis = '建築物本體造價';
    } catch (_) { /* 資料不足時沿用不動產保額 */ }
  }
  const eqSum = building > 0 ? Math.min(Math.round(eqBase / WAN) * WAN, Number(st.eq_max_sum)) : 0;
  const eqAnnual = (Number(st.eq_annual_premium) * eqSum) / Number(st.eq_max_sum);
  const eqPremium = round((eqAnnual * eqShort) / 100);

  return {
    buildingSum: building,
    movableAutoSum: movableAuto,
    movableAddSum: movableAdd,
    eqSum,
    glassLimit: st.glass_limit_text,
    firePremium,
    eqPremium,
    totalPremium: firePremium + eqPremium,
    detail: {
      gradeName: grade.name,
      fireRatePerMille: Number(fireRate.toFixed(4)),
      fireRateFactor: Number(st.fire_rate_factor || 1),
      fireAnnual: round(fireAnnual),
      eqBasis,
      eqAnnual: round(eqAnnual),
      periodMonths: months,
      fireShortPct: fireShort,
      eqShortPct: eqShort,
    },
  };
}

module.exports = { buildRef, monthsBetween, shortPct, suggestGrade, suggest, calculate, unitPricePerPing };
