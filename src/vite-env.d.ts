/// <reference types="vite/client" />

// Injetada em build-time por vite.config.ts (`define`) a partir da versão do package.json —
// usada no rodapé da Home e na comparação de update (src/update/apkUpdater.ts).
declare const __APP_VERSION__: string;
