// Hanmoto 新刊/近刊を r.jina.ai 経由で取得して補足JSONを返す（直アクセスは500のためプロキシ固定）
// ・RSS2.0 / Atom 対応
// ・Shift_JIS / EUC-JP / UTF-8 自動判定
// ・days_window 未指定なら新刊の期間フィルタをスキップ
// ・?debug=1 で取得メタを返す

const { XMLParser } = require("fast-xml-parser");
const { fetch: undiFetch } = require("undici");
const iconv = require("iconv-lite");

// プロキシ固定（直は500のため使わない）
const FEEDS = {
  shinkan: "https://r.jina.ai/https://www.hanmoto.com/bd/shinkan/feed/",
  kinkan:  "https://r.jina.ai/https://www.hanmoto.com/bd/kinkan/feed/"
};

const jpNow = () => new Date(Date.now() + 9 * 60 * 60 * 1000);
const txt = (x) => (x == null ? "" : String(x));
const onlyDigits = (s) => (s || "").replace(/[^0-9]/g, "");

// 0..1 簡易一致スコア
function scoreMatch(q, fields) {
  const terms = (q || "").trim().split(/\s+/).filter(Boolean).map(t => t.toLowerCase());
  if (!terms.length) return 1.0;
  const hay = fields.join(" ").toLowerCase();
  const hit = terms.filter(t => hay.includes(t)).length;
  return hit / terms.length;
}

// 文字コード自動判定 → UTF-8文字列
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

// RSS/Atom 正規化
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

async function fetchFeed(url) {
  const meta = { url, status: null, contentType: null, detectedEncoding: null, bytes: 0, mode: "none", error: null };
  try {
    const r = await undiFetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        "Accept": "application/rss+xml, application/atom+xml, text/xml;q=0.9, text/plain;q=0.8, */*;q=0.7"
      }
    });
    meta.status = r.status;
    meta.contentType = r.headers.get("content-type") || "";
    const ab = await r.arrayBuffer();
    const raw = Buffer.from(ab);
    meta.bytes = raw.length;

    const { text: xml, detected } = decodeBuffer(raw, meta.contentType);
    meta.detectedEncoding = detected;

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      allowBooleanAttributes: true,
      // Atom/RSS混在のエンティティを無難に処理
      processEntities: true
    });

    let parsed;
    try {
      parsed = parser.parse(xml);
      const norm = normalizeParsed(parsed);
      meta.mode = norm.mode;
      return { items: norm.items, meta, xmlSnippet: xml.slice(0, 200) };
    } catch (e) {
      meta.error = `parse-error: ${String(e)}`;
      return { items: [], meta, xmlSnippet: xml.slice(0, 200) };
    }
  } catch (e) {
    meta.error = `fetch-error: ${String(e)}`;
    return { items: [], meta, xmlSnippet: "" };
  }
}

const txtLower = (s) => (s || "").toLowerCase();

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

    // days_window 未指定(null) → 新刊の期間フィルタなし
    const daysParam = url.searchParams.get("days_window");
    const daysWindow = daysParam == null ? null : Math.min(Math.max(parseInt(daysParam || "14", 10), 1), 90);

    // feeds：デフォルト両方
    const rawFeeds = url.searchParams.getAll("feeds");
    const feeds = (rawFeeds.length ? rawFeeds : ["shinkan", "kinkan"])
      .filter(f => f === "shinkan" || f === "kinkan");

    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "20", 10), 1), 50);

    const now = jpNow();
    const out = [];
    const dbg = [];

    for (const f of feeds) {
      const r = await fetchFeed(FEEDS[f]);
      dbg.push({ feed: f, ...r.meta, xmlSnippet: r.xmlSnippet });

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

        // キーワード一致（タイトル＋本文に対して）
        const m = scoreMatch(q, [it.title, it.description]);
        if (q && m === 0) continue;

        const isbn13 = extractISBN13(it.link);

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
    if (debugMode) payload.debug = dbg;

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).send(JSON.stringify(payload, null, 2));
  } catch (e) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(500).send(JSON.stringify({ error: String(e) }));
  }
};
