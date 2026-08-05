// src/tools/FilterPanel.tsx — carrossel de filtros: toque aplica 100%, slider ajusta intensidade
import { useEffect, useRef, useState, type Dispatch } from 'react';
import { createRenderer } from '../engine/renderer';
import { FILTERS } from '../engine/filters';
import { DEFAULT_ADJUSTMENTS, DEFAULT_GEOMETRY, type EditAction, type EditSnapshot, type FilterOp } from '../state/editStack';
import type { LoadedImage } from '../io/openImage';

export interface FilterPanelProps {
  present: EditSnapshot;
  dispatch: Dispatch<EditAction>;
  image: LoadedImage;
}

const THUMB_WIDTH = 128;

export default function FilterPanel({ present, dispatch, image }: FilterPanelProps) {
  const [originalThumb, setOriginalThumb] = useState<string | null>(null);
  const [filterThumbs, setFilterThumbs] = useState<Record<string, string>>({});
  // Cópia "viva" de present.filter — mesma técnica do AdjustPanel (liveRef): evita que 2 dispatches
  // síncronos no mesmo tick (ex.: cancelGesture seguido de outro toque) leiam um `present` que o React
  // ainda não repropagou. Aqui o "patch" é o objeto filter inteiro (id+intensity), não uma chave.
  const liveRef = useRef(present.filter);
  liveRef.current = present.filter; // resync a cada render (fonte de verdade quando nenhum gesto está em voo)
  // intensidade do filtro ATIVO antes do gesto de slider em curso; null = nenhum gesto em andamento.
  const baselineRef = useRef<number | null>(null);

  // Gera as miniaturas 1x por imagem (não por render): thumb base derivada do bitmap de preview já
  // carregado (mais barato que reprocessar o blob original) + 1 render offscreen por filtro a 100%.
  useEffect(() => {
    let cancelled = false;
    let renderer: ReturnType<typeof createRenderer> | null = null;
    setOriginalThumb(null);
    setFilterThumbs({});

    (async () => {
      // resizeWidth só (sem resizeHeight): o spec de createImageBitmap deriva a altura mantendo o aspecto.
      const thumbBitmap = await createImageBitmap(image.bitmap, { resizeWidth: THUMB_WIDTH, resizeQuality: 'high' });
      if (cancelled) { thumbBitmap.close(); return; }

      const originalCanvas = document.createElement('canvas');
      originalCanvas.width = thumbBitmap.width;
      originalCanvas.height = thumbBitmap.height;
      originalCanvas.getContext('2d')?.drawImage(thumbBitmap, 0, 0);
      // PNG (não jpeg) pro card "Original": além de sem perdas num thumb tão pequeno, distingue
      // visualmente/por seletor os 2 tipos de miniatura (a original não passou pelo pipeline WebGL).
      setOriginalThumb(originalCanvas.toDataURL('image/png'));

      // renderer offscreen compartilhado (canvas fora da árvore) — descartável, por isso destroy({loseContext:true}).
      const offCanvas = document.createElement('canvas');
      try {
        renderer = createRenderer(offCanvas);
      } catch {
        thumbBitmap.close();
        return; // sem WebGL: fica só com a miniatura "Original"
      }
      renderer.setImage(thumbBitmap); // texImage2D copia os pixels de imediato — seguro fechar já a seguir
      thumbBitmap.close();

      // IMPORTANTE (decisão de design): as miniaturas mostram o filtro PURO, com ajustes/geometria
      // default — não os ajustes atuais do usuário. A miniatura representa o filtro em si, não o
      // resultado final da edição (senão mudaria a cada slider da aba Ajustes, muito custoso).
      for (let i = 0; i < FILTERS.length; i++) {
        if (cancelled) break;
        const f = FILTERS[i];
        renderer.render({
          geometry: DEFAULT_GEOMETRY,
          adjustments: DEFAULT_ADJUSTMENTS,
          filter: { id: f.id, intensity: 100 },
          annotations: [],
          baseVersion: 0,
        });
        const url = offCanvas.toDataURL('image/jpeg', 0.8);
        if (cancelled) break;
        setFilterThumbs((prev) => ({ ...prev, [f.id]: url }));
        if (i % 4 === 3) await new Promise((r) => setTimeout(r)); // libera a UI a cada 4 miniaturas
      }
    })();

    return () => {
      cancelled = true;
      renderer?.destroy({ loseContext: true });
    };
  }, [image]);

  // Tocar num card: Original → filter null; um filtro → sempre volta pra intensidade 100 (mesmo se
  // já era o ativo, ex.: usuário tinha arrastado o slider e toca o card de novo). Só pula o dispatch
  // quando o resultado seria idêntico ao present atual (id+intensity) — sem entrada de histórico duplicada.
  function selectFilter(id: string | null) {
    const current = liveRef.current;
    if (id === null) {
      if (current === null) return;
      liveRef.current = null;
      dispatch({ type: 'set', patch: { filter: null } });
      return;
    }
    if (current?.id === id && current.intensity === 100) return;
    const next: FilterOp = { id, intensity: 100 };
    liveRef.current = next;
    dispatch({ type: 'set', patch: { filter: next } });
  }

  function captureBaseline() {
    if (baselineRef.current !== null || !liveRef.current) return;
    baselineRef.current = liveRef.current.intensity;
  }

  function previewIntensity(value: number) {
    const id = liveRef.current?.id;
    if (!id) return;
    const next: FilterOp = { id, intensity: value };
    liveRef.current = next; // visível pra próxima chamada ANTES do re-render
    dispatch({ type: 'preview', patch: { filter: next } });
  }

  function commitIntensity(value: number) {
    const baseline = baselineRef.current;
    baselineRef.current = null;
    const id = liveRef.current?.id;
    if (!id || baseline === null) return;
    if (baseline === value) return; // gesto sem mudança real: não registra entrada vazia no histórico
    // Mesma técnica do AdjustPanel: 'preview' já reescreveu liveRef/present.filter pro valor arrastado —
    // reverte pro baseline num dispatch de 'preview' ANTES do 'set', senão o histórico empilharia esse
    // MESMO valor (present já mutado), virando um no-op (1º undo não desfaria nada).
    liveRef.current = { id, intensity: baseline };
    dispatch({ type: 'preview', patch: { filter: liveRef.current } });
    const final: FilterOp = { id, intensity: value };
    liveRef.current = final;
    dispatch({ type: 'set', patch: { filter: final } });
  }

  // Gesto interrompido sem soltura normal (pointercancel / blur no meio de um keydown sem keyup):
  // reverte o preview pro baseline e descarta o gesto SEM registrar 'set' (mesmo tratamento do AdjustPanel).
  function cancelGesture() {
    const baseline = baselineRef.current;
    baselineRef.current = null;
    const id = liveRef.current?.id;
    if (baseline === null || !id) return;
    liveRef.current = { id, intensity: baseline };
    dispatch({ type: 'preview', patch: { filter: liveRef.current } });
  }

  const activeId = present.filter?.id ?? null;
  const intensity = present.filter?.intensity ?? 100;

  return (
    <div className="filter-panel">
      <div className="filter-carousel" data-testid="filter-carousel">
        <button
          type="button"
          className={`filter-card${activeId === null ? ' active' : ''}`}
          data-testid="filter-original"
          onClick={() => selectFilter(null)}
        >
          <span className="filter-thumb-wrap">
            {originalThumb ? <img src={originalThumb} alt="" className="filter-thumb" /> : null}
          </span>
          <span className="filter-name">Original</span>
        </button>
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`filter-card${activeId === f.id ? ' active' : ''}`}
            data-testid={`filter-${f.id}`}
            onClick={() => selectFilter(f.id)}
          >
            <span className="filter-thumb-wrap">
              {filterThumbs[f.id] ? <img src={filterThumbs[f.id]} alt="" className="filter-thumb" /> : null}
            </span>
            <span className="filter-name">{f.name}</span>
          </button>
        ))}
      </div>

      {activeId !== null && (
        <div className="slider-row filter-intensity-row" data-testid="filter-intensity-row">
          <div className="slider-row-label">
            <span>Intensidade</span>
            <span>{intensity}</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={intensity}
            data-testid="filter-intensity"
            onPointerDown={captureBaseline}
            onKeyDown={captureBaseline}
            onInput={(e) => previewIntensity(Number(e.currentTarget.value))}
            onPointerUp={(e) => commitIntensity(Number(e.currentTarget.value))}
            onKeyUp={(e) => commitIntensity(Number(e.currentTarget.value))}
            onPointerCancel={cancelGesture}
            onBlur={cancelGesture}
          />
        </div>
      )}
    </div>
  );
}
