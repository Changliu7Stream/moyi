/**
 * 墨忆 — 记忆衰减与遗忘
 *
 * 目的不是「让旧记忆消失」，而是让长期没人用的记忆在检索排序里往后靠，
 * 把位置让给近期真正被用到的。所以默认只做**降权**，删除永远是显式操作。
 *
 * 两个不同的量，刻意分开算，别混用：
 *
 * 1. vitality(m) —— 检索用的「活力」，参与排序：
 *      raw     = exp( -(age_days / (1 + access_count)) / 半衰期 )
 *      vitality = max(raw, FLOOR[importance])
 *    指数而非线性：「30 天 vs 60 天」的差别应当大于「930 天 vs 960 天」，
 *    线性衰减会把十年老账和上月新账拉成两个世界。
 *    访问次数按「复习次数」缩小有效年龄（间隔重复）：被反复用到的记忆
 *    衰减更慢。第一版用对数惩罚项做不到这点，见 rawDecay() 的注释。
 *    FLOOR 保证 high 的记忆即使三年没人碰也仍可被搜到（身份类事实放着不用
 *    依然重要），但地板只影响排序，不会反过来掩盖降级的判据。
 *
 * 2. 是否**改动数据**（降级）—— 用 rawDecay()，不取地板，否则
 *    「重要性地板 ≥ 降级阈值」会让降级永远不触发（第一版就踩了这个坑）。
 *
 * 三条硬约束（防止误删用户资产）：
 *    a) high 永不自动降级。要动它只能用户自己 PATCH。
 *    b) 降级一次只降一级（medium → low），绝不一步从中到底。
 *    c) force=true 存进来的记忆钉住，不参与任何衰减。
 *    d) 删除（遗忘）永远是显式操作 + 默认 dry-run，且只对 low 生效。
 */

const { numEnv } = require('./numenv.js');

// 半衰期与遗忘门槛用 numEnv 而非 Number(...)：
// 写错一个字符（带上单位、全角数字）会让 HALFLIFE_DAYS 变成 NaN，
// 进而让 vitality / decayFactor / 最终 score 全部变成 NaN——接口仍回 200，
// 只是所有相关性都废了。见 lib/numenv.js 顶部的说明。
const HALFLIFE_DAYS = numEnv('MOYI_DECAY_HALFLIFE', 90, { min: 7 });
/** 检索排序时的活力地板 */
const FLOOR = { high: 0.55, medium: 0.30, low: 0.0 };
/** 低于此「原始衰减」才降级（high 不参与自动降级，见上） */
const DOWNGRADE_BELOW = { medium: 0.15, low: 0 };
const FORGET_AFTER = numEnv('MOYI_FORGET_AFTER_DAYS', 180, { min: 30 });
const FORGET_MAX_ACCESS = numEnv('MOYI_FORGET_MAX_ACCESS', 1, { min: 0 });

const RANK = { low: 0, medium: 1, high: 2 };
const LOWER = { high: 'medium', medium: 'low', low: 'low' };

function ageDays(m, now = Date.now()) {
  // 以最后一次「被写或被读」的时间为年龄基准：访问过就该重新计时
  const t = [m.updated_at, m.created_at]
    .filter(Boolean).map(x => new Date(x).getTime()).filter(n => !Number.isNaN(n));
  const last = t.length ? Math.max(...t) : now;
  return Math.max(0, (now - last) / 86400000);
}

/** 强制保留的记忆：source 里带独立的 force 标记，或显式 pinned。 */
function isPinned(m) {
  if (m.pinned === true) return true;
  // 按空白分词做精确匹配，不能用 includes：否则来源叫 force-app 会被误判为钉住
  return String(m.source || '').toLowerCase().split(/[\s,;|]+/).includes('force');
}

/**
 * 不含重要性地板的原始衰减 [0,1]，用于「是否降级」的判断。
 *
 * 访问次数作为「复习次数」缩小有效年龄：age / (1 + accesses)。
 * 这是间隔重复的思路——被反复用到的记忆应该衰减得更慢。
 *
 * 为什么不是早期那版 exp(-age/H) / (1 + 0.25·ln(1+n))：乘一个对数项根本
 * 抵不过指数衰减。400 天 × 40 次访问算出来仍是 0.006，等于「访问次数」
 * 这个变量在数学上毫无作用（要抵消 400 天需要 e^340 次访问）。测试里
 * 「常被访问的 medium 不该降级」就是因此失败的——那是代码错，不是测试错。
 */
function rawDecay(m, now = Date.now()) {
  if (isPinned(m)) return 1;
  const acc = Math.max(0, Number(m.access_count) || 0);
  const effectiveAge = ageDays(m, now) / (1 + acc);
  return Math.min(1, Math.exp(-effectiveAge / HALFLIFE_DAYS));
}

/** 检索用活力 [0,1]：原始衰减 + 重要性地板。 */
function vitality(m, now = Date.now()) {
  if (isPinned(m)) return 1;
  const imp = RANK[m.importance] != null ? m.importance : 'medium';
  return Math.max(rawDecay(m, now), FLOOR[imp]);
}

/** 乘在融合分上的衰减系数。 */
function decayFactor(m, now = Date.now()) {
  // 地板 0.35：再老的记忆也仍可被搜到，只是排后面，绝不「静默失效」
  return 0.35 + 0.65 * vitality(m, now);
}

/**
 * 评估一批记忆，返回将要发生的动作（纯函数，不写库）。
 * 调用方负责写库，也负责把「删除」这件事单独确认。
 */
function evaluate(rows, opts = {}) {
  const now = opts.now || Date.now();
  const forgetAfter = opts.forgetAfterDays != null ? Number(opts.forgetAfterDays) : FORGET_AFTER;
  const out = { keep: [], downgrade: [], forget_eligible: [], pinned: 0 };

  for (const m of rows) {
    const imp = RANK[m.importance] != null ? m.importance : 'medium';
    const age = ageDays(m, now);
    const acc = Number(m.access_count) || 0;
    const rec = {
      id: m.id, importance: imp,
      vitality: Number(vitality(m, now).toFixed(3)),
      decay: Number(rawDecay(m, now).toFixed(3)),
      age_days: Number(age.toFixed(1)), access_count: acc,
      summary: (m.summary || (m.content || '').slice(0, 60)),
    };
    if (isPinned(m)) { out.pinned++; out.keep.push(rec); continue; }

    // 遗忘候选：低重要性 + 超期 + 几乎没被访问过，三个条件缺一不可
    if (imp === 'low' && age > forgetAfter && acc <= FORGET_MAX_ACCESS) {
      out.forget_eligible.push(Object.assign(rec, { reason: 'low_importance_and_stale' }));
      continue;
    }
    // high 明确跳过：见文件头约束 a
    if (imp === 'medium' && rec.decay < DOWNGRADE_BELOW.medium) {
      out.downgrade.push(Object.assign(rec, { to: 'low', reason: 'stale_and_never_accessed' }));
      continue;
    }
    out.keep.push(rec);
  }
  return out;
}

module.exports = {
  HALFLIFE_DAYS, FORGET_AFTER, FORGET_MAX_ACCESS, RANK, LOWER, FLOOR, DOWNGRADE_BELOW,
  ageDays, isPinned, rawDecay, vitality, decayFactor, evaluate,
};
