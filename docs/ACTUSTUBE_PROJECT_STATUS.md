# ActusTube Project Status

最終更新日：2026-07-29

> 2026-07-27 JSTの確認に基づく状態スナップショットです。release candidateは`main`へfast-forward統合済みで、`main` / `origin/main` は `08ec587f7a242b40ada53a0eb69acb33ebb9253b` で同期しています。Current Productionは同じsource commitをREADY / Currentで配信し、トップはHTTP 200です。Migration 0006は正式Production branchへexact 1回適用済みです。Production runtimeの`DATABASE_URL`接続先不一致は、Production scopeだけを正式Production branchの公式pooled接続へ修正し、同一source commitを1回Redeployして解消しました。`/api/usage/status`と`/api/weekly-cycle`はHTTP 200へ復旧し、動画あり最終スモークも合格しています。rollbackとrestoreは実施していません。

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

- Next.js 15.5.21
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
- Node.js 24.x
- npm 11.18.0
- `package-lock.json` lockfileVersion 3

## App Shell feature状態

- branch：`feat/app-shell-vidiq-inspired-beta-ux`
- HEAD：`a643e09303929537be6cc24bc34db5f756ab0447`
- Preview build：合格済み
- Production反映：未実施。`main`とCurrent Productionは引き続き`08ec587f7a242b40ada53a0eb69acb33ebb9253b`
- 認証済みApp Shell操作テスト：Next.js versionの文書不一致により未実施
- 次工程：文書同期後、ProductionとDB・OAuth・Environment Variablesを完全分離した認証済みstaging環境を構築し、認証済み操作を検証する

## Staging DB postflight verification基盤

- repository管理command：`npm run db:verify:staging`
- entry：`scripts/verify-staging-database-postflight.mjs`
- Runbook：[STAGING_DATABASE_RUNBOOK.md](./STAGING_DATABASE_RUNBOOK.md)
- direct / pooled双方をread-only transactionで確認し、Migration 0000〜0006のjournal、file hash、DB履歴、schema / object、function signature、owner、ACL、implicit PUBLIC EXECUTE、default privilege、security mode、fixed search path、runtime role権限、RLS / policy、同一論理database、合成UUIDによるread-only smoke、前後件数不変をfail-closedで判定する基盤を実装
- local verification：外部DB環境を除外した使い捨てPostgreSQLで、別owner / runtime role、正常系、direct / pooled別DB、schema drift、未知object、PUBLIC EXECUTE、grant option、column / sequence / default ACL、function default式、Migration hash不一致、secret redaction、read-only instrumentation、bounded cleanupを検証
- 実staging DB：未作成・未接続・未実行
- 実provider pooled endpoint：未実行のためtransaction pooler固有挙動はNOT TESTED
- 実staging owner / ACL：未検証
- Production DB：未接続・未変更
- Migration：ローカル使い捨てDBだけへ適用。外部DBへの適用なし
- 次工程：新しいfeature HEADを基準とした認証済みstaging環境構築・事前監査について、別のproject owner明示承認待ち

この基盤のlocal PASSを「staging DB検証済み」「staging構築完了」とは扱いません。1件でもFAIL、NOT VERIFIED、timeout、cleanup不明があればauthenticated staging工程へ進みません。

## Staging専用検索index防止基盤

- server / build側Environment Variable：`ACTUSTUBE_STAGING_NOINDEX`
- 有効条件：値が文字列`1`と完全一致する場合だけ
- header：`X-Robots-Tag: noindex, nofollow, noarchive, nosnippet`
- 適用範囲：全path。staging専用Vercel projectのProduction scopeだけに設定する
- default：未定義、空文字、`0`、`false`、その他の値ではheaderを追加しない
- Production保護：現在のProduction projectへ変数を設定せず、既存metadata、robots metadata、robots.txtを変更しない
- 検証：設定関数の自動テストと、staging条件を有効にしたProduction buildを必須とする。実deployment後はrootと正式8routeのresponse headerを確認する
- 実staging resource：未作成。Vercel、Neon、Google Cloud、OAuth、DB、Migration、deploymentは本実装工程の対象外

既存の認証済みstaging環境・完全構築指示は、このfeatureの新しい完全HEAD、`ACTUSTUBE_STAGING_NOINDEX`のscope、build時のexact値、deployment後のheader検証方法を反映して更新されるまで再利用しません。

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
- Migration対象Production branch自体に不整合はなく、Vercel Production runtimeの接続先branch不一致を修正した後はPersistence 500が解消しています。

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

Production復旧・動画あり最終スモーク：

- Productionの`DATABASE_URL`はProduction scopeだけに維持し、Sensitiveを維持したまま、Migration 0006適用済みの正式Production branchの公式pooled接続へ修正済み
- PreviewとDevelopmentの`DATABASE_URL`：各0件
- 同一source commitの復旧Redeploy：1回。追加Redeploy、Promote、Rollbackなし
- `/api/usage/status`と`/api/weekly-cycle`：各HTTP 200。PersistenceErrorの再発なし
- 所有チャンネル：1件取得・自動選択成功。通常動画2本、Shorts 1本を取得
- 分析：1回、HTTP 200。履歴0件→1件。分析時のAI同時生成・消費なし
- AI提案：1回、HTTP 200。履歴0件→1件
- 分析の日次利用枠：使用0→1、上限2、残り2→1
- 分析の月次利用枠：使用0→1、上限5、残り5→4
- AI提案の日次利用枠：使用0→1、上限1、残り1→0
- AI提案の月次利用枠：使用0→1、上限3、残り3→2
- 処理上限：通常動画10本、Shorts 10本
- 改善項目：`【Production Smoke】動画あり最終確認 2026-07-27`を1件作成。planned／進行中で再取得後も永続化を確認し、編集、結果メモ、skipped、削除は未実施
- 重複requestと重複利用枠消費：なし
- Browser Console error / warning、Production runtime error / fatal、HTTP 5xx：すべて0件
- 認証情報、Cookie、token、接続情報の取得・表示：なし

この結果により、今回のreleaseで確認対象としたProduction主要導線は合格です。未実装または未確認の将来機能、Standard / Proの完成を示すものではありません。

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
- 所有チャンネル：1件取得・自動選択成功
- 通常動画：2本取得成功
- Shorts：1本取得成功
- `/api/usage/status`：HTTP 200
- `/api/weekly-cycle`：HTTP 200
- Production `DATABASE_URL`：正式Production branchの公式pooled接続へ修正済み。Production scopeのみ、Sensitive維持
- Preview / Development `DATABASE_URL`：各0件
- Persistence 500復旧後のRedeploy：同一source commitで1回。追加Redeployなし
- 分析：1回成功、HTTP 200、履歴0件→1件
- AI提案：1回成功、HTTP 200、履歴0件→1件
- 利用枠：分析とAI提案を各1回分だけ消費。重複消費なし
- 改善項目：スモーク専用項目1件をplanned／進行中で保存し、再取得後の永続化を確認
- Browser Console error / warning、Production runtime error / fatal、HTTP 5xx：すべて0件
- rollback、restore、Promote：未実施
- このdeployment情報は確認時点のスナップショットであり、後続docs-only commitによって識別子が進んでも永続的にCurrentであることを意味しない

Persistence 500復旧に関する完了済み履歴：

- 以前の障害は、`/api/usage/status`の`UsageStatusPersistenceError`と`/api/weekly-cycle`の`WeeklyCyclePersistenceError`によるHTTP 500
- 根本原因は、Vercel Productionの`DATABASE_URL`がschemaの空の別Neon branchを参照し、Migration 0006適用済みProduction branchと接続先が不一致だったこと
- Previewの`DATABASE_URL`を削除し、Productionの`DATABASE_URL`だけを正しい公式pooled接続へ修正
- 同じsource commitを1回だけRedeploy
- 両APIのHTTP 200、PersistenceError再発なし、正式Production branchへのruntime activityを確認
- runtime error、fatal、HTTP 5xx：0件
- DBの直接修正、Migration再実行、rollback、restore：なし

復旧ではPreviewだけの`DATABASE_URL`を1件削除し、Productionの`DATABASE_URL`を1件更新しました。Developmentとその他の環境変数は変更していません。値、接続文字列、host、database名、role名、内部識別子は本書へ記録しません。これらは完了済みincidentに限定した操作であり、変更許可は終了しています。通常のVercel環境変数変更禁止を再適用しています。

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

Persistence 500はこのDBのMigration、schema、権限によるものではありませんでした。Production runtimeの接続先を正式Production branchの公式pooled接続へ修正した後は、主要読み取りAPIと動画あり最終スモークが正常です。実データ、接続文字列、host、database名、role名、内部識別子は本書へ追加しません。

## バックアップ兼リハーサルブランチ

- Migration 0006専用リハーサルchild branch：READYで保持中
- Production復旧用backup child branch：READYで保持中
- 両branchとも削除、変更、reset、restore、別用途への流用を行っていません
- 今回のdocs-only同期ではNeon操作を行いません

## 現在残っている作業

1. staging resourceを作成せず、新しいfeature HEADを基準とした認証済みstaging環境構築・事前監査の別承認を待つ
2. 復旧済みProductionを24〜48時間監視し、PersistenceError、runtime error、fatal、HTTP 5xx、利用枠の重複消費が再発しないことを確認する
3. 期限付きセキュリティ例外を初回2026-08-02、その後最低週1回の期限で再確認する
4. planned／進行中で残存するスモーク専用改善項目について、実在データを独断で変更・削除せず、project ownerがcleanup要否を判断する
5. 料金・利用上限・原価率、利用規約・プライバシー・Google / YouTubeポリシー適合を確定する
6. 正式仕様書で未実装または未確認とされた「期待効果」専用field、YouTube Analytics、決済、Standard / Pro等を、設計と実装を混同せず個別工程で扱う

Migration 0006のProduction適用、postflight、Persistence 500復旧、動画あり最終スモークは完了しています。incident限定の環境変数変更許可は終了しました。今回の文書同期ではProduction、アプリコード、DB、Migration、schema、認証、API契約、利用上限、AI処理を変更しません。

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

staging関連の次工程は、staging専用検索index防止を含むこのfeatureの新しい完全HEADを基準とし、`ACTUSTUBE_STAGING_NOINDEX=1`のscopeとheader検証を反映した完全構築指示を新たに承認することです。既存の完全構築指示は再利用しません。staging resourceはまだ作成せず、別の明示承認を待ちます。Production監視、期限付き例外の週次確認、plannedで残存するスモーク専用改善項目のcleanup判断も独立した工程として扱い、データ変更、環境変数変更、Redeploy、rollbackを必要とする場合は別の明示承認を受けます。

この文書同期branchの作成・commit・pushはProduction操作と分離します。`main`へcommit、merge、pushせず、Production deploy、Vercel設定・環境変数、Production DB、Migration、Neon、Google Cloudを変更しません。文書上の識別子と後続の実状態がdocs-only commit / deployment分だけ異なる場合は、AGENTS / Runbookの全条件を読み取り専用で確認できた場合に限り、限定例外を適用できます。
