// src/tools/useSliderGesture.ts — gesto compartilhado de slider: baseline no início, preview ao
// arrastar, commit (revert-then-set) ao soltar, cancelamento em pointercancel/blur.
// Extraído do AdjustPanel/FilterPanel (T5 review): mesma coreografia, agora reusada pela T6
// (Endireitar) sem duplicar a lógica de baseline/revert-then-set.
import { useRef } from 'react';

// O hook NÃO guarda o valor "vivo" atual — isso continua responsabilidade de quem chama (via
// getCurrent/onPreview/onSet), porque o AdjustPanel precisa de UM liveRef compartilhado entre os 9
// sliders (2 dedos arrastando sliders DIFERENTES no mesmo tick de dispatch batelado do React 18 —
// ver comentário original no AdjustPanel). Cada slider tem sua PRÓPRIA instância do hook (seu próprio
// baseline), mas todas leem/escrevem o mesmo liveRef do componente pai através destes callbacks.
export interface SliderGestureConfig<T> {
  // valor+alvo ATUAIS (fonte de verdade síncrona, não a prop `present` da última render).
  getCurrent: () => { target: T; value: number } | null;
  onPreview: (value: number) => void; // dispatch 'preview' pro alvo atual
  onSet: (value: number) => void;     // dispatch 'set' pro alvo atual
}

export interface SliderGestureHandlers {
  captureBaseline: () => void;
  preview: (value: number) => void;
  commit: (value: number) => void;
  cancelGesture: () => void;
}

export function useSliderGesture<T>(config: SliderGestureConfig<T>): SliderGestureHandlers {
  // ref pra sempre chamar os callbacks/getCurrent MAIS RECENTES (evita closures presas na render em
  // que o gesto começou — pointerup pode disparar várias renders depois do pointerdown).
  const configRef = useRef(config);
  configRef.current = config;
  // alvo+valor ANTES do gesto atual, capturado no pointerdown/keydown; null = nenhum gesto em andamento.
  const baselineRef = useRef<{ target: T; value: number } | null>(null);

  function captureBaseline() {
    if (baselineRef.current !== null) return; // gesto já em andamento (ex.: segundo pointerdown sem soltar)
    const current = configRef.current.getCurrent();
    if (current) baselineRef.current = current;
  }

  // Fix do review da T5 (Minor): se já existe um baseline em andamento, só aplica o preview quando o
  // alvo ATUAL ainda é o mesmo que o do baseline. Sem essa checagem, um dedo que continua arrastando
  // (eventos 'input' seguem chegando pro MESMO elemento — captura implícita de ponteiro do
  // input[type=range]) depois que outro dedo trocou o alvo (ex.: tocou outro card de filtro)
  // continuaria disparando 'preview' pro alvo NOVO com o valor do arraste do alvo ANTIGO — corrompendo
  // visualmente o alvo errado mesmo que o commit final seja descartado (ver abaixo). Sem baseline
  // (nenhum gesto em andamento — chamada direta, fora de um pointerdown/keydown) aplica normalmente.
  // NOTA: descartar aqui não força um re-render — o <input type=range> é controlado (`value={...}`),
  // então sua posição visual só resincroniza no PRÓXIMO re-render de qualquer origem. Num gesto
  // descartado, o thumb pode ficar visualmente parado na última posição arrastada até essa próxima
  // atualização (quirk conhecido de controlled input durante drag, já documentado no AdjustPanel) —
  // não é um bug de dados: `present`/histórico permanecem corretos, só o visual do thumb fica atrasado.
  function preview(value: number) {
    const baseline = baselineRef.current;
    if (baseline) {
      const current = configRef.current.getCurrent();
      if (!current || current.target !== baseline.target) return;
    }
    configRef.current.onPreview(value);
  }

  // Revalida que o ALVO no fim do gesto é o MESMO de quando o baseline foi capturado. Multi-touch pode
  // trocar o alvo no meio do caminho (ex.: dedo A arrasta a intensidade do filtro "P&B", dedo B toca o
  // card "Quente" — o alvo do slider passa a ser "quente" antes do dedo A soltar). Sem essa checagem,
  // o commit do dedo A aplicaria seu baseline (intensidade do P&B) por cima do filtro errado. Alvo
  // divergente → descarta o baseline, SEM commitar e SEM reverter (o gesto do outro alvo, se houver,
  // segue intocado — e o preview() acima já bloqueou qualquer corrupção intermediária do alvo novo).
  function commit(value: number) {
    const baseline = baselineRef.current;
    baselineRef.current = null;
    if (!baseline) return;
    const current = configRef.current.getCurrent();
    if (!current || current.target !== baseline.target) return;
    if (baseline.value === value) return; // gesto sem mudança real: não registra entrada vazia no histórico
    // 'preview' já reescreveu o valor vivo pro valor arrastado — reverte pro baseline num dispatch de
    // 'preview' ANTES do 'set', senão o 'set' empilharia esse MESMO valor em `past` (present já
    // mutado), virando um no-op (1º undo não desfaria nada). Ver comentário original no AdjustPanel.
    configRef.current.onPreview(baseline.value);
    configRef.current.onSet(value);
  }

  // Gesto interrompido sem soltura normal (pointercancel / blur no meio de um keydown sem keyup):
  // reverte o preview pro baseline e descarta o gesto SEM registrar 'set'. Mesma checagem de alvo do
  // commit — se o alvo já mudou, não há o que reverter (reverter agora corromperia o alvo NOVO).
  function cancelGesture() {
    const baseline = baselineRef.current;
    baselineRef.current = null;
    if (!baseline) return;
    const current = configRef.current.getCurrent();
    if (!current || current.target !== baseline.target) return;
    configRef.current.onPreview(baseline.value);
  }

  return { captureBaseline, preview, commit, cancelGesture };
}
