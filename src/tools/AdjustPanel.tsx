// src/tools/AdjustPanel.tsx — 9 sliders de ajuste; preview ao arrastar, histórico ao soltar
import { useRef, type Dispatch } from 'react';
import { DEFAULT_ADJUSTMENTS, type Adjustments, type EditAction, type EditSnapshot } from '../state/editStack';

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
  // valor do ajuste ANTES do gesto atual (capturado no pointerdown/keydown, antes de qualquer 'preview').
  const baselineRef = useRef<Partial<Record<keyof Adjustments, number>>>({});

  function captureBaseline(key: keyof Adjustments) {
    if (!(key in baselineRef.current)) baselineRef.current[key] = present.adjustments[key];
  }

  function preview(key: keyof Adjustments, value: number) {
    dispatch({ type: 'preview', patch: { adjustments: { ...present.adjustments, [key]: value } } });
  }

  function commit(key: keyof Adjustments, value: number) {
    const baseline = baselineRef.current[key] ?? present.adjustments[key];
    delete baselineRef.current[key];
    if (baseline === value) return; // gesto sem mudança real: não registra entrada vazia no histórico
    // 'preview' já reescreveu present.adjustments[key] pro valor arrastado — sem reverter aqui, o 'set'
    // abaixo empilharia esse MESMO valor em `past` (present já mutado), virando um no-op: o 1º undo não
    // desfaria nada. React encadeia dispatches síncronos pelo reducer em sequência, então revertendo o
    // present pro baseline ANTES do 'set', o histórico fica correto com 1 dispatch por gesto.
    dispatch({ type: 'preview', patch: { adjustments: { ...present.adjustments, [key]: baseline } } });
    dispatch({ type: 'set', patch: { adjustments: { ...present.adjustments, [key]: value } } });
  }

  function restoreDefaults() {
    dispatch({ type: 'set', patch: { adjustments: { ...DEFAULT_ADJUSTMENTS } } });
  }

  return (
    <div className="adjust-panel">
      {SLIDERS.map(({ key, label, min }) => {
        const value = adjustments[key];
        return (
          <div className="slider-row" key={key}>
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
              onPointerDown={() => captureBaseline(key)}
              onKeyDown={() => captureBaseline(key)}
              onInput={(e) => preview(key, Number(e.currentTarget.value))}
              // Commit só em onPointerUp/onKeyUp (fim do gesto) — NÃO em onChange: pra <input type=range>,
              // o DOM muda o valor por fora do setter JS interceptado pelo React, então o value-tracker do
              // React nunca resincroniza sozinho durante o arraste e onChange acaba disparando a cada
              // tick de "input" (mesma cadência do onInput), não só na soltura. Usar onChange aqui
              // gravaria uma entrada de histórico por tick, exigindo vários undos pra desfazer 1 gesto.
              onPointerUp={(e) => commit(key, Number(e.currentTarget.value))}
              onKeyUp={(e) => commit(key, Number(e.currentTarget.value))}
            />
          </div>
        );
      })}
      <button type="button" className="btn btn-secondary adjust-reset" data-testid="adjust-reset" onClick={restoreDefaults}>
        Restaurar ajustes
      </button>
    </div>
  );
}
