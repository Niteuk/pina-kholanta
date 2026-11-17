const EPSILON = 1e-9;

/**
 * Calcule le score de chaque joueur et désigne le(s) MVP et le(s) boulet(s).
 *
 * Score d'un joueur = moyenne de ses moyennes par catégorie
 * (chaque catégorie pèse autant, quel que soit le nombre de notes reçues).
 * En cas d'égalité, il peut y avoir plusieurs MVP ou plusieurs boulets.
 * Si tout le monde a exactement le même score, personne n'est désigné.
 *
 * @param {string[]} eligibleIds joueurs éligibles de la session
 * @param {{voter_id: string, target_id: string, category_id: number, note: number}[]} ratings
 */
function computeResults(eligibleIds, ratings) {
  const eligible = new Set(eligibleIds);
  const byTarget = new Map(); // joueur -> Map(catégorie -> { sum, count })

  for (const r of ratings) {
    if (!eligible.has(r.voter_id) || !eligible.has(r.target_id) || r.voter_id === r.target_id) continue;
    if (!byTarget.has(r.target_id)) byTarget.set(r.target_id, new Map());
    const cats = byTarget.get(r.target_id);
    const acc = cats.get(r.category_id) ?? { sum: 0, count: 0 };
    acc.sum += r.note;
    acc.count += 1;
    cats.set(r.category_id, acc);
  }

  const rows = [];
  for (const [userId, cats] of byTarget) {
    const averages = [...cats.values()].map(({ sum, count }) => sum / count);
    const score = averages.reduce((a, b) => a + b, 0) / averages.length;
    rows.push({ userId, score });
  }
  rows.sort((a, b) => b.score - a.score);

  if (rows.length < 2) return { rows, mvp: [], boulet: [] };

  const max = rows[0].score;
  const min = rows[rows.length - 1].score;
  if (max - min < EPSILON) return { rows, mvp: [], boulet: [] };

  return {
    rows,
    mvp: rows.filter((r) => max - r.score < EPSILON).map((r) => r.userId),
    boulet: rows.filter((r) => r.score - min < EPSILON).map((r) => r.userId),
  };
}

module.exports = { computeResults };
