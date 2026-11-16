/* 住火地震暨居家綜合保險 報價系統 — 前端 */
(() => {
  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  let REF = null;
  let lastCalc = null;
  let current = null; // 目前載入的報價單（DB 資料）
  let mode = 'new';   // new / edit / view

  // ── 小工具 ───────────────────────────────────────
  const fmt = (n) => Number(n || 0).toLocaleString('zh-TW');
  const num = (id) => Number($(id).value || 0);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function msg(text, ok = true) {
    const m = $('msg');
    m.textContent = text || '';
    m.className = 'msg ' + (text ? (ok ? 'ok' : 'err') : '');
  }

  async function api(path, body, method) {
    const opt = body === undefined ? { method: method || 'GET' } : {
      method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    };
    const res = await fetch(path, opt);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function fillSelect(sel, items, valueKey, labelFn, selected) {
    sel.innerHTML = items.map((it) => `<option value="${esc(it[valueKey])}">${esc(labelFn(it))}</option>`).join('');
    if (selected !== undefined) sel.value = selected;
  }

  // 民國日期
  const toISO = (y, m, d) => (y && m && d ? `${Number(y) + 1911}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null);
  function setRoc(prefix, iso) {
    if (!iso) return;
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    $(prefix + 'Y').value = y - 1911;
    $(prefix + 'M').value = m;
    $(prefix + 'D').value = d;
  }
  function rocText(iso) {
    if (!iso) return '';
    const [y, m, d] = String(iso).slice(0, 10).split('-');
    return `${Number(y) - 1911}/${m}/${d}`;
  }
  function addYear(iso) {
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    return `${y + 1}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
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
    if (/^\d{8}$/.test(v)) {
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

  const planOf = (code) => REF.plans.find((p) => p.code === code);
  const isHome = () => planOf($('planCode').value)?.kind === 'HOME';
  const covOptions = (code) => REF.coverageOptions.filter((o) => o.coverage_code === code).sort((a, b) => a.sort - b.sort);
  const defaultOpt = (code) => (covOptions(code).find((o) => o.is_default) || covOptions(code)[0] || {}).value;

  // ── 初始化 ───────────────────────────────────────
  async function init() {
    const [ref, health] = await Promise.all([api('/api/refdata'), api('/api/health')]);
    REF = ref;
    const badge = $('dbBadge');
    badge.textContent = health.db === 'neon' ? 'Neon DB' : '記憶體模式';
    badge.className = 'badge ' + health.db;

    fillSelect($('planCode'), ref.plans, 'code', (p) => `${p.code}:${p.name}`, ref.plans[0]?.code);
    const zipLabel = (z) => `${z.zip}:${z.county}${z.district}`;
    $$('.zip-select').forEach((s) => fillSelect(s, ref.zips, 'zip', zipLabel, '100'));
    fillSelect($('structureCode'), ref.structures, 'code', (s) => `${s.code}:${s.name}`, '02');
    fillSelect($('roofCode'), ref.roofs, 'code', (s) => `${s.code}:${s.name}`, '01');
    fillSelect($('gradeCode'), ref.grades, 'code', (g) => `${g.code}:${g.name}`, '1');
    fillSelect($('decorationPerPing'), ref.settings.decoration_options.split(',').map((v) => ({ v })), 'v', (o) => fmt(o.v), '0');
    $$('select.nat').forEach((s) => fillSelect(s, ref.nationalities, 'code', (n) => `${n.code}:${n.name}`, '158'));
    fillSelect($('bankPicker'), [{ code: '', name: '— 請選擇銀行 —' }, ...ref.banks], 'code', (b) => (b.code ? `${b.code} ${b.name}` : b.name));
    fillSelect($('cov_TPL_value'), covOptions('TPL'), 'value', (o) => o.value, defaultOpt('TPL'));
    ref.status1.forEach((s) => $('qmS1').insertAdjacentHTML('beforeend', `<option>${esc(s)}</option>`));
    ref.status2.forEach((s) => $('qmS2').insertAdjacentHTML('beforeend', `<option>${esc(s)}</option>`));

    buildRiders();
    resetForm();
    bind();
  }

  /** 附加險列：依 coverages 資料表產生 */
  function buildRiders() {
    const rows = REF.coverages.filter((c) => !c.required).map((c) => {
      const right = c.calc === 'RATE_PROP'
        ? `<input id="cov_${c.code}_value" class="num w8 follow-prop" readonly tabindex="-1" title="保額跟隨財物損害保險保額"> 萬元`
        : `${c.sum_label ? `<span class="muted">${esc(c.sum_label)}</span> ` : ''}<select id="cov_${c.code}_value" class="w8"></select> 萬元`;
      return `<tr>
        <th class="rider-name"><label><input type="checkbox" id="cov_${c.code}_on"> ${esc(c.name)}</label></th>
        <td>${right}</td>
      </tr>`;
    });
    $('riderBody').innerHTML = rows.join('');
    REF.coverages.filter((c) => !c.required && c.calc === 'TABLE').forEach((c) => {
      fillSelect($(`cov_${c.code}_value`), covOptions(c.code), 'value', (o) => o.value, defaultOpt(c.code));
    });
  }

  function syncFollowProp() {
    $$('.follow-prop').forEach((el) => { el.value = $('propSumWan').value || 0; });
  }

  function resetRiders() {
    REF.coverages.filter((c) => !c.required).forEach((c) => {
      $(`cov_${c.code}_on`).checked = Boolean(c.default_on);
      if (c.calc === 'TABLE') $(`cov_${c.code}_value`).value = defaultOpt(c.code);
    });
    $('cov_TPL_value').value = defaultOpt('TPL');
    syncFollowProp();
  }

  function applyPlanVisibility() {
    const home = isHome();
    $$('.fire-only').forEach((el) => el.classList.toggle('hidden', home));
    $$('.home-only').forEach((el) => el.classList.toggle('hidden', !home));
  }

  function defaultPeriod() {
    const now = new Date(Date.now() + 8 * 3600e3);
    const s = now.toISOString().slice(0, 10);
    setRoc('s', s);
    setRoc('e', addYear(s));
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
    $('gradeCode').value = String(Math.min(5, Number(s.default_grade) + Number(r?.grade_shift || 0)));
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

  function readCoverages() {
    const out = { TPL: { on: true, value: $('cov_TPL_value').value } };
    REF.coverages.filter((c) => !c.required).forEach((c) => {
      out[c.code] = { on: $(`cov_${c.code}_on`).checked, value: c.calc === 'TABLE' ? $(`cov_${c.code}_value`).value : null };
    });
    return out;
  }
  function writeCoverages(sel) {
    resetRiders();
    REF.coverages.filter((c) => !c.required).forEach((c) => { $(`cov_${c.code}_on`).checked = false; });
    for (const [code, v] of Object.entries(sel || {})) {
      if (code === 'TPL') { if (v.value) $('cov_TPL_value').value = v.value; continue; }
      if (!$(`cov_${code}_on`)) continue;
      $(`cov_${code}_on`).checked = Boolean(v.on);
      if (v.value && $(`cov_${code}_value`).tagName === 'SELECT') $(`cov_${code}_value`).value = v.value;
    }
    syncFollowProp();
  }

  function collect() {
    const { start, end } = periodISO();
    return {
      quoteNo: $('quoteNo').value || null,
      prevQuoteNo: $('prevQuoteNo').value || null,
      planCode: $('planCode').value,
      locationZip: $('locationZip').value,
      totalFloors: num('totalFloors') || null,
      areaPing: num('areaPing') || null,
      buildYear: num('buildYear') || null,
      structureCode: $('structureCode').value,
      roofCode: $('roofCode').value,
      gradeCode: $('gradeCode').value,
      decorationPerPing: isHome() ? 0 : num('decorationPerPing'),
      buildingSumWan: num('buildingSumWan'),
      movableAddWan: num('movableAddWan'),
      propSumWan: num('propSumWan'),
      eqAlready: $('eqAlready').checked,
      coverages: readCoverages(),
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

  // ── 試算結果 ─────────────────────────────────────
  function renderCalc(c) {
    lastCalc = c;
    const n = c.lines.length;
    $('resultBody').innerHTML = c.lines.map((l, i) => `
      <tr>
        ${i === 0 ? `<th rowspan="${n}" class="target">${esc(c.targetName).replace('暨', '暨<br>')}</th>` : ''}
        <td>${esc(l.name)}</td>
        <td class="r">${esc(l.sumText)}${l.subText ? `<div class="muted small">${esc(l.subText)}</div>` : ''}</td>
        <td class="r">${l.includedText ? `<span class="note">${esc(l.includedText)}</span>` : `<b class="money">${fmt(l.premium)}</b> 元`}</td>
        ${i === 0 ? `<td rowspan="${n}" class="r total"><b class="money">${fmt(c.totalPremium)}</b> 元</td>` : ''}
      </tr>`).join('');
    const d = c.detail;
    $('calcDetail').innerHTML = c.kind === 'FIRE'
      ? `火險：${esc(d.gradeName)} 費率 ${d.fireRatePerMille}‰${d.fireRateFactor !== 1 ? `（係數 ${d.fireRateFactor}）` : ''}，全年 ${fmt(d.fireAnnual)} 元 × 短期 ${d.fireShortPct}%<br>`
        + `地震：保額依${esc(d.eqBasis)}（上限 150 萬），全年 ${fmt(d.eqAnnual)} 元 × 短期 ${d.eqShortPct}%　保險期間 ${d.periodMonths} 個月`
      : `${esc(d.planName)}：財損 ${d.propBaseFee ? `${fmt(d.propBaseFee)} 元 + ` : ''}保額 × ${d.propRate}‰，居家各險 × 短期 ${d.homeShortPct}%<br>`
        + (c.eqAlready ? '已投保住宅地震險，不另計基本地震保費' : `地震：保額依${esc(d.eqBasis)}（上限 150 萬）× 短期 ${d.eqShortPct}%`)
        + `　保險期間 ${d.periodMonths} 個月`;
  }
  function clearCalc() {
    lastCalc = null;
    $('resultBody').innerHTML = '<tr><td colspan="5" class="muted center">請按「建議保額」或「保費計算」</td></tr>';
    $('calcDetail').textContent = '';
  }

  // ── 狀態 / 模式 ───────────────────────────────────
  function renderStatus(q) {
    $('statusText').innerHTML = q
      ? `<span class="tag s1">${esc(q.status1)}</span><span class="tag s2">${esc(q.status2)}</span>`
      : '';
  }

  /** view：唯讀檢視（查詢或非報價中）；edit/new：可編輯 */
  function setMode(m, note) {
    mode = m;
    const ro = m === 'view';
    $$('#f input, #f select, #f button').forEach((el) => {
      if (['quoteNo', 'prevQuoteNo', 'periodMonths'].includes(el.id) || el.classList.contains('follow-prop')) return;
      el.disabled = ro;
    });
    $('btnSave').classList.toggle('hidden', ro);
    $('btnConfirm').classList.toggle('hidden', ro);
    const banner = $('modeBanner');
    banner.classList.toggle('hidden', !note);
    banner.textContent = note || '';
  }

  async function withBusy(btn, fn) {
    btn.disabled = true;
    try { await fn(); } catch (e) { msg(e.message, false); } finally { if (mode !== 'view' || !btn.closest('#f')) btn.disabled = false; }
  }

  function resetForm() {
    $('f').reset();
    current = null;
    ['quoteNo', 'prevQuoteNo', 'loadKey'].forEach((id) => { $(id).value = ''; });
    $('planCode').value = REF.plans[0]?.code;
    $$('.zip-select').forEach((s) => { s.value = '100'; });
    $('structureCode').value = '02'; $('roofCode').value = '01'; $('gradeCode').value = '1';
    $('decorationPerPing').value = '0';
    $$('select.nat').forEach((s) => { s.value = '158'; });
    $('gradeHint').textContent = '';
    resetRiders();
    applyPlanVisibility();
    clearCalc(); defaultPeriod(); updateRegionHint(); renderStatus(null);
    setMode('new');
    msg('');
  }

  // ── 事件 ─────────────────────────────────────────
  function bind() {
    $('planCode').addEventListener('change', () => { applyPlanVisibility(); clearCalc(); msg(''); });
    $('locationZip').addEventListener('change', () => {
      updateRegionHint();
      $('propertyZip').value = $('locationZip').value;
    });
    $('structureCode').addEventListener('change', suggestGradeLocal);
    $('roofCode').addEventListener('change', suggestGradeLocal);
    $('gradeCode').addEventListener('change', () => { $('gradeHint').textContent = ''; });
    $('propSumWan').addEventListener('input', syncFollowProp);

    const ratio = Number(REF.settings.ping_to_m2) || 3.30579;
    $('btnConvert').addEventListener('click', () => {
      if (num('areaPing') > 0) $('areaM2').value = (num('areaPing') * ratio).toFixed(2);
      else if (num('areaM2') > 0) $('areaPing').value = (num('areaM2') / ratio).toFixed(2);
    });
    $('areaM2').addEventListener('change', () => { if (num('areaM2') > 0) $('areaPing').value = (num('areaM2') / ratio).toFixed(2); });

    $('btnSuggest').addEventListener('click', () => withBusy($('btnSuggest'), async () => {
      msg('');
      const s = await api('/api/suggest', collect());
      if (isHome()) {
        $('propSumWan').value = s.suggestedBuildingWan;
        syncFollowProp();
      } else {
        $('buildingSumWan').value = s.suggestedBuildingWan;
        if (s.suggestedGrade) $('gradeCode').value = s.suggestedGrade;
      }
      renderCalc(await api('/api/calc', collect()));
      msg(`建議保額 ${fmt(s.suggestedBuildingWan)} 萬元＝本體 ${fmt(s.bodyCost)}（${s.basis}）${s.decoration ? `＋裝潢 ${fmt(s.decoration)}` : ''}`);
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
    ['sY', 'sM', 'sD'].forEach((id) => $(id).addEventListener('change', () => {
      const { start } = periodISO();
      if (!start) return;
      setRoc('e', addYear(start));
      updateMonths();
    }));

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

    $$('[data-f="id_no"]').forEach((el) => el.addEventListener('blur', () => {
      el.value = el.value.toUpperCase();
      el.classList.toggle('invalid', Boolean(el.value) && !validId(el.value));
    }));

    $('btnLoadPrev').addEventListener('click', () => withBusy($('btnLoadPrev'), loadPrevious));
    $('btnSave').addEventListener('click', () => withBusy($('btnSave'), () => save('save')));
    $('btnConfirm').addEventListener('click', () => withBusy($('btnConfirm'), () => save('confirm')));

    // 右上角
    $('btnClear').addEventListener('click', () => {
      if (!confirm('確定清除畫面所有資料？')) return;
      resetForm();
    });
    $('btnQuery').addEventListener('click', openQuery);
    $('btnPrint').addEventListener('click', printQuote);

    // 查詢視窗
    $('qmClose').addEventListener('click', closeQuery);
    $('queryModal').addEventListener('click', (e) => { if (e.target.id === 'queryModal') closeQuery(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('queryModal').classList.contains('hidden')) closeQuery(); });
    $('qmSearch').addEventListener('click', loadList);
    $('qmKw').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadList(); });
    $('qmS1').addEventListener('change', loadList);
    $('qmS2').addEventListener('change', loadList);
    $('qmBody').addEventListener('click', onListClick);
  }

  // ── 載入報價單到畫面 ─────────────────────────────
  function fillFromQuote(q, asRenewal) {
    $('quoteNo').value = asRenewal ? '' : q.quote_no;
    $('prevQuoteNo').value = asRenewal ? q.quote_no : (q.prev_quote_no || '');
    $('planCode').value = planOf(q.plan_code) ? q.plan_code : 'HF';
    applyPlanVisibility();
    $('locationZip').value = q.location_zip || '100';
    $('totalFloors').value = q.total_floors || '';
    $('areaPing').value = q.area_ping ? Number(q.area_ping) : '';
    $('areaM2').value = '';
    $('buildYear').value = q.build_year || '';
    $('structureCode').value = q.structure_code || '02';
    $('roofCode').value = q.roof_code || '01';
    $('gradeCode').value = q.grade_code || '1';
    $('decorationPerPing').value = String(q.decoration_per_ping || 0);
    $('buildingSumWan').value = Math.round(Number(q.building_sum || 0) / 10000);
    $('movableAddWan').value = Math.round(Number(q.movable_add_sum || 0) / 10000);
    $('propSumWan').value = Math.round(Number(q.prop_sum || 0) / 10000);
    $('eqAlready').checked = Boolean(q.eq_already);
    writeCoverages(q.coverages);
    writePerson('insured', q.insured || {});
    writePerson('applicant', q.applicant || {});
    $('propertyZip').value = q.property_zip || q.location_zip || '100';
    $('propertyAddr').value = q.property_addr || '';
    $('mailZip').value = q.mail_zip || '100';
    $('mailAddr').value = q.mail_addr || '';
    $('mortgageeBank').value = q.mortgagee_bank || '';
    $('mortgageeName').value = q.mortgagee_name || '';
    if (asRenewal && q.period_end) {
      setRoc('s', q.period_end);
      setRoc('e', addYear(q.period_end));
    } else {
      setRoc('s', q.period_start); setRoc('e', q.period_end);
    }
    updateMonths(); updateRegionHint();
    $('gradeHint').textContent = '';
  }

  async function loadPrevious() {
    const key = $('loadKey').value.trim();
    if (!key) throw new Error('請輸入前期報價單號或身分證統編');
    const q = await api('/api/quotes?q=' + encodeURIComponent(key));
    fillFromQuote(q, true);
    current = null;
    renderStatus(null);
    setMode('new');
    renderCalc(await api('/api/calc', collect()));
    msg(`已載入前期資料 ${q.quote_no}，保險期間已順延一年，請確認後儲存`);
  }

  async function openQuote(no, wantEdit) {
    const q = await api('/api/quotes?no=' + encodeURIComponent(no));
    fillFromQuote(q, false);
    current = q;
    renderStatus(q);
    const editable = wantEdit && q.status1 === '報價中';
    setMode(editable ? 'edit' : 'view',
      editable ? '' : `檢視模式：報價單 ${q.quote_no}（${q.status1}／${q.status2}）${q.status1 !== '報價中' ? '，已非報價中，不可修改' : ''}。按右上「清除畫面」可開新報價。`);
    try { renderCalc(await api('/api/calc', collect())); } catch (e) { clearCalc(); }
    msg(editable ? `已載入報價單 ${q.quote_no}，可修改後儲存` : '');
  }

  async function save(action) {
    const d = collect();
    if (action === 'confirm') {
      if (!d.insured.name) throw new Error('請填寫被保險人姓名');
      if (!validId(d.insured.id_no)) throw new Error('被保險人身分證統編檢核錯誤');
      if (!d.applicant.name) throw new Error('請填寫要保人姓名');
      if (!validId(d.applicant.id_no)) throw new Error('要保人身分證統編檢核錯誤');
      for (const who of ['insured', 'applicant']) {
        if (d[who].birthday && !/^\d{7}$/.test(d[who].birthday)) throw new Error('生日格式應為 CYYMMDD，例：0750315');
      }
      if (!d.propertyAddr || !d.mailAddr) throw new Error('請填寫標的物地址及通訊地址');
      if (!confirm('確認要保後，報價單將轉為「已要保」，之後不可再修改。確定送出？')) return;
    } else if (!d.applicant.name) {
      throw new Error('儲存報價單至少需填寫要保人姓名');
    }
    d.action = action;
    const r = await api('/api/quotes', d);
    current = r.quote;
    $('quoteNo').value = r.quote.quote_no;
    renderCalc(r.calc);
    renderStatus(r.quote);
    if (action === 'confirm') {
      setMode('view', `報價單 ${r.quote.quote_no} 已確認要保（已要保／${r.quote.status2}）。按右上「清除畫面」可開新報價。`);
      msg(`已確認要保，報價單號 ${r.quote.quote_no}，總保費 ${fmt(r.calc.totalPremium)} 元`);
    } else {
      setMode('edit');
      msg(`已儲存，報價單號 ${r.quote.quote_no}，總保費 ${fmt(r.calc.totalPremium)} 元`);
    }
  }

  // ── 列印報價單 ───────────────────────────────────
  async function printQuote() {
    if (!lastCalc) {
      try { renderCalc(await api('/api/calc', collect())); } catch (e) { msg('列印前請先完成保費計算：' + e.message, false); return; }
    }
    const no = $('quoteNo').value;
    $('printInfo').textContent = `${no ? `報價單號：${no}　` : '（未儲存報價）　'}列印時間：${new Date().toLocaleString('zh-TW', { hour12: false })}`;
    window.print();
  }

  // ── 查詢報價單一覽表 ─────────────────────────────
  function openQuery() {
    $('queryModal').classList.remove('hidden');
    $('qmKw').focus();
    loadList();
  }
  function closeQuery() { $('queryModal').classList.add('hidden'); }

  async function loadList() {
    const p = new URLSearchParams({ kw: $('qmKw').value.trim(), status1: $('qmS1').value, status2: $('qmS2').value });
    $('qmBody').innerHTML = '<tr><td colspan="13" class="center muted">查詢中…</td></tr>';
    try {
      const rows = await api('/api/quotes?' + p.toString());
      $('qmCount').textContent = `共 ${rows.length} 筆`;
      $('qmBody').innerHTML = rows.length ? rows.map((r) => {
        const editable = r.status1 === '報價中';
        return `<tr>
          <td>${esc(r.quote_no)}</td>
          <td>${esc(r.applicant_name)}</td>
          <td>${rocText(r.period_start)}</td>
          <td>${rocText(r.period_end)}</td>
          <td class="r">${fmt(r.fire_premium)}</td>
          <td class="r">${fmt(r.eq_premium)}</td>
          <td class="r">${fmt(r.home_premium)}</td>
          <td class="r"><b>${fmt(r.total_premium)}</b></td>
          <td><span class="tag s1">${esc(r.status1)}</span></td>
          <td><span class="tag s2">${esc(r.status2)}</span></td>
          <td><button type="button" data-act="view" data-no="${esc(r.quote_no)}">查詢</button></td>
          <td><button type="button" data-act="edit" data-no="${esc(r.quote_no)}" ${editable ? '' : 'disabled title="非報價中不可修改"'}>修改</button></td>
          <td><button type="button" data-act="del" data-no="${esc(r.quote_no)}" class="danger" ${editable ? '' : 'disabled title="非報價中不可刪除"'}>刪除</button></td>
        </tr>`;
      }).join('') : '<tr><td colspan="13" class="center muted">查無資料</td></tr>';
    } catch (e) {
      $('qmBody').innerHTML = `<tr><td colspan="13" class="center err">${esc(e.message)}</td></tr>`;
    }
  }

  async function onListClick(e) {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const no = btn.dataset.no;
    try {
      if (btn.dataset.act === 'del') {
        if (!confirm(`確定刪除報價單 ${no}？`)) return;
        await api('/api/quotes?no=' + encodeURIComponent(no), undefined, 'DELETE');
        if ($('quoteNo').value === no) resetForm();
        await loadList();
        return;
      }
      await openQuote(no, btn.dataset.act === 'edit');
      closeQuery();
    } catch (err) {
      alert(err.message);
    }
  }

  init().catch((e) => msg('初始化失敗：' + e.message, false));
})();
