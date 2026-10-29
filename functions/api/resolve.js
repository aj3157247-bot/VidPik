const API_BASE = "https://www.aparat.com/api/fa/v1/video/video/show/videohash/";

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
  const host = url.hostname.toLowerCase();
  if (!["aparat.com", "www.aparat.com", "m.aparat.com"].includes(host)) {
    throw new Error("لطفاً فقط لینک‌های دامنه aparat.com را وارد کن.");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  let id = "";
  if (parts[0] === "v" && parts[1]) id = parts[1];
  else if (parts[0] === "video" && parts[1] === "video" && parts[2] === "embed" && parts[3] === "videohash" && parts[4]) id = parts[4];
  else if (parts[0] === "shorts" && parts[1]) id = parts[1];
  if (!/^[A-Za-z0-9_-]{3,40}$/.test(id)) {
    throw new Error("قالب لینک پشتیبانی نمی‌شود. لینک یک ویدیو مانند https://www.aparat.com/v/VIDEO_ID وارد کن.");
  }
  return id;
}

function isAparatMediaUrl(raw) {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    return u.protocol === "https:" &&
      (host === "aparat.com" || host.endsWith(".aparat.com") || host === "aparat.ir" || host.endsWith(".aparat.ir"));
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
        if (typeof raw === "string" && isAparatMediaUrl(raw)) {
          candidates.push({ quality: String(quality || "کیفیت موجود"), url: raw });
        }
      }
    }
  }
  if (typeof attrs?.file_link === "string" && isAparatMediaUrl(attrs.file_link)) {
    candidates.push({ quality: String(attrs.profile || "کیفیت موجود"), url: attrs.file_link });
  }
  if (typeof attrs?.download_link === "string" && isAparatMediaUrl(attrs.download_link)) {
    candidates.push({ quality: String(attrs.profile || "کیفیت موجود"), url: attrs.download_link });
  }
  const unique = [...new Map(candidates.map(x => [x.url, x])).values()];
  unique.sort((a, b) => {
    const ra = Number((a.quality.match(/\d{3,4}/) || [0])[0]);
    const rb = Number((b.quality.match(/\d{3,4}/) || [0])[0]);
    return ra - rb;
  });
  return unique.slice(0, 12);
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  if (url.pathname !== "/api/resolve") return json({ error: "مسیر پیدا نشد." }, 404);
  const raw = url.searchParams.get("url");
  if (!raw || raw.length > 2048) return json({ error: "لینک ویدیو را وارد کن." }, 400);

  let id;
  try { id = getVideoId(raw); }
  catch (e) { return json({ error: e.message }, 400); }

  try {
    const response = await fetch(API_BASE + encodeURIComponent(id), {
      headers: {
        "accept": "application/json, text/plain, */*",
        "user-agent": "Mozilla/5.0 (compatible; VidPik/1.0)"
      },
      redirect: "follow"
    });
    if (!response.ok) {
      if (response.status === 404) return json({ error: "ویدیو پیدا نشد یا در دسترس نیست." }, 404);
      if (response.status === 401 || response.status === 403) return json({ error: "آپارات دسترسی به اطلاعات این ویدیو را محدود کرده است." }, 502);
      return json({ error: "آپارات پاسخ موفق نداد (HTTP " + response.status + ")." }, 502);
    }
    const body = await response.json();
    const attrs = body?.data?.attributes || body?.data || body?.attributes;
    if (!attrs || typeof attrs !== "object") {
      return json({ error: "ساختار پاسخ آپارات تغییر کرده یا اطلاعات ویدیو در دسترس نیست." }, 502);
    }
    if (attrs.can_download === false || attrs.can_download === 0 || attrs.can_download === "0") {
      return json({ error: "برای این ویدیو لینک دانلود مستقیم از سوی آپارات ارائه نشده است." }, 404);
    }
    const downloads = normalizeDownloads(attrs);
    if (!downloads.length) {
      return json({ error: "لینک فایل مستقیم پیدا نشد. ممکن است این ویدیو فقط پخش آنلاین داشته باشد یا API آپارات تغییر کرده باشد." }, 404);
    }
    const title = String(attrs.title || attrs.name || "ویدیوی آپارات").slice(0, 300);
    const uploader = attrs.username || attrs.sender_name || attrs.owner?.name || attrs.uploader?.name || "";
    const thumbnail = attrs.big_poster || attrs.small_poster || attrs.poster || attrs.thumbnail || "";
    let safeThumbnail = "";
    try {
      const t = new URL(thumbnail);
      if (t.protocol === "https:" && (t.hostname.endsWith(".aparat.com") || t.hostname === "aparat.com")) safeThumbnail = t.href;
    } catch {}
    return json({
      title,
      uploader: String(uploader).slice(0, 150),
      thumbnail: safeThumbnail,
      downloads
    });
  } catch (error) {
    return json({ error: "ارتباط با آپارات ناموفق بود. کمی بعد دوباره تلاش کن." }, 502);
  }
}
