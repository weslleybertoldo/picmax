// src/tools/EnhancePanel.tsx — aba Melhorar: seção "Meus modelos" expansível (v1.1.1, pedido do
// Weslley) + 2 cards empilhados (auto-ajuste instantâneo da T9 + IA Real-ESRGAN 4x offline da T10,
// só em plataforma nativa — no web dev o botão fica desabilitado com hint, não existe
// libpicmaxenhance.so fora do APK). v1.1: os 2 cards ganharam estado "Aplicado ✓" PERMANENTE com
// toggle de desfazer (ver handleAutoEnhance/handleAiClick).
import { useState, type Dispatch } from 'react';
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { computeAutoEnhance } from '../engine/autoEnhance';
import type { EditAction, EditSnapshot } from '../state/editStack';
import { loadedImageFromBlob, type LoadedImage } from '../io/openImage';
import { blobToBase64 } from '../io/blobToBase64';
import { ImageEnhancer } from '../native/imageEnhancer';
import PresetsPanel from '../presets/PresetsPanel';
import type { EditPreset } from '../presets/presets';

export interface EnhancePanelProps {
  present: EditSnapshot;
  dispatch: Dispatch<EditAction>;
  image: LoadedImage;
  // T10: entrega a base nova (resultado 4x da IA) pro Editor, que a acrescenta ao array de bases do
  // App e troca o baseVersion num dispatch 'set' (desfazível) — ver handleNewBase em Editor.tsx.
  onNewBase: (img: LoadedImage) => void;
  // v1.1: tamanho do array de bases do App — permite REAPLICAR a IA sem reprocessar quando um
  // resultado já existe (bases.length > 1): só volta o baseVersion pro índice do resultado.
  basesCount: number;
  // "Meus modelos" (v1.1.1): aplicar um modelo daqui usa o MESMO handler da aba Filtros
  // (handleApplyPreset do Editor — set desfazível + toast "Modelo aplicado ✓").
  onApplyPreset: (preset: EditPreset) => void;
  // bump do Editor pra reler o storage sem remontar (mesma técnica da aba Filtros).
  presetsVersion: number;
}

// Estado do fluxo de IA. usingGpu null = ainda sem o 1º evento de progresso (o Kotlin emite percent
// 0 logo após carregar o modelo, então o modo GPU/CPU aparece quase imediato).
type AiState =
  | { phase: 'idle' }
  | { phase: 'running'; percent: number; usingGpu: boolean | null; cancelling: boolean };

export default function EnhancePanel({ present, dispatch, image, onNewBase, basesCount, onApplyPreset, presetsVersion }: EnhancePanelProps) {
  const [aiState, setAiState] = useState<AiState>({ phase: 'idle' });
  const [aiError, setAiError] = useState<string | null>(null);
  // "Meus modelos" (v1.1.1): COLAPSADO por default (estado local — trocar de aba recolhe, mesmo
  // racional do activeKey do AdjustPanel). O card nunca some quando não há modelos (descobribilidade):
  // expandir sem modelos mostra "Nenhum modelo salvo ainda" (emptyMessage do PresetsPanel).
  const [presetsOpen, setPresetsOpen] = useState(false);
  const isNative = Capacitor.isNativePlatform();

  // Estado "Aplicado ✓" do auto-ajuste (v1.1): vive no SNAPSHOT (present.autoEnhance), não em state
  // local — sobrevive a troca de aba, entra no undo/redo e o card mostra o estado permanente.
  const autoApplied = present.autoEnhance !== null;

  // Aplicar: analisa o bitmap de PREVIEW atual (≤2048 — ver autoEnhance.ts), aplica os ajustes
  // calculados por CIMA dos ajustes atuais e guarda `before` = adjustments de ANTES num ÚNICO
  // dispatch 'set' (1 entrada de histórico). Desfazer (2º clique): restaura o `before` salvo e zera
  // autoEnhance — também 1 'set', desfazível com undo. IMPORTANTE (documentado na spec): se o usuário
  // mexer manualmente nos sliders DEPOIS de aplicar, o estado "aplicado" PERMANECE — o desfazer
  // restaura o `before` salvo no momento da aplicação (descarta também os ajustes manuais feitos por
  // cima). É o comportamento desejado: o card desfaz "o auto-ajuste e tudo que veio depois dele nos
  // sliders", e o undo do histórico continua disponível pra granularidade fina.
  function handleAutoEnhance() {
    if (present.autoEnhance) {
      dispatch({ type: 'set', patch: { adjustments: present.autoEnhance.before, autoEnhance: null } });
      return;
    }
    const auto = computeAutoEnhance(image.bitmap);
    dispatch({
      type: 'set',
      patch: {
        adjustments: { ...present.adjustments, ...auto },
        autoEnhance: { before: present.adjustments },
      },
    });
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

  // Estado "Aplicado ✓" da IA (v1.1): aplicado = snapshot apontando pra uma base ≠ original.
  // Desfazer: set {baseVersion: 0} — volta pra base original SEM jogar fora o resultado (os bitmaps
  // ficam vivos no array bases[] do App). aiResultIndex: se já existe um resultado processado
  // (basesCount > 1), REAPLICAR só volta o baseVersion pro índice dele — sem reprocessar (instantâneo
  // e desfazível; documentado na spec: mais rápido e óbvio pro usuário do que rodar a IA de novo).
  // Só a ÚLTIMA base entra no atalho (bases.length-1): é o resultado mais recente da IA.
  const aiApplied = present.baseVersion > 0;
  const aiResultIndex = basesCount > 1 ? basesCount - 1 : null;

  function handleAiClick() {
    if (aiApplied) {
      dispatch({ type: 'set', patch: { baseVersion: 0 } });
      return;
    }
    if (aiResultIndex !== null) {
      dispatch({ type: 'set', patch: { baseVersion: aiResultIndex } });
      return;
    }
    void handleAiEnhance();
  }

  // Desfazer/reaplicar são dispatches puros (funcionam em qualquer plataforma — inclusive na
  // validação headless); só PROCESSAR de novo exige o plugin nativo.
  const aiDisabled = running || (!isNative && !aiApplied && aiResultIndex === null);

  return (
    <div className="enhance-panel">
      {/* "Meus modelos" (v1.1.1): ACIMA do Ajuste automático. Header inteiro é o botão de
          expandir/colapsar (chevron gira); o conteúdo reusa o PresetsPanel inline da aba Filtros —
          tocar num modelo aplica via onApplyPreset (set desfazível + toast no Editor). */}
      <div className="enhance-card">
        <button
          type="button"
          className="enhance-presets-toggle"
          data-testid="enhance-presets-toggle"
          aria-expanded={presetsOpen}
          onClick={() => setPresetsOpen((o) => !o)}
        >
          <h3 className="enhance-card-title">Meus modelos</h3>
          <span className={`enhance-presets-chevron${presetsOpen ? ' open' : ''}`} aria-hidden="true">
            ▾
          </span>
        </button>
        {presetsOpen && (
          <div data-testid="enhance-presets-content">
            <PresetsPanel
              variant="inline"
              onApply={onApplyPreset}
              refreshKey={presetsVersion}
              emptyMessage="Nenhum modelo salvo ainda"
            />
          </div>
        )}
      </div>

      <div className="enhance-card">
        <div className="enhance-card-header">
          <h3 className="enhance-card-title">Ajuste automático</h3>
        </div>
        <p className="enhance-card-desc">
          {autoApplied
            ? 'Desfazer restaura os ajustes de antes do auto-ajuste (inclusive por cima de mudanças manuais)'
            : 'Ajuste automático instantâneo'}
        </p>
        <button
          type="button"
          className={autoApplied ? 'btn btn-secondary enhance-card-btn enhance-applied' : 'btn btn-primary enhance-card-btn'}
          data-testid="enhance-auto"
          onClick={handleAutoEnhance}
        >
          {autoApplied ? 'Aplicado ✓ — toque para desfazer' : 'Melhorar qualidade'}
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
          className={`btn btn-secondary enhance-card-btn${aiApplied ? ' enhance-applied' : ''}`}
          data-testid="enhance-ai"
          disabled={aiDisabled}
          onClick={handleAiClick}
        >
          {aiApplied
            ? 'Aplicado ✓ — toque para desfazer'
            : aiResultIndex !== null
              ? 'Reaplicar melhoria com IA'
              : 'Melhorar qualidade com IA'}
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
