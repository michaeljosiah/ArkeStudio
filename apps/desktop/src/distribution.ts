import { join } from "node:path";

/** SPEC-016: the installed dev channel keeps both workspace and Electron state separate. */
export function desktopDistribution(channel: string, home: string, appData: string) {
  if (channel !== "production" && channel !== "development") throw new Error("Unknown Studio distribution channel");
  const development = channel === "development";
  return {
    development,
    name: development ? "Arke Studio Dev" : "Arke Studio",
    workspace: join(home, development ? "ArkeStudioDev" : "ArkeStudio"),
    userData: development ? join(appData, "ArkeStudioDev") : undefined,
    allowUpdates: !development,
  };
}
