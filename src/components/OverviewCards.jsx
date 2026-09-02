import { useEffect, useState } from "react";
import { ArrowUpRight, CloudSun, Footprints, Plane, ThumbsUp, TrainFront } from "lucide-react";
import {
  buildQunarFlightUrl,
  fetchWeekendForecast,
  getTargetWeekend,
  outfitFromTemp,
  recommendTransport,
} from "../lib/weekend.js";
import faresSnapshot from "../data/fares.json";

const dateFmt = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" });

function WeatherCard({ route, weekend }) {
  const [forecast, setForecast] = useState(null);
  const [status, setStatus] = useState("loading");

  const [lat, lon] = route.map_data.center_location;
  const weekendKey = `${route.id}-${weekend.saturday.toISOString()}`;

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");

    fetchWeekendForecast(lat, lon, weekend.saturday, weekend.sunday)
      .then((data) => {
        if (cancelled) return;
        setForecast(data);
        setStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setForecast(null);
        setStatus("fallback");
      });

    return () => {
      cancelled = true;
    };
  }, [weekendKey, lat, lon]);

  const wi = route.weather_info;
  const dayRows = [
    {
      label: "周六",
      day: "D1",
      date: dateFmt.format(weekend.saturday),
      condition: forecast?.days?.[0]?.condition ?? wi.day1?.condition ?? "多云",
      range: forecast?.days?.[0]?.range ?? wi.day1?.temp_range ?? wi.suitable_temp_range,
    },
    {
      label: "周日",
      day: "D2",
      date: dateFmt.format(weekend.sunday),
      condition: forecast?.days?.[1]?.condition ?? wi.day2?.condition ?? "多云",
      range: forecast?.days?.[1]?.range ?? wi.day2?.temp_range ?? wi.suitable_temp_range,
    },
  ];
  const advice =
    forecast != null
      ? `${outfitFromTemp(forecast.minC, forecast.maxC)} ${wi.condition_note}`
      : wi.condition_note;

  return (
    <div className="flex h-full flex-col rounded-2xl bg-moss-50 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs text-moss-500">
          <CloudSun className="h-3.5 w-3.5" aria-hidden />
          天气 · {wi.target_city}
        </p>
        <span className="rounded-full bg-white/80 px-2 py-0.5 text-[10px] font-medium tracking-wide text-sea-600">
          {status === "fallback" ? "季节参考" : "下周末预测"}
        </span>
      </div>

      <ul className="mt-2 space-y-1.5">
        {status === "loading" ? (
          <li className="rounded-xl bg-white/60 px-2.5 py-2.5 text-xs text-moss-400">正在匹配周末气温…</li>
        ) : (
          dayRows.map((row) => (
            <li
              key={row.day}
              className="flex items-center gap-2 rounded-xl bg-white/60 px-2.5 py-1.5"
            >
              <span className="shrink-0 text-xs font-medium text-moss-800">
                {row.label}
                <span className="ml-1 text-[10px] text-moss-400">{row.day}</span>
              </span>
              <span className="shrink-0 text-[10px] text-moss-400">{row.date}</span>
              <span className="min-w-0 flex-1 truncate text-right text-xs text-moss-600">{row.condition}</span>
              <span className="shrink-0 text-xs font-semibold text-moss-900">{row.range}</span>
            </li>
          ))
        )}
      </ul>

      <p className="mt-auto pt-2 text-[11px] leading-relaxed text-moss-500">{advice}</p>
    </div>
  );
}

function MileageCard({ route }) {
  return (
    <div className="flex h-full flex-col rounded-2xl bg-moss-50 px-4 py-3">
      <p className="flex items-center gap-1.5 text-xs text-moss-500">
        <Footprints className="h-3.5 w-3.5" aria-hidden />
        预计里程
      </p>
      <p className="mt-2.5 font-display text-2xl font-semibold leading-none text-moss-900">
        {route.overview.total_hiking_km}
        <span className="ml-1 text-xs font-normal text-moss-500">km 总长</span>
      </p>
      <ul className="flex flex-1 flex-col justify-center gap-1.5 py-3">
        {[
          { day: "Day 1", value: route.daily_distances.day1 },
          { day: "Day 2", value: route.daily_distances.day2 },
        ].map((row) => (
          <li
            key={row.day}
            className="flex items-center justify-between rounded-xl bg-white/60 px-2.5 py-1.5 text-xs"
          >
            <span className="text-moss-600">{row.day}</span>
            <span className="font-medium text-moss-800">{row.value}</span>
          </li>
        ))}
      </ul>
      <p>
        <span className="inline-flex rounded-full bg-moss-900/10 px-2 py-0.5 text-[10px] font-medium text-moss-700">
          难度 {route.overview.difficulty_level}
        </span>
      </p>
    </div>
  );
}

function TransportRow({ icon: Icon, text, href, recommended, label }) {
  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap text-xs">
      <Icon className="h-3.5 w-3.5 shrink-0 text-moss-500" aria-hidden />
      <span className={recommended ? "font-semibold text-moss-900" : "text-moss-600"}>{text}</span>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        aria-label={label}
        title={label}
        className="ml-auto inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-moss-700/20 text-moss-500 transition hover:border-moss-700/50 hover:bg-white hover:text-moss-700"
      >
        <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
      </a>
    </div>
  );
}

function TransportCard({ route, weekend }) {
  const recommend = recommendTransport(route, faresSnapshot);
  const dep = route.departure || {};
  const flightAvailable = Boolean(dep.flight_url);
  const flightWins = recommend.mode === "flight";
  const withDuration = (label, duration) => (duration ? `${label} · ${duration}` : label);
  const trainText = withDuration(`高铁 ¥${recommend.train.fareRefCny ?? "—"}`, dep.train_duration);
  const flightText = recommend.flight
    ? withDuration(`机票 ¥${recommend.flight.minCny}`, dep.flight_duration)
    : withDuration("机票比价", dep.flight_duration);

  return (
    <div className="flex h-full flex-col rounded-2xl bg-moss-50 px-4 py-3">
      <p className="flex items-center gap-1.5 text-xs text-moss-500">
        {flightWins ? <Plane className="h-3.5 w-3.5" aria-hidden /> : <TrainFront className="h-3.5 w-3.5" aria-hidden />}
        交通与票务
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-sm font-medium text-moss-800">
        {route.transport_label}
        <span className="inline-flex items-center gap-0.5 rounded-full bg-moss-900/10 px-2 py-0.5 text-[10px] font-semibold text-moss-800">
          <ThumbsUp className="h-2.5 w-2.5" aria-hidden />
          {flightWins ? "✈️ 本周机票特价" : "🚄 高铁出行更省"}
        </span>
      </p>
      <div className="mt-auto space-y-2.5 pt-3">
        <TransportRow
          icon={TrainFront}
          text={trainText}
          href={recommend.train.url}
          recommended={!flightWins}
          label="前往 12306 查票/订票"
        />
        {flightAvailable ? (
          <TransportRow
            icon={Plane}
            text={flightText}
            href={buildQunarFlightUrl(route.weather_info.target_city, weekend.saturday)}
            recommended={flightWins}
            label="前往去哪儿查询实时机票"
          />
        ) : null}
      </div>
    </div>
  );
}

export default function OverviewCards({ route }) {
  // 与每周管道发布节奏一致：展示"下周目标周末"（发布周一 +12/+13 天）
  const weekend = getTargetWeekend();

  return (
    <div className="mt-6 grid grid-cols-1 items-stretch gap-3 sm:grid-cols-3">
      <WeatherCard route={route} weekend={weekend} />
      <MileageCard route={route} />
      <TransportCard route={route} weekend={weekend} />
    </div>
  );
}
