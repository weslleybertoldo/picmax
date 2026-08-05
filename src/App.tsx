// Harness dev do engine WebGL (Task 3) — será substituído pelo Editor na Task 4
import { useEffect, useRef, useState } from 'react';
import { createRenderer, type Renderer } from './engine/renderer';
import { FILTERS } from './engine/filters';
import { initialSnapshot, type EditSnapshot } from './state/editStack';

function makeTestBitmap(): Promise<ImageBitmap> {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 512, 512);
  grad.addColorStop(0, '#ff2d55'); grad.addColorStop(0.5, '#34c759'); grad.addColorStop(1, '#0a84ff');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, 512, 512);
  const circles: [number, number, number, string][] = [
    [128, 128, 80, '#ffd60a'], [384, 160, 60, '#ff9f0a'], [256, 384, 100, '#bf5af2'], [430, 430, 50, '#ffffff'],
  ];
  for (const [x, y, r, col] of circles) {
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 64, 64); // marcador de orientação (canto sup. esquerdo)
  return createImageBitmap(c);
}

declare global {
  interface Window { __picmax?: { ready: boolean; set: (patch: Partial<EditSnapshot>) => void } }
}

const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0' };

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const [snap, setSnap] = useState<EditSnapshot>(initialSnapshot);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let r: Renderer | null = null;
    try {
      r = createRenderer(canvasRef.current!);
      rendererRef.current = r;
      makeTestBitmap().then((bmp) => {
        if (!alive) return;
        r!.setImage(bmp);
        setReady(true);
      });
    } catch (e) {
      setError(String(e));
    }
    return () => { alive = false; r?.destroy(); rendererRef.current = null; setReady(false); };
  }, []);

  useEffect(() => {
    if (ready) rendererRef.current?.render(snap);
  }, [snap, ready]);

  useEffect(() => { // hook do teste automatizado (harness dev)
    window.__picmax = { ready, set: (patch) => setSnap((s) => ({ ...s, ...patch })) };
  }, [ready]);

  const g = snap.geometry;
  const setAdj = (key: keyof EditSnapshot['adjustments'], v: number) =>
    setSnap((s) => ({ ...s, adjustments: { ...s.adjustments, [key]: v } }));
  const setGeo = (patch: Partial<EditSnapshot['geometry']>) =>
    setSnap((s) => ({ ...s, geometry: { ...s.geometry, ...patch } }));

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: 16, fontFamily: 'system-ui, sans-serif' }}>
      <h2 style={{ margin: '0 0 12px' }}>PicMax — harness do engine (Task 3)</h2>
      {error && <p style={{ color: 'red' }} data-testid="engine-error">{error}</p>}
      <canvas ref={canvasRef} data-testid="preview" style={{ width: '100%', maxWidth: 512, background: '#222' }} />
      <div style={row}>
        <label style={{ width: 110 }}>Brilho {snap.adjustments.brightness}</label>
        <input type="range" min={-100} max={100} value={snap.adjustments.brightness}
          onChange={(e) => setAdj('brightness', Number(e.target.value))} style={{ flex: 1 }} data-testid="brightness" />
      </div>
      <div style={row}>
        <label style={{ width: 110 }}>Filtro</label>
        <select data-testid="filter" value={snap.filter?.id ?? ''}
          onChange={(e) => setSnap((s) => ({
            ...s,
            filter: e.target.value ? { id: e.target.value, intensity: s.filter?.intensity ?? 100 } : null,
          }))}>
          <option value="">— sem filtro —</option>
          {FILTERS.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <label>Intensidade {snap.filter?.intensity ?? 100}</label>
        <input type="range" min={0} max={100} value={snap.filter?.intensity ?? 100} disabled={!snap.filter}
          onChange={(e) => setSnap((s) => s.filter
            ? { ...s, filter: { ...s.filter, intensity: Number(e.target.value) } } : s)}
          style={{ flex: 1 }} data-testid="intensity" />
      </div>
      <div style={row}>
        <button type="button" data-testid="rot90"
          onClick={() => setGeo({ rotate90: ((g.rotate90 + 1) & 3) as 0 | 1 | 2 | 3 })}>
          Rot 90° ({g.rotate90})
        </button>
        <button type="button" data-testid="flipH" onClick={() => setGeo({ flipH: !g.flipH })}>
          Flip H {g.flipH ? 'ON' : 'off'}
        </button>
        <label style={{ marginLeft: 12 }}>Straighten {g.straighten}°</label>
        <input type="range" min={-45} max={45} value={g.straighten}
          onChange={(e) => setGeo({ straighten: Number(e.target.value) })} style={{ flex: 1 }} data-testid="straighten" />
      </div>
    </div>
  );
}
