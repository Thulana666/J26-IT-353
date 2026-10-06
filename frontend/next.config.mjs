import path from "node:path";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin Turbopack's workspace root to the repo root instead of letting Next.js
  // guess. Keep it there: with frontend/ as the root, Tailwind's PostCSS
  // worker crashed on this setup and the dev server ran out of memory.
  turbopack: { root: path.join(import.meta.dirname, "..") },
  experimental: {
    // Trust the operating system's certificates when Turbopack downloads
    // Google Fonts (needed behind HTTPS-inspecting antivirus such as Avast).
    turbopackUseSystemTlsCerts: true,
  },
};

export default nextConfig;
