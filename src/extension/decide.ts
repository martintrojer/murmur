import type { Driver } from "../types.js";

export function endState(focused: boolean, muManaged: boolean): "cleared" | "done" {
  if (muManaged) return "cleared";
  return focused ? "cleared" : "done";
}

export function driverFromEnv(env: NodeJS.ProcessEnv): Driver {
  return env.MU_MANAGED_AGENT === "1" || env.MU_AGENT_NAME ? "orchestrated" : "human";
}
