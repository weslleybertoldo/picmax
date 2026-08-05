import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

// versão exposta ao app (rodapé + comparação de update, T13) — lida do package.json em build-time
// pra não duplicar a versão em dois lugares.
const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [react()],
  build: {
    // WebView de sistema em devices reais com minSdk 29 pode ser bem mais antiga que o Chromium do
    // browser de dev (achado real em smoke em emulador Android 11: Chrome 83/2020 não parseia
    // `||=`/`&&=`/`??=` — ES2021 — presentes no bundle default do esbuild/React 19). target: 'es2019'
    // faz o esbuild transpilar esses operadores (e outras sintaxes ES2020+) de volta pra formas
    // compatíveis, sem precisar de polyfills — cobre WebView até Chrome ~80.
    target: 'es2019',
  },
})
