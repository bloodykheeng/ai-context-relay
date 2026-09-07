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
| run again to top up      | no                | yes   |
| Codex back to Claude     | no                | yes   |

## Install

Needs Node 18+, Claude Code, and the Codex CLI, both signed in.

```
git clone https://github.com/bloodykheeng/ai-context-relay
cd ai-context-relay
node relay.mjs --install
```

That is it. A quiet watcher starts at every logon and covers every project.

## Using it

Nothing to type. When one tool runs out, open the other.

```
  Claude runs out
        |
        v
  open Codex  ->  click the thread  ->  carry on
        |
        v
  Codex runs out
        |
        v
  back to Claude  ->  resume the session  ->  carry on
```

If you ever want to check or nudge it:

```
relay              sync now
relay --status     what is paired
relay --new        start a fresh Codex thread
relay --uninstall  stop it starting at logon
```

## How it works

Both tools keep their history as plain text files. relay reads one and writes
the other.

```
  ~/.claude/projects/<project>/<session>.jsonl     Claude writes as you talk
                     |
                     |  every 15s: anything new?
                     |  reads only the new lines
                     v
                   relay
                     |
                     v
  ~/.codex/sessions/YYYY/MM/DD/rollout-<id>.jsonl  Codex reads
```

Codex creates the thread, over the same app-server call the official plugin
uses. relay only appends to the file afterwards, and never writes to Codex's
database.

Records relay writes are tagged, and tagged records are never read back, so the
two sides cannot echo each other.

Idle cost: about 0.4% of one core and 39MB. It sleeps unless a file changed.

## Platforms

| Windows | works |
| macOS, Linux | works, except `--install`. Use `relay --watch`, launchd or systemd |
| iOS | not possible, relay reads local files |

## Worth knowing

Appending to Codex's session files is not a supported interface. It works
because the format is stable and Codex re-reads a file that has grown. If that
changes, relay breaks.

Your Claude transcript is never modified, except when carrying Codex work back,
and only when Claude has not touched it for 20 seconds.

Screenshots are written once to `~/.codex/relay-media`, named by content hash.

## Related

The plugin's own transfer is broken on Windows: it reports failure after a
successful import, because it looks the thread up by a verbatim `\\?\` path and
by a hash of a transcript that keeps growing. See `openai/codex-plugin-cc`
issues #618, #514, #417 and PRs #701, #469. Those PRs are the real fix for that
bug. relay is a separate tool, not a patch.

## Licence

MIT
