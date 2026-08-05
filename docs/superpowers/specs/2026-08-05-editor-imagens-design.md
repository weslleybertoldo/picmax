# FotoLab — Editor de Imagens Android Offline

**Data:** 2026-08-05 · **Status:** aprovado (design validado com Weslley)
**Nome provisório:** FotoLab (renomeável antes do release)

## Objetivo

APK Android de edição de imagens **100% offline**, completo (corte, ajustes, anotações), com dois diferenciais:

1. **Melhorar** — dois modos: "Melhorar qualidade" (auto-ajuste instantâneo) e "Melhorar qualidade com IA" (super-resolução Real-ESRGAN on-device).
2. **Filtros com intensidade** — tocar aplica o filtro a 100%; slider abaixo mistura original↔filtrado (0–100%).

Extra: **Modelos de edição** — salvar o conjunto de ajustes+filtro como preset nomeado e reaplicar em outras fotos.

Sem backend, sem API paga, sem coleta de dados. Distribuição: APK direto (sem Play Store).

## Stack

- **Capacitor 7 + Vite + React + TypeScript** (mesmo padrão de PhysiqCalc/NutriTrack).
- **Plugin Capacitor nativo (Kotlin)** só para a IA: Real-ESRGAN via NCNN/Vulkan.
- Projeto pessoal: TDD não obrigatório; validação por smoke test em device (APK debug).

## Arquitetura

### Pipeline de edição (não-destrutivo)

- A imagem original nunca é alterada. O estado da edição é uma **pilha de operações** (JSON serializável):
  `{ crop?, rotate?, flip?, resize?, adjustments: {...}, filter: {id, intensity}, annotations: [...] }`
- **Preview**: renderizado em canvas WebGL na resolução da tela (rápido, sliders em tempo real).
- **Export**: mesma pilha reaplicada na resolução total da imagem.
- Undo/redo = histórico da pilha.

### Módulos (web)

| Módulo | Responsabilidade |
|---|---|
| `engine/` | Render WebGL: shaders de ajustes, filtros (mix por intensidade), aplicação de crop/transform |
| `tools/basic` | Cortar, girar 90°, espelhar, redimensionar, endireitar (straighten com grade) |
| `tools/adjust` | Sliders: brilho, contraste, saturação, exposição, temperatura, sombras, realces, nitidez, vinheta |
| `tools/annotate` | Camada separada (canvas 2D): desenho livre, texto (fonte/cor/tamanho), setas/formas, borracha |
| `tools/filters` | ~20 filtros predefinidos + slider de intensidade |
| `tools/enhance` | "Melhorar qualidade" (web) e "Melhorar qualidade com IA" (chama plugin nativo) |
| `presets/` | Modelos de edição do usuário (salvar/listar/aplicar/excluir) |
| `io/` | Abrir da galeria/câmera, exportar via MediaStore, compartilhar |

### Filtros (requisito central)

- ~20 filtros: P&B, sépia, vintage, quente, frio, cinema, vívido, fade, dramático etc. Implementados como shader/LUT.
- Grade de miniaturas (thumbnail da própria foto com o filtro aplicado).
- **Tocar no filtro → aplica com intensidade 100%** e aparece o slider logo abaixo.
- **Slider 0–100**: interpola pixel a pixel entre imagem sem filtro (0) e com filtro pleno (100). Mover à esquerda suaviza até sumir.
- Trocar de filtro reseta a intensidade para 100%.

### Melhorar (2 modos)

1. **Melhorar qualidade** (instantâneo, web): auto-contraste (equalização suave) + saturação leve + nitidez (unsharp mask). Aplica como operações na pilha — dá pra desfazer.
2. **Melhorar qualidade com IA** (plugin nativo `ImageEnhancer`):
   - Modelo **realesr-general-x4v3** (NCNN, ~5MB) embarcado no APK.
   - Execução via Vulkan (GPU); **fallback CPU** se o aparelho não suportar Vulkan (mais lento, com aviso).
   - Processamento em **tiles** para não estourar memória em foto grande.
   - Barra de progresso via callback do plugin; cancelável.
   - Resultado entra na pilha como operação (desfazível). Roda sobre a imagem original + operações anteriores.

### Modelos de edição (presets do usuário)

- Salvar: nome + snapshot de `adjustments` + `filter{id, intensity}` (crop, resize e anotações **não** entram — são específicos da foto; enhance IA também não entra, é pesado e por foto).
- Persistência: Capacitor Preferences (JSON local).
- Aplicar: sobrescreve ajustes/filtro atuais da foto aberta (com undo).
- Gerenciar: listar, renomear, excluir.

### Export

- Salvar cópia na galeria via MediaStore (álbum "FotoLab"), JPEG qualidade 90 (PNG se original for PNG). Original intocado.
- Botão compartilhar (share sheet nativo).

## Telas

1. **Início**: abrir da galeria / tirar foto / lista de modelos de edição.
2. **Editor**: imagem central + toolbar inferior com abas (Básico · Ajustes · Filtros · Anotar · Melhorar) + topo (undo/redo, salvar modelo, exportar/compartilhar).
3. **Modais**: salvar modelo (nome), progresso da IA, confirmação de descarte.

## Tratamento de erros

- Foto muito grande: trabalhar com versão reduzida no preview; export em tiles; limite duro documentado (ex.: 64MP).
- IA: sem Vulkan → CPU com aviso de lentidão; falta de memória → reduzir tile; erro → toast e imagem intacta.
- Sair sem salvar → confirmação.
- Permissões de mídia negadas → tela explicativa com botão para configurações.

## Fora de escopo (v1)

- Play Store, update in-app automático (padrão dos outros apps — pode vir em v2).
- Stickers/emojis, blur seletivo, mosaico (grupo "Extras" ficou de fora por decisão do Weslley).
- Edição de vídeo, colagens, remoção de objetos/fundo.

## Critérios de sucesso

- Editar foto de 12MP com sliders fluidos (preview ≥30fps em aparelho médio).
- IA melhora foto 2MP em <30s em aparelho médio com Vulkan.
- Filtro + slider de intensidade funcionando exatamente como descrito (toque = 100%, slider suaviza até 0).
- Modelo salvo numa foto reproduz o mesmo visual em outra foto.
- APK final ≤ ~60MB.
