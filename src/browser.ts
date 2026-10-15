import { spawn } from "node:child_process";

// How to open `url` in the default browser on `platform`. On Windows this uses
// rundll32 rather than `cmd /c start`: cmd parses the command line, and an
// unquoted `&` ends the command there. The OAuth URL is all `&`-joined query
// parameters, so the browser would open it cut off after the first one and the
// sign-in could never call back. rundll32 takes the URL as one argument.
export function browserCommand(platform: NodeJS.Platform, url: string): { cmd: string; args: string[] } {
  if (platform === "darwin") return { cmd: "open", args: [url] };
  if (platform === "win32") return { cmd: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  return { cmd: "xdg-open", args: [url] };
}

export function openBrowser(url: string): void {
  const { cmd, args } = browserCommand(process.platform, url);
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  // A missing launcher (no xdg-open, say) is reported as an "error" event,
  // which would crash the wizard if nothing listened. The user can still open
  // the page themselves, so a failed launch is not worth stopping for.
  child.on("error", () => {});
  child.unref();
}
