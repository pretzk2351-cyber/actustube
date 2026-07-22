# ActusTube Project Status

最終更新日：2026-07-22

> 2026-07-22の状態スナップショットです。ProductionのDB接続資格情報を安全に復旧し、ユーザー本人による単一Googleログインと同時間帯のRuntime Logを確認しました。以前失敗していたGoogle OAuthアカウントのDB同期境界は正常に通過し、Production DB接続復旧は正式完了しています。今回限定のVercel Production `DATABASE_URL` 変更例外は終了し、通常の変更禁止規則が全面的に再適用されています。次工程はProduction復旧作業と分離した第1回UI改修です。

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

2026-07-22のProduction DB接続復旧完了後に読み取り確認した状態：

- `main`：`696d4b027d062e4f5dd85ed5af566194af70061f`
- `origin/main`：`696d4b027d062e4f5dd85ed5af566194af70061f`
- `main` と `origin/main`：0 / 0で同期済み
- 作業ツリー：clean
- `c6b403e`：週次改善サイクルのrelease candidate
- `2f79fa7`：Google OAuth callback互換性修正
- `509bf21`：Production認証障害に合わせた文書同期
- `c3e71ff`：安全な認証DB診断ログ
- `696d4b0`：Production DB接続復旧手順の文書化と復旧deploymentのsource

旧状態の `main` `92f834d`、`fix/weekly-action-duplicate-conflict` 未統合、診断ログ未公開、DB資格情報の復旧待ちは完了済みの履歴です。Production復旧用branchの作業は完了し、次の開発作業は `feat/ui-foundation-primary-flow` でProductionと分離して進めます。

## Vercel Production状態

2026-07-22のProduction DB接続復旧完了後スナップショット：

- Production Branch：`main`
- commit：`696d4b027d062e4f5dd85ed5af566194af70061f`
- deployment：`dpl_Gk8TkDoUfG5dbpdn3HKpEc5k36aa`
- domain：`https://actustube.vercel.app`
- 状態：READY / Current
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

旧deployment `dpl_HPGCXavawHj3yHKo9nFg99LGB6jR`、`dpl_BFQqxdLJqaFS6vVcPVfZvfVkmFGQ`、診断前の原因未確定状態は完了済みの履歴です。復旧ではVercel Productionの `DATABASE_URL` 以外を変更せず、Production DB本体やMigration 0000〜0005を変更・再適用していません。今回限定の環境変数変更例外は終了済みです。

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

1. 第1回UI改修で、分析結果から週次改善行動までの主要導線を明確にする
2. 共通カラー、背景、タイポグラフィ、余白、最大幅、ボタン、カード、入力欄を整理する
3. 既存状態判定を維持したままloading、empty、error表示を改善する
4. 自動テストと各レスポンシブ幅で検証する

Production復旧作業は完了しています。通常のVercel環境変数変更禁止が再適用されており、UI改修ではProduction、DB、Migration、schema、認証、API契約、利用上限、AI処理を変更しません。

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

次に実施する工程は、`feat/ui-foundation-primary-flow` で行う第1回UI改修です。既存の機能と表示データを維持し、分析結果から根拠、優先課題、今週の改善行動、確認指標へ自然に進める視覚構造と共通UI基盤を整えます。

この工程はProduction復旧作業から分離します。`main` への統合、Production deploy、Vercel設定・環境変数、Production DB、Migration、Neon、Google Cloudの変更は行いません。
