import { Howl, staticFiles } from "@hushkey/howl";
import { apiConfig, type State } from "../howl.config.ts";
import { coalesceRequests, compression } from "@hushkey/howl/middleware";

export const app = new Howl<State>({
  logger: true,
  debug: true,
});
// middlewares
app.use(staticFiles());
app.use(compression());
app.use(coalesceRequests());

app.get("/docs", (ctx) => {
  return ctx.partialRedirect("/docs/getting-started");
});

// fs endpoints
app.fsApiRoutes(apiConfig);
app.fsClientRoutes();

export default { app };
