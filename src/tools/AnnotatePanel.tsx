// src/tools/AnnotatePanel.tsx — controles da aba Anotar: ferramenta ativa (toggle único), paleta de
// cores, espessura do traço e "Limpar anotações". O desenho em si (captura de pointer + rasterização)
// vive em annotate/AnnotationCanvas.tsx — este painel só manipula o estado LOCAL da ferramenta
// (levantado pro Editor, que o compartilha com AnnotationCanvas) e o histórico de `annotations`.
import type { Dispatch } from 'react';
import type { AnnotateTool } from '../annotate/AnnotationCanvas';
import type { EditAction, EditSnapshot } from '../state/editStack';

export interface AnnotatePanelProps {
  present: EditSnapshot;
  dispatch: Dispatch<EditAction>;
  tool: AnnotateTool | null;
  onToolChange: (tool: AnnotateTool | null) => void;
  color: string;
  onColorChange: (color: string) => void;
  size: number;
  onSizeChange: (size: number) => void;
}

const TOOLS: Array<{ id: AnnotateTool; label: string; icon: string }> = [
  { id: 'pen', label: 'Caneta', icon: '✏️' },
  { id: 'eraser', label: 'Borracha', icon: '🧹' },
  { id: 'text', label: 'Texto', icon: 'A' },
  { id: 'arrow', label: 'Seta', icon: '↗' },
  { id: 'rect', label: 'Retângulo', icon: '▭' },
  { id: 'ellipse', label: 'Elipse', icon: '◯' },
  { id: 'line', label: 'Linha', icon: '╱' },
];

// Ordem pedida na spec: branco, preto, vermelho, laranja, amarelo, verde, azul, rosa. Laranja/rosa/azul
// reusam os brand colors do tema (--brand-1/2/3) pra consistência visual com o resto do app.
const COLORS: Array<{ id: string; value: string }> = [
  { id: 'branco', value: '#ffffff' },
  { id: 'preto', value: '#000000' },
  { id: 'vermelho', value: '#ff3b30' },
  { id: 'laranja', value: '#ff7a18' },
  { id: 'amarelo', value: '#ffcc00' },
  { id: 'verde', value: '#34c759' },
  { id: 'azul', value: '#1e6bff' },
  { id: 'rosa', value: '#ff2d78' },
];

export default function AnnotatePanel({
  present,
  dispatch,
  tool,
  onToolChange,
  color,
  onColorChange,
  size,
  onSizeChange,
}: AnnotatePanelProps) {
  // Toggle único: tocar a ferramenta já ativa desativa (o overlay para de capturar pointer — ver
  // `enabled` em Editor.tsx).
  function selectTool(id: AnnotateTool) {
    onToolChange(tool === id ? null : id);
  }

  function clearAnnotations() {
    if (present.annotations.length === 0) return;
    if (!window.confirm('Isso vai apagar todas as anotações. Continuar?')) return;
    dispatch({ type: 'set', patch: { annotations: [] } });
  }

  return (
    <div className="annotate-panel">
      <div className="annotate-tools" data-testid="annotate-tools">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`btn btn-secondary annotate-tool${tool === t.id ? ' active' : ''}`}
            data-testid={`annotate-tool-${t.id}`}
            onClick={() => selectTool(t.id)}
          >
            <span className="annotate-tool-icon">{t.icon}</span>
            <span className="annotate-tool-label">{t.label}</span>
          </button>
        ))}
      </div>

      <div className="annotate-colors" data-testid="annotate-colors">
        {COLORS.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`annotate-color${color === c.value ? ' active' : ''}`}
            data-testid={`annotate-color-${c.id}`}
            style={{ background: c.value }}
            aria-label={c.id}
            onClick={() => onColorChange(c.value)}
          />
        ))}
      </div>

      <div className="slider-row" data-testid="annotate-size-row">
        <div className="slider-row-label">
          <span>Espessura</span>
          <span>{size}</span>
        </div>
        {/* Estado LOCAL da ferramenta (levantado pro Editor via onSizeChange) — NÃO vai pro
            EditSnapshot/histórico, por isso não usa useSliderGesture (que existe pra coreografar
            preview/commit/undo de valores que VÃO pro histórico). Espessura é só a config do PRÓXIMO
            traço/forma/texto a ser criado; mudar o slider não altera anotações já existentes, então um
            useState simples + onInput direto bastam. */}
        <input
          type="range"
          min={4}
          max={40}
          step={1}
          value={size}
          data-testid="annotate-size"
          onInput={(e) => onSizeChange(Number(e.currentTarget.value))}
        />
      </div>

      <button
        type="button"
        className="btn btn-secondary annotate-clear"
        data-testid="annotate-clear"
        disabled={present.annotations.length === 0}
        onClick={clearAnnotations}
      >
        Limpar anotações
      </button>
    </div>
  );
}
