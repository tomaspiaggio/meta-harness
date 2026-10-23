// Offline fallback only. A configured cheap utility model or the active agent
// can supply a semantic title without making naming a prerequisite for work.
export function fallbackSessionTitle(prompt: string): string {
  const ignored = new Set(
    "a an the i me my we our you your it its is are was were be been being to of in on at by for from with and or but that this these those as if then than not can could would should will want like need please help lets let us do does did have has had get got some something anything everything about how what why when where who which every each also just really much more most make give use using start first configure create task session conversation today tomorrow now go check update updates show tell know done thank thanks".split(
      " ",
    ),
  );
  const tokens =
    prompt.slice(0, 3000).match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
  const candidates = new Map<
    string,
    { word: string; first: number; count: number }
  >();
  tokens.forEach((word, index) => {
    const key = word.toLowerCase();
    if (
      ignored.has(key) ||
      word.length < 3 ||
      word.length > 28 ||
      /^\d+$/.test(word)
    )
      return;
    const previous = candidates.get(key);
    if (previous) previous.count++;
    else candidates.set(key, { word, first: index, count: 1 });
  });
  const chosen = [...candidates.values()]
    .sort(
      (a, b) =>
        b.count + (b.first < 16 ? 1 : 0) - (a.count + (a.first < 16 ? 1 : 0)) ||
        a.first - b.first,
    )
    .slice(0, 4)
    .sort((a, b) => a.first - b.first);
  let title = chosen.map((item) => item.word).join(" ");
  while (title.length > 45 && title.includes(" "))
    title = title.slice(0, title.lastIndexOf(" "));
  return title ? title[0].toUpperCase() + title.slice(1) : "New conversation";
}
