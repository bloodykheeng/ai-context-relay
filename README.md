# ai-context-relay

Keep a Claude Code session and a Codex thread as one conversation.

Work in either tool. Whichever one you run out of, the other has everything when
you open it. No export step, no thread ids to remember.

## Why

Claude and Codex bill against different accounts, so when one hits its limit the
other still has capacity. What does not carry over is the conversation. The
official transfer in `openai/codex-plugin-cc` is one-way, one-shot, and drops
every tool call: of a 234 record Claude session it carried 6 plain messages and
none of the 31 tool calls, 30 results or 7 screenshots.

relay carries the lot, both directions, continuously.

## What it does

| | official transfer | relay |
| --- | --- | --- |
| tool calls and their output | dropped | carried |
| screenshots | dropped | carried |
| assistant reasoning | dropped | carried as text |
| run it again to top up | refuses, one import per session | appends what is new |
| Codex back to Claude | not supported | supported |

## Install

Needs Node 18+, Claude Code and the Codex CLI, both signed in.

```
git clone https://github.com/bloodykheeng/ai-context-relay
cd ai-context-relay
node relay.mjs --install
```

`--install` registers a windowless watcher that starts at every logon and covers
every project. Add the folder to PATH to get the short commands below.

Remove it with `relay --uninstall`.

## Use

Nothing, day to day. When one tool runs out, open the other.

| | |
| --- | --- |
| `relay` | sync both ways, now |
| `relay --status` | what is paired with what |
| `relay --new` | start a fresh Codex thread for this session |
| `relay --watch` | run the watcher in the foreground |
| `relay --uninstall` | stop starting at logon |

Options: `--cwd <dir>`, `--session <file>`, `--tools native|text`,
`--no-thinking`, `--interval <sec>`.

## How it works

Both tools keep their history as JSONL on disk. Claude writes
`~/.claude/projects/<slug>/<session>.jsonl`; Codex writes
`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl` and lists chats from a
`threads` table in `~/.codex/state_5.sqlite`.

relay asks Codex to create the thread over the app-server JSON-RPC
(`externalAgentConfig/import`), the same call the official plugin makes, then
appends the full conversation into the session file Codex made. Codex projects a
rollout by byte offset, so appended records are picked up. Records relay writes
are tagged, and tagged records are never read back out, so the two sides cannot
echo each other.

It never writes to Codex's database. Only Codex does that.

## Platforms

- Windows: supported and tested.
- macOS and Linux: everything works except `--install`, which is written against
  the Windows Startup folder. Use launchd or systemd, or run `relay --watch`.
- iOS: not possible. relay reads local session files.

## Caveats

Writing into Codex's session directory is not a supported interface. It works
because the rollout format is stable and Codex re-reads a file that has grown.
If OpenAI changes that format, relay breaks. Your Claude transcript is the source
of truth and is never modified, except when carrying Codex work back, which only
happens when Claude has not touched the file for 20 seconds.

Screenshots are written once to `~/.codex/relay-media`, named by content hash.

## Related

The plugin's own transfer is broken on Windows, reporting failure after a
successful import: it looks the thread up by a verbatim `\\?\` path and by a
hash of a transcript that keeps growing, so the match can never succeed. See
`openai/codex-plugin-cc` issues #618, #514, #417 and PRs #701, #469. Those PRs
are the real fix for that bug. relay is a separate tool, not a patch.

## Licence

MIT
