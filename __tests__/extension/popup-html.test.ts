import { readFileSync } from "node:fs";
import { join } from "node:path";

const popupHtml = readFileSync(
  join(process.cwd(), "extension/popup.html"),
  "utf8",
);

describe("popup HTML document contract", () => {
  it("declares UTF-8 as the first head child", () => {
    expect(popupHtml).toMatch(/<head>\s*<meta charset="UTF-8">/iu);
  });
});
