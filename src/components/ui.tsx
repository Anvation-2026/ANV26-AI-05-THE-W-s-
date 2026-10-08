import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { create } from 'zustand';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Icon, type IconName } from './Icon';

/* ---------------------------------------------------------------- toasts */
interface ToastItem {
  id: number;
  text: string;
  kind: 'info' | 'error';
}
export const useToasts = create<{ items: ToastItem[]; push: (t: Omit<ToastItem, 'id'>) => void; drop: (id: number) => void }>((set) => ({
  items: [],
  push: (t) => {
    const id = Date.now() + Math.random();
    set((s) => ({ items: [...s.items, { ...t, id }].slice(-4) }));
    setTimeout(() => set((s) => ({ items: s.items.filter((x) => x.id !== id) })), t.kind === 'error' ? 7000 : 4000);
  },
  drop: (id) => set((s) => ({ items: s.items.filter((x) => x.id !== id) })),
}));
export const toast = (text: string, kind: 'info' | 'error' = 'info') => useToasts.getState().push({ text, kind });

export function ToastHost() {
  const items = useToasts((s) => s.items);
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind === 'error' ? 'toast-error' : ''}`}>
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- buttons */
interface BtnProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> {
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  size?: 'md' | 'sm';
  loading?: boolean;
  icon?: IconName;
  disabled?: boolean;
  /** Shown on hover and focus whenever the button is disabled. */
  disabledReason?: string;
}

export function Tip({ text, children }: { text: string; children: ReactNode }) {
  const [on, setOn] = useState(false);
  const id = useId();
  return (
    <span className="tip-wrap" onMouseEnter={() => setOn(true)} onMouseLeave={() => setOn(false)} onFocus={() => setOn(true)} onBlur={() => setOn(false)}>
      <span aria-describedby={on ? id : undefined} style={{ display: 'contents' }}>
        {children}
      </span>
      {on && (
        <span role="tooltip" id={id} className="tip-bubble">
          {text}
        </span>
      )}
    </span>
  );
}

export function Button({ variant = 'secondary', size = 'md', loading, icon, disabled, disabledReason, className, children, onClick, type = 'button', ...rest }: BtnProps) {
  const off = disabled || loading;
  const btn = (
    <button
      {...rest}
      type={type}
      aria-disabled={off || undefined}
      className={`btn btn-${variant} ${size === 'sm' ? 'btn-sm' : ''} ${loading ? 'is-loading' : ''} ${className ?? ''}`}
      onClick={(e) => {
        if (off) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
    >
      {icon && <Icon name={icon} className="icon-sm" />}
      {children}
    </button>
  );
  if (disabled && disabledReason) return <Tip text={disabledReason}>{btn}</Tip>;
  return btn;
}

export function IconButton({
  icon,
  label,
  pressed,
  onClick,
  disabled,
  disabledReason,
  className,
}: {
  icon: IconName;
  label: string;
  pressed?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  disabledReason?: string;
  className?: string;
}) {
  const b = (
    <button
      type="button"
      className={`icon-btn ${className ?? ''}`}
      aria-label={label}
      title={disabled ? disabledReason ?? label : label}
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      onClick={() => !disabled && onClick?.()}
    >
      <Icon name={icon} />
    </button>
  );
  return b;
}

/* ----------------------------------------------------------------- forms */
export function Field({ label, hint, error, children, htmlFor, hideLabel }: { label: string; hint?: string; error?: string | null; children: ReactNode; htmlFor?: string; hideLabel?: boolean }) {
  return (
    <div className="field">
      <label className={hideLabel ? 'sr-only' : 'field-label'} htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  hint,
  disabled,
  changed,
  hideLabel,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  hint?: string;
  disabled?: boolean;
  changed?: boolean;
  hideLabel?: boolean;
}) {
  const id = useId();
  const [text, setText] = useState(String(value));
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setText(String(value)), [value]);
  const commit = (s: string) => {
    const n = Number(s);
    if (s.trim() === '' || !Number.isFinite(n)) return setErr('Enter a number.');
    if (min !== undefined && n < min) return setErr(`Use ${min} or more.`);
    if (max !== undefined && n > max) return setErr(`Use ${max} or less.`);
    setErr(null);
    onChange(n);
  };
  return (
    <Field label={label} htmlFor={id} hint={hint} error={err} hideLabel={hideLabel}>
      <div className="input-unit">
        <input
          id={id}
          className="input"
          inputMode="decimal"
          value={text}
          disabled={disabled}
          aria-invalid={!!err}
          onChange={(e) => {
            setText(e.target.value);
            commit(e.target.value);
          }}
          onBlur={() => {
            if (err) {
              setText(String(value));
              setErr(null);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              const dir = e.key === 'ArrowUp' ? 1 : -1;
              const n = Math.round((value + dir * step) * 1e6) / 1e6;
              const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
              onChange(clamped);
            }
          }}
        />
        {unit && <span>{unit}</span>}
        {changed && <span className="badge badge-plain">Changed</span>}
      </div>
    </Field>
  );
}

export function SliderField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  disabled,
  format,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  disabled?: boolean;
  format?: (n: number) => string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <div className="slider-row">
        <input
          id={id}
          className="slider"
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-valuetext={`${format ? format(value) : value}${unit ? ' ' + unit : ''}`}
        />
        <span className="tnum">
          {format ? format(value) : value}
          {unit ? ` ${unit}` : ''}
        </span>
      </div>
    </div>
  );
}

export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  disabledOptions,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; disabledReason?: string }[];
  onChange: (v: T) => void;
  disabledOptions?: T[];
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o, i) => {
        const checked = o.value === value;
        const off = disabledOptions?.includes(o.value) || !!o.disabledReason;
        return (
          <button
            key={String(o.value)}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            className="seg-btn"
            title={o.disabledReason}
            disabled={off}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault();
                const dir = e.key === 'ArrowRight' ? 1 : -1;
                const next = (i + dir + options.length) % options.length;
                onChange(options[next].value);
                refs.current[next]?.focus();
              }
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Toggle({ label, checked, onChange, disabled, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; hint?: string }) {
  return (
    <label className="toggle" title={hint}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-box" aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}

export function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id}>
      <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

/* ------------------------------------------------------------------ tabs */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  noPanels,
}: {
  tabs: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  /** Set when the tabs only switch the data shown and there is no separate tab panel element. */
  noPanels?: boolean;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button
          key={t.id}
          role="tab"
          id={`tab-${t.id}`}
          aria-selected={value === t.id}
          aria-controls={noPanels ? undefined : `panel-${t.id}`}
          tabIndex={value === t.id ? 0 : -1}
          className="tab"
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
              const dir = e.key === 'ArrowRight' ? 1 : -1;
              const n = tabs[(i + dir + tabs.length) % tabs.length];
              onChange(n.id);
              requestAnimationFrame(() => document.getElementById(`tab-${n.id}`)?.focus());
            }
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- surfaces */
export function Badge({ children, tone = 'paint' }: { children: ReactNode; tone?: 'paint' | 'plain' | 'sign' | 'stop' }) {
  return <span className={`badge ${tone === 'plain' ? 'badge-plain' : tone === 'sign' ? 'badge-sign' : tone === 'stop' ? 'badge-stop' : ''}`}>{children}</span>;
}

export function Meter({ value, max, cap, label }: { value: number; max: number; cap?: number; label: string }) {
  const pct = Math.min(100, (value / Math.max(1e-9, max)) * 100);
  return (
    <div
      className="meter"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.round(value * 10) / 10}
    >
      <span style={{ width: `${pct}%` }} />
      {cap !== undefined && <i className="meter-cap" style={{ left: `${Math.min(100, (cap / max) * 100)}%` }} />}
    </div>
  );
}

export function Skel({ w = '100%', h = 16, style }: { w?: number | string; h?: number | string; style?: React.CSSProperties }) {
  return <div className="skel" style={{ width: w, height: h, ...style }} aria-hidden="true" />;
}

export function SkeletonBlock({ lines = 3, title = true }: { lines?: number; title?: boolean }) {
  return (
    <div className="stack-sm" role="status" aria-label="Loading">
      {title && <Skel w="40%" h={22} />}
      {Array.from({ length: lines }, (_, i) => (
        <Skel key={i} w={i === lines - 1 ? '60%' : '100%'} h={14} />
      ))}
    </div>
  );
}

export function SkeletonSquare() {
  return (
    <div role="status" aria-label="Loading junction" style={{ aspectRatio: '1 / 1', width: '100%' }}>
      <Skel w="100%" h="100%" />
    </div>
  );
}

export function SkeletonChart({ height = 220 }: { height?: number }) {
  return (
    <div role="status" aria-label="Loading chart" className="stack-sm">
      <Skel w="30%" h={16} />
      <Skel w="100%" h={height} />
    </div>
  );
}

export function SkeletonTable({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div role="status" aria-label="Loading table" className="stack-sm">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 12 }}>
          {Array.from({ length: cols }, (_, c) => (
            <Skel key={c} h={18} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p className="muted">{body}</p>
      {action}
    </div>
  );
}

export function ErrorState({ title, body, onRetry }: { title: string; body: string; onRetry?: () => void }) {
  return (
    <div className="error-state" role="alert">
      <h3>{title}</h3>
      <p>{body}</p>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function PageHeader({ title, lede, actions }: { title: string; lede: string; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="row-between">
        <h1>{title}</h1>
        {actions && <div className="row">{actions}</div>}
      </div>
      <p className="page-lede">{lede}</p>
    </header>
  );
}

export function KeyboardHint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="row" style={{ gap: 6 }}>
      {keys.map((k) => (
        <kbd key={k}>{k}</kbd>
      ))}
      <span className="muted">{label}</span>
    </span>
  );
}

/* ---------------------------------------------------------------- dialog */
export function Dialog({
  open,
  title,
  onClose,
  children,
  actions,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const prev = useRef<Element | null>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    prev.current = document.activeElement;
    const el = ref.current;
    const focusables = () => Array.from(el?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? []).filter((n) => !n.hasAttribute('disabled'));
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
      if (e.key === 'Tab') {
        const f = focusables();
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      (prev.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onClose]);
  const reduce = useReducedMotion();
  return (
    <AnimatePresence>
      {open && (
    <motion.div
      className="dialog-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={ref}
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
        transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
      >
        <div className="row-between">
          <h2 id={titleId}>{title}</h2>
          <IconButton icon="close" label="Close" onClick={onClose} />
        </div>
        <div className="stack">{children}</div>
        {actions && <div className="dialog-actions">{actions}</div>}
      </motion.div>
    </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Cross-fades content with a short shift in the direction of travel. Use when a control swaps what is shown. */
export function Swap({ id, dir = 1, children }: { id: string | number; dir?: 1 | -1; children: ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <motion.div key={id} initial={reduce ? { opacity: 0 } : { opacity: 0, x: 12 * dir }} animate={{ opacity: 1, x: 0 }} transition={{ duration: reduce ? 0.1 : 0.2, ease: [0.2, 0, 0, 1] }}>
      {children}
    </motion.div>
  );
}

export function useConfirm() {
  const [state, setState] = useState<{ title: string; body: string; confirm: string; danger?: boolean; resolve: (v: boolean) => void } | null>(null);
  const ask = useCallback(
    (title: string, body: string, confirm = 'Confirm', danger = false) =>
      new Promise<boolean>((resolve) => setState({ title, body, confirm, danger, resolve })),
    [],
  );
  const node = state ? (
    <Dialog
      open
      title={state.title}
      onClose={() => {
        state.resolve(false);
        setState(null);
      }}
      actions={
        <>
          <Button
            variant="quiet"
            onClick={() => {
              state.resolve(false);
              setState(null);
            }}
          >
            Cancel
          </Button>
          <Button
            variant={state.danger ? 'danger' : 'primary'}
            onClick={() => {
              state.resolve(true);
              setState(null);
            }}
          >
            {state.confirm}
          </Button>
        </>
      }
    >
      <p>{state.body}</p>
    </Dialog>
  ) : null;
  return { ask, node };
}

/* ------------------------------------------------------------- file drop */
export function FileDrop({
  accept,
  label,
  hint,
  onFile,
  error,
  icon = 'upload',
}: {
  accept: string;
  label: string;
  hint: string;
  onFile: (f: File) => void;
  error?: string | null;
  icon?: IconName;
}) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      className={`drop ${over ? 'is-over' : ''} ${error ? 'is-error' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
    >
      <Icon name={icon} />
      <strong>{label}</strong>
      <span className="muted">{hint}</span>
      <input
        ref={input}
        type="file"
        accept={accept}
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = '';
        }}
        aria-label={label}
      />
      <Button variant="secondary" size="sm" onClick={() => input.current?.click()}>
        Choose file
      </Button>
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ data table */
export interface Column<T> {
  key: string;
  label: string;
  num?: boolean;
  render: (row: T) => ReactNode;
  sort?: (row: T) => number | string;
}
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  ariaLabel,
  maxHeight,
  onRowHover,
  selectedKey,
  empty,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (r: T) => string | number;
  ariaLabel: string;
  maxHeight?: number;
  onRowHover?: (r: T | null) => void;
  selectedKey?: string | number | null;
  empty?: ReactNode;
}) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const c = columns.find((x) => x.key === sort.key);
    if (!c?.sort) return rows;
    const f = c.sort;
    return rows.slice().sort((a, b) => {
      const x = f(a);
      const y = f(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [rows, columns, sort]);
  if (!rows.length && empty) return <>{empty}</>;
  return (
    <div className="table-wrap" style={{ maxHeight }} tabIndex={0} role="region" aria-label={`${ariaLabel}, scrollable table`}>
      <table className="table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.num ? 'num' : ''} aria-sort={sort?.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
                {c.sort ? (
                  <button className="th-sort" onClick={() => setSort((s) => (s?.key === c.key ? { key: c.key, dir: (s.dir * -1) as 1 | -1 } : { key: c.key, dir: 1 }))}>
                    {c.label}
                    {sort?.key === c.key ? (sort.dir === 1 ? ' (up)' : ' (down)') : ''}
                  </button>
                ) : (
                  c.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr
              key={rowKey(r)}
              className={selectedKey !== undefined && selectedKey === rowKey(r) ? 'is-selected' : ''}
              onMouseEnter={() => onRowHover?.(r)}
              onMouseLeave={() => onRowHover?.(null)}
            >
              {columns.map((c) => (
                <td key={c.key} className={c.num ? 'num' : ''}>
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------------------------------------------------- media query */
export function useMedia(query: string): boolean {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const fn = () => setM(mq.matches);
    mq.addEventListener('change', fn);
    fn();
    return () => mq.removeEventListener('change', fn);
  }, [query]);
  return m;
}

export const ThemeContext = createContext<{ theme: 'light' | 'dark'; toggle: () => void }>({ theme: 'light', toggle: () => {} });
export const useTheme = () => useContext(ThemeContext);

