import { cloneElement, isValidElement, useEffect, useId, useRef, useState, type ChangeEvent, type ReactElement, type ReactNode } from 'react';
import { X } from '@phosphor-icons/react';
import { useStore } from '../state/store';

export function Panel({
  title,
  subtitle,
  actions,
  children,
  flush,
  className,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
}) {
  return (
    <section className={className ? `panel ${className}` : 'panel'}>
      {title !== undefined && (
        <header className="panel-head">
          <div style={{ display: 'grid', gap: 1 }}>
            <span className="panel-title">{title}</span>
            {subtitle !== undefined && <span className="panel-sub">{subtitle}</span>}
          </div>
          <div style={{ flex: 1 }} />
          {actions}
        </header>
      )}
      <div className={flush ? 'panel-body flush' : 'panel-body'}>{children}</div>
    </section>
  );
}

export function Metric({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: 'up' | 'down' }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className={tone ? `metric-value ${tone}` : 'metric-value'}>{value}</span>
      {note !== undefined && <span className="metric-note">{note}</span>}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  const generated = useId();
  const errorId = `${generated}-error`;
  const childId = isValidElement(children) ? (children.props as { id?: string }).id : undefined;
  const controlId = htmlFor ?? childId ?? generated;
  // Only elements that accept an `id` and are labelable receive `htmlFor`.
  // Groups (Segmented, plain layout divs) are labelled with the field label
  // through `aria-labelledby` so the association is still announced.
  const childType = isValidElement(children) ? children.type : undefined;
  // The input primitives forward ARIA props through their own aliases, so an
  // error reaches them by name instead of as a dropped DOM attribute.
  const primitive =
    childType === TextInput || childType === TextArea || childType === NumberInput || childType === Select;
  const labelable =
    typeof childType === 'string'
      ? ['input', 'select', 'textarea', 'button'].includes(childType)
      : primitive || childType === Switch;

  if (!labelable) {
    const labelId = `${generated}-label`;
    return (
      <div
        className="field"
        role="group"
        aria-labelledby={labelId}
        aria-describedby={error !== undefined ? errorId : undefined}
      >
        <span className="field-label" id={labelId}>
          {label}
        </span>
        {children}
        {hint !== undefined && error === undefined && <span className="field-hint">{hint}</span>}
        {error !== undefined && (
          <span className="field-error" id={errorId}>
            {error}
          </span>
        )}
      </div>
    );
  }

  let control: ReactNode = children;
  if (isValidElement(children)) {
    const childProps = children.props as Record<string, unknown>;
    const nextProps: Record<string, unknown> = {};
    if (childId === undefined && htmlFor === undefined) nextProps.id = controlId;
    if (error !== undefined) {
      const descriptionKey = primitive ? 'ariaDescribedBy' : 'aria-describedby';
      const existing = typeof childProps[descriptionKey] === 'string' ? (childProps[descriptionKey] as string) : '';
      nextProps[primitive ? 'ariaInvalid' : 'aria-invalid'] = true;
      nextProps[descriptionKey] = existing ? `${existing} ${errorId}` : errorId;
    }
    if (Object.keys(nextProps).length > 0) {
      control = cloneElement(children as ReactElement<Record<string, unknown>>, nextProps);
    }
  }
  return (
    <div className="field">
      <label className="field-label" htmlFor={controlId}>
        {label}
      </label>
      {control}
      {hint !== undefined && error === undefined && <span className="field-hint">{hint}</span>}
      {error !== undefined && (
        <span className="field-error" id={errorId}>
          {error}
        </span>
      )}
    </div>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  id,
  type = 'text',
  min,
  max,
  step,
  disabled,
  ariaLabel,
  ariaInvalid,
  ariaDescribedBy,
  onKeyDown,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  id?: string;
  type?: 'text' | 'number' | 'date';
  min?: number | string;
  max?: number | string;
  step?: number | string;
  disabled?: boolean;
  ariaLabel?: string;
  /** Set by `Field` when the control has a validation error. */
  ariaInvalid?: boolean;
  /** Id of the error text rendered by `Field`. */
  ariaDescribedBy?: string;
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <input
      id={id}
      aria-label={ariaLabel}
      aria-invalid={ariaInvalid === true ? true : undefined}
      aria-describedby={ariaDescribedBy}
      className="input"
      type={type}
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
    />
  );
}

export function TextArea({
  value,
  onChange,
  placeholder,
  id,
  rows = 4,
  disabled,
  ariaLabel,
  ariaInvalid,
  ariaDescribedBy,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  id?: string;
  rows?: number;
  disabled?: boolean;
  ariaLabel?: string;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
}) {
  return (
    <textarea
      id={id}
      aria-label={ariaLabel}
      aria-invalid={ariaInvalid === true ? true : undefined}
      aria-describedby={ariaDescribedBy}
      className="input"
      rows={rows}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value)}
    />
  );
}

export function NumberInput({
  value,
  onChange,
  id,
  min,
  max,
  step = 1,
  disabled,
  placeholder,
  ariaInvalid,
  ariaDescribedBy,
}: {
  value: number;
  onChange: (value: number) => void;
  id?: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  placeholder?: string;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
}) {
  // The rendered text is a local draft so an empty field stays empty while the
  // operator types. Only parseable values are committed to the caller.
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (Number.isFinite(value) ? String(value) : '');
  return (
    <input
      id={id}
      className="input"
      type="number"
      aria-invalid={ariaInvalid === true ? true : undefined}
      aria-describedby={ariaDescribedBy}
      value={shown}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(event) => {
        const text = event.target.value;
        setDraft(text);
        if (text === '') return;
        const parsed = Number(text);
        if (Number.isFinite(parsed)) onChange(parsed);
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  id,
  disabled,
  ariaLabel,
  ariaInvalid,
  ariaDescribedBy,
}: {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
  id?: string;
  disabled?: boolean;
  ariaLabel?: string;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
}) {
  return (
    <select
      id={id}
      aria-label={ariaLabel}
      aria-invalid={ariaInvalid === true ? true : undefined}
      aria-describedby={ariaDescribedBy}
      className="select"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as T)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function Switch({ checked, onChange, label, id }: { checked: boolean; onChange: (checked: boolean) => void; label: string; id?: string }) {
  const generated = useId();
  const controlId = id ?? generated;
  return (
    <div className="toggle-row">
      <label className="field-label" htmlFor={controlId}>
        {label}
      </label>
      <button
        id={controlId}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className="switch"
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<{ value: T; label: string; title?: string }>;
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title ?? option.label}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Tag({ tone, children }: { tone?: 'accent' | 'up' | 'down' | 'warn'; children: ReactNode }) {
  return <span className={tone ? `tag ${tone}` : 'tag'}>{children}</span>;
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon}
      <span className="empty-title">{title}</span>
      <span className="empty-body">{body}</span>
      {action}
    </div>
  );
}

export function Skeleton({ width = '100%', height = 14 }: { width?: string | number; height?: number }) {
  return <div className="skeleton" style={{ width, height }} aria-hidden />;
}

/**
 * Open modals, in the order they were opened. Escape and the Tab trap belong
 * to the topmost modal only, so a dialog opened from another dialog (for
 * example "Compare symbols" -> "Download market data") cannot dismiss its host
 * when the user closes the child.
 */
const openModalStack: string[] = [];

function registerModal(id: string) {
  if (!openModalStack.includes(id)) openModalStack.push(id);
}

function unregisterModal(id: string) {
  const index = openModalStack.indexOf(id);
  if (index !== -1) openModalStack.splice(index, 1);
}

function isTopmostModal(id: string) {
  return openModalStack[openModalStack.length - 1] === id;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const modalId = useId();

  // Inline arrows are common, so the listener reads the latest callback instead
  // of re-running the effect (and re-focusing) on every parent render.
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    registerModal(modalId);
    const dialog = dialogRef.current;
    const firstField = dialog?.querySelector<HTMLElement>('.dialog-body input, .dialog-body select, .dialog-body textarea, .dialog-body button');
    const fallback = dialog?.querySelector<HTMLElement>('input, select, textarea, button, [tabindex]');
    (firstField ?? fallback ?? dialog)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      // A dialog underneath another one must not react to the keys that belong
      // to the top layer.
      if (!isTopmostModal(modalId)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = dialog.querySelectorAll<HTMLElement>('input, select, textarea, button, [tabindex]:not([tabindex="-1"])');
      if (focusable.length === 0) return;
      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      unregisterModal(modalId);
      restoreRef.current?.focus();
      restoreRef.current = null;
    };
  }, [open, modalId]);

  if (!open) return null;
  return (
    <div
      className="backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={wide ? 'dialog wide' : 'dialog'} role="dialog" aria-modal="true" aria-label={title} ref={dialogRef} tabIndex={-1}>
        <header className="dialog-head">
          <span className="dialog-title">{title}</span>
          <button type="button" className="button ghost icon" onClick={onClose} aria-label="Close dialog">
            <X size={14} weight="bold" />
          </button>
        </header>
        <div className="dialog-body">{children}</div>
        {footer !== undefined && <footer className="dialog-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function Toaster() {
  const { state, actions } = useStore();
  if (state.toasts.length === 0) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {state.toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind}`}>
          <span className="toast-body">{toast.message}</span>
          <button type="button" className="button ghost icon" aria-label="Dismiss notification" onClick={() => actions.dismissToast(toast.id)}>
            <X size={12} weight="bold" />
          </button>
        </div>
      ))}
    </div>
  );
}

export function StatusNotice({ kind, children }: { kind: 'info' | 'warning'; children: ReactNode }) {
  return (
    <div className={`toast ${kind}`} style={{ animation: 'none', boxShadow: 'none' }}>
      <span className="toast-body">{children}</span>
    </div>
  );
}
