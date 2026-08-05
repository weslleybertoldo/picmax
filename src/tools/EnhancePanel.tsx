// src/tools/EnhancePanel.tsx — aba Melhorar: 2 cards empilhados (auto-ajuste instantâneo funcional
// nesta task; IA offline com botão desabilitado, ligado na T10).
import { useEffect, useRef, useState, type Dispatch } from 'react';
import { computeAutoEnhance } from '../engine/autoEnhance';
import type { EditAction, EditSnapshot } from '../state/editStack';
import type { LoadedImage } from '../io/openImage';

export interface EnhancePanelProps {
  present: EditSnapshot;
  dispatch: Dispatch<EditAction>;
  image: LoadedImage;
}

const APPLIED_FEEDBACK_MS = 1500;

export default function EnhancePanel({ present, dispatch, image }: EnhancePanelProps) {
  // Micro-feedback local (T9): o texto do botão vira "Aplicado ✓" por ~1.5s — puramente visual, NÃO
  // entra no EditSnapshot/histórico (mesmo espírito do `toast` do Editor, só que escopado ao botão em
  // vez de global). timerRef permite reiniciar a contagem se o usuário clicar de novo antes de acabar.
  const [applied, setApplied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // Analisa o bitmap de PREVIEW atual (image.bitmap, ≤2048 — ver autoEnhance.ts) e aplica os ajustes
  // calculados por CIMA dos ajustes atuais do usuário (spread de present.adjustments primeiro). Uma
  // única entrada de histórico (dispatch 'set'), instantâneo e desfazível com undo — a base da imagem
  // (image.bitmap) nunca muda aqui, só os uniforms de ajuste do renderer.
  function handleAutoEnhance() {
    const auto = computeAutoEnhance(image.bitmap);
    dispatch({ type: 'set', patch: { adjustments: { ...present.adjustments, ...auto } } });
    setApplied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setApplied(false), APPLIED_FEEDBACK_MS);
  }

  return (
    <div className="enhance-panel">
      <div className="enhance-card">
        <div className="enhance-card-header">
          <h3 className="enhance-card-title">Ajuste automático</h3>
        </div>
        <p className="enhance-card-desc">Ajuste automático instantâneo</p>
        <button
          type="button"
          className="btn btn-primary enhance-card-btn"
          data-testid="enhance-auto"
          onClick={handleAutoEnhance}
        >
          {applied ? 'Aplicado ✓' : 'Melhorar qualidade'}
        </button>
      </div>

      <div className="enhance-card enhance-card-ai">
        <div className="enhance-card-header">
          <h3 className="enhance-card-title">Melhorar com IA</h3>
          <span className="enhance-badge">em breve</span>
        </div>
        <p className="enhance-card-desc">Super-resolução com IA offline</p>
        <button type="button" className="btn btn-secondary enhance-card-btn" data-testid="enhance-ai" disabled>
          Melhorar qualidade com IA
        </button>
      </div>
    </div>
  );
}
