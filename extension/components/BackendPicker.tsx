import { useState } from 'react';
import type { BackendId, BackendState, BackendStatus } from '@quack/shared';
import { FixSteps } from './FixSteps';

const STATE_LABEL: Record<BackendState, string> = {
  ready: 'Ready',
  not_logged_in: 'Not logged in',
  not_installed: 'Not installed',
};

export function StatusDot({ state }: { state: BackendState }) {
  return <span className={`dot ${state === 'ready' ? 'ok' : 'warn'}`} aria-hidden="true" />;
}

/**
 * Every backend is listed. Ones that aren't ready can't be selected; instead
 * they show why, with the commands to fix it and a Recheck button.
 */
export function BackendPicker({
  backends,
  selected,
  onSelect,
  onRecheck,
}: {
  backends: BackendStatus[];
  selected: BackendId;
  onSelect: (id: BackendId) => void;
  onRecheck: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<BackendId | null>(null);
  const current = backends.find((b) => b.id === selected);

  return (
    <div className="picker">
      <button className="picker-button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        {current ? (
          <>
            <StatusDot state={current.state} /> {current.label}
            {current.state !== 'ready' && <span className="muted"> · {STATE_LABEL[current.state]}</span>}
          </>
        ) : (
          'Backend'
        )}{' '}
        ▾
      </button>
      {open && (
        <div className="picker-menu" role="listbox" aria-label="AI backend">
          {backends.map((b) => {
            const ready = b.state === 'ready';
            return (
              <div key={b.id} className={`picker-item ${b.id === selected ? 'selected' : ''}`}>
                <button
                  role="option"
                  aria-selected={b.id === selected}
                  aria-disabled={!ready}
                  className={ready ? '' : 'disabled'}
                  onClick={() => {
                    if (ready) {
                      onSelect(b.id);
                      setOpen(false);
                    } else {
                      setExpanded(expanded === b.id ? null : b.id);
                    }
                  }}
                >
                  <StatusDot state={b.state} /> {b.label}
                  <span className="muted small"> {STATE_LABEL[b.state]}</span>
                  {b.version && <span className="muted small"> · {b.version}</span>}
                </button>
                {!ready && (expanded === b.id || b.id === selected) && (
                  <div className="picker-fix small">
                    <FixSteps steps={b.fixSteps} />
                    <button onClick={onRecheck}>Recheck</button>
                  </div>
                )}
                {!ready && expanded !== b.id && b.id !== selected && (
                  <div className="muted small picker-reason">Click for how to fix</div>
                )}
              </div>
            );
          })}
          <div className="picker-footer">
            <button className="link small" onClick={onRecheck}>
              Recheck all
            </button>
            <span className="muted small">Switching backend starts a new thread.</span>
          </div>
        </div>
      )}
    </div>
  );
}
