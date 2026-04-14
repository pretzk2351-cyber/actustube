import { auth } from "../../auth";
import { SignInButton, SignOutButton } from "./components/auth-buttons";
import { YouTubeForm } from "./components/youtube-form";

export default async function Home() {
  const session = await auth();

  return (
    <main
      style={{
        minHeight: "100vh",
        backgroundColor: "#ffffff",
        color: "#111111",
        fontFamily:
          "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      }}
    >
      <div
        style={{
          width: "100%",
          background:
            "linear-gradient(90deg, #d90429 0%, #c40025 45%, #a8001f 100%)",
          color: "#ffffff",
          borderBottom: "1px solid #8d001a",
          boxShadow: "0 8px 28px rgba(217,4,41,0.18)",
        }}
      >
        <div
          style={{
            maxWidth: "1280px",
            margin: "0 auto",
            padding: "14px 20px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "16px",
            flexWrap: "wrap",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "14px",
              flexWrap: "wrap",
            }}
          >
            <div
              style={{
                fontSize: "27px",
                fontWeight: 900,
                letterSpacing: "-0.04em",
                lineHeight: 1,
              }}
            >
              ACTUSTUBE
            </div>

            <div
              style={{
                display: "inline-block",
                padding: "6px 10px",
                borderRadius: "999px",
                backgroundColor: "rgba(255,255,255,0.14)",
                fontSize: "12px",
                fontWeight: 700,
                letterSpacing: "0.05em",
              }}
            >
              FREE MVP
            </div>
          </div>

          {session ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "12px",
                flexWrap: "wrap",
              }}
            >
              {session.user?.image && (
                <img
                  src={session.user.image}
                  alt="profile"
                  width={42}
                  height={42}
                  style={{
                    borderRadius: "50%",
                    objectFit: "cover",
                    border: "2px solid rgba(255,255,255,0.92)",
                  }}
                />
              )}

              <div style={{ lineHeight: 1.3 }}>
                <p
                  style={{
                    margin: 0,
                    fontSize: "12px",
                    color: "rgba(255,255,255,0.82)",
                    fontWeight: 700,
                  }}
                >
                  ACCOUNT
                </p>
                <p
                  style={{
                    margin: "2px 0 0",
                    fontSize: "15px",
                    fontWeight: 800,
                    color: "#ffffff",
                  }}
                >
                  {session.user?.name ?? "ユーザー"}
                </p>
                <p
                  style={{
                    margin: "2px 0 0",
                    fontSize: "12px",
                    color: "rgba(255,255,255,0.82)",
                  }}
                >
                  {session.user?.email}
                </p>
              </div>

              <div
                style={{
                  marginLeft: "4px",
                  paddingLeft: "10px",
                  borderLeft: "1px solid rgba(255,255,255,0.22)",
                }}
              >
                <SignOutButton />
              </div>
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "12px",
                flexWrap: "wrap",
              }}
            >
              <p
                style={{
                  margin: 0,
                  fontSize: "14px",
                  fontWeight: 700,
                  color: "rgba(255,255,255,0.92)",
                }}
              >
                Googleでログインして開始
              </p>
              <SignInButton />
            </div>
          )}
        </div>
      </div>

      <div
        style={{
          maxWidth: "1280px",
          margin: "0 auto",
          padding: "28px 20px 68px",
        }}
      >
        <section
          style={{
            marginBottom: "28px",
            padding: "34px 34px 30px",
            border: "1px solid #ececec",
            borderRadius: "28px",
            background:
              "radial-gradient(circle at top left, rgba(217,4,41,0.12), transparent 24%), linear-gradient(135deg, #111111 0%, #181818 55%, #202020 100%)",
            color: "#ffffff",
            boxShadow: "0 24px 52px rgba(0,0,0,0.10)",
            overflow: "hidden",
            position: "relative",
          }}
        >
          <div
            style={{
              display: "inline-block",
              padding: "7px 12px",
              borderRadius: "999px",
              backgroundColor: "#d90429",
              color: "#ffffff",
              fontSize: "12px",
              fontWeight: 700,
              letterSpacing: "0.05em",
              marginBottom: "16px",
            }}
          >
            CHANNEL CONSULTING
          </div>

          <h1
            style={{
              margin: 0,
              fontSize: "40px",
              lineHeight: 1.06,
              fontWeight: 900,
              letterSpacing: "-0.04em",
              maxWidth: "860px",
            }}
          >
            分析で終わらせず、
            <br />
            次の一手まで整理する
          </h1>

          <p
            style={{
              marginTop: "16px",
              marginBottom: 0,
              color: "#d6d6d6",
              lineHeight: 1.86,
              maxWidth: "920px",
              fontSize: "15px",
            }}
          >
            動画の傾向を見ながら、強み、弱み、直すべき点、
            次回以降の方向性までひと続きで確認できるダッシュボードです。
          </p>
        </section>

        {!session ? (
          <section
            style={{
              display: "grid",
              gridTemplateColumns: "1.1fr 0.9fr",
              gap: "24px",
              alignItems: "stretch",
            }}
          >
            <div
              style={{
                backgroundColor: "#ffffff",
                border: "1px solid #ececec",
                borderRadius: "26px",
                padding: "28px",
                boxShadow: "0 18px 40px rgba(0,0,0,0.05)",
              }}
            >
              <h2
                style={{
                  marginTop: 0,
                  marginBottom: "16px",
                  fontSize: "29px",
                  fontWeight: 850,
                  letterSpacing: "-0.03em",
                }}
              >
                この画面で確認できること
              </h2>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                  gap: "14px",
                }}
              >
                {[
                  "通常動画 10本の分析",
                  "ショート動画 10本の分析",
                  "強みの整理",
                  "弱みの整理",
                  "今の改善点",
                  "次回以降の提案",
                ].map((item) => (
                  <div
                    key={item}
                    style={{
                      border: "1px solid #efefef",
                      borderRadius: "18px",
                      padding: "16px",
                      backgroundColor: "#fafafa",
                    }}
                  >
                    <p
                      style={{
                        margin: 0,
                        fontSize: "14px",
                        fontWeight: 700,
                        lineHeight: 1.65,
                      }}
                    >
                      {item}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            <div
              style={{
                border: "1px solid #ececec",
                borderRadius: "26px",
                padding: "28px",
                backgroundColor: "#fff6f7",
                boxShadow: "0 18px 40px rgba(217,4,41,0.07)",
              }}
            >
              <div
                style={{
                  display: "inline-block",
                  padding: "6px 12px",
                  borderRadius: "999px",
                  backgroundColor: "#d90429",
                  color: "#ffffff",
                  fontSize: "12px",
                  fontWeight: 800,
                  letterSpacing: "0.05em",
                  marginBottom: "14px",
                }}
              >
                START
              </div>

              <h3
                style={{
                  margin: 0,
                  fontSize: "30px",
                  lineHeight: 1.15,
                  letterSpacing: "-0.03em",
                  fontWeight: 850,
                }}
              >
                ログインして
                <br />
                分析を始める
              </h3>

              <p
                style={{
                  marginTop: "15px",
                  marginBottom: "24px",
                  color: "#525252",
                  lineHeight: 1.85,
                }}
              >
                チャンネルURLを入力すると、
                動画の傾向と改善の方向性をまとめて確認できます。
              </p>

              <SignInButton />
            </div>
          </section>
        ) : (
          <section>
            <YouTubeForm />
          </section>
        )}
      </div>
    </main>
  );
}