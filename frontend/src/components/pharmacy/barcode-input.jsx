"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, CameraOff, ScanLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const SCAN_INTERVAL_MS = 150;
// The same code seen again within this time is the same physical scan.
const REPEAT_GUARD_MS = 1500;
const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf", "qr_code", "data_matrix"];

// Scanner input: a USB/Bluetooth barcode reader types the code and presses
// Enter, staff can type a code or name, or use the camera (BarcodeDetector
// for 1D barcodes and QR where the browser supports it, else jsQR for QR
// labels only). Calls onScan(code) for every scan.
export function BarcodeInput({ id = "scan", label = "Scan or type a barcode", placeholder, onScan, disabled = false, autoFocus = true, busy = false }) {
  const [value, setValue] = useState("");
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraNote, setCameraNote] = useState(null);
  const inputRef = useRef(null);
  const videoRef = useRef(null);
  const onScanRef = useRef(onScan);

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(() => {
    if (!cameraOn) return undefined;
    let stopped = false;
    let stream;
    let timer;
    let last = { text: null, at: 0 };
    const video = videoRef.current;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (stopped) return;
        video.srcObject = stream;
        await video.play();

        let native = null;
        if ("BarcodeDetector" in window) {
          const supported = await window.BarcodeDetector.getSupportedFormats();
          const formats = FORMATS.filter((f) => supported.includes(f));
          if (formats.length) native = new window.BarcodeDetector({ formats });
        }
        const jsQR = native ? null : (await import("jsqr")).default;
        if (!native) setCameraNote("This browser can read only QR labels with the camera. Use a barcode reader for product barcodes.");

        const scan = async () => {
          if (stopped) return;
          let text = null;
          if (video.readyState >= 2) {
            if (native) {
              text = (await native.detect(video))[0]?.rawValue ?? null;
            } else {
              canvas.width = video.videoWidth;
              canvas.height = video.videoHeight;
              context.drawImage(video, 0, 0);
              const image = context.getImageData(0, 0, canvas.width, canvas.height);
              text = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" })?.data ?? null;
            }
          }
          const now = Date.now();
          if (text && !(text === last.text && now - last.at < REPEAT_GUARD_MS)) {
            last = { text, at: now };
            onScanRef.current?.(text.trim());
          }
          timer = setTimeout(scan, SCAN_INTERVAL_MS);
        };
        scan();
      } catch (error) {
        if (stopped) return;
        setCameraNote(
          error?.name === "NotAllowedError"
            ? "Camera permission was denied. Allow it in the browser, or use a barcode reader."
            : "No camera is available. Use a barcode reader or type the code."
        );
        setCameraOn(false);
      }
    }
    start();
    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [cameraOn]);

  function submit(event) {
    event.preventDefault();
    const code = value.trim();
    if (!code || disabled) return;
    onScan(code);
    setValue("");
    inputRef.current?.focus();
  }

  return (
    <div className="flex flex-col gap-2">
      <form onSubmit={submit} className="flex flex-col gap-1.5">
        <Label htmlFor={id}>{label}</Label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <ScanLine size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={inputRef}
              id={id}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={placeholder ?? "Barcode, batch number, warehouse QR or product name"}
              autoComplete="off"
              autoFocus={autoFocus}
              disabled={disabled}
              className="pl-8"
            />
          </div>
          <Button type="submit" disabled={disabled || busy || !value.trim()}>
            {busy ? "Looking up…" : "Add"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setCameraNote(null);
              setCameraOn((on) => !on);
            }}
            aria-pressed={cameraOn}
            disabled={disabled}
          >
            {cameraOn ? <CameraOff size={14} /> : <Camera size={14} />}
            {cameraOn ? "Stop" : "Camera"}
          </Button>
        </div>
        <span className="text-xs text-muted-foreground">Barcode readers work here directly: keep the cursor in this box and scan.</span>
      </form>
      {cameraNote && <p className="text-xs text-amber-800">{cameraNote}</p>}
      {cameraOn && <video ref={videoRef} className="max-h-56 w-full rounded-lg bg-black object-cover" muted playsInline aria-label="Camera preview" />}
    </div>
  );
}
