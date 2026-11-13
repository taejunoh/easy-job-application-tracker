import { cp, mkdir } from "node:fs/promises";

const packageDirectory = new URL("./node_modules/pdfjs-dist/", import.meta.url);
const assetDirectory = new URL("./.static-assets/pdf-assets/", import.meta.url);

await mkdir(assetDirectory, { recursive: true });
await Promise.all(
  ["cmaps", "iccs", "standard_fonts", "wasm", "LICENSE"].map((name) =>
    cp(new URL(name, packageDirectory), new URL(name, assetDirectory), { recursive: true }),
  ),
);

await cp(
  new URL("../src/app/fonts/IBM-Plex-Sans-LICENSE.txt", import.meta.url),
  new URL("./.static-assets/IBM-Plex-Sans-LICENSE.txt", import.meta.url),
);
