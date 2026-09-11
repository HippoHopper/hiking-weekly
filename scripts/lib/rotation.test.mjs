import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildEdition,
  buildGroups,
  buildRoute,
  editionsSincePublished,
  nearestDestination,
  normalizeLibrary,
  pairAutoTracks,
  parseTempRange,
  polylineKm,
  scoreGroup,
  selectGroups,
  weatherScore,
} from "./rotation.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const destinations = JSON.parse(readFileSync(path.join(HERE, "destinations.json"), "utf8")).destinations;
const bySlug = Object.fromEntries(destinations.map((d) => [d.slug, d]));

// 一条 [lng,lat] 直线轨迹，约 stepKm 公里一点
function fakeLine(startLat, startLng, stepKm, points) {
  const out = [];
  let lat = startLat;
  let lng = startLng;
  for (let i = 0; i < points; i += 1) {
    out.push([Number(lng.toFixed(5)), Number(lat.toFixed(5))]);
    lat += (stepKm / 111) * (i % 2 === 0 ? 1 : -0.6);
    lng += stepKm / (111 * Math.cos((lat * Math.PI) / 180));
  }
  return out;
}

function makeTrack({ slug, group, role, km, line, photos = [], source = "discover" }) {
  const dest = bySlug[slug];
  return {
    url: `https://www.2bulu.com/track/${group}-d${role}.htm`,
    name: `${dest.city}测试轨迹 ${role}`,
    mileage_km: km,
    center: line ? [line[0][0], line[0][1]] : [dest.lng, dest.lat],
    line: line || fakeLine(dest.lat, dest.lng, 0.5, 20),
    photos,
    city: dest.city,
    destination_slug: slug,
    group_id: group,
    day_role: role,
    source,
    ingested_at: "2026-09-01T00:00:00.000Z",
  };
}

function makePair(slug, km1, km2, suffix = "g1", extra = {}) {
  const group = `${slug}--${suffix}`;
  return [
    makeTrack({ slug, group, role: 1, km: km1, ...extra }),
    makeTrack({ slug, group, role: 2, km: km2, ...extra }),
  ];
}

test("nearestDestination 按轨迹中心就近归城，超阈值返回 null", () => {
  const hit = nearestDestination([121.62, 38.91], destinations);
  assert.equal(hit.destination.slug, "dalian-coastal");
  assert.ok(hit.distanceKm < 50);
  assert.equal(nearestDestination([114.16, 22.32], destinations), null); // 香港，库外
});

test("normalizeLibrary 兼容旧版数组结构", () => {
  assert.deepEqual(normalizeLibrary([]), { version: 1, tracks: [] });
  assert.equal(normalizeLibrary({ tracks: [{ a: 1 }] }).tracks.length, 1);
});

test("buildGroups 只产出 day1/day2 齐全且都有 line 的完整双日组", () => {
  const [d1, d2] = makePair("dalian-coastal", 18, 16);
  const orphan = makeTrack({ slug: "chengde-qingchui", group: "orphan", role: 1, km: 10 });
  const noLine = makeTrack({
    slug: "chengde-qingchui",
    group: "broken",
    role: 1,
    km: 10,
    line: fakeLine(bySlug["chengde-qingchui"].lat, bySlug["chengde-qingchui"].lng, 0.5, 20),
  });
  const noLine2 = { ...makeTrack({ slug: "chengde-qingchui", group: "broken", role: 2, km: 8 }), line: null };
  const { groups, orphans } = buildGroups([d1, d2, orphan, noLine, noLine2], destinations);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].slug, "dalian-coastal");
  assert.equal(groups[0].tracks[0].day_role, 1);
  assert.equal(orphans.length, 3);
});

test("pairAutoTracks 为无组轨迹按城市自动配对，里程长者为 Day1", () => {
  const dest = bySlug["tianjin-binhai"];
  const short = {
    ...makeTrack({ slug: "tianjin-binhai", group: undefined, role: undefined, km: 6 }),
    group_id: undefined,
    day_role: undefined,
    discovered_at: "2026-09-01T00:00:00Z",
  };
  const long = {
    ...makeTrack({ slug: "tianjin-binhai", group: undefined, role: undefined, km: 14 }),
    url: "https://www.2bulu.com/track/long.htm",
    group_id: undefined,
    day_role: undefined,
    discovered_at: "2026-09-02T00:00:00Z",
  };
  const out = pairAutoTracks([short, long]);
  const paired = out.filter((t) => t.group_id);
  assert.equal(paired.length, 2);
  assert.equal(paired[0].group_id, paired[1].group_id);
  assert.match(paired[0].group_id, /^tianjin-binhai--auto-1$/);
  const day1 = paired.find((t) => t.day_role === 1);
  assert.equal(day1.mileage_km, 14);
});

test("无显式归城的轨迹自动就近归城", () => {
  const line = fakeLine(36.07, 120.38, 0.4, 10);
  const raw = {
    url: "https://www.2bulu.com/track/qingdao-x.htm",
    name: "青岛测试轨迹",
    mileage_km: 9,
    center: [line[0][0], line[0][1]],
    line,
    photos: [],
    group_id: "qingdao-x",
    day_role: 1,
    source: "discover",
  };
  const { tracks } = buildGroups([raw], destinations);
  assert.equal(tracks.find((t) => t.url === raw.url).destination_slug, "qingdao-coast");
});

test("weatherScore 晴好贴合温度 > 雷雨高温；无预报返回 null", () => {
  const dest = bySlug["dalian-coastal"];
  const sunny = { days: [{ code: 0, minC: 18, maxC: 23, pop: 5 }, { code: 1, minC: 19, maxC: 24, pop: 10 }] };
  const storm = { days: [{ code: 95, minC: 27, maxC: 33, pop: 95 }, { code: 65, minC: 25, maxC: 30, pop: 90 }] };
  assert.ok(weatherScore(sunny, dest) > weatherScore(storm, dest));
  assert.equal(weatherScore(null, dest), null);
});

test("parseTempRange 兼容 – - ~ 分隔符", () => {
  assert.deepEqual(parseTempRange("16–24°C"), [16, 24]);
  assert.deepEqual(parseTempRange("10-22"), [10, 22]);
  assert.equal(parseTempRange(null), null);
});

test("selectGroups L1 排除上一期城市，保证每周城市不重样", () => {
  const slugs = [
    "dalian-coastal",
    "beidaihe-boardwalk",
    "chengde-qingchui",
    "tianjin-binhai",
    "tangshan-coast",
    "zhangjiakou-greatwall",
  ];
  const groups = slugs.flatMap((s, i) => {
    const [a, b] = makePair(s, 10 + i, 8 + i, `g${i}`);
    return buildGroups([a, b], destinations).groups;
  });
  const history = [
    {
      weekend: "2026-09-13",
      destinations: [
        { slug: "dalian-coastal", group_id: "dalian-coastal--g0" },
        { slug: "beidaihe-boardwalk", group_id: "beidaihe-boardwalk--g1" },
        { slug: "chengde-qingchui", group_id: "chengde-qingchui--g2" },
      ],
    },
  ];
  const { picks, layer } = selectGroups(groups, {}, history, { count: 3, weekendMonth: 9 });
  assert.equal(layer, 1);
  assert.equal(picks.length, 3);
  const pickedSlugs = picks.map((p) => p.slug).sort();
  assert.deepEqual(pickedSlugs, ["tangshan-coast", "tianjin-binhai", "zhangjiakou-greatwall"]);
  assert.equal(new Set(pickedSlugs).size, 3);
});

test("selectGroups 库存耗尽时分层降级仍只产出完整组且结果确定", () => {
  const [a1, a2] = makePair("dalian-coastal", 18, 16, "seed");
  const [b1, b2] = makePair("beidaihe-boardwalk", 6, 9, "seed");
  const [c1, c2] = makePair("chengde-qingchui", 12, 5, "seed");
  const groups = buildGroups([a1, a2, b1, b2, c1, c2], destinations).groups;
  const history = [
    { weekend: "2026-09-13", destinations: groups.map((g) => ({ slug: g.slug, group_id: g.id })) },
    { weekend: "2026-09-20", destinations: groups.map((g) => ({ slug: g.slug, group_id: g.id })) },
    { weekend: "2026-09-27", destinations: groups.map((g) => ({ slug: g.slug, group_id: g.id })) },
    { weekend: "2026-10-04", destinations: groups.map((g) => ({ slug: g.slug, group_id: g.id })) },
  ];
  const r1 = selectGroups(groups, {}, history, { count: 3, weekendMonth: 10 });
  const r2 = selectGroups(groups, {}, history, { count: 3, weekendMonth: 10 });
  assert.equal(r1.picks.length, 3);
  assert.equal(r1.layer, 3);
  assert.deepEqual(r1.picks.map((p) => p.id), r2.picks.map((p) => p.id));
});

test("editionsSincePublished 正确反映轮转冷却", () => {
  const history = [
    { destinations: [{ slug: "a" }] },
    { destinations: [{ slug: "b" }] },
    { destinations: [{ slug: "a" }] },
  ];
  assert.equal(editionsSincePublished("a", history), 0);
  assert.equal(editionsSincePublished("b", history), 1);
  assert.equal(editionsSincePublished("z", history), null);
});

test("buildRoute 完整满足前端契约：坐标序、null 票价、航班模板、交通段、line 里程兜底", () => {
  const [d1Raw, d2Raw] = makePair("qingdao-coast", null, null, "auto1", {
    photos: ["/photos/library/abc/1.jpg"],
  });
  const line1 = fakeLine(36.07, 120.38, 0.6, 30);
  const line2 = fakeLine(36.08, 120.4, 0.5, 24);
  d1Raw.line = line1;
  d1Raw.center = [line1[0][0], line1[0][1]];
  d2Raw.line = line2;
  d2Raw.center = [line2[0][0], line2[0][1]];
  const [group] = buildGroups([d1Raw, d2Raw], destinations).groups;
  const forecast = { days: [{ code: 0, minC: 19, maxC: 24 }, { code: 2, minC: 20, maxC: 25 }] };
  const route = buildRoute(group, forecast, (c) => (c === 0 ? "晴朗" : "多云"));

  assert.equal(route.id, "qingdao-coast");
  assert.equal(route.overview.duration_days, 2);
  assert.equal(typeof route.overview.total_hiking_km, "number");
  assert.ok(route.overview.total_hiking_km > 0); // mileage_km 为 null 时由 line 兜底
  assert.match(route.daily_distances.day1, /km$/);
  assert.equal(route.train_fare_ref_cny, null); // 未核实票价禁止编造
  assert.equal(route.departure.city, "北京");
  assert.match(route.departure.flight_url, /PEK%20to%20TAO/);
  assert.match(route.departure.flight_url, /%7Bdepart%7D.*%7Breturn%7D/);

  // center/POI 是 [lat,lng]，line 是 [lng,lat]
  const [clat, clng] = route.map_data.center_location;
  assert.ok(clat > 35 && clat < 37 && clng > 119 && clng < 121);
  for (const poi of route.map_data.points_of_interest) {
    assert.equal(poi.coordinates.length, 2);
    assert.ok(Math.abs(poi.coordinates[0] - 36) < 1);
  }
  assert.deepEqual(route.itinerary.days[0].bulu_track_line[0], line1[0]);

  const allSegments = route.itinerary.days.flatMap((d) => d.segments);
  assert.ok(allSegments.some((s) => s.activity_type === "transport"));
  assert.ok(allSegments.some((s) => s.activity_type === "hiking" && s.highlight));
  assert.equal(route.itinerary.days[0].photos[0], "/photos/library/abc/1.jpg");
  assert.equal(route.weather_info.day1.condition, "晴朗");
});

test("buildRoute 已核实城市票价落数字，无航班城市不带 flight 字段", () => {
  const [d1, d2] = makePair("chengde-qingchui", 12.4, 4.8, "seed");
  const [group] = buildGroups([d1, d2], destinations).groups;
  const route = buildRoute(group, null);
  assert.equal(route.train_fare_ref_cny, 95);
  assert.equal(route.departure.flight_url, undefined);
  assert.equal(route.weather_info.day1.temp_range, "12–22°C"); // 静态兜底
});

test("scoreGroup 当季 + LRU 加成可排序，无预报按中性天气分", () => {
  const [d1, d2] = makePair("datong-hengshan", 12, 10, "g1");
  const [group] = buildGroups([d1, d2], destinations).groups;
  const fresh = scoreGroup(group, null, [], 7); // 7 月不在大同季节月 [5,6,9,10]
  const neverPublished = fresh;
  const justPublished = scoreGroup(group, null, [{ destinations: [{ slug: "datong-hengshan" }] }], 7);
  assert.ok(neverPublished > justPublished);
  const inSeason = scoreGroup(group, null, [], 5);
  assert.ok(inSeason > fresh);
});

test("polylineKm 估算轨迹长度", () => {
  const line = fakeLine(40, 116, 1, 11);
  const km = polylineKm(line);
  assert.ok(km > 8 && km < 14, `got ${km}`);
});

test("buildEdition 记录发布组用于历史去重", () => {
  const [d1, d2] = makePair("dalian-coastal", 18, 16, "seed");
  const [group] = buildGroups([d1, d2], destinations).groups;
  const edition = buildEdition("2026-09-19", [group], "2026-09-07T12:00:00.000Z");
  assert.equal(edition.destinations[0].slug, "dalian-coastal");
  assert.equal(edition.destinations[0].group_id, group.id);
  assert.equal(edition.destinations[0].tracks.length, 2);
});
