#!/usr/bin/env node
/**
 * 周末徒哪儿 · 数据管道（发现 / 发布两层分离）
 *
 * 发现层（本机，住宅 IP + 有头浏览器过 WAF，建议每日 launchd 运行）：
 *   --discover   两步路榜单/关键词发现新轨迹 → 完整 line + 照片本地化 → 就近归城入库
 *   --ingest     解析 scripts/submissions.json 用户投稿链接（同样本机有头）
 *
 * 发布层（CI 每周一离线运行，完全不访问两步路）：
 *   --rotate --write   从 track-library 库存按天气/季节/历史去重轮选 3 城，模板生成 routes.json
 *   --fares            Google Flights 机票快照（best-effort，失败保留旧快照）
 *
 * 兼容旧用法：
 *   无参数 = 按 weekly-tracks.json 刷新固定轨迹（旧管道）
 *   --seed            从当前 routes.json 把 6 条轨迹导入库存（首次升级用一次）
 *   --photos-only     仅下载 routes.json 现有照片
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  buildEdition,
  buildGroups,
  buildRoute,
  lineCenter,
  nearestDestination,
  normalizeLibrary,
  selectGroups,
  PAIR_DISTANCE_KM,
  WEEKLY_PICK_COUNT,
} from "./lib/rotation.mjs";
import { describeWeatherCode } from "../src/lib/weekend.js";
import { launchRealChrome } from "./lib/cdp-browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const ROUTES_JSON = path.join(ROOT, "src/data/routes.json");
const FARES_JSON = path.join(ROOT, "src/data/fares.json");
const WEEKLY_JSON = path.join(HERE, "weekly-tracks.json");
const SUBMISSIONS_JSON = path.join(HERE, "submissions.json");
const LIBRARY_JSON = path.join(HERE, "track-library.json");
const DESTINATIONS_JSON = path.join(HERE, "lib/destinations.json");
const PUBLISHED_JSON = path.join(HERE, "published.json");
const DISCOVER_QUEUE_JSON = path.join(HERE, "discover-queue.json");
const PHOTO_ROOT = path.join(ROOT, "public/photos");
const PROFILE_DIR = path.join(ROOT, ".pw-profile");
const CDP_PROFILE_DIR = path.join(ROOT, ".chrome-cdp");
const CDP_PORT = Number(process.env.CDP_PORT || 9222);

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const PHOTO_BASE = "https://down-files.2bulu.com/f/d1?downParams=";
const TARGET_POINTS = 90;
// 本地有头模式留足手动过 WAF 的时间；GitHub Actions 无头被 WAF 拦是预期降级，快速失败保留旧数据。
// 注意不能只看 CI：本机 agent shell 也带 CI=true，会把发现层等待误缩到 45s。
const WAIT_TRACK_MS = process.env.FETCH_WAIT_MS
  ? Number(process.env.FETCH_WAIT_MS)
  : process.env.GITHUB_ACTIONS
    ? 45_000
    : 180_000;

const STEALTH_SCRIPT = () => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh", "en"] });
  Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
  if (!window.chrome) window.chrome = { runtime: {} };
  const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
  if (originalQuery) {
    window.navigator.permissions.query = (parameters) =>
      parameters && parameters.name === "notifications"
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);
  }
};

const log = (...a) => console.log("[fetch-routes]", ...a);
const warn = (...a) => console.warn("[fetch-routes][warn]", ...a);

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};
const writeJson = (file, data) => fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
const loadRoutes = () => readJson(ROUTES_JSON, []);
const saveRoutes = (data) => writeJson(ROUTES_JSON, data);

/**
 * 目标周末日期（北京时间 UTC+8，与周末发布节奏一致）：
 * 管道每周一 20:00 发布"下周周末"的内容，即发布周一 +12/+13 天；
 * 周一 20:00 前仍按上周一发布的那一周计算。
 */
function targetWeekendDates(from = new Date()) {
  const bj = new Date(from.getTime() + 8 * 3_600_000);
  const weekday = bj.getUTCDay(); // 0=周日 … 6=周六
  const refMonday = new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()));
  refMonday.setUTCDate(refMonday.getUTCDate() - ((weekday + 6) % 7));
  if (weekday === 1 && bj.getUTCHours() < 20) {
    refMonday.setUTCDate(refMonday.getUTCDate() - 7);
  }
  const saturday = new Date(refMonday);
  saturday.setUTCDate(refMonday.getUTCDate() + 12); // 周一 +12 = 下周六
  const sunday = new Date(saturday);
  sunday.setUTCDate(saturday.getUTCDate() + 1);
  const iso = (d) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return { depart: iso(saturday), back: iso(sunday) };
}

function normalizePhotoUrl(raw) {
  let u = String(raw || "").trim();
  if (!u) return null;
  if (u.startsWith("//")) return `https:${u}`;
  if (u.startsWith("http")) return u;
  if (!/(==|%3D%3D)/i.test(u)) u += "%3D%3D";
  if (!/%0A$/i.test(u)) u += "%0A";
  return PHOTO_BASE + u;
}

async function downloadPhoto(url, destPath) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Referer: "https://www.2bulu.com/",
      Accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get("content-type") || "";
  if (!type.includes("image")) throw new Error(`not an image (${type})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 5 * 1024) throw new Error(`file too small (${buf.length}b)`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
  return buf.length;
}

function pickSpread(items, n) {
  if (items.length <= n) return items.slice();
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(items[Math.round((i * (items.length - 1)) / (n - 1))]);
  }
  return out;
}

async function materializePhotos(routeId, dayNum, photoEntries) {
  const seen = new Set();
  const urls = [];
  for (const entry of photoEntries) {
    const url = normalizePhotoUrl(entry && entry.u);
    if (url && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  const chosen = pickSpread(urls, 3);
  const localPaths = [];
  for (let i = 0; i < chosen.length; i += 1) {
    const file = `${dayNum}-${i + 1}.jpg`;
    const dest = path.join(PHOTO_ROOT, routeId, file);
    const webPath = `/photos/${routeId}/${file}`;
    try {
      const size = await downloadPhoto(chosen[i], dest);
      log(`  照片 ${webPath} (${(size / 1024).toFixed(0)}KB)`);
      localPaths.push(webPath);
    } catch (err) {
      warn(`照片下载失败，跳过：${err.message} ${chosen[i].slice(0, 90)}`);
    }
  }
  return localPaths;
}

async function extractTrack(page, url, headed) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const deadline = Date.now() + WAIT_TRACK_MS;
  let wafHinted = false;
  while (Date.now() < deadline) {
    const data = await page
      .evaluate(
        ([targetPoints]) => {
          if (!Array.isArray(window.trackLngs) || window.trackLngs.length < 5) return null;
          const photos = (window.trackMarks || [])
            .map((mk) => {
              const p = mk && mk.pointMsg && mk.pointMsg.params;
              if (!p || !p.commnFileUrl) return null;
              if (Number(p.fileType) !== 0) return null;
              return { n: String(mk.pointMsg.text || "").trim(), u: String(p.commnFileUrl).trim() };
            })
            .filter(Boolean);
          const all = window.trackLngs;
          const step = Math.max(1, Math.ceil(all.length / targetPoints));
          const line = all.filter((p, i) => i % step === 0).map((p) => [
            Math.round(p.lng * 100000) / 100000,
            Math.round(p.lat * 100000) / 100000,
          ]);
          const lng = all.reduce((s, p) => s + p.lng, 0) / all.length;
          const lat = all.reduce((s, p) => s + p.lat, 0) / all.length;
          return {
            name: String(window.trackName || "").trim(),
            mileage: Number(window.trackTotalMileage) || null,
            photos,
            line,
            center: [Math.round(lng * 100000) / 100000, Math.round(lat * 100000) / 100000],
            docTitle: document.title,
            // 默认按步行处理，只排除标题里明确标注其他运动类型的（不少步行轨迹标题无类别后缀）
            walk: !/驾车|骑行|水上|飞行|雪地|陆地滑行|驾驶/.test(document.title),
          };
        },
        [TARGET_POINTS],
      )
      .catch(() => null);
    if (data && data.line.length >= 2) return data;

    const bodyText = await page.evaluate(() => (document.body ? document.body.textContent : "")).catch(() => "");
    if (
      bodyText.includes("当前环境") ||
      bodyText.includes("系统异常") ||
      bodyText.includes("客户端异常")
    ) {
      if (!wafHinted) {
        warn(
          headed
            ? "页面被 WAF 拦截，请在弹出的浏览器窗口中完成验证（等待几秒通常自动放行），脚本会继续…"
            : "页面被 WAF 拦截，无头模式可能无法过验证；请改用 npm run fetch:routes -- --headed",
        );
        wafHinted = true;
      }
    }
    await page.waitForTimeout(2000);
  }
  throw new Error("等待轨迹数据超时（WAF 拦截或页面结构变化）");
}

async function extractFlightPrice(page, flightUrl, headed) {
  await page.goto(flightUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const min = await page
      .evaluate(() => {
        const text = document.body ? document.body.innerText : "";
        const prices = [];
        const re = /[¥￥]\s?([\d,]{3,5})/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          const v = Number.parseInt(m[1].replace(/,/g, ""), 10);
          if (v >= 150 && v <= 20000) prices.push(v);
        }
        return prices.length ? Math.min(...prices) : null;
      })
      .catch(() => null);
    if (min) return min;
    await page.waitForTimeout(2500);
  }
  throw new Error("Google Flights 未出现价格（地区限制或页面结构变化）");
}

async function launchBrowser(headed) {
  // 有头发现层走本机真实 Chrome（CDP）：SafeLine WAF 对 Playwright 指纹必拦，
  // 真实 Chrome 指纹为 navigator.webdriver=false，且 cookie/信任在独立 profile 中持久化。
  if (headed && process.platform === "darwin") {
    return launchRealChrome({
      profileDir: CDP_PROFILE_DIR,
      port: CDP_PORT,
      startUrl: "https://www.2bulu.com/",
    });
  }
  const { chromium } = await import("playwright");
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const base = {
    userDataDir: PROFILE_DIR,
    headless: !headed,
    viewport: { width: 1280, height: 900 },
    locale: "zh-CN",
    args: ["--disable-blink-features=AutomationControlled", "--disable-features=IsolateOrigins,site-per-process"],
  };
  const withStealth = (context) => {
    context.addInitScript(STEALTH_SCRIPT);
    return context;
  };
  if (headed) {
    try {
      return withStealth(await chromium.launchPersistentContext(PROFILE_DIR, { ...base, channel: "chrome" }));
    } catch {
      log("未找到本机 Chrome，回退到 Playwright 自带 Chromium");
      return withStealth(await chromium.launchPersistentContext(PROFILE_DIR, base));
    }
  }
  return withStealth(await chromium.launchPersistentContext(PROFILE_DIR, base));
}

function findDay(routes, routeId, dayNum) {
  const route = routes.find((r) => r.id === routeId);
  if (!route) throw new Error(`routes.json 中找不到路线：${routeId}`);
  const day = route.itinerary.days.find((d) => d.day === dayNum);
  if (!day) throw new Error(`${routeId} 中找不到 Day ${dayNum}`);
  return { route, day };
}

async function collectEntry(context, entry, routes) {
  const { route, day } = findDay(routes, entry.routeId, entry.day);
  log(`→ 周路线 ${entry.routeId} Day${entry.day}：${entry.trackUrl}`);
  const page = await context.newPage();
  try {
    await page.setExtraHTTPHeaders({ "Accept-Language": "zh-CN,zh;q=0.9" });
    const data = await extractTrack(page, entry.trackUrl, entry.headed);
    day.bulu_track_url = entry.trackUrl;
    if (data.name) day.bulu_track_name = data.name;
    if (data.line.length >= 2) day.bulu_track_line = data.line;
    const photos = await materializePhotos(entry.routeId, entry.day, data.photos);
    if (photos.length >= 2) {
      day.photos = photos;
    } else {
      warn(`有效照片仅 ${photos.length} 张，保留原有照片字段`);
    }
    if (data.mileage) {
      const km = Math.round(data.mileage * 10) / 10;
      route.daily_distances[`day${entry.day}`] = `${km}km`;
    }
    log(`  ✓ ${data.name || "(未取到轨迹名)"} · ${data.mileage ?? "?"}km · 候选照片 ${data.photos.length} 张 · 轨迹 ${data.line.length} 点`);
    return true;
  } finally {
    await page.close();
  }
}

function refreshTotals(routes) {
  for (const route of routes) {
    const d1 = Number.parseFloat(route.daily_distances?.day1) || 0;
    const d2 = Number.parseFloat(route.daily_distances?.day2) || 0;
    if (d1 || d2) route.overview.total_hiking_km = Math.round((d1 + d2) * 10) / 10;
  }
}

function readEntries(argv) {
  const positional = argv.filter((a) => !a.startsWith("--"));
  if (positional.length >= 3) {
    const [routeId, dayStr, trackUrl] = positional;
    return [{ routeId, day: Number(dayStr), trackUrl }];
  }
  return readJson(WEEKLY_JSON, []);
}

/** 发现/投稿轨迹的照片下载到 public/photos/library/{hash}/，返回 web 路径 */
async function materializeLibraryPhotos(hash, photoEntries) {
  const seen = new Set();
  const urls = [];
  for (const entry of photoEntries) {
    const url = normalizePhotoUrl(entry && entry.u);
    if (url && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  const chosen = pickSpread(urls, 3);
  const localPaths = [];
  for (let i = 0; i < chosen.length; i += 1) {
    const file = `${i + 1}.jpg`;
    const dest = path.join(PHOTO_ROOT, "library", hash, file);
    const webPath = `/photos/library/${hash}/${file}`;
    try {
      const size = await downloadPhoto(chosen[i], dest);
      log(`  照片 ${webPath} (${(size / 1024).toFixed(0)}KB)`);
      localPaths.push(webPath);
    } catch (err) {
      warn(`照片下载失败，跳过：${err.message} ${chosen[i].slice(0, 90)}`);
    }
  }
  return localPaths;
}

const hash8 = (s) => crypto.createHash("md5").update(s).digest("hex").slice(0, 8);
const loadDestinations = () => readJson(DESTINATIONS_JSON, { destinations: [] }).destinations || [];
const loadLibrary = () => normalizeLibrary(readJson(LIBRARY_JSON, null));
const saveLibrary = (lib) => writeJson(LIBRARY_JSON, lib);
const loadPublished = () => readJson(PUBLISHED_JSON, { history: [] });
const savePublished = (p) => writeJson(PUBLISHED_JSON, p);

/** 由 extractTrack 结果构造库存轨迹，并就近归城（超距返回 null） */
function buildLibraryRecord({ url, data, photos, source, submittedAt = null, now }) {
  const record = {
    url,
    name: data.name || "(未命名轨迹)",
    mileage_km: data.mileage ? Math.round(data.mileage * 10) / 10 : null,
    center: data.center,
    line: data.line,
    photos: photos || [],
    city: null,
    destination_slug: null,
    group_id: null,
    day_role: null,
    source,
    submitted_at: submittedAt,
    ingested_at: now,
  };
  if (source === "discover") record.discovered_at = now;
  return record;
}

/** 解析 scripts/submissions.json 用户投稿链接 → track-library.json；失败链接留在队列里等下次重试 */
async function ingestSubmissions(context, headed) {
  const raw = readJson(SUBMISSIONS_JSON, []);
  const submissions = (Array.isArray(raw) ? raw : [])
    .map((item) =>
      typeof item === "string"
        ? { url: item, submittedAt: null }
        : { url: String(item.url || "").trim(), submittedAt: item.submittedAt || null },
    )
    .filter((s) => /2bulu\.com\/track\/t-/i.test(s.url));
  if (!submissions.length) {
    log("投稿队列 scripts/submissions.json 为空，跳过");
    return;
  }
  log(`投稿入库：${submissions.length} 条链接待解析`);
  const destinations = loadDestinations();
  const library = loadLibrary();
  const known = new Set(library.tracks.map((t) => t.url));
  const failed = [];
  const page = await context.newPage();
  try {
    await page.setExtraHTTPHeaders({ "Accept-Language": "zh-CN,zh;q=0.9" });
    for (const sub of submissions) {
      if (known.has(sub.url)) {
        log(`  - 已在库中，跳过：${sub.url.slice(0, 70)}`);
        continue;
      }
      try {
        const data = await extractTrack(page, sub.url, headed);
        const photos = await materializeLibraryPhotos(hash8(sub.url), data.photos);
        const record = buildLibraryRecord({
          url: sub.url,
          data,
          photos,
          source: "submission",
          submittedAt: sub.submittedAt,
          now: new Date().toISOString(),
        });
        const hit = nearestDestination(data.center, destinations);
        if (hit) {
          record.destination_slug = hit.destination.slug;
          record.city = hit.destination.city;
          record.assign_distance_km = hit.distanceKm;
        }
        library.tracks.push(record);
        known.add(sub.url);
        log(`  ✓ 入库：${record.name} · ${record.mileage_km ?? "?"}km · ${record.city || "未归城"} · 照片 ${photos.length} 张`);
      } catch (err) {
        warn(`投稿解析失败（下次自动重试）：${err.message} ${sub.url.slice(0, 70)}`);
        failed.push(sub);
      }
    }
  } finally {
    await page.close();
  }
  const built = buildGroups(library.tracks, destinations);
  saveLibrary({ version: library.version, tracks: built.tracks });
  writeJson(SUBMISSIONS_JSON, failed);
  log(`投稿入库完成：库中共 ${built.tracks.length} 条轨迹 / ${built.groups.length} 个双日组${failed.length ? `，${failed.length} 条失败留待重试` : ""}`);
}

/** best-effort 机票实时快照 → src/data/fares.json；失败保留旧快照 */
async function refreshFares(context, headed) {
  const routes = loadRoutes();
  const { depart, back } = targetWeekendDates();
  const snapshot = readJson(FARES_JSON, { updatedAt: null, routes: {} });
  snapshot.routes = snapshot.routes || {};
  let updated = 0;
  for (const route of routes) {
    const tmpl = route.departure?.flight_url;
    if (!tmpl) continue;
    const url = tmpl.replaceAll("{depart}", depart).replaceAll("{return}", back);
    const page = await context.newPage();
    try {
      log(`→ 机票快照 ${route.id}（${depart} 出发）`);
      const min = await extractFlightPrice(page, url, headed);
      snapshot.routes[route.id] = { flightMinCny: min, fetchedAt: new Date().toISOString(), departDate: depart };
      log(`  ✓ 实时最低价 ¥${min}`);
      updated += 1;
    } catch (err) {
      warn(`机票快照失败，保留旧数据：${err.message}`);
    } finally {
      await page.close();
    }
  }
  if (updated) snapshot.updatedAt = new Date().toISOString();
  writeJson(FARES_JSON, snapshot);
  log(`机票快照完成：更新 ${updated} 条`);
}

async function photosOnly() {
  const routes = loadRoutes();
  let count = 0;
  for (const route of routes) {
    for (const day of route.itinerary.days) {
      const remote = (day.photos || []).filter((p) => /^https?:/.test(p));
      if (!remote.length) continue;
      const next = [];
      for (let i = 0; i < remote.length; i += 1) {
        const webPath = `/photos/${route.id}/${day.day}-${i + 1}.jpg`;
        const dest = path.join(PHOTO_ROOT, route.id, `${day.day}-${i + 1}.jpg`);
        try {
          if (!fs.existsSync(dest)) {
            const size = await downloadPhoto(remote[i], dest);
            log(`下载 ${webPath} (${(size / 1024).toFixed(0)}KB)`);
          }
          next.push(webPath);
          count += 1;
        } catch (err) {
          warn(`${webPath} 下载失败，保留远程 URL：${err.message}`);
          next.push(remote[i]);
        }
      }
      day.photos = next;
    }
  }
  saveRoutes(routes);
  log(`照片自托管完成，${count} 张已本地化 → public/photos/`);
}

/** 首次升级：把当前 routes.json 里的 6 条真实轨迹（含 line/本地照片）导入库存 */
function seedLibrary() {
  const routes = loadRoutes();
  const destinations = loadDestinations();
  const library = loadLibrary();
  const known = new Set(library.tracks.map((t) => t.url));
  let added = 0;
  const now = new Date().toISOString();
  for (const route of routes) {
    for (const day of route.itinerary.days) {
      const url = day.bulu_track_url;
      if (!url || known.has(url)) continue;
      if (!Array.isArray(day.bulu_track_line) || day.bulu_track_line.length < 2) {
        warn(`种子缺少 line，跳过：${route.id} Day${day.day}`);
        continue;
      }
      const km = Number.parseFloat(route.daily_distances?.[`day${day.day}`] || "") || null;
      library.tracks.push({
        url,
        name: day.bulu_track_name || `${route.title} · Day ${day.day}`,
        mileage_km: km ? Math.round(km * 10) / 10 : null,
        center: lineCenter(day.bulu_track_line),
        line: day.bulu_track_line,
        photos: Array.isArray(day.photos) ? day.photos : [],
        city: route.weather_info?.target_city || null,
        destination_slug: route.id,
        group_id: route.id,
        day_role: day.day,
        source: "seed",
        ingested_at: now,
      });
      known.add(url);
      added += 1;
    }
  }
  const built = buildGroups(library.tracks, destinations);
  saveLibrary({ version: library.version, tracks: built.tracks });
  log(`种子导入完成：新增 ${added} 条，库存共 ${built.tracks.length} 条轨迹 / ${built.groups.length} 个完整双日组`);
  for (const g of built.groups) {
    log(`  · ${g.slug} [${g.id}] Day1 ${g.tracks[0].mileage_km ?? "?"}km + Day2 ${g.tracks[1].mileage_km ?? "?"}km`);
  }
  if (built.orphans.length) warn(`${built.orphans.length} 条轨迹未成对/未归城，等待 discover 攒库存`);
}

/** open-meteo 目标周末天气（含天气码与降水概率），失败返回 null（选品按中性分） */
async function fetchRotationForecast(dest, depart, back) {
  try {
    const params = new URLSearchParams({
      latitude: String(dest.lat),
      longitude: String(dest.lng),
      daily: "temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max",
      timezone: "Asia/Shanghai",
      start_date: depart,
      end_date: back,
    });
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    const highs = data.daily?.temperature_2m_max ?? [];
    if (highs.length < 2) return null;
    return {
      days: highs.slice(0, 2).map((hi, i) => ({
        code: data.daily.weather_code?.[i] ?? 2,
        minC: Math.round(data.daily.temperature_2m_min[i]),
        maxC: Math.round(hi),
        pop: data.daily.precipitation_probability_max?.[i] ?? null,
      })),
    };
  } catch {
    return null;
  }
}

/**
 * 发布层：库存 → 天气/季节/历史评分 → 轮选 3 城 → 模板生成 routes.json（纯离线，不碰两步路）。
 * 默认 dry-run；--write 才落盘 routes.json 并追加 published.json。
 */
async function runRotation({ write }) {
  const destinations = loadDestinations();
  const library = loadLibrary();
  const built = buildGroups(library.tracks, destinations);
  saveLibrary({ version: library.version, tracks: built.tracks }); // 持久化归城/自动配对结果
  log(`库存：${built.tracks.length} 条轨迹 → ${built.groups.length} 个完整双日组${built.orphans.length ? `，${built.orphans.length} 条未成对` : ""}`);
  if (!built.groups.length) {
    warn("没有任何完整双日组：先运行 npm run seed，再在本机运行 npm run discover 攒库存");
    return false;
  }

  const { depart, back } = targetWeekendDates();
  const month = Number(depart.slice(5, 7));
  const slugs = [...new Set(built.groups.map((g) => g.slug))];
  const forecasts = {};
  for (const slug of slugs) {
    const dest = destinations.find((d) => d.slug === slug);
    const f = await fetchRotationForecast(dest, depart, back);
    forecasts[slug] = f;
    if (!f) warn(`天气获取失败，按中性分处理：${dest.city}`);
  }

  const published = loadPublished();
  const history = Array.isArray(published.history) ? published.history : [];
  const { picks, layer, scored } = selectGroups(built.groups, forecasts, history, {
    count: WEEKLY_PICK_COUNT,
    weekendMonth: month,
  });
  const scoreOf = new Map(scored.map((g) => [g.id, g.score]));
  log(`目标周末 ${depart}（周六）– ${back}（周日），选品分层 L${layer}：`);
  for (const g of picks) {
    const f = forecasts[g.slug];
    const wx = f ? f.days.map((d) => `${describeWeatherCode(d.code)} ${d.minC}–${d.maxC}°C`).join(" / ") : "无预报";
    const total = (g.tracks[0].mileage_km || 0) + (g.tracks[1].mileage_km || 0);
    log(`  → ${g.city}（${g.slug}）组 ${g.id} · 共 ${total.toFixed(1)}km · 评分 ${scoreOf.get(g.id)} · ${wx}`);
  }
  if (picks.length < WEEKLY_PICK_COUNT) {
    warn(`库存仅能产出 ${picks.length} 条路线（目标 ${WEEKLY_PICK_COUNT}），请在本机多跑 discover 攒库存`);
  }
  if (layer > 1) warn(`L${layer} 降级选品：库存不足以保证与近期完全不重样${layer === 3 ? "，连轨迹组都发生了重复" : ""}`);

  if (!write) {
    log("dry-run 模式未写盘；确认无误后加 --write 落盘");
    return true;
  }
  const routesOut = picks.map((g) => buildRoute(g, forecasts[g.slug] ?? null, describeWeatherCode));
  saveRoutes(routesOut);
  const nextHistory = [...history, buildEdition(depart, picks, new Date().toISOString())];
  savePublished({ history: nextHistory });
  log(`已写盘 src/data/routes.json（${routesOut.length} 条）并记录发布历史 scripts/published.json（第 ${nextHistory.length} 期）`);
  return true;
}

const DISCOVER_TARGET_GROUPS = Number(process.env.DISCOVER_TARGET_GROUPS || 3);
const DISCOVER_MAX_NEW = Number(process.env.DISCOVER_MAX_NEW || 10);
const DISCOVER_PAGES = Number(process.env.DISCOVER_PAGES || 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 3.5–7s 随机间隔：今天的探针密集请求会触发 SafeLine 频率拦截，发现层宁可慢也不要被限流
const jitterMs = () => 3500 + Math.random() * 3500;

/** 从搜索结果页 a[href*="/track/t-"] 收集轨迹详情页 URL（Node 侧归一化去重） */
async function collectListLinks(page, keyword, pageNum, headed) {
  const url = `https://www.2bulu.com/track/list-${encodeURIComponent(keyword)}-----${pageNum}.htm?sortType=2`;
  log(`发现页：${keyword} 第 ${pageNum} 页`);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  } catch (err) {
    // Chrome 更新重启/CDP 断连等：本页放弃，保住整轮发现不中断
    warn(`搜索页导航失败，跳过本页：${err.message}`);
    return [];
  }
  const deadline = Date.now() + WAIT_TRACK_MS;
  // 出现 WAF 验证页时只保留 90s 人工点确认窗口：真人点完页面会自动重载，下轮轮询即取到链接；
  // 持续拦截则提前结束本页，避免 12 城全程空等一个多小时（后续页面仍会再次检测）
  let wafDeadline = 0;
  const WAF_WAIT_MS = 90_000;
  let wafHinted = false;
  while (Date.now() < deadline) {
    const hrefs = await page
      .evaluate(() => Array.from(document.querySelectorAll('a[href*="/track/t-"]')).map((a) => a.href))
      .catch(() => []);
    const links = new Set();
    for (const href of hrefs) {
      // href 为双重编码形态（%252F…%253D%253D），必须原样使用；
      // 再 decode 一次会变成单次编码 URL，站点直接返回 HTTP 400
      const m = /\/track\/(t-[^/?#]+\.htm)/.exec(href);
      if (m) links.add(`https://www.2bulu.com/track/${m[1]}`);
    }
    if (links.size) return [...links];
    const bodyText = await page.evaluate(() => (document.body ? document.body.textContent : "")).catch(() => "");
    if (/当前环境|系统异常|客户端异常/.test(bodyText)) {
      if (!wafHinted) {
        warn(headed ? "搜索页被 WAF 拦截，请在浏览器窗口完成验证（90s 内有效），脚本继续…" : "搜索页被 WAF 拦截，建议 --headed 运行");
        wafHinted = true;
        wafDeadline = Date.now() + WAF_WAIT_MS;
      } else if (Date.now() > wafDeadline) {
        warn(`搜索页 WAF 持续拦截，90s 内未完成验证，提前跳过本页：${keyword} 第 ${pageNum} 页`);
        return [];
      }
    }
    await page.waitForTimeout(2000);
  }
  warn(`搜索页未取到轨迹链接：${keyword} 第 ${pageNum} 页（WAF 或页面结构变化）`);
  return [];
}

/**
 * 发现层（仅本机）：按库存不足的目的地跑两步路关键词搜索，
 * 逐条抓真实轨迹（line/照片本地化/就近归城），落库后自动配对，攒未来两周的发布库存。
 */
async function runDiscover(context, headed) {
  const destinations = loadDestinations();
  const library = loadLibrary();
  const built0 = buildGroups(library.tracks, destinations);
  saveLibrary({ version: library.version, tracks: built0.tracks });
  const groupCount = new Map();
  for (const g of built0.groups) groupCount.set(g.slug, (groupCount.get(g.slug) || 0) + 1);
  // 库存为 0 的城市优先：尽快扩大城市覆盖（"每周不同"比给同城攒备份更重要）
  const targets = destinations
    .filter((d) => (groupCount.get(d.slug) || 0) < DISCOVER_TARGET_GROUPS)
    .sort((a, b) => (groupCount.get(a.slug) || 0) - (groupCount.get(b.slug) || 0));
  if (!targets.length) {
    log(`每个目的地都已攒够 ${DISCOVER_TARGET_GROUPS} 组，本次无需发现`);
    return;
  }

  const known = new Set(built0.tracks.map((t) => t.url));
  const queue = [];
  const queueRaw = readJson(DISCOVER_QUEUE_JSON, []);
  for (const item of Array.isArray(queueRaw) ? queueRaw : []) {
    const url = typeof item === "string" ? item : item.url;
    if (typeof url === "string" && /2bulu\.com\/track\/t-/i.test(url)) queue.push({ url, slug: typeof item === "object" ? item.slug : null });
  }

  const page = await context.newPage();
  await page.setExtraHTTPHeaders({ "Accept-Language": "zh-CN,zh;q=0.9" });
  let added = 0;
  try {
    for (const dest of targets) {
      if (added >= DISCOVER_MAX_NEW) break;
      const keywords = [...new Set([dest.city, ...(dest.spots || []).slice(0, 1)])];
      const links = [];
      for (const kw of keywords) {
        for (let p = 1; p <= DISCOVER_PAGES; p += 1) {
          links.push(...(await collectListLinks(page, kw, p, headed)));
          await sleep(jitterMs());
        }
      }
      for (const url of [...new Set(links)]) {
        if (added >= DISCOVER_MAX_NEW) break;
        if (known.has(url)) continue;
        try {
          const data = await extractTrack(page, url, headed);
          const km = data.mileage ? Math.round(data.mileage * 10) / 10 : null;
          if (!km || km < 3 || km > 45 || !data.line || data.line.length < 10) {
            warn(`跳过（里程/点数不合周末双日线）：${data.name || url} ${km ?? "?"}km`);
            known.add(url);
            continue;
          }
          if (data.walk === false) {
            warn(`跳过（非步行轨迹）：${data.docTitle?.slice(0, 40) || url}`);
            known.add(url);
            continue;
          }
          if (!Array.isArray(data.photos) || data.photos.length === 0) {
            warn(`跳过（无照片，九宫格会空白）：${data.docTitle?.slice(0, 40) || url}`);
            known.add(url);
            continue;
          }
          const hit = nearestDestination(data.center, destinations);
          if (!hit) {
            warn(`跳过（超出所有目的地 ${PAIR_DISTANCE_KM}km 归组半径）：${data.name}`);
            known.add(url);
            continue;
          }
          const photos = await materializeLibraryPhotos(hash8(url), data.photos);
          const now = new Date().toISOString();
          const record = buildLibraryRecord({ url, data, photos, source: "discover", now });
          record.destination_slug = hit.destination.slug;
          record.city = hit.destination.city;
          record.assign_distance_km = hit.distanceKm;
          library.tracks.push(record);
          known.add(url);
          added += 1;
          saveLibrary({ version: library.version, tracks: library.tracks });
          log(`  ✓ 入库 ${hit.destination.city}：${record.name} · ${km}km · ${data.line.length} 点 · 照片 ${photos.length} 张`);
        } catch (err) {
          warn(`轨迹抓取失败，跳过：${err.message} ${url.slice(0, 80)}`);
        }
        await sleep(jitterMs());
      }
    }

    for (const q of queue) {
      if (added >= DISCOVER_MAX_NEW) break;
      if (known.has(q.url)) continue;
      try {
        const data = await extractTrack(page, q.url, headed);
        const photos = await materializeLibraryPhotos(hash8(q.url), data.photos);
        const record = buildLibraryRecord({ url: q.url, data, photos, source: "queue", now: new Date().toISOString() });
        const hit = q.slug ? { destination: destinations.find((d) => d.slug === q.slug), distanceKm: null } : nearestDestination(data.center, destinations);
        if (hit?.destination) {
          record.destination_slug = hit.destination.slug;
          record.city = hit.destination.city;
          record.assign_distance_km = hit.distanceKm;
        }
        library.tracks.push(record);
        known.add(q.url);
        added += 1;
        saveLibrary({ version: library.version, tracks: library.tracks });
        log(`  ✓ 队列入库：${record.name} · ${record.mileage_km ?? "?"}km · ${record.city || "未归城"}`);
      } catch (err) {
        warn(`队列轨迹抓取失败：${err.message} ${q.url.slice(0, 80)}`);
      }
      await sleep(jitterMs());
    }
  } finally {
    await page.close();
  }
  const finalBuilt = buildGroups(library.tracks, destinations);
  saveLibrary({ version: library.version, tracks: finalBuilt.tracks });
  log(`发现结束：新增 ${added} 条，库存共 ${finalBuilt.tracks.length} 条 / ${finalBuilt.groups.length} 个完整双日组，${finalBuilt.orphans.length} 条待配对`);
}

async function runWithBrowser(headed, task) {
  let context;
  try {
    context = await launchBrowser(headed);
  } catch (err) {
    if (process.env.CI) {
      warn(`浏览器启动失败，本次跳过浏览器相关步骤：${err.message}`);
      return;
    }
    throw err;
  }
  try {
    await task(context);
  } finally {
    await context.close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--photos-only")) {
    await photosOnly();
    return;
  }
  if (argv.includes("--seed")) {
    seedLibrary();
    return;
  }
  if (argv.includes("--rotate")) {
    const write = argv.includes("--write");
    const ok = await runRotation({ write });
    if (ok && write && argv.includes("--fares")) {
      await runWithBrowser(false, (context) => refreshFares(context, false));
    }
    return;
  }
  if (argv.includes("--discover")) {
    const headed = !argv.includes("--headless");
    const { depart, back } = targetWeekendDates();
    log(`发现层运行（${headed ? "有头" : "无头"}），目标周末 ${depart} – ${back}`);
    await runWithBrowser(headed, (context) => runDiscover(context, headed));
    return;
  }

  // —— 旧管道：固定轨迹刷新 / 投稿入库 / 机票快照 ——
  const headed = argv.includes("--headed");
  const ingestOnly = argv.includes("--ingest");
  const faresOnly = argv.includes("--fares");

  const routes = loadRoutes();
  const { depart, back } = targetWeekendDates();
  log(`目标周末：${depart}（周六）– ${back}（周日），模式：${headed ? "有头（可手动过 WAF）" : "无头"}`);
  let context;
  try {
    context = await launchBrowser(headed);
  } catch (err) {
    if (process.env.CI) {
      warn(`浏览器启动失败，本次跳过所有采集，保留现有数据：${err.message}`);
      return; // CI 中这是可降级故障：旧数据完好，后续部署照常进行
    }
    throw err;
  }
  let ok = 0;
  const skipWeekly = faresOnly || ingestOnly;
  const entries = skipWeekly ? [] : readEntries(argv).map((e) => ({ ...e, headed }));
  try {
    if (!faresOnly && !ingestOnly) {
      log(`周路线采集：${entries.length} 条轨迹`);
      for (const entry of entries) {
        try {
          await collectEntry(context, entry, routes);
          ok += 1;
          refreshTotals(routes);
          saveRoutes(routes);
        } catch (err) {
          warn(`${entry.routeId} Day${entry.day} 采集失败，保留旧数据：${err.message}`);
        }
      }
      refreshTotals(routes);
      saveRoutes(routes);
    }
    if (!faresOnly) await ingestSubmissions(context, headed);
    if (!ingestOnly) await refreshFares(context, headed);
  } finally {
    await context.close();
  }
  const failed = entries.length - ok;
  log(`管道结束：周路线 ${ok}/${entries.length} 成功${failed ? `（${failed} 条失败已保留旧数据）` : ""}`);
  // 本地运行时用非零退出码提示主编有采集失败；CI 中 WAF 拦截属预期降级（旧数据完好、部署继续），不算管道失败
  if (failed && !process.env.CI) process.exitCode = 1;
}

main().catch((err) => {
  warn(err.stack || err.message);
  process.exit(1);
});
