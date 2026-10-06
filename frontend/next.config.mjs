import path from "node:path";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The repo root has its own (empty) package-lock.json, which made Next.js
  // warn while guessing the workspace root. Pin it to the repo root - what it
  // already used. (Pinning it to frontend/ crashes Tailwind's PostCSS worker.)
  turbopack: { root: path.join(import.meta.dirname, "..") },
};

export default nextConfig;
