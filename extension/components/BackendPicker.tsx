import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { BackendId, BackendState, BackendStatus } from '@quack/shared';
import { FixSteps } from './FixSteps';
import { Check, ChevronDown, Retry, Search } from './icons';

const STATE_LABEL: Record<BackendState, string> = {
  ready: 'Ready',
  not_logged_in: 'Not logged in',
  not_installed: 'Not installed',
};

export function backendLabel(id: BackendId): string {
  return id === 'cursor' ? 'Cursor' : 'Claude Code';
}

export function StatusDot({ tone }: { tone: 'ok' | 'warn' | 'err' | 'idle' }) {
  return <span className={`dot ${tone}`} aria-hidden="true" />;
}

/** Closes a menu on Escape or a click outside it. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  return ref;
}

function Menu({
  label,
  button,
  open,
  setOpen,
  disabled,
  align = 'left',
  children,
}: {
  label: string;
  button: ReactNode;
  open: boolean;
  setOpen: (open: boolean) => void;
  disabled?: boolean;
  align?: 'left' | 'right';
  children: ReactNode;
}) {
  const ref = useDismiss(open, () => setOpen(false));
  return (
    <div className="menu" ref={ref}>
      <button
        type="button"
        className={`picker-button ${open ? 'open' : ''}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        {button}
        <ChevronDown size={14} />
      </button>
      {open && <div className={`menu-popover ${align}`}>{children}</div>}
    </div>
  );
}

function secondsAgo(at: number | null, now: number): string {
  if (!at) return 'Not checked yet';
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 60 ? `Checked ${s} s ago` : `Checked ${Math.round(s / 60)} min ago`;
}

/**
 * Every backend is listed. Ones that aren't ready can't be picked; they say
 * why and expand into the commands that fix it.
 */
export function BackendPicker({
  backends,
  selected,
  companionVersion,
  checkedAt,
  offline,
  onSelect,
  onRecheck,
  onOpenChange,
}: {
  backends: BackendStatus[];
  selected: BackendId;
  companionVersion?: string;
  checkedAt: number | null;
  offline: boolean;
  onSelect: (id: BackendId) => void;
  onRecheck: () => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpenState] = useState(false);
  const [expanded, setExpanded] = useState<BackendId | null>(null);
  const setOpen = (o: boolean) => {
    setOpenState(o);
    onOpenChange?.(o);
  };
  const current = backends.find((b) => b.id === selected);

  const button = offline ? (
    <>
      <StatusDot tone="warn" /> No companion
    </>
  ) : (
    <>
      <StatusDot tone={!current ? 'idle' : current.state === 'ready' ? 'ok' : 'warn'} /> {current?.label ?? backendLabel(selected)}
    </>
  );

  return (
    <Menu label="AI backend" button={button} open={open} setOpen={setOpen} disabled={offline || !backends.length}>
      <div className="menu-head">
        <span className="menu-title">Backend</span>
        {companionVersion && <span className="muted">Companion v{companionVersion} · connected</span>}
      </div>
      <div role="listbox" aria-label="AI backend">
        {backends.map((b) => {
          const ready = b.state === 'ready';
          const isSelected = b.id === selected;
          const showFix = !ready && (expanded === b.id || isSelected);
          return (
            <div key={b.id} className={`menu-item-wrap ${ready ? '' : 'unavailable'}`}>
              <button
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`menu-item ${isSelected ? 'selected' : ''}`}
                onClick={() => {
                  if (ready) {
                    onSelect(b.id);
                    setOpen(false);
                  } else {
                    setExpanded(expanded === b.id ? null : b.id);
                  }
                }}
              >
                <span className="check">{isSelected && <Check size={16} />}</span>
                <span className="menu-item-label">{b.label}</span>
                <span className={`state ${ready ? 'ok' : 'warn'}`}>
                  <StatusDot tone={ready ? 'ok' : 'warn'} /> {STATE_LABEL[b.state]}
                </span>
              </button>
              {!ready && !showFix && <div className="menu-item-hint">{b.fixSteps[0]?.text ?? 'Not available'} · show how</div>}
              {showFix && (
                <div className="menu-item-fix">
                  <FixSteps steps={b.fixSteps} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <Now>
        {(now) => (
          <div className="menu-foot">
            <span className="muted">{secondsAgo(checkedAt, now)}</span>
            <button type="button" className="link" onClick={onRecheck}>
              <Retry size={14} /> Re-check
            </button>
          </div>
        )}
      </Now>
    </Menu>
  );
}

function Now({ children }: { children: (now: number) => ReactNode }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <>{children(now)}</>;
}

const CLAUDE_MODELS: Record<string, { name: string; description: string }> = {
  opus: { name: 'Opus', description: 'Most capable · slower' },
  sonnet: { name: 'Sonnet', description: 'Balanced · default' },
  haiku: { name: 'Haiku', description: 'Fastest · lighter questions' },
};
const CLAUDE_ORDER = ['opus', 'sonnet', 'haiku'];

export function modelLabel(backend: BackendId, model: string): string {
  if (!model) return 'Default model';
  return backend === 'claude-code' ? CLAUDE_MODELS[model]?.name ?? model : model;
}

export function ModelPicker({
  status,
  model,
  recent,
  disabled,
  onChange,
}: {
  status?: BackendStatus;
  model: string;
  recent: string[];
  disabled?: boolean;
  onChange: (model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const backend = status?.id ?? 'cursor';
  const pick = (m: string) => {
    onChange(m);
    setOpen(false);
  };
  return (
    <Menu
      label="Model"
      button={<span className={backend === 'cursor' ? 'mono' : ''}>{modelLabel(backend, model)}</span>}
      open={open}
      setOpen={setOpen}
      disabled={disabled || !status}
    >
      {status && open && (backend === 'claude-code' ? (
        <ClaudeModels status={status} model={model} onPick={pick} />
      ) : (
        <SearchableModels status={status} model={model} recent={recent} onPick={pick} />
      ))}
    </Menu>
  );
}

function ClaudeModels({ status, model, onPick }: { status: BackendStatus; model: string; onPick: (m: string) => void }) {
  const [custom, setCustom] = useState(CLAUDE_MODELS[model] ? '' : model);
  const ids = [...CLAUDE_ORDER.filter((m) => status.models.includes(m)), ...status.models.filter((m) => !CLAUDE_ORDER.includes(m))];
  return (
    <>
      <div className="menu-head">
        <span className="menu-title">Model · {status.label}</span>
      </div>
      <div role="listbox" aria-label="Model">
        {ids.map((id) => (
          <button
            key={id}
            type="button"
            role="option"
            aria-selected={id === model}
            className={`menu-item two-line ${id === model ? 'selected' : ''}`}
            onClick={() => onPick(id)}
          >
            <span className="check">{id === model && <Check size={16} />}</span>
            <span className="menu-item-label">
              <span>{CLAUDE_MODELS[id]?.name ?? (id || 'Default model')}</span>
              {CLAUDE_MODELS[id] && <span className="menu-item-sub">{CLAUDE_MODELS[id].description}</span>}
            </span>
          </button>
        ))}
      </div>
      <form
        className="menu-custom"
        onSubmit={(e) => {
          e.preventDefault();
          if (custom.trim()) onPick(custom.trim());
        }}
      >
        <label htmlFor="custom-model" className="menu-title">
          Custom model ID
        </label>
        <div className="row">
          <input
            id="custom-model"
            className="mono"
            value={custom}
            placeholder="Paste a model ID"
            spellCheck={false}
            onChange={(e) => setCustom(e.target.value)}
          />
          <button type="submit" className="secondary" disabled={!custom.trim()}>
            Use
          </button>
        </div>
      </form>
    </>
  );
}

function highlight(text: string, query: string): ReactNode {
  if (!query) return text;
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length)}
    </>
  );
}

function SearchableModels({
  status,
  model,
  recent,
  onPick,
}: {
  status: BackendStatus;
  model: string;
  recent: string[];
  onPick: (m: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(() => Math.max(0, status.models.indexOf(model)));
  const listRef = useRef<HTMLDivElement>(null);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return status.models.filter((m) => (m || 'default').toLowerCase().includes(q));
  }, [query, status.models]);
  const recentOthers = recent.filter((m) => m !== model && status.models.includes(m)).slice(0, 4);

  useEffect(() => {
    if (query) setActive(0);
  }, [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <>
      <div className="menu-search">
        <Search size={16} />
        <input
          autoFocus
          value={query}
          placeholder="Search models"
          aria-label="Search models"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, matches.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (matches[active] !== undefined) onPick(matches[active]);
              else if (query.trim()) onPick(query.trim());
            }
          }}
        />
        <span className="muted small">
          {matches.length} of {status.models.length}
        </span>
      </div>
      <div className="menu-list" role="listbox" aria-label="Model" ref={listRef}>
        {matches.map((m, i) => (
          <button
            key={m || 'default'}
            type="button"
            role="option"
            data-index={i}
            aria-selected={m === model}
            className={`menu-item mono ${i === active ? 'active' : ''}`}
            onMouseEnter={() => setActive(i)}
            onClick={() => onPick(m)}
          >
            <span className="check">{m === model && <Check size={16} />}</span>
            <span className="menu-item-label">{m ? highlight(m, query.trim()) : 'Default model'}</span>
            {m === model && <span className="muted small">Current</span>}
          </button>
        ))}
        {!matches.length && query.trim() && (
          <button type="button" className="menu-item mono active" onClick={() => onPick(query.trim())}>
            <span className="check" />
            <span className="menu-item-label">Use “{query.trim()}”</span>
          </button>
        )}
      </div>
      {recentOthers.length > 0 && (
        <div className="menu-recent">
          <span className="menu-title">Recently used</span>
          <div className="row">
            {recentOthers.map((m) => (
              <button key={m} type="button" className="pill mono" onClick={() => onPick(m)}>
                {m || 'default'}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="menu-foot">
        <span className="muted">{status.hint ? 'Built-in list' : `Live list from ${status.label}`}</span>
        <span className="muted">↑↓ move · ↵ pick</span>
      </div>
    </>
  );
}
