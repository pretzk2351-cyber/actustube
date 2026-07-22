import type { ReactNode } from "react";

export type StatusTone = "info" | "loading" | "empty" | "error" | "success";

export function StatusPanel({
  tone,
  title,
  children,
}: {
  tone: StatusTone;
  title: string;
  children?: ReactNode;
}) {
  const isLoading = tone === "loading";

  return (
    <div
      className={`status-panel status-panel--${tone}`}
      role={tone === "error" ? "alert" : "status"}
      aria-live={tone === "error" ? "assertive" : "polite"}
      aria-busy={isLoading || undefined}
    >
      {isLoading && <span className="status-panel__spinner" aria-hidden="true" />}
      <div>
        <strong className="status-panel__title">{title}</strong>
        {children && <div className="status-panel__body">{children}</div>}
      </div>
    </div>
  );
}

export function SectionIntro({
  id,
  eyebrow,
  title,
  description,
}: {
  id?: string;
  eyebrow: string;
  title: string;
  description?: ReactNode;
}) {
  return (
    <div className="section-intro" id={id}>
      <p className="section-intro__eyebrow">{eyebrow}</p>
      <h2 className="section-intro__title">{title}</h2>
      {description && <div className="section-intro__description">{description}</div>}
    </div>
  );
}

export function AnalysisFlowGuide({
  hasRecommendation,
}: {
  hasRecommendation: boolean;
}) {
  const steps = [
    { label: "現状", href: "#analysis-overview" },
    { label: "根拠データ", href: "#analysis-evidence" },
    {
      label: "優先課題",
      href: hasRecommendation ? "#analysis-priority" : null,
    },
    { label: "今週の改善", href: "#weekly-cycle-title" },
    { label: "確認指標", href: "#analysis-metrics" },
  ];

  return (
    <nav className="analysis-flow" aria-label="分析から改善までの流れ">
      <p className="analysis-flow__label">この分析の進め方</p>
      <ol className="analysis-flow__steps">
        {steps.map((step, index) => (
          <li className="analysis-flow__step" key={step.label}>
            <span className="analysis-flow__number">{index + 1}</span>
            {step.href ? (
              <a href={step.href}>{step.label}</a>
            ) : (
              <span className="analysis-flow__pending">{step.label}</span>
            )}
          </li>
        ))}
      </ol>
      {!hasRecommendation && (
        <p className="analysis-flow__hint">
          優先課題は、分析後に「提案を見る」を実行すると確認できます。
        </p>
      )}
    </nav>
  );
}
