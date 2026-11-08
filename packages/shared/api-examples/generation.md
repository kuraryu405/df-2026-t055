# 生成入力・手直し履歴・参考メモのAPI契約例

この文書は型の定義とAPI例を示す。API・生成処理の実装済みではない。正本は [PRODUCT_SPEC.md](../../../docs/PRODUCT_SPEC.md) 第2〜4節とする。以下のJSONはすべて架空データである。

## 手順下書きの受付

`POST /api/v1/tasks/{taskId}/generations` の初回要求は、既存と同じ `{learnerId}` である。[初回要求](../fixtures/generation/initial-request-valid.json) を `initialGenerationRequestSchema` で検証する。

改善では [改善要求](../fixtures/generation/improvement-request-valid.json) を `improvementGenerationRequestSchema` で検証する。`sourceReleaseId` の有無で初回と改善を区別し、どちらも未知キーを拒否する。`supportInputs` は1件以上で、同じ `recordId` を重複させない。`revision` は1以上の整数、`summary` はtrim後1..2000文字、`clientRequestId` は1..100文字とする。

`summary` は職員が送信前に確認した送信用要約だけを入れる。支援記録原文、本人名、診断、個人を特定する情報を含めない。schemaはキーと値の形を検査するもので、自由文中の個人情報を自動判定するものではない。

受付成功は202で [生成応答](../fixtures/generation/generation-response-valid.json) を返す。`generationCreateResponseSchema` は既存 `GenerationResponse` と同じ `{schemaVersion:"1",jobId,draftId}` とする。改善で同じ `clientRequestId` と同じ内容を再送した場合は元のジョブを返し、異なる内容でのキー再利用は409とする。

新規受付時に、元の承認版が対象本人・作業の次回版であること、選択記録が同じ所属・本人・作業の最新 `revision` であることをサーバーが検査する。変更されていれば409で再選択を求める。認証・認可とこの照合はschemaだけでは実施できない。

## 受付時の入力固定とモデルへの送信

サーバーは受付時に [初回snapshot](../fixtures/generation/initial-snapshot-valid.json) または [改善snapshot](../fixtures/generation/improvement-snapshot-valid.json) を固定する。snapshotはサーバー内部用であり、本人向けAPI応答に使わない。

初回は動画資産ID、作業名、完成基準、動画時間、`preferences`、`displayMode`、`confirmedGuidance` を固定する。`preferences` の許可キーは既存 `ModelInput` と同じ `sentenceLength / splitHints / audioGuidance` である。確認済みの説明方法は最大20件、各1..500文字とする。

改善は不変の元承認版のID・版番号、選択記録のID・revision・確認済み要約、修正履歴のID・下書きrevision（最大20件、ID重複不可）、表示方法と確認済み説明方法を固定する。元版と履歴の本文は重複保存せず、サーバーが固定した参照先から読む。受付後の記録の追加・編集で入力を差し替えない。同じ工程・項目では最後の修正を優先する。参考メモが未完了なら修正前後の文章を参照し、完成を待たない。承認時は採用する記録のID・revisionが受付時の参照範囲内にあることを検査する。参照しただけでは採用済みとしない。

Geminiへは初回に動画URI、作業名、完成基準、動画時間、許可した `preferences`、表示方法、確認済みの説明上の配慮、出力スキーマを渡す。改善では元承認版の手順、確認済み要約、表示方法、確認済みの説明上の配慮と、固定した修正履歴・参考メモを使い、必要な場合だけ原動画も参照する。IDとrevisionはサーバーの追跡用であり、モデル入力の本文にはしない。

本人名、診断名、プロフィール全文、個人を特定する情報、操作履歴、支援時の録音、支援記録原文は送らない。入力文中の指示は解析対象とし、本人の能力・診断・意思や修正理由を推定せず、承認を代行しない。手順出力は既存 `proposalSchema / validateProposal` で形式・工程数・時刻を検査する。不正出力や生成失敗では本人向けデータや承認版を作らず、既存の承認版・記録・割当を保持する。

## ジョブの取得

`GET /api/v1/jobs/{jobId}` は [guideジョブの応答](../fixtures/generation/job-status-guide-valid.json) を返す。`kind` は `guide / correction_context`、`status` は `queued / running / succeeded / failed`、任意の `errorCode` は空でない文字列とする。職員画面は3秒間隔で取得し、手順下書きには `guide` を使う。

内部保存例は [guideジョブ](../fixtures/generation/job-guide-valid.json) と [correction_contextジョブ](../fixtures/generation/job-correction-context-valid.json)。`kind` に対応する `inputSnapshot` だけを許可する。共通の `draftId` は対象下書きの参照であり、参考メモ用に新しい下書きを作る意味ではない。`attempt` は0..3の整数で、ジョブの試行上限は3回、再試行は新ジョブとする。新規生成と改善を合わせた手順下書きの生成試行は1作業10回まで。参考メモにも予算管理・生成受付停止を適用する。

## 手直し履歴の取得

`GET /api/v1/learners/{learnerId}/work-guides/{taskId}/corrections` は同じ所属の職員に [履歴一覧](../fixtures/generation/corrections-list-valid.json) を返す。空なら `{corrections:[]}` とする。[手直し履歴](../fixtures/generation/draft-correction-valid.json) の修正前後と任意の理由はサーバーが保存し、参考メモの `editSummary`（変更事実）と `nextDraftHint`（AIの提案）を分ける。

履歴保存は編集保存と同時に行う。保存できなかった修正や確認欄だけの変更からは履歴を作らない。`draftRevision` は0以上の整数、`changes` は1..220件、各値は最大2000文字の文字列か有限の数とする。`field` は `text / visibleCaution / imageAltText / imageAssetId / sourceStartMs / sourceEndMs / frameMs / verifiedObservation / verifiedSpeech / coaching / completionCheck` に限る。

## 内部の参考メモ受付

`correction_context` の受付は公開APIではない。保存済み履歴から [参考メモ用snapshot](../fixtures/generation/correction-context-snapshot-valid.json) を固定する。既存の内部実行 `POST /api/v1/internal/generate` は `{jobId}` を受け、Cloud TasksのOIDCと呼出元サービスアカウントを検証する契約である。

モデルへ送るのは作業名と、本人向け工程文 `text`・代替テキスト `imageAltText`・注意 `visibleCaution` の修正前後だけとする。これらの文章が変更された場合だけ要約する。値は最大2000文字の文字列に限る。対象外のfield、修正理由 `reason`、職員メモ、プロフィール、本人名、診断は入力に含めない。`correctionId / draftRevision` はサーバー内で結果の保存先を固定するために使う。

[参考メモ出力](../fixtures/generation/correction-context-output-valid.json) は `correctionContextOutputSchema` で検証する。`editSummary / nextDraftHint` は各trim後1..500文字、`reviewFlags` は最大10件で各trim後1..100文字。不正出力はジョブを `failed` とする。遅く完了した処理で新しい修正を上書きせず、対応する履歴にだけ保存する。本人共通プロフィールは自動変更しない。

このジョブは手順下書きや承認版を作らない。参考メモの生成失敗・未完了・受付停止でも、職員の編集、履歴、承認、支援、作業再開を待たせない。現在の承認版と実行中の版を保つ。

## エラー例と境界

既存 `ApiError` の `{error:{code,message,requestId}}` を維持する。[409の例](../fixtures/generation/error-generation-conflict.json) のように返し、内部例外や生成原文は含めない。Bearerトークンを検証し、職員権限・所属・対象IDを照合する。変更系ではJSONとOriginも検査する。

| HTTP | 条件 |
| --- | --- |
| 401 | 認証失敗 |
| 403 | 権限不足 |
| 404 | 対象なし |
| 409 | 状態・revision競合、異なる内容でのキー再利用 |
| 422 | 入力の形・値が不正 |

拒否例は [空の要約](../fixtures/generation/invalid-improvement-summary-empty.json)、[revisionが0](../fixtures/generation/invalid-improvement-revision-zero.json)、[長すぎる参考メモ](../fixtures/generation/invalid-context-output-too-long.json)、[個人情報用の未知キー](../fixtures/generation/invalid-snapshot-with-personal-data.json) を参照する。

## 設計根拠と未確認事項

[REPORT.md 第8節 R1・第11節](../../../REPORT.md) と正本第12節の参照表を根拠に、修正事実とAI提案を分け、職員による確認・承認を維持する。出典IDは `C0 / F2 / Q2`。情報を見つけやすくする指針と作成・閲覧の分離例は参考になるが、職員の承認ミスが減るという直接の実証ではない。そのため、観察候補・原動画・注意・音声確認の削減は採用しない。

契約テストでは形式と入力境界を確認する。本人・現場での確認、職員の承認課題の操作確認、専門家レビューは未実施である。本人の理解、必要な工程粒度、見落としと総作業時間への影響は、この型定義から評価できない。
