import { cloneElement, isValidElement, useEffect, useId, useRef, type ChangeEvent, type ReactElement, type ReactNode } from 'react';
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
  const childId = isValidElement(children) ? (children.props as { id?: string }).id : undefined;
  const controlId = htmlFor ?? childId ?? generated;
  // Associate the visible label with the control so it is announced and can be
  // targeted by its label. Controls that expose an `id` receive one here.
  const control =
    isValidElement(children) && childId === undefined && htmlFor === undefined
      ? cloneElement(children as ReactElement<{ id?: string }>, { id: controlId })
      : children;
  return (
    <div className="field">
      <label className="field-label" htmlFor={controlId}>
        {label}
      </label>
      {control}
      {hint !== undefined && error === undefined && <span className="field-hint">{hint}</span>}
      {error !== undefined && <span className="field-error">{error}</span>}
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
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <input
      id={id}
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

export function NumberInput({
  value,
  onChange,
  id,
  min,
  max,
  step = 1,
  disabled,
  placeholder,
}: {
  value: number;
  onChange: (value: number) => void;
  id?: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <input
      id={id}
      className="input"
      type="number"
      value={Number.isFinite(value) ? String(value) : ''}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(event) => {
        const parsed = Number(event.target.value);
        if (event.target.value === '') {
          onChange(Number.NaN);
          return;
        }
        if (Number.isFinite(parsed)) onChange(parsed);
      }}
    />
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  id,
  disabled,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string }>;
  id?: string;
  disabled?: boolean;
}) {
  return (
    <select id={id} className="select" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as T)}>
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
  options: Array<{ value: T; label: string; title?: string }>;
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

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    const focusable = dialogRef.current?.querySelector<HTMLElement>('input, select, textarea, button, [tabindex]');
    focusable?.focus();
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={wide ? 'dialog wide' : 'dialog'} role="dialog" aria-modal="true" aria-label={title} ref={dialogRef}>
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
