# ActusTube Project Status

最終更新日：2026-08-24

> Production節は2026-07-27 JSTの確認に基づく履歴スナップショットです。2026-08-14のharness redesign自体ではGitHub Actions、Vercel、Neon、Google Cloudへ接続しておらず、Production / provider状態は再確認していません。その後、GitHub Actions run `32639709042`とphase observabilityを追加したrun `32684794700`はいずれもPostgreSQL 18.6 service-container gateで`RUN / FAILED`でした。subphase化後のrun `32695896204`も`RUN / FAILED`で、固定markerはexplicit runtime executionを示しました。Migration本体とactual harness query pathの静的照合により、`SECURITY INVOKER`関数を実行するtemporary fixture roleにfunction bodyのobject privilegeが不足することをroot causeとして確定しました。raw PostgreSQL errorは根拠に使用していません。local body ACL fix commit `5ac1849a0dbf4418bf820b09b120a95c51aff83b`は独立reviewでP2 5件が確認されたため未pushで保持し、本follow-upはその5件だけを修正します。combined two-commit PostgreSQL 18.6 external gateは本follow-up commit時点で`NOT RUN`です。

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

## Staging DB preflight / postflight verification基盤

- Migration前preflight command：`npm run db:preflight:staging`
- preflight entry：`scripts/verify-staging-database-preflight.mjs`
- Migration後postflight command：`npm run db:verify:staging`
- postflight entry：`scripts/verify-staging-database-postflight.mjs`
- Runbook：[STAGING_DATABASE_RUNBOOK.md](./STAGING_DATABASE_RUNBOOK.md)
- preflightは、既存postflightのstaging URL分類、provider identity照合、read-only transaction、timeout、固定エラー分類、bounded cleanupを共用しつつ、Migration適用済みschema判定とは分離する。URL queryは`sslmode=require`と`channel_binding=require`だけをdecode後のpositive allowlistで受理し、未知・重複・空key / value・routing / credential / local-file参照parameterを接続前に拒否する。database / usernameは非曖昧なsafe grammarへ限定し、percent-encoded delimiter、double encoding、malformed escapeを拒否する。接続せず生成したNeon clientの実効host / port / database / userとsafety layerをdirect / pooledごとに照合し、driver実効databaseへstaging markerを適用する。固定read-only queryでPostgreSQL versionと`current_user`を取得し、URL roleとの一致を要求する。正式対象をmajor 18だけに限定し、direct / pooledのbefore / afterすべてでmajor 18かつ同一versionを要求する。取得不能はexit code 3、major 18以外または検証済み不一致はexit code 1でMigrationを禁止する。reportへ実versionやroleは出さず固定statusだけを返す
- preflightが許可する初期状態は、Migration管理schema自体がないpristine状態、またはDrizzle runnerが事前作成し得るexact形状のmigration tableが履歴0件で存在する状態だけ。既知のActusTube名に限定せずuser-defined residual objectを固定catalog queryで列挙し、system schemaを限定除外する。extension evidenceをcandidate signature単位へ集約し、direct membershipと正式`_RETURN` rule／FK enforcement triggerだけを`managed support`、generic `deptype='a'`・非許可internal・後付けobjectを`residual support`、candidate markerと通常構造参照`deptype='n'`を`neutral evidence`とする。managed＋residual混在、neutral-only、未知・欠落・重複はexit code 3であり、managed supportの存在だけでresidual evidenceを無視しない。`pg_extension.extnamespace`一致やprovider風名称だけでは許可しない。candidate／evidence、computed／SQL managed、computed／SQL residualをすべて双方向完全照合し、candidate・evidence signature一意、candidate総数＝managed＋residual、両集合の交差0件、residual／object signature／集計一致を要求する。hidden residual、片側へ寄せるfalse-clean、direct / pooled差、before / after差を拒否する
- 空migration tableは正式3 columns、primary key、serial sequence、relation property、ownership / default dependencyに加え、sequence現在状態が`last_value=1`かつ`is_called=false`であることまで検証する。`pg_attribute`はrelation対応、物理列数、attnum順序、drop / inheritance、built-in type、length / pass-by-value / alignment、typmod / dimension、domain、identity / generated、collation、NOT NULL、default有無、ACL / option / FDW option、storage / compression、fresh PostgreSQL 18での単一`attstattarget IS NULL`状態をexact検証する。`pg_class`はrelation kind、namespace、access method、persistence、replica identity、RLS、populated / partition / shared / rewrite / row-type / typed-table、TOAST、tablespace等のstable fieldを検証し、物理配置・planner統計・VACUUM / freeze / transaction依存fieldだけをfield別理由付きで除外する。`pg_index`は正式全fieldをexact値、relation対応、sanitized vector、null状態へ分類し、`pg_constraint`はprimary key／NOT NULLの正式全field、action chars、FK／exclusion配列、expressionまでcoverageする。stable fieldの未検査とcatalog field取得不能を拒否し、direct / pooled初回・相互比較・再取得・前後比較へ同じversion / catalog / sequence evidenceを含める。applied 0件、pending 0000〜0006 exact 7件、user-defined object / data 0件を要求し、実値はreportへ出さず固定statusだけを返す
- direct / pooled双方をread-only transactionで確認し、Migration 0000〜0006のjournal、file hash、DB履歴、schema / object、function signature、owner、ACL、implicit PUBLIC EXECUTE、default privilege、security mode、fixed search path、runtime role権限、RLS / policy、同一論理database、合成UUIDによるread-only smoke、前後件数不変をfail-closedで判定する基盤を実装
- external fixture verification：PostgreSQLの起動、停止、port確保、data directory、PID、kill、filesystem cleanupはrepository harnessから完全に除外し、GitHub Actions Linux service containerだけをlifecycle ownerとします。接続専用verifierは5個の専用Environment Variableだけから、lowercase `postgres` / `postgresql`、raw numeric `127.0.0.1`、明示port、expected database / role、major 18、Migration max 0006を接続前に検証し、missing時は`EXTERNAL_FIXTURE_NOT_CONFIGURED`で停止します。GitHub Actionsではdigest固定`postgres:18.6-bookworm`の使い捨てfixtureへ、空migration ledgerのproduction preflight、fresh before / after、第三session drift、extension分類4種、Migration 0000〜0006、再適用時重複0、transaction rollback、schema / owner / ACL / function / index / FK / unique / check / type / default / nullability / ledgerを含むpostflight、postflight driftを通します。通常のlocal Vitestは実DBへ接続せず、URL boundary、秘密情報非出力、権限境界、distinct owner / executorのfake Client検証、独立deadline context、固定benign Node childによる親観測P3だけを実行します。このworkflowの実行履歴は下記のimmutable recordに記載します。run `32639709042`は`RUN / FAILED`であり、generic markerへ集約されたため、external fixture内のpreflight、Migration、cleanup、postflightのどこまで到達・完了したかは確定していません。実Neon catalog／transaction pooler／staging owner／ACL、provider driverのnative cancellation、advisory lockは引き続きNOT VERIFIEDまたはNOT TESTEDです
- repository-owned lifecycle authority removal：旧local postflight command、旧local Migration command、対応する4 script、`embedded-postgres`とplatform package設定を削除し、connection-only verifierが直接使う`pg`だけを既存lock内versionで固定します。使い捨てexternal fixture内だけにfixed `NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`のdistinct legacy ownerとMigration executorを作成する設計です。0000〜0005はexecutorの実効roleで適用し、legacy functionをlegacy ownerへ変更して必要なmembershipを付与します。0006直前にsession / effective role、owner / executor名・OID、membershipをcatalogで照合し、legacy ownerとは異なるexecutorとして0006を適用した後、legacy functionと全versioned functionのowner名・OIDがexact legacy ownerであることをACL、security mode、search pathとともに確認します。旧usage Migration harnessのDB意味契約は、0005互換性、PUBLIC依存時の0006原子的拒否、plan fallback / fail-closed、同時予約上限、release / finalize / stale recoveryとしてconnection-only verifierへ統合しました。fixture extension expectedは固定`plpgsql` / `1.0` / `pg_catalog` contractから生成し、actualはProduction SQLと共有しない独立catalog queryで照合します。全DB operationは単一のmonotonic total deadline 300,000ms以下に束縛し、connect 10,000ms、client query 30,000ms、statement 20,000ms、lock 5,000ms、idle transaction 20,000ms、close 5,000ms以下です。timeout時は対象contextのowned `pg.Client` socketだけを破棄し、同じClientの追加query、ROLLBACK、`RESET ROLE`、owner query、probe、再利用を行いません。独立contextのunrelated Clientは自身のbounded closeで終了します。P3 benign child oracleは別moduleへ分離し、connection-only verifierは`node:child_process`をimportしません。local fake Client / unit testはactual PostgreSQL PASSではありません。GitHub Actions run `32684794700`がbroad `MIGRATION_POSTCONDITIONS`で`RUN / FAILED`だったことはimmutable historyです。後続run `32695896204`はexplicit runtime executionを示し、body ACL fixと本follow-upのcombined qualification runはcommit時点で`NOT RUN`です
- final ownership workflow candidate：productionとlocal fake-client testは、role作成、executor / distinct legacy ownerの初期属性検証、限定grant、同一bounded Client上の0000〜0005 / 0006 / replay callback、0006直前precondition、直後とreplay後のowner postconditionを管理する単一のinternal orchestrationを共有します。executorには使い捨てfixtureの`drizzle` schemaだけへ`USAGE, CREATE`を付与し、PUBLIC、runtime role、production postflight契約は緩和しません。distinct legacy-owner inheritance、ACL、SECURITY INVOKER、固定search path、membership、replayを検証した後だけ、固定repository allowlistと独立catalog inventoryが一致する場合に限り、expected table / index依存、enum、exact function signature、migration ledger、`public` / `drizzle` schemaをfixture session ownerへtype-specificにcanonicalizeします。`REASSIGN OWNED`は使用しません。独立post-canonical snapshotで全ownerがsession roleであることを確認した後、temporary executor / legacy ownerについてACLのgrantee側とgrantor側、direct / recursive / effective membership、ownership、shared dependencyを独立inventoryします。正常contractはfixture session roleからexecutorまたはlegacy ownerへ付与されたexplicit ACL 11行とmembership evidence 3行の合計14行で、target roleがgrantorとなるACLはunexpected authorityとしてcleanup前に拒否します。`pg_shdepend.deptype = 'a'`はclass / object / column subobject単位でexplicit ACLとのcoverageを照合する未列挙ACL dependency backstopとし、covered ACLを二重計上しません。固定14行との完全一致時だけdatabase / schema / ledger table / sequenceの限定REVOKE 6件とlegacy membership REVOKE 1件を実行し、bounded cleanupを7 REVOKEから拡張しません。cleanup後はACLのgrantee / grantor、未列挙ACL dependency、membership、ownershipを含む同じinventoryのexact 0行とcanonical ownerの維持を再確認し、bounded Clientの正常close後にだけproduction postflightを1回開始します。local testの7 REVOKE oracleはproduction実装から独立したexact SQL / parameter contractで、wrong object / role / privilege / orderではfake authority stateを削除しません。欠落・余分・重複・未知権限、REVOKE失敗、残存、owner drift、timeoutではpostflight開始0です。`DROP OWNED`、`REASSIGN OWNED`、role / database / schema削除は行いません。local fake-client検証はactual PostgreSQLの権限・catalog・Migration成功を証明しません。GitHub Actions PostgreSQL 18.6 gateのrun `32639709042`は`RUN / FAILED`で、underlying failure phaseは`NOT IDENTIFIED`です。実staging / Production / Neon / pooler owner・ACLは引き続きNOT VERIFIEDで、repositoryがPostgreSQL process、port、PID、data directory、停止、削除を所有するauthorityは0のままです
- grantor identity binding：connection configurationのroleは最初のMigration ClientでDB identityを照合するための事前期待値に限定します。productionとfake probeが共有するpre-mutation boundaryは、接続とtimeout設定後の最初のfixture-level queryとして`session_user`と`current_user`をexact 1-row contractで観測し、両者とconfiguration roleの一致を検証してからだけ`ALTER DEFAULT PRIVILEGES`、role作成、GRANT、Migration callbackを開始します。mismatch、query failure、timeout時のfixture mutationは0です。最初のactual `session_user`から作成したexact `sessionRole` keyだけのfrozen objectを唯一のdownstream grantor authorityとして保持し、Migration boundaryの再観測は値比較だけに使ってobjectを置換しません。expected 11 ACL rowsのgrantor、owner canonicalization、temporary-authority contract、cleanup identity比較は同じoriginal object referenceへ束縛します。cleanup Clientでは最初のqueryで`session_user` / `current_user`を再観測し、ownership inventory、canonicalization、`ALTER ... OWNER`より前にoriginal frozen identityとの一致を要求します。cleanup identity mismatch、query failure、timeout時はowner change、ownership / authority inventory、REVOKE、postflightを0にします。caller configuration、initial / boundary / cleanup DB-observed identity、fake actual ACL grantorはtest fixtureで独立した入力・stateとして扱います。fake Clientはactual PostgreSQLの証明ではありません。run `32684794700`のbroad-marker failureはimmutable historyであり、後続run `32695896204`はexplicit runtime executionで`RUN / FAILED`でした。body ACL fixと本follow-upのcombined qualification runはcommit時点で`NOT RUN`、実staging / Production / Neon / poolerは`NOT VERIFIED`、repository-owned PostgreSQL lifecycle authorityは0のままです

- GitHub Actions external fixture execution history（immutable）：workflow `Staging database preflight fixture`、run `32639709042`、head SHA `6aa050888b24a20b231d245b05d292bcebec3ccb`、PostgreSQL 18.6 service-container gate `RUN / FAILED`、observed public marker `EXTERNAL_FIXTURE_VERIFICATION_FAILED`、underlying failure phase `NOT IDENTIFIED`。failureはgeneric markerへ集約され、どのproduction phaseで失敗したか、fixture内のpreflight / Migration / cleanup / postflightがどこまで開始・完了したかは特定できません。この履歴はactual PostgreSQL defectを修正済み、root cause確定、またはPostgreSQL 18.6 gate PASSとは扱いません。
- GitHub Actions phase observability execution history（immutable）：workflow `Staging database preflight fixture`、run `32684794700`、head SHA `a8b6cfbc9fb5e9ac7fd29729adff52c4226aa327`、PostgreSQL 18.6 external fixture gate `RUN / FAILED`、observed fixed marker `EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_POSTCONDITIONS` exact 1件、phase localization `MIGRATION_POSTCONDITIONS`、exact call site `NOT IDENTIFIED`、underlying root cause `NOT IDENTIFIED`。known marker exact 1件によりpublic-safe observabilityはqualifiedですが、このphaseはfinal Migration直後のowner postcondition、Migration replay直後のowner postcondition、後段usage-security verification groupの3箇所に再利用されていたためcall siteまでは特定できません。この履歴はactual PostgreSQL behaviorを修正済みまたはgate PASSとは扱いません。
- Migration postcondition subphase observability candidate：今回の変更は上記3箇所を固定ASCII subphaseへ分け、後段helper内もowner / ACL / privilege / security、plan-resolution control、reservation lifecycle、runtime ACL configurationの異なるexisting await境界へ追加queryなしで分類するobservability-only変更です。旧`MIGRATION_POSTCONDITIONS`はimmutable履歴とnegative test以外のruntime allowlistから外し、unbranded messageは`UNKNOWN`へ固定します。underlying PostgreSQL behavior、SQL、query parameter / count / order、Migration、ownership、ACL、cleanup、deadline、Client lifecycleは修正対象にしません。新subphase-marker commitのexternal gateはcommit時点で`NOT RUN`です。raw error、error message、stack、cause、SQL、URL、credential、host、port、database、session / executor / legacy-owner role、OID、ACL / membership / catalog rowをpublic outputへ追加しません。fake Clientはactual PostgreSQL semanticsの証明ではなく、actual Neon / staging / Production / poolerは`NOT VERIFIED`、actual staging preflight / Migration / postflightは`NOT RUN`、repository-owned PostgreSQL lifecycle authorityは0です。
- explicit runtime body ACL fix candidate：GitHub Actions run `32695896204`はPostgreSQL 18.6 external fixtureで`RUN / FAILED`、observed markerは`EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_EXPLICIT_RUNTIME_EXECUTION`でした。raw PostgreSQL errorではなく、Migration 0006の`SECURITY INVOKER` function bodyとactual verifier invocationの静的照合によりbody-object privilege不足をroot causeとして確定しました。final Migration、owner postcondition、replay、replay owner postconditionの後だけ、fixed manifestからtemporary explicit runtime roleとmembership runtime groupへ必要最小限のtable privilegeをdirect grantし、membership leafはgroup inheritanceだけを使用します。各GRANT / REVOKEはoriginal DB-observed frozen session identityを`GRANTED BY`へ固定し、configuration / caller roleへfallbackしません。denied role、PUBLIC、Production runtime role、Migration executor、legacy ownerへの拡張は0です。GRANT後はgrantor / grantee / grant option / shared ACL dependencyを含む18-row catalog inventoryとの完全一致を要求し、usage / plan / reservation verificationの成功・失敗後に同じfixed manifestのbounded REVOKEを試行します。`configureRuntimeAcl()`より前に同じinventoryのexact zero residueを要求し、未確認または残存時は後段へ進みません。Migration、application runtime、workflowは変更しません。fake Client oracleはactual PostgreSQL semanticsを証明せず、新commitのPostgreSQL 18.6 external gateはcommit時点で`NOT RUN`、actual staging / Production / Neon / poolerは`NOT VERIFIED`、Production Migration / deploymentは`NOT RUN`、repository-owned PostgreSQL lifecycle authorityは0です。
- body ACL review findings follow-up：local commit `5ac1849a0dbf4418bf820b09b120a95c51aff83b`は、timeout後のactual REVOKE、fresh mutation Client identity、observed-grantor inventory、REVOKE oracle、文書current-stateのP2 5件が独立reviewで確認されたため未pushで保持しました。本follow-upは最初のtemporary GRANT前に、connect 1、identity query 1、REVOKE query 1、zero-residue query 1、close 1の既存上限からcleanup budgetを静的予約します。business timeout後もoriginal absolute deadlineを延長・resetせず、別`timedOut` stateとfresh owned Clientを持つcleanup-only contextでidentity-first、actual bounded REVOKE、zero-residue、bounded closeを実行し、元のprimary failureを維持します。fresh GRANT / REVOKE Clientはoriginal DB-observed frozen identityとの一致後だけmutationを開始します。inventoryはexpected recipientがgranteeのACLに加えoriginal observed grantorから全non-owner recipientへのACLを必須parameterで列挙し、unknown third recipientを期待集合へ加えず拒否します。test-local REVOKE oracleはaction-awareなSQL / parameter mutationを各caseで実差分確認し、unknown / unrelated authorityを誤って消しません。fake Clientはactual PostgreSQL semanticsを証明しません。combined two-commit PostgreSQL 18.6 gateは本follow-up commit時点で`NOT RUN`、actual staging / Production / Neon / poolerは`NOT VERIFIED`、Production Migration / deploymentは`NOT RUN`、repository-owned PostgreSQL lifecycle authorityは0です。
- staging専用provider resource：文書上は別の承認済み工程で作成済み。今回のlocal product recoveryではprovider状態をNOT VERIFIED
- 実staging DB：未接続。preflight、Migration、postflightはすべて実行0回
- 実provider pooled endpoint：未実行のためtransaction pooler固有挙動はNOT TESTED
- Production非複製：DB queryでは証明せず、provider metadata preflightで別途証明する必須gateを維持
- 実staging owner / ACL：未検証
- Production DB：未接続・未変更
- Migration：履歴上の明示承認済みlocal使い捨てDBだけへ適用。GitHub Actions run `32684794700`のbroad-marker failureと、後続run `32695896204`のexplicit runtime execution failureはimmutable historyです。実staging / Production DBへのMigration適用は0回で、body ACL fixと本follow-upのcombined qualification runはcommit時点で`NOT RUN`です
- 次工程：本follow-upのlocal validationとcombined two-commit independent reviewを完了し、blocking finding 0の場合だけfeature branchへnormal push exact 1回を行い、新HEADのautomatic PostgreSQL 18.6 workflowを監視する。Draft PR、staging構築、Production、provider、Migration、deploymentは別承認まで開始しない

local unit PASSまたは将来のGitHub Actions disposable fixture PASSを「実staging DB検証済み」「staging構築完了」とは扱いません。1件でもFAIL、NOT VERIFIED、timeout、結果不明があればauthenticated staging工程へ進みません。

## Staging専用検索index防止基盤

- server / build側Environment Variable：`ACTUSTUBE_STAGING_NOINDEX`
- 有効条件：値が文字列`1`と完全一致する場合だけ
- header：`X-Robots-Tag: noindex, nofollow, noarchive, nosnippet`
- 適用範囲：全path。staging専用Vercel projectのProduction scopeだけに設定する
- default：未定義、空文字、`0`、`false`、その他の値ではheaderを追加しない
- Production保護：現在のProduction projectへ変数を設定せず、既存metadata、robots metadata、robots.txtを変更しない
- 検証：設定関数の自動テストと、staging条件を有効にしたProduction buildを必須とする。実deployment後はrootと正式8routeのresponse headerを確認する
- staging専用resourceと`ACTUSTUBE_STAGING_NOINDEX`設定：別の承認済み工程で作成・設定済み。DB接続、Migration、deploymentは未実施

既存の認証済みstaging環境・完全構築指示は、このfeatureの新しい完全HEAD、`ACTUSTUBE_STAGING_NOINDEX`のscope、build時のexact値、deployment後のheader検証方法を反映して更新されるまで再利用しません。

## 承認済み期限付きセキュリティ例外

現在のProduction sourceには、[GHSA-mh99-v99m-4gvg / CVE-2026-14257の正式な期限付き例外](./SECURITY_EXCEPTION_GHSA-MH99-V99M-4GVG.md)を含む承認済みrelease candidateが統合されています。

- 対象：`brace-expansion` のdevDependency lint経路にあるGHSA-mh99-v99m-4gvgだけ
- 承認日：2026-07-26
- 失効日：2026-08-24 23:59 JST
- 初回週次確認期限：2026-08-02
- Runtime `npm audit --omit=dev`：全severity 0件
- full `npm audit`：exit code 1、High 1件、Critical 0件、total 1件。`brace-expansion`のaffected dependency node 2件が同一のGHSA-mh99-v99m-4gvgに由来し、対象GHSA以外のHigh / Criticalは0件。判定は`NOT PASS — known advisory only`
- このHigh 1件は依存関係変更禁止のため本工程では修正せず、将来の別dependency remediationで対応します。runtime auditが全severity 0件で、今回変更が到達性を拡大しないことを条件に、本preflight独立レビューのblockerとはしません。これはProduction全体に脆弱性がないという判定ではありません
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
- full audit：exit code 1、High advisory 1件、Critical 0件、`brace-expansion`のaffected dependency node 2件。advisoryは承認済みのGHSA-mh99-v99m-4gvgだけで、statusは`NOT PASS — known advisory only`。dependencyと`package-lock.json`は不変
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

staging関連のinitial feature-branch push、run `32639709042`のgeneric failure、run `32684794700`のbroad Migration postcondition localization、subphase化、およびrun `32695896204`のexplicit runtime execution localizationまで完了しました。run `32695896204`は`RUN / FAILED`で、静的root causeは`SECURITY INVOKER` body-object privilege不足です。完了済みsubphase observabilityを次の実装作業とは扱いません。local body ACL fix `5ac1849a0dbf4418bf820b09b120a95c51aff83b`はP2 5件のため未pushで、本follow-upがreserved cleanup、timeout後のfresh cleanup Client actual REVOKE、fresh GRANT / REVOKE identity-first、observed-grantor unknown-recipient inventory、independent action-aware REVOKE oracle、current-state同期を修正します。次の外部qualificationはcombined two-commit review合格後のnormal feature-branch pushで自動起動するPostgreSQL 18.6 workflowです。commit時点では`NOT RUN`であり、Draft PR、ready-for-review、merge、staging構築、Production、provider、deploymentへ進みません。

この文書同期branchの作成・commit・pushはProduction操作と分離します。`main`へcommit、merge、pushせず、Production deploy、Vercel設定・環境変数、Production DB、Migration、Neon、Google Cloudを変更しません。文書上の識別子と後続の実状態がdocs-only commit / deployment分だけ異なる場合は、AGENTS / Runbookの全条件を読み取り専用で確認できた場合に限り、限定例外を適用できます。

## Staging database preflight hardening candidate

- `ACTUSTUBE_EXPECTED_STAGING_EXTENSIONS`を必須のserver-side process入力とし、schemaVersion 1、最大32,768 bytes、最大128 entries、各string最大128 charactersの固定contractで検証します。
- extension name／schema／versionはdirect／pooledのbefore／afterで順序非依存のexact比較を行い、期待値不足、入力不正、catalog取得不能、inventory不一致を別checkIdでfail-closedにします。
- direct／pooledはbeforeのread-only repeatable-read transactionを双方とも終了してから、after用のread-only repeatable-read transactionを双方で新しく開始します。GitHub Actionsのdigest固定PostgreSQL 18.6 fixtureでは第三sessionによるcommitをafterで検出し、同一snapshotを再読してdriftを見逃さないことをgateします。run `32684794700`のbroad markerは後続subphase化で解消し、run `32695896204`はexplicit runtime executionで`RUN / FAILED`でした。body ACL fixと本follow-upのcombined qualification runはcommit時点で`NOT RUN`です。
- public reportのexit 0は、PostgreSQL version、connection authority、database / role identity、extension inventory、migration history / catalog、user-defined object catalog、fresh before / after比較、read-only invariant、cleanup、canonical summary、overall statusの単一semantic predicateにすべて合格した場合だけ受理します。非0もexit 1 / 2＝overall / failureとも`fail`、exit 3＝両方`not_verified`のcanonical mappingだけを受理します。missing、duplicate、unknown exit、`not_verified`、exit / overall / failureの矛盾はraw reportを出さず固定exit 3へ変換します。
- terminal reportはmemory上の単一bufferをterminal barrier後に同期write 1回だけcommitし、commit前fatalをmain結果より優先します。main AbortSignalはDB open／query scheduling／query待機／comparison／report準備／cleanup開始判断のorchestration境界へ伝播します。cleanupはmainとは別のcontrollerでdirect／pooledを同時に開始し、全体を最大5,000msに制限します。exit code 3はreport commitとlistener解除後にprocessを終了します。provider driverのnative cancellationは実provider未接続のためNOT TESTEDです。
- network evidenceはguardを明示的に導入したNode childの拒否観測だけを示します。expected probeは専用DNS childに分離します。接続成功を観測する経路ではないため、successful guarded Node API external connectionとnative child external connectionはどちらも`NOT VERIFIED`です。
- connection-only verifierはdatabase process、port、filesystem、terminationのauthorityを各0件に固定し、lifecycle adapterのDI seamも持ちません。接続factoryだけをproduction SQLへの境界として残し、invalid URL / identity / version / Migration maxはfactory呼出し0件で停止します。repository-owned embedded PostgreSQL command / dependencyは削除済みです。DB URL、password、host、port、database、role、raw errorはpublic resultへ含めません。
- P3 regressionはconnection-only verifierと別moduleに置き、DBやOS utilityを所有せず、固定sourceのbenign Node childだけをabsolute `process.execPath`、`shell: false`、private IPCで起動します。mode／occurrence／capabilityは初回IPCだけで束縛し、exact message schemaとsequence、authenticated phase sequence、exit / closeのevent count・code・signal・parent monotonic timestamp、error event、exact nonzero code、exact signal、deadline時aliveを親が独立照合します。wrong / zero exit、wrong signal、deadline前正常終了、phase前failure、phase後予定外正常終了、terminal reason偽装、duplicate / malformed / replayed phaseをrejectします。resultはtop-levelとnested keyをexact allowlist化し、PID、PPID、occurrence、capabilityを出しません。
- Windowsのlocal named pipeはcanonical `\\.\pipe\...`だけをlocal IPCとして許可し、remote UNC、slash表記、extended UNC、`options.path`のremote形式はunexpected network occurrenceとしてoriginal connect前に拒否します。POSIX local Unix domain socketの扱いは維持します。
- preflightはconcurrency barrierではありません。承認済みの排他的maintenance window内でpreflight直後にMigrationを開始し、その間に別command、管理操作、schema / 接続先変更を挟みません。遅延、再接続、担当者変更、provider操作または予期しない活動があれば、古いPASSを流用せず新しい明示承認の下でpreflightからやり直します。同一advisory lockまたはMigration直前の同等再検証は将来候補であり、現時点では未実装です。
- repository Migration SQL、journal、application runtime code、Production設定は変更していません。実Neon extension catalogの検証完了は主張しません。

local unit testは外部fixture接続成功、PostgreSQL 18.6 native挙動、Migration、postflightを証明しません。それらのPASSはautomatic GitHub Actions workflowが成功した場合だけ判定できます。run `32695896204`はexplicit runtime executionで`RUN / FAILED`、静的root causeは`SECURITY INVOKER` body-object privilege不足です。body ACL fixと本follow-upのcombined qualification runはcommit時点で`NOT RUN`です。actual staging / Production / Neon / poolerは`NOT VERIFIED`、Production Migration / deploymentは`NOT RUN`です。Next.js、npm、Vitest、Corepackその他のprocessがsensitive environment fileを読み取らなかったことも証明しません。
