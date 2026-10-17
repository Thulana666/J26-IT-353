"use client";

import { Button } from "@/components/ui/button";

// Opens the batch label (QR image, code and batch details) in a small window
// and prints it. The page is built with DOM nodes, not an HTML string.
export function PrintLabelButton({ imageDataUrl, displayCode, lines = [] }) {
  function print() {
    const win = window.open("", "_blank", "width=420,height=600");
    if (!win) return;
    const doc = win.document;
    doc.title = `Batch label ${displayCode}`;
    const style = doc.createElement("style");
    style.textContent =
      "body{font-family:system-ui,sans-serif;text-align:center;margin:24px;color:#000}" +
      "img{width:240px;height:240px}p{margin:6px 0}.code{font:600 18px ui-monospace,monospace;letter-spacing:1px}";
    doc.head.append(style);

    const image = doc.createElement("img");
    image.alt = `QR code ${displayCode}`;
    const code = doc.createElement("p");
    code.className = "code";
    code.textContent = displayCode;
    doc.body.append(image, code, ...lines.map((text) => Object.assign(doc.createElement("p"), { textContent: text })));
    image.onload = () => {
      win.focus();
      win.print();
    };
    image.src = imageDataUrl;
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={print}>
      Print label
    </Button>
  );
}
