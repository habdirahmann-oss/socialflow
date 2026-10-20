import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Sta verzoeken via de Cloudflare-tunnel toe tijdens development
  allowedDevOrigins: ["*.trycloudflare.com"],

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
      {
        // Niet indexeren, behalve de publieke privacy- en voorwaardenpagina's
        source: "/((?!privacy|voorwaarden).*)",
        headers: [{ key: "X-Robots-Tag", value: "noindex" }],
      },
    ];
  },
};

export default nextConfig;
