function page(title: string, subtitle: string): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${title}</title></head>`,
    '<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#111217;color:#e0e0e0;">',
    '<div style="text-align:center;max-width:400px;padding:2rem;">',
    `<h1 style="margin-bottom:0.5rem;color:#fff;">${title}</h1>`,
    `<p style="color:#9ca3af;font-size:0.9rem;">${subtitle}</p>`,
    "</div></body></html>",
  ].join("");
}

export function successPage(): string {
  return page("Authenticated!", "setup-cli is now connected to Grafana Assistant. You can close this tab.");
}

export function cancelledPage(): string {
  return page("Authorization cancelled", "Return to your terminal to try again. You can close this tab.");
}
