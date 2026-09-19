/**
 * 墨忆 — 记忆图谱
 *
 * 「关联可视化」需要一个可计算的边。零依赖、无 NLP 的前提下，
 * 唯一可靠的信号是**共享标签**与**共享事实锚点**（数字/拉丁 token）。
 * 权重用共现度（overlap coefficient，|A∩B| / min(|A|,|B|)），
 * 因为一条只有 2 个标签的记忆和一条有 10 个标签的记忆连到同一节点，
 * 语义强度不该按 10 算。
 *
 * 刻意不做的事：不猜「因果」「时间先后」这类需要语言模型的边。
 * 宁缺毋滥 —— 图谱里出现假边比少几条边更糟（与去重同一原则）。
 */

const { tokenize } = require('./embeddings.js');

/** 一行的连边特征：标签 + 内容里的数字/拉丁锚点。 */
function affinityKeys(m) {
  const tags = new Set((m.tags || []).map(t => 'tag:' + String(t).toLowerCase()));
  const facts = new Set();
  for (const t of tokenize(m.content || '')) {
    // 只取含数字或纯拉丁的 token 作锚点；中文词面太碎，会把不相关的记忆连成片
    if (/[\d]/.test(t) || /^[a-z][a-z0-9._+-]{1,}$/.test(t)) facts.add('fact:' + t);
  }
  const src = m.source ? 'src:' + String(m.source).toLowerCase() : null;
  return { tags, facts, src };
}

/** overlap coefficient，0..1 */
function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let hit = 0;
  for (const x of small) if (big.has(x)) hit++;
  return hit / small.size;
}

/**
 * 构图。
 * @param rows  记忆行（需含 id,content,tags,importance,created_at,source）
 * @param opts  { maxNodes, minWeight }
 * 边只保留 weight >= minWeight 且两端不同的对；节点度上限 MAX_DEG，
 * 防止某条「万能标签」记忆把整张图连成一坨不可读的毛线球。
 */
const MAX_DEG = Number(process.env.MOYI_GRAPH_MAX_DEG || 8);

function buildGraph(rows, opts = {}) {
  const maxNodes = Math.min(600, Math.max(10, parseInt(opts.maxNodes, 10) || 200));
  const minWeight = opts.minWeight != null ? Number(opts.minWeight) : 0.5;
  const mems = rows.slice(0, maxNodes);
  const keys = mems.map(affinityKeys);
  const edges = [];
  const deg = new Map(mems.map(m => [m.id, 0]));

  for (let i = 0; i < mems.length; i++) {
    if (deg.get(mems[i].id) >= MAX_DEG) continue;
    for (let j = i + 1; j < mems.length; j++) {
      if (deg.get(mems[j].id) >= MAX_DEG) continue;
      const wTag = overlap(keys[i].tags, keys[j].tags);
      const wFact = overlap(keys[i].facts, keys[j].facts);
      // 主信号取 tag/fact 共现的较大者；同来源只作为加成，且最终钳在 1 以内，
      // 否则「同一来源 + 完全重合」会算出 1.15 这种超出 [0,1] 的权重（实测踩过）。
      const wSrc = keys[i].src && keys[i].src === keys[j].src ? 0.1 : 0;
      const w = Math.min(1, Math.max(wTag, wFact) * 0.9 + Math.min(wTag, wFact) * 0.1 + wSrc);
      if (w < minWeight) continue;
      edges.push({
        from: mems[i].id,
        to: mems[j].id,
        weight: Number(w.toFixed(3)),
        via: wFact >= wTag
          ? [...keys[i].facts].filter(f => keys[j].facts.has(f)).map(f => f.slice(5))
          : [...keys[i].tags].filter(t => keys[j].tags.has(t)).map(t => t.slice(4)),
      });
      deg.set(mems[i].id, deg.get(mems[i].id) + 1);
      deg.set(mems[j].id, deg.get(mems[j].id) + 1);
    }
  }

  const nodes = mems.map(m => ({
    id: m.id,
    summary: (m.summary || (m.content || '').slice(0, 60)),
    importance: m.importance || 'low',
    tags: m.tags || [],
    source: m.source || null,
    created_at: m.created_at,
    degree: deg.get(m.id) || 0,
  }));

  // 孤点超过一半时说明 minWeight 太高，如实报告而不是硬凑边
  const isolated = nodes.filter(n => !n.degree).length;
  return {
    nodes,
    edges,
    stats: {
      node_count: nodes.length,
      edge_count: edges.length,
      isolated,
      max_degree: MAX_DEG,
      truncated: rows.length > mems.length ? rows.length - mems.length : 0,
      density: nodes.length > 1
        ? Number((2 * edges.length / (nodes.length * (nodes.length - 1))).toFixed(4)) : 0,
    },
    min_weight: minWeight,
  };
}

/** 从一个节点出发的邻域（前端点选某条记忆时展开关联）。 */
function neighborhood(graph, id, depth = 2) {
  const adj = new Map();
  for (const e of graph.edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to)) adj.set(e.to, []);
    adj.get(e.from).push({ id: e.to, weight: e.weight });
    adj.get(e.to).push({ id: e.from, weight: e.weight });
  }
  const seen = new Set([id]);
  let frontier = [id];
  const hops = [];
  for (let d = 0; d < Math.max(1, Math.min(3, depth)); d++) {
    const next = [];
    for (const cur of frontier) {
      for (const nb of (adj.get(cur) || [])) {
        if (seen.has(nb.id)) continue;
        seen.add(nb.id);
        next.push(nb.id);
        hops.push({ from: cur, to: nb.id, weight: nb.weight, depth: d + 1 });
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return {
    nodes: graph.nodes.filter(n => seen.has(n.id)),
    edges: graph.edges.filter(e => seen.has(e.from) && seen.has(e.to)),
    hops,
  };
}

module.exports = { buildGraph, neighborhood, affinityKeys };
