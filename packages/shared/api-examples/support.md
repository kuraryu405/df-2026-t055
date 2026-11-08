# 支援APIの共有契約と例

Issue #26 の型の定義であり API・WebSocket実装済みではない。正本は [PRODUCT_SPEC 第2〜4節](../../../docs/PRODUCT_SPEC.md)。リンク先のJSONは、すべて架空データによる入出力例である。

## HTTPと認可

ベースは `/api/v1`。Firebase IDトークンを `Authorization: Bearer <idToken>` で渡す。サーバーはトークン、membersのrole、所属、対象への権限を毎回検査する。本人は自分のセッションだけを参照できる。変更要求ではJSONとOriginも検査する。応答は `Cache-Control: no-store` とする。

| メソッド・パス | 要求と応答の例 |
| --- | --- |
| GET /api/v1/support-requests | `{requests:[...]}`。既定は open・assigned・in_progress。`?status=acknowledged` で後入力用の完了分を取得する。status query は省略または open / assigned / in_progress / acknowledged の1値。通知の [一覧例](../fixtures/support/ws-staff-snapshot.json) の requests と同じDTOを使う |
| POST /api/v1/support-requests/{requestId}/claim | `{}` → [claim応答](../fixtures/support/operation-claim-response.json) |
| POST /api/v1/support-requests/{requestId}/start | `{}` → [start応答](../fixtures/support/operation-start-response.json) |
| POST /api/v1/support-requests/{requestId}/acknowledge | `{}` → [acknowledge応答](../fixtures/support/operation-acknowledge-response.json) |
| POST /api/v1/support-requests/{requestId}/resume | [resume要求](../fixtures/support/operation-resume-request.json) → [resume応答](../fixtures/support/operation-resume-response.json) |
| GET /api/v1/support-requests/{requestId}/record | [record DTO](../fixtures/support/record-valid.json) を直接返す。未作成は404 |
| PUT /api/v1/support-requests/{requestId}/record | [保存要求](../fixtures/support/record-save-request.json) → [record DTO](../fixtures/support/record-valid.json)。ラッパーなし |
| GET /api/v1/me/sessions/{sessionId} | 承認済み固定版の手順・提示設定とセッション状態を返す。support と状態の部分は [本人向け状態例](../fixtures/support/learner-session-support.json) を参照 |
| POST /api/v1/me/sessions/{sessionId}/events | 既存 eventSchema の `{clientEventId,expectedRevision,type}` を維持。応答例は下記 |

```json
{"schemaVersion":"1","status":"waiting_help","stepIndex":0,"revision":2,"support":{"requestId":"demo-request-help","status":"open","revision":1}}
```

イベントの type は next / back / help / resume / stop / complete。支援終了後は support を省略できる。本人向け状態DTOは手順本文を持たず、既存 LearnerSessionDTO の手順を置き換えない。本人に渡す手順は承認済みの許可フィールドから組み立て、下書きIDやAI候補、職員メモ、支援記録、プロフィールを含めない。

## 支援要求と再送

help は open → assigned → in_progress → acknowledged だけを許可する。stop は open → acknowledged だけを許可する。段階飛ばし、逆戻り、acknowledged からの遷移は拒否する。再送の成功扱いは、新しい状態遷移とは別に判定する。

help の各状態の例は [open](../fixtures/support/request-help-open.json)、[assigned](../fixtures/support/request-help-assigned.json)、[in_progress](../fixtures/support/request-help-in-progress.json)、[acknowledged](../fixtures/support/request-help-acknowledged.json)。stop の例は [open](../fixtures/support/request-stop-open.json)、[acknowledged](../fixtures/support/request-stop-acknowledged.json)。各要求は revision が1以上で、状態変更ごとに増加する。

claim/start/acknowledge は共通の strict な空object要求を使う。clientRequestId、冪等キー、担当者や時刻を要求へ追加しない。担当者と時刻はサーバーが認証主体から確定する。同じ職員による再送では元の担当者と時刻を保つ。claim はトランザクションで最初に保存できた職員を担当者とし、別の職員との担当競合は409にする。help の開始・完了・職員側の再開は担当職員だけに許可する。stop の確認は同じ所属の職員に許可し、担当・開始情報は持たせない。

resume は clientRequestId が1..100文字、expectedSessionRevision が整数で0以上。同じキーの再送で再開を重ねない。対応中または対応完了のhelpだけが対象で、必要な完了記録、対象要求で支援待ちのセッションの再開、イベント保存を一つのトランザクションで行う。版と工程を保ち、activeSupportRequestId を外す。stopped の再開は拒否する。記録入力やAI生成の完了を再開条件にしない。

記録の対象IDは、サーバーが要求とセッションから確定する。対応開始後から完了後まで保存でき、初回は expectedRevision: 0。更新は保存済みrevisionと照合し、競合は409。3項目は各2000文字までで、空文字を許可する。1項目だけ先に入力しても保存できる。未知キーと null は拒否する。

## エラー

既存 ApiError の `{error:{code,message,requestId}}` を維持する。schemaVersion や内部例外、生成原文を追加しない。[担当競合の409例](../fixtures/support/error-claim-conflict.json) を参照。

| HTTP | 意味 |
| --- | --- |
| 401 | 認証失敗 |
| 403 | role・所属・対象の権限不足 |
| 404 | 対象なし |
| 409 | 担当、状態、revisionの競合 |
| 422 | 入力不正 |

拒否するJSON例は [担当者欠落](../fixtures/support/invalid-request-assigned-without-assignee.json)、[stopへの担当情報混入](../fixtures/support/invalid-request-stop-with-assignee.json)、[本人通知への記録混入](../fixtures/support/invalid-learner-notification-with-record.json)。スキーマは形式を検査し、認可や再送処理はサーバーが行う。

## WebSocketと通信断

`/api/v1/ws` に接続し、初回メッセージとして [auth](../fixtures/support/ws-auth.json) を送る。idToken は空でない文字列。トークンをURLやログへ残さない。サーバーはトークン・members・Originを検査して購読を許可し、認証前の接続は5秒で閉じる。有効期限切れでは切断し、再認証して接続し直す。

職員には同じ所属の [support.snapshot](../fixtures/support/ws-staff-snapshot.json) と [support.updated](../fixtures/support/ws-staff-update.json) を送る。支援記録や職員メモの本文は通知に含めない。本人には自分のセッションだけの [session.support.snapshot](../fixtures/support/ws-learner-snapshot.json) と [session.support.updated](../fixtures/support/ws-learner-update.json) を送る。両方の payload は同じ状態DTOを使い、support は requestId/status/revision だけにする。外側・payload・support の未知キーを拒否し、職員メモ、支援記録、プロフィール、担当者の識別情報を含む拡張を受け付けない。

更新操作は認証付きHTTP APIで受け、保存後に通知する。接続直後と再接続時に最新snapshotを送り、セッションと要求それぞれのrevisionで古い通知を除く。再接続だけでは再開しない。通信断中は支援待ちを保ち、HTTPフォールバックとして本人は GET /api/v1/me/sessions/{sessionId}、職員は GET /api/v1/support-requests を3秒ごとに取得する。支援終了または画面を閉じた時に不要な接続を閉じる。

「やめる」は通信やrevision一致より停止を優先する。端末は即時停止を保持し、未送信の停止があっても再開通知で作業に戻さない。サーバーも停止済みセッションの再開を拒否する。

## 設計根拠と未確認事項

[REPORT 第8節 A3・A5と第11節](../../../REPORT.md) と正本第12節の参照表を確認した。A3の出典ID C0/W5/W6/W7 は操作結果と人的支援の状態を区別する根拠であり、保存済みの状態を返す契約に採用した。状態表示の文言や本人の理解、待てる時間、職員不在・通信断時の代替は未確認である。

A5の出典ID C0/N0/M1/AV0/B1 は安定した承認版の提示を支持するが、版の保持方式を比較した研究ではない。実行中のreleaseIdを保ち、下書きを本人向けDTOへ含めない方針を採用した。キャッシュの追加や調査上の未採用提案は今回の対象にしない。

契約テストは形式、状態遷移、情報混入の拒否を確認する。チーム内の画面操作確認、専門家レビュー、本人による評価は未実施であり、契約テストで代替しない。第11節の援助・停止の模擬場面と端末準備・版更新は本人・現場で別途確認する。
