export function toISODate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 若今天已是周末则取本周末，否则取即将到来的周六、周日。 */
export function getUpcomingWeekend(from = new Date()) {
  const today = new Date(from);
  today.setHours(0, 0, 0, 0);
  const weekday = today.getDay();

  const saturday = new Date(today);
  if (weekday === 6) {
    /* already Saturday */
  } else if (weekday === 0) {
    saturday.setDate(today.getDate() - 1);
  } else {
    saturday.setDate(today.getDate() + (6 - weekday));
  }

  const sunday = new Date(saturday);
  sunday.setDate(saturday.getDate() + 1);

  return { saturday, sunday };
}

export function formatWeekendRange(saturday, sunday) {
  const fmt = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", weekday: "short" });
  return `${fmt.format(saturday)} – ${fmt.format(sunday)}`;
}

export function fillDateTemplate(url, saturday, sunday) {
  return url
    .replaceAll("{depart}", toISODate(saturday))
    .replaceAll("{return}", toISODate(sunday));
}

/**
 * 行程流交通段文案：与交通卡推荐结果联动。
 * mode 为 recommendTransport 返回的 "train" | "flight"，
 * 保证"卡推高铁、Day 1 就写高铁"的前后一致性。
 */
export function transportSegmentText(route, dayNum, mode) {
  const dep = route.departure || {};
  const dest = (route.transport_label || "").split("⇄")[1]?.trim() || route.weather_info?.target_city || "";
  const spot = dep.arrival_spot || "酒店";
  const byFlight = mode === "flight" && Boolean(dep.flight_url);

  if (dayNum === 1) {
    return byFlight
      ? `北京飞${dest}，落地直达${spot}。`
      : `北京高铁至${dest}，到达${dep.train_arrival || `${dest}站`}后直达${spot}。`;
  }
  const tail = dep.return_note ? dep.return_note.replace(/^[，,]/, "") : "结束周末行程。";
  return byFlight ? `飞回北京，${tail}` : `乘高铁返京，${tail}`;
}

/** 去哪儿机票单程搜索（北京 → 目的城市，周六出发），供交通卡 icon 跳转。 */
export function buildQunarFlightUrl(cityName, departDate) {
  const params = new URLSearchParams({
    searchDepartureAirport: "北京",
    searchArrivalAirport: cityName,
    searchDepartureTime: toISODate(departDate),
    nextNDays: "0",
    startSearch: "true",
  });
  return `https://flight.qunar.com/site/oneway_list.htm?${params.toString()}`;
}

/**
 * 真实比价：高铁公布参考票价（routes.json train_fare_ref_cny）
 * vs 构建期 Google Flights 实时快照（fares.json，7 天内有效）。
 * 机票比高铁参考价便宜 15% 以上视为特价，推荐飞机；否则一律推荐高铁。
 * 无航班快照或航班不可达的路线，默认推荐高铁。
 */
export function recommendTransport(route, fares, now = new Date()) {
  const dep = route.departure || {};
  const train = {
    url: dep.train_url || "https://www.12306.cn/",
    fareRefCny: typeof route.train_fare_ref_cny === "number" ? route.train_fare_ref_cny : null,
  };
  let flight = null;
  const snap = fares?.routes?.[route.id];
  if (dep.flight_url && snap?.flightMinCny && snap?.fetchedAt) {
    const ageDays = (now.getTime() - new Date(snap.fetchedAt).getTime()) / 86_400_000;
    if (ageDays <= 7) {
      flight = { urlTemplate: dep.flight_url, minCny: snap.flightMinCny, fetchedAt: snap.fetchedAt };
    }
  }
  const flightWins = Boolean(flight && train.fareRefCny && flight.minCny <= train.fareRefCny * 0.85);
  return { mode: flightWins ? "flight" : "train", train, flight };
}

const WMO = {
  0: "晴朗",
  1: "大部晴朗",
  2: "多云",
  3: "阴天",
  45: "有雾",
  48: "雾凇",
  51: "小毛毛雨",
  53: "毛毛雨",
  55: "浓毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  80: "阵雨",
  81: "强阵雨",
  95: "雷阵雨",
};

export function describeWeatherCode(code) {
  return WMO[code] ?? "多云间晴";
}

export function outfitFromTemp(minC, maxC) {
  if (maxC >= 28) return "短袖即可，备帽子与防晒，避开正午暴晒路段。";
  if (maxC >= 22 && minC >= 14) return "短袖加薄外套，晨晚海风或林风时套上即可。";
  if (maxC >= 16) return "长袖速干 + 薄风衣，分层穿脱最稳妥。";
  if (maxC >= 10) return "抓绒或轻羽绒，手套可选，注意山区早晚温差。";
  return "保暖层齐全，防风帽与手套建议带上。";
}

export async function fetchWeekendForecast(lat, lon, saturday, sunday) {
  const start = toISODate(saturday);
  const end = toISODate(sunday);
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    daily: "temperature_2m_max,temperature_2m_min,weather_code",
    timezone: "Asia/Shanghai",
    start_date: start,
    end_date: end,
  });
  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!response.ok) throw new Error("forecast failed");
  const data = await response.json();
  const highs = data.daily?.temperature_2m_max ?? [];
  const lows = data.daily?.temperature_2m_min ?? [];
  const codes = data.daily?.weather_code ?? [];
  if (highs.length < 2 || lows.length < 2) throw new Error("empty forecast");
  const days = highs.map((high, i) => {
    const minC = Math.round(lows[i]);
    const maxC = Math.round(high);
    return {
      condition: describeWeatherCode(codes[i] ?? 2),
      minC,
      maxC,
      range: `${minC}–${maxC}°C`,
    };
  });
  return {
    days,
    minC: Math.round(Math.min(...lows)),
    maxC: Math.round(Math.max(...highs)),
  };
}
