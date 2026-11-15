import { useEffect, useState } from "react";

export type ErrorHandler = (error: unknown) => void;
export type NoticeHandler = (message: string) => void;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request could not be completed";
}

export function useResource<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    load().then((value) => {
      if (active) setData(value);
    }).catch((failure: unknown) => {
      if (active) setError(errorMessage(failure));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [load, revision]);

  return {
    data,
    loading,
    error,
    reload: () => setRevision((value) => value + 1)
  };
}

export function PageHeading({ eyebrow, title, description, action }: {
  eyebrow: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="muted">{description}</p>
      </div>
      {action}
    </div>
  );
}

export function Panel({ title, description, action, children, className = "" }: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          {description && <p className="muted">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function ResourceState({ loading, error, empty, children }: {
  loading: boolean;
  error?: string;
  empty?: boolean;
  children: React.ReactNode;
}) {
  if (loading) return <div className="state-box">Loading…</div>;
  if (error) return <div className="state-box error-text">{error}</div>;
  if (empty) return <div className="state-box">Nothing here yet.</div>;
  return <>{children}</>;
}

export function MetricCard({ label, value, note, tone = "blue" }: {
  label: string;
  value: string | number;
  note: string;
  tone?: "blue" | "green" | "orange" | "purple";
}) {
  return (
    <article className={`metric-card tone-${tone}`}>
      <div className="metric-dot" />
      <p>{label}</p>
      <strong>{value}</strong>
      <span>{note}</span>
    </article>
  );
}

export function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: string }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value / 1024;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${amount.toFixed(amount < 10 ? 1 : 0)} ${units[unitIndex]}`;
}

export function InlineError({ children }: { children: React.ReactNode }) {
  return <p className="inline-error" role="alert">{children}</p>;
}
