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
  const seen = new Set();
  const add = (raw, quality, type) => {
    if (typeof raw !== "string" || !safeMediaUrl(raw) || seen.has(raw)) return;
    seen.add(raw);
    candidates.push({
      quality: String(quality || "کیفیت موجود").slice(0, 80),
      url: raw,
      type: String(type || "").slice(0, 100)
    });
  };
  const walk = (value, fallback = "کیفیت موجود", depth = 0) => {
    if (depth > 6 || value == null) return;
    if (typeof value === "string") { add(value, fallback); return; }
    if (Array.isArray(value)) { for (const item of value) walk(item, fallback, depth + 1); return; }
    if (typeof value !== "object") return;
    const quality = value.profile || value.quality || value.label || value.resolution || value.height || value.name || fallback;
    const type = value.type || value.mime_type || value.mimeType || "";
    for (const key of ["url", "src", "file", "link", "file_link", "download_url"]) {
      if (typeof value[key] === "string") add(value[key], quality, type);
    }
    for (const key of ["urls", "files", "sources", "streams", "items", "links", "qualities"]) {
      if (value[key] != null) walk(value[key], quality, depth + 1);
    }
  };
  for (const key of ["file_link_all", "file_link", "download_link", "download_links", "multiSRC", "sources", "streams", "qualities", "files"]) {
    if (attrs && attrs[key] != null) walk(attrs[key], attrs.profile || "کیفیت موجود");
  }
  candidates.sort((a, b) => {
    const ah = Number((String(a.quality).match(/\d{3,4}/) || [0])[0]);
    const bh = Number((String(b.quality).match(/\d{3,4}/) || [0])[0]);
    return bh - ah;
  });
  return candidates.slice(0, 30);
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
      mediaSources: [],
      downloadAllowed: false,
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
    mediaSources: downloads,
    downloadAllowed: downloads.length > 0,
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
  if (url.pathname === "/api/admin/feedback" && request.method === "GET") {
    const rows = await db.prepare("SELECT id,session_id,type,name,contact,message,reply,status,created_at,replied_at FROM feedback_messages ORDER BY id DESC LIMIT 300").all();
    return json({items:rows.results||[]});
  }
  if (url.pathname === "/api/admin/feedback/reply" && request.method === "POST") {
    let body={}; try { body=await request.json(); } catch { return json({error:"داده‌های پاسخ معتبر نیست."},400); }
    const id=Number(body.id), reply=String(body.reply||"").trim();
    if (!Number.isSafeInteger(id) || id<1 || reply.length<1 || reply.length>2000) return json({error:"شناسه پیام یا متن پاسخ معتبر نیست."},400);
    const result=await db.prepare("UPDATE feedback_messages SET reply=?,status='answered',replied_at=? WHERE id=?").bind(reply,new Date().toISOString(),id).run();
    if (!result.meta?.changes) return json({error:"پیام پیدا نشد."},404);
    return json({ok:true});
  }
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
    const adRows = await db.prepare("SELECT query_text ad_id,page placement,SUM(event_type='ad_impression') impressions,SUM(event_type='ad_click') clicks,COUNT(DISTINCT CASE WHEN event_type='ad_impression' THEN session_id END) unique_viewers,MAX(created_at) last_seen FROM analytics_events WHERE event_type IN ('ad_impression','ad_click') AND created_at>=? AND TRIM(query_text)<>'' GROUP BY query_text,page ORDER BY impressions DESC,clicks DESC").bind(since).all();
    const adStats = (adRows.results||[]).map(x=>({...x,ctr:Number(x.impressions)>0?Math.round(Number(x.clicks)/Number(x.impressions)*10000)/100:0}));
    return json({range,adStats,total:total.total||0,visitors:total.visitors||0,views:await count("page_view"),searches:await count("search"),resolves:await count("resolve"),downloads:(await one("SELECT COUNT(*) n FROM analytics_events WHERE event_type IN ('download_started','download') AND created_at>=?",since)).n||0,downloadCompleted,downloadPaused,downloadActive,downloadCancelled,downloadFailed,downloadIncomplete:downloadCancelled+downloadFailed,daily:daily.results||[],topPages:topPages.results||[],sources:sources.results||[],countries:countries.results||[],devices:devices.results||[],topSearches:topSearches.results||[],latestSearches:latestSearches.results||[],recent:recent.results||[]});
  }
  if (url.pathname === "/api/admin/ads" && request.method === "GET") {
    const rows = await db.prepare("SELECT setting_key,setting_value FROM site_settings WHERE setting_key LIKE 'ad_%'").all();
    const out={}; for (const r of rows.results||[]) { try { out[r.setting_key.slice(3)]=JSON.parse(r.setting_value); } catch {} }
    return json(out);
  }
  if (url.pathname === "/api/admin/ads" && request.method === "PUT") {
    let body={}; try { body=await request.json(); } catch { return json({error:"داده‌های ارسالی معتبر نیست."},400); }
    const allowed=["home"];
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
  if (url.pathname === "/api/admin/searches" && request.method === "GET") {
    const limit = 100;
    const offset = Math.max(0, Math.min(10000000, Number.parseInt(url.searchParams.get("offset") || "0", 10) || 0));
    const term = String(url.searchParams.get("q") || "").trim().slice(0, 180);
    const where = "event_type='search' AND TRIM(query_text)<>''" + (term ? " AND query_text LIKE ?" : "");
    const args = term ? ["%" + term.replace(/[\\%_]/g, "\\$&") + "%"] : [];
    const totalRow = await db.prepare("SELECT COUNT(*) total FROM analytics_events WHERE " + where).bind(...args).first();
    const rows = await db.prepare("SELECT id,query_text query,country,device,created_at,referrer_host FROM analytics_events WHERE " + where + " ORDER BY id DESC LIMIT ? OFFSET ?").bind(...args, limit, offset).all();
    return json({searches:rows.results||[],total:totalRow?.total||0,offset,limit,hasMore:offset+limit<(totalRow?.total||0)});
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

    if (url.pathname === "/api/feedback" && request.method === "POST") {
      const db=getDb(env); if(!db) return json({error:"سامانه پیام‌ها هنوز به پایگاه داده متصل نشده است."},503);
      let body={}; try { body=await request.json(); } catch { return json({error:"پیام ارسالی معتبر نیست."},400); }
      const session=String(request.headers.get("x-vidpik-session")||"").trim().slice(0,80);
      const type=String(body.type||"نظر").trim().slice(0,40), name=String(body.name||"").trim().slice(0,60), contact=String(body.contact||"").trim().slice(0,120), message=String(body.message||"").trim();
      if(!/^[A-Za-z0-9_-]{8,80}$/.test(session)) return json({error:"شناسه نشست معتبر نیست؛ صفحه را تازه‌سازی کن."},400);
      if(!["نظر","پیشنهاد","گزارش مشکل","پشتیبانی"].includes(type) || message.length<4 || message.length>2000) return json({error:"نوع یا متن پیام معتبر نیست؛ پیام باید بین ۴ تا ۲۰۰۰ حرف باشد."},400);
      await db.prepare("INSERT INTO feedback_messages(session_id,type,name,contact,message,status,created_at) VALUES(?,?,?,?,?,'new',?)").bind(session,type,name,contact,message,new Date().toISOString()).run();
      return json({ok:true});
    }
    if (url.pathname === "/api/feedback" && request.method === "GET") {
      const db=getDb(env); if(!db) return json({error:"سامانه پیام‌ها هنوز آماده نیست."},503);
      const session=String(url.searchParams.get("session")||"").trim().slice(0,80);
      if(!/^[A-Za-z0-9_-]{8,80}$/.test(session)) return json({error:"شناسه نشست معتبر نیست."},400);
      const rows=await db.prepare("SELECT id,type,message,reply,status,created_at,replied_at FROM feedback_messages WHERE session_id=? ORDER BY id DESC LIMIT 50").bind(session).all();
      return json({items:rows.results||[]});
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
            if (key === "home" && item.enabled && (!item.start || item.start<=today) && (!item.end || item.end>=today)) ads.home=item;
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
      if (!["page_view","search","resolve","download","download_started","download_complete","download_failed","download_cancelled","download_paused","download_resumed","ad_click","ad_impression"].includes(type)) return json({error:"رویداد نامعتبر است."},400);
      await recordEvent(env,type,request,{query:body.query||body.adId||"",page:body.page||"/"});
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
      if (page === 1) await recordEvent(env,"search",request,{query:q});
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
          // Collect every video object in the response; Aparat changes the mix nesting periodically.
          const seen = new Set();
          const videoNodes = [];
          const visited = new WeakSet();
          const walk = (node, depth = 0) => {
            if (!node || typeof node !== "object" || depth > 12 || visited.has(node)) return;
            visited.add(node);
            if (Array.isArray(node)) { for (const child of node) walk(child, depth + 1); return; }
            const type = String(node.type || node.kind || "").toLowerCase();
            const candidate = node.data && typeof node.data === "object" ? node.data : node;
            const uid = String(candidate.uid || candidate.video_hash || candidate.videohash || candidate.hash_id || "");
            if ((type === "video" || (uid && (candidate.title || candidate.sender_name))) &&
                /^[a-zA-Z0-9_-]{3,40}$/.test(uid)) videoNodes.push(candidate);
            for (const [key, value] of Object.entries(node)) {
              if (key !== "link" && key !== "links") walk(value, depth + 1);
            }
          };
          walk(aparatBody);
          const items = videoNodes.map(v => {
            const uid = String(v.uid || v.video_hash || v.videohash || v.hash_id);
            if (seen.has(uid)) return null;
            seen.add(uid);
            const candidates = [v.small_poster, v.medium_poster, v.big_poster, v.poster, v.thumbnail, v.image, v.pic];
            const thumbnail = candidates.find(x => typeof x === "string" && /^https:\/\//i.test(x)) || "";
            return {
              title: String(v.title || v.name || "ویدیوی آپارات").slice(0, 300),
              url: "https://www.aparat.com/v/" + uid,
              thumbnail,
              snippet: String(v.description || v.meta_description || "").slice(0, 500),
              uploader: String(v.sender_name || v.username || v.owner?.name || "آپارات").slice(0, 100),
              source: "جستجوی مستقیم آپارات",
              isAparat: true
            };
          }).filter(Boolean);
          let next = "";
          const findNext = (node, depth = 0) => {
            if (!node || typeof node !== "object" || depth > 10 || next) return;
            if (Array.isArray(node)) { for (const child of node) findNext(child, depth + 1); return; }
            const raw = node.link?.next || node.links?.next || node.next;
            if (typeof raw === "string" && raw) {
              try { next = new URL(raw, "https://www.aparat.com").searchParams.get("nextq") || ""; } catch {}
            }
            for (const value of Object.values(node)) findNext(value, depth + 1);
          };
          findNext(aparatBody);
          // Merge indexed Aparat video pages as a second discovery source when configured.
          // This helps surface uploads that the current Aparat mixed-search response omits.
          let secondaryHasMore = false;
          try {
            let secondary = [];
            if (env.SERPAPI_KEY) {
              const endpoint = new URL("https://serpapi.com/search.json");
              endpoint.searchParams.set("engine", "google");
              endpoint.searchParams.set("q", "site:aparat.com/v " + q);
              endpoint.searchParams.set("num", "10");
              endpoint.searchParams.set("start", String((page - 1) * 10));
              endpoint.searchParams.set("api_key", env.SERPAPI_KEY);
              const response = await fetch(endpoint.toString(), { headers: { "accept": "application/json" } });
              const body = await response.json().catch(() => null);
              if (response.ok && Array.isArray(body?.organic_results)) {
                secondary = normalize(body.organic_results);
                secondaryHasMore = Boolean(body.serpapi_pagination?.next);
              }
            } else if (env.GOOGLE_API_KEY && env.GOOGLE_CSE_ID) {
              const endpoint = new URL("https://www.googleapis.com/customsearch/v1");
              endpoint.searchParams.set("key", env.GOOGLE_API_KEY);
              endpoint.searchParams.set("cx", env.GOOGLE_CSE_ID);
              endpoint.searchParams.set("q", "site:aparat.com/v " + q);
              endpoint.searchParams.set("num", "10");
              endpoint.searchParams.set("start", String((page - 1) * 10 + 1));
              const response = await fetch(endpoint.toString(), { headers: { "accept": "application/json" } });
              const body = await response.json().catch(() => null);
              if (response.ok && Array.isArray(body?.items)) {
                secondary = normalize(body.items);
                secondaryHasMore = Boolean(body.queries?.nextPage?.length);
              }
            }
            const known = new Set(items.map(item => item.url));
            for (const item of secondary) if (!known.has(item.url)) { known.add(item.url); items.push(item); }
          } catch (_) { /* primary Aparat results remain usable if indexing provider is unavailable */ }
          return json({ items, page, hasMore: Boolean(next) || secondaryHasMore, next, provider: "آپارات + جستجوی تکمیلی" });
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
    // Inline media proxy for the internal player; forwards byte ranges for seeking.
    if (url.pathname === "/api/stream") {
      if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "فقط GET و HEAD پذیرفته می‌شود." }, 405);
      const raw = url.searchParams.get("url");
      if (!raw || raw.length > 4096 || !safeMediaUrl(raw)) return json({ error: "لینک فایل ویدیویی معتبر نیست." }, 400);
      try {
        const upstream = await fetch(raw, {
          method: request.method,
          headers: {
            "accept": "video/*, application/vnd.apple.mpegurl, application/octet-stream;q=0.9, */*;q=0.8",
            ...(request.headers.has("range") ? { "range": request.headers.get("range") } : {})
          },
          redirect: "follow"
        });
        if (!safeMediaUrl(upstream.url || raw)) return json({ error: "منبع پخش به دامنه تأییدنشده هدایت شد." }, 502);
        if (!upstream.ok && upstream.status !== 206) return json({ error: "دریافت جریان ویدیو ناموفق بود (HTTP " + upstream.status + ")." }, 502);
        const contentType = (upstream.headers.get("content-type") || "application/octet-stream").toLowerCase();
        if (contentType.includes("text/html") || contentType.includes("application/json")) return json({ error: "منبع به‌جای ویدیو، صفحه وب برگرداند." }, 502);
        const headers = new Headers({
          "content-type": contentType,
          "content-disposition": "inline",
          "cache-control": "no-store, no-transform",
          "x-content-type-options": "nosniff",
          "accept-ranges": upstream.headers.get("accept-ranges") || "bytes"
        });
        for (const name of ["content-length", "content-range", "accept-ranges"]) {
          const value = upstream.headers.get(name);
          if (value) headers.set(name, value);
        }
        return new Response(request.method === "HEAD" ? null : upstream.body, { status: upstream.status, headers });
      } catch {
        return json({ error: "ارتباط با منبع پخش ویدیو ناموفق بود." }, 502);
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
        const extension = /webm/i.test(contentType) ? "webm" : /quicktime/i.test(contentType) ? "mov" : "mp4";
        const disposition = `attachment; filename="VidPik-video.${extension}"`;
        const headers = new Headers({
          "content-type": contentType || "application/octet-stream",
          "content-disposition": disposition,
          "cache-control": "no-store, no-transform",
          "x-content-type-options": "nosniff",
          "accept-ranges": upstream.headers.get("accept-ranges") || "bytes"
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
