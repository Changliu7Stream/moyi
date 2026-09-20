/**
 * 环境变量的数值解析。
 *
 * 为什么要单独一个文件：多处模块直接写 Number(process.env.X || 默认)，
 * 这个写法只在「变量未设置」时安全。一旦变量**设了但不是数字**
 * （MOYI_W_VEC=0.7d、半衰期手滑带上单位、从别处复制来是全角数字），
 * Number('0.7d') 得 NaN，而 NaN 会把整条运算链染成 NaN：
 *
 *   MOYI_DECAY_HALFLIFE=abc
 *     → vitality = Math.exp(-age / NaN)      = NaN
 *     → decayFactor = 0.35 + 0.65·NaN        = NaN
 *     → 融合分 score × NaN                    = NaN
 *     → 检索结果序列化成 JSON 后 score 变成 null，且排序比较器拿到 NaN
 *
 * 服务照常启动、日志一声不响、接口照回 200，只是所有相关性都废了。
 * 根因是一个错字，排查成本却极高——所以在解析层就拦住，并且喊出来。
 *
 * 注意只覆盖 Number() 那些点。parseInt(x,10) || 默认 的写法本身已对
 * NaN 免疫（parseInt 出 NaN → 走 || 右侧），不改语义、不动它。
 */

const warned = new Set();

/** 解析成有限数字，失败返回 null（未设置/空串/非数字/Infinity 都算失败）。 */
function parseNum(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 读一个数值型环境变量。
 * @param {string} name 变量名
 * @param {number} def  默认值（代码里的可信常量，不参与钳制）
 * @param {{min?:number,max?:number}} [opts]
 * @returns {number}
 */
function numEnv(name, def, opts) {
  const o = opts || {};
  const raw = process.env[name];
  let v = parseNum(raw);
  if (v === null) {
    // 设了但解析不出来 → 用默认值，同时明确告知，避免「以为配置生效了」
    if (raw !== undefined && String(raw).trim() !== '' && !warned.has(name)) {
      warned.add(name);
      process.stderr.write('[moyi] ' + name + ' 的值 "' + raw + '" 不是有效数字，已改用默认值 '
        + def + '。\n');
    }
    return def;
  }
  if (o.min !== undefined && v < o.min) v = o.min;
  if (o.max !== undefined && v > o.max) v = o.max;
  return v;
}

module.exports = { numEnv, parseNum };
