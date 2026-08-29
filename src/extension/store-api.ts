import type { NodeIdentity } from "../identity.js";
import type { Store } from "../store.js";

export type StoreModule = {
  loadIdentity(): NodeIdentity | null;
  openStore(): Store;
};
