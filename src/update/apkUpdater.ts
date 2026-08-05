// src/update/apkUpdater.ts — atualização in-app (T13): checa a última release no GitHub, baixa o
// APK dentro do próprio app (via plugin nativo `ApkInstaller`, com progresso) e dispara o instalador
// do sistema. Fora do Android nativo (web/dev) não há PackageInstaller — cai pro fallback de abrir a
// URL do APK direto no navegador.
import { App } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';

// Repo público onde a T12 publica as releases (tag vX.Y.Z + asset .apk).
const REPO = 'weslleybertoldo/picmax';
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

export interface ApkInstallerPlugin {
  download(options: { url: string }): Promise<{ path: string }>;
  install(options: { path: string }): Promise<void>;
  canInstall(): Promise<{ granted: boolean }>;
  openInstallSettings(): Promise<void>;
  addListener(
    eventName: 'downloadProgress',
    listenerFunc: (data: { percent: number }) => void,
  ): Promise<{ remove: () => void }>;
}

const ApkInstaller = registerPlugin<ApkInstallerPlugin>('ApkInstaller');

export interface UpdateInfo {
  version: string;
  apkUrl: string;
  notes: string;
}

function isNativeAndroid(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

// Versão instalada: no nativo usa o metadata real do APK (App.getInfo — pode divergir do bundle web
// se o usuário abriu um APK velho com JS mais novo/vice-versa); __APP_VERSION__ (injetado pelo Vite a
// partir do package.json, ver vite.config.ts) é o fallback pra web/dev e pro caso raro do plugin falhar.
async function getCurrentVersion(): Promise<string> {
  if (Capacitor.isNativePlatform()) {
    try {
      const info = await App.getInfo();
      if (info?.version) return info.version;
    } catch {
      // plugin @capacitor/app indisponível (build antiga) — segue pro fallback abaixo
    }
  }
  return __APP_VERSION__;
}

function parseSemver(v: string): [number, number, number] {
  const [a, b, c] = v.replace(/^v/, '').split('.').map((n) => Number(n) || 0);
  return [a ?? 0, b ?? 0, c ?? 0];
}

function isNewer(remote: string, local: string): boolean {
  const [r0, r1, r2] = parseSemver(remote);
  const [l0, l1, l2] = parseSemver(local);
  if (r0 !== l0) return r0 > l0;
  if (r1 !== l1) return r1 > l1;
  return r2 > l2;
}

interface GithubAsset {
  name: string;
  browser_download_url: string;
}

interface GithubRelease {
  tag_name?: string;
  body?: string;
  assets?: GithubAsset[];
}

// Timeout do fetch da release (review T13, fix 2): sem isso, rede travada deixa o spinner do rodapé
// (e o check silencioso de boot) presos indefinidamente — o AbortController força a desistência.
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Release mais nova existe, mas ainda não tem asset `.apk` (ex.: a T12 publicou a tag antes de subir
 * o binário). Erro distinto de falha de rede/API pra o chamador poder diferenciar a mensagem
 * (review T13, fix 3: "Nenhum APK disponível ainda" ≠ "Não foi possível verificar agora").
 */
export class NoApkAssetError extends Error {
  readonly version: string;

  constructor(version: string) {
    super(`release ${version} sem asset .apk`);
    this.name = 'NoApkAssetError';
    this.version = version;
  }
}

async function fetchLatestRelease(): Promise<GithubRelease> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(RELEASES_URL, { cache: 'no-store', signal: controller.signal });
    if (!res.ok) throw new Error(`github_${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Busca a última release publicada no GitHub e compara com a versão instalada.
 * Retorna null quando já está na versão mais recente; lança `NoApkAssetError` quando a release é mais
 * nova mas ainda não tem o binário, ou um erro genérico em falha de rede/API/timeout (10s) — o
 * chamador decide como comunicar (ver rodapé da Home e o banner de boot).
 */
export async function checkLatest(): Promise<UpdateInfo | null> {
  const release = await fetchLatestRelease();

  const remoteVersion = (release.tag_name || '').replace(/^v/, '');
  if (!remoteVersion) throw new Error('sem_tag_name');

  const current = await getCurrentVersion();
  if (!isNewer(remoteVersion, current)) return null;

  const apkAsset = (release.assets || []).find((a) => a.name.endsWith('.apk'));
  if (!apkAsset) throw new NoApkAssetError(remoteVersion);

  return {
    version: remoteVersion,
    apkUrl: apkAsset.browser_download_url,
    notes: release.body || '',
  };
}

export type InstallResult = 'installed' | 'permission' | 'fallback';

/**
 * Baixa o APK e dispara o instalador do sistema (Android nativo). Fora do Android — web/dev/iOS —
 * não existe instalador, então só abre a URL (o navegador trata o download).
 */
export async function downloadAndInstall(
  url: string,
  onProgress?: (percent: number) => void,
): Promise<InstallResult> {
  if (!isNativeAndroid()) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return 'fallback';
  }

  let granted = true;
  try {
    const res = await ApkInstaller.canInstall();
    granted = res.granted;
  } catch {
    // plugin indisponível (ex.: usuário ainda está num APK anterior à T13, sem o plugin nativo) —
    // segue e deixa download/install falharem de forma explícita em vez de bloquear aqui.
    granted = true;
  }
  if (!granted) {
    await ApkInstaller.openInstallSettings();
    return 'permission';
  }

  const listener = await ApkInstaller.addListener('downloadProgress', (d) => {
    onProgress?.(d.percent);
  });
  try {
    const { path } = await ApkInstaller.download({ url });
    await ApkInstaller.install({ path });
    return 'installed';
  } finally {
    listener.remove();
  }
}
