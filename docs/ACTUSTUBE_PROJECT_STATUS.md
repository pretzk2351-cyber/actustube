# ActusTube Project Status

最終更新日：2026-07-22

> 2026-07-22の状態スナップショットです。安全な認証DB診断ログをProductionへ公開し、ユーザー本人による単一ログインで障害原因をDBパスワード認証失敗と確定しました。次工程は、今回限定の例外としてVercel Productionの `DATABASE_URL` だけを復旧する作業です。次工程でもRunbookの停止条件に従って実状態を再確認してください。

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

## 検証結果

release candidate作成時に再実行した確認結果です。

- 通常テスト：153件成功
- 実DB専用4件は通常実行時skip
- 重複作成関連実DB検証：4/4成功
- 関連実DBテスト：48/48成功
- ESLint：0エラー、既存の `<img>` 警告1件
- TypeScript：成功
- Production build：成功
- `npm audit`：脆弱性0件。間接dev依存の `brace-expansion` を1.1.14から修正版1.1.16へlockfile内で更新
- `drizzle-kit check`：成功
- Schema drift：なし
- `git diff --check`：成功
- 秘密情報混入：なし
- UI幅320、375、390、768、1024、1440で横はみ出しなし

## Git状態

2026-07-22のProduction DB接続復旧作業開始前に読み取り確認した状態：

- `main`：`c3e71ffdf5b66f97e1303f9e3f62481b7f725f2a`
- `origin/main`：`c3e71ffdf5b66f97e1303f9e3f62481b7f725f2a`
- `main` と `origin/main`：0 / 0で同期済み
- 作業ツリー：clean
- `c6b403e`：週次改善サイクルのrelease candidate
- `2f79fa7`：Google OAuth callback互換性修正
- `509bf21`：Production認証障害に合わせた文書同期
- `c3e71ff`：安全な認証DB診断ログ

旧状態の `main` `92f834d`、`fix/weekly-action-duplicate-conflict` 未統合、診断ログ未公開は完了済みの履歴です。次の作業ブランチは `fix/production-database-url-recovery` とし、文書同期後に今回限定のProduction接続復旧を実施します。アプリコードは変更しません。

## Vercel Production状態

2026-07-22のProduction DB接続復旧作業開始前スナップショット：

- Production Branch：`main`
- commit：`c3e71ffdf5b66f97e1303f9e3f62481b7f725f2a`
- deployment：`dpl_HPGCXavawHj3yHKo9nFg99LGB6jR`
- domain：`https://actustube.vercel.app`
- 状態：READY / Current
- `redirect_uri_mismatch`：解消済み
- OAuth callbackの `missing iss`：解消済み
- callbackは `/api/auth/callback/google` まで到達
- 安全な診断ログ：実装・検証・Production公開済み
- 本人による単一ログイン：実施済み。追加ログインは未実施
- 現在のブロッカー：Runtimeが使用する `DATABASE_URL` のDBパスワード認証失敗
- Neon / PostgreSQLが `sync_google_oauth_account` のSQL実行前に接続認証を拒否
- timeout、fetch失敗、接続リセットではない
- Migration、DB関数、schema、制約、権限の問題ではない

旧deployment `dpl_BFQqxdLJqaFS6vVcPVfZvfVkmFGQ` と診断前の原因未確定状態は完了済みの履歴です。Production DB本体やMigrationは変更せず、Migration 0000〜0005を再適用しません。

## Production DB

ローカルの接続設定を秘密情報を表示せず解析し、明示的なread-only transactionでEndpoint IDとDatabaseを再確認しました。

実Production DB：

- Neon Project：ActusTube
- Project ID：`small-night-17748387`
- Branch name：`development`
- Branch ID：`br-blue-bonus-aza51iwc`
- Endpoint ID：`ep-polished-cloud-az8xdsqg`
- Database：`neondb`

重要：Neon上のブランチ名は `development` ですが、Vercel Productionが実際に接続しているためProduction DBとして扱います。削除、リセット、テスト用途への流用は禁止です。

2026-07-21のProduction DB状態：

- Migration履歴：6件
- 0000〜0005がjournalの順序どおり適用済み
- Migration 0005：適用済み。再適用は禁止
- journalの6つの `when` とDB履歴の `created_at`：すべて一致
- Drizzleと同じSHA-256計算で、0005は現在のファイルと一致
- 0000〜0004は現在のWindows作業ツリーのCRLFではhashが異なるが、LFへ正規化した同一SQL本文と一致。SQL内容変更ではなく改行コード差であり、Drizzleは最新の `created_at` とjournalの `when` により適用済みと判断する
- `analysis_runs`：作成済み、0件
- `improvement_actions`：作成済み、0件
- `improvement_action_status`：作成済み（`planned` / `completed` / `skipped`）
- Migration 0005のIndex・制約・関数：`schema.ts`、Migration SQL、0005 snapshotと一致
- 2つの確定関数：`SECURITY INVOKER`、固定 `search_path`、PUBLIC実行権限なし
- `users`：1件
- `oauth_accounts`：1件
- `plans`：1件
- `user_plan_assignments`：1件
- `user_usage_buckets`：0件
- `usage_reservation_leases`：0件

実データの内容、ユーザー情報、認証情報、接続情報の秘密部分は記載しません。

管理外テーブル `playing_with_neon` が1つ存在し、40件の行があります。コード、`schema.ts`、Migration、テストから参照されておらず、ActusTube管理オブジェクトとの名前衝突もありません。Neonのサンプルテーブルとしてアプリ管理Schemaの比較対象から除外し、削除・変更・Migrationへの追加は行いません。ActusTube管理対象のSchema driftはありません。

## バックアップ兼リハーサルブランチ

- Name：`pre-weekly-mvp-production-backup-20260720`
- Branch ID：`br-crimson-shadow-azkeq0kc`
- Endpoint ID：`ep-still-bar-azv826h8`
- Parent：`br-blue-bonus-aza51iwc`
- Database：`neondb`
- 状態：Ready
- 削除せず保持中

この既存ブランチはMigrationリハーサルに使用済みです。

週次改善サイクルProduction公開前には、当時のProduction DBを基点に次のバックアップを作成し、Readyを確認済みです。

- Name：`backup-pre-release-20260721-c6b403e`
- Branch ID：`br-withered-darkness-azjg6fpl`
- 状態：Ready

今回の認証診断ログ追加ではDB・Migrationを変更しないため、新たなNeon branch作成やMigration実行は行いません。

このブランチでは、引き継ぎ時点で次が合格済みと報告されています。

- 親ブランチとのMigration履歴・データ件数一致
- Migration 0005適用
- 履歴5件から6件
- 新テーブル・enum・Index・外部キー・関数作成
- `SECURITY INVOKER`
- 固定 `search_path`
- PUBLIC実行権限なし
- Googleログイン
- YouTube分析
- 分析履歴保存
- AI提案保存
- 改善項目作成・編集
- `completed` / `skipped`
- 結果メモ
- 重複作成409
- API 500なし
- 既存データ維持
- テストデータ削除

## 現在残っている作業

1. `fix/production-database-url-recovery` で今回限定の復旧手順を文書commitとして保存
2. 対象branch・database・endpoint・既存Production Runtime用role・pooled構成を非秘密情報で照合
3. 有効なpooled接続URIを表示・保存せず取得
4. `BEGIN READ ONLY; SELECT 1; ROLLBACK;` だけで接続確認
5. Vercel Production scopeの `DATABASE_URL` だけを更新
6. 文書commitを `main` へfast-forward統合して通常push
7. 新しいProduction deploymentを1件だけ作成し、READY / Currentを確認
8. 未認証スモークテストを実施
9. ユーザー本人によるGoogleログイン1回の直前で停止

認証済みスモークテスト、AI提案、DB・データ・Migration・schema・関数・権限、Neon構成、Google Cloud、`DATABASE_URL` 以外の環境変数変更はこの工程に含めません。

## 今回の公開対象外

- YouTube Analytics API
- 自動成果比較
- Stripe
- 通知
- Proの全動画処理
- トレンド分析
- 収益予測
- UI全面リニューアル

## 次の作業

次に実施する工程は、今回限定の例外としてVercel Productionの `DATABASE_URL` だけを有効なpooled接続資格情報へ更新し、同じアプリコードを新しいProduction deploymentへ公開することです。Production DB本体、Migration 0000〜0005、関数、schema、権限、Neon branch、Google Cloud、他の環境変数は変更しません。

新deploymentの未認証確認後、Googleアカウント選択など本人操作の直前で停止します。ユーザーがログインを1回行った後にRuntime Logを読み取り、復旧結果を判定します。開始前に [Production Release Runbook](./PRODUCTION_RELEASE_RUNBOOK.md) を読み、記載内容とGit・Vercel・Neonの実状態が一致しない場合は停止してください。
