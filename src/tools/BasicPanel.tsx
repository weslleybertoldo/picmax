// src/tools/BasicPanel.tsx — girar 90°, espelhar H/V, endireitar, redimensionar (export) e entrar no
// modo Cortar (o overlay em si vive em CropOverlay.tsx / Editor.tsx).
import { useRef, type Dispatch } from 'react';
import type { EditAction, EditSnapshot, Geometry } from '../state/editStack';
import { useSliderGesture } from './useSliderGesture';

export interface BasicPanelProps {
  present: EditSnapshot;
  dispatch: Dispatch<EditAction>;
  onEnterCrop: () => void;
  // liga/desliga a grade 3x3 sobre o canvas enquanto o slider Endireitar está sendo arrastado
  // (renderizada pelo Editor, que tem acesso ao canvas — ver StraightenGrid em Editor.tsx).
  onStraightenDragChange: (dragging: boolean) => void;
}

const RESIZE_CHIPS: Array<{ label: string; value: number | null; testId: string }> = [
  { label: 'Original', value: null, testId: 'original' },
  { label: '2048px', value: 2048, testId: '2048' },
  { label: '1080px', value: 1080, testId: '1080' },
];

// Guarda de anotações (spec T6): Cortar/Girar 90° mudam o FRAME (aspecto/orientação), e as
// coordenadas de anotação são frações do frame FINAL pós-geometria — sem realinhamento elas ficariam
// deslocadas/erradas. Espelhar e Endireitar NÃO mudam o formato/aspecto do frame (só reamostram
// dentro dele), então não disparam a guarda — decisão v1 documentada aqui e no plano da T6.
// Anotações só existem a partir da T7; o guard já fica pronto e é validado com annotations injetadas
// via hook de dev (ver Editor.tsx, import.meta.env.DEV).
function confirmDiscardAnnotations(): boolean {
  return window.confirm('As anotações serão removidas. Continuar?');
}

export default function BasicPanel({ present, dispatch, onEnterCrop, onStraightenDragChange }: BasicPanelProps) {
  const geometry = present.geometry;
  // liveRef: mesma técnica do AdjustPanel/FilterPanel — fonte de verdade síncrona pra não perder um
  // clique/gesto que aconteça antes do React repropagar `present` (ver useSliderGesture.ts).
  const liveRef = useRef(present.geometry);
  liveRef.current = present.geometry;

  function commitGeometry(next: Geometry, clearAnnotations: boolean) {
    liveRef.current = next;
    dispatch({ type: 'set', patch: clearAnnotations ? { geometry: next, annotations: [] } : { geometry: next } });
  }

  function handleRotate90() {
    const hasAnnotations = present.annotations.length > 0;
    if (hasAnnotations && !confirmDiscardAnnotations()) return; // usuário cancelou: aborta sem dispatch
    const next: Geometry = { ...liveRef.current, rotate90: ((liveRef.current.rotate90 + 1) % 4) as 0 | 1 | 2 | 3 };
    commitGeometry(next, hasAnnotations);
  }

  function toggleFlip(axis: 'flipH' | 'flipV') {
    const next: Geometry = { ...liveRef.current, [axis]: !liveRef.current[axis] };
    commitGeometry(next, false);
  }

  function setResize(value: number | null) {
    const next: Geometry = { ...liveRef.current, resizeMaxSide: value };
    commitGeometry(next, false);
  }

  const straightenGesture = useSliderGesture<'straighten'>({
    getCurrent: () => ({ target: 'straighten', value: liveRef.current.straighten }),
    onPreview: (v) => {
      const next = { ...liveRef.current, straighten: v };
      liveRef.current = next;
      dispatch({ type: 'preview', patch: { geometry: next } });
    },
    onSet: (v) => {
      const next = { ...liveRef.current, straighten: v };
      liveRef.current = next;
      dispatch({ type: 'set', patch: { geometry: next } });
    },
  });

  function startStraighten() {
    onStraightenDragChange(true);
    straightenGesture.captureBaseline();
  }
  function endStraighten(value: number) {
    onStraightenDragChange(false);
    straightenGesture.commit(value);
  }
  function cancelStraighten() {
    onStraightenDragChange(false);
    straightenGesture.cancelGesture();
  }

  return (
    <div className="basic-panel">
      <div className="basic-actions">
        <button type="button" className="btn btn-secondary" data-testid="basic-rotate90" onClick={handleRotate90}>
          ↻ Girar 90°
        </button>
        <button
          type="button"
          className={`btn btn-secondary${geometry.flipH ? ' active' : ''}`}
          data-testid="basic-fliph"
          onClick={() => toggleFlip('flipH')}
        >
          ⇋ Espelhar H
        </button>
        <button
          type="button"
          className={`btn btn-secondary${geometry.flipV ? ' active' : ''}`}
          data-testid="basic-flipv"
          onClick={() => toggleFlip('flipV')}
        >
          ⇵ Espelhar V
        </button>
        <button type="button" className="btn btn-secondary" data-testid="basic-crop" onClick={onEnterCrop}>
          ⬚ Cortar
        </button>
      </div>

      <div className="slider-row" data-testid="basic-straighten-row">
        <div className="slider-row-label">
          <span>Endireitar</span>
          <span>{geometry.straighten}°</span>
        </div>
        <input
          type="range"
          min={-45}
          max={45}
          step={0.5}
          value={geometry.straighten}
          data-testid="basic-straighten"
          onPointerDown={startStraighten}
          onKeyDown={startStraighten}
          onInput={(e) => straightenGesture.preview(Number(e.currentTarget.value))}
          onPointerUp={(e) => endStraighten(Number(e.currentTarget.value))}
          onKeyUp={(e) => endStraighten(Number(e.currentTarget.value))}
          onPointerCancel={cancelStraighten}
          onBlur={cancelStraighten}
        />
      </div>

      <div className="basic-resize" data-testid="basic-resize-row">
        <div className="slider-row-label">
          <span>Redimensionar</span>
        </div>
        <div className="basic-resize-chips">
          {RESIZE_CHIPS.map((chip) => (
            <button
              key={chip.testId}
              type="button"
              className={`btn btn-secondary basic-chip${geometry.resizeMaxSide === chip.value ? ' active' : ''}`}
              data-testid={`basic-resize-${chip.testId}`}
              onClick={() => setResize(chip.value)}
            >
              {chip.label}
            </button>
          ))}
        </div>
        <p className="basic-resize-hint">Aplicado ao salvar</p>
      </div>
    </div>
  );
}
