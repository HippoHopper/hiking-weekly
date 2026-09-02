#!/usr/bin/env node
/**
 * 方案 A · 构建期全自动采集管道（离线运行，前端只读静态成品 JSON）
 *
 * 职责：
 *   1. 按 scripts/weekly-tracks.json 抓两步路轨迹（轨迹名/里程/坐标/沿途照片），
 *      照片下载到 public/photos/ 自托管，结果写回 src/data/routes.json；
 *   2. 解析用户投稿：scripts/submissions.json 里的两步路链接 → 元信息入库 scripts/track-library.json；
 *   3. 机票实时快照（best-effort）：Google Flights 抓最低价 → src/data/fares.json，
 *      抓取失败自动保留旧快照，前端比价不受影响。
 *   任何一步失败都保留旧数据，绝不阻断构建。
 *
 * 用法：
 *   npm run fetch:routes                 全量管道：周路线 + 投稿入库 + 机票快照（无头）
 *   npm run fetch:routes -- --headed     有头模式（首次过 WAF：在弹出窗口里等验证通过，profile 会记住）
 *   npm run fetch:routes -- --ingest     只解析 scripts/submissions.json 投稿链接
 *   npm run fetch:routes -- --fares      只刷新机票价格快照
 *   npm run fetch:photos                 不开浏览器，仅把 routes.json 现有照片下载到本地
 *   node scripts/fetch-routes.js <routeId> <day> <trackUrl> [--headed]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const ROUTES_JSON = path.join(ROOT, "src/data/routes.json");
const FARES_JSON = path.join(ROOT, "src/data/fares.json");
const WEEKLY_JSON = path.join(HERE, "weekly-tracks.json");
const SUBMISSIONS_JSON = path.join(HERE, "submissions.json");
const LIBRARY_JSON = path.join(HERE, "track-library.json");
const PHOTO_ROOT = path.join(ROOT, "public/photos");
const PROFILE_DIR = path.join(ROOT, ".pw-profile");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const PHOTO_BASE = "https://down-files.2bulu.com/f/d1?downParams=";
const TARGET_POINTS = 90;
// 本地有头模式留足手动过 WAF 的时间；CI 无头被 WAF 拦是预期降级，快速失败保留旧数据
const WAIT_TRACK_MS = process.env.FETCH_WAIT_MS
  ? Number(process.env.FETCH_WAIT_MS)
  : process.env.CI
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
          };
        },
        [TARGET_POINTS],
      )
      .catch(() => null);
    if (data && data.line.length >= 2) return data;

    const bodyText = await page.evaluate(() => (document.body ? document.body.textContent : "")).catch(() => "");
    if (bodyText.includes("当前环境") || bodyText.includes("系统异常")) {
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

/** 解析 scripts/submissions.json 用户投稿链接 → scripts/track-library.json；失败链接留在 submissions.json 里等下周重试 */
async function ingestSubmissions(context, headed) {
  const raw = readJson(SUBMISSIONS_JSON, []);
  const submissions = (Array.isArray(raw) ? raw : []).map((item) =>
    typeof item === "string" ? { url: item, submittedAt: null } : { url: String(item.url || "").trim(), submittedAt: item.submittedAt || null },
  ).filter((s) => /2bulu\.com\/track\/t-/i.test(s.url));
  if (!submissions.length) {
    log("投稿队列 scripts/submissions.json 为空，跳过");
    return;
  }
  log(`投稿入库：${submissions.length} 条链接待解析`);
  const library = readJson(LIBRARY_JSON, []);
  const known = new Set(library.map((t) => t.url));
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
        library.push({
          url: sub.url,
          name: data.name || "(未命名轨迹)",
          mileage_km: data.mileage ? Math.round(data.mileage * 10) / 10 : null,
          photo_count: data.photos.length,
          center: data.center,
          submitted_at: sub.submittedAt,
          ingested_at: new Date().toISOString(),
        });
        known.add(sub.url);
        log(`  ✓ 入库：${data.name || "(未命名)"} · ${data.mileage ?? "?"}km · 照片 ${data.photos.length} 张`);
      } catch (err) {
        warn(`投稿解析失败（下周自动重试）：${err.message} ${sub.url.slice(0, 70)}`);
        failed.push(sub);
      }
    }
  } finally {
    await page.close();
  }
  writeJson(LIBRARY_JSON, library);
  writeJson(SUBMISSIONS_JSON, failed);
  log(`投稿入库完成：库中共 ${library.length} 条候选轨迹${failed.length ? `，${failed.length} 条失败留待重试` : ""}`);
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

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--photos-only")) {
    await photosOnly();
    return;
  }
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
