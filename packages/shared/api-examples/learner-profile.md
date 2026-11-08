# 本人プロフィール API 契約（Issue #24）

この文書は型の定義であり、API 実装済みではない。正本は `docs/PRODUCT_SPEC.md` 第2・3・4節。
共有契約は `packages/shared/src/learner-profile.ts`、JSON例は
[`../fixtures/learner-profile/`](../fixtures/learner-profile/) にある。
`tests/contract-learner-profile.test.ts` が以下のfixtureを実スキーマで直接parseする。
既存APIへの接続・認可・永続化・競合処理は本変更の検証対象外。

## 共通条件

- ベースパス `/api/v1`。JSONはcamelCase。DTOの `schemaVersion` は literal `"1"`。
- Firebase Authentication IDトークンを `Authorization: Bearer <ID token>` で送り、サーバーが検証してmembersのrole・orgIdを取得する。
- 認証済み職員（staff）の所属内だけで一覧・詳細・作成・更新を許可する。URLのlearnerIdにも所属検査が必要。本人・新人には許可しない。
- 変更系は `Content-Type: application/json` とOriginを検査する。応答は `Cache-Control: no-store`。
- orgId・enteredBy・updatedByは認証主体から、learnerIdはサーバー生成UUID、createdAtはサーバー時刻、revisionはサーバーで確定する。クライアント指定はstrict schemaで拒否する。
- 本人プロフィールの登録は認証アカウントの作成とは別の操作。

## 操作一覧（OpenAPI相当）

| Method / Path | requestBody schema | 成功応答 schema / JSON例 |
| --- | --- | --- |
| GET `/api/v1/learners` | なし | 200 `LearnerProfileListResponse` / [list-valid.json](../fixtures/learner-profile/list-valid.json) |
| GET `/api/v1/learners/{learnerId}` | なし。path learnerId: 必須の空でないstring | 200 `LearnerProfileDetail` / [detail-valid.json](../fixtures/learner-profile/detail-valid.json) |
| POST `/api/v1/learners` | 必須JSON `LearnerProfileCreateRequest` / [create-valid.json](../fixtures/learner-profile/create-valid.json) | 201 `LearnerProfileDetail` / [detail-valid.json](../fixtures/learner-profile/detail-valid.json) |
| PATCH `/api/v1/learners/{learnerId}` | 必須JSON `LearnerProfileUpdateRequest`。path learnerId: 必須の空でないstring / [update-delete-disability-info.json](../fixtures/learner-profile/update-delete-disability-info.json) | 200 `LearnerProfileDetail`。削除後の応答にはdisabilityInfoキーを含めない |

一覧はstrictな `{items: LearnerProfileSummary[]}`。
各要素は `schemaVersion, learnerId, displayName, preferences, revision` のみを含む。
障害情報と4分類のメモは返さない。
詳細は一覧の項目に `orgId, enteredBy, updatedBy, createdAt`、任意の4分類と `disabilityInfo` を加える。
障害情報は詳細DTOだけに含める。

## フィールドと省略

すべてのobjectはstrictで、未知のキーを拒否する。

| フィールド | 契約 |
| --- | --- |
| displayName | trim後1〜100文字。作成は必須、更新は任意 |
| preferences | 詳細・一覧では必須object（空object可）、作成・更新では任意。各設定はすべて任意 |
| preferences.sentenceLength | 整数1〜40 |
| preferences.splitHints | 最大200文字 |
| preferences.displayMode | `photo_only` または `photo_text` |
| preferences.audioGuidance | boolean |
| learnerWishes | 本人の希望。任意配列、最大20件、各項目trim後1〜500文字 |
| staffObservations | 職員の観察。別の任意配列、上と同じ制限 |
| staffSuggestions | 職員の提案。別の任意配列、上と同じ制限 |
| confirmedGuidance | 確認済みの配慮。別の任意配列、上と同じ制限 |
| disabilityInfo | 任意strict object。detail（trim後1〜500文字）、source（trim後1〜200文字）、confirmedAt（ISO日時、タイムゾーン必須）はすべて必須 |
| revision | DTOでは整数1以上 |
| expectedRevision | 更新で必須、整数0以上。現在値との一致をサーバーで検査する |
| createdAt | ISO日時、タイムゾーン必須 |

未確認値は省略し、既定値やnullで埋めない。`false` は確認済みの希望であり、省略と区別する。
4分類は互いに混ぜず、省略と空配列を表現できる。
障害情報は支援上必要で本人が共有を希望する内容だけを記録する任意項目。
診断・所属区分から設定や権限を自動決定しない。

PATCHで `disabilityInfo` を省略した場合は変更しない。
`disabilityInfo: null` は任意記録の削除要求であり、保存・詳細応答にnullを残す意味ではない。
objectを送る場合は3項目すべてが必須で、欠落があれば422を返す。
その他のフィールドやpreferences内の設定にnullは使えない。
[invalid-unconfirmed-null.json](../fixtures/learner-profile/invalid-unconfirmed-null.json) と
[invalid-list-with-disability-info.json](../fixtures/learner-profile/invalid-list-with-disability-info.json) は拒否される例。

## エラー

既存 `ApiError` の `{error:{code,message,requestId}}` を使用する。
内部例外・プロフィール原文・認証トークンを返さない。

| HTTP status | 意味 / 操作 |
| --- | --- |
| 401 | 認証失敗。全操作 |
| 403 | 権限不足・所属不一致。全操作 |
| 404 | 対象なし。詳細取得・更新 |
| 409 | 状態・revision競合。更新のexpectedRevisionが不一致なら再取得して編集し直す |
| 422 | 入力不正。作成・更新の未知キー、null、不正な日時、範囲外など |

409のJSON例: [error-revision-conflict.json](../fixtures/learner-profile/error-revision-conflict.json)。
HTTP statusはJSONに混ぜず、レスポンスのstatusで表す。fixtureは既存ApiError形のままとする。

## 設計根拠と確認範囲

REPORT第8節A1（C0・E0・N0）、第4節4.1〜4.3、第6節「音声」（T0・T1）、第11節を参照。
正本第12節の参照表に従い、本人ごとに希望を確認する方針と未確認値の省略を契約化した。
A1のルビ・文字サイズ追加や音声の速度設定は正本の採用要件ではなく、本契約に追加しない。
N0は対応例集、T0・T1は主に読字に困難のある学生等の研究であり、成人の作業への効果は断定できない。
検証範囲は架空データを使った型・境界・一覧投影の自動テスト。本人・現場での表示方法の適合性、音声の希望・理解、専門家レビューは未確認。
