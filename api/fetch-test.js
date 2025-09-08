// 最小の疎通テスト：外部サイトへ fetch できるかを見る
module.exports = async (req, res) => {
  const targets = [
    "https://example.com/",
    "https://www.hanmoto.com/bd/shinkan/feed/",
    "https://www.hanmoto.com/bd/kinkan/feed/",
    "https://r.jina.ai/https://www.hanmoto.com/bd/shinkan/feed/",
    "https://r.jina.ai/https://www.hanmoto.com/bd/kinkan/feed/",
    "https://www.hanmoto.com/bd/search/index.php?enc=UTF-8&action_search_do4api=true&format=R2MODS&flg_searchmode=shousai&ORDERBY=DateShuppan&ORDERBY2=DateShotenhatsubai&SORTORDER=DESC&searchqueryword=%E3%81%AE"
  ];

  const out = [];
  for (const url of targets) {
    const start = Date.now();
    try {
      const r = await fetch(url, { method: "GET" });
      const ct = r.headers.get("content-type");
      out.push({ url, ok: r.ok, status: r.status, contentType: ct, ms: Date.now() - start });
    } catch (e) {
      out.push({ url, ok: false, error: String(e), ms: Date.now() - start });
    }
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(200).send(JSON.stringify({ time: new Date().toISOString(), results: out }, null, 2));
};
