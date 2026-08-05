// src/presets/PresetsPanel.tsx — lista de modelos salvos (T11), usada em 2 lugares:
// (a) Editor, seção "Meus modelos" no topo da aba Filtros (variant="inline", cards horizontais,
//     tocar APLICA o modelo via onApply); some inteira quando a lista está vazia (sem `emptyMessage`).
// (b) Home, aba "Meus modelos" (variant="list", lista vertical); não há edição em curso pra aplicar,
//     então tocar só mostra um hint — por isso `onApply` é opcional.
// Renomear/excluir: botão ⋮ em cada card abre um mini-menu (mais confiável que long-press em WebView).
// Renomear reusa o mesmo padrão de modal (text-modal-backdrop/text-modal) do texto de anotação
// (AnnotationCanvas.tsx) e do progresso da IA (EnhancePanel.tsx); excluir usa window.confirm, o mesmo
// padrão já usado em handleCropApply/clearAnnotations.
import { useEffect, useState } from 'react';
import { deletePreset, listPresets, renamePreset, type EditPreset } from './presets';

export interface PresetsPanelProps {
  variant: 'inline' | 'list';
  // Presente (Editor): tocar num card aplica o modelo. Ausente (Home): tocar mostra um hint, já que
  // não há uma edição em curso pra aplicar.
  onApply?: (preset: EditPreset) => void;
  // Incrementa pra forçar reler o storage sem remontar o componente (ex.: salvou um modelo novo com a
  // aba Filtros já montada — mesma técnica do `retryToken` em FilterPanel.tsx).
  refreshKey?: number;
  // Título opcional acima da lista (Editor usa "Meus modelos"; Home já mostra o próprio título fora
  // deste componente, pra não duplicar).
  title?: string;
  // Se ausente, a seção inteira (título incluso) some quando não há modelos salvos — spec da aba
  // Filtros do Editor. Se presente (Home), mostra essa mensagem no lugar da lista vazia.
  emptyMessage?: string;
}

export default function PresetsPanel({ variant, onApply, refreshKey, title, emptyMessage }: PresetsPanelProps) {
  const [presets, setPresets] = useState<EditPreset[]>([]);
  const [menuFor, setMenuFor] = useState<EditPreset | null>(null); // ⋮ aberto: menu Renomear/Excluir/Cancelar
  const [renameTarget, setRenameTarget] = useState<EditPreset | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listPresets().then((list) => {
      if (!cancelled) setPresets(list);
    });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(null), 3000);
    return () => clearTimeout(t);
  }, [hint]);

  function selectPreset(p: EditPreset) {
    if (onApply) onApply(p);
    else setHint('Abra uma foto para aplicar');
  }

  function openRename(p: EditPreset) {
    setRenameValue(p.name);
    setRenameTarget(p);
    setMenuFor(null);
  }

  async function confirmRename() {
    const name = renameValue.trim().slice(0, 40);
    if (!name || !renameTarget) return;
    await renamePreset(renameTarget.id, name);
    setRenameTarget(null);
    setPresets(await listPresets());
  }

  async function handleDelete(p: EditPreset) {
    setMenuFor(null);
    if (!window.confirm(`Excluir o modelo "${p.name}"? Essa ação não pode ser desfeita.`)) return;
    await deletePreset(p.id);
    setPresets(await listPresets());
  }

  if (presets.length === 0) {
    if (!emptyMessage) return null; // spec Editor: seção some por completo quando vazia
    return <p className="presets-empty" data-testid="presets-empty">{emptyMessage}</p>;
  }

  return (
    <div className="presets-panel" data-testid="presets-panel">
      {title && <h2 className="presets-title">{title}</h2>}
      <div className={variant === 'inline' ? 'presets-row' : 'presets-list'} data-testid="presets-cards">
        {presets.map((p) => (
          <div key={p.id} className="preset-card" data-testid={`preset-${p.id}`}>
            <button type="button" className="preset-card-main" onClick={() => selectPreset(p)}>
              <span className="preset-card-name">{p.name}</span>
            </button>
            <button
              type="button"
              className="btn btn-icon preset-card-menu"
              aria-label={`Opções de ${p.name}`}
              data-testid={`preset-menu-${p.id}`}
              onClick={() => setMenuFor(p)}
            >
              ⋮
            </button>
          </div>
        ))}
      </div>

      {hint && (
        <p className="presets-hint" data-testid="presets-hint">
          {hint}
        </p>
      )}

      {menuFor && (
        <div className="text-modal-backdrop" data-testid="preset-menu-modal">
          <div className="text-modal">
            <p className="preset-menu-title">{menuFor.name}</p>
            <button
              type="button"
              className="btn btn-secondary"
              data-testid="preset-menu-rename"
              onClick={() => openRename(menuFor)}
            >
              Renomear
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              data-testid="preset-menu-delete"
              onClick={() => handleDelete(menuFor)}
            >
              Excluir
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              data-testid="preset-menu-cancel"
              onClick={() => setMenuFor(null)}
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {renameTarget && (
        <div className="text-modal-backdrop" data-testid="preset-rename-modal">
          <div className="text-modal">
            <input
              type="text"
              className="text-modal-input"
              data-testid="preset-rename-input"
              autoFocus
              maxLength={40}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder="Nome do modelo"
            />
            <div className="text-modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                data-testid="preset-rename-cancel"
                onClick={() => setRenameTarget(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn btn-primary"
                data-testid="preset-rename-ok"
                disabled={!renameValue.trim()}
                onClick={confirmRename}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
