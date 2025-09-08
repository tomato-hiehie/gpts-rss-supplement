// Hanmoto（版元ドットコム）の新刊/近刊フィードを取得し、補足用の簡易JSONに整形して返す。
// 特徴：
// ・RSS2.0 / Atom 両対応
// ・Shift_JIS / EUC-JP / UTF-8 を自動判定してデコード
// ・到達順フォールバック：公式（http→https）→ r.jina.ai（http→https）→ 検索API RSS（R2MODS→MRSS、直/経由）
// ・days_window 未指定なら新刊の期間フィルタをスキップ（拾いやすい）
// ・?debug=1 で取得経路とメタ情報を返す

const { XMLParser } = require("fast-xml-parser");
const { fetch: undiFetch } = require("undici");
const iconv = require("iconv-lite");

// 公式 新刊/近刊
const ORIG = {
  shinkan: "http://www.hanmoto.com/bd/shinkan/feed/",
  kinkan:  "http://www.hanmoto.com/bd/kinkan/feed/"
};
const ORIG_HTTPS = {
  shinkan: "https://www.hanmoto.com/bd/shinkan/feed/",
  kinkan:  "https://www.hanmoto.com/bd/kinkan/feed/"
};
// 公開プロキシ（読み取り専用）
const VIA_JINA_HTTP = {
  shinkan: "https://r.jina.ai/http://www.hanmoto.com/bd/shinkan/feed/",
  kinkan:  "https://r.jina.ai/http://www.hanmoto.com/bd/kinkan/feed/"
};
const VIA_JINA_HTTPS = {
  shinkan: "https://r.jina.ai/https://www.hanmoto.com/bd/shinkan/feed/",
  kinkan:  "https://r.jina.ai/https://www.hanmoto.com/bd/kinkan/feed/"
};
// 公式検索API（R2MODS / MRSS）※RSS2.0でXMLを返す
const SEARCH_BASE = "https://www.hanmoto.com/bd/search/index.php";
function buildSearchUrl(format, q) {
  const keyword = (q && q.trim()) ? q.trim() : "の"; // q省略時の代替（広く拾える高頻度語）
  const p = new URLSearchParams({
    enc: "UTF-8",
    action_search_do4api: "true",
    format, // "R2MODS" か "MRSS"
    flg_searchmode: "shousai",
    ORDERBY: "DateShuppan",
    ORDERBY2: "DateShotenhatsubai",
    SORTORDER: "DESC",
    searchqueryword: keyword
  });
  return `${SEARCH_BASE}?${p.toString()}`;
}

// 公式ルート → プロキシルート
const OFFICIAL_ROUTES = [ORIG, ORIG_HTTPS, VIA_JINA_HTTP, VIA_JINA_HTTPS];

const jpNow = () => new Date(Date.now() + 9 * 60 * 60 * 1000);
const txt = (x) => (x == null ? "" : String(x));
const onlyDigits = (s) => (s || "").replace(/[^0-9]/g, "");

// 簡易一致スコア（0..1）
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

  try { return { text: iconv.decode(Buffer.from(buf), enc), detected: enc }; }
  catch { return { text: Buffer.from(buf).toString("utf-8"), detected: "utf-8(fallback)" }; }
}

// RSS/Atom → {mode, items:[{title,link,pubDate,description}]}
function normalizeParsed(obj) {
  // RSS2.0
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
  // Atom
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
        } else if (typeof en.link === "object") link = txt(en.link?.["@_href"]);
        else link = txt(en.link);
        const body = txt(en["content:encoded"] ?? en.content?.["#text"] ?? en.content ?? en.summary ?? "");
        const when = txt(en.updated ?? en.published ?? "");
        return { title: txt(en.title?.["#text"] ?? en.title), link, pubDate: when, description: body };
      })
    };
  }
  return { mode: "none", items: [] };
}

// 1回取得
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
  // r.jina.ai は text/plain で返すこともあるので、ヘッダは参考程度に
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

// 公式→プロキシ→検索API(R2MODS→MRSS、直→jina) の順で取得
async function loadFeedSmart(feedKey, qForSearch) {
  // 1) 公式/プロキシ
  for (const route of OFFICIAL_ROUTES) {
    const url = route[feedKey];
    try {
      const r = await fetchOnce(url);
      if ((r.status >= 200 && r.status < 300) && r.items.length > 0) {
        return { used: url, routeKind: "official", ok: true, ...r };
      }
    } catch {}
  }
  // 2) 検索API（R2MODS → MRSS）
  for (const fmt of ["R2MODS", "MRSS"]) {
    const searchUrl = buildSearchUrl(fmt, qForSearch);
    // 直
    try {
      let r = await fetchOnce(searchUrl);
      if ((r.status >= 200 && r.status < 300) && r.items.length > 0) {
        return { used: searchUrl, routeKind: `search:${fmt}`, ok: true, ...r };
      }
      // Jina 経由
      const via = "https://r.jina.ai/" + searchUrl.replace(/^https?:\/\//, "");
      r = await fetchOnce(via);
      if ((r.status >= 200 && r.status < 300) && r.items.length > 0) {
        return { used: via, routeKind: `search:${fmt}:jina`, ok: true, ...r };
      }
    } catch {}
  }
  // 全滅
  return {
    used: null, routeKind: "failed", ok: false,
    status: 0, contentType: "", detectedEncoding: "", bytes: 0,
    mode: "none", items: [], parseError: "all routes failed", xmlSnippet: ""
  };
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

    // days_window 未指定(null) → 新刊の期間フィルタをスキップ
    const daysParam = url.searchParams.get("days_window");
    const daysWindow = daysParam == null ? null : Math.min(Math.max(parseInt(daysParam || "14", 10), 1), 90);

    // feeds デフォルト：両方
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
        routeKind: r.routeKind,
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

        // フィルタ
        let keep = true;
        if (f === "shinkan") {
          if (daysWindow !== null) {
            keep = pubOK ? ((now - pub) / 86400000 <= daysWindow && (now - pub) >= 0) : true;
          }
        } else {
          keep = pubOK ? (pub > now) : true; // 近刊は未来日。日付不明は通す
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

    // スコア降順 → 日付降順
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
