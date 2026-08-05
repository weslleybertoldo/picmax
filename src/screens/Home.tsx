// src/screens/Home.tsx — tela inicial: abrir da galeria, tirar foto (e, em dev, imagem de teste)
import { useState } from 'react';
import { openImage, type LoadedImage } from '../io/openImage';
import PresetsPanel from '../presets/PresetsPanel';

export interface HomeProps {
  onImage: (image: LoadedImage) => void;
}

type Busy = 'gallery' | 'camera' | 'test' | null;

// Gera uma imagem procedural 1024×768 (gradiente + círculos + marcador de canto) — só p/ validar
// o fluxo headless/emulador sem depender de galeria ou câmera reais.
async function makeTestImage(): Promise<LoadedImage> {
  const w = 1024, h = 768;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D não disponível');

  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, '#ff7a18');
  grad.addColorStop(0.5, '#ff2d78');
  grad.addColorStop(1, '#1e6bff');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  const circles: Array<[number, number, number, string]> = [
    [w * 0.2, h * 0.28, 90, '#ffd60a'],
    [w * 0.78, h * 0.3, 70, '#34c759'],
    [w * 0.5, h * 0.72, 120, '#bf5af2'],
    [w * 0.85, h * 0.85, 55, '#ffffff'],
  ];
  for (const [x, y, r, color] of circles) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 64, 64); // marcador de canto (valida orientação)

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob falhou'))), 'image/png');
  });
  const bitmap = await createImageBitmap(canvas);
  return { bitmap, blob, width: w, height: h };
}

export default function Home({ onImage }: HomeProps) {
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  // Acesso à lista de modelos (T11) sem precisar de uma foto aberta — troca a Home pra uma tela
  // simples de lista; tocar num modelo aqui não aplica nada (não há edição em curso), só mostra um
  // hint (ver PresetsPanel: `onApply` ausente = modo "view").
  const [showPresets, setShowPresets] = useState(false);

  async function handleOpen(source: 'gallery' | 'camera') {
    setError(null);
    setBusy(source);
    try {
      const image = await openImage(source);
      if (image) onImage(image);
    } catch {
      setError('Não foi possível abrir a imagem. Tente novamente.');
    } finally {
      setBusy(null);
    }
  }

  async function handleTestImage() {
    setError(null);
    setBusy('test');
    try {
      const image = await makeTestImage();
      onImage(image);
    } catch {
      setError('Não foi possível gerar a imagem de teste.');
    } finally {
      setBusy(null);
    }
  }

  // Tela "Meus modelos" (T11): substitui a Home inteira em vez de sobrepor — não há foto aberta aqui,
  // então não faz sentido dividir espaço com os botões de abrir imagem. Tocar num modelo não aplica
  // nada (PresetsPanel sem `onApply`): só mostra o hint "Abra uma foto para aplicar".
  if (showPresets) {
    return (
      <div className="home home-presets">
        <div className="home-presets-topbar">
          <button
            type="button"
            className="btn btn-icon"
            data-testid="presets-back"
            aria-label="Voltar"
            onClick={() => setShowPresets(false)}
          >
            ←
          </button>
          <h2 className="home-presets-title">Meus modelos</h2>
        </div>
        <div className="home-presets-body">
          <PresetsPanel variant="list" emptyMessage="Nenhum modelo salvo ainda." />
        </div>
      </div>
    );
  }

  return (
    <div className="home">
      <div className="home-brand">
        <h1 className="home-title">PicMax</h1>
        <p className="home-subtitle">Edição de imagens, 100% offline</p>
      </div>

      {error && <p className="home-error">{error}</p>}

      <div className="home-actions">
        <button
          type="button"
          className="btn btn-primary"
          data-testid="open-gallery"
          disabled={busy !== null}
          onClick={() => handleOpen('gallery')}
        >
          {busy === 'gallery' ? 'Abrindo…' : 'Abrir da galeria'}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          data-testid="open-camera"
          disabled={busy !== null}
          onClick={() => handleOpen('camera')}
        >
          {busy === 'camera' ? 'Abrindo câmera…' : 'Tirar foto'}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          data-testid="open-presets"
          disabled={busy !== null}
          onClick={() => setShowPresets(true)}
        >
          Meus modelos
        </button>
        {import.meta.env.DEV && (
          <button
            type="button"
            className="btn btn-dev"
            data-testid="open-test-image"
            disabled={busy !== null}
            onClick={handleTestImage}
          >
            {busy === 'test' ? 'Gerando…' : 'Imagem de teste (dev)'}
          </button>
        )}
      </div>
    </div>
  );
}
