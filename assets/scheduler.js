/**
 * WIRS 调度算法 —— 面向"有明确考试日期 + 有考频权重"的间隔重复。
 *
 * 规则依据：11_技术设计/记忆算法设计.md 与 背诵任务量与记忆曲线修订.md
 *   · S/A/B 三级进入 SRS，目标保留率 0.95 / 0.92 / 0.88
 *   · C 级不进入 SRS（考前集中浏览）
 *   · "重来"惩罚系数 0.45（原 0.3 会造成重置雪崩）
 *   · 每日新卡默认按剩余天数自动推算，可被用户自定义覆盖
 */

const FACTOR = 19 / 81;          // 使 R(t=S)=0.9
const DECAY = 0.5;
export const MAX_STABILITY = 365;
export const AGAIN_PENALTY = 0.45;

export const RETENTION = { S: 0.95, A: 0.92, B: 0.88 };
const BASE_D = { S: 4.5, A: 5.0, B: 6.0, C: 7.0 };

/** 距上次复习 t 天后，记忆仍可提取的概率 */
export function retrievability(t, S) {
  return Math.pow(1 + FACTOR * t / S, -DECAY);
}

/** 由稳定度和目标保留率反解下次间隔（天） */
export function interval(S, r) {
  return Math.max(1, Math.round(S / FACTOR * (Math.pow(r, -2) - 1)));
}

/** 稳定度增长系数 */
function growth(rating, D) {
  if (rating === 'easy') return 3.00 - 0.15 * D;
  if (rating === 'good') return 2.20 - 0.10 * D;
  return 1.50 - 0.06 * D;                        // hard
}

const D_DELTA = { again: 0.8, hard: 0.3, good: -0.1, easy: -0.5 };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 新卡片的初始状态 */
export function initialState(card) {
  const base = BASE_D[card.priority] ?? 6.0;
  return {
    id: card.id,
    state: 'new',
    S: 0.5,
    D: clamp(base + (card.difficulty - 2) * 0.8, 1, 10),
    due: 0,
    lastReview: null,
    reps: 0,
    lapses: 0,
  };
}

/** 预览：四档评分分别会把卡片推到多少天后 */
export function previewIntervals(card, st) {
  const r = RETENTION[card.priority] ?? 0.88;
  const s = st || initialState(card);
  return {
    again: 0,
    hard: interval(Math.min(MAX_STABILITY, s.S * growth('hard', s.D)), r),
    good: interval(Math.min(MAX_STABILITY, s.S * growth('good', s.D)), r),
    easy: interval(Math.min(MAX_STABILITY, s.S * growth('easy', s.D)), r),
  };
}

/**
 * 复习一张卡片，返回新的状态与本次复习日志。
 * @param {object} card  词条
 * @param {object} st    当前状态（可为 null，表示新卡）
 * @param {'again'|'hard'|'good'|'easy'} rating
 * @param {number} today 以"天"为单位的当天序号
 */
export function review(card, st, rating, today) {
  const prev = st || initialState(card);
  const r = RETENTION[card.priority] ?? 0.88;
  const R = prev.reps > 0 ? retrievability(today - prev.due + 1, prev.S) : null;

  const next = { ...prev, id: card.id, reps: prev.reps + 1, lastReview: today };

  if (rating === 'again') {
    next.S = Math.max(0.5, prev.S * AGAIN_PENALTY);
    next.D = clamp(prev.D + D_DELTA.again, 1, 10);
    next.lapses = prev.lapses + 1;
    next.state = 'relearning';
    next.due = today;                            // 当天再出现一次
  } else {
    next.S = Math.min(MAX_STABILITY, prev.S * growth(rating, prev.D));
    next.D = clamp(prev.D + D_DELTA[rating], 1, 10);
    next.state = 'review';
    next.due = today + Math.max(1, interval(next.S, r));
  }

  return {
    next,
    log: {
      cardId: card.id, rating,
      S_before: prev.S, S_after: next.S, D: next.D, R,
      day: today,
    },
  };
}

/**
 * 自动推算每日新卡配额。
 * 不含 C 级；缓冲期后不再引入新卡。
 */
export function autoNewQuota({ remainingNew, daysLeft, bufferDays = 14, cap = 40 }) {
  const usable = Math.max(1, daysLeft - bufferDays);
  if (daysLeft <= bufferDays) return 0;
  return Math.min(cap, Math.ceil(remainingNew / usable));
}

/**
 * 生成今日队列。
 * 顺序：学习队列（重来卡）→ 逾期复习卡 → 新卡
 */
export function buildQueue({ cards, progress, today, newQuota, totalCap }) {
  const p = progress;
  const prioRank = { S: 0, A: 1, B: 2 };
  const weight = { S: 1.50, A: 1.25, B: 1.00 };

  const learning = [];
  const dueCards = [];
  const fresh = [];

  for (const c of cards) {
    if (!c.inSrs) continue;
    const st = p[c.id];
    if (!st || st.state === 'new') { fresh.push(c); continue; }
    if (st.due <= today) {
      const overdue = today - st.due + 1;
      (st.state === 'relearning' ? learning : dueCards)
        .push({ card: c, st, key: overdue * (weight[c.priority] ?? 1) });
    }
  }

  learning.sort((a, b) => a.st.due - b.st.due);
  dueCards.sort((a, b) => b.key - a.key);
  fresh.sort((a, b) => (prioRank[a.priority] ?? 9) - (prioRank[b.priority] ?? 9));

  const queue = [
    ...learning.map(x => ({ card: x.card, st: x.st })),
    ...dueCards.map(x => ({ card: x.card, st: x.st })),
    ...fresh.slice(0, Math.max(0, newQuota)).map(c => ({ card: c, st: null })),
  ];

  const capped = queue.length > totalCap ? queue.slice(0, totalCap) : queue;
  return {
    queue: capped,
    deferred: Math.max(0, queue.length - capped.length),
    counts: {
      learning: learning.length,
      review: dueCards.length,
      fresh: Math.min(fresh.length, Math.max(0, newQuota)),
      freshTotal: fresh.length,
    },
  };
}

/** 未来 n 天每天到期多少张（用于统计页） */
export function forecast(cards, progress, today, days = 7) {
  const out = new Array(days).fill(0);
  for (const c of cards) {
    if (!c.inSrs) continue;
    const st = progress[c.id];
    if (!st || st.state === 'new') continue;
    const d = st.due - today;
    if (d >= 0 && d < days) out[d] += 1;
  }
  return out;
}
