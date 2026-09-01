import { ExternalLink, Route } from "lucide-react";
import TrackMapCover from "./TrackMapCover";

const ACTIVITY_LABEL = {
  hiking: "徒步",
  transport: "交通",
  food: "用餐",
};

function hideBrokenImage(event) {
  const figure = event.currentTarget.closest("figure");
  if (figure) figure.style.display = "none";
}

function DayModule({ route, day }) {
  const photos = day.photos ?? [];
  const distance = route.daily_distances?.[`day${day.day}`];

  return (
    <div className="rounded-2xl border border-moss-200/60 bg-white/50 p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="inline-flex h-7 items-center rounded-full bg-moss-900 px-3 text-xs font-semibold tracking-wide text-sand-50">
          Day {day.day}
        </span>
        <p className="text-sm font-medium text-moss-900">{day.title}</p>
        {distance ? (
          <span className="ml-auto rounded-full bg-moss-100 px-2.5 py-0.5 text-[11px] text-moss-600">
            本段徒步约 {distance}
          </span>
        ) : null}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-5 lg:grid-cols-5">
        <div className="flex flex-col lg:col-span-3">
          <ul className="space-y-3 border-l border-moss-200 pl-4">
            {day.segments.map((segment) => (
              <li key={`${day.day}-${segment.time}`} className="relative">
                <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-moss-500" />
                <p className="text-xs text-moss-500">
                  {segment.time} · {ACTIVITY_LABEL[segment.activity_type] ?? segment.activity_type}
                </p>
                <p className="mt-0.5 text-sm leading-relaxed text-moss-800">{segment.highlight}</p>
              </li>
            ))}
          </ul>

          {photos.length > 0 ? (
            <div
              className={`mt-4 grid gap-3 ${
                photos.length >= 3 ? "grid-cols-3" : "grid-cols-2"
              }`}
            >
              {photos.slice(0, 3).map((src, index) => (
                <figure key={src} className="overflow-hidden rounded-xl bg-moss-100 shadow-card">
                  <img
                    src={src}
                    alt={`Day ${day.day} ${route.title} 实景照片 ${index + 1}`}
                    className="h-24 w-full object-cover sm:h-28"
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    onError={hideBrokenImage}
                  />
                </figure>
              ))}
            </div>
          ) : null}
        </div>

        <a
          href={day.bulu_track_url}
          target="_blank"
          rel="noreferrer"
          className="group relative flex min-h-[16rem] flex-col justify-end overflow-hidden rounded-2xl border border-moss-200/70 bg-[#e9efe9] shadow-card lg:col-span-2 lg:min-h-full"
        >
          <TrackMapCover
            line={day.bulu_track_line}
            className="pointer-events-none absolute inset-0 block h-full w-full transition duration-500 group-hover:scale-[1.03]"
          />
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-moss-900/90 via-moss-900/25 to-moss-900/5" />
          <div className="relative z-10 p-4 text-sand-50">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <Route className="h-4 w-4" aria-hidden />
              两步路轨迹地图 · Day {day.day}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-sand-100/90">{day.bulu_track_name}</p>
            <p className="mt-2 inline-flex items-center gap-1 text-[11px] text-sand-100/70">
              <ExternalLink className="h-3 w-3" aria-hidden />
              点击在新标签页打开轨迹与导航
            </p>
          </div>
        </a>
      </div>
    </div>
  );
}

export default function ItineraryFlow({ route }) {
  return (
    <section className="mt-8">
      <h3 className="text-sm font-medium text-moss-800">每日行程流</h3>

      <div className="mt-4 space-y-5">
        {route.itinerary.days.map((day) => (
          <DayModule key={day.day} route={route} day={day} />
        ))}
      </div>
    </section>
  );
}
