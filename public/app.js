/* 住宅火災及地震基本保險 報價系統 — 前端 */
(() => {
  const $ = (id) => document.getElementById(id);
  let REF = null;

  // ── 小工具 ───────────────────────────────────────
  const fmt = (n) => Number(n || 0).toLocaleString('zh-TW');
  const wan = (n) => fmt(Math.round(Number(n || 0) / 10000));
  const num = (id) => Number($(id).value || 0);

  function msg(text, ok = true) {
    const m = $('msg');
    m.textContent = text || '';
    m.className = 'msg ' + (text ? (ok ? 'ok' : 'err') : '');
  }

  async function api(path, body) {
    const res = await fetch(path, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function fillSelect(sel, items, valueKey, labelFn, selected) {
    sel.innerHTML = items.map((it) => `<option value="${it[valueKey]}">${labelFn(it)}</option>`).join('');
    if (selected !== undefined) sel.value = selected;
  }

  // 民國日期 <-> ISO
  const toISO = (y, m, d) => (y && m && d ? `${Number(y) + 1911}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null);
  function setRoc(prefix, iso) {
    if (!iso) return;
    const d = new Date(iso);
    $(prefix + 'Y').value = d.getFullYear() - 1911;
    $(prefix + 'M').value = d.getMonth() + 1;
    $(prefix + 'D').value = d.getDate();
  }
  function monthsBetween(s, e) {
    const a = new Date(s); const b = new Date(e);
    if (!s || !e || isNaN(a) || isNaN(b) || b <= a) return 0;
    let m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
    if (b.getDate() > a.getDate()) m += 1;
    return Math.max(1, Math.min(12, m));
  }

  // 台灣身分證 / 居留證 / 統編檢核
  function validId(v) {
    v = String(v || '').toUpperCase();
    if (/^\d{8}$/.test(v)) { // 統一編號
      const w = [1, 2, 1, 2, 1, 2, 4, 1];
      let sum = 0;
      for (let i = 0; i < 8; i++) { const p = Number(v[i]) * w[i]; sum += Math.floor(p / 10) + (p % 10); }
      return sum % 5 === 0 || (v[6] === '7' && (sum + 1) % 5 === 0);
    }
    if (!/^[A-Z][12890A-D]\d{8}$/.test(v)) return false;
    const letters = 'ABCDEFGHJKLMNPQRSTUVXYWZIO';
    const code = letters.indexOf(v[0]) + 10;
    const second = /[A-D]/.test(v[1]) ? (letters.indexOf(v[1]) + 10) % 10 : Number(v[1]);
    const digits = [Math.floor(code / 10), code % 10, second, ...v.slice(2).split('').map(Number)];
    const w = [1, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1];
    return digits.reduce((s, d, i) => s + d * w[i], 0) % 10 === 0;
  }

  // ── 初始化 ───────────────────────────────────────
  async function init() {
    const [ref, health] = await Promise.all([api('/api/refdata'), api('/api/health')]);
    REF = ref;
    const badge = $('dbBadge');
    badge.textContent = health.db === 'neon' ? 'Neon DB' : '記憶體模式';
    badge.className = 'badge ' + health.db;

    const zipLabel = (z) => `${z.zip}:${z.county}${z.district}`;
    document.querySelectorAll('.zip-select').forEach((s) => fillSelect(s, ref.zips, 'zip', zipLabel, '100'));
    fillSelect($('structureCode'), ref.structures, 'code', (s) => `${s.code}:${s.name}`, '02');
    fillSelect($('roofCode'), ref.roofs, 'code', (s) => `${s.code}:${s.name}`, '01');
    fillSelect($('gradeCode'), ref.grades, 'code', (g) => `${g.code}:${g.name}`, '1');
    fillSelect($('decorationPerPing'), ref.settings.decoration_options.split(',').map((v) => ({ v })), 'v', (o) => fmt(o.v), '0');
    document.querySelectorAll('select.nat').forEach((s) => fillSelect(s, ref.nationalities, 'code', (n) => `${n.code}:${n.name}`, '158'));
    fillSelect($('bankPicker'), [{ code: '', name: '— 請選擇銀行 —' }, ...ref.banks], 'code', (b) => (b.code ? `${b.code} ${b.name}` : b.name));
    $('rGlass').textContent = ref.settings.glass_limit_text;

    defaultPeriod();
    updateRegionHint();
    bind();
  }

  function defaultPeriod() {
    const now = new Date(Date.now() + 8 * 3600e3);
    const s = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const e = new Date(s); e.setUTCFullYear(e.getUTCFullYear() + 1);
    setRoc('s', s.toISOString().slice(0, 10));
    setRoc('e', e.toISOString().slice(0, 10));
    updateMonths();
  }

  function periodISO() {
    return { start: toISO($('sY').value, $('sM').value, $('sD').value), end: toISO($('eY').value, $('eM').value, $('eD').value) };
  }
  function updateMonths() {
    const { start, end } = periodISO();
    $('periodMonths').value = monthsBetween(start, end) || '';
  }

  function updateRegionHint() {
    const z = REF.zips.find((x) => x.zip === $('locationZip').value);
    $('regionHint').textContent = z ? `造價表第 ${z.cost_region} 區` : '';
  }

  function suggestGradeLocal() {
    const s = REF.structures.find((x) => x.code === $('structureCode').value);
    const r = REF.roofs.find((x) => x.code === $('roofCode').value);
    if (!s) return;
    const g = String(Math.min(5, Number(s.default_grade) + Number(r?.grade_shift || 0)));
    $('gradeCode').value = g;
    $('gradeHint').textContent = '(依構造建議，可人工調整)';
  }

  // ── 表單 <-> 物件 ─────────────────────────────────
  function readPerson(who) {
    const box = document.querySelector(`table[data-who="${who}"]`);
    const o = {};
    box.querySelectorAll('[data-f]').forEach((el) => { o[el.dataset.f] = el.value.trim(); });
    o.pep = box.querySelector(`input[name="${who}_pep"]:checked`).value;
    o.job = box.querySelector(`input[name="${who}_job"]:checked`).value;
    return o;
  }
  function writePerson(who, o = {}) {
    const box = document.querySelector(`table[data-who="${who}"]`);
    box.querySelectorAll('[data-f]').forEach((el) => {
      if (o[el.dataset.f] !== undefined) el.value = o[el.dataset.f];
    });
    if (o.pep) box.querySelector(`input[name="${who}_pep"][value="${o.pep}"]`).checked = true;
    if (o.job) box.querySelector(`input[name="${who}_job"][value="${o.job}"]`).checked = true;
  }

  function collect() {
    const { start, end } = periodISO();
    return {
      quoteNo: $('quoteNo').value || null,
      prevQuoteNo: $('prevQuoteNo').value || null,
      locationZip: $('locationZip').value,
      totalFloors: num('totalFloors') || null,
      areaPing: num('areaPing') || null,
      buildYear: num('buildYear') || null,
      structureCode: $('structureCode').value,
      roofCode: $('roofCode').value,
      gradeCode: $('gradeCode').value,
      decorationPerPing: num('decorationPerPing'),
      buildingSumWan: num('buildingSumWan'),
      movableAddWan: num('movableAddWan'),
      insured: readPerson('insured'),
      applicant: readPerson('applicant'),
      propertyZip: $('propertyZip').value,
      propertyAddr: $('propertyAddr').value.trim(),
      mailZip: $('mailZip').value,
      mailAddr: $('mailAddr').value.trim(),
      eDoc: $('eDoc').checked,
      periodStart: start,
      periodEnd: end,
      mortgageeBank: $('mortgageeBank').value.trim(),
      mortgageeName: $('mortgageeName').value.trim(),
    };
  }

  function renderCalc(c) {
    $('rBuilding').textContent = wan(c.buildingSum);
    $('rMovableAdd').textContent = wan(c.movableAddSum);
    $('rMovableAuto').textContent = wan(c.movableAutoSum);
    $('rEq').textContent = wan(c.eqSum);
    $('rFire').textContent = fmt(c.firePremium);
    $('rEqPrem').textContent = fmt(c.eqPremium);
    $('rTotal').textContent = fmt(c.totalPremium);
    const d = c.detail;
    $('calcDetail').innerHTML =
      `火險：${d.gradeName} 費率 ${d.fireRatePerMille}‰${d.fireRateFactor !== 1 ? `（係數 ${d.fireRateFactor}）` : ''}，` +
      `全年 ${fmt(d.fireAnnual)} 元 × 短期 ${d.fireShortPct}%<br>` +
      `地震：保額依${d.eqBasis}（上限 150 萬），全年 ${fmt(d.eqAnnual)} 元 × 短期 ${d.eqShortPct}%　保險期間 ${d.periodMonths} 個月`;
  }
  function clearCalc() {
    ['rBuilding', 'rMovableAdd', 'rMovableAuto', 'rEq', 'rFire', 'rEqPrem', 'rTotal'].forEach((id) => { $(id).textContent = '0'; });
    $('calcDetail').textContent = '';
  }

  async function withBusy(btn, fn) {
    btn.disabled = true;
    try { await fn(); } catch (e) { msg(e.message, false); } finally { btn.disabled = false; }
  }

  // ── 事件 ─────────────────────────────────────────
  function bind() {
    $('locationZip').addEventListener('change', () => {
      updateRegionHint();
      $('propertyZip').value = $('locationZip').value;
    });
    $('structureCode').addEventListener('change', suggestGradeLocal);
    $('roofCode').addEventListener('change', suggestGradeLocal);
    $('gradeCode').addEventListener('change', () => { $('gradeHint').textContent = ''; });

    // 坪 ⇄ 平方公尺
    const ratio = Number(REF.settings.ping_to_m2) || 3.30579;
    $('btnConvert').addEventListener('click', () => {
      if (num('areaPing') > 0) $('areaM2').value = (num('areaPing') * ratio).toFixed(2);
      else if (num('areaM2') > 0) $('areaPing').value = (num('areaM2') / ratio).toFixed(2);
    });
    $('areaM2').addEventListener('change', () => { if (num('areaM2') > 0) $('areaPing').value = (num('areaM2') / ratio).toFixed(2); });

    $('btnSuggest').addEventListener('click', () => withBusy($('btnSuggest'), async () => {
      msg('');
      const s = await api('/api/suggest', collect());
      $('buildingSumWan').value = s.suggestedBuildingWan;
      if (s.suggestedGrade) $('gradeCode').value = s.suggestedGrade;
      const c = await api('/api/calc', collect());
      renderCalc(c);
      msg(`建議保額 ${fmt(s.suggestedBuildingWan)} 萬元＝本體 ${fmt(s.bodyCost)}（${s.basis}）＋裝潢 ${fmt(s.decoration)}`);
    }));

    $('btnCalc').addEventListener('click', () => withBusy($('btnCalc'), async () => {
      msg('');
      renderCalc(await api('/api/calc', collect()));
    }));

    $('btnSameInsured').addEventListener('click', () => {
      const o = readPerson('insured');
      delete o.relation;
      writePerson('applicant', o);
      document.querySelector('table[data-who="insured"] [data-f="relation"]').value = '本人';
    });
    $('btnSameAddr').addEventListener('click', () => {
      $('mailZip').value = $('propertyZip').value;
      $('mailAddr').value = $('propertyAddr').value;
    });

    ['sY', 'sM', 'sD', 'eY', 'eM', 'eD'].forEach((id) => $(id).addEventListener('input', updateMonths));
    // 起日變動 → 自動帶一年後迄日
    ['sY', 'sM', 'sD'].forEach((id) => $(id).addEventListener('change', () => {
      const { start } = periodISO();
      if (!start) return;
      const d = new Date(start); d.setFullYear(d.getFullYear() + 1);
      setRoc('e', d.toISOString().slice(0, 10));
      updateMonths();
    }));

    // 抵押權人
    $('btnBank').addEventListener('click', () => $('bankPicker').classList.toggle('hidden'));
    $('bankPicker').addEventListener('change', () => {
      const b = REF.banks.find((x) => x.code === $('bankPicker').value);
      if (b) { $('mortgageeBank').value = b.code; $('mortgageeName').value = b.name; }
      $('bankPicker').classList.add('hidden');
    });
    $('mortgageeBank').addEventListener('change', () => {
      const b = REF.banks.find((x) => x.code === $('mortgageeBank').value.trim());
      if (b) $('mortgageeName').value = b.name;
    });

    // 身分證檢核
    document.querySelectorAll('[data-f="id_no"]').forEach((el) => el.addEventListener('blur', () => {
      el.value = el.value.toUpperCase();
      el.classList.toggle('invalid', Boolean(el.value) && !validId(el.value));
    }));

    $('btnLoadPrev').addEventListener('click', () => withBusy($('btnLoadPrev'), loadPrevious));
    $('btnSave').addEventListener('click', () => withBusy($('btnSave'), save));
    $('btnNew').addEventListener('click', () => {
      if (!confirm('確定清除畫面所有資料？')) return;
      $('f').reset();
      ['quoteNo', 'prevQuoteNo'].forEach((id) => { $(id).value = ''; });
      document.querySelectorAll('.zip-select').forEach((s) => { s.value = '100'; });
      $('structureCode').value = '02'; $('roofCode').value = '01'; $('gradeCode').value = '1';
      document.querySelectorAll('select.nat').forEach((s) => { s.value = '158'; });
      clearCalc(); defaultPeriod(); updateRegionHint(); msg('');
    });
  }

  // ── 載入前期 / 儲存 ───────────────────────────────
  function fillFromQuote(q, asRenewal) {
    $('quoteNo').value = asRenewal ? '' : q.quote_no;
    $('prevQuoteNo').value = asRenewal ? q.quote_no : (q.prev_quote_no || '');
    $('locationZip').value = q.location_zip || '100';
    $('totalFloors').value = q.total_floors || '';
    $('areaPing').value = q.area_ping ? Number(q.area_ping) : '';
    $('buildYear').value = q.build_year || '';
    $('structureCode').value = q.structure_code || '02';
    $('roofCode').value = q.roof_code || '01';
    $('gradeCode').value = q.grade_code || '1';
    $('decorationPerPing').value = String(q.decoration_per_ping || 0);
    $('buildingSumWan').value = Math.round(Number(q.building_sum || 0) / 10000);
    $('movableAddWan').value = Math.round(Number(q.movable_add_sum || 0) / 10000);
    writePerson('insured', q.insured || {});
    writePerson('applicant', q.applicant || {});
    $('propertyZip').value = q.property_zip || q.location_zip || '100';
    $('propertyAddr').value = q.property_addr || '';
    $('mailZip').value = q.mail_zip || '100';
    $('mailAddr').value = q.mail_addr || '';
    $('mortgageeBank').value = q.mortgagee_bank || '';
    $('mortgageeName').value = q.mortgagee_name || '';
    if (asRenewal && q.period_end) {
      // 續保：新期間由前期迄日起算一年
      const s = new Date(q.period_end);
      const e = new Date(s); e.setFullYear(e.getFullYear() + 1);
      setRoc('s', s.toISOString().slice(0, 10));
      setRoc('e', e.toISOString().slice(0, 10));
    } else {
      setRoc('s', q.period_start); setRoc('e', q.period_end);
    }
    updateMonths(); updateRegionHint();
  }

  async function loadPrevious() {
    const key = $('loadKey').value.trim();
    if (!key) throw new Error('請輸入前期要保號碼或身分證統編');
    const q = await api('/api/quotes?q=' + encodeURIComponent(key));
    fillFromQuote(q, true);
    renderCalc(await api('/api/calc', collect()));
    msg(`已載入前期資料 ${q.quote_no}，保險期間已順延一年，請確認後儲存`);
  }

  async function save() {
    const d = collect();
    if (!validId(d.insured.id_no)) throw new Error('被保險人身分證統編檢核錯誤');
    if (d.applicant.id_no && !validId(d.applicant.id_no)) throw new Error('要保人身分證統編檢核錯誤');
    if (d.insured.birthday && !/^\d{7}$/.test(d.insured.birthday)) throw new Error('生日格式應為 CYYMMDD，例：0750315');
    const r = await api('/api/quotes', d);
    $('quoteNo').value = r.quote.quote_no;
    renderCalc(r.calc);
    msg(`已儲存，要保號碼 ${r.quote.quote_no}，總保費 ${fmt(r.calc.totalPremium)} 元`);
  }

  init().catch((e) => msg('初始化失敗：' + e.message, false));
})();
