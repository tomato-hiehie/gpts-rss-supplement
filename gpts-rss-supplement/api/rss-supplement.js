import { XMLParser } from "fast-xml-parser";
import { fetch as undiFetch } from "undici";

const RSS = {
  shinkan: "http://www.hanmoto.com/bd/shinkan/feed/",
  kinkan:  "http://www.hanmoto.com/bd/kinkan/feed/"
};

const jpNow = () => new Date(Date.now() + 9 * 60 * 60 * 1000);
const txt = (x) => (x == null ? "" : String(x));
const onlyDigits = (s) => s.replace(/[^0-9]/g, "");

const scoreMatch = (q, fields) => {
  const terms = (q || "").trim().split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
  if (!terms.length) return 1.0;
  const hay = fields.join(" ").toLowerCase();
  const hit = terms.filter((t) => hay.includes(t)).length;
  return hit / terms.length;
};

async function loadRSS(url) {
  const res = await undiFetch(url, { headers: { "User-Agent": "RSS-Supplement/1.0" } });
  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false });
  const obj = parser.parse(xml);
  const items = obj?.rss?.channel?.item ?? [];
  const arr = Array.isArray(items) ? items : [items];
  return arr.map((it) => ({
    title: txt(it.title),
    link: txt(it.link),
    pubDate: txt(it.pubDate),
    description: txt(it.description)
  }));
}

function extractISBN13(link) {
  const digits = onlyDigits(link || "");
  if (!digits || digits.length < 13) return null;
  const cand = digits.slice(-13);
  return cand.length === 13 ? cand : null;
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const q = (url.searchParams.get("q") || "").trim();
    const daysWindow = Math.min(Math.max(parseInt(url.searchParams.get("days_window") || "14", 10), 1), 90);
    const rawFeeds = url.searchParams.getAll("feeds");
    const feeds = (rawFeeds.length ? rawFeeds : ["shinkan","kinkan"]).filter(f => f==="shinkan" || f==="kinkan");
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "20", 10), 1), 50);

    const now = jpNow();
    const list = [];

    for (const f of feeds) {
      const rss = await loadRSS(RSS[f]);
      for (const it of rss) {
        const pub = it.pubDate ? new Date(it.pubDate) : null;
        if (f === "shinkan") {
          if (!pub) continue;
          const age = (now.getTime() - pub.getTime()) / 86400000;
          if (age < 0 || age > daysWindow) continue;
        } else {
          if (!pub || pub <= now) continue;
        }
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

    list.sort((a, b) => {
      if (b.match_score !== a.match_score) return b.match_score - a.match_score;
      return new Date(b.pubDate) - new Date(a.pubDate);
    });

    const out = list.slice(0, limit);
    const body = { trace_id: `rss_${Date.now()}`, items: out };

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*"); // GPTs からの呼び出し用
    res.status(200).send(JSON.stringify(body, null, 2));
  } catch (e) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(500).send(JSON.stringify({ error: String(e) }));
  }
}
