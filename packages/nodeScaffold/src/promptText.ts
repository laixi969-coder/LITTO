import type { AnyTagProps } from "x-sender";

export function getPromptText(value: AnyTagProps[][], resolveReference?: (id: string, marker: string) => string) {
  return value.map(line => line.map(tag => {
    if (tag.type === "Write") return tag.text;
    if (tag.type === "Input") return tag.text || tag.placeholder;
    if (tag.type !== "Custom") {
      const prefix = tag.type === "Mention" ? "@" : tag.type === "Trigger" ? tag.key : "";
      return prefix + tag.name;
    }
    const content = document.createElement("template");
    content.innerHTML = tag.html;
    for (const reference of content.content.querySelectorAll<HTMLElement>(".imageReference[data-value]")) {
      const marker = reference.dataset.value ?? "";
      reference.replaceWith(resolveReference ? resolveReference(reference.dataset.referenceId ?? "", marker) : marker);
    }
    return content.content.textContent ?? "";
  }).join("")).join("\n");
}
