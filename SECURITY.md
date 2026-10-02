# Security

## Reporting a vulnerability

Please report it privately, not in a public issue: on GitHub, open the repo's **Security** tab and choose **Report a vulnerability**. Only the maintainer sees the report. Say what you found, how to reproduce it, and which version (`porch --version`) and harness it affects.

Fixes go out as a new release (`CHANGELOG.md`). Only the latest release is supported.

## What counts

Porch runs on one machine, as the user who runs it, and reaches agent sessions through files and Unix sockets in that user's folders. A vulnerability is a way to break that boundary, for example:

- another local user delivering a message to, or reading the state of, your sessions through Porch's session records (`~/.porch/sessions/`, created readable by you only) or a session's delivery socket (Porch checks a socket belongs to you before writing to it, `src/unix-socket.ts`);
- a session id, harness name or file content that makes Porch read or write outside its own folders;
- Porch's inside part (Claude Code hooks, the Pi extension) changing what a session does, beyond the delivered message the session's harness was asked to accept;
- the published package containing something it should not (a secret, code not in this repo).

Not in scope: what an agent does with a message it was delivered, a harness's own security, and anything that needs the same user's access already (that user can read and write the same files Porch does).
