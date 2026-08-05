// src/io/blobToBase64.ts — blob -> base64 SEM o prefixo "data:...;base64," (formato que o plugin
// Kotlin espera em `base64` e que o Filesystem espera em `data`). FileReader (não arrayBuffer+btoa
// manual) porque é a via nativa mais barata pra converter um Blob potencialmente grande (export
// full-res) sem estourar a pilha de argumentos de String.fromCharCode. Usado pelo export/share
// (Editor, T8) e pela gravação do input da IA em cache (EnhancePanel, T10).
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Falha ao ler o arquivo exportado.'));
    reader.onloadend = () => {
      const result = reader.result;
      if (typeof result !== 'string') return reject(new Error('Falha ao codificar o arquivo exportado.'));
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}
