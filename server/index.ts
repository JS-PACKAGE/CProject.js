import { configFromEnv } from "./config";
import { Store } from "./store";
import { createServer } from "./http";

const config = configFromEnv();
const store = new Store(config.dataDir, config.legacyAccount);
const server = createServer(config, store);
server.on("error", () => { console.error("Server failed to listen; check host and port configuration"); store.close(); process.exitCode = 1; });
server.listen(config.port, config.host, () => console.log(`CProject sync listening on ${config.host}:${config.port}`));
function stop() { server.close(() => { store.close(); }); }
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
