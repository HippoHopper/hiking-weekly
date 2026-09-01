import { useState } from "react";
import { Calendar, MapPin, RefreshCw } from "lucide-react";
import routes from "./data/routes.json";
import OverviewCards from "./components/OverviewCards.jsx";
import ItineraryFlow from "./components/ItineraryFlow.jsx";
import SubmitRoute from "./components/SubmitRoute.jsx";

function formatNow() {
  return new Intl.DateTimeFormat("zh-CN", {
    weekday: "short",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
}

export default function App() {
  const [index, setIndex] = useState(0);
  const [now] = useState(() => formatNow());

  const route = routes[index];
  const total = routes.length;

  const nextRoute = () => {
    setIndex((current) => (current + 1) % total);
  };

  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-moss-100 via-sand-50 to-sand-50">
      <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-5 py-8 sm:px-8">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-moss-200/60 pb-6">
          <div>
            <p className="text-xs tracking-[0.22em] text-moss-500">WEEKLY TRAIL NOTES</p>
            <h1 className="mt-1 font-display text-3xl font-semibold text-moss-900">🌄 周末徒哪儿</h1>
          </div>
          <div className="text-right text-sm text-moss-700">
            <p className="flex items-center justify-end gap-1.5">
              <Calendar className="h-3.5 w-3.5" aria-hidden />
              {now}
            </p>
            <p className="mt-1 flex items-center justify-end gap-1.5">
              <MapPin className="h-3.5 w-3.5" aria-hidden />
              出发地 {route.departure.city}
            </p>
          </div>
        </header>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-moss-600">本周精选 · Top {index + 1}</p>
          <div className="flex items-center gap-2.5">
            <SubmitRoute />
            <button
              type="button"
              onClick={nextRoute}
              className="inline-flex items-center gap-2 rounded-full border border-moss-700/20 bg-white/70 px-4 py-2 text-sm text-moss-800 shadow-sm backdrop-blur transition hover:border-moss-700/40 hover:bg-white"
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
              切换下一条路线 ({index + 1}/{total})
            </button>
          </div>
        </div>

        <main className="mt-6 flex-1">
          <article className="rounded-3xl border border-white/80 bg-white/80 p-6 shadow-card backdrop-blur-sm sm:p-8">
            <p className="text-xs uppercase tracking-[0.18em] text-sea-600">{route.tags.join("  ·  ")}</p>
            <h2 className="mt-3 font-display text-2xl font-semibold text-moss-900 sm:text-3xl">{route.title}</h2>
            <p className="mt-3 max-w-prose leading-relaxed text-moss-700">{route.summary}</p>

            <OverviewCards route={route} />
            <ItineraryFlow route={route} />
          </article>
        </main>
      </div>
    </div>
  );
}
