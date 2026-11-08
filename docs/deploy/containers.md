# Issue #30 コンテナのビルドとデプロイ手順

対象は linux/amd64、Node 24 の `web-api` と `generator`。実デプロイ、Artifact Registryへのpush、GCP認証情報の取得・配置は今回実施していない。Cloud Build自体も未実行。

## 現在の実行境界

**この版は本番デプロイ不可。** 両entrypointの `NODE_ENV=production` ガードを維持し、イメージもproductionを既定にする。ローカル検証だけ明示的に `NODE_ENV=development` を渡す。本番でdevelopmentに変えてガードを回避しない。

- APIのFirebase検証クライアント、Firestore/Storage実クライアント、Cloud Tasksキュー/OIDCのentrypointへの接続が未完了。既存OPEN PRの内容は取り込んでいない（基点は #36 / PR #111）。
- 現generatorはローカルAPIへの認証付きHTTP転送とdrainポーリング。生成本体はAPI側workerで動く。Cloud Tasks HTTP内でgeneratorが生成を完了する本番構成への接続は別作業。応答後処理・ポーリングに依存する状態では本番投入しない。
- ローカル検証の `.local/assets` とメモリDBは使い捨て。本番ではFirestore・非公開Storageへ保存し、ディスクは `TMPDIR=/tmp` の動画処理用一時ファイルだけに使う。`media.ts` のfinally削除は維持。
- 新しいアプリログは追加していない。実運用のCloud LoggingはrequestId・ジョブ状態・エラーコードのみとし、本文・トークン・プロフィール・原動画等を記録しない。

## ローカルでのビルド

リポジトリ直下で実行する。必要なのはNode 24/npm、curl、tar（xz対応）、md5sum、sha256sum、Docker。新規npm依存なし。DockerfileにRUNはなく、依存取得とWebビルドは前段で行う。

```sh
./scripts/prepare-containers.sh
./scripts/fetch-ffmpeg.sh
sudo docker build --platform=linux/amd64 -f deploy/Dockerfile.web-api -t t055/web-api:issue30 .
sudo docker build --platform=linux/amd64 -f deploy/Dockerfile.generator -t t055/generator:issue30 .
```

準備スクリプトは `npm ci` → `npm run build` を再利用し、実行に必要なソース・Web dist・production依存のみを `.containers/runtime` に用意する。`.dockerignore` はこの成果物とDockerfileだけを許可し、リポジトリ全体・秘密情報・ホストのnode_modulesをCOPYしない。`.gcloudignore` はgitignoreの秘密情報・生成物除外をCloud Build送信にも適用する。ソースやWeb設定を変えたら準備からやり直す。

ffmpegはjohnvansickle.comの `ffmpeg-release-amd64-static.tar.xz`（ffprobe同梱）。スクリプトは配布元MD5で転送破損を検査し、バイナリSHA256を出力する。MD5は署名・真正性の証明ではない。release URLは更新されるため、採用時の版とSHA256をビルド記録に残す。**GPLv3の配布物**なので、イメージの配布時は同梱ソフトウェアの著作権表示・ライセンス・対応ソースの提供条件を確認し、著作物利用シートに記載する。上流の[配布ページ](https://johnvansickle.com/ffmpeg/)と[ソース](https://johnvansickle.com/ffmpeg/release-source/)を参照する。

## 起動設定

| 設定 | イメージの既定・入力 |
| --- | --- |
| `PORT` | 8080。起動CMDがAPI_PORTまたはGENERATOR_PORTへ渡す |
| `API_PORT` / `GENERATOR_PORT` | 明示値があればPORTより優先。通常のホスト起動の既定3001/3002は維持 |
| `LISTEN_HOST` | イメージは0.0.0.0、通常のホスト起動は127.0.0.1 |
| `TMPDIR` | /tmp。nodeユーザー（UID/GID 1000）で利用可能 |
| `NODE_ENV` | production。本番未接続の現状は起動拒否。ローカルのみdevelopment |
| `API_URL` | ローカルgeneratorからAPIへ接続するURL（既定http://127.0.0.1:3001） |
| `INTERNAL_TOKEN` | ローカル両サービスへ同じ一時ランダム値を実行時に渡す。イメージやログへ保存しない |
| `WEB_ORIGIN` | 公開WebのHTTPSオリジン。本番では公開URLと一致させる |
| `GENERATION_GLOBAL_LIMIT` | 既存の既定30。予算・受付停止の担当が管理 |

## このVMでのHTTP確認（ブラウザ不使用）

このVMはrunc setnsが拒否され、`docker run` とDocker RUNステップが不可。`docker create`（未起動）→ `docker export` → chrootでイメージのファイルを起動する。名前空間、cgroup、Cloud Run環境の検証にはならない。

1. `mktemp -d .containers/t055-container-XXXXXX` で専用ディレクトリを作る（2イメージ展開分の空き容量が必要。512MBの/tmpには置かない）。その下にweb-api/generatorのrootを作る。
2. 各イメージを `sudo docker create` し、`sudo docker export ID | sudo tar -xpf - -C ROOT` で展開する。createしたコンテナは `sudo docker rm ID` で削除する。
3. 各ROOTの `/dev/null` と `/dev/urandom` を必要に応じてホストからbind mountする。今回の確認では/proc・/sys・/tmpのbindは不要。ROOT内のtmpはmode1777とする。外側の親ディレクトリもUID1000が通過できるようにする。
4. `sudo chroot --userspec=1000:1000 ROOT /usr/local/bin/ffmpeg -version` とffprobe、`node -p process.getuid()`を両方で確認する。
5. イメージCMDと同じshコマンドで起動する。web-apiは `PORT=18080`、generatorは `PORT=18081 API_URL=http://127.0.0.1:18080`、両方へ `NODE_ENV=development LISTEN_HOST=0.0.0.0 TMPDIR=/tmp INTERNAL_TOKEN=一時値` を渡す。chrootはDockerのENVを自動では適用しないため、`sudo env ... chroot --userspec=1000:1000 ROOT /bin/sh -ec 'cd /app; export API_PORT=${API_PORT:-${PORT:-8080}}; exec node --experimental-transform-types apps/api/src/server.ts'` を使う（generatorはCMDの変数・パスに置換）。
6. ホストffmpegで合成fixtureを作り、同じINTERNAL_TOKENを環境で渡してHTTPチェックする。

```sh
ffmpeg -v error -f lavfi -i testsrc2=size=160x120:rate=2 \
  -f lavfi -i sine=frequency=440:sample_rate=8000 -t 12 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -y /tmp/t055-fixture.mp4
node scripts/check-container-http.mjs http://127.0.0.1:18080 http://127.0.0.1:18081 /tmp/t055-fixture.mp4
```

チェックはWeb本体・JS・SPAの3ルートと同一オリジンのAPI、未認証拒否、アップロードのffprobe検査、generator HTTP経由のジョブ成功・候補JPEG作成・本人への下書き拒否をassertする。モデルは既存FakeでありVertex実解析ではない。完了後は起動プロセス停止、bind解除、専用root・fixture削除を必ず行う。

## Cloud BuildとArtifact Registry（今後の実施手順）

必要入力：GCPプロジェクトID、リージョン（基本 `asia-northeast1`）、既存Docker形式Artifact Registryリポジトリ名、タグ（レビュー済みコミットSHA推奨、未指定はBUILD_ID）、ビルド実行サービスアカウント。Cloud Build/Artifact Registry APIと、対象リポジトリへのArtifact Registry Writer権限を基盤担当が準備する。認証は実行主体の権限を使い、鍵ファイルをイメージやビルド入力へ置かない。

以下は将来の操作例であり今回未実行。pushを伴うため実施担当が別途承認を得る。

```sh
gcloud builds submit . --project="$PROJECT_ID" --config=cloudbuild.yaml \
  --substitutions="_REGION=$REGION,_REPOSITORY=$REPOSITORY,_TAG=$COMMIT_SHA"
```

`cloudbuild.yaml` は前段のNode 24で同じ準備スクリプトを実行し、2種のDocker build後、`images` に指定した次のタグで保存する。Cloud Runデプロイは自動実行しない。

- `$REGION-docker.pkg.dev/$PROJECT_ID/$REPOSITORY/web-api:$COMMIT_SHA`
- `$REGION-docker.pkg.dev/$PROJECT_ID/$REPOSITORY/generator:$COMMIT_SHA`

## Cloud Run（本番アダプター結合後のみ）

追加の入力：レビュー済み両イメージのdigest、web用・generator用・Tasks呼出用の各サービスアカウント、公開Web URL、generator URL/OIDC audience、Tasksキュー名・ロケーション、非公開Storageバケット、Firestoreデータベース・org ID、Firebaseプロジェクト、Vertexプロジェクト・利用ロケーション・AI担当が決めたモデルID、受付上限。既存アダプターの環境設定名は `AUTH_BACKEND=firebase`、`REPOSITORY_BACKEND=firestore`、`STORAGE_BACKEND=cloud`、`STORAGE_BUCKET`、`FIRESTORE_ORG_ID`、`MODEL_PROVIDER=vertex`、`GOOGLE_CLOUD_PROJECT`、`GOOGLE_CLOUD_LOCATION`、`VERTEX_MODEL`、`VIDEO_BUCKET`。SDK/OIDC/キュー接続後に実際の設定契約を再照合する。TTSは別途採用・結合を確認する。

基盤担当はwebに必要なFirestore/Storage/Tasks enqueue権限、generatorに必要なFirestore/Storage/Vertex実行権限、Tasks呼出用だけにgeneratorのRun Invoker権限を最小範囲で付与する。キューは並列1、HTTP dispatch deadline240秒、Runはtimeout300秒・min0・max web2/generator1。Storageは非公開、ブラウザからFirestore/Storageへの直接アクセスなし。予算5/10/15ドル通知と15ドルでの受付停止運用を用意する。

本番ガードの解除は必要アダプターと受入条件を実装・レビューした別変更で行う。その後、秘密を含まない環境設定ファイル（管理対象外）とdigestを用意して、例として次を実施する。

```sh
gcloud run deploy generator --project="$PROJECT_ID" --region="$REGION" \
  --image="$GENERATOR_IMAGE_DIGEST" --service-account="$GENERATOR_SERVICE_ACCOUNT" \
  --no-allow-unauthenticated --ingress=internal --port=8080 --timeout=300 \
  --min-instances=0 --max-instances=1 --env-vars-file="$GENERATOR_ENV_FILE"
gcloud run deploy web-api --project="$PROJECT_ID" --region="$REGION" \
  --image="$WEB_API_IMAGE_DIGEST" --service-account="$WEB_SERVICE_ACCOUNT" \
  --allow-unauthenticated --ingress=all --port=8080 --timeout=300 \
  --min-instances=0 --max-instances=2 --env-vars-file="$WEB_ENV_FILE"
```

両環境設定に `NODE_ENV=production` を含める。webは公開HTTPSでもアプリ内のFirebase認証・認可を維持する。generatorはRun IAMとOIDC audience・呼出元SA検証を両方行う。公開URLとWEB_ORIGINを一致させ、Cloud Tasksから内部ingressへ到達できる同一プロジェクト等の構成を確認する。デプロイ後に正本第8節の境界・生成HTTP完了・停止・通信断・版固定・永続化を実URLで検証し、SHA/digest/設定と結果を記録する。これらの実デプロイ確認はすべて今回未検証。
