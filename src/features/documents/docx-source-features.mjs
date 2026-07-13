import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";
import { posix as pathPosix } from "node:path";

const WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const PACKAGE_RELATIONSHIPS_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships";
const HEADER_FOOTER_TEXT_ELEMENTS = new Set(["instrText", "t"]);
const HEADER_FOOTER_NON_TEXT_CONTENT = new Set(["drawing", "pict"]);

export async function collectDocxSourceFeatures(buffer) {
  const features = new Set();
  const zip = await JSZip.loadAsync(Buffer.from(buffer));
  const documentRoot = await readXmlPart(zip, "word/document.xml");
  walkElements(documentRoot, (element) => {
    if (isWordElement(element, "u") && isEnabledUnderline(readWordValue(element))) {
      features.add("underline");
    } else if (isWordElement(element, "color") && isMeaningfulWordValue(readWordValue(element), "auto")) {
      features.add("text-color");
    } else if (isWordElement(element, "highlight") && isMeaningfulWordValue(readWordValue(element), "none")) {
      features.add("highlight");
    }
  });

  if (!zip.file("word/_rels/document.xml.rels")) return features;
  const relationshipsRoot = await readXmlPart(zip, "word/_rels/document.xml.rels");
  const relatedParts = [];
  walkElements(relationshipsRoot, (element) => {
    if (element.namespaceURI !== PACKAGE_RELATIONSHIPS_NAMESPACE || element.localName !== "Relationship") return;
    const type = element.getAttribute("Type");
    const target = element.getAttribute("Target");
    if (!type || !target) return;
    if (type.endsWith("/header")) relatedParts.push({ feature: "header", target });
    if (type.endsWith("/footer")) relatedParts.push({ feature: "footer", target });
  });

  for (const part of relatedParts) {
    const partPath = pathPosix.resolve("/word", part.target).slice(1);
    if (!partPath.startsWith("word/") || !zip.file(partPath)) continue;
    const partRoot = await readXmlPart(zip, partPath);
    if (hasMeaningfulHeaderFooterContent(partRoot)) features.add(part.feature);
  }
  return features;
}

async function readXmlPart(zip, name) {
  const part = zip.file(name);
  if (!part) throw new Error(`DOCX part is missing: ${name}`);
  const errors = [];
  const parser = new DOMParser({
    errorHandler: {
      error: (message) => errors.push(message),
      fatalError: (message) => errors.push(message),
      warning: () => undefined,
    },
  });
  const document = parser.parseFromString(await part.async("string"), "application/xml");
  if (errors.length > 0 || !document?.documentElement) {
    throw new Error(`Invalid DOCX XML part: ${name}`);
  }
  return document.documentElement;
}

function walkElements(root, visit) {
  const stack = root ? [root] : [];
  while (stack.length > 0) {
    const element = stack.pop();
    visit(element);
    for (let child = element.lastChild; child; child = child.previousSibling) {
      if (child.nodeType === 1) stack.push(child);
    }
  }
}

function hasMeaningfulHeaderFooterContent(root) {
  let meaningful = false;
  walkElements(root, (element) => {
    if (meaningful || element.namespaceURI !== WORD_NAMESPACE) return;
    if (HEADER_FOOTER_NON_TEXT_CONTENT.has(element.localName)) {
      meaningful = true;
    } else if (HEADER_FOOTER_TEXT_ELEMENTS.has(element.localName) && element.textContent?.trim()) {
      meaningful = true;
    }
  });
  return meaningful;
}

function isWordElement(element, localName) {
  return element.namespaceURI === WORD_NAMESPACE && element.localName === localName;
}

function readWordValue(element) {
  return element.getAttributeNS(WORD_NAMESPACE, "val") ?? element.getAttribute("w:val");
}

function isEnabledUnderline(value) {
  return value === null || !["0", "false", "none"].includes(value.toLowerCase());
}

function isMeaningfulWordValue(value, disabledValue) {
  return value !== null && !["0", "false", disabledValue].includes(value.toLowerCase());
}
