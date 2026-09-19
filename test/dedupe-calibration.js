/**
 * 去重判据回归 —— 锁死「哪些能合并、哪些绝不能合并」。
 *
 * 背景：本地特征哈希向量的区分度不足，实测「改生日」的余弦（0.97）
 * 反而高于「语序调整」（0.91）。若只按语义相似度合并，会把用户的
 * 生日、版本号这类关键事实悄悄记错——这比漏合并严重得多。
 * 因此判据是三重护栏：事实不冲突 + 字面重合 + 向量相似。
 *
 *   node test/dedupe-calibration.js
 */
const { localEmbed, cosine, factsConflict, lexicalOverlap } = require('../lib/embeddings.js');

// 与 lib/moyi.js 的默认阈值保持一致
const VEC_LOCAL = 0.70, LEX_LOCAL = 0.88;

const CASES = [
  // [说明, 已存在的记忆, 新到的内容, 期望是否合并]
  ['字面完全复制',       '主人的生日是1994年3月8日，在意仪式感', '主人的生日是1994年3月8日，在意仪式感', true],
  ['插入语气词',         '主人偏好水墨风格，习惯深色主题',       '主人偏好水墨风格，非常习惯深色主题',     true],
  ['语序调整',           '主人偏好水墨风格，习惯深色主题',       '主人习惯深色主题，偏好水墨风格',         true],
  ['同主题不同事实',     '主人养了一只叫团子的橘猫，很黏人',     '主人养了一只叫团子的英短蓝猫，很高冷',   false],
  ['改生日（致命）',     '主人的生日是1994年3月8日',             '主人的生日是1994年5月8日',               false],
  ['改版本号（致命）',   '服务部署在 v2.3 环境',                 '服务部署在 v2.4 环境',                   false],
  ['改端口（致命）',     '墨忆监听 3906 端口',                   '墨忆监听 3907 端口',                     false],
  ['数量变化（致命）',   '我有 3 个 agent 在跑',                 '我有 5 个 agent 在跑',                   false],
  ['主题完全不同',       '主人爱喝龙井',                         '项目下周上线 v2.1',                      false],
  ['同一事实的追加补充', '主人习惯用 TypeScript 写后端',         '主人习惯用 TypeScript 写后端和前端',     true],
];

function decide(a, b) {
  if (factsConflict(a, b)) return false;
  if (lexicalOverlap(a, b) < LEX_LOCAL) return false;
  return cosine(localEmbed(a), localEmbed(b)) >= VEC_LOCAL;
}

let pass = 0, fail = 0;
console.log('\n去重判据回归（本地模式阈值 vec>=' + VEC_LOCAL + ', lex>=' + LEX_LOCAL + '）\n');
console.log('  ' + '场景'.padEnd(11) + 'vec     lex     冲突    合并    期望    结果');
console.log('  ' + '-'.repeat(66));
for (const [name, a, b, want] of CASES) {
  const v = cosine(localEmbed(a), localEmbed(b));
  const l = lexicalOverlap(a, b);
  const c = factsConflict(a, b);
  const got = decide(a, b);
  const good = got === want;
  good ? pass++ : fail++;
  console.log('  ' + name.padEnd(11)
    + v.toFixed(3) + '   ' + l.toFixed(3) + '   '
    + String(c).padEnd(7) + String(got).padEnd(7) + String(want).padEnd(7)
    + (good ? '✓' : '✗'));
}
console.log('\n  ' + pass + '/' + (pass + fail) + ' 通过' + (fail ? '  ⚠ 有回归' : ''));
process.exit(fail ? 1 : 0);
