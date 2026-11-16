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

// ---- VidPik analytics + admin API (Cloudflare D1) ----
const encoder = new TextEncoder();
function b64url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
function fromB64url(value) {
  const s = value.replace(/-/g,"+").replace(/_/g,"/");
  const raw = atob(s + "=".repeat((4-s.length%4)%4));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
async function hmac(secret, value) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), {name:"HMAC",hash:"SHA-256"}, false, ["sign","verify"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}
async function issueAdminToken(env) {
  const payload = b64url(encoder.encode(JSON.stringify({role:"admin",exp:Date.now()+12*60*60*1000})));
  const sig = b64url(await hmac(env.VIDPIK_ADMIN_SECRET, payload));
  return payload + "." + sig;
}
async function validAdmin(request, env) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !env.VIDPIK_ADMIN_SECRET) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  try {
    const expected = await hmac(env.VIDPIK_ADMIN_SECRET, parts[0]);
    const actual = fromB64url(parts[1]);
    if (expected.length !== actual.length) return false;
    let diff = 0; for (let i=0;i<expected.length;i++) diff |= expected[i]^actual[i];
    if (diff) return false;
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    return payload.role === "admin" && payload.exp > Date.now();
  } catch { return false; }
}
function getDb(env) { return env.DB || env.VIDPIK_DB || null; }
async function recordEvent(env, type, request, extra={}) {
  const db = getDb(env); if (!db) return;
  try {
    const url = new URL(request.url);
    const ua = request.headers.get("user-agent") || "";
    const device = /mobile|android|iphone/i.test(ua) ? "موبایل" : /ipad|tablet/i.test(ua) ? "تبلت" : "دسکتاپ";
    const ref = request.headers.get("referer") || "";
    let refHost = "";
    try { refHost = ref ? new URL(ref).hostname.replace(/^www\./,"") : "مستقیم"; } catch {}
    const country = request.cf?.country || "نامشخص";
    const session = (request.headers.get("x-vidpik-session") || "").slice(0,80) || "anonymous";
    await db.prepare("INSERT INTO analytics_events (event_type,page,query_text,referrer,referrer_host,country,device,session_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(String(type).slice(0,40), String(extra.page||url.pathname).slice(0,200), String(extra.query||"").slice(0,180), ref.slice(0,500), refHost.slice(0,120), String(country).slice(0,8), device, session, new Date().toISOString()).run();
  } catch (e) { /* analytics must never interrupt the public product */ }
}
function adminCorsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  const allowed = String(env.VIDPIK_ADMIN_ORIGIN || "https://vidpik-admin.pages.dev").replace(/\/$/, "");
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Vidpik-Session",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  });
  if (origin === allowed) headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}
function withAdminCors(response, request, env) {
  const headers = new Headers(response.headers);
  for (const [key, value] of adminCorsHeaders(request, env)) headers.set(key, value);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, {status: response.status, statusText: response.statusText, headers});
}

async function adminApi(request, env, url) {
  const db = getDb(env);
  if (url.pathname === "/api/admin/login" && request.method === "POST") {
    if (!env.VIDPIK_ADMIN_PASSWORD || !env.VIDPIK_ADMIN_SECRET) return json({error:"تنظیمات رمز و کلید مدیر در Cloudflare کامل نشده است."},503);
    let body={}; try { body=await request.json(); } catch {}
    if (String(body.password||"").length > 200 || body.password !== env.VIDPIK_ADMIN_PASSWORD) {
      await recordEvent(env,"admin_login_failed",request);
      return json({error:"رمز عبور نادرست است."},401);
    }
    await recordEvent(env,"admin_login",request);
    return json({token:await issueAdminToken(env),expiresIn:43200});
  }
  if (!(await validAdmin(request,env))) return json({error:"نشست مدیر معتبر نیست؛ دوباره وارد شو."},401);
  if (!db) return json({error:"پایگاه داده D1 وصل نیست. طبق فایل ADMIN-SETUP-FA.txt دیتابیس را بساز و binding با نام DB اضافه کن."},503);
  if (url.pathname === "/api/admin/stats" && request.method === "GET") {
    const range = Math.max(1,Math.min(90,Number(url.searchParams.get("range")||7)));
    const since = new Date(Date.now()-range*86400000).toISOString();
    const one = async (sql,...args) => (await db.prepare(sql).bind(...args).first()) || {};
    const total = await one("SELECT COUNT(*) total, COUNT(DISTINCT session_id) visitors FROM analytics_events WHERE created_at >= ?",since);
    const count = async type => (await one("SELECT COUNT(*) n FROM analytics_events WHERE event_type=? AND created_at>=?",type,since)).n||0;
    const daily = await db.prepare("SELECT substr(created_at,1,10) day, SUM(event_type='page_view') views, SUM(event_type='search') searches, SUM(event_type='resolve') resolves, SUM(event_type='download') downloads FROM analytics_events WHERE created_at>=? GROUP BY day ORDER BY day").bind(since).all();
    const topPages = await db.prepare("SELECT page,COUNT(*) views FROM analytics_events WHERE event_type='page_view' AND created_at>=? GROUP BY page ORDER BY views DESC LIMIT 8").bind(since).all();
    const sources = await db.prepare("SELECT referrer_host source,COUNT(*) visits FROM analytics_events WHERE created_at>=? GROUP BY source ORDER BY visits DESC LIMIT 8").bind(since).all();
    const countries = await db.prepare("SELECT country,COUNT(*) visits FROM analytics_events WHERE created_at>=? GROUP BY country ORDER BY visits DESC LIMIT 8").bind(since).all();
    const devices = await db.prepare("SELECT device,COUNT(*) visits FROM analytics_events WHERE created_at>=? GROUP BY device ORDER BY visits DESC").bind(since).all();
    const recent = await db.prepare("SELECT event_type,page,query_text,referrer_host,country,device,created_at FROM analytics_events ORDER BY id DESC LIMIT 15").all();
    return json({range,total:total.total||0,visitors:total.visitors||0,views:await count("page_view"),searches:await count("search"),resolves:await count("resolve"),downloads:await count("download"),daily:daily.results||[],topPages:topPages.results||[],sources:sources.results||[],countries:countries.results||[],devices:devices.results||[],recent:recent.results||[]});
  }
  if (url.pathname === "/api/admin/ads" && request.method === "GET") {
    const rows = await db.prepare("SELECT setting_key,setting_value FROM site_settings WHERE setting_key LIKE 'ad_%'").all();
    const out={}; for (const r of rows.results||[]) { try { out[r.setting_key.slice(3)]=JSON.parse(r.setting_value); } catch {} }
    return json(out);
  }
  if (url.pathname === "/api/admin/ads" && request.method === "PUT") {
    let body={}; try { body=await request.json(); } catch { return json({error:"داده‌های ارسالی معتبر نیست."},400); }
    const allowed=["home","before","during"];
    const stmts=[];
    for (const key of allowed) {
      const item=body[key]||{};
      const link=String(item.url||"").trim();
      const image=String(item.image||"").trim();
      const validWebUrl=value=>{ if(!value)return true; try { const u=new URL(value); return u.protocol==="https:"||u.protocol==="http:"; } catch { return false; } };
      if (!validWebUrl(link) || !validWebUrl(image)) return json({error:"آدرس لینک و تصویر باید با http:// یا https:// شروع شود."},400);
      const value=JSON.stringify({title:String(item.title||"").slice(0,120),text:String(item.text||"").slice(0,1000),url:link,image,button:String(item.button||"مشاهده تبلیغ").slice(0,40),start:String(item.start||"").slice(0,10),end:String(item.end||"").slice(0,10),enabled:!!item.enabled});
      stmts.push(db.prepare("INSERT INTO site_settings(setting_key,setting_value,updated_at) VALUES(?,?,?) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=excluded.updated_at").bind("ad_"+key,value,new Date().toISOString()));
    }
    await db.batch(stmts);
    return json({ok:true});
  }
  if (url.pathname === "/api/admin/events" && request.method === "GET") {
    const rows=await db.prepare("SELECT event_type,page,query_text,referrer_host,country,device,created_at FROM analytics_events ORDER BY id DESC LIMIT 100").all();
    return json({events:rows.results||[]});
  }
  return json({error:"مسیر مدیریت پیدا نشد."},404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Search-engine endpoints. Only stable, public pages belong in the sitemap.
    if (url.pathname === "/sitemap.xml") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { "allow": "GET, HEAD" } });
      }
      const origin = url.origin;
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
        `<url><loc>${origin}/</loc></url>` +
        `</urlset>`;
      return new Response(request.method === "HEAD" ? null : xml, {
        status: 200,
        headers: {
          "content-type": "application/xml; charset=utf-8",
          "cache-control": "public, max-age=3600, s-maxage=3600",
          "x-content-type-options": "nosniff"
        }
      });
    }
    if (url.pathname === "/robots.txt") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { "allow": "GET, HEAD" } });
      }
      const body = `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${url.origin}/sitemap.xml\n`;
      return new Response(request.method === "HEAD" ? null : body, {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "public, max-age=3600, s-maxage=3600",
          "x-content-type-options": "nosniff"
        }
      });
    }

    if (url.pathname === "/api/ads" && request.method === "GET") {
      const db=getDb(env);
      if (!db) return json({ads:{}});
      try {
        const rows=await db.prepare("SELECT setting_key,setting_value FROM site_settings WHERE setting_key LIKE 'ad_%'").all();
        const ads={}; const today=new Date().toISOString().slice(0,10);
        for (const row of rows.results||[]) {
          try {
            const key=row.setting_key.slice(3), item=JSON.parse(row.setting_value);
            if (item.enabled && (!item.start || item.start<=today) && (!item.end || item.end>=today)) ads[key]=item;
          } catch {}
        }
        return json({ads});
      } catch { return json({ads:{}}); }
    }
    if (url.pathname.startsWith("/api/admin/")) {
      if (request.method === "OPTIONS") return new Response(null, {status:204, headers:adminCorsHeaders(request,env)});
      const response = await adminApi(request, env, url);
      return withAdminCors(response, request, env);
    }
    if (url.pathname === "/api/track" && request.method === "POST") {
      let body={}; try { body=await request.json(); } catch {}
      const type=String(body.type||"").slice(0,40);
      if (!["page_view","search","resolve","download","ad_click"].includes(type)) return json({error:"رویداد نامعتبر است."},400);
      await recordEvent(env,type,request,{query:body.query||"",page:body.page||"/"});
      return json({ok:true});
    }
    if (url.pathname === "/api/health") {
      const response = json({ ok: true, service: "public-aparat-link-resolver" });
      return withAdminCors(response, request, env);
    }
    if (url.pathname === "/api/search") {
      if (request.method !== "GET") return json({ error: "فقط GET پذیرفته می‌شود." }, 405);
      const q = (url.searchParams.get("q") || "").trim().slice(0, 180);
      const page = Math.max(1, Math.min(20, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1));
      if (!q) return json({ error: "عبارت جست‌وجو را وارد کن." }, 400);
      await recordEvent(env,"search",request,{query:q});
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
      await recordEvent(env,"resolve",request);
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
      await recordEvent(env,"download",request);
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
