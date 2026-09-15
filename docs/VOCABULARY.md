# murmur vocabulary

- **node** — one machine running murmur, identified by `host_id`.
- **tmux server** — the server that owns a pane. Snapshot protocol v3 represents
  it as exactly one tagged value: `{ "kind": "default" }`,
  `{ "kind": "label", "value": "coop" }`, or
  `{ "kind": "path", "value": "/absolute/socket/path" }`.
- **pane address** — `(server, pane)`. A pane id is unique only within one tmux
  server; `%34` on the default server and `%34` on `tmux -L coop` are different
  addresses.
- **snapshot** — one node's complete current state. Snapshot version 3 requires
  every pane address to include its server tag and is deliberately incompatible
  with version 2.
- **activity** — whether the pane's owning process reports `running` or
  `stopped`.
- **attention** — a `done`, `blocked`, or `crashed` request associated with a
  pane address.
- **freshness** — how recently the reader fetched the node's snapshot.
