import { ButtonHTMLAttributes, ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { CircleHelp, Loader2, X } from "lucide-react";
import { STATUS_META } from "utils/helper_functions/format";
import { useToastStore } from "utils/store/toastStore";
import { DisplayStatus } from "utils/types";

// Shared building blocks, like components/display_components in the NueAssist UI.

// ---------- Button ----------

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: "bg-brand text-white hover:bg-brand-dark disabled:bg-brand/50",
  secondary: "border border-line bg-sheet text-ink hover:border-ink-faint disabled:text-ink-faint",
  danger: "border border-refused/30 bg-sheet text-refused hover:bg-refused-tint disabled:opacity-50",
  ghost: "text-ink-soft hover:bg-ink/5 hover:text-ink disabled:opacity-50",
};

interface DisplayButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "md" | "lg";
  loading?: boolean;
  icon?: ReactNode;
}

export const DisplayButton = ({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  children,
  className = "",
  disabled,
  ...props
}: DisplayButtonProps) => {
  const sizeStyle = size === "lg" ? "px-5 py-2.5 text-base" : "px-3.5 py-1.5 text-sm";
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:cursor-not-allowed ${sizeStyle} ${BUTTON_STYLES[variant]} ${className}`}
      {...props}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
};

// ---------- Status badge ----------

const TONE_STYLES = {
  done: "bg-done-tint text-done",
  waiting: "bg-waiting-tint text-waiting",
  refused: "bg-refused-tint text-refused",
  neutral: "bg-ink/5 text-ink-soft",
};

export const DisplayBadge = ({ label, tone = "neutral" }: { label: string; tone?: keyof typeof TONE_STYLES }) => (
  <span className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE_STYLES[tone]}`}>{label}</span>
);

// ---------- Tap-to-explain hints ----------

// A short explanation that opens when you TAP or click it (or press Enter), and also when the mouse rests on it.
// Hover-only hints (the title="" attribute) cannot be read on a phone, so every hint in the app uses this instead.
// It closes on a second tap, a tap anywhere else, Escape, or scrolling. It is fixed to the screen, so a table or
// card around it can never cut it off, and it is kept inside the screen edges.
const TIP_WIDTH = 256;

const Tip = ({ meaning, children, className = "", label }: { meaning: string; children: ReactNode; className?: string; label?: string }) => {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const pinned = useRef(false);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState({ top: 0, left: 0 });

  const close = useCallback(() => {
    pinned.current = false;
    setOpen(false);
  }, []);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const width = Math.min(TIP_WIDTH, window.innerWidth - 16);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    // Below the hint, unless there is no room there; then above it.
    const height = bubbleRef.current?.offsetHeight ?? 0;
    const below = rect.bottom + 6;
    const top = below + height > window.innerHeight - 8 && rect.top - height - 6 > 8 ? rect.top - height - 6 : below;
    setPlace({ top, left });
  }, [open, meaning]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!triggerRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && close();
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open, close]);

  return (
    <span className="inline">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        aria-label={label}
        className={className}
        onClick={() => {
          pinned.current = !pinned.current;
          setOpen(pinned.current);
        }}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => !pinned.current && setOpen(false)}
        onBlur={close}
      >
        {children}
      </button>
      {open && (
        <span
          id={id}
          ref={bubbleRef}
          role="tooltip"
          style={{ top: place.top, left: place.left, width: Math.min(TIP_WIDTH, window.innerWidth - 16) }}
          className="fixed z-50 whitespace-pre-line rounded-md bg-ink px-3 py-2 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-white shadow-lg"
        >
          {meaning}
        </span>
      )}
    </span>
  );
};

// A term people may not know, with a dotted underline. Tap or click it to read what it means.
export const DisplayTip = ({ term, meaning }: { term: string; meaning: string }) => (
  <Tip meaning={meaning} className="cursor-help underline decoration-dotted underline-offset-2">
    {term}
  </Tip>
);

// A small round "?" next to a label, for a longer explanation.
export const DisplayHelp = ({ meaning, label = "What does this mean?" }: { meaning: string; label?: string }) => (
  <Tip meaning={meaning} label={label} className="ml-1 inline-flex align-middle text-ink-faint hover:text-ink">
    <CircleHelp className="h-4 w-4" aria-hidden />
  </Tip>
);

// A run's status, in plain words. With `explain`, tapping it says what it means.
export const DisplayStatusBadge = ({ status, explain = false }: { status: DisplayStatus; explain?: boolean }) => {
  const meta = STATUS_META[status];
  const badge = `inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE_STYLES[meta.tone]}`;
  if (explain) {
    return (
      <Tip meaning={meta.hint} className={`${badge} cursor-help`}>
        {meta.label}
      </Tip>
    );
  }
  return <span className={badge}>{meta.label}</span>;
};

// ---------- Page header ----------

export const DisplayPageHeader = ({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) => (
  <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {description && <p className="mt-1 text-ink-soft">{description}</p>}
    </div>
    {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
  </header>
);

// ---------- Empty, loading and error states ----------

export const DisplayEmptyState = ({ title, description, action }: { title: string; description: string; action?: ReactNode }) => (
  <div className="rounded-lg border border-dashed border-line bg-sheet px-6 py-12 text-center">
    <p className="font-serif text-lg">{title}</p>
    <p className="mx-auto mt-1 max-w-md text-ink-soft">{description}</p>
    {action && <div className="mt-5">{action}</div>}
  </div>
);

export const DisplayLoading = ({ label = "Loading" }: { label?: string }) => (
  <div className="flex items-center gap-2 py-10 text-ink-soft" role="status">
    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
    {label}…
  </div>
);

export const DisplayError = ({ message, onRetry }: { message: string; onRetry?: () => void }) => (
  <div className="rounded-lg border border-refused/30 bg-refused-tint px-4 py-3 text-refused" role="alert">
    <p>{message}</p>
    {onRetry && (
      <button type="button" onClick={onRetry} className="mt-1 text-sm font-semibold underline">
        Try again
      </button>
    )}
  </div>
);

// ---------- Toasts ----------

const TOAST_STYLES = {
  success: "border-done/30 bg-sheet text-ink [&>span]:bg-done",
  error: "border-refused/40 bg-sheet text-ink [&>span]:bg-refused",
  info: "border-line bg-sheet text-ink [&>span]:bg-brand",
};

export const DisplayToasts = () => {
  const { toasts, dismissToast } = useToastStore();
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto flex items-start gap-3 rounded-lg border px-4 py-3 shadow-lg shadow-ink/5 ${TOAST_STYLES[toast.tone]}`}
          role={toast.tone === "error" ? "alert" : "status"}
        >
          <span className="mt-2 h-2 w-2 shrink-0 rounded-full" aria-hidden />
          <p className="flex-1 text-sm">{toast.message}</p>
          <button type="button" onClick={() => dismissToast(toast.id)} className="text-ink-faint hover:text-ink" aria-label="Close message">
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
};
