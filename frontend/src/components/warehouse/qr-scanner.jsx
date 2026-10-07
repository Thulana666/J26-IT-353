"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import styles from "./warehouse.module.css";

const SCAN_INTERVAL_MS = 150;

// Scan a batch label with the camera, a handheld scanner (it types the code
// and presses Enter) or by typing the code. The text goes to ?code=, where
// the page resolves it on the server; validation happens in the backend.
export function QrScanner({ initialValue = "", autoFocus = true }) {
  const router = useRouter();
  const [value, setValue] = useState(initialValue);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState(null);
  const videoRef = useRef(null);

  useEffect(() => {
    if (!cameraOn) return undefined;
    let stopped = false;
    let stream;
    let timer;
    const video = videoRef.current;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (stopped) return;
        video.srcObject = stream;
        await video.play();

        // Native detector where the browser has one (not on Windows), else jsQR.
        const native =
          "BarcodeDetector" in window &&
          (await window.BarcodeDetector.getSupportedFormats()).includes("qr_code")
            ? new window.BarcodeDetector({ formats: ["qr_code"] })
            : null;
        const jsQR = native ? null : (await import("jsqr")).default;

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
          if (text && !stopped) {
            stopped = true;
            setValue(text);
            setCameraOn(false);
            router.push(`/dashboard/warehouse/qr?code=${encodeURIComponent(text)}`);
            return;
          }
          timer = setTimeout(scan, SCAN_INTERVAL_MS);
        };
        scan();
      } catch (error) {
        if (stopped) return;
        setCameraError(
          error?.name === "NotAllowedError"
            ? "Camera permission was denied. Allow it in the browser, or type the code."
            : "No camera is available. Use a handheld scanner or type the code."
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
  }, [cameraOn, router]);

  function handleSubmit(event) {
    event.preventDefault();
    const text = value.trim();
    if (text) router.push(`/dashboard/warehouse/qr?code=${encodeURIComponent(text)}`);
  }

  function toggleCamera() {
    setCameraError(null);
    setCameraOn((on) => !on);
  }

  return (
    <div className={styles.scanner}>
      <form onSubmit={handleSubmit} className={styles.form}>
        <div className={styles.field}>
          <Label htmlFor="qr-code">QR code</Label>
          <Input
            id="qr-code"
            name="code"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Scan a label, or type e.g. 7K3M-9Q2X-WD4RB"
            autoComplete="off"
            autoFocus={autoFocus}
          />
          <span className={styles.hint}>
            Handheld scanners work here directly. Typed codes ignore case and dashes.
          </span>
        </div>
        <div className={styles.actions}>
          <Button type="button" variant="outline" onClick={toggleCamera}>
            {cameraOn ? "Stop camera" : "Scan with camera"}
          </Button>
          <Button type="submit">Look up</Button>
        </div>
      </form>
      {cameraError && (
        <p role="alert" className={styles.formError}>
          {cameraError}
        </p>
      )}
      {cameraOn && <video ref={videoRef} className={styles.video} muted playsInline aria-label="Camera preview" />}
    </div>
  );
}
