# ActusTube Project Status

最終更新日：2026-07-21

> Vercel、Neon Production DB、過去の検証結果に関する記載は、引き継ぎ時に提示された直近確認情報です。この文書の作成作業では、Production DBへの接続、Vercel操作、テスト再実行を行っていません。次工程の開始時に、Runbookの停止条件に従って実状態を読み取り確認してください。

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

この修正コミットは `fix/weekly-action-duplicate-conflict` に存在し、`main` へは未統合です。

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

引き継ぎ時に提示された最新確認済み結果です。この文書作成時には再実行していません。

- 通常テスト：153件成功
- 実DB専用4件は通常実行時skip
- 重複作成関連実DB検証：4/4成功
- 関連実DBテスト：48/48成功
- ESLint：0エラー、既存の `<img>` 警告1件
- TypeScript：成功
- Production build：成功
- `npm audit`：脆弱性0件
- `drizzle-kit check`：成功
- Schema drift：なし
- `git diff --check`：成功
- 秘密情報混入：なし
- UI幅320、375、390、768、1024、1440で横はみ出しなし

## Git状態

文書作成前の読み取り確認結果：

- 現在ブランチ：`fix/weekly-action-duplicate-conflict`
- HEAD：`35b9615ce474194277e35921b628744f8dc640e5`
- upstream：`origin/fix/weekly-action-duplicate-conflict`
- fixブランチとupstream：0 / 0で同期済み
- 作業ツリー：文書作成前はclean
- `main`：`92f834ddc77d5a8134904dce4ccbb38eced8ac14`
- `origin/main`：`92f834ddc77d5a8134904dce4ccbb38eced8ac14`
- `main` と `origin/main`：0 / 0で同期済み

この文書を含む3ファイルは、`fix/weekly-action-duplicate-conflict` 上の1つの文書コミットとして保存・pushする対象です。`main` へのmergeは未実施です。保存後のcommit SHA、upstreamとの同期状態、作業ツリーの状態はGit履歴と `git status` で確認してください。

## Vercel Production状態

引き継ぎ時に提示された直近確認情報：

- Production Branch：`main`
- 現在Productionで稼働中の安定コミット：`5964c2d749d14eff04ea356be14166fa7eb5f4dc`
- `92f834d` のProductionはDB未準備のためInstant Rollback済み
- 現在のProduction状態：READY
- HTTP 200確認済み
- 直近確認で不要な404・500なし
- GitHub `main` 自体は `92f834d` のまま
- Vercel Productionだけ旧安定デプロイへ戻している

## Production DB

引き継ぎ時には、Vercel Productionの接続設定から秘密情報を表示せずEndpoint IDだけを取得し、照合済みと報告されています。

実Production DB：

- Neon Project：ActusTube
- Project ID：`small-night-17748387`
- Branch name：`development`
- Branch ID：`br-blue-bonus-aza51iwc`
- Endpoint ID：`ep-polished-cloud-az8xdsqg`
- Database：`neondb`

重要：Neon上のブランチ名は `development` ですが、Vercel Productionが実際に接続しているためProduction DBとして扱います。削除、リセット、テスト用途への流用は禁止です。

引き継ぎ時点のProduction DB状態：

- Migration履歴：5件
- 0000〜0004相当が適用済み
- Migration 0005：未適用
- `analysis_runs`：未作成
- `improvement_actions`：未作成
- `improvement_action_status`：未作成
- `users`：1件
- `oauth_accounts`：1件
- `plans`：1件
- `user_plan_assignments`：1件
- `user_usage_buckets`：0件
- `usage_reservation_leases`：0件

実データの内容、ユーザー情報、認証情報、接続情報の秘密部分は記載しません。

## バックアップ兼リハーサルブランチ

- Name：`pre-weekly-mvp-production-backup-20260720`
- Branch ID：`br-crimson-shadow-azkeq0kc`
- Endpoint ID：`ep-still-bar-azv826h8`
- Parent：`br-blue-bonus-aza51iwc`
- Database：`neondb`
- 状態：Ready
- 削除せず保持中

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

1. Production DB本体へMigration 0005を適用
2. Migration適用後にDBオブジェクトと既存データ維持を確認
3. `fix/weekly-action-duplicate-conflict` を `main` へ統合
4. `main` 上で全自動検証
5. `origin/main` へpush
6. Vercel自動Productionデプロイ確認
7. Productionスモークテスト
8. Productionログ・Console・Network確認
9. 安定確認後にバックアップブランチの扱いを判断
10. ProductionとdevelopmentのNeonブランチ構成を後日整理

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

次に実施する工程は、Production DB本体へのMigration 0005適用と、適用後の読み取り確認です。

`main` 統合・push・デプロイは同じ工程では行いません。開始前に [Production Release Runbook](./PRODUCTION_RELEASE_RUNBOOK.md) を読み、記載内容とGit・Vercel・Neonの実状態が一致しない場合はMigrationを実行せず停止してください。
