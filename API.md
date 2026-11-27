# Storyboard API (for your AI terminal)

Let Claude Code / Codex read and write your board's cards.

- Base: `https://<your-board-host>/api/ws/<workspace>`
- Token: `ADMIN_TOKEN` in `.slate-secrets.json` (every workspace), or `WS_TOKENS.<workspace>` (that one workspace only — made for `verticals` with `"api": true`).
- Send it as `Authorization: Bearer <token>`. Never commit or paste the token anywhere public. Delete a token field and redeploy to cut that person off.

| Endpoint | Does |
|---|---|
| `GET /api/ws/<ws>` | endpoint list + card format guide |
| `GET /scripts?status=&q=` | every card with stage, date, open notes, source (file / api / edited-online) |
| `GET /scripts/<name>` (`?format=md`) | one card with its Markdown |
| `POST /scripts` | new card: raw Markdown body, or JSON `{md, name?, date?, status?}` (default stage `ready`) |
| `PUT /scripts/<name>` | replace the Markdown; on a file card it stores an online copy that wins until DELETE |
| `PATCH /scripts/<name>` | `{status, date, notes, resolve}` — the same as dragging / noting on the board |
| `DELETE /scripts/<name>` | delete an API card / drop an online copy (file cards: PATCH `status: "binned"`) |
| `GET /notes` | open notes on that board |

Stages: `idea` `writing` `ready` `reviewed` `filmed` `edited` `posted` `binned`.

```bash
TOK=$(python3 -c "import json;print(json.load(open('.slate-secrets.json'))['ADMIN_TOKEN'])")
curl -s -H "Authorization: Bearer $TOK" https://<your-board-host>/api/ws/my-studio/scripts
```
