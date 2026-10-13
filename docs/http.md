# HTTP API

Everything the console does goes through `/bot/v1`, so anything else can too.
Send `Authorization: Bearer <console token>`. Rooms are `desk` for HQ and
`bot-<botId>` for a Bot.

## Talk to a room

```bash
curl -X POST localhost:3000/bot/v1/rooms/desk/messages -H 'content-type: application/json' -d '{"message":"Who is on the team?"}'
curl -N 'localhost:3000/bot/v1/rooms/desk/stream?startIndex=0'          # NDJSON, live
curl -X POST localhost:3000/bot/v1/rooms/desk/respond -H 'content-type: application/json' -d '{"responses":[{"requestId":"<id>","optionId":"approve"}]}'
curl -X POST localhost:3000/bot/v1/rooms/desk/reset                       # start the thread over
curl -X POST localhost:3000/bot/v1/rooms/desk/recover -H 'content-type: application/json' -d '{"message":"…"}'  # a thread that stopped answering: fresh session, message sent again
```

## The team

```bash
curl localhost:3000/bot/v1/state                                          # roster, presence, feed
curl -X POST localhost:3000/bot/v1/bots -H 'content-type: application/json' -d '{"name":"Ava","role":"Inbound sales follow-up","persona":"Warm and brief."}'
curl -X PATCH localhost:3000/bot/v1/bots/<id> -H 'content-type: application/json' -d '{"status":"paused","pinned":true,"section":"Sales"}'
curl -X POST localhost:3000/bot/v1/bots/<id>/duplicate
curl -X DELETE localhost:3000/bot/v1/bots/<id>
curl -X DELETE localhost:3000/bot/v1/jobs/<id>                            # cancel a job durably
```

## Connectors

```bash
curl -X POST localhost:3000/bot/v1/connectors -H 'content-type: application/json' -d '{"catalog":"linear"}'      # add a connector; OAuth ones then need a sign-in
curl -X POST localhost:3000/bot/v1/connectors/<id>/oauth/start                                                 # the consent URL to open; the server sends the browser back to /bot/v1/oauth/callback
curl -X POST localhost:3000/bot/v1/connectors/<id>/reviewed-reads -H 'content-type: application/json' -d '{"tools":["list_issues"]}'  # confirm guessed reads for HQ; no "tools" = all of them
```

## The front door

The public pages are readable by agents too: `/`, `/about`, `/contact`, and
`/privacy` answer `Accept: text/markdown` with Markdown, unknown paths answer
404 the same way, `/llms.txt` says when to reach for Bot, and `/sitemap.xml`
lists the public pages. The console and `/eve` stay out of all of it.
