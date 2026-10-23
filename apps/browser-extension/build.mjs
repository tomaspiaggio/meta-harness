import { cp, mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/background.ts", "src/options.ts"],
  outdir: "dist",
  bundle: true,
  format: "esm",
  target: "chrome120",
});
for (const name of ["manifest.json", "options.html"])
  await cp(name, `dist/${name}`);
