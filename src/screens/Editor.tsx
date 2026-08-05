// src/screens/Editor.tsx — shell do editor: canvas WebGL + toolbar de abas (Básico, Ajustes e Filtros
// funcionais) + overlay de crop / grade de endireitar sobre o canvas
import { useEffect, useMemo, useReducer, useRef, useState, type RefObject } from 'react';
import { createRenderer, type Renderer } from '../engine/renderer';
import { editReducer, initialSnapshot, type CropRect, type EditAction, type EditSnapshot } from '../state/editStack';
import type { LoadedImage } from '../io/openImage';
import BasicPanel from '../tools/BasicPanel';
import CropOverlay from '../tools/CropOverlay';
import { useCanvasBox } from '../tools/canvasGeometry';
import AdjustPanel from '../tools/AdjustPanel';
import FilterPanel from '../tools/FilterPanel';
import AnnotatePanel from '../tools/AnnotatePanel';
import AnnotationCanvas, { DEFAULT_ANNOTATE_COLOR, DEFAULT_ANNOTATE_SIZE, type AnnotateTool } from '../annotate/AnnotationCanvas';

export interface EditorProps {
  image: LoadedImage;
  onBack: () => void;
}

type TabId = 'basico' | 'ajustes' | 'filtros' | 'anotar' | 'melhorar';
const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'basico', label: 'Básico' },
  { id: 'ajustes', label: 'Ajustes' },
  { id: 'filtros', label: 'Filtros' },
  { id: 'anotar', label: 'Anotar' },
  { id: 'melhorar', label: 'Melhorar' },
];

// Grade 3x3 sobreposta ao canvas enquanto o slider Endireitar do BasicPanel está sendo arrastado (some
// ao soltar) — mesmo cálculo de box do CropOverlay (o canvas é sempre proporcional ao frame; ver
// comentário no topo de CropOverlay.tsx). `pointer-events:none`: é só um guia visual, nunca captura o
// gesto do slider (que está em outro elemento, no painel abaixo do canvas).
function StraightenGrid({
  canvasRef,
  containerRef,
}: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  const box = useCanvasBox(canvasRef, containerRef);
  if (!box) return null;
  return (
    <div
      className="straighten-grid"
      data-testid="straighten-grid"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
    >
      <div className="straighten-grid-line straighten-grid-v1" />
      <div className="straighten-grid-line straighten-grid-v2" />
      <div className="straighten-grid-line straighten-grid-h1" />
      <div className="straighten-grid-line straighten-grid-h2" />
    </div>
  );
}

export default function Editor({ image, onBack }: EditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const [history, dispatch] = useReducer(editReducer, undefined, () => ({
    past: [],
    present: initialSnapshot(),
    future: [],
  }));
  const [activeTab, setActiveTab] = useState<TabId>('ajustes');
  const [engineError, setEngineError] = useState<string | null>(null);
  // Modo Cortar (T6): substitui a toolbar de abas por Cancelar/Aplicar e trava undo/redo enquanto ativo.
  const [cropMode, setCropMode] = useState(false);
  // Grade 3x3 visível só durante o arraste do slider Endireitar (ver StraightenGrid acima).
  const [showStraightenGrid, setShowStraightenGrid] = useState(false);
  // Estado da ferramenta de anotação (T7): levantado pro Editor porque AnnotatePanel (controla) e
  // AnnotationCanvas (lê, pra saber o que desenhar no próximo gesto) são componentes-irmãos — mesmo
  // padrão de cropMode/showStraightenGrid acima. `null` = nenhuma ferramenta ativa (overlay não
  // captura pointer). color/size são estado LOCAL da ferramenta (NÃO vão pro EditSnapshot/histórico —
  // ver comentário no slider de espessura em AnnotatePanel.tsx).
  const [annotateTool, setAnnotateTool] = useState<AnnotateTool | null>(null);
  const [annotateColor, setAnnotateColor] = useState(DEFAULT_ANNOTATE_COLOR);
  const [annotateSize, setAnnotateSize] = useState(DEFAULT_ANNOTATE_SIZE);

  // Hook de dev (T6, só em build DEV — tree-shaken em produção via import.meta.env.DEV): permite
  // injetar `annotations` fake por fora da UI (T7 ainda não existe) pra validar a guarda de
  // "anotações serão removidas" em Girar 90°/Aplicar crop, sem precisar da aba Anotar já implementada.
  // Mesmo padrão de "só em dev" já usado no botão de imagem de teste (Home.tsx). Em useEffect (spec
  // review, item 3): atribuir a `window` é um efeito colateral e não deve rodar durante o render
  // (StrictMode chama a função de render 2x em dev só pra detectar impurezas — a atribuição em si é
  // idempotente, mas o lugar correto pra side effect é useEffect, não o corpo do componente).
  // `dispatch` de useReducer é estável entre renders, então o efeito roda 1x por montagem.
  useEffect(() => {
    if (import.meta.env.DEV) {
      (window as unknown as { __picmaxDispatch?: (action: EditAction) => void }).__picmaxDispatch = dispatch;
    }
  }, [dispatch]);

  // Cria o renderer 1x por imagem montada. destroy() sem opts (loseContext=false) — StrictMode roda
  // setup→cleanup→setup no MESMO <canvas> em dev, e um contexto perdido inviabilizaria o 2º setup.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: Renderer | null = null;
    try {
      renderer = createRenderer(canvas);
      rendererRef.current = renderer;
      renderer.setImage(image.bitmap);
      setEngineError(null);
    } catch (e) {
      setEngineError(e instanceof Error ? e.message : 'Não foi possível abrir esta imagem no editor.');
    }
    return () => {
      renderer?.destroy();
      rendererRef.current = null;
    };
  }, [image]);

  // Enquanto no modo Cortar, renderiza o snapshot SEM o crop atual — o overlay sempre opera sobre o
  // frame ÍNTEGRO (pós rotate90/flip/straighten), permitindo reexpandir uma área já recortada (ver
  // comentário no topo de CropOverlay.tsx). Fora do modo Cortar, renderiza `history.present` normalmente.
  // useMemo (não um const recomputado toda render): fora do modo crop, mantém a MESMA referência de
  // `history.present` entre renders não relacionados — senão o efeito de render abaixo disparia um rAF
  // a cada render do Editor (ex.: qualquer state local mudando), não só quando o snapshot muda de fato.
  const displaySnapshot: EditSnapshot = useMemo(
    () => (cropMode ? { ...history.present, geometry: { ...history.present.geometry, crop: null } } : history.present),
    [cropMode, history.present],
  );

  // Render coalescido com rAF: se o snapshot exibido mudar de novo antes do frame disparar, o cleanup
  // cancela o rAF pendente e agenda um novo — nunca desenha um snapshot já obsoleto.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const raf = requestAnimationFrame(() => renderer.render(displaySnapshot));
    return () => cancelAnimationFrame(raf);
  }, [displaySnapshot]);

  function handleCropApply(crop: CropRect) {
    const patch: Partial<EditSnapshot> = { geometry: { ...history.present.geometry, crop } };
    if (history.present.annotations.length > 0) {
      if (!window.confirm('As anotações serão removidas. Continuar?')) return; // cancelou: aborta, segue no modo crop
      patch.annotations = [];
    }
    dispatch({ type: 'set', patch });
    setCropMode(false);
  }

  return (
    <div className="editor">
      <div className="editor-topbar">
        <button type="button" className="btn btn-icon" data-testid="back" aria-label="Voltar" onClick={onBack}>
          ←
        </button>
        <button
          type="button"
          className="btn btn-icon"
          data-testid="undo"
          aria-label="Desfazer"
          disabled={cropMode || history.past.length === 0}
          onClick={() => dispatch({ type: 'undo' })}
        >
          ↶
        </button>
        <button
          type="button"
          className="btn btn-icon"
          data-testid="redo"
          aria-label="Refazer"
          disabled={cropMode || history.future.length === 0}
          onClick={() => dispatch({ type: 'redo' })}
        >
          ↷
        </button>
        <div className="editor-topbar-spacer" />
      </div>

      <div className="editor-canvas-wrap" ref={canvasWrapRef}>
        {engineError && (
          <p className="editor-error" data-testid="engine-error">
            {engineError}
          </p>
        )}
        <canvas ref={canvasRef} className="editor-canvas" data-testid="canvas" />
        {showStraightenGrid && <StraightenGrid canvasRef={canvasRef} containerRef={canvasWrapRef} />}
        {/* Camada de anotações: visível em TODAS as abas (anotações fazem parte da edição), mas só
            captura pointer na aba Anotar com uma ferramenta ativa. Desmontada inteira no modo Cortar
            (quality review): enquanto cropMode está ativo, `displaySnapshot` renderiza o frame com
            geometry.crop=null (ver comentário acima) — um frame DIFERENTE do frame final em que as
            frações das anotações foram desenhadas. Deixar a camada montada nesse momento mostrava as
            anotações deslocadas/fora de escala (glitch visual real, achado no quality review) até o
            usuário sair do modo Cortar. Cortar/Aplicar já limpam `annotations` com confirm quando há
            alguma (ver handleCropApply) — então escondê-las ENQUANTO o modo está aberto não perde nada,
            só evita mostrar uma posição temporariamente errada. */}
        {!cropMode && (
          <AnnotationCanvas
            canvasRef={canvasRef}
            containerRef={canvasWrapRef}
            present={history.present}
            dispatch={dispatch}
            enabled={activeTab === 'anotar' && annotateTool !== null}
            tool={annotateTool}
            color={annotateColor}
            size={annotateSize}
          />
        )}
      </div>

      {cropMode ? (
        <CropOverlay
          canvasRef={canvasRef}
          containerRef={canvasWrapRef}
          initialCrop={history.present.geometry.crop}
          onCancel={() => setCropMode(false)}
          onApply={handleCropApply}
        />
      ) : (
        <>
          <div className="editor-panel">
            {activeTab === 'basico' ? (
              <BasicPanel
                present={history.present}
                dispatch={dispatch}
                onEnterCrop={() => setCropMode(true)}
                onStraightenDragChange={setShowStraightenGrid}
              />
            ) : activeTab === 'ajustes' ? (
              <AdjustPanel present={history.present} dispatch={dispatch} />
            ) : activeTab === 'filtros' ? (
              <FilterPanel present={history.present} dispatch={dispatch} image={image} />
            ) : activeTab === 'anotar' ? (
              <AnnotatePanel
                present={history.present}
                dispatch={dispatch}
                tool={annotateTool}
                onToolChange={setAnnotateTool}
                color={annotateColor}
                onColorChange={setAnnotateColor}
                size={annotateSize}
                onSizeChange={setAnnotateSize}
              />
            ) : (
              <p className="panel-placeholder">Em breve</p>
            )}
          </div>

          <div className="editor-tabs">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`editor-tab${activeTab === tab.id ? ' active' : ''}`}
                data-testid={`tab-${tab.id}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
