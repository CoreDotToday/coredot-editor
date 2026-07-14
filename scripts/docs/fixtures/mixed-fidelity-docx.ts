import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from "docx";
import JSZip from "jszip";

const NUMBERING_REFERENCE = "docs-capture-numbering";
const FIXED_ZIP_DATE = new Date(1980, 0, 1, 0, 0, 0);
const HYPERLINK_TARGET = "https://example.invalid/coredot-guide";
const FIXED_HYPERLINK_RELATIONSHIP_ID = "rIdDocsCaptureHyperlink";
const UNSUPPORTED_VISUAL_PLACEHOLDER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZbL8AAAAASUVORK5CYII=",
  "base64",
);

export async function createMixedFidelityDocx(): Promise<Buffer> {
  const source = await Packer.toBuffer(
    new Document({
      creator: "CoreDot Editor",
      description: "Deterministic local fixture for the public documentation.",
      lastModifiedBy: "CoreDot Editor",
      numbering: {
        config: [
          {
            levels: [
              {
                alignment: AlignmentType.START,
                format: LevelFormat.DECIMAL,
                level: 0,
                style: {
                  paragraph: {
                    indent: { hanging: 260, left: 720 },
                  },
                },
                text: "%1.",
              },
            ],
            reference: NUMBERING_REFERENCE,
          },
        ],
      },
      sections: [
        {
          children: [
            new Paragraph({
              heading: HeadingLevel.HEADING_1,
              text: "Mixed-Fidelity Product Brief",
            }),
            new Paragraph({
              heading: HeadingLevel.HEADING_2,
              text: "Executive summary",
            }),
            new Paragraph({
              children: [
                new TextRun({ bold: true, text: "Key signal: " }),
                new TextRun({
                  italics: true,
                  text: "retention improved, while the supporting evidence still needs review.",
                }),
              ],
            }),
            new Paragraph({
              children: [
                new TextRun("Read the "),
                new ExternalHyperlink({
                  children: [
                    new TextRun({ style: "Hyperlink", text: "editor fidelity guide" }),
                  ],
                  link: HYPERLINK_TARGET,
                }),
                new TextRun(" before approving the imported draft."),
              ],
            }),
            new Paragraph({
              heading: HeadingLevel.HEADING_2,
              text: "Evidence checklist",
            }),
            new Paragraph({ bullet: { level: 0 }, text: "Confirm the source metric." }),
            new Paragraph({ bullet: { level: 0 }, text: "Name the accountable owner." }),
            new Paragraph({
              numbering: { level: 0, reference: NUMBERING_REFERENCE },
              text: "Review the imported structure.",
            }),
            new Paragraph({
              numbering: { level: 0, reference: NUMBERING_REFERENCE },
              text: "Approve the final wording.",
            }),
            new Table({
              rows: [
                new TableRow({
                  children: [
                    tableCell("Area"),
                    tableCell("Evidence"),
                    tableCell("Decision"),
                  ],
                }),
                new TableRow({
                  children: [
                    tableCell("Retention"),
                    tableCell("Needs source"),
                    tableCell("Review"),
                  ],
                }),
              ],
            }),
            new Paragraph({
              heading: HeadingLevel.HEADING_2,
              text: "Unsupported visual construct warning",
            }),
            new Paragraph({
              children: [
                new TextRun(
                  "A floating SmartArt diagram is intentionally represented by a local placeholder because the editor does not preserve that visual construct during import. ",
                ),
                new ImageRun({
                  altText: {
                    description:
                      "Local placeholder for an intentionally unsupported floating SmartArt diagram",
                    name: "Unsupported SmartArt placeholder",
                    title: "Unsupported visual construct",
                  },
                  data: UNSUPPORTED_VISUAL_PLACEHOLDER,
                  transformation: { height: 16, width: 16 },
                  type: "png",
                }),
              ],
            }),
          ],
        },
      ],
      title: "Mixed-Fidelity Product Brief",
    }),
  );

  return normalizeDocxArchive(source);
}

function tableCell(text: string) {
  return new TableCell({ children: [new Paragraph(text)] });
}

async function normalizeDocxArchive(source: Buffer) {
  const input = await JSZip.loadAsync(source);
  const output = new JSZip();
  const generatedHyperlinkRelationshipId = await readHyperlinkRelationshipId(input);
  const fileNames = Object.keys(input.files)
    .filter((name) => !input.files[name]!.dir)
    .sort();

  for (const fileName of fileNames) {
    const file = input.file(fileName);
    if (!file) throw new Error("Docs DOCX fixture failed");
    const contents = await file.async("nodebuffer");
    output.file(
      fileName,
      normalizeGeneratedContents(
        fileName,
        contents,
        generatedHyperlinkRelationshipId,
      ),
      {
        createFolders: false,
        date: FIXED_ZIP_DATE,
      },
    );
  }

  return output.generateAsync({
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "DOS",
    type: "nodebuffer",
  });
}

async function readHyperlinkRelationshipId(archive: JSZip) {
  const relationships = archive.file("word/_rels/document.xml.rels");
  if (!relationships) throw new Error("Docs DOCX fixture failed");
  const xml = await relationships.async("string");
  const relationship = xml
    .match(/<Relationship\b[^>]*>/g)
    ?.find((element) => element.includes(`Target="${HYPERLINK_TARGET}"`));
  const relationshipId = relationship?.match(/\bId="([^"]+)"/)?.[1];
  if (!relationshipId) throw new Error("Docs DOCX fixture failed");
  return relationshipId;
}

function normalizeGeneratedContents(
  fileName: string,
  contents: Buffer,
  generatedHyperlinkRelationshipId: string,
) {
  if (fileName === "docProps/core.xml") return removeAutomaticCoreDates(contents);
  if (
    fileName !== "word/document.xml" &&
    fileName !== "word/_rels/document.xml.rels"
  ) {
    return contents;
  }
  return Buffer.from(
    contents
      .toString("utf8")
      .replaceAll(
        generatedHyperlinkRelationshipId,
        FIXED_HYPERLINK_RELATIONSHIP_ID,
      ),
    "utf8",
  );
}

function removeAutomaticCoreDates(contents: Buffer) {
  const xml = contents.toString("utf8").replace(
    /<dcterms:(?:created|modified)\b[^>]*>[^<]*<\/dcterms:(?:created|modified)>/g,
    "",
  );
  return Buffer.from(xml, "utf8");
}
