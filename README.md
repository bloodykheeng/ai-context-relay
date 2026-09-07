# ai-context-relay

Keep a Claude Code session and a Codex thread as one conversation.

Run out of one, open the other, everything is already there.

```
          you                              you
           |                                |
    +------v------+                  +------v------+
    | Claude Code |                  |    Codex    |
    +------+------+                  +------+------+
           |                                |
           +----------->  relay  <----------+
                      both directions
```

## The problem

Claude and Codex bill separately, so when one runs out the other still has room.
What does not follow you is the conversation.

The official transfer copies plain messages once, then stops. From a real 234
record session it carried 6 messages and dropped all 31 tool calls, 30 results
and 7 screenshots.

## What relay carries

|                          | official transfer | relay |
| ------------------------ | ----------------- | ----- |
| messages                 | yes               | yes   |
| tool calls and output    | no                | yes   |
| screenshots              | no                | yes   |
| attached files           | no                | yes   |
| run again to top up      | no                | yes   |
| Codex back to Claude     | no                | yes   |

## Install

Needs Node 18+, Claude Code and the Codex CLI, both signed in.

```
git clone https://github.com/bloodykheeng/ai-context-relay
cd ai-context-relay
node relay.mjs --install
```

A quiet watcher starts at every logon and covers every project.

For the live pull, add this to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command",
                     "command": "node \"$USERPROFILE/.claude/tools/relay.mjs\" --hook",
                     "timeout": 15 } ] }
    ]
  }
}
```

## Using it

Nothing to type. When one tool runs out, open the other.

```
  Claude runs out
        |
        v
  open Codex  ->  the conversation is in the thread  ->  carry on
        |
        v
  Codex runs out
        |
        v
  back to Claude  ->  it is in the session  ->  carry on
```

## Commands

```
relay                sync now: push to Codex, print anything new from Codex
relay --now          also write it into this session, without waiting
relay --status       what is paired with what
relay --new          start a fresh Codex thread for this session
relay --reset        unpair this session
relay --watch        run the watcher in the foreground
relay --install      run the watcher at every logon
relay --uninstall    stop it starting at logon
relay --help         this list
```

### Flags

| flag | meaning |
| --- | --- |
| `--cwd <dir>` | project directory (default: current) |
| `--session <file>` | act on one specific Claude transcript |
| `--tools native\|text` | carry tool calls as call items, or as prose (default: `native`) |
| `--no-thinking` | leave Claude's reasoning out |
| `--interval <sec>` | how often `--watch` polls (default: 10) |
| `--force` | alias of `--now` |
| `--hook` | pull-only mode for the `UserPromptSubmit` hook |

## How it works

Both tools keep their history as JSONL on disk.

```
  ~/.claude/projects/<project>/<session>.jsonl      Claude Code
  ~/.codex/sessions/YYYY/MM/DD/rollout-<id>.jsonl   Codex
  ~/.codex/state_5.sqlite                           Codex chats list
```

### Claude to Codex

The watcher notices a transcript change (`fs.watch`, debounced 1.5s), reads the
bytes added since last time, and appends them to the paired Codex session file.
Codex re-reads a session by byte offset whenever a thread is opened, so
appending is how it reads its own history.

The thread itself is never created by hand. relay asks Codex to make it over
the app-server JSON-RPC (`externalAgentConfig/import`), the same call the
official plugin uses, because only Codex can write the chats-list row. relay
then clears the body Codex wrote and appends its own richer version, so nothing
appears twice.

### Codex to Claude

Two paths, sharing one read marker so nothing is delivered twice.

- **Written in**, once a session has been idle 90 seconds, meaning you left it.
  Appending under a session Claude Code is still writing lands records in the
  middle of a turn.
- **Delivered live** by the `UserPromptSubmit` hook while you are still typing,
  as `additionalContext`, plus a visible `relay: carried N turns over from Codex`.

`--now` skips the idle wait. Reopening the session is what shows a written-in
turn: Claude Code does not re-read a transcript it already has open.

### What stops it looping

- Records relay writes into Claude carry `relayOrigin`, and are skipped on read.
- Turns relay pushes into Codex carry a `[Claude]` label, and are skipped on pull.
- A tool call carries no label, so relay also marks its own writes as read, and
  only when everything Codex had was already consumed.

### Which threads it reads

Every Codex thread whose recorded `cwd` is this project, not just the paired
one. You use whichever thread is open; the pairing is bookkeeping. A thread
relay made resumes where it stopped; a thread **Codex** made is carried whole,
because its history is exactly what Claude has never seen.

### Attachments

Screenshots are inlined as `data:` URIs. A `file://` URL is rejected outright by
the API and fails every later turn.

PDFs, spreadsheets and documents are written to `~/.codex/relay-media`, named by
content hash, and named in the message with type, size and path. They are not
inlined: a real 53MB PDF is 71MB of base64 in a file Codex re-reads constantly.

### Tunables

| constant | value | what it governs |
| --- | --- | --- |
| `SETTLE_MS` | 1500 | quiet period before syncing after a file change |
| `LEFT_THE_SESSION_MS` | 90s | idle time before writing into a Claude session |
| `MIN_ITEMS_TO_PAIR` | 6 | a chat must be a conversation before it gets a thread |
| `PAIR_WINDOW_MS` | 30m | only recently used sessions are paired |
| `ACTIVE_WINDOW_MS` | 24h | how far back threads and sessions are considered |
| `MAX_ITEMS_PULLED` | 60 | cap on a long Codex thread arriving at once |

Idle cost: about 0.4% of one core and 39MB.

## Platforms

| Windows | supported and tested |
| macOS, Linux | works, except `--install`. Use `relay --watch`, launchd or systemd |
| iOS | not possible, relay reads local files |

## Worth knowing

Appending to Codex session files is not a supported interface. It works because
the format is stable and Codex re-reads a file that has grown. If that changes,
relay breaks. It never writes to Codex's database; only Codex does that.

## Related

The plugin's own transfer is broken on Windows: it reports failure after a
successful import, because it looks the thread up by a verbatim `\\?\` path and
by a hash of a transcript that keeps growing. See `openai/codex-plugin-cc`
issues #618, #514, #417 and PRs #701, #469. Those PRs are the real fix for that
bug. relay is a separate tool, not a patch.

## Licence

MIT
