/**
 * Cloudflare Pages Advanced Mode Worker
 * Public, directly accessible Aparat videos only.
 * Static files are served through env.ASSETS.
 */
const API_BASE = "https://www.aparat.com/api/fa/v1/video/video/show/videohash/";
const ALLOWED_PAGE_HOSTS = new Set(["aparat.com", "www.aparat.com", "m.aparat.com"]);
const ALLOWED_MEDIA_HOST_RE = /(^|\.)(asset|cdn)\.aparat\.(com|ir)$/i;
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
      const urls = Array.isArray(item?.urls) ? item.urls : (item?.url ? [item.url] : []);
      for (const raw of urls) {
        if (typeof raw === "string" && safeMediaUrl(raw)) {
          candidates.push({ quality: String(quality || "ویدیو"), url: raw });
        }
      }
    }
  }
  for (const key of ["file_link", "download_link"]) {
    const raw = attrs?.[key];
    if (typeof raw === "string" && safeMediaUrl(raw)) {
      candidates.push({ quality: String(attrs?.profile || "کیفیت موجود"), url: raw });
    }
  }
  // Newer Aparat responses may expose download_links or player multiSRC instead.
  for (const key of ["download_links", "multiSRC", "sources"]) {
    const list = attrs?.[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const items = Array.isArray(entry) ? entry : [entry];
      for (const item of items) {
        const raw = typeof item === "string" ? item : (item?.url || item?.src);
        if (typeof raw === "string" && safeMediaUrl(raw)) {
          candidates.push({
            quality: String(item?.quality || item?.profile || item?.label || "کیفیت موجود"),
            url: raw
          });
        }
      }
    }
  }
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
  const endpoints = [
    API_BASE + encodeURIComponent(id),
    "https://www.aparat.com/etc/api/video/videohash/" + encodeURIComponent(id)
  ];
  let attrs = null;
  let lastStatus = 0;
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        headers: {
          "accept": "application/json, text/plain, */*",
          "accept-language": "fa-IR,fa;q=0.9,en;q=0.8",
          "origin": "https://www.aparat.com",
          "referer": "https://www.aparat.com/",
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
        },
        redirect: "follow"
      });
      lastStatus = response.status;
      if (!response.ok) continue;
      const body = await response.json().catch(() => null);
      attrs = body?.data?.attributes || body?.data || body?.attributes ||
        body?.video?.attributes || body?.video || null;
      if (attrs && typeof attrs === "object") break;
    } catch (_) {}
  }

  // The embedded Aparat player can still work when its metadata/download API is unavailable.
  const embedUrl = "https://www.aparat.com/video/video/embed/videohash/" +
    encodeURIComponent(id) + "/vt/frame";
  if (!attrs) {
    return {
      title: "ویدیوی آپارات",
      uploader: "",
      thumbnail: "",
      downloads: [],
      embedUrl,
      warning: lastStatus === 404
        ? "اطلاعات دانلود از API آپارات دریافت نشد؛ پخش‌کنندهٔ رسمی امتحان می‌شود."
        : "API دریافت کیفیت‌ها پاسخ نداد؛ پخش‌کنندهٔ رسمی امتحان می‌شود."
    };
  }

  const downloads = normalizeDownloads(attrs);
  const title = String(attrs.title || attrs.name || "ویدیوی آپارات").slice(0, 300);
  const uploader = attrs.username || attrs.sender_name || attrs.owner?.name || attrs.uploader?.name || "";
  const thumbnail = attrs.big_poster || attrs.small_poster || attrs.poster || attrs.thumbnail || "";
  let safeThumbnail = "";
  try {
    const t = new URL(thumbnail);
    if (t.protocol === "https:" && /(^|\.)asset\.aparat\.com$/i.test(t.hostname)) safeThumbnail = t.href;
  } catch {}
  return {
    title,
    uploader: String(uploader).slice(0, 150),
    thumbnail: safeThumbnail,
    downloads,
    embedUrl,
    warning: downloads.length ? "" : "پخش‌کنندهٔ رسمی در دسترس است، اما لینک دانلود مستقیم از API دریافت نشد."
  };
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
      .bind(String(type).slice(0,40), String(extra.page||url.pathname).slice(0,200), String(type.startsWith("download_") && extra.downloadId ? JSON.stringify({id:String(extra.downloadId).slice(0,80),title:String(extra.title||"").slice(0,180),quality:String(extra.quality||"").slice(0,60)}) : (extra.query||"")).slice(0,400), ref.slice(0,500), refHost.slice(0,120), String(country).slice(0,8), device, session, new Date().toISOString()).run();
  } catch (e) { /* analytics must never interrupt the public product */ }
}
function adminCorsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  const allowed = String(env.VIDPIK_ADMIN_ORIGIN || "https://vidpik-admin.pages.dev").replace(/\/$/, "");
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Vidpik-Session",
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
  if (url.pathname === "/api/admin/upload-image" && request.method === "POST") {
    const bucket=env.VIDPIK_MEDIA;
    if(!bucket) return json({error:"فضای ذخیره‌سازی R2 وصل نیست؛ binding با نام VIDPIK_MEDIA لازم است."},503);
    let form; try{form=await request.formData()}catch{return json({error:"فرم آپلود معتبر نیست."},400)}
    const file=form.get("file");
    if(!file || typeof file.arrayBuffer!=="function") return json({error:"تصویری انتخاب نشده است."},400);
    const types={"image/jpeg":"jpg","image/png":"png","image/webp":"webp","image/gif":"gif"};
    if(!types[file.type] || file.size>5*1024*1024) return json({error:"فقط تصویر JPG، PNG، WebP یا GIF تا ۵ مگابایت مجاز است."},400);
    const key=`ads/${Date.now()}-${crypto.randomUUID()}.${types[file.type]}`;
    await bucket.put(key,await file.arrayBuffer(),{httpMetadata:{contentType:file.type,cacheControl:"public, max-age=31536000, immutable"}});
    const base=String(env.VIDPIK_MEDIA_PUBLIC_URL||"").replace(/\/$/,"");
    if(!base) return json({error:"متغیر VIDPIK_MEDIA_PUBLIC_URL برای دامنه عمومی R2 تنظیم نشده است."},503);
    return json({ok:true,url:base+"/"+key});
  }
  if (url.pathname === "/api/admin/stats" && request.method === "GET") {
    const range = Math.max(1,Math.min(90,Number(url.searchParams.get("range")||7)));
    const since = new Date(Date.now()-range*86400000).toISOString();
    const one = async (sql,...args) => (await db.prepare(sql).bind(...args).first()) || {};
    const count = async type => (await one("SELECT COUNT(*) n FROM analytics_events WHERE event_type=? AND created_at>=?",type,since)).n||0;
    const total = await one("SELECT COUNT(*) total, COUNT(DISTINCT session_id) visitors FROM analytics_events WHERE created_at >= ?",since);
    const daily = await db.prepare("SELECT substr(created_at,1,10) day, SUM(event_type='page_view') views, SUM(event_type='search') searches, SUM(event_type='resolve') resolves, SUM(event_type='download_started') downloadStarted, SUM(event_type='download_complete') downloadCompleted, SUM(event_type='download_paused') downloadPaused, SUM(event_type='download_cancelled') downloadCancelled, SUM(event_type='download_failed') downloadFailed FROM analytics_events WHERE created_at>=? GROUP BY day ORDER BY day").bind(since).all();
    const topPages = await db.prepare("SELECT page,COUNT(*) views FROM analytics_events WHERE event_type='page_view' AND created_at>=? GROUP BY page ORDER BY views DESC LIMIT 8").bind(since).all();
    const sources = await db.prepare("SELECT referrer_host source,COUNT(*) visits FROM analytics_events WHERE created_at>=? GROUP BY source ORDER BY visits DESC LIMIT 8").bind(since).all();
    const countries = await db.prepare("SELECT country,COUNT(*) visits FROM analytics_events WHERE created_at>=? GROUP BY country ORDER BY visits DESC LIMIT 8").bind(since).all();
    const devices = await db.prepare("SELECT device,COUNT(*) visits FROM analytics_events WHERE created_at>=? GROUP BY device ORDER BY visits DESC").bind(since).all();
    const topSearches = await db.prepare("SELECT query_text query,COUNT(*) searches,MAX(created_at) lastSeen FROM analytics_events WHERE event_type='search' AND created_at>=? AND TRIM(query_text)<>'' GROUP BY query_text ORDER BY searches DESC,lastSeen DESC LIMIT 30").bind(since).all();
    const latestSearches = await db.prepare("SELECT query_text query,country,device,created_at FROM analytics_events WHERE event_type='search' AND created_at>=? ORDER BY id DESC LIMIT 50").bind(since).all();
    const latestDownloads = await db.prepare("SELECT event_type,query_text,session_id,created_at FROM analytics_events WHERE event_type LIKE 'download_%' AND created_at>=? ORDER BY id DESC LIMIT 2000").bind(since).all();
    const activeById = new Map();
    for (const row of latestDownloads.results||[]) {
      let meta={}; try{meta=JSON.parse(row.query_text||"{}")}catch{}
      const id=meta.id ? row.session_id+":"+meta.id : row.session_id+":"+row.query_text;
      if(!activeById.has(id)) activeById.set(id,{...row,meta});
    }
    const states=[...activeById.values()];
    const activeCutoff=Date.now()-6*60*60*1000;
    const downloadActive=states.filter(x=>["download_started","download_resumed"].includes(x.event_type) && Date.parse(x.created_at)>=activeCutoff).length;
    const downloadPaused=states.filter(x=>x.event_type==="download_paused").length;
    const downloadCompleted=await count("download_complete");
    const downloadCancelled=await count("download_cancelled");
    const downloadFailed=await count("download_failed");
    const recent = await db.prepare("SELECT event_type,page,query_text,referrer_host,country,device,created_at FROM analytics_events ORDER BY id DESC LIMIT 30").all();
    return json({range,total:total.total||0,visitors:total.visitors||0,views:await count("page_view"),searches:await count("search"),resolves:await count("resolve"),downloads:(await one("SELECT COUNT(*) n FROM analytics_events WHERE event_type IN ('download_started','download') AND created_at>=?",since)).n||0,downloadCompleted,downloadPaused,downloadActive,downloadCancelled,downloadFailed,downloadIncomplete:downloadCancelled+downloadFailed,daily:daily.results||[],topPages:topPages.results||[],sources:sources.results||[],countries:countries.results||[],devices:devices.results||[],topSearches:topSearches.results||[],latestSearches:latestSearches.results||[],recent:recent.results||[]});
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
      if (!["page_view","search","resolve","download","download_started","download_complete","download_failed","download_cancelled","download_paused","download_resumed","ad_click"].includes(type)) return json({error:"رویداد نامعتبر است."},400);
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
      // Only return real Aparat video pages. General Google results are not playable videos.
      const normalize = (list) => (Array.isArray(list) ? list : []).map(item => {
        const link = String(item.link || item.url || "");
        let parsed;
        try { parsed = new URL(link); } catch { return null; }
        const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
        const validHost = host === "aparat.com" || host.endsWith(".aparat.com") || host === "aparat.ir" || host.endsWith(".aparat.ir");
        const videoPath = /^\/v\/[a-zA-Z0-9_-]{3,40}(?:\/|$)/.test(parsed.pathname);
        if (parsed.protocol !== "https:" || !validHost || !videoPath) return null;
        let thumbnail = String(item.thumbnail || item.image || item.pagemap?.cse_thumbnail?.[0]?.src || item.pagemap?.cse_image?.[0]?.src || "");
        try { const imageUrl = new URL(thumbnail); if (imageUrl.protocol !== "https:") thumbnail = ""; else thumbnail = imageUrl.href; } catch { thumbnail = ""; }
        return {
          title: String(item.title || "ویدیوی آپارات").slice(0, 300),
          url: parsed.href,
          thumbnail,
          snippet: String(item.snippet || item.description || "").slice(0, 500),
          uploader: host,
          source: "آپارات",
          isAparat: true
        };
      }).filter(Boolean);
      try {
        // First-party Aparat search: relevance-ranked videos and channels, no Google site: restriction.
        // Aparat's public web client currently exposes a mixed-search endpoint; only video records
        // are returned to VidPik because channel pages are not directly playable downloads.
        const nextToken = (url.searchParams.get("next") || "").slice(0, 2000);
        const aparatEndpoint = new URL("https://www.aparat.com/api/v0/search/mix/" + encodeURIComponent(q));
        if (nextToken) {
          aparatEndpoint.searchParams.set("nextq", nextToken);
          aparatEndpoint.searchParams.set("isnextpage", "true");
        }
        const aparatResponse = await fetch(aparatEndpoint.toString(), {
          headers: {
            "accept": "*/*",
            "accept-language": "fa-IR,fa;q=0.9,en;q=0.8",
            "origin": "https://www.aparat.com",
            "referer": "https://www.aparat.com/",
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin"
          },
          cf: { cacheTtl: 30, cacheEverything: false }
        });
        const aparatBody = await aparatResponse.json().catch(() => null);
        if (aparatResponse.ok && aparatBody && !aparatBody.error) {
          const block = aparatBody.data?.[0] || {};
          const mixed = block.mixV2?.data || [];
          const seen = new Set();
          const items = mixed.filter(x => x?.type === "Video" && x?.data?.uid)
            .map(x => {
              const v = x.data;
              const uid = String(v.uid);
              if (!/^[a-zA-Z0-9_-]{3,40}$/.test(uid) || seen.has(uid)) return null;
              seen.add(uid);
              const candidates = [
                v.small_poster, v.medium_poster, v.big_poster, v.poster,
                v.thumbnail, v.image, v.pic
              ];
              let thumbnail = candidates.find(x => typeof x === "string" && /^https:\/\//i.test(x)) || "";
              return {
                title: String(v.title || "ویدیوی آپارات").slice(0, 300),
                url: "https://www.aparat.com/v/" + uid,
                thumbnail,
                snippet: String(v.description || v.meta_description || "").slice(0, 500),
                uploader: String(v.sender_name || v.username || "آپارات").slice(0, 100),
                source: "جستجوی مستقیم آپارات",
                isAparat: true
              };
            }).filter(Boolean);
          const nextUrl = String(block.link?.next || "");
          let next = "";
          try { next = new URL(nextUrl, "https://www.aparat.com").searchParams.get("nextq") || ""; } catch {}
          return json({ items, page, hasMore: Boolean(next), next, provider: "جستجوی مستقیم آپارات" });
        }
        // If Aparat's unofficial endpoint is temporarily unavailable, keep the existing search providers.
        if (env.SERPAPI_KEY) {
          const endpoint = new URL("https://serpapi.com/search.json");
          endpoint.searchParams.set("engine", "google");
          endpoint.searchParams.set("q", "site:aparat.com/v " + q);
          endpoint.searchParams.set("num", "10");
          endpoint.searchParams.set("start", String((page - 1) * 10));
          endpoint.searchParams.set("api_key", env.SERPAPI_KEY);
          const upstream = await fetch(endpoint.toString(), { headers: { "accept": "application/json" } });
          const body = await upstream.json().catch(() => null);
          if (upstream.ok && body && Array.isArray(body.organic_results)) {
            const items = normalize(body.organic_results);
            return json({ items, page, hasMore: Boolean(body.serpapi_pagination?.next), next: "", provider: "جستجوی پشتیبان گوگل" });
          }
        }
        if (env.GOOGLE_API_KEY && env.GOOGLE_CSE_ID) {
          const endpoint = new URL("https://www.googleapis.com/customsearch/v1");
          endpoint.searchParams.set("key", env.GOOGLE_API_KEY);
          endpoint.searchParams.set("cx", env.GOOGLE_CSE_ID);
          endpoint.searchParams.set("q", "site:aparat.com/v " + q);
          endpoint.searchParams.set("num", "10");
          endpoint.searchParams.set("start", String((page - 1) * 10 + 1));
          const upstream = await fetch(endpoint.toString(), { headers: { "accept": "application/json" } });
          const body = await upstream.json().catch(() => null);
          if (upstream.ok && body && Array.isArray(body.items)) {
            const items = normalize(body.items.map(x => ({ ...x, thumbnail: x.pagemap?.cse_thumbnail?.[0]?.src || x.pagemap?.cse_image?.[0]?.src || "" })));
            return json({ items, page, hasMore: Boolean(body.queries?.nextPage?.length), next: "", provider: "جستجوی پشتیبان گوگل" });
          }
        }
        return json({ error: "جستجوی آپارات فعلاً پاسخ نداد. چند لحظه بعد دوباره تلاش کن." }, 502);
      } catch (error) {
        return json({ error: "ارتباط با جستجوی آپارات ناموفق بود. اتصال اینترنت را بررسی کن و دوباره تلاش کن." }, 502);
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
