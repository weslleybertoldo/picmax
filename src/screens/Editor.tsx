// src/screens/Editor.tsx — shell do editor: canvas WebGL + toolbar de abas (Básico, Ajustes e Filtros
// funcionais) + overlay de crop / grade de endireitar sobre o canvas
import { useEffect, useMemo, useReducer, useRef, useState, type RefObject } from 'react';
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { createRenderer, type Renderer } from '../engine/renderer';
import { editReducer, initialSnapshot, type CropRect, type EditAction, type EditSnapshot } from '../state/editStack';
import type { LoadedImage } from '../io/openImage';
import { blobToBase64 } from '../io/blobToBase64';
import { exportImage } from '../io/exportImage';
import { ImageEnhancer } from '../native/imageEnhancer';
import BasicPanel from '../tools/BasicPanel';
import CropOverlay from '../tools/CropOverlay';
import { useCanvasBox } from '../tools/canvasGeometry';
import AdjustPanel from '../tools/AdjustPanel';
import FilterPanel from '../tools/FilterPanel';
import AnnotatePanel from '../tools/AnnotatePanel';
import EnhancePanel from '../tools/EnhancePanel';
import AnnotationCanvas, { DEFAULT_ANNOTATE_COLOR, DEFAULT_ANNOTATE_SIZE, type AnnotateTool } from '../annotate/AnnotationCanvas';

function exportFileName(mime: string): string {
  return `PicMax_${Date.now()}.${mime === 'image/png' ? 'png' : 'jpg'}`;
}

export interface EditorProps {
  // T10: array de bases (índice = baseVersion do snapshot). bases[0] = imagem aberta; a IA
  // acrescenta novas via onAddBase e troca a base ativa com dispatch set {baseVersion} (desfazível).
  bases: LoadedImage[];
  onAddBase: (img: LoadedImage) => void;
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

export default function Editor({ bases, onAddBase, onBack }: EditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const [history, dispatch] = useReducer(editReducer, undefined, () => ({
    past: [],
    present: initialSnapshot(),
    future: [],
  }));
  // Base ativa segue o baseVersion do snapshot (undo/redo trocam a base junto). O clamp cobre o
  // instante entre o dispatch set {baseVersion: N} e o re-render com o `bases` já crescido — os dois
  // acontecem no mesmo handler (batched), mas o clamp garante que NUNCA se lê bases[undefined].
  const image = bases[Math.min(history.present.baseVersion, bases.length - 1)];
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
  // Export/compartilhar (T8): `exportBusy` desabilita os 2 botões (a exportação full-res pode levar
  // segundos numa foto grande) — só um dos dois roda por vez, sem fila. `toast` é feedback efêmero
  // (sucesso ou erro, nunca stack trace) — some sozinho depois de 3s (efeito abaixo).
  const [exportBusy, setExportBusy] = useState<'export' | 'share' | null>(null);
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'error' } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

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

  // Resultado da IA (T10): acrescenta a base nova ao array do App e troca o baseVersion no MESMO
  // handler (React faz batch dos dois) — o índice da base nova é bases.length ANTES do append.
  // Desfazível: undo volta o baseVersion e este Editor re-deriva `image` da base antiga (viva).
  function handleNewBase(img: LoadedImage) {
    const newIndex = bases.length;
    onAddBase(img);
    dispatch({ type: 'set', patch: { baseVersion: newIndex } });
  }

  function handleCropApply(crop: CropRect) {
    const patch: Partial<EditSnapshot> = { geometry: { ...history.present.geometry, crop } };
    if (history.present.annotations.length > 0) {
      if (!window.confirm('As anotações serão removidas. Continuar?')) return; // cancelou: aborta, segue no modo crop
      patch.annotations = [];
    }
    dispatch({ type: 'set', patch });
    setCropMode(false);
  }

  // Exportar (T8): render full-res via exportImage (geometria+ajustes+filtro+anotações — ver
  // src/io/exportImage.ts) e grava no MediaStore via o plugin nativo. Na plataforma web dev (sem
  // Capacitor nativo, `npm run dev`) não existe MediaStore: baixa o blob como download comum
  // (`<a download>` + Blob URL) — sem isso o botão não teria NENHUM efeito observável fora do device,
  // e é exatamente esse link que permite validar o pipeline de export de ponta a ponta num navegador
  // headless (Playwright intercepta o evento de download), sem precisar de emulador Android.
  async function handleExport() {
    if (exportBusy) return;
    setExportBusy('export');
    try {
      const blob = await exportImage(image, history.present);
      if (Capacitor.isNativePlatform()) {
        const base64 = await blobToBase64(blob);
        await ImageEnhancer.saveToGallery({ base64, mime: blob.type });
        setToast({ text: 'Salvo em Pictures/PicMax ✓', kind: 'ok' });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = exportFileName(blob.type);
        a.setAttribute('data-testid', 'export-download-link');
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000); // dá tempo do navegador consumir o Blob URL
        setToast({ text: 'Download iniciado (modo dev, sem device nativo)', kind: 'ok' });
      }
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : 'Não foi possível exportar a imagem.', kind: 'error' });
    } finally {
      setExportBusy(null);
    }
  }

  // Compartilhar (T8): mesmo render full-res, mas grava em cache (Filesystem, escopo do app — não
  // aparece na galeria) e abre o share sheet do sistema. Só faz sentido em device nativo (Web Share
  // API não suporta `files` de forma confiável e não roda em Chromium headless); erro aqui vira toast,
  // nunca stack trace.
  async function handleShare() {
    if (exportBusy) return;
    setExportBusy('share');
    try {
      const blob = await exportImage(image, history.present);
      const base64 = await blobToBase64(blob);
      const { uri } = await Filesystem.writeFile({
        path: exportFileName(blob.type),
        data: base64,
        directory: Directory.Cache,
      });
      await Share.share({ files: [uri], title: 'PicMax' });
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : 'Não foi possível compartilhar a imagem.', kind: 'error' });
    } finally {
      setExportBusy(null);
    }
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
        <button
          type="button"
          className="btn btn-secondary btn-export"
          data-testid="export"
          aria-label="Exportar"
          disabled={cropMode || exportBusy !== null}
          onClick={handleExport}
        >
          {exportBusy === 'export' ? <span className="spinner" aria-hidden="true" /> : '⬇'} Exportar
        </button>
        <button
          type="button"
          className="btn btn-icon"
          data-testid="share"
          aria-label="Compartilhar"
          disabled={cropMode || exportBusy !== null}
          onClick={handleShare}
        >
          {exportBusy === 'share' ? <span className="spinner" aria-hidden="true" /> : '⤴'}
        </button>
      </div>

      {toast && (
        <div className={`toast toast-${toast.kind}`} data-testid="toast" role="status">
          {toast.text}
        </div>
      )}

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
              <EnhancePanel present={history.present} dispatch={dispatch} image={image} onNewBase={handleNewBase} />
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
