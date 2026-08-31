#!/usr/bin/env node
import { Command } from "commander";
import { registerClear } from "./cli/clear.js";
import { registerCollect } from "./cli/collect.js";
import { registerDoctor } from "./cli/doctor.js";
import { registerExport } from "./cli/export.js";
import { registerInit } from "./cli/init.js";
import { registerLink } from "./cli/link.js";
import { registerNotify } from "./cli/notify.js";
import { registerPeer } from "./cli/peer.js";
import { registerPick } from "./cli/pick.js";
import { registerStatus } from "./cli/status.js";
import { VERSION } from "./index.js";

const program = new Command();
program
  .name("murmur")
  .description("Agent state across every machine, in one view.")
  .version(VERSION);
registerInit(program);
registerLink(program);
registerExport(program);
registerCollect(program);
registerClear(program);
registerNotify(program);
registerPeer(program);
registerDoctor(program);
registerStatus(program);
registerPick(program);
program.parse();
