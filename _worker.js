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


const DEFAULT_ADS = {home:{text:"",enabled:false},before:{text:"",enabled:false},during:{text:"",enabled:false}};
function b64url(bytes) { let s=""; for (const b of bytes) s+=String.fromCharCode(b); return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,""); }
function unb64url(s) { s=s.replace(/-/g,"+").replace(/_/g,"/"); const b=atob(s+"=".repeat((4-s.length%4)%4)); return Uint8Array.from(b,c=>c.charCodeAt(0)); }
async function makeToken(payload, secret) { const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]); const data=b64url(new TextEncoder().encode(JSON.stringify(payload))); const sig=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(data)); return data+"."+b64url(new Uint8Array(sig)); }
async function checkToken(token, secret) { try { const [data,sig]=token.split("."); const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["verify"]); if(!await crypto.subtle.verify("HMAC",key,unb64url(sig),new TextEncoder().encode(data))) return false; return JSON.parse(new TextDecoder().decode(unb64url(data))).exp > Date.now()/1000; } catch { return false; } }
async function bodyJson(req) { try { return await req.json(); } catch { return {}; } }
async function getAds(env) { if(!env.VIDPIK_KV) return DEFAULT_ADS; try { return await env.VIDPIK_KV.get("vidpik:ads","json") || DEFAULT_ADS; } catch { return DEFAULT_ADS; } }
async function increment(env,key) { if(!env.VIDPIK_KV) return; const k="vidpik:stat:"+key; const n=Number(await env.VIDPIK_KV.get(k)||0); await env.VIDPIK_KV.put(k,String(n+1)); }
async function isAdmin(req,env) { const secret=env.VIDPIK_ADMIN_SECRET; const auth=req.headers.get("Authorization")||""; return !!secret && auth.startsWith("Bearer ") && checkToken(auth.slice(7),secret); }
function cleanSearchItem(item) {
 const a=item?.attributes||item||{}; const title=String(a.title||a.name||"").slice(0,300); const hash=a.uid||a.video_hash||a.hash||item?.uid||item?.video_hash||"";
 let url=a.url||item?.url||(hash?"https://www.aparat.com/v/"+hash:""); let thumbnail=a.big_poster||a.small_poster||a.poster||item?.big_poster||item?.small_poster||""; let uploader=a.username||a.sender_name||item?.username||"";
 try { const u=new URL(url,"https://www.aparat.com"); if(!["aparat.com","www.aparat.com","m.aparat.com"].includes(u.hostname.toLowerCase())||u.protocol!=="https:") return null; url=u.href; } catch { return null; }
 try { const t=new URL(thumbnail); if(t.protocol!=="https:"||!/(^|\.)asset\.aparat\.com$/i.test(t.hostname)) thumbnail=""; } catch { thumbnail=""; }
 return title?{title,url,thumbnail,uploader:String(uploader).slice(0,120)}:null;
}
async function searchAparat(q) { const r=await fetch("https://www.aparat.com/api/fa/v1/video/video/search?q="+encodeURIComponent(q)+"&limit=12",{headers:{accept:"application/json, text/plain, */*","user-agent":"Mozilla/5.0 VidPik"},redirect:"follow"}); if(!r.ok) throw new Error("API جست‌وجوی آپارات پاسخ نداد (HTTP "+r.status+")."); const b=await r.json(); const items=b?.data?.items||b?.data?.videos||b?.items||b?.videos||[]; return (Array.isArray(items)?items:[]).map(cleanSearchItem).filter(Boolean).slice(0,12); }

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return json({ ok: true, service: "public-aparat-link-resolver" });
    if (url.pathname === "/api/download") {
      if (request.method !== "GET") return json({error:"فقط GET پذیرفته می‌شود."},405);
      const raw = url.searchParams.get("url");
      const quality = (url.searchParams.get("quality") || "video").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 20);
      if (!raw || !safeMediaUrl(raw)) return json({error:"آدرس فایل ویدیویی معتبر نیست."},400);
      try {
        const media = new URL(raw);
        const range = request.headers.get("Range");
        const upstreamHeaders = new Headers({"user-agent":"Mozilla/5.0 (compatible; VidPik/1.0)"});
        if (range) upstreamHeaders.set("Range", range);
        const upstream = await fetch(media.href, {headers:upstreamHeaders, redirect:"follow"});
        if (!upstream.ok && upstream.status !== 206) return json({error:"سرور ویدیو فایل را نداد (HTTP "+upstream.status+")."},502);
        const finalUrl = new URL(upstream.url || media.href);
        if (!ALLOWED_MEDIA_HOST_RE.test(finalUrl.hostname)) return json({error:"میزبان فایل مجاز نیست."},502);
        const responseHeaders = new Headers({
          "Content-Type":upstream.headers.get("Content-Type") || "application/octet-stream",
          "Content-Disposition":'attachment; filename="VidPik-'+(quality||"video")+'.mp4"',
          "Cache-Control":"no-store", "X-Content-Type-Options":"nosniff"
        });
        for (const key of ["Content-Length","Content-Range","Accept-Ranges"]) { const value=upstream.headers.get(key); if(value) responseHeaders.set(key,value); }
        try { await increment(env,"downloads"); } catch {}
        return new Response(upstream.body,{status:upstream.status,headers:responseHeaders});
      } catch { return json({error:"دریافت فایل ناموفق بود؛ دوباره تلاش کن."},502); }
    }


    if (url.pathname === "/api/event" && request.method === "POST") {
      const body = await bodyJson(request); const map={view:"views",search:"searches",resolve:"resolves",download:"downloads"};
      if(map[body.type]) { try { await increment(env,map[body.type]); } catch {} }
      return json({ok:true});
    }
    if (url.pathname === "/api/ads" && request.method === "GET") return json(await getAds(env));
    if (url.pathname === "/api/search" && request.method === "GET") {
      const q=(url.searchParams.get("q")||"").trim().slice(0,120); if(!q) return json({error:"عبارت جست‌وجو را وارد کن."},400);
      try { return json({items:await searchAparat(q)}); } catch(e) { return json({error:e instanceof Error?e.message:"جست‌وجو ناموفق بود."},502); }
    }
    if (url.pathname.startsWith("/api/admin/")) {
      if (url.pathname === "/api/admin/login" && request.method === "POST") {
        if(!env.VIDPIK_ADMIN_PASSWORD||!env.VIDPIK_ADMIN_SECRET) return json({error:"در Cloudflare متغیرهای VIDPIK_ADMIN_PASSWORD و VIDPIK_ADMIN_SECRET را تنظیم کن."},503);
        const body=await bodyJson(request); if(body.password!==env.VIDPIK_ADMIN_PASSWORD) return json({error:"رمز مدیر اشتباه است."},401);
        const now=Math.floor(Date.now()/1000); return json({token:await makeToken({iat:now,exp:now+43200},env.VIDPIK_ADMIN_SECRET)});
      }
      if(!await isAdmin(request,env)) return json({error:"دسترسی مدیر معتبر نیست؛ دوباره وارد شو."},401);
      if(url.pathname==="/api/admin/stats"&&request.method==="GET") { const stats={}; for(const k of ["views","searches","resolves","downloads"]) stats[k]=env.VIDPIK_KV?Number(await env.VIDPIK_KV.get("vidpik:stat:"+k)||0):0; return json(stats); }
      if(url.pathname==="/api/admin/ads"&&request.method==="GET") return json(await getAds(env));
      if(url.pathname==="/api/admin/ads"&&request.method==="PUT") {
        if(!env.VIDPIK_KV) return json({error:"برای ذخیره‌سازی، یک KV Namespace با نام VIDPIK_KV وصل کن."},503);
        const body=await bodyJson(request); const ads={}; for(const k of ["home","before","during"]) ads[k]={text:String(body[k]?.text||"").slice(0,1000),enabled:body[k]?.enabled===true};
        await env.VIDPIK_KV.put("vidpik:ads",JSON.stringify(ads)); return json({ok:true});
      }
      return json({error:"مسیر مدیریت پیدا نشد."},404);
    }

    if (url.pathname === "/api/resolve") {
      if (request.method !== "GET") return json({ error: "فقط درخواست GET پذیرفته می‌شود." }, 405);
      const raw = url.searchParams.get("url");
      if (!raw || raw.length > 2048) return json({ error: "لینک ویدیو را وارد کن." }, 400);
      try {
        const result = await resolveAparat(raw);
        try { await increment(env, "resolves"); } catch {}
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
