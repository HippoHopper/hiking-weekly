#!/usr/bin/env node
/**
 * 攻略精选路线 · 构建期同步（不依赖 GPS 轨迹）。
 *
 * 输入：
 *   scripts/guide-routes.json   人工维护：地名序列 + 里程/爬升/难度 + 真实来源链接
 *   scripts/lib/destinations.json  目的地参考坐标（距离校验）
 *   scripts/geocode-cache.json  地名→坐标快照（提交入库，CI 零网络）
 * 输出：
 *   scripts/guide-groups.json   轮换引擎可直接消费的"预制双日攻略组"
 *
 * 用法：
 *   node scripts/sync-guides.mjs            本机在线解析缺失地名并落盘（≥1.1s 节流）
 *   node scripts/sync-guides.mjs --offline  只用缓存快照，缺条目或校验不过即失败（CI 用）
 *
 * 防误判：Nominatim 对中文短 query 可能把"泰安"解析到广东"太安"，因此每个坐标都要与
 * 目的地参考点做距离校验（默认 ≤80km），超限直接报错并列出 query / 命中名 / 距离。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { geocodeOne, distanceKm } from "./lib/geocode.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUIDE_SRC = path.join(HERE, "guide-routes.json");
const DESTINATIONS_JSON = path.join(HERE, "lib/destinations.json");
const CACHE_JSON = path.join(HERE, "geocode-cache.json");
const GROUPS_JSON = path.join(HERE, "guide-groups.json");

const MAX_WAYPOINT_KM = Number(process.env.GUIDE_MAX_DISTANCE_KM || 80);
const CACHE_VERSION = 1;
const GROUPS_VERSION = 1;

const round6 = (n) => Math.round(n * 1_000_000) / 1_000_000;
const round1 = (n) => Math.round(n * 10) / 10;

const log = (...a) => console.log("[sync-guides]", ...a);
const fail = (...a) => console.error("[sync-guides][error]", ...a);

function readJson(file, fallback = null) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8"));
}

async function main() {
  const offline = process.argv.includes("--offline");
  const src = readJson(GUIDE_SRC);
  if (!src || !Array.isArray(src.routes)) throw new Error("guide-routes.json 缺少 routes 数组");
  const destinations = readJson(DESTINATIONS_JSON).destinations;
  const destBySlug = new Map(destinations.map((d) => [d.slug, d]));
  const cache = readJson(CACHE_JSON, { version: CACHE_VERSION, entries: {} });
  if (!cache.entries || typeof cache.entries !== "object") cache.entries = {};

  const errors = [];
  let cacheDirty = false;
  const resolveCache = new Map(); // `${query}|${nearKey}` -> Promise<entry|null>

  const nearKey = (near) =>
    near ? `${near.lat},${near.lng},${near.padLat ?? ""},${near.padLng ?? ""}` : "";

  const resolveQuery = (query, near) => {
    const key = `${query}|${nearKey(near)}`;
    if (resolveCache.has(key)) return resolveCache.get(key);
    const task = (async () => {
      const hit = cache.entries[query];
      if (hit && Number.isFinite(hit.lat) && Number.isFinite(hit.lng)) return hit;
      if (offline) return null;
      const got = await geocodeOne(query, { near });
      if (!got) return null;
      const entry = { lat: round6(got.lat), lng: round6(got.lng), display: got.display };
      cache.entries[query] = entry;
      cacheDirty = true;
      return entry;
    })();
    resolveCache.set(key, task);
    return task;
  };

  const outRoutes = [];
  let waypointTotal = 0;
  let waypointCached = 0;
  let waypointManual = 0;

  for (const route of src.routes) {
    const dest = destBySlug.get(route.destination_slug);
    if (!dest) {
      errors.push(`路线 ${route.id}: destinations.json 中找不到 slug=${route.destination_slug}`);
      continue;
    }
    if (!Array.isArray(route.days) || route.days.length !== 2) {
      errors.push(`路线 ${route.id}: 必须恰好包含 2 天行程`);
      continue;
    }
    const outDays = [];
    for (let di = 0; di < route.days.length; di += 1) {
      const day = route.days[di];
      if (!Array.isArray(day.waypoints) || day.waypoints.length < 2) {
        errors.push(`路线 ${route.id} Day${di + 1}: 至少需要 2 个 waypoint 才能画示意线`);
        continue;
      }
      const near = day.geocode_near || route.geocode_near || null;
      const outWps = [];
      for (const wp of day.waypoints) {
        waypointTotal += 1;
        const isManual = Number.isFinite(wp.lat) && Number.isFinite(wp.lng);
        let entry = null;
        let manualSource = null;
        if (isManual) {
          // OSM/高德系覆盖盲区：人工钉死的 WGS-84 坐标（必须在 coord_source 注明出处），跳过网络与缓存
          waypointManual += 1;
          entry = { lat: round6(wp.lat), lng: round6(wp.lng) };
          manualSource = String(wp.coord_source || "手工坐标（未注明出处）");
        } else if (!wp.query) {
          errors.push(`${route.id} Day${di + 1} 地名「${wp.name}」既无 query 也无手工 lat/lng`);
          continue;
        } else {
          if (cache.entries[wp.query]) waypointCached += 1;
          entry = await resolveQuery(wp.query, near);
        }
        if (!entry) {
          errors.push(
            `${route.id} Day${di + 1} 地名「${wp.name}」${offline ? "缓存缺失（--offline）" : "Nominatim 无结果"}：${wp.query}`,
          );
          continue;
        }
        const dist = round1(distanceKm(entry.lat, entry.lng, dest.lat, dest.lng));
        if (dist > MAX_WAYPOINT_KM) {
          errors.push(
            isManual
              ? `${route.id} Day${di + 1} 手工坐标「${wp.name}」距${dest.city}参考点 ${dist}km > ${MAX_WAYPOINT_KM}km：(${entry.lat},${entry.lng})`
              : `${route.id} Day${di + 1} 地名「${wp.name}」坐标距${dest.city}参考点 ${dist}km > ${MAX_WAYPOINT_KM}km，疑似误判：query="${wp.query}" 命中="${entry.display}" (${entry.lat},${entry.lng})`,
          );
          continue;
        }
        outWps.push({
          name: wp.name,
          lat: entry.lat,
          lng: entry.lng,
          distance_km: dist,
          ...(isManual
            ? { coord_source: manualSource }
            : { query: wp.query, ...(entry.display ? { display: entry.display } : {}) }),
        });
      }
      outDays.push({
        title: day.title,
        distance_km: day.distance_km,
        elevation_gain_m: day.elevation_gain_m ?? null,
        highlight: day.highlight,
        waypoints: outWps,
      });
    }
    outRoutes.push({
      id: route.id,
      destination_slug: route.destination_slug,
      title: route.title,
      summary: route.summary,
      difficulty_level: route.difficulty_level,
      source_name: route.source_name,
      source_url: route.source_url,
      days: outDays,
    });
  }

  if (errors.length) {
    for (const e of errors) fail(e);
    if (cacheDirty) {
      writeFileSync(CACHE_JSON, `${JSON.stringify(cache, null, 2)}\n`);
      log(`已保存部分解析结果到 geocode-cache.json（${Object.keys(cache.entries).length} 条），修正 query 后重跑即可续传`);
    }
    fail(`共 ${errors.length} 个问题，未生成 guide-groups.json`);
    process.exit(1);
  }

  // 每天 waypoint 数被前面的 <2 校验间接保证（错误时已 exit）；再做一次几何完整性防御
  for (const r of outRoutes) {
    for (let i = 0; i < 2; i += 1) {
      if (!Array.isArray(r.days[i]?.waypoints) || r.days[i].waypoints.length < 2) {
        fail(`路线 ${r.id} Day${i + 1} 几何不完整`);
        process.exit(1);
      }
    }
  }

  if (cacheDirty) {
    writeFileSync(CACHE_JSON, `${JSON.stringify(cache, null, 2)}\n`);
    log(`geocode-cache.json 已更新（共 ${Object.keys(cache.entries).length} 条快照）`);
  } else {
    log(`全部 ${waypointTotal} 个关键点就绪（缓存命中 ${waypointCached}、手工坐标 ${waypointManual}），未发起网络请求`);
  }

  const payload = { version: GROUPS_VERSION, routes: outRoutes };
  const prev = readJson(GROUPS_JSON, null);
  if (prev && JSON.stringify(prev.routes) === JSON.stringify(outRoutes) && prev.version === GROUPS_VERSION) {
    log("guide-groups.json 内容无变化，跳过写盘");
  } else {
    const artifact = { ...payload, generated_at: new Date().toISOString() };
    writeFileSync(GROUPS_JSON, `${JSON.stringify(artifact, null, 2)}\n`);
    log(`guide-groups.json 已生成：${outRoutes.length} 条攻略双日线 / ${waypointTotal} 个关键点（缓存命中 ${waypointCached}、手工坐标 ${waypointManual}）`);
  }
}

main().catch((err) => {
  fail(err.stack || err.message);
  process.exit(1);
});
