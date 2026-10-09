import os from "node:os";
import path from "node:path";
import { defineConfig, type PluginOption } from "vite";
import { enterDevPlugin, enterProdPlugin } from "vite-plugin-enter-dev";

// Enter 平台约定：`pnpm dev` 启动 Vite 开发服务器（端口 8080），预览与可视化编辑依赖它。
// 两个入口：主应用 index.html 与手机上传页 mobile.html（局域网通道需要本机服务在构建产物里注入 token）。
// 开发服务器提供 /api/lan-base：页面在 localhost 打开时，云端二维码需改用局域网地址，
// 手机（微信扫码）才能访问 mobile.html；逻辑与 server.mjs 的 localAddress/publicBase 保持一致。
function lanAddress(): string | null {
  const interfaces = os.networkInterfaces();
  const isUsable = (item: os.NetworkInterfaceInfo | undefined) =>
    !!item && item.family === "IPv4" && !item.internal;
  const wifi = (interfaces.en0 || []).find(isUsable);
  if (wifi) return wifi.address;
  const candidates = Object.entries(interfaces)
    .filter(([name]) => !/^(lo|utun|awdl|llw|bridge|gif|stf)/i.test(name))
    .flatMap(([, addresses]) => addresses || [])
    .filter(isUsable);
  const privateAddress = candidates.find((item) =>
    /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item!.address),
  );
  return (privateAddress || candidates[0])?.address || null;
}

// 平台配置器只接受「插件调用」形式的条目，所以这里用工厂函数返回插件对象。
function lanBasePlugin(): PluginOption {
  return {
    name: "scribe-lan-base",
    configureServer(server) {
      server.middlewares.use("/api/lan-base", (req, res) => {
        const port = (req.headers.host || "").split(":")[1] || "8080";
        const address = lanAddress();
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify({ base: address ? `http://${address}:${port}` : null }));
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const plugins: PluginOption[] = [...enterProdPlugin()];
  if (mode === "development") {
    plugins.push(...enterDevPlugin(), lanBasePlugin());
  }
  return {
    server: {
      host: "::",
      port: 8080,
    },
    plugins: plugins.filter(Boolean) as PluginOption[],
    base: "/",
    build: {
      outDir: "dist",
      emptyOutDir: true,
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, "index.html"),
          mobile: path.resolve(__dirname, "mobile.html"),
        },
      },
    },
  };
});
