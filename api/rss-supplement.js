// api/rss-supplement.js
// Hanmoto（版元ドットコム）の新刊/近刊フィードを取得。
// RSS2.0 (<rss><channel><item>) と ATOM (<feed><entry>) の両方をサポート。
// ・days_window 未指定 → 新刊の期間フィルタをスキップ
// ・pubDate/updated を解釈できない場合も除外しない（速報用途）

const { XMLParser } = require("fast-xml-parser");
const { fetch: undiFetch } = require("undici");

const RSS = {
  shinkan: "http://www.hanmoto.com/bd/shinkan/feed/",
  kinkan:  "http://www.hanmoto.com/bd/kinkan/feed/"
};

const jpNow = () => new Date(Date.now() + 9 * 60 * 60 * 1000);
const txt = (x) => (x == null ? "" : String(x));
const onlyDigits = (s) => (s || "").replace(/[^0-9]/g, "");

function scoreMatch(q, fields) {
  const terms = (q || "").trim().split(/\s+/).filter(Boolean).map(t => t.toLowerCase());
  if (!terms.length) return 1.0;
  const hay = fields.join(" ").toLowerCase();
  const hit = terms.filter(t => hay.includes(t)).length;
  return hit / terms.length;
}

// RSS2.0 と Atom の両方を吸収して {title, link, pubDate, description} に正規化
async function loadFeed(url) {
  const res = await undiFetch(url, { headers: { "User-Agent": "RSS-Supplement/1.1" } });
  const xml = await res.text();

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseTagValue: true,
  });
  const obj = parser.parse(xml);

  // --- RSS2.0 ---
  const rssItems = obj?.rss?.channel?.item;
  if (rssItems) {
    const arr = Array.isArray(rssItems) ? rssItems : [rssItems];
    return arr.map(it => ({
      title: txt(it.title),
      link: txt(typeof it.link === "object" ? it.link?.["@_href"] : it.link),
      pubDate: txt(it.pubDate || it["dc:date"]),
      description: txt(it["content:encoded"] ?? it.description ?? "")
    }));
  }

  // --- Atom ---
  const atomEntries = obj?.feed?.entry;
  if (atomEntries) {
    const arr = Array.isArray(atomEntries) ? atomEntries : [atomEntries];
    return arr.map(en => {
      // <link> は配列のことが多く、@_href にURLが入る
      let link = "";
      if (Array.isArray(en.link)) {
        const alt = en.link.find(l => (l["@_rel"] ?? "alternate") === "alternate") || en.link[0];
        link = txt(alt?.["@_href"]);
      } else if (typeof en.link === "object") {
        link = txt(en.link?.["@_href"]);
      } else {
        link = txt(en.link);
      }
      // 本文は <content> or <summary>
      const body = txt(en.content?.["#text"] ?? en.content ?? en.summary ?? "");
      // 日付は <updated> or <published>
      const when = txt(en.updated ?? en.published ?? "");

      return {
        title: txt(en.title?.["#text"] ?? en.title),
        link,
        pubDate: when,
        description: body
      };
    });
  }

  // どちらでも無かった場合は空配列
  return [];
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

    // days_window が未指定なら null（＝新刊の期間フィルタをスキップ）
    const daysWindowParam = url.searchParams.get("days_window");
    const daysWindow = daysWindowParam == null
      ? null
      : Math.min(Math.max(parseInt(daysWindowParam || "14", 10), 1), 90);

    // feeds：デフォルト両方
    const rawFeeds = url.searchParams.getAll("feeds");
    const feeds = (rawFeeds.length ? rawFeeds : ["shinkan", "kinkan"])
      .filter(f => f === "shinkan" || f === "kinkan");

    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "20", 10), 1), 50);

    const now = jpNow();
    const list = [];

    for (const f of feeds) {
      const items = await loadFeed(RSS[f]);
      for (const it of items) {
        // pubDate parse（Atom/RSSいずれも文字列想定）
        const pub = it.pubDate ? new Date(it.pubDate) : null;
        const pubOK = pub instanceof Date && !isNaN(pub);

        // ---- フィルタ ----
        let keep = true;
        if (f === "shinkan") {
          if (daysWindow !== null) {
            if (!pubOK) {
              keep = true; // 日付不明は通す（速報用途）
            } else {
              const age = (now - pub) / 86400000;
              keep = age >= 0 && age <= daysWindow;
            }
          }
        } else {
          // 近刊は未来日。日付不明なら通す
          keep = pubOK ? (pub > now) : true;
        }
        if (!keep) continue;

        const isbn13 = extractISBN13(it.link);
        const m = scoreMatch(q, [it.title, it.description]);

        list.push({
          feed: f,
          title: it.title,
          link: it.link,
          pubDate: it.pubDate,
          isbn13,
          match_score: m,
          tag: f === "shinkan" ? "recent_release" : "forthcoming"
        });
      }
    }

    // スコア降順→日付降順（ないものは最後）
    list.sort((a, b) => {
      if (b.match_score !== a.match_score) return b.match_score - a.match_score;
      const ta = a.pubDate ? Date.parse(a.pubDate) : 0;
      const tb = b.pubDate ? Date.parse(b.pubDate) : 0;
      return tb - ta;
    });

    const out = list.slice(0, limit);

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).send(JSON.stringify({ trace_id: `rss_${Date.now()}`, items: out }, null, 2));
  } catch (e) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(500).send(JSON.stringify({ error: String(e) }));
  }
};
