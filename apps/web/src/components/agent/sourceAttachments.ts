import type { AgentAttachment } from "./types";

export async function createSourceAttachments(file: File): Promise<AgentAttachment[]> {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const documentTypes: Record<string, string> = {
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  const isText = ["txt", "md", "srt", "lrc"].includes(extension);
  const mimeType = documentTypes[extension] ?? (isText ? "text/plain" : file.type);
  if (!isText && !documentTypes[extension] && !/^(image|video)\//.test(mimeType)) {
    throw new Error("请选择 TXT、MD、DOCX、PDF、图片或视频；旧版 DOC 请先另存为 DOCX");
  }
  const maxBytes = isText ? 400000 : documentTypes[extension] ? 20 * 1024 * 1024 : 100 * 1024 * 1024;
  if (!file.size || file.size > maxBytes) throw new Error(`${file.name} 为空或超出大小限制`);
  const source = { name: file.name, path: "", mimeType, file };
  if (!isText && !documentTypes[extension]) return [source];
  let text = "";
  if (isText) {
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); }
    catch { throw new Error(`${file.name} 必须使用 UTF-8 编码`); }
  } else if (extension === "docx") {
    const mammoth = await import("mammoth");
    text = (await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
  } else {
    const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist");
    const { default: workerUrl } = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    GlobalWorkerOptions.workerSrc = workerUrl;
    const task = getDocument({ data: await file.arrayBuffer() });
    try {
      const pdf = await task.promise;
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        const pageText = content.items.map(item => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("");
        if (!pageText.trim()) throw new Error(`第 ${pageNumber} 页没有可提取文字，请先 OCR 或将该页作为图片上传`);
        text += `【第 ${pageNumber} 页】\n${pageText}\n\n`;
        page.cleanup();
        if (text.length > 100000) throw new Error("文档正文不能超过 100000 个字符，请拆分后上传");
      }
    } finally {
      await task.destroy();
    }
  }
  if (!text.trim()) throw new Error("文档没有可提取的正文，请先 OCR 或上传图片");
  if (text.length > 100000) throw new Error("文档正文不能超过 100000 个字符，请拆分后上传");
  if (isText) return [source];
  // ACT: 原件保留在工作区，正文复用现有纯文本附件链路；暂不做 OCR 或还原文档排版。
  const textFile = new File([text], `${file.name.slice(0, 251)}.txt`, { type: "text/plain" });
  return [source, { name: textFile.name, path: "", mimeType: "text/plain", file: textFile }];
}
