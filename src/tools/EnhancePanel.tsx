// src/tools/EnhancePanel.tsx — aba Melhorar: 2 cards empilhados (auto-ajuste instantâneo da T9 +
// IA Real-ESRGAN 4x offline da T10, só em plataforma nativa — no web dev o botão fica desabilitado
// com hint, não existe libpicmaxenhance.so fora do APK).
import { useEffect, useRef, useState, type Dispatch } from 'react';
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { computeAutoEnhance } from '../engine/autoEnhance';
import type { EditAction, EditSnapshot } from '../state/editStack';
import { loadedImageFromBlob, type LoadedImage } from '../io/openImage';
import { blobToBase64 } from '../io/blobToBase64';
import { ImageEnhancer } from '../native/imageEnhancer';

export interface EnhancePanelProps {
  present: EditSnapshot;
  dispatch: Dispatch<EditAction>;
  image: LoadedImage;
  // T10: entrega a base nova (resultado 4x da IA) pro Editor, que a acrescenta ao array de bases do
  // App e troca o baseVersion num dispatch 'set' (desfazível) — ver handleNewBase em Editor.tsx.
  onNewBase: (img: LoadedImage) => void;
}

const APPLIED_FEEDBACK_MS = 1500;

// Estado do fluxo de IA. usingGpu null = ainda sem o 1º evento de progresso (o Kotlin emite percent
// 0 logo após carregar o modelo, então o modo GPU/CPU aparece quase imediato).
type AiState =
  | { phase: 'idle' }
  | { phase: 'running'; percent: number; usingGpu: boolean | null; cancelling: boolean };

export default function EnhancePanel({ present, dispatch, image, onNewBase }: EnhancePanelProps) {
  // Micro-feedback local (T9): o texto do botão vira "Aplicado ✓" por ~1.5s — puramente visual, NÃO
  // entra no EditSnapshot/histórico (mesmo espírito do `toast` do Editor, só que escopado ao botão em
  // vez de global). timerRef permite reiniciar a contagem se o usuário clicar de novo antes de acabar.
  const [applied, setApplied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [aiState, setAiState] = useState<AiState>({ phase: 'idle' });
  const [aiError, setAiError] = useState<string | null>(null);
  const isNative = Capacitor.isNativePlatform();

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

  // IA (T10): grava a BASE atual (image.blob — full-res, não o preview) em cache → plugin nativo
  // processa 4x por tiles (progresso via evento) → lê o JPEG resultante e entrega como base nova.
  // Enquanto roda, o modal fixo bloqueia toda a UI (backdrop cobre a tela) — não dá pra trocar de
  // aba/desmontar este painel no meio, então os setState do fluxo sempre acham o componente montado.
  async function handleAiEnhance() {
    if (aiState.phase === 'running') return;
    setAiError(null);
    setAiState({ phase: 'running', percent: 0, usingGpu: null, cancelling: false });
    let listener: Awaited<ReturnType<typeof ImageEnhancer.addListener>> | null = null;
    const inputName = `ai_input_${Date.now()}.${image.blob.type === 'image/png' ? 'png' : 'jpg'}`;
    let outputPath: string | null = null;
    try {
      const base64 = await blobToBase64(image.blob);
      const { uri } = await Filesystem.writeFile({ path: inputName, data: base64, directory: Directory.Cache });
      listener = await ImageEnhancer.addListener('enhanceProgress', (e) => {
        setAiState((s) => (s.phase === 'running' ? { ...s, percent: e.percent, usingGpu: e.usingGpu } : s));
      });
      const res = await ImageEnhancer.enhance({ path: uri, maxOutputSide: 8192 });
      outputPath = res.path;
      // Lê o resultado pelo servidor local do WebView (convertFileSrc) — evita empurrar um JPEG de
      // dezenas de MB como base64 pela bridge JS.
      const resp = await fetch(Capacitor.convertFileSrc(res.path));
      if (!resp.ok) throw new Error('Falha ao ler o resultado da IA.');
      const blob = await resp.blob();
      const enhanced = await loadedImageFromBlob(blob);
      onNewBase(enhanced);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Cancelamento não é erro: o Kotlin rejeita com "cancelado" e o estado anterior fica intacto.
      if (msg !== 'cancelado') {
        setAiError('Não foi possível melhorar com IA. Tente novamente.');
        console.error('[EnhancePanel] falha na IA:', e);
      }
    } finally {
      listener?.remove();
      // Temporários: o input SEMPRE morre; o output morre depois de já ter virado blob em memória
      // (a base nova vive no blob, não no arquivo). Falha na limpeza não é fatal (cacheDir é do app).
      Filesystem.deleteFile({ path: inputName, directory: Directory.Cache }).catch(() => {});
      if (outputPath) {
        const uri = outputPath.startsWith('file://') ? outputPath : `file://${outputPath}`;
        Filesystem.deleteFile({ path: uri }).catch(() => {});
      }
      setAiState({ phase: 'idle' });
    }
  }

  async function handleAiCancel() {
    setAiState((s) => (s.phase === 'running' ? { ...s, cancelling: true } : s));
    // O reject "cancelado" da promise do enhance() é quem fecha o modal (finally acima).
    await ImageEnhancer.cancelEnhance().catch(() => {});
  }

  const running = aiState.phase === 'running';

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
          {!isNative && <span className="enhance-badge">só no app</span>}
        </div>
        <p className="enhance-card-desc">
          {isNative
            ? 'Super-resolução 4x com IA offline (Real-ESRGAN)'
            : 'Super-resolução com IA offline — disponível apenas no app Android'}
        </p>
        {aiError && (
          <p className="enhance-ai-error" data-testid="enhance-ai-error">
            {aiError}
          </p>
        )}
        <button
          type="button"
          className="btn btn-secondary enhance-card-btn"
          data-testid="enhance-ai"
          disabled={!isNative || running}
          onClick={handleAiEnhance}
        >
          Melhorar qualidade com IA
        </button>
      </div>

      {running && (
        <div className="text-modal-backdrop" data-testid="ai-progress-modal">
          <div className="text-modal ai-modal">
            <h3 className="enhance-card-title">Melhorando com IA…</h3>
            <div className="ai-progress-track">
              <div className="ai-progress-fill" style={{ width: `${aiState.percent}%` }} />
            </div>
            <p className="enhance-card-desc" data-testid="ai-progress-info">
              {aiState.usingGpu === null
                ? 'Preparando o modelo…'
                : `${aiState.usingGpu ? 'GPU' : 'CPU (mais lento)'} · ${aiState.percent}%`}
            </p>
            <button
              type="button"
              className="btn btn-secondary"
              data-testid="ai-cancel"
              disabled={aiState.cancelling}
              onClick={handleAiCancel}
            >
              {aiState.cancelling ? 'Cancelando…' : 'Cancelar'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
