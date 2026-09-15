import { openStore, tmux } from "../../dist/index.js";

const location = tmux.currentWindow();
if (!location) throw new Error("private claimant is not running in tmux");

const store = openStore();
const claim = store.claimAgent({
  location,
  owner_pid: process.pid,
  meta: {
    agent_name: process.env.MU_AGENT_NAME ?? null,
    pi_session: null,
    workstream: process.env.MU_WORKSTREAM ?? null,
    role: process.env.MU_ROLE ?? null,
    cli: "pi",
    driver: process.env.MU_MANAGED_AGENT === "1" ? "orchestrated" : "human",
  },
});
store.setActivity({
  agent_id: claim.agent_id,
  owner_pid: process.pid,
  activity: "running",
  location,
});
store.close();

process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 60_000);
