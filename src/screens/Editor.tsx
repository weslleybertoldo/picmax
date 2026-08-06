// src/screens/Editor.tsx — shell do editor: canvas WebGL + toolbar de abas (Básico, Ajustes e Filtros
// funcionais) + overlay de crop / grade de endireitar sobre o canvas
import { useEffect, useMemo, useReducer, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { createRenderer, roundKeepingAspect, type Renderer } from '../engine/renderer';
import { DEFAULT_ADJUSTMENTS, DEFAULT_GEOMETRY, editReducer, initialSnapshot, type CropRect, type EditAction, type EditSnapshot } from '../state/editStack';
import type { LoadedImage } from '../io/openImage';
import { blobToBase64 } from '../io/blobToBase64';
import { exportImage } from '../io/exportImage';
import { ImageEnhancer } from '../native/imageEnhancer';
import { savePreset, type EditPreset } from '../presets/presets';
import BasicPanel from '../tools/BasicPanel';
import CropOverlay from '../tools/CropOverlay';
import { useCanvasBox } from '../tools/canvasGeometry';
import AdjustPanel from '../tools/AdjustPanel';
import FilterPanel from '../tools/FilterPanel';
import AnnotatePanel from '../tools/AnnotatePanel';
import EnhancePanel from '../tools/EnhancePanel';
import AnnotationCanvas, { DEFAULT_ANNOTATE_COLOR, DEFAULT_ANNOTATE_SIZE, type AnnotateTool } from '../annotate/AnnotationCanvas';
import ClockOverlay from '../tools/ClockOverlay';
import { isClockFilter, withClockAppliedAt } from '../engine/clockOverlay';

function exportFileName(mime: string): string {
  return `PicMax_${Date.now()}.${mime === 'image/png' ? 'png' : 'jpg'}`;
}

// Voltar pra Home com edição não exportada (T12): diferente de `isNeutralEdit` (só ajustes+filtro,
// usado pro botão "Salvar modelo" — ver comentário mais abaixo), esta checagem cobre TUDO que se
// perderia ao sair sem exportar: geometria (crop/rotação/flip/straighten), anotações e a base ativa
// (troca pela IA). É comparada contra `history.past.length > 0` no botão Voltar: só pergunta quando
// existe histórico desfazível (algo foi de fato commitado) E o snapshot atual ainda não é neutro
// (um usuário que edita e desfaz tudo de volta não deveria ser interrompido ao saír).
function isNeutralSnapshot(s: EditSnapshot): boolean {
  return (
    s.baseVersion === 0 &&
    s.filter === null &&
    s.annotations.length === 0 &&
    s.geometry.rotate90 === DEFAULT_GEOMETRY.rotate90 &&
    s.geometry.flipH === DEFAULT_GEOMETRY.flipH &&
    s.geometry.flipV === DEFAULT_GEOMETRY.flipV &&
    s.geometry.straighten === DEFAULT_GEOMETRY.straighten &&
    s.geometry.crop === DEFAULT_GEOMETRY.crop &&
    // resizeMaxSide fica FORA da checagem de propósito (limpeza pré-release): desde a v1.1 ele nunca
    // mais é setado por dispatch (o modal de resolução injeta o valor só na hora do export, sem
    // histórico) — comparação era código morto.
    (Object.keys(DEFAULT_ADJUSTMENTS) as Array<keyof typeof DEFAULT_ADJUSTMENTS>).every(
      (k) => s.adjustments[k] === DEFAULT_ADJUSTMENTS[k],
    )
  );
}

// Antes/depois (v1.1): TAP curto no canvas ALTERNA entre a edição e a foto com o snapshot neutro da
// base ATUAL (geometria/ajustes/filtro/anotações no default, mas a MESMA base — a textura já
// carregada no renderer não muda; substituiu o hold-to-compare da v1.0). Tap = pointerdown+up do
// MESMO ponteiro em <TAP_MAX_MS com deslocamento <TAP_MAX_PX — um arraste ou toque longo nunca
// alterna, então nenhum gesto futuro de pan/zoom no canvas conflita com este. baseVersion não
// influencia o render() do WebGL em si (a textura já está fixada via setImage; o campo só existe pro
// Editor/App saberem QUAL bitmap carregar) — mantido por completude semântica.
const TAP_MAX_MS = 300;
const TAP_MAX_PX = 10;
function neutralSnapshotOfBase(baseVersion: number): EditSnapshot {
  return { ...initialSnapshot(), baseVersion };
}

export interface EditorProps {
  // T10: array de bases (índice = baseVersion do snapshot). bases[0] = imagem aberta; a IA
  // acrescenta novas via onAddBase e troca a base ativa com dispatch set {baseVersion} (desfazível).
  bases: LoadedImage[];
  onAddBase: (img: LoadedImage) => void;
  onBack: () => void;
  // Resolução do export (v1.1): última escolha no modal (null = Máxima), lembrada pela sessão no
  // App — ver comentário em App.tsx.
  exportMaxSide: number | null;
  onExportMaxSideChange: (v: number | null) => void;
}

// Opções do modal de resolução (v1.1): lado MAIOR da saída. Opções maiores que o frame final ficam
// ocultas (sem upscale); "Máxima (original)" sempre existe e é a pré-selecionada default.
const EXPORT_SIZE_OPTIONS: Array<{ label: string; value: number }> = [
  { label: '4K', value: 2160 },
  { label: 'Full HD', value: 1080 },
  { label: 'HD', value: 720 },
];

// Dimensões REAIS de saída do export com a geometria atual: base FULL-RES (image.width/height já
// orientadas pelo EXIF — ver openImage.ts; a textura do preview é ≤2048 e NÃO serve pra isso),
// eixos trocados por rotate90 ímpar e fração do crop — mesmo cálculo do renderer.frameSize, mesmo
// arredondamento (roundKeepingAspect). O clamp de MAX_TEXTURE_SIZE da GPU não entra na exibição
// (caso raro de foto acima do limite; o exportImage já trata na hora).
function exportFrameSize(image: LoadedImage, snap: EditSnapshot): { w: number; h: number } {
  const k = snap.geometry.rotate90 & 3;
  let w = k % 2 ? image.height : image.width;
  let h = k % 2 ? image.width : image.height;
  if (snap.geometry.crop) {
    w *= snap.geometry.crop.w;
    h *= snap.geometry.crop.h;
  }
  return roundKeepingAspect(w, h);
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

export default function Editor({ bases, onAddBase, onBack, exportMaxSide, onExportMaxSideChange }: EditorProps) {
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
  // Modal de resolução (v1.1): Exportar/Compartilhar abrem o modal ANTES de gerar; a escolha vira o
  // resizeMaxSide da exportação (os chips de Redimensionar da aba Básico saíram — o modal é a fonte
  // ÚNICA da escolha; geometry.resizeMaxSide continua existindo no snapshot só como veículo do valor
  // até o exportImage, nunca mais é setado por dispatch).
  const [exportModal, setExportModal] = useState<'export' | 'share' | null>(null);
  const [exportChoice, setExportChoice] = useState<number | null>(null);
  // Modelos (T11): modal de nome do "Salvar modelo" + contador que força a seção "Meus modelos" da
  // aba Filtros a reler o storage sem remontar (ela só remonta ao trocar de aba — ver ternário de
  // abas mais abaixo; sem isso, salvar um modelo com a aba Filtros já aberta deixaria a lista velha
  // visível até o usuário sair e voltar pra aba).
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetsVersion, setPresetsVersion] = useState(0);
  // Antes/depois (v1.1): `showOriginal` alterna a cada TAP no canvas fora do modo Cortar/Anotar-ativo
  // (ver handleTapStart/handleTapEnd). tapRef guarda o gesto candidato em andamento (pointerId que
  // começou + posição/hora do pointerdown); um 2º dedo pousando no meio CANCELA o candidato (dois
  // dedos = gesto de outra natureza, nunca um tap). Sair do modo original é automático em qualquer
  // ação de edição — ver dispatchEdit abaixo.
  const [showOriginal, setShowOriginal] = useState(false);
  // Relógio do Slim Black iOS (v1.1 r4; release review, bloqueante 4): o instante da aplicação vive
  // no SNAPSHOT (filter.appliedAt, gravado por withClockAppliedAt no dispatch que aplica o filtro —
  // FilterPanel.selectFilter / handleApplyPreset abaixo) — undo/redo restauram a mesma hora e o
  // corpo do render fica puro (a versão anterior mutava uma ref aqui). Preview e export leem SÓ do
  // snapshot; `clockAppliedAt === null` com filtro-relógio ativo só acontece em snapshot injetado
  // por fora da UI (hook de dev) — nesse caso o overlay de preview não monta (o export usa fallback
  // próprio, ver exportImage.ts).
  const filterIsClock = isClockFilter(history.present.filter?.id);
  const clockAppliedAt = filterIsClock ? (history.present.filter?.appliedAt ?? null) : null;
  const tapRef = useRef<{ pointerId: number; x: number; y: number; t: number } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // Edição neutra (spec T11): todos os ajustes no default E sem filtro — nada a salvar como modelo.
  // Crop/anotações/baseVersion (IA) ficam de fora dessa checagem de propósito: não fazem parte do
  // modelo (são propriedades da FOTO, não da "receita" de cor reaplicável em qualquer imagem).
  const isNeutralEdit =
    history.present.filter === null &&
    (Object.keys(DEFAULT_ADJUSTMENTS) as Array<keyof typeof DEFAULT_ADJUSTMENTS>).every(
      (k) => history.present.adjustments[k] === DEFAULT_ADJUSTMENTS[k],
    );

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

  // Antes/depois: enquanto `showOriginal`, substitui o snapshot renderizado pelo neutro da base
  // atual (ver neutralSnapshotOfBase acima) — independente do modo Cortar, já que o tap-gesture é
  // desabilitado nesse modo (ver handleTapStart). useMemo pelo mesmo motivo do displaySnapshot: manter
  // referência estável fora do instante em que showOriginal/displaySnapshot de fato mudam.
  const renderSnapshot: EditSnapshot = useMemo(
    () => (showOriginal ? neutralSnapshotOfBase(history.present.baseVersion) : displaySnapshot),
    [showOriginal, displaySnapshot, history.present.baseVersion],
  );

  // Render coalescido com rAF: se o snapshot exibido mudar de novo antes do frame disparar, o cleanup
  // cancela o rAF pendente e agenda um novo — nunca desenha um snapshot já obsoleto.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const raf = requestAnimationFrame(() => renderer.render(renderSnapshot));
    return () => cancelAnimationFrame(raf);
  }, [renderSnapshot]);

  // Sai do modo "Original" automaticamente em QUALQUER ação de edição (mexer em slider dispara
  // 'preview', trocar filtro/aplicar modelo dispara 'set', undo/redo idem) — o usuário sempre volta a
  // ver o que está editando. Wrapper usado em TODOS os pontos de dispatch do Editor e passado aos
  // painéis no lugar do dispatch cru (setState com o mesmo valor é bail-out barato do React — não
  // re-renderiza à toa durante um arraste de slider). O hook de dev __picmaxDispatch continua com o
  // dispatch cru de propósito: ele injeta estado por fora da UI (testes), sem semântica de "edição".
  function dispatchEdit(action: EditAction) {
    setShowOriginal(false);
    dispatch(action);
  }

  // Antes/depois: pointerdown fora do modo Cortar/Anotar (ferramenta ativa) registra o candidato a
  // tap; o pointerup do MESMO ponteiro decide — <TAP_MAX_MS e deslocamento <TAP_MAX_PX alternam o
  // modo original, qualquer outra coisa é ignorada (arraste/hold não alternam). setPointerCapture:
  // garante que pointerup/cancel deste MESMO ponteiro sempre chegam neste elemento, mesmo que o dedo
  // arraste pra fora do canvas antes de soltar (sem isso o candidato ficaria "preso" até o próximo
  // toque). Um 2º dedo pousando cancela o candidato: dois dedos nunca são um tap — mesma disciplina
  // de CropOverlay/AnnotationCanvas, que filtram por pointerId nos próprios gestos.
  function handleTapStart(e: ReactPointerEvent<HTMLDivElement>) {
    if (cropMode || (activeTab === 'anotar' && annotateTool !== null)) return;
    if (tapRef.current !== null) {
      tapRef.current = null; // 2º dedo no meio do gesto: não é tap — cancela o candidato
      return;
    }
    tapRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ponteiro já não está mais ativo (ex.: evento sintético em teste, ou up processado antes) —
      // sem captura o tap ainda funciona quando o dedo solta em cima do canvas; só perde o caso
      // "soltar fora" (que de todo jeito não seria um tap válido pela distância).
    }
  }
  function handleTapEnd(e: ReactPointerEvent<HTMLDivElement>) {
    const tap = tapRef.current;
    if (!tap || tap.pointerId !== e.pointerId) return; // não é o dedo que iniciou — ignora
    tapRef.current = null;
    const dt = performance.now() - tap.t;
    const dist = Math.hypot(e.clientX - tap.x, e.clientY - tap.y);
    if (dt < TAP_MAX_MS && dist < TAP_MAX_PX) setShowOriginal((v) => !v);
  }
  function handleTapCancel(e: ReactPointerEvent<HTMLDivElement>) {
    if (tapRef.current?.pointerId === e.pointerId) tapRef.current = null;
  }

  // Resultado da IA (T10): acrescenta a base nova ao array do App e troca o baseVersion no MESMO
  // handler (React faz batch dos dois) — o índice da base nova é bases.length ANTES do append.
  // Desfazível: undo volta o baseVersion e este Editor re-deriva `image` da base antiga (viva).
  // Toast (v1.1): feedback global ao concluir a IA, além do estado "Aplicado ✓" no card.
  function handleNewBase(img: LoadedImage) {
    const newIndex = bases.length;
    onAddBase(img);
    dispatchEdit({ type: 'set', patch: { baseVersion: newIndex } });
    setToast({ text: 'Melhoria aplicada ✓', kind: 'ok' });
  }

  // Aplicar modelo (T11): 1 dispatch 'set' com adjustments+filter do modelo — 1 entrada de histórico,
  // desfazível como qualquer outra edição. Geometria/anotações/baseVersion do snapshot atual não são
  // tocados (o modelo nunca inclui crop/anotações/IA, por design).
  // Merge com DEFAULT_ADJUSTMENTS (forward-compat, review): um modelo salvo por uma versão anterior
  // do schema de Adjustments (campo novo adicionado depois) chegaria aqui sem essa chave — sem o
  // merge, o slider correspondente leria `undefined` (input não-controlado / NaN no render).
  // withClockAppliedAt: modelo com filtro-relógio (slim-black*) ganha o `appliedAt` AGORA — o
  // modelo persiste sem hora (strip no savePreset) e cada aplicação é uma aplicação nova; se um
  // filtro-relógio já estava ativo, a hora existente é preservada (mesma regra do FilterPanel).
  // autoEnhance: null no mesmo set (limpeza pré-release): o modelo SUBSTITUI os ajustes por inteiro,
  // então o "Aplicado ✓" do auto-ajuste (e seu `before`) deixa de fazer sentido — mesma regra do
  // "Restaurar ajustes" (AdjustPanel).
  function handleApplyPreset(preset: EditPreset) {
    const filter = preset.filter ? withClockAppliedAt(preset.filter, history.present.filter) : null;
    dispatchEdit({
      type: 'set',
      patch: { adjustments: { ...DEFAULT_ADJUSTMENTS, ...preset.adjustments }, filter, autoEnhance: null },
    });
    setToast({ text: 'Modelo aplicado ✓', kind: 'ok' });
  }

  // setShowOriginal(false) (release review, bloqueante 6): Salvar modelo age sobre a EDIÇÃO — sair
  // do modo Original antes de abrir o modal, senão a tela segue mostrando o original enquanto o
  // usuário nomeia o modelo do editado (mesma regra em openExportModal).
  function openSaveModal() {
    setShowOriginal(false);
    setPresetName('');
    setShowSaveModal(true);
  }

  async function confirmSavePreset() {
    const name = presetName.trim().slice(0, 40);
    if (!name || savingPreset) return;
    setSavingPreset(true);
    try {
      await savePreset({ name, adjustments: history.present.adjustments, filter: history.present.filter });
      setPresetsVersion((n) => n + 1);
      setShowSaveModal(false);
      setToast({ text: 'Modelo salvo ✓', kind: 'ok' });
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : 'Não foi possível salvar o modelo.', kind: 'error' });
    } finally {
      setSavingPreset(false);
    }
  }

  function handleCropApply(crop: CropRect) {
    const patch: Partial<EditSnapshot> = { geometry: { ...history.present.geometry, crop } };
    if (history.present.annotations.length > 0) {
      if (!window.confirm('As anotações serão removidas. Continuar?')) return; // cancelou: aborta, segue no modo crop
      patch.annotations = [];
    }
    dispatchEdit({ type: 'set', patch });
    setCropMode(false);
  }

  // Modal de resolução (v1.1): dimensões finais do frame FULL-RES pra montar as opções.
  const frameFull = useMemo(() => exportFrameSize(image, history.present), [image, history.present]);
  const frameMaxDim = Math.max(frameFull.w, frameFull.h);
  // opções visíveis: só as MENORES que o frame (sem upscale); Máxima sempre.
  const visibleSizeOptions = EXPORT_SIZE_OPTIONS.filter((o) => o.value < frameMaxDim);

  function openExportModal(mode: 'export' | 'share') {
    if (exportBusy) return;
    // Exportar/Compartilhar agem sobre a EDIÇÃO (release review, bloqueante 6): sai do modo
    // Original antes — sem isso a tela mostrava o original enquanto o export do EDITADO acontecia.
    setShowOriginal(false);
    // Frame pequeno (limpeza pré-release): sem NENHUMA opção menor que o frame, o modal só teria
    // "Máxima" — pergunta sem escolha. Pula direto pra ação na resolução máxima (null), sem tocar
    // na escolha lembrada da sessão (ela segue valendo pra próxima imagem em que fizer sentido).
    if (visibleSizeOptions.length === 0) {
      if (mode === 'export') void handleExport(null);
      else void handleShare(null);
      return;
    }
    // escolha lembrada da sessão só vale se ainda visível pra ESTA imagem (senão volta pra Máxima)
    const remembered = exportMaxSide !== null && exportMaxSide < frameMaxDim ? exportMaxSide : null;
    setExportChoice(remembered);
    setExportModal(mode);
  }

  function confirmExportModal() {
    const mode = exportModal;
    if (!mode) return;
    setExportModal(null);
    onExportMaxSideChange(exportChoice); // lembra pra próxima (sessão)
    if (mode === 'export') void handleExport(exportChoice);
    else void handleShare(exportChoice);
  }

  // Snapshot efetivo da exportação: injeta a escolha do modal como resizeMaxSide SEM dispatch
  // (não entra no histórico — resolução de saída não é uma "edição").
  function exportSnapshot(maxSide: number | null): EditSnapshot {
    if (maxSide === null) return history.present;
    return { ...history.present, geometry: { ...history.present.geometry, resizeMaxSide: maxSide } };
  }

  // Exportar (T8): render full-res via exportImage (geometria+ajustes+filtro+anotações — ver
  // src/io/exportImage.ts) e grava no MediaStore via o plugin nativo. Na plataforma web dev (sem
  // Capacitor nativo, `npm run dev`) não existe MediaStore: baixa o blob como download comum
  // (`<a download>` + Blob URL) — sem isso o botão não teria NENHUM efeito observável fora do device,
  // e é exatamente esse link que permite validar o pipeline de export de ponta a ponta num navegador
  // headless (Playwright intercepta o evento de download), sem precisar de emulador Android.
  async function handleExport(maxSide: number | null) {
    if (exportBusy) return;
    setExportBusy('export');
    try {
      const blob = await exportImage(image, exportSnapshot(maxSide));
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
  async function handleShare(maxSide: number | null) {
    if (exportBusy) return;
    setExportBusy('share');
    try {
      const blob = await exportImage(image, exportSnapshot(maxSide));
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

  // Voltar pra Home (T12): confirma antes de descartar uma edição que ainda não foi exportada — só
  // pergunta quando há histórico desfazível E o resultado ainda é visivelmente diferente do original
  // (ver isNeutralSnapshot acima). `window.confirm` é o mesmo padrão já usado em handleCropApply.
  function handleBackClick() {
    if (history.past.length > 0 && !isNeutralSnapshot(history.present)) {
      if (!window.confirm('Descartar edição?')) return;
    }
    onBack();
  }

  // Botão FÍSICO de voltar do Android (review, bloqueante 3): sem um listener próprio, o comportamento
  // default do plugin App tentaria voltar no histórico do WebView — que esta SPA nunca usa (troca
  // condicional de tela, sem router) — e cairia direto no exit do app, mesmo dentro do Editor. Prioridade:
  // 1) modal de salvar modelo aberto → só fecha o modal; 2) modo Cortar aberto → só cancela o crop;
  // 3) senão, mesma lógica do botão de voltar na tela (confirm se houver edição não-neutra).
  // Ref (não os states direto): o listener é registrado 1x (Capacitor.App.addListener é assíncrono e
  // não republicaria a cada mudança de estado sem reassinar) — backButtonHandlerRef.current é
  // reatribuído TODA render, então o callback do listener sempre lê a versão mais atual dos states
  // fechados nele (mesma técnica do `liveRef` já usado em AdjustPanel/FilterPanel pra evitar closure
  // obsoleta). Modais de ferramentas filhas (progresso da IA, texto de anotação, menu de modelo) NÃO
  // são cobertos aqui — ficam fora do escopo desta review (não expõem um "fechar" pro Editor); back
  // nesses casos cai na lógica de cima (crop/save-modal → confirm-ou-volta), que já é uma melhoria
  // real sobre o comportamento anterior (sem listener nenhum, o back saía do app direto).
  const backButtonHandlerRef = useRef<() => void>(() => {});
  backButtonHandlerRef.current = () => {
    if (exportModal) {
      setExportModal(null); // v1.1: back físico fecha o modal de resolução (mesma cascata dos demais)
      return;
    }
    if (showSaveModal) {
      setShowSaveModal(false);
      return;
    }
    if (cropMode) {
      setCropMode(false);
      return;
    }
    handleBackClick();
  };
  useEffect(() => {
    let handle: PluginListenerHandle | null = null;
    let cancelled = false;
    CapacitorApp.addListener('backButton', () => backButtonHandlerRef.current()).then((h) => {
      if (cancelled) h.remove();
      else handle = h;
    });
    return () => {
      cancelled = true;
      handle?.remove();
    };
  }, []);

  return (
    <div className="editor">
      <div className="editor-topbar">
        <button type="button" className="btn btn-icon" data-testid="back" aria-label="Voltar" onClick={handleBackClick}>
          ←
        </button>
        <button
          type="button"
          className="btn btn-icon"
          data-testid="undo"
          aria-label="Desfazer"
          disabled={cropMode || history.past.length === 0}
          onClick={() => dispatchEdit({ type: 'undo' })}
        >
          ↶
        </button>
        <button
          type="button"
          className="btn btn-icon"
          data-testid="redo"
          aria-label="Refazer"
          disabled={cropMode || history.future.length === 0}
          onClick={() => dispatchEdit({ type: 'redo' })}
        >
          ↷
        </button>
        <div className="editor-topbar-spacer" />
        <button
          type="button"
          className="btn btn-icon"
          data-testid="save-preset"
          aria-label="Salvar modelo"
          disabled={cropMode || isNeutralEdit}
          onClick={openSaveModal}
        >
          🔖
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-export"
          data-testid="export"
          aria-label="Exportar"
          disabled={cropMode || exportBusy !== null}
          onClick={() => openExportModal('export')}
        >
          {exportBusy === 'export' ? <span className="spinner" aria-hidden="true" /> : '⬇'} Exportar
        </button>
        <button
          type="button"
          className="btn btn-icon"
          data-testid="share"
          aria-label="Compartilhar"
          disabled={cropMode || exportBusy !== null}
          onClick={() => openExportModal('share')}
        >
          {exportBusy === 'share' ? <span className="spinner" aria-hidden="true" /> : '⤴'}
        </button>
      </div>

      {toast && (
        <div className={`toast toast-${toast.kind}`} data-testid="toast" role="status">
          {toast.text}
        </div>
      )}

      {/* Modal de resolução (v1.1): Máxima sempre presente e pré-selecionada por default; as demais
          opções mostram as dimensões REAIS de saída e só aparecem quando menores que o frame final
          (sem upscale). O botão de confirmar repete o verbo da ação que abriu o modal. */}
      {exportModal && (
        <div className="text-modal-backdrop" data-testid="export-size-modal">
          <div className="text-modal">
            <h3 className="export-size-title">Resolução</h3>
            <div className="export-size-options">
              <button
                type="button"
                className={`export-size-option${exportChoice === null ? ' active' : ''}`}
                data-testid="export-size-max"
                onClick={() => setExportChoice(null)}
              >
                <span>Máxima (original)</span>
                <span className="export-size-dims">
                  {frameFull.w}×{frameFull.h}
                </span>
              </button>
              {visibleSizeOptions.map((opt) => {
                const scale = opt.value / frameMaxDim;
                const dims = roundKeepingAspect(frameFull.w * scale, frameFull.h * scale);
                return (
                  <button
                    key={opt.value}
                    type="button"
                    className={`export-size-option${exportChoice === opt.value ? ' active' : ''}`}
                    data-testid={`export-size-${opt.value}`}
                    onClick={() => setExportChoice(opt.value)}
                  >
                    <span>{opt.label}</span>
                    <span className="export-size-dims">
                      {dims.w}×{dims.h}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="text-modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                data-testid="export-size-cancel"
                onClick={() => setExportModal(null)}
              >
                Cancelar
              </button>
              <button type="button" className="btn btn-primary" data-testid="export-size-confirm" onClick={confirmExportModal}>
                {exportModal === 'export' ? 'Exportar' : 'Compartilhar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showSaveModal && (
        <div className="text-modal-backdrop" data-testid="save-preset-modal">
          <div className="text-modal">
            <input
              type="text"
              className="text-modal-input"
              data-testid="save-preset-input"
              autoFocus
              maxLength={40}
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              placeholder="Nome do modelo"
            />
            <div className="text-modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                data-testid="save-preset-cancel"
                disabled={savingPreset}
                onClick={() => setShowSaveModal(false)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn btn-primary"
                data-testid="save-preset-ok"
                disabled={!presetName.trim() || savingPreset}
                onClick={confirmSavePreset}
              >
                {savingPreset ? <span className="spinner" aria-hidden="true" /> : 'Salvar'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div
        className="editor-canvas-wrap"
        ref={canvasWrapRef}
        onPointerDown={handleTapStart}
        onPointerUp={handleTapEnd}
        onPointerCancel={handleTapCancel}
      >
        {engineError && (
          <p className="editor-error" data-testid="engine-error">
            {engineError}
          </p>
        )}
        <canvas ref={canvasRef} className="editor-canvas" data-testid="canvas" />
        {/* Antes/depois: hint enquanto showOriginal — pointer-events:none (CSS) pra nunca
            interceptar o próprio tap que alterna o modo. */}
        {showOriginal && (
          <span className="original-hint" data-testid="original-hint">
            Original — toque para voltar
          </span>
        )}
        {showStraightenGrid && <StraightenGrid canvasRef={canvasRef} containerRef={canvasWrapRef} />}
        {/* Camada de anotações: visível em TODAS as abas (anotações fazem parte da edição), mas só
            captura pointer na aba Anotar com uma ferramenta ativa. Desmontada inteira no modo Cortar
            (quality review): enquanto cropMode está ativo, `displaySnapshot` renderiza o frame com
            geometry.crop=null (ver comentário acima) — um frame DIFERENTE do frame final em que as
            frações das anotações foram desenhadas. Deixar a camada montada nesse momento mostrava as
            anotações deslocadas/fora de escala (glitch visual real, achado no quality review) até o
            usuário sair do modo Cortar. Cortar/Aplicar já limpam `annotations` com confirm quando há
            alguma (ver handleCropApply) — então escondê-las ENQUANTO o modo está aberto não perde nada,
            só evita mostrar uma posição temporariamente errada. Mesmo raciocínio pro antes/depois
            (review, bloqueante 1): enquanto `showOriginal`, o frame renderizado é o NEUTRO da base —
            também DIFERENTE do frame em que as anotações foram desenhadas (elas fazem parte da edição,
            não do "original"). Sem esconder aqui, as anotações apareceriam fora de posição por cima da
            foto original enquanto o dedo segura. */}
        {/* Relógio do Slim Black iOS: parte do look do filtro (r4) — some junto com o filtro nos
            modos que mostram OUTRO frame (crop/antes-e-depois), igual às anotações. Instante e
            intensidade vêm do snapshot (bloqueantes 2/4). */}
        {!cropMode && !showOriginal && filterIsClock && clockAppliedAt !== null && history.present.filter && (
          <ClockOverlay
            canvasRef={canvasRef}
            containerRef={canvasWrapRef}
            appliedAt={clockAppliedAt}
            intensity={history.present.filter.intensity}
          />
        )}
        {!cropMode && !showOriginal && (
          <AnnotationCanvas
            canvasRef={canvasRef}
            containerRef={canvasWrapRef}
            present={history.present}
            dispatch={dispatchEdit}
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
                dispatch={dispatchEdit}
                onEnterCrop={() => { setShowOriginal(false); setCropMode(true); }}
                onStraightenDragChange={setShowStraightenGrid}
              />
            ) : activeTab === 'ajustes' ? (
              <AdjustPanel present={history.present} dispatch={dispatchEdit} />
            ) : activeTab === 'filtros' ? (
              <FilterPanel
                present={history.present}
                dispatch={dispatchEdit}
                image={image}
                onApplyPreset={handleApplyPreset}
                presetsVersion={presetsVersion}
              />
            ) : activeTab === 'anotar' ? (
              <AnnotatePanel
                present={history.present}
                dispatch={dispatchEdit}
                tool={annotateTool}
                // setShowOriginal(false) junto (release review, bloqueante 3): entrar no modo
                // Original sem ferramenta e SÓ ENTÃO selecionar uma deixava o editor num beco —
                // com ferramenta ativa o tap no canvas vira anotação (handleTapStart ignora), o
                // toggle nunca volta e o hint "toque para voltar" mente. Selecionar/trocar/desativar
                // ferramenta é intenção de EDIÇÃO — sai do modo Original como qualquer dispatch.
                onToolChange={(tool) => {
                  setShowOriginal(false);
                  setAnnotateTool(tool);
                }}
                color={annotateColor}
                onColorChange={setAnnotateColor}
                size={annotateSize}
                onSizeChange={setAnnotateSize}
              />
            ) : (
              <EnhancePanel
                present={history.present}
                dispatch={dispatchEdit}
                image={image}
                onNewBase={handleNewBase}
                basesCount={bases.length}
              />
            )}
          </div>

          <div className="editor-tabs">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`editor-tab${activeTab === tab.id ? ' active' : ''}`}
                data-testid={`tab-${tab.id}`}
                onClick={() => { setShowOriginal(false); setActiveTab(tab.id); }}
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
