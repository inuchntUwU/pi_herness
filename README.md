# pi_herness

pi coding agent 用の自作拡張パッケージ。pi に無い OpenCode 系の機能を補う。

## 拡張一覧

| 拡張 | 提供するもの |
| --- | --- |
| `modes.ts` | Shift+Tab のモード巡回（reading / plan / goal / hard-goal / auto / hard-auto / loop）。`/read` `/plan` `/goal` `/auto` `/loop` `/mode` |
| `agentmemory.ts` | `/agentmemory` コマンド。共有メモリの閲覧・検索 |
| `safety-gate.ts` | 危険な bash コマンドをテキストで確認（`/safety on\|off`、`/safety allow\|deny <id>`）。返信 `yes` / `no` でも承認・拒否できる |
| `lint-on-edit.ts` | 編集後に lint/test を自動実行し、失敗だけモデルに返す |
| `scout.ts` | 別プロセスで読み取り専用の調査を1回走らせ、結論だけ返すツール |
| `git-checkpoint.ts` | goal/auto でターン開始時に `git stash create` のチェックポイントを取る。`/fork` 後に `/restore <id>` で復元 |
| `clear.ts` | Claude Code 風の `/clear`。会話を消して新セッションを開始（組み込み `/new` と同じ。旧セッションは `/resume` で復帰可） |
| `memory.ts` | `/memory [focus]`。このセッションの作業を `~/agentmemory` に保存させる（規約に沿ったファイル作成＋索引更新＋snapshot はエージェントが実行） |
| `loop.ts` | loop モードの本体。計画→放置実行の反復、停滞検出、`.pi/loop/` への成果物、`/loop-status` `/loop-stop` `/loop-resume`。loop モード以外では何もしない |
| `tool-filter.ts` | 使わないツールを `setActiveTools` から外して常時コンテキストを削る。隠す対象は `herness.json` の `hiddenTools`（既定: remote-pi の mesh ツール）。`/tools` で変更 |
| `tools.ts` | `/tools`。loop の commit/push/PR とツール表示を、ダイアログなしの引数式で設定（既定はすべて off） |
| `questions.ts` | `/questions`。`.pi/loop/QUESTIONS.md` の質問を `Q:`/`A:` テンプレートとしてエディタに読み込む |
| `handoff.ts` | `/handoff [focus]`。今の会話を要約し、親を引き継いだ新セッションを開いて続きのプロンプトをエディタに差し込む |
| `todo.ts` | `todo` ツール（list / add / toggle / clear）と `/todos`。分岐ごとに todo を保持 |
| `preset.ts` | `/preset [name\|none]`。モデルと thinking だけのプリセット（`presets.json`）。`--preset` フラグ、`Ctrl+Shift+U` で巡回 |
| `bookmark.ts` | `/bookmark [label]` `/unbookmark`。メッセージに印を付けて後で `/tree` から戻れる |
| `session-name.ts` | `/session-name [name]`。セッション名の設定・表示 |

## モード（Shift+Tab で巡回）

```
reading → plan → goal → hard-goal → auto → hard-auto → loop → reading → ...
```

| モード | edit/write | bash | 危険コマンド確認 | 注入される指示 |
| --- | --- | --- | --- | --- |
| reading | 無効 | read-only allowlist | 危険コマンドはブロック | 読み取り専用で調査せよ |
| plan | 無効 | read-only allowlist | 危険コマンドはブロック | `Plan:` 以下に番号付きステップを出せ |
| goal | 有効 | 制限なし | あり | 設定ゴールへ向けて進めよ |
| hard-goal | 有効 | 制限なし | **なし（自動許可）** | ゴール + 確認ゲートは無効 |
| auto | 有効 | 制限なし | あり | なし |
| hard-auto | 有効 | 制限なし | **なし（自動許可）** | 確認ゲートは無効 |
| loop | plan 中は無効 / run 中は有効 | plan 中は allowlist / run 中は制限なし | plan 中はあり / **run 中はなし** | `[LOOP n]` の1反復だけを実行せよ |

- hard-* は safety-gate の確認ダイアログを出さずに危険コマンドを実行する。**`sudo` だけは
  従来どおりブロック**し、実端末用のコマンドを本人に渡す（TTY が無いため）
- `/goal <text>` を hard 系で実行すると hard を保ったまま hard-goal になる
- `Alt+T` は thinking level の切替（`~/.pi/agent/keybindings.json` で `app.thinking.cycle` を変更）
- `/goal <text>` でゴール設定、`/goal` で表示、`/goal clear` でクリア

## loop モード（放置実行）

`/loop <goal>`（または起動フラグ `--loop`）で入る。最初に計画を1回だけ人間と詰め、
あとは人間が離れていてもゴールに向かって反復し、完了か「人間の判断待ち」で自分から止まる。

```
plan 段階: 調査 → 質問と計画をテキストで提示 → 人間が start と返す
run  段階: [LOOP n] を1回ずつ実行 → STATUS: CONTINUE | DONE | BLOCKED
```

| コマンド / フラグ | 効果 |
| --- | --- |
| `/loop <goal>` | ゴールを設定して loop モードに入り、その場で計画フェーズを開始 |
| `--loop` | セッション開始時に loop モードにする（`pi -p --loop "..."` 用） |
| `--loop-yes` / `PI_LOOP_YES=1` | 計画を自動承認して run 段階へ（ヘッドレス用） |
| `/loop-status` | phase・反復回数・ゴール・コンテキスト使用率を表示 |
| `/loop-stop` | ループを止める（`stop` と返信、`.pi/loop/STOP` の作成でも同じ） |
| `/loop-resume` | 止まっているループを、返信せずに再開 |

- 質問は**ダイアログを出さない**。`.pi/loop/QUESTIONS.md` に書き出し、ループは駆動を止めて
  テキストの返信を待つ（本人が端末の前にいなくても remote-pi で返せるため）。`/questions` で
  質問を `Q:`/`A:` テンプレートとしてエディタに読み込める
- 停滞の検出: 作業ツリー（tracked の diff、untracked の中身、HEAD の commit id）が3反復続けて
  変わらなければ `stalled` として `waiting` に落ちる（commit しても進捗として数える）
- `run` 中にセッションを再開すると `waiting` に落ちる（勝手に反復を始めない）
- 終了時は `.pi/loop/REPORT.md` に、ゴール・反復数・停止理由・進捗・コストを残す
- git の commit / push / PR は既定ですべて off。`/tools loop.commit on`（`push` / `pr` も同様）で
  明示的に有効化したときだけ、反復ごとの `[LOOP n]` 指示に従って実行される（`pr` は `push` を、
  `push` は `commit` を含意する）
- 開始時の `git stash create` の ref をレポートに残すので、戻すときは
  `git restore --source=<ref> --staged --worktree -- :/`

### 成果物（`.pi/loop/`）

| ファイル | 中身 |
| --- | --- |
| `PLAN.md` | 承認した計画（`start: <修正>` の追記つき） |
| `PROGRESS.md` | 進捗。エージェントが毎反復更新する |
| `QUESTIONS.md` | 人間に聞きたいこと（`waiting` のとき） |
| `REPORT.md` | 終了時のレポート |
| `state.json` / `events.jsonl` | 状態とイベントログ（再開・デバッグ用） |
| `STOP` | 置くと次の反復の前に止まる |

対象リポジトリを汚したくなければ `.gitignore` に `.pi/loop/` を足す。

### コンパクションとの関係

計画と進捗はディスク上にあり、各反復は `[LOOP n]` の要約（計画＋進捗＋次にやること）から
始まるので、要約が薄くても続行できる。コンテキスト使用率が `herness.json` の
`loop.compactPercent`（既定 80%）を超えたらループが `ctx.compact()` を呼び、完了を待ってから
次の反復を注入する（`keepRecentTokens` はいじらないので、他のモードのコンパクション挙動は
変わらない）。古い `[LOOP n]` は `context` ハンドラで最新1件だけ残す。

## safety-gate（テキスト確認）

承認が要るパターン:

- `rm -rf` / `rm -r` / `rm --recursive`
- `git push --force` / `-f` / `--force-with-lease`
- `chmod` / `chown` の `777`
- ファイル上書きリダイレクト（単一の `>`）
- `dd` / `mkfs`
- `curl` / `wget` をシェルにパイプ（`curl ... | sh`）

ダイアログは出さない。検出したらコマンドを**保留**して短い id を振り、エージェントに
「この id を伝えて止まれ」と返す。承認・拒否はテキストで行う:

- 承認: `/safety allow <id>` か、そのまま `yes` と返信
- 拒否: `/safety deny <id>` か、そのまま `no` と返信

`yes` は再実行プロンプトに変換され、エージェントが同じコマンドをもう一度出す。その
**1回だけ**通すトークンを持っているので実行され、トークンは消費される。違うコマンドなら
また保留になる。`/safety`（引数なし）で状態と保留一覧、`/safety on|off` でゲート自体を切替。

`sudo` は**実行しない**し、ここでの承認対象にもならない。「sudo が必要なコマンドは実端末で
実行してください」とコマンドを添えて本人に渡す（TTY が無く必ず失敗し、faillock のリスクが
あるため）。このポリシーは `/safety off` でも変わらない。hard-goal / hard-auto モードの間は
ゲートを出さずに実行する（それでも `sudo` はブロックのまま）。loop モードは **run 段階の
あいだだけ**同じ扱いになる（計画段階ではゲートが働く）。

冒頭でモデルに渡す sudo ポリシーは**セッションごとに1回だけ**注入する。内容が変わらないのに
毎ターン積むとコンテキストを無駄に消費するだけで意味がないため。

## lint-on-edit の設定

優先順位:

1. `.pi/herness.json`（プロジェクト）
2. `~/.pi/agent/herness.json`（ユーザー）
3. プロジェクトからの自動推測（npm scripts の `lint`/`test`、ruff、cargo、go）

```json
{ "lint": "npm run lint" }
{ "lint": ["npm run lint", "npm test"] }
{ "lint": false }
```

編集後 1.5 秒デバウンスして実行し、失敗したコマンドの出力だけを `lint-failures` メッセージでモデルに返す。

## /tools と herness.json

`/tools` はダイアログを開かない引数式の設定コマンド:

```bash
/tools                          # 現在値の一覧
/tools loop.commit on           # ユーザー全体（~/.pi/agent/herness.json）に保存
/tools loop.push on             # commit も自動で on
/tools loop.pr on               # push, commit も自動で on
/tools loop.compactPercent 80   # 数値オプション
/tools local loop.pr on         # このプロジェクト（.pi/herness.json）だけ
/tools agent_send on            # ツールの表示/非表示
```

`herness.json` の解決順は `.pi/herness.json`（プロジェクト）→ `~/.pi/agent/herness.json`
（ユーザー）→ 既定値。書き込みは既定でユーザー側なので、どのプロジェクトでも同じ設定が効く。
`loop.commit` / `loop.push` / `loop.pr` は**すべて既定 off**で、明示的に on にしたときだけ
loop が従う（`pr` は `push` を、`push` は `commit` を含意する）。`lint` キーと同じファイル。

```json
{
  "lint": "npm run lint",
  "loop": { "compactPercent": 80, "commit": false, "push": false, "pr": false },
  "hiddenTools": ["agent_send", "list_peers", "agent_request"]
}
```

## ダイアログを使わない方針

端末の前にいないことがあり、remote-pi のモバイルアプリは拡張のダイアログを表示しない。
そのため拡張はブロッキングダイアログ（`ctx.ui.select` / `confirm` / `input` / `editor` /
`custom`）を**使わない**。代わりにテキストで問い、コマンドか返信で答える:

- loop の質問 → `.pi/loop/QUESTIONS.md` と `STATUS: BLOCKED`
- safety-gate → `/safety allow|deny <id>` または `yes` / `no`
- git-checkpoint → `/restore <id>`

`ctx.ui.notify` / `setStatus` / `setWidget` / `setEditorText` は非ブロッキングなので使ってよい。

## ワークフロー（handoff / todo / preset / prompts / subagent）

対話まわりの道具。どれもダイアログを出さない。

| 使い方 | 効果 |
| --- | --- |
| `/handoff [focus]` | 今の会話を要約し、親を引き継いだ新セッションを開いて、続きのプロンプトをエディタに差し込む |
| `todo` ツール + `/todos` | list / add / toggle / clear。分岐ごとに todo を持ち、`/todos` で一覧表示 |
| `/preset [name\|none]` | モデルと thinking だけのプリセット。`Ctrl+Shift+U` で巡回、`--preset <name>` でも起動可 |
| `/bookmark [label]` / `/unbookmark` | メッセージに印を付けて、後で `/tree` から戻れる |
| `/session-name [name]` | セッション名の設定・表示 |

### プリセット（presets.json）

`~/.pi/agent/presets.json` と `<cwd>/.pi/presets.json` を読む。モデルと thinking level だけを持つ:

```json
{
  "fast": { "model": "openrouter/moonshotai/kimi-k2.6", "thinkingLevel": "low" },
  "deep": { "thinkingLevel": "high" }
}
```

`/preset`（引数なし）で一覧、`/preset <name>` で適用、`/preset none` で元に戻す。

### prompt templates

リポジトリの `prompts/` に置き、`~/.pi/agent/prompts` から symlink して読み込ませる
（この環境では `~/.pi/agent/extensions/pi_herness` の symlink 経由では package manifest の
`pi.prompts` が読まれず、ユーザーの prompts ディレクトリだけが読まれたため）。`/` で補完できる:

| template | 用途 |
| --- | --- |
| `/review` | 未コミット差分をバグ・セキュリティ・エラー処理の観点でレビュー（変更はしない） |
| `/commit` | `git add` 対象とコミットメッセージを提案（**commit はしない**。規約どおり本人が行う） |
| `/plan <指示>` | 番号付きの実装計画を出す（ファイルは触らない） |
| `/implement <指示>` | scout → planner → worker の subagent チェーンで実装 |
| `/scout-and-plan <指示>` | scout → planner まで（実装しない） |
| `/implement-and-review <指示>` | worker → reviewer → worker のチェーン |

### subagent

`~/.pi/agent/extensions/subagent/`（公式 example をコピーし、project ローカル agent の
確認ダイアログだけテキスト拒否に置き換えたもの）と `~/.pi/agent/agents/` の4エージェント
（scout / planner / reviewer / worker）を入れてある。`subagent` ツールで:

- single: `agent` + `task`
- parallel: `tasks` 配列（同時実行）
- chain: `chain` 配列（`{previous}` で前段の出力を渡す）

agent に `model:` を書いていないので、呼び出し元のモデルを引き継ぐ。既定の `agentScope` は
`"user"`（`~/.pi/agent/agents`）で、project の `.pi/agents` は信頼したプロジェクトでしか使わない。

### キーバインド

`~/.pi/agent/keybindings.json` に `app.session.tree` を `Ctrl+Shift+T` で足してある（既定は空）。
`/tree` をキー1つで開ける。

## scout ツール

```
Use scout to find how authentication is wired up. Report only the conclusion.
```

別の `pi --mode json` プロセスを読み取り専用ツール（read/grep/find/ls/bash）で起動し、
最終回答だけを返す。大量のログ読みをメインの文脈に入れずに済む。セッションは保存しない。

## git-checkpoint

goal / auto モードで、各ターンの開始時にチェックポイントを取る。`/fork` したときは
ダイアログを出さず、`.pi/herness-checkpoints.json` に短い id を書いて `/restore <id>` を案内する。
id はファイルに残るので、フォーク後の新セッションでも `/restore` が効く。
記録するのは、作業ツリーが汚れていれば `git stash create` の ref、クリーンなら `HEAD`。
復元は `git restore --source=<ref> --staged --worktree -- :/`（`git stash apply` は作業ツリーに
既に同じ変更があると失敗するため使っていない）。

- `/restore`（引数なし）で保留中チェックポイントの一覧、`/restore <id>` で復元
- reading / plan では動かない（そもそも変更できないため）
- `git stash create` は **stash リストに積まず、作業ツリーも変えない**。コミットも push もしない
- **untracked ファイルは対象外**（追跡済みの変更のみ。復元時に削除もしない）
- ターン内チェックポイントは**メモリ上のみ**。`/reload` や再起動で消える（fork 後の id はファイルに残る）
- モデルには何も送らないのでコンテキストを消費しない

## コンテキストの重複除去

`before_agent_start` で毎ターン注入されるブロックは、`context` ハンドラで重複を落とす。
modes の `[MODE: ...]` / `[SESSION GOAL]` は最新1件だけ残し（auto では全削除）、
safety-gate の sudo ポリシーはセッション1回に固定する。

## 開発

```bash
npm install          # typescript と @types/node
npx tsc --noEmit     # 型チェック
npm test             # loop.ts / modes.ts / safety-gate.ts の状態機械テスト（LLM 不要）
grep -rn 'ui\.\(select\|confirm\|input\|editor\|custom\)' extensions/  # 0 件であること（下記方針）
```

`node_modules/@earendil-works/*` と `node_modules/typebox` はグローバル pi への symlink。
`tsconfig.json` の `paths` で pi パッケージを解決している。

## インストール

```bash
ln -sfn /path/to/pi_herness ~/.pi/agent/extensions/pi_herness
ln -sfn /path/to/pi_herness/prompts ~/.pi/agent/prompts
```

`~/.pi/agent/extensions/` 配下は pi が自動検出する。`package.json` の `pi.extensions` に
各拡張を列挙してある。prompt templates はユーザーの prompts ディレクトリから読ませる。
subagent は `~/.pi/agent/extensions/subagent/`（`index.ts` と `agents.ts`）、エージェントは
`~/.pi/agent/agents/*.md` に別途置く（既定の `agentScope: "user"` がここを見る）。
