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

async function downloadMedia(request) {
  const requestUrl = new URL(request.url);
  const raw = requestUrl.searchParams.get("url");
  const quality = (requestUrl.searchParams.get("quality") || "video")
    .replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 20) || "video";

  if (!raw || raw.length > 4096 || !safeMediaUrl(raw)) {
    return json({ error: "لینک فایل دانلود معتبر نیست." }, 400);
  }

  try {
    const upstreamHeaders = new Headers({
      "user-agent": "Mozilla/5.0",
      "accept": "*/*"
    });
    const range = request.headers.get("range");
    if (range) upstreamHeaders.set("range", range);

    // Stream the media file through the Worker; do not redirect the browser
    // to a raw media URL or return a JSON response as the download.
    const upstream = await fetch(raw, {
      method: "GET",
      headers: upstreamHeaders,
      redirect: "follow"
    });

    if (!upstream.ok && upstream.status !== 206) {
      return json({
        error: "سرور آپارات فایل را ارسال نکرد. کد HTTP: " + upstream.status
      }, 502);
    }

    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    if (contentType.includes("text/html") || contentType.includes("application/json")) {
      return json({ error: "سرور به‌جای فایل ویدیو، پاسخ غیرقابل‌دانلود فرستاد." }, 502);
    }

    const headers = new Headers({
      "content-type": contentType,
      "content-disposition": `attachment; filename="VidPik-${quality}.mp4"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    });
    for (const name of ["content-length", "content-range", "accept-ranges"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers
    });
  } catch {
    return json({ error: "ارتباط با سرور فایل ناموفق بود؛ دوباره تلاش کن." }, 502);
  }
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
    if (url.pathname === "/api/download") {
      if (request.method !== "GET") return json({ error: "فقط درخواست GET پذیرفته می‌شود." }, 405);
      return downloadMedia(request);
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
