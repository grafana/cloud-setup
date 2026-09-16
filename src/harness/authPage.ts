// Styled as a fake terminal window rather than a generic web page — the
// point of this tab is just to hand control back to the real terminal,
// so it should look like one rather than like a marketing landing page.
function terminalPage(status: string, statusOk: boolean, message: string): string {
  const statusColor = statusOk ? "#3fb950" : "#f85149";
  const statusIcon = statusOk ? "✓" : "✖";
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${status}</title>`,
    "<style>",
    "*{box-sizing:border-box}",
    "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0d1117;font-family:-apple-system,BlinkMacSystemFont,sans-serif}",
    ".terminal{width:600px;max-width:90vw;border-radius:10px;overflow:hidden;background:#161b22;box-shadow:0 20px 60px rgba(0,0,0,.5);border:1px solid #30363d}",
    ".titlebar{display:flex;align-items:center;gap:8px;padding:10px 14px;background:#21262d;border-bottom:1px solid #30363d}",
    ".dot{width:11px;height:11px;border-radius:50%}",
    ".dot.red{background:#ff5f56}.dot.yellow{background:#ffbd2e}.dot.green{background:#27c93f}",
    ".titlebar-label{flex:1;text-align:center;color:#8b949e;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;margin-right:53px}",
    ".body{padding:22px 24px 26px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px;line-height:1.8;color:#c9d1d9}",
    `.status{color:${statusColor};font-weight:600}`,
    ".message{margin-top:10px;font-weight:400}",
    "</style></head>",
    "<body>",
    '<div class="terminal">',
    '<div class="titlebar"><div class="dot red"></div><div class="dot yellow"></div><div class="dot green"></div><div class="titlebar-label">cloud-setup</div></div>',
    '<div class="body">',
    `<div><span class="status">${statusIcon} ${status}</span></div>`,
    `<div class="message">${message}</div>`,
    "</div></div></body></html>",
  ].join("");
}

export function successPage(): string {
  return terminalPage("Authenticated", true, "You can close this tab and return to your terminal.");
}

export function cancelledPage(): string {
  return terminalPage("Authorization cancelled", false, "You can close this tab and return to your terminal to try again.");
}
