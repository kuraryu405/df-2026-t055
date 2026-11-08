# Work-guide API 契約例（Issue #25）

これは型の定義であり、APIを実装したものではない。正本第2・3・4節に従う。
fixtureはすべて架空データである。以下のリンク先JSONを要求・応答本文の例とし、契約テストで実スキーマに照合する。

| エンドポイント | 要求 | 応答・fixture |
| --- | --- | --- |
| GET /api/v1/drafts/{draftId} | なし | [AI下書き](../fixtures/work-guides/draft-ai-valid.json) または [手作業コピー](../fixtures/work-guides/draft-manual-valid.json)（draftDetailSchema） |
| PATCH /api/v1/drafts/{draftId} | [更新要求](../fixtures/work-guides/draft-patch-valid.json)（draftPatchSchema） | [保存後の確認欄](../fixtures/work-guides/draft-update-response-valid.json)（draftUpdateResponseSchema） |
| POST /api/v1/drafts/{draftId}/approve | `{"expectedRevision":1,"approvalRequestId":"demo-approve-1"}`（approvalRequestSchema） | `{"schemaVersion":"1","releaseId":"demo-release-1","version":1}`（approvalResponseSchema） |
| POST /api/v1/releases/{releaseId}/drafts | [コピー要求](../fixtures/work-guides/release-copy-request-valid.json)（releaseCopyRequestSchema） | 201 [コピー応答](../fixtures/work-guides/release-copy-response-valid.json)（releaseCopyResponseSchema） |
| GET /api/v1/me/assignments | なし | `{"assignments":[{"schemaVersion":"1","taskId":"demo-task-1","title":"架空のタオル包装","releaseId":"demo-release-1"}]}`（learnerAssignmentsResponseSchema）。空一覧は `{"assignments":[]}` |
| POST /api/v1/me/sessions | `{"taskId":"demo-task-1","clientRequestId":"demo-start-1"}`（sessionStartSchema） | [写真と短文](../fixtures/work-guides/session-photo-text-valid.json) または [写真のみ](../fixtures/work-guides/session-photo-only-valid.json)（learnerSessionSchema） |
| GET /api/v1/me/sessions/{sessionId} | なし | 開始応答と同じ判別共用体（learnerSessionSchema）。上記2つのセッションfixtureを使用 |

PATCHはexpectedRevisionで競合を検査する。内容変更時の確認解除はサーバーの処理であり、要求でtrueを送っても解除が優先される。応答のreviewChecksは保存後の状態を表す。スキーマ自体は確認解除や承認を実行しない。旧ペイロード（alt・新しい任意設定なし）も受理し、未知キー・nullは拒否する。

承認はapprovalRequestId、コピーと開始はclientRequestId（1〜100文字）で冪等にする。同じキーの再送は同じ版・下書き・セッションを返す。コピーは生成ジョブを作らず、確認欄をすべてfalseにする。元の承認版と実行中の固定版は変更しない。承認のrevision・照合・写真と代替テキスト・提示内容・本人一致の確認はサーバーの責務。

職員向け内部承認版の例は [写真のみ承認版](../fixtures/work-guides/release-photo-only-valid.json)（releaseSchema）。写真のみでもlearnerStepsのtext/visibleCautionとstaffGuideを保持する。本人向けにはprojectReleaseToSessionStepsで許可された項目だけを取り出す。photo_onlyのstepはstepId/order/imageAssetId/imageAltText/audioAssetId?だけを許可し、text/visibleCautionはキー自体を含めない。[textが混入した不正例](../fixtures/work-guides/invalid-session-photo-only-with-text.json)は本人DTOのスキーマで拒否する。

本人は認証主体に結び付く割当・セッションの承認版だけを取得する。下書きの有無で割当応答を変えない。下書きID、AI候補、Storageパス、職員メモ、staffGuide、プロフィールの職員向け情報、支援記録、修正履歴は本人DTOへ含めず、未知キーとして拒否する。職員専用の下書き取得処理を本人ルーターと共用しない。本人によるdraft API・原動画・下書き画像へのアクセスは403。API応答はno-storeとし、下書きのサービスワーカーキャッシュを作らない。これらの認証・認可・配信制御はこの契約追加では未実装。

旧版の入力互換は新規作成と分ける。[旧承認版](../fixtures/work-guides/release-legacy-valid.json)はreleaseReadSchema/normalizeReleaseで、欠けたdisplayModeをphoto_text、audioGuidanceをfalse、imageAltTextを承認済みtextで補う。ReleaseReadInputは入力型、Releaseは補完後の必須出力型。新規のreleaseSchemaは3項目必須。[旧セッション](../fixtures/work-guides/session-legacy-valid.json)はnormalizeLearnerSessionDTOで同じ補完を行う。新しい本人DTOは旧形式を直接受け付けない。AI下書きではjobIdが必須、生成中・失敗時のaiProposalは任意。手作業コピーではsourceReleaseIdが必須でjobId/aiProposalを禁止する。[混在の不正例](../fixtures/work-guides/invalid-draft-manual-with-job.json)を参照。

全エンドポイントに401（認証失敗）/403（権限不足）/404（対象なし）/409（状態・revision競合）/422（入力不正）を適用する。既存ApiError形 `{error:{code,message,requestId}}` を維持し、内部例外やAI原文を含めない。[409の例](../fixtures/work-guides/error-revision-conflict.json)（apiErrorSchema）。正常契約のschemaVersionはliteral "1"とし、エラーには追加しない。

設計根拠はREPORT第8節A2（C0/V2/V3/M2/F1/W0）、A5（C0/N0/M1/AV0/B1）および第11節、正本第12節の参照表。工程順・現在位置と版固定・下書き分離は、正本の受入条件を表すために契約へ採用する。写真列の構成の直接比較は未確認で、版保持方式の比較研究も未確認。写真列・オフラインキャッシュは採用せず、正本のno-store契約を維持する。本人・現場での確認は未実施で、写真の理解、工程粒度、提示設定、音声の希望、版更新の伝え方は未確認。今回の検証は架空JSONの契約テストと既存コードの型検査・ビルドに限り、チームの実機操作確認、専門家レビュー、本人評価は未実施。
