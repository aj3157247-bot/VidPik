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
      const q = (url.searchParams.get("q") || "").trim().slice(0, 180);
      const page = Math.max(1, Math.min(20, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1));
      if (!q) return json({ error: "عبارت جست‌وجو را وارد کن." }, 400);
      const hostOf = value => { try { return new URL(value).hostname.replace(/^www\./i, ""); } catch { return "وب"; } };
      const normalize = (list) => (Array.isArray(list) ? list : []).map(item => {
        const link = String(item.link || item.url || "");
        if (!/^https?:\/\//i.test(link)) return null;
        let thumbnail = String(item.thumbnail || item.image || item.pagemap?.cse_thumbnail?.[0]?.src || item.pagemap?.cse_image?.[0]?.src || "");
        try { if (!/^https?:\/\//i.test(thumbnail)) thumbnail = ""; } catch { thumbnail = ""; }
        return {
          title: String(item.title || "نتیجهٔ وب").slice(0, 300),
          url: link,
          thumbnail,
          snippet: String(item.snippet || item.description || "").slice(0, 500),
          uploader: hostOf(link),
          source: hostOf(link),
          isAparat: /(^|\.)aparat\.(com|ir)$/i.test(hostOf(link)) && /\/v\//i.test(new URL(link).pathname)
        };
      }).filter(Boolean);
      try {
        // Preferred: SerpApi provides Google web results with server-side API access.
        if (env.SERPAPI_KEY) {
          const endpoint = new URL("https://serpapi.com/search.json");
          endpoint.searchParams.set("engine", "google");
          endpoint.searchParams.set("q", q);
          endpoint.searchParams.set("num", "10");
          endpoint.searchParams.set("start", String((page - 1) * 10));
          endpoint.searchParams.set("api_key", env.SERPAPI_KEY);
          const upstream = await fetch(endpoint.toString(), { headers: { "accept": "application/json" } });
          const body = await upstream.json().catch(() => null);
          if (upstream.ok && body && Array.isArray(body.organic_results)) {
            const items = normalize(body.organic_results);
            return json({ items, page, hasMore: Boolean(body.serpapi_pagination?.next), provider: "Google" });
          }
          if (upstream.status === 401 || upstream.status === 403) return json({ error: "کلید SERPAPI_KEY معتبر نیست یا سهمیهٔ جست‌وجو تمام شده است." }, 502);
        }
        // Google Programmable Search JSON API, for accounts that already have access.
        if (env.GOOGLE_API_KEY && env.GOOGLE_CSE_ID) {
          const endpoint = new URL("https://www.googleapis.com/customsearch/v1");
          endpoint.searchParams.set("key", env.GOOGLE_API_KEY);
          endpoint.searchParams.set("cx", env.GOOGLE_CSE_ID);
          endpoint.searchParams.set("q", q);
          endpoint.searchParams.set("num", "10");
          endpoint.searchParams.set("start", String((page - 1) * 10 + 1));
          const upstream = await fetch(endpoint.toString(), { headers: { "accept": "application/json" } });
          const body = await upstream.json().catch(() => null);
          if (upstream.ok && body && Array.isArray(body.items)) {
            const items = normalize(body.items.map(x => ({ ...x, thumbnail: x.pagemap?.cse_thumbnail?.[0]?.src || x.pagemap?.cse_image?.[0]?.src || "" })));
            return json({ items, page, hasMore: Boolean(body.queries?.nextPage?.length), provider: "Google" });
          }
          const message = body?.error?.message;
          return json({ error: "گوگل پاسخ جست‌وجو نداد" + (message ? ": " + String(message).slice(0, 220) : ".") }, 502);
        }
        return json({ error: "جست‌وجوی گسترده هنوز به کلید API وصل نشده است. در Cloudflare Pages → Settings → Variables and Secrets، کلید SERPAPI_KEY را اضافه کن. راهنمای GOOGLE-SEARCH-SETUP.txt را ببین." }, 503);
      } catch (error) {
        return json({ error: "اتصال به جست‌وجوی گوگل ناموفق بود. تنظیمات API و دسترسی شبکه را بررسی کن." }, 502);
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
    // Download only verified public Aparat media URLs; never return the app's HTML page as a download.
    if (url.pathname === "/api/download") {
      if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "فقط GET و HEAD پذیرفته می‌شود." }, 405);
      const raw = url.searchParams.get("url");
      if (!raw || raw.length > 4096 || !safeMediaUrl(raw)) {
        return json({ error: "لینک مستقیم و معتبر فایل ویدیویی آپارات لازم است." }, 400);
      }
      try {
        const upstream = await fetch(raw, {
          method: request.method,
          headers: {
            "accept": "video/*, application/octet-stream;q=0.9, */*;q=0.8",
            ...(request.headers.has("range") ? { "range": request.headers.get("range") } : {})
          },
          redirect: "follow"
        });
        // Check the final URL as well, in case the media host redirected elsewhere.
        if (!safeMediaUrl(upstream.url || raw)) {
          return json({ error: "سرور فایل به دامنهٔ تأییدنشده هدایت شد؛ دانلود متوقف شد." }, 502);
        }
        if (!upstream.ok && upstream.status !== 206) {
          return json({ error: "دریافت فایل ویدیو ناموفق بود (HTTP " + upstream.status + ")." }, 502);
        }
        const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
        if (contentType.includes("text/html") || contentType.includes("application/json")) {
          return json({ error: "سایت منبع به‌جای فایل ویدیو، صفحهٔ وب برگرداند. این ویدیو لینک دانلود مستقیم قابل‌دسترسی ندارد." }, 502);
        }
        const disposition = 'attachment; filename="vidpik-video.mp4"';
        const headers = new Headers({
          "content-type": contentType || "application/octet-stream",
          "content-disposition": disposition,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff"
        });
        for (const name of ["content-length", "accept-ranges", "content-range"]) {
          const value = upstream.headers.get(name);
          if (value) headers.set(name, value);
        }
        return new Response(request.method === "HEAD" ? null : upstream.body, {
          status: upstream.status,
          headers
        });
      } catch (error) {
        return json({ error: "اتصال برای دریافت فایل ویدیو ناموفق بود. دوباره تلاش کن." }, 502);
      }
    }
    // Required for Cloudflare Pages Advanced Mode: serve static assets.
    if (env.ASSETS && typeof env.ASSETS.fetch === "function") return env.ASSETS.fetch(request);
    return new Response("Not Found", { status: 404 });
  }
};
