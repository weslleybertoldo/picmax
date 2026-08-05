// src/tools/AdjustPanel.tsx — 9 sliders de ajuste; preview ao arrastar, histórico ao soltar
import { useRef, type Dispatch, type RefObject } from 'react';
import { DEFAULT_ADJUSTMENTS, type Adjustments, type EditAction, type EditSnapshot } from '../state/editStack';
import { useSliderGesture } from './useSliderGesture';

export interface AdjustPanelProps {
  present: EditSnapshot;
  dispatch: Dispatch<EditAction>;
}

interface SliderDef {
  key: keyof Adjustments;
  label: string;
  min: number;
}

const SLIDERS: SliderDef[] = [
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
  // Cópia "viva" de present.adjustments, atualizada de forma SÍNCRONA a cada dispatch — evita a race
  // de 2 sliders arrastados por dedos diferentes no mesmo tick: como React só propaga a nova `present`
  // no próximo render, se preview()/commit() lessem direto da prop `present.adjustments` (closure da
  // render atual), o 2º dispatch do MESMO tick recomporia o patch a partir de um snapshot que ainda não
  // viu o 1º dispatch — e como 'preview'/'set' substituem `adjustments` por inteiro (não fazem merge
  // profundo), o 2º dispatch reverteria silenciosamente o valor do 1º. liveRef sempre reflete o último
  // patch já enviado, mesmo antes do re-render. Compartilhado entre os 9 <AdjustSliderRow> (cada um
  // tem sua PRÓPRIA instância de useSliderGesture/baseline — ver useSliderGesture.ts — mas todos leem
  // e escrevem o MESMO liveRef, por isso ele vive aqui no pai, não dentro do hook).
  const liveRef = useRef(present.adjustments);
  liveRef.current = present.adjustments; // resync a cada render (fonte de verdade quando NENHUM gesto está em voo)

  function restoreDefaults() {
    liveRef.current = { ...DEFAULT_ADJUSTMENTS };
    dispatch({ type: 'set', patch: { adjustments: liveRef.current } });
  }

  return (
    <div className="adjust-panel">
      {SLIDERS.map((def) => (
        <AdjustSliderRow key={def.key} def={def} value={adjustments[def.key]} liveRef={liveRef} dispatch={dispatch} />
      ))}
      <button type="button" className="btn btn-secondary adjust-reset" data-testid="adjust-reset" onClick={restoreDefaults}>
        Restaurar ajustes
      </button>
    </div>
  );
}

interface AdjustSliderRowProps {
  def: SliderDef;
  value: number;
  liveRef: RefObject<Adjustments>;
  dispatch: Dispatch<EditAction>;
}

function AdjustSliderRow({ def, value, liveRef, dispatch }: AdjustSliderRowProps) {
  const { key, label, min } = def;
  const gesture = useSliderGesture<keyof Adjustments>({
    getCurrent: () => ({ target: key, value: liveRef.current[key] }),
    onPreview: (v) => {
      const next = { ...liveRef.current, [key]: v };
      liveRef.current = next; // visível pra próxima chamada ANTES do re-render
      dispatch({ type: 'preview', patch: { adjustments: next } });
    },
    onSet: (v) => {
      const next = { ...liveRef.current, [key]: v };
      liveRef.current = next;
      dispatch({ type: 'set', patch: { adjustments: next } });
    },
  });

  return (
    <div className="slider-row">
      <div className="slider-row-label">
        <span>{label}</span>
        <span>{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={100}
        step={1}
        value={value}
        data-testid={`adjust-${key}`}
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
  );
}
