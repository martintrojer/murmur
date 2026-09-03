# ssh for murmur

Everything about reaching a peer that an ordinary `ssh <host>` does not already
handle. Most fleets need none of this: murmur rides whatever ssh already works,
and a host that answers key auth unattended needs no setup at all.

Read this when a peer will not collect and the error is about credentials.

---

## The one rule

murmur never prompts. Every ssh it runs sets `BatchMode=yes`, so a background
collect cannot block on a human — no password, no passphrase, no host-key
question. A peer that cannot authenticate silently and unattended is therefore
only collectable while an already-authenticated connection exists for murmur to
ride.

That is the whole of it. The rest of this page is the consequences.

---

## A host that demands interactive auth

Some machines refuse an unattended login: a second factor per connection, a
hardware token, a password. Open a master session and leave it running:

```sh
ssh -MNf -S '~/.ssh/control/%r@%h:%p' dev   # answer the second factor once
```

All four flags earn their place, and none of them are about authentication.

**`-N -f`** keep it from opening a shell. Without `-N` the command starts an
interactive session, and on a host that caps sessions per connection that shell
holds the only slot — so the remedy would block every collect for as long as the
terminal stayed open. `-N` asks for no remote command; `-f` backgrounds it after
auth so you get your prompt back.

**`-M -S`** decide *where the socket lives*. OpenSSH defaults to `ControlMaster
no` and `ControlPath none` (verify with `ssh -F /dev/null -G <host>`), so on a
machine with no ssh_config of its own a bare `ssh dev` multiplexes nothing and
leaves no socket for murmur to find. `-M` creates the master, `-S` puts it on
the path murmur reads.

If your own ssh_config already sets `ControlMaster auto` and a matching
`ControlPath`, a plain `ssh dev` gives murmur a master it can use. The flags
just make one instruction correct on every machine.

While that master lives, collects cost ~10ms. While it does not, the peer is
skipped rather than dialled on every tick, its cached rows still list with their
real age, and the picker header names it with the command:

```
! dev: re-auth needed (last seen 2h) — ssh -MNf -S ~/.ssh/control/%r@%h:%p dev
```

`murmur doctor` carries the full list where the header trims.

---

## When the host caps sessions per connection

A collect fails with `Session open refused by peer` while a master *is* running.
This is not an auth problem and no flag above prevents it.

`MaxSessions` is per **network connection** and defaults to 10, but a hardened
host may set it to 1 — which, as OpenSSH's own documentation puts it,
"effectively disable[s] session multiplexing". One connection then carries one
session channel, so any second command over that socket is refused.

### Why it looks like a credentials failure

ssh does not stop at the refusal. It falls back to a fresh connection, which
hits the host's interactive auth and dies there:

```
mux_client_request_session: session request failed: Session open refused by peer
mtrojer@dev: Permission denied (keyboard-interactive).
```

The second line is the one that survives in a log, and nothing in it mentions
sessions. murmur classifies this case separately from a genuine auth wall and
retries rather than asking you to re-authenticate — see `sessionChannelBusy` in
`src/collector.ts`.

`ControlMaster no` does not help, despite looking like it should. It governs
master *creation* only; the fallback fires for a socket that exists and refuses
as readily as for one that is absent. Measured with `no` set: three of four
concurrent calls still produced the misleading error.

### Do your own work in Eternal Terminal

ET cannot serve murmur — it bootstraps over ssh, so opening one hits the same
auth wall, and it exposes no multiplexing socket to attach to. That is exactly
why the pairing works: **once connected it holds no ssh session**, so the capped
slot stays free.

Verified on a `MaxSessions 1` devvm: an interactive `ssh` starved every collect
for as long as it stayed open, while an ET session on the same host did not.

Run ET for yourself and one `ssh -MNf` master for murmur, and the two do not
compete. Note this is tested one way only — ET running costs no slot; whether
ET's own bootstrap can complete when the slot is *already* exhausted is untested.

### Jumping is a session too — peek, then back out

The jump is `ssh -t <host> tmux attach`, which occupies a session channel for
the whole visit. On a capped host that has two consequences, and both were
measured:

**While you are attached, that peer does not collect.** Its rows age and the
picker shows it going stale until you detach. Nothing is broken and nothing
needs fixing — it resumes on the next tick after you leave.

**If the slot is already busy, the jump fails.** It reports `Permission denied
(keyboard-interactive)`, the same misleading error a blocked collect gets. A
failed jump is the worse of the two, because it presents as a keypress that did
nothing.

So on a `MaxSessions 1` peer, treat the jump as a quick peek: look, act, detach.
For a long working session on that host, attach to a remote tmux over Eternal
Terminal instead and leave the ssh slot to murmur — you get the same windows
without holding the channel.

### There is no client-side fix

`MaxSessions` exists only in `sshd_config`; `ssh -o MaxSessions=1` is a
configuration error. The client cannot raise, query or negotiate the cap, and
discovers it only by being refused. If the limit is wrong for your host, the
change belongs in whatever manages that host's sshd.

---

## Recovery: a wedged master

A peer stays stuck after all of the above. The signature is `ssh -O check`
reporting `Master running` while every command over that socket fails.

Rebuild it — and kill the proxy too. A `ProxyCommand` child outlives the master
that spawned it and will poison the replacement, so rebuilding without this step
appears to work and then fails identically.

```sh
pkill -f 'ssh -MNf dev'                     # the master
pkill -f 'x2ssh .*dev'                      # its ProxyCommand child, if any
rm -f ~/.ssh/control/'<user>@<host>:22'     # the stale socket
ssh -MNf -S '~/.ssh/control/%r@%h:%p' dev   # rebuild, answer the second factor
ssh -O check dev                            # expect: Master running (pid=...)
```

---

## Reading the fleet

`murmur peer list` is best-effort by design, and the two columns answer different
questions:

- **`SSH`** is last-known reachability — a host can read `warm` and be failing
  right now.
- **`error`** is the current attempt.

Branch on the error, never on presence in the list. `murmur peer list --json`
exits 0 whether or not peers are down, because a fleet with sleeping machines is
the normal state rather than a fault.

`murmur status` and `murmur pick` are polling paths and stay silent whatever the
fleet is doing. `murmur collect` is a deliberate dial and prints one line per
host it could not reach — that is the one to run when the question is "can I
reach this host *right now*".
