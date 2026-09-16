/**
 * 地名 → 经纬度 解析（OpenStreetMap Nominatim）。
 * 仅在本机构建期运行：结果会写入 scripts/geocode-cache.json 快照并提交，
 * CI 轮换阶段零网络依赖。遵守 Nominatim 使用政策：自定义 UA、全局 ≥1.1s 节流。
 */

const ENDPOINT = "https://nominatim.openstreetmap.org/search";
const MIN_GAP_MS = 1100;

let lastCallAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 解析单个地名，返回 { lat, lng, display } 或 null。
 * countryBias 固定中国；调用方应给出"地标, 城市, 省"形式的完整 query。
 * near = { lat, lng, padLat = 0.5, padLng = 0.7 } 时追加 viewbox 地域偏置
 * （Nominatim 会优先返回框内结果，专治"泰安→广东太安""南天门→南天门大街"式错配）。
 */
export async function geocodeOne(query, { timeoutMs = 12000, near = null } = {}) {
  const wait = MIN_GAP_MS - (Date.now() - lastCallAt);
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();

  const params = new URLSearchParams({ format: "jsonv2", limit: "1", countrycodes: "cn", q: query });
  if (near) {
    const padLat = near.padLat ?? 0.5;
    const padLng = near.padLng ?? 0.7;
    // viewbox=<minLng>,<minLat>,<maxLng>,<maxLat>
    params.set(
      "viewbox",
      `${near.lng - padLng},${near.lat - padLat},${near.lng + padLng},${near.lat + padLat}`,
    );
  }
  const url = `${ENDPOINT}?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "hiking-weekly-route-builder/1.0 (local build; weekend hiking planner)" },
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) return null;
  const list = await res.json().catch(() => []);
  const hit = Array.isArray(list) ? list[0] : null;
  if (!hit) return null;
  const lat = Number(hit.lat);
  const lng = Number(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, display: hit.display_name || query };
}

/** 取一个坐标与目的地参考点的球面距离（km） */
export function distanceKm(lat1, lng1, lat2, lng2) {
  const r = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}
