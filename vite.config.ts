import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
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
