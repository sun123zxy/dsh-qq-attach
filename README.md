# dsh-qq-attach

Attach one open Deepseek Harness session to one QQ chat, so an agent you are already working
with could also talk to you on QQ.

> Vibed with Deepseek V4.1 Flash. Not polished yet. Use at your own risk.

## How this differs from the official QQ bot

The [official DSH QQ bot](https://github.com/tencent-connect/dsh-qqbot) hands you a bot:
it manages its own sessions, and controls the session lifecycle.

This plugin does the reverse — it binds a **DSH session** to a QQ chat.

- **Existing sessions can be attached.** So that you can continue working with the same agent on QQ.

- **Two reply modes.**

  - *Automatic replies* (default): everything the agent says is forwarded. 
    The agent does not know it is on QQ.
  - *Proactive only* (`autoReply` off): normal output is not forwarded and
    stays in the session. The agent must call `qq_send` / `qq_send_file` to send
    QQ messages. Ideal for a long-running, autonomous agent that only
    occasionally needs to reach you on QQ.

## Install & Setup

Needs DSH `0.2.2-rc.5` (declared in `engines.dsh`) and Node 22.19 or newer. You
also need a QQ bot from the [QQ Open Platform](https://q.qq.com/), with the
group and direct-message events enabled, and its AppID and AppSecret.

### Install the bundle

Paste one of these into **Settings → Plugins → add plugin**:

```
github:sun123zxy/dsh-qq-attach
```

Doing development instead? Clone the repository and
install its absolute path, which links the working copy so edits apply on reload:

```
/home/you/dsh-qq-attach
```

### Bind the bot

Open **Settings → Plugins → dsh-qq-attach** and scan the QR code, or fill in
AppID and AppSecret. Credentials go to the DSH credential store, so the bot
reconnects by itself on later starts.

### Attach a chat

Open a conversation, switch to the **QQ attach** tab (you may need to say something to the bot first to see it), pick a chat and press Attach.

The picker only lists chats the bot has already received something from, so send
one message from that QQ chat first; until then paste the id by hand as
`c2c:<openid>` or `group:<openid>`.

## Configuration

```yaml
- id: qq-attach
  name: dsh-qq-attach
  config:
    media:
      enabled: true
      maxMB: 200
      ttlHours: 24
    sendFile:
      maxFiles: 4
    group:
      historyLimit: 8
```

`media.ttlHours` only clears the download staging area in `~/.dsh-qqbot/media`.
Images already used in a session are stored in the DSH attachment store and is
not within the scope of this setting.

## Development

```sh
pnpm install
pnpm typecheck
```

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):
`<type>(<scope>)?: <subject>`.
