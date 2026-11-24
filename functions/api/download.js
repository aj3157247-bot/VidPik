
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function allowedHost(host) {
  host = host.toLowerCase();

  return host === "aparat.com" ||
    host.endsWith(".aparat.com") ||
    host === "aparat.ir" ||
    host.endsWith(".aparat.ir");
}

export async function onRequestGet({ request }) {
  const reqUrl = new URL(request.url);
  const mediaUrl = reqUrl.searchParams.get("url");
  const quality = (
    reqUrl.searchParams.get("quality") || "video"
  ).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 20);
  const inline = reqUrl.searchParams.get("mode") === "stream";

  let media;

  try {
    media = new URL(mediaUrl);
  } catch {
    return json({ error: "آدرس دانلود معتبر نیست." }, 400);
  }

  if (
    media.protocol !== "https:" ||
    !allowedHost(media.hostname)
  ) {
    return json({
      error: "دامنه فایل با دامنه‌های مجاز آپارات مطابقت ندارد."
    }, 400);
  }

  try {
    const headers = new Headers();
    const range = request.headers.get("Range");

    if (range) headers.set("Range", range);

    // فایل را به شکل جریانی دریافت می‌کنیم تا لازم نباشد
    // تمام ویدیو در حافظه Worker ذخیره شود.
    const upstream = await fetch(media.href, {
      headers,
      redirect: "follow"
    });

    if (!upstream.ok && upstream.status !== 206) {
      return json({
        error: "سرور ویدیو فایل را نداد. کد HTTP: " +
          upstream.status
      }, 502);
    }

    const mediaType = upstream.headers.get("Content-Type") || "application/octet-stream";
    const extension = /webm/i.test(mediaType) ? "webm" : /quicktime/i.test(mediaType) ? "mov" : "mp4";
    const responseHeaders = new Headers({
      "Content-Type": mediaType,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="VidPik-${quality || "video"}.${extension}"`,
      "Cache-Control": "no-store, no-transform",
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": upstream.headers.get("Accept-Ranges") || "bytes"
    });

    for (const key of [
      "Content-Length",
      "Content-Range",
      "Accept-Ranges"
    ]) {
      const value = upstream.headers.get(key);
      if (value) responseHeaders.set(key, value);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders
    });

  } catch {
    return json({
      error: "دریافت فایل ناموفق بود؛ دوباره تلاش کن."
    }, 502);
  }
}
