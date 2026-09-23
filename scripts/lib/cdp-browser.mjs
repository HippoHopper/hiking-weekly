// 真实 Chrome + CDP 适配器：两步路 SafeLine WAF 通过 navigator.webdriver 等指纹识别
// Playwright 启动的浏览器（即便有头+stealth）必被拦；启动本机真实 Chrome 二进制并以
// CDP 连接，浏览器指纹与普通用户完全一致。仅用于本机有头发现层，CI 无头场景不用。
import { spawn } from "node:child_process";
import fs from "node:fs";

const DEFAULT_CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!res.ok) throw new Error(`CDP /json/version HTTP ${res.status}`);
  return (await res.json()).webSocketDebuggerUrl;
}

async function waitForWs(port, totalMs) {
  const deadline = Date.now() + totalMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      return await getWsUrl(port);
    } catch (err) {
      lastErr = err;
      await sleep(500);
    }
  }
  throw new Error(`Chrome CDP 端口 ${port} 等待超时：${lastErr?.message}`);
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("CDP websocket 连接失败"));
  });
  let nextId = 1;
  const pending = new Map();
  const sessionListeners = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      return;
    }
    if (msg.method) {
      const listeners = sessionListeners.get(msg.sessionId || "") || [];
      for (const fn of listeners) {
        try {
          fn(msg.method, msg.params || {});
        } catch {
          // 监听器异常不影响主流程
        }
      }
    }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const on = (sessionId, event, fn) => {
    const key = sessionId || "";
    if (!sessionListeners.has(key)) sessionListeners.set(key, []);
    const wrapped = (method, params) => {
      if (method === event) fn(params);
    };
    sessionListeners.get(key).push(wrapped);
    return () => {
      const arr = sessionListeners.get(key) || [];
      sessionListeners.set(
        key,
        arr.filter((x) => x !== wrapped),
      );
    };
  };
  return { ws, send, on };
}

function makePage(conn, sessionId, targetId) {
  const { send, on } = conn;

  const evaluate = async (expressionOrFn, arg) => {
    let expression = expressionOrFn;
    if (typeof expressionOrFn === "function") {
      // Playwright 语义：evaluate(fn, arg) 的 arg 是 fn 的【单个】实参（调用方常传数组），
      // 必须整体序列化后作为唯一参数，不能按参数列表展开
      expression = `(${expressionOrFn.toString()})(${arg === undefined ? "" : JSON.stringify(arg)})`;
    }
    const r = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, sessionId);
    if (r.exceptionDetails) {
      const desc = r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails);
      throw new Error(desc.split("\n")[0]);
    }
    return r.result?.value;
  };

  const goto = async (url, opts = {}) => {
    const timeout = opts.timeout ?? 60_000;
    const wantLoad = opts.waitUntil === "load" || !opts.waitUntil;
    const eventName = wantLoad ? "Page.loadEventFired" : "Page.domContentEventFired";
    let remove;
    const fired = new Promise((resolve) => {
      remove = on(sessionId, eventName, () => resolve());
    });
    let timerHandle;
    const timer = new Promise((_, reject) => {
      timerHandle = setTimeout(() => reject(new Error(`goto ${url.slice(0, 80)} 超时`)), timeout);
    });
    // 导航先成功时，定时器稍后触发会产生无人处理的 rejected promise（Node 直接崩进程）：
    // 挂一个空 catch 兜底，正常路径下 finally 会 clearTimeout 根本不触发
    timer.catch(() => {});
    try {
      await send("Page.navigate", { url }, sessionId);
      await Promise.race([fired, timer]);
    } finally {
      clearTimeout(timerHandle);
      remove?.();
    }
  };

  return {
    targetId,
    goto,
    evaluate,
    waitForTimeout: sleep,
    setExtraHTTPHeaders: (headers) =>
      send("Network.setExtraHTTPHeaders", { headers }, sessionId),
    close: async () => {
      await send("Target.closeTarget", { targetId }).catch(() => {});
      await send("Target.detachFromTarget", { sessionId }).catch(() => {});
    },
  };
}

async function createTab(conn, initialUrl) {
  let targetId;
  try {
    const r = await conn.send("Target.createTarget", { url: initialUrl || "about:blank" });
    targetId = r.targetId;
  } catch {
    const res = await fetch(
      `http://127.0.0.1:${conn.port}/json/new?${encodeURIComponent(initialUrl || "about:blank")}`,
      { method: "PUT" },
    ).catch(() => null);
    const j = res?.ok ? await res.json() : null;
    if (!j?.id) throw new Error("Target.createTarget 失败且 /json/new 不可用");
    targetId = j.id;
  }
  const { sessionId } = await conn.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await conn.send("Runtime.enable", {}, sessionId);
  await conn.send("Page.enable", {}, sessionId);
  await conn.send("Network.enable", {}, sessionId);
  // 新标签激活到前台，避免后台标签计时器/网络被 Chrome 限流拖慢轨迹数据加载
  await conn.send("Target.activateTarget", { targetId }).catch(() => {});
  await conn.send("Page.bringToFront", {}, sessionId).catch(() => {});
  return makePage(conn, sessionId, targetId);
}

/**
 * 启动（或复用）本机真实 Chrome 并返回 Playwright context 形状的薄适配器：
 * { newPage(), close() }。CDP 端口已在监听则直接复用（保留 WAF cookie 会话）。
 */
export async function launchRealChrome({ profileDir, port = 9222, startUrl = "about:blank" }) {
  const chromeBin = process.env.CHROME_BIN || DEFAULT_CHROME_PATHS.find((p) => fs.existsSync(p));
  if (!chromeBin) throw new Error("未找到 Google Chrome（可设 CHROME_BIN 环境变量指定路径）");

  let wsUrl = await getWsUrl(port).catch(() => null);
  let spawned = null;
  if (!wsUrl) {
    fs.mkdirSync(profileDir, { recursive: true });
    spawned = spawn(
      chromeBin,
      [
        `--remote-debugging-port=${port}`,
        "--remote-allow-origins=*",
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        startUrl,
      ],
      { detached: true, stdio: "ignore" },
    );
    spawned.unref();
    wsUrl = await waitForWs(port, 30_000);
  }

  const conn = await connect(wsUrl);
  conn.port = port;

  return {
    newPage: () => createTab(conn, "about:blank"),
    close: async () => {
      try {
        if (spawned) await conn.send("Browser.close").catch(() => {});
      } finally {
        conn.ws.close();
        if (spawned) spawned.kill("SIGTERM");
      }
    },
  };
}
