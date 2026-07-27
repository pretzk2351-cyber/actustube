# ActusTube Project Status

最終更新日：2026-07-27

> 2026-07-27 JSTの読み取り専用確認に基づく状態スナップショットです。release candidateは`main`へfast-forward統合済みで、`main` / `origin/main` は `08ec587f7a242b40ada53a0eb69acb33ebb9253b` で同期しています。Current Productionは同じsource commitをREADY / Currentで配信し、トップはHTTP 200です。Migration 0006は正式Production branchへexact 1回適用済みです。一方、Production runtimeの`DATABASE_URL`がschemaの空の別branchを指しているため、`/api/usage/status`と`/api/weekly-cycle`はPersistence 500です。接続先修正、Redeploy、復旧確認はまだ実施していません。

## プロジェクト概要

ActusTubeは、YouTube投稿者向けのAI分析・改善サービスです。

中心価値：

- 通常動画とShortsのデータ分析
- 投稿者固有の強み・弱みの抽出
- 根拠付きの改善提案
- 次回動画の内容・構成・制作方法の提案
- 分析→改善→実行→振り返りのサイクル形成
- 投稿者がすぐ実行できる具体的な提案を重視

予定プラン：

- Free
- Standard
- Pro

原価割れ防止を最優先とし、動画本数、AI処理量、利用回数、文字起こし、DB、ストレージ等を上限管理します。

## 技術構成

`package.json`、Drizzle設定、実装を確認した構成です。

- Next.js 15.5.20
- React / React DOM 19.0.0
- TypeScript 5系
- Auth.js（`next-auth` 5.0.0 beta 25以降）
- Drizzle ORM 0.45.2 / Drizzle Kit 0.31.10
- Neon Serverless PostgreSQL
- OpenAI API（OpenAI SDK 6.1.0以降）
- YouTube Data API
- Vitest 4.1.10以降
- Vercel
- Stripe SDK 18.0.0以降は依存関係に存在するが、Stripe機能は今回の公開対象外

## 承認済み期限付きセキュリティ例外

現在のProduction sourceには、[GHSA-mh99-v99m-4gvg / CVE-2026-14257の正式な期限付き例外](./SECURITY_EXCEPTION_GHSA-MH99-V99M-4GVG.md)を含む承認済みrelease candidateが統合されています。

- 対象：`brace-expansion` のdevDependency lint経路にあるGHSA-mh99-v99m-4gvgだけ
- 承認日：2026-07-26
- 失効日：2026-08-24 23:59 JST
- 初回週次確認期限：2026-08-02
- Runtime `npm audit --omit=dev`：全severity 0件
- full `npm audit`：対象GHSAによるHigh 9件のみ。対象GHSA以外は0件
- Production dependency / trace / bundle / route / action / user-input経路：対象packageへの到達なし
- Preview：Node.js 24.x、Corepack、npm 11.18.0、既定install、`npm run build`を実証済み
- ローカル回帰検証：247件成功、4件skip、React act警告0件
- 独立レビュー：P0 / P1 / P2 / P3 / NOT VERIFIEDすべて0件
- Git Fork Protection：有効
- `DATABASE_URL`：Productionだけに保存され、Previewには含まれない

通常のHigh / Critical 0件release gateは維持しています。今回の例外は単一GHSA、期限、週次再確認、即時解除条件、恒久対応を正式文書で拘束するもので、一般的なdevDependency脆弱性を許容しません。

release candidateの統合、Migration 0006のProduction適用、Migration後postflightは完了しています。期限付き例外のscope、期限、週次再確認、即時解除条件は引き続き正式例外文書を正本とします。本docs-only同期は例外条件や依存関係の評価を変更しません。

## Migration 0006適用後のProduction状態

- Migration履歴は0000〜0006の7件です。
- Migration 0006は正式Production branchへexact 1回適用済みで、再実行は禁止です。
- postflightは合格し、schema、function、owner、ACL、PUBLIC権限、security mode、固定search pathは期待状態です。
- Migration由来の想定外データ件数変化はありません。
- Migrationリハーサル用child branchとProduction復旧用backup child branchは、変更・削除せずREADYで保持しています。
- rollbackとrestoreは実施していません。
- 現在のPersistence 500はMigration対象Production branchの不整合ではなく、Vercel Production runtimeの接続先branch不一致が原因です。

## 実装済み機能

- Googleログイン・ログアウト
- `youtube.readonly` 権限
- YouTubeアクセストークン更新
- チャンネル取得
- 通常動画・Shorts取得
- 再生数等の統計
- 投稿頻度
- 月別推移
- 再生数分布
- 動画ランキング
- 低再生動画抽出
- AIによる強み・弱み・改善点・次回提案
- API認証保護
- Free利用上限
- DB利用枠管理と失敗時の予約解放
- 分析履歴
- AI提案履歴
- 週次改善項目
- `planned` / `completed` / `skipped`
- 結果メモ
- 1ユーザーにつき `planned` 1件
- 1分析につき改善項目1件
- カーソルページネーション
- 所有者アクセス制御
- 320pxから1440pxまでのレスポンシブ対応

## 週次改善サイクルMVP

統合済みコミット：

- `363fa43` `feat: add weekly improvement cycle`
- `92f834d` `fix: prevent responsive overflow in YouTube form`

API 500修正コミット：

- `35b9615ce474194277e35921b628744f8dc640e5`
- `fix: handle duplicate weekly improvement actions`

この修正コミットはrelease candidate `c6b403e` に含まれ、`main` へ統合・Production公開済みです。

修正内容：

- `DrizzleQueryError` の `cause` 内にある `NeonDbError` を探索
- PostgreSQLエラーコード `23505` とconstraint名を認識
- `improvement_actions_analysis_run_unique` の違反だけを409へ変換
- APIコード `IMPROVEMENT_ACTION_ALREADY_EXISTS` を返却
- `planned` 制約に対する既存の409を維持
- `completed` / `skipped` 後も、同じ分析に作成フォームを再表示しない
- 409発生時は履歴を再取得
- 想定外のDBエラーは内部情報を出さない安全な500に変換

## 第1回UI改修

`main` へfast-forward統合・Production公開済みの関連コミット：

- `65cdff375ffeae8f6c063f7a4e6201f5dbf81508` `fix: override sharp to patched libvips release`
- `f675ee9cc1db785adc625ae7f8887914da0fe35a` `feat: establish UI foundation and primary improvement flow`
- `0b4d83509755e69495584871968015ca8b483a0a` `fix: distinguish weekly cycle error notices`
- `3ede11a415ad47899f9776bd5fcd0ca33018006b` `test: add weekly cycle component test harness`
- `7ef73eddf081cc0f558aa69e7e00af3a75f2fdbd` `fix: preserve weekly cycle refresh errors`

実装・検証済みの内容：

- 共通UI基盤と、分析結果から今週の改善行動へ進む主要導線
- 320px、375px、390px、768px、1024px、1440pxを対象としたレスポンシブ確認
- 週次改善項目の作成・更新成功後に履歴再読込が失敗した場合、成功通知で上書きしない部分成功表示
- errorは `role="alert"` / `aria-live="assertive"`、successは `role="status"` / `aria-live="polite"`
- pending中のdisabledと二重送信防止
- WeeklyImprovementCycle本体をjsdomへrenderし、fetch mockとユーザー操作を通す実行経路テスト

API、認証、DB、Migration、schema、利用上限、課金仕様、AI提案の「期待効果」仕様は、このUI改修では変更していません。

## 検証結果

現在のProduction sourceへ統合されたrelease candidateの検証結果です。期限付きセキュリティ例外の扱いは、本書の「承認済み期限付きセキュリティ例外」と正式例外文書を参照してください。

- 自動テスト：247件成功、4件skip
- React act警告：0件
- ESLint：0エラー、既存の `<img>` 警告1件
- TypeScript：成功
- Production build：成功
- Runtime audit：全severity 0件
- full audit：承認済み単一GHSAによるHigh 9件。例外対象外のHigh / Criticalは0件
- npm 11.18.0のclean installと `npm ls --depth=0`：extraneous / invalid 0件
- `sharp`：0.35.3のみ
- `libvips`：package 1.3.2 / runtime 8.18.3
- `sharp` によるメモリ内SVG→PNG変換：成功
- `drizzle-kit check`：成功
- 週次改善release candidate時の重複作成関連実DB検証：4/4成功
- 同release candidate時の関連実DBテスト：48/48成功
- ActusTube管理対象のSchema drift：なし。`696d4b0` 以後のUI・依存・文書更新ではDB、Migration、schemaを変更していない
- `git diff --check`：成功
- 秘密情報・個人情報候補：0件
- UI幅320、375、390、768、1024、1440で横はみ出しなし

## Git状態

2026-07-27 JSTに読み取り確認した状態：

- `main`：`08ec587f7a242b40ada53a0eb69acb33ebb9253b`
- `origin/main`：`08ec587f7a242b40ada53a0eb69acb33ebb9253b`
- `main` と `origin/main`：0 / 0で同期済み
- 作業ツリー：clean

過去の主なProduction関連commit：

- `c6b403e`：週次改善サイクルのrelease candidate
- `2f79fa7`：Google OAuth callback互換性修正
- `509bf21`：Production認証障害に合わせた文書同期
- `c3e71ff`：安全な認証DB診断ログ
- `696d4b0`：Production DB接続復旧手順の文書化と復旧deploymentのsource
- `7ef73ed`：第1回UI改修と週次改善サイクル通知修正を含む直近のアプリコード基準
- `f6014a1`：正式仕様書v1.0を正本Markdownとして追加したdocs-only commit
- `e036d34`：Project Status / Production Runbookを同期したdocs-only commit

`08ec587f7a242b40ada53a0eb69acb33ebb9253b`には、承認済みrelease candidate、Migration 0006対応コード、期限付き例外文書が含まれ、`main`へfast-forward統合済みです。本docs-only branchはこのSHAを親とし、`main`自体を変更しません。

## Vercel Production状態

2026-07-27 JSTのProductionスナップショット：

- Production Branch：`main`
- Vercel Project：ActusTube
- source commit：`08ec587f7a242b40ada53a0eb69acb33ebb9253b`
- domain：`https://actustube.vercel.app`
- 状態：READY / Current
- トップページ：HTTP 200
- Google認証：成功
- session：成功
- 所有チャンネル：1件取得成功
- `/api/usage/status`：HTTP 500、`UsageStatusPersistenceError`
- `/api/weekly-cycle`：HTTP 500、`WeeklyCyclePersistenceError`
- 分析、AI提案、改善項目作成：未実行
- 根本原因：Production runtimeの`DATABASE_URL`接続先branch不一致
- `DATABASE_URL`修正、Redeploy、復旧確認：未実施
- rollback、restore：未実施
- このdeployment情報は確認時点のスナップショットであり、後続docs-only commitによって識別子が進んでも永続的にCurrentであることを意味しない

Production DB接続復旧に関する完了済み履歴：

- `redirect_uri_mismatch`：解消済み
- OAuth callbackの `missing iss`：解消済み
- callbackは `/api/auth/callback/google` まで到達し、HTTP 302で完了
- 安全な診断ログ：実装・検証・Production公開済み
- 本人による単一ログイン：成功。callback直後のトップページはHTTP 200
- 本人申告のログイン時刻周辺にGoogle callbackとHTTP 200を確認し、エラー、5xx、DB認証失敗は確認されなかった。Vercel側ログの表示時刻にはタイムゾーンまたは表示形式による差があるため、本人申告時刻との秒単位の一致は断定しない
- `[auth][error]`、`[auth][cause]`、`[auth][details]`：0件
- DB同期診断ログ：0件。失敗時だけ出力される実装のため正常結果と整合
- `password authentication failed`、Neon / PostgreSQL接続エラー、`error`、`fatal`、HTTP 5xx：0件
- 以前失敗していたGoogle OAuthアカウントのDB同期境界を正常に通過
- Production DB接続復旧：正式完了
- rollback：不要

直前のdocs-only deployment `dpl_6YzgHwYxG2w9XhwpGpZfJsjQ42sa`（`main@f6014a1`）と、直近のアプリコード公開deployment `dpl_37GSvgbM3Y23QAs9571UtAwzD42d`（`main@7ef73ed`）は比較用履歴として残します。Production DB接続復旧時の `dpl_Gk8TkDoUfG5dbpdn3HKpEc5k36aa`（`main@696d4b0`）、旧deployment `dpl_HPGCXavawHj3yHKo9nFg99LGB6jR`、`dpl_BFQqxdLJqaFS6vVcPVfZvfVkmFGQ` は監査履歴であり、現在のCurrentまたは自動的なrollback先ではありません。復旧ではVercel Productionの `DATABASE_URL` 以外を変更せず、Production DB本体やMigration 0000〜0005を変更・再適用していません。今回限定の環境変数変更例外は終了済みです。

## Production DB

Migration 0006適用後の正式Production branchを、秘密情報を表示しないread-only postflightで確認済みです。

- Migration履歴：0000〜0006の7件
- Migration 0006：exact 1件。再実行禁止
- repositoryのjournal、Migration識別情報、適用順序：一致
- 管理対象table、function、index、constraint：期待状態
- owner、ACL、PUBLIC権限、security mode、固定`search_path`：期待状態
- runtime roleの必要権限：正常
- Migration由来の想定外データ件数変化：なし
- rollback、restore：未実施

現在のPersistence 500はこのDBのMigration、schema、権限によるものではありません。正式Production branchでは同じアプリ経路がdirect／pooledとも正常で、Production runtimeだけがschemaの空の別branchへ接続しています。実データ、接続文字列、host、database名、role名、内部識別子は本書へ追加しません。

## バックアップ兼リハーサルブランチ

- Migration 0006専用リハーサルchild branch：READYで保持中
- Production復旧用backup child branch：READYで保持中
- 両branchとも削除、変更、reset、restore、別用途への流用を行っていません
- 今回のdocs-only同期ではNeon操作を行いません

## 現在残っている作業

1. 同期済みRunbookを根拠に、別のproject owner明示承認を受けてProductionの`DATABASE_URL`接続先だけを正式Production branchのpooled接続へ修正する
2. 同じsource commitのProduction Redeployを最大1回だけ行い、`/api/usage/status`と`/api/weekly-cycle`を各最大1回確認する
3. 両APIの復旧と正しいruntime接続先を確認した場合だけ、所有者による残りの認証済みProductionスモークを最小回数で再開する
4. 復旧完了後、Current Productionと最終検証結果を正式文書へ再同期する
5. 料金・利用上限・原価率、利用規約・プライバシー・Google / YouTubeポリシー適合を確定する
6. 正式仕様書で未実装または未確認とされた「期待効果」専用field、YouTube Analytics、決済、Standard / Pro等を、設計と実装を混同せず個別工程で扱う

Migration 0006のProduction適用とpostflightは完了しています。Persistence 500の接続先修正は未実施です。通常のVercel環境変数変更禁止は維持し、Runbookのincident限定手順と別の明示承認がある場合だけ`DATABASE_URL` 1件の修正へ進めます。今回の文書同期ではProduction、アプリコード、DB、Migration、schema、認証、API契約、利用上限、AI処理を変更しません。

## 今回の公開対象外

- YouTube Analytics API
- 自動成果比較
- Stripe
- メール・プッシュ等の外部通知機能
- Proの全動画処理
- トレンド分析
- 収益予測
- UI全面リニューアル

## 次の作業

次工程は、`docs/sync-production-incident-20260726`上の同期済みRunbookを根拠とした、Production `DATABASE_URL`接続先修正と同一source commitのRedeploy最大1回について、別途明示承認を受けることです。古い復旧指示は再利用しません。

この文書同期branchの作成・commit・pushはProduction操作と分離します。`main`へcommit、merge、pushせず、Production deploy、Vercel設定・環境変数、Production DB、Migration、Neon、Google Cloudを変更しません。文書上の識別子と後続の実状態がdocs-only commit / deployment分だけ異なる場合は、AGENTS / Runbookの全条件を読み取り専用で確認できた場合に限り、限定例外を適用できます。
