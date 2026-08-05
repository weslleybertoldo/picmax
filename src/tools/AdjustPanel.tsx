// src/tools/AdjustPanel.tsx — v1.1: carrossel horizontal de chips (um por ajuste, estilo
// Instagram/Lightroom) + UM slider abaixo controlando o chip ativo. Tocar no chip ativo de novo
// recolhe o slider. Chip com valor ≠ 0 ganha dot + valor pequeno. Substitui a lista vertical de
// 9 sliders da v1.0 (mesma coreografia de gesto: useSliderGesture, preview/commit/cancel).
import { useRef, useState, type Dispatch } from 'react';
import { DEFAULT_ADJUSTMENTS, type Adjustments, type EditAction, type EditSnapshot } from '../state/editStack';
import { useSliderGesture } from './useSliderGesture';

export interface AdjustPanelProps {
  present: EditSnapshot;
  dispatch: Dispatch<EditAction>;
}

interface ChipDef {
  key: keyof Adjustments;
  label: string;
  min: number;
}

const CHIPS: ChipDef[] = [
  { key: 'brightness', label: 'Brilho', min: -100 },
  { key: 'contrast', label: 'Contraste', min: -100 },
  { key: 'saturation', label: 'Saturação', min: -100 },
  { key: 'exposure', label: 'Exposição', min: -100 },
  { key: 'temperature', label: 'Temperatura', min: -100 },
  { key: 'shadows', label: 'Sombras', min: -100 },
  { key: 'highlights', label: 'Realces', min: -100 },
  { key: 'sharpness', label: 'Nitidez', min: 0 },
  { key: 'vignette', label: 'Vinheta', min: 0 },
];

export default function AdjustPanel({ present, dispatch }: AdjustPanelProps) {
  const adjustments = present.adjustments;
  // Chip ativo (null = nenhum slider aberto). Estado LOCAL do painel (não vai pro histórico):
  // trocar de aba e voltar recolhe o slider — comportamento aceitável e mais simples.
  const [activeKey, setActiveKey] = useState<keyof Adjustments | null>(null);

  // Cópia "viva" de present.adjustments, atualizada de forma SÍNCRONA a cada dispatch — herdada da
  // v1.0 (ver useSliderGesture.ts): mesmo com UM slider só, o alvo pode trocar no meio de um arraste
  // (outro dedo toca outro chip), e preview/commit precisam ler o valor mais atual, não a closure da
  // render em que o gesto começou.
  const liveRef = useRef(present.adjustments);
  liveRef.current = present.adjustments; // resync a cada render (fonte de verdade sem gesto em voo)
  // Ref do chip ativo pelo MESMO motivo: getCurrent() do gesto roda em eventos assíncronos
  // (pointerup chega renders depois do pointerdown) e precisa do alvo ATUAL — se o usuário trocou de
  // chip no meio do arraste, o commit do gesto antigo é descartado pela checagem de alvo do hook.
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;

  const gesture = useSliderGesture<keyof Adjustments>({
    getCurrent: () => {
      const key = activeKeyRef.current;
      return key ? { target: key, value: liveRef.current[key] } : null;
    },
    onPreview: (v) => {
      const key = activeKeyRef.current;
      if (!key) return;
      const next = { ...liveRef.current, [key]: v };
      liveRef.current = next; // visível pra próxima chamada ANTES do re-render
      dispatch({ type: 'preview', patch: { adjustments: next } });
    },
    onSet: (v) => {
      const key = activeKeyRef.current;
      if (!key) return;
      const next = { ...liveRef.current, [key]: v };
      liveRef.current = next;
      dispatch({ type: 'set', patch: { adjustments: next } });
    },
  });

  function toggleChip(key: keyof Adjustments) {
    setActiveKey((current) => (current === key ? null : key));
  }

  function restoreDefaults() {
    liveRef.current = { ...DEFAULT_ADJUSTMENTS };
    dispatch({ type: 'set', patch: { adjustments: liveRef.current } });
  }

  const active = activeKey ? (CHIPS.find((c) => c.key === activeKey) ?? null) : null;
  // Math.round na EXIBIÇÃO (chips e slider): snapshots antigos podem carregar frações (ex.: um
  // auto-ajuste aplicado por versão anterior ao arredondamento em computeAutoEnhance) — a UI nunca
  // mostra decimais; o slider (step 1) commita sempre inteiro.
  const activeValue = active ? Math.round(adjustments[active.key]) : 0;

  return (
    <div className="adjust-panel">
      <div className="adjust-carousel" data-testid="adjust-carousel">
        {CHIPS.map((def) => {
          const value = Math.round(adjustments[def.key]);
          return (
            <button
              key={def.key}
              type="button"
              className={`adjust-chip${activeKey === def.key ? ' active' : ''}`}
              data-testid={`adjust-chip-${def.key}`}
              onClick={() => toggleChip(def.key)}
            >
              <span className="adjust-chip-label">{def.label}</span>
              {value !== 0 && (
                <span className="adjust-chip-value" data-testid={`adjust-chip-value-${def.key}`}>
                  {value}
                </span>
              )}
              {value !== 0 && <span className="adjust-chip-dot" aria-hidden="true" />}
            </button>
          );
        })}
      </div>

      {active && (
        <div className="slider-row adjust-slider-row" data-testid="adjust-slider-row">
          <div className="slider-row-label">
            <span>{active.label}</span>
            <span>{activeValue}</span>
          </div>
          <input
            type="range"
            min={active.min}
            max={100}
            step={1}
            value={activeValue}
            data-testid={`adjust-${active.key}`}
            onPointerDown={gesture.captureBaseline}
            onKeyDown={gesture.captureBaseline}
            onInput={(e) => gesture.preview(Number(e.currentTarget.value))}
            // Commit só em onPointerUp/onKeyUp (fim do gesto) — NÃO em onChange: pra <input type=range>,
            // o DOM muda o valor por fora do setter JS interceptado pelo React, então o value-tracker do
            // React nunca resincroniza sozinho durante o arraste e onChange acaba disparando a cada
            // tick de "input" (mesma cadência do onInput), não só na soltura. Usar onChange aqui
            // gravaria uma entrada de histórico por tick, exigindo vários undos pra desfazer 1 gesto.
            onPointerUp={(e) => gesture.commit(Number(e.currentTarget.value))}
            onKeyUp={(e) => gesture.commit(Number(e.currentTarget.value))}
            onPointerCancel={gesture.cancelGesture}
            onBlur={gesture.cancelGesture}
          />
        </div>
      )}

      <button type="button" className="btn btn-secondary adjust-reset" data-testid="adjust-reset" onClick={restoreDefaults}>
        Restaurar ajustes
      </button>
    </div>
  );
}
