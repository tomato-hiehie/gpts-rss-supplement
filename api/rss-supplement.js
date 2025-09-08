// Hanmoto 新刊/近刊の RSS/Atom を取得して正規化して返す
// ・RSS2 / Atom 両対応
// ・Shift_JIS / EUC-JP / UTF-8 自動判定
// ・days_window 未指定なら新刊の期間フィルタをスキップ
// ・?debug=1 を付けると取得状況を debug セクションに返す（本番応答は items はそのまま）

const { XMLParser } = require("fast-xml-parser");
const { fetch: undiFetch } = require("undici");
const iconv = require("iconv-lite");

const FEEDS_PRIMARY = {
  shinkan: "http://www.hanmoto.com/bd/shinkan/feed/",
  kinkan:  "http://www.hanmoto.com/bd/kinkan/feed/"
};
const FEEDS_FALLBACK = {
  shinkan: "https://www.hanmoto.com/bd/shinkan/feed/",
  kinkan:  "https://www.hanmoto.com/bd/kinkan/feed/"
};

const jpNow = () => new Date(Date.now() + 9 * 60 * 60 * 1000);
const txt = (x) => (x == null ? "" : String(x));
const onlyDigits = (s) => (s || "").replace(/[^0-9]/g, "");

// 0..1 の簡易一致スコア
function scoreMatch(q, fields) {
  const terms = (q || "").trim().split(/\s+/).filter(Boolean).map(t => t.toLowerCase());
  if (!terms.length) return 1.0;
  const hay = fields.join(" ").toLowerCase();
  const hit = terms.filter(t => hay.includes(t)).length;
  return hit / terms.length;
}

// charset を判定して UTF-8 に
function decodeBuffer(buf, contentTypeHeader) {
  let charset = "";
  if (contentTypeHeader) {
    const m = /charset\s*=\s*("?)([^";\s]+)\1/i.exec(contentTypeHeader);
    if (m) charset = m[2].toLowerCase();
  }
  if (!charset) {
    const probe = Buffer.from(buf.subarray(0, 2048)).toString();
    const m2 = /<\?xml[^>]*encoding=["']([^"']+)["']/i.exec(probe);
    if (m2) charset = m2[1].toLowerCase();
  }
  if (!charset || charset === "utf8") charset = "utf-8";
  const map = { "shift-jis": "shift_jis", "sjis": "shift_jis", "shift_jis": "shift_jis", "euc-jp": "euc-jp" };
  const enc = map[charset] || charset;

  try {
    return { text: iconv.decode(Buffer.from(buf), enc), detected: enc };
  } catch {
    return { text: Buffer.from(buf).toString("utf-8"), detected: "utf-8(fallback)" };
  }
}

// RSS/Atom を [{title, link, pubDate, description}], mode: 'rss'|'atom'|'none'
function normalizeParsed(obj) {
  // RSS2.0
  const rssItems = obj?.rss?.channel?.item;
  if (rssItems) {
    const arr = Array.isArray(rssItems) ? rssItems : [rssItems];
    const items = arr.map(it => ({
      title: txt(it.title),
      link: txt(typeof it.link === "object" ? it.link?.["@_href"] : it.link),
      pubDate: txt(it.pubDate || it["dc:date"]),
      description: txt(it["content:encoded"] ?? it.description ?? "")
    }));
    return { mode: "rss", items };
  }
  // Atom
  const atomEntries = obj?.feed?.entry;
  if (atomEntries) {
    const arr = Array.isArray(atomEntries) ? atomEntries : [atomEntries];
    const items = arr.map(en => {
      let link = "";
      if (Array.isArray(en.link)) {
        const alt = en.link.find(l => (l["@_rel"] ?? "alternate") === "alternate") || en.link[0];
        link = txt(alt?.["@_href"]);
      } else if (typeof en.link === "object") {
        link = txt(en.link?.["@_href"]);
      } else link = txt(en.link);
      const body = txt(en["content:encoded"] ?? en.content?.["#text"] ?? en.content ?? en.summary ?? "");
      const when = txt(en.updated ?? en.published ?? "");
      return { title: txt(en.title?.["#text"] ?? en.title), link, pubDate: when, description: body };
    });
    return { mode: "atom", items };
  }
  return { mode: "none", items: [] };
}

// フィード1本取得（プライマリ → 失敗したらフォールバック）
async function fetchFeedOnce(url) {
  const res = await undiFetch(url, {
    headers: {
      // 一部のサイトは UA で弾くため一般ブラウザ風に
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
    }
  });
  const arrayBuf = await res.arrayBuffer();
  const raw = Buffer.from(arrayBuf);
  const { text: xml, detected } = decodeBuffer(raw, res.headers.get("content-type") || "");
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: true });
  let parsed; let norm = { mode: "none", items: [] }; let parseError = null;
  try {
    parsed = parser.parse(xml);
    norm = normalizeParsed(parsed);
  } catch (e) {
    parseError = String(e);
  }
  return {
    status: res.status,
    contentType: res.headers.get("content-type") || "",
    bytes: raw.length,
    detectedEncoding: detected,
    mode: norm.mode,
    items: norm.items,
    parseError,
    xmlSnippet: xml.slice(0, 200) // debug 用に先頭だけ
  };
}

async function loadFeedSmart(feedKey) {
  // 1st: http://, 2nd: https://
  const primary = await fetchFeedOnce(FEEDS_PRIMARY[feedKey]);
  if (primary.items.length > 0 || primary.status === 200) return { used: "primary", ...primary };
  const fallback = await fetchFeedOnce(FEEDS_FALLBACK[feedKey]);
  return { used: "fallback", ...fallback };
}

function extractISBN13(link) {
  const d = onlyDigits(link);
  if (d.length < 13) return null;
  const cand = d.slice(-13);
  return cand.length === 13 ? cand : null;
}

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const q = (url.searchParams.get("q") || "").trim();
    const debugMode = url.searchParams.get("debug") === "1";

    const daysParam = url.searchParams.get("days_window");
    const daysWindow = daysParam == null ? null : Math.min(Math.max(parseInt(daysParam || "14", 10), 1), 90);

    const rawFeeds = url.searchParams.getAll("feeds");
    const feeds = (rawFeeds.length ? rawFeeds : ["shinkan", "kinkan"])
      .filter(f => f === "shinkan" || f === "kinkan");

    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "20", 10), 1), 50);

    const now = jpNow();
    const itemsOut = [];
    const debugInfo = [];

    for (const f of feeds) {
      const result = await loadFeedSmart(f);
      debugInfo.push({
        feed: f,
        request: result.used,
        status: result.status,
        contentType: result.contentType,
        bytes: result.bytes,
        encoding: result.detectedEncoding,
        mode: result.mode,
        parseError: result.parseError,
        sampleTitle: result.items[0]?.title || "",
        xmlSnippet: result.xmlSnippet
      });

      for (const it of result.items) {
        const pub = it.pubDate ? new Date(it.pubDate) : null;
        const pubOK = pub instanceof Date && !isNaN(pub);

        let keep = true;
        if (f === "shinkan") {
          if (daysWindow !== null) {
            if (pubOK) {
              const age = (now - pub) / 86400000;
              keep = age >= 0 && age <= daysWindow;
            } else keep = true; // 日付不明は通す
          }
        } else {
          keep = pubOK ? pub > now : true; // 近刊は未来、日付不明は通す
        }
        if (!keep) continue;

        const isbn13 = extractISBN13(it.link);
        const m = scoreMatch(q, [it.title, it.description]);

        itemsOut.push({
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

    // スコア降順 → 日付降順
    itemsOut.sort((a, b) => {
      if (b.match_score !== a.match_score) return b.match_score - a.match_score;
      const ta = a.pubDate ? Date.parse(a.pubDate) : 0;
      const tb = b.pubDate ? Date.parse(b.pubDate) : 0;
      return tb - ta;
    });

    const payload = { trace_id: `rss_${Date.now()}`, items: itemsOut.slice(0, limit) };
    if (debugMode) payload.debug = debugInfo;

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).send(JSON.stringify(payload, null, 2));
  } catch (e) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(500).send(JSON.stringify({ error: String(e) }));
  }
};
