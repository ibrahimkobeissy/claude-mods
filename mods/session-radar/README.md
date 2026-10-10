# 📡 session-radar

**A live sidebar for long Claude Code sessions.** Usage limits, context, agents, background shells and progress, all in one small pane next to your transcript. It changes none of Claude Code's own behaviour.

<p align="center">
  <img src="assets/overview.png" alt="session-radar docked beside a Claude Code session" width="100%">
</p>

## Install

```text
/plugin marketplace add ibrahimkobeissy/claude-mods
/plugin install session-radar@claude-mods
```

Then type `/radar` to open it, and `/radar` again to close it.

## What it shows

| Section | What's in it |
| --- | --- |
| **⚠ Needs you** | Pinned at the top while a permission prompt, a question or a plan approval is waiting, and who it's from |
| **Limits** | 5-hour and 7-day usage with reset times, session cost, cost per hour, and **when the 5h window fills at your current pace** |
| **Main** | Model, effort, context bar (yellow, then red with "compaction soon"), git branch or worktree, session time |
| **Agents** | Each subagent with status, type, task, running time, context, tool calls, errors and branch or worktree. Select one to see its last message |
| **Background** | The background shells the footer counts: running ones first, then the last few finished. Select one to open its live output. Also lists scheduled cron jobs and `/loop` wakeups |
| **Progress** | The live todo list (or task list), with the approved plan's title on top |

You also get a toast when a background shell or agent finishes or fails.

### A background shell, opened

<p align="center">
  <img src="assets/shell.png" alt="A background shell's live output in the radar pane" width="100%">
</p>

You get the last lines of output, refreshed every 2 seconds. **Copy** puts them on your clipboard. **Stop** calls `TaskStop`, which asks for permission like any other tool call.

## Keys

The radar never takes over your keyboard. While you type at the prompt, every Claude Code shortcut works as it always does.

| Key | Where | Does |
| --- | --- | --- |
| `ctrl+x tab` | prompt | Moves the keyboard into the pane (press it again if another plugin's band is showing) |
| `tab` / `shift+tab` | pane | Next / previous row |
| `enter` | pane | Open a shell, show an agent's details, fold or unfold a section |
| `↑` `↓` | pane | Scroll |
| `b` / `c` / `s` | shell view | Back / copy / stop |
| `esc` | pane | Back to the prompt |

You can also click rows.

## Options

| Option | Default | |
| --- | --- | --- |
| `autoOpen` | `false` | Open the radar when a session starts. When opened this way it only appears where it fits as a sidebar (144+ columns) |

Set it from `/plugin` → session-radar → configure.

## Good to know

- The pane docks as a sidebar in the fullscreen layout. In a narrow terminal it opens above the prompt instead and scrolls.
- Limits appear once the first API response reports them, and only on a Claude subscription. The 5h forecast appears after about 5 minutes of usage data.
- An agent's context is shown in tokens (from its last model request), since agents can run on different models.
- It tracks what happens while it's loaded. Shells and agents started before you installed it won't show up.

## Permissions and privacy

It reads your session's own events and runs `git rev-parse` locally to find branches. It reads a background shell's output file only when you open that shell. No network access, and nothing is written to disk.

## Develop

```bash
claude --plugin-dir mods/session-radar       # try it live; saves hot-reload
scripts/validate.sh mods/session-radar       # validate + run tests/
```
