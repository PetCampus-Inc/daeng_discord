const express = require("express");
const { createServiceAdmin } = require("./service-admin");

const port = Number(process.env.PORT || 3001);
const serviceAdmin = createServiceAdmin();

if (!serviceAdmin.hasServiceDbConfig || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("SERVICE_DB_* and a valid PORT are required.");
  process.exit(1);
}

const app = express();
app.disable("x-powered-by");
app.use("/api/service-admin", serviceAdmin.requireServiceDb, serviceAdmin.router);

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`Service admin API listening on port ${port}`);
});

function shutdown() {
  server.close(async () => {
    try {
      await serviceAdmin.serviceDb.end();
    } catch (err) {
      console.error("Service admin DB shutdown failed:", err.message);
      process.exitCode = 1;
    }
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
