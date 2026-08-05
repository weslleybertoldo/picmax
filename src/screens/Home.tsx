// src/screens/Home.tsx — tela inicial: abrir da galeria, tirar foto (e, em dev, imagem de teste)
import { useEffect, useRef, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import { CameraPermissionDeniedError, openImage, PhotoTooLargeError, type LoadedImage } from '../io/openImage';
import { ImageEnhancer } from '../native/imageEnhancer';
import PresetsPanel from '../presets/PresetsPanel';
import { checkLatest, downloadAndInstall, NoApkAssetError, type UpdateInfo } from '../update/apkUpdater';

// Erro de abertura (T12, review — gap 8): permissão negada ganha um botão "Abrir Configurações"
// (openAppSettings do plugin nativo — ImageEnhancerPlugin.kt) além do texto; os outros 2 casos
// (foto grande, erro genérico) são só texto, sem ação possível daqui.
interface HomeError {
  text: string;
  showSettingsButton: boolean;
}

// Resultado da verificação manual do rodapé — estado próprio p/ "release sem apk" (review T13, fix 3):
// sem isso, cairia no mesmo balde genérico de "erro de rede" e a mensagem ficaria enganosa.
type UpdateCheckResult =
  | { status: 'ok' }
  | { status: 'update'; info: UpdateInfo }
  | { status: 'no-apk' }
  | { status: 'error' };

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
  const [error, setError] = useState<HomeError | null>(null);
  // Acesso à lista de modelos (T11) sem precisar de uma foto aberta — troca a Home pra uma tela
  // simples de lista; tocar num modelo aqui não aplica nada (não há edição em curso), só mostra um
  // hint (ver PresetsPanel: `onApply` ausente = modo "view").
  const [showPresets, setShowPresets] = useState(false);

  // Botão físico de voltar (T12, review): sem listener próprio o plugin App tentaria voltar no
  // histórico do WebView (que esta SPA não usa) e cairia direto no exit — então a Home precisa do
  // SEU PRÓPRIO listener (o Editor tem o dele, ver Editor.tsx) pra: dentro de "Meus modelos" → só
  // fecha a lista (mesmo efeito do botão ← em tela); na Home "de baixo" → aí sim sai do app. Ref
  // porque o listener é registrado 1x mas precisa sempre ler o showPresets mais atual.
  const showPresetsRef = useRef(showPresets);
  showPresetsRef.current = showPresets;
  useEffect(() => {
    let handle: PluginListenerHandle | null = null;
    let cancelled = false;
    CapacitorApp.addListener('backButton', () => {
      if (showPresetsRef.current) setShowPresets(false);
      else CapacitorApp.exitApp(); // não implementado na web (chamado só quando o evento nativo dispara)
    }).then((h) => {
      if (cancelled) h.remove();
      else handle = h;
    });
    return () => {
      cancelled = true;
      handle?.remove();
    };
  }, []);

  // Rodapé (T13): verificação manual de atualização — separado do check automático de boot
  // (UpdateChecker.tsx, montado no App): aqui o usuário pede explicitamente, então mesmo "sem
  // update" e "erro" ganham feedback inline (o banner de boot não mostra nada nesses 2 casos).
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);
  const [updateNeedsPerm, setUpdateNeedsPerm] = useState(false);

  async function handleCheckUpdate() {
    setCheckingUpdate(true);
    setUpdateNeedsPerm(false);
    try {
      const info = await checkLatest();
      setUpdateResult(info ? { status: 'update', info } : { status: 'ok' });
    } catch (e) {
      setUpdateResult(e instanceof NoApkAssetError ? { status: 'no-apk' } : { status: 'error' });
    } finally {
      setCheckingUpdate(false);
    }
  }

  async function handleDownloadUpdate() {
    if (updateResult?.status !== 'update') return;
    setUpdateNeedsPerm(false);
    setUpdateProgress(0);
    try {
      const result = await downloadAndInstall(updateResult.info.apkUrl, setUpdateProgress);
      if (result === 'permission') setUpdateNeedsPerm(true);
    } catch {
      setUpdateResult({ status: 'error' });
    } finally {
      setUpdateProgress(null);
    }
  }

  async function handleOpen(source: 'gallery' | 'camera') {
    setError(null);
    setBusy(source);
    try {
      const image = await openImage(source);
      if (image) onImage(image);
    } catch (e) {
      // 3 casos distintos (T12): permissão negada ganha instrução + botão "Abrir Configurações"
      // (review, gap 8 — ImageEnhancer.openAppSettings, já que o app não pode reabrir o dialog de
      // permissão sozinho depois de "negar permanentemente"); foto grande demais precisa dizer QUAL é
      // o limite; qualquer outra falha (rede, hardware, decode) cai no genérico de sempre. Nenhum
      // deles mostra stack trace.
      if (e instanceof CameraPermissionDeniedError) {
        setError({
          text: `Permissão negada para ${source === 'camera' ? 'câmera' : 'galeria'}. Habilite o acesso nas Configurações do app e tente novamente.`,
          showSettingsButton: true,
        });
      } else if (e instanceof PhotoTooLargeError) {
        setError({ text: e.message, showSettingsButton: false });
      } else {
        setError({ text: 'Não foi possível abrir a imagem. Tente novamente.', showSettingsButton: false });
      }
    } finally {
      setBusy(null);
    }
  }

  // Plugin indisponível (ex.: web/dev) ou Intent falhando num device exótico — nada a fazer além de
  // deixar o texto (que já orienta o caminho manual) como está; nunca deixa um erro sem tratamento
  // borbulhar de um clique de botão.
  function handleOpenSettings() {
    ImageEnhancer.openAppSettings().catch(() => {});
  }

  async function handleTestImage() {
    setError(null);
    setBusy('test');
    try {
      const image = await makeTestImage();
      onImage(image);
    } catch {
      setError({ text: 'Não foi possível gerar a imagem de teste.', showSettingsButton: false });
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

      {error && (
        <div className="home-error">
          <p>{error.text}</p>
          {error.showSettingsButton && (
            <button
              type="button"
              className="btn btn-secondary home-error-settings"
              data-testid="open-app-settings"
              onClick={handleOpenSettings}
            >
              Abrir Configurações
            </button>
          )}
        </div>
      )}

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

      <footer className="home-footer">
        <p className="home-version">v{__APP_VERSION__}</p>
        <button
          type="button"
          className="home-update-check"
          data-testid="check-update"
          disabled={checkingUpdate}
          onClick={handleCheckUpdate}
        >
          <span className={checkingUpdate ? 'home-update-spin' : ''}>⟳</span>
          Verificar atualizações
        </button>

        {updateResult && (
          <div className="home-update-result" data-testid="update-result">
            {updateResult.status === 'error' ? (
              <p className="home-update-error">Não foi possível verificar agora.</p>
            ) : updateResult.status === 'no-apk' ? (
              <p className="home-update-noapk" data-testid="update-no-apk">
                Nenhum APK disponível ainda.
              </p>
            ) : updateResult.status === 'update' ? (
              updateProgress !== null ? (
                <div className="home-update-progress">
                  <div className="home-update-progress-track">
                    <div
                      className="home-update-progress-fill"
                      style={{ width: `${updateProgress}%` }}
                    />
                  </div>
                  <p className="home-update-progress-label">
                    {updateProgress < 100 ? `Baixando ${updateProgress}%` : 'Abrindo instalador…'}
                  </p>
                </div>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary home-update-download"
                  data-testid="download-update"
                  onClick={handleDownloadUpdate}
                >
                  {updateNeedsPerm ? 'Tentar novamente' : `Baixar v${updateResult.info.version}`}
                </button>
              )
            ) : (
              <p className="home-update-ok">✓ Versão mais recente</p>
            )}
          </div>
        )}
      </footer>
    </div>
  );
}
