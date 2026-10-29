/**
 * Cloudflare Pages Advanced Mode Worker
 * Public, directly accessible Aparat videos only.
 * Static files are served through env.ASSETS.
 */
const API_BASE = "https://www.aparat.com/api/fa/v1/video/video/show/videohash/";
const ALLOWED_PAGE_HOSTS = new Set(["aparat.com", "www.aparat.com", "m.aparat.com"]);
const ALLOWED_MEDIA_HOST_RE = /(^|\.)asset\.aparat\.com$/i;
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}
function getVideoId(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("لینک معتبر نیست."); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("فقط لینک HTTP/HTTPS پذیرفته می‌شود.");
  if (!ALLOWED_PAGE_HOSTS.has(url.hostname.toLowerCase())) throw new Error("لطفاً فقط لینک‌های دامنه aparat.com را وارد کن.");
  const parts = url.pathname.split("/").filter(Boolean);
  let id = "";
  if (parts[0] === "v" && parts[1]) id = parts[1];
  else if (parts[0] === "video" && parts[1] === "video" && parts[2] === "embed" && parts[3] === "videohash" && parts[4]) id = parts[4];
  else if (parts[0] === "shorts" && parts[1]) id = parts[1];
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(id)) throw new Error("فرمت لینک پشتیبانی نمی‌شود. لینک یک ویدیوی آپارات با قالب /v/شناسه وارد کن.");
  return id;
}
function safeMediaUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && ALLOWED_MEDIA_HOST_RE.test(u.hostname.toLowerCase());
  } catch { return false; }
}
function normalizeDownloads(attrs) {
  const candidates = [];
  const all = attrs?.file_link_all;
  if (Array.isArray(all)) {
    for (const item of all) {
      const quality = item?.profile || item?.quality || item?.label || "";
      const urls = Array.isArray(item?.urls) ? item.urls : [];
      for (const raw of urls) {
        if (typeof raw === "string" && safeMediaUrl(raw)) {
          candidates.push({ quality: String(quality || "ویدیو"), url: raw });
        }
      }
    }
  }
  // Some API responses expose a single download_link instead.
  if (typeof attrs?.download_link === "string" && safeMediaUrl(attrs.download_link)) {
    candidates.push({ quality: attrs?.profile || "کیفیت موجود", url: attrs.download_link });
  }
  // Remove duplicate URLs and sort low-to-high when labels contain resolution.
  const unique = [...new Map(candidates.map(x => [x.url, x])).values()];
  unique.sort((a, b) => {
    const ra = Number((a.quality.match(/\d{3,4}/) || [0])[0]);
    const rb = Number((b.quality.match(/\d{3,4}/) || [0])[0]);
    return ra - rb;
  });
  return unique;
}
async function resolveAparat(raw) {
  const id = getVideoId(raw);
  const endpoint = API_BASE + encodeURIComponent(id);
  const response = await fetch(endpoint, {
    headers: {
      "accept": "application/json, text/plain, */*",
      "user-agent": "Mozilla/5.0 (compatible; PublicAparatLinkResolver/1.0)"
    },
    redirect: "follow"
  });
  if (!response.ok) {
    if (response.status === 404) throw new Error("ویدیو پیدا نشد یا API آپارات آن را در دسترس قرار نمی‌دهد.");
    if (response.status === 403 || response.status === 401) throw new Error("آپارات دسترسی به اطلاعات این ویدیو را محدود کرده است.");
    throw new Error("آپارات پاسخ موفق نداد (HTTP " + response.status + "). کمی بعد دوباره امتحان کن.");
  }
  const body = await response.json().catch(() => null);
  const attrs = body?.data?.attributes || body?.data || body?.attributes;
  if (!attrs || typeof attrs !== "object") throw new Error("ساختار پاسخ آپارات تغییر کرده یا اطلاعات ویدیو در دسترس نیست.");
  const downloads = normalizeDownloads(attrs);
  if (!downloads.length) {
    throw new Error("لینک فایل مستقیم پیدا نشد. این ویدیو ممکن است فقط پخش آنلاین داشته باشد یا آپارات دریافت فایل را محدود کرده باشد.");
  }
  const title = String(attrs.title || attrs.name || "ویدیوی آپارات").slice(0, 300);
  const uploader = attrs.username || attrs.sender_name || attrs.owner?.name || attrs.uploader?.name || "";
  const thumbnail = attrs.big_poster || attrs.small_poster || attrs.poster || attrs.thumbnail || "";
  let safeThumbnail = "";
  try {
    const t = new URL(thumbnail);
    if (t.protocol === "https:" && /(^|\.)asset\.aparat\.com$/i.test(t.hostname)) safeThumbnail = t.href;
  } catch {}
  return { title, uploader: String(uploader).slice(0, 150), thumbnail: safeThumbnail, downloads };
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return json({ ok: true, service: "public-aparat-link-resolver" });
    if (url.pathname === "/api/search") {
      if (request.method !== "GET") return json({ error: "فقط GET پذیرفته می‌شود." }, 405);
      const q = (url.searchParams.get("q") || "").trim().slice(0, 120);
      if (!q) return json({ error: "عبارت جست‌وجو را وارد کن." }, 400);
      try {
        // Try the currently known public API route variants first.
        const endpoints = [
          "https://www.aparat.com/api/fa/v1/video/video/search?q=" + encodeURIComponent(q) + "&limit=15&page=1",
          "https://www.aparat.com/api/fa/v1/video/video/search?query=" + encodeURIComponent(q) + "&limit=15&page=1",
          "https://www.aparat.com/api/fa/v1/video/video/search?q=" + encodeURIComponent(q) + "&perpage=15",
          "https://www.aparat.com/api/fa/v1/video/video/search?search_query=" + encodeURIComponent(q) + "&limit=15",
          "https://www.aparat.com/api/fa/v1/video/video/search?search_term=" + encodeURIComponent(q) + "&limit=15",
          "https://www.aparat.com/etc/api/videoBySearch/text/" + encodeURIComponent(q)
        ];
        let body = null;
        for (const endpoint of endpoints) {
          const upstream = await fetch(endpoint, {
            headers: {
              "accept": "application/json, text/plain, */*",
              "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
              "referer": "https://www.aparat.com/"
            },
            redirect: "follow"
          });
          if (!upstream.ok) continue;
          const parsed = await upstream.json().catch(() => null);
          if (parsed) { body = parsed; break; }
        }
        const normalize = (item) => {
          const attrs = item?.attributes || item || {};
          const title = String(attrs.title || attrs.name || attrs.video_title || "").slice(0, 300);
          const hash = attrs.uid || attrs.hash_id || attrs.video_hash || attrs.video_uid || attrs.hash || attrs.videohash || attrs.id || item?.hash_id || item?.uid || "";
          let pageUrl = attrs.url || item?.url || (hash ? "https://www.aparat.com/v/" + hash : "");
          try {
            const parsed = new URL(pageUrl, "https://www.aparat.com");
            if (!["aparat.com", "www.aparat.com", "m.aparat.com"].includes(parsed.hostname.toLowerCase())) return null;
            pageUrl = parsed.href;
            if (!/^\/v\/[A-Za-z0-9_-]+(?:\/[^/]*)?\/?$/.test(parsed.pathname)) return null;
          } catch { return null; }
          const poster = attrs.big_poster || attrs.small_poster || attrs.poster || attrs.thumbnail || attrs.image || attrs.preview || "";
          let thumbnail = "";
            try { const t = new URL(poster); if (t.protocol === "https:" && /(^|\.)asset\.aparat\.com$/i.test(t.hostname)) thumbnail = t.href; } catch {}
          const uploader = String(attrs.username || attrs.sender_name || attrs.owner?.name || attrs.uploader?.name || "").slice(0, 150);
          return title ? {title, uploader, thumbnail, url:pageUrl} : null;
        };
        if (body) {
          const candidates = body?.data?.items || body?.data?.videos || body?.data?.result || body?.items || body?.videos || body?.data?.attributes?.videos || body?.data || body?.included || body?.videoBySearch || body?.videobysearch || [];
          let list = Array.isArray(candidates) ? candidates : (Array.isArray(candidates?.items) ? candidates.items : []);
          if (!list.length && Array.isArray(body?.included)) list = body.included;
          const items = list.map(normalize).filter(Boolean).slice(0, 15);
          if (items.length) return json({items});
        }
        // Fallback: parse publicly rendered Aparat search HTML if its JSON API is blocked/changed.
        const searchPage = "https://www.aparat.com/result/" + encodeURIComponent(q);
        const pageResponse = await fetch(searchPage, {
          headers: {
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
            "referer": "https://www.aparat.com/"
          },
          redirect: "follow"
        });
        if (pageResponse.ok) {
          const page = await pageResponse.text();
          const found = new Map();
          // Video entries can be rendered into HTML or embedded JSON.
          const searchablePage = page.replace(/\\\//g, "/").replace(/\\u0026/g, "&");
          const linkRegex = /(?:https?:\/\/(?:www\.)?aparat\.com)?\/v\/([A-Za-z0-9_-]{3,32})/g;
          let match;
          while ((match = linkRegex.exec(searchablePage)) && found.size < 15) {
            const id = match[1];
            if (found.has(id)) continue;
            const from = Math.max(0, match.index - 1800);
            const to = Math.min(searchablePage.length, match.index + 1800);
            const chunk = searchablePage.slice(from, to);
            const clean = value => String(value || "").replace(/&quot;|&#34;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
            let title = "";
            const titleMatch = chunk.match(/(?:title|video_title|name)["']?\s*[:=]\s*["']([^"'<>]{3,300})["']/i)
              || chunk.match(/aria-label=["']([^"']{3,300})["']/i)
              || chunk.match(/<title[^>]*>([^<]{3,300})<\/title>/i);
            if (titleMatch) title = clean(titleMatch[1]);
            let poster = "";
            const posterMatch = chunk.match(/https?:\/\/[^"'\s<>]+\.(?:jpg|jpeg|png|webp)(?:\?[^"'\s<>]*)?/i);
            if (posterMatch) poster = posterMatch[0];
            let thumbnail = "";
            try { const t = new URL(poster); if (t.protocol === "https:" && /(^|\.)asset\.aparat\.com$/i.test(t.hostname)) thumbnail = t.href; } catch {}
            if (!title || /آپارات|aparat/i.test(title) && title.length < 12) title = "ویدیوی آپارات " + id;
            found.set(id, {title, uploader:"", thumbnail, url:"https://www.aparat.com/v/" + id});
          }
          if (found.size) return json({items:[...found.values()]});
        }
        return json({error:"آپارات فعلاً نتایج جست‌وجو را در دسترس قرار نمی‌دهد. لطفاً لینک مستقیم ویدیو را از بخش «لینک ویدیو» وارد کن."}, 502);
      } catch {
        return json({error:"اتصال به جست‌وجوی آپارات ناموفق بود. لطفاً کمی بعد دوباره امتحان کن یا از لینک مستقیم استفاده کن."}, 502);
      }
    }
    if (url.pathname === "/api/resolve") {
      if (request.method !== "GET") return json({ error: "فقط درخواست GET پذیرفته می‌شود." }, 405);
      const raw = url.searchParams.get("url");
      if (!raw || raw.length > 2048) return json({ error: "لینک ویدیو را وارد کن." }, 400);
      try {
        const result = await resolveAparat(raw);
        return json(result);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "خطای نامشخص." }, 400);
      }
    }
    // Required for Cloudflare Pages Advanced Mode: serve static assets.
    if (env.ASSETS && typeof env.ASSETS.fetch === "function") return env.ASSETS.fetch(request);
    return new Response("Not Found", { status: 404 });
  }
};
