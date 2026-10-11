import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Sta verzoeken via de Cloudflare-tunnel toe tijdens development
  allowedDevOrigins: ["*.trycloudflare.com"],
};

export default nextConfig;
