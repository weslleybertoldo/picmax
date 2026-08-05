// src/App.tsx — troca condicional Home/Editor (sem router); estado da imagem aberta vive aqui.
import { useState } from 'react';
import Home from './screens/Home';
import Editor from './screens/Editor';
import type { LoadedImage } from './io/openImage';

export default function App() {
  const [image, setImage] = useState<LoadedImage | null>(null);

  if (image) {
    return <Editor image={image} onBack={() => setImage(null)} />;
  }
  return <Home onImage={setImage} />;
}
