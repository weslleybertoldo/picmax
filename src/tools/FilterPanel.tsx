// src/tools/FilterPanel.tsx — carrossel de filtros: toque aplica 100%, slider ajusta intensidade
import { useEffect, useRef, useState, type Dispatch } from 'react';
import { createRenderer } from '../engine/renderer';
import { FILTERS } from '../engine/filters';
import { DEFAULT_ADJUSTMENTS, DEFAULT_GEOMETRY, type EditAction, type EditSnapshot, type FilterOp } from '../state/editStack';
import type { LoadedImage } from '../io/openImage';
import PresetsPanel from '../presets/PresetsPanel';
import type { EditPreset } from '../presets/presets';
import { useSliderGesture } from './useSliderGesture';

export interface FilterPanelProps {
  present: EditSnapshot;
  dispatch: Dispatch<EditAction>;
  image: LoadedImage;
  onApplyPreset: (preset: EditPreset) => void;
  // bump do Editor pra forçar a seção "Meus modelos" reler o storage sem remontar (ver PresetsPanel).
  presetsVersion: number;
}

const THUMB_WIDTH = 128;

interface ThumbCache { original: string; filters: Record<string, string> }
// Cache module-level (sobrevive ao unmount do FilterPanel) — chave = o próprio ImageBitmap, sem
// segurar referência forte a ele no valor. O Editor desmonta este painel ao trocar de aba (ternário
// de abas), então um useState/useRef comum morreria a cada Ajustes↔Filtros; WeakMap resolve isso
// e ainda invalida sozinho quando o bitmap morre (GC) — troca de foto regenera naturalmente, sem
// precisar limpar a entrada manualmente. Só entra no cache uma geração COMPLETA (ver efeito abaixo) —
// falha ou cancelamento no meio do caminho nunca grava entrada parcial.
const thumbCache = new WeakMap<ImageBitmap, ThumbCache>();

export default function FilterPanel({ present, dispatch, image, onApplyPreset, presetsVersion }: FilterPanelProps) {
  const [originalThumb, setOriginalThumb] = useState<string | null>(null);
  const [filterThumbs, setFilterThumbs] = useState<Record<string, string>>({});
  const [genError, setGenError] = useState(false);
  // incrementado pelo botão "Tentar de novo" pra forçar o efeito de geração a rodar de novo pra
  // MESMA imagem (o efeito só depende de `image`, que não mudou).
  const [retryToken, setRetryToken] = useState(0);
  // Cópia "viva" de present.filter — mesma técnica do AdjustPanel (liveRef): evita que 2 dispatches
  // síncronos no mesmo tick (ex.: cancelGesture seguido de outro toque) leiam um `present` que o React
  // ainda não repropagou. Aqui o "patch" é o objeto filter inteiro (id+intensity), não uma chave.
  const liveRef = useRef(present.filter);
  liveRef.current = present.filter; // resync a cada render (fonte de verdade quando nenhum gesto está em voo)

  // Gera as miniaturas 1x por imagem (não por render, não por remount): thumb base derivada do bitmap
  // de preview já carregado (mais barato que reprocessar o blob original) + 1 render offscreen por
  // filtro a 100%. Cache-hit (revisita da aba) usa o resultado do WeakMap direto — zero createRenderer,
  // zero toDataURL. Qualquer exceção no meio (createImageBitmap/setImage/toDataURL, ex.: canvas sem
  // memória, WebGL indisponível) cai no catch: mostra erro visível no carrossel em vez de deixar
  // cards vazios pra sempre (a promise da IIFE nunca era esperada por ninguém — sem o catch, virava
  // unhandled rejection e o usuário via só um carrossel quebrado, sem explicação nem saída).
  useEffect(() => {
    const cached = thumbCache.get(image.bitmap);
    if (cached) {
      setOriginalThumb(cached.original);
      setFilterThumbs(cached.filters);
      setGenError(false);
      return; // já em cache: nada a gerar, nada a destruir no cleanup (nenhum renderer foi criado)
    }

    let cancelled = false;
    let renderer: ReturnType<typeof createRenderer> | null = null;
    setOriginalThumb(null);
    setFilterThumbs({});
    setGenError(false);

    (async () => {
      let thumbBitmap: ImageBitmap | null = null;
      try {
        // resizeWidth só (sem resizeHeight): o spec de createImageBitmap deriva a altura mantendo o aspecto.
        thumbBitmap = await createImageBitmap(image.bitmap, { resizeWidth: THUMB_WIDTH, resizeQuality: 'high' });
        if (cancelled) return;

        const originalCanvas = document.createElement('canvas');
        originalCanvas.width = thumbBitmap.width;
        originalCanvas.height = thumbBitmap.height;
        originalCanvas.getContext('2d')?.drawImage(thumbBitmap, 0, 0);
        // PNG (não jpeg) pro card "Original": além de sem perdas num thumb tão pequeno, distingue
        // visualmente/por seletor os 2 tipos de miniatura (a original não passou pelo pipeline WebGL).
        const originalUrl = originalCanvas.toDataURL('image/png');
        if (cancelled) return;
        setOriginalThumb(originalUrl);

        // renderer offscreen compartilhado (canvas fora da árvore) — descartável, por isso destroy() no finally.
        const offCanvas = document.createElement('canvas');
        renderer = createRenderer(offCanvas); // pode lançar (sem WebGL) — cai no catch de fora
        renderer.setImage(thumbBitmap);

        // IMPORTANTE (decisão de design): as miniaturas mostram o filtro PURO, com ajustes/geometria
        // default — não os ajustes atuais do usuário. A miniatura representa o filtro em si, não o
        // resultado final da edição (senão mudaria a cada slider da aba Ajustes, muito custoso).
        const filters: Record<string, string> = {};
        for (let i = 0; i < FILTERS.length; i++) {
          if (cancelled) break;
          const f = FILTERS[i];
          renderer.render({
            geometry: DEFAULT_GEOMETRY,
            adjustments: DEFAULT_ADJUSTMENTS,
            filter: { id: f.id, intensity: 100 },
            annotations: [],
            baseVersion: 0,
            autoEnhance: null,
          });
          const url = offCanvas.toDataURL('image/jpeg', 0.8);
          if (cancelled) break;
          filters[f.id] = url;
          setFilterThumbs((prev) => ({ ...prev, [f.id]: url }));
          if (i % 4 === 3) await new Promise((r) => setTimeout(r)); // libera a UI a cada 4 miniaturas
        }
        // só grava no cache se completou as 20 sem interrupção — cancelado no meio (troca de foto antes
        // de terminar) não deixa entrada parcial; a próxima montagem pra essa imagem gera tudo de novo.
        if (!cancelled) thumbCache.set(image.bitmap, { original: originalUrl, filters });
      } catch (err) {
        if (!cancelled) {
          console.error('[FilterPanel] falha ao gerar miniaturas:', err);
          setGenError(true);
        }
      } finally {
        thumbBitmap?.close(); // close() é idempotente (no-op se já fechado) — seguro mesmo já tendo sido chamado antes
        renderer?.destroy({ loseContext: true }); // destrói já ao terminar a geração, não só no cleanup do efeito
        renderer = null;
      }
    })();

    return () => {
      cancelled = true;
      renderer?.destroy({ loseContext: true }); // cobre o caso de unmount/troca de imagem NO MEIO da geração
    };
  }, [image, retryToken]);

  function retryGeneration() {
    thumbCache.delete(image.bitmap); // defensivo: geração falha nunca grava, mas garante que um retry nunca reusa lixo
    setGenError(false);
    setRetryToken((n) => n + 1);
  }

  const gesture = useSliderGesture<string>({
    getCurrent: () => (liveRef.current ? { target: liveRef.current.id, value: liveRef.current.intensity } : null),
    onPreview: (value) => {
      const id = liveRef.current?.id;
      if (!id) return;
      const next: FilterOp = { id, intensity: value };
      liveRef.current = next; // visível pra próxima chamada ANTES do re-render
      dispatch({ type: 'preview', patch: { filter: next } });
    },
    onSet: (value) => {
      const id = liveRef.current?.id;
      if (!id) return;
      const next: FilterOp = { id, intensity: value };
      liveRef.current = next;
      dispatch({ type: 'set', patch: { filter: next } });
    },
  });

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

  const activeId = present.filter?.id ?? null;
  const intensity = present.filter?.intensity ?? 100;

  return (
    <div className="filter-panel">
      {/* Seção "Meus modelos" (T11): some por completo quando não há modelos salvos (sem emptyMessage
          — ver PresetsPanel). Tocar num card aplica adjustments+filter do modelo (1 entrada de
          histórico, desfazível) — crop/anotações/base da IA nunca fazem parte do modelo. */}
      <PresetsPanel variant="inline" title="Meus modelos" onApply={onApplyPreset} refreshKey={presetsVersion} />

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

      {genError && (
        <div className="filter-error" data-testid="filter-thumbs-error">
          <span>Falha ao gerar miniaturas</span>
          <button type="button" className="btn btn-secondary" data-testid="filter-thumbs-retry" onClick={retryGeneration}>
            Tentar de novo
          </button>
        </div>
      )}

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
            onPointerDown={gesture.captureBaseline}
            onKeyDown={gesture.captureBaseline}
            onInput={(e) => gesture.preview(Number(e.currentTarget.value))}
            onPointerUp={(e) => gesture.commit(Number(e.currentTarget.value))}
            onKeyUp={(e) => gesture.commit(Number(e.currentTarget.value))}
            onPointerCancel={gesture.cancelGesture}
            onBlur={gesture.cancelGesture}
          />
        </div>
      )}
    </div>
  );
}
