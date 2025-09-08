// api/rss-supplement.js
// Hanmoto（版元ドットコム）の新刊/近刊RSSを取得 → キーワードスコアで整列 → 速報用リストを返す
// 仕様：days_window が「未指定」のときは期間フィルタをスキップ。pubDate が読めない項目も除外しない。

const { XMLParser } = require("fast-xml-parser");
const { fetch: undiFetch } = require("undici");

const RSS = {
  shinkan: "http://www.hanmoto.com/bd/shinkan/feed/",
  kinkan:  "http://www.hanmoto.com/bd/kinkan/feed/"
};

const jpNow = () => new Date(Date.now() + 9 * 60 * 60 * 1000);
const txt = (x) => (x == null ? "" : String(x));
const onlyDigits = (s) => (s || "").replace(/[^0-9]/g, "");

const scoreMatch = (q, fields) => {
  const terms = (q || "").trim().split(/\s+/).filter(Boolean).map(t => t.toLowerCase());
  if (!terms.length) return 1.0;
  const hay = fields.join(" ").toLowerCase();
  const hit = terms.filter(t => hay.includes(t)).length;
  return hit / terms.length;
};

async function loadRSS(url) {
  const res = await undiFetch(url, { headers: { "User-Agent": "RSS-Supplement/1.0" } });
  const xml = await res.text();
  const obj = new XMLParser({ ignoreAttributes: false }).parse(xml);
  const items = obj?.rss?.channel?.item ?? [];
  const arr = Array.isArray(items) ? items : [items];
  return arr.map(it => ({
    title: txt(it.title),
    link: txt(it.link),
    pubDate: txt(it.pubDate),
    description: txt(it.description)
  }));
}

function extractISBN13(link) {
  const digits = onlyDigits(link);
  if (digits.length < 13) return null;
  const cand = digits.slice(-13);
  return cand.length === 13 ? cand : null;
}

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    const q = (url.searchParams.get("q") || "").trim();

    // days_window が「未指定（パラメータ無し）」なら null → 期間フィルタをスキップ
    const daysWindowParam = url.searchParams.get("days_window");
    const daysWindow = daysWindowParam == null
      ? null
      : Math.min(Math.max(parseInt(daysWindowParam || "14", 10), 1), 90);

    // feeds は shinkan/kinkan を両方デフォルト。?feeds=shinkan&feeds=kinkan の両方にも対応
    const rawFeeds = url.searchParams.getAll("feeds");
    const feeds = (rawFeeds.length ? rawFeeds : ["shinkan", "kinkan"])
      .filter(f => f === "shinkan" || f === "kinkan");

    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "20", 10), 1), 50);

    const now = jpNow();
    const list = [];

    for (const f of feeds) {
      const rssItems = await loadRSS(RSS[f]);
      for (const it of rssItems) {
        // pubDate を安全にパース（失敗したら pubOK=false）
        const pub = it.pubDate ? new Date(it.pubDate) : null;
        const pubOK = pub instanceof Date && !isNaN(pub);

        // ===== フィルタ判定 =====
        let keep = true;
        if (f === "shinkan") {
          // 新刊：過去N日以内。daysWindow===null のときは期間フィルタなし
          if (daysWindow !== null) {
            if (!pubOK) {
              // 日付が読めない場合は通す（速報なので寛容）
              keep = true;
            } else {
              const age = (now.getTime() - pub.getTime()) / 86400000;
              keep = age >= 0 && age <= daysWindow;
            }
          }
        } else {
          // 近刊：未来日。pubDate が読めない場合は通す
          if (pubOK) keep = pub > now;
          else keep = true;
        }
        if (!keep) continue;

        const isbn13 = extractISBN13(it.link);
        const m = scoreMatch(q, [it.title, it.description]);

        list.push({
          feed: f,
          title: it.title,
          link: it.link,
          pubDate: it.pubDate,               // RFC1123文字列
          isbn13,
          match_score: m,                    // 0〜1
          tag: f === "shinkan" ? "recent_release" : "forthcoming"
        });
      }
    }

    // スコア降順 → 日付降順（pubDateが無ければ最後）
    list.sort((a, b) => {
      if (b.match_score !== a.match_score) return b.match_score - a.match_score;
      const ta = a.pubDate ? Date.parse(a.pubDate) : 0;
      const tb = b.pubDate ? Date.parse(b.pubDate) : 0;
      return tb - ta;
    });

    const out = list.slice(0, limit);

    res.setHeader("Access-Control-Allow-Origin", "*"); // GPTs からのCORS対策
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).send(JSON.stringify({ trace_id: `rss_${Date.now()}`, items: out }, null, 2));
  } catch (e) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(500).send(JSON.stringify({ error: String(e) }));
  }
};
