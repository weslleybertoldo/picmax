// src/App.tsx — troca condicional Home/Editor (sem router); estado da imagem aberta vive aqui.
// T10: em vez de UMA imagem, um array de BASES — bases[0] = imagem aberta; cada resultado da IA
// (Real-ESRGAN 4x) entra como bases.push(novo) e o snapshot aponta pra base via baseVersion
// (índice). Undo/redo do baseVersion funciona porque as bases antigas continuam aqui, vivas.
import { useState } from 'react';
import Home from './screens/Home';
import Editor from './screens/Editor';
import UpdateChecker from './update/UpdateChecker';
import type { LoadedImage } from './io/openImage';

export default function App() {
  const [bases, setBases] = useState<LoadedImage[] | null>(null);
  // Resolução do export (v1.1): última escolha do usuário no modal do Exportar/Compartilhar
  // (null = Máxima). Vive AQUI (não no Editor) pra sobreviver a fechar/abrir fotos na MESMA sessão;
  // de propósito não persiste (sem Preferences) — cada sessão nova volta pra Máxima.
  const [exportMaxSide, setExportMaxSide] = useState<number | null>(null);

  // Fecha TODOS os ImageBitmap ao descartar a sessão de edição (volta pra Home). Bases antigas
  // NUNCA são fechadas durante a edição: undo pode voltar o baseVersion pra qualquer uma delas.
  // NÃO fechar dentro do Editor/useEffect: o renderer já copiou os pixels pra textura no setImage
  // (texImage2D não mantém referência viva ao bitmap), então fechar aqui é seguro; fechar durante o
  // efeito de montagem do Editor quebraria o StrictMode (setup→cleanup→setup na MESMA imagem faria o
  // 2º setImage do remount receber um bitmap já fechado).
  function handleBack() {
    bases?.forEach((b) => b.bitmap.close());
    setBases(null);
  }

  return (
    <>
      {bases ? (
        <Editor
          bases={bases}
          onAddBase={(img) => setBases((prev) => (prev ? [...prev, img] : [img]))}
          onBack={handleBack}
          exportMaxSide={exportMaxSide}
          onExportMaxSideChange={setExportMaxSide}
        />
      ) : (
        <Home onImage={(img) => setBases([img])} />
      )}
      {/* Check automático no boot (T13): SÓ na Home (review, fix 1) — no Editor o banner ficaria por
          cima da tab bar (Anotar/Melhorar), e não há como fechar/scrollar por baixo dela. Se o check
          terminar depois do usuário já ter entrado no Editor, o UpdateChecker desmonta sem mostrar
          nada; ele reaparece (com um novo check) no próximo boot ou ao voltar pra Home. */}
      {!bases && <UpdateChecker />}
    </>
  );
}
