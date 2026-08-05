// src/screens/Editor.tsx — shell do editor: canvas WebGL + toolbar de abas (Ajustes e Filtros funcionais)
import { useEffect, useReducer, useRef, useState } from 'react';
import { createRenderer, type Renderer } from '../engine/renderer';
import { editReducer, initialSnapshot } from '../state/editStack';
import type { LoadedImage } from '../io/openImage';
import AdjustPanel from '../tools/AdjustPanel';
import FilterPanel from '../tools/FilterPanel';

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

export default function Editor({ image, onBack }: EditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const [history, dispatch] = useReducer(editReducer, undefined, () => ({
    past: [],
    present: initialSnapshot(),
    future: [],
  }));
  const [activeTab, setActiveTab] = useState<TabId>('ajustes');
  const [engineError, setEngineError] = useState<string | null>(null);

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

  // Render coalescido com rAF: se `present` mudar de novo antes do frame disparar, o cleanup
  // cancela o rAF pendente e agenda um novo — nunca desenha um snapshot já obsoleto.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const raf = requestAnimationFrame(() => renderer.render(history.present));
    return () => cancelAnimationFrame(raf);
  }, [history.present]);

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
          disabled={history.past.length === 0}
          onClick={() => dispatch({ type: 'undo' })}
        >
          ↶
        </button>
        <button
          type="button"
          className="btn btn-icon"
          data-testid="redo"
          aria-label="Refazer"
          disabled={history.future.length === 0}
          onClick={() => dispatch({ type: 'redo' })}
        >
          ↷
        </button>
        <div className="editor-topbar-spacer" />
      </div>

      <div className="editor-canvas-wrap">
        {engineError && (
          <p className="editor-error" data-testid="engine-error">
            {engineError}
          </p>
        )}
        <canvas ref={canvasRef} className="editor-canvas" data-testid="canvas" />
      </div>

      <div className="editor-panel">
        {activeTab === 'ajustes' ? (
          <AdjustPanel present={history.present} dispatch={dispatch} />
        ) : activeTab === 'filtros' ? (
          <FilterPanel present={history.present} dispatch={dispatch} image={image} />
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
    </div>
  );
}
