import { useEffect, useState } from "react";
import { Check, Download, Link2, X } from "lucide-react";

const STORAGE_KEY = "hiking-weekly:submissions";
const TRACK_URL_RE = /2bulu\.com\/track\/t-[A-Za-z0-9%._-]+\.htm/i;

function loadSubmissions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export default function SubmitRoute() {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [submissions, setSubmissions] = useState([]);

  useEffect(() => {
    if (open) setSubmissions(loadSubmissions());
  }, [open]);

  const submit = async (event) => {
    event.preventDefault();
    const value = url.trim();
    if (!TRACK_URL_RE.test(value)) {
      setError("请粘贴两步路轨迹链接，形如 https://www.2bulu.com/track/t-xxxx.htm");
      return;
    }
    const next = [{ url: value, submittedAt: new Date().toISOString() }, ...submissions].slice(0, 50);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* 隐私模式等场景下 localStorage 不可用，忽略持久化错误 */
    }
    const webhook = import.meta.env.VITE_SUBMIT_WEBHOOK;
    if (webhook) {
      fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: value, submittedAt: new Date().toISOString() }),
      }).catch(() => {});
    }
    setSubmissions(next);
    setUrl("");
    setError("");
  };

  const exportJson = () => {
    const payload = submissions.map((s) => s.url);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = "submissions.json";
    a.click();
    URL.revokeObjectURL(href);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-full border border-moss-700/20 bg-white/70 px-3.5 py-2 text-sm text-moss-800 shadow-sm backdrop-blur transition hover:border-moss-700/40 hover:bg-white"
      >
        <Link2 className="h-4 w-4" aria-hidden />
        推荐新路线
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-moss-900/40 p-4 backdrop-blur-sm"
          onClick={() => setOpen(false)}
          role="presentation"
        >
          <div
            className="w-full max-w-md rounded-2xl border border-moss-200 bg-white p-6 shadow-card"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="推荐新路线"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-display text-lg font-semibold text-moss-900">链接上载 · 推荐新路线</h3>
                <p className="mt-1 text-xs leading-relaxed text-moss-600">
                  在两步路发现好走的轨迹？把链接贴进来，主编每周采集时会自动解析轨迹、照片与里程，入选下周推荐。
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-full p-1.5 text-moss-500 transition hover:bg-moss-100"
                aria-label="关闭"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>

            <form onSubmit={submit} className="mt-4">
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="粘贴两步路轨迹链接，如 https://www.2bulu.com/track/t-xxxx.htm"
                className="w-full rounded-xl border border-moss-200 bg-moss-50/60 px-3.5 py-2.5 text-sm text-moss-900 outline-none transition focus:border-moss-500 focus:bg-white"
                autoFocus
              />
              {error ? <p className="mt-1.5 text-xs text-red-600">{error}</p> : null}
              <button
                type="submit"
                className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-full bg-moss-900 px-4 py-2.5 text-sm font-medium text-sand-50 transition hover:bg-moss-700"
              >
                <Check className="h-4 w-4" aria-hidden />
                提交轨迹链接
              </button>
            </form>

            {submissions.length ? (
              <div className="mt-4 rounded-xl bg-moss-50 p-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-moss-600">本机已记录 {submissions.length} 条推荐链接</p>
                  <button
                    type="button"
                    onClick={exportJson}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-sea-600 transition hover:text-moss-700"
                  >
                    <Download className="h-3 w-3" aria-hidden />
                    导出 JSON 给采集脚本
                  </button>
                </div>
                <ul className="mt-2 space-y-1">
                  {submissions.slice(0, 3).map((s) => (
                    <li key={s.url} className="truncate text-[11px] text-moss-500">
                      {s.url}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
