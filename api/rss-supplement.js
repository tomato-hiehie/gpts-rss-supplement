// Hanmoto（版元ドットコム）新刊/近刊フィード → キーワードでスコアリングして返す
// 対応：RSS2.0 / Atom、Shift_JIS・EUC-JP・UTF-8 の自動判定、days_window未指定なら期間フィルタ無効

const { XMLParser } = require("fast-xml-parser");
const { fetch: undiFetch } = require("undici");
const iconv = require("iconv-lite");

const FEEDS = {
  shinkan: "http://www.hanmoto.com/bd/shinkan/feed/",
  kinkan:  "http://www.hanmoto.com/bd/kinkan/feed/"
};

const jpNow = () => new Date(Date.now() + 9 * 60 * 60 * 1000);
const txt = (x) => (x == null ? "" : String(x));
const onlyDigits = (s) => (s || "").replace(/[^0-9]/g, "");

// ---- keyword match 0..1
function scoreMatch(q, fields) {
  const terms = (q || "").trim().split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
  if (!terms.length) return 1.0;
  const hay = fields.join(" ").toLowerCase();
  const hit = terms.filter((t) => hay.includes(t)).length;
  return hit / terms.length;
}

// ---- charset 判定 → UTF-8文字列へ
function decodeBuffer(buf, contentTypeHeader) {
  // 1) HTTPヘッダ優先
  let charset = "";
  if (contentTypeHeader) {
    const m = /charset\s*=\s*("?)([^";\s]+)\1/i.exec(contentTypeHeader);
    if (m) charset = m[2].toLowerCase();
  }
  // 2) ヘッダに無ければ、先頭数KBをUTF-8仮デコードして XML宣言を覗く
  if (!charset) {
    const probe = buf.subarray(0, 2048).toString(); // NodeはBuffer→latin1だが宣言はASCII圏なので読み取れる
    const m2 = /<\?xml[^>]*encoding=["']([^"']+)["']/i.exec(probe);
    if (m2) charset = m2[1].toLowerCase();
  }
  // 3) 見つからなければUTF-8扱い
  if (!charset || charset === "utf8") charset = "utf-8";

  // iconv-lite が知っている名前に寄せる
  const map = { "shift-jis": "shift_jis", "shift_jis": "shift_jis", "sjis": "shift_jis", "euc-jp": "euc-jp" };
  const enc = map[charset] || charset;

  try {
    return iconv.decode(Buffer.from(buf), enc);
  } catch {
    // 失敗時はUTF-8でフォールバック
    return Buffer.from(buf).toString("utf-8");
  }
}

// ---- RSS/Atom を正規化: [{title, link, pubDate, description}]
async function loadFeed(url) {
  const res = await undiFetch(url, { headers: { "User-Agent": "RSS-Supplement/1.2 (+Vercel)" } });
  const arrayBuf = await res.arrayBuffer();
  const raw = Buffer.from(arrayBuf);
  const xml = decodeBuffer(raw, res.headers.get("content-type") || "");

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseTagValue: true,
  });
  let obj;
  try {
    obj = parser.parse(xml);
  } catch {
    return [];
  }

  // --- RSS2.0 ---
  const rssItems = obj?.rss?.channel?.item;
  if (rssItems) {
    const arr = Array.isArray(rssItems) ? rssItems : [rssItems];
    return arr.map((it) => ({
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
    return arr.map((en) => {
      let link = "";
      if (Array.isArray(en.link)) {
        const alt = en.link.find((l) => (l["@_rel"] ?? "alternate") === "alternate") || en.link[0];
        link = txt(alt?.["@_href"]);
      } else if (typeof en.link === "object") {
        link = txt(en.link?.["@_href"]);
      } else {
        link = txt(en.link);
      }
      const body = txt(en["content:encoded"] ?? en.content?.["#text"] ?? en.content ?? en.summary ?? "");
      const when = txt(en.updated ?? en.published ?? "");
      return { title: txt(en.title?.["#text"] ?? en.title), link, pubDate: when, description: body };
    });
  }

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

    // days_window 未指定(null) → 新刊の期間フィルタをスキップ
    const daysParam = url.searchParams.get("days_window");
    const daysWindow = daysParam == null ? null : Math.min(Math.max(parseInt(daysParam || "14", 10), 1), 90);

    const rawFeeds = url.searchParams.getAll("feeds");
    const feeds = (rawFeeds.length ? rawFeeds : ["shinkan", "kinkan"]).filter((f) => f === "shinkan" || f === "kinkan");

    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "20", 10), 1), 50);

    const now = jpNow();
    const list = [];

    for (const f of feeds) {
      const items = await loadFeed(FEEDS[f]);
      for (const it of items) {
        const pub = it.pubDate ? new Date(it.pubDate) : null;
        const pubOK = pub instanceof Date && !isNaN(pub);

        // ---- フィルタ ----
        let keep = true;
        if (f === "shinkan") {
          if (daysWindow !== null) {
            if (pubOK) {
              const age = (now.getTime() - pub.getTime()) / 86400000;
              keep = age >= 0 && age <= daysWindow;
            } else {
              keep = true; // 日付不明は通す（速報用途）
            }
          }
        } else {
          // 近刊：未来日。日付不明は通す
          keep = pubOK ? pub > now : true;
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

    // スコア降順 → 日付降順（無いものは最後）
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
