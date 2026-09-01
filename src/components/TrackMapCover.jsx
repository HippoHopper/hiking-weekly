import { useEffect, useRef } from "react";

const TILE = 256;
const PAD = 44;
const MIN_Z = 10;
const MAX_Z = 16;

function worldX(lng, z) {
  return ((lng + 180) / 360) * TILE * Math.pow(2, z);
}

function worldY(lat, z) {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE * Math.pow(2, z);
}

function tileSrc(x, y, z) {
  return `https://webrd0${((x + y) % 4) + 1}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=${x}&y=${y}&z=${z}`;
}

export default function TrackMapCover({ line, className = "" }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !Array.isArray(line) || line.length < 2) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const tiles = new Map();
    let disposed = false;

    const render = () => {
      if (disposed) return;
      const parent = canvas.parentElement;
      const cssW = parent ? parent.clientWidth : 360;
      const cssH = parent ? parent.clientHeight : 300;
      if (cssW < 10 || cssH < 10) return;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      let minLng = Infinity;
      let maxLng = -Infinity;
      let minLat = Infinity;
      let maxLat = -Infinity;
      for (const [lng, lat] of line) {
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }

      let z = MAX_Z;
      let cx = 0;
      let cy = 0;
      for (; z >= MIN_Z; z -= 1) {
        const spanX = worldX(maxLng, z) - worldX(minLng, z);
        const spanY = worldY(minLat, z) - worldY(maxLat, z);
        if (spanX <= cssW - PAD * 2 && spanY <= cssH - PAD * 2) {
          cx = (worldX(minLng, z) + worldX(maxLng, z)) / 2;
          cy = (worldY(minLat, z) + worldY(maxLat, z)) / 2;
          break;
        }
      }
      if (z < MIN_Z) {
        z = MIN_Z;
        cx = (worldX(minLng, z) + worldX(maxLng, z)) / 2;
        cy = (worldY(minLat, z) + worldY(maxLat, z)) / 2;
      }

      const viewLeft = cx - cssW / 2;
      const viewTop = cy - cssH / 2;

      ctx.fillStyle = "#e9efe9";
      ctx.fillRect(0, 0, cssW, cssH);

      const tx0 = Math.floor(viewLeft / TILE);
      const ty0 = Math.floor(viewTop / TILE);
      const tx1 = Math.floor((viewLeft + cssW) / TILE);
      const ty1 = Math.floor((viewTop + cssH) / TILE);
      for (let tx = tx0; tx <= tx1; tx += 1) {
        for (let ty = ty0; ty <= ty1; ty += 1) {
          const key = `${z}/${tx}/${ty}`;
          let img = tiles.get(key);
          if (!img) {
            img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = () => {
              if (!disposed) render();
            };
            img.src = tileSrc(tx, ty, z);
            tiles.set(key, img);
          }
          if (img.complete && img.naturalWidth > 0) {
            ctx.drawImage(img, tx * TILE - viewLeft, ty * TILE - viewTop, TILE, TILE);
          }
        }
      }

      const pts = line.map(([lng, lat]) => [
        worldX(lng, z) - viewLeft,
        worldY(lat, z) - viewTop,
      ]);

      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.strokeStyle = "rgba(255,255,255,0.92)";
      ctx.lineWidth = 6.5;
      ctx.stroke();

      ctx.beginPath();
      pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.strokeStyle = "#e23a2e";
      ctx.lineWidth = 3.5;
      ctx.stroke();

      const drawBadge = (x, y, label, color) => {
        ctx.beginPath();
        ctx.arc(x, y, 11, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 12px ui-sans-serif, system-ui, -apple-system, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, x, y + 0.5);
      };

      drawBadge(pts[0][0], pts[0][1], "起", "#2f9e54");
      drawBadge(pts[pts.length - 1][0], pts[pts.length - 1][1], "终", "#d8352a");
    };

    render();

    let ro = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => render());
      if (canvas.parentElement) ro.observe(canvas.parentElement);
    }

    return () => {
      disposed = true;
      if (ro) ro.disconnect();
    };
  }, [line]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
