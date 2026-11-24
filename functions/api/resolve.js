
const API_BASE =
  "https://www.aparat.com/api/fa/v1/video/video/show/videohash/";

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers
    }
  });
}

function isAllowedHost(host) {
  host = host.toLowerCase();
  return host === "aparat.com" ||
    host.endsWith(".aparat.com") ||
    host === "aparat.ir" ||
    host.endsWith(".aparat.ir");
}

function validMediaUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && isAllowedHost(u.hostname);
  } catch {
    return false;
  }
}

function getVideoId(value) {
  let u;

  try {
    u = new URL(value);
  } catch {
    throw new Error("لینک واردشده معتبر نیست.");
  }

  if (
    !["aparat.com", "www.aparat.com", "m.aparat.com"]
      .includes(u.hostname.toLowerCase())
  ) {
    throw new Error("لطفاً لینک ویدیوی آپارات را وارد کن.");
  }

  const parts = u.pathname.split("/").filter(Boolean);
  let id = "";

  if (parts[0] === "v" && parts[1]) {
    id = parts[1];
  } else if (
    parts[0] === "video" &&
    parts[1] === "video" &&
    parts[2] === "embed" &&
    parts[3] === "videohash" &&
    parts[4]
  ) {
    id = parts[4];
  }

  if (!/^[a-zA-Z0-9_-]{3,40}$/.test(id)) {
    throw new Error("قالب لینک پشتیبانی نمی‌شود.");
  }

  return id;
}

function extractDownloads(attributes) {
  const downloads = [];
  const seen = new Set();
  const add = (url, quality, type) => {
    if (typeof url !== "string" || !validMediaUrl(url) || seen.has(url)) return;
    seen.add(url);
    downloads.push({ quality: String(quality || "کیفیت موجود").slice(0, 80), url, type: String(type || "").slice(0, 100) });
  };
  const walk = (value, fallback = "کیفیت موجود", depth = 0) => {
    if (depth > 6 || value == null) return;
    if (typeof value === "string") { add(value, fallback); return; }
    if (Array.isArray(value)) { for (const item of value) walk(item, fallback, depth + 1); return; }
    if (typeof value !== "object") return;
    const quality = value.profile || value.quality || value.label || value.resolution || value.height || value.name || fallback;
    const type = value.type || value.mime_type || value.mimeType || "";
    for (const key of ["url", "src", "file", "link", "file_link", "download_url"]) if (typeof value[key] === "string") add(value[key], quality, type);
    for (const key of ["urls", "files", "sources", "streams", "items", "links", "qualities"]) if (value[key] != null) walk(value[key], quality, depth + 1);
  };
  for (const key of ["file_link_all", "file_link", "download_link", "download_links", "multiSRC", "sources", "streams", "qualities", "files"]) {
    if (attributes && attributes[key] != null) walk(attributes[key], attributes.profile || "کیفیت موجود");
  }
  downloads.sort((a, b) => Number((String(b.quality).match(/\d{3,4}/) || [0])[0]) - Number((String(a.quality).match(/\d{3,4}/) || [0])[0]));
  return downloads.slice(0, 30);
}

export async function onRequestGet({ request }) {
  const requestUrl = new URL(request.url);

  // مسیر دانلود
  if (requestUrl.pathname === "/api/download") {
    const mediaUrl = requestUrl.searchParams.get("url");
    const quality = (
      requestUrl.searchParams.get("quality") || "video"
    ).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 20);

    if (
      !mediaUrl ||
      mediaUrl.length > 4096 ||
      !validMediaUrl(mediaUrl)
    ) {
      return json({ error: "لینک فایل معتبر نیست." }, 400);
    }

    try {
      const headers = new Headers();
      const range = request.headers.get("range");

      if (range) headers.set("range", range);

      const upstream = await fetch(mediaUrl, {
        headers,
        redirect: "manual"
      });

      if ([301, 302, 303, 307, 308].includes(upstream.status)) {
        const location = upstream.headers.get("location");

        if (!location) {
          return json({ error: "آدرس فایل دریافت نشد." }, 502);
        }

        let target;

        try {
          target = new URL(location, mediaUrl);
        } catch {
          return json({ error: "آدرس فایل نامعتبر است." }, 502);
        }

        if (!validMediaUrl(target.href)) {
          return json({
            error: "منبع دانلود به دامنه دیگری منتقل شده است."
          }, 502);
        }

        return json({
          error: "منبع فایل تغییر مسیر می‌دهد؛ این نسخه هنوز آن مسیر را دنبال نمی‌کند."
        }, 502);
      }

      if (!upstream.ok && upstream.status !== 206) {
        return json({
          error: "دریافت فایل ناموفق بود: HTTP " + upstream.status
        }, 502);
      }

      const responseHeaders = new Headers({
        "content-type":
          upstream.headers.get("content-type") ||
          "application/octet-stream",
        "content-disposition":
          `attachment; filename="VidPik-${quality || "video"}.mp4"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
      });

      for (const name of [
        "content-length",
        "content-range",
        "accept-ranges"
      ]) {
        const value = upstream.headers.get(name);
        if (value) responseHeaders.set(name, value);
      }

      return new Response(upstream.body, {
        status: upstream.status,
        headers: responseHeaders
      });

    } catch {
      return json({
        error: "ارتباط با منبع فایل ناموفق بود."
      }, 502);
    }
  }

  // مسیر بررسی ویدیو
  if (requestUrl.pathname !== "/api/resolve") {
    return json({ error: "مسیر پیدا نشد." }, 404);
  }

  const raw = requestUrl.searchParams.get("url");

  if (!raw || raw.length > 2048) {
    return json({ error: "لینک ویدیو را وارد کن." }, 400);
  }

  let id;

  try {
    id = getVideoId(raw);
  } catch (error) {
    return json({ error: error.message }, 400);
  }

  try {
    let attributes = null;
    for (const endpoint of [
      API_BASE + encodeURIComponent(id),
      "https://www.aparat.com/etc/api/video/videohash/" + encodeURIComponent(id)
    ]) {
      try {
        const response = await fetch(endpoint, {
          headers: {
            "accept": "application/json, text/plain, */*",
            "accept-language": "fa-IR,fa;q=0.9,en;q=0.8",
            "origin": "https://www.aparat.com",
            "referer": "https://www.aparat.com/",
            "user-agent": "Mozilla/5.0"
          },
          redirect: "follow"
        });
        if (!response.ok) continue;
        const body = await response.json().catch(() => null);
        attributes = body?.data?.attributes || body?.data ||
          body?.attributes || body?.video?.attributes || body?.video || null;
        if (attributes && typeof attributes === "object") break;
      } catch {}
    }

    const embedUrl =
      "https://www.aparat.com/video/video/embed/videohash/" +
      encodeURIComponent(id) + "/vt/frame";

    if (!attributes || typeof attributes !== "object") {
      return json({
        title: "ویدیوی آپارات",
        uploader: "",
        thumbnail: "",
        downloads: [],
        embedUrl,
        warning: "API دریافت کیفیت‌ها پاسخ نداد؛ پخش‌کنندهٔ رسمی آپارات امتحان می‌شود."
      });
    }

    const downloads = extractDownloads(attributes);
    let thumbnail = "";
    const poster = attributes.big_poster || attributes.small_poster ||
      attributes.poster || attributes.thumbnail || "";
    try {
      const imageUrl = new URL(poster);
      if (imageUrl.protocol === "https:" && isAllowedHost(imageUrl.hostname)) {
        thumbnail = imageUrl.href;
      }
    } catch {}

    return json({
      title: String(attributes.title || attributes.name || "ویدیوی آپارات").slice(0, 300),
      uploader: String(attributes.username || attributes.sender_name || "").slice(0, 150),
      thumbnail,
      downloads,
      mediaSources: downloads,
      downloadAllowed: downloads.length > 0,
      embedUrl,
      warning: downloads.length ? "" : "پخش آنلاین ممکن است فعال باشد، اما لینک دانلود مستقیم در دسترس نیست."
    });
  } catch {
    return json({
      title: "ویدیوی آپارات",
      uploader: "",
      thumbnail: "",
      downloads: [],
      embedUrl: "https://www.aparat.com/video/video/embed/videohash/" +
        encodeURIComponent(id) + "/vt/frame",
      warning: "ارتباط با API آپارات ناموفق بود؛ پخش‌کنندهٔ رسمی امتحان می‌شود."
    });
  }
}
