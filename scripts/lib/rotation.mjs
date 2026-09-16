/**
 * 每周路线轮换引擎（纯逻辑，不访问网络/文件系统，便于单测）。
 *
 * 数据分层：
 *   1. track-library.json —— 本机发现层攒下的真实轨迹库存（含完整 line / 本地化照片 / 归城）
 *   2. destinations.json  —— 北京出发目的地知识表（坐标/高铁/机场/季节主题/已核实票价）
 *   3. published.json     —— 发布历史，用于去重与最久未用（LRU）轮转
 *
 * 关键不变量：只有"同一目的地下 day1+day2 两条轨迹齐全"的完整双日组才可被选品与落盘，
 * 选品判定与 routes.json 写入使用同一强度，杜绝半成品路线。
 */

export const LIBRARY_VERSION = 1;
export const PAIR_DISTANCE_KM = 120;
export const RECENT_GROUP_EDITIONS = 4;
export const WEEKLY_PICK_COUNT = 3;

const KM_RADIUS = 6371;

export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * KM_RADIUS * Math.asin(Math.sqrt(a));
}

const round5 = (n) => Math.round(n * 100000) / 100000;
const round1 = (n) => Math.round(n * 10) / 10;

/** 兼容旧版数组结构与 {version,tracks} 结构，统一输出 {version,tracks} */
export function normalizeLibrary(raw) {
  if (Array.isArray(raw)) return { version: LIBRARY_VERSION, tracks: raw };
  if (raw && Array.isArray(raw.tracks)) return { version: raw.version || LIBRARY_VERSION, tracks: raw.tracks };
  return { version: LIBRARY_VERSION, tracks: [] };
}

/**
 * 就近归城：轨迹中心来自两步路，坐标顺序为 [lng,lat]；
 * destinations 坐标为 [lat,lng]。超过 maxKm 返回 null（无法可信归城的轨迹不参与轮换）。
 */
export function nearestDestination(centerLngLat, destinations, maxKm = PAIR_DISTANCE_KM) {
  if (!Array.isArray(centerLngLat) || centerLngLat.length !== 2) return null;
  const [lng, lat] = centerLngLat;
  let best = null;
  for (const dest of destinations) {
    const d = haversineKm(lat, lng, dest.lat, dest.lng);
    if (d <= maxKm && (!best || d < best.distanceKm)) {
      best = { destination: dest, distanceKm: round1(d) };
    }
  }
  return best;
}

/** 由 line（[lng,lat] 序列）估算里程（km），发现轨迹缺 mileage 时兜底 */
export function polylineKm(line) {
  if (!Array.isArray(line) || line.length < 2) return null;
  let total = 0;
  for (let i = 1; i < line.length; i += 1) {
    total += haversineKm(line[i - 1][1], line[i - 1][0], line[i][1], line[i][0]);
  }
  return round1(total);
}

export function trackKm(track) {
  const km = Number(track.mileage_km);
  if (Number.isFinite(km) && km > 0) return round1(km);
  return polylineKm(track.line);
}

export function lineCenter(line) {
  if (!Array.isArray(line) || !line.length) return null;
  let lng = 0;
  let lat = 0;
  for (const [x, y] of line) {
    lng += x;
    lat += y;
  }
  return [round5(lng / line.length), round5(lat / line.length)];
}

const timeKey = (t) => t.discovered_at || t.ingested_at || "";

/**
 * 为缺 group_id 的库存轨迹自动配对：按目的地分组，按发现先后（再按里程降序）两两成组，
 * 里程较长的作为 Day1。已带 group_id/day_role 的种子轨迹原样保留。
 * 返回新数组（浅拷贝 track 对象），调用方负责落盘。
 */
export function pairAutoTracks(tracks) {
  const next = tracks.map((t) => ({ ...t }));
  const counters = new Map();
  for (const t of next) {
    const m = /--auto-(\d+)$/.exec(t.group_id || "");
    if (m) counters.set(t.destination_slug, Math.max(counters.get(t.destination_slug) || 0, Number(m[1])));
  }
  const orphans = next.filter((t) => !t.group_id && t.destination_slug);
  const bySlug = new Map();
  for (const t of orphans) {
    if (!bySlug.has(t.destination_slug)) bySlug.set(t.destination_slug, []);
    bySlug.get(t.destination_slug).push(t);
  }
  for (const [slug, list] of bySlug) {
    list.sort((a, b) => (timeKey(a) < timeKey(b) ? -1 : timeKey(a) > timeKey(b) ? 1 : (trackKm(b) || 0) - (trackKm(a) || 0)));
    for (let i = 0; i + 1 < list.length; i += 2) {
      const n = (counters.get(slug) || 0) + 1;
      counters.set(slug, n);
      const gid = `${slug}--auto-${n}`;
      const [a, b] = [list[i], list[i + 1]];
      const ka = trackKm(a) || 0;
      const kb = trackKm(b) || 0;
      const [day1, day2] = kb > ka ? [b, a] : [a, b];
      day1.group_id = gid;
      day1.day_role = 1;
      day2.group_id = gid;
      day2.day_role = 2;
    }
  }
  return next;
}

/**
 * 构建完整双日组：
 *   归城（显式 destination_slug 优先，否则就近匹配）→ 自动配对 → 按 group_id 聚合成组。
 * 仅返回 day1/day2 齐全、两条轨迹都有 line 的组；孤儿轨迹放入 orphans（供日志/攒库存提示）。
 */
export function buildGroups(libraryTracks, destinations) {
  const destBySlug = new Map(destinations.map((d) => [d.slug, d]));
  const assigned = libraryTracks.map((t) => {
    const track = { ...t };
    if (!track.destination_slug) {
      const hit = nearestDestination(track.center, destinations);
      if (hit) {
        track.destination_slug = hit.destination.slug;
        track.city = hit.destination.city;
        track.assign_distance_km = hit.distanceKm;
      }
    }
    return track;
  });
  const paired = pairAutoTracks(assigned);

  const map = new Map();
  const orphans = [];
  for (const t of paired) {
    if (!t.group_id || !t.destination_slug) {
      orphans.push(t);
      continue;
    }
    if (!map.has(t.group_id)) {
      map.set(t.group_id, { id: t.group_id, slug: t.destination_slug, city: t.city || null, tracks: [] });
    }
    map.get(t.group_id).tracks.push(t);
  }
  const groups = [];
  for (const group of map.values()) {
    const d1 = group.tracks.find((t) => Number(t.day_role) === 1);
    const d2 = group.tracks.find((t) => Number(t.day_role) === 2);
    const complete =
      d1 && d2 && Array.isArray(d1.line) && d1.line.length >= 2 && Array.isArray(d2.line) && d2.line.length >= 2;
    if (complete) {
      group.destination = destBySlug.get(group.slug) || null;
      group.tracks = [d1, d2];
      groups.push(group);
    } else {
      orphans.push(...group.tracks);
    }
  }
  groups.sort((a, b) => a.id.localeCompare(b.id));
  return { groups, tracks: paired, orphans };
}

/**
 * 攻略精选供给：读取 sync-guides.mjs 产物 guide-groups.json，把"无 GPS 轨迹、只有
 * 有序关键点"的双日线包装成与真实轨迹组同构的候选组，供 selectGroups 统一打分。
 * waypoint 坐标为 [lat,lng]，track.line 契约为 [lng,lat]，此处转换。
 * 攻略组绝不回写 track-library.json（见 fetch-routes 的落盘范围）。
 * 返回 { groups, skipped }。
 */
export function buildGuideGroups(rawGuideGroups, destinations) {
  const destBySlug = new Map(destinations.map((d) => [d.slug, d]));
  const routes = Array.isArray(rawGuideGroups?.routes) ? rawGuideGroups.routes : [];
  const groups = [];
  const skipped = [];

  for (const route of routes) {
    const dest = destBySlug.get(route.destination_slug);
    if (!dest) {
      skipped.push(`${route.id}: destinations.json 中无 ${route.destination_slug}`);
      continue;
    }
    if (!Array.isArray(route.days) || route.days.length !== 2) {
      skipped.push(`${route.id}: 需要恰好 2 天行程`);
      continue;
    }
    const tracks = route.days.map((day, idx) => {
      const wps = Array.isArray(day.waypoints) ? day.waypoints : [];
      const line = wps.map((w) => [round5(Number(w.lng)), round5(Number(w.lat))]);
      return {
        kind: "guide",
        group_id: `guide--${route.id}`,
        day_role: idx + 1,
        destination_slug: route.destination_slug,
        city: dest.city,
        name: day.title,
        url: route.source_url,
        source_name: route.source_name,
        mileage_km: Number(day.distance_km),
        elevation_gain_m: Number.isFinite(day.elevation_gain_m) ? day.elevation_gain_m : null,
        center: lineCenter(line),
        line,
        photos: [],
        waypoint_names: wps.map((w) => w.name),
        highlight: day.highlight,
      };
    });
    const complete = tracks.every(
      (t) =>
        Array.isArray(t.line) &&
        t.line.length >= 2 &&
        t.line.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)),
    );
    if (!complete) {
      skipped.push(`${route.id}: 关键点坐标不完整（每天至少 2 个有效坐标）`);
      continue;
    }
    groups.push({
      id: `guide--${route.id}`,
      slug: route.destination_slug,
      city: dest.city,
      kind: "guide",
      destination: dest,
      tracks,
      guide: {
        id: route.id,
        title: route.title,
        summary: route.summary,
        difficulty_level: route.difficulty_level,
        source_name: route.source_name,
        source_url: route.source_url,
      },
    });
  }
  groups.sort((a, b) => a.id.localeCompare(b.id));
  return { groups, skipped };
}

/** 合并多个候选组来源（真实轨迹组 + 攻略组），按 id 确定性排序 */
export function combineGroups(...lists) {
  return lists.flat().sort((a, b) => a.id.localeCompare(b.id));
}

/** "16–24°C" / "10-22°C" → [10,22]，无法解析返回 null */
export function parseTempRange(text) {
  if (!text) return null;
  const m = /(-?\d{1,2})\s*[–\-~—]\s*(\d{1,2})/.exec(String(text));
  if (!m) return null;
  return [Number(m[1]), Number(m[2])].sort((a, b) => a - b);
}

const WEATHER_CODE_SCORE = {
  0: 1.0,
  1: 0.95,
  2: 0.8,
  3: 0.55,
  45: 0.5,
  48: 0.45,
  51: 0.4,
  53: 0.3,
  55: 0.25,
  56: 0.35,
  57: 0.25,
  61: 0.2,
  63: 0.1,
  65: 0.0,
  66: 0.15,
  67: 0.05,
  71: 0.4,
  73: 0.3,
  75: 0.15,
  77: 0.35,
  80: 0.3,
  81: 0.15,
  82: 0.05,
  85: 0.35,
  86: 0.2,
  95: 0.0,
  96: 0.0,
  99: 0.0,
};

function dayTempScore(day, range) {
  const mid = (day.minC + day.maxC) / 2;
  if (!range) return 0.6;
  const [lo, hi] = range;
  const dist = mid < lo ? lo - mid : mid > hi ? mid - hi : 0;
  return Math.max(0, 1 - dist / 10);
}

/**
 * 目标周末天气评分（0–40）：天气码 60% + 气温贴合度 30% + 无降水概率 10%，两天取均值。
 * forecast 为 null（接口失败）时返回 null，选品层按中性分处理。
 */
export function weatherScore(forecast, destination) {
  if (!forecast || !Array.isArray(forecast.days) || forecast.days.length < 2) return null;
  const range = parseTempRange(destination?.suitable_temp);
  const scores = forecast.days.slice(0, 2).map((day) => {
    const code = WEATHER_CODE_SCORE[day.code] ?? 0.6;
    const temp = dayTempScore(day, range);
    const dry = Number.isFinite(day.pop) ? 1 - day.pop / 100 : 0.7;
    return code * 0.6 + temp * 0.3 + dry * 0.1;
  });
  return round1(((scores[0] + scores[1]) / 2) * 40);
}

/** 该目的地上一次发布距今多少期；从未发布返回 null（享受最高 LRU 加权） */
export function editionsSincePublished(slug, history) {
  for (let i = history.length - 1, ago = 0; i >= 0; i -= 1, ago += 1) {
    if ((history[i].destinations || []).some((d) => d.slug === slug)) return ago;
  }
  return null;
}

function lruScore(slug, history) {
  const ago = editionsSincePublished(slug, history);
  if (ago === null) return 15;
  if (ago === 0) return 0;
  if (ago === 1) return 3;
  if (ago === 2) return 6;
  if (ago === 3) return 10;
  return 12;
}

/**
 * 候选组综合评分：天气 40 + 当季 15 + LRU 轮转 15 + 里程适配 5。
 * history 为 published.json 的 history 数组（按期数顺序）。
 */
export function scoreGroup(group, forecast, history, weekendMonth) {
  const dest = group.destination;
  const km1 = trackKm(group.tracks[0]) || 0;
  const km2 = trackKm(group.tracks[1]) || 0;
  const total = round1(km1 + km2);
  const w = weatherScore(forecast, dest);
  const inSeason = weekendMonth && Array.isArray(dest.season_months) && dest.season_months.includes(weekendMonth) ? 15 : 0;
  const fit = total >= 8 && total <= 42 ? 5 : 0;
  return round1((w ?? 24) + inSeason + lruScore(dest.slug, history || []) + fit);
}

/**
 * 在已有 picks 基础上从候选池补足（保留上层已选，跳过策略只作用于"选人层"）：
 * 第一轮严格按城市去重；allowDupSlug 时才允许同城补位（库存耗尽的最终降级）。
 */
function fillFrom(scored, count, picks, { banGroupIds, banSlugs, allowDupSlug }) {
  const usedIds = new Set(picks.map((p) => p.id));
  const usedSlugs = new Set([...banSlugs, ...picks.map((p) => p.slug)]);
  const candidates = scored
    .filter((g) => !banGroupIds.has(g.id) && !usedIds.has(g.id))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  for (const g of candidates) {
    if (picks.length >= count) break;
    if (!usedSlugs.has(g.slug)) {
      picks.push(g);
      usedSlugs.add(g.slug);
    }
  }
  if (allowDupSlug) {
    for (const g of candidates) {
      if (picks.length >= count) break;
      if (!picks.includes(g)) picks.push(g);
    }
  }
  return picks;
}

/**
 * 分层选品：层数越高约束越宽松，但任何一层都只产出完整双日组（与写入契约同强度）。
 *   L1 排除"最近 N 期出现过的组"且排除"上一期发布过的城市"（保证每周城市不重样）
 *   L2 仅排除最近 N 期的组（允许更早轮转过的城市，但不允许同一条轨迹组短期重复）
 *   L3 全量候选（库存不足时 LRU 高分者优先，仍保证确定性输出）
 * 返回 {picks, layer, scored, recentGroupIds}。
 */
export function selectGroups(groups, forecastsBySlug, history = [], opts = {}) {
  const count = opts.count || WEEKLY_PICK_COUNT;
  const recentWindow = opts.recentGroupEditions || RECENT_GROUP_EDITIONS;
  const weekendMonth = opts.weekendMonth || null;
  const empty = () => new Set();

  const scored = groups
    .filter((g) => g.destination)
    .map((g) => ({ ...g, score: scoreGroup(g, forecastsBySlug[g.slug] || null, history, weekendMonth) }));

  const recentGroupIds = new Set(
    history
      .slice(-recentWindow)
      .flatMap((e) => (e.destinations || []).map((d) => d.group_id))
      .filter(Boolean),
  );
  const lastEdition = history.length ? history[history.length - 1] : null;
  const lastSlugs = new Set((lastEdition?.destinations || []).map((d) => d.slug));

  let picks = fillFrom(scored, count, [], { banGroupIds: recentGroupIds, banSlugs: lastSlugs });
  let layer = 1;
  if (picks.length < count) {
    picks = fillFrom(scored, count, picks, { banGroupIds: recentGroupIds, banSlugs: empty() });
    layer = 2;
  }
  if (picks.length < count) {
    picks = fillFrom(scored, count, picks, { banGroupIds: empty(), banSlugs: empty(), allowDupSlug: true });
    layer = 3;
  }
  return { picks: picks.slice(0, count), layer, scored, recentGroupIds };
}

const GOOGLE_FLIGHTS_TMPL = (code) =>
  `https://www.google.com/travel/flights?hl=zh-CN&curr=CNY&q=${encodeURIComponent(
    `Flights from PEK to ${code} on {depart} through {return}`,
  )}`;

function difficulty(totalKm) {
  if (totalKm < 15) return "轻松";
  if (totalKm < 21) return "中等偏低";
  if (totalKm < 36) return "中等";
  return "中等偏强";
}

const toLatLng = ([lng, lat]) => [round5(lat), round5(lng)];

function pointOfInterest(track, index, name, category, description) {
  const p = track.line[index];
  if (!p) return null;
  return { name, category, coordinates: toLatLng(p), description };
}

/**
 * 攻略组模板：与真实轨迹路线同契约，但标题/摘要/难度/每日文案均来自人工精选库，
 * 关键点生成编号 POI 与 [lng,lat] 示意折线，照片缺省为空。
 */
function buildGuideRoute(group, forecast, describeWeather) {
  const dest = group.destination;
  const meta = group.guide;
  const [d1, d2] = group.tracks;
  const km1 = trackKm(d1);
  const km2 = trackKm(d2);
  const total = round1((km1 || 0) + (km2 || 0));
  const themes = dest.themes?.length ? dest.themes : ["徒步"];
  const labelCity = dest.label || dest.city;

  const train = dest.train || {};
  const flight = dest.flight || null;
  const recommendation = flight
    ? `北京出发高铁约 ${train.duration || "2–5 小时"}直达${train.arrival || `${dest.city}站`}；也可直飞${flight.arrival}约 ${flight.duration}，按当周真实比价结果推荐。`
    : `北京出发高铁约 ${train.duration || "2–5 小时"}直达${train.arrival || `${dest.city}站`}，票价以 12306 实时查询为准。`;

  const fdays = forecast?.days || [];
  const weatherDay = (i) => {
    const f = fdays[i];
    if (!f) return { condition: "多云", temp_range: dest.suitable_temp || null };
    return { condition: describeWeather(f.code), temp_range: `${f.minC}–${f.maxC}°C` };
  };

  const c1 = lineCenter(d1.line) || d1.line[0];
  const c2 = lineCenter(d2.line) || d2.line[0];
  const centerLatLng = [round5((c1[1] + c2[1]) / 2), round5((c1[0] + c2[0]) / 2)];

  const pois = [d1, d2].flatMap((t) =>
    t.line.map(([lng, lat], i) => ({
      name: t.waypoint_names?.[i] || `关键点 ${i + 1}`,
      category: i === 0 ? "start" : i === t.line.length - 1 ? "landmark" : "viewpoint",
      coordinates: [round5(lat), round5(lng)],
      description: "",
    })),
  );

  const mkDay = (t, dayNum) => ({
    day: dayNum,
    title: t.name,
    track_kind: "guide",
    source_name: t.source_name,
    photos: [],
    bulu_track_url: t.url,
    bulu_track_name: t.source_name,
    bulu_track_line: t.line,
    elevation_gain_m: t.elevation_gain_m,
    segments:
      dayNum === 1
        ? [
            { time: "07:30–10:30", activity_type: "transport", highlight: "" },
            { time: "10:30–17:00", activity_type: "hiking", highlight: t.highlight },
            { time: "17:30–19:30", activity_type: "food", highlight: `${dest.city}当地晚餐，早休整为次日留体力。` },
          ]
        : [
            { time: "08:00–13:00", activity_type: "hiking", highlight: t.highlight },
            { time: "14:00–18:00", activity_type: "transport", highlight: "" },
          ],
  });

  return {
    id: dest.slug,
    source_kind: "guide",
    guide_id: meta.id,
    title: meta.title,
    summary: meta.summary,
    tags: Array.from(new Set(["周末往返", "精选攻略", ...themes.slice(0, 3)])),
    best_months: dest.season_months || [],
    departure: {
      city: "北京",
      transport_type: "train",
      transport_recommendation: recommendation,
      train_url: "https://www.12306.cn/",
      train_duration: train.duration || null,
      train_arrival: train.arrival || `${dest.city}站`,
      arrival_spot: train.arrival_spot || dest.spots?.[0] || `${dest.city}步道`,
      return_note: `结束一个${themes[0]}周末。`,
      ...(flight
        ? {
            flight_url: GOOGLE_FLIGHTS_TMPL(flight.code),
            flight_duration: flight.duration,
            flight_arrival: flight.arrival,
          }
        : {}),
    },
    weather_info: {
      target_city: dest.city,
      suitable_temp_range: dest.suitable_temp || null,
      day1: weatherDay(0),
      day2: weatherDay(1),
      condition_note: dest.condition_note || "出发前再看一眼实时天气，分层穿衣最稳妥。",
    },
    overview: {
      duration_days: 2,
      total_hiking_km: total,
      difficulty_level: meta.difficulty_level,
    },
    daily_distances: {
      day1: `${km1 ?? "?"}km`,
      day2: `${km2 ?? "?"}km`,
    },
    transport_label: `北京 ⇄ ${labelCity}`,
    train_fare_ref_cny: typeof train.fare_cny === "number" ? train.fare_cny : null,
    map_data: {
      center_location: centerLatLng,
      zoom_level: 12,
      points_of_interest: pois,
    },
    itinerary: {
      days: [mkDay(d1, 1), mkDay(d2, 2)],
    },
  };
}

/**
 * 模板工厂：一个完整双日组 + 目的地元数据 → 一条符合前端契约的路线。
 * kind==="guide" 的攻略组走 buildGuideRoute（人工标题/难度/文案 + 关键点示意线）；
 * 真实轨迹组沿用原模板。票价严格只用 destinations.json 已核实值。
 * forecast 可为 null（weather_info 走静态兜底）。describeWeather 由调用方注入。
 */
export function buildRoute(group, forecast, describeWeather = (c) => "多云") {
  if (group && group.kind === "guide") return buildGuideRoute(group, forecast, describeWeather);
  const dest = group.destination;
  const [d1, d2] = group.tracks;
  const km1 = trackKm(d1);
  const km2 = trackKm(d2);
  const total = round1((km1 || 0) + (km2 || 0));
  const spots = dest.spots?.length ? dest.spots : [`${dest.city}郊野步道`];
  const themes = dest.themes?.length ? dest.themes : ["徒步"];
  const labelCity = dest.label || dest.city;

  const centerLngLat = [
    round5(((d1.center?.[0] ?? d1.line[0][0]) + (d2.center?.[0] ?? d2.line[0][0])) / 2),
    round5(((d1.center?.[1] ?? d1.line[0][1]) + (d2.center?.[1] ?? d2.line[0][1])) / 2),
  ];

  const fdays = forecast?.days || [];
  const weatherDay = (i) => {
    const f = fdays[i];
    if (!f) return { condition: "多云", temp_range: dest.suitable_temp || null };
    return { condition: describeWeather(f.code), temp_range: `${f.minC}–${f.maxC}°C` };
  };

  const train = dest.train || {};
  const flight = dest.flight || null;
  const recommendation = flight
    ? `北京出发高铁约 ${train.duration || "2–5 小时"}直达${train.arrival || `${dest.city}站`}；也可直飞${flight.arrival}约 ${flight.duration}，按当周真实比价结果推荐。`
    : `北京出发高铁约 ${train.duration || "2–5 小时"}直达${train.arrival || `${dest.city}站`}，票价以 12306 实时查询为准。`;

  const pois = [
    pointOfInterest(
      d1,
      0,
      `${spots[0]}步道起点`,
      "start",
      `${dest.city}${themes[0]}路线的热身起点，补给与交通最集中。`,
    ),
    pointOfInterest(
      d1,
      Math.floor(d1.line.length / 2),
      spots[1] || spots[0],
      "viewpoint",
      `轨迹中段最开阔的转折点，${themes[0]}景观最集中，适合休整拍照。`,
    ),
    pointOfInterest(
      d2,
      d2.line.length - 1,
      spots[2] || spots[1] || spots[0],
      "landmark",
      "周末双日线的收束点，附近即可接返程交通。",
    ),
  ].filter(Boolean);

  const hiking1 = `沿${spots[0]}行进，${themes.slice(0, 2).join("与")}景观交替，今日约 ${km1 ?? "?"} 公里，按自己的节奏走。`;
  const hiking2 = `从${spots[1] || spots[0]}继续，走一条约 ${km2 ?? "?"} 公里的收尾线，午后返程。`;

  return {
    id: dest.slug,
    title: `${dest.city}${spots[0]}轻徒步`,
    summary: `北京出发${train.duration ? `高铁 ${train.duration}直达` : "高铁直达"}${dest.city}，把${spots
      .slice(0, 2)
      .join("、")}串成一条${themes.slice(0, 2).join("·")}主题的周末双日线。`,
    tags: Array.from(new Set(["周末往返", ...themes.slice(0, 3)])),
    best_months: dest.season_months || [],
    departure: {
      city: "北京",
      transport_type: "train",
      transport_recommendation: recommendation,
      train_url: "https://www.12306.cn/",
      train_duration: train.duration || null,
      train_arrival: train.arrival || `${dest.city}站`,
      arrival_spot: train.arrival_spot || spots[0],
      return_note: `结束一个${themes[0]}周末。`,
      ...(flight
        ? {
            flight_url: GOOGLE_FLIGHTS_TMPL(flight.code),
            flight_duration: flight.duration,
            flight_arrival: flight.arrival,
          }
        : {}),
    },
    weather_info: {
      target_city: dest.city,
      suitable_temp_range: dest.suitable_temp || null,
      day1: weatherDay(0),
      day2: weatherDay(1),
      condition_note: dest.condition_note || "出发前再看一眼实时天气，分层穿衣最稳妥。",
    },
    overview: {
      duration_days: 2,
      total_hiking_km: total,
      difficulty_level: difficulty(total),
    },
    daily_distances: {
      day1: `${km1 ?? "?"}km`,
      day2: `${km2 ?? "?"}km`,
    },
    transport_label: `北京 ⇄ ${labelCity}`,
    train_fare_ref_cny: typeof train.fare_cny === "number" ? train.fare_cny : null,
    map_data: {
      center_location: toLatLng(centerLngLat),
      zoom_level: 12,
      points_of_interest: pois,
    },
    itinerary: {
      days: [
        {
          day: 1,
          title: `抵达 · ${spots[0]}`,
          photos: Array.isArray(d1.photos) ? d1.photos.slice(0, 3) : [],
          bulu_track_url: d1.url,
          bulu_track_name: d1.name || `${dest.city}${spots[0]}轨迹 · Day 1`,
          bulu_track_line: d1.line,
          segments: [
            { time: "07:30–10:30", activity_type: "transport", highlight: "" },
            { time: "10:30–17:00", activity_type: "hiking", highlight: hiking1 },
            { time: "17:30–19:30", activity_type: "food", highlight: `${dest.city}当地晚餐，早休整为次日留体力。` },
          ],
        },
        {
          day: 2,
          title: `${spots[1] || spots[0]} · 午后返程`,
          photos: Array.isArray(d2.photos) ? d2.photos.slice(0, 3) : [],
          bulu_track_url: d2.url,
          bulu_track_name: d2.name || `${dest.city}${spots[0]}轨迹 · Day 2`,
          bulu_track_line: d2.line,
          segments: [
            { time: "08:00–13:00", activity_type: "hiking", highlight: hiking2 },
            { time: "14:00–18:00", activity_type: "transport", highlight: "" },
          ],
        },
      ],
    },
  };
}

/** 生成新一期发布历史记录 */
export function buildEdition(weekend, picks, nowIso) {
  return {
    weekend,
    published_at: nowIso,
    destinations: picks.map((g) => ({
      slug: g.slug,
      group_id: g.id,
      tracks: g.tracks.map((t) => t.url),
      ...(g.kind === "guide" ? { guide_id: g.guide.id } : {}),
    })),
  };
}
