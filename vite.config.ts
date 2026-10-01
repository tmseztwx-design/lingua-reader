import { defineConfig, type PluginOption } from "vite";
import { enterDevPlugin, enterProdPlugin } from "vite-plugin-enter-dev";

// Enter 平台约定：`pnpm dev` 启动 Vite 开发服务器（端口 8080），预览与可视化编辑依赖它。
export default defineConfig(({ mode }) => {
  const plugins: PluginOption[] = [...enterProdPlugin()];
  if (mode === "development") {
    plugins.push(...enterDevPlugin());
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
    },
  };
});
