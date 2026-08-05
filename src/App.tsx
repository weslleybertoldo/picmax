// src/App.tsx — troca condicional Home/Editor (sem router); estado da imagem aberta vive aqui.
import { useState } from 'react';
import Home from './screens/Home';
import Editor from './screens/Editor';
import type { LoadedImage } from './io/openImage';

export default function App() {
  const [image, setImage] = useState<LoadedImage | null>(null);

  // Fecha o ImageBitmap ao descartar a imagem (volta pra Home ou troca por outra no futuro).
  // NÃO fechar dentro do Editor/useEffect: o renderer já copiou os pixels pra textura no setImage
  // (texImage2D não mantém referência viva ao bitmap), então fechar aqui é seguro; fechar durante o
  // efeito de montagem do Editor quebraria o StrictMode (setup→cleanup→setup na MESMA imagem faria o
  // 2º setImage do remount receber um bitmap já fechado).
  function handleBack() {
    image?.bitmap.close();
    setImage(null);
  }

  if (image) {
    return <Editor image={image} onBack={handleBack} />;
  }
  return <Home onImage={setImage} />;
}
