import {
  RETENTION, initialState, previewIntervals, review,
  autoNewQuota, buildQueue, forecast,
} from './scheduler.js';
import * as db from './storage.js';

/* ================= 基础工具 ================= */

const $ = id => document.getElementById(id);
const DAY_MS = 86400000;

/** 本地日期的整数序号，用作调度里的 "day" */
function todayIndex(d = new Date()) {
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / DAY_MS);
}
const indexToDate = i => new Date(i * DAY_MS);

function daysBetweenIndex(a, b) { return b - a; }

function fmtDate(i) {
  const d = indexToDate(i);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function toast(msg, ms = 1800) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function fatal(msg) {
  const box = $('errBox');
  const pre = $('errMsg');
  if (!box || !pre) return;
  pre.textContent = String(msg);
  box.hidden = false;
  console.error(msg);
}

window.addEventListener('error', e =>
  fatal(`${e.message}\n${e.filename || ''}:${e.lineno || ''}`));
window.addEventListener('unhandledrejection', e =>
  fatal((e.reason && (e.reason.stack || e.reason.message)) || e.reason));

/* ================= 外观（白天 / 黑夜 / 跟随系统） ================= */

const THEME_KEY = 'theme843';

function currentTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) { return 'auto'; }
}

function applyTheme(mode) {
  document.documentElement.dataset.theme = mode;
  const dark = mode === 'dark'
    || (mode === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#14171a' : '#1f6feb');
  document.querySelectorAll('#themeSeg button').forEach(b =>
    b.classList.toggle('on', b.dataset.themeopt === mode));
}

function setTheme(mode) {
  try { localStorage.setItem(THEME_KEY, mode); } catch (e) { /* 忽略 */ }
  applyTheme(mode);
}

/* ================= 默写作答比对 ================= */

const escapeHtml = s => String(s).replace(/[&<>"]/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 去掉空白与标点，便于比对 */
const stripPunct = s => (s || '').replace(/[\s\p{P}]/gu, '').toLowerCase();

/**
 * 默写作答与标准释义的重合度（参考值，非判分）。
 * 用二元词组的覆盖率衡量：标准释义里的相邻两字组合，有多少也出现在你的作答里。
 */
function recallScore(user, answer) {
  const A = stripPunct(answer);
  const U = stripPunct(user);
  if (!A || !U) return 0;
  const gram = s => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const ga = gram(A);
  if (!ga.size) return A === U ? 100 : 0;
  const gu = gram(U);
  let hit = 0;
  for (const g of ga) if (gu.has(g)) hit += 1;
  return Math.round(hit / ga.size * 100);
}

/* ================= 全局状态 ================= */

const TODAY = todayIndex();

const S = {
  data: null,          // cards.json
  progress: {},        // id -> 学习状态
  meta: {},            // 设置与快照
  queue: [],
  idx: 0,
  flipped: false,
  browse: false,       // C 级速览模式
  session: { rated: 0, correct: 0, isNew: 0 },
  finished: false,
};

const DEFAULTS = {
  bufferDays: 14,
  defaultCap: 120,
  newCap: 40,
};

const SUBJECT_ORDER = [
  '数据结构', '计算机组成原理', '计算机网络',
  '概率论与数理统计', '线性代数', '计算机软件技术基础', '创新设计',
];

/* ================= 设置读写 ================= */

function setting(key, fallback) {
  return S.meta[key] === undefined ? fallback : S.meta[key];
}

async function saveSetting(key, value) {
  S.meta[key] = value;
  await db.setMeta(key, value);
}

/** 今日自定义覆盖：仅对当天生效 */
function todayOverride() {
  const ov = S.meta.todayOverride;
  return ov && ov.day === TODAY ? ov : null;
}

/** 计算今天实际使用的新卡配额与总上限 */
function effectiveQuota() {
  const cards = S.data.cards;
  const srsCards = cards.filter(c => c.inSrs);
  const remainingNew = srsCards.filter(c => {
    const st = S.progress[c.id];
    return !st || st.state === 'new';
  }).length;

  const examIdx = todayIndex(new Date(setting('examDate', S.data.examDate) + 'T00:00:00'));
  const daysLeft = Math.max(0, daysBetweenIndex(TODAY, examIdx));

  const auto = autoNewQuota({
    remainingNew, daysLeft, bufferDays: DEFAULTS.bufferDays, cap: DEFAULTS.newCap,
  });

  const ov = todayOverride();
  if (ov) {
    return { newQuota: ov.new, totalCap: ov.cap, auto, daysLeft, remainingNew, custom: true };
  }
  return {
    newQuota: setting('defaultNew', null) === null ? auto : setting('defaultNew', auto),
    totalCap: setting('defaultCap', DEFAULTS.defaultCap),
    auto, daysLeft, remainingNew, custom: false,
  };
}

/* ================= 渲染：今日 ================= */

function renderToday() {
  const { newQuota, totalCap, auto, daysLeft, remainingNew, custom } = effectiveQuota();
  const built = buildQueue({
    cards: S.data.cards, progress: S.progress, today: TODAY,
    newQuota, totalCap,
  });

  // 倒计时
  $('countdown').innerHTML = daysLeft > 0
    ? `距 843 考试 <b>${daysLeft}</b> 天` : '考试周 · 冲刺';

  // 今日进度
  const goal = S.meta['goal_' + TODAY] || (built.queue.length || 1);
  const done = S.meta['done_' + TODAY] || 0;
  $('doneToday').textContent = done;
  $('goalToday').textContent = goal;
  $('todayBar').style.width = clamp(done / goal * 100, 0, 100) + '%';
  $('heroSub').textContent = done >= goal ? '今日目标已完成 🎉' : '今日已学';

  // 自定义学习量
  $('qNew').textContent = newQuota;
  $('qCap').textContent = totalCap;
  $('btnResetQuota').hidden = !custom;
  document.querySelectorAll('#presets button').forEach(b => {
    b.classList.toggle('on', +b.dataset.preset === newQuota);
  });

  // 三个数字
  $('cNew').textContent = built.counts.fresh;
  $('cDue').textContent = built.counts.learning + built.counts.review;
  $('cDone').textContent = done;

  const empty = built.queue.length === 0;
  $('btnStart').textContent = empty ? '今天没有待办，休息一下' : `开始学习（${built.queue.length} 张）`;
  $('btnStart').disabled = empty;

  // C 级速览入口
  const cCount = S.data.cards.filter(c => !c.inSrs).length;
  const browseBtn = $('btnBrowse');
  browseBtn.hidden = cCount === 0;
  browseBtn.textContent = `C 级速览 · ${cCount} 条（考前浏览，不计入复习）`;

  return built;
}

/* ================= 渲染：统计 ================= */

async function renderStats() {
  const srs = S.data.cards.filter(c => c.inSrs);
  const learned = srs.filter(c => S.progress[c.id] && S.progress[c.id].state !== 'new').length;
  $('allBar').style.width = (learned / srs.length * 100).toFixed(1) + '%';
  $('allText').textContent = `已学 ${learned} / ${srs.length} 张（${(learned / srs.length * 100).toFixed(1)}%）`;

  const logs = (await db.getLogs()).filter(l => l.day === TODAY);
  const isNew = logs.filter(l => l.isNew).length;
  const correct = logs.filter(l => l.rating !== 'again').length;
  $('sNew').textContent = isNew;
  $('sRev').textContent = logs.length - isNew;
  $('sRate').textContent = logs.length ? Math.round(correct / logs.length * 100) + '%' : '—';

  // 各科目
  const box = $('bySubject');
  box.innerHTML = '';
  const present = [...new Set(srs.map(c => c.subject))];
  const subs = SUBJECT_ORDER.filter(s => present.includes(s))
    .concat(present.filter(s => !SUBJECT_ORDER.includes(s)));
  for (const sub of subs) {
    const all = srs.filter(c => c.subject === sub);
    const ok = all.filter(c => S.progress[c.id] && S.progress[c.id].state !== 'new').length;
    const pct = ok / all.length * 100;
    box.insertAdjacentHTML('beforeend', `
      <div class="subj">
        <div class="subj-head"><span>${sub}</span><span>${ok}/${all.length}</span></div>
        <div class="progress-track"><div class="progress-fill" style="width:${pct.toFixed(1)}%"></div></div>
      </div>`);
  }

  // 未来 7 天
  const f = forecast(S.data.cards, S.progress, TODAY, 7);
  const max = Math.max(1, ...f);
  $('forecast').innerHTML = f.map((n, i) => `
    <div class="bar">
      <em>${n}</em>
      <i style="height:${(n / max * 100).toFixed(1)}%"></i>
      <em>${fmtDate(TODAY + i)}</em>
    </div>`).join('');
}

/* ================= 渲染：设置 ================= */

async function renderSettings() {
  applyTheme(currentTheme());
  $('examDate').value = setting('examDate', S.data.examDate);
  $('defNew').value = setting('defaultNew', '');
  $('defNew').placeholder = '自动';
  $('defCap').value = setting('defaultCap', DEFAULTS.defaultCap);

  const last = setting('lastBackupAt', null);
  $('backupHint').textContent = last
    ? `上次备份：${new Date(last).toLocaleDateString('zh-CN')}`
    : '还没有备份过，建议现在导出一份';

  const est = await db.estimateUsage();
  const used = est ? (est.usage / 1024 / 1024).toFixed(2) : '?';
  $('aboutText').innerHTML =
    `词条 ${S.data.counts.total} 条（进入循环 ${S.data.counts.inSrs} 条，C 级 ${S.data.counts.excluded} 条考前浏览）<br>` +
    `辨析题 ${S.data.debates.length} 道<br>` +
    `本地占用约 ${used} MB · 数据只保存在本机浏览器`;
}

/* ================= 学习流程 ================= */

function startStudy(bonus = 0) {
  if (!bonus || S.finished) {
    const { newQuota, totalCap } = effectiveQuota();
    const built = buildQueue({
      cards: S.data.cards, progress: S.progress, today: TODAY,
      newQuota, totalCap: totalCap + bonus,
    });
    if (!built.queue.length) { toast('今天没有待办'); return; }
    S.queue = built.queue;
    S.idx = 0;
    S.browse = false;
    S.session = { rated: 0, correct: 0, isNew: 0 };
    S.finished = false;
    if (!S.meta['goal_' + TODAY]) {
      saveSetting('goal_' + TODAY, built.queue.length);
    }
  }
  $('study').hidden = false;
  document.body.style.overflow = 'hidden';
  showCard();
}

/** C 级速览：只翻看，不计入 SRS */
function startBrowse() {
  const list = S.data.cards
    .filter(c => !c.inSrs)
    .sort((a, b) => SUBJECT_ORDER.indexOf(a.subject) - SUBJECT_ORDER.indexOf(b.subject)
      || a.term.localeCompare(b.term, 'zh'));
  if (!list.length) { toast('没有 C 级词条'); return; }
  S.queue = list.map(c => ({ card: c, st: null }));
  S.idx = 0;
  S.browse = true;
  S.session = { rated: 0, correct: 0, isNew: 0 };
  $('study').hidden = false;
  document.body.style.overflow = 'hidden';
  showCard();
}

function quitStudy() {
  $('study').hidden = true;
  document.body.style.overflow = '';
  S.browse = false;
  renderToday();
  renderStats();
}

function current() {
  return S.queue[S.idx] || null;
}

function showCard() {
  const item = current();
  if (!item) { finishStudy(); return; }
  S.flipped = false;

  const { card, st } = item;
  const state = st || initialState(card);

  // 标签
  const tags = [`${card.subject}`, `${card.group}`];
  $('fcTags').innerHTML =
    (card.priority === 'S' ? '<span class="s">S 级 · 高频</span>' : '') +
    card.examYears.map(y => `<span class="exam">${y} 考过</span>`).join('') +
    tags.map(t => `<span>${t}</span>`).join('') +
    (state.reps ? `<span>第 ${state.reps + 1} 次</span>` : '<span>新卡</span>');

  $('fcTerm').textContent = card.term;
  $('fcTermBack').textContent = card.term;
  $('fcDef').textContent = card.definition;

  $('fc').querySelector('.fc-front').classList.add('on');
  $('fc').querySelector('.fc-back').classList.remove('on');
  $('rate').hidden = true;
  $('rateHint').hidden = S.browse;
  $('browseBar').hidden = !S.browse;
  $('btnBonus').hidden = S.browse;

  // 默写区：每次换卡清空；速览模式下不显示
  $('recallInput').value = '';
  $('recallBox').hidden = S.browse;
  $('fcResult').hidden = true;

  // 评分按钮上的间隔预览
  const iv = previewIntervals(card, st);
  $('ivAgain').textContent = '今天';
  $('ivHard').textContent = iv.hard + ' 天';
  $('ivGood').textContent = iv.good + ' 天';
  $('ivEasy').textContent = iv.easy + ' 天';

  $('studyProgress').textContent = S.browse
    ? `C 级速览 ${S.idx + 1} / ${S.queue.length}`
    : `${S.session.rated} / ${Math.max(S.queue.length, S.session.rated + 1)}`;
}

function flip() {
  const item = current();
  if (!item || S.flipped) return;
  S.flipped = true;

  $('fc').querySelector('.fc-front').classList.remove('on');
  $('fc').querySelector('.fc-back').classList.add('on');
  $('rate').hidden = S.browse;
  $('rateHint').hidden = true;
  $('browseBar').hidden = !S.browse;

  // 有默写作答就给出参考重合度，供自己判断掌握程度
  const typed = $('recallInput').value.trim();
  const box = $('fcResult');
  if (typed) {
    const pct = recallScore(typed, item.card.definition);
    box.innerHTML =
      `本张记忆重合度 <b>${pct}%</b><br>仅供参考，最终对错由自己判断` +
      `<div class="answer">你的作答：${escapeHtml(typed)}</div>`;
    box.hidden = false;
  } else {
    box.hidden = true;
  }
}

async function rate(r) {
  const item = current();
  if (!item || !S.flipped) return;
  const { card, st } = item;
  const isNew = !st;

  const { next, log } = review(card, st, r, TODAY);
  S.progress[card.id] = next;
  await db.putProgress(next);
  await db.addLog({ ...log, isNew });

  S.session.rated += 1;
  if (r !== 'again') S.session.correct += 1;
  if (isNew) S.session.isNew += 1;

  const done = (S.meta['done_' + TODAY] || 0) + 1;
  await saveSetting('done_' + TODAY, done);

  if (r === 'again') {
    S.queue.push({ card, st: next });      // 当天稍后再出现一次
  }
  S.idx += 1;
  showCard();
}

function finishStudy() {
  S.finished = true;
  const acc = S.session.rated ? Math.round(S.session.correct / S.session.rated * 100) : 0;
  toast(`完成 ${S.session.rated} 张 · 答对率 ${acc}%`, 2600);
  quitStudy();
}

/* ================= 自定义今日学习量 ================= */

async function changeQuota(kind, delta) {
  const cur = effectiveQuota();
  const isNewCap = kind === 'new';
  const nextNew = clamp(isNewCap ? cur.newQuota + delta : cur.newQuota, 0, 80);
  const nextCap = clamp(!isNewCap ? cur.totalCap + delta : cur.totalCap, 20, 400);
  await saveSetting('todayOverride', { day: TODAY, new: nextNew, cap: nextCap });
  renderToday();
  toast(`今日新卡 ${nextNew} 张 · 上限 ${nextCap} 张`, 1400);
}

async function setPreset(n) {
  const cur = effectiveQuota();
  await saveSetting('todayOverride', { day: TODAY, new: n, cap: Math.max(cur.totalCap, n * 4) });
  renderToday();
  toast(`已设为「${n} 张/天」`, 1400);
}

async function resetQuota() {
  await saveSetting('todayOverride', null);
  renderToday();
  toast('已恢复自动配额');
}

/* ================= 备份 ================= */

async function doExport() {
  const data = await db.exportAll();
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `843背诵备份_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  await saveSetting('lastBackupAt', Date.now());
  renderSettings();
  toast('备份已导出');
}

async function doImport(file) {
  try {
    const text = await file.text();
    const n = await db.importAll(JSON.parse(text));
    toast(`已导入 ${n} 条进度，正在重载…`);
    setTimeout(() => location.reload(), 900);
  } catch (e) {
    toast('导入失败：' + e.message, 3000);
  }
}

async function doReset() {
  if (!confirm('确定清空全部学习进度？此操作不可撤销（建议先导出备份）。')) return;
  await db.clearProgress();
  await db.clearLogs();
  toast('已清空，正在重载…');
  setTimeout(() => location.reload(), 800);
}

/* ================= 视图切换 ================= */

function switchTab(name) {
  for (const v of ['today', 'stats', 'settings']) {
    $('view-' + v).hidden = v !== name;
  }
  document.querySelectorAll('#tabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  if (name === 'stats') renderStats();
  if (name === 'settings') renderSettings();
}

/* ================= 事件绑定 ================= */

function bind() {
  document.querySelectorAll('#tabs button').forEach(b =>
    b.addEventListener('click', () => switchTab(b.dataset.tab)));

  $('btnStart').addEventListener('click', () => startStudy());
  $('btnBrowse').addEventListener('click', startBrowse);
  $('btnNext').addEventListener('click', () => {
    if (S.idx < S.queue.length - 1) { S.idx += 1; showCard(); }
    else { quitStudy(); toast('C 级已全部浏览完'); }
  });
  $('btnPrev').addEventListener('click', () => {
    if (S.idx > 0) { S.idx -= 1; showCard(); }
  });
  $('btnQuit').addEventListener('click', quitStudy);
  $('btnBonus').addEventListener('click', () => {
    const extra = S.queue.slice(S.idx, S.idx + 5);
    const { newQuota, totalCap } = effectiveQuota();
    const built = buildQueue({
      cards: S.data.cards, progress: S.progress, today: TODAY,
      newQuota: newQuota + 5, totalCap: totalCap + 5,
    });
    const more = built.queue.filter(x => !S.queue.some(q => q.card.id === x.card.id)).slice(0, 5);
    if (!more.length) { toast('没有更多卡片了'); return; }
    S.queue = [...extra.length ? S.queue : S.queue, ...more];
    S.finished = false;
    toast('已加入 ' + more.length + ' 张');
    showCard();
  });

  $('fcWrap').addEventListener('click', e => {
    if (e.target.closest('#recallBox')) return;   // 点输入框或按钮时不翻面
    flip();
  });
  $('btnCheck').addEventListener('click', e => { e.stopPropagation(); flip(); });
  document.querySelectorAll('#rate button').forEach(b =>
    b.addEventListener('click', e => { e.stopPropagation(); rate(b.dataset.r); }));

  document.querySelectorAll('#themeSeg button').forEach(b =>
    b.addEventListener('click', () => setTheme(b.dataset.themeopt)));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (currentTheme() === 'auto') applyTheme('auto');
  });

  document.querySelectorAll('.stepper button').forEach(b =>
    b.addEventListener('click', () => changeQuota(b.dataset.q, +b.dataset.d)));
  document.querySelectorAll('#presets button').forEach(b =>
    b.addEventListener('click', () => setPreset(+b.dataset.preset)));
  $('btnResetQuota').addEventListener('click', resetQuota);

  $('examDate').addEventListener('change', e => {
    saveSetting('examDate', e.target.value); renderToday(); toast('考试日期已更新');
  });
  $('defNew').addEventListener('change', e => {
    const v = e.target.value === '' ? null : clamp(+e.target.value, 1, 100);
    e.target.value = v === null ? '' : v;
    saveSetting('defaultNew', v); renderToday();
  });
  $('defCap').addEventListener('change', e => {
    const v = clamp(+e.target.value || DEFAULTS.defaultCap, 10, 400);
    e.target.value = v;
    saveSetting('defaultCap', v); renderToday();
  });

  $('btnExport').addEventListener('click', doExport);
  $('btnImport').addEventListener('click', () => $('fileImport').click());
  $('fileImport').addEventListener('change', e => {
    if (e.target.files[0]) doImport(e.target.files[0]);
  });
  $('btnReset').addEventListener('click', doReset);

  // 键盘：空格翻面，1-4 评分
  document.addEventListener('keydown', e => {
    if ($('study').hidden) return;
    const typing = e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT');
    if (typing) {
      // 正在默写：回车 = 对照答案，其余按键交给输入框
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); flip(); }
      return;
    }
    if (e.code === 'Space' || e.key === 'Enter') { e.preventDefault(); flip(); return; }
    const map = { '1': 'again', '2': 'hard', '3': 'good', '4': 'easy' };
    if (map[e.key]) rate(map[e.key]);
  });

  // 防止学习页里误触返回
  window.addEventListener('beforeunload', e => {
    if (!$('study').hidden && S.session.rated) { e.preventDefault(); e.returnValue = ''; }
  });
}

/* ================= 启动 ================= */

async function main() {
  window.__booted = true;
  if (location.protocol === 'file:') {
    $('envWarn').hidden = false;
    return;
  }
  try {
    S.data = await (await fetch('data/cards.json')).json();
  } catch (e) {
    toast('数据加载失败：' + e.message, 4000);
    return;
  }
  S.progress = await db.getAllProgress();
  S.meta = await db.allMeta();

  await db.requestPersistence();
  bind();
  switchTab('today');
  renderToday();
  renderStats();

  // 离线支持（HTTP 环境下才注册）
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

main();
