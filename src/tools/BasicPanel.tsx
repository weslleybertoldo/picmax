// src/tools/BasicPanel.tsx — girar 90°, espelhar H/V, endireitar e entrar no modo Cortar (o overlay
// em si vive em CropOverlay.tsx / Editor.tsx). Os chips de Redimensionar saíram na v1.1: a escolha
// de resolução MIGROU pro modal do Exportar/Compartilhar (fonte única do conceito — ver Editor.tsx),
// que mostra as dimensões reais de saída por opção em vez de um chip fixo desconectado do resultado.
import { useRef, type Dispatch } from 'react';
import { mirrorCropRect, rotateCropRect90, type EditAction, type EditSnapshot, type Geometry } from '../state/editStack';
import { useSliderGesture } from './useSliderGesture';

export interface BasicPanelProps {
  present: EditSnapshot;
  dispatch: Dispatch<EditAction>;
  onEnterCrop: () => void;
  // liga/desliga a grade 3x3 sobre o canvas enquanto o slider Endireitar está sendo arrastado
  // (renderizada pelo Editor, que tem acesso ao canvas — ver StraightenGrid em Editor.tsx).
  onStraightenDragChange: (dragging: boolean) => void;
}

// Guarda de anotações: qualquer mudança de GEOMETRIA com anotações ativas limpa `annotations` (após
// confirmação) — decisão v1 UNIFORME (T7 revisita a decisão inicial da T6, que só cobria Cortar/Girar
// 90°). Cortar/Girar 90° mudam o FRAME (aspecto/orientação) e as coordenadas de anotação são frações
// do frame FINAL pós-geometria — sem realinhamento elas ficariam deslocadas/erradas (motivo original
// da T6). Espelhar H/V e o COMMIT do Endireitar não mudam o aspecto do frame, mas REAMOSTRAM o
// conteúdo dentro dele (frame fixo, conteúdo espelha/inclina) — uma anotação desenhada sobre um
// detalhe da foto passaria a apontar pra um pedaço DIFERENTE da imagem depois do espelho/endireitar,
// mesmo com a mesma fração x,y. Por simplicidade (v1), a regra é igual pras 4 ações em vez de
// recalcular a posição da anotação sob cada transformação — usuário reanota depois de ajustar a
// geometria.
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
    const g = liveRef.current;
    // Bug crítico do spec review: girar 90° com um crop ativo, SEM transformar o crop, mantinha as
    // mesmas frações — que passam a selecionar uma região visual DIFERENTE (o conteúdo girou, o
    // retângulo fixo não acompanhou). rotateCropRect90 reaplica o MESMO giro no retângulo, em frações,
    // pra preservar a região visual (ver derivação/prova em state/editStack.ts).
    // 2ª rodada de review: flip e rotação não comutam — com exatamente 1 flip ativo (H xor V) o giro
    // do retângulo precisa ser o INVERSO. flipH/flipV não mudam neste botão (só rotate90 muda), então
    // a paridade usada é simplesmente o XOR dos dois flips atuais.
    const flipParityOdd = g.flipH !== g.flipV;
    const next: Geometry = {
      ...g,
      rotate90: ((g.rotate90 + 1) % 4) as 0 | 1 | 2 | 3,
      crop: g.crop ? rotateCropRect90(g.crop, flipParityOdd) : null,
    };
    commitGeometry(next, hasAnnotations);
  }

  function toggleFlip(axis: 'flipH' | 'flipV') {
    // Guarda de anotações (T7): espelhar reamostra o CONTEÚDO sob o frame fixo — ver
    // confirmDiscardAnnotations acima. Cancelar aborta sem tocar em `geometry`.
    const hasAnnotations = present.annotations.length > 0;
    if (hasAnnotations && !confirmDiscardAnnotations()) return;
    const g = liveRef.current;
    // Achado durante a validação do fix de rotate90+flip: espelhar SOZINHO, com um crop ativo, já
    // corrompia a seleção (o flip espelha em torno do centro do FRAME cheio, não do centro do próprio
    // retângulo de crop — ver prova/derivação em state/editStack.ts). mirrorCropRect mantém a região
    // visual: Espelhar H mirra crop.x, Espelhar V mirra crop.y (regra igual pra qualquer rotate90 atual).
    // 3ª rodada de review: flip e straighten (Endireitar) TAMBÉM não comutam (F·S(θ) = S(−θ)·F) — com
    // straighten≠0, espelhar sem negar o ângulo corrompia o crop (fuzz do reviewer: 26176/29511
    // sequências falhando, replicado em scripts/verify-geometry.mjs). Negar `straighten` no MESMO
    // dispatch fecha a comutação — e é a UX correta: espelhar a foto espelha a inclinação do
    // horizonte junto (rodar scripts/verify-geometry.mjs valida isso pra todas as sequências).
    const next: Geometry = {
      ...g,
      [axis]: !g[axis],
      crop: g.crop ? mirrorCropRect(g.crop, axis === 'flipH' ? 'x' : 'y') : null,
      straighten: -g.straighten,
    };
    commitGeometry(next, hasAnnotations);
  }

  const straightenGesture = useSliderGesture<'straighten'>({
    getCurrent: () => ({ target: 'straighten', value: liveRef.current.straighten }),
    onPreview: (v) => {
      const next = { ...liveRef.current, straighten: v };
      liveRef.current = next;
      dispatch({ type: 'preview', patch: { geometry: next } });
    },
    onSet: (v) => {
      // Guarda de anotações (T7): o COMMIT do Endireitar reamostra o conteúdo sob o frame fixo — ver
      // confirmDiscardAnnotations acima. Cancelar aqui NÃO precisa reverter manualmente: `commit()` do
      // useSliderGesture (ver useSliderGesture.ts) já chamou onPreview(baseline.value) IMEDIATAMENTE
      // antes deste onSet, então abortar sem dispatch deixa `geometry.straighten` exatamente no
      // baseline (o valor antes do arraste).
      const hasAnnotations = present.annotations.length > 0;
      if (hasAnnotations && !confirmDiscardAnnotations()) return;
      const next = { ...liveRef.current, straighten: v };
      liveRef.current = next;
      dispatch({ type: 'set', patch: hasAnnotations ? { geometry: next, annotations: [] } : { geometry: next } });
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

    </div>
  );
}
