import { auth } from "../../auth";
import { SignInButton, SignOutButton } from "./components/auth-buttons";
import { YouTubeForm } from "./components/youtube-form";

const publicFeatures = [
  "通常動画 10本の分析",
  "ショート動画 10本の分析",
  "強みと弱みの整理",
  "根拠となる再生データ",
  "今すぐ見直すこと",
  "今週の改善サイクル",
];

export default async function Home() {
  const session = await auth();

  return (
    <main className="app-shell">
      <header className="site-header">
        <div className="site-header__inner">
          <div className="brand-lockup" aria-label="ActusTube">
            <span className="brand-mark" aria-hidden="true" />
            <span className="brand-name">ACTUSTUBE</span>
            <span className="plan-badge">FREE MVP</span>
          </div>

          {session ? (
            <div className="account-block">
              {session.user?.image && (
                <img
                  className="account-avatar"
                  src={session.user.image}
                  alt="プロフィール画像"
                  width={38}
                  height={38}
                />
              )}
              <div className="account-copy">
                <p className="account-copy__label">ACCOUNT</p>
                <p className="account-copy__name">
                  {session.user?.name ?? "ユーザー"}
                </p>
                <p className="account-copy__email">{session.user?.email}</p>
              </div>
              <SignOutButton />
            </div>
          ) : (
            <div className="guest-actions">
              <p className="guest-actions__copy">Googleでログインして開始</p>
              <SignInButton />
            </div>
          )}
        </div>
      </header>

      <div className="page-container">
        <section className="hero" aria-labelledby="hero-title">
          <p className="hero__eyebrow">CHANNEL IMPROVEMENT DASHBOARD</p>
          <h1 className="hero__title" id="hero-title">
            分析を、今週の改善行動につなげる
          </h1>
          <p className="hero__description">
            動画の傾向を確認し、根拠となるデータ、優先して見直すこと、
            今週取り組む行動、実行後に確認する指標までをひと続きで整理します。
          </p>
          <ol className="hero__flow" aria-label="ActusTubeで行う改善の流れ">
            <li>分析結果</li>
            <li>根拠</li>
            <li>優先課題</li>
            <li>今週の改善行動</li>
            <li>確認する指標</li>
          </ol>
        </section>

        {!session ? (
          <section className="public-grid" aria-label="ActusTubeでできること">
            <article className="surface-card">
              <span className="eyebrow-badge">WHAT YOU CAN REVIEW</span>
              <h2 className="surface-card__title" style={{ marginTop: "16px" }}>
                データを見るだけで終わらない分析
              </h2>
              <p className="surface-card__copy">
                通常動画とショートを分けて現状を把握し、改善候補を今週の行動へつなげます。
              </p>
              <div className="feature-grid">
                {publicFeatures.map((item) => (
                  <div className="feature-item" key={item}>
                    {item}
                  </div>
                ))}
              </div>
            </article>

            <article className="surface-card surface-card--accent">
              <span className="eyebrow-badge">START</span>
              <h2 className="surface-card__title" style={{ marginTop: "16px" }}>
                ログインしてチャンネルを分析
              </h2>
              <p className="surface-card__copy">
                YouTubeチャンネルを選び、既存の分析・AI提案・週次改善サイクルを利用できます。
              </p>
              <SignInButton />
            </article>
          </section>
        ) : (
          <section aria-label="チャンネル分析と改善サイクル">
            <YouTubeForm />
          </section>
        )}
      </div>
    </main>
  );
}
