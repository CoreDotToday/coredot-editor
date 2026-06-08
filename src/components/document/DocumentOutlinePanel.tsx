import { FileText, Heading1, Heading2, Heading3 } from "lucide-react";
import type { DocumentOutlineItem } from "@/features/documents/document-outline";
import { formatEditorMessage } from "@/features/i18n/editor-language";

export type DocumentOutlinePanelMessages = {
  empty: string;
  itemLabel: string;
  title: string;
};

type DocumentOutlinePanelProps = {
  activeItemId?: string | null;
  messages: DocumentOutlinePanelMessages;
  onSelectItem: (item: DocumentOutlineItem) => void;
  outline: DocumentOutlineItem;
};

const headingIconByLevel = {
  1: Heading1,
  2: Heading2,
  3: Heading3,
} as const;

export function DocumentOutlinePanel({
  activeItemId = null,
  messages,
  onSelectItem,
  outline,
}: DocumentOutlinePanelProps) {
  return (
    <nav aria-label={messages.title} className="shrink-0 border-t border-zinc-200 px-4 py-4">
      <div className="flex items-center gap-2">
        <FileText aria-hidden="true" className="size-3.5 text-zinc-500" />
        <h2 className="text-xs font-semibold uppercase tracking-normal text-zinc-500">{messages.title}</h2>
      </div>
      {outline.children.length === 0 ? (
        <p className="mt-2 line-clamp-3 text-xs leading-5 text-zinc-500">{messages.empty}</p>
      ) : (
        <div className="mt-2 max-h-52 space-y-0.5 overflow-y-auto pr-1">
          {outline.children.map((item) => (
            <OutlineItemNode
              activeItemId={activeItemId}
              item={item}
              key={item.id}
              messages={messages}
              onSelectItem={onSelectItem}
            />
          ))}
        </div>
      )}
    </nav>
  );
}

function OutlineItemNode({
  activeItemId,
  item,
  messages,
  onSelectItem,
}: {
  activeItemId: string | null;
  item: DocumentOutlineItem;
  messages: DocumentOutlinePanelMessages;
  onSelectItem: (item: DocumentOutlineItem) => void;
}) {
  const Icon = headingIconByLevel[item.level];
  const isActive = activeItemId === item.id;
  const paddingLeft = `${Math.max(0, item.level - 1) * 0.75}rem`;

  return (
    <div>
      <button
        aria-label={formatEditorMessage(messages.itemLabel, { title: item.title })}
        className={[
          "flex min-h-8 w-full items-center gap-2 rounded px-2 text-left text-xs font-medium transition-colors",
          isActive ? "bg-zinc-950 text-white" : "text-zinc-700 hover:bg-zinc-100 hover:text-zinc-950",
        ].join(" ")}
        onClick={() => onSelectItem(item)}
        style={{ paddingLeft }}
        type="button"
      >
        <Icon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="truncate">{item.title}</span>
      </button>
      {item.children.length > 0 ? (
        <div className="space-y-0.5">
          {item.children.map((child) => (
            <OutlineItemNode
              activeItemId={activeItemId}
              item={child}
              key={child.id}
              messages={messages}
              onSelectItem={onSelectItem}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
