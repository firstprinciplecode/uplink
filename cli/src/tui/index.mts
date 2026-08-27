import { startMenuSession } from "./session.mts";

startMenuSession().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
