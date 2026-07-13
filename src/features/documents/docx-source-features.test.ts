import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { collectDocxSourceFeatures } from "./docx-source-features.mjs";

const WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const RELATIONSHIPS_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships";

describe("DOCX source feature detection", () => {
  it("treats an empty underline element as enabled and ignores disabled style values", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml", `
      <w:document xmlns:w="${WORD_NAMESPACE}"><w:body><w:p><w:r><w:rPr>
        <w:u/><w:color w:val="auto"/><w:highlight w:val="none"/>
      </w:rPr><w:t>Body</w:t></w:r></w:p></w:body></w:document>
    `);
    zip.file("word/_rels/document.xml.rels", `
      <Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">
        <Relationship Id="rId1" Type="x/header" Target="header1.xml"/>
        <Relationship Id="rId2" Type="x/footer" Target="footer1.xml"/>
      </Relationships>
    `);
    zip.file("word/header1.xml", `<w:hdr xmlns:w="${WORD_NAMESPACE}"><w:p><w:r><w:t>Header</w:t></w:r></w:p></w:hdr>`);
    zip.file("word/footer1.xml", `<w:ftr xmlns:w="${WORD_NAMESPACE}"><w:p/></w:ftr>`);

    const features = await collectDocxSourceFeatures(await zip.generateAsync({ type: "uint8array" }));

    expect([...features]).toEqual(expect.arrayContaining(["underline", "header"]));
    expect([...features]).not.toEqual(expect.arrayContaining(["text-color", "highlight", "footer"]));
  });
});
