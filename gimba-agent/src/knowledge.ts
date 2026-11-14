import KB from "../knowledge/金霸貓舍知識庫-v2.md";

export interface Section {
  title: string;
  body: string;
}

export const SECTIONS: Section[] = KB.split(/^## /m)
  .map((chunk) => chunk.trim())
  .filter(Boolean)
  .map((chunk) => {
    const [title, ...rest] = chunk.split("\n");
    return { title: title.trim(), body: rest.join("\n").trim() };
  });

export function byTitle(...keywords: string[]): Section[] {
  return SECTIONS.filter((s) => keywords.some((k) => s.title.includes(k)));
}

const LONG_LEG = /英短|英長|英國|長腿/;
const SHORT_LEG = /曼赤肯|小步舞曲|短腿/;
const LONG_HAIR = /長毛|英長/;

/** Sections for a recommendation, chosen by the customer's breed preference (deterministic, no embedding). */
export function sectionsForNeeds(breed: string): Section[] {
  const wantLong = LONG_LEG.test(breed);
  const wantShort = SHORT_LEG.test(breed);
  const either = !wantLong && !wantShort;
  const picked = byTitle("個性與適合");
  if (wantLong || either) picked.push(...byTitle("長腿（英短、英長）的體型"));
  if (wantShort || either) picked.push(...byTitle("短腿（曼赤肯、長毛曼赤肯、小步舞曲）的體型", "短腿（曼赤肯、長毛曼赤肯、小步舞曲）的健康"));
  if (LONG_HAIR.test(breed)) picked.push(...byTitle("長毛與扁臉"));
  picked.push(...byTitle("遺傳疾病", "價格區間"));
  return [...new Set(picked)];
}

function bigrams(text: string): Set<string> {
  const clean = text.replace(/[\s，。、？！「」（）:：,.?!]/g, "");
  const out = new Set<string>();
  for (let i = 0; i < clean.length - 1; i++) out.add(clean.slice(i, i + 2));
  return out;
}

/** Sections for a side question: the two with the most shared character pairs, or none below the threshold. */
export function sectionsForQuestion(question: string, limit = 2): Section[] {
  if (!question) return [];
  const q = bigrams(question);
  return SECTIONS.map((s) => {
    const b = bigrams(s.title + s.body);
    let hits = 0;
    q.forEach((g) => b.has(g) && hits++);
    return { s, hits };
  })
    .filter((x) => x.hits >= 2)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit)
    .map((x) => x.s);
}

export function render(sections: Section[]): string {
  return sections.map((s) => `## ${s.title}\n${s.body}`).join("\n\n");
}
