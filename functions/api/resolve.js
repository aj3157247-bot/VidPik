
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

  const all = attributes?.file_link_all;

  if (Array.isArray(all)) {
    for (const item of all) {
      const quality = String(
        item?.profile || item?.quality || item?.label || "کیفیت موجود"
      );

      const urls = Array.isArray(item?.urls) ? item.urls : [];

      for (const url of urls) {
        if (typeof url === "string" && validMediaUrl(url)) {
          downloads.push({ quality, url });
        }
      }
    }
  }

  for (const key of ["file_link", "download_link"]) {
    const url = attributes?.[key];

    if (typeof url === "string" && validMediaUrl(url)) {
      downloads.push({
        quality: String(attributes?.profile || "کیفیت موجود"),
        url
      });
    }
  }

  return [...new Map(
    downloads.map(item => [item.url, item])
  ).values()].slice(0, 12);
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
    const response = await fetch(
      API_BASE + encodeURIComponent(id),
      {
        headers: {
          "accept": "application/json",
          "user-agent": "Mozilla/5.0"
        }
      }
    );

    if (!response.ok) {
      return json({
        error: "آپارات اطلاعات ویدیو را ارائه نکرد: HTTP " +
          response.status
      }, 502);
    }

    const body = await response.json();

    const attributes =
      body?.data?.attributes ||
      body?.data ||
      body?.attributes;

    if (!attributes || typeof attributes !== "object") {
      return json({
        error: "ساختار پاسخ آپارات قابل‌شناسایی نیست."
      }, 502);
    }

    const downloads = extractDownloads(attributes);

    if (!downloads.length) {
      return json({
        error: "لینک دانلود مستقیم پیدا نشد یا API آپارات تغییر کرده است."
      }, 404);
    }

    let thumbnail = "";

    const poster =
      attributes.big_poster ||
      attributes.small_poster ||
      attributes.poster ||
      "";

    try {
      const imageUrl = new URL(poster);

      if (
        imageUrl.protocol === "https:" &&
        isAllowedHost(imageUrl.hostname)
      ) {
        thumbnail = imageUrl.href;
      }
    } catch {}

    return json({
      title: String(attributes.title || "ویدیوی آپارات").slice(0, 300),
      uploader: String(
        attributes.username || attributes.sender_name || ""
      ).slice(0, 150),
      thumbnail,
      downloads
    });

  } catch {
    return json({
      error: "ارتباط با API آپارات ناموفق بود."
    }, 502);
  }
}
