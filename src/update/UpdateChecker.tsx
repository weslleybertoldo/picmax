// src/update/UpdateChecker.tsx — banner flutuante discreto: checa update em background ao abrir o
// app (só nativo — no navegador não há PackageInstaller) e, se houver uma versão mais nova, oferece
// atualizar. Coexiste com a verificação manual do rodapé da Home (Home.tsx) — são os 2 juntos, não
// um ou outro: este cobre "abri o app e nem lembrei de checar", o rodapé cobre "quero checar agora".
import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { checkLatest, downloadAndInstall, type UpdateInfo } from './apkUpdater';

export default function UpdateChecker() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [needsPerm, setNeedsPerm] = useState(false);

  useEffect(() => {
    // Web/dev: sem instalador de APK — não vale a pena nem checar (fallback seria abrir o navegador
    // sem o usuário ter pedido nada, no boot; ruído sem benefício).
    if (!Capacitor.isNativePlatform()) return;
    checkLatest()
      .then(setUpdate)
      .catch(() => {
        // Sem internet ou API fora do ar — falha silenciosa; o rodapé da Home permite tentar de novo.
      });
  }, []);

  async function handleUpdate() {
    if (!update) return;
    setNeedsPerm(false);
    setProgress(0);
    try {
      const result = await downloadAndInstall(update.apkUrl, setProgress);
      if (result === 'permission') setNeedsPerm(true);
    } catch {
      // silencioso — o usuário pode tentar de novo pelo rodapé da Home
    } finally {
      setProgress(null);
    }
  }

  if (!update || dismissed) return null;

  return (
    <div className="update-banner" data-testid="update-banner">
      <div className="update-banner-header">
        <p className="update-banner-title">Nova versão v{update.version} disponível</p>
        <button
          type="button"
          className="update-banner-close"
          aria-label="Fechar"
          onClick={() => setDismissed(true)}
        >
          ×
        </button>
      </div>

      {progress !== null ? (
        <div className="update-banner-progress">
          <div className="update-banner-progress-track">
            <div className="update-banner-progress-fill" style={{ width: `${progress}%` }} />
          </div>
          <p className="update-banner-progress-label">
            {progress < 100 ? `Baixando ${progress}%` : 'Abrindo instalador…'}
          </p>
        </div>
      ) : (
        <div className="update-banner-actions">
          {needsPerm && (
            <p className="update-banner-hint">
              Permita "instalar apps desconhecidos" nas configurações que abriram e toque em
              Atualizar de novo.
            </p>
          )}
          <button
            type="button"
            data-testid="update-banner-update"
            className="btn btn-primary update-banner-btn"
            onClick={handleUpdate}
          >
            {needsPerm ? 'Tentar novamente' : 'Atualizar'}
          </button>
          <button
            type="button"
            data-testid="update-banner-later"
            className="btn btn-secondary update-banner-btn"
            onClick={() => setDismissed(true)}
          >
            Depois
          </button>
        </div>
      )}
    </div>
  );
}
