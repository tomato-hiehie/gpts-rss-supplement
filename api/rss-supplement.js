const { XMLParser } = require("fast-xml-parser");
const { fetch: undiFetch } = require("undici");
const iconv = require("iconv-lite");

// 1) 新刊・近刊（公式RSS2.0）
const ORIG = {
  shinkan: "http://www.hanmoto.com/bd/shinkan/feed/",
  kinkan:  "http://www.hanmoto.com/bd/kinkan/feed/"
};
const ORIG_HTTPS = {
  shinkan: "https://www.hanmoto.com/bd/shinkan/feed/",
  kinkan:  "https://www.hanmoto.com/bd/kinkan/feed/"
};
// 2) 公開CDNプロキシ（読み取りのみ）
const VIA_JINA_HTTP = {
  shinkan: "https://r.jina.ai/http://www.hanmoto.com/bd/shinkan/feed/",
  kinkan:  "https://r.jina.ai/http://www.hanmoto.com/bd/kinkan/feed/"
};
const VIA_JINA_HTTPS = {
  shinkan: "https://r.jina.ai/https://www.hanmoto.com/bd/shinkan/feed/",
  kinkan:  "https://r.jina.ai/https://www.hanmoto.com/bd/kinkan/feed/"
};
// 3) 検索結果フィード（RSS2.0） 例：…/search/index.php?...&action_search_do4feed=true&searchqueryword=〇〇
const SEARCH_BASE = "https://www.hanmoto.com/bd/search/index.php";
function buildSearchFeedURL(q) {
  // 代表的な推奨パラメータ（仕様引用）
  const params = new URLSearchParams({
    enc: "UTF-8",
    action_search_do4feed: "true",
    flg_searchmode: "shousai",
    ORDERBY: "DateShuppan",        // 刊行日
    ORDERBY2: "DateShotenhatsubai",// 書店発売日
    SORTORDER: "DESC",
    searchqueryword: q || ""       // テーマ語（空でも可）
  });
  return `${SEARCH_BASE}?${params.toString()}`;
}

const FETCH_ROUTE = [ORIG, ORIG_HTTPS, VIA_JINA_HTTP, VIA_JINA_HTTPS];

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

// 文字コード自動判定→UTF-8文字列
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

// RSS/Atom 正規化
function normalizeParsed(obj) {
  const rssItems = obj?.rss?.channel?.item;
  if (rssItems) {
    const arr = Array.isArray(rssItems) ? rssItems : [rssItems];
    return {
      mode: "rss",
      items: arr.map(it => ({
        title: txt(it.title),
        link: txt(typeof it.link === "object" ? it.link?.["@_href"] : it.link),
        pubDate: txt(it.pubDate || it["dc:date"] || it["dcterms:date"]),
        description: txt(it["content:encoded"] ?? it.description ?? "")
      }))
    };
  }
  const atomEntries = obj?.feed?.entry;
  if (atomEntries) {
    const arr = Array.isArray(atomEntries) ? atomEntries : [atomEntries];
    return {
      mode: "atom",
      items: arr.map(en => {
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
      })
    };
  }
  return { mode: "none", items: [] };
}

async function fetchOnce(url) {
  const res = await undiFetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      "Accept": "application/rss+xml, application/atom+xml, text/xml;q=0.9, */*;q=0.8"
    }
  });
  const ab = await res.arrayBuffer();
  const raw = Buffer.from(ab);
  const { text: xml, detected } = decodeBuffer(raw, res.headers.get("content-type") || "");
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  let parsed, norm = { mode: "none", items: [] }, parseError = null;
  try {
    parsed = parser.parse(xml);
    norm = normalizeParsed(parsed);
  } catch (e) {
    parseError = String(e);
  }
  return {
    status: res.status,
    contentType: res.headers.get("content-type") || "",
    detectedEncoding: detected,
    bytes: raw.length,
    mode: norm.mode,
    items: norm.items,
    parseError,
    xmlSnippet: xml.slice(0, 200)
  };
}

// route: 新刊/近刊 → だめなら 検索結果フィード(q)
async function loadFeedSmart(feedKey, qForSearch) {
  // 直接→https→jina(http)→jina(https)
  for (const route of FETCH_ROUTE) {
    const url = route[feedKey];
    try {
      const r = await fetchOnce(url);
      if ((r.status >= 200 && r.status < 300) && r.items.length > 0) {
        return { used: url, kind: "official", ok: true, ...r };
      }
    } catch {}
  }
  // 検索結果フィードに切替（q が空でも新着が返る）
  const searchUrl = buildSearchFeedURL(qForSearch);
  const r = await fetchOnce(searchUrl);
  return { used: searchUrl, kind: "search", ok: (r.status >= 200 && r.status < 300), ...r };
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
    const out = [];
    const debug = [];

    for (const f of feeds) {
      const r = await loadFeedSmart(f, q);
      debug.push({
        feed: f,
        used: r.used,
        routeKind: r.kind, // "official" or "search"
        ok: r.ok,
        status: r.status,
        contentType: r.contentType,
        encoding: r.detectedEncoding,
        mode: r.mode,
        bytes: r.bytes,
        parseError: r.parseError,
        sampleTitle: r.items[0]?.title || "",
        xmlSnippet: r.xmlSnippet
      });

      for (const it of r.items) {
        const pub = it.pubDate ? new Date(it.pubDate) : null;
        const pubOK = pub instanceof Date && !isNaN(pub);

        let keep = true;
        if (f === "shinkan") {
          if (daysWindow !== null) {
            keep = pubOK ? ((now - pub) / 86400000 <= daysWindow && (now - pub) >= 0) : true;
          }
        } else {
          keep = pubOK ? (pub > now) : true; // 近刊は未来
        }
        if (!keep) continue;

        const isbn13 = extractISBN13(it.link);
        const m = scoreMatch(q, [it.title, it.description]);

        out.push({
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

    out.sort((a, b) => {
      if (b.match_score !== a.match_score) return b.match_score - a.match_score;
      const ta = a.pubDate ? Date.parse(a.pubDate) : 0;
      const tb = b.pubDate ? Date.parse(b.pubDate) : 0;
      return tb - ta;
    });

    const payload = { trace_id: `rss_${Date.now()}`, items: out.slice(0, limit) };
    if (debugMode) payload.debug = debug;

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).send(JSON.stringify(payload, null, 2));
  } catch (e) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(500).send(JSON.stringify({ error: String(e) }));
  }
};
